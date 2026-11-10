/**
 * "Active" and "in force on the day we treated them" are different questions.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * `Benefits.eligibility` is the payer's answer as of the instant it replied. A claim is about a DATE
 * OF SERVICE. Those disagree constantly — a patient seen on the 20th whose plan ended on the 5th
 * gets a perfectly ACTIVE 271 today — and until `Benefits.coverage` existed there was nowhere in the
 * model to put the difference. `parse271` discarded the DTP segments the payer sent, so Mermaid
 * verified the patient, priced the plan, quoted them, and filed a claim the payer was always going
 * to refuse, with nothing on any screen suggesting the coverage window had been checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Benefits } from "@mermaid/shared";
import { detectExceptions } from "../analysis.ts";
import type { InsuranceCardData, PatientInfo } from "../../types.ts";

const patient: PatientInfo = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" };
const field = (value: string | null) => ({ value, confidence: 0.9, source: "ocr" as const, explanation: "" });
const card: InsuranceCardData = {
  payerName: field("Delta Dental"), memberId: field("ABC12345"), groupNumber: field(null),
  planName: field(null), subscriberName: field(null), effectiveDate: field(null),
};

const benefits = (coverage?: Benefits["coverage"]): Benefits => ({
  eligibility: "active",
  payerName: "Delta Dental",
  planName: "PPO",
  deductible: { individualAnnual: cents(50), remaining: cents(0), appliesTo: ["basic", "major"] },
  annualMaximum: { amount: cents(1500), used: cents(0), remaining: cents(1500) },
  coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
  waitingPeriods: [], frequencyLimits: [], exclusions: [], excludedCodes: [],
  ...(coverage ? { coverage } : {}),
});

const codes = (b: Benefits, serviceDate?: string): string[] =>
  detectExceptions(card, patient, b, null, serviceDate).map((f) => f.code);

test("a policy that ended before the date of service is CRITICAL, even though the payer says active", () => {
  const flags = detectExceptions(
    card, patient,
    benefits({ effectiveDate: "2025-01-01", terminationDate: "2026-08-05" }),
    null,
    "2026-08-20"
  );
  const terminated = flags.find((f) => f.code === "coverage-terminated");
  assert.ok(terminated, "a claim for a day outside the coverage window must not pass silently");
  assert.equal(terminated!.severity, "critical", "this is not a confidence problem to be averaged away");
  assert.match(terminated!.message, /2026-08-05/);
  assert.match(terminated!.message, /2026-08-20/);
});

test("treatment before the policy started is caught too", () => {
  assert.ok(
    codes(benefits({ effectiveDate: "2026-09-01", terminationDate: null }), "2026-08-20").includes(
      "coverage-not-yet-effective"
    )
  );
});

test("a date of service inside the window raises nothing", () => {
  const inside = codes(benefits({ effectiveDate: "2026-01-01", terminationDate: "2026-12-31" }), "2026-08-20");
  assert.equal(inside.includes("coverage-terminated"), false);
  assert.equal(inside.includes("coverage-not-yet-effective"), false);
});

test("the boundary days are INSIDE the window — a plan is in force on the day it ends", () => {
  const window = { effectiveDate: "2026-01-01", terminationDate: "2026-12-31" };
  for (const day of ["2026-01-01", "2026-12-31"]) {
    const flags = codes(benefits(window), day);
    assert.equal(flags.includes("coverage-terminated"), false, `${day} must be covered`);
    assert.equal(flags.includes("coverage-not-yet-effective"), false, `${day} must be covered`);
  }
  // And one day past each edge is not.
  assert.ok(codes(benefits(window), "2027-01-01").includes("coverage-terminated"));
  assert.ok(codes(benefits(window), "2025-12-31").includes("coverage-not-yet-effective"));
});

test("a payer that states no window is not treated as unlimited coverage — it raises nothing either", () => {
  /**
   * The safe reading of silence. Most payers omit DTP entirely, and every record written before this
   * field existed has none. Absent must mean "not stated": inventing a window would flag healthy
   * claims, and inventing permission would defeat the check. It raises nothing, and the fact that
   * nothing was stated is visible on the record rather than resolved here.
   */
  assert.deepEqual(codes(benefits(undefined), "2026-08-20").filter((c) => c.startsWith("coverage-")), []);
  assert.deepEqual(
    codes(benefits({ effectiveDate: null, terminationDate: null }), "2026-08-20").filter((c) => c.startsWith("coverage-")),
    []
  );
});

test("without a date of service there is nothing to compare, and nothing is claimed", () => {
  assert.deepEqual(
    codes(benefits({ effectiveDate: "2026-01-01", terminationDate: "2026-08-05" })).filter((c) => c.startsWith("coverage-")),
    [],
    "no service date means the window cannot be checked — it must not be guessed either way"
  );
});

test("a terminated window and an inactive eligibility are reported as two separate facts", () => {
  // They have different remedies: one is "this policy is dead", the other is "this policy was alive,
  // just not on that day". Collapsing them would lose the date the biller needs to act on.
  const b = { ...benefits({ effectiveDate: "2025-01-01", terminationDate: "2026-08-05" }), eligibility: "inactive" as const };
  const flags = codes(b, "2026-08-20");
  assert.ok(flags.includes("inactive-coverage"));
  assert.ok(flags.includes("coverage-terminated"));
});

// ── M18 / M4 — silence is not a refusal, and it is not a zero ─────────────────────────────────

test("M18: an UNKNOWN eligibility is not reported as the payer saying 'not active'", () => {
  /**
   * `eligibility !== "active"` raised `inactive-coverage` with the message "The payer reports this
   * member's coverage as not active" — for `unknown`, where the payer reported nothing at all.
   *
   * Both route to a human, and that was already right. The message is what the person acts on, and
   * the two lead somewhere different: inactive means find other coverage or collect from the
   * patient; unknown means ring the payer, because the coverage may be perfectly good. Telling a
   * practice a plan is dead when nobody said so loses a case that would have been paid.
   */
  const unknown = { ...benefits(), eligibility: "unknown" as const };
  const flags = detectExceptions(card, patient, unknown, null);

  const flag = flags.find((f) => f.code === "eligibility-unknown");
  assert.ok(flag, "an unknown must be reported as an unknown");
  assert.equal(flag!.severity, "critical", "it still routes to a human — only the sentence changed");
  assert.match(flag!.message, /did not state/);
  assert.match(flag!.message, /UNKNOWN, not a refusal/);
  assert.ok(
    !flags.some((f) => f.code === "inactive-coverage"),
    "the payer did not report the coverage inactive, so Mermaid must not say it did"
  );
});

test("M18: a genuinely INACTIVE eligibility still reports as inactive", () => {
  // The control — the distinction must not have flattened the other way.
  const flags = detectExceptions(card, patient, { ...benefits(), eligibility: "inactive" }, null);
  assert.ok(flags.some((f) => f.code === "inactive-coverage"));
  assert.ok(!flags.some((f) => f.code === "eligibility-unknown"));
});

test("M4: an unstated annual maximum is an UNKNOWN, not an exhausted plan", () => {
  const b = { ...benefits(), annualMaximum: { amount: null, used: null, remaining: null } };
  const flags = detectExceptions(card, patient, b, null);

  const flag = flags.find((f) => f.code === "annual-max-unknown");
  assert.ok(flag, "the payer said nothing; that is not the same as saying zero");
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /did not state/);
  assert.ok(
    !flags.some((f) => f.code === "annual-max-exhausted"),
    "'no benefits remain this year' is a statement about the plan the payer never made"
  );
});

test("M4: a genuinely exhausted annual maximum still reports as exhausted", () => {
  // The control.
  const b = { ...benefits(), annualMaximum: { amount: cents(1500), used: cents(1500), remaining: cents(0) } };
  const flags = detectExceptions(card, patient, b, null);
  assert.ok(flags.some((f) => f.code === "annual-max-exhausted"));
  assert.ok(!flags.some((f) => f.code === "annual-max-unknown"));
});

test("M4: an unstated remaining deductible says which way the estimate erred", () => {
  /**
   * The estimate quotes conservatively — it assumes the whole annual deductible is unmet — and that
   * assumption sits directly on what the patient is told they owe. Quoting conservatively without
   * saying so is just a different invented number, so the flag names the DIRECTION of the error.
   */
  const b: Benefits = {
    ...benefits(),
    deductible: { individualAnnual: cents(50), remaining: null, appliesTo: ["basic", "major"] },
  };
  const flag = detectExceptions(card, patient, b, null).find((f) => f.code === "deductible-unknown");

  assert.ok(flag);
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /assumes ALL of it is unmet/);
  assert.match(flag!.message, /may be overstated/, "a biller must know which way to check");
});

test("M4: no deductible stated at all errs the OTHER way, and says so", () => {
  // Nothing to assume from, so none is applied — which understates the patient's share rather than
  // overstating it. Opposite direction, opposite warning.
  const b = { ...benefits(), deductible: { individualAnnual: null, remaining: null, appliesTo: [] } };
  const flag = detectExceptions(card, patient, b, null).find((f) => f.code === "deductible-unknown");

  assert.ok(flag);
  assert.match(flag!.message, /stated no deductible at all/);
  assert.match(flag!.message, /may be understated/);
});

test("M17: a category the payer never mentioned is flagged as unknown, not as an exclusion", () => {
  const b = {
    ...benefits(),
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, orthodontic: 0 },
  };
  const flag = detectExceptions(card, patient, b, null).find((f) => f.code === "coverage-percent-unknown");

  assert.ok(flag, "silence about major services must be visible");
  assert.match(flag!.message, /major/);
  assert.match(flag!.message, /not a plan exclusion/);
});

test("M4/M17: a fully-stated 271 raises none of these — they must not fire on good data", () => {
  // The control for the whole group. A rule that fires on everything is not a rule.
  const flags = detectExceptions(card, patient, benefits(), null).map((f) => f.code);
  for (const code of ["eligibility-unknown", "annual-max-unknown", "deductible-unknown", "coverage-percent-unknown"]) {
    assert.ok(!flags.includes(code as never), `${code} must not fire when the payer stated everything`);
  }
});
