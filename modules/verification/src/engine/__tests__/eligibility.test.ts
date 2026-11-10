import { test } from "node:test";
import assert from "node:assert/strict";
import { runEligibilityAndEstimate } from "../../eligibility.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import { addCents, cents, type TreatmentPlanItem } from "@mermaid/shared";

const adapter = new MockEdiAdapter();
const TODAY = new Date("2026-07-15");
const req = (memberId: string) => ({
  payerId: "DELTA",
  payerName: "Delta Dental",
  planName: "Delta Dental PPO",
  memberId,
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01" },
  serviceDate: TODAY,
});
const PROCS: TreatmentPlanItem[] = [
  { code: "D1110", quantity: 1, fee: cents(110) }, // preventive 100%
  { code: "D2740", quantity: 1, fee: cents(1200) }, // major 50%
];

test("active member: produces benefits + an estimate whose totals reconcile in cents", async () => {
  const out = await runEligibilityAndEstimate(adapter, req("ABC12345"), PROCS, TODAY);
  assert.equal(out.eligibility, "active");
  assert.ok(out.benefits && out.estimate);
  assert.ok(out.raw271 && out.raw271.includes("271"));
  assert.ok(out.confidence > 0.5);
  const est = out.estimate!;
  assert.equal(addCents(est.totalInsurancePays, est.totalPatientPays), est.totalFee);
});

test("inactive member: whole fee falls to the patient", async () => {
  const out = await runEligibilityAndEstimate(adapter, req("MEM10000"), PROCS, TODAY);
  assert.equal(out.eligibility, "inactive");
  assert.equal(out.estimate!.totalInsurancePays, 0);
  assert.equal(out.estimate!.totalPatientPays, out.estimate!.totalFee);
});

test("invalid member: no benefits, no estimate, explanation surfaces the reason", async () => {
  const out = await runEligibilityAndEstimate(adapter, req("bad!"), PROCS, TODAY);
  assert.equal(out.benefits, null);
  assert.equal(out.estimate, null);
  assert.match(out.explanation, /not a valid format/);
});
