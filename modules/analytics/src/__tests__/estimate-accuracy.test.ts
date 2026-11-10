/**
 * Estimate accuracy at practice scale (F-7), and the population trap it has to avoid.
 *
 * ── THE TRAP ───────────────────────────────────────────────────────────────────────────────────
 * The obvious formula is `collected − expected` off the money summary. It is wrong: `expected` is
 * summed over claims SUBMITTED in the period and `collected` over payments POSTED in it, and payers
 * take weeks. So a practice whose estimates are exactly right, but which filed more this month than
 * it was paid for, would be told its estimates are running short by the difference. It would go
 * hunting for a fee-schedule fault it does not have.
 *
 * These tests pin the matched-population form: every claim PAID in the period, against its own
 * estimate, whenever it happened to be filed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildMoney } from "../engine/report.ts";
import type { Fact } from "../types.ts";

const fact = (over: Partial<Fact> & { factType: Fact["factType"] }): Fact =>
  ({
    sourceEventId: `e-${Math.random()}`,
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

test("a payer paying exactly the estimate reports no variance", () => {
  const m = buildMoney([submitted("c1", 800), paid("c1", 800, 800)]);
  assert.equal(m.estimateVariance, cents(0));
  assert.equal(m.estimateAccuracy, 0);
});

test("a payer paying less than estimated reports a signed shortfall", () => {
  const m = buildMoney([submitted("c1", 120), paid("c1", 47.99, 120)]);
  assert.equal(m.estimateVariance, cents(-72.01), "Gina's claim, at practice scale");
  assert.equal(m.estimateAccuracy, -0.6, "−72.01 / 120.00, to three places");
});

/**
 * The defect this metric was rewritten to avoid. Six claims filed this period, one paid — and the
 * one paid was estimated perfectly. The honest answer is "no variance".
 */
test("filing more than gets paid is not an estimate error", () => {
  const facts = [
    ...Array.from({ length: 6 }, (_, i) => submitted(`new-${i}`, 800)),
    paid("old-1", 500, 500),
  ];
  const m = buildMoney(facts);

  assert.equal(m.estimateVariance, cents(0), "the one claim a payer answered was estimated exactly");
  assert.equal(m.estimateAccuracy, 0);
  assert.notEqual(
    m.estimateVariance,
    cents(-4300),
    "collected − expected would report a $4,300 shortfall on a practice whose estimates are perfect"
  );
});

/** And the mirror: a claim paid from a prior period still counts, because its payer has answered. */
test("a claim filed before the period still counts once it is paid in it", () => {
  const m = buildMoney([paid("old-1", 700, 800)]);
  assert.equal(m.estimateVariance, cents(-100), "no claim_submitted fact in the period at all");
});

/**
 * Coordination of benefits. One claim, two payers, one estimate. The paid amounts add; the
 * expectation does not.
 */
test("a claim paid by two payers is measured against ONE estimate", () => {
  const m = buildMoney([paid("c1", 600, 800), paid("c1", 200, 800)]);
  assert.equal(m.estimateVariance, cents(0), "$600 + $200 against a single $800 estimate");
  assert.notEqual(
    m.estimateVariance,
    cents(-800),
    "double-counting the expectation invents a whole-claim shortfall on exactly the COB cases nobody checks by hand"
  );
});

test("distinct claims each carry their own estimate", () => {
  const m = buildMoney([paid("c1", 600, 800), paid("c2", 200, 800)]);
  assert.equal(m.estimateVariance, cents(-800), "two claims, two estimates, $1,600 expected");
});

test("a period with no payments has no accuracy to report", () => {
  const m = buildMoney([submitted("c1", 800)]);
  assert.equal(m.estimateVariance, cents(0));
  assert.equal(m.estimateAccuracy, null, "not 0 — nobody has been paid, so nothing has been tested");
});

test("an overpayment reports positive, and does not cancel a shortfall it has nothing to do with", () => {
  const m = buildMoney([paid("c1", 900, 800), paid("c2", 700, 800)]);
  assert.equal(m.estimateVariance, cents(0), "net across the practice is what the metric means");
  const over = buildMoney([paid("c1", 900, 800)]);
  assert.equal(over.estimateVariance, cents(100));
  assert.equal(over.estimateAccuracy, 0.125);
});

// ── Appeal money is explained at practice scale too ───────────────────────────────────────────

const won = (claimId: string, recovered: number, denied: number) =>
  fact({ factType: "appeal_outcome", claimId, amount: cents(recovered), expected: cents(denied), won: true });

/**
 * The same defect the claim screen had, one level up. On staging this metric read +32% — "your
 * payers pay you a third more than you quote them" — on a practice whose payers had in fact paid
 * $300.11 LESS than estimated, with two appeals won for $2,250.00. Not a small distortion: the
 * opposite sign.
 */
test("appeals won are not payers being generous", () => {
  const facts = [
    submitted("c1", 175),
    paid("c1", 21.49, 175),
    paid("c1", 1125, 175),
    won("c1", 1125, 1250),
  ];
  const m = buildMoney(facts);

  assert.equal(m.estimateVariance, cents(-153.51), "21.49 against a 175.00 estimate, once the appeal is set aside");
  assert.equal(m.estimateAccuracy, -0.877);
  assert.notEqual(m.estimateVariance, cents(971.49), "gross would claim the payer overpaid by $971.49");
});

/**
 * A lost appeal recovers nothing, and the READING of that is pinned here rather than delegated to
 * the producer. Denials publishes `recovered = won ? amount : 0` today, so an amount on a lost
 * outcome does not currently occur — which is exactly why this must be asserted: analytics sits
 * across a context boundary behind an at-least-once bus, and a change on the far side that started
 * stating what was at stake on a lost appeal would otherwise silently subtract it as if it were
 * cash, turning a real shortfall into a clean bill of health.
 */
test("a LOST appeal nets out nothing, whatever amount its fact carries", () => {
  const lost = fact({ factType: "appeal_outcome", claimId: "c1", amount: cents(500), expected: cents(500), won: false });
  const m = buildMoney([paid("c1", 700, 800), lost]);
  assert.equal(m.estimateVariance, cents(-100), "the $100.00 shortfall stands on its own");
  assert.notEqual(m.estimateVariance, cents(-600), "an appeal that recovered nothing explains nothing");
});

test("a zero-amount lost appeal is equally inert", () => {
  const lost = fact({ factType: "appeal_outcome", claimId: "c1", amount: cents(0), expected: cents(500), won: false });
  assert.equal(buildMoney([paid("c1", 700, 800), lost]).estimateVariance, cents(-100));
});

/**
 * The population rule, applied to recoveries as well as expectations. A recovery on a claim no
 * payment landed on this period must not be subtracted, because its cash is not in `paid` either —
 * subtracting it would manufacture a shortfall out of an appeal the practice won.
 */
test("a recovery on a claim not paid in this period is not subtracted", () => {
  const m = buildMoney([paid("c1", 800, 800), won("other-claim", 1125, 1250)]);
  assert.equal(m.estimateVariance, cents(0), "c1 was paid exactly as estimated");
  assert.notEqual(m.estimateVariance, cents(-1125), "netting unmatched recovery would invent a shortfall");
});

/**
 * The invariant that makes the dashboard and the claim screen tell one story: the practice figure is
 * the sum of the per-claim figures. Verified against live staging data too, where both came to
 * −$300.11 independently.
 */
test("the practice figure is the sum of the per-claim figures", () => {
  const facts = [
    paid("c1", 47.99, 120),                                  // −72.01
    paid("c2", 157.5, 175),                                  // −17.50
    paid("c3", 21.49, 175), paid("c3", 1125, 175), won("c3", 1125, 1250), // −153.51
    paid("c4", 7.98, 65), paid("c4", 1125, 65), won("c4", 1125, 1250),    // −57.02
  ];
  const perClaim = [-72.01, -17.5, -153.51, -57.02].reduce((t, v) => t + Math.round(v * 100), 0);
  assert.equal(buildMoney(facts).estimateVariance, perClaim);
  assert.equal(perClaim, cents(-300.04));
});
