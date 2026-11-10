/**
 * MockEdiAdapter.submitClaim tests — the adapter boundary, not the wire format (that is
 * x12-837.test.ts). The distinction these assert is the one most easily lost in an integration:
 * a transport failure (`ok: false`, retryable) is not the same as a payer rejection
 * (`ok: true`, `status: "rejected"`), and treating them alike either retries a rejection forever
 * or records a network blip as a denial.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { MockEdiAdapter } from "../mock/index.ts";
import type { ClaimSubmissionRequest } from "../adapter.ts";

const adapter = new MockEdiAdapter();

function claim(overrides: Partial<ClaimSubmissionRequest> = {}): ClaimSubmissionRequest {
  return {
    claimId: "11111111-2222-3333-4444-555555555555",
    patientControlNumber: "MRM-000123",
    payerId: "delta-dental",
    payerName: "Delta Dental",
    subscriber: {
      firstName: "Ada",
      lastName: "Alpha",
      dateOfBirth: "1990-04-12",
      memberId: "ABC12345",
      groupNumber: "GRP100",
    },
    billingProvider: { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" },
    serviceDate: "2026-07-27",
    totalCharge: cents(1425),
    lines: [
      { lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: cents(65), serviceDate: "2026-07-27" },
      { lineNumber: 2, procedureCode: "D1110", quantity: 1, chargeAmount: cents(110), serviceDate: "2026-07-27" },
      { lineNumber: 3, procedureCode: "D2750", toothNumber: "19", quantity: 1, chargeAmount: cents(1250), serviceDate: "2026-07-27" },
    ],
    ...overrides,
  };
}

test("a clean claim is accepted and returns a control number plus the 837 for provenance", async () => {
  const result = await adapter.submitClaim(claim());

  assert.equal(result.ok, true);
  assert.equal(result.source, "mock");
  assert.equal(result.data!.status, "accepted");
  assert.equal(result.data!.statusCategory, "A1");
  assert.equal(result.data!.statusCode, "19");
  assert.match(result.data!.controlNumber, /^\d{9}$/);
  assert.deepEqual(result.data!.lineErrors, []);
  assert.ok(result.raw?.includes("ST*837*"), "the submitted 837 is retained for audit");
});

test("money crosses cents → dollars exactly once, at the adapter boundary", async () => {
  const result = await adapter.submitClaim(claim());
  assert.match(result.raw!, /CLM\*MRM-000123\*1425\.00/, "$1,425.00 total on the wire");
  assert.match(result.raw!, /SV3\*AD:D2750\*1250\.00/, "$1,250.00 crown line on the wire");
});

test("a payer rejection is ok:true with status rejected — a business outcome, not an error", async () => {
  const result = await adapter.submitClaim(
    claim({ subscriber: { ...claim().subscriber, memberId: "MEM10000" } })
  );

  assert.equal(result.ok, true, "the transport worked — the payer said no");
  assert.equal(result.error, undefined);
  assert.equal(result.data!.status, "rejected");
  assert.equal(result.data!.statusCategory, "A3");
  assert.equal(result.data!.statusCode, "33");
  assert.match(result.data!.message, /Subscriber and subscriber id not found/);
});

test("a zero-charge line is rejected and itemized back to the line number", async () => {
  const base = claim();
  const result = await adapter.submitClaim({
    ...base,
    lines: [
      base.lines[0]!,
      { lineNumber: 2, procedureCode: "D1110", quantity: 1, chargeAmount: cents(0), serviceDate: "2026-07-27" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.data!.status, "rejected");
  assert.equal(result.data!.lineErrors.length, 1);
  assert.equal(result.data!.lineErrors[0]!.lineNumber, 2);
  assert.equal(result.data!.lineErrors[0]!.matchedBy, "unique-procedure-code");
  assert.match(result.data!.lineErrors[0]!.message, /carries no charge/);
});

test("a claim with no destination or no service lines fails as a transport error, never as a rejection", async () => {
  const noPayer = await adapter.submitClaim(claim({ payerId: "" }));
  assert.equal(noPayer.ok, false);
  assert.equal(noPayer.error!.code, "unavailable");
  assert.equal(noPayer.data, undefined);

  const noLines = await adapter.submitClaim(claim({ lines: [] }));
  assert.equal(noLines.ok, false);
  assert.equal(noLines.error!.code, "parse_error");
});

test("submission is deterministic — resubmitting the same claim presents the same control number", async () => {
  const first = await adapter.submitClaim(claim());
  const second = await adapter.submitClaim(claim());
  assert.equal(first.data!.controlNumber, second.data!.controlNumber);
});

test("a different claim gets a different control number", async () => {
  const a = await adapter.submitClaim(claim());
  const b = await adapter.submitClaim(claim({ claimId: "99999999-2222-3333-4444-555555555555" }));
  assert.notEqual(a.data!.controlNumber, b.data!.controlNumber);
});

test("the mock stays consistent with eligibility: an inactive member is rejected at both stages", async () => {
  const eligibility = await adapter.checkEligibility({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    memberId: "MEM10000",
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
  });
  const submission = await adapter.submitClaim(
    claim({ subscriber: { ...claim().subscriber, memberId: "MEM10000" } })
  );

  assert.equal(eligibility.data!.eligibility, "inactive");
  assert.equal(submission.data!.status, "rejected");
});
