/**
 * The adversarial verification matrix — every coverage state a real front desk meets, driven
 * through the whole pipeline rather than through the engines in isolation.
 *
 * The property that matters across all of them is not any single flag. It is this: **a case that a
 * person must look at never auto-verifies, and a case nobody needs to look at never blocks the
 * desk.** Both failures cost money — the first quotes a patient from coverage nobody confirmed, the
 * second buries staff in review until they stop reading it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "../../pipeline.ts";
import { decideVerification } from "../decision.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import { addCents, cents, type TreatmentPlanItem } from "@mermaid/shared";
import type { PatientInfo, VerificationRecord } from "../../types.ts";

const adapter = new MockEdiAdapter();
const NOW = new Date("2026-08-10T12:00:00Z");
const PLAN: TreatmentPlanItem[] = [
  { code: "D0120", quantity: 1 },
  { code: "D1110", quantity: 1, fee: cents(110) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

const patient = (o: Partial<PatientInfo> = {}): PatientInfo => ({
  firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345", ...o,
});

const verify = (memberId: string, card: string, o: Partial<PatientInfo> = {}) =>
  runVerification({ patient: patient({ memberId, ...o }), cardText: card, planItems: PLAN }, adapter, NOW);

const codes = (r: VerificationRecord) => r.exceptions.map((e) => e.code);
const critical = (r: VerificationRecord) => r.exceptions.filter((e) => e.severity === "critical").map((e) => e.code);

/** The invariant every row of the matrix is measured against. */
function assertGateHolds(record: VerificationRecord, label: string): void {
  const decision = decideVerification(record, NOW);
  const hasCritical = record.exceptions.some((e) => e.severity === "critical");
  const belowThreshold = record.confidence.overall < record.confidence.reviewThreshold;

  if (hasCritical || belowThreshold) {
    assert.notEqual(decision.outcome, "complete", `${label}: must not auto-verify`);
    assert.equal(record.status, record.benefits ? "needs_review" : record.status, `${label}: routed to a person`);
  }
  // Money identity, whatever the coverage state.
  if (record.calculation) {
    assert.equal(
      addCents(record.calculation.totalInsurancePays, record.calculation.totalPatientPays),
      record.calculation.totalFee,
      `${label}: insurance + patient must equal the fee`
    );
  }
  // Confidence is a probability, always.
  assert.ok(record.confidence.overall >= 0 && record.confidence.overall <= 1, `${label}: confidence out of range`);
}

// ── The matrix ───────────────────────────────────────────────────────────────────────────────────

test("ACTIVE, clean — auto-verifies, and the estimate reconciles", async () => {
  const r = await verify("ABC12345", "Delta Dental\nMember ID: ABC12345");
  assert.equal(r.status, "verified");
  assert.equal(critical(r).length, 0);
  assert.equal(decideVerification(r, NOW).outcome, "complete");
  assertGateHolds(r, "active-clean");
});

test("INACTIVE coverage — critical, blocked, and the patient owes the whole fee", async () => {
  const r = await verify("MEM10000", "Delta Dental\nMember ID: MEM10000");
  assert.ok(critical(r).includes("inactive-coverage"));
  assert.equal(r.status, "needs_review");
  assert.equal(r.calculation!.totalInsurancePays, 0, "an inactive policy pays nothing");
  assert.equal(r.calculation!.totalPatientPays, r.calculation!.totalFee);
  assertGateHolds(r, "inactive");
});

test("WAITING PERIOD — the affected line is denied and says why, without blocking the rest", async () => {
  const r = await verify("MET30066", "MetLife Dental\nMember ID: MET30066");
  assert.ok(codes(r).includes("waiting-period"), "the reason must be named, not just 'denied'");
  const denied = r.calculation!.lines.filter((l) => l.denied);
  assert.ok(denied.length > 0);
  assert.ok(denied.every((l) => l.insurancePays === 0), "a denied line pays nothing");
  assertGateHolds(r, "waiting-period");
});

test("NEAR the annual maximum — warned, and insurance never pays past what remains", async () => {
  const r = await verify("CIG20099", "Cigna Dental\nMember ID: CIG20099");
  assert.ok(codes(r).some((c) => c === "annual-max-near-limit" || c === "annual-max-exhausted"));
  const remaining = r.benefits!.annualMaximum.remaining;
  assert.notEqual(remaining, null, "this fixture states a maximum, so the cap is a real number");
  assert.ok(
    r.calculation!.totalInsurancePays <= remaining!,
    "the estimate must never promise more than the plan has left"
  );
  assertGateHolds(r, "near-max");
});

test("UNKNOWN payer — no benefits, no invented estimate, and a person is required", async () => {
  const r = await verify("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999");
  assert.equal(r.benefits, null, "an unrecognised payer must not yield benefits");
  assert.equal(r.calculation, null, "and must not yield an estimate built on nothing");
  assert.ok(critical(r).includes("unknown-payer"));
  assert.equal(r.payerId, null);
  assertGateHolds(r, "unknown-payer");
});

test("MEMBER ID MISMATCH between the card and the form — surfaced, never silently preferred", async () => {
  const r = await verify("ABC12345", "Delta Dental\nMember ID: ZZZ99999");
  assert.ok(codes(r).includes("member-id-mismatch"));
  assertGateHolds(r, "member-mismatch");
});

test("MALFORMED member ID — refused at the adapter, and the refusal reaches the record", async () => {
  const r = await verify("!!", "Delta Dental\nMember ID: !!");
  assert.equal(r.benefits, null);
  assert.equal(r.status, "needs_review");
  assertGateHolds(r, "malformed-member");
});

test("INVALID date of birth — critical, because an identity we cannot state is not a verification", async () => {
  const r = await verify("ABC12345", "Delta Dental\nMember ID: ABC12345", { dateOfBirth: "" });
  assert.ok(critical(r).includes("data-validation"));
  assertGateHolds(r, "bad-dob");
});

test("a future date of birth is refused as firmly as a malformed one", async () => {
  const r = await verify("ABC12345", "Delta Dental\nMember ID: ABC12345", { dateOfBirth: "2099-01-01" });
  assert.ok(critical(r).includes("data-validation"));
  assertGateHolds(r, "future-dob");
});

// ── Freshness: a verification is a snapshot, and snapshots go stale ─────────────────────────────

test("STALE — a verification does not silently keep speaking for coverage months later", async () => {
  const { verificationFreshness } = await import("../freshness.ts");
  const r = await verify("ABC12345", "Delta Dental\nMember ID: ABC12345");

  const sameDay = verificationFreshness(r.createdAt, NOW);
  const muchLater = verificationFreshness(r.createdAt, new Date("2026-12-01T12:00:00Z"));
  assert.equal(sameDay.status, "fresh");
  assert.notEqual(muchLater.status, "fresh", "coverage changes; a months-old check is not current");
  /**
   * The flag that matters is not `outcome` — the check WAS complete when it ran, and rewriting
   * history would be wrong. It is `canNotifyPatient`: permission to read a dollar figure to a
   * patient. Freshness expires at the plan-year boundary because the deductible and the annual
   * maximum reset there, so an expired estimate is priced against numbers that no longer exist.
   */
  const nextYear = new Date("2027-03-01T12:00:00Z");
  const stale = decideVerification(r, nextYear);
  assert.equal(verificationFreshness(r.createdAt, nextYear).status, "expired");
  assert.equal(stale.canNotifyPatient, false, "an expired verification must not be quoted to a patient");
  assert.ok(
    stale.reasoning.some((line) => /expired/i.test(line)),
    "and the screen must say why, not merely withhold the button"
  );

  // Same-day, the estimate is quotable — the gate must not have become a blanket refusal.
  assert.equal(decideVerification(r, NOW).canNotifyPatient, true);
});

// ── The property, swept ─────────────────────────────────────────────────────────────────────────

test("across every coverage state, the human gate and the money identity both hold", async () => {
  const cases: [string, string][] = [
    ["ABC12345", "Delta Dental\nMember ID: ABC12345"],
    ["MEM10000", "Delta Dental\nMember ID: MEM10000"],
    ["CIG20099", "Cigna Dental\nMember ID: CIG20099"],
    ["MET30066", "MetLife Dental\nMember ID: MET30066"],
    ["AET40123", "Aetna Dental\nMember ID: AET40123"],
    ["XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"],
    ["MOD11111", "Moda Health\nMember ID: MOD11111"],
  ];
  for (const [memberId, card] of cases) {
    const r = await verify(memberId, card);
    assertGateHolds(r, memberId);
    // A record always explains itself: every exception carries a message a person can act on.
    for (const e of r.exceptions) {
      assert.ok(e.message.trim().length > 0, `${memberId}: exception ${e.code} has no message`);
    }
    // And the audit trail is never empty — provenance is the point of the record.
    assert.ok(r.audit.length > 0, `${memberId}: no audit trail`);
  }
});
