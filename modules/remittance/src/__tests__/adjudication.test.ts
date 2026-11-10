/**
 * "Was this claim paid correctly?" is not the same question as "did the number match the estimate?".
 *
 * The codebase had only the second one, spread across `posting.disposition`, `variance.outcome` and
 * `claim.status`, and every recommendation was derived from it. That produced two failures a real
 * clinic would feel:
 *
 *   • A claim paying $47.99 against a $120.00 estimate was reported as "settled in full", because
 *     the EFT reconciled and nothing was categorised recoverable.
 *   • A claim paying $0.00 because the whole allowed amount went to an unmet deductible was
 *     classified "denied" — starting an appeal clock against a claim nobody denied, in the month
 *     when deductibles reset and that is most of the book.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { computeVariance, type PaidClaim } from "../engine/variance.ts";
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


const adj = (group: string, code: string, category: VarianceReason["category"], amount: number): VarianceReason => ({
  group, code, description: `${group}-${code}`, category, amount: cents(amount), procedureCode: null,
});

const claim = (o: Partial<PaidClaim> & { charged: number; paid: number; adjustments: VarianceReason[] }): PaidClaim => ({
  chargedAmount: cents(o.charged),
  paidAmount: cents(o.paid),
  patientResponsibility: o.patientResponsibility ?? cents(0),
  adjustments: o.adjustments,
});

// ── The scenarios named in the brief ─────────────────────────────────────────────────────────────

test("expected $120, paid $120 → paid correctly", () => {
  const v = variance(claim({ charged: 120, paid: 120, adjustments: [] }), cents(120));
  assert.equal(v.adjudication, "paid_correctly");
  assert.equal(v.actionable, false);
});

test("expected $120, paid $47.99, patient owes $0 → an underpayment to pursue", () => {
  // Nothing explains the shortfall, so the arithmetic is the only thing that can surface it.
  const v = variance(claim({ charged: 120, paid: 47.99, adjustments: [] }), cents(120));
  assert.equal(v.adjudication, "underpaid");
  assert.equal(v.unexplainedAmount, cents(72.01));
  assert.equal(v.actionable, true, "money withheld with no reason code must reach a person");
});

test("expected $120, paid $47.99, patient owes the difference → NOT a payer underpayment", () => {
  const v = variance(
    claim({ charged: 120, paid: 47.99, adjustments: [adj("PR", "2", "patient", 72.01)] }),
    cents(120)
  );
  assert.equal(v.adjudication, "patient_responsibility");
  assert.equal(v.actionable, false, "there is nothing to pursue with the payer");
  assert.equal(v.patientResponsibility, cents(72.01));
  // The arithmetic still says "underpaid" against the estimate — and that is fine. The estimate was
  // wrong; the payer was not. Both facts are now expressible at once.
  assert.equal(v.outcome, "underpaid");
});

test("paid $0 with a correctable denial code → the denial workflow", () => {
  const v = variance(
    claim({ charged: 1425, paid: 0, adjustments: [adj("CO", "197", "recoverable", 1425)] }),
    cents(1140)
  );
  assert.equal(v.adjudication, "denied");
  assert.equal(v.actionable, true);
});

// ── The deductible case that was being mislabelled ───────────────────────────────────────────────

test("paid $0 because the allowed amount went to an unmet deductible is NOT a denial", () => {
  /**
   * January, every year, for most of the book. The payer adjudicated this claim perfectly: it
   * applied its fee schedule and then assigned the remainder to the patient's deductible.
   *
   * `outcome` still reads "denied" — that field means "nothing arrived", which is true. The
   * decision does not, which is what routes the work.
   */
  const v = variance(
    claim({
      charged: 1425,
      paid: 0,
      adjustments: [adj("CO", "45", "contractual", 190), adj("PR", "1", "patient", 1235)],
    }),
    cents(0)
  );
  assert.equal(v.outcome, "denied", "the arithmetic: nothing arrived");
  assert.equal(v.adjudication, "patient_responsibility", "the decision: correctly adjudicated to the patient");
  assert.equal(v.actionable, false, "a deductible must never open an appeal");
  assert.equal(v.patientResponsibility, cents(1235));
});

test("a fully contractual write-off is not a leak and not an action", () => {
  const v = variance(
    claim({ charged: 1425, paid: 1235, adjustments: [adj("CO", "45", "contractual", 190)] }),
    cents(1235)
  );
  assert.equal(v.adjudication, "contractual");
  assert.equal(v.actionable, false);
});

// ── Overpayment ──────────────────────────────────────────────────────────────────────────────────

test("an overpayment is actionable, because the money is not the practice's yet", () => {
  /**
   * Payers reclaim overpayments routinely, often months later and by deducting from an unrelated
   * remittance. `actionable` was `recoverable > 0 || unexplained > 0`, both zero here — so an
   * overpayment scored priority 5 and never appeared in any queue, leaving a practice free to
   * spend money that was going to be taken back.
   */
  const v = variance(claim({ charged: 1425, paid: 1425, adjustments: [] }), cents(1200));
  assert.equal(v.adjudication, "overpaid");
  assert.equal(v.variance, cents(225));
  assert.equal(v.actionable, true);
});

// ── Precedence ───────────────────────────────────────────────────────────────────────────────────

test("a recoverable dollar outranks an otherwise well-behaved claim", () => {
  // Mostly patient responsibility, with one correctable denial inside it. The claim must not be
  // read as "the patient's problem" because the recoverable part is smaller.
  const v = variance(
    claim({
      charged: 1425,
      paid: 100,
      adjustments: [
        adj("PR", "2", "patient", 1225),
        adj("CO", "197", "recoverable", 100),
      ],
    }),
    cents(200)
  );
  assert.equal(v.adjudication, "underpaid");
  assert.equal(v.actionable, true);
  assert.equal(v.recoverableAmount, cents(100));
});

test("every adjudication is one of the six, for a wide sweep of shapes", () => {
  const valid = new Set(["paid_correctly", "patient_responsibility", "contractual", "underpaid", "denied", "overpaid"]);
  for (const paid of [0, 1, 47.99, 120, 1425, 2000]) {
    for (const expected of [0, 120, 1425]) {
      for (const adjustments of [
        [],
        [adj("CO", "45", "contractual", 190)],
        [adj("PR", "1", "patient", 500)],
        [adj("CO", "197", "recoverable", 300)],
        [adj("CO", "45", "contractual", 100), adj("PR", "2", "patient", 200), adj("CO", "16", "recoverable", 50)],
      ]) {
        const v = variance(claim({ charged: 1425, paid, adjustments }), cents(expected));
        assert.ok(valid.has(v.adjudication), `paid=${paid} expected=${expected} → ${v.adjudication}`);
        // The partition must hold for every shape, or a dollar has gone missing.
        const total = v.actualPaid + v.contractualAdjustments + v.patientResponsibility + v.recoverableAmount + v.unexplainedAmount;
        assert.ok(total >= v.chargedAmount, `paid=${paid} adjustments=${adjustments.length}: partition lost money`);
      }
    }
  }
});

// ── What the claim's own status becomes ──────────────────────────────────────────────────────────

test("settled follows the adjudication, so an overpaid claim is never 'partially paid'", () => {
  /**
   * `remittance.posted` carries `settled`, and the Claims module turns it into a status:
   * settled → `paid`, otherwise money-received → `partially_paid`, otherwise → `denied`.
   *
   * `settled` was `!variance.actionable`. Those agreed only by coincidence: `actionable` means "a
   * person should look at this", and an overpayment is both settled and actionable. Deriving one
   * from the other marked overpaid claims `partially_paid` — the single status that asserts the
   * payer still owes money, on the claims where the payer had paid too much.
   */
  const settledFor = (adjudication: string) => adjudication !== "underpaid" && adjudication !== "denied";

  assert.equal(settledFor("paid_correctly"), true);
  assert.equal(settledFor("patient_responsibility"), true, "the payer is done; the patient owes");
  assert.equal(settledFor("contractual"), true);
  assert.equal(settledFor("overpaid"), true, "the payer is more than done");
  assert.equal(settledFor("underpaid"), false);
  assert.equal(settledFor("denied"), false);

  // And the two are genuinely independent: settled AND actionable is a real, reachable combination.
  const over = variance(claim({ charged: 1425, paid: 1425, adjustments: [] }), cents(1200));
  assert.equal(over.adjudication, "overpaid");
  assert.equal(over.actionable, true);
  assert.equal(settledFor(over.adjudication), true);
});

// ── The materiality band, as the classifier applies it (F-6) ──────────────────────────────────

/**
 * A payment differing by one cent used to be labelled `underpaid` on a claim the payer had settled
 * in full — seven of nine postings on the audited staging set, and the only value the `outcome`
 * column ever took. These assert the band is applied HERE, not merely available in shared: the
 * policy having correct arithmetic is worth nothing if `classify` does not consult it.
 *
 * Expected $800.00 ⇒ threshold $1.00 (0.25%, capped). Figures derived from the policy, not read back.
 */
test("F-6: a one-cent difference is not a shortfall, and the figure is still exact", () => {
  const v = variance(claim({ charged: 1425, paid: 799.99, adjustments: [] }), cents(800));
  assert.equal(v.outcome, "as_expected", "the payer settled in full; a cent of rounding is not news");
  assert.equal(v.variance, cents(-0.01), "and the exact figure is kept — nothing was rounded away");
  assert.equal(v.varianceMaterial, false);
  assert.equal(v.varianceThreshold, cents(1), "$1.00 on an $800.00 expectation");
});

test("F-6: a difference just past the band is a shortfall", () => {
  const v = variance(claim({ charged: 1425, paid: 798.99, adjustments: [] }), cents(800));
  assert.equal(v.variance, cents(-1.01));
  assert.equal(v.outcome, "underpaid", "$1.01 is worth chasing");
  assert.equal(v.varianceMaterial, true);
});

test("F-6: exactly the threshold is tolerated, a cent past it is not", () => {
  const at = variance(claim({ charged: 1425, paid: 799, adjustments: [] }), cents(800));
  assert.equal(at.outcome, "as_expected", "$1.00 exactly");
  const past = variance(claim({ charged: 1425, paid: 798.99, adjustments: [] }), cents(800));
  assert.equal(past.outcome, "underpaid", "$1.01");
});

test("F-6: the band is tighter on a small claim", () => {
  /** Expected $20.00 ⇒ threshold 5¢, so 6¢ is 0.3% of the claim and worth a look. */
  const v = variance(claim({ charged: 100, paid: 19.94, adjustments: [] }), cents(20));
  assert.equal(v.varianceThreshold, cents(0.05));
  assert.equal(v.outcome, "underpaid", "6¢ on $20.00 is not the same as 6¢ on $800.00");
});

test("F-6: an overpayment inside the band is not reported as one either", () => {
  const v = variance(claim({ charged: 1425, paid: 800.5, adjustments: [] }), cents(800));
  assert.equal(v.outcome, "as_expected");
  assert.equal(v.variance, cents(0.5), "still exact");
});

/**
 * The line the band must never cross. `unexplained` is money withheld with no reason code, and it is
 * computed to the cent regardless of materiality — tolerating a shortfall in a LABEL is a reporting
 * decision; tolerating one in the reconciliation would lose money silently.
 */
test("F-6: the band never reaches the reconciliation", () => {
  const v = variance(claim({ charged: 1425, paid: 1424.99, adjustments: [] }), cents(1425));
  assert.equal(v.outcome, "as_expected", "a cent short of the estimate is not news");
  assert.equal(v.unexplainedAmount, cents(0.01), "but the cent is still unaccounted for, exactly");
  assert.ok(v.actionable, "and money nobody explained is still somebody's job");
});

// ── An unknown expectation is not a zero one ──────────────────────────────────────────────────

/**
 * ── WHY THE SIGNATURE CHANGED ──────────────────────────────────────────────────────────────────
 * `computeVariance` took `Cents` and carried a comment saying the caller MUST NOT call it when the
 * expectation is unknown. The single caller honoured it. Nothing enforced it, and the type could not
 * express it: `0` had to stand for both "expected to pay nothing" — a real expectation a payer can
 * be measured against — and "we have no idea", which nothing can.
 *
 * A caller passing a defaulted zero would get a variance equal to the whole payment, reported as an
 * overpayment, and every such claim would reach the recovery worklist as a suspected takeback. That
 * is the shape of L-1, which reached production once already.
 */
test("an unknown expectation yields no variance at all, rather than a fabricated one", () => {
  assert.equal(
    computeVariance(claim({ charged: 1425, paid: 800, adjustments: [] }), null),
    null,
    "nothing can be measured against an expectation nobody stated"
  );
});

test("a genuine expectation of zero is measured, not skipped", () => {
  /**
   * The distinction the old signature could not make. A claim the estimate said would pay nothing is
   * a real expectation: if the payer then pays $800.00 that is an overpayment, and a person should
   * see it rather than have it silently discarded alongside the unknowns.
   */
  const v = variance(claim({ charged: 1425, paid: 800, adjustments: [] }), cents(0));
  assert.equal(v.expectedInsurancePays, 0);
  assert.equal(v.variance, cents(800), "paid − expected, against a stated zero");
  assert.equal(v.outcome, "overpaid");
});
