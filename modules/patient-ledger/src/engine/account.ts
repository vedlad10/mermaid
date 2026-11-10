/**
 * The ledger engine — entries in, an account out.
 *
 * Pure and deterministic. This is the only place the balance, the aging split and the work priority
 * are decided, and it takes no clock beyond the one it is handed, so the same entries always produce
 * the same statement. That matters more here than anywhere else in the product: this is the number a
 * practice puts in front of a patient and has to be able to defend.
 *
 * ── HOW AGING IS COMPUTED, AND WHY IT IS NOT THE OBVIOUS WAY ───────────────────────────────────
 * The naive method buckets every charge by its own age and reports the totals. That double-counts:
 * a patient who was charged $200 ninety days ago and paid $200 last week would still show $200 in
 * the 90-plus bucket, and a practice would chase money it already has.
 *
 * So payments are applied OLDEST CHARGE FIRST — the same order a practice-management system, a
 * collections agency and a patient all assume — and only the unpaid remainder of each charge is
 * aged. The aging therefore always sums to the balance, which is the property that makes an aging
 * report worth printing.
 */
import { addCents, formatUsd, type Cents } from "@mermaid/shared";
import {
  AGING_BUCKETS,
  ENTRY_SIGN,
  type AgingBucket,
  type LedgerEntry,
  type LedgerSummary,
  type AccountPerson,
  type PatientAccount,
  type PatientStatement,
} from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = 0 as Cents;

const sum = (values: Cents[]): Cents => addCents(...values);
const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

const emptyAging = (): Record<AgingBucket, Cents> => ({
  current: ZERO,
  d31_60: ZERO,
  d61_90: ZERO,
  d90_plus: ZERO,
});

/** Which bucket a charge that old belongs in. */
export function bucketFor(days: number): AgingBucket {
  if (days <= 30) return "current";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

const daysBetween = (from: string, now: Date): number =>
  Math.floor((now.getTime() - new Date(from).getTime()) / DAY_MS);

/**
 * Work priority, on the same 0–100 basis every other module uses so the unified Today queue can rank
 * a patient balance against a claim deadline meaningfully.
 *
 * Age dominates size, because a balance's chance of ever being collected falls off a cliff with age
 * while a large recent balance is simply normal. A $60 balance at 120 days is more urgent than a
 * $600 balance at 20 days, and this scoring says so.
 */
function priorityOf(balance: Cents, days: number | null): number {
  if (balance <= 0 || days === null) return 0;
  let priority = days > 90 ? 70 : days > 60 ? 55 : days > 30 ? 40 : 20;
  if (balance >= 50_000) priority += 15; // $500+
  else if (balance >= 20_000) priority += 8;
  return Math.max(0, Math.min(100, priority));
}

function recommend(balance: Cents, days: number | null, name: string): string {
  if (balance < 0) {
    return `${name} has a credit of ${formatUsd(Math.abs(balance) as Cents)} — refund it or apply it to their next visit.`;
  }
  if (balance === 0) return "Nothing outstanding.";
  if (days === null) return `${formatUsd(balance)} outstanding.`;
  if (days > 90) {
    return (
      `${formatUsd(balance)} has been outstanding for ${days} days. Call before this ages further — ` +
      `after 90 days a balance is far more likely to be written off than collected.`
    );
  }
  if (days > 60) return `${formatUsd(balance)} is ${days} days old. Send a second statement and follow up by phone.`;
  if (days > 30) return `${formatUsd(balance)} is ${days} days old. Send a statement.`;
  return `${formatUsd(balance)} outstanding, ${days} day${days === 1 ? "" : "s"} old. Nothing to chase yet.`;
}

/**
 * Fold one patient's entries into an account.
 *
 * `entries` may arrive in any order; this sorts by the business moment, not by write order, because
 * a redelivered event can be written after a later one.
 */
export function buildAccount(
  patientKey: string,
  patientName: string,
  entries: LedgerEntry[],
  now: Date = new Date(),
  /**
   * The person this account belongs to, when the patient master resolved one. Null for money that
   * is still only identified by the policy it arrived under — which is a real state, not a gap to
   * be filled in with a guess.
   */
  patientId: string | null = null
): PatientAccount {
  const ordered = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const charged = sum(ordered.filter((e) => e.kind === "charge").map((e) => e.amount));
  const paid = sum(ordered.filter((e) => e.kind === "payment").map((e) => Math.abs(e.amount) as Cents));
  const forgiven = sum(
    ordered.filter((e) => e.kind === "adjustment" || e.kind === "writeoff").map((e) => Math.abs(e.amount) as Cents)
  );
  const balance = sum(ordered.map((e) => e.amount));

  // Apply every reduction to the oldest outstanding charge first, then age what is left.
  let credit = (paid + forgiven) as number;
  const aging = emptyAging();
  let oldestChargeAt: string | null = null;

  for (const entry of ordered) {
    if (entry.kind !== "charge") continue;
    let remaining = entry.amount as number;
    if (credit > 0) {
      const applied = Math.min(credit, remaining);
      credit -= applied;
      remaining -= applied;
    }
    if (remaining <= 0) continue;
    if (oldestChargeAt === null) oldestChargeAt = entry.occurredAt;
    const bucket = bucketFor(daysBetween(entry.occurredAt, now));
    aging[bucket] = (aging[bucket] + remaining) as Cents;
  }

  const daysOutstanding = oldestChargeAt === null ? null : daysBetween(oldestChargeAt, now);
  const lastActivityAt = ordered.at(-1)?.occurredAt ?? now.toISOString();

  /**
   * WHO, within this account, owes what.
   *
   * An account keyed by member ID is a POLICY, and on a family plan one policy covers several
   * people. Every entry has always carried the person it belongs to; the account folded them
   * together and took whichever name the payer mentioned last. The list screen was fixed to group
   * by person (F-4) and this was not, so clicking "Nils Demo — $482.51" opened an account headed
   * "Nora Demo — $965.02" and a script reading "Nora Demo owes $965.02" — a collection demand, to
   * be read aloud, for money that was half somebody else's.
   *
   * Computed rather than stored: it is a view of the same entries, so it cannot drift from them.
   */
  const people = peopleIn(ordered);

  return {
    patientKey,
    patientName,
    balance,
    charged,
    paid,
    forgiven,
    patientId,
    people,
    aging,
    oldestChargeAt,
    daysOutstanding,
    entryCount: ordered.length,
    lastActivityAt,
    priority: priorityOf(balance, daysOutstanding),
    /**
     * A recommendation must not name one person when the balance belongs to several — that is the
     * sentence a front desk repeats to whoever is standing there.
     */
    recommendedAction:
      people.length > 1
        ? `${formatUsd(balance)} outstanding across ${people.length} people on this policy` +
          `${daysOutstanding === null ? "" : `, ${daysOutstanding} day${daysOutstanding === 1 ? "" : "s"} old`}. ` +
          `Collect from each person separately.`
        : recommend(balance, daysOutstanding, patientName),
  };
}

/**
 * Everyone with entries on this account, each with their own balance, biggest first.
 *
 * Entries the patient master never resolved carry no `patientId`. They are grouped under a single
 * "not yet identified" person rather than dropped, because that is real money — and rather than
 * being merged into a named person, because attributing an unidentified charge to whoever else is
 * on the policy is exactly the error this function exists to prevent.
 */
function peopleIn(entries: LedgerEntry[]): AccountPerson[] {
  const byPerson = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = entry.patientId ? `id:${entry.patientId}` : "unidentified";
    byPerson.set(key, [...(byPerson.get(key) ?? []), entry]);
  }
  return [...byPerson.values()]
    .map((group) => ({
      patientId: group[0]!.patientId ?? null,
      patientName: group.at(-1)!.patientName,
      balance: sum(group.map((e) => e.amount)),
      charged: sum(group.filter((e) => e.kind === "charge").map((e) => e.amount)),
      paid: sum(group.filter((e) => e.kind === "payment").map((e) => Math.abs(e.amount) as Cents)),
    }))
    .sort((a, b) => b.balance - a.balance);
}

/**
 * The plain-English statement.
 *
 * Written to be read ALOUD by a team member, not emailed automatically — this product never messages
 * a patient on its own (human-in-the-loop doctrine). Every sentence names where the number came from,
 * because "you owe $217" with no provenance is the sentence that starts every billing dispute.
 */
export function statementLines(account: PatientAccount, entries: LedgerEntry[]): string[] {
  /** Who to name. A policy covering several people is named by the policy, never by one of them. */
  const whose =
    account.people.length > 1 ? `Member ${account.patientKey}` : account.patientName;

  if (account.balance === 0 && account.entryCount === 0) {
    return [`${whose} has no account activity.`];
  }
  if (account.balance <= 0) {
    return account.balance < 0
      ? [
          `${whose} has a credit balance of ${formatUsd(Math.abs(account.balance) as Cents)}.`,
          "This is money the practice owes them — refund it or hold it against their next visit.",
        ]
      : [`${whose}'s account is settled. Nothing is outstanding.`];
  }

  /**
   * ── NEVER NAME ONE PERSON FOR A FAMILY'S BALANCE ──────────────────────────────────────────────
   * These lines are read ALOUD to whoever is at the desk. On a family policy this account covers
   * several people, and "Nora Demo owes $965.02" was a collection demand for money that was half
   * her brother's — spoken with the practice's full authority, from a screen that gave the person
   * reading it no way to know.
   *
   * A multi-person account therefore never asserts an owner. It names the policy, then each person
   * and their own share, which is the only sentence a practice can actually defend.
   */
  const shared = account.people.length > 1;
  const named = (p: AccountPerson) => `${p.patientName} ${formatUsd(p.balance)}`;

  const lines = shared
    ? [
        `This account is billed under one policy — member ${account.patientKey} — and covers ` +
          `${account.people.length} people. ${formatUsd(account.balance)} is outstanding across all of them.`,
        `Each person owes a different amount: ${account.people.map(named).join(", ")}.`,
        "Collect from each person for their own share. Do not ask any one of them for the total.",
      ]
    : [
        `${account.patientName} owes ${formatUsd(account.balance)}.`,
        `That is ${formatUsd(account.charged)} charged, less ${formatUsd(account.paid)} paid` +
          `${account.forgiven > 0 ? ` and ${formatUsd(account.forgiven)} adjusted or written off` : ""}.`,
      ];

  const charges = entries.filter((e) => e.kind === "charge");
  if (charges.length > 0) {
    // Descriptions are written as complete sentences (they are also shown alone, on the ledger), so
    // the trailing stop is dropped when they are embedded in this one. These lines are read ALOUD to
    // a patient — "…as patient responsibility.." is exactly the kind of seam that makes a statement
    // sound machine-generated at the moment it most needs not to.
    //
    // On a shared policy the person is prefixed, because two dependents treated on the same day
    // produce two charges whose descriptions are identical to the character.
    const phrase = (c: LedgerEntry) =>
      `${shared ? `${c.patientName}, ` : ""}${formatUsd(c.amount)} — ${c.description.replace(/\.$/, "")}`;
    lines.push(
      `The balance comes from ${charges.length} charge${charges.length === 1 ? "" : "s"}: ` +
        charges.slice(0, 3).map(phrase).join("; ") +
        (charges.length > 3 ? `, and ${charges.length - 3} more.` : ".")
    );
  }
  if (account.daysOutstanding !== null && account.daysOutstanding > 30) {
    lines.push(`The oldest unpaid charge is ${account.daysOutstanding} days old.`);
  }
  return lines;
}

export function buildStatement(
  patientKey: string,
  patientName: string,
  entries: LedgerEntry[],
  now: Date = new Date()
): PatientStatement {
  const account = buildAccount(patientKey, patientName, entries, now);
  const newestFirst = [...entries].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)
  );
  return { account, entries: newestFirst, statementLines: statementLines(account, newestFirst) };
}

/** Practice-level totals across every account. */
export function buildSummary(accounts: PatientAccount[]): LedgerSummary {
  const aging = emptyAging();
  for (const account of accounts) {
    for (const bucket of AGING_BUCKETS) {
      aging[bucket] = (aging[bucket] + account.aging[bucket]) as Cents;
    }
  }
  /**
   * ── A PAYMENT ON A FAMILY POLICY USED TO LEAVE THE TOTAL UNCHANGED ────────────────────────────
   * `totalOutstanding` summed only accounts with a POSITIVE balance, and that filter is right in
   * spirit: an account in credit owes nothing, and letting it offset a different patient's debt
   * would understate what the practice is actually owed.
   *
   * But rows are grouped by PERSON where one is known and by ACCOUNT where nobody is (`groupKeyFor`),
   * and `byMemberId` deliberately refuses to name a person on a family policy. So a payment taken at
   * the desk against a family lands in a row of its own, carrying a NEGATIVE balance and no patient —
   * and the filter dropped it. Reproduced on staging: a $10.00 payment against FAM-STG001 moved the
   * ledger to $5,445.12 and left `totalOutstanding` reporting $5,455.12.
   *
   * Every human payment on a family policy was invisible to reported A/R, and the error accumulates:
   * a practice collecting from families watches its outstanding figure refuse to come down.
   *
   * The money belongs to the POLICY, so it nets within the policy and nowhere else. Accounts are
   * folded by `patientKey` first — which puts an unattributed credit against the debts of the very
   * member id it was taken on — and only then is the positive-balance rule applied, per policy.
   * A single-person key nets to itself and is unchanged; a genuinely overpaid patient still nets
   * negative and is still excluded; one patient's credit still cannot offset another's debt.
   */
  const byPolicy = new Map<string, Cents>();
  for (const account of accounts) {
    byPolicy.set(account.patientKey, ((byPolicy.get(account.patientKey) ?? 0) + account.balance) as Cents);
  }
  const owingPolicies = [...byPolicy.values()].filter((b) => b > 0);
  const totalOutstanding = sum(owingPolicies);
  const totalCharged = sum(accounts.map((a) => a.charged));
  const totalPaid = sum(accounts.map((a) => a.paid));

  return {
    /**
     * Counted per policy for the same reason the total is: two siblings owing money on one member id
     * are one account the practice chases, and a family whose debts and credits cancel is not an
     * account with a balance at all.
     */
    accountsWithBalance: owingPolicies.length,
    totalOutstanding,
    aging,
    overNinetyShare: ratio(aging.d90_plus, totalOutstanding),
    totalCharged,
    totalPaid,
    totalForgiven: sum(accounts.map((a) => a.forgiven)),
    collectionRate: ratio(totalPaid, totalCharged),
  };
}

/** A signed amount for an entry kind — the one place the sign convention is applied. */
export const signed = (kind: LedgerEntry["kind"], amount: Cents): Cents =>
  (Math.abs(amount) * ENTRY_SIGN[kind]) as Cents;
