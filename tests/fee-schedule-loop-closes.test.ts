/**
 * F-1's loop closes: what the payer wrote off is what the next estimate predicts.
 *
 * ── THE PROPERTY ───────────────────────────────────────────────────────────────────────────────
 * The system learns a contracted rate from a payer's own write-off, then quotes the next patient
 * from it. If those two figures disagree, the whole feature is decoration: the practice would be
 * quoting from a "contracted rate" the payer does not actually apply.
 *
 * Nothing else tests this. `fee-schedule-learning.test.ts` proves a rate is learned and that a later
 * quote uses it; `contracted-allowance.test.ts` proves the estimate arithmetic. Neither asks whether
 * the learned number MATCHES what the payer does — they could both be internally consistent and
 * jointly wrong, which is exactly how a closed loop fails.
 *
 * The mock applies a 10% contractual reduction (`CONTRACTUAL_RATE`), so a $1,250.00 crown is allowed
 * at $1,125.00 and $125.00 is written off. That figure is derived here from the CONSTANT rather than
 * hard-coded, so a change to the mock's rate moves the expectation with it and this test keeps
 * asking the real question instead of a stale one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter, CONTRACTUAL_RATE } from "@mermaid/edi";
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
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

/** Verify a patient, file, and take the payer's advice — the cycle that teaches a rate. */
async function cycle(services: ReturnType<typeof buildServices>, memberId: string, first: string) {
  const demo = services.via(new MockEdiAdapter());
  const verification = await demo.verification.create({
    patient: { firstName: first, lastName: "Test", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
    cardText: `Delta Dental\nMember ID: ${memberId}`,
    planItems: PLAN,
  });

  for (const item of await demo.claims.list({ status: "ready" })) {
    if (item.canSubmit) await demo.claims.submit(item.id, { submittedBy: "loop.test@clinic" });
  }
  const submitted = await demo.claims.list({ status: "submitted" });
  const detailed = (await Promise.all(submitted.map((i) => demo.claims.get(i.id)))).filter(
    (v): v is NonNullable<typeof v> => v !== null && v.claim.submission !== null && v.claim.payer.payerId !== null
  );
  for (const v of detailed) {
    await demo.remittance.fetchAndIngest({
      payerId: v.claim.payer.payerId!,
      payerName: v.claim.payer.payerName ?? "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      claims: [
        {
          patientControlNumber: v.claim.submission!.patientControlNumber,
          payerControlNumber: v.claim.submission!.controlNumber,
          patientFirstName: v.claim.patient.firstName,
          patientLastName: v.claim.patient.lastName,
          memberId: v.claim.patient.memberId,
          lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
          expectedInsurancePays: v.claim.expectedInsurancePays,
        },
      ],
    });
  }
  return { demo, verification };
}

test("the rate learned from a payer's write-off is the rate that payer actually applies", async () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  await cycle(services, "ABC12345", "Ada");

  const learned = await services.allowedAmounts.listAll();
  assert.ok(learned.length > 0, "the payer stated contractual reductions and none were learned");

  for (const rate of learned) {
    const billed = PLAN.find((l) => l.code === rate.cdtCode)?.fee;
    if (billed === undefined) continue;
    /**
     * Derived from the mock's own constant, not restated. `charged − charged × rate`, rounded the
     * way integer cents force — which is the same arithmetic the adjudicator does, expressed
     * independently rather than copied.
     */
    const expectedAllowed = billed - Math.round(billed * CONTRACTUAL_RATE);
    assert.equal(
      rate.allowed,
      expectedAllowed,
      `${rate.cdtCode}: learned ${rate.allowed} but the payer allows ${expectedAllowed}`
    );
  }
});

test("the next patient's predicted write-off is the one the payer will actually take", async () => {
  /**
   * The closing of the loop. First patient teaches the rate; second is quoted from it; the predicted
   * write-off must equal what the payer took on the first — otherwise the practice is quoting a
   * discount the payer does not give, which is worse than quoting the list price.
   */
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  await cycle(services, "ABC12345", "Ada");

  const demo = services.via(new MockEdiAdapter());
  const second = await demo.verification.create({
    patient: { firstName: "Bo", lastName: "Beta", dateOfBirth: "1988-01-02", memberId: "ABC12346", address: SYNTHETIC_ADDRESS },
    cardText: "Delta Dental\nMember ID: ABC12346",
    planItems: PLAN,
  });

  const calc = second.record.calculation!;
  assert.ok(calc.totalContractualWriteOff > 0, "the second quote should be priced against the learned contract");

  const crown = calc.lines.find((l) => l.code === "D2750")!;
  const billed = cents(1250);
  const expectedWriteOff = Math.round(billed * CONTRACTUAL_RATE);
  assert.equal(
    crown.contractualWriteOff,
    expectedWriteOff,
    `predicted ${crown.contractualWriteOff} but the payer takes ${expectedWriteOff}`
  );
  assert.equal(crown.allowedAmount, billed - expectedWriteOff);
});

test("quoting from the contract makes the estimate closer to what the payer pays, not further", async () => {
  /**
   * The outcome F-1 exists for, stated as a comparison rather than an assertion about one number.
   * The second patient — quoted against the learned rate — must land nearer the payer's actual
   * payment than the first, who was quoted off the practice's list price. If it did not, the whole
   * feature would be moving the estimate in the wrong direction while looking busy.
   */
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const { verification: firstQuote } = await cycle(services, "ABC12345", "Ada");
  const { verification: secondQuote } = await cycle(services, "ABC12346", "Bo");

  const demo = services.via(new MockEdiAdapter());
  const claims = await Promise.all((await demo.claims.list()).map((c) => demo.claims.get(c.id)));
  const paid = claims.filter((c) => c !== null && c.claim.payments.length > 0);
  assert.ok(paid.length >= 2, "both cycles produced a paid claim");

  const errorOf = (expected: number, claimPaid: number) => Math.abs(claimPaid - expected);
  const firstError = errorOf(firstQuote.record.calculation!.totalInsurancePays, paid[0]!.paidAmount);
  const secondError = errorOf(secondQuote.record.calculation!.totalInsurancePays, paid[1]!.paidAmount);

  assert.ok(
    secondError <= firstError,
    `the contracted quote was further out (${secondError}) than the list-price quote (${firstError})`
  );
});
