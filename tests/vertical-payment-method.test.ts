/**
 * A payer that charges the practice to pay it, from the 835 all the way to the screen's data.
 *
 * The unit tests either side of this prove their own halves: the engine decides what a payment
 * method means, and the fold decides what a per-payer rollup means. Neither proves they are
 * CONNECTED — that the observation leaves Remittance, survives the bus, reaches the payer profile,
 * and turns into the rows the Money screen reads. That join is what this covers, and it is the part
 * that silently does nothing if a subscription is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const { build835 } = await import("../platform/edi/mock/x12-835.ts");

const NOW = new Date("2026-08-10T09:00:00Z");

const crownAdvice = (over: { trace: string; method: string; control?: string }) =>
  build835({
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: over.trace,
    paymentTotal: 650,
    paymentDate: "2026-08-10",
    paymentMethod: over.method,
    claims: [
      {
        patientControlNumber: over.control ?? "MRM-000123",
        statusCode: "1",
        charged: 1250,
        paid: 650,
        patientResponsibility: 162,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [
          {
            procedureCode: "D2750",
            charged: 1250,
            paid: 650,
            adjustments: [
              { group: "CO", code: "45", amount: 438 },
              { group: "PR", code: "2", amount: 162 },
            ],
          },
        ],
      },
    ],
  });

const expectation = (control: string) => ({
  claimId: `claim-${control}`,
  verificationId: "ver-1",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: control,
  payerControlNumber: "556677889",
  totalFee: cents(1250),
  expectedInsurancePays: cents(650),
  serviceDate: "2026-07-27",
});

test("a cheque from a payer reaches the payer profile, and the Money screen's data", async () => {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });

  await services.remittance.recordExpectation(expectation("MRM-000123") as never);
  await services.remittance.ingestRaw(crownAdvice({ trace: "CHK-0001", method: "CHK" }), NOW);
  await bus.drain();

  const summary = await services.paymentMethods.summary();
  assert.equal(summary.length, 1, "the observation must have crossed the bus and been recorded");
  assert.equal(summary[0]!.payerName, "Delta Dental");
  assert.equal(summary[0]!.payments, 1);
  assert.equal(summary[0]!.latestMethod, "CHK");
  assert.equal(summary[0]!.paymentTotal, cents(650));
  /**
   * No merchant rate is configured in a test environment, which is also the production default. The
   * payment is still recorded and still reported — only its price is withheld, and `unpricedPayments`
   * is what stops the screen presenting an absent cost as a cost of nothing.
   */
  assert.equal(summary[0]!.feeCents, null);
  assert.equal(summary[0]!.unpricedPayments, 1);
});

test("an ACH payer never appears — the screen stays silent when nothing is wrong", async () => {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });

  await services.remittance.recordExpectation(expectation("MRM-000123") as never);
  await services.remittance.ingestRaw(crownAdvice({ trace: "ACH-0001", method: "ACH" }), NOW);
  await bus.drain();

  assert.deepEqual(await services.paymentMethods.summary(), []);
});

test("a payer that switches from ACH to cheque arrives flagged as a reversion", async () => {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });

  await services.remittance.recordExpectation(expectation("MRM-000123") as never);
  await services.remittance.recordExpectation(expectation("MRM-000124") as never);

  await services.remittance.ingestRaw(crownAdvice({ trace: "ACH-0001", method: "ACH" }), NOW);
  await services.remittance.ingestRaw(
    crownAdvice({ trace: "CHK-0009", method: "CHK", control: "MRM-000124" }),
    new Date("2026-09-10T09:00:00Z")
  );
  await bus.drain();

  const summary = await services.paymentMethods.summary();
  assert.equal(summary.length, 1, "only the cheque is a finding; the ACH month said nothing");
  assert.equal(summary[0]!.reverted, true, "and it must arrive at the screen already knowing it is a relapse");
});

test("a redelivered observation does not become a second payment on the screen", async () => {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });

  await services.remittance.recordExpectation(expectation("MRM-000123") as never);
  await services.remittance.ingestRaw(crownAdvice({ trace: "CHK-0001", method: "CHK" }), NOW);

  /**
   * Drained repeatedly on purpose. Delivery is at-least-once, and the subscriber is keyed on the
   * remittance id precisely so a retry overwrites its own row rather than counting another fee.
   */
  for (let i = 0; i < 3; i++) await bus.drain();

  const summary = await services.paymentMethods.summary();
  assert.equal(summary[0]!.payments, 1);
});
