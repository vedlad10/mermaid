/**
 * A payer that quietly stops honouring its own rate, from the 835 to the stored finding (F2).
 *
 * The unit tests beside the engine prove the fold's judgement. Nothing there proves the fold is
 * CONNECTED — that an allowance observed on a real advice leaves Remittance, survives the bus,
 * reaches the second subscriber, and becomes an epoch. That join is what this covers, and it is the
 * part that silently does nothing if a subscription is missing.
 *
 * Every figure below balances as an 835 must: charged = paid + patient responsibility + contractual.
 * A file that does not balance is held rather than posted, and a held advice publishes nothing —
 * which would make every assertion here pass for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const { build835 } = await import("../platform/edi/mock/x12-835.ts");

const CHARGED = 1250;

/**
 * One crown, adjudicated at a stated allowance.
 *
 * `contractual` is the CO-45 write-off, so the allowance the payer is stating is `1250 − CO`. The
 * patient's coinsurance is taken off that, and the remainder is what the payer paid — which is how
 * a real advice is shaped and why changing one number here changes three.
 */
const crown = (over: {
  trace: string;
  control: string;
  contractual: number;
  patient: number;
  payerName?: string;
  date?: string;
}) => {
  const paid = CHARGED - over.contractual - over.patient;
  return build835({
    payerName: over.payerName ?? "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: over.trace,
    paymentTotal: paid,
    paymentDate: over.date ?? "2026-03-04",
    paymentMethod: "ACH",
    claims: [
      {
        patientControlNumber: over.control,
        statusCode: "1",
        charged: CHARGED,
        paid,
        patientResponsibility: over.patient,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [
          {
            procedureCode: "D2750",
            charged: CHARGED,
            paid,
            adjustments: [
              { group: "CO", code: "45", amount: over.contractual },
              { group: "PR", code: "2", amount: over.patient },
            ],
          },
        ],
      },
    ],
  });
};

const expectation = (control: string) => ({
  claimId: `claim-${control}`,
  verificationId: "ver-1",
  submittedAt: "2026-02-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: control,
  payerControlNumber: "556677889",
  totalFee: cents(CHARGED),
  expectedInsurancePays: cents(900),
  serviceDate: "2026-02-27",
});

/** The practice's own fee schedule as Delta stated it: $1,125.00 allowed on a $1,250.00 crown. */
const AT_RATE = { contractual: 125, patient: 225 };
/** The same crown, $145.00 lighter, with no notice given. */
const CUT = { contractual: 270, patient: 196 };

async function practice() {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });
  for (const n of [123, 124, 125, 126]) await services.remittance.recordExpectation(expectation(`MRM-000${n}`) as never);
  return { bus, services };
}

const ingest = async (
  s: Awaited<ReturnType<typeof practice>>,
  advice: string,
  at: string
): Promise<void> => {
  await s.services.remittance.ingestRaw(advice, new Date(at));
  await s.bus.drain();
};

test("the first advice teaches a rate and reports nothing wrong", async () => {
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");

  const history = await s.services.allowedVariances.history("delta-dental", "D2750");
  assert.equal(history.length, 1, "the observation must have crossed the bus and opened an epoch");
  assert.equal(history[0]!.status, "confirmed");
  assert.equal(history[0]!.allowed, cents(1125), "1250 charged less the 125 Delta wrote off");
  assert.equal(history[0]!.charged, cents(1250));
  assert.equal(history[0]!.observedPayerName, "Delta Dental");
  assert.deepEqual(await s.services.allowedVariances.findings(), []);
});

test("a silent cut is caught, and the rate it is short of is still on file", async () => {
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");
  await ingest(
    s,
    crown({ trace: "ACH-2", control: "MRM-000124", ...CUT, date: "2026-08-19" }),
    "2026-08-19T09:00:00Z"
  );

  const findings = await s.services.allowedVariances.findings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.classification, "line-underpayment");
  assert.equal(findings[0]!.expected, cents(1125));
  assert.equal(findings[0]!.observed, cents(980));
  assert.equal(findings[0]!.delta, cents(-145));
  assert.equal(findings[0]!.recoverable, true);
  assert.equal(findings[0]!.cdtCode, "D2750");

  const history = await s.services.allowedVariances.history("delta-dental", "D2750");
  assert.equal(history.find((e) => e.status === "confirmed")!.allowed, cents(1125));

  /**
   * The contrast that is the whole reason F2 exists, asserted side by side so it cannot be
   * accidentally "fixed" by making the learner overwrite here too. `payer_allowed_amounts` has
   * already forgotten $1,125.00 — correctly, for its own purpose, which is quoting the patient what
   * the payer is charging TODAY. F2 still holds it, because that is what an appeal is written from.
   */
  const learned = (await s.services.allowedAmounts.find("delta-dental", "D2750"))!;
  assert.equal(learned.allowed, cents(980), "the learner keeps only the current rate, as it always did");
});

test("a third short advice promotes the cut and CLOSES the old rate rather than erasing it", async () => {
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");
  await ingest(s, crown({ trace: "ACH-2", control: "MRM-000124", ...CUT, date: "2026-08-19" }), "2026-08-19T09:00:00Z");
  await ingest(s, crown({ trace: "ACH-3", control: "MRM-000125", ...CUT, date: "2026-09-02" }), "2026-09-02T09:00:00Z");
  await ingest(s, crown({ trace: "ACH-4", control: "MRM-000126", ...CUT, date: "2026-09-14" }), "2026-09-14T09:00:00Z");

  const history = await s.services.allowedVariances.history("delta-dental", "D2750");
  const original = history.find((e) => e.seq === 1)!;
  assert.equal(original.status, "superseded");
  assert.equal(original.allowed, cents(1125), "still provable after the payer stopped honouring it");
  assert.equal(original.openedAt, "2026-03-04T09:00:00.000Z");
  assert.ok(original.closedAt !== null, "and bounded, so the date range can be quoted back at the payer");

  assert.equal(history.find((e) => e.status === "confirmed")!.allowed, cents(980));

  const findings = await s.services.allowedVariances.findings();
  assert.equal(findings[0]!.classification, "schedule-drift", "most recent first");
  assert.equal(findings[0]!.recoverable, false);
  assert.equal(
    (await s.services.allowedVariances.findings({ recoverableOnly: true })).length,
    2,
    "the two short payments before the schedule moved are still money to pursue"
  );
});

test("a claim repriced under another network's name is named as that, not as a mystery", async () => {
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");
  await ingest(
    s,
    crown({
      trace: "ACH-2",
      control: "MRM-000124",
      ...CUT,
      date: "2026-08-19",
      payerName: "Connection Dental Network",
    }),
    "2026-08-19T09:00:00Z"
  );

  const findings = await s.services.allowedVariances.findings();
  assert.equal(findings[0]!.classification, "leased-network");
  assert.equal(findings[0]!.observedPayerName, "Connection Dental Network");
  assert.equal(
    findings[0]!.payerId,
    "delta-dental",
    "the contracted payer is still the claim's own, taken from the expectation rather than from the advice"
  );
});

test("a redelivered advice does not become a second shortfall, or a second sighting", async () => {
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");
  await ingest(s, crown({ trace: "ACH-2", control: "MRM-000124", ...CUT, date: "2026-08-19" }), "2026-08-19T09:00:00Z");

  /**
   * Drained repeatedly on purpose. Delivery is at-least-once, and the epoch fold is NOT idempotent
   * on its own — a second delivery would count as a second sighting and could corroborate a
   * candidate only one advice ever supported. The per-subscriber checkpoint is what stops it, which
   * is why this asserts the epoch counts as well as the finding count.
   */
  for (let i = 0; i < 3; i++) await s.bus.drain();

  assert.equal((await s.services.allowedVariances.findings()).length, 1);
  const history = await s.services.allowedVariances.history("delta-dental", "D2750");
  assert.equal(history.length, 2);
  assert.equal(history.find((e) => e.status === "confirmed")!.observations, 1);
  assert.equal(history.find((e) => e.status === "candidate")!.observations, 1);
});

test("an advice with no contractual reduction states no rate, so it opens no epoch", async () => {
  // `allowedFromLine` learns only from CO. A line paid at full price says the contract may have
  // lapsed — which 0028 already records — and says nothing about what the rate IS.
  const s = await practice();
  await ingest(
    s,
    crown({ trace: "ACH-1", control: "MRM-000123", contractual: 0, patient: 250 }),
    "2026-03-04T09:00:00Z"
  );
  assert.deepEqual(await s.services.allowedVariances.history("delta-dental", "D2750"), []);
});

test("F2 changes nothing about what the existing learner records", async () => {
  /**
   * Shadow mode, asserted rather than asserted-to. The learned-rate path is what a patient quote
   * will eventually be computed from, and the case for adding a second subscriber instead of
   * changing the first one is only worth anything if this stays true.
   */
  const s = await practice();
  await ingest(s, crown({ trace: "ACH-1", control: "MRM-000123", ...AT_RATE }), "2026-03-04T09:00:00Z");
  await ingest(s, crown({ trace: "ACH-2", control: "MRM-000124", ...CUT, date: "2026-08-19" }), "2026-08-19T09:00:00Z");

  const learned = (await s.services.allowedAmounts.find("delta-dental", "D2750"))!;
  assert.equal(learned.allowed, cents(980));
  assert.equal(learned.observations, 2);
  assert.equal(learned.restatements, 2, "one restatement on top of the first sighting");
  assert.equal(learned.fullPriceSince, 0);
});
