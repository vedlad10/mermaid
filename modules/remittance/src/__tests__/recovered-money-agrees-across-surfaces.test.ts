/**
 * Money and Recover must answer the same question with the same number.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────────────────────────
 * F-5 taught `buildRecoveryQueue` to subtract `resolvedRecoverable` and stopped there. Every other
 * reader of the same fact — `buildRemittanceView.totalRecoverable`, which drives the Money header,
 * the per-row "$X owed" badge, the Today board's at-stake total and the recommended-action
 * sentence — kept summing the payer's raw figure.
 *
 * In live staging that produced a single screen that contradicted itself: the Money header read
 * "2 held · $2,250.00 still owed to the practice" directly above a Recovery queue panel reading
 * "RECOVERABLE $0.00 — Nothing outstanding." Both figures were computed from the same two postings,
 * whose denials were `recovered` in full. A biller reading the top of the screen would have chased
 * $2,250.00 that was already in the bank.
 *
 * ── WHY IT IS WRITTEN AS AN AGREEMENT AND NOT AS TWO EXPECTED VALUES ───────────────────────────
 * Asserting "Money says $0" would have passed the moment someone hard-coded a zero. The property
 * that actually matters is that the two surfaces cannot disagree, so the assertion compares them to
 * each other. That is the invariant the defect broke, and it holds for any fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildRecoveryQueue, buildRemittanceView } from "../view.ts";
import type { Posting, Remittance } from "../types.ts";

const POSTING: Posting = {
  id: "posting-1",
  claimId: "claim-1",
  patientName: "Pia Phase32",
  patientControlNumber: "MRM-000123",
  payerControlNumber: "998877",
  chargedAmount: cents(1250),
  paidAmount: cents(0),
  patientResponsibility: cents(0),
  disposition: "denied",
  variance: {
    expectedInsurancePays: cents(1125),
    paidAmount: cents(0),
    contractualAmount: cents(0),
    patientResponsibility: cents(0),
    recoverableAmount: cents(1125),
    unexplainedAmount: cents(0),
    varianceAmount: cents(1125),
    outcome: "recoverable",
    actionable: true,
    material: true,
    threshold: cents(100),
    reasons: [],
    explanation: "Denied for a reason worth appealing.",
  },
  adjustments: [],
  remarks: [],
  postedAt: "2026-08-28T04:40:14.843Z",
} as unknown as Posting;

const remittanceWith = (resolved: number | undefined): Remittance =>
  ({
    id: "rem-1",
    payerName: "MetLife Dental",
    status: "posted",
    balanced: true,
    paymentTotal: cents(21.49),
    receivedAt: "2026-08-28T04:40:14.843Z",
    paymentDate: "2026-08-28",
    postings: [resolved === undefined ? POSTING : { ...POSTING, resolvedRecoverable: cents(resolved) }],
    audit: [],
  }) as unknown as Remittance;

test("a fully recovered denial is $0 outstanding on BOTH surfaces", () => {
  const remittance = remittanceWith(1125);

  const money = buildRemittanceView(remittance).totalRecoverable;
  const recover = buildRecoveryQueue([remittance]).reduce(
    (t, i) => t + i.recoverableAmount + i.unexplainedAmount,
    0
  );

  assert.equal(recover, 0, "the Recover queue already knew this money came back");
  assert.equal(
    money,
    recover,
    `Money reported ${money} while Recover reported ${recover} for the same posting — ` +
      `this is the contradiction a biller saw on one screen`
  );
});

test("the two surfaces agree at every stage of a partial recovery", () => {
  /**
   * The agreement must hold while money is still coming back, not only at the endpoints — a fix
   * that special-cased "fully resolved" would pass the test above and still misreport every
   * partially recovered denial.
   */
  for (const resolved of [undefined, 0, 300, 1124, 1125]) {
    const remittance = remittanceWith(resolved);
    const money = buildRemittanceView(remittance).totalRecoverable;
    const recover = buildRecoveryQueue([remittance]).reduce(
      (t, i) => t + i.recoverableAmount + i.unexplainedAmount,
      0
    );
    assert.equal(money, recover, `resolved=${resolved}: Money ${money} vs Recover ${recover}`);
  }
});

test("what is still outstanding is the payer's figure minus what came back", () => {
  /** The arithmetic itself, stated independently rather than by comparing the two builders. */
  assert.equal(buildRemittanceView(remittanceWith(300)).totalRecoverable, cents(825));
  assert.equal(buildRemittanceView(remittanceWith(undefined)).totalRecoverable, cents(1125));
});

test("the payer's own figure is never rewritten by a recovery", () => {
  /**
   * The whole design depends on this: `resolvedRecoverable` is a second fact, not a correction. If
   * a recovery edited `variance.recoverableAmount`, the evidence a human needs to understand the
   * recovery months later would be gone.
   */
  const remittance = remittanceWith(1125);
  const posting = buildRemittanceView(remittance).remittance.postings[0]!;
  assert.equal(posting.variance!.recoverableAmount, cents(1125), "the advice still says what it said");
  assert.equal(posting.resolvedRecoverable, cents(1125));
});

test("a recovered posting stops being counted as work to do", () => {
  /**
   * `actionable` is the payer's flag, frozen at ingest and still true after the money returns. It
   * drove `actionableCount` on the Money list, so a fully recovered advice advertised work that no
   * longer existed.
   */
  assert.equal(buildRemittanceView(remittanceWith(1125)).actionable.length, 0);
  assert.equal(buildRemittanceView(remittanceWith(300)).actionable.length, 1, "partially recovered is still work");
});

test("money nobody explained is not resolved by a recovery", () => {
  /**
   * `resolvedRecoverable` is defined against the recoverable figure alone. Unexplained money is a
   * different problem — nothing was ever accounted for — and netting a recovery against it would
   * quietly retire a reconciliation gap that no one had looked at.
   */
  const base = remittanceWith(1125);
  const withUnexplained = {
    ...base,
    postings: [
      {
        ...base.postings[0]!,
        variance: { ...base.postings[0]!.variance!, unexplainedAmount: cents(50) },
      },
    ],
  } as Remittance;

  assert.equal(buildRemittanceView(withUnexplained).totalRecoverable, cents(50));
  assert.equal(
    buildRecoveryQueue([withUnexplained]).reduce((t, i) => t + i.recoverableAmount + i.unexplainedAmount, 0),
    cents(50),
    "and both surfaces still agree about it"
  );
});
