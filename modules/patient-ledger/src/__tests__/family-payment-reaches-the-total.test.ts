/**
 * A payment taken on a family policy must reduce what the practice reports it is owed.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `buildSummary` summed only accounts whose balance was positive. That filter is right in spirit —
 * an account in credit owes nothing, and letting it offset a different patient's debt would
 * understate real A/R — but it interacted badly with how rows are grouped.
 *
 * Rows group by PERSON where one is known and by ACCOUNT where nobody is (`groupKeyFor`), and
 * `byMemberId` deliberately refuses to name a person on a family policy: a member id covering a
 * parent and a child cannot be resolved to one of them. A payment taken at the desk cites no claim,
 * so it resolves to no patient, so it forms a row of its own carrying a NEGATIVE balance — and the
 * positive-balance filter dropped that row entirely.
 *
 * Reproduced against staging before the fix: a $10.00 payment on FAM-STG001 moved the ledger from
 * $5,455.12 to $5,445.12 while `summary.totalOutstanding` went on reporting $5,455.12.
 *
 * The consequence compounds. Every family payment a practice ever takes is invisible to the figure
 * its owner reads as "what patients owe us", so that figure drifts permanently upward and the
 * collections it reports never appear to land.
 *
 * ── WHAT THE FIX MUST NOT DO ─────────────────────────────────────────────────────────────────────
 * Netting everything would be a worse bug: one patient's credit would silently pay down another
 * patient's debt and the practice would under-chase real money. The netting is therefore scoped to
 * the POLICY — the member id the money was actually taken on — and the last two tests here exist to
 * hold that line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import { buildAccount, buildSummary } from "../engine/account.ts";
import type { LedgerEntry } from "../types.ts";

const NOW = new Date("2026-10-01T12:00:00Z");

let seq = 0;
const entry = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    id: `e${++seq}`,
    patientKey: "FAM-1",
    patientId: null,
    patientName: "Ada Family",
    kind: "charge",
    amount: cents(100) as Cents,
    occurredAt: "2026-09-20T09:00:00.000Z",
    description: "",
    claimId: null,
    denialId: null,
    sourceRef: null,
    recordedBy: "test",
    ...over,
  }) as LedgerEntry;

/** One row per person, plus a row for anything nobody could be named on — what `#accounts` produces. */
const accountsOf = (groups: LedgerEntry[][]) =>
  groups.map((g) => buildAccount(g[0]!.patientKey, g.at(-1)!.patientName, g, NOW, g[0]!.patientId ?? null));

test("a payment on a family policy reduces what the practice is owed", () => {
  const ada = [entry({ patientId: "p-ada", patientName: "Ada", amount: cents(500) as Cents })];
  const kit = [entry({ patientId: "p-kit", patientName: "Kit", amount: cents(500) as Cents })];
  /** No claim, so no person: exactly what the desk produces on a family. */
  const paid = [entry({ patientId: null, patientName: "Ada", kind: "payment", amount: cents(-10) as Cents })];

  const before = buildSummary(accountsOf([ada, kit]));
  const after = buildSummary(accountsOf([ada, kit, paid]));

  assert.equal(before.totalOutstanding, cents(1000), "the family owes $1,000.00 to begin with");
  assert.equal(
    after.totalOutstanding,
    cents(990),
    "a $10.00 payment must show up in the total — it used to be dropped for having a negative balance"
  );
});

test("the family is one account to chase, not three rows", () => {
  const ada = [entry({ patientId: "p-ada", patientName: "Ada", amount: cents(500) as Cents })];
  const kit = [entry({ patientId: "p-kit", patientName: "Kit", amount: cents(500) as Cents })];
  const paid = [entry({ patientId: null, kind: "payment", amount: cents(-10) as Cents })];

  const summary = buildSummary(accountsOf([ada, kit, paid]));
  assert.equal(
    summary.accountsWithBalance,
    1,
    "two siblings and a credit on one member id are one account, not three"
  );
});

test("a family that has paid in full disappears from the total", () => {
  const ada = [entry({ patientId: "p-ada", patientName: "Ada", amount: cents(500) as Cents })];
  const paid = [entry({ patientId: null, kind: "payment", amount: cents(-500) as Cents })];

  const summary = buildSummary(accountsOf([ada, paid]));
  assert.equal(summary.totalOutstanding, 0, "nothing is owed once the balance is settled");
  assert.equal(summary.accountsWithBalance, 0);
});

test("one patient's credit never pays down another patient's debt", () => {
  /**
   * The guard the original filter existed for, and the thing the fix must not trade away. These are
   * two DIFFERENT member ids: netting across them would report less owed than the practice is owed,
   * and would send nobody to chase the account that is genuinely behind.
   */
  const owing = [entry({ patientKey: "SOLO-A", patientId: "p-a", patientName: "A", amount: cents(800) as Cents })];
  const credit = [
    entry({ patientKey: "SOLO-B", patientId: "p-b", patientName: "B", amount: cents(300) as Cents }),
    entry({ patientKey: "SOLO-B", patientId: "p-b", patientName: "B", kind: "payment", amount: cents(-500) as Cents }),
  ];

  const summary = buildSummary(accountsOf([owing, credit]));
  assert.equal(summary.totalOutstanding, cents(800), "B being $200.00 in credit does not reduce what A owes");
  assert.equal(summary.accountsWithBalance, 1, "only A is an account with a balance");
});

test("an overpaid family is excluded, not counted as negative money owed", () => {
  const ada = [entry({ patientId: "p-ada", patientName: "Ada", amount: cents(100) as Cents })];
  const over = [entry({ patientId: null, kind: "payment", amount: cents(-250) as Cents })];

  const summary = buildSummary(accountsOf([ada, over]));
  assert.equal(summary.totalOutstanding, 0, "a policy in credit owes nothing; it does not owe a negative amount");
});
