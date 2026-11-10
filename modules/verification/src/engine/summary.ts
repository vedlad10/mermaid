/**
 * Presentation-layer summarizers — pure functions of a completed verification record. They turn the
 * pipeline's outputs into human language; they NEVER re-derive benefit math (that stays in the
 * deterministic engine). Ported from Dental Verify's `summary.ts`; money uses cents/formatUsd.
 *
 *   • reviewReasons        → the coordinator triaging exceptions: why is this in front of me?
 *   • plainEnglishEstimate → the coordinator explaining the number to a patient.
 *
 * Note: this GENERATES the words a human reads aloud; it does not deliver the bill to the patient.
 * The patient financial conversation stays human (human-in-the-loop-workflow §3).
 */
import { formatUsd, formatUsdOrUnknown } from "@mermaid/shared";
import type { CoverageLine } from "@mermaid/shared";
import type { VerificationRecord } from "../types.ts";

function conjoin(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function namesList(names: string[], max = 3): string {
  if (names.length <= max) return conjoin(names);
  return conjoin([...names.slice(0, max), `${names.length - max} more`]);
}

/** Human reasons a verification is (or would be) routed to review, in the routing agent's order. */
export function reviewReasons(record: VerificationRecord): string[] {
  const reasons: string[] = [];
  for (const e of record.exceptions) if (e.severity === "critical") reasons.push(e.message);
  if (record.confidence.overall < record.confidence.reviewThreshold) {
    reasons.push(
      `Overall confidence ${Math.round(record.confidence.overall * 100)}% is below the ` +
        `${Math.round(record.confidence.reviewThreshold * 100)}% auto-verify threshold.`
    );
  }
  for (const e of record.exceptions) if (e.severity === "warning") reasons.push(e.message);
  return reasons;
}

/** A short plain-language explanation of the estimate — derived entirely from the numbers, so it
 *  always matches the page. Returns [] when there is no estimate to explain. */
export function plainEnglishEstimate(record: VerificationRecord): string[] {
  const calc = record.calculation;
  const benefits = record.benefits;
  if (!calc || !benefits) return [];
  const payer = benefits.payerName ?? "The payer";

  /**
   * ── "INACTIVE" AND "UNKNOWN" ARE NOT THE SAME ANSWER (M18, D3) ─────────────────────────────────
   * The same split `analysis.ts` already makes for the coordinator, made here for the sentence a
   * patient is read aloud. This branch was `!== "active"`, so a payer that answered NOTHING about
   * eligibility produced "reports this member's coverage as not active" — a refusal attributed to a
   * payer who never issued one, told to the patient, with the whole fee moved onto them.
   *
   * The two lead somewhere different, and the difference is the patient's money. Inactive means
   * find other coverage or pay. Unknown means ring the payer first: the coverage may be perfectly
   * good, and a practice that collects in full on a silence has charged a patient for a plan that
   * would have paid.
   *
   * The inactive wording is untouched — when the payer did say it, saying so is correct.
   */
  if (benefits.eligibility === "inactive") {
    return [
      `${payer} reports this member's coverage as not active, so the full ${formatUsd(calc.totalFee)} ` +
        `treatment fee is the patient's responsibility.`,
    ];
  }

  if (benefits.eligibility !== "active") {
    // Deliberately quotes no figure. Any number here would rest on an answer the payer did not give.
    return [
      `${payer} did not confirm whether this member's coverage is currently active. ` +
        `Please contact ${payer} directly to verify coverage before proceeding.`,
    ];
  }

  /**
   * The sentence a person reads ALOUD to a patient, so its arithmetic has to survive being heard.
   *
   * Once a contracted rate is known (F-1) the plan splits three ways, and the old sentence named
   * only two of them: "pays $500.00 of the $1,250.00 plan, leaving about $500.00 for the patient"
   * is a claim a patient can see does not add up, asked about at the desk, and answered badly.
   *
   * The write-off is also the best news in the sentence and was going unsaid. It is the difference
   * between "this costs you $625.00" and "this costs you $500.00 because we have a contract with
   * your insurer" — the second is why a patient accepts treatment.
   */
  const writeOff = calc.totalContractualWriteOff;
  const sentences: string[] = [
    writeOff > 0
      ? `Of the ${formatUsd(calc.totalFee)} treatment plan, ${formatUsd(writeOff)} is written off ` +
        `under this practice's contract with ${payer} and is charged to nobody. ${payer} is ` +
        `estimated to pay ${formatUsd(calc.totalInsurancePays)} of the rest, leaving about ` +
        `${formatUsd(calc.totalPatientPays)} for the patient.`
      : `${payer} is estimated to pay ${formatUsd(calc.totalInsurancePays)} of the ${formatUsd(calc.totalFee)} ` +
        `treatment plan, leaving about ${formatUsd(calc.totalPatientPays)} for the patient.`,
  ];

  const denied = calc.lines.filter((l) => l.denied);
  /**
   * "The plan doesn't cover this" is a statement about the PLAN, and it may only be made when the
   * payer actually made it. A category the payer never mentioned is an unknown: the line is still
   * quoted as the patient's (promising coverage nobody stated would be worse), but the sentence a
   * patient reads must not turn that silence into a refusal.
   *
   * ── AND A COVERED BENEFIT IS NOT AN UNCOVERED ONE (D2) ─────────────────────────────────────────
   * A waiting period and a spent frequency allowance were counted here too, so a plan that pays for
   * a crown in four months' time, or for the next cleaning in the next benefit period, was
   * described to the patient as a plan that "doesn't cover" it. That is a statement about the plan,
   * and it is false: the benefit exists. A patient declines treatment they could have had by
   * waiting, or rebooked inside the allowance, on the strength of it.
   *
   * Each now leaves this bucket and gets its own sentence, with the figures the engine already
   * computed — read from `denialDetail`, never parsed back out of the note.
   *
   * ── AND MERMAID'S OWN GAP IS NOT THE PAYER'S REFUSAL (D5) ──────────────────────────────────────
   * A CDT code missing from Mermaid's 24-entry catalog was denied with no reason at all, fell off
   * the end of `analysis.ts`'s classifier to `exclusion`, and was counted here too — so a patient
   * was told their plan does not cover a procedure the plan was never asked about. The catalog is
   * small, so this is the ordinary case for most of the CDT set, not an edge one.
   */
  const COVERED_BUT_NOT_NOW = ["waiting-period", "frequency-limit"] as const;
  const isCoveredButNotNow = (l: CoverageLine) =>
    COVERED_BUT_NOT_NOW.includes(l.denialReason as (typeof COVERED_BUT_NOT_NOW)[number]);

  const notCovered = denied.filter(
    (l) =>
      l.denialReason !== "coverage-unknown" && l.denialReason !== "procedure-unrecognized" && !isCoveredButNotNow(l)
  );
  const unknownCoverage = denied.filter((l) => l.denialReason === "coverage-unknown");
  const unrecognized = denied.filter((l) => l.denialReason === "procedure-unrecognized");
  const waiting = denied.filter((l) => l.denialReason === "waiting-period");
  const overLimit = denied.filter((l) => l.denialReason === "frequency-limit");
  const hasDeductible = calc.deductibleAppliedTotal > 0;

  if (calc.totalPatientPays === 0) {
    sentences.push("Every planned procedure is covered in full — the patient owes nothing.");
  } else {
    const drivers: string[] = [];
    if (hasDeductible) drivers.push(`a ${formatUsd(calc.deductibleAppliedTotal)} deductible`);
    if (notCovered.length > 0) {
      drivers.push(
        `${notCovered.length} procedure${notCovered.length === 1 ? "" : "s"} the plan doesn't cover ` +
          `(${namesList(notCovered.map((l) => l.description))})`
      );
    }
    if (unknownCoverage.length > 0) {
      drivers.push(
        `${unknownCoverage.length} procedure${unknownCoverage.length === 1 ? "" : "s"} we don't yet have ` +
          `plan information for (${namesList(unknownCoverage.map((l) => l.description))})`
      );
    }
    if (unrecognized.length > 0) {
      // Named by CODE, not by `description` — the description on these lines is the placeholder
      // "Unknown procedure code", and a list of those tells a patient nothing about which item it is.
      drivers.push(
        `${unrecognized.length} procedure${unrecognized.length === 1 ? "" : "s"} we don't have on file ` +
          `(${namesList(unrecognized.map((l) => l.code))})`
      );
    }
    if (waiting.length > 0) {
      drivers.push(
        `${waiting.length} procedure${waiting.length === 1 ? "" : "s"} in a waiting period ` +
          `(${namesList(waiting.map((l) => l.description))})`
      );
    }
    if (overLimit.length > 0) {
      drivers.push(
        `${overLimit.length} procedure${overLimit.length === 1 ? "" : "s"} over the plan's frequency limit ` +
          `(${namesList(overLimit.map((l) => l.description))})`
      );
    }
    sentences.push(
      drivers.length > 0
        ? `The patient's share reflects ${conjoin(drivers)}, plus standard coinsurance on the covered procedures.`
        : "The patient's share is the standard coinsurance the plan leaves after applying its coverage percentages."
    );
    if (unknownCoverage.length > 0) {
      sentences.push(
        "We don't yet have information from your plan about coverage for this — we'll follow up once we do."
      );
    }

    /**
     * One sentence per benefit, because the figures differ per line and a merged sentence would
     * have to pick one set of numbers and apply it to all of them.
     *
     * A line with no `denialDetail` — written before the figures were carried — is skipped rather
     * than described with invented ones. It keeps its place in the count above, which claims only
     * that the benefit exists and is not available yet, and that much is true without the numbers.
     */
    for (const line of unrecognized) {
      sentences.push(
        `We couldn't find ${line.code} in our procedure list, so we don't yet know how your plan ` +
          `covers it. We're treating it as the patient's full responsibility for now — please check ` +
          `with our office or the payer to confirm.`
      );
    }
    for (const line of waiting) {
      const detail = line.denialDetail;
      if (detail?.kind !== "waiting-period") continue;
      const remaining = Math.max(0, detail.monthsRequired - detail.monthsElapsed);
      sentences.push(
        `This benefit has a waiting period that hasn't fully elapsed yet — coverage should begin ` +
          `once ${remaining} more month(s) have passed. Until then, this procedure is the patient's ` +
          `responsibility.`
      );
    }
    for (const line of overLimit) {
      const detail = line.denialDetail;
      if (detail?.kind !== "frequency-limit") continue;
      /**
       * No date, and no period name. `FrequencyLimit.period` is a label ("calendar-year",
       * "12-months", "36-months") with no anchor, so WHEN the allowance next resets is not knowable
       * from this model — and a patient told a date would rebook against it.
       */
      sentences.push(
        `This plan covers ${detail.description}, but you've already used the allowed number of ` +
          `visits (${detail.used} of ${detail.limit}) for this benefit period.`
      );
    }
  }

  const capped = calc.lines.some((l) => l.notes.some((n) => n.toLowerCase().includes("annual maximum caps")));
  if (capped) {
    sentences.push(
      `Note: the plan's remaining annual maximum (${formatUsdOrUnknown(benefits.annualMaximum.remaining)}) ` +
        `limits what insurance can pay on this plan.`
    );
  }

  return sentences;
}
