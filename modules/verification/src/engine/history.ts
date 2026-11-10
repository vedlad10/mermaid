/**
 * A verification's own chronology, projected for the patient record (M14 deliverable 4).
 *
 * ── WHY THIS IS NOT THE RECORD'S AUDIT ARRAY ───────────────────────────────────────────────────
 * A verification carries nine or so audit lines — card interpreted, payer identified, eligibility
 * checked, confidence aggregated. Those are the right level of detail on the verification screen,
 * where someone is asking why THIS verification concluded what it did. Poured onto a patient's
 * record they would bury the two things a person opening that screen actually wants: that we checked
 * this patient's coverage on a date and what we told them it would cost, and whether a human had to
 * settle it.
 *
 * A timeline that is exhaustive is a timeline nobody reads, and one nobody reads is not a control.
 * So this projects the two facts that belong on a PERSON's record and leaves the rest where it is —
 * one click away, on the verification the entry references.
 *
 * Nothing here re-derives a benefit figure: every number is read from the calculation the pipeline
 * froze. Pure and deterministic — no I/O, no clock of its own.
 */
import { formatUsd, type HistoryEntry } from "@mermaid/shared";
import type { VerificationRecord } from "../types.ts";

const patientName = (record: VerificationRecord): string =>
  `${record.patient.firstName} ${record.patient.lastName}`.trim() || "the patient";

/**
 * The entries one verification contributes to a patient's record.
 *
 * The first is the estimate itself — the number the patient was quoted, which is the fact the whole
 * rest of the cycle is measured against. The second exists only when a human settled it, and says
 * who and what they decided.
 */
export function verificationHistory(record: VerificationRecord): HistoryEntry[] {
  const ref = { kind: "verification", id: record.id };
  const payer = record.benefits?.payerName ?? record.card.payerName.value ?? "an unidentified payer";
  const entries: HistoryEntry[] = [];

  const quoted = record.calculation?.totalPatientPays ?? null;
  entries.push({
    phase: "verification",
    at: record.createdAt,
    title:
      record.status === "failed"
        ? "Coverage could not be verified"
        : record.status === "needs_review"
          ? "Coverage verified — held for a person"
          : "Coverage verified",
    detail:
      quoted === null
        ? `${patientName(record)} was checked against ${payer}. No estimate was produced.`
        : `${patientName(record)} was checked against ${payer}. ` +
          `${formatUsd(record.calculation!.totalFee)} of treatment; the estimate quoted them ` +
          `${formatUsd(quoted)} and expected ${formatUsd(record.calculation!.totalInsurancePays)} from the plan.`,
    actor: "system",
    amount: quoted,
    ref,
  });

  /**
   * The human gate, when one was needed.
   *
   * `reviewedBy` is not on the review record — the service attributes the decision through the audit
   * trail and the platform audit log — so the actor here is "staff". Naming the individual belongs
   * with widening `ReviewDecision`, which is a change to a persisted document and is not worth
   * making for a label; the security audit already answers "which person" for anyone entitled to
   * ask, and this screen is read under `patients.read`.
   */
  if (record.review) {
    entries.push({
      phase: "verification",
      at: record.review.reviewedAt,
      title:
        record.review.decision === "rejected"
          ? "Verification rejected by a person"
          : record.review.decision === "overridden"
            ? "Verification overridden by a person"
            : "Verification approved by a person",
      detail: record.review.notes?.trim()
        ? record.review.notes.trim()
        : "No note was left with the decision.",
      actor: "staff",
      amount: null,
      ref,
    });
  }

  return entries;
}
