/**
 * §4.4 small-n suppression, and the way the guard for it failed open in the browser.
 *
 * ── THE DEFECT, AS IT ACTUALLY APPEARED ────────────────────────────────────────────────────────
 * The Recover screen rendered:
 *
 *     "197 · 1 denial · 30% — based on undefined similar appeals across comparable denials"
 *
 * The suppression check was written `if (n < MIN_SAMPLE) return null`, which reads correctly and is
 * wrong for exactly one input. `undefined < 5` is false — as is `undefined >= 5` — so a record that
 * carried no sample size sailed straight past a check whose entire purpose is to stop a rate with no
 * evidence behind it. The missing-evidence case is the one the rule exists for, and it was the one
 * case that got through.
 *
 * ── WHY IT MATTERS MORE THAN A COSMETIC BUG ────────────────────────────────────────────────────
 * This percentage is the number a practice uses to decide whether an afternoon of appeal work is
 * worth doing. "30%" over an unknown number of prior appeals is not a weaker claim than "30% over
 * 42" — it is an unfounded one wearing the same clothes. A screen that cannot say what a rate is
 * based on has to say nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { horizonTone, quotable, rateWithBasis } from "../public/recover.js";

test("a sample that is absent, not merely small, still fails the guard", () => {
  /* The regression. Each of these would have passed `n < 5` and published a rate. */
  for (const missing of [undefined, null, NaN, "42" as unknown as number]) {
    assert.equal(quotable(missing as number), false, `${String(missing)} is not a sample size`);
  }
});

test("the threshold itself is honoured in both directions", () => {
  assert.equal(quotable(4), false, "four appeals is an anecdote");
  assert.equal(quotable(5), true, "five is the specification's floor");
  assert.equal(quotable(42), true);
  assert.equal(quotable(0), false, "no appeals at all is the clearest case of nothing to quote");
});

test("a quotable rate is always written with its denominator and where it came from", () => {
  const learned = rateWithBasis(0.68, 42, "payer-learned");
  assert.equal(learned, "68% — based on 42 similar appeals with this payer");

  const generic = rateWithBasis(0.3, 12, "carc-category");
  assert.equal(generic, "30% — based on 12 similar appeals across comparable denials");
});

test("an unquotable rate returns null rather than a sentence with a hole in it", () => {
  assert.equal(rateWithBasis(0.3, undefined as unknown as number, "carc-category"), null);
  assert.equal(rateWithBasis(0.3, 1, "payer-learned"), null);
  /* A rate that is itself missing is refused too — "NaN% based on 42 appeals" is no better. */
  assert.equal(rateWithBasis(NaN, 42, "payer-learned"), null);
});

/* ══ The deadline horizon ═════════════════════════════════════════════════════════════════════ */

test("a passed deadline is its own band, not the most urgent warning", () => {
  /**
   * The distinction §8.5 insists on. A closed appeal window is not an escalation of an approaching
   * one — it is a different fact: the money is gone. Ranking it as the most critical live item puts
   * work nobody can do at the top of the list of work to do today.
   */
  assert.equal(horizonTone(-1), "past");
  assert.equal(horizonTone(-400), "past");
  assert.equal(horizonTone(0), "critical", "today is the last day, and it is still actionable");
});

test("the urgency bands are contiguous, so no deadline falls between two of them", () => {
  assert.equal(horizonTone(2), "critical");
  assert.equal(horizonTone(3), "warning");
  assert.equal(horizonTone(7), "warning");
  assert.equal(horizonTone(8), "open");
  /* No recorded deadline is not "safe" — it is unknown, and a screen must be able to say so. */
  assert.equal(horizonTone(null), "unknown");
});
