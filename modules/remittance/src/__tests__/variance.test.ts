/**
 * Variance-engine tests.
 *
 * The assertions that matter are the ones separating the three kinds of shortfall. A clinic that
 * chases contractual write-offs wastes staff time; a clinic that writes off recoverable denials
 * loses revenue; a clinic that never notices an unexplained shortfall loses revenue *silently*.
 * Getting this split right is the product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { computeVariance, variancePriority } from "../engine/variance.ts";
import type { PaidClaim } from "../engine/variance.ts";
import type { VarianceReason } from "../types.ts";

/**
 * `computeVariance` returns null for an UNKNOWN expectation, which is a state none of these tests
 * describe — every one of them states a figure. Asserted rather than silenced with `!`, so a
 * function that started refusing everything would fail here instead of passing quietly.
 */
const variance = (
  paid: Parameters<typeof computeVariance>[0],
  expected: Parameters<typeof computeVariance>[1]
): NonNullable<ReturnType<typeof computeVariance>> => {
  const v = computeVariance(paid, expected);
  assert.ok(v, "a stated expectation must produce a variance");
  return v;
};


const adjustment = (
  group: string,
  code: string,
  category: VarianceReason["category"],
  dollars: number,
  procedureCode: string | null = null
): VarianceReason => ({
  group,
  code,
  description: `${group}-${code}`,
  category,
  amount: cents(dollars),
  procedureCode,
});

/** Charged $1425; the payer allowed $1300 after a $125 contractual cut. */
function paid(overrides: Partial<PaidClaim> = {}): PaidClaim {
  return {
    chargedAmount: cents(1425),
    paidAmount: cents(800),
    patientResponsibility: cents(500),
    adjustments: [
      adjustment("CO", "45", "contractual", 125, "D2750"),
      adjustment("PR", "2", "patient", 500, "D2750"),
    ],
    ...overrides,
  };
}

test("a payment matching the estimate is as_expected and needs no attention", () => {
  const v = variance(paid(), cents(800));

  assert.equal(v.outcome, "as_expected");
  assert.equal(v.variance, 0);
  assert.equal(v.actionable, false);
  assert.equal(v.recoverableAmount, 0);
  assert.equal(v.unexplainedAmount, 0);
  assert.match(v.explanation[0]!, /exactly what the estimate promised/);
});

test("the shortfall is split three ways: contractual, patient, recoverable", () => {
  const v = variance(
    paid({
      paidAmount: cents(500),
      adjustments: [
        adjustment("CO", "45", "contractual", 125, "D2750"),
        adjustment("PR", "2", "patient", 500, "D2750"),
        adjustment("CO", "197", "recoverable", 300, "D2750"),
      ],
    }),
    cents(800)
  );

  assert.equal(v.outcome, "underpaid");
  assert.equal(v.variance, cents(-300));
  assert.equal(v.contractualAdjustments, cents(125));
  assert.equal(v.patientResponsibility, cents(500));
  assert.equal(v.recoverableAmount, cents(300));
  assert.equal(v.unexplainedAmount, 0);
  assert.equal(v.actionable, true);
});

test("a purely contractual shortfall is NOT actionable — that is the cost of being in network", () => {
  const v = variance(
    paid({
      paidAmount: cents(700),
      adjustments: [
        adjustment("CO", "45", "contractual", 225, "D2750"),
        adjustment("PR", "2", "patient", 500, "D2750"),
      ],
    }),
    cents(800)
  );

  assert.equal(v.outcome, "underpaid");
  assert.equal(v.variance, cents(-100));
  assert.equal(v.actionable, false, "nothing to chase");
  assert.equal(v.recoverableAmount, 0);
  assert.ok(v.explanation.some((e) => /nothing to pursue with the payer/.test(e)));
});

test("a patient balance is never treated as a payer shortfall to chase", () => {
  const v = variance(
    paid({
      paidAmount: cents(300),
      adjustments: [
        adjustment("CO", "45", "contractual", 125, "D2750"),
        adjustment("CO", "119", "patient", 1000, "D2750"),
      ],
    }),
    cents(800)
  );

  assert.equal(v.patientResponsibility, cents(1000));
  assert.equal(v.recoverableAmount, 0);
  assert.equal(v.actionable, false);
  assert.ok(v.explanation.some((e) => /bill the patient, not the payer/.test(e)));
});

test("money withheld with NO reason code is caught by arithmetic and flagged loudly", () => {
  // $1425 charged, $800 paid, only $125 explained — $500 has simply vanished.
  const v = variance(
    paid({ paidAmount: cents(800), adjustments: [adjustment("CO", "45", "contractual", 125, "D2750")] }),
    cents(800)
  );

  assert.equal(v.unexplainedAmount, cents(500));
  assert.equal(v.actionable, true, "unexplained money is always worth a human's time");
  assert.ok(v.explanation.some((e) => /unaccounted for/.test(e) && /Query the payer directly/.test(e)));
});

test("a full denial is classified as denied, not merely underpaid", () => {
  const v = variance(
    paid({
      paidAmount: cents(0),
      patientResponsibility: cents(0),
      adjustments: [adjustment("CO", "27", "patient", 1425)],
    }),
    cents(800)
  );

  assert.equal(v.outcome, "denied");
  assert.equal(v.variance, cents(-800));
  assert.match(v.explanation[0]!, /paid nothing against \$1,425\.00/);
});

test("an overpayment is flagged as one, with a takeback warning", () => {
  const v = variance(
    paid({ paidAmount: cents(900), adjustments: [adjustment("CO", "45", "contractual", 125, "D2750"), adjustment("PR", "2", "patient", 400, "D2750")] }),
    cents(800)
  );

  assert.equal(v.outcome, "overpaid");
  assert.equal(v.variance, cents(100));
  assert.match(v.explanation[0]!, /MORE than expected.*taken back/);
});

test("recoverable reasons are listed largest first, for triage", () => {
  const v = variance(
    paid({
      paidAmount: cents(100),
      adjustments: [
        adjustment("CO", "16", "recoverable", 200, "D0120"),
        adjustment("CO", "197", "recoverable", 900, "D2750"),
        adjustment("CO", "45", "contractual", 125, "D2750"),
        adjustment("PR", "2", "patient", 100),
      ],
    }),
    cents(800)
  );

  assert.deepEqual(v.reasons.map((r) => r.code), ["197", "16"]);
  assert.equal(v.recoverableAmount, cents(1100));
  assert.ok(v.explanation.some((e) => /CO-197/.test(e) && /D2750/.test(e)));
});

test("zero-amount adjustments are not reported as reasons", () => {
  const v = variance(
    paid({
      paidAmount: cents(1300),
      adjustments: [adjustment("CO", "45", "contractual", 125, "D2750"), adjustment("CO", "16", "recoverable", 0)],
    }),
    cents(800)
  );
  assert.deepEqual(v.reasons, []);
});

test("the engine is pure — identical input yields identical output", () => {
  const input = paid();
  assert.deepEqual(variance(input, cents(800)), variance(input, cents(800)));
});

test("priority ranks by what is actually retrievable, not by the raw gap", () => {
  const contractualOnly = variance(
    paid({ paidAmount: cents(700), adjustments: [adjustment("CO", "45", "contractual", 225, "D2750"), adjustment("PR", "2", "patient", 500)] }),
    cents(800)
  );
  const smallUnexplained = variance(
    paid({ paidAmount: cents(1400), adjustments: [adjustment("CO", "45", "contractual", 10)] }),
    cents(1400)
  );
  const bigDenial = variance(
    paid({ paidAmount: cents(0), patientResponsibility: cents(0), adjustments: [adjustment("CO", "197", "recoverable", 1425, "D2750")] }),
    cents(800)
  );

  assert.equal(variancePriority(contractualOnly), 5, "a contractual write-off is not work");
  assert.ok(variancePriority(smallUnexplained) > variancePriority(contractualOnly));
  assert.ok(variancePriority(bigDenial) > variancePriority(smallUnexplained));
  assert.ok(variancePriority(bigDenial) <= 100);
});

test("every explanation is plain English a human can act on without training", () => {
  const v = variance(
    paid({
      paidAmount: cents(500),
      adjustments: [
        adjustment("CO", "45", "contractual", 125, "D2750"),
        adjustment("PR", "2", "patient", 500, "D2750"),
        adjustment("CO", "197", "recoverable", 300, "D2750"),
      ],
    }),
    cents(800)
  );

  assert.ok(v.explanation.length >= 4);
  for (const line of v.explanation) {
    assert.ok(line.trim().length > 0);
    assert.ok(/[.!]$/.test(line.trim()), `explanation should read as a sentence: "${line}"`);
  }
});

// ── M8 — COORDINATION OF BENEFITS: MONEY THAT BELONGS TO NOBODY YET ───────────────────────────
//
// The `OA` group — CARC 23, "the impact of prior payer(s) adjudication" — is how a payer says an
// amount is another plan's question. It used to be categorised `informational`, which counted toward
// `accountedFor` (so the arithmetic balanced and no `unexplained` was raised) and then appeared in
// NONE of the reported money fields and no queue. It reconciled perfectly and vanished.
//
// Meanwhile the primary's `PR` balance on the same advice went straight to the patient — money a
// secondary payer may owe. That is a refund when discovered and a balance-billing exposure.

/** A primary payer's advice: it pays its share, writes off its cut, and hands the rest to the other plan. */
function coordinated(overrides: Partial<PaidClaim> = {}): PaidClaim {
  return {
    chargedAmount: cents(1000),
    paidAmount: cents(600),
    patientResponsibility: cents(0),
    adjustments: [
      adjustment("CO", "45", "contractual", 100, "D2750"),
      adjustment("OA", "23", "coordination", 300, "D2750"),
    ],
    ...overrides,
  };
}

test("M8: coordination money is reported as its own figure, not swept into another category", () => {
  const v = variance(coordinated(), cents(600));

  assert.equal(v.coordinationAmount, cents(300), "the amount must be nameable, not merely balanced");
  assert.equal(v.patientResponsibility, cents(0), "it is NOT the patient's");
  assert.equal(v.contractualAdjustments, cents(100), "and it is not a write-off — that is the CO-45");
  assert.equal(v.recoverableAmount, cents(0), "nor is it this payer's to be chased for");
});

test("M8: coordination money still reconciles — it must not become phantom 'unexplained'", () => {
  /**
   * The reconciliation invariant. `OA` counted toward `accountedFor` when it was `informational`,
   * and it must keep doing so: if splitting it out dropped it from the sum, every COB claim would
   * report a large `unexplained` shortfall that does not exist and flood the recovery queue with
   * money nobody withheld.
   */
  const v = variance(coordinated(), cents(600));

  assert.equal(v.unexplainedAmount, cents(0), "nothing vanished and nothing was invented");
  assert.equal(
    v.actualPaid + v.contractualAdjustments + v.patientResponsibility + v.recoverableAmount +
      v.coordinationAmount + v.unexplainedAmount,
    v.chargedAmount,
    "every dollar charged is accounted for by exactly one category"
  );
});

test("M8: a coordinated claim is NOT adjudicated as settled, however benign the numbers look", () => {
  /**
   * `adjudicate` reaching any of `paid_correctly`, `contractual`, `patient_responsibility` or
   * `overpaid` is a statement that the claim is finished — and `settled` on `remittance.posted` is
   * derived from it, which closes the claim in the Claims module and retires it from every queue
   * while a secondary claim still needs filing.
   */
  const v = variance(coordinated(), cents(600));

  assert.equal(v.adjudication, "coordination_pending");
  assert.notEqual(v.adjudication, "paid_correctly");
  assert.notEqual(v.adjudication, "patient_responsibility");
  assert.notEqual(v.adjudication, "contractual");
  assert.equal(v.actionable, true, "somebody must file the secondary claim, or that revenue is lost");
});

test("M8: a PR balance alongside coordination is NOT presented as 'bill the patient'", () => {
  /**
   * The most dangerous shape on this list. A primary's advice carrying both a patient balance and an
   * OA amount is describing a claim where another plan is in play — and the old explanation said
   * flatly "bill the patient, not the payer".
   */
  const v = variance(
    coordinated({
      chargedAmount: cents(1000),
      paidAmount: cents(500),
      adjustments: [
        adjustment("CO", "45", "contractual", 100, "D2750"),
        adjustment("PR", "2", "patient", 150, "D2750"),
        adjustment("OA", "23", "coordination", 250, "D2750"),
      ],
    }),
    cents(500)
  );

  assert.equal(v.patientResponsibility, cents(150), "the PR figure is still reported honestly");
  assert.equal(v.adjudication, "coordination_pending", "but the claim is not settled on it");

  const text = v.explanation.join(" ");
  assert.match(text, /do NOT bill it yet/, "the screen must not tell staff to bill this");
  assert.match(text, /another payer's adjudication/);
  assert.doesNotMatch(
    text,
    /is the patient's responsibility — bill the patient/,
    "the unqualified 'bill the patient' sentence is exactly the instruction that causes the refund"
  );
});

test("M8: an ordinary single-payer claim is completely unaffected", () => {
  // The control. If coordination fired on ordinary traffic, every clean claim would hold and the
  // gate would be noise within a week.
  const v = variance(paid(), cents(800));

  assert.equal(v.coordinationAmount, cents(0));
  assert.notEqual(v.adjudication, "coordination_pending");
  assert.match(v.explanation.join(" "), /is the patient's responsibility — bill the patient/);
});
