/**
 * Two statutory clocks, from the 835 to the stored demand (F5).
 *
 * The unit tests beside the engine prove the arithmetic and — more of them — prove the refusals.
 * Nothing there proves the clock is CONNECTED: that a filing date leaves the expectation, a PLB
 * leaves the advice, both survive the bus, and become a finding somebody can act on. That join is
 * what this covers, and it is the part that silently does nothing if a subscription is missing.
 *
 * ── WHY THE JURISDICTION IS PASSED IN ──────────────────────────────────────────────────────────
 * The default comes from `BILLING_PROVIDER_STATE`, and the laptop demo's synthetic practice is in
 * California — which has no verified rule, deliberately (see `statutes.ts`). A test that took the
 * default would pass while finding nothing, which is the shape of a test proving the feature is
 * switched off.
 *
 * It is passed to `buildServices` rather than set in the environment because `getConfig` caches on
 * first read: every test in this file shares one process, so an env write inside the second test
 * would be silently ignored and that test would assert against the FIRST test's state. That is not
 * hypothetical — it is what this file did before the seam existed, and the Texas cases passed as
 * New Jersey.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const { build835 } = await import("../platform/edi/mock/x12-835.ts");

const CHARGED = 1250;
const CONTRACTUAL = 125;
const PATIENT = 225;
const PAID = CHARGED - CONTRACTUAL - PATIENT; // 900

/**
 * One crown, adjudicated. `takebacks` become PLB segments against the payment as a whole.
 *
 * `paymentTotal` is the claim payment MINUS whatever the payer withheld at the provider level,
 * which is how a real advice balances: the file reconciles as
 * `payments received = amount posted − provider adjustments`.
 */
const advice = (over: {
  trace: string;
  control: string;
  paymentDate: string;
  carc?: { group: string; code: string };
  takebacks?: { reasonCode: string; referenceId?: string; amount: number }[];
  interestPaid?: number;
}) => {
  const plb = [
    ...(over.takebacks ?? []).map((t) => ({ providerId: "1234567893", ...t })),
    ...(over.interestPaid ? [{ providerId: "1234567893", reasonCode: "L6", amount: -over.interestPaid }] : []),
  ];
  const withheld = plb.reduce((sum, p) => sum + p.amount, 0);

  return build835({
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    traceNumber: over.trace,
    paymentTotal: PAID - withheld,
    paymentDate: over.paymentDate,
    paymentMethod: "ACH",
    providerAdjustments: plb.length > 0 ? plb : undefined,
    claims: [
      {
        patientControlNumber: over.control,
        statusCode: "1",
        charged: CHARGED,
        paid: PAID,
        patientResponsibility: PATIENT,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [
          {
            procedureCode: "D2750",
            charged: CHARGED,
            paid: PAID,
            adjustments: [
              { group: "CO", code: "45", amount: CONTRACTUAL },
              { group: "PR", code: "2", amount: PATIENT },
              ...(over.carc ? [{ ...over.carc, amount: 0 }] : []),
            ],
          },
        ],
      },
    ],
  });
};

const expectation = (control: string, submittedAt: string) => ({
  claimId: `claim-${control}`,
  verificationId: "ver-1",
  submittedAt,
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: control,
  payerControlNumber: "556677889",
  totalFee: cents(CHARGED),
  expectedInsurancePays: cents(PAID),
  serviceDate: "2026-05-30",
});

async function practice(jurisdiction = "NJ") {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus, jurisdiction });
  return { bus, services };
}

/**
 * Ingest, and release if the safety gate held it.
 *
 * A PLB over the review threshold HOLDS the advice, which is correct and is also why the clock
 * publishes from `#post` rather than from ingestion: a demand raised off a payment a human has not
 * accepted is a letter about money the practice may never have. Releasing is what a biller would do,
 * and it is the path a recoupment finding actually travels.
 */
async function ingest(
  s: Awaited<ReturnType<typeof practice>>,
  raw: string,
  at: string
): Promise<void> {
  const view = await s.services.remittance.ingestRaw(raw, new Date(at));
  if (view.remittance.status === "held") {
    await s.services.remittance.release(view.remittance.id, "biller@clinic", "Reviewed the takeback.", new Date(at));
  }
  await s.bus.drain();
}

// ── Prompt pay ──────────────────────────────────────────────────────────────────────────────────

test("a payer 60 days late produces an interest demand with the statute on it", async () => {
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-06-01T10:00:00.000Z") as never);
  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31" }), "2026-07-31T09:00:00Z");

  const findings = await s.services.statutoryClock.findings({ kind: "prompt-pay-interest" });
  assert.equal(findings.length, 1, "the observation must have crossed the bus and been assessed");
  assert.equal(findings[0]!.subject, "MRM-000123");
  assert.equal(findings[0]!.state, "NJ");
  assert.equal(findings[0]!.payerId, "delta-dental", "the slug from the claim's own expectation");
  // $900.00 × 12% × 30 late days / 365 = $8.88
  assert.equal(findings[0]!.claimedCents, cents(8.88));
  assert.equal(findings[0]!.recoveredCents, 0, "detected is not collected");
  assert.equal(findings[0]!.outcome, "open");
  assert.match(findings[0]!.citation, /N\.J\.S\.A\. 17B:30-51/);
  assert.ok(
    findings[0]!.defeasibleBy.some((d) => /ERISA/.test(d)),
    "the demand must not reach a worklist without the preemption that could defeat it"
  );
});

test("a payer that paid inside the window is never mentioned", async () => {
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-07-10T10:00:00.000Z") as never);
  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31" }), "2026-07-31T09:00:00Z");

  assert.deepEqual(await s.services.statutoryClock.findings(), []);
});

test("a claim the payer asked for information on raises nothing, however late it was", async () => {
  // CARC 16 means the clock restarts from the date the information arrived, and that date is not on
  // an 835. Accruing from the original filing is the version of this the payer disproves with our
  // own evidence.
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-06-01T10:00:00.000Z") as never);
  await ingest(
    s,
    advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31", carc: { group: "CO", code: "16" } }),
    "2026-07-31T09:00:00Z"
  );

  assert.deepEqual(await s.services.statutoryClock.findings(), []);
});

test("interest the payer already paid at the provider level suppresses the demand", async () => {
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-06-01T10:00:00.000Z") as never);
  await ingest(
    s,
    advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31", interestPaid: 8.88 }),
    "2026-07-31T09:00:00Z"
  );

  assert.deepEqual(
    await s.services.statutoryClock.findings(),
    [],
    "PLB L6 is the payer saying it already paid this, and demanding it again is the worst thing this feature could do"
  );
});

// ── Recoupment ──────────────────────────────────────────────────────────────────────────────────

test("a takeback outside the window is a dispute; one inside it is not", async () => {
  /**
   * New Jersey has a verified prompt-pay rule and NO verified recoupment window, which is exactly
   * the situation this asserts: the two tables are independent, and a state present in one is not
   * thereby present in the other. Silence here is the correct answer, not a gap.
   */
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-01-02T10:00:00.000Z") as never);
  await s.services.remittance.recordExpectation(expectation("MRM-000124", "2026-08-20T10:00:00.000Z") as never);

  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-01-05" }), "2026-01-05T09:00:00Z");
  await ingest(
    s,
    advice({
      trace: "ACH-2",
      control: "MRM-000124",
      paymentDate: "2026-09-01",
      takebacks: [{ reasonCode: "WO", referenceId: "MRM-000123", amount: 420 }],
    }),
    "2026-09-01T09:00:00Z"
  );

  assert.deepEqual(
    await s.services.statutoryClock.findings({ kind: "recoupment-out-of-time" }),
    [],
    "New Jersey has no verified recoupment window, so nothing may be asserted about one"
  );

  // The payment index is still built, because a rule verified later must not find a hole where this
  // practice's own payment history should be.
  const payment = await s.services.statutoryClock.paymentFor("MRM-000123");
  assert.equal(payment!.paidAt, "2026-01-05");
  assert.equal(payment!.paidCents, cents(PAID));
});

test("in Texas the same takeback is out of time, and the finding carries both dates", async () => {
  const s = await practice("TX");
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-01-02T10:00:00.000Z") as never);
  await s.services.remittance.recordExpectation(expectation("MRM-000124", "2026-08-20T10:00:00.000Z") as never);

  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-01-05" }), "2026-01-05T09:00:00Z");
  await ingest(
    s,
    advice({
      trace: "ACH-2",
      control: "MRM-000124",
      paymentDate: "2026-09-01",
      takebacks: [{ reasonCode: "WO", referenceId: "MRM-000123", amount: 420 }],
    }),
    "2026-09-01T09:00:00Z"
  );

  const findings = await s.services.statutoryClock.findings({ kind: "recoupment-out-of-time" });
  assert.equal(findings.length, 1, "the PLB must have crossed the bus and been dated against the payment index");
  assert.equal(findings[0]!.subject, "MRM-000123", "keyed on the claim the payer named, not the advice's own claim");
  assert.equal(findings[0]!.claimedCents, cents(420));
  assert.equal(findings[0]!.state, "TX");
  assert.match(findings[0]!.citation, /1301\.132/);
  assert.equal(findings[0]!.evidence.daysSinceOriginalPayment, 239);
  assert.equal(findings[0]!.evidence.windowStated, "180 days");
});

test("a takeback naming a claim this system never paid is refused, not guessed", async () => {
  /**
   * The index only holds claims paid since the feature was switched on, so this is ordinary rather
   * than exceptional. A defence built on an invented payment date is one the payer disproves from
   * its own records.
   */
  const s = await practice("TX");
  await s.services.remittance.recordExpectation(expectation("MRM-000124", "2026-08-20T10:00:00.000Z") as never);
  await ingest(
    s,
    advice({
      trace: "ACH-2",
      control: "MRM-000124",
      paymentDate: "2026-09-01",
      takebacks: [{ reasonCode: "WO", referenceId: "MRM-OLD-0001", amount: 420 }],
    }),
    "2026-09-01T09:00:00Z"
  );

  assert.deepEqual(await s.services.statutoryClock.findings({ kind: "recoupment-out-of-time" }), []);
});

// ── Idempotency and savings ─────────────────────────────────────────────────────────────────────

test("a redelivered advice does not become a second demand", async () => {
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-06-01T10:00:00.000Z") as never);
  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31" }), "2026-07-31T09:00:00Z");

  for (let i = 0; i < 3; i++) await s.bus.drain();

  const findings = await s.services.statutoryClock.findings();
  assert.equal(findings.length, 1, "a practice shown the same $8.88 twice will claim it twice");
  assert.equal((await s.services.statutoryClock.savings()).promptPay.claimedCents, cents(8.88));
});

test("the savings report separates what was claimed from what actually came back", async () => {
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-06-01T10:00:00.000Z") as never);
  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-07-31" }), "2026-07-31T09:00:00Z");

  const before = await s.services.statutoryClock.savings();
  assert.equal(before.promptPay.claimedCents, cents(8.88));
  assert.equal(before.promptPay.recoveredCents, 0, "nothing has been collected and it must not read otherwise");

  const raised = (await s.services.statutoryClock.findings())[0]!;
  await s.services.statutoryClock.recordOutcome(
    { remittanceId: raised.remittanceId, kind: "prompt-pay-interest", subject: raised.subject },
    { outcome: "recovered", recoveredCents: cents(8.88), note: "Paid on the November advice." }
  );

  const after = await s.services.statutoryClock.savings();
  assert.equal(after.promptPay.claimedCents, cents(8.88), "claiming is unchanged by collecting");
  assert.equal(after.promptPay.recoveredCents, cents(8.88));
  assert.deepEqual(await s.services.statutoryClock.findings({ openOnly: true }), []);
});

// ── Nothing else moved ──────────────────────────────────────────────────────────────────────────

test("the clock changes no posting, no balance and no hold", async () => {
  /**
   * Shadow mode, asserted rather than asserted-to. An out-of-time recoupment still balances the file
   * — the payer took the money and the ledger has to agree with the bank whether or not the takeback
   * was lawful. What changes is that somebody is now told about it.
   */
  const s = await practice("TX");
  await s.services.remittance.recordExpectation(expectation("MRM-000123", "2026-01-02T10:00:00.000Z") as never);
  await s.services.remittance.recordExpectation(expectation("MRM-000124", "2026-08-20T10:00:00.000Z") as never);

  await ingest(s, advice({ trace: "ACH-1", control: "MRM-000123", paymentDate: "2026-01-05" }), "2026-01-05T09:00:00Z");
  await ingest(
    s,
    advice({
      trace: "ACH-2",
      control: "MRM-000124",
      paymentDate: "2026-09-01",
      takebacks: [{ reasonCode: "WO", referenceId: "MRM-000123", amount: 420 }],
    }),
    "2026-09-01T09:00:00Z"
  );

  const posted = await s.services.remittance.list({});
  assert.equal(posted.length, 2);
  for (const r of posted) assert.equal(r.status, "posted", "both advices still post exactly as they did");

  const reconciliation = await s.services.remittance.reconcileAll();
  assert.equal(reconciliation.balanced, true, "and the file still reconciles against the bank");
});

// ── An advice with no real payment date ─────────────────────────────────────────────────────────

test("an advice whose payment date is not a real day starts no clock, and nothing dead-letters", async () => {
  /**
   * Both clocks run FROM the payment date. An impossible BPR16 (a public 835 sample carries
   * `20002316`) is stored as no date, and `claim_payment_clock.paid_at` is DATE NOT NULL — so in
   * Postgres the subscriber threw on every redelivery until the event dead-lettered. The in-memory
   * store accepted "" silently, which is why no test saw it: what it recorded was a clock with no
   * start.
   */
  const s = await practice();
  await s.services.remittance.recordExpectation(expectation("MRM-000124", "2026-06-01T10:00:00.000Z") as never);
  const raw = advice({ trace: "ACH-NODATE", control: "MRM-000124", paymentDate: "2026-07-31" }).replace(/(BPR\*[^~]*\*)20260731~/, "$120262316~");
  assert.match(raw, /\*20262316~/, "the fixture must carry the impossible date");

  await ingest(s, raw, "2026-07-31T09:00:00Z");

  assert.equal(await s.services.statutoryClock.paymentFor("MRM-000124"), null, "no clock from a date nobody can state");
  assert.deepEqual(await s.services.statutoryClock.findings(), []);
  assert.equal(s.bus.deadLetters().length, 0);
});
