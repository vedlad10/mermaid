/**
 * Detecting whether a payer requires approval before treatment — and refusing to guess.
 *
 * ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────────────────────────
 * A payer that requires authorisation and did not get one refuses under CARC 197 in the `CO` group.
 * `CO` forbids billing the patient, so the whole allowed amount is written off against the
 * practice. Pia Phase32's crown lost $1,125.00 that way — money that was knowable before she sat
 * down.
 *
 * ── WHY THE ANSWER IS THREE-VALUED, TESTED HERE ────────────────────────────────────────────────
 * `unknown` is the point of the design. A 271 does not carry these rules; payers publish them in
 * portals. Silence is the ORDINARY case, and collapsing it either way is a defect:
 *
 *   • silence read as "not required" invents permission the payer never gave — the exact silent
 *     failure this feature exists to stop;
 *   • silence read as "required" puts a blocking task on every routine filling until staff learn
 *     to dismiss the feature entirely.
 *
 * So the tests below pin all three answers, and pin that they come from PAYER DATA rather than a
 * hardcoded list of procedures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../money.ts";
import { preAuthRequirementFor, revenueAtRisk } from "../domain/preauth.ts";
import type { PreAuthorizationPolicy } from "../domain/preauth.ts";

const CROWN = { code: "D2750", category: "major" as const };
const EXAM = { code: "D0120", category: "diagnostic" as const };

const policy = (over: Partial<PreAuthorizationPolicy> = {}): PreAuthorizationPolicy => ({
  categories: ["major"],
  codes: [],
  thresholdCents: null,
  validityDays: 180,
  source: "TEST PLAN RULE",
  ...over,
});

test("a payer that names the category requires approval for it", () => {
  const v = preAuthRequirementFor(CROWN, cents(1250), { preAuthorization: policy() });
  assert.equal(v.requirement, "required");
  assert.match(v.reason, /major/, "the reason must quote the rule the payer actually stated");
});

test("the same plan does not require approval for a service outside the rule", () => {
  const v = preAuthRequirementFor(EXAM, cents(65), { preAuthorization: policy() });
  assert.equal(v.requirement, "not-required");
});

test("silence from the payer is UNKNOWN, never permission", () => {
  /**
   * The single most important assertion in this file. A plan with no rule on file has not said
   * "no" — and a system that reads it as "no" files the claim, loses the money, and shows nothing
   * beforehand.
   */
  const v = preAuthRequirementFor(CROWN, cents(1250), {});
  assert.equal(v.requirement, "unknown");
  assert.match(v.reason, /has not told us|portal|plan documents/i, "and it must say what to do about it");
});

test("nothing is hardcoded: the same crown is required, not-required or unknown by PLAN", () => {
  /**
   * The rule the brief names explicitly — no hardcoded "crowns need pre-auth". The procedure is
   * held constant and only the payer's data changes.
   */
  const required = preAuthRequirementFor(CROWN, cents(1250), { preAuthorization: policy() });
  const notRequired = preAuthRequirementFor(CROWN, cents(1250), {
    preAuthorization: policy({ categories: ["orthodontic"] }),
  });
  const unknown = preAuthRequirementFor(CROWN, cents(1250), {});

  assert.equal(required.requirement, "required");
  assert.equal(notRequired.requirement, "not-required");
  assert.equal(unknown.requirement, "unknown");
});

test("a specific code beats a category rule, and says so", () => {
  /**
   * A payer listing D2750 explicitly has said something more precise than "major services".
   * Reporting the general rule would misquote the payer on the screen a person checks.
   */
  const v = preAuthRequirementFor(CROWN, cents(1250), {
    preAuthorization: policy({ categories: [], codes: ["D2750"] }),
  });
  assert.equal(v.requirement, "required");
  assert.match(v.reason, /D2750/, "the specific rule is the one quoted");
});

test("a money threshold applies whatever the category", () => {
  const rule = policy({ categories: [], thresholdCents: cents(500) });
  assert.equal(preAuthRequirementFor(CROWN, cents(1250), { preAuthorization: rule }).requirement, "required");
  assert.equal(preAuthRequirementFor(EXAM, cents(65), { preAuthorization: rule }).requirement, "not-required");
  assert.equal(
    preAuthRequirementFor(EXAM, cents(500), { preAuthorization: rule }).requirement,
    "required",
    "at the threshold, not merely above it"
  );
});

test("an uncatalogued code under a category rule is unknown, not cleared", () => {
  /**
   * The silent-permission failure in miniature. If the rule is category-based and Mermaid cannot
   * say which bucket a code falls in, the honest answer is that nobody has established it.
   */
  const v = preAuthRequirementFor({ code: "D9999", category: null }, cents(900), {
    preAuthorization: policy(),
  });
  assert.equal(v.requirement, "unknown");
  assert.match(v.reason, /not in Mermaid's catalog/);
});

// ── What a refusal would actually cost ────────────────────────────────────────────────────────

test("the exposure is the insurance share, never the billed fee", () => {
  /**
   * CARC 197 arrives under `CO`, which forbids billing the patient — so the contractual write-off
   * was never collectable from anyone and including it would overstate the loss by exactly the
   * discount the practice had already agreed to.
   *
   * Pia Phase32's crown, to the cent: $1,250.00 billed, $125.00 contractual, $1,125.00 allowed and
   * paid by insurance. CARC 197 took $1,125.00.
   */
  assert.equal(
    revenueAtRisk({
      requirement: "required",
      fee: cents(1250),
      allowedAmount: cents(1125),
      insurancePays: cents(1125),
    }),
    cents(1125)
  );
});

test("an unknown requirement carries the SAME exposure as a known one", () => {
  /**
   * The difference between "we know approval is needed and have none" and "nobody has checked" is a
   * difference in what to do, not in what is at stake. Showing zero for the unchecked case would
   * make not checking look safe, which is the behaviour that loses the money.
   */
  const line = { fee: cents(1250), allowedAmount: cents(1125), insurancePays: cents(1125) };
  assert.equal(revenueAtRisk({ ...line, requirement: "unknown" }), cents(1125));
  assert.equal(revenueAtRisk({ ...line, requirement: "required" }), cents(1125));
});

test("a service needing no approval is exposed to nothing", () => {
  assert.equal(
    revenueAtRisk({ requirement: "not-required", fee: cents(1250), insurancePays: cents(1125) }),
    0
  );
});

test("a line insurance pays nothing on exposes nothing, even when approval is required", () => {
  /**
   * A refusal removes what the payer was going to pay. Where that is already zero — a line denied
   * for some other reason — there is no additional money to lose, and reporting the fee as "at
   * risk" would inflate the practice's exposure with money no payer was ever going to send.
   */
  assert.equal(
    revenueAtRisk({ requirement: "required", fee: cents(1250), insurancePays: cents(0) }),
    0
  );
});
