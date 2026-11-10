/**
 * Ledger-engine tests.
 *
 * The aging split gets the most attention, because the naive implementation is wrong in a way that
 * costs a practice real money and real goodwill: bucket each charge by its own age and a patient who
 * paid last week still shows in the 90-plus bucket, so the practice chases money it already has.
 * Applying payments oldest-charge-first is what makes the aging sum to the balance, and that property
 * is asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildAccount, buildStatement, buildSummary, bucketFor, signed } from "../index.ts";
import type { LedgerEntry } from "../index.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
let seq = 0;

function entry(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, "kind" | "amount">): LedgerEntry {
  seq += 1;
  return {
    id: `e-${seq}`,
    patientKey: "ABC12345",
    patientName: "Ada Alpha",
    // Null by default on purpose: the aging and balance engines must not depend on the patient link
    // existing. `patientKey` is still the account key, which is what makes M14 part 2 additive.
    patientId: null,
    occurredAt: "2026-09-15T10:00:00.000Z",
    description: "test entry",
    claimId: null,
    denialId: null,
    sourceRef: null,
    recordedBy: "system",
    ...overrides,
    amount: signed(overrides.kind, overrides.amount),
  };
}

const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ── Balance ───────────────────────────────────────────────────────────────────────────

test("the balance is a fold over signed entries, not a stored total", () => {
  const account = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [
      entry({ kind: "charge", amount: cents(200) }),
      entry({ kind: "charge", amount: cents(50) }),
      entry({ kind: "payment", amount: cents(100) }),
      entry({ kind: "adjustment", amount: cents(25) }),
    ],
    NOW
  );

  assert.equal(account.charged, cents(250));
  assert.equal(account.paid, cents(100));
  assert.equal(account.forgiven, cents(25));
  assert.equal(account.balance, cents(125));
  assert.equal(account.entryCount, 4);
});

test("an overpayment reports a credit, and says so rather than showing a negative debt", () => {
  const account = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [entry({ kind: "charge", amount: cents(100) }), entry({ kind: "payment", amount: cents(150) })],
    NOW
  );

  assert.equal(account.balance, cents(-50));
  assert.match(account.recommendedAction, /credit of \$50\.00/);
  assert.match(account.recommendedAction, /refund/i);
});

test("an empty account is zeroes and nulls, never NaN", () => {
  const account = buildAccount("NOBODY", "Nobody", [], NOW);
  assert.equal(account.balance, 0);
  assert.equal(account.oldestChargeAt, null);
  assert.equal(account.daysOutstanding, null);
  assert.equal(account.priority, 0);
});

test("entries written out of order still fold correctly — a redelivery can arrive late", () => {
  const inOrder = [
    entry({ kind: "charge", amount: cents(100), occurredAt: daysAgo(60) }),
    entry({ kind: "payment", amount: cents(40), occurredAt: daysAgo(10) }),
  ];
  const shuffled = [inOrder[1]!, inOrder[0]!];

  assert.deepEqual(
    buildAccount("ABC12345", "Ada Alpha", shuffled, NOW),
    buildAccount("ABC12345", "Ada Alpha", inOrder, NOW)
  );
});

// ── Aging ─────────────────────────────────────────────────────────────────────────────

test("buckets are 0–30, 31–60, 61–90, 90+", () => {
  assert.equal(bucketFor(0), "current");
  assert.equal(bucketFor(30), "current");
  assert.equal(bucketFor(31), "d31_60");
  assert.equal(bucketFor(60), "d31_60");
  assert.equal(bucketFor(61), "d61_90");
  assert.equal(bucketFor(90), "d61_90");
  assert.equal(bucketFor(91), "d90_plus");
});

test("charges age into their own buckets", () => {
  const { aging } = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [
      entry({ kind: "charge", amount: cents(10), occurredAt: daysAgo(5) }),
      entry({ kind: "charge", amount: cents(20), occurredAt: daysAgo(45) }),
      entry({ kind: "charge", amount: cents(30), occurredAt: daysAgo(75) }),
      entry({ kind: "charge", amount: cents(40), occurredAt: daysAgo(120) }),
    ],
    NOW
  );

  assert.equal(aging.current, cents(10));
  assert.equal(aging.d31_60, cents(20));
  assert.equal(aging.d61_90, cents(30));
  assert.equal(aging.d90_plus, cents(40));
});

test("a payment settles the OLDEST charge first — the bug this test exists for", () => {
  // Charged $200 four months ago, $100 last week, then paid $200. The naive implementation ages each
  // charge by its own date and reports $200 at 90-plus days, so the practice phones a patient who
  // has already paid.
  const account = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [
      entry({ kind: "charge", amount: cents(200), occurredAt: daysAgo(120) }),
      entry({ kind: "charge", amount: cents(100), occurredAt: daysAgo(7) }),
      entry({ kind: "payment", amount: cents(200), occurredAt: daysAgo(1) }),
    ],
    NOW
  );

  assert.equal(account.balance, cents(100));
  assert.equal(account.aging.d90_plus, 0, "the old charge was paid and must not still be aged");
  assert.equal(account.aging.current, cents(100));
  assert.equal(account.daysOutstanding, 7, "the oldest UNPAID charge is a week old");
});

test("the aging always sums to the balance — the property that makes it printable", () => {
  const account = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [
      entry({ kind: "charge", amount: cents(150), occurredAt: daysAgo(100) }),
      entry({ kind: "charge", amount: cents(75), occurredAt: daysAgo(50) }),
      entry({ kind: "charge", amount: cents(40), occurredAt: daysAgo(3) }),
      entry({ kind: "payment", amount: cents(60), occurredAt: daysAgo(2) }),
      entry({ kind: "writeoff", amount: cents(30), occurredAt: daysAgo(1) }),
    ],
    NOW
  );

  const bucketed = account.aging.current + account.aging.d31_60 + account.aging.d61_90 + account.aging.d90_plus;
  assert.equal(bucketed, account.balance);
  assert.equal(account.balance, cents(175));
});

test("a partly-paid old charge keeps only its remainder in the old bucket", () => {
  const account = buildAccount(
    "ABC12345",
    "Ada Alpha",
    [
      entry({ kind: "charge", amount: cents(200), occurredAt: daysAgo(100) }),
      entry({ kind: "payment", amount: cents(120), occurredAt: daysAgo(1) }),
    ],
    NOW
  );
  assert.equal(account.aging.d90_plus, cents(80));
  assert.equal(account.daysOutstanding, 100);
});

// ── Priority ──────────────────────────────────────────────────────────────────────────

test("age outranks size — an old small balance beats a new large one", () => {
  const old = buildAccount(
    "A",
    "Old Small",
    [entry({ kind: "charge", amount: cents(60), occurredAt: daysAgo(120) })],
    NOW
  );
  const fresh = buildAccount(
    "B",
    "New Large",
    [entry({ kind: "charge", amount: cents(600), occurredAt: daysAgo(5) })],
    NOW
  );

  assert.ok(
    old.priority > fresh.priority,
    "a balance's chance of ever being collected falls off a cliff with age; size does not move like that"
  );
});

test("a balance inside the first statement cycle is not yet work", () => {
  const account = buildAccount(
    "A",
    "Recent",
    [entry({ kind: "charge", amount: cents(100), occurredAt: daysAgo(5) })],
    NOW
  );
  assert.equal(account.priority, 20, "visible, but ranked below anything with a real deadline");
  assert.match(account.recommendedAction, /Nothing to chase yet/);
});

test("a settled account has no priority at all", () => {
  const account = buildAccount(
    "A",
    "Settled",
    [
      entry({ kind: "charge", amount: cents(100), occurredAt: daysAgo(120) }),
      entry({ kind: "payment", amount: cents(100), occurredAt: daysAgo(1) }),
    ],
    NOW
  );
  assert.equal(account.priority, 0);
  assert.equal(account.recommendedAction, "Nothing outstanding.");
});

// ── Statement ─────────────────────────────────────────────────────────────────────────

test("the statement explains how the number was arrived at", () => {
  const { statementLines, entries } = buildStatement(
    "ABC12345",
    "Ada Alpha",
    [
      entry({
        kind: "charge",
        amount: cents(200),
        occurredAt: daysAgo(60),
        description: "Delta Dental processed the claim and left $200.00 as patient responsibility.",
      }),
      entry({ kind: "payment", amount: cents(50), occurredAt: daysAgo(10) }),
    ],
    NOW
  );

  assert.match(statementLines[0]!, /Ada Alpha owes \$150\.00/);
  assert.match(statementLines[1]!, /\$200\.00 charged, less \$50\.00 paid/);
  assert.ok(statementLines.some((l) => /Delta Dental processed the claim/.test(l)));
  assert.ok(statementLines.some((l) => /60 days old/.test(l)));
  // Read aloud to a patient: an embedded description must not leave a doubled stop.
  assert.ok(
    statementLines.every((l) => !l.includes("..")),
    `a statement line ended with a doubled period: ${JSON.stringify(statementLines)}`
  );

  assert.equal(entries[0]!.kind, "payment", "a statement reads newest first");
});

test("a settled account's statement says so instead of listing nothing", () => {
  const { statementLines } = buildStatement(
    "ABC12345",
    "Ada Alpha",
    [entry({ kind: "charge", amount: cents(100) }), entry({ kind: "payment", amount: cents(100) })],
    NOW
  );
  assert.match(statementLines[0]!, /settled/);
});

// ── Practice summary ──────────────────────────────────────────────────────────────────

test("the summary answers 'what do our patients owe us?'", () => {
  const accounts = [
    buildAccount("A", "A", [entry({ kind: "charge", amount: cents(100), occurredAt: daysAgo(120) })], NOW),
    buildAccount(
      "B",
      "B",
      [
        entry({ kind: "charge", amount: cents(300), occurredAt: daysAgo(10) }),
        entry({ kind: "payment", amount: cents(100), occurredAt: daysAgo(2) }),
      ],
      NOW
    ),
    buildAccount(
      "C",
      "C",
      [
        entry({ kind: "charge", amount: cents(50), occurredAt: daysAgo(200) }),
        entry({ kind: "payment", amount: cents(50), occurredAt: daysAgo(1) }),
      ],
      NOW
    ),
  ];
  const summary = buildSummary(accounts);

  assert.equal(summary.accountsWithBalance, 2, "the settled account is not an outstanding one");
  assert.equal(summary.totalOutstanding, cents(300));
  assert.equal(summary.aging.d90_plus, cents(100));
  assert.equal(summary.aging.current, cents(200));
  assert.equal(summary.overNinetyShare, 0.333);
  assert.equal(summary.totalCharged, cents(450));
  assert.equal(summary.totalPaid, cents(150));
  assert.equal(summary.collectionRate, 0.333);
});

test("an empty practice reports zeroes and a null rate", () => {
  const summary = buildSummary([]);
  assert.equal(summary.totalOutstanding, 0);
  assert.equal(summary.collectionRate, null);
  assert.equal(summary.overNinetyShare, null);
});
