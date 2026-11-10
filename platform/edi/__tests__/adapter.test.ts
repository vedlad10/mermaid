import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "../mock/index.ts";
import type { EligibilityRequest } from "../adapter.ts";

const adapter = new MockEdiAdapter();
const TODAY = new Date("2026-07-15");

function req(memberId: string): EligibilityRequest {
  return {
    payerId: "DELTA",
    payerName: "Delta Dental",
    planName: "Delta Dental PPO",
    memberId,
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01" },
    serviceDate: TODAY,
  };
}

test("returns normalized active benefits with money in INTEGER CENTS", async () => {
  const r = await adapter.checkEligibility(req("ABC12345"));
  assert.equal(r.ok, true);
  const b = r.data!.benefits;
  assert.equal(b.eligibility, "active");
  // Cents are integers, and $50 deductible → 5000.
  assert.ok(Number.isInteger(b.deductible.individualAnnual));
  assert.equal(b.deductible.individualAnnual, 5000);
  assert.ok(Number.isInteger(b.annualMaximum.amount));
  // This 271 states both halves, so all three are real numbers and the identity must hold. The
  // non-null assertions are the assertion: a null here would mean the adapter lost a figure the
  // payer did state.
  assert.notEqual(b.annualMaximum.used, null);
  assert.notEqual(b.annualMaximum.remaining, null);
  assert.equal(b.annualMaximum.used! + b.annualMaximum.remaining!, b.annualMaximum.amount);
  assert.equal(b.coveragePercentages.basic, 80);
  assert.ok(r.raw && r.raw.includes("ST*271")); // raw 271 retained for provenance
});

test("member IDs ending 00 are inactive; ending 77 carry a major-services waiting period", async () => {
  const inactive = await adapter.checkEligibility(req("MEM10000"));
  assert.equal(inactive.data!.eligibility, "inactive");

  const waiting = await adapter.checkEligibility(req("MEM10066"));
  assert.ok(waiting.data!.benefits.waitingPeriods.some((w) => w.category === "major"));
});

test("rejects an invalid member ID format without throwing", async () => {
  const r = await adapter.checkEligibility(req("bad!"));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "invalid_member_id");
  assert.equal(r.error?.retryable, false);
});

test("is deterministic — same member yields identical benefits", async () => {
  const a = await adapter.checkEligibility(req("ZZ998877"));
  const b = await adapter.checkEligibility(req("ZZ998877"));
  assert.deepEqual(a.data!.benefits, b.data!.benefits);
});
