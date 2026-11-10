/**
 * Test fixtures for the Claims context.
 *
 * The coverage snapshot is hand-built here rather than produced by running the verification module,
 * and that is the point: Claims must be provable against the *event contract* alone. If these tests
 * needed the verification module to run, the module boundary would already be broken.
 */
import {
  COVERAGE_SNAPSHOT_VERSION,
  cents,
  withVersion,
  type Benefits,
  type CoverageCalculation,
  type CoverageLine,
  type CoverageSnapshot,
} from "@mermaid/shared";
import type { VerificationCompletedBody } from "@mermaid/events";
import type { ClaimPatient } from "../types.ts";

export const NOW = new Date("2026-07-27T12:00:00Z");
export const VERIFIED_AT = "2026-07-27T09:00:00.000Z";

/**
 * A properly CONFIGURED practice — the baseline a well-formed claim is scrubbed against.
 *
 * It used to be the demo identity (`MERMAID DEMO DENTAL` / `1234567893`), which meant the "a
 * well-formed claim scrubs clean" test was quietly asserting that an unconfigured deployment scrubs
 * clean. That is the very thing the placeholder rule exists to complain about, so the baseline has
 * to be a practice that actually set its environment. `1333333338` carries a correct NPI check digit.
 */
export const BILLING_PROVIDER = {
  name: "FIXTURE FAMILY DENTAL",
  npi: "1333333338",
  taxId: "987654321",
};

/** An unconfigured deployment — still running on the demo defaults. */
export const DEMO_BILLING_PROVIDER = {
  name: "MERMAID DEMO DENTAL",
  npi: "1234567893",
  taxId: "000000000",
};

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
 */
export const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

export const PATIENT: ClaimPatient = {
  firstName: "Ada",
  lastName: "Alpha",
  dateOfBirth: "1990-04-12",
  memberId: "ABC12345",
  address: SYNTHETIC_ADDRESS,
};

const BENEFITS: Benefits = {
  eligibility: "active",
  payerName: "Delta Dental",
  planName: "Delta Dental PPO",
  deductible: { individualAnnual: cents(50), remaining: cents(0), appliesTo: ["basic", "major"] },
  annualMaximum: { amount: cents(1500), used: cents(300), remaining: cents(1200) },
  coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
  waitingPeriods: [],
  frequencyLimits: [],
  exclusions: [],
  excludedCodes: [],
};

function line(overrides: Partial<CoverageLine> & Pick<CoverageLine, "code" | "description" | "category" | "fee">): CoverageLine {
  return {
    quantity: 1,
    coveragePercent: 100,
    deductibleApplied: cents(0),
    insurancePays: cents(0),
    patientPays: overrides.fee,
    notes: [],
    denied: false,
    ...overrides,
  };
}

/** Exam + cleaning + a crown on tooth 19 — the canonical demo plan. */
const CALCULATION: CoverageCalculation = {
  /** No pre-auth exposure: this fixture's plan publishes no rule and no line is at risk. */
  preAuthRevenueAtRisk: cents(0),
  lines: [
    line({
      code: "D0120",
      description: "Periodic oral evaluation",
      category: "diagnostic",
      fee: cents(65),
      coveragePercent: 100,
      insurancePays: cents(65),
      patientPays: cents(0),
    }),
    line({
      code: "D1110",
      description: "Prophylaxis (cleaning), adult",
      category: "preventive",
      fee: cents(110),
      coveragePercent: 100,
      insurancePays: cents(110),
      patientPays: cents(0),
    }),
    line({
      code: "D2750",
      description: "Crown, porcelain fused to metal",
      category: "major",
      toothNumber: "19",
      fee: cents(1250),
      coveragePercent: 50,
      insurancePays: cents(625),
      patientPays: cents(625),
    }),
  ],
  totalFee: cents(1425),
  totalInsurancePays: cents(800),
  totalPatientPays: cents(625),
  /** Zero: this fixture is priced entirely off billed fees, as every estimate was before F-1. */
  totalContractualWriteOff: cents(0),
  deductibleAppliedTotal: cents(0),
  annualMaxRemainingAfter: cents(400),
};

export function snapshot(overrides: Partial<CoverageSnapshot> = {}): CoverageSnapshot {
  const base = withVersion(
    {
      verificationId: "ver-0001",
      verifiedAt: VERIFIED_AT,
      payerId: "delta-dental",
      payerName: "Delta Dental",
      planName: "Delta Dental PPO",
      memberId: "ABC12345",
      groupNumber: "GRP100",
      benefits: structuredClone(BENEFITS),
      calculation: structuredClone(CALCULATION),
      confidence: 0.94,
      source: "mock" as const,
    },
    COVERAGE_SNAPSHOT_VERSION
  );
  return { ...base, ...overrides };
}

export function completedEvent(overrides: Partial<VerificationCompletedBody> = {}): VerificationCompletedBody {
  const coverageSnapshot = overrides.coverageSnapshot ?? snapshot();
  return {
    verificationId: coverageSnapshot.verificationId,
    completedAt: VERIFIED_AT,
    settledAs: "verified",
    patient: { ...PATIENT },
    coverageSnapshot,
    patientResponsibility: coverageSnapshot.calculation.totalPatientPays,
    totalFee: coverageSnapshot.calculation.totalFee,
    ...overrides,
  };
}
