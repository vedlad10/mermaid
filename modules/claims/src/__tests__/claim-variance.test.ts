/**
 * Estimate versus actual, made visible (F-7).
 *
 * ── WHY THIS WAS INVISIBLE ─────────────────────────────────────────────────────────────────────
 * The figure has been computed and stored on every posting since the variance engine existed, and no
 * screen read it. A practice could see a claim was paid and never learn the estimate it quoted the
 * patient from was wrong. Gina Demo was quoted against a $120.00 benefit, the payer paid $47.99, and
 * the only surface that mentioned the $72.01 was a database column.
 *
 * Every expected value below is derived from the scenario. The materiality band is
 * min($1.00, max(5c, expected x 0.25%)), so an $800.00 expectation tolerates $1.00.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { claimVariance } from "../view.ts";
import type { Claim, ClaimPayment } from "../types.ts";

const payment = (paid: number, over: Partial<ClaimPayment> = {}): ClaimPayment =>
  ({
    postingId: `p-${paid}`,
    remittanceId: "rem-1",
    postedAt: "2026-08-28T04:40:49.311Z",
    traceNumber: "EFT1",
    paidAmount: cents(paid),
    patientResponsibility: cents(0),
    contractualAdjustments: cents(142.5),
    variance: cents(0),
    outcome: "as_expected",
    settled: true,
    ...over,
  }) as ClaimPayment;

const claim = (expected: number, payments: ClaimPayment[], recoveries: { denialId: string; settled: number }[] = []): Claim =>
  ({
    id: "c-1",
    expectedInsurancePays: cents(expected),
    payments,
    appealRecoveries: recoveries.map((r) => ({
      denialId: r.denialId,
      settledAmount: cents(r.settled),
      awardedAmount: cents(r.settled),
      settledAt: "2026-08-30T00:00:00.000Z",
    })),
  }) as unknown as Claim;

test("an unpaid claim has no variance — unknown is not zero", () => {
  assert.equal(
    claimVariance(claim(800, [])),
    null,
    "reporting $0.00 would assert the estimate had been confirmed by a payer who has not answered"
  );
});

test("a payment inside the band reports the figure without raising it", () => {
  const v = claimVariance(claim(800, [payment(799.99)]))!;
  assert.equal(v.expected, cents(800));
  assert.equal(v.paid, cents(799.99));
  assert.equal(v.variance, cents(-0.01), "exact, as always");
  assert.equal(v.unexplained, cents(-0.01), "nothing explained it away");
  assert.equal(v.material, false, "a cent of rounding is not news");
  assert.equal(v.threshold, cents(1));
  assert.match(v.summary, /as expected/);
});

/**
 * Gina's case, which is the one that motivated this. Quoted against $120.00, paid $47.99.
 *   variance  47.99 − 120.00 = −72.01
 *   threshold min(1.00, max(0.05, 120.00 × 0.25% = 0.30)) = 0.30 ⇒ material
 */
test("a payer paying materially less than promised says so, and says who was quoted from it", () => {
  const v = claimVariance(claim(120, [payment(47.99)]))!;
  assert.equal(v.variance, cents(-72.01));
  assert.equal(v.material, true);
  assert.equal(v.threshold, cents(0.3));
  assert.match(v.summary, /\$72\.01 LESS/);
  assert.match(v.summary, /the patient was quoted/, "the practice has to know who was told what");
});

test("a payer paying materially more says so too, and names the risk", () => {
  const v = claimVariance(claim(800, [payment(900)]))!;
  assert.equal(v.variance, cents(100));
  assert.equal(v.material, true);
  assert.match(v.summary, /\$100\.00 MORE/);
  assert.match(v.summary, /takeback/, "an overpayment is money the practice does not get to keep");
});

// ── Money won on appeal is explained, and must not read as a surprise ─────────────────────────

/**
 * The staging claim that forced this. Estimated $175.00; a $1,250.00 crown the estimate carried at
 * zero coverage was denied, appealed, and won; the payer then sent $1,125.00 on a corrected advice.
 *
 * Judged gross that is a $971.49 overpayment, and the screen told the biller to check for a
 * duplicate or a takeback — about money the practice itself fought for and won. Judged net, the real
 * signal appears and it points the other way.
 */
test("cash won on appeal is not an overpayment, and stops hiding the estimate error underneath it", () => {
  const v = claimVariance(
    claim(175, [payment(21.49), payment(1125, { postingId: "p-2" })], [{ denialId: "d-1", settled: 1125 }])
  )!;

  assert.equal(v.paid, cents(1146.49));
  assert.equal(v.variance, cents(971.49), "the gross figure is still reported, unchanged");
  assert.equal(v.appealRecovered, cents(1125));
  assert.equal(v.unexplained, cents(-153.51), "21.49 against a 175.00 estimate — the primary came in UNDER");
  assert.equal(v.material, true, "and that shortfall is worth knowing about");
  assert.match(v.summary, /\$153\.51 LESS/, "not $971.49 MORE");
  assert.doesNotMatch(v.summary, /duplicate/, "never accuse a won appeal of being a duplicate");
  assert.match(v.summary, /recovered on appeal/, "but say plainly where the money came from");
});

test("a recovery that exactly explains the variance leaves nothing to flag", () => {
  const v = claimVariance(claim(175, [payment(175), payment(500, { postingId: "p-2" })], [{ denialId: "d-1", settled: 500 }]))!;
  assert.equal(v.variance, cents(500));
  assert.equal(v.unexplained, cents(0));
  assert.equal(v.material, false, "every cent of it is accounted for");
  assert.match(v.summary, /recovered on appeal/);
});

test("recoveries across several denials on one claim all count", () => {
  const v = claimVariance(
    claim(100, [payment(100), payment(300, { postingId: "p-2" })], [
      { denialId: "d-1", settled: 200 },
      { denialId: "d-2", settled: 100 },
    ])
  )!;
  assert.equal(v.appealRecovered, cents(300));
  assert.equal(v.unexplained, cents(0));
});

test("a claim that never had an appeal is unaffected", () => {
  const v = claimVariance(claim(800, [payment(900)]))!;
  assert.equal(v.appealRecovered, cents(0));
  assert.equal(v.unexplained, v.variance, "the overwhelming majority of claims — nothing to net out");
  assert.match(v.summary, /takeback/, "and a genuine overpayment still says so");
});

test("a claim persisted before appeal recoveries existed reads as having recovered nothing", () => {
  /** No `appealRecoveries` key at all — every claim written before this field did. */
  const legacy = { id: "c-1", expectedInsurancePays: cents(800), payments: [payment(799.99)] } as unknown as Claim;
  const v = claimVariance(legacy)!;
  assert.equal(v.appealRecovered, cents(0), "absent must read as zero, not throw");
  assert.equal(v.unexplained, cents(-0.01));
});

test("the variance is measured across every posting, not just the last", () => {
  /** A corrected remittance settling an appeal adds to what the payer has paid on the claim. */
  const v = claimVariance(claim(175, [payment(21.49), payment(1125, { postingId: "p-2" })]))!;
  assert.equal(v.paid, cents(1146.49), "21.49 + 1125.00");
  assert.equal(v.variance, cents(971.49), "1146.49 − 175.00");
});

test("the band scales, so the same cents mean different things on different claims", () => {
  const big = claimVariance(claim(800, [payment(799.5)]))!;
  const small = claimVariance(claim(20, [payment(19.5)]))!;
  assert.equal(big.variance, small.variance, "both are 50 cents short");
  assert.equal(big.material, false, "50c on $800.00 is rounding");
  assert.equal(small.material, true, "50c on $20.00 is 2.5% of the claim");
});
