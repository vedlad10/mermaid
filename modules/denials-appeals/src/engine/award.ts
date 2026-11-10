/**
 * Appeal awards — the gap between WINNING and BEING PAID.
 *
 * ── THE DEFECT THIS EXISTS TO FIX (F-2) ────────────────────────────────────────────────────────
 * `recordOutcome` wrote `status: "recovered"` and a `recoveredAmount`, and `recovered` was a CLOSED
 * status. So the moment a human recorded a win the denial left every worklist, the Recover queue
 * emptied, and the patient record reported money "recovered" beside cash that had never arrived. A
 * staging audit found exactly that: $1,125.00 recorded as recovered against $21.49 collected, with
 * no receivable, no follow-up, and no screen on which the difference appeared.
 *
 * Four facts were collapsed into one field, and this module holds them apart:
 *
 *   recovered_by_workflow  a person recorded that the payer agreed        → awardedAmount
 *   expected_from_payer    a receivable with an age                       → awardOutstanding()
 *   cash_received          an ERA arrived carrying money (may be held)    → posting.paidAmount
 *   cash_posted            that cash was attributed to this award         → awardSettledAmount
 *
 * Only the last one may move a denial to `recovered`. It is the single transition in this machine
 * that money, rather than a person, is allowed to trigger.
 *
 * Pure and deterministic: no I/O, no clock of its own, no repository. Every function takes the
 * denial and returns a new one, so the state machine can be tested without a database.
 */
import { addCents, subCents, expectationFor, formatUsd, ZERO, type Cents } from "@mermaid/shared";

/** Re-exported so this module has one import site for the award rules. Defined in shared because
 * Remittance needs it too and the two modules may not import each other. */
export { expectationFor };
import type { Denial, DenialStatus } from "../types.ts";

/** Statuses where an award exists and the money has not all arrived. */
export const AWARD_OPEN_STATUSES: readonly DenialStatus[] = ["awaiting_payment", "partially_recovered"];

const DAY_MS = 86_400_000;

/** What the payer still owes on this denial's award. Zero when there is no award, or it is settled. */
export function awardOutstanding(denial: Denial): Cents {
  const awarded = denial.awardedAmount ?? ZERO;
  const settled = denial.awardSettledAmount ?? ZERO;
  return Math.max(0, awarded - settled) as Cents;
}

/**
 * How long the practice has been waiting, from the date the win was recorded.
 *
 * ── WHY THERE IS NO DUE DATE ──────────────────────────────────────────────────────────────────
 * An earlier draft carried `awardExpectedBy`, a date 30 days after the award. It was withdrawn
 * because no payer publishes a corrected-remittance turnaround, so the field would have asserted a
 * commitment that exists nowhere. The codebase reserves its "catalogued default, not this payer's
 * stated terms" language for figures with a real external source — appeal windows come from payer
 * policy documents; this does not. Dressing an invention in that vocabulary is worse than having no
 * field, because it would look sourced.
 *
 * So the age is derived from a recorded fact, and the escalation bands below are stated as the
 * PRACTICE's policy wherever they are shown.
 */
export function awardAgeDays(denial: Denial, now: Date): number {
  if (!denial.awardedAt) return 0;
  return Math.floor((now.getTime() - new Date(denial.awardedAt).getTime()) / DAY_MS);
}

/** Escalation band for a waiting award. Practice policy, never a payer commitment. */
export function awardUrgency(ageDays: number): { band: "new" | "chase" | "overdue" | "escalate"; factor: number } {
  if (ageDays >= 90) return { band: "escalate", factor: 2.0 };
  if (ageDays >= 60) return { band: "overdue", factor: 1.6 };
  if (ageDays >= 30) return { band: "chase", factor: 1.25 };
  return { band: "new", factor: 1.0 };
}

const audit = (now: Date, actor: "system" | "staff", message: string) => ({
  timestamp: now.toISOString(),
  actor,
  message,
});

export interface AwardOutcomeInput {
  won: boolean;
  /** What the payer agreed to pay. Defaults to the full denied amount. */
  awardedAmount?: Cents;
  recordedBy: string;
  notes?: string;
}

/**
 * Record what the payer decided.
 *
 * A win produces a RECEIVABLE, not a recovery: `awardedAmount` is set, `awardSettledAmount` is
 * zero, and the status becomes `awaiting_payment`, which is OPEN. No cash figure anywhere is
 * touched — this function cannot reach a posting or a ledger entry, and that is the structural
 * guarantee behind "a won appeal is never cash collected".
 */
export function applyAwardOutcome(denial: Denial, input: AwardOutcomeInput, now: Date): Denial {
  const actor = input.recordedBy.trim();
  const awarded = (input.won ? (input.awardedAmount ?? denial.deniedAmount) : 0) as Cents;

  if (!input.won) {
    return {
      ...denial,
      status: "written_off",
      outcomeDecision: "lost",
      awardedAmount: ZERO,
      awardSettledAmount: ZERO,
      updatedAt: now.toISOString(),
      closeReason: input.notes ?? "Appeal denied by the payer.",
      audit: [
        ...denial.audit,
        audit(now, "staff", `Appeal lost. Recorded by ${actor}.${input.notes ? ` ${input.notes}` : ""}`),
      ],
    };
  }

  return {
    ...denial,
    status: "awaiting_payment",
    outcomeDecision: "won",
    awardedAmount: awarded,
    awardSettledAmount: ZERO,
    awardedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    closeReason: null,
    audit: [
      ...denial.audit,
      audit(
        now,
        "staff",
        `Appeal WON — ${formatUsd(awarded)} awarded. Recorded by ${actor}. The payer has agreed to ` +
          `pay it; nothing has arrived yet, so this stays open until a corrected remittance settles it.`
      ),
    ],
  };
}

export interface SettlementInput {
  /** Cash from a posting, attributed to THIS award. */
  cash: Cents;
  /** The posting the cash came from. The idempotency key — one posting settles exactly once. */
  postingId: string;
}

/**
 * Attribute posted cash to an award.
 *
 * ── WHY THE POSTING IDS ARE KEPT, AND NOT JUST A RUNNING TOTAL ────────────────────────────────
 * Delivery is at-least-once: `domain_event_deliveries` checkpoints per subscriber, so a handler can
 * legitimately run twice for one event — after a worker retry, a crash between consumers, or a
 * redelivery. An incrementing settlement would double-credit on the second run and quietly close a
 * denial that is still owed money.
 *
 * So the denial records WHICH postings have settled it, and the figure is derived from that set.
 * Re-applying a posting already in the set changes nothing, which makes replay a no-op rather than
 * something the caller has to be careful about. It also means the amount can be recomputed from
 * authoritative state at any time instead of being trusted from an event payload.
 *
 * Capped at the awarded amount: a payer that sends more than it agreed has overpaid the CLAIM, and
 * that surplus is the claim's business (and the partition's `overpayment`), not the award's.
 */
export function applyAwardSettlement(denial: Denial, input: SettlementInput, now: Date): Denial {
  const awarded = denial.awardedAmount ?? ZERO;
  if (awarded <= 0) return denial;

  const existing = denial.awardSettlements ?? [];
  /** Already seen this posting — replay, retry, or redelivery. Nothing to do. */
  if (existing.some((s) => s.postingId === input.postingId)) return denial;

  const settlements =
    input.cash > 0 ? [...existing, { postingId: input.postingId, amount: input.cash }] : existing;
  const attributed = addCents(...settlements.map((s) => s.amount));
  const settled = Math.min(awarded, Math.max(0, attributed)) as Cents;
  const outstanding = subCents(awarded, settled);
  const status: DenialStatus = outstanding === 0 ? "recovered" : settled > 0 ? "partially_recovered" : "awaiting_payment";

  if (settled === (denial.awardSettledAmount ?? ZERO) && status === denial.status) return denial;

  const message =
    outstanding === 0
      ? `Award settled in full — ${formatUsd(settled)} received and posted. Recovered.`
      : settled > 0
        ? `${formatUsd(settled)} of the ${formatUsd(awarded)} award received. ${formatUsd(outstanding)} still owed.`
        : `No cash has been attributed to the ${formatUsd(awarded)} award yet.`;

  return {
    ...denial,
    status,
    awardSettledAmount: settled,
    awardSettlements: settlements,
    updatedAt: now.toISOString(),
    audit: [...denial.audit, audit(now, "system", message)],
  };
}

// ── Attribution: which award does an incoming payment settle? ─────────────────────────────────

export interface PaymentLine {
  procedureCode: string | null;
  amount: Cents;
}

export type Attribution =
  | { kind: "exact"; denialId: string; reason: "procedure-code" }
  | { kind: "sole"; denialId: string; reason: "only-open-award" }
  | { kind: "ambiguous"; candidates: string[]; reason: string }
  | { kind: "none"; reason: string };

/**
 * Decide which award a payment belongs to.
 *
 * An 835 carries no appeal reference — there is no field for one — so attribution has to come from
 * something the payer does send. A denial is uniquely identified by its PROCEDURE CODE within a
 * claim (`denials_one_per_posting_reason` is keyed on it), and a corrected remittance names the
 * procedure it is paying in its service-line detail. That is the key, and it is a real signal
 * rather than an ordering convention.
 *
 * When the line detail cannot decide it, this REFUSES rather than guessing. "Oldest award first"
 * was considered and rejected: award order carries no meaning a payer respects, so it would be a
 * coin-flip wearing the costume of a rule. Cash still posts to the claim and the ledger normally —
 * only the award credit waits for a human, so no money is lost or invented by the refusal.
 */
export function attributeAward(openAwards: Denial[], lines: PaymentLine[]): Attribution {
  const awards = openAwards.filter((d) => awardOutstanding(d) > 0);
  if (awards.length === 0) return { kind: "none", reason: "no open award on this claim" };

  const paidCodes = new Set(lines.filter((l) => l.amount > 0 && l.procedureCode).map((l) => l.procedureCode));
  const byCode = awards.filter((d) => d.procedureCode && paidCodes.has(d.procedureCode));

  if (byCode.length === 1) {
    return { kind: "exact", denialId: byCode[0]!.id, reason: "procedure-code" };
  }
  if (byCode.length > 1) {
    return {
      kind: "ambiguous",
      candidates: byCode.map((d) => d.id),
      reason: `${byCode.length} open awards share the procedure codes this remittance paid`,
    };
  }
  if (awards.length === 1) {
    return { kind: "sole", denialId: awards[0]!.id, reason: "only-open-award" };
  }
  return {
    kind: "ambiguous",
    candidates: awards.map((d) => d.id),
    reason: `${awards.length} open awards and no service-line detail identifying which was paid`,
  };
}

/** Total awarded and settled across a claim's denials — the projection `claim_expectations` mirrors. */
export function claimAwardTotals(denials: Denial[]): { awarded: Cents; settled: Cents; outstanding: Cents } {
  const open = denials.filter((d) => AWARD_OPEN_STATUSES.includes(d.status));
  const awarded = addCents(...open.map((d) => d.awardedAmount ?? ZERO));
  const settled = addCents(...open.map((d) => d.awardSettledAmount ?? ZERO));
  return { awarded, settled, outstanding: Math.max(0, awarded - settled) as Cents };
}
