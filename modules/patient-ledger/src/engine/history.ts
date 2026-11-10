/**
 * The ledger's chronology — the patient's own half of the record (M14 deliverable 4).
 *
 * ── WHY THIS IS THE THINNEST ENGINE HERE ───────────────────────────────────────────────────────
 * A ledger entry is already a history entry. It was written once, never updated, carries the moment
 * it happened, a description written to be read by the patient it concerns, and the person
 * responsible. There is nothing to project — only to label with a phase and hand the sign back to
 * the caller as a positive figure with a direction, because a screen showing "-$120.00" beside the
 * words "Payment received" says the same thing twice and gets it wrong once.
 *
 * That the mapping is this thin is the point. The append-only design was chosen precisely so that
 * "how was this number arrived at" is answerable from the rows themselves; if assembling the answer
 * needed logic, the rows would not really be the answer.
 *
 * Pure — no I/O, no clock.
 */
import { formatUsd, type HistoryEntry } from "@mermaid/shared";
import type { LedgerEntry } from "../types.ts";

const TITLES: Record<LedgerEntry["kind"], string> = {
  charge: "Charged to the patient",
  payment: "Payment received",
  adjustment: "Courtesy adjustment",
  writeoff: "Written off",
};

/** The entries a patient's ledger contributes to their record, one per movement. */
export function ledgerHistory(entries: LedgerEntry[]): HistoryEntry[] {
  return entries.map((entry) => {
    // Stored signed (a charge positive, everything else negative) so a balance is a sum. The
    // magnitude is what a person reads; the direction is already in the title.
    const magnitude = Math.abs(entry.amount);
    return {
      phase: "ledger" as const,
      at: entry.occurredAt,
      title: `${TITLES[entry.kind]} — ${formatUsd(magnitude as LedgerEntry["amount"])}`,
      detail: entry.description,
      // "system" only ever for a cycle-driven charge. Money LEAVING a balance always names a person
      // — that is enforced at the service, and this is where it becomes visible.
      actor: entry.recordedBy,
      amount: magnitude,
      ref: { kind: "ledger", id: entry.id },
    };
  });
}
