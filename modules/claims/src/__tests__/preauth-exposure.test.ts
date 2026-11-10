/**
 * The dashboard's "at risk" figure and the submit gate must read the same claim the same way.
 *
 * ── THE CONTRADICTION, ON LIVE STAGING ─────────────────────────────────────────────────────────
 * Pia Preauth's claim carried a real authorisation: status `approved`, reference `AUTH-STAGING-1`,
 * valid to 2027-03-01. The submit gate cleared it — `canSubmit: true`, no blockers. The Today board
 * simultaneously reported $625.00 under "At risk · unauthorised, not yet filed".
 *
 * One screen said the claim was clear to file; another said its money was at risk for exactly the
 * reason the first had cleared. The list item summed every line's `preAuthRiskAmount` and never
 * asked whether an authorisation existed. The rule lived in the scrub and nowhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { preAuthExposure, preAuthSatisfied } from "../engine/preauth.ts";
import { scrubClaim } from "../engine/scrub.ts";
import type { Claim } from "../types.ts";

const CROWN = {
  code: "D2750",
  description: "Crown, porcelain fused to metal",
  category: "major",
  quantity: 1,
  lineNumber: 1,
  fee: cents(1250),
  serviceDate: "2026-09-01",
  expectedInsurancePays: cents(625),
  expectedPatientPays: cents(625),
  preAuthRequirement: "required" as const,
  preAuthRiskAmount: cents(625),
};

const claim = (auth: unknown, serviceDate = "2026-09-01"): Claim =>
  ({
    id: "c1",
    status: "ready",
    serviceDate,
    lines: [CROWN],
    preAuthorization: auth,
    patient: { firstName: "Pia", lastName: "Preauth", dateOfBirth: "1990-01-01", memberId: "MET90077", address: null },
    payer: { payerId: "metlife-dental", payerName: "MetLife Dental", planName: "PPO", groupNumber: null },
    totalFee: cents(1315),
    expectedInsurancePays: cents(690),
    expectedPatientPays: cents(625),
    payments: [],
    audit: [],
    coverageSnapshot: SNAPSHOT,
    filingDeadline: "2027-09-01",
  }) as unknown as Claim;

/** A real billing identity, so the scrub's placeholder warning does not muddy the comparison. */
const SCRUB_CTX = {
  billingProvider: { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "000000000" },
} as never;

/** The scrubber reads the inherited snapshot for everything else it checks, so a fixture needs one. */
const SNAPSHOT = {
  snapshot_version: 1,
  verifiedAt: "2026-09-01T00:00:00.000Z",
  benefits: {
    eligibility: "active",
    planName: "MetLife Preferred",
    deductible: { individualAnnual: cents(50), remaining: cents(0), appliesTo: ["basic", "major"] },
    annualMaximum: { amount: cents(1500), used: cents(0), remaining: cents(1500) },
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50 },
    waitingPeriods: [],
    frequencyLimits: [],
    exclusions: [],
    excludedCodes: [],
    preAuthorization: {
      categories: ["major"],
      codes: [],
      thresholdCents: null,
      validityDays: 180,
      source: "TEST PLAN RULE — synthetic",
    },
  },
} as unknown as Claim["coverageSnapshot"];

const APPROVED = {
  status: "approved",
  source: "payer-portal",
  referenceNumber: "AUTH-STAGING-1",
  requestedAt: "2026-09-01T09:45:01.621Z",
  decidedAt: "2026-09-01T09:45:01.621Z",
  requestedBy: "operator@clinic",
  validUntil: "2027-03-01",
};

test("an approval on file removes the exposure", () => {
  assert.equal(preAuthExposure(claim(APPROVED)), 0);
  assert.ok(preAuthSatisfied(claim(APPROVED)));
});

test("with no authorisation the exposure is the money the payer would refuse", () => {
  assert.equal(preAuthExposure(claim(null)), cents(625));
  assert.ok(!preAuthSatisfied(claim(null)));
});

test("pending, denied and expired are not permission", () => {
  for (const status of ["pending", "denied", "expired"]) {
    const c = claim({ ...APPROVED, status });
    assert.equal(preAuthExposure(c), cents(625), `${status} must still carry the exposure`);
  }
});

test("a waiver satisfies it, because the payer said none was needed", () => {
  assert.equal(preAuthExposure(claim({ ...APPROVED, status: "waived" })), 0);
});

test("expiry is judged against the DATE OF SERVICE, not today", () => {
  /**
   * A claim filed late for treatment that WAS authorised at the time must not be reported as
   * exposed — the authorisation covered the day the work was done, which is the only day that
   * matters.
   */
  const inTime = claim({ ...APPROVED, validUntil: "2026-09-01" }, "2026-09-01");
  assert.equal(preAuthExposure(inTime), 0, "valid ON the day of service counts");

  const lapsed = claim({ ...APPROVED, validUntil: "2026-08-31" }, "2026-09-01");
  assert.equal(preAuthExposure(lapsed), cents(625), "treatment after the term is not covered");
});

test("the gate and the exposure agree on every authorisation state", () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. Whatever the state, a claim the gate lets through must not
   * be reported as carrying pre-authorisation risk, and one it blocks must be.
   */
  const states: unknown[] = [
    null,
    APPROVED,
    { ...APPROVED, status: "pending" },
    { ...APPROVED, status: "denied", denialReason: "Not medically necessary" },
    { ...APPROVED, status: "expired" },
    { ...APPROVED, status: "waived" },
    { ...APPROVED, validUntil: "2026-08-31" },
  ];
  for (const auth of states) {
    const c = claim(auth);
    const blocked = scrubClaim(c, SCRUB_CTX, new Date("2026-09-01T12:00:00Z")).findings.some(
      (f) => f.code === "preauth-missing"
    );
    const exposed = preAuthExposure(c) > 0;
    assert.equal(
      exposed,
      blocked,
      `gate blocked=${blocked} but dashboard exposure=${exposed} for ${JSON.stringify(auth)}`
    );
  }
});

test("a line that does not need approval carries no exposure at all", () => {
  const exam = { ...CROWN, code: "D0120", preAuthRequirement: "not-required" as const, preAuthRiskAmount: undefined };
  const c = { ...claim(null), lines: [exam] } as unknown as Claim;
  assert.equal(preAuthExposure(c), 0);
});
