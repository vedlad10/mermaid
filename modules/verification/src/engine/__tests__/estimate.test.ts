import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateCoverage } from "../estimate.ts";
import { cents, addCents, ZERO, type Benefits } from "@mermaid/shared";

const TODAY = new Date("2026-07-15T12:00:00");

function benefits(overrides: Partial<Benefits> = {}): Benefits {
  return {
    eligibility: "active",
    planName: "Delta Dental PPO",
    deductible: { individualAnnual: cents(50), remaining: cents(50), appliesTo: ["basic", "major"] },
    annualMaximum: { amount: cents(1500), used: ZERO, remaining: cents(1500) },
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
    ...overrides,
  };
}

// ── B2 — A DENIAL CARRIES ITS REASON, AND "UNKNOWN" IS NEVER "EXCLUDED" ────────────────────────
//
// `denied: true` was emitted identically whether the payer excluded the code, stated 0%, or never
// mentioned the category. Only the free-text note differed, and `analysis.ts` classified by matching
// substrings of that note — so the note whose own words are "this is an unknown, not an exclusion"
// was labelled `exclusion`, and the patient card said "the plan doesn't cover" about a category the
// payer had been silent on.

test("B2: each denial records WHY, and the six reasons are distinguishable", () => {
  const line = (b: Partial<Benefits>, code = "D2750", fee = cents(1250)) =>
    calculateCoverage([{ code, quantity: 1, fee }], benefits(b), TODAY).lines[0]!;

  // The payer named the code as excluded.
  assert.equal(line({ excludedCodes: ["D2750"] }).denialReason, "excluded");

  // The payer stated a percentage, and it was zero.
  assert.equal(line({ coveragePercentages: { major: 0 } }).denialReason, "zero-percent-stated");

  // The payer never mentioned major services at all — the 32dc3a29 case.
  assert.equal(line({ coveragePercentages: {} }).denialReason, "coverage-unknown");

  // Covered, but not yet.
  assert.equal(
    line({ waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-06-01" }] }).denialReason,
    "waiting-period"
  );

  // Covered, but the allowance is spent.
  assert.equal(
    line({ frequencyLimits: [{ codes: ["D1110"], limit: 2, used: 2, period: "calendar-year", description: "Cleanings 2 per year" }] }, "D1110", cents(110))
      .denialReason,
    "frequency-limit"
  );

  // Nothing is covered, because the policy is not active.
  assert.equal(line({ eligibility: "inactive" }).denialReason, "coverage-inactive");

  // Nothing is quoted as covered, because the payer never said whether the policy is live (D3).
  assert.equal(line({ eligibility: "unknown" }).denialReason, "eligibility-unknown");
});

test("D3: an unknown eligibility is its own reason, distinct from inactive AND from B2's unknown", () => {
  /**
   * Three facts that all end in a denied line, and the union has to keep them apart:
   *   • the payer SAID the policy is not active
   *   • the payer said nothing about the policy at all
   *   • the policy is live, but the payer said nothing about THIS category (B2)
   *
   * They lead somewhere different. The first is settled — find other coverage or collect. The other
   * two both mean ring the payer, but about different questions.
   */
  const line = (b: Partial<Benefits>) =>
    calculateCoverage([{ code: "D2750", quantity: 1, fee: cents(1250) }], benefits(b), TODAY).lines[0]!;

  const inactive = line({ eligibility: "inactive" });
  const unknownEligibility = line({ eligibility: "unknown" });
  const unknownCategory = line({ coveragePercentages: {} });

  assert.equal(inactive.denialReason, "coverage-inactive");
  assert.equal(unknownEligibility.denialReason, "eligibility-unknown");
  assert.equal(unknownCategory.denialReason, "coverage-unknown");
  assert.equal(
    new Set([inactive.denialReason, unknownEligibility.denialReason, unknownCategory.denialReason]).size,
    3,
    "three facts, three reasons"
  );

  // The arithmetic is deliberately identical — the fee is the patient's either way. Only the reason
  // and the sentence staff read differ, which is the entire fix.
  assert.equal(unknownEligibility.patientPays, inactive.patientPays);
  assert.equal(unknownEligibility.insurancePays, inactive.insurancePays);
  assert.notEqual(unknownEligibility.notes.join(" "), inactive.notes.join(" "));
  assert.match(unknownEligibility.notes.join(" "), /did not state whether this member's coverage is active/);
  assert.doesNotMatch(unknownEligibility.notes.join(" "), /Coverage is not active/);
});

test("B2: an unstated category is denied as UNKNOWN, not as an exclusion", () => {
  /**
   * The payer said nothing about major services. The line is still the patient's — promising
   * coverage nobody stated would be worse — but the REASON must not read as a plan exclusion.
   */
  const calc = calculateCoverage(
    [{ code: "D2750", quantity: 1, fee: cents(1250) }],
    benefits({ coveragePercentages: {} }),
    TODAY
  );
  const line = calc.lines[0]!;

  assert.equal(line.denied, true, "still the patient's — nothing is promised");
  assert.equal(line.denialReason, "coverage-unknown");
  assert.notEqual(line.denialReason, "excluded", "silence is not a refusal");
  assert.match(line.notes.join(" "), /unknown, not an exclusion/);
});

test("covers preventive at 100% with no deductible", () => {
  const calc = calculateCoverage([{ code: "D1110", quantity: 1, fee: cents(110) }], benefits(), TODAY);
  const line = calc.lines[0]!;
  assert.equal(line.deductibleApplied, 0);
  assert.equal(line.insurancePays, cents(110));
  assert.equal(line.patientPays, 0);
});

test("applies deductible then coverage percentage to basic services", () => {
  // $200 at 80% after a $50 deductible: insurance (200-50)*0.8 = 120; patient 80.
  const calc = calculateCoverage([{ code: "D2391", quantity: 1, fee: cents(200) }], benefits(), TODAY);
  const line = calc.lines[0]!;
  assert.equal(line.deductibleApplied, cents(50));
  assert.equal(line.insurancePays, cents(120));
  assert.equal(line.patientPays, cents(80));
});

test("only applies the deductible once across the plan", () => {
  const calc = calculateCoverage(
    [{ code: "D2391", quantity: 1, fee: cents(200) }, { code: "D2140", quantity: 1, fee: cents(100) }],
    benefits(),
    TODAY
  );
  assert.equal(calc.deductibleAppliedTotal, cents(50));
  assert.equal(calc.lines[1]!.deductibleApplied, 0);
  assert.equal(calc.lines[1]!.insurancePays, cents(80)); // 100 * 0.8
});

test("caps insurance payment at the remaining annual maximum", () => {
  const b = benefits({ annualMaximum: { amount: cents(1500), used: cents(1400), remaining: cents(100) } });
  const calc = calculateCoverage([{ code: "D2740", quantity: 1, fee: cents(1000) }], b, TODAY);
  const line = calc.lines[0]!;
  assert.equal(line.insurancePays, cents(100));
  assert.equal(line.patientPays, cents(900));
  assert.equal(calc.annualMaxRemainingAfter, 0);
});

test("denies major services still inside a waiting period", () => {
  const b = benefits({ waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-03-01" }] });
  const calc = calculateCoverage([{ code: "D2740", quantity: 1, fee: cents(1200) }], b, TODAY);
  const line = calc.lines[0]!;
  assert.equal(line.denied, true);
  assert.equal(line.patientPays, cents(1200));
  assert.match(line.notes.join(" "), /waiting period/);
});

/**
 * ── A PARTIAL MONTH IS NOT AN ELAPSED MONTH ────────────────────────────────────────────────────
 * `monthsBetween` subtracted month NUMBERS and ignored the day of the month entirely, so every
 * partial month counted as a whole one. A six-month waiting period beginning 2026-01-31 therefore
 * read as satisfied on 2026-07-01 — five months and one day — and the crown was quoted with
 * insurance paying half of it. The patient accepts treatment on that promise and the payer denies
 * the claim: the practice absorbs the difference, or re-bills someone it has already quoted.
 *
 * This is the direction that costs money. Denying a line that is in fact covered over-quotes, and
 * the patient is credited; promising coverage that is refused cannot be taken back.
 */
test("a waiting period is not satisfied by a partial final month", () => {
  const b = benefits({ waitingPeriods: [{ category: "major", months: 6, coverageEffectiveDate: "2026-01-31" }] });
  const crown = [{ code: "D2750", quantity: 1, fee: cents(1250) }];

  // Five months and ONE DAY after coverage began. The payer will not pay.
  const early = calculateCoverage(crown, b, new Date("2026-07-01T12:00:00Z")).lines[0]!;
  assert.equal(early.denied, true, "quoting coverage here is a promise the payer refuses");
  assert.equal(early.insurancePays, 0);
  assert.equal(early.patientPays, cents(1250));
  assert.deepEqual(early.denialDetail, { kind: "waiting-period", monthsRequired: 6, monthsElapsed: 5 });

  // …and on the anniversary itself it IS satisfied, so the guard has not simply become stricter.
  const onTime = calculateCoverage(crown, b, new Date("2026-07-31T12:00:00Z")).lines[0]!;
  assert.equal(onTime.denied, false, "the sixth month has genuinely elapsed");
  // ($1,250 − $50 deductible) × 50% major coverage.
  assert.equal(onTime.insurancePays, cents(600));
});

test("the waiting period is counted in the practice's day, not the host's", () => {
  const b = benefits({ waitingPeriods: [{ category: "major", months: 6, coverageEffectiveDate: "2026-02-01" }] });
  const crown = [{ code: "D2750", quantity: 1, fee: cents(1250) }];
  // 03:00Z on Aug 1 is still Jul 31 in Los Angeles — the day before the sixth month completes.
  const instant = new Date("2026-08-01T03:00:00Z");

  assert.equal(
    calculateCoverage(crown, b, instant, "America/Los_Angeles").lines[0]!.denied,
    true,
    "in the room where the patient is sitting it is still July"
  );
  assert.equal(
    calculateCoverage(crown, b, instant, "UTC").lines[0]!.denied,
    false,
    "and in UTC the same instant is August — which is why the zone must be stated, not inherited"
  );
});

test("denies units beyond a frequency limit", () => {
  const b = benefits({
    frequencyLimits: [{ codes: ["D1110"], limit: 2, period: "calendar-year", used: 2, description: "Prophylaxis limited to 2 per calendar year." }],
  });
  const calc = calculateCoverage([{ code: "D1110", quantity: 1, fee: cents(110) }], b, TODAY);
  assert.equal(calc.lines[0]!.denied, true);
  assert.match(calc.lines[0]!.notes.join(" "), /Frequency limit/i);
});

test("denies excluded codes", () => {
  const b = benefits({ excludedCodes: ["D8080"] });
  const calc = calculateCoverage([{ code: "D8080", quantity: 1, fee: cents(5500) }], b, TODAY);
  assert.equal(calc.lines[0]!.denied, true);
  assert.equal(calc.lines[0]!.patientPays, cents(5500));
});

test("puts the full fee on the patient when coverage is inactive", () => {
  const b = benefits({ eligibility: "inactive" });
  const calc = calculateCoverage([{ code: "D1110", quantity: 1, fee: cents(110) }], b, TODAY);
  assert.equal(calc.totalInsurancePays, 0);
  assert.equal(calc.totalPatientPays, cents(110));
});

test("treats unknown CDT codes as not covered instead of throwing", () => {
  const calc = calculateCoverage([{ code: "D9999", quantity: 1, fee: cents(300) }], benefits(), TODAY);
  assert.equal(calc.lines[0]!.denied, true);
  assert.equal(calc.lines[0]!.patientPays, cents(300));
});

test("falls back to the catalog typical fee when the clinic supplies none", () => {
  const calc = calculateCoverage([{ code: "D0120", quantity: 1 }], benefits(), TODAY); // D0120 typical $65, diagnostic 100%
  const line = calc.lines[0]!;
  assert.equal(line.fee, cents(65));
  assert.equal(line.insurancePays, cents(65));
  assert.equal(line.patientPays, 0);
});

test("totals reconcile exactly in integer cents — fee = insurance + patient, no float drift", () => {
  // Deliberately odd fees + a 50% category that would round mid-cent under floats.
  const calc = calculateCoverage(
    [
      { code: "D0120", quantity: 1, fee: cents(99.99) },
      { code: "D1110", quantity: 2, fee: cents(33.33) },
      { code: "D2740", quantity: 1, fee: cents(1000.01) },
      { code: "D2391", quantity: 3, fee: cents(11.11) },
    ],
    benefits(),
    TODAY
  );
  for (const l of calc.lines) {
    assert.equal(addCents(l.insurancePays, l.patientPays), l.fee, `line ${l.code} must reconcile`);
    assert.ok(Number.isInteger(l.insurancePays) && Number.isInteger(l.patientPays));
  }
  assert.equal(addCents(calc.totalInsurancePays, calc.totalPatientPays), calc.totalFee);
});

// ── M4 / M17 — a figure the payer did not state is not a favourable one ────────────────────────
//
// Both adapters coalesced a missing figure to `0` (`parsed.deductible.remaining ?? 0`), so a payer
// that stated an annual deductible and omitted the remaining balance — extremely common — was read
// as "the deductible is already met". The estimate applied none, the patient was quoted less than
// they owed, and the practice found out at the ERA as `PR-1 deductible`, after quoting someone.
//
// Same shape as the coverage-date defect: a legitimately nullable field, and a coalesce that made
// "we do not know" indistinguishable from a real value. Here it collapsed to the number that reads
// as good news.

test("M4: an unstated remaining deductible assumes the FULL annual amount is unmet", () => {
  /**
   * $200 basic at 80%, $50 annual deductible, remaining NOT stated.
   * Conservative: assume all $50 is still to be met → insurance (200-50)*0.8 = 120, patient 80.
   * The old behaviour applied no deductible → insurance 160, patient 40 — the patient under-quoted
   * by $40 on a single filling.
   */
  const calc = calculateCoverage(
    [{ code: "D2391", quantity: 1, fee: cents(200) }],
    benefits({ deductible: { individualAnnual: cents(50), remaining: null, appliesTo: ["basic", "major"] } }),
    TODAY
  );
  const line = calc.lines[0]!;

  assert.equal(line.deductibleApplied, cents(50), "the whole deductible is assumed unmet");
  assert.equal(line.insurancePays, cents(120));
  assert.equal(line.patientPays, cents(80));
  assert.notEqual(line.patientPays, cents(40), "the under-quote this fix exists to stop");
});

test("M4: the conservative assumption is stated on the line, not applied silently", () => {
  // Quoting conservatively without saying so is just a different invented number.
  const calc = calculateCoverage(
    [{ code: "D2391", quantity: 1, fee: cents(200) }],
    benefits({ deductible: { individualAnnual: cents(50), remaining: null, appliesTo: ["basic", "major"] } }),
    TODAY
  );
  const note = calc.lines[0]!.notes.join(" ");
  assert.match(note, /did not state how much/);
  assert.match(note, /assumed unmet/);
  assert.match(note, /Confirm with the payer/);
});

test("M4: a payer that stated NO deductible at all has none invented for it", () => {
  // There is nothing to assume FROM. Applying a made-up deductible would fabricate a number, which
  // is worse than the under-quote — an over-quote nobody can account for.
  const calc = calculateCoverage(
    [{ code: "D2391", quantity: 1, fee: cents(200) }],
    benefits({ deductible: { individualAnnual: null, remaining: null, appliesTo: ["basic", "major"] } }),
    TODAY
  );
  const line = calc.lines[0]!;
  assert.equal(line.deductibleApplied, ZERO);
  assert.equal(line.insurancePays, cents(160));
});

test("M4: a STATED zero remaining deductible still means met — silence and zero must stay distinct", () => {
  // The control. Conflating them the other way would start charging every fully-met deductible again.
  const calc = calculateCoverage(
    [{ code: "D2391", quantity: 1, fee: cents(200) }],
    benefits({ deductible: { individualAnnual: cents(50), remaining: ZERO, appliesTo: ["basic", "major"] } }),
    TODAY
  );
  assert.equal(calc.lines[0]!.deductibleApplied, ZERO, "the payer said it is met, so it is met");
  assert.equal(calc.lines[0]!.insurancePays, cents(160));
});

test("M4: an unstated annual maximum caps nothing, rather than capping everything at zero", () => {
  /**
   * `?? 0` made a payer that did not state a maximum produce an estimate where insurance paid
   * nothing on every line — shown to the patient as though the plan were exhausted. Conservative in
   * the cash direction, but a false statement about the plan, and it kills case acceptance on a fact
   * the payer never asserted.
   */
  const calc = calculateCoverage(
    [{ code: "D1110", quantity: 1, fee: cents(110) }],
    benefits({ annualMaximum: { amount: null, used: null, remaining: null } }),
    TODAY
  );
  const line = calc.lines[0]!;

  assert.equal(line.insurancePays, cents(110), "an unstated maximum is not an exhausted one");
  assert.equal(line.denied, false);
  assert.match(line.notes.join(" "), /did not state a remaining annual maximum/);
  assert.equal(calc.annualMaxRemainingAfter, null, "and the sentinel must never escape as a real figure");
});

test("M4: a STATED zero annual maximum still exhausts the plan", () => {
  // The control for the other direction.
  const calc = calculateCoverage(
    [{ code: "D1110", quantity: 1, fee: cents(110) }],
    benefits({ annualMaximum: { amount: cents(1500), used: cents(1500), remaining: ZERO } }),
    TODAY
  );
  assert.equal(calc.lines[0]!.insurancePays, ZERO);
  assert.equal(calc.annualMaxRemainingAfter, ZERO);
});

test("M17: a category the payer never mentioned is an UNKNOWN, not a plan exclusion", () => {
  /**
   * `{ ...EMPTY_PERCENTAGES, ...parsed }` filled every unmentioned category with 0, and the estimate
   * denied the line saying "The plan covers 0% of major services." That is an assertion about the
   * plan that Mermaid invented — and a patient declines a crown on the strength of it.
   *
   * The line is still denied: promising coverage nobody stated would be worse. Only the reason
   * changes, and the reason is what a person repeats to the patient.
   */
  const calc = calculateCoverage(
    [{ code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) }],
    benefits({ coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, orthodontic: 0 } }),
    TODAY
  );
  const line = calc.lines[0]!;

  assert.equal(line.denied, true, "still quoted as the patient's — an unknown may not become a promise");
  assert.equal(line.patientPays, cents(1250));
  const note = line.notes.join(" ");
  assert.match(note, /did not state what this plan covers/);
  assert.match(note, /unknown, not an exclusion/);
  assert.doesNotMatch(note, /covers 0%/, "Mermaid must not assert a percentage the payer never gave");
});

test("M17: a payer that DID state 0% is reported as the exclusion it is", () => {
  // The control. Orthodontic is explicitly 0 in the fixture — a real plan term, and it must keep
  // reading as one.
  const calc = calculateCoverage([{ code: "D8080", quantity: 1, fee: cents(5000) }], benefits(), TODAY);
  const note = calc.lines[0]!.notes.join(" ");
  assert.match(note, /covers 0% of orthodontic services/);
  assert.doesNotMatch(note, /did not state/);
});

test("a rate the payer listed for the CODE beats the category's blended one", () => {
  /**
   * Cigna's live 271 states restorative at 90% for fillings and 60% for inlays and onlays, and lists
   * the codes for each. The category alone can only carry the lower (60%), so without the per-code
   * rate a patient having a $200 composite filling was quoted $80 instead of $20.
   */
  const fill = (b: Partial<Benefits>) =>
    calculateCoverage(
      [{ code: "D2391", quantity: 1, toothNumber: "30", fee: cents(200) }],
      benefits({ deductible: { individualAnnual: cents(50), remaining: ZERO, appliesTo: ["basic", "major"] }, ...b }),
      TODAY
    ).lines[0]!;

  const perCode = fill({ coveragePercentages: { basic: 60 }, procedureCoveragePercentages: { D2391: 90 } });
  assert.equal(perCode.coveragePercent, 90);
  assert.equal(perCode.insurancePays, cents(180));
  assert.equal(perCode.patientPays, cents(20));

  // A code the payer did not list still falls back to the category, exactly as before.
  const unlisted = fill({ coveragePercentages: { basic: 60 }, procedureCoveragePercentages: { D2140: 90 } });
  assert.equal(unlisted.coveragePercent, 60);
  assert.equal(unlisted.patientPays, cents(80));
});
