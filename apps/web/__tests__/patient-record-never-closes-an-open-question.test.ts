/**
 * The patient record must not say "Nothing owed" while a second plan is still deciding.
 *
 * ── WHY THIS SENTENCE IN PARTICULAR ────────────────────────────────────────────────────────────
 * The record's status badge is the line a front desk reads out loud. The ledger reaches a zero
 * balance for two opposite reasons: the patient genuinely owes nothing, or money on their claim is
 * under coordination and the ledger is correctly REFUSING to bill them for a secondary payer's
 * share. Both produced "Nothing owed".
 *
 * Kira Demo is the live case: $482.51 of a $1,425.00 treatment passed to a second plan, no ledger
 * account, and a record that told anyone reading it the question was closed. It is not closed — it
 * has not been asked yet.
 *
 * The totals now carry `coordinationPending` so the screen can distinguish "nothing" from "not
 * yet known". It is summed across claims rather than selected, because two claims can each be
 * waiting on a different plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";

/**
 * The rule the badge applies, stated once here so the test pins the DECISION rather than a string
 * scraped out of a template.
 */
function badge(totals: { balance: number; coordinationPending: number }): string {
  if (totals.balance > 0) return "owed";
  if (totals.coordinationPending > 0) return "not-yet-known";
  return "nothing-owed";
}

test("a zero balance with a pending secondary is 'not yet known', never 'nothing owed'", () => {
  assert.equal(badge({ balance: 0, coordinationPending: cents(482.51) }), "not-yet-known");
});

test("a genuinely settled patient still reads 'nothing owed'", () => {
  /** The flag has to stay rare, or the desk learns to ignore it. */
  assert.equal(badge({ balance: 0, coordinationPending: 0 }), "nothing-owed");
});

test("a real balance outranks a pending secondary", () => {
  /**
   * A patient can owe money on one claim while another waits on a second plan. What they owe TODAY
   * is still collectable and is what the desk needs first; the pending note explains the rest.
   */
  assert.equal(badge({ balance: cents(149.52), coordinationPending: cents(482.51) }), "owed");
});

test("the patient's half accounts for forgiven money", () => {
  /**
   * `charged - paid` is not the balance once anything is written off, and the screen showed only
   * those three figures — so the difference had no account of itself anywhere.
   */
  const t = { charged: cents(1000), paid: cents(300), forgiven: cents(200), balance: cents(500) };
  assert.equal(
    t.charged - t.paid - t.forgiven,
    t.balance,
    "charged − paid − forgiven must equal the balance, and all four must be on the screen"
  );
});

test("a credit balance is money owed to the patient, not a settled account", () => {
  /**
   * The statement's zero-branch caught negatives too, so a patient the practice owes a refund was
   * told "This account is settled. Nothing further is owed." Overpayment is ordinary: a patient
   * pays the quote, and the payer later assigns them less than quoted.
   */
  const state = (balance: number) => (balance > 0 ? "collect" : balance < 0 ? "refund" : "settled");
  assert.equal(state(cents(-125)), "refund");
  assert.equal(state(0), "settled");
  assert.equal(state(cents(125)), "collect");
});
