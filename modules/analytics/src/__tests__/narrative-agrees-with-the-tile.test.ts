/**
 * The sentence and the number beside it answer the same question the same way.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Live staging rendered both of these on the Insights screen, from one payload:
 *
 *   narrative  "Collecting 125% of what the estimates promised — payers are paying $1,949.87 MORE
 *               than quoted."
 *   tile       "Estimates vs actual · excluding appeal wins · 3.9% under"
 *               (title: "Payers paid $300.13 LESS than estimated … net of anything won on appeal.")
 *
 * More and less. The same question, opposite answers, a foot apart on a money screen.
 *
 * The cause was that the narrative computed `collected − expected` itself, while the tile reads
 * `estimateVariance`, which subtracts appeal recoveries. On this data $2,250.00 of the collected
 * cash was won on appeal, and `estimateAccuracyOf` documents exactly why leaving it in is not an
 * approximation: "not a small distortion of the signal, it is the opposite sign."
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 * The cash ratio may stay the headline — that is what `collectionRate` means. But any claim about
 * whether payers paid MORE or LESS than quoted must agree in sign with `estimateVariance`, because
 * that is the figure the screen shows next to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildMoney, buildInsights } from "../engine/report.ts";
import type { Fact, Funnel } from "../types.ts";

let seq = 0;
const fact = (over: Partial<Fact> & { factType: Fact["factType"] }): Fact =>
  ({
    sourceEventId: `e-${++seq}`,
    occurredAt: "2026-08-15T00:00:00.000Z",
    payerId: "delta-dental",
    payerName: "Delta Dental",
    procedureCode: null,
    carcCode: null,
    verificationId: null,
    claimId: null,
    denialId: null,
    amount: cents(0),
    expected: cents(0),
    won: null,
    meta: null,
    ...over,
  }) as Fact;

const submitted = (claimId: string, expected: number) =>
  fact({ factType: "claim_submitted", claimId, amount: cents(expected * 2), expected: cents(expected) });
const paid = (claimId: string, amount: number, expected: number) =>
  fact({ factType: "payment_posted", claimId, amount: cents(amount), expected: cents(expected) });
const won = (claimId: string, recovered: number, denied: number) =>
  fact({ factType: "appeal_outcome", claimId, amount: cents(recovered), expected: cents(denied), won: true });

/** Enough of a funnel that `buildInsights` does not short-circuit to "no activity". */
const FUNNEL: Funnel = {
  verificationsCompleted: 10,
  verificationsFlagged: 1,
  claimsSubmitted: 8,
  claimsPaid: 8,
  billingRate: 0.8,
  reviewRate: 0.1,
};

const estimateLine = (facts: Fact[]) => {
  const money = buildMoney(facts);
  const line = buildInsights(FUNNEL, money, [], []).find((s) => s.includes("estimates promised"));
  assert.ok(line, "the estimate sentence must still be written");
  return { money, line };
};

test("an overshoot made entirely of appeal wins is not reported as payers being generous", () => {
  /**
   * Staging's shape, reduced: expected $7,660.00, collected $9,609.87, of which $2,250.00 came back
   * on appeal. The cash ratio is 125%; the netted truth is that payers paid $300.13 LESS.
   */
  const facts = [
    submitted("c1", 7660),
    paid("c1", 7359.87, 7660),
    paid("c1-appeal", 2250, 0),
    won("c1-appeal", 2250, 2250),
  ];
  const { money, line } = estimateLine(facts);

  assert.ok(money.collectionRate !== null && money.collectionRate > 1.1, "the cash ratio must overshoot");
  assert.ok(money.estimateVariance < 0, "and the netted variance must point the other way");

  assert.ok(
    !/MORE than quoted/.test(line),
    `the tile says payers paid LESS; the sentence must not say MORE:\n  ${line}`
  );
  assert.match(line, /LESS than quoted/, "it should say what the tile says");
  assert.match(line, /appeal/i, "and name the appeal money that explains the overshoot");
});

test("a genuine overshoot is still called out", () => {
  /* No appeals anywhere: 125% really is payers paying more than the practice quoted. */
  const facts = [submitted("c1", 1000), paid("c1", 1250, 1000)];
  const { money, line } = estimateLine(facts);

  assert.ok(money.estimateVariance > 0, "nothing to net out, so the surplus is real");
  assert.match(line, /MORE than quoted/, `a real surplus must still be reported:\n  ${line}`);
  assert.match(line, /over-quoted/, "including why it matters — patients are being quoted too much");
});

test("the sentence never contradicts the sign of the figure beside it", () => {
  /**
   * The general rule, over every shape that reaches this branch. `estimateVariance` is what the tile
   * renders; a sentence that says MORE while the tile says LESS is the defect, in either direction.
   */
  const shapes: Array<[string, Fact[]]> = [
    ["exactly on estimate", [submitted("c1", 1000), paid("c1", 1000, 1000)]],
    ["payers short", [submitted("c1", 1000), paid("c1", 700, 1000)]],
    ["payers short, badly", [submitted("c1", 1000), paid("c1", 300, 1000)]],
    ["payers generous", [submitted("c1", 1000), paid("c1", 1400, 1000)]],
    ["overshoot from appeals", [submitted("c1", 1000), paid("c1", 900, 1000), paid("c2", 400, 0), won("c2", 400, 400)]],
    ["appeals and a real surplus", [submitted("c1", 1000), paid("c1", 1300, 1000), paid("c2", 200, 0), won("c2", 200, 200)]],
  ];

  for (const [name, facts] of shapes) {
    const { money, line } = estimateLine(facts);
    if (/MORE than quoted/.test(line)) {
      assert.ok(money.estimateVariance > 0, `"${name}" says MORE while the tile shows ${money.estimateVariance}:\n  ${line}`);
    }
    if (/LESS than quoted/.test(line)) {
      assert.ok(money.estimateVariance < 0, `"${name}" says LESS while the tile shows ${money.estimateVariance}:\n  ${line}`);
    }
    if (/the front half and the billing half agree/.test(line)) {
      assert.ok(
        money.estimateAccuracy === null || Math.abs(money.estimateAccuracy) <= 0.1,
        `"${name}" claims agreement while the tile shows ${money.estimateAccuracy}:\n  ${line}`
      );
    }
  }
});
