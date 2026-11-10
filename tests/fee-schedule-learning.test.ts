/**
 * The system learns what a payer actually allows, from the payer's own advice (F-1).
 *
 * ── THE DEFECT BEING WORKED TOWARD ─────────────────────────────────────────────────────────────
 * The estimate engine quotes both the insurance and the patient share off the practice's BILLED FEE:
 *
 *     insurancePays = coverage% × (fee − deductible)
 *     patientPays   = fee − insurancePays
 *
 * For an in-network practice that is wrong twice, in opposite directions. The payer pays a
 * percentage of its contracted ALLOWED amount, so the insurance figure is overstated; and the gap
 * between the billed fee and the allowed amount is a contractual write-off nobody owes, so the
 * patient is quoted money that will never be collected from anyone.
 *
 * The over-quote is the expensive half and the invisible one — a patient who declines a crown over
 * a figure $71.25 too high is revenue that never appears in any report, because nothing measures
 * treatment not accepted.
 *
 * ── WHAT THIS STAGE DOES ───────────────────────────────────────────────────────────────────────
 * Accumulates observations only. No estimate reads them yet, and a code never observed falls back
 * to the billed fee, which is exactly today's behaviour — so these tests assert that the right
 * numbers are being learned and that nothing else moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const SYNTHETIC_ADDRESS = {
  street: "1 SYNTHETIC TEST WAY",
  city: "SPRINGFIELD",
  state: "CA",
  zip: "900010000",
} as const;

const PLAN = [
  { code: "D0120", quantity: 1, fee: cents(65) },
  { code: "D1110", quantity: 1, fee: cents(110) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

/** Verify a patient, file what is filable, and take the payer's advice on it. */
async function throughPayment(patients = [{ firstName: "Ada", lastName: "Alpha", dob: "1990-04-12", memberId: "ABC12345" }]) {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const demo = services.via(new MockEdiAdapter());

  for (const p of patients) {
    await demo.verification.create({
      patient: { firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dob, memberId: p.memberId, address: SYNTHETIC_ADDRESS },
      cardText: `Delta Dental
Member ID: ${p.memberId}`,
      planItems: PLAN,
    });
  }
  for (const item of await demo.claims.list({ status: "ready" })) {
    if (item.canSubmit) await demo.claims.submit(item.id, { submittedBy: "fee.schedule.test@clinic" });
  }

  const submitted = await demo.claims.list({ status: "submitted" });
  const detailed = (await Promise.all(submitted.map((i) => demo.claims.get(i.id)))).filter(
    (v): v is NonNullable<typeof v> => v !== null && v.claim.submission !== null && v.claim.payer.payerId !== null
  );
  const byPayer = new Map<string, typeof detailed>();
  for (const v of detailed) byPayer.set(v.claim.payer.payerId!, [...(byPayer.get(v.claim.payer.payerId!) ?? []), v]);

  for (const [payerId, group] of byPayer) {
    await demo.remittance.fetchAndIngest({
      payerId,
      payerName: group[0]!.claim.payer.payerName ?? payerId,
      payeeName: "MERMAID DEMO DENTAL",
      claims: group.map((v) => ({
        patientControlNumber: v.claim.submission!.patientControlNumber,
        payerControlNumber: v.claim.submission!.controlNumber,
        patientFirstName: v.claim.patient.firstName,
        patientLastName: v.claim.patient.lastName,
        memberId: v.claim.patient.memberId,
        lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
        expectedInsurancePays: v.claim.expectedInsurancePays,
      })),
    });
  }
  return { services, demo, detailed };
}

test("posting a remittance teaches the profile what this payer allows", async () => {
  const { services } = await throughPayment();

  const learned = await services.allowedAmounts.listForPayer("delta-dental");
  assert.ok(learned.length > 0, "the payer stated contracted reductions and none were recorded");

  for (const rate of learned) {
    assert.ok(rate.allowed > 0, `${rate.cdtCode} allowed nothing`);
    assert.ok(
      rate.allowed < rate.charged,
      `${rate.cdtCode}: an allowance equal to the charge is not evidence of a contract`
    );
    assert.equal(rate.observations, 1);
    assert.equal(rate.restatements, 1);
    assert.equal(rate.payerId, "delta-dental");
  }
});

test("what is learned is the payer's own arithmetic, to the cent", async () => {
  const { services } = await throughPayment();

  /**
   * Derived independently from the advice rather than restated from the code under test: the whole
   * claim of this feature is `allowed = charge − CO`, and asserting it against a figure this system
   * produced would be checking its arithmetic against its own arithmetic.
   */
  const learned = await services.allowedAmounts.listForPayer("delta-dental");
  assert.ok(learned.length > 0);

  for (const rate of learned) {
    const planLine = PLAN.find((l) => l.code === rate.cdtCode);
    if (!planLine) continue;
    assert.equal(rate.charged, planLine.fee, `${rate.cdtCode}: learned against the fee actually billed`);
    assert.ok(
      rate.charged - rate.allowed > 0,
      `${rate.cdtCode}: the write-off is what makes this a contracted rate`
    );
  }
});

test("two patients on the same payer confirm the rate rather than duplicating it", async () => {
  const one = await throughPayment();
  const two = await throughPayment([
    { firstName: "Ada", lastName: "Alpha", dob: "1990-04-12", memberId: "ABC12345" },
    { firstName: "Bo", lastName: "Beta", dob: "1988-01-02", memberId: "ABC12346" },
  ]);

  const single = await one.services.allowedAmounts.listForPayer("delta-dental");
  const doubled = await two.services.allowedAmounts.listForPayer("delta-dental");

  assert.deepEqual(
    doubled.map((r) => r.cdtCode),
    single.map((r) => r.cdtCode),
    "one row per code, however many patients arrive"
  );
  for (const rate of doubled) {
    assert.ok(rate.observations >= 2, `${rate.cdtCode} was seen on both patients' advices`);
    assert.equal(rate.restatements, 1, `${rate.cdtCode}: the payer has not contradicted itself`);
  }
});

test("the first quote is off billed fees, because nothing has been observed yet", async () => {
  /**
   * The honest starting state. A practice on its first day with a payer has no remittance history,
   * so there is no contracted rate to quote from and the billed fee is the only figure available.
   * This is also the permanent behaviour for any code a payer has never adjudicated.
   */
  const { detailed } = await throughPayment();
  const claim = detailed[0]!.claim;

  const billed = PLAN.reduce((t, l) => t + l.fee, 0);
  assert.equal(claim.totalFee, billed);
  assert.equal(
    claim.expectedInsurancePays + claim.expectedPatientPays,
    billed,
    "with no third bucket to put it in, the whole fee is split between payer and patient"
  );
});

test("a LATER patient is quoted from the contract the payer has since stated (F-1)", async () => {
  /**
   * The whole point, end to end. One patient goes through: verify, file, get paid. The payer's advice
   * states its contracted reductions, the profile records them, and the NEXT patient with the same
   * plan is quoted against those rates instead of the practice's price list.
   *
   * Both directions are asserted, because the defect ran both ways: the patient is quoted LESS (they
   * were being billed a write-off nobody owed) and insurance is expected to pay LESS (a percentage of
   * a number the payer never agreed to). A change in only one direction would mean the write-off had
   * merely been moved rather than recognised.
   */
  const first = await throughPayment();
  const learned = await first.services.allowedAmounts.listForPayer("delta-dental");
  assert.ok(learned.length > 0, "the payer stated rates on the first advice");

  // A second patient, same payer, same plan — now with the schedule in hand.
  const second = await first.demo.verification.create({
    patient: {
      firstName: "Bo",
      lastName: "Beta",
      dateOfBirth: "1988-01-02",
      memberId: "ABC12346",
      address: SYNTHETIC_ADDRESS,
    },
    cardText: `Delta Dental
Member ID: ABC12346`,
    planItems: PLAN,
  });

  const before = first.detailed[0]!.claim;
  const after = second.record.calculation!;
  const billed = PLAN.reduce((t, l) => t + l.fee, 0);

  assert.equal(after.totalFee, billed, "the practice still bills what it bills");
  assert.ok(after.totalContractualWriteOff > 0, "the contract is now visible in the quote");
  assert.equal(
    after.totalInsurancePays + after.totalPatientPays + after.totalContractualWriteOff,
    billed,
    "and the billed fee splits three ways, exactly"
  );

  assert.ok(
    after.totalPatientPays < before.expectedPatientPays,
    `the patient is quoted less than the first patient was: ${after.totalPatientPays} vs ${before.expectedPatientPays}`
  );
  assert.ok(
    after.totalInsurancePays < before.expectedInsurancePays,
    "and insurance is expected to pay a percentage of the ALLOWANCE, not of the fee"
  );
  assert.equal(
    before.expectedPatientPays - after.totalPatientPays + (before.expectedInsurancePays - after.totalInsurancePays),
    after.totalContractualWriteOff,
    "every cent of the correction is the write-off, split between the two parties that were carrying it"
  );
});
