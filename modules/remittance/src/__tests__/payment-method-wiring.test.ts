/**
 * The payment-method observation, driven through real ingestion rather than called directly.
 *
 * `payment-method.test.ts` pins the engine's arithmetic. This pins that the engine is actually
 * REACHED by traffic, that it reads the previous payment from the store rather than from an
 * argument a test invented, and — the half that decides whether the feature is usable — that it
 * stays silent on the advices where a fee was never charged. A detector that fires on every denial
 * is a detector somebody switches off in a week.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import type { ClaimSubmittedBody, DomainEvent } from "@mermaid/events";
import {
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceService,
} from "../index.ts";

const { build835 } = await import("../../../../platform/edi/mock/x12-835.ts");

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});

function wired(merchantRateBps: number | null = 295) {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const expectations = new InMemoryExpectationRepository();
  const service = new RemittanceService(repo, expectations, new MockEdiAdapter(), bus, null, merchantRateBps);

  const observed: DomainEvent<"remittance.payment_method_observed">[] = [];
  bus.subscribe("remittance.payment_method_observed", "test:collector", async (e) => {
    observed.push(e);
  });
  return { bus, repo, service, observed };
}

const submitted = (control: string): ClaimSubmittedBody => ({
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

/**
 * A single crown, adjudicated the way a PPO actually does it: billed $1,250, a $438 contractual
 * write-off down to the $812 allowed amount, $650 to the practice and $162 of coinsurance to Ada.
 */
const crownAdvice = (over: { trace: string; method?: string; control?: string }) =>
  build835({
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: over.trace,
    paymentTotal: 650,
    paymentDate: "2026-08-10",
    paymentMethod: over.method ?? "ACH",
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

// ── First detection ───────────────────────────────────────────────────────────────────

test("a payer that pays by cheque is observed, with the fee it cost to receive", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));

  const view = await service.ingestRaw(crownAdvice({ trace: "CHK-0001", method: "CHK" }), NOW);
  assert.equal(view.remittance.status, "posted", "the observation must not have disturbed posting");
  await bus.drain();

  assert.equal(observed.length, 1);
  const body = observed[0]!.payload;
  assert.equal(body.method, "CHK");
  assert.equal(body.payerName, "Delta Dental");
  assert.equal(body.paymentTotal, cents(650));
  // 65000 × 0.0295 = 1917.5 → 1918 cents.
  assert.equal(body.feeCents, 1918);
  assert.equal(body.reverted, false, "nothing to revert from on a first sighting");
  assert.equal(body.priorMethod, null);
  /**
   * Payer-QUALIFIED, per migration 0020: two payers may both send trace "1001" and they are two
   * payments. That qualification is what makes this key usable as provenance — it identifies the
   * payment, not merely the number the payer printed on it.
   */
  assert.equal(body.dedupeKey, "DELTA DENTAL|CHK-0001", "the key that makes this payment countable once");
});

test("an ACH payment says nothing at all", async () => {
  const { service, observed, bus } = wired();
  await service.recordExpectation(submitted("MRM-000123"));
  await service.ingestRaw(crownAdvice({ trace: "ACH-0001", method: "ACH" }), NOW);
  await bus.drain();
  assert.equal(observed.length, 0, "an event on every normal remittance is how an outbox becomes noise");
});

test("without a merchant rate the observation still fires, carrying no invented cost", async () => {
  const { service, observed, bus } = wired(null);
  await service.recordExpectation(submitted("MRM-000123"));
  await service.ingestRaw(crownAdvice({ trace: "CHK-0002", method: "CHK" }), NOW);
  await bus.drain();

  assert.equal(observed.length, 1, "detection must not depend on knowing the price");
  assert.equal(observed[0]!.payload.feeCents, null);
});

// ── The reversion, which is the part no human catches unaided ─────────────────────────

test("a payer that paid by ACH and has switched to a card is flagged as a REVERSION", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));
  await service.recordExpectation(submitted("MRM-000124"));

  // Month one: ACH, silent.
  await service.ingestRaw(crownAdvice({ trace: "ACH-0001", method: "ACH" }), NOW);
  await bus.drain();
  assert.equal(observed.length, 0);

  // Month two: the same payer, now by cheque. The prior method comes from the STORE, not from a
  // value this test handed in — which is the whole point of driving it through ingestion.
  const later = new Date("2026-09-10T09:00:00Z");
  await service.ingestRaw(
    crownAdvice({ trace: "CHK-0009", method: "CHK", control: "MRM-000124" }),
    later
  );
  await bus.drain();

  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.payload.reverted, true);
  assert.equal(observed[0]!.payload.priorMethod, "ACH", "and it must name what it used to do");
});

test("a payer that has always paid by cheque is not a reversion", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));
  await service.recordExpectation(submitted("MRM-000124"));

  await service.ingestRaw(crownAdvice({ trace: "CHK-0001", method: "CHK" }), NOW);
  await service.ingestRaw(
    crownAdvice({ trace: "CHK-0002", method: "CHK", control: "MRM-000124" }),
    new Date("2026-09-10T09:00:00Z")
  );
  await bus.drain();

  assert.equal(observed.length, 2, "both are still fee events");
  assert.equal(observed[1]!.payload.reverted, false, "but neither is a relapse");
});

// ── Suppression: advices where no fee was ever charged ────────────────────────────────

test("a denial-only advice moved no money and raises no fee observation", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));

  // The whole charge denied for no pre-authorisation; nothing paid, so nothing was run through a
  // card terminal. BPR04 `NON` is what a payer legitimately sends here.
  const denialOnly = build835({
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: "NON-0001",
    paymentTotal: 0,
    paymentDate: "2026-08-10",
    paymentMethod: "NON",
    claims: [
      {
        patientControlNumber: "MRM-000123",
        statusCode: "4",
        charged: 1250,
        paid: 0,
        patientResponsibility: 0,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [
          {
            procedureCode: "D2750",
            charged: 1250,
            paid: 0,
            adjustments: [{ group: "CO", code: "197", amount: 1250 }],
          },
        ],
      },
    ],
  });

  await service.ingestRaw(denialOnly, NOW);
  await bus.drain();
  assert.equal(observed.length, 0, "there are more denials than card payments; this must stay quiet");
});

test("a reversal raises no fee observation, and never a positive fee on negative money", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));

  const reversal = build835({
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: "REV-0001",
    paymentTotal: -650,
    paymentDate: "2026-08-10",
    paymentMethod: "CHK",
    claims: [
      {
        patientControlNumber: "MRM-000123",
        statusCode: "22",
        charged: -1250,
        paid: -650,
        patientResponsibility: -162,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [
          {
            procedureCode: "D2750",
            charged: -1250,
            paid: -650,
            adjustments: [
              { group: "CO", code: "45", amount: -438 },
              { group: "PR", code: "2", amount: -162 },
            ],
          },
        ],
      },
    ],
  });

  await service.ingestRaw(reversal, NOW);
  await bus.drain();
  assert.equal(observed.length, 0);
});

// ── Idempotency ───────────────────────────────────────────────────────────────────────

test("the same advice delivered twice is one payment, and one observation", async () => {
  const { service, observed, bus } = wired(295);
  await service.recordExpectation(submitted("MRM-000123"));

  const raw = crownAdvice({ trace: "CHK-0001", method: "CHK" });
  await service.ingestRaw(raw, NOW);
  // A clearinghouse re-serving an ERA and a user re-uploading a file are ordinary traffic, not edge
  // cases — `remittances_one_per_dedupe_key` is what makes them one payment.
  await service.ingestRaw(raw, new Date("2026-08-11T09:00:00Z"));
  await bus.drain();

  assert.equal(observed.length, 1, "a redelivered payment was not charged a second fee");
  assert.equal(observed[0]!.payload.dedupeKey, "DELTA DENTAL|CHK-0001");
});
