/**
 * Reviewing a verification settles the WORKFLOW. It does not settle the COVERAGE.
 *
 * ── WHAT THE LIVE SCREEN SAID ──────────────────────────────────────────────────────────────────
 * Ben Demo. Delta Dental reports his coverage INACTIVE. His claim carries a blocking scrub finding
 * and reads "Do not file. Re-verify coverage, or collect from the patient directly." He owes the
 * full $175.00 with no insurance at all.
 *
 * His VERIFICATION screen — the one a front desk reads before he sits in the chair — said:
 *
 *   status                "reviewed"
 *   recommended action    "No action needed — this case is closed."
 *
 * The `complete` branch returned early for anything that was not active-with-an-estimate, so the
 * sentence written for inactive coverage two branches below became unreachable the moment a human
 * marked the case reviewed. A coordinator doing exactly the right thing is what silenced the
 * warning, and the screen then told the front desk there was nothing to know.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { decideVerification } from "../engine/decision.ts";
import type { VerificationRecord } from "../types.ts";

const record = (over: Record<string, unknown>): VerificationRecord =>
  ({
    id: "v1",
    status: "reviewed",
    createdAt: "2026-08-28T04:40:05.622Z",
    verifiedAt: "2026-08-28T04:40:05.622Z",
    patient: { firstName: "Ben", lastName: "Demo", dateOfBirth: "1979-11-02", memberId: "DEMO0100", address: null },
    card: { payerName: { value: "Delta Dental", confidence: 0.95 }, memberId: { value: "DEMO0100", confidence: 0.9 } },
    confidence: { overall: 0.82, components: [], reviewThreshold: 0.75 },
    exceptions: [],
    benefits: null,
    calculation: null,
    provenance: { kind: "mock", dataSource: "mock" },
    ...over,
  }) as unknown as VerificationRecord;

const ACTIVE_BENEFITS = {
  eligibility: "active",
  planName: "Dental PPO",
  payerName: "Delta Dental",
  deductible: { individualAnnual: cents(50), remaining: cents(0), appliesTo: [] },
  annualMaximum: { amount: cents(1500), used: cents(0), remaining: cents(1500) },
  coveragePercentages: { diagnostic: 100 },
  waitingPeriods: [],
  frequencyLimits: [],
  exclusions: [],
  excludedCodes: [],
  coverage: { effectiveDate: null, terminationDate: null },
};

const CALC = { lines: [], totalFee: cents(175), totalPatientPays: cents(0), totalInsurancePays: cents(175) };

test("a REVIEWED inactive-coverage case still says the coverage is not active", () => {
  /** THE ASSERTION THIS FILE EXISTS FOR. */
  const d = decideVerification(
    record({
      benefits: { ...ACTIVE_BENEFITS, eligibility: "inactive" },
      calculation: CALC,
      exceptions: [{ code: "inactive-coverage", severity: "critical", message: "Coverage is not active." }],
    })
  );

  assert.equal(d.outcome, "complete", "the workflow IS complete — that part was never wrong");
  assert.ok(
    !/^No action needed/.test(d.recommendedAction),
    `a front desk must not be told there is nothing to know: ${d.recommendedAction}`
  );
  assert.match(d.recommendedAction, /NOT ACTIVE/);
  assert.match(d.recommendedAction, /pays in full/, "and what that means for the money");
  assert.match(d.recommendedAction, /do not file/i, "and what not to do");
});

test("a reviewed case with no benefits at all is BLOCKED, not complete", () => {
  /**
   * Verified rather than assumed: a record with no benefits never reaches the `complete` branch at
   * all, whatever its status, so the manual-verification instruction has always been correct here.
   * Asserted so a future refactor of `outcome` cannot quietly route it into "case closed".
   */
  const d = decideVerification(record({ status: "reviewed", benefits: null }));
  assert.equal(d.outcome, "blocked");
  assert.ok(!/^No action needed/.test(d.recommendedAction), d.recommendedAction);
  assert.match(d.recommendedAction, /Verify manually with Delta Dental/);
});

test("a reviewed case where the payer never stated eligibility says to confirm", () => {
  const d = decideVerification(
    record({
      benefits: { ...ACTIVE_BENEFITS, eligibility: "unknown" },
      calculation: CALC,
      exceptions: [{ code: "eligibility-unknown", severity: "critical", message: "Not stated." }],
    })
  );
  assert.ok(!/^No action needed/.test(d.recommendedAction), d.recommendedAction);
  assert.match(d.recommendedAction, /did not state/);
});

test("an exhausted annual maximum is named even though the estimate is ready", () => {
  /**
   * The estimate is correct and quotable, so this is not a warning state — but it happens to be
   * almost entirely the patient's, and a front desk reading only "ready to share" walks into that
   * conversation without knowing it is coming.
   */
  const d = decideVerification(
    record({
      benefits: { ...ACTIVE_BENEFITS, annualMaximum: { amount: cents(1500), used: cents(1500), remaining: cents(0) } },
      calculation: CALC,
      exceptions: [{ code: "annual-max-exhausted", severity: "warning", message: "Nothing left." }],
    })
  );
  assert.match(d.recommendedAction, /ready to share/, "the estimate is genuinely usable");
  assert.match(d.recommendedAction, /no annual-maximum benefits remain/i);
  assert.match(d.recommendedAction, /Say so before treatment/);
});

test("an ordinary active case is unchanged — no new warning where none is warranted", () => {
  /**
   * The other half. A screen that warns on every case is one staff learn to scroll past, and the
   * value of the sentences above depends entirely on their being rare.
   */
  const d = decideVerification(record({ benefits: ACTIVE_BENEFITS, calculation: CALC }));
  assert.equal(d.recommendedAction, "No action needed — the estimate is ready to share with the patient.");
});

test("an unreviewed inactive case still reads the way it always did", () => {
  const d = decideVerification(
    record({
      status: "needs_review",
      benefits: { ...ACTIVE_BENEFITS, eligibility: "inactive" },
      calculation: CALC,
      exceptions: [{ code: "inactive-coverage", severity: "critical", message: "Coverage is not active." }],
    })
  );
  assert.equal(d.outcome, "needs_human");
  assert.match(d.recommendedAction, /Contact the patient before the visit/);
});
