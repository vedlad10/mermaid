/**
 * Estimate domain types — the front-half coverage/estimate model, shared because the estimate is
 * inherited by the claim (blueprint doc 04, doc 03 `claims.coverage_snapshot`). Money is `Cents`.
 *
 * `Benefits` is the version-agnostic logical shape the estimate engine reasons over; `BenefitSnapshot`
 * is its persisted form, carrying `snapshot_version` (the anti-drift guard, blueprint doc 16 R5).
 */
import type { Cents } from "../money.ts";
import type { Snapshot } from "../snapshot.ts";
import type { PreAuthorizationPolicy, PreAuthVerdict } from "./preauth.ts";

export type ProcedureCategory =
  | "diagnostic"
  | "preventive"
  | "basic"
  | "major"
  | "orthodontic";

/**
 * A line whose procedure Mermaid's catalog does not hold, and which therefore has NO category.
 *
 * ── WHY THIS IS NOT A SIXTH `ProcedureCategory` ────────────────────────────────────────────────
 * `ProcedureCategory` is the set of buckets a PLAN prices: waiting periods are declared per
 * category, `coveragePercentages` is keyed by category, and `deductible.appliesTo` lists them.
 * Every one of those is a statement about the payer's benefits, and "we could not classify this"
 * is not one of them — adding it to that union would make it addressable as a benefit bucket and
 * invite exactly the lookup this value exists to prevent.
 *
 * So the closed union stays closed, and only the LINE types widen. A line can be uncategorized; a
 * benefit rule cannot.
 */
export const UNCATEGORIZED = "uncategorized" as const;

/** What a line's category may be: a real benefit bucket, or an explicit absence of one. */
export type LineCategory = ProcedureCategory | typeof UNCATEGORIZED;

/**
 * The benefit bucket to price a line against, or null when there is none.
 *
 * ── WHY A FUNCTION RATHER THAN A CAST ──────────────────────────────────────────────────────────
 * An unrecognized line used to carry `category: "basic"`, invented for a code nobody had
 * classified. It was inert only by accident of control flow — the estimate returns before any
 * category is read — so the fabrication was one refactor away from silently pricing an unknown
 * procedure at the basic-services percentage, applying the basic deductible, and honouring a basic
 * waiting period, all on a category no one assigned.
 *
 * Every lookup goes through here, so "no category" cannot be spent as if it were one. Null means
 * the caller must decide what no-data does; it must never mean "basic".
 */
export function benefitCategoryOf(category: LineCategory): ProcedureCategory | null {
  return category === UNCATEGORIZED ? null : category;
}

export interface WaitingPeriod {
  category: ProcedureCategory;
  months: number;
  /** ISO date coverage became effective. */
  coverageEffectiveDate: string;
}

export interface FrequencyLimit {
  /** CDT codes this limit applies to. */
  codes: string[];
  limit: number;
  period: "calendar-year" | "12-months" | "36-months";
  /** How many are already used this period. */
  used: number;
  description: string;
}

/**
 * ── NULL MEANS "THE PAYER DID NOT STATE IT". IT NEVER MEANS ZERO. (M4, M17) ────────────────────
 *
 * Every money figure and every percentage below is nullable, and the reason is a defect these
 * fields carried from the beginning: both adapters coalesced a missing figure to `0`
 * (`parsed.deductible.remaining ?? 0`), so a payer that stated an annual deductible and omitted the
 * remaining balance — which is extremely common — was read as "the deductible is fully met".
 *
 * That is the dangerous direction. The estimate applied no deductible, the patient was quoted less
 * than they owed, and the practice discovered it at the ERA as `PR-1 deductible` — after quoting
 * someone. Nothing flagged it, because `perFieldConfidence.deductible` only dropped when the ANNUAL
 * amount was missing, which is the case where a missing remaining is least surprising.
 *
 * It is the same shape as the coverage-date defect (V6): a field that is legitimately nullable and
 * a coalesce that made "we do not know" indistinguishable from a real value. Here the collapse was
 * to a number that reads as good news.
 *
 * So the distinction lives in the type, and every consumer has to decide what to do with it.
 * `calculateCoverage` quotes CONSERVATIVELY from a null, and `detectExceptions` raises a critical
 * flag so a human sees that the quote rests on an assumption rather than on the payer's answer.
 *
 * Snapshots written before this existed carry numbers, which remain valid and read exactly as
 * before. A pre-existing `0` that actually meant "not stated" is indistinguishable and stays so —
 * that history cannot be recovered, only stopped from growing.
 */
export interface Benefits {
  eligibility: "active" | "inactive" | "unknown";
  /** Payer name, when known — carried for reports/summaries; not used by the estimate math. */
  payerName?: string;
  planName: string;
  deductible: {
    /** The plan's annual individual deductible, or null when the payer did not state one. */
    individualAnnual: Cents | null;
    /** How much of it is still to be met, or null when the payer did not state it. */
    remaining: Cents | null;
    /** Categories the deductible applies to (typically not preventive). */
    appliesTo: ProcedureCategory[];
  };
  annualMaximum: { amount: Cents | null; used: Cents | null; remaining: Cents | null };
  /**
   * Coverage percentage (0–100) per category. A category the payer did not mention is ABSENT, which
   * is not the same as a plan that covers 0% of it — one is silence and the other is an exclusion,
   * and the estimate must not report the first as the second.
   */
  coveragePercentages: Partial<Record<ProcedureCategory, number>>;
  /**
   * What the plan pays (0–100) for a specific CDT code, when the payer listed the code against a
   * rate. More specific than the category and preferred over it by the estimate: one category can
   * carry several rates (Cigna's restorative row is 90% for fillings, 60% for inlays and onlays).
   *
   * OPTIONAL: absent on every payer that does not list codes and on every record written before it
   * existed, and then the category percentage applies exactly as before.
   */
  procedureCoveragePercentages?: Record<string, number>;
  waitingPeriods: WaitingPeriod[];
  frequencyLimits: FrequencyLimit[];
  exclusions: string[];
  excludedCodes: string[];
  /**
   * Which services this payer requires approval for BEFORE treatment, as the payer stated it.
   *
   * OPTIONAL, and its absence is load-bearing: absent means the payer has not told us, which is
   * the ordinary case for a 271 and is NOT the same as "nothing needs approval". See
   * `preAuthRequirementFor` — silence must reach the screen as a question, never as permission.
   */
  preAuthorization?: PreAuthorizationPolicy;
  /**
   * The window this coverage is actually in force, as the payer stated it (271 `DTP*346` plan begin
   * and `DTP*347` plan end).
   *
   * ── WHY THIS HAD TO EXIST ────────────────────────────────────────────────────────────────────
   * `eligibility: "active"` answers "is this policy live?" — as of the moment the payer answered.
   * It says nothing about the DATE OF SERVICE, and those are routinely different questions: a
   * patient seen on the 20th whose plan ended on the 5th gets an ACTIVE 271 today and a denied claim
   * next month. Without these dates Mermaid could not represent the difference, so it verified a
   * patient, produced an estimate, quoted them, and filed a claim the payer was always going to
   * refuse — with nothing on any screen suggesting the coverage window had been checked, because it
   * had not been.
   *
   * OPTIONAL, and it has to be: most payers omit the segments, and every record written before this
   * field existed has none. `null` and absent both mean **the payer did not state it** — never
   * "unlimited". Nothing may treat a missing date as permission.
   */
  coverage?: {
    /** ISO day the plan began, or null when the payer did not say. */
    effectiveDate: string | null;
    /** ISO day the plan ends or ended, or null when the payer did not say. */
    terminationDate: string | null;
  };
  /**
   * Other plans the PAYER says this patient has — the 271's `EB*R` ("other or additional payer")
   * with its 2120 benefit-related-entity loop.
   *
   * EVIDENCE, never a decision. A payer's coordination file can be stale or wrong, and the order of
   * benefits is a property of a person on a date that no 271 settles. Nothing creates a coverage
   * record or sets an order of benefits from this; it is shown to the person confirming coverage.
   * Absent when the payer said nothing — which is not "no other plan".
   */
  otherPayers?: OtherPayerEvidence[];
}

/** One other plan a payer named in its 271. Every field is only what the payer sent. */
export interface OtherPayerEvidence {
  /** From NM101 in the 2120 loop: PRP primary, SEP secondary, TTP tertiary, PR unspecified. */
  role: "primary" | "secondary" | "tertiary" | "unspecified";
  name: string | null;
  idQualifier: string | null;
  id: string | null;
  /** EB04 insurance type code, as sent. */
  insuranceType: string | null;
  /** EB05 plan coverage description, as sent. */
  planDescription: string | null;
}

/** Persisted, versioned benefits (what lands in `coverages.benefit_snapshot`). */
export type BenefitSnapshot = Snapshot<Benefits>;

export interface TreatmentPlanItem {
  /** CDT code. */
  code: string;
  toothNumber?: string;
  quantity: number;
  /** Clinic fee per unit; falls back to the CDT typical fee. */
  fee?: Cents;
}

export interface CoverageLine {
  code: string;
  description: string;
  /**
   * The benefit bucket this line was priced against, or `UNCATEGORIZED` when the code is not in
   * Mermaid's catalog and no bucket was ever assigned (D5, Option C). Read it through
   * `benefitCategoryOf`, never directly, so an absence cannot be spent as if it were "basic".
   */
  category: LineCategory;
  /**
   * Carried through from the treatment plan. Not used by the estimate math, but the claim inherits
   * this line verbatim and a payer rejects a tooth-specific procedure filed without a tooth number —
   * so dropping it here would mean re-deriving it later from data the claim no longer has.
   */
  toothNumber?: string;
  quantity: number;
  /** What the practice bills for this line, all units. Unchanged by anything below. */
  fee: Cents;
  /**
   * The payer's contracted allowance for this line, when one has been observed (F-1).
   *
   * The figure the payer actually adjudicates against. Absent when this payer has never stated a
   * rate for this code, and absent on every estimate produced before this existed — in both cases
   * the line was priced off the billed fee, which is what the reader should assume.
   */
  allowedAmount?: Cents;
  /**
   * Whether this payer requires approval BEFORE this service is done, and why (pre-auth).
   *
   * Present on every line once the estimate knows how to ask — including the `unknown` answer,
   * which is the ordinary one and must not be mistaken for "not required". Absent only on estimates
   * produced before this existed.
   */
  preAuth?: PreAuthVerdict;
  /**
   * What a pre-auth refusal would cost on this line: the money the PAYER would otherwise have paid.
   *
   * Not the billed fee — a CARC 197 refusal comes under `CO`, which forbids billing the patient, so
   * the contractual write-off was never collectable from anyone and including it would overstate
   * the exposure. Zero when no approval is needed.
   */
  preAuthRiskAmount?: Cents;
  /**
   * `fee − allowedAmount`: money that is nobody's (F-1).
   *
   * Not the payer's, because the contract says they need not pay it. Not the patient's, because the
   * same contract forbids billing it to them. Quoting it to a patient — which is what
   * `fee − insurancePays` did — bills them for money no one will ever collect, and a patient who
   * declines treatment over it is revenue that appears in no report.
   */
  contractualWriteOff?: Cents;
  coveragePercent: number;
  deductibleApplied: Cents;
  insurancePays: Cents;
  patientPays: Cents;
  notes: string[];
  denied: boolean;
  /**
   * WHY this line was denied — the distinction `denied` alone cannot carry.
   *
   * ── THE DEFECT THIS EXISTS TO FIX ──────────────────────────────────────────────────────────────
   * `denied: true` was emitted identically for three genuinely different facts: the payer listed the
   * code as excluded, the payer stated 0% for the category, and the payer NEVER MENTIONED the
   * category. Only the free-text note differed, and the downstream classifier matched on that text —
   * so a note reading "this is an unknown, not an exclusion" was labelled `exclusion`, and the
   * patient card said "N procedures the plan doesn't cover" about a category the payer was silent on.
   *
   * "Your plan does not cover this" is a statement about the plan. When the payer said nothing, it is
   * a statement Mermaid invented, and a patient declines treatment on the strength of it.
   *
   * Optional because records written before this existed do not carry it; absent means "not
   * recorded", never "no reason".
   */
  denialReason?:
    | "excluded"
    | "zero-percent-stated"
    | "coverage-unknown"
    | "waiting-period"
    | "frequency-limit"
    | "coverage-inactive"
    /**
     * The payer never stated whether the POLICY is live, so every line is quoted to the patient
     * without a coverage answer behind it.
     *
     * Three separate facts, and the union has to keep all three apart (D3):
     *   • `coverage-inactive`  — the payer SAID the policy is not active. A refusal.
     *   • `coverage-unknown`   — the policy is live, but the payer said nothing about THIS category.
     *   • `eligibility-unknown` — the payer said nothing about the policy AT ALL.
     *
     * It shares the name with `ExceptionFlag`'s `eligibility-unknown` code deliberately: M18 already
     * established that vocabulary one layer up, for the same fact, against the same alternative. Two
     * names for one state is how the distinction gets lost again.
     */
    | "eligibility-unknown"
    /**
     * The CDT code is not in Mermaid's procedure catalog, so no benefit rule was ever applied.
     *
     * The odd one out of this union, and named for it. Every other reason records something the
     * PAYER did or did not say; this records something MERMAID does not know. `coverage-unknown`
     * and `eligibility-unknown` both mean "the payer was silent", and folding this in beside them
     * as `procedure-unknown` would put our own gap in the same family as their silence — which is
     * the misattribution this value exists to stop. "Unrecognized" says whose ignorance it is.
     *
     * The line is still denied and still charged to the patient in full: promising coverage on a
     * code nobody has classified would be worse. Only the stated reason changes.
     */
    | "procedure-unrecognized";
  /**
   * The FIGURES behind the reason, for the two reasons whose sentence is meaningless without them.
   *
   * ── WHY THIS IS CARRIED AND NOT RE-DERIVED (D2) ────────────────────────────────────────────────
   * A waiting period and a spent frequency allowance are COVERED benefits — the plan pays for them,
   * just not yet or not again this period. They were described to a patient in the same words as a
   * genuine exclusion ("procedures the plan doesn't cover"), which is a statement about the plan
   * that is simply untrue, and a patient declines treatment they could have had months later, or
   * rebooked inside the allowance, on the strength of it.
   *
   * Saying the true thing needs the numbers: how many months are left, how much of the allowance is
   * gone. The summarizer holds only the `CoverageLine`, so the alternative would be parsing them
   * back out of the note text — the substring matching B2 removed for exactly this reason.
   *
   * Discriminated on `kind`, which always equals `denialReason`. Optional, and absent means "not
   * recorded": a line written before this existed carries no figures, and the summarizer falls back
   * to language that claims none.
   */
  denialDetail?:
    | { kind: "waiting-period"; monthsRequired: number; monthsElapsed: number }
    /**
     * `used` is what has actually been consumed when the line was denied — `FrequencyLimit.used`
     * plus anything earlier in THIS treatment plan already spent. They differ whenever the plan
     * itself exhausts the allowance, and only this figure makes "you have already used the allowed
     * number" true rather than self-contradicting.
     *
     * No renewal date, and deliberately none: `FrequencyLimit` carries `period` as a NAME
     * ("calendar-year", "12-months", "36-months") and no anchor date, so when the allowance next
     * resets is not knowable from this model. A patient told a date would rebook against it.
     */
    | { kind: "frequency-limit"; used: number; limit: number; description: string };
}

/**
 * What each payer allows, per procedure code, PER UNIT (F-1).
 *
 * `payerId → cdtCode → allowed`. A missing payer or a missing code means "never observed", and the
 * line is priced off the billed fee — the behaviour every estimate had before this existed.
 */
export type FeeSchedule = ReadonlyMap<string, ReadonlyMap<string, Cents>>;

/**
 * Whether a contracted allowed amount caps what the patient may be billed for a DENIED line (L-3).
 *
 * ── THE QUESTION, AND WHY IT IS NOT ONE ANSWER ─────────────────────────────────────────────────
 * When a procedure is denied and a contracted fee schedule exists, is the patient's liability the
 * billed fee or the contracted allowance? Asked as a blanket question it has no correct answer.
 * Asked per line, against the reason the PAYER gave, it does — and this system already records that
 * reason, so the decision is made from data rather than from a policy someone had to invent.
 *
 * ── WHAT THIS RESTS ON ─────────────────────────────────────────────────────────────────────────
 * Two things, neither of them a guess about any particular agreement:
 *
 *   1. Group CO in X12 835 is DEFINED as contractual obligation — the amount a participating
 *      provider may not bill the patient. That is the HIPAA code set's meaning, not a contract
 *      term, and this codebase already relies on it everywhere else money is split.
 *
 *   2. A learned allowance for (payer, code) EXISTS only because that payer applied a CO write-off
 *      to that code for this practice. Its presence is therefore direct evidence that the procedure
 *      is inside the fee schedule — the contract prices it. A participating agreement prices a
 *      covered procedure at the allowed amount whether or not the plan happened to pay on this
 *      claim; the benefit decides who pays, the contract decides how much.
 *
 * So the cap applies when the plan COVERS the procedure and the denial is a benefit limit — the
 * money is the patient's, at the contracted price. It does not apply when there is no covered
 * benefit to price: an inactive policy, a policy we know nothing about, a category the payer never
 * mentioned, or a procedure the plan excludes outright.
 *
 * ── THE ONE CASE THAT GENUINELY VARIES BY AGREEMENT ────────────────────────────────────────────
 * `excluded`. Some participating agreements carry a "non-covered services" clause that caps even
 * excluded procedures at the fee schedule, and a few states legislate it; many do not. That is a
 * real contract term and not derivable from anything the payer sends, so it stays on the billed fee
 * — the reading that does not assume a clause the practice may not have signed. If a practice's
 * agreement does cap non-covered services, this is the one line to change, and it is deliberately
 * the only one.
 */
export function contractCapsPatientLiability(reason: CoverageLine["denialReason"]): boolean {
  switch (reason) {
    // The plan covers this procedure; the payer is refusing THIS instance of it. The contract still
    // prices it, so the patient owes the contracted amount and not the practice's list price.
    case "waiting-period":
    case "frequency-limit":
    case "zero-percent-stated":
      return true;
    // No covered benefit to price against — the policy is not in force, or nobody has said it is,
    // or nobody has said this category is in it, or the plan excludes the procedure outright.
    case "coverage-inactive":
    case "eligibility-unknown":
    case "coverage-unknown":
    case "excluded":
      return false;
    // A line with no recorded reason predates the field. Quoting the lower figure on an unknown
    // basis would understate what a patient owes, and a patient told too little is a collection
    // problem the practice discovers at the desk.
    default:
      return false;
  }
}

export interface CoverageCalculation {
  lines: CoverageLine[];
  totalFee: Cents;
  totalInsurancePays: Cents;
  totalPatientPays: Cents;
  /**
   * Money the contract says nobody owes (F-1). Zero when no contracted rate is known, which is when
   * this estimate is priced entirely off billed fees.
   *
   * ── THE IDENTITY THIS CHANGES ─────────────────────────────────────────────────────────────────
   * It used to be true that `totalFee === totalInsurancePays + totalPatientPays`. That identity was
   * the DEFECT wearing the clothes of an invariant: with no third bucket, every cent of the billed
   * fee had to be assigned to the payer or the patient, so the contractual write-off was silently
   * handed to the patient. The identity is now:
   *
   *     totalFee = totalInsurancePays + totalPatientPays + totalContractualWriteOff
   *
   * which is the same arithmetic the remittance side has always used to split a payment three ways.
   */
  totalContractualWriteOff: Cents;
  /**
   * Money on this plan that a payer may refuse purely because nobody obtained approval first.
   *
   * Deliberately NOT part of the three-way identity above — it is not a fourth share of the fee, it
   * is a risk against the insurance share already counted. Summing it into the split would double
   * count every dollar it describes.
   *
   * Counts `unknown` lines as well as `required` ones, at the same amount: the difference between
   * "we know approval is needed and have none" and "nobody has checked" is a difference in what to
   * do, not in what is exposed, and showing zero for the unchecked case would make not checking
   * look safe.
   */
  preAuthRevenueAtRisk: Cents;
  deductibleAppliedTotal: Cents;
  /** Null when the payer never stated a maximum — there is nothing to have a remainder of. */
  annualMaxRemainingAfter: Cents | null;
}
