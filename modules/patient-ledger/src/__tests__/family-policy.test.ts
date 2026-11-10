/**
 * A family policy is not a person, and the statement must never say it is.
 *
 * ── THE DEFECT, FOUND BY READING THE LIVE SCREEN ───────────────────────────────────────────────
 * A ledger account is keyed by MEMBER ID, which is right: that identity travels with the money from
 * verification through to the payer's advice, and it is what a payer pays against. On a family plan
 * one member ID covers several people.
 *
 * The list screen was fixed for this (F-4) and groups by person. The account screen was not. So on
 * staging:
 *
 *   the Patients list showed   "Nils Demo — $482.51" and "Nora Demo — $482.51"
 *   clicking either opened     "Nora Demo · $965.02 owed"
 *   under the heading          "Read to the patient"
 *   with the script            "Nora Demo owes $965.02."
 *
 * That is a collection demand, written to be spoken aloud with the practice's full authority, for
 * money that was half her brother's — and the two ledger rows behind it were identical to the
 * character ("Delta Dental processed the claim and left $482.51 as patient responsibility"), so the
 * person reading it had no way to tell. Nora's own patient record said $482.51 the whole time.
 *
 * Every entry has always carried `patientId` and `patientName`. Nothing was missing; the account
 * folded them together and took whichever name appeared last.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildAccount, buildStatement } from "../engine/account.ts";
import type { LedgerEntry } from "../types.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

const charge = (
  patientId: string | null,
  patientName: string,
  amount: number,
  at = "2026-08-28T04:40:49.311Z"
): LedgerEntry => ({
  id: `e-${patientName}-${amount}-${at}`,
  patientKey: "DEMO0106",
  patientName,
  kind: "charge",
  amount: cents(amount),
  occurredAt: at,
  description: "Delta Dental processed the claim and left the balance as patient responsibility.",
  claimId: null,
  denialId: null,
  sourceRef: null,
  patientId,
  recordedBy: "system",
});

/** The staging fixture, exactly: two dependents on one policy, same day, same amount. */
const FAMILY = [
  charge("id-nora", "Nora Demo", 482.51, "2026-08-28T04:40:49.311Z"),
  charge("id-nils", "Nils Demo", 482.51, "2026-08-28T04:40:14.648Z"),
];

test("the account reports each person's own share", () => {
  const account = buildAccount("DEMO0106", "Nora Demo", FAMILY, NOW);

  assert.equal(account.balance, cents(965.02), "the policy total is unchanged — this is a naming fix, not a money fix");
  assert.equal(account.people.length, 2);
  /** Order-independent: the two shares are equal here, so their relative order carries no meaning. */
  assert.deepEqual(
    account.people.map((p) => `${p.patientName} ${p.balance}`).sort(),
    [`Nils Demo ${cents(482.51)}`, `Nora Demo ${cents(482.51)}`],
    "both people, each with their own balance"
  );
  assert.equal(
    account.people.reduce((t, p) => t + p.balance, 0),
    account.balance,
    "and the shares must account for the total exactly"
  );
});

test("the read-aloud script never tells one person they owe the family's balance", () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. These lines are read to whoever is standing at the desk.
   */
  const lines = buildStatement("DEMO0106", "Nora Demo", FAMILY, NOW).statementLines;
  const script = lines.join(" ");

  assert.ok(
    !/Nora Demo owes \$965\.02/.test(script),
    `the script demanded the whole policy balance from one person: ${script}`
  );
  assert.ok(
    !/(Nora|Nils) Demo owes/.test(script),
    "no single person may be named as owing this account's balance at all"
  );
  assert.match(script, /covers 2 people/, "it must say the policy covers more than one person");
  assert.match(script, /Nora Demo \$482\.51/, "and give each person's own share");
  assert.match(script, /Nils Demo \$482\.51/);
  assert.match(script, /Do not ask any one of them for the total/i, "and say plainly what not to do");
});

test("two identical charges on one day are told apart by the person", () => {
  /**
   * The descriptions are identical to the character, because two dependents were treated the same
   * day under the same plan. Without the name prefix the itemisation is two lines a human cannot
   * distinguish, on the screen where they are deciding who to bill.
   */
  const script = buildStatement("DEMO0106", "Nora Demo", FAMILY, NOW).statementLines.join(" ");
  assert.match(script, /Nora Demo, \$482\.51 —/);
  assert.match(script, /Nils Demo, \$482\.51 —/);
});

test("the recommended action does not name one person either", () => {
  const account = buildAccount("DEMO0106", "Nora Demo", FAMILY, NOW);
  assert.ok(!/Nora|Nils/.test(account.recommendedAction), account.recommendedAction);
  assert.match(account.recommendedAction, /across 2 people/);
  assert.match(account.recommendedAction, /separately/);
});

// ── The ordinary case must be completely unchanged ──────────────────────────────────────────────

const SOLO = [charge("id-solo", "Gina Demo", 1234.51)];

test("a single-person account still speaks the way it always did", () => {
  const account = buildAccount("DEMO0299", "Gina Demo", SOLO, NOW);
  assert.equal(account.people.length, 1);

  const script = buildStatement("DEMO0299", "Gina Demo", SOLO, NOW).statementLines.join(" ");
  assert.match(script, /Gina Demo owes \$1,234\.51\./);
  assert.match(script, /That is \$1,234\.51 charged, less \$0\.00 paid\./);
  assert.ok(!/covers/.test(script), "and says nothing about a policy covering people");
  assert.ok(!/Gina Demo, \$1,234\.51/.test(script), "nor prefixes its own itemisation with the name");
});

test("a settled account and a credit are named for the policy only when shared", () => {
  const settled = buildStatement("DEMO0299", "Gina Demo", [], NOW);
  assert.match(settled.statementLines.join(" "), /Gina Demo has no account activity/);

  const refund: LedgerEntry = { ...charge("id-solo", "Gina Demo", -50), kind: "payment", amount: cents(-50) };
  const credit = buildStatement("DEMO0299", "Gina Demo", [refund], NOW);
  assert.match(credit.statementLines.join(" "), /Gina Demo has a credit balance of \$50\.00/);
});

test("money the patient master never identified is its own share, never merged into a named person", () => {
  /**
   * `patientId` is null for entries nobody has matched to a patient record. Folding those into
   * whichever named person is also on the policy would attribute a stranger's charge to them —
   * the same error in a quieter form.
   */
  const mixed = [charge("id-nora", "Nora Demo", 482.51), charge(null, "Unknown", 100)];
  const account = buildAccount("DEMO0106", "Nora Demo", mixed, NOW);

  assert.equal(account.people.length, 2);
  const unidentified = account.people.find((p) => p.patientId === null)!;
  assert.ok(unidentified, "the unidentified money is its own row");
  assert.equal(unidentified.balance, cents(100));
  assert.equal(
    account.people.find((p) => p.patientId === "id-nora")!.balance,
    cents(482.51),
    "and the named person's share is untouched by it"
  );
});

test("when one person on the policy pays, only their share moves", () => {
  /**
   * The fixtures above are all charges, which made "the shares sum to the balance" pass under a
   * mutation that summed only charges — a family where one dependent had paid would then have shown
   * both of them still owing the full amount. Found by mutation testing, not by reading.
   */
  const paid: LedgerEntry = {
    ...charge("id-nils", "Nils Demo", -200, "2026-08-30T10:00:00.000Z"),
    kind: "payment",
    amount: cents(-200),
    description: "Card payment taken at the desk.",
    recordedBy: "reception@clinic",
  };
  const account = buildAccount("DEMO0106", "Nora Demo", [...FAMILY, paid], NOW);

  assert.equal(account.balance, cents(765.02), "the policy total drops by exactly what was paid");
  assert.equal(
    account.people.reduce((t, p) => t + p.balance, 0),
    account.balance,
    "and the shares still account for it exactly"
  );

  const nils = account.people.find((p) => p.patientName === "Nils Demo")!;
  const nora = account.people.find((p) => p.patientName === "Nora Demo")!;
  assert.equal(nils.balance, cents(282.51), "the payer's own share falls");
  assert.equal(nils.paid, cents(200));
  assert.equal(nora.balance, cents(482.51), "and nobody else's does");
  assert.equal(nora.paid, cents(0));

  const script = buildStatement("DEMO0106", "Nora Demo", [...FAMILY, paid], NOW).statementLines.join(" ");
  assert.match(script, /Nora Demo \$482\.51/);
  assert.match(script, /Nils Demo \$282\.51/, "the script must quote the reduced share, not the original charge");
});
