/**
 * Patient-ledger bounded-context types.
 *
 * ── WHY THIS CONTEXT EXISTS ────────────────────────────────────────────────────────────────────
 * Through M8 this product tracked the payer's half of every dollar completely and the patient's half
 * not at all. A verification quoted the patient a number, a posting recorded what the payer said the
 * patient owed, and a denial could be closed as "bill the patient" — and then the money simply
 * stopped existing. A practice could not answer "what do our patients owe us?", which is the second
 * question every practice owner asks and typically 20–30% of collectable revenue.
 *
 * ── AN APPEND-ONLY LEDGER, NOT A BALANCE COLUMN ────────────────────────────────────────────────
 * The obvious shape is a `balance_cents` on a patient row, incremented and decremented. It is the
 * wrong one for money that a person will be asked to pay: when a patient disputes a statement, the
 * only useful answer is *how the number was arrived at*, and a mutable total cannot produce one.
 * Every movement is therefore an immutable entry, and the balance is a fold over them. That also
 * makes idempotency natural — an entry carries the id of the event that caused it, and the database
 * refuses a second entry for the same cause.
 *
 * Money is integer cents throughout. Entries are stored with a SIGNED amount (a charge is positive,
 * a payment negative) so a balance is a sum rather than a switch statement that someone will one day
 * add a case to and forget to negate.
 */
import type { Cents } from "@mermaid/shared";

/**
 * What kind of movement this is.
 *
 * `charge`     — the practice is owed this. From a posting's patient responsibility, or a denial
 *                closed as the patient's to pay.
 * `payment`    — the patient paid. Always recorded by a named person.
 * `adjustment` — a courtesy discount or a correction. Always reasoned and attributed.
 * `writeoff`   — the practice has given up on collecting it. Attributed, and never silent.
 */
export type EntryKind = "charge" | "payment" | "adjustment" | "writeoff";

/** Positive kinds increase what the patient owes; negative kinds reduce it. */
export const ENTRY_SIGN: Record<EntryKind, 1 | -1> = {
  charge: 1,
  payment: -1,
  adjustment: -1,
  writeoff: -1,
};

export interface LedgerEntry {
  id: string;
  /** The account this belongs to — see `PatientAccount.patientKey`. */
  patientKey: string;
  /**
   * The patient's name as it was when this entry was written.
   *
   * Denormalised deliberately, for the same reason an analytics fact denormalises a payer name: a
   * statement reprinted next year must read the way it read when it was issued. It is also what lets
   * an account exist at all without this module owning a patient master it has no business owning.
   */
  patientName: string;
  kind: EntryKind;
  /** SIGNED cents: positive increases the balance, negative reduces it. */
  amount: Cents;
  occurredAt: string;
  /** Plain English, in the words a patient would read on a statement. */
  description: string;
  /** Where this came from, when it came from the cycle rather than from a person. */
  claimId: string | null;
  denialId: string | null;
  /**
   * The domain event (or posting) that caused this entry — the idempotency key.
   *
   * Null only for entries a human created directly, which cannot be redelivered.
   */
  sourceRef: string | null;
  /** The person responsible. "system" only for cycle-driven charges, never for money leaving. */
  recordedBy: string;
  /**
   * Which patient this money belongs to (M14 part 2), or null when the member ID could not be
   * resolved to a coverage on file.
   *
   * ADDITIVE, and deliberately so. `patientKey` remains the account key for every existing query, so
   * no balance depends on this being populated and no balance can move because it is. What it adds
   * is the ability to see one human as one person across every member ID they have ever held —
   * which `patientKey` alone cannot do, because a job change issues a new one.
   *
   * Null is legitimate and is never a reason to refuse an entry. A payment taken for a patient whose
   * verification predates the patient master must still be recordable; turning "we cannot tell who
   * this is" into "the front desk cannot take this payment" would be the worse failure.
   */
  patientId: string | null;
}

/** How overdue a balance is. The buckets a dental practice actually reports on. */
export type AgingBucket = "current" | "d31_60" | "d61_90" | "d90_plus";

export const AGING_BUCKETS: readonly AgingBucket[] = ["current", "d31_60", "d61_90", "d90_plus"];

/** One patient's account, folded from their entries. */
/** One person's share of an account, when the account covers more than one. */
export interface AccountPerson {
  /** Null for money the patient master never resolved — a real state, not a gap to fill with a guess. */
  patientId: string | null;
  patientName: string;
  balance: Cents;
  charged: Cents;
  paid: Cents;
}

export interface PatientAccount {
  /**
   * The account key.
   *
   * The member ID the claim was filed under, which is the identity that travels with the money from
   * verification through to the payer's advice. A practice-management system would key on its own
   * patient record; this system does not create one (`patients` exists and nothing writes it), and
   * inventing a second identity here would be worse than using the one the money already carries.
   */
  patientKey: string;
  /**
   * The person, when the patient master resolved one — null for money still identified only by the
   * policy it arrived under.
   *
   * A row is now one PERSON, not one policy. Grouping on the member id merged a family into a single
   * balance labelled with whichever member the payer mentioned last (F-4).
   */
  patientId: string | null;
  patientName: string;
  /**
   * Everyone with entries on this account, each with their own balance.
   *
   * Length 1 for an ordinary account. Longer on a family policy, where one member ID covers several
   * people — the case where naming the account after one of them, and quoting them the total, is a
   * collection demand for somebody else's money.
   */
  people: AccountPerson[];
  /** What the patient owes right now. Never negative in the UI sense — a credit is reported as one. */
  balance: Cents;
  /** Sum of every charge ever raised. */
  charged: Cents;
  /** Sum of every payment received. */
  paid: Cents;
  /** Courtesy adjustments plus write-offs — money the practice decided not to collect. */
  forgiven: Cents;
  /** Balance split by how long it has been outstanding, oldest charge first. */
  aging: Record<AgingBucket, Cents>;
  /** The oldest unpaid charge's date, or null when nothing is outstanding. */
  oldestChargeAt: string | null;
  /** Days since that charge. Null when nothing is outstanding. */
  daysOutstanding: number | null;
  entryCount: number;
  lastActivityAt: string;
  /** 0–100, comparable with every other module's work priority. */
  priority: number;
  recommendedAction: string;
}

/** A patient's account with the entries behind it — the statement screen. */
export interface PatientStatement {
  account: PatientAccount;
  /** Newest first: a statement is read from the most recent movement backwards. */
  entries: LedgerEntry[];
  /** Plain-English lines a human reads to the patient. Never auto-delivered. */
  statementLines: string[];
}

/** Practice-level totals — the answer to "what do our patients owe us?". */
export interface LedgerSummary {
  accountsWithBalance: number;
  totalOutstanding: Cents;
  aging: Record<AgingBucket, Cents>;
  /** Balances older than 90 days, as a share of everything outstanding. 0–1, null when nothing is. */
  overNinetyShare: number | null;
  totalCharged: Cents;
  totalPaid: Cents;
  totalForgiven: Cents;
  /** `paid ÷ charged`, 0–1. What share of what patients were billed actually arrived. */
  collectionRate: number | null;
}

/**
 * How a ledger entry is grouped into a Money-screen row: by PERSON where one is known, and by
 * ACCOUNT only where nobody has been identified (F-4).
 *
 * Lives here because three places must agree on it — the service that builds the rows, and both
 * repositories' "still owes something" filters. Them diverging is subtle and expensive: a patient
 * with a settled balance inside a family that still owes money would be pulled into the owing list,
 * and one who owes money inside a family netting to zero would vanish from it.
 */
export const groupKeyFor = (entry: { patientId?: string | null; patientKey: string }): string =>
  entry.patientId ? `id:${entry.patientId}` : `key:${entry.patientKey}`;
