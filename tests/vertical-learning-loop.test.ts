/**
 * The learning loop — the product thesis, end to end.
 *
 * card text → verification → claim → payer → 835 → variance → denial → appeal → human approval →
 * outcome → **the payer profile learns** → the next identical denial is triaged against evidence
 * rather than a prior.
 *
 * Four bounded contexts and the shared brain participate, and **no module imports another**.
 * Everything crosses on the outbox.
 *
 * The assertion this file exists for is "the same denial, triaged twice, is triaged differently the
 * second time — because of what happened in between". Every other test in this repository checks
 * that a calculation is correct. This one checks that the system gets *better*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import { InMemoryPlaybookRepository, PayerProfileService, TRUST_THRESHOLD } from "@mermaid/payer-profile";
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

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const VISIT_DAY = new Date("2026-07-27T12:00:00Z");
const PAYMENT_DAY = new Date("2026-08-24T09:00:00Z");
const silent = createLogger(() => {});
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };

/** The composition root — the only place that knows every context exists. */
async function clinic() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const adapter = new MockEdiAdapter();

  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();

  // The other half of the loop, wired exactly as the real composition root wires it: the brain the
  // appeals write into is the same instance verification reads its confidence term out of.
  const payerHistory = {
    async forPayer(payerId: string | null) {
      const accuracy = await playbook.payerAccuracy(payerId);
      return { confidence: accuracy.confidence, explanation: accuracy.explanation };
    },
  };

  const verification = new VerificationService(new InMemoryVerificationRepository(), adapter, bus, payerHistory);
  const claims = new ClaimService(new InMemoryClaimRepository(), adapter, BILLING_PROVIDER, bus);
  const remittanceRepo = new InMemoryRemittanceRepository();
  const remittance = new RemittanceService(remittanceRepo, new InMemoryExpectationRepository(), adapter, bus);
  const denialRepo = new InMemoryDenialRepository();
  const denials = new DenialService(denialRepo, playbook, { name: BILLING_PROVIDER.name }, bus);

  registerClaimsSubscriptions(bus, claims);
  registerRemittanceSubscriptions(bus, remittance);
  registerDenialSubscriptions(bus, denials);

  // The loop closes here — exactly as the real composition root wires it.
  bus.subscribe("appeal.outcome.recorded", "payer-profile:learn", async (event) => {
    await playbook.recordOutcome({
      payerId: event.payload.payerId,
      carcCode: event.payload.carcCode,
      cdtCode: event.payload.procedureCode,
      won: event.payload.won,
    });
  });

  return { bus, verification, claims, remittance, denials, playbook, denialRepo };
}

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

/** Drive one patient from the front desk all the way to a denial sitting in the recovery queue. */
async function throughToDenial(app: Awaited<ReturnType<typeof clinic>>, memberId = "MET30077") {
  const verified = await app.verification.create(PREAUTH_VISIT(memberId), VISIT_DAY);
  const claimView = (await app.claims.getByVerification(verified.record.id, VISIT_DAY))!;
  await app.claims.recordPreAuthorization(
    claimView.claim.id,
    { status: "approved", source: "payer-portal", referenceNumber: "AUTH-TEST-1", recordedBy: "office.manager@clinic" },
    VISIT_DAY
  );
  const filed = await app.claims.submit(claimView.claim.id, { submittedBy: "office.manager@clinic" }, VISIT_DAY);
  const claim = filed.claim;

  await app.remittance.fetchAndIngest(
    {
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
    },
    PAYMENT_DAY
  );

  const queue = await app.denials.list({ openOnly: true }, PAYMENT_DAY);
  return { claim, queue };
}

test("a payer's refusal becomes triaged, actionable work with no human touching billing", async () => {
  const app = await clinic();
  const { queue } = await throughToDenial(app);

  assert.equal(queue.length, 1, "the pre-auth denial arrived in the recovery queue on its own");
  const denial = queue[0]!;
  assert.equal(denial.carcCode, "197");
  assert.equal(denial.disposition, "appeal");
  assert.equal(denial.deniedAmount, cents(1125));
  assert.ok(denial.expectedRecovery > 0);
  assert.match(denial.recommendedAction, /retro-authorization/i);
});

test("every context communicated only through the outbox, in order", async () => {
  const app = await clinic();
  await throughToDenial(app);

  assert.deepEqual(
    app.bus.all().map((e) => e.type),
    [
      "verification.completed",
      "claim.submitted",
      "remittance.posted",
      "variance.detected",
      "denial.created",
      // A payer stating its contracted rates on the advice it just paid (F-1). It arrives after the
      // posting cascade because it is published once the whole remittance is posted, and it is
      // about the PAYER rather than about this claim's money — which is why it is its own event
      // rather than a field on the posting every other subscriber already reads.
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

test("an appeal cannot reach the payer without a named human approving it", async () => {
  const app = await clinic();
  const { claim, queue } = await throughToDenial(app);
  const id = queue[0]!.id;

  const drafted = await app.denials.draftAppeal(
    id,
    {
      memberId: claim.patient.memberId,
      claimControlNumber: claim.submission!.patientControlNumber,
      serviceDate: claim.serviceDate,
    },
    PAYMENT_DAY
  );
  assert.equal(drafted.activeAppeal!.status, "draft");
  assert.equal(drafted.canSubmit, false, "drafting is not sending");

  await assert.rejects(() => app.denials.submitAppeal(id, PAYMENT_DAY), /has not been approved by a person/);

  await app.denials.approveAppeal(id, "biller@clinic", PAYMENT_DAY);
  const sent = await app.denials.submitAppeal(id, PAYMENT_DAY);
  assert.equal(sent.denial.status, "appealed");
  assert.ok(sent.denial.audit.some((a) => a.actor === "staff" && /approved by biller@clinic/.test(a.message)));
});

test("the appeal letter carries the real patient, procedure and money from four contexts away", async () => {
  const app = await clinic();
  const { claim, queue } = await throughToDenial(app);

  const drafted = await app.denials.draftAppeal(
    queue[0]!.id,
    {
      memberId: claim.patient.memberId,
      claimControlNumber: claim.submission!.patientControlNumber,
      serviceDate: claim.serviceDate,
    },
    PAYMENT_DAY
  );
  const letter = drafted.activeAppeal!.letter;

  assert.match(letter, /Ada Alpha/, "the patient name travelled from the verification");
  assert.match(letter, /MET30077/);
  assert.match(letter, /D2750/, "the procedure came from the claim's inherited estimate");
  assert.match(letter, /\$1,125\.00/, "the amount came from the payer's own 835");
  assert.match(letter, /reason code 197/);
  assert.match(letter, new RegExp(claim.submission!.patientControlNumber));
});

// ── The loop ──────────────────────────────────────────────────────────────────────────

test("THE LEARNING LOOP: an outcome makes the next identical denial triage differently", async () => {
  const app = await clinic();

  // What the brain believes before anything has ever happened.
  const beforeAnything = await app.playbook.resolve("metlife-dental", "197", "D2750", "CO");
  assert.equal(beforeAnything.sampleSize, 0);
  assert.equal(beforeAnything.source, "default-rule");

  // Win an appeal on this exact code, for this exact payer.
  const first = await throughToDenial(app, "MET30077");
  const id = first.queue[0]!.id;
  await app.denials.draftAppeal(
    id,
    {
      memberId: first.claim.patient.memberId,
      claimControlNumber: first.claim.submission!.patientControlNumber,
      serviceDate: first.claim.serviceDate,
    },
    PAYMENT_DAY
  );
  await app.denials.approveAppeal(id, "biller@clinic", PAYMENT_DAY);
  await app.denials.submitAppeal(id, PAYMENT_DAY);
  await app.denials.recordOutcome(
    id,
    { won: true, recoveredAmount: cents(1125), recordedBy: "biller@clinic" },
    PAYMENT_DAY
  );

  // The outcome crossed the outbox into the shared brain.
  const afterOneWin = await app.playbook.resolve("metlife-dental", "197", "D2750", "CO");
  assert.equal(afterOneWin.sampleSize, 1, "the outcome reached the payer profile over the event bus");
  assert.ok(
    afterOneWin.overturnRate > beforeAnything.overturnRate,
    "winning an appeal raised this payer's overturn rate"
  );

  // And a *different* payer is untouched — one payer's behaviour is not evidence about another.
  const otherPayer = await app.playbook.resolve("delta-dental", "197", "D2750", "CO");
  assert.equal(otherPayer.overturnRate, beforeAnything.overturnRate);
  assert.equal(otherPayer.sampleSize, 0);
});

test("a second identical denial is triaged with better odds than the first", async () => {
  const app = await clinic();

  const first = await throughToDenial(app, "MET30077");
  const firstOdds = first.queue[0]!.overturnRate;

  // Work it and win.
  const id = first.queue[0]!.id;
  await app.denials.draftAppeal(
    id,
    { memberId: "MET30077", claimControlNumber: first.claim.submission!.patientControlNumber, serviceDate: first.claim.serviceDate },
    PAYMENT_DAY
  );
  await app.denials.approveAppeal(id, "biller", PAYMENT_DAY);
  await app.denials.submitAppeal(id, PAYMENT_DAY);
  await app.denials.recordOutcome(id, { won: true, recordedBy: "biller" }, PAYMENT_DAY);

  // A second patient, same payer, same denial.
  const second = await throughToDenial(app, "MET99977");
  const secondDenial = second.queue.find((d) => d.carcCode === "197")!;

  assert.ok(
    secondDenial.overturnRate > firstOdds,
    `the second triage should reflect the first outcome (${firstOdds} → ${secondDenial.overturnRate})`
  );
  assert.ok(
    secondDenial.expectedRecovery > 0,
    "and the expected recovery it is ranked by moves with it"
  );
});

test("a rate stays provisional until enough outcomes, then becomes trusted", async () => {
  const app = await clinic();
  for (let i = 0; i < TRUST_THRESHOLD - 1; i++) {
    await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });
  }
  const first = await throughToDenial(app);
  const before = first.queue.find((d) => d.claimId === first.claim.id && d.carcCode === "197")!;
  assert.equal(before.trusted, false, "below the sample threshold a rate is a guess, and says so");

  await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });

  // A second patient — the queue now holds both, so scope the assertion to the NEW claim.
  const second = await throughToDenial(app, "MET88877");
  const after = second.queue.find((d) => d.claimId === second.claim.id && d.carcCode === "197")!;
  assert.equal(after.trusted, true, "the threshold was crossed between the two triages");
});

test("losses teach as much as wins — the rate falls and the queue de-prioritises the code", async () => {
  const app = await clinic();
  const before = (await app.playbook.resolve("metlife-dental", "197", "D2750", "CO")).overturnRate;

  for (let i = 0; i < 10; i++) {
    await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: false });
  }

  const after = (await app.playbook.resolve("metlife-dental", "197", "D2750", "CO")).overturnRate;
  assert.ok(after < before, "ten losses lowered the odds");
  assert.ok(after > 0, "but never to zero — a code at 0% would be hidden forever");

  const { queue } = await throughToDenial(app);
  assert.ok(
    queue[0]!.expectedRecovery < queue[0]!.deniedAmount * 0.4,
    "and the queue now ranks this code below what it would have been worth"
  );
});

test("the recorded triage is frozen — later learning never rewrites an old decision", async () => {
  const app = await clinic();
  const { queue } = await throughToDenial(app);
  const id = queue[0]!.id;
  const oddsAtDecision = (await app.denials.get(id, PAYMENT_DAY))!.denial.triage!.overturnRate;

  for (let i = 0; i < 30; i++) {
    await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });
  }

  assert.equal(
    (await app.denials.get(id, PAYMENT_DAY))!.denial.triage!.overturnRate,
    oddsAtDecision,
    "the odds a human saw when they decided must not change underneath them"
  );
});

/**
 * ── WHAT "CAME BACK" MEANS CHANGED, AND THAT WAS THE POINT (F-2) ─────────────────────────────────
 * This asserted a 100% recovery rate the instant a human recorded a win, on money the payer had not
 * sent. That is the reporting defect the staging audit found: $1,125.00 on the scoreboard against
 * $21.49 actually collected. A win is now a receivable, and only a posting can turn it into cash.
 */
test("the recovery scoreboard separates money AGREED from money COLLECTED", async () => {
  const app = await clinic();
  const { claim, queue } = await throughToDenial(app);
  const id = queue[0]!.id;

  await app.denials.draftAppeal(
    id,
    { memberId: "MET30077", claimControlNumber: claim.submission!.patientControlNumber, serviceDate: claim.serviceDate },
    PAYMENT_DAY
  );
  await app.denials.approveAppeal(id, "biller", PAYMENT_DAY);
  await app.denials.submitAppeal(id, PAYMENT_DAY);
  await app.denials.recordOutcome(id, { won: true, recoveredAmount: cents(1125), recordedBy: "biller" }, PAYMENT_DAY);

  const stats = await app.denials.recoveryStats(PAYMENT_DAY);
  assert.equal(stats.recoveredCount, 0, "no cash has been posted");
  assert.equal(stats.recoveredAmount, 0);
  assert.equal(stats.awaitingPaymentCount, 1, "the win is a receivable");
  assert.equal(stats.awardedAwaitingPayment, cents(1125));
  assert.equal(stats.openCount, 1, "and still work somebody has to chase");
  assert.equal(stats.recoveryRate, null, "nothing has settled either way yet");
});

test("the whole cycle is still deterministic — two identical clinics reach identical denials", async () => {
  const runOnce = async () => {
    const app = await clinic();
    const { queue } = await throughToDenial(app);
    const d = queue[0]!;
    return {
      carcCode: d.carcCode,
      deniedAmount: d.deniedAmount,
      disposition: d.disposition,
      overturnRate: d.overturnRate,
      expectedRecovery: d.expectedRecovery,
      priority: d.priority,
    };
  };
  assert.deepEqual(await runOnce(), await runOnce());
});

// ── The loop reaches the FRONT half (M11) ──────────────────────────────────────────────
//
// Everything above proves an outcome sharpens the next TRIAGE. That is the back half of the thesis,
// and until M11 it was all of it: a payer that lost 80% of its appeals produced better denial
// recommendations and *exactly the same verification confidence* as a payer that won them all. The
// loop returned to the half of the product it came from.
//
// This is the edge the unified RCM workflow draws as `S -.sharpens.-> D`, and roadmap §5's last row
// as "sharpens future confidence scoring".

test("THE LOOP REACHES THE FRONT HALF: an appeal outcome changes the NEXT verification's confidence", async () => {
  const app = await clinic();

  // 1. A verification, before this payer has any recorded history at all.
  const before = await app.verification.create(PREAUTH_VISIT("MET30001"), VISIT_DAY);
  const componentsBefore = before.record.confidence.components.map((c) => c.name);
  assert.ok(
    !componentsBefore.includes("Payer track record"),
    "an unproven payer must contribute NO component — a neutral one would raise every unfamiliar payer's score"
  );

  // 2. One real denial driven all the way to a recorded outcome, over the outbox. This proves the
  //    evidence reaches the brain the way it does in production, not by being written there directly.
  const { claim, queue } = await throughToDenial(app, "MET30077");
  const denialId = queue[0]!.id;
  await app.denials.draftAppeal(
    denialId,
    {
      memberId: claim.patient.memberId,
      claimControlNumber: claim.submission!.patientControlNumber,
      serviceDate: claim.serviceDate,
    },
    PAYMENT_DAY
  );
  await app.denials.approveAppeal(denialId, "biller@clinic", PAYMENT_DAY);
  await app.denials.submitAppeal(denialId, PAYMENT_DAY);
  await app.denials.recordOutcome(denialId, { won: true, recordedBy: "biller@clinic" }, PAYMENT_DAY);

  assert.ok(
    app.bus.all().some((e) => e.type === "appeal.outcome.recorded"),
    "the outcome must have crossed the outbox"
  );
  assert.equal((await app.playbook.payerAccuracy("metlife-dental")).observations, 1);

  // 3. One outcome is not evidence. The gate must still hold.
  const afterOne = await app.verification.create(PREAUTH_VISIT("MET30002"), VISIT_DAY);
  assert.ok(
    !afterOne.record.confidence.components.some((c) => c.name === "Payer track record"),
    "one outcome must not move a verification — human-in-the-loop §9's sanity gate applies here too"
  );

  // 4. Accumulate the rest of the evidence. Recorded directly rather than by driving twenty more
  //    patients through the whole cycle: step 2 already proved the path, and what is under test here
  //    is what the ACCUMULATED evidence does to the front half.
  for (let i = 1; i < TRUST_THRESHOLD; i++) {
    await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });
  }

  // 5. The same verification, run again against a payer that now has a track record.
  const after = await app.verification.create(PREAUTH_VISIT("MET30003"), VISIT_DAY);
  const trackRecord = after.record.confidence.components.find((c) => c.name === "Payer track record");

  assert.ok(trackRecord, "with the threshold cleared, the payer's history must now count");
  assert.notEqual(
    after.record.confidence.overall,
    before.record.confidence.overall,
    "THE THESIS: what happened to an appeal changed what the next estimate is worth"
  );

  // 6. And it must say why. Every heuristic output in this system carries its own explanation —
  //    a confidence score that moved for reasons a coordinator cannot read is a black box.
  assert.match(trackRecord!.explanation, /overturned/);
  assert.match(trackRecord!.explanation, new RegExp(`${TRUST_THRESHOLD} recorded outcomes`));
  assert.ok(
    after.record.audit.some((a) => /Payer track record applied/.test(a.message)),
    "the verification's own audit trail must record that the payer's history was consulted"
  );
});

test("a payer whose denials hold up does not drag down verifications of a different payer", async () => {
  const app = await clinic();

  // Twenty reversals against MetLife — evidence that MetLife's own decisions are unreliable.
  for (let i = 0; i < TRUST_THRESHOLD; i++) {
    await app.playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });
  }

  const delta = await app.verification.create(
    {
      patient: { firstName: "Bea", lastName: "Beta", dateOfBirth: "1988-02-02", memberId: "DD40001" , address: SYNTHETIC_ADDRESS},
      cardText: "Delta Dental\nMember ID: DD40001",
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    VISIT_DAY
  );

  assert.ok(
    !delta.record.confidence.components.some((c) => c.name === "Payer track record"),
    "learning about one payer must never leak into another payer's estimate"
  );
});
