/**
 * How far a payment may differ from the estimate before the difference means anything (F-6).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The variance classifier compared against exact zero, so a payment differing by one cent was
 * labelled `underpaid` — permanently, on a claim the payer had settled in full. Seven of nine
 * postings on the audited staging set carried that label, and `SELECT DISTINCT outcome FROM
 * postings` returned only `underpaid`. A column with one value carries no information, and a badge
 * that is always lit is one staff stop reading. That is how a real underpayment gets missed.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────────
 * It is a labelling rule. Nothing here rounds a stored amount, writes off a cent, or posts an
 * adjustment. A variance inside the band is still recorded exactly and still reportable — it is
 * simply not called a shortfall. Every assertion below is a threshold, never a money movement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../money.ts";
import { isMaterialVariance, materialityThreshold } from "../money.ts";

// ── The band's shape ──────────────────────────────────────────────────────────────────────────

/**
 * threshold = min($1.00, max(5¢, expected × 0.25%))
 *
 *   $20.00   → 0.25% =  5¢  → floor  →  5¢
 *   $100.00  → 0.25% = 25¢          →  25¢
 *   $400.00  → 0.25% = $1.00        →  $1.00
 *   $800.00  → 0.25% = $2.00 → cap  →  $1.00
 *   $1,600.00→ 0.25% = $4.00 → cap  →  $1.00
 */
test("the band scales with the claim, with a floor and a cap", () => {
  assert.equal(materialityThreshold(cents(20)), 5, "5¢ floor — smaller claims do not get a smaller band");
  assert.equal(materialityThreshold(cents(100)), 25);
  assert.equal(materialityThreshold(cents(400)), 100);
  assert.equal(materialityThreshold(cents(800)), 100, "$1.00 cap");
  assert.equal(materialityThreshold(cents(1600)), 100, "a pure percentage would tolerate $4.00 here");
});

test("a zero expectation still gets the floor rather than a zero band", () => {
  assert.equal(materialityThreshold(cents(0)), 5, "otherwise every cent of drift is a shortfall");
});

test("the band does not depend on the direction of the expectation", () => {
  assert.equal(materialityThreshold(cents(-800)), materialityThreshold(cents(800)));
});

// ── The boundary table, at two claim sizes ────────────────────────────────────────────────────

/**
 * Expected $800.00 ⇒ threshold $1.00. The band is exclusive: exactly $1.00 is tolerated, $1.01 is
 * not, which is the line a person would draw reading "differences up to a dollar".
 */
test("boundaries on an $800.00 expectation", () => {
  const expected = cents(800);
  const material = (v: number) => isMaterialVariance(cents(v), expected);

  assert.equal(material(0), false, "$0.00");
  assert.equal(material(-0.01), false, "1¢ — the case that mislabelled seven of nine postings");
  assert.equal(material(-0.02), false, "2¢");
  assert.equal(material(-0.49), false, "49¢");
  assert.equal(material(-0.5), false, "50¢");
  assert.equal(material(-1.0), false, "$1.00 — exactly the threshold, tolerated");
  assert.equal(material(-1.01), true, "$1.01 — a dollar of dental revenue is worth chasing");
  assert.equal(material(-72.01), true, "$72.01");
});

/** Expected $20.00 ⇒ threshold 5¢. The same table, and the band is genuinely tighter. */
test("boundaries on a $20.00 expectation, where the band must be tighter", () => {
  const expected = cents(20);
  const material = (v: number) => isMaterialVariance(cents(v), expected);

  assert.equal(material(0), false);
  assert.equal(material(-0.01), false, "1¢ of pro-rata drift is still drift");
  assert.equal(material(-0.05), false, "5¢ — exactly the floor");
  assert.equal(material(-0.06), true, "6¢ on a $20.00 claim is 0.3% and worth a look");
  assert.equal(material(-1.0), true, "$1.00 here is 5% of the claim");
});

test("the band is symmetric — an overpayment is material at the same size as a shortfall", () => {
  const expected = cents(800);
  assert.equal(isMaterialVariance(cents(1.01), expected), true);
  assert.equal(isMaterialVariance(cents(-1.01), expected), true);
  assert.equal(isMaterialVariance(cents(1.0), expected), false);
  assert.equal(isMaterialVariance(cents(-1.0), expected), false);
});

// ── The property that keeps it a label and not a write-off ────────────────────────────────────

/**
 * The rule this policy must never break. `materialityThreshold` answers a question ABOUT an amount;
 * it never returns a corrected amount, so there is no value it could return that a caller might
 * mistake for money to store. Pinned because "just round the variance" is the obvious-looking
 * simplification, and it would quietly forgive a cent on every claim in the practice.
 */
test("the policy yields a threshold, never a corrected amount", () => {
  const expected = cents(800);
  const variance = cents(-0.37);
  assert.equal(isMaterialVariance(variance, expected), false, "not worth reading");
  assert.equal(variance, -37, "and the figure itself is untouched, to the cent");
});
