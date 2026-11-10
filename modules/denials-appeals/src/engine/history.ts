/**
 * A denial's chronology — the recovery half of a patient's record (M14 deliverable 4).
 *
 * ── WHAT BELONGS ON A PERSON'S RECORD ──────────────────────────────────────────────────────────
 * The payer said no, what a human did about it, and how it ended. Not the triage's internal
 * reasoning, which is on the recovery screen where a biller is deciding whether to chase it; by the
 * time this appears on a patient's record the decision is history, and the question being asked is
 * "why does this patient still owe money" or "what happened to this claim".
 *
 * The distinction matters most at the end: a denial closed as `patient_billed` is the moment the
 * practice decided this money is the PATIENT's, and it is the single most contestable entry on the
 * whole record. It carries the person who decided and the reason they gave, because "you owe $217"
 * with no provenance is the sentence that starts every billing dispute.
 *
 * Every figure is read from the denial, which froze it at triage. Pure — no I/O, no clock.
 */
import { formatUsd, type Cents, type HistoryEntry } from "@mermaid/shared";
import type { Appeal, Denial } from "../types.ts";

const appealTitle = (level: number, what: string): string => `Level-${level} appeal ${what}`;

/** The entries one denial and its appeals contribute to a patient's record. */
export function denialHistory(denial: Denial): HistoryEntry[] {
  const ref = { kind: "denial", id: denial.id };
  const procedure = denial.procedureCode ? ` on ${denial.procedureCode}` : "";
  const entries: HistoryEntry[] = [
    {
      phase: "denial",
      at: denial.detectedAt,
      title: `${denial.payerName} denied ${formatUsd(denial.deniedAmount)}`,
      detail:
        `Reason ${denial.carcCode} — ${denial.carcDescription}${procedure}. ` +
        (denial.triage
          ? `Triaged as "${denial.triage.disposition.replace(/_/g, " ")}" at ` +
            `${Math.round(denial.triage.overturnRate * 100)}% recovery odds.`
          : "Not yet triaged."),
      actor: "system",
      amount: denial.deniedAmount,
      ref,
    },
  ];

  for (const appeal of denial.appeals) entries.push(...appealEntries(denial, appeal, ref));

  // ── How it ended ───────────────────────────────────────────────────────────────────────────
  // `updatedAt` is the closest instant the record holds for a close; the disposition itself is the
  // fact worth showing, and it is exact.
  if (denial.status === "written_off") {
    entries.push({
      phase: "resolution",
      at: denial.updatedAt,
      title: `Written off — ${formatUsd(denial.deniedAmount)} the practice absorbed`,
      detail: denial.closeReason ?? "No reason was recorded.",
      actor: "staff",
      amount: denial.deniedAmount,
      ref,
    });
  } else if (denial.status === "patient_billed") {
    entries.push({
      phase: "resolution",
      at: denial.updatedAt,
      title: `Moved to the patient's balance — ${formatUsd(denial.deniedAmount)}`,
      detail:
        (denial.closeReason ?? "No reason was recorded.") +
        " This is the decision that made the amount the patient's to pay.",
      actor: "staff",
      amount: denial.deniedAmount,
      ref,
    });
  } else if (denial.status === "recovered") {
    entries.push({
      phase: "resolution",
      at: denial.updatedAt,
      title: `Recovered ${formatUsd(denial.recoveredAmount ?? (0 as Cents))} from ${denial.payerName}`,
      detail: "The appeal succeeded; the payer reprocessed and paid.",
      actor: "system",
      amount: denial.recoveredAmount,
      ref,
    });
  }

  return entries;
}

function appealEntries(denial: Denial, appeal: Appeal, ref: { kind: string; id: string }): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    {
      phase: "appeal",
      at: appeal.createdAt,
      title: appealTitle(appeal.level, "drafted"),
      detail:
        `A letter and ${appeal.checklist.length} evidence item(s) were prepared for ${denial.payerName}. ` +
        "Drafting is not sending — nothing leaves the practice until a person approves it.",
      actor: "system",
      amount: denial.deniedAmount,
      ref,
    },
  ];

  // The human gate. Named, always: an appeal is a factual assertion about a patient's care, and the
  // person who stands behind it is part of the record.
  if (appeal.approvedAt) {
    entries.push({
      phase: "appeal",
      at: appeal.approvedAt,
      title: appealTitle(appeal.level, "approved"),
      detail: `${appeal.approvedBy ?? "A member of staff"} approved the appeal for sending.`,
      actor: appeal.approvedBy ?? "staff",
      amount: null,
      ref,
    });
  }
  if (appeal.submittedAt) {
    entries.push({
      phase: "appeal",
      at: appeal.submittedAt,
      title: appealTitle(appeal.level, `sent to ${denial.payerName}`),
      detail: `Claim ${denial.claimControlNumber || "—"}, reason ${denial.carcCode}.`,
      actor: appeal.approvedBy ?? "staff",
      amount: denial.deniedAmount,
      ref,
    });
  }
  if (appeal.outcomeRecordedAt) {
    const won = (appeal.recoveredAmount ?? 0) > 0;
    entries.push({
      phase: "appeal",
      at: appeal.outcomeRecordedAt,
      title: appealTitle(appeal.level, won ? "upheld" : "denied again"),
      detail:
        (won
          ? `${denial.payerName} reprocessed and paid ${formatUsd(appeal.recoveredAmount!)}.`
          : `${denial.payerName} upheld the original decision.`) +
        (appeal.outcomeNotes?.trim() ? ` ${appeal.outcomeNotes.trim()}` : ""),
      actor: "staff",
      amount: appeal.recoveredAmount,
      ref,
    });
  }

  return entries;
}
