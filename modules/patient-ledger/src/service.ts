/**
 * Patient-ledger service — what a patient owes, how it got there, and what to do about it.
 *
 * Two rules shape every method here:
 *
 *  1. **A charge is never created by a person.** Charges arrive from the cycle — the payer said the
 *     patient owes this, or a human decided a denied amount is the patient's. Letting staff invent
 *     charges here would create a second, unreconciled source of patient debt beside the one the
 *     claims produce.
 *
 *  2. **Money never leaves a balance without a named person.** Payments, courtesy adjustments and
 *     write-offs all require an actor, because reducing what a patient owes is exactly how a
 *     practice loses money quietly. This is the same human-gate doctrine as claim submission and
 *     appeal approval, applied to the other direction of the same cash.
 */
import { randomUUID } from "node:crypto";
import { formatUsd, orderHistory, type Cents, type HistoryEntry } from "@mermaid/shared";
import {
  NullEventPublisher,
  type DenialClosedBody,
  type EventPublisher,
  type RemittancePostedBody,
} from "@mermaid/events";
import { buildAccount, buildStatement, buildSummary, signed } from "./engine/account.ts";
import { ledgerHistory } from "./engine/history.ts";
import type { LedgerFilter, LedgerRepository, PatientScope } from "./repository.ts";
import { groupKeyFor } from "./types.ts";
import type { EntryKind, LedgerEntry, LedgerSummary, PatientAccount, PatientStatement } from "./types.ts";

export class PatientAccountNotFoundError extends Error {
  constructor(patientKey: string) {
    super(`no ledger account for ${patientKey}`);
    this.name = "PatientAccountNotFoundError";
  }
}

/** Refused because the movement is not one the ledger will make. */
export class LedgerActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerActionError";
  }
}

export interface HumanEntryInput {
  /** Positive cents. The sign convention is applied here, never by the caller. */
  amount: Cents;
  recordedBy: string;
  note?: string;
}

/**
 * Which patient a member ID belongs to.
 *
 * A two-method port this module owns, in the same shape and for the same reason as Verification's
 * `PayerAccuracyProvider` and Claims' `PayerWindowProvider`: the ledger needs one id, and importing
 * the patient master to get it would couple a bounded context to a table it does not own. The
 * composition root satisfies it; no module imports another.
 *
 * Returning null is a normal answer, not an error.
 */
export interface PatientLookup {
  byMemberId(memberId: string): Promise<string | null>;
  /**
   * The patient whose visit produced this claim, when the money came from one.
   *
   * ── WHY A MEMBER ID IS NOT ENOUGH HERE ─────────────────────────────────────────────────────────
   * `byMemberId` answers "exactly one, or nothing", because a member ID is a POLICY and a dental
   * plan covers a whole family under one. That refusal is right — guessing a family member is how a
   * child's balance lands on their sibling — but it means the cycle's own charges resolved to NULL
   * for exactly the families this matters most for, and a null entry is then visible to everyone
   * holding the key.
   *
   * A claim does not have that ambiguity: it names one verification, and the verification names the
   * patient, resolved on name and date of birth rather than on the policy. So when an entry cites a
   * claim, that is the better question to ask, and this asks it.
   *
   * Optional, and null is a normal answer: a deployment with no directory, or a claim whose
   * verification predates the patient master, falls back to the member ID exactly as before.
   */
  byClaimId?(claimId: string): Promise<string | null>;
}

/** The default: no directory wired, so entries carry no patient id and behave exactly as before M14. */
export const NoPatientLookup: PatientLookup = {
  async byMemberId(): Promise<string | null> {
    return null;
  },
};

export class PatientLedgerService {
  #repo: LedgerRepository;
  #publisher: EventPublisher;
  #patients: PatientLookup;

  constructor(
    repo: LedgerRepository,
    publisher: EventPublisher = new NullEventPublisher(),
    patients: PatientLookup = NoPatientLookup
  ) {
    this.#repo = repo;
    this.#publisher = publisher;
    this.#patients = patients;
  }

  /**
   * Charge the patient what the payer left them, from `remittance.posted`.
   *
   * Idempotent on the posting id: the outbox delivers at least once, and a double-charged patient is
   * the worst failure this product can produce — unlike a wrong dashboard number, it leaves the
   * building as a demand for money the patient does not owe.
   *
   * Zero-responsibility postings are skipped rather than recorded as $0 entries: a statement listing
   * "$0.00 — Delta Dental processed your claim" is noise on the one document a patient reads closely.
   */
  async chargeFromPosting(payload: RemittancePostedBody, now: Date = new Date()): Promise<LedgerEntry | null> {
    if (!payload.memberId) return null; // an unattributable payment is not a patient's debt

    /**
     * ── A BALANCE UNDER COORDINATION IS NOT THE PATIENT'S TO BE BILLED (M8) ─────────────────────
     *
     * When the payer assigned money to another plan's adjudication (`OA` / CARC 23) or forwarded
     * the claim outright (CLP02 `19`/`20`), what the patient actually owes depends on what that
     * other plan pays. The `PR` figure on THIS advice is the primary's view, not the final answer.
     *
     * The remittance safety gate already holds such an advice, so this only runs on one a person
     * released — and that is exactly why the second layer is needed. Releasing a remittance means
     * "I have reconciled this file"; it does not mean "I have established the patient owes this".
     * Treating those as the same decision is how the money gets billed anyway.
     *
     * Nothing is lost by refusing. The amount is on the remittance, on the posting, named on the
     * variance as `coordinationAmount`, and stated in the hold reason. The one thing that does not
     * happen is a demand leaving the building for money a secondary payer may owe — which is the
     * whole rule: UNKNOWN goes to a human, never to the patient.
     */
    const coordination = payload.coordinationAmount ?? 0;
    if (coordination !== 0 || payload.forwardedToOtherPayer === true) return null;

    /**
     * ── ONE CLAIM, ONE PATIENT BALANCE — WHATEVER THE PAYER DOES NEXT (M6) ──────────────────────
     *
     * This charged `payload.patientResponsibility` outright, idempotent only on the posting id. That
     * guards a REDELIVERY of one posting and nothing else. A payer that re-adjudicates a claim —
     * a COB correction, an appeal it paid, a fee-schedule correction — issues a SECOND posting under
     * a new trace number, and the patient was charged their share a second time.
     *
     * The reversal gate does not cover it. `checkRemittanceSafety` blocks CLP-22 reversals, which
     * catches payers that send a formal retraction; the ones that simply re-adjudicate send no
     * reversal at all. And Claims already handles its side correctly (`isTerminal` → an audit note,
     * no state change), so the two halves of the same event disagreed: the claim knew it had already
     * been settled and the ledger did not.
     *
     * A double-charged patient is the one failure in this module that leaves the building, as a
     * demand for money they do not owe.
     *
     * ── WHY A DELTA, AND WHY IT MOVES IN BOTH DIRECTIONS ────────────────────────────────────────
     * The invariant is that what this claim has charged the patient equals the payer's LATEST word
     * on their share. So each posting contributes the difference:
     *
     *   • the payer raised the patient's share  → charge the increase;
     *   • the payer lowered it                  → reduce by the decrease;
     *   • the payer restated the same figure    → nothing at all.
     *
     * The downward direction is deliberately as automatic as the upward one. Raising a patient's
     * balance on the payer's say-so while requiring a human to lower it would bias the ledger toward
     * over-billing, and the two are the same kind of statement from the same source. It is NOT the
     * "courtesy adjustment" `recordAdjustment` gates behind a person — nobody is choosing to forgive
     * anything; the payer has restated what is owed, and the entry names the posting that said so.
     */
    /**
     * Serialise before reading, exactly as `#humanEntry` does (M16). The delta below is a
     * read-then-write: two postings for the same claim handled concurrently — the request drain and
     * the background worker both run — would otherwise both read the same prior state, both compute
     * the full delta, and charge the patient twice. The `source_ref` unique index cannot catch this:
     * the postings are genuinely different events, so both rows insert.
     */
    await this.#repo.lockPatient(payload.memberId);
    const priorEntries = await this.#repo.entriesFor(payload.memberId);
    const alreadyForClaim = priorEntries
      .filter((e) => e.claimId === payload.claimId && (e.sourceRef ?? "").startsWith("posting:"))
      .reduce((total, e) => total + e.amount, 0);

    /**
     * ── DOES THIS ADVICE ACTUALLY SAY ANYTHING ABOUT THE PATIENT? (L-2) ─────────────────────────
     *
     * The symmetry argued for above — the payer may raise or lower the share, and both are the same
     * kind of statement — is correct, and it is preserved. What it assumed is that every posting on
     * a claim IS such a statement. That was true while a claim could only ever have one posting.
     *
     * It stopped being true the moment appeals began settling. A supplemental cheque paying a won
     * award carries `patientResponsibility: 0` because it re-adjudicates nothing — it moves money to
     * the practice and is silent about the patient. Read as a restatement, that silence became "the
     * payer lowered the share to zero", and the ledger credited the balance away. On staging it
     * forgave a real $136.01 the first time an appeal settled.
     *
     * So the question is no longer "did the figure change?" but "did the payer RESTATE it?".
     *
     * ── CLP02 IS NECESSARY AND NOT SUFFICIENT ───────────────────────────────────────────────────
     * The obvious answer is the claim status code, and it is not enough. The staging settlement that
     * forgave $136.01 arrived as CLP02 `partial` — a perfectly ordinary "processed" status, because
     * a payer sending a supplemental cheque has no other status to use. Gating on CLP02 alone would
     * have let exactly the defect through.
     *
     * What separates the two is whether the advice carries any PATIENT-responsibility content: a
     * `PR`-group CAS adjustment, or a non-zero patient figure. The original advice had both. The
     * settlement had neither — it carried a contractual write-off and a payment, and said nothing
     * about the patient. A genuine re-adjudication to zero still qualifies, because zeroing a
     * patient's share is done with PR-group reversal adjustments rather than by omission.
     *
     * Remittance computes that where the adjustments actually live and states it on the event, so
     * this module consumes a fact rather than re-deriving one from figures.
     */
    const stated = payload.restatesPatientResponsibility;
    /**
     * Absent means the event predates this field. Charging an INCREASE is still right — that is what
     * every such event has always meant — but a DECREASE must not be inferred from an old payload
     * that never carried the distinction. So the fallback is deliberately asymmetric, and it is the
     * safe direction: a balance left standing is a mistake a person can find and reverse; one
     * credited away silently is not.
     */
    const delta = (payload.patientResponsibility - alreadyForClaim) as Cents;
    if (stated === false || (stated === undefined && delta < 0 && alreadyForClaim > 0)) {
      return null;
    }
    /**
     * Zero covers three cases at once, and all three want the same answer: a claim the payer left
     * nothing on, a redelivery of a posting already reflected here, and a re-adjudication that did
     * not move the patient's share.
     */
    if (delta === 0) return null;

    const superseding = alreadyForClaim !== 0;

    if (delta > 0) {
      return this.#append(
        {
          patientKey: payload.memberId,
          patientName: payload.patientName,
          kind: "charge",
          amount: delta,
          occurredAt: payload.postedAt,
          description: superseding
            ? `${payload.payerName} reprocessed the claim and raised patient responsibility to ` +
              `${formatUsd(payload.patientResponsibility)}; ${formatUsd(delta)} added to the ` +
              `${formatUsd(alreadyForClaim as Cents)} already charged.`
            : `${payload.payerName} processed the claim and left ` +
              `${formatUsd(payload.patientResponsibility)} as patient responsibility.`,
          claimId: payload.claimId,
          denialId: null,
          sourceRef: `posting:${payload.postingId}`,
          recordedBy: "system",
        },
        now
      );
    }

    // The payer lowered the patient's share. Recorded as a reduction against the same claim, sourced
    // to the posting that said so — attributable, and reversible by reading the ledger.
    return this.#append(
      {
        patientKey: payload.memberId,
        patientName: payload.patientName,
        kind: "adjustment",
        amount: Math.abs(delta) as Cents,
        occurredAt: payload.postedAt,
        description:
          `${payload.payerName} reprocessed the claim and lowered patient responsibility to ` +
          `${formatUsd(payload.patientResponsibility)}; ${formatUsd(Math.abs(delta) as Cents)} of the ` +
          `${formatUsd(alreadyForClaim as Cents)} already charged is no longer owed.`,
        claimId: payload.claimId,
        denialId: null,
        sourceRef: `posting:${payload.postingId}`,
        recordedBy: "system",
      },
      now
    );
  }

  /**
   * Charge the patient a denied amount a human decided is theirs, from `denial.closed`.
   *
   * Only `patient_billed` produces a charge. `written_off` is the practice absorbing the money, and
   * absorbing it means nobody is billed — the distinction is the entire point of asking a human
   * which it was.
   */
  async chargeFromDenial(payload: DenialClosedBody, now: Date = new Date()): Promise<LedgerEntry | null> {
    if (payload.closedAs !== "patient_billed") return null;
    if (payload.deniedAmount <= 0 || !payload.memberId) return null;

    return this.#append(
      {
        patientKey: payload.memberId,
        patientName: payload.patientName,
        kind: "charge",
        amount: payload.deniedAmount,
        occurredAt: payload.closedAt,
        description:
          `${payload.payerName} denied ${formatUsd(payload.deniedAmount)} (reason ${payload.carcCode}) ` +
          `and ${payload.closedBy} determined it is the patient's responsibility: ${payload.reason}`,
        claimId: payload.claimId,
        denialId: payload.denialId,
        sourceRef: `denial:${payload.denialId}`,
        recordedBy: payload.closedBy,
      },
      now
    );
  }

  /** A patient paid. Always attributed. */
  async recordPayment(patientKey: string, input: HumanEntryInput, now: Date = new Date()): Promise<PatientStatement> {
    return this.#humanEntry(patientKey, "payment", input, now);
  }

  /** A courtesy discount or a correction. Reasoned and attributed. */
  async recordAdjustment(patientKey: string, input: HumanEntryInput, now: Date = new Date()): Promise<PatientStatement> {
    if (!input.note?.trim()) {
      throw new LedgerActionError("an adjustment needs a reason — a discount nobody can account for is a leak");
    }
    return this.#humanEntry(patientKey, "adjustment", input, now);
  }

  /** The practice gives up on collecting. Reasoned and attributed. */
  async writeOff(patientKey: string, input: HumanEntryInput, now: Date = new Date()): Promise<PatientStatement> {
    if (!input.note?.trim()) {
      throw new LedgerActionError("a write-off needs a reason — this is revenue the practice is choosing to lose");
    }
    return this.#humanEntry(patientKey, "writeoff", input, now);
  }

  /** One patient's account and the entries behind it. */
  async statement(patientKey: string, now: Date = new Date()): Promise<PatientStatement | null> {
    const entries = await this.#repo.entriesFor(patientKey);
    if (entries.length === 0) return null;
    return buildStatement(patientKey, latestName(entries), entries, now);
  }

  /**
   * One HUMAN's account across every member ID they have ever held (M14 deliverable 4).
   *
   * The acceptance criterion this exists for: 12,500 − 5,000 under one plan plus 8,000 under another
   * is one person and one number, 15,500 — not two unrelated accounts that a biller has to add up in
   * their head and a patient receives two statements for.
   *
   * The account key on the result is the PATIENT id rather than a member ID, deliberately: this is a
   * different question from `statement()` and must not be mistaken for it. `statement()` still
   * answers "what does this account owe", is what every existing route and the aging report use, and
   * is unchanged — the unified view is a new query alongside the old one, never a redefinition of
   * it. That is the same property migration 0015 was built around, and it is why no balance anywhere
   * could move as a result of this.
   *
   * Returns null when the person has no financial history at all, which is normal: a patient the
   * practice has verified but never billed has a record and no ledger.
   */
  async unifiedStatement(scope: PatientScope, now: Date = new Date()): Promise<PatientStatement | null> {
    const entries = await this.#repo.list({ patient: scope });
    if (entries.length === 0) return null;
    return buildStatement(scope.patientId, latestName(entries), entries, now);
  }

  /**
   * Every account, ranked by what it costs the practice to leave alone.
   *
   * Age dominates size: a balance's chance of being collected falls off a cliff after 90 days, while
   * a large recent balance is simply how dentistry works.
   */
  async list(filter?: LedgerFilter, now: Date = new Date()): Promise<PatientAccount[]> {
    return this.#accounts(await this.#repo.list(filter), now).sort(
      (a, b) => b.priority - a.priority || b.balance - a.balance
    );
  }

  /**
   * This context's contribution to a chronology (M14 deliverable 4) — one entry per movement.
   *
   * The thinnest of the five, because an append-only ledger IS a history: every row was written once
   * at the moment it happened and carries the person responsible. That was the reason for choosing an
   * append-only design over a mutable balance column, and this is where that choice pays.
   */
  async history(filter?: LedgerFilter): Promise<HistoryEntry[]> {
    return orderHistory(ledgerHistory(await this.#repo.list(filter)));
  }

  /** The practice-level answer to "what do our patients owe us?". */
  async summary(now: Date = new Date()): Promise<LedgerSummary> {
    return buildSummary(this.#accounts(await this.#repo.list(), now));
  }

  // ── internals ───────────────────────────────────────────────────────────────────────

  /**
   * Group the ledger into the rows the Money screen lists — one per PERSON (F-4).
   *
   * ── WHY THIS USED TO SHOW TWO PEOPLE AS ONE ─────────────────────────────────────────────────
   * It grouped on `patientKey`, which is the member ID: a POLICY, not a person. A dental plan
   * covers a whole family under one subscriber id, so a parent and child sharing `FAM-STG001`
   * collapsed into a single row carrying both balances — and `latestName` then labelled that row
   * with whichever of them the payer had mentioned most recently. Staging showed $1,015.02 owed by
   * "Ada Stagetest" with Kit absent entirely, when each of them owed $507.51.
   *
   * The variable was called `byPatient` and it was by account. That was the whole bug.
   *
   * ── WHY THE NAME NEEDS NO LOOKUP ────────────────────────────────────────────────────────────
   * An earlier design had the composition root resolve names from the patient master, because this
   * module may not read that table. It turns out not to be needed: once a group is one person,
   * `latestName` is reading that person's own entries and is right by construction. The commingling
   * WAS the naming bug.
   *
   * ── THE FALLBACK IS LOAD-BEARING ────────────────────────────────────────────────────────────
   * `patientId` is null for money the patient master never resolved — and `byMemberId` returns null
   * precisely on family policies, which are the accounts this fix is about. Those entries group
   * under their key so they still appear and still total correctly; they simply cannot be split by
   * person until someone identifies them. Dropping them would hide real money.
   */
  #accounts(entries: LedgerEntry[], now: Date): PatientAccount[] {
    const byPerson = new Map<string, LedgerEntry[]>();
    for (const entry of entries) {
      const key = groupKeyFor(entry);
      byPerson.set(key, [...(byPerson.get(key) ?? []), entry]);
    }
    return [...byPerson.entries()].map(([, group]) =>
      buildAccount(group[0]!.patientKey, latestName(group), group, now, group[0]!.patientId ?? null)
    );
  }

  async #humanEntry(
    patientKey: string,
    kind: Exclude<EntryKind, "charge">,
    input: HumanEntryInput,
    now: Date
  ): Promise<PatientStatement> {
    const actor = input.recordedBy.trim();
    if (!actor) throw new LedgerActionError("a recording user is required — money never moves anonymously");
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new LedgerActionError("the amount must be a positive whole number of cents");
    }

    /**
     * Serialise against this account before reading it (M16).
     *
     * Everything below is a read-then-write: read the entries, compute the balance, refuse an amount
     * larger than it, append. Under `READ COMMITTED` two payments taken at the same moment both read
     * the same pre-state, both pass the check, and both are written — the balance goes negative,
     * which is exactly what the check exists to prevent.
     *
     * The lock is the serialisation, held until the request's transaction commits. In memory it is a
     * no-op; there is no concurrency to lose to.
     */
    await this.#repo.lockPatient(patientKey);
    const existing = await this.#repo.entriesFor(patientKey);
    if (existing.length === 0) throw new PatientAccountNotFoundError(patientKey);

    const account = buildAccount(patientKey, latestName(existing), existing, now);
    if (input.amount > account.balance) {
      throw new LedgerActionError(
        `${formatUsd(input.amount)} is more than the ${formatUsd(account.balance)} outstanding — ` +
          `a ledger that can go negative by accident is one nobody can reconcile`
      );
    }

    const label =
      kind === "payment" ? "Payment received" : kind === "adjustment" ? "Courtesy adjustment" : "Written off";
    const entry = await this.#append(
      {
        patientKey,
        patientName: account.patientName,
        kind,
        amount: input.amount,
        occurredAt: now.toISOString(),
        description: `${label} by ${actor}${input.note?.trim() ? `: ${input.note.trim()}` : "."}`,
        claimId: null,
        denialId: null,
        // A human action cannot be redelivered, so there is nothing to be idempotent against — and
        // giving it a synthetic key would silently swallow a genuine second payment.
        sourceRef: null,
        recordedBy: actor,
      },
      now
    );

    const after = await this.#repo.entriesFor(patientKey);
    const statement = buildStatement(patientKey, account.patientName, after, now);

    await this.#publisher.publish(
      "patient.payment.recorded",
      entry!.id,
      {
        entryId: entry!.id,
        patientKey,
        patientName: account.patientName,
        occurredAt: entry!.occurredAt,
        recordedBy: actor,
        kind,
        amount: input.amount,
        balanceAfter: statement.account.balance,
      },
      { occurredAt: now }
    );

    return statement;
  }

  /** Write one entry, applying the sign convention and announcing a charge. */
  async #append(draft: Omit<LedgerEntry, "id" | "patientId">, now: Date): Promise<LedgerEntry | null> {
    /**
     * Whose money this is (M14 part 2), resolved at the single choke point every entry passes
     * through — from the cycle and from a person alike, so the two can never diverge.
     *
     * A failure to resolve is NOT a failure to record. The member ID may belong to a patient whose
     * verification predates the patient master, or to a legacy key; the entry is still real money
     * and must still be written. Turning "we cannot tell who this is" into "the front desk cannot
     * take this payment" would be a worse outcome than a null, and `patientKey` still carries the
     * account either way.
     */
    /**
     * The CLAIM is asked first when there is one, and the member ID only after.
     *
     * Both answer the same question, but not equally well. A member ID is a policy, so for a family
     * sharing one `byMemberId` correctly refuses to choose and returns null — and a charge written
     * with a null patient is then part of every family member's balance, because an unresolved entry
     * belongs to whoever holds its key. The cycle's charges are exactly the ones that cite a claim,
     * and a claim names one verification which names one patient, so for them the ambiguity is not
     * real and does not have to be inherited.
     *
     * Order matters and the fallback is not redundant: a claim whose verification predates the
     * patient master resolves to null here and is then asked of the member ID, which is where such a
     * row was always answered. Nothing that resolved before resolves differently now; entries that
     * could not resolve at all are still written, still with a null, and still recorded.
     */
    let patientId: string | null = null;
    try {
      if (draft.claimId && this.#patients.byClaimId) {
        patientId = await this.#patients.byClaimId(draft.claimId);
      }
      patientId ??= await this.#patients.byMemberId(draft.patientKey);
    } catch {
      patientId = null;
    }

    const entry: LedgerEntry = {
      ...draft,
      patientId,
      id: randomUUID(),
      // The one place the sign convention is applied: callers always pass a positive amount.
      amount: signed(draft.kind, draft.amount),
    };

    const written = await this.#repo.append(entry);
    if (!written) return null; // already recorded — a redelivery, not an error

    if (entry.kind === "charge") {
      await this.#publisher.publish(
        "patient.charged",
        entry.id,
        {
          entryId: entry.id,
          patientKey: entry.patientKey,
          patientName: entry.patientName,
          claimId: entry.claimId,
          denialId: entry.denialId,
          occurredAt: entry.occurredAt,
          amount: Math.abs(entry.amount) as Cents,
          reason: entry.description,
        },
        { occurredAt: now }
      );
    }
    return entry;
  }
}

/** The display name from the most recent entry — a patient who changed their name kept both. */
function latestName(entries: LedgerEntry[]): string {
  const named = [...entries]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .find((e) => e.patientName.trim() !== "");
  return named?.patientName ?? "Unknown patient";
}
