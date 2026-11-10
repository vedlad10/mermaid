/**
 * The CAS group code is the money decision. The reason code only says why.
 *
 * These exist because the opposite rule shipped: `categorizeAdjustment` honoured `PR` and then let a
 * `category` stored against the CODE overrule every other group. Two rows in the reference table
 * carried `category: "patient"` under `typicalGroup: "CO"` — benefit maximum reached, and coverage
 * terminated — so a payer sending CO-119 produced the instruction "bill the patient", for money the
 * payer had contractually barred the practice from billing.
 *
 * That is balance billing. It breaches the participating-provider agreement, it is prohibited
 * outright in many states, and the clinic carries the liability. It is the one error in this
 * codebase that could put a customer in front of a regulator, so it gets a test file of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARC_CODES, categorizeAdjustment, describeCarc, findCarc } from "../carc.ts";

// ── The invariant ────────────────────────────────────────────────────────────────────────────────

test("only a PR group can ever produce a patient charge — for every code in the reference", () => {
  for (const carc of CARC_CODES) {
    for (const group of ["CO", "PI", "OA", "CR"]) {
      assert.notEqual(
        categorizeAdjustment(group, carc.code),
        "patient",
        `${group}-${carc.code} (${carc.description}) must never be billable to the patient`
      );
    }
    assert.equal(
      categorizeAdjustment("PR", carc.code),
      "patient",
      `PR-${carc.code} is the payer assigning this to the patient`
    );
  }
});

test("an unknown code cannot become a patient charge either", () => {
  // Payers use hundreds of codes. The safe default under CO/PI is to make a human look at money we
  // did not receive — never to bill it onward, and never to absorb it silently.
  assert.equal(categorizeAdjustment("CO", "99999"), "recoverable");
  assert.equal(categorizeAdjustment("PI", "99999"), "recoverable");
  assert.equal(categorizeAdjustment("PR", "99999"), "patient");
  /**
   * ── M8 — THIS ASSERTION REPLACES ONE THAT PINNED THE DEFECT ────────────────────────────────
   *
   * It read `assert.equal(categorizeAdjustment("OA", "99999"), "informational")`, which contradicted
   * the comment three lines above it: `informational` IS absorbing the money silently. It counted
   * toward `computeVariance`'s `accountedFor`, so the arithmetic balanced, and then appeared in none
   * of the reported money fields and no queue.
   *
   * `OA` — Other Adjustment — is defined by what it is not: not contractual, not the patient's, not
   * the payer's own reduction. An unrecognised code in that group is therefore precisely a sum whose
   * owner cannot be named, and the rule for that is the same as everywhere else here — it goes in
   * front of a person. `coordination` is a blocker in the safety gate.
   */
  assert.equal(categorizeAdjustment("OA", "99999"), "coordination");
});

// ── The two rows that caused it ──────────────────────────────────────────────────────────────────

test("CARC 119 — benefit maximum — follows the group, not the code", () => {
  // The usual case: the payer says the patient owes their exhausted maximum.
  assert.equal(categorizeAdjustment("PR", "119"), "patient");
  // The unusual case, and the one that was wrong: the payer says the PRACTICE absorbs it. That is
  // money we did not receive and may not bill onward, so a person has to look at it.
  assert.equal(categorizeAdjustment("CO", "119"), "recoverable");
});

test("CARC 27 — coverage terminated — follows the group, not the code", () => {
  assert.equal(categorizeAdjustment("PR", "27"), "patient");
  assert.equal(categorizeAdjustment("CO", "27"), "recoverable");
});

// ── Contractual write-offs stay write-offs, but only under a contractual group ────────────────────

test("a fee-schedule reduction is a write-off under CO and a question under PI", () => {
  assert.equal(categorizeAdjustment("CO", "45"), "contractual");
  assert.equal(categorizeAdjustment("CO", "131"), "contractual");
  // PI is the payer's own decision rather than a contract term, so the same code is worth asking
  // about. Absorbing a payer-initiated reduction as though a contract required it is how a practice
  // writes off money nobody ever agreed to.
  assert.equal(categorizeAdjustment("PI", "45"), "recoverable");
});

test("correctable denials land in the recovery queue, which is what it is for", () => {
  for (const code of ["16", "97", "197", "151", "29", "A1"]) {
    assert.equal(categorizeAdjustment("CO", code), "recoverable", `CO-${code}`);
  }
});

// ── The table itself ─────────────────────────────────────────────────────────────────────────────

test("the reference table cannot express a patient charge at all", () => {
  /**
   * The structural half of the fix. `nature` says what a code is ABOUT; only the group decides whose
   * money it is, so there is no field left in which a future edit could write "this code means the
   * patient pays" and have it override a CO group again.
   */
  const natures = new Set(CARC_CODES.map((c) => c.nature));
  for (const nature of natures) {
    assert.ok(
      ["patient_share", "contractual", "correctable", "informational"].includes(nature),
      `unexpected nature "${nature}"`
    );
  }
  assert.equal(CARC_CODES.some((c) => "category" in c), false, "a code row must not carry a category");
});

test("every code is described, and unknown codes degrade to something readable", () => {
  for (const carc of CARC_CODES) {
    assert.equal(describeCarc(carc.code), carc.description);
    assert.ok(carc.description.length > 0);
  }
  assert.equal(describeCarc("99999"), "Reason code 99999");
  assert.equal(findCarc("  45  "), findCarc("45"), "lookup tolerates the whitespace a wire format brings");
});

test("group matching is case- and whitespace-insensitive, as wire data requires", () => {
  assert.equal(categorizeAdjustment(" pr ", "2"), "patient");
  assert.equal(categorizeAdjustment("Co", "45"), "contractual");
  assert.equal(categorizeAdjustment("co", "119"), "recoverable");
});
