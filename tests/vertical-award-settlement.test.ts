/**
 * The settlement loop, end to end over the real event bus.
 *
 * ── WHAT THIS PROVES THAT THE UNIT TESTS CANNOT ────────────────────────────────────────────────
 * `award-lifecycle.test.ts` pins the state machine as pure functions. This drives the same
 * transitions through the wiring a deployment actually uses — Denials publishes
 * `appeal.outcome.recorded`, a subscriber pushes the receivable onto Remittance's expectation, a
 * corrected 835 is ingested, `remittance.posted` comes back, and a second subscriber attributes the
 * cash to the award. Nothing is called directly across a module boundary, because nothing may be.
 *
 * ── HOW THE EXPECTED VALUES WERE OBTAINED ──────────────────────────────────────────────────────
 * From the fixture's own documented arithmetic, worked out on paper and written as literals — never
 * read back from a run. The mock adjudicator pays
 *
 *     paid = min( expectedInsurancePays × line.charged / totalCharged ,  charged − 10% )
 *
 * so for the corrected advice below, one line charged $1,250.00 with an expectation of $1,125.00
 * gives allowed = $1,125.00 and paid = $1,125.00 — exact, by construction.
 *
 * The original visit produces:
 *   charged     $1,425.00  = 65.00 + 110.00 + 1,250.00
 *   denied      $1,125.00  = the crown, withheld under CO-197 (member id ends 77)
 *   first cash  $   21.49
 *   estimate E0 $  175.00
 *
 * $1,125.00 measured against E0 is +$950.00 and would be reported as an OVERPAYMENT. That is the
 * defect these tests keep fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents, type Cents } from "@mermaid/shared";
import { InMemoryPlaybookRepository, PayerProfileService } from "@mermaid/payer-profile";
import { MockEdiAdapter } from "@mermaid/edi";
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
  registerRemittanceSubscriptions,
} from "@mermaid/remittance";
import {
  DenialService,
  InMemoryDenialRepository,
  registerDenialSubscriptions,
} from "@mermaid/denials-appeals";

const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;
const VISIT_DAY = new Date("2026-07-27T12:00:00Z");
const PAYMENT_DAY = new Date("2026-08-24T09:00:00Z");
const APPEAL_DAY = new Date("2026-09-01T09:00:00Z");
const CORRECTED_DAY = new Date("2026-10-02T09:00:00Z");
const silent = createLogger(() => {});
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };

const DENIED = cents(1125);

/**
 * The award is the one absolute this file pins, and it is derivable: the crown is charged $1,250.00,
 * the payer allows 90% of it, and CO-197 withholds the whole allowed amount — $1,125.00.
 *
 * The FIRST payment is deliberately NOT asserted as a literal. It falls out of the plan fixture's
 * coverage percentages and the catalog fee for D0120, neither of which is derivable from anything
 * written here — so a number would be a value copied out of a previous run, which is exactly the
 * self-confirming oracle this suite is written to avoid. What matters for F-2 is the RELATIONSHIP,
 * and every assertion below is stated that way: winning changes cash by zero, and an exact
 * settlement changes it by precisely the award.
 */

/**
 * The composition root, wired exactly as `apps/web/wiring.ts` wires it — including the two
 * subscribers this phase adds. If those move, this harness moves with them, which is the point: the
 * wiring is what is under test, not just the services.
 */
async function clinic() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const adapter = new MockEdiAdapter();
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();

  const verification = new VerificationService(new InMemoryVerificationRepository(), adapter, bus);
  const claims = new ClaimService(new InMemoryClaimRepository(), adapter, BILLING_PROVIDER, bus);
  const expectations = new InMemoryExpectationRepository();
  const remittance = new RemittanceService(new InMemoryRemittanceRepository(), expectations, adapter, bus);
  const denials = new DenialService(new InMemoryDenialRepository(), playbook, { name: BILLING_PROVIDER.name }, bus);

  registerClaimsSubscriptions(bus, claims);
  registerRemittanceSubscriptions(bus, remittance);
  registerDenialSubscriptions(bus, denials);

  const ambiguous: { claimId: string; candidates: string[] }[] = [];
  const syncAwardProjection = async (claimId: string, patientControlNumber: string) => {
    await remittance.setAwardOutstanding(patientControlNumber, await denials.awardOutstandingForClaim(claimId));
  };

  bus.subscribe("appeal.outcome.recorded", "remittance:award-expectation", async (event) => {
    const { claimId, claimControlNumber } = event.payload;
    if (!claimControlNumber) return;
    await syncAwardProjection(claimId, claimControlNumber);
  });

  bus.subscribe("denial.recovery.settled", "remittance:resolve-recoverable", async (event) => {
    await remittance.resolveRecoverable(event.payload.postingId, event.payload.resolvedAmount, new Date(event.payload.settledAt));
  });

  bus.subscribe("remittance.posted", "denials:settle-award", async (event) => {
    const { claimId, postingId, paidAmount, patientControlNumber, procedureCodes } = event.payload;
    if (!claimId) return;
    const { attribution } = await denials.settleAwardsFromPosting(
      { claimId, postingId, paidAmount, procedureCodes },
      new Date(event.payload.postedAt)
    );
    if (attribution.kind === "ambiguous") ambiguous.push({ claimId, candidates: attribution.candidates });
    await syncAwardProjection(claimId, patientControlNumber);
  });

  return { bus, verification, claims, remittance, denials, expectations, ambiguous, adapter };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;

/** Member IDs ending 77 hit a missing pre-authorization on the crown — a recoverable CO-197. */
const PREAUTH_VISIT = (memberId = "MET30077"): VerificationInput => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText: `MetLife Dental\nMember ID: ${memberId}`,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) },
  ],
});

async function throughToDenial(app: Clinic) {
  const verified = await app.verification.create(PREAUTH_VISIT(), VISIT_DAY);
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
  await app.bus.drain();
  const fc = filed.claim;
  await app.remittance.fetchAndIngest(
    {
      payerId: fc.payer.payerId!,
      payerName: fc.payer.payerName!,
      payeeName: BILLING_PROVIDER.name,
      paymentDate: "2026-08-24",
      claims: [
        {
          patientControlNumber: fc.submission!.patientControlNumber,
          payerControlNumber: fc.submission!.controlNumber,
          patientFirstName: fc.patient.firstName,
          patientLastName: fc.patient.lastName,
          memberId: fc.patient.memberId,
          lines: fc.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
          expectedInsurancePays: fc.expectedInsurancePays,
        },
      ],
    },
    PAYMENT_DAY
  );
  await app.bus.drain();

  const queue = await app.denials.list({ openOnly: true }, PAYMENT_DAY);
  const claim = (await app.claims.get(claimView.claim.id, PAYMENT_DAY))!;
  return {
    claimId: claim.claim.id,
    serviceDate: claim.claim.serviceDate,
    controlNumber: claim.claim.submission!.patientControlNumber,
    payerControlNumber: claim.claim.submission!.controlNumber,
    denialId: queue[0]!.id,
  };
}

async function winAppeal(app: Clinic, c: Awaited<ReturnType<typeof throughToDenial>>, award: Cents = DENIED) {
  await app.denials.draftAppeal(
    c.denialId,
    { memberId: "MET30077", claimControlNumber: c.controlNumber, serviceDate: c.serviceDate },
    APPEAL_DAY
  );
  await app.denials.approveAppeal(c.denialId, "biller@clinic", APPEAL_DAY);
  await app.denials.submitAppeal(c.denialId, APPEAL_DAY);
  const won = await app.denials.recordOutcome(
    c.denialId,
    { won: true, recoveredAmount: award, recordedBy: "biller@clinic" },
    APPEAL_DAY
  );
  await app.bus.drain();
  return won;
}

/**
 * A corrected remittance for the SAME claim control number.
 *
 * Member id `MET30001` carries no scenario lever, so the adjudicator pays normally rather than
 * re-denying the crown. `charged` is set so that `charged − 10%` equals the payment wanted, which is
 * how the fixture's own formula yields an exact figure.
 */
async function correctedEra(app: Clinic, c: { controlNumber: string; payerControlNumber: string }, pays: Cents): Promise<string> {
  const charged = Math.round((pays as number) / 0.9) as Cents;
  const fetched = await app.adapter.fetchRemittance({
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    payeeName: BILLING_PROVIDER.name,
    paymentDate: "2026-10-02",
    claims: [
      {
        patientControlNumber: c.controlNumber,
        payerControlNumber: c.payerControlNumber,
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "MET30001",
        lines: [{ procedureCode: "D2750", charged, quantity: 1 }],
        expectedInsurancePays: pays,
      },
    ],
  });
  return fetched.raw!;
}

const cashOn = async (app: Clinic, claimId: string): Promise<Cents> =>
  (await app.claims.get(claimId, CORRECTED_DAY))!.paidAmount;

const denialOf = async (app: Clinic, denialId: string) =>
  (await app.denials.get(denialId, CORRECTED_DAY))!.denial;

const awardOutstandingOf = async (app: Clinic, controlNumber: string): Promise<number> =>
  (await app.expectations.getByControlNumber(controlNumber))!.awardOutstanding;

// ── A. Appeal won → awaiting payment ──────────────────────────────────────────────────────────

test("A — winning the appeal opens a receivable and moves no cash at all", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const cashBefore = await cashOn(app, c.claimId);
  assert.ok(cashBefore > 0, "the payer's first advice paid something");

  const won = await winAppeal(app, c);

  assert.equal(won.denial.status, "awaiting_payment");
  assert.equal(won.denial.awardedAmount, DENIED, "award = the denied amount");
  assert.equal(won.denial.awardSettledAmount, 0, "cash attributed to it");
  assert.equal(won.denial.recoveredAmount, null, "cash recovered");
  assert.equal(await cashOn(app, c.claimId), cashBefore, "WINNING CHANGES NO CASH — not by a cent");
  assert.equal(await awardOutstandingOf(app, c.controlNumber), DENIED, "S1: the receivable reached the projection");
});

// ── B. Exact corrected ERA → settled → recovered ──────────────────────────────────────────────

test("B — an exact corrected remittance settles the award, and is not an overpayment", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const cashBefore = await cashOn(app, c.claimId);
  await winAppeal(app, c);

  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  const d = await denialOf(app, c.denialId);
  assert.equal(d.status, "recovered", "cash — and only cash — closes it");
  assert.equal(d.awardSettledAmount, DENIED);
  assert.equal(
    (await cashOn(app, c.claimId)) - cashBefore,
    DENIED,
    "cash rose by exactly the award — $1,125.00 of real money"
  );
  assert.equal(await awardOutstandingOf(app, c.controlNumber), 0, "S1: nothing outstanding");

  /** And the payment was measured against the AWARD, so it is not reported as an overpayment. */
  const settledPosting = (await app.claims.get(c.claimId, CORRECTED_DAY))!.claim.payments.at(-1)!;
  assert.notEqual(settledPosting.outcome, "overpaid", "measured against the award, not the estimate");
  assert.equal(settledPosting.paidAmount, DENIED);
});

// ── C. Lower corrected ERA → partially recovered ──────────────────────────────────────────────

test("C — a short corrected remittance settles part and leaves the rest owed", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);

  await app.remittance.ingestRaw(await correctedEra(app, c, cents(800)), CORRECTED_DAY);
  await app.bus.drain();

  const d = await denialOf(app, c.denialId);
  assert.equal(d.status, "partially_recovered", "still OPEN");
  assert.equal(d.awardSettledAmount, cents(800));
  assert.equal(await awardOutstandingOf(app, c.controlNumber), cents(325), "1125.00 − 800.00");
});

// ── E. Duplicate corrected ERA → no double credit ─────────────────────────────────────────────

test("E — re-ingesting the same corrected remittance credits nothing twice", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);

  const raw = await correctedEra(app, c, DENIED);
  await app.remittance.ingestRaw(raw, CORRECTED_DAY);
  await app.bus.drain();
  const cashAfterFirst = await cashOn(app, c.claimId);

  await app.remittance.ingestRaw(raw, CORRECTED_DAY);
  await app.bus.drain();

  const d = await denialOf(app, c.denialId);
  assert.equal(d.awardSettledAmount, DENIED, "not 2250.00");
  assert.equal(d.awardSettlements?.length, 1, "one posting, recorded once");
  assert.equal(await cashOn(app, c.claimId), cashAfterFirst, "and no extra cash");
});

// ── F. Duplicate appeal outcome → no duplicate award ──────────────────────────────────────────

test("F — replaying the award event does not double the receivable", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const won = await winAppeal(app, c);

  /** Re-publish the same outcome, exactly as an at-least-once redelivery would. */
  await app.bus.publish("appeal.outcome.recorded", won.denial.id, {
    denialId: won.denial.id,
    appealId: won.denial.appeals.at(-1)!.id,
    claimId: c.claimId,
    claimControlNumber: c.controlNumber,
    recordedAt: APPEAL_DAY.toISOString(),
    recordedBy: "biller@clinic",
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    carcCode: "197",
    procedureCode: "D2750",
    level: 1,
    won: true,
    deniedAmount: DENIED,
    recoveredAmount: DENIED,
  });
  await app.bus.drain();

  const d = await denialOf(app, c.denialId);
  assert.equal(d.awardedAmount, DENIED, "assignment, not accumulation");
  assert.equal(await awardOutstandingOf(app, c.controlNumber), DENIED, "S1 holds after a replay");
});

// ── G. Remittance before the award event ──────────────────────────────────────────────────────

test("G — cash that posts before the award is credited once the award is recorded", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);

  /** The corrected money lands FIRST — no award exists yet, so nothing can be attributed. */
  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  const beforeAward = await denialOf(app, c.denialId);
  assert.equal(beforeAward.awardSettledAmount ?? 0, 0, "nothing to settle against yet");

  await winAppeal(app, c);

  const afterAward = await denialOf(app, c.denialId);
  assert.equal(afterAward.status, "awaiting_payment", "the award is open; the cash arrived before it existed");
  assert.equal(await awardOutstandingOf(app, c.controlNumber), DENIED, "and is reported as still owed");
});

// ── I. Patient responsibility survives ────────────────────────────────────────────────────────

test("I — the patient's balance is not erased by a corrected remittance", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const before = (await app.claims.get(c.claimId, PAYMENT_DAY))!;
  const patientBefore = before.claim.payments.at(-1)!.patientResponsibility;
  assert.ok(patientBefore > 0, "the first advice assigned the patient a share");

  await winAppeal(app, c);
  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  const after = (await app.claims.get(c.claimId, CORRECTED_DAY))!;
  assert.ok(after.claim.payments.length >= 2, "a second posting landed");
  assert.ok(
    after.claim.payments.some((p) => p.patientResponsibility === patientBefore),
    "the original adjudication is still on the record"
  );
});

// ── J. S1 divergence stays zero ───────────────────────────────────────────────────────────────

test("J — the projection equals the awards that own it at every step", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const check = async (label: string) => {
    const owned = await app.denials.awardOutstandingForClaim(c.claimId);
    assert.equal(await awardOutstandingOf(app, c.controlNumber), owned, `S1 diverged ${label}`);
  };

  await check("before any award");
  await winAppeal(app, c);
  await check("after the win");
  await app.remittance.ingestRaw(await correctedEra(app, c, cents(800)), CORRECTED_DAY);
  await app.bus.drain();
  await check("after a partial settlement");
});

// ── F-5: a recovered denial stops advertising its money ───────────────────────────────────────

/**
 * Recover-queue arithmetic, derived by hand:
 *   payer withheld (CO-197)   $1,125.00
 *   award                     $1,125.00
 *   exact settlement          $1,125.00  ⇒ resolved $1,125.00 ⇒ still recoverable   $0.00
 *   partial settlement          $800.00  ⇒ resolved   $800.00 ⇒ still recoverable $325.00
 */
const queue = async (app: Clinic) => app.remittance.recoveryQueue();

test("F-5/A — an exactly settled award leaves the Recover queue", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  const before = await queue(app);
  assert.equal(before.length, 1, "pursuable before the appeal is worked");
  assert.equal(before[0]!.recoverableAmount, DENIED, "$1,125.00 to chase");

  await winAppeal(app, c);
  assert.equal((await queue(app)).length, 1, "winning alone changes nothing — no cash yet");

  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  assert.equal((await queue(app)).length, 0, "nothing left to chase — the money came back");
});

test("F-5/A — the payer's own figure is preserved beside what we resolved", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);
  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  const all = await app.remittance.list();
  let checked = false;
  for (const item of all) {
    const view = (await app.remittance.get(item.id))!;
    for (const p of view.remittance.postings) {
      if ((p.variance?.recoverableAmount ?? 0) > 0) {
        assert.equal(p.variance!.recoverableAmount, DENIED, "the 835 said $1,125.00 and still does");
        assert.equal(p.resolvedRecoverable, DENIED, "and the resolution is recorded separately");
        checked = true;
      }
    }
  }
  assert.ok(checked, "the original posting must still be there to check");
});

test("F-5/B — a partial settlement leaves exactly the remainder pursuable", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);
  await app.remittance.ingestRaw(await correctedEra(app, c, cents(800)), CORRECTED_DAY);
  await app.bus.drain();

  const after = await queue(app);
  assert.equal(after.length, 1, "there is still work to do");
  assert.equal(after[0]!.recoverableAmount, cents(325), "1125.00 − 800.00, not the original 1125.00");
});

test("F-5/D — a duplicate corrected ERA resolves nothing twice", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);
  const raw = await correctedEra(app, c, DENIED);
  await app.remittance.ingestRaw(raw, CORRECTED_DAY);
  await app.bus.drain();
  await app.remittance.ingestRaw(raw, CORRECTED_DAY);
  await app.bus.drain();

  assert.equal((await queue(app)).length, 0);
  assert.equal((await denialOf(app, c.denialId)).awardSettledAmount, DENIED, "not 2250.00");
});

test("F-5/G — replaying the settlement event is a no-op", async () => {
  const app = await clinic();
  const c = await throughToDenial(app);
  await winAppeal(app, c);
  await app.remittance.ingestRaw(await correctedEra(app, c, DENIED), CORRECTED_DAY);
  await app.bus.drain();

  const d = await denialOf(app, c.denialId);
  await app.bus.publish("denial.recovery.settled", d.id, {
    denialId: d.id,
    claimId: c.claimId,
    postingId: d.postingId,
    resolvedAmount: DENIED,
    awardedAmount: DENIED,
    settledAmount: DENIED,
    status: d.status,
    settledAt: CORRECTED_DAY.toISOString(),
  });
  await app.bus.drain();
  assert.equal((await queue(app)).length, 0, "still empty, still idempotent");
});
