/**
 * Quoting a patient from the CONTRACT, not from the practice's price list (F-1 stage 2).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * Both shares were computed from the billed fee:
 *
 *     insurancePays = coverage% × (fee − deductible)
 *     patientPays   = fee − insurancePays
 *
 * For an in-network practice that is wrong twice, in opposite directions. The payer pays a
 * percentage of its CONTRACTED ALLOWANCE, so insurance was overstated. And with only two buckets,
 * every cent of the billed fee had to land in one of them — so the contractual write-off, money the
 * contract forbids billing to the patient, was silently handed to the patient.
 *
 * The over-quote is the expensive half and the invisible one. A patient who declines a crown
 * because they were told it costs more than it does is revenue that appears in no report, because
 * nothing measures treatment not accepted.
 *
 * ── THE ARITHMETIC, DONE BY HAND ───────────────────────────────────────────────────────────────
 * A $1,250.00 crown, 50% major coverage, no deductible left, payer allows $1,000.00:
 *
 *              billed-fee basis (before)        allowed basis (after)
 *   insurance  50% × 1250.00 = 625.00           50% × 1000.00 = 500.00
 *   patient    1250.00 − 625.00 = 625.00        1000.00 − 500.00 = 500.00
 *   write-off  (no such bucket)                 1250.00 − 1000.00 = 250.00
 *
 * The patient was quoted $625.00 and owes $500.00, and every cent of that gap was money nobody
 * would ever have collected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, ZERO, type Benefits, type Cents } from "@mermaid/shared";
import { calculateCoverage } from "../engine/estimate.ts";
import { plainEnglishEstimate } from "../engine/summary.ts";
import type { VerificationRecord } from "../types.ts";

const TODAY = new Date("2026-08-31T12:00:00Z");

/**
 * The same builder the engine's own suite uses, so this file is testing the pricing change and not
 * a fixture of its own invention. Deductible already met, so the first tests isolate the allowance.
 */
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

const BENEFITS = benefits();

const CROWN = [{ code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" }];
const schedule =
  (rates: Record<string, number>) =>
  (code: string): Cents | null =>
    code in rates ? cents(rates[code]!) : null;

// ── The correction ────────────────────────────────────────────────────────────────────────────

test("with no observed rate the estimate is unchanged — the fallback IS the old behaviour", () => {
  const before = calculateCoverage(CROWN, BENEFITS, TODAY);
  const withEmpty = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", () => null);

  assert.deepEqual(withEmpty, before, "an absent schedule must be identical to no schedule");
  assert.equal(before.totalInsurancePays, cents(625), "50% of the billed $1,250.00");
  assert.equal(before.totalPatientPays, cents(625));
  assert.equal(before.totalContractualWriteOff, cents(0), "nothing is written off if nothing is known");
});

test("a known allowance moves BOTH shares down and names the difference", () => {
  const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 }));

  assert.equal(e.totalFee, cents(1250), "the practice still bills what it bills");
  assert.equal(e.totalInsurancePays, cents(500), "50% of the ALLOWED $1,000.00, not of the fee");
  assert.equal(e.totalPatientPays, cents(500), "allowance less insurance — never fee less insurance");
  assert.equal(e.totalContractualWriteOff, cents(250));

  assert.equal(e.lines[0]!.allowedAmount, cents(1000));
  assert.equal(e.lines[0]!.contractualWriteOff, cents(250));
});

test("the patient is quoted $125.00 less, and every cent of it was uncollectable", () => {
  const before = calculateCoverage(CROWN, BENEFITS, TODAY);
  const after = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 }));
  assert.equal(before.totalPatientPays - after.totalPatientPays, cents(125));
});

// ── The identity that changed ─────────────────────────────────────────────────────────────────

/**
 * `totalFee === insurance + patient` used to hold, and that identity WAS the defect wearing the
 * clothes of an invariant: with no third bucket the write-off had nowhere to go but the patient.
 */
test("the billed fee now splits three ways, and still splits exactly", () => {
  const cases: Record<string, number>[] = [{}, { D2750: 1000 }, { D2750: 1249 }, { D2750: 1 }];
  for (const rates of cases) {
    const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule(rates));
    assert.equal(
      e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff,
      e.totalFee,
      `no cent may be created or lost: ${JSON.stringify(rates)}`
    );
  }
});

test("no share is ever negative, whatever the payer has been observed to allow", () => {
  for (const allowedCents of [1, 100, 62400, 62500, 62600, 124900]) {
    const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", () => allowedCents as Cents);
    assert.ok(e.totalInsurancePays >= 0, `insurance at ${allowedCents}`);
    assert.ok(e.totalPatientPays >= 0, `patient at ${allowedCents}`);
    assert.ok(e.totalContractualWriteOff >= 0, `write-off at ${allowedCents}`);
    assert.equal(e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff, e.totalFee);
  }
});

// ── Readings that must be refused ─────────────────────────────────────────────────────────────

test("an allowance above the billed fee is ignored, not used", () => {
  /**
   * A payer never pays more than what was billed, so this reading is a stale rate or a fee the
   * practice has since lowered. Using it would quote insurance paying more than the charge, which is
   * visibly absurd on a patient card and would put a negative write-off in the arithmetic.
   */
  const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule({ D2750: 2000 }));
  assert.equal(e.totalInsurancePays, cents(625), "priced off the fee, exactly as with no rate at all");
  assert.equal(e.totalContractualWriteOff, cents(0));
});

test("a zero or negative allowance is ignored rather than treated as free care", () => {
  for (const bad of [0, -10000]) {
    const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", () => bad as Cents);
    assert.equal(e.totalPatientPays, cents(625), `allowance ${bad} must fall back to the fee`);
    assert.equal(e.totalContractualWriteOff, cents(0));
  }
});

test("a rate for one code says nothing about another", () => {
  const plan = [
    { code: "D0120", quantity: 1, fee: cents(65) },
    { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
  ];
  const e = calculateCoverage(plan, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 }));
  const exam = e.lines.find((l) => l.code === "D0120")!;
  const crown = e.lines.find((l) => l.code === "D2750")!;
  assert.equal(exam.contractualWriteOff, undefined, "no rate observed for the exam");
  assert.equal(exam.patientPays + exam.insurancePays, exam.fee, "so it is still priced off its fee");
  assert.equal(crown.contractualWriteOff, cents(250));
});

test("quantity multiplies the per-unit allowance", () => {
  const two = [{ code: "D2750", quantity: 2, fee: cents(1250), toothNumber: "19" }];
  const e = calculateCoverage(two, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 }));
  assert.equal(e.totalFee, cents(2500), "two units at the practice fee");
  assert.equal(e.lines[0]!.allowedAmount, cents(2000), "two units at the contracted rate");
  assert.equal(e.totalContractualWriteOff, cents(500));
  assert.equal(e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff, e.totalFee);
});

// ── The deductible applies to the allowance, not to the fee ───────────────────────────────────

test("the deductible comes off the allowance, because that is what the payer recognises", () => {
  const unmet = benefits({
    deductible: { individualAnnual: cents(50), remaining: cents(50), appliesTo: ["basic", "major"] },
  });

  const e = calculateCoverage(CROWN, unmet, TODAY, "UTC", schedule({ D2750: 1000 }));
  assert.equal(e.deductibleAppliedTotal, cents(50));
  assert.equal(e.totalInsurancePays, cents(475), "50% of (1000.00 − 50.00)");
  assert.equal(e.totalPatientPays, cents(525), "1000.00 − 475.00: coinsurance plus the deductible");
  assert.equal(e.totalContractualWriteOff, cents(250));
  assert.equal(e.totalInsurancePays + e.totalPatientPays + e.totalContractualWriteOff, e.totalFee);
});

// ── The sentence a person reads aloud ─────────────────────────────────────────────────────────

const spoken = (calc: ReturnType<typeof calculateCoverage>) =>
  plainEnglishEstimate({
    calculation: calc,
    benefits: { ...BENEFITS, payerName: "Delta Dental" },
  } as unknown as VerificationRecord).join(" ");

test("the spoken summary accounts for every dollar of the plan", () => {
  /**
   * This sentence is read to a patient at the desk. Once a contracted rate is known the plan splits
   * three ways, and naming only two of them produces a claim the patient can hear does not add up —
   * "$500.00 of a $1,250.00 plan, leaving about $500.00 for you" — which gets asked about and
   * answered badly.
   */
  const said = spoken(calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 })));

  assert.match(said, /\$250\.00 is written off/, "the write-off is named");
  assert.match(said, /charged to nobody/, "and explicitly charged to no one");
  assert.match(said, /\$500\.00 for the patient/);
  assert.doesNotMatch(said, /\$625\.00/, "never the old over-quote");
});

test("with no contracted rate the sentence is the one it has always been", () => {
  const said = spoken(calculateCoverage(CROWN, BENEFITS, TODAY));
  assert.match(said, /estimated to pay \$625\.00 of the \$1,250\.00/);
  assert.doesNotMatch(said, /written off/, "nothing is written off when no contract is known");
});

// ── What the payer is billed is unchanged ─────────────────────────────────────────────────────

test("the practice still BILLS its own fee — the allowance changes the quote, not the claim", () => {
  /**
   * The failure this exists to prevent, and it would be expensive and quiet. A practice bills its
   * own fee and the payer applies the contract on its side; billing the allowed amount instead would
   * under-bill every claim, and would do so invisibly, because the payer would pay exactly what was
   * asked and nothing would ever look wrong.
   *
   * `fee` is therefore asserted untouched at both line and plan level. The claim copies these
   * figures verbatim into the 837 (`modules/claims/src/engine/build.ts` — "this function COPIES, it
   * does not CALCULATE"), so holding the line here holds it all the way to the payer.
   */
  const e = calculateCoverage(CROWN, BENEFITS, TODAY, "UTC", schedule({ D2750: 1000 }));
  assert.equal(e.lines[0]!.fee, cents(1250), "the line still carries the practice fee");
  assert.equal(e.totalFee, cents(1250), "and so does the plan total");
  assert.notEqual(e.lines[0]!.fee, e.lines[0]!.allowedAmount, "the allowance is recorded beside the fee, never over it");
});
