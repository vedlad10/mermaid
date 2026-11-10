/**
 * The mock payer's adjudication, checked against figures worked out on paper.
 *
 * ── WHY THESE NUMBERS ARE LITERALS AND NOT COMPUTED ────────────────────────────────────────────
 * This is the oracle. Its whole job is to be an authority that does NOT come from the code under
 * test, so every expected value below is derived by hand from the plan and written out. Computing
 * them here — even with a "simpler" expression — would reintroduce exactly the circularity F-0
 * exists to remove: a fixture that agrees with itself proves nothing about either side.
 *
 * The derivation is written above each case so a reader can check the arithmetic without running
 * anything, and so a future change that alters a figure has to argue with the sum rather than just
 * re-record whatever the code now produces.
 *
 * ── THE PLAN THESE CASES USE ───────────────────────────────────────────────────────────────────
 *   coverage      diagnostic 100%, preventive 100%, basic 80%, major 50%, orthodontic 0%
 *   deductible    applies to basic and major only
 *   write-off     10% of the billed fee (CONTRACTUAL_RATE)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjudicateLines } from "../adjudicator.ts";
import type { MockProfile } from "../profile.ts";

/** Amounts on `MockProfile` are DOLLARS; the adjudicator converts. Lines are cents. */
const plan = (over: Partial<MockProfile> = {}): MockProfile =>
  ({
    eligibility: "active",
    planName: "Test Plan",
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    deductibleAnnual: 50,
    deductibleRemaining: 0,
    annualMaximum: 1500,
    annualMaximumRemaining: 1500,
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
    ...over,
  }) as MockProfile;

const EXAM = { procedureCode: "D0120", charged: 6500 };
const CLEANING = { procedureCode: "D1110", charged: 11000 };
const CROWN = { procedureCode: "D2750", charged: 125000 };

// ── One line at a time, so each rule is pinned on its own ─────────────────────────────────────

/**
 * Crown, $1,250.00, major at 50%, deductible met, plenty of annual maximum left.
 *   contractual  1250.00 × 10%          = 125.00
 *   allowed      1250.00 − 125.00       = 1125.00
 *   paid         1125.00 × 50%          =  562.50
 *   patient      1125.00 − 562.50       =  562.50
 */
test("a crown with the deductible met pays half the ALLOWED amount, not half the fee", () => {
  const [line] = adjudicateLines([CROWN], plan());
  assert.equal(line!.contractual, 12500);
  assert.equal(line!.allowed, 112500);
  assert.equal(line!.paid, 56250);
  assert.equal(line!.patientShare, 56250);
  assert.notEqual(line!.paid, 62500, "half the FEE would be 625.00 — the defect this fixture must expose");
});

/**
 * Same crown with a $50.00 deductible outstanding.
 *   allowed                    1125.00
 *   deductible                   50.00   (major is a deductible category)
 *   after deductible           1075.00
 *   paid        1075.00 × 50% =  537.50
 *   patient     1125.00 − 537.50 = 587.50
 */
test("an unmet deductible comes off the allowed amount before the percentage", () => {
  const [line] = adjudicateLines([CROWN], plan({ deductibleRemaining: 50 }));
  assert.equal(line!.deductible, 5000);
  assert.equal(line!.paid, 53750);
  assert.equal(line!.patientShare, 58750);
});

/**
 * Preventive cleaning, $110.00, covered at 100%, exempt from the deductible.
 *   allowed  110.00 − 11.00 = 99.00
 *   paid     99.00 × 100%   = 99.00
 *   patient                    0.00
 */
test("a preventive line is paid in full at the allowed amount and never touches the deductible", () => {
  const [line] = adjudicateLines([CLEANING], plan({ deductibleRemaining: 50 }));
  assert.equal(line!.deductible, 0, "preventive is exempt");
  assert.equal(line!.allowed, 9900);
  assert.equal(line!.paid, 9900);
  assert.equal(line!.patientShare, 0);
});

// ── A whole visit, which is where the ordering rules interact ─────────────────────────────────

/**
 * Exam + cleaning + crown, deductible met, $1,500.00 annual maximum available.
 *   D0120  65.00 → allowed  58.50, 100% → paid  58.50, patient   0.00
 *   D1110 110.00 → allowed  99.00, 100% → paid  99.00, patient   0.00
 *   D2750 1250.00 → allowed 1125.00, 50% → paid 562.50, patient 562.50
 *   totals                allowed 1282.50   paid 720.00   patient 562.50
 *
 * The estimator, which splits the FEE rather than the ALLOWED amount, produces patient 625.00 for
 * this same visit. That $62.50 gap is F-1, and it is only visible because these two disagree.
 */
test("a full visit splits the allowed amount, and the totals reconcile", () => {
  const lines = adjudicateLines([EXAM, CLEANING, CROWN], plan());
  const sum = (k: "allowed" | "paid" | "patientShare" | "contractual") =>
    lines.reduce((t, l) => t + l[k], 0);

  assert.deepEqual(
    lines.map((l) => l.paid),
    [5850, 9900, 56250]
  );
  assert.equal(sum("allowed"), 128250, "$1,282.50");
  assert.equal(sum("paid"), 72000, "$720.00");
  assert.equal(sum("patientShare"), 56250, "$562.50");
  assert.equal(sum("paid") + sum("patientShare"), sum("allowed"), "allowed = paid + patient");
  assert.equal(sum("allowed") + sum("contractual"), 142500, "and charged = allowed + write-off");
});

/**
 * The same visit with only $120.00 of annual maximum left.
 *   D0120 allowed 58.50, 100% → wants 58.50, cap has 120.00 → paid 58.50, cap left 61.50
 *   D1110 allowed 99.00, 100% → wants 99.00, cap has  61.50 → paid 61.50, cap left  0.00
 *   D2750 allowed 1125.00, 50% → wants 562.50, cap has 0.00 → paid  0.00
 *   totals paid 120.00 — exactly the maximum, and not a cent more
 */
test("the annual maximum caps the plan's payment and is consumed in line order", () => {
  const lines = adjudicateLines([EXAM, CLEANING, CROWN], plan({ annualMaximumRemaining: 120 }));
  assert.deepEqual(
    lines.map((l) => l.paid),
    [5850, 6150, 0]
  );
  assert.equal(
    lines.reduce((t, l) => t + l.paid, 0),
    12000,
    "the plan pays exactly what was left"
  );
  assert.equal(lines[1]!.reason, "annual-maximum", "and says why it paid less than the percentage");
  assert.equal(lines[2]!.reason, "annual-maximum");
});

/** A category the plan covers at 0% is the patient's in full, at the allowed amount. */
test("a zero-percent category pays nothing and leaves the allowed amount to the patient", () => {
  const [line] = adjudicateLines([{ procedureCode: "D8080", charged: 500000 }], plan());
  assert.equal(line!.paid, 0);
  assert.equal(line!.allowed, 450000);
  assert.equal(line!.patientShare, 450000);
});

/** A code the catalog does not hold is paid at zero — never guessed into a benefit category. */
test("an unrecognised procedure is paid at zero rather than assigned a category", () => {
  const [line] = adjudicateLines([{ procedureCode: "D9999", charged: 10000 }], plan());
  assert.equal(line!.paid, 0);
  assert.equal(line!.patientShare, 9000, "the allowed amount, all of it theirs");
});

// ── Properties that hold for any plan, checked without enumerating cases ──────────────────────

test("every line balances, and nothing is ever negative", () => {
  const plans = [
    plan(),
    plan({ deductibleRemaining: 50 }),
    plan({ annualMaximumRemaining: 120 }),
    plan({ annualMaximumRemaining: 0 }),
    plan({ coveragePercentages: { diagnostic: 0, preventive: 0, basic: 0, major: 0, orthodontic: 0 } }),
  ];
  for (const p of plans) {
    for (const line of adjudicateLines([EXAM, CLEANING, CROWN], p)) {
      assert.equal(line.charged, line.allowed + line.contractual, "charged = allowed + write-off");
      assert.equal(line.allowed, line.paid + line.patientShare, "allowed = paid + patient");
      assert.ok(line.paid >= 0 && line.patientShare >= 0 && line.contractual >= 0, "no negatives");
      assert.ok(line.paid <= line.allowed, "a payer never pays above the contract");
    }
  }
});

/**
 * The property that makes this an oracle at all: what the payer decides is a function of the PLAN,
 * not of anything the practice predicted. Nothing in the signature can carry an expectation.
 */
test("adjudication depends only on the lines and the plan", () => {
  const once = adjudicateLines([EXAM, CLEANING, CROWN], plan());
  const twice = adjudicateLines([EXAM, CLEANING, CROWN], plan());
  assert.deepEqual(once, twice, "deterministic");
  assert.equal(
    adjudicateLines.length,
    2,
    "two parameters — lines and plan. A third would be the door expectations walk back in through."
  );
});

// ── The anti-circularity gate ─────────────────────────────────────────────────────────────────

/**
 * The property that makes this fixture worth having: it can DISAGREE with the estimator.
 *
 * The estimator splits the practice's FEE. A payer splits the contracted ALLOWED amount. On the
 * standard visit, with the deductible met and the annual maximum clear:
 *
 *   estimator   65.00 × 100%  +  110.00 × 100%  +  1250.00 × 50%   =  800.00
 *   payer       58.50 × 100%  +   99.00 × 100%  +  1125.00 × 50%   =  720.00
 *
 * Both figures are worked out here from the plan, and neither is read from the code that produces
 * the other. The $80.00 between them is F-1 — the defect that made every in-network estimate
 * over-quote the patient — and it is only detectable because these two disagree.
 *
 * The old fixture computed its payment FROM `expectedInsurancePays`, so it returned 800.00 and the
 * variance was zero. A broken estimator and a correct one produced identical staging runs. If this
 * test ever passes by finding the two equal, the fixture has gone back to quoting the estimator at
 * itself and every other assertion about money is worthless.
 */
test("the payer's decision is independent of what the practice expected — the F-0 gate", () => {
  const lines = adjudicateLines([EXAM, CLEANING, CROWN], plan());
  const payerPays = lines.reduce((t, l) => t + l.paid, 0);

  /** What a fee-based split would produce, computed here rather than imported. */
  const feeBasedSplit = 6500 * 1.0 + 11000 * 1.0 + Math.round(125000 * 0.5);

  assert.equal(feeBasedSplit, 80000, "$800.00 — the estimator's reading");
  assert.equal(payerPays, 72000, "$720.00 — the payer's reading");
  assert.notEqual(
    payerPays,
    feeBasedSplit,
    "if these are ever equal the fixture is quoting the estimator back at itself, and no test that " +
      "depends on a variance means anything"
  );
  assert.equal(feeBasedSplit - payerPays, 8000, "$80.00 — F-1, made visible");
});

/**
 * The same gate stated as a property rather than one arithmetic case: whatever the plan, the payer
 * pays a share of the ALLOWED amount, so its total can never exceed what the contract allows —
 * something a fee-based figure is free to do.
 */
test("the payer never pays more than the contract allows, whatever the plan says", () => {
  for (const p of [plan(), plan({ deductibleRemaining: 50 }), plan({ annualMaximumRemaining: 120 })]) {
    const lines = adjudicateLines([EXAM, CLEANING, CROWN], p);
    const paid = lines.reduce((t, l) => t + l.paid, 0);
    const allowed = lines.reduce((t, l) => t + l.allowed, 0);
    assert.ok(paid <= allowed, `paid ${paid} exceeded allowed ${allowed}`);
  }
});
