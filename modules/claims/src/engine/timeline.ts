/**
 * The claim timeline — estimate → submission → posting → resolution.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * Roadmap §6 specifies `GET /api/claims/:id/timeline` returning exactly that sequence, and §2 models
 * a `timeline_events` table to hold it. Neither was built. The provenance, however, has been
 * captured all along — the claim carries the estimate it inherited, who released it and when, every
 * posting the payer made against it, and its own audit trail. What was missing was the assembly.
 *
 * ── WHY NO `timeline_events` TABLE ─────────────────────────────────────────────────────────────
 * The roadmap's table would be a THIRD copy of facts already stored twice: once on the claim, once
 * in `domain_events` and `audit_events`. Every copy is a chance to disagree, and a timeline that
 * disagrees with the claim it describes is worse than no timeline — it is the screen a practice
 * would quote to a payer or a patient during a dispute.
 *
 * So this is a pure projection over the claim itself. It cannot go stale, it cannot drift, and it
 * needs no migration. Same reasoning as the Today queue being composed at request time rather than
 * projected (`apps/web/today.ts`).
 *
 * ── WHO ACTUALLY READS THIS ────────────────────────────────────────────────────────────────────
 * Two audiences, and they want the same thing: a biller answering "what happened to this claim, and
 * when?" during a payer call, and a breach-notification or dispute review asking the identical
 * question of the record. That overlap is why this was scheduled with the compliance milestone
 * rather than with a UI pass.
 *
 * Pure and deterministic — no I/O, no clock of its own.
 */
import { formatUsd, orderHistory, type Cents, type HistoryEntry, type HistoryPhase } from "@mermaid/shared";
import type { Claim } from "../types.ts";
import { FILING_WINDOWS_ARE_PAYER_SOURCED, FILING_WINDOW_ESTIMATE_NOTE, sourcedFilingWindowNote } from "./deadline.ts";

/**
 * The entry shape moved to `@mermaid/shared` at M14, where four other contexts now produce it so the
 * patient record can interleave them into one spine (`packages/shared/src/domain/history.ts`).
 *
 * These aliases are kept because the claim timeline is a published API response and its readers name
 * this type. The JSON is unchanged — `HistoryEntry` adds two OPTIONAL fields (`amount`, `ref`), so
 * every existing consumer sees exactly the object it saw before, plus more.
 */
export type TimelinePhase = HistoryPhase;
export type TimelineEntry = HistoryEntry;

/**
 * Build the timeline for one claim, oldest first.
 *
 * Ordered by `at` rather than by phase, because the phases are not strictly sequential in practice —
 * a claim can be corrected and refiled after a denial, producing a second submission that is
 * genuinely later than the first posting. Sorting by what the phases *ought* to be would rewrite
 * history to look tidier than it was.
 */
export function buildClaimTimeline(claim: Claim): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const ref = { kind: "claim", id: claim.id };

  // ── Estimate ─────────────────────────────────────────────────────────────────────────────────
  // The keystone: a claim inherits the verification's frozen snapshot and never recalculates it.
  entries.push({
    phase: "estimate",
    at: claim.createdAt,
    title: "Claim created from the verified estimate",
    detail:
      `Inherited verification ${claim.verificationId}. ` +
      `${formatUsd(claim.totalFee)} billed; the estimate expected ${formatUsd(claim.expectedInsurancePays)} ` +
      `from ${claim.payer.payerName ?? "the payer"} and ${formatUsd(claim.expectedPatientPays)} from the patient.`,
    actor: "system",
    amount: claim.totalFee,
    ref,
  });

  if (claim.scrub) {
    const { clean, errors, warnings } = claim.scrub;
    entries.push({
      phase: "estimate",
      at: claim.scrub.scrubbedAt,
      title: clean ? "Scrubbed clean" : `Scrubbed — ${errors} error(s), ${warnings} warning(s)`,
      detail: errors > 0
        ? "Errors must be corrected before this claim can be released to the payer."
        : clean
          ? "No payer-rejection rules matched."
          : "Advisory findings only; the claim may still be released by a human.",
      actor: "system",
      amount: null,
      ref,
    });
  }

  // ── Submission ───────────────────────────────────────────────────────────────────────────────
  if (claim.submission) {
    const s = claim.submission;
    entries.push({
      phase: "submission",
      at: s.submittedAt,
      title: s.outcome === "accepted" ? "Released to the payer" : "Refused at intake",
      detail:
        `Control number ${s.patientControlNumber}` +
        (s.controlNumber ? ` (payer reference ${s.controlNumber})` : "") +
        (s.outcome === "rejected" && s.statusCode ? ` — rejected with ${s.statusCategory ?? ""} ${s.statusCode}` : "") +
        // The permanent record of what was filed and by when. Left bare, a reader six months later
        // takes this date for the payer's own term rather than one this system computed.
        `. Filing deadline ${claim.filingDeadline}` +
        // B-1: a date the payer's own document stands behind is named as such, with its source.
        (claim.filingWindowSource
          ? ` (${claim.filingWindowSource.publisher}'s published limit). ${sourcedFilingWindowNote(claim.filingWindowSource)}`
          : `${FILING_WINDOWS_ARE_PAYER_SOURCED ? "." : ` (Mermaid's estimate). ${FILING_WINDOW_ESTIMATE_NOTE}`}`),
      // The submit gate is a human act and is always attributable — that is the point of the gate.
      actor: s.submittedBy,
      amount: claim.expectedInsurancePays,
      ref,
    });
  }

  // ── Posting ──────────────────────────────────────────────────────────────────────────────────
  for (const payment of claim.payments) {
    const shortfall = payment.variance < 0 ? ` Underpaid by ${formatUsd(Math.abs(payment.variance) as Cents)}.` : "";
    entries.push({
      phase: "posting",
      at: payment.postedAt,
      title:
        payment.outcome === "denied"
          ? "Payer denied"
          : payment.outcome === "as_expected"
            ? "Paid as estimated"
            : payment.outcome === "overpaid"
              ? "Paid above the estimate"
              : "Paid below the estimate",
      detail:
        `${formatUsd(payment.paidAmount)} posted from trace ${payment.traceNumber}. ` +
        `Contractual ${formatUsd(payment.contractualAdjustments)}, ` +
        `patient ${formatUsd(payment.patientResponsibility)}.${shortfall}`,
      actor: "system",
      amount: payment.paidAmount,
      // The posting is the Remittance module's record; the claim copied it verbatim. Referencing the
      // remittance is what lets the patient record link a payment back to the payer's own advice.
      ref: { kind: "remittance", id: payment.remittanceId },
    });
  }

  // ── Resolution ───────────────────────────────────────────────────────────────────────────────
  if (claim.status === "void") {
    entries.push({
      phase: "resolution",
      at: claim.updatedAt,
      title: "Voided",
      detail: claim.voidReason ?? "No reason recorded.",
      // A void always carries a human reason; the audit trail holds who, and is surfaced alongside.
      actor: "staff",
      amount: null,
      ref,
    });
  } else if (claim.status === "paid") {
    entries.push({
      phase: "resolution",
      at: claim.payments[claim.payments.length - 1]?.postedAt ?? claim.updatedAt,
      title: "Settled",
      detail: "The payer owes nothing further on this claim.",
      actor: "system",
      amount: null,
      ref,
    });
  }

  return orderHistory(entries);
}
