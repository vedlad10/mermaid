/**
 * A payer may not quietly charge a practice to collect its own money.
 *
 * These pin the two failure directions that make a fee detector worth having: missing a card payment
 * (the leak this exists to stop) and crying wolf on every denial (the noise that would get the whole
 * feature switched off in a week).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPaymentMethod } from "../engine/payment-method.ts";
import { cents, type Cents } from "@mermaid/shared";

const advice = (over: Partial<{ paymentMethod: string; paymentTotal: Cents; payerName: string }> = {}) => ({
  paymentMethod: "ACH",
  paymentTotal: cents(812.0), // a D2740 crown at a Delta PPO contracted rate
  payerName: "Delta Dental of California",
  ...over,
});

test("an ACH payment is the normal case and says nothing", () => {
  const a = assessPaymentMethod(advice());
  assert.equal(a.standing, "ach");
  assert.equal(a.finding, null, "a finding on every clean remittance is how a queue becomes wallpaper");
  assert.equal(a.feeCents, null);
});

test("a non-ACH payment is found, and the fee is computed from the practice's own rate", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "CHK", paymentTotal: cents(681.0) }), {
    merchantRateBps: 295,
  });
  assert.equal(a.standing, "non-ach");
  // 68100 × 0.0295 = 2008.95 → 2009 cents, rounded once, in integer cents.
  assert.equal(a.feeCents, 2009);
  assert.match(a.finding ?? "", /Delta Dental of California/, "the payer must be named — enrolment is per-payer");
  assert.match(a.finding ?? "", /paper cheque/);
  assert.match(a.finding ?? "", /162\.925\(a\)\(1\)/, "the biller is about to ask a payer to change; give them the rule");
});

test("without a merchant rate the finding still fires, and refuses to invent a number", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "BOP" }));
  assert.equal(a.standing, "non-ach");
  assert.equal(a.feeCents, null, "a plausible 3% is indistinguishable on screen from a measured one");
  assert.match(a.finding ?? "", /not known/);
  assert.doesNotMatch(a.finding ?? "", /\$?\d+\.\d\d in merchant fees/, "no fabricated cost may appear");
});

/**
 * ── THE NOISE TEST ─────────────────────────────────────────────────────────────────────────────
 * A denial-only advice legitimately carries BPR04 `NON`, and there are more denials than card
 * payments in any real practice. Reading the method before reading the amount would put a fee alarm
 * on every one of them and bury the findings that matter under the ones that do not.
 */
test("a denial-only advice moved no money, so there is no channel to complain about", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "NON", paymentTotal: 0 as Cents }));
  assert.equal(a.standing, "no-payment");
  assert.equal(a.finding, null);
  assert.equal(a.reverted, false);
});

test("a reversal carries a negative total and is not a fee event either", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "CHK", paymentTotal: cents(-400) }), {
    merchantRateBps: 295,
  });
  assert.equal(a.standing, "no-payment");
  assert.equal(a.feeCents, null, "a negative payment must never produce a positive fee");
});

/**
 * ── THE ONE THAT PAYS FOR THE FEATURE ──────────────────────────────────────────────────────────
 * Opting out once is a task a practice can do without us. Staying opted out is not: a fresh card
 * product months later re-enrols anyone whose staff simply processes it. Nobody holds the previous
 * remittance from one payer in their head across hundreds of files.
 */
test("a payer that paid by ACH and has stopped is a REVERSION, reported as such", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "CHK" }), { priorStanding: "ach", merchantRateBps: 295 });
  assert.equal(a.reverted, true);
  assert.match(a.finding ?? "", /paid by ACH previously/, "the wording must distinguish a relapse from a first sighting");
});

test("a first sighting is not a reversion, and does not claim to be", () => {
  const first = assessPaymentMethod(advice({ paymentMethod: "CHK" }), { priorStanding: null });
  assert.equal(first.reverted, false);
  assert.doesNotMatch(first.finding ?? "", /previously/);

  // Still not a reversion when the payer has only ever paid by card.
  const again = assessPaymentMethod(advice({ paymentMethod: "CHK" }), { priorStanding: "non-ach" });
  assert.equal(again.reverted, false);
});

test("BOP is not treated as ACH — an ambiguous method is where a card hides", () => {
  assert.equal(assessPaymentMethod(advice({ paymentMethod: "BOP" })).standing, "non-ach");
});

test("the method is read case- and whitespace-insensitively, but reported as normalised", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "  ach " }));
  assert.equal(a.standing, "ach", "a payer's casing must not decide whether a practice gets a fee alarm");
  assert.equal(a.method, "ACH");
});

test("an absent method is not silently forgiven", () => {
  const a = assessPaymentMethod(advice({ paymentMethod: "" }));
  assert.equal(a.standing, "non-ach", "no stated method is not evidence of ACH");
  assert.match(a.finding ?? "", /unstated/);
});
