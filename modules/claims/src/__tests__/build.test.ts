/**
 * Claim-builder tests. The assertions all circle one property: the claim's money is the SNAPSHOT's
 * money. If a figure here could be produced by arithmetic rather than by copying, estimate-vs-actual
 * reconciliation would be comparing Mermaid against Mermaid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimDraft, patientControlNumber } from "../engine/build.ts";
import { NOW, PATIENT, VERIFIED_AT, snapshot } from "./fixtures.ts";

function draft(overrides: Parameters<typeof buildClaimDraft>[0] | null = null) {
  return buildClaimDraft(
    overrides ?? { verificationId: "ver-0001", patient: PATIENT, coverageSnapshot: snapshot() },
    NOW
  );
}

test("a draft claim starts in draft status and links back to its verification", () => {
  const claim = draft();
  assert.equal(claim.status, "draft");
  assert.equal(claim.verificationId, "ver-0001");
  assert.equal(claim.scrub, null);
  assert.equal(claim.submission, null);
  assert.equal(claim.filingRiskRaised, null);
  assert.match(claim.audit[0]!.message, /Claim drafted from verification ver-0001/);
});

test("every line's money is copied from the snapshot, not recalculated", () => {
  const claim = draft();
  const source = snapshot().calculation.lines;

  assert.equal(claim.lines.length, 3);
  claim.lines.forEach((line, i) => {
    assert.equal(line.fee, source[i]!.fee);
    assert.equal(line.expectedInsurancePays, source[i]!.insurancePays);
    assert.equal(line.expectedPatientPays, source[i]!.patientPays);
    assert.equal(line.code, source[i]!.code);
    assert.equal(line.lineNumber, i + 1);
  });
});

test("claim totals equal the snapshot totals exactly", () => {
  const claim = draft();
  assert.equal(claim.totalFee, cents(1425));
  assert.equal(claim.expectedInsurancePays, cents(800));
  assert.equal(claim.expectedPatientPays, cents(625));
});

test("tooth numbers survive the estimate → claim handoff", () => {
  const claim = draft();
  const crown = claim.lines.find((l) => l.code === "D2750")!;
  assert.equal(crown.toothNumber, "19");
  assert.equal(claim.lines.find((l) => l.code === "D1110")!.toothNumber, undefined);
});

test("payer identity is carried from the snapshot onto the claim", () => {
  const claim = draft();
  assert.deepEqual(claim.payer, {
    payerId: "delta-dental",
    payerName: "Delta Dental",
    planName: "Delta Dental PPO",
    groupNumber: "GRP100",
  });
});

test("the service date defaults to the verification date, and the deadline follows the payer", () => {
  const claim = draft();
  assert.equal(claim.serviceDate, VERIFIED_AT.slice(0, 10));
  // Delta Dental allows 365 days from 2026-07-27.
  assert.equal(claim.filingDeadline, "2027-07-27");
});

test("a shorter-window payer gets an earlier deadline", () => {
  const claim = buildClaimDraft(
    {
      verificationId: "ver-uhc",
      patient: PATIENT,
      coverageSnapshot: snapshot({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental" }),
    },
    NOW
  );
  // UnitedHealthcare allows 90 days.
  assert.equal(claim.filingDeadline, "2026-10-25");
});

test("the claim's snapshot is a deep copy — mutating the source cannot reach it", () => {
  const source = snapshot();
  const claim = buildClaimDraft({ verificationId: "ver-0001", patient: PATIENT, coverageSnapshot: source }, NOW);

  source.calculation.totalPatientPays = cents(999999);
  source.benefits.annualMaximum.remaining = cents(0);

  assert.equal(claim.coverageSnapshot.calculation.totalPatientPays, cents(625));
  assert.equal(claim.coverageSnapshot.benefits.annualMaximum.remaining, cents(1200));
});

test("the control number is stable per claim and differs between claims", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  assert.equal(patientControlNumber(id), patientControlNumber(id));
  assert.equal(patientControlNumber(id), "MRM-111111112222");
  assert.notEqual(patientControlNumber(id), patientControlNumber("99999999-2222-3333-4444-555555555555"));
});

test("an explicit service date overrides the verification date", () => {
  const claim = buildClaimDraft(
    { verificationId: "ver-0001", patient: PATIENT, coverageSnapshot: snapshot(), serviceDate: "2026-08-03" },
    NOW
  );
  assert.equal(claim.serviceDate, "2026-08-03");
  assert.equal(claim.lines[0]!.serviceDate, "2026-08-03");
  assert.equal(claim.filingDeadline, "2027-08-03");
});

// ── B-1 — the claim records which document stands behind its filing date ──────────────────────

const SOURCE = {
  publisher: "Aetna Dental",
  document: "Dental Office Guide, 23.05.803.1B, revised 09/25/2026",
  url: "https://app-iaem.aetna.com/content/dam/aetna/pdfs/aetna-dental/ppo-office-guide.pdf",
  quote: "no later than 90 days after the date of service.",
  verifiedOn: "2026-09-30",
};

test("B-1: a claim built on a sourced catalogued window records the source beside its date", () => {
  const claim = draft({
    verificationId: "ver-0001",
    patient: PATIENT,
    coverageSnapshot: snapshot({ payerId: "aetna-dental" }),
    filingWindowDays: 90,
    filingWindowSource: SOURCE,
  });
  assert.deepEqual(claim.filingWindowSource, SOURCE);
});

test("B-1: without a catalogued window there is no source to record, whatever was passed", () => {
  const claim = draft({
    verificationId: "ver-0001",
    patient: PATIENT,
    coverageSnapshot: snapshot({ payerId: "aetna-dental" }),
    filingWindowDays: null,
    filingWindowSource: SOURCE,
  });
  assert.equal(claim.filingWindowSource, undefined, "a date from the engine's own table is Mermaid's estimate");
});

test("B-1: an unsourced claim carries no source key at all — it reads exactly as every older claim does", () => {
  const claim = draft();
  assert.equal("filingWindowSource" in claim, false);
});
