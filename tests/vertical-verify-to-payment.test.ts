/**
 * The complete revenue cycle, end to end: card text → verification → estimate → claim →
 * human submit gate → payer → 835 remittance → posting → estimate-vs-actual variance → recovery
 * queue.
 *
 * Three bounded contexts participate and **none of them imports another**. Everything crosses on the
 * outbox: `verification.completed` → `claim.submitted` → `remittance.posted` / `variance.detected`.
 * This file lives in `tests/` because it is the only place permitted to import more than one module
 * (CI forbids it inside `modules/**`).
 *
 * The assertion the whole architecture exists to make possible is in "the variance is computed
 * against what the patient was actually quoted": the number the payer is measured against is the
 * number the verification produced weeks earlier, carried forward untouched through the claim's
 * immutable coverage snapshot. Nothing anywhere re-derives it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents, type Cents } from "@mermaid/shared";
import {
  InMemoryVerificationRepository,
  VerificationService,
  type VerificationInput,
} from "@mermaid/verification";
import { ClaimService, InMemoryClaimRepository, registerClaimsSubscriptions } from "@mermaid/claims";
import {
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceService,
  buildRecoveryQueue,
  registerRemittanceSubscriptions,
} from "@mermaid/remittance";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const VISIT_DAY = new Date("2026-07-27T12:00:00Z");
const PAYMENT_DAY = new Date("2026-08-24T09:00:00Z");
const silent = createLogger(() => {});

const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };

/** The composition root — the only place that knows all three modules exist. */
function clinic() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const adapter = new MockEdiAdapter();

  const verification = new VerificationService(new InMemoryVerificationRepository(), adapter, bus);
  const claims = new ClaimService(new InMemoryClaimRepository(), adapter, BILLING_PROVIDER, bus);
  const remittanceRepo = new InMemoryRemittanceRepository();
  const remittance = new RemittanceService(remittanceRepo, new InMemoryExpectationRepository(), adapter, bus);

  registerClaimsSubscriptions(bus, claims);
  registerRemittanceSubscriptions(bus, remittance);
  return { bus, verification, claims, remittance, remittanceRepo };
}

function visit(memberId: string, cardText: string): VerificationInput {
  return {
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
    cardText,
    planItems: [
      { code: "D0120", quantity: 1 },
      { code: "D1110", quantity: 1, fee: cents(110) },
      { code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) },
    ],
  };
}

/**
 * Walk one patient from the front desk to a filed claim, then build the fetch request the payer
 * would adjudicate. Returns everything the assertions need.
 */
async function throughSubmission(app: ReturnType<typeof clinic>, memberId: string, card: string) {
  const verified = await app.verification.create(visit(memberId, card), VISIT_DAY);
  const claimView = (await app.claims.getByVerification(verified.record.id, VISIT_DAY))!;
  /**
   * A "...77" plan requires pre-authorisation, so the submit gate holds this claim until a decision
   * is on record — that is the feature working. This suite is about what happens after the payer
   * refuses, so it records an approval; the payer then refuses under CARC 197 anyway, which is the
   * doctrine stated plainly: an authorisation is permission to treat, never a guarantee of payment.
   */
  await app.claims.recordPreAuthorization(
    claimView.claim.id,
    { status: "approved", source: "payer-portal", referenceNumber: "AUTH-TEST-1", recordedBy: "office.manager@clinic" },
    VISIT_DAY
  );
  const filed = await app.claims.submit(claimView.claim.id, { submittedBy: "office.manager@clinic" }, VISIT_DAY);

  const claim = filed.claim;
  const fetchRequest = {
    payerId: claim.payer.payerId!,
    payerName: claim.payer.payerName!,
    payeeName: BILLING_PROVIDER.name,
    paymentDate: "2026-08-24",
    claims: [
      {
        patientControlNumber: claim.submission!.patientControlNumber,
        payerControlNumber: claim.submission!.controlNumber,
        patientFirstName: claim.patient.firstName,
        patientLastName: claim.patient.lastName,
        memberId: claim.patient.memberId,
        lines: claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
        expectedInsurancePays: claim.expectedInsurancePays,
      },
    ],
  };
  return { verified, claim, fetchRequest };
}

const CLEAN = ["ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"] as const;
const PREAUTH = ["MET30077", "MetLife Dental\nMember ID: MET30077"] as const;

test("a patient walks in and the payer's money is posted against their estimate, untouched by anyone", async () => {
  const app = clinic();
  const { verified, claim, fetchRequest } = await throughSubmission(app, ...CLEAN);

  const [remitted] = await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);

  assert.equal(remitted!.remittance.status, "posted");
  assert.equal(remitted!.remittance.balanced, true, remitted!.remittance.issues.join(" | "));

  const posting = remitted!.remittance.postings[0]!;
  assert.equal(posting.claimId, claim.id, "matched on the control number the payer echoed back");
  // The number the payer was measured against came from the verification, weeks earlier.
  assert.equal(posting.variance!.expectedInsurancePays, verified.record.calculation!.totalInsurancePays);
  assert.equal(posting.variance!.expectedInsurancePays, claim.expectedInsurancePays);
});

test("the claim closes itself when the payer settles it", async () => {
  const app = clinic();
  const { claim, fetchRequest } = await throughSubmission(app, ...CLEAN);
  await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);

  // No call into Claims — the remittance.posted event did it.
  const settled = (await app.claims.get(claim.id, PAYMENT_DAY))!;
  assert.equal(settled.claim.status, "paid");
  assert.equal(settled.claim.payments.length, 1);
  assert.equal(settled.outstanding, 0);
  // The payer owes nothing further, and this advice left money with the patient — so the action says
  // the PAYER is done and names what to bill, rather than closing the claim outright.
  assert.match(settled.recommendedAction, /payer is done/);
  assert.match(settled.recommendedAction, /assigned to the patient/);
});

test("all three contexts communicated only through the outbox, in order", async () => {
  const app = clinic();
  const { fetchRequest } = await throughSubmission(app, ...CLEAN);
  await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);

  assert.deepEqual(
    app.bus.all().map((e) => e.type),
    [
      "verification.completed",
      "claim.submitted",
      "remittance.posted",
      // The payer stating its contracted rates on the advice it just paid (F-1) — published once the
      // whole remittance is posted, because a fee schedule is a fact about the PAYER rather than
      // about this claim's money.
      "remittance.allowed_amounts_observed",
      /**
       * The dates two statutes run on (F5). Last, and published from the same moment as the rate
       * observation above for the same reason: a HELD advice is money nobody has accepted, and a
       * demand raised off a payment that is later voided is a letter to a payer about money the
       * practice does not have.
       *
       * It carries the claim FILING date, which is the whole prompt-pay clock and exists nowhere on
       * an 835, and the advice's provider-level adjustments, which belong to the file rather than to
       * any one claim. Neither fits on `remittance.posted`, which is per posting and already has
       * three subscribers — which is why this is its own event.
       */
      "remittance.statutory_clock_observed",
    ]
  );
  assert.equal(app.bus.pending().length, 0);
  assert.equal(app.bus.deadLetters().length, 0);
});

test("a denied procedure surfaces as recoverable revenue, with the payer's own reason", async () => {
  const app = clinic();
  // Member IDs ending 77 hit a missing pre-authorization on the crown.
  const { claim, fetchRequest } = await throughSubmission(app, ...PREAUTH);

  const [remitted] = await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);
  const variance = remitted!.remittance.postings[0]!.variance!;

  assert.equal(variance.outcome, "underpaid");
  assert.ok(variance.recoverableAmount > 0);
  assert.ok(variance.reasons.some((r) => r.code === "197"), "the payer said why");
  assert.equal(variance.unexplainedAmount, 0, "every dollar is accounted for");
  assert.ok(variance.explanation.some((e) => /corrected or appealed/.test(e)));

  const detected = app.bus.ofType("variance.detected");
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.payload.claimId, claim.id);
  assert.equal(detected[0]!.payload.payerId, "metlife-dental");

  const outstanding = (await app.claims.get(claim.id, PAYMENT_DAY))!;
  assert.equal(outstanding.claim.status, "partially_paid", "money is still owed");
  assert.ok(outstanding.outstanding > 0);
});

test("a contractual write-off is NOT reported as recoverable — it is the cost of being in network", async () => {
  const app = clinic();
  const { fetchRequest } = await throughSubmission(app, ...CLEAN);
  const [remitted] = await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);
  const variance = remitted!.remittance.postings[0]!.variance!;

  assert.ok(variance.contractualAdjustments > 0, "the payer's fee schedule sits below our fee");
  assert.equal(variance.recoverableAmount, 0);
  assert.equal(variance.actionable, false);
  assert.equal(app.bus.ofType("variance.detected").length, 0, "flooding the queue would train staff to ignore it");
});

test("the recovery queue answers 'where is our missing revenue?' across every claim", async () => {
  const app = clinic();
  const clean = await throughSubmission(app, ...CLEAN);
  await app.remittance.fetchAndIngest(clean.fetchRequest, PAYMENT_DAY);

  const denied = await throughSubmission(app, ...PREAUTH);
  await app.remittance.fetchAndIngest(denied.fetchRequest, PAYMENT_DAY);

  const queue = buildRecoveryQueue(await app.remittanceRepo.list());

  assert.equal(queue.length, 1, "only the pre-auth denial is worth pursuing");
  assert.equal(queue[0]!.claimId, denied.claim.id);
  assert.ok(queue[0]!.recoverableAmount > 0);
  assert.ok(queue[0]!.reasons.some((r) => r.code === "197"));
  assert.ok(queue[0]!.explanation.length > 0, "a human can act on it without opening anything else");
});

test("the money reconciles: everything the payers sent was posted", async () => {
  const app = clinic();
  const clean = await throughSubmission(app, ...CLEAN);
  const denied = await throughSubmission(app, ...PREAUTH);
  await app.remittance.fetchAndIngest(clean.fetchRequest, PAYMENT_DAY);
  await app.remittance.fetchAndIngest(denied.fetchRequest, PAYMENT_DAY);

  const report = await app.remittance.reconcileAll();
  assert.equal(report.balanced, true, report.summary);
  assert.equal(report.drift, 0);
  assert.ok(report.paymentsReceived > 0);
});

test("a re-served remittance does not double-count revenue anywhere", async () => {
  const app = clinic();
  const { claim, fetchRequest } = await throughSubmission(app, ...CLEAN);

  await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);
  await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);

  assert.equal((await app.remittanceRepo.list()).length, 1, "one payment, one remittance");
  const settled = (await app.claims.get(claim.id, PAYMENT_DAY))!;
  assert.equal(settled.claim.payments.length, 1, "one payment, one posting on the claim");
  assert.equal(app.bus.ofType("remittance.posted").length, 1);
});

test("an unbalanced 835 stops before any money moves, and the claim stays open", async () => {
  const app = clinic();
  const { claim, fetchRequest } = await throughSubmission(app, ...CLEAN);

  // Corrupt the payer's file the way a real one occasionally is.
  const adapter = new MockEdiAdapter();
  const fetched = await adapter.fetchRemittance(fetchRequest);
  const tampered = fetched.raw!.replace(/CAS\*PR\*2\*([\d.]+)\*/, "CAS*PR*2*1.00*");

  const held = await app.remittance.ingestRaw(tampered, PAYMENT_DAY);

  assert.equal(held.remittance.status, "held");
  assert.equal(held.canPost, false, "arithmetic is never overridable");
  assert.equal(app.bus.ofType("remittance.posted").length, 0);
  assert.equal((await app.claims.get(claim.id, PAYMENT_DAY))!.claim.status, "submitted", "still awaiting payment");
});

test("the front half never learns about billing, and the back half never re-derives an estimate", async () => {
  const app = clinic();
  const { verified, claim, fetchRequest } = await throughSubmission(app, ...CLEAN);
  await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);

  // The verification record is exactly what it was: nothing downstream wrote back to it.
  const reread = (await app.verification.get(verified.record.id, PAYMENT_DAY))!;
  assert.deepEqual(reread.record, verified.record);

  // And the claim's snapshot still holds the original estimate, byte for byte.
  const settled = (await app.claims.get(claim.id, PAYMENT_DAY))!;
  assert.deepEqual(
    settled.claim.coverageSnapshot.calculation,
    verified.record.calculation,
    "the estimate a claim was billed on is the estimate the patient was quoted"
  );
});

test("the whole cycle is deterministic — two identical clinics reach identical money", async () => {
  const runOnce = async () => {
    const app = clinic();
    const { fetchRequest } = await throughSubmission(app, ...PREAUTH);
    const [remitted] = await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);
    const posting = remitted!.remittance.postings[0]!;
    return {
      paymentTotal: remitted!.remittance.paymentTotal,
      paid: posting.paidAmount,
      variance: posting.variance!.variance,
      recoverable: posting.variance!.recoverableAmount,
      contractual: posting.variance!.contractualAdjustments,
      reasons: posting.variance!.reasons.map((r) => `${r.group}-${r.code}:${r.amount}`),
    };
  };

  assert.deepEqual(await runOnce(), await runOnce());
});

test("every cent the payer withheld is attributed to exactly one bucket", async () => {
  const app = clinic();
  const { fetchRequest } = await throughSubmission(app, ...PREAUTH);
  const [remitted] = await app.remittance.fetchAndIngest(fetchRequest, PAYMENT_DAY);
  const posting = remitted!.remittance.postings[0]!;
  const v = posting.variance!;

  const accountedFor = (v.actualPaid +
    v.contractualAdjustments +
    v.patientResponsibility +
    v.recoverableAmount +
    v.unexplainedAmount) as Cents;

  assert.equal(accountedFor, posting.chargedAmount, "no dollar is double-counted or lost");
});
