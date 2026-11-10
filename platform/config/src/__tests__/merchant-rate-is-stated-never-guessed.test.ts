/**
 * The merchant discount rate is a number a PRACTICE states, or no number at all.
 *
 * It prices what a non-ACH payer reimbursement cost to receive, and a biller may quote that figure
 * to a payer when asking to be moved onto ACH. So the failure that matters here is not a crash — it
 * is a plausible number nobody measured, which looks exactly like a measured one on a screen and
 * cannot be defended in the conversation it was produced for.
 *
 * Every rejection therefore returns null ("unstated"), never a fallback. Detection of the non-ACH
 * payment does not depend on this value; only the cost does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMerchantRateBps } from "../env.ts";

test("a stated rate is taken exactly as given", () => {
  assert.equal(parseMerchantRateBps("295"), 295, "2.95%");
  assert.equal(parseMerchantRateBps("350"), 350);
  assert.equal(parseMerchantRateBps(" 295 "), 295, "surrounding whitespace is not a typo worth punishing");
});

test("unset means unstated, and unstated means null", () => {
  assert.equal(parseMerchantRateBps(undefined), null);
  assert.equal(parseMerchantRateBps(""), null);
  assert.equal(parseMerchantRateBps("   "), null);
});

test("zero is a statement, not an absence", () => {
  // A practice whose processor charges nothing for these says so, and gets a computed fee of zero
  // rather than "not known". Collapsing 0 to null would silently withhold a true answer.
  assert.equal(parseMerchantRateBps("0"), 0);
});

test("a malformed rate is refused outright rather than rounded into something usable", () => {
  /**
   * `2.95` is the one that matters most: it is a PERCENTAGE typed where basis points go, and it is
   * the mistake a reader of the variable name is most likely to make. Accepting it would report a
   * crown's card fee as three cents.
   */
  for (const bad of ["abc", "2.95", "2,95", "295bps", "NaN", "Infinity"]) {
    assert.equal(parseMerchantRateBps(bad), null, `${JSON.stringify(bad)} must not become a rate`);
  }
});

test("an unusually WRITTEN rate is still a rate, as long as it is exact", () => {
  // The guard is against values that are wrong, not values that are oddly spelled. `1e3` is exactly
  // 1000 with no rounding and no ambiguity; refusing it would be strictness that buys no safety.
  assert.equal(parseMerchantRateBps("1e3"), 1000);
});

test("a rate outside 0–10000 bps is a unit error, not a rate", () => {
  // Over 100% is almost always a percentage typed where basis points go (someone wrote "3" meaning
  // 3%, or "30000" meaning nothing at all). A negative one would credit the practice for being paid
  // by card. Both are refused rather than clamped, because clamping invents the intent.
  assert.equal(parseMerchantRateBps("-1"), null);
  assert.equal(parseMerchantRateBps("10001"), null);
  assert.equal(parseMerchantRateBps("10000"), 10_000, "100% is the boundary, and is allowed");
});

test("a fractional basis point is refused — the unit is whole basis points", () => {
  assert.equal(parseMerchantRateBps("295.5"), null);
});
