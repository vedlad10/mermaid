/**
 * The submit gate for pre-authorisation — the point where the $1,125.00 is actually saved.
 *
 * ── PIA PHASE32, AS THE REGRESSION SCENARIO ────────────────────────────────────────────────────
 * Her crown was billed $1,250.00, allowed $1,125.00 after a $125.00 contractual reduction, and
 * refused in full by MetLife under CARC 197 — "Pre-authorization absent" — in the `CO` group. `CO`
 * forbids billing the patient, so the practice absorbed all $1,125.00 for a reason that was
 * knowable before she was treated. Nothing in Mermaid asked the question.
 *
 * Every state below is exercised against that claim, and the amounts are hers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { scrubClaim } from "../engine/scrub.ts";
import type { Claim, ClaimLine, ClaimPreAuthorization } from "../types.ts";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const SERVICE_DATE = "2026-08-30";

const line = (over: Partial<ClaimLine>): ClaimLine =>
  ({
    lineNumber: 1,
    code: "D2750",
    description: "Crown, porcelain fused to metal",
    category: "major",
    toothNumber: "19",
    quantity: 1,
    fee: cents(1250),
    expectedInsurancePays: cents(1125),
    expectedPatientPays: cents(0),
    contractualWriteOff: cents(125),
    estimatedDenied: false,
    serviceDate: SERVICE_DATE,
    ...over,
  }) as ClaimLine;

const claim = (lines: ClaimLine[], preAuthorization?: ClaimPreAuthorization): Claim =>
  ({
    id: "claim-pia",
    status: "ready",
    totalFee: cents(1425),
    expectedInsurancePays: cents(1125),
    expectedPatientPays: cents(300),
    lines,
    payments: [],
    audit: [],
    patient: {
      firstName: "Pia",
      lastName: "Phase32",
      dateOfBirth: "1990-01-01",
      memberId: "MET90077",
      address: { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" },
      relationship: "self",
    },
    payer: { id: "metlife-dental", name: "MetLife Dental", payerName: "MetLife Dental" },
    serviceDate: SERVICE_DATE,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    filingDeadline: "2027-08-30",
    verificationId: "ver-pia",
    scrub: null,
    submission: null,
    voidReason: null,
    coverageSnapshot: SNAPSHOT,
    ...(preAuthorization ? { preAuthorization } : {}),
  }) as unknown as Claim;

/**
 * The scrubber reads the inherited snapshot for everything else it checks, so a claim fixture needs
 * one. It carries `preAuthorization` too, which is where the LINE requirements above came from —
 * they are inherited by the claim, never re-derived at submit time.
 */
const SNAPSHOT = {
  snapshot_version: 1,
  verifiedAt: "2026-08-30T00:00:00.000Z",
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

const CTX = {
  billingProvider: { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "000000000" },
} as never;

const findings = (c: Claim) => scrubClaim(c, CTX, NOW).findings;
const codes = (c: Claim) => findings(c).map((f) => f.code);
const of = (c: Claim, code: string) => findings(c).find((f) => f.code === code);

const REQUIRED = [line({ preAuthRequirement: "required", preAuthRiskAmount: cents(1125) })];

// ── REQUIRED, and nothing on record ───────────────────────────────────────────────────────────

test("a required approval that was never sought BLOCKS the claim, naming the exposure", () => {
  const f = of(claim(REQUIRED), "preauth-missing")!;
  assert.ok(f, "the gate must hold");
  assert.equal(f.severity, "error", "an error blocks the submit gate; a warning would not");
  assert.match(f.message, /D2750/, "and name the procedure");
  assert.match(f.message, /\$1,125\.00/, "and the money actually at risk");
  assert.match(f.message, /No authorisation has been requested/);
  assert.match(f.remediation, /reference number|waived/i, "and say what clears it");
});

test("the exposure quoted is the insurance share, not the $1,250.00 billed", () => {
  /**
   * CARC 197 is `CO`: the patient cannot be billed, and the $125.00 contractual reduction was never
   * collectable from anyone. Quoting the fee would overstate the loss by exactly the discount the
   * practice had already agreed to.
   */
  const f = of(claim(REQUIRED), "preauth-missing")!;
  assert.match(f.message, /\$1,125\.00/);
  assert.doesNotMatch(f.message, /\$1,250\.00/);
});

// ── PENDING ───────────────────────────────────────────────────────────────────────────────────

test("a request still with the payer does not clear the gate", () => {
  /**
   * Asking is not being answered. Filing on a pending request is filing on hope, and the refusal
   * arrives all the same.
   */
  const f = of(claim(REQUIRED, { status: "pending", source: "payer-portal" }), "preauth-missing")!;
  assert.ok(f);
  assert.match(f.message, /still with the payer/);
});

// ── APPROVED ──────────────────────────────────────────────────────────────────────────────────

test("an approval clears the gate", () => {
  const approved = claim(REQUIRED, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-99871",
    validUntil: "2027-02-26",
  });
  assert.ok(!codes(approved).includes("preauth-missing"), "an approved claim must file");
});

// ── EXPIRED ───────────────────────────────────────────────────────────────────────────────────

test("an approval that lapsed before the date of service does NOT clear the gate", () => {
  /**
   * Checked against the DATE OF SERVICE, not today: the day the work was done is the day the
   * authorisation had to cover. Checking against today would fail a claim filed late for treatment
   * that was properly authorised at the time.
   */
  const lapsed = claim(REQUIRED, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-OLD",
    validUntil: "2026-06-30",
  });
  assert.ok(codes(lapsed).includes("preauth-missing"), "an expired approval is not an approval");
});

test("an approval still valid on the day of service clears it, even if it has since lapsed", () => {
  const stillValidThen = claim(REQUIRED, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-99871",
    validUntil: SERVICE_DATE,
  });
  assert.ok(!codes(stillValidThen).includes("preauth-missing"), "valid ON the day counts");
});

test("an explicitly expired decision blocks and says so", () => {
  const f = of(claim(REQUIRED, { status: "expired", source: "payer-portal" }), "preauth-missing")!;
  assert.match(f.message, /expired/i);
});

// ── DENIED ────────────────────────────────────────────────────────────────────────────────────

test("a refused authorisation blocks, quotes the payer, and points at the appeal", () => {
  /**
   * The most dangerous state to get wrong. Filing anyway is knowingly buying a write-off the
   * patient cannot be charged for, so the route back is the appeal path — never the submit button.
   */
  const f = of(
    claim(REQUIRED, {
      status: "denied",
      source: "payer-portal",
      denialReason: "Radiographs do not support medical necessity",
    }),
    "preauth-missing"
  )!;
  assert.match(f.message, /REFUSED/);
  assert.match(f.message, /Radiographs do not support medical necessity/, "the payer's own words");
  assert.match(f.remediation, /appeal/i);
  assert.match(f.remediation, /cannot be billed to them/i, "and that the patient cannot absorb it");
});

// ── WAIVED ────────────────────────────────────────────────────────────────────────────────────

test("a payer waiving the requirement clears the gate without pretending to be an approval", () => {
  const waived = claim(REQUIRED, { status: "waived", source: "payer-phone", note: "Confirmed by Dana at MetLife" });
  assert.ok(!codes(waived).includes("preauth-missing"));
});

// ── UNKNOWN ───────────────────────────────────────────────────────────────────────────────────

test("an unknown requirement WARNS and does not block", () => {
  /**
   * `unknown` is the ordinary answer — a 271 does not carry these rules. Blocking on it would stop
   * nearly every claim in the system on a question the payer never answered, and a gate that fires
   * on ordinary traffic is one people learn to click past.
   */
  const c = claim([line({ preAuthRequirement: "unknown", preAuthRiskAmount: cents(1125) })]);
  const f = of(c, "preauth-unknown")!;
  assert.ok(f, "it must still be said");
  assert.equal(f.severity, "warning", "but it must not block");
  assert.ok(!codes(c).includes("preauth-missing"));
  assert.match(f.message, /\$1,125\.00/, "and it must still name what is at stake");
  assert.match(f.message, /271 does not carry/, "and why nobody knows");
});

// ── NOT REQUIRED ──────────────────────────────────────────────────────────────────────────────

test("a plan that needs no approval produces no finding at all", () => {
  /**
   * The flag has to stay rare. A pre-auth note on every ordinary claim is one nobody reads.
   */
  const c = claim([line({ preAuthRequirement: "not-required", preAuthRiskAmount: cents(0) })]);
  assert.ok(!codes(c).includes("preauth-missing"));
  assert.ok(!codes(c).includes("preauth-unknown"));
});

test("a claim built before this feature existed is silent, not blocked", () => {
  /**
   * Absent is not `required`. Every claim in the system predates this field, and a gate that read
   * absence as a missing approval would block all of them.
   */
  const legacy = claim([line({})]);
  assert.ok(!codes(legacy).includes("preauth-missing"));
  assert.ok(!codes(legacy).includes("preauth-unknown"));
});

test("only the lines that need approval are named, not the whole visit", () => {
  /**
   * The requirement is per procedure. A crown needing approval says nothing about the exam beside
   * it, and blocking a whole visit for one line would make the gate feel arbitrary.
   */
  const mixed = claim([
    line({ lineNumber: 1, code: "D0120", category: "diagnostic", fee: cents(65), preAuthRequirement: "not-required", preAuthRiskAmount: cents(0) }),
    line({ lineNumber: 2, preAuthRequirement: "required", preAuthRiskAmount: cents(1125) }),
  ]);
  const f = of(mixed, "preauth-missing")!;
  assert.match(f.message, /D2750/);
  assert.doesNotMatch(f.message, /D0120/, "the exam is not the problem and must not be named as one");
});
