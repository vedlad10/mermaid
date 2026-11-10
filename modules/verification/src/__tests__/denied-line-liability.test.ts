/**
 * What a DENIED line costs the patient when a contracted fee schedule exists (L-3).
 *
 * ── THE QUESTION ───────────────────────────────────────────────────────────────────────────────
 * A procedure is denied and the payer has a contracted rate with this practice. Does the patient owe
 * the billed fee or the contracted allowance? Asked as one question it has no correct answer. Asked
 * per line, against the reason the PAYER gave, it does — and the reason is already recorded.
 *
 * ── WHAT THE ANSWER RESTS ON ───────────────────────────────────────────────────────────────────
 * Group CO in an 835 is DEFINED as the amount a participating provider may not bill the patient —
 * the HIPAA code set's meaning, not a contract term. And a learned allowance exists only because
 * that payer applied a CO write-off to that code for this practice, so its presence is evidence the
 * procedure sits inside the fee schedule. A participating agreement prices a covered procedure at
 * the allowed amount whether or not the plan paid on this claim: the benefit decides who pays, the
 * contract decides how much.
 *
 * So the cap applies where the plan COVERS the procedure and is refusing this instance of it, and
 * does not apply where there is no covered benefit to price against.
 *
 * ── EVERY EXPECTED FIGURE BELOW IS COMPUTED BY HAND ────────────────────────────────────────────
 * Stated as arithmetic in the comment above each assertion, never derived from the engine. A test
 * that recomputed the rule would agree with a wrong implementation.
 *
 * The crown: billed $1,250.00, contracted allowance $1,000.00, so the write-off is $250.00.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, contractCapsPatientLiability, ZERO, type Benefits, type Cents } from "@mermaid/shared";
import { calculateCoverage } from "../engine/estimate.ts";

const TODAY = new Date("2026-08-31T12:00:00Z");
const CROWN = [{ code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" }];
const ALLOWED = (code: string): Cents | null => (code === "D2750" ? cents(1000) : null);
const NO_SCHEDULE = (): Cents | null => null;

function benefits(overrides: Partial<Benefits> = {}): Benefits {
  return {
    eligibility: "active",
    planName: "Delta Dental PPO",
    deductible: { individualAnnual: cents(50), remaining: ZERO, appliesTo: ["basic", "major"] },
    annualMaximum: { amount: cents(2000), used: ZERO, remaining: cents(2000) },
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
    ...overrides,
  };
}

const line = (b: Benefits, allowed = ALLOWED) => calculateCoverage(CROWN, b, TODAY, "UTC", allowed).lines[0]!;

// ── The rule itself, stated once ──────────────────────────────────────────────────────────────

test("the contract caps a denial that is a benefit limit, and not one that is an absence of cover", () => {
  for (const reason of ["waiting-period", "frequency-limit", "zero-percent-stated"] as const) {
    assert.equal(contractCapsPatientLiability(reason), true, `${reason} is a covered procedure the plan refused`);
  }
  for (const reason of ["coverage-inactive", "eligibility-unknown", "coverage-unknown", "excluded"] as const) {
    assert.equal(contractCapsPatientLiability(reason), false, `${reason} has no covered benefit to price`);
  }
  assert.equal(contractCapsPatientLiability(undefined), false, "an unrecorded reason must not quote the lower figure");
});

// ── Denied because the plan covers it but not yet / not again / not at all this year ───────────

test("a waiting-period denial is quoted at the contracted allowance", () => {
  /**
   * The plan covers crowns; the member has not waited long enough. The contract still prices the
   * crown, so the patient owes $1,000.00 and $250.00 is written off — not $1,250.00.
   */
  const l = line(
    benefits({ waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-06-01" }] })
  );
  assert.equal(l.denied, true);
  assert.equal(l.denialReason, "waiting-period");
  assert.equal(l.patientPays, cents(1000), "the contracted allowance");
  assert.equal(l.contractualWriteOff, cents(250), "1250.00 − 1000.00");
  assert.equal(l.insurancePays, ZERO, "the plan pays nothing — that is what denied means");
});

test("a frequency-limit denial is quoted at the contracted allowance", () => {
  const l = line(
    benefits({
      frequencyLimits: [
        { codes: ["D2750"], limit: 1, period: "36-months", used: 1, description: "one crown per tooth per 5 years" },
      ],
    })
  );
  assert.equal(l.denialReason, "frequency-limit");
  assert.equal(l.patientPays, cents(1000));
  assert.equal(l.contractualWriteOff, cents(250));
});

test("a stated 0% benefit is quoted at the contracted allowance", () => {
  /** The category IS in the plan, at a benefit level of zero. Covered, and priced by the contract. */
  const l = line(benefits({ coveragePercentages: { major: 0 } }));
  assert.equal(l.denialReason, "zero-percent-stated");
  assert.equal(l.patientPays, cents(1000));
});

// ── Denied because there is no covered benefit to price against ───────────────────────────────

test("an inactive policy is quoted at the full billed fee", () => {
  /**
   * The agreement prices services for COVERED members. With no policy in force the patient is
   * self-pay, and quoting them $1,000.00 would promise a discount the contract does not give.
   */
  const l = line(benefits({ eligibility: "inactive" }));
  assert.equal(l.patientPays, cents(1250), "the full billed fee");
  assert.equal(l.contractualWriteOff, undefined, "nothing is written off — there is no contract to price this");
});

test("an excluded procedure is quoted at the full billed fee", () => {
  /**
   * The one case that genuinely varies by agreement. Some participating contracts carry a
   * non-covered-services clause capping even excluded procedures; many do not, and no payer message
   * reveals which. The billed fee is the reading that does not assume a clause the practice may not
   * have signed.
   */
  const l = line(benefits({ excludedCodes: ["D2750"] }));
  assert.equal(l.denialReason, "excluded");
  assert.equal(l.patientPays, cents(1250));
});

test("a category the payer never mentioned is quoted at the full billed fee", () => {
  const l = line(benefits({ coveragePercentages: { preventive: 100 } }));
  assert.equal(l.denialReason, "coverage-unknown");
  assert.equal(l.patientPays, cents(1250), "unknown is not a discount");
});

test("an unanswered eligibility check is quoted at the full billed fee", () => {
  const l = line(benefits({ eligibility: "unknown" }));
  assert.equal(l.patientPays, cents(1250));
});

// ── The fallback: no fee schedule means nothing changes, anywhere ──────────────────────────────

test("with no contracted rate every denial is the billed fee, exactly as before", () => {
  for (const b of [
    benefits({ waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-06-01" }] }),
    benefits({ frequencyLimits: [{ codes: ["D2750"], limit: 1, period: "36-months", used: 1, description: "x" }] }),
    benefits({ coveragePercentages: { major: 0 } }),
    benefits({ eligibility: "inactive" }),
    benefits({ excludedCodes: ["D2750"] }),
  ]) {
    const l = line(b, NO_SCHEDULE);
    assert.equal(l.patientPays, cents(1250), `${l.denialReason} must fall back to the billed fee`);
    assert.equal(l.contractualWriteOff, undefined);
  }
});

// ── The money still adds up, on every path ────────────────────────────────────────────────────

test("a denied line splits the billed fee three ways, exactly", () => {
  for (const b of [
    benefits({ waitingPeriods: [{ category: "major", months: 12, coverageEffectiveDate: "2026-06-01" }] }),
    benefits({ coveragePercentages: { major: 0 } }),
    benefits({ eligibility: "inactive" }),
    benefits({ excludedCodes: ["D2750"] }),
  ]) {
    const e = calculateCoverage(CROWN, b, TODAY, "UTC", ALLOWED);
    assert.equal(
      e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff,
      e.totalFee,
      `no cent created or lost on a ${e.lines[0]!.denialReason} denial`
    );
    assert.equal(e.totalFee, cents(1250), "the practice still bills what it bills");
  }
});

// ── Covered lines: deductible, coinsurance and the annual maximum ──────────────────────────────

test("deductible and coinsurance are taken against the allowance, not the fee", () => {
  /**
   * 50% major, $50.00 deductible outstanding, allowance $1,000.00.
   *   insurance = 50% × (1000.00 − 50.00) = 475.00
   *   patient   = 1000.00 − 475.00        = 525.00   (their 50% share, plus the deductible)
   *   write-off = 1250.00 − 1000.00       = 250.00
   */
  const e = calculateCoverage(
    CROWN,
    benefits({ deductible: { individualAnnual: cents(50), remaining: cents(50), appliesTo: ["basic", "major"] } }),
    TODAY,
    "UTC",
    ALLOWED
  );
  assert.equal(e.deductibleAppliedTotal, cents(50));
  assert.equal(e.totalInsurancePays, cents(475));
  assert.equal(e.totalPatientPays, cents(525));
  assert.equal(e.totalContractualWriteOff, cents(250));
});

test("an annual maximum caps the benefit and the patient picks up the rest, at contracted prices", () => {
  /**
   * Only $120.00 of annual maximum left, allowance $1,000.00, 50% major.
   *   uncapped benefit = 50% × 1000.00 = 500.00, capped by the remaining maximum to 120.00
   *   patient          = 1000.00 − 120.00 = 880.00
   *   write-off        = 1250.00 − 1000.00 = 250.00
   * The patient absorbs the exhausted benefit — but at $880.00, not $1,130.00.
   */
  const e = calculateCoverage(
    CROWN,
    benefits({ annualMaximum: { amount: cents(2000), used: cents(1880), remaining: cents(120) } }),
    TODAY,
    "UTC",
    ALLOWED
  );
  assert.equal(e.totalInsurancePays, cents(120), "capped by what is left of the maximum");
  assert.equal(e.totalPatientPays, cents(880));
  assert.equal(e.totalContractualWriteOff, cents(250));
  assert.equal(e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff, e.totalFee);
});

test("a partially covered plan year: the same crown costs the patient less than the list price throughout", () => {
  /**
   * The property that matters to a practice quoting a patient. Whatever the plan does — pays in
   * full, pays partially, pays nothing because the benefit is spent, refuses because it is too
   * early — the patient never owes more than the contracted $1,000.00 while the procedure is a
   * covered benefit.
   */
  for (const b of [
    benefits(),
    benefits({ annualMaximum: { amount: cents(2000), used: cents(1880), remaining: cents(120) } }),
    benefits({ coveragePercentages: { major: 0 } }),
    benefits({ frequencyLimits: [{ codes: ["D2750"], limit: 1, period: "36-months", used: 1, description: "x" }] }),
  ]) {
    const e = calculateCoverage(CROWN, b, TODAY, "UTC", ALLOWED);
    assert.ok(
      e.totalPatientPays <= cents(1000),
      `patient quoted ${e.totalPatientPays} on a covered procedure with a $1,000.00 contracted rate`
    );
  }
});

// ── Contracted-rate edge cases ────────────────────────────────────────────────────────────────

test("an allowance at or above the billed fee is ignored on a denial too", () => {
  /** A payer never allows more than was billed; that reading is stale, and using it would invent a credit. */
  const l = calculateCoverage(CROWN, benefits({ coveragePercentages: { major: 0 } }), TODAY, "UTC", () => cents(2000)).lines[0]!;
  assert.equal(l.patientPays, cents(1250));
  assert.equal(l.contractualWriteOff, undefined);
});

test("a zero or negative allowance is ignored on a denial too", () => {
  for (const bad of [0, -10000]) {
    const l = calculateCoverage(CROWN, benefits({ coveragePercentages: { major: 0 } }), TODAY, "UTC", () => bad as Cents).lines[0]!;
    assert.equal(l.patientPays, cents(1250), `allowance ${bad} must fall back to the billed fee`);
  }
});

test("an allowance one cent below the fee still caps, and by one cent", () => {
  const l = calculateCoverage(CROWN, benefits({ coveragePercentages: { major: 0 } }), TODAY, "UTC", () => cents(1249.99)).lines[0]!;
  assert.equal(l.patientPays, cents(1249.99));
  assert.equal(l.contractualWriteOff, cents(0.01));
});

test("quantity multiplies a capped denial", () => {
  const two = [{ code: "D2750", quantity: 2, fee: cents(1250), toothNumber: "19" }];
  const e = calculateCoverage(two, benefits({ coveragePercentages: { major: 0 } }), TODAY, "UTC", ALLOWED);
  assert.equal(e.totalFee, cents(2500), "two units billed");
  assert.equal(e.totalPatientPays, cents(2000), "two units at the contracted rate");
  assert.equal(e.totalContractualWriteOff, cents(500));
});
