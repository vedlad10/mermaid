/**
 * Patient-estimate engine — deterministic coverage calculation. This is correctness-critical: it
 * decides what a patient owes, so it is pure, exhaustively tested, and does its arithmetic in
 * integer cents (no floating-point money). Ported faithfully from Dental Verify's `calc.ts`; the
 * only behavioral change is the money type — every documented rule and rounding point is preserved.
 *
 * Applies, per line, in order:
 *   1. exclusions (excluded codes / 0%-category)
 *   2. waiting periods (category not yet covered → denied)
 *   3. frequency limits (units beyond the remaining allowance → denied/partial)
 *   4. coverage percentage for the procedure's category
 *   5. remaining deductible (only for categories it applies to; consumed once across the plan)
 *   6. remaining annual maximum (caps what insurance pays)
 *
 * Percentages round to whole cents at the line, matching how payers present estimates.
 */
import {
  addCents,
  calendarDay,
  scaleCents,
  subCents,
  formatUsd,
  ZERO,
  UNCATEGORIZED,
  type Cents,
  type Benefits,
  type CoverageCalculation,
  type CoverageLine,
  type FrequencyLimit,
  type TreatmentPlanItem,
  contractCapsPatientLiability,
  findProcedure,
  benefitCategoryOf,
  preAuthRequirementFor,
  revenueAtRisk,
} from "@mermaid/shared";

/**
 * Whole months elapsed from `fromDay` to `toDay`, both `YYYY-MM-DD` calendar days.
 *
 * ── TWO DEFECTS THIS REPLACES, AND BOTH QUOTED COVERAGE THAT DOES NOT EXIST ────────────────────
 *
 * It read `new Date(fromIso + "T00:00:00")` against `to.getFullYear()/getMonth()`, so:
 *
 *  1. **The day of the month was ignored entirely.** Only the month NUMBERS were subtracted, so a
 *     six-month waiting period beginning 2026-01-31 read as satisfied on 2026-07-01 — five months
 *     and one day. The crown was quoted with insurance paying half of it, the patient accepted
 *     treatment on that promise, and the payer denied the claim. That is the dangerous direction:
 *     the practice absorbs the difference or re-bills a patient it has already quoted.
 *
 *  2. **It ran in the HOST's timezone**, not the practice's — a bare `T00:00:00` parses as local
 *     time and the getters are local getters. The same verification could therefore produce
 *     different estimates on two deployment hosts, and neither answer is necessarily the day in the
 *     room where the patient is sitting. The rest of this codebase settled that question already
 *     (`packages/shared/src/calendar.ts`); this function had not been told.
 *
 * Both are fixed by comparing calendar days as text: no `Date`, so no zone can enter, and the
 * day-of-month decides the boundary the way a person counting months would.
 *
 * The end-of-month edge is deliberately conservative. From 2026-01-31, "one month" is not reached
 * on 2026-02-28 by this rule, because 28 < 31 — the anniversary date does not exist and the
 * alternatives all mean asserting a waiting period has ended when the payer may not agree. Denying
 * a line over-quotes the patient, which this engine already documents (`assumedDeductibleRemaining`)
 * as the recoverable error; promising coverage that is refused is the one that is not.
 */
function monthsElapsed(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = toDay.slice(0, 10).split("-").map(Number);
  if ([fy, fm, fd, ty, tm, td].some((n) => n === undefined || !Number.isFinite(n))) return 0;
  const months = (ty! - fy!) * 12 + (tm! - fm!);
  return td! < fd! ? months - 1 : months;
}

/**
 * How much deductible to assume is still to be met, when the payer did not say.
 *
 * ── WHY THE ANNUAL AMOUNT AND NOT ZERO (M4) ────────────────────────────────────────────────────
 * A missing remaining balance used to be coalesced to `0` at the adapter boundary, i.e. read as
 * "already met" — the most favourable possible reading of silence, and the one that under-quotes
 * the patient. The practice then absorbs the difference or re-bills someone it has already quoted.
 *
 * The conservative assumption is the opposite: none of it has been met. That can over-quote, and
 * over-quoting is the recoverable error — a patient told they may owe $50 more than they do is
 * refunded or credited, while a patient told they owe $50 less has to be chased for money the
 * practice already said was not theirs.
 *
 * It is an ASSUMPTION either way, so `detectExceptions` raises `deductible-unknown` as a critical
 * flag and the line carries a note. Quoting conservatively without saying so would be a different
 * kind of dishonest.
 *
 * When the payer stated neither figure there is nothing to assume FROM, and inventing a deductible
 * would be fabricating a number. Nothing is applied, and the same critical flag fires.
 */
function assumedDeductibleRemaining(benefits: Benefits): { amount: Cents; assumed: boolean } {
  const { remaining, individualAnnual } = benefits.deductible;
  if (remaining !== null) return { amount: remaining, assumed: false };
  if (individualAnnual !== null) return { amount: individualAnnual, assumed: true };
  return { amount: ZERO, assumed: true };
}

export function calculateCoverage(
  items: TreatmentPlanItem[],
  benefits: Benefits,
  today: Date = new Date(),
  /**
   * The practice's IANA timezone — the zone `today` is resolved to a calendar day in, for the
   * waiting-period comparison. Defaults to UTC so every existing caller is unchanged; the
   * composition root passes the configured zone, as it does to the deadline engines.
   */
  timeZone = "UTC",
  /**
   * What this payer has been observed to allow, per procedure code, PER UNIT (F-1).
   *
   * A plain lookup rather than a repository, so this engine stays pure and every existing caller is
   * unchanged by omitting it. A code with no entry falls back to the billed fee, which is exactly
   * the behaviour that shipped before this parameter existed — so an empty map and no map are the
   * same estimate, and a practice with no remittance history yet is quoted exactly as it always was.
   */
  allowedFor: (cdtCode: string) => Cents | null = () => null
): CoverageCalculation {
  const todayDay = calendarDay(today, timeZone);
  const deductibleAssumption = assumedDeductibleRemaining(benefits);
  let deductibleRemaining: Cents = deductibleAssumption.amount;
  /**
   * An unstated annual maximum caps NOTHING, rather than capping everything at zero.
   *
   * `?? 0` at the adapter boundary meant a payer that did not state a maximum produced an estimate
   * where insurance paid nothing on every line — presented to the patient as though the plan were
   * exhausted. Conservative in the cash direction, but it is a false statement about the plan and it
   * kills case acceptance on a fact the payer never asserted. `detectExceptions` raises
   * `annual-max-unknown` instead, which routes the case to a human who can ring the payer.
   */
  let annualMaxRemaining: Cents = benefits.annualMaximum.remaining ?? (Number.MAX_SAFE_INTEGER as Cents);
  const annualMaxStated = benefits.annualMaximum.remaining !== null;
  // Track frequency usage as we consume it across the plan itself (keyed by the limit object).
  const freqUsed = new Map<FrequencyLimit, number>();

  const lines: CoverageLine[] = items.map((item) => {
    const proc = findProcedure(item.code);
    const quantity = Math.max(1, Math.floor(item.quantity));
    const unitFee: Cents = item.fee ?? proc?.typicalFee ?? ZERO;
    const fee: Cents = (unitFee * quantity) as Cents;

    /**
     * The basis the payer actually adjudicates against (F-1).
     *
     * An in-network payer pays a percentage of its CONTRACTED ALLOWANCE, not of whatever the
     * practice bills, and the gap between the two is a write-off the contract forbids billing to
     * the patient. Pricing off `unitFee` therefore overstated the insurance share AND handed the
     * write-off to the patient, because with only two buckets every cent of the fee had to land in
     * one of them.
     *
     * An allowance ABOVE the billed fee is ignored rather than used: a payer never pays more than
     * what was billed, so that reading is a stale rate or a fee the practice has since lowered, and
     * quoting insurance to pay more than the charge would be visibly absurd on the patient card.
     */
    const observedUnitAllowed = allowedFor(item.code);
    const unitAllowed: Cents =
      observedUnitAllowed !== null && observedUnitAllowed > 0 && observedUnitAllowed < unitFee
        ? observedUnitAllowed
        : unitFee;
    const allowedTotal: Cents = (unitAllowed * quantity) as Cents;
    const writeOff: Cents = subCents(fee, allowedTotal);
    const notes: string[] = [];
    // Tooth number is passed through untouched — the estimate ignores it, the claim needs it.
    const tooth = item.toothNumber ? { toothNumber: item.toothNumber } : {};

    if (!proc) {
      return {
        code: item.code,
        /**
         * Named so it cannot be mistaken for the procedure's own name (D5, Option C — description
         * half). "Unknown procedure code" is a phrase a patient reads as the name of the treatment
         * they are being quoted for, on the line carrying the largest number on the page.
         *
         * The code is NOT repeated here. Both surfaces that print this already print the code
         * beside it — the patient estimate renders `${l.code}  ${l.description}` and the
         * coordinator's flag renders `${line.code} (${line.description})` — so quoting it again
         * produced "D6058 (Unrecognized procedure (code D6058))". Saying the same identifier three
         * times in one line reads as a defect in the software, which is its own kind of noise on a
         * document a patient is deciding treatment from.
         *
         * Display only — the 837D carries the code, the fee and the tooth number, never this.
         */
        description: "Unrecognized procedure code",
        /**
         * No category, stated as such.
         *
         * This was `"basic"` — invented for a code nobody has classified. It was inert only by
         * accident of control flow: every category reader sits after this early return and reads
         * `proc.category` from the catalog record, so nothing ever spent the fabrication. That made
         * it one refactor away from pricing an unknown procedure at the basic percentage, applying
         * the basic deductible and honouring a basic waiting period — three statements about a
         * plan, derived from a bucket no one assigned.
         *
         * `UNCATEGORIZED` is deliberately NOT a sixth `ProcedureCategory`: that union is the set of
         * buckets a plan prices, and "we could not classify this" is not one. Lookups go through
         * `benefitCategoryOf`, which answers null here.
         */
        category: UNCATEGORIZED,
        ...tooth,
        quantity,
        fee,
        coveragePercent: 0,
        deductibleApplied: ZERO,
        insurancePays: ZERO,
        patientPays: fee,
        notes: [`CDT code "${item.code}" is not in the catalog; treated as not covered.`],
        denied: true,
        /**
         * Mermaid's gap, not the payer's refusal (D5). Without a reason this fell through
         * `analysis.ts`'s classifier to `exclusion` and was counted by `summary.ts` as a procedure
         * "the plan doesn't cover" — a statement about a plan that was never asked about this code.
         *
         * `denied: true` and the full fee stand: the catalog holds 24 codes, and quoting coverage
         * on one it has never seen would be the worse error.
         */
        denialReason: "procedure-unrecognized",
      };
    }

    const base = {
      code: proc.code,
      description: proc.description,
      category: proc.category,
      ...tooth,
      quantity,
      fee,
      notes,
    };

    /**
     * The REASON is a parameter, not something to infer downstream from the note text.
     *
     * `analysis.ts` used to classify these by substring-matching `why` — so the unstated-category
     * note, whose own words are "this is an unknown, not an exclusion", was labelled `exclusion`.
     * The branches below have always been distinct; only the tag was missing.
     */
    const denied = (
      why: string,
      reason: NonNullable<CoverageLine["denialReason"]>,
      /**
       * The figures behind the reason, where the patient sentence is meaningless without them (D2).
       * Only the two covered-but-not-now reasons carry any; the rest have nothing to quantify.
       */
      detail?: CoverageLine["denialDetail"]
    ): CoverageLine => {
      notes.push(why);
      /**
       * ── WHAT A DENIED LINE COSTS THE PATIENT (L-3) ────────────────────────────────────────────
       *
       * Every denied line used to be quoted at the billed fee. That is right when there is no
       * covered benefit to price against, and wrong when the plan covers the procedure and is
       * merely refusing this instance of it: the contract prices a covered procedure whether or not
       * the plan paid on this claim, so the patient owes the contracted amount, not the list price.
       *
       * `contractCapsPatientLiability` decides that from the payer's OWN stated reason rather than
       * from a blanket policy — see its comment for what the distinction rests on and for the one
       * case (`excluded`) that genuinely varies by agreement.
       *
       * With no observed rate, `allowedTotal` IS `fee`, so this is byte-identical to the previous
       * behaviour for any practice that has not yet been paid by this payer for this code.
       */
      const capped = contractCapsPatientLiability(reason);
      const patientOwes = capped ? allowedTotal : fee;
      const writtenOff = subCents(fee, patientOwes);
      return {
        ...base,
        ...(writtenOff > 0 ? { allowedAmount: patientOwes, contractualWriteOff: writtenOff } : {}),
        coveragePercent: 0,
        deductibleApplied: ZERO,
        insurancePays: ZERO,
        patientPays: patientOwes,
        denied: true,
        denialReason: reason,
        ...(detail ? { denialDetail: detail } : {}),
      };
    };

    /**
     * ── A REFUSAL AND A SILENCE PRODUCE THE SAME NUMBER, NOT THE SAME REASON (M18, D3) ───────────
     * Both quote the full fee to the patient, and that is right either way: promising coverage
     * nobody stated would be worse. What was wrong is that a payer who said NOTHING about the
     * policy was recorded as having said the policy is not active — on the line, in the note staff
     * read, and in the coverage snapshot the claim inherits, where it outlives this module.
     *
     * The reason is split; the arithmetic is untouched.
     */
    if (benefits.eligibility === "inactive") {
      return denied("Coverage is not active; the full fee is patient responsibility.", "coverage-inactive");
    }
    if (benefits.eligibility !== "active") {
      return denied(
        // M18's sentence, so the line note and the coordinator's flag say the same thing.
        "The payer did not state whether this member's coverage is active; the full fee is quoted " +
          "to the patient until it is confirmed.",
        "eligibility-unknown"
      );
    }

    // 1. Exclusions.
    if (benefits.excludedCodes.includes(proc.code)) {
      return denied(`Procedure ${proc.code} is excluded by the plan.`, "excluded");
    }

    // 2. Waiting periods.
    const wp = benefits.waitingPeriods.find((w) => w.category === proc.category);
    if (wp) {
      const elapsed = monthsElapsed(wp.coverageEffectiveDate, todayDay);
      if (elapsed < wp.months) {
        return denied(
          `${proc.category} services have a ${wp.months}-month waiting period; ` +
            `only ${elapsed} month(s) have elapsed since coverage began.`,
          "waiting-period",
          { kind: "waiting-period", monthsRequired: wp.months, monthsElapsed: elapsed }
        );
      }
    }

    // 3. Frequency limits (partial denial: units over the allowance).
    let coveredQty = quantity;
    const fl = benefits.frequencyLimits.find((f) => f.codes.includes(proc.code));
    if (fl) {
      const alreadyConsumed = fl.used + (freqUsed.get(fl) ?? 0);
      const allowance = Math.max(0, fl.limit - alreadyConsumed);
      coveredQty = Math.min(quantity, allowance);
      freqUsed.set(fl, (freqUsed.get(fl) ?? 0) + coveredQty);
      if (coveredQty < quantity) {
        notes.push(`${fl.description} ${alreadyConsumed} of ${fl.limit} already used — ${quantity - coveredQty} unit(s) not covered.`);
      }
      if (coveredQty === 0) {
        return denied(
          "Frequency limit reached; this service is not covered again this period.",
          "frequency-limit",
          // `alreadyConsumed`, not `fl.used`: when this same treatment plan spent the remainder of
          // the allowance, `fl.used` alone would render "1 of 2" on a line that is fully denied.
          { kind: "frequency-limit", used: alreadyConsumed, limit: fl.limit, description: fl.description }
        );
      }
    }

    /**
     * 4. Coverage percentage on the covered portion of the fee.
     *
     * A category the payer did not mention is ABSENT, not zero (M17). Both readings deny the line —
     * assuming coverage nobody stated would be worse — but they are different facts and the note
     * must say which one it is. "The plan covers 0% of major services" is an assertion about the
     * plan; when the payer never mentioned major services, it is an assertion Mermaid invented, and
     * a patient declines treatment on the strength of it.
     */
    // A rate the payer stated for THIS code beats the category's, which may blend several.
    const statedPercent =
      benefits.procedureCoveragePercentages?.[proc.code] ?? benefits.coveragePercentages[proc.category];
    const coveragePercent = statedPercent ?? 0;
    /**
     * Priced against the ALLOWANCE, not the fee. The deductible and the coverage percentage both
     * apply to what the payer recognises; applying them to the billed fee is what overstated the
     * insurance share on every in-network claim.
     */
    const coveredFee: Cents = (unitAllowed * coveredQty) as Cents;
    if (statedPercent === undefined) {
      return denied(
        `The payer did not state what this plan covers for ${proc.category} services, so nothing can ` +
          `be promised. Treated as patient responsibility until it is confirmed with the payer — this ` +
          `is an unknown, not an exclusion.`,
        "coverage-unknown"
      );
    }
    if (coveragePercent === 0) {
      return denied(`The plan covers 0% of ${proc.category} services.`, "zero-percent-stated");
    }

    // 5. Deductible (consumed once across the plan).
    let deductibleApplied: Cents = ZERO;
    if (benefits.deductible.appliesTo.includes(proc.category) && deductibleRemaining > 0) {
      deductibleApplied = Math.min(deductibleRemaining, coveredFee) as Cents;
      deductibleRemaining = subCents(deductibleRemaining, deductibleApplied);
      if (deductibleApplied > 0) {
        notes.push(
          deductibleAssumption.assumed
            ? `${formatUsd(deductibleApplied)} deductible applied — the payer did not state how much ` +
              `of the deductible is still to be met, so the FULL annual amount is assumed unmet. ` +
              `Confirm with the payer; the patient's share may be lower.`
            : `${formatUsd(deductibleApplied)} deductible applied.`
        );
      }
    }

    // 6. Insurance pays coverage% of the post-deductible amount, capped by remaining annual max.
    let insurancePays: Cents = scaleCents(subCents(coveredFee, deductibleApplied), coveragePercent / 100);
    if (insurancePays > annualMaxRemaining) {
      notes.push(`Annual maximum caps this benefit at ${formatUsd(annualMaxRemaining)} (calculated benefit was ${formatUsd(insurancePays)}).`);
      insurancePays = annualMaxRemaining;
    }
    annualMaxRemaining = subCents(annualMaxRemaining, insurancePays);
    if (!annualMaxStated) {
      notes.push(
        "The payer did not state a remaining annual maximum, so this benefit is shown uncapped. " +
          "Confirm the plan's remaining maximum before treating this figure as what insurance will pay."
      );
    }

    /**
     * The patient owes the ALLOWANCE less what insurance pays. Not `fee − insurancePays`, which
     * handed them the contractual write-off — the single most expensive line in this file, because
     * a patient declining treatment over an inflated quote costs the practice the whole case and
     * shows up in no report.
     */
    const patientPays: Cents = subCents(allowedTotal, insurancePays);
    return {
      ...base,
      ...(writeOff > 0 ? { allowedAmount: allowedTotal, contractualWriteOff: writeOff } : {}),
      coveragePercent,
      deductibleApplied,
      insurancePays,
      patientPays,
      denied: false,
    };
  });

  /**
   * ── PRE-AUTHORISATION IS ASKED OF EVERY LINE, AFTER THE MONEY IS SETTLED ──────────────────────
   * After, because the amount at risk is the INSURANCE SHARE this engine just computed — what a
   * refusal under CARC 197 actually removes. Asking before would only have the billed fee, which
   * overstates the exposure by the contractual write-off, money nobody could collect anyway.
   *
   * Every line is asked, including denied ones: a line denied for some other reason still carries a
   * pre-auth requirement, and hiding it would mean a practice that fixed the other problem walked
   * straight into this one.
   */
  const withPreAuth: CoverageLine[] = lines.map((line) => {
    const verdict = preAuthRequirementFor(
      { code: line.code, category: benefitCategoryOf(line.category) },
      line.fee,
      benefits
    );
    const risk = revenueAtRisk({
      requirement: verdict.requirement,
      fee: line.fee,
      ...(line.allowedAmount !== undefined ? { allowedAmount: line.allowedAmount } : {}),
      insurancePays: line.insurancePays,
    });
    return { ...line, preAuth: verdict, preAuthRiskAmount: risk };
  });

  return {
    lines: withPreAuth,
    /**
     * Summed over `required` AND `unknown` — see `preAuthRevenueAtRisk`. Not part of the three-way
     * fee identity: this is a risk against the insurance share, not a fourth share of the fee.
     */
    preAuthRevenueAtRisk: addCents(...withPreAuth.map((l) => l.preAuthRiskAmount ?? ZERO)),
    totalFee: addCents(...lines.map((l) => l.fee)),
    totalInsurancePays: addCents(...lines.map((l) => l.insurancePays)),
    totalPatientPays: addCents(...lines.map((l) => l.patientPays)),
    /** Zero on an estimate priced entirely off billed fees, which is every estimate before F-1. */
    totalContractualWriteOff: addCents(...lines.map((l) => l.contractualWriteOff ?? ZERO)),
    deductibleAppliedTotal: addCents(...lines.map((l) => l.deductibleApplied)),
    /**
     * Null when the payer never stated a maximum. The sentinel this engine reasons with internally
     * (`MAX_SAFE_INTEGER`, meaning "uncapped") must not escape into a snapshot a claim inherits and
     * a report prints — it would read as a real, enormous remaining benefit.
     */
    annualMaxRemainingAfter: annualMaxStated ? annualMaxRemaining : null,
  };
}
