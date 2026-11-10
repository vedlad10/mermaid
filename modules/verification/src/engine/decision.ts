/**
 * Decision engine — turns a verification record into an operational decision: not just "does this
 * need review?" but *what is the state, why, on what evidence, and what should a human do next*.
 * Ported from Dental Verify's `decision.ts`; a pure read-model (never persisted, never re-derives
 * benefit math). Money uses cents.
 *
 * `canNotifyPatient` means "the estimate is trustworthy enough to SHARE" — a human still delivers it
 * (human-in-the-loop-workflow §3). It never triggers an automated message to the patient.
 */
import { cents, formatUsd, formatUsdOrUnknown } from "@mermaid/shared";
import { verificationFreshness } from "./freshness.ts";
import { reviewReasons } from "./summary.ts";
import type { VerificationRecord } from "../types.ts";

export interface DecisionEvidence {
  label: string;
  detail: string;
}

export interface Decision {
  outcome: "complete" | "needs_human" | "blocked";
  completedBy: "ai" | "staff" | null;
  confidence: number;
  reasoning: string[];
  evidence: DecisionEvidence[];
  recommendedAction: string;
  canNotifyPatient: boolean;
  escalate: boolean;
  /** 0–100 work-ranking; higher = handle first. */
  priority: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function has(record: VerificationRecord, code: string): boolean {
  return record.exceptions.some((e) => e.code === code);
}

/**
 * What the BENEFITS mean operationally, regardless of where the verification is in its workflow.
 *
 * Null when the coverage carries no consequence a human has to act on.
 */
function coverageConsequence(record: VerificationRecord): string | null {
  /**
   * The payer answered and refused. Split out ahead of the general "no benefits" case because the
   * next act is different: this is a card to re-read, not a payer to ring. See audit C-7 and
   * `benefits-unavailable` in types.ts.
   */
  if (has(record, "benefits-unavailable")) {
    const payer = record.card.payerName.value ?? "The payer";
    const said = record.exceptions.find((e) => e.code === "benefits-unavailable")?.message;
    return (
      `${said ?? `${payer} returned no benefits.`} Nothing here is a coverage estimate. Check the ` +
      `member ID and date of birth against the card and re-verify before quoting this patient.`
    );
  }
  if (!record.benefits || has(record, "unknown-payer")) {
    const payer = record.card.payerName.value ?? "this payer";
    return (
      `Benefits were never retrieved — verify manually with ${payer} by phone or portal before ` +
      `quoting this patient. Nothing here is a coverage estimate.`
    );
  }
  if (has(record, "inactive-coverage")) {
    return (
      "The payer reports this coverage as NOT ACTIVE. This patient pays in full unless coverage is " +
      "reinstated — tell them before treatment, and do not file."
    );
  }
  if (has(record, "eligibility-unknown")) {
    return (
      "The payer did not state whether this member's coverage is active. Confirm directly with them " +
      "before quoting the patient or filing."
    );
  }
  if (has(record, "annual-max-exhausted")) {
    return "No annual-maximum benefits remain this year — discuss costs with the patient before treatment.";
  }
  return null;
}

function recommendAction(record: VerificationRecord, outcome: Decision["outcome"]): string {
  if (outcome === "complete") {
    if (record.calculation && record.benefits?.eligibility === "active") {
      /**
       * The estimate IS ready, and sharing it is the action — no warning is warranted, because a
       * screen that warns on every case is one staff learn to scroll past.
       *
       * The exhausted annual maximum is the exception worth a clause. The estimate is correct and
       * quotable, and it happens to be almost entirely the patient's; a front desk reading only
       * "ready to share" walks into that conversation without knowing it is coming.
       */
      return has(record, "annual-max-exhausted")
        ? "No action needed — the estimate is ready to share, but no annual-maximum benefits remain " +
            "this year, so nearly all of it is the patient's. Say so before treatment."
        : "No action needed — the estimate is ready to share with the patient.";
    }
    /**
     * ── BEING REVIEWED SETTLES THE WORKFLOW, NOT THE COVERAGE ────────────────────────────────────
     * This branch returned "No action needed — this case is closed" for everything that was not
     * active-with-an-estimate, and it returns EARLY, so the sentences below it — including the one
     * written for inactive coverage — became unreachable the moment a human marked the case
     * reviewed.
     *
     * On staging that is Ben Demo. Delta Dental reports his coverage INACTIVE; his claim carries a
     * blocking scrub finding and says "Do not file. Re-verify coverage, or collect from the patient
     * directly"; he owes the full $175.00 with no insurance at all. His VERIFICATION screen — the
     * one a front desk reads before he sits down — said "reviewed" and "No action needed — this
     * case is closed."
     *
     * A coordinator doing the right thing (reviewing the case) is what silenced the warning.
     */
    const consequence = coverageConsequence(record);
    return consequence ? `Reviewed, but this is not a normal case. ${consequence}` : "No action needed — this case is closed.";
  }
  if (has(record, "benefits-unavailable")) {
    const payer = record.card.payerName.value ?? "The payer";
    /**
     * NOT "electronic verification isn't available for this card", which is what this said when the
     * two cases shared a branch — and which is false here in every clause. The check reached the
     * payer; the payer replied; the reply refused the identifier. That is a card to look at again.
     */
    return (
      `Re-read the card: ${payer} answered the check but would not return benefits for this member ` +
      `ID. Correct the member ID or date of birth and verify again, then ring them if it still fails.`
    );
  }
  if (!record.benefits || has(record, "unknown-payer")) {
    const payer = record.card.payerName.value ?? "this payer";
    return `Verify manually with ${payer} by phone or portal — electronic verification isn't available for this card.`;
  }
  if (has(record, "inactive-coverage")) {
    return "Contact the patient before the visit — the payer reports this coverage as not active.";
  }
  /* eligibility-unknown, annual-max-exhausted and the rest follow, in severity order. */
  /**
   * ── THE CRITICAL FLAG THAT REACHED NO ACTION (M18, D3) ────────────────────────────────────────
   * M18 gave the unknown state its own code so it could never again be read as a refusal. This
   * function branches on codes, in severity order — and had no branch for it. So the record's ONLY
   * critical flag fell past every warning-level branch to the default, "Double-check the
   * low-confidence fields, then approve or re-verify", and the one instruction that matters — ring
   * the payer — never reached the coordinator at all.
   *
   * A distinction is only worth drawing where somebody acts on it. Kept next to `inactive-coverage`
   * because the two are the same question's two answers, and both outrank the warnings below.
   *
   * The sentence is M18's own, reordered into this function's action-first shape.
   */
  if (has(record, "eligibility-unknown")) {
    return (
      "Confirm directly with the payer before quoting the patient or filing — the payer did not " +
      "state whether this member's coverage is active."
    );
  }
  if (has(record, "annual-max-exhausted")) {
    return "Discuss costs with the patient — no annual-maximum benefits remain this year.";
  }
  if (has(record, "data-validation")) {
    return "Correct the highlighted patient fields, then re-verify.";
  }
  if (has(record, "member-id-mismatch")) {
    return "Confirm the member ID against the physical card, then re-verify.";
  }
  return "Double-check the low-confidence fields, then approve or re-verify.";
}

export function decideVerification(record: VerificationRecord, now: Date = new Date()): Decision {
  const blocked = record.status === "failed" || !record.benefits;
  const settled = record.status === "verified" || record.status === "reviewed";
  const outcome: Decision["outcome"] = blocked ? "blocked" : settled ? "complete" : "needs_human";

  const reasoning =
    outcome === "complete"
      ? [
          record.status === "reviewed"
            ? `A staff member ${record.review?.decision ?? "reviewed"} this case after manual review.`
            : `Confidence ${pct(record.confidence.overall)} cleared the ${pct(record.confidence.reviewThreshold)} threshold with no critical exceptions.`,
        ]
      : reviewReasons(record);

  const evidence: DecisionEvidence[] = [];
  if (record.benefits) {
    evidence.push({
      label: "Benefits source",
      detail:
        `${record.benefits.payerName ?? "Payer"} — eligibility ${record.benefits.eligibility}` +
        `${record.raw271 ? ", EDI 271 retained" : ""} (${record.dataSource} data)`,
    });
    evidence.push({
      label: "Annual maximum",
      detail: `${formatUsdOrUnknown(record.benefits.annualMaximum.remaining)} of ${formatUsdOrUnknown(record.benefits.annualMaximum.amount)} remaining`,
    });
  } else {
    evidence.push({ label: "Benefits source", detail: "No benefits retrieved — payer not identified or connector unavailable." });
  }
  if (record.calculation) {
    evidence.push({
      label: "Estimate",
      detail: `Patient ${formatUsd(record.calculation.totalPatientPays)} of ${formatUsd(record.calculation.totalFee)} total`,
    });
  }
  for (const c of record.confidence.components) {
    evidence.push({ label: `Confidence · ${c.name}`, detail: pct(c.confidence) });
  }
  const freshness = verificationFreshness(record.createdAt, now);
  evidence.push({ label: "Freshness", detail: `${freshness.status} — expires ${freshness.expiresAt.slice(0, 10)}` });

  /**
   * An EXPIRED verification may not be quoted to a patient.
   *
   * ── WHY FRESHNESS BELONGS IN THIS FLAG ─────────────────────────────────────────────────────────
   * This read `outcome === "complete" && calculation && eligibility === "active"` — all true forever,
   * because they are facts about the moment the check ran. Freshness was computed two lines above,
   * shown as evidence, and used to bump priority, but the one flag that decides whether staff may
   * read a dollar figure to a patient ignored it.
   *
   * `verificationFreshness` expires a check at the PLAN YEAR boundary specifically because the
   * deductible and the annual maximum reset there. So a December verification opened in January
   * still said "estimate ready to share" over numbers that had already reset — the patient is
   * quoted a remaining maximum they no longer have and a deductible they have not met. That is the
   * plain "bill a patient incorrectly" failure, produced by a screen telling staff it was safe.
   *
   * `aging` still permits quoting: it means the check is approaching expiry, not past it, and the
   * status is on screen beside the figure. Only `expired` withdraws permission.
   */
  const canNotifyPatient =
    outcome === "complete" &&
    record.calculation !== null &&
    record.benefits?.eligibility === "active" &&
    freshness.status !== "expired";

  if (outcome === "complete" && freshness.status === "expired") {
    reasoning.push(
      `This verification expired on ${freshness.expiresAt.slice(0, 10)} — ${freshness.reason} ` +
        `Re-run it before quoting the patient; the deductible and remaining maximum it was priced ` +
        `against may no longer be current.`
    );
  }
  const escalate = outcome === "blocked" || has(record, "inactive-coverage") || has(record, "annual-max-exhausted");

  let priority = outcome === "blocked" ? 80 : outcome === "needs_human" ? 60 : 10;
  if ((record.calculation?.totalPatientPays ?? 0) > cents(500)) priority += 15;
  if (record.confidence.overall < 0.5) priority += 10;
  if (outcome === "complete" && freshness.status === "expired") priority = 40; // stale — worth a re-run
  priority = Math.max(0, Math.min(100, priority));

  return {
    outcome,
    completedBy: outcome !== "complete" ? null : record.review ? "staff" : "ai",
    confidence: record.confidence.overall,
    reasoning,
    evidence,
    recommendedAction: recommendAction(record, outcome),
    canNotifyPatient,
    escalate,
    priority,
  };
}
