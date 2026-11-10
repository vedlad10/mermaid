/**
 * Exception detection + confidence scoring + review routing. Deterministic "AI reasoning": every
 * output carries an explanation so staff see *why* a case was flagged. Ported from Dental Verify's
 * `analysis.ts`; money comparisons/messages use integer cents.
 */
import { formatUsd, scaleCents, type Benefits, type CoverageCalculation } from "@mermaid/shared";
import type {
  ConfidenceComponent,
  ConfidenceReport,
  ExceptionFlag,
  InsuranceCardData,
  PatientInfo,
} from "../types.ts";

/** Cases below this overall confidence are routed to manual review. */
export const REVIEW_THRESHOLD = 0.75;

export function validatePatient(patient: PatientInfo): ExceptionFlag[] {
  const flags: ExceptionFlag[] = [];
  if (!patient.firstName.trim() || !patient.lastName.trim()) {
    flags.push({ severity: "critical", code: "data-validation", message: "Patient first and last name are required." });
  }
  const dob = new Date(patient.dateOfBirth + "T00:00:00");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(patient.dateOfBirth) || isNaN(dob.getTime())) {
    flags.push({ severity: "critical", code: "data-validation", message: `Date of birth "${patient.dateOfBirth}" is not a valid date.` });
  } else if (dob > new Date()) {
    flags.push({ severity: "critical", code: "data-validation", message: "Date of birth is in the future." });
  }
  if (!/^[A-Z0-9-]{6,}$/i.test(patient.memberId.trim())) {
    flags.push({ severity: "warning", code: "data-validation", message: "Member ID looks too short or contains unexpected characters." });
  }
  return flags;
}

export function detectExceptions(
  card: InsuranceCardData,
  patient: PatientInfo,
  benefits: Benefits | null,
  calculation: CoverageCalculation | null,
  /** ISO day of service. Optional so existing callers are unchanged; without it the coverage window
   *  cannot be checked, and the absence is reported rather than assumed away. */
  serviceDate?: string,
  /**
   * Why there are no benefits, when the caller knows — the pipeline does, and this function cannot.
   *
   * `reached: false` (or omitted) is the original behaviour: nothing could address this payer.
   * `reached: true` means a request went out and the payer answered without usable benefits, and
   * `reason` is that answer in the payer's own words. See `benefits-unavailable` in types.ts.
   */
  benefitsOutcome?: { reached: boolean; reason?: string }
): ExceptionFlag[] {
  const flags: ExceptionFlag[] = [];

  if (
    card.memberId.value &&
    patient.memberId &&
    card.memberId.value.replace(/-/g, "").toUpperCase() !== patient.memberId.replace(/-/g, "").toUpperCase()
  ) {
    flags.push({
      severity: "warning",
      code: "member-id-mismatch",
      message: `Member ID on the card (${card.memberId.value}) does not match the one entered (${patient.memberId}).`,
    });
  }

  if (!benefits) {
    if (benefitsOutcome?.reached) {
      const payer = card.payerName.value ?? "The payer";
      const because = benefitsOutcome.reason?.trim();
      flags.push({
        severity: "critical",
        code: "benefits-unavailable",
        // The payer's own words, verbatim, because they are usually the instruction: "Invalid/Missing
        // Subscriber/Insured ID" tells a coordinator to re-read the card, and nothing this function
        // could compose would say it better.
        message: because
          ? `${payer} answered but returned no benefits: ${because}`
          : `${payer} answered but the response carried no benefit information.`,
      });
      return flags;
    }
    flags.push({ severity: "critical", code: "unknown-payer", message: "Benefits could not be retrieved; verify manually with the payer." });
    return flags;
  }

  /**
   * ── "INACTIVE" AND "UNKNOWN" ARE NOT THE SAME ANSWER (M18) ─────────────────────────────────────
   * Both route to a human, and that was already right. But the MESSAGE was the same for both, and
   * the message is what a person acts on: `unknown` produced "The payer reports this member's
   * coverage as not active", which the payer did not report. It reported nothing.
   *
   * The two lead somewhere different. Inactive means find other coverage or collect from the
   * patient. Unknown means ring the payer — the coverage may be perfectly good, and telling a
   * practice otherwise loses a case that would have been paid.
   */
  if (benefits.eligibility === "inactive") {
    flags.push({
      severity: "critical",
      code: "inactive-coverage",
      message: "The payer reports this member's coverage as NOT ACTIVE.",
    });
  } else if (benefits.eligibility !== "active") {
    flags.push({
      severity: "critical",
      code: "eligibility-unknown",
      message:
        "The payer did not state whether this member's coverage is active — this is an UNKNOWN, not a " +
        "refusal. Confirm directly with the payer before quoting the patient or filing.",
    });
  }

  /**
   * Coverage can be ACTIVE today and not have been in force on the day of treatment.
   *
   * ── WHY THIS IS SEPARATE FROM `inactive-coverage` ──────────────────────────────────────────────
   * `eligibility` is the payer's answer to "is this policy live?", as of the instant it replied.
   * The claim is about a DATE OF SERVICE, and the two disagree constantly: a patient seen on the
   * 20th whose plan ended on the 5th gets a perfectly ACTIVE 271 today. Before the benefits model
   * carried a coverage window there was nowhere to notice — Mermaid verified them, priced the plan,
   * quoted the patient, and filed a claim the payer was always going to refuse.
   *
   * Critical rather than a warning: this is not a confidence problem that averaging should soften.
   * It is a fact about whether the payer owes anything at all, and only a person holding the
   * patient's card and calendar can resolve it.
   */
  const window = benefits.coverage;
  if (window && serviceDate) {
    if (window.terminationDate && serviceDate > window.terminationDate) {
      flags.push({
        severity: "critical",
        code: "coverage-terminated",
        message:
          `Coverage ended ${window.terminationDate}, before the ${serviceDate} date of service. ` +
          `The payer reports the policy as ${benefits.eligibility}, but it was not in force on the day of treatment.`,
      });
    }
    if (window.effectiveDate && serviceDate < window.effectiveDate) {
      flags.push({
        severity: "critical",
        code: "coverage-not-yet-effective",
        message:
          `Coverage began ${window.effectiveDate}, after the ${serviceDate} date of service. ` +
          `Treatment on that day predates this policy.`,
      });
    }
  }

  /**
   * ── AN UNSTATED FIGURE IS AN UNKNOWN, NOT AN EXHAUSTED BENEFIT (M4) ────────────────────────────
   * `annualMaximum.remaining` used to be coalesced to `0` at the adapter boundary, so a payer that
   * simply did not state a maximum produced "the annual maximum has been exhausted; no benefits
   * remain this year" — a statement about the plan that the payer never made, on the screen a
   * practice uses to discuss money with a patient. It routed to review, so nothing was lost; it was
   * the sentence that was false, and the sentence is what the person acts on.
   */
  const max = benefits.annualMaximum;
  if (max.remaining === null) {
    flags.push({
      severity: "critical",
      code: "annual-max-unknown",
      message:
        "The payer did not state how much of the annual maximum remains, so the estimate cannot cap " +
        "what insurance will pay. Confirm the remaining maximum with the payer before quoting.",
    });
  } else if (max.remaining <= 0) {
    flags.push({
      severity: "critical",
      code: "annual-max-exhausted",
      message: "The annual maximum has been exhausted; no benefits remain this year.",
    });
  } else if (max.amount !== null && max.remaining < scaleCents(max.amount, 0.15)) {
    flags.push({
      severity: "warning",
      code: "annual-max-near-limit",
      message: `Only ${formatUsd(max.remaining)} of the ${formatUsd(max.amount)} annual maximum remains.`,
    });
  }

  /**
   * ── THE DEDUCTIBLE THE ESTIMATE ASSUMED (M4) ───────────────────────────────────────────────────
   * `calculateCoverage` quotes conservatively when the payer did not state a remaining deductible —
   * it assumes the full annual amount is still to be met, because over-quoting is the recoverable
   * error and under-quoting means chasing a patient for money the practice already said was not
   * theirs. That assumption has to be visible, or a conservative number is just a different
   * invented one.
   *
   * Critical, so the verification routes to a human: only the payer can settle it, and the figure
   * sits directly on what the patient is told they owe.
   */
  if (benefits.deductible.remaining === null) {
    flags.push({
      severity: "critical",
      code: "deductible-unknown",
      message:
        benefits.deductible.individualAnnual === null
          ? "The payer stated no deductible at all. The estimate applies none, so the patient's share may " +
            "be understated. Confirm the deductible with the payer."
          : `The payer did not state how much of the ${formatUsd(benefits.deductible.individualAnnual)} ` +
            `deductible is still to be met. The estimate assumes ALL of it is unmet, so the patient's ` +
            `share may be overstated. Confirm with the payer before collecting.`,
    });
  }

  /**
   * A category the payer never mentioned is silence, not an exclusion (M17). The estimate denies
   * those lines either way — promising coverage nobody stated would be worse — but a patient
   * declines treatment on "your plan does not cover this", and that must only be said when the
   * payer actually said it.
   */
  const unstated = (["diagnostic", "preventive", "basic", "major", "orthodontic"] as const).filter(
    (category) => benefits.coveragePercentages[category] === undefined
  );
  if (unstated.length > 0 && benefits.eligibility === "active") {
    flags.push({
      severity: "warning",
      code: "coverage-percent-unknown",
      message:
        `The payer stated no coverage percentage for ${unstated.join(", ")}. Any treatment in those ` +
        `categories is quoted as fully the patient's — that is an UNKNOWN, not a plan exclusion, and ` +
        `should be confirmed with the payer before telling a patient their plan does not cover it.`,
    });
  }

  // Per-line denial flags are meaningful only for active coverage (else the single
  // inactive-coverage flag already explains why every line is denied).
  if (calculation && benefits.eligibility === "active") {
    for (const line of calculation.lines) {
      if (!line.denied) continue;
      const note = line.notes[line.notes.length - 1] ?? "not covered";
      /**
       * Classified from the REASON the engine recorded, never from the note's wording.
       *
       * This matched substrings: "waiting period" or "frequency", and everything else fell through
       * to `exclusion`. The unstated-category note says, in its own words, "this is an unknown, not
       * an exclusion" — and was labelled `exclusion` anyway. A payer's silence became a statement
       * that the plan does not cover the treatment.
       *
       * `coverage-unknown` is its own code precisely so it can never be read as an exclusion again.
       * A line with no recorded reason keeps the old default, which is the honest answer for records
       * written before the reason existed.
       */
      const code: ExceptionFlag["code"] =
        line.denialReason === "waiting-period"
          ? "waiting-period"
          : line.denialReason === "frequency-limit"
            ? "frequency-limit"
            : line.denialReason === "coverage-unknown"
              ? "coverage-unknown"
              : // A code Mermaid's catalog has never seen is not a code the payer refused (D5). This
                // is the case that reached `exclusion` by falling off the end of the chain rather
                // than by anything asserting it.
                line.denialReason === "procedure-unrecognized"
                ? "procedure-unrecognized"
                : "exclusion";
      flags.push({ severity: "warning", code, message: `${line.code} (${line.description}): ${note}` });
    }
  }

  return flags;
}

export function aggregateConfidence(components: ConfidenceComponent[]): ConfidenceReport {
  // Weakest-link weighting: one bad extraction invalidates the whole estimate, so the overall
  // score is dragged toward the lowest component.
  const avg = components.reduce((s, c) => s + c.confidence, 0) / Math.max(1, components.length);
  const min = Math.min(...components.map((c) => c.confidence), 1);
  const overall = Math.round((avg * 0.6 + min * 0.4) * 100) / 100;
  return { overall, components, reviewThreshold: REVIEW_THRESHOLD };
}

/** A case is auto-verified only when confidence clears the threshold AND nothing critical flagged. */
export function routeForReview(confidence: ConfidenceReport, exceptions: ExceptionFlag[]): { needsReview: boolean; reason: string } {
  const critical = exceptions.filter((e) => e.severity === "critical");
  if (critical.length > 0) {
    return { needsReview: true, reason: `Critical exception(s): ${critical.map((e) => e.code).join(", ")}.` };
  }
  if (confidence.overall < confidence.reviewThreshold) {
    return {
      needsReview: true,
      reason: `Overall confidence ${confidence.overall.toFixed(2)} is below the ${confidence.reviewThreshold} review threshold.`,
    };
  }
  return { needsReview: false, reason: "Confidence above threshold and no critical exceptions." };
}

/**
 * The record status that follows from a routing decision.
 *
 * Extracted from the pipeline when M14 gave a SECOND caller the ability to raise a critical
 * exception — the patient-linking step, which runs after the pipeline has already routed. Two
 * copies of this three-way would be two places to forget that "no benefits AND no review" is
 * `failed` rather than `verified`, and the divergence would only show as a verification quietly
 * reading verified when a human had been asked for.
 */
export function statusFor(hasBenefits: boolean, needsReview: boolean): "needs_review" | "verified" | "failed" {
  if (needsReview) return "needs_review";
  return hasBenefits ? "verified" : "failed";
}
