import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretCardText, cardConfidence } from "../ocr.ts";
import { identifyPayer } from "../payer.ts";
import { validatePatient, detectExceptions, routeForReview, aggregateConfidence } from "../analysis.ts";
import { verificationFreshness } from "../freshness.ts";
import { calculateCoverage } from "../estimate.ts";
import { plainEnglishEstimate } from "../summary.ts";
import { cents, ZERO, type Benefits } from "@mermaid/shared";
import type { PatientInfo } from "../../types.ts";

// ── OCR ──────────────────────────────────────────────────────────────────────
test("interpretCardText extracts payer, member ID, group from labeled card text", () => {
  const card = interpretCardText("Delta Dental\nMember ID: ABC12345\nGroup #: GRP100\nEffective: 2025-01-01");
  assert.equal(card.payerName.value, "Delta Dental");
  assert.ok(card.payerName.confidence > 0.9);
  assert.equal(card.memberId.value, "ABC12345");
  assert.equal(card.groupNumber.value, "GRP100");
  assert.equal(card.effectiveDate.value, "2025-01-01");
  assert.ok(cardConfidence(card) > 0.7);
});

test("interpretCardText degrades gracefully on an unknown payer (first line, low confidence)", () => {
  const card = interpretCardText("Obscure Plan Co\nMember ID: ZZ998877");
  assert.equal(card.payerName.value, "Obscure Plan Co");
  assert.ok(card.payerName.confidence < 0.5);
});

// ── Payer identification ──────────────────────────────────────────────────────
test("identifyPayer maps known payers and flags unknown ones", () => {
  const delta = identifyPayer("Delta Dental");
  assert.equal(delta.value?.payerId, "delta-dental");
  assert.ok(delta.confidence > 0.9);
  assert.equal(identifyPayer("Obscure Plan Co").value, null);
  assert.equal(identifyPayer(null).confidence, 0);
});

// ── Patient validation ────────────────────────────────────────────────────────
const patient = (o: Partial<PatientInfo> = {}): PatientInfo => ({
  firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: "ABC12345", ...o,
});

test("validatePatient flags missing names, bad DOB, short member ID", () => {
  assert.equal(validatePatient(patient()).length, 0);
  assert.ok(validatePatient(patient({ firstName: "" })).some((f) => f.severity === "critical"));
  assert.ok(validatePatient(patient({ dateOfBirth: "not-a-date" })).some((f) => f.code === "data-validation"));
  assert.ok(validatePatient(patient({ memberId: "12" })).some((f) => f.severity === "warning"));
});

test("detectExceptions raises unknown-payer when benefits are absent", () => {
  const card = interpretCardText("Delta Dental\nMember ID: ABC12345");
  const flags = detectExceptions(card, patient(), null, null);
  assert.ok(flags.some((f) => f.code === "unknown-payer" && f.severity === "critical"));
});

/**
 * ── B2 GUARD — SILENCE IS NEVER REPORTED AS A REFUSAL ─────────────────────────────────────────
 *
 * The whole chain, driven end to end: a payer that stated nothing about major services must not
 * produce an `exclusion` flag for the biller, and must not produce "the plan doesn't cover" on the
 * card a patient is read from. Both used to happen, because `denied` was a bare boolean and the
 * classifier matched the note's text — including a note that says "this is an unknown, not an
 * exclusion".
 */
test("B2 GUARD: an unstated category never yields `exclusion` or the doesn't-cover sentence", () => {
  const card = interpretCardText("Delta Dental\nMember ID: ABC12345");
  const silentOnMajor: Benefits = {
    eligibility: "active",
    planName: "Delta Dental PPO",
    payerName: "Delta Dental",
    deductible: { individualAnnual: ZERO, remaining: ZERO, appliesTo: [] },
    annualMaximum: { amount: cents(1500), used: ZERO, remaining: cents(1500) },
    // The 32dc3a29 shape: active coverage, and not one word about what is covered.
    coveragePercentages: {},
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
  };
  const calc = calculateCoverage([{ code: "D2750", quantity: 1, fee: cents(1250) }], silentOnMajor, new Date("2026-07-15T12:00:00"));

  // Biller-facing: a distinct code, never `exclusion`.
  const flags = detectExceptions(card, patient(), silentOnMajor, calc);
  const perLine = flags.filter((f) => f.message.includes("D2750"));
  assert.ok(perLine.length > 0, "the line must still be flagged for a human");
  assert.ok(
    perLine.every((f) => f.code !== "exclusion"),
    "an unstated category must never be labelled an exclusion"
  );
  assert.ok(perLine.some((f) => f.code === "coverage-unknown"));

  // Patient-facing: the plan-exclusion sentence must not appear.
  const record = {
    calculation: calc,
    benefits: silentOnMajor,
  } as unknown as Parameters<typeof plainEnglishEstimate>[0];
  const prose = plainEnglishEstimate(record).join(" ");
  assert.doesNotMatch(prose, /the plan doesn't cover/, "silence must not be read to a patient as a refusal");
  assert.match(prose, /don't yet have information from your plan/);
});

test("routeForReview holds a case with a critical exception, passes a clean high-confidence one", () => {
  const clean = aggregateConfidence([{ name: "x", confidence: 0.9, explanation: "" }]);
  assert.equal(routeForReview(clean, []).needsReview, false);
  assert.equal(routeForReview(clean, [{ severity: "critical", code: "inactive-coverage", message: "" }]).needsReview, true);
  const weak = aggregateConfidence([{ name: "x", confidence: 0.4, explanation: "" }]);
  assert.equal(routeForReview(weak, []).needsReview, true);
});

// ── Freshness ─────────────────────────────────────────────────────────────────
test("verificationFreshness: fresh → aging → expired, and the UTC plan-year boundary", () => {
  assert.equal(verificationFreshness("2026-07-01T12:00:00Z", new Date("2026-07-05T12:00:00Z")).status, "fresh");
  assert.equal(verificationFreshness("2026-07-01T12:00:00Z", new Date("2026-07-28T12:00:00Z")).status, "aging");
  assert.equal(verificationFreshness("2026-07-01T12:00:00Z", new Date("2026-08-15T12:00:00Z")).status, "expired");

  const planYear = verificationFreshness("2026-12-20T12:00:00Z", new Date("2026-12-21T12:00:00Z"));
  assert.equal(planYear.expiresAt.slice(0, 10), "2027-01-01");
  assert.match(planYear.reason, /Plan-year/);
});

// ── D2 — the two covered-but-not-now reasons leave the "doesn't cover" sentence ────────────────
//
// A waiting period and a spent frequency allowance are benefits the plan DOES cover. Counting them
// into "N procedures the plan doesn't cover" states something false about the plan, and a patient
// declines treatment they could have had by waiting, or by rebooking inside the allowance.
//
// The mock adapter cannot reach `zero-percent-stated` (its only 0% category is orthodontic, whose
// single catalogued code is also on the excluded list), so the two refusal reasons are pinned here,
// against the engine, where both are reachable — see `pipeline.test.ts` for the realistic cases.

function d2Benefits(overrides: Partial<Benefits> = {}): Benefits {
  return {
    eligibility: "active",
    planName: "Delta Dental PPO",
    payerName: "Delta Dental",
    deductible: { individualAnnual: ZERO, remaining: ZERO, appliesTo: [] },
    annualMaximum: { amount: cents(1500), used: ZERO, remaining: cents(1500) },
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
    ...overrides,
  };
}

const asRecord = (calc: ReturnType<typeof calculateCoverage>, b: Benefits) =>
  ({ calculation: calc, benefits: b }) as unknown as Parameters<typeof plainEnglishEstimate>[0];

test("D2: a stated 0% and a named exclusion are still 'the plan doesn't cover'", () => {
  const today = new Date("2026-07-15T12:00:00");

  const statedZero = d2Benefits({ coveragePercentages: { major: 0 } });
  const zeroCalc = calculateCoverage([{ code: "D2750", quantity: 1, fee: cents(1250) }], statedZero, today);
  assert.equal(zeroCalc.lines[0]!.denialReason, "zero-percent-stated");
  assert.equal(zeroCalc.lines[0]!.denialDetail, undefined, "a refusal has no figures to quantify");
  assert.match(plainEnglishEstimate(asRecord(zeroCalc, statedZero)).join(" "), /the plan doesn't cover/);

  const excludes = d2Benefits({ excludedCodes: ["D2750"] });
  const exclCalc = calculateCoverage([{ code: "D2750", quantity: 1, fee: cents(1250) }], excludes, today);
  assert.equal(exclCalc.lines[0]!.denialReason, "excluded");
  assert.equal(exclCalc.lines[0]!.denialDetail, undefined);
  assert.match(plainEnglishEstimate(asRecord(exclCalc, excludes)).join(" "), /the plan doesn't cover/);
});

test("D2: a waiting period and a spent allowance are counted apart from both of them", () => {
  const today = new Date("2026-07-15T12:00:00");

  const waiting = d2Benefits({
    waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-04-15" }],
  });
  const waitCalc = calculateCoverage([{ code: "D2750", quantity: 1, fee: cents(1250) }], waiting, today);
  const waitProse = plainEnglishEstimate(asRecord(waitCalc, waiting)).join(" ");
  assert.equal(waitCalc.lines[0]!.denialReason, "waiting-period");
  assert.doesNotMatch(waitProse, /the plan doesn't cover/, "the plan does cover this — just not yet");
  assert.match(waitProse, /coverage should begin once 9 more month\(s\) have passed/);

  const spent = d2Benefits({
    frequencyLimits: [
      { codes: ["D1110"], limit: 2, used: 2, period: "calendar-year", description: "Cleanings 2 per year" },
    ],
  });
  const spentCalc = calculateCoverage([{ code: "D1110", quantity: 1, fee: cents(110) }], spent, today);
  const spentProse = plainEnglishEstimate(asRecord(spentCalc, spent)).join(" ");
  assert.equal(spentCalc.lines[0]!.denialReason, "frequency-limit");
  assert.doesNotMatch(spentProse, /the plan doesn't cover/, "the plan does cover this — just not again yet");
  assert.match(spentProse, /This plan covers Cleanings 2 per year, but you've already used/);
  assert.match(spentProse, /\(2 of 2\) for this benefit period/);
});

test("D2: the count reported to a patient is what the allowance actually consumed", () => {
  /**
   * `FrequencyLimit.used` is what the PAYER reported. When this same treatment plan spends the
   * remainder, the denied line's true figure is that plus what the plan itself took — quoting
   * `used` alone would render "1 of 2" on a line that is entirely the patient's, which reads as a
   * contradiction and invites a patient to book the visit they have just been denied.
   */
  const today = new Date("2026-07-15T12:00:00");
  const oneLeft = d2Benefits({
    frequencyLimits: [
      { codes: ["D1110"], limit: 2, used: 1, period: "calendar-year", description: "Cleanings 2 per year" },
    ],
  });

  // Two cleanings planned, one of the two allowed already used: the first is covered, the second is
  // the patient's — and by then the allowance stands at 2 of 2, not 1 of 2.
  const calc = calculateCoverage(
    [
      { code: "D1110", quantity: 1, fee: cents(110) },
      { code: "D1110", quantity: 1, fee: cents(110) },
    ],
    oneLeft,
    today
  );

  const deniedLine = calc.lines.find((l) => l.denied)!;
  assert.equal(deniedLine.denialReason, "frequency-limit");
  assert.deepEqual(deniedLine.denialDetail, {
    kind: "frequency-limit",
    used: 2,
    limit: 2,
    description: "Cleanings 2 per year",
  });
  assert.match(plainEnglishEstimate(asRecord(calc, oneLeft)).join(" "), /\(2 of 2\) for this benefit period/);
});
