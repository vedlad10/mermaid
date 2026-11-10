/**
 * Pia Phase32, end to end: the $1,125.00 that was lost, and the point at which it is now caught.
 *
 * ── WHAT ACTUALLY HAPPENED ─────────────────────────────────────────────────────────────────────
 * Her crown was billed $1,250.00 and allowed $1,125.00 after a $125.00 contractual reduction.
 * MetLife refused the whole allowed amount under CARC 197 — "Pre-authorization absent" — in the
 * `CO` group. `CO` forbids billing the patient, so the practice absorbed all $1,125.00 for a reason
 * that was knowable before she sat in the chair. Nothing in Mermaid asked the question.
 *
 * ── THE INCOHERENCE THIS ALSO FIXES ────────────────────────────────────────────────────────────
 * Her benefit snapshot said the crown sat inside a 12-month WAITING PERIOD while both of her ERAs
 * refused and then paid it under PRE-AUTH. Two different facts about one tooth, and only one of
 * them is appealable — obtaining an authorisation does not shorten a waiting period. The mock's
 * adjudicator had always emitted CARC 197 for a "...77" member; its benefits generator said
 * waiting period. They now agree, and the waiting-period behaviour moved to "...66".
 *
 * The amounts below are hers, unchanged. Only the REASON is now consistent across the snapshot,
 * the estimate, the gate and the payer's own advice.
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

/** Her plan. "...77" is the mock's pre-authorisation plan on BOTH sides — benefits and adjudicator. */
const PIA = {
  patient: {
    firstName: "Pia",
    lastName: "Phase32",
    dateOfBirth: "1990-01-01",
    memberId: "MET90077",
    address: SYNTHETIC_ADDRESS,
  },
  cardText: "MetLife Dental\nMember ID: MET90077",
  planItems: [
    { code: "D0120", quantity: 1, fee: cents(65) },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
  ],
};

const clinic = () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  return { services, demo: services.via(new MockEdiAdapter()) };
};

test("her benefits state the rule, and the estimate reads it rather than guessing", async () => {
  const { demo } = clinic();
  const v = await demo.verification.create(PIA);
  const benefits = v.record.benefits!;

  assert.ok(benefits.preAuthorization, "the plan publishes a pre-authorisation rule");
  assert.ok(
    benefits.preAuthorization!.categories.includes("major"),
    "and it names major services — which is where a crown falls"
  );
  assert.equal(
    benefits.waitingPeriods.length,
    0,
    "and it no longer ALSO claims a waiting period — that was the contradiction"
  );
  assert.match(
    benefits.preAuthorization!.source,
    /MOCK|synthetic/i,
    "synthetic plan data must say so; a real payer rule must never be indistinguishable from a fixture"
  );
});

test("the crown is flagged BEFORE treatment, with the money it puts at risk", async () => {
  const { demo } = clinic();
  const v = await demo.verification.create(PIA);
  const calc = v.record.calculation!;
  const crown = calc.lines.find((l) => l.code === "D2750")!;
  const exam = calc.lines.find((l) => l.code === "D0120")!;

  assert.equal(crown.preAuth?.requirement, "required");
  assert.match(crown.preAuth!.reason, /major/, "quoting the payer's own rule");
  assert.equal(exam.preAuth?.requirement, "not-required", "the exam beside it is not the problem");

  assert.ok(crown.preAuthRiskAmount! > 0, "the exposure is named");
  assert.equal(
    calc.preAuthRevenueAtRisk,
    crown.preAuthRiskAmount,
    "and the plan total is the sum of the lines that carry it"
  );
});

test("the exposure is the insurance share, not the $1,250.00 billed", async () => {
  /**
   * CARC 197 arrives under `CO`: the patient cannot be charged, and the contractual reduction was
   * never collectable from anyone. Quoting the fee would overstate the loss by exactly the discount
   * the practice had already agreed to.
   */
  const { demo } = clinic();
  const v = await demo.verification.create(PIA);
  const crown = v.record.calculation!.lines.find((l) => l.code === "D2750")!;

  assert.equal(crown.fee, cents(1250));
  assert.equal(
    crown.preAuthRiskAmount,
    crown.insurancePays,
    "the risk is what the payer was going to pay, and nothing more"
  );
  assert.ok(crown.preAuthRiskAmount! < crown.fee, "never the billed fee");
});

test("the claim inherits the requirement and is BLOCKED before it can be filed", async () => {
  /**
   * The point of the whole feature. Left alone, this claim files, MetLife refuses under CARC 197,
   * and $1,125.00 is gone with no way to bill the patient for it.
   */
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();
  const view = (await demo.claims.get(item!.id))!;

  const crown = view.claim.lines.find((l) => l.code === "D2750")!;
  assert.equal(crown.preAuthRequirement, "required", "inherited, never re-derived at submit time");

  assert.equal(view.canSubmit, false, "the gate must hold");
  const blocker = view.blockers.find((b) => b.code === "preauth-missing")!;
  assert.ok(blocker, "and say why");
  assert.match(blocker.message, /D2750/);
  assert.match(blocker.message, /at risk/);
  assert.match(blocker.remediation, /reference number|waived/i, "and what clears it");
});

test("recording the payer's approval clears the gate in the same breath", async () => {
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();

  const after = await demo.claims.recordPreAuthorization(item!.id, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-PIA-1",
    recordedBy: "office.manager@clinic",
  });

  assert.equal(after.canSubmit, true, "recording the number must unblock, or nobody will use it");
  assert.ok(!after.blockers.some((b) => b.code === "preauth-missing"));
  assert.equal(after.claim.preAuthorization?.referenceNumber, "AUTH-PIA-1");
});

test("an approval is evidence or it is nothing — a reference number is required", async () => {
  /**
   * An approval that cannot be quoted back to the payer is a memory of a phone call. Refusing it
   * here is what stops the record becoming decoration.
   */
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();

  await assert.rejects(
    () =>
      demo.claims.recordPreAuthorization(item!.id, {
        status: "approved",
        source: "payer-phone",
        recordedBy: "office.manager@clinic",
      }),
    /authorisation number/i
  );
});

test("a refusal demands the payer's reason, because it decides the route back", async () => {
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();

  await assert.rejects(
    () =>
      demo.claims.recordPreAuthorization(item!.id, {
        status: "denied",
        source: "payer-portal",
        recordedBy: "office.manager@clinic",
      }),
    /reason/i
  );
});

test("the whole decision is on the audit trail, including that it is synthetic", async () => {
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();

  const after = await demo.claims.recordPreAuthorization(item!.id, {
    status: "approved",
    source: "mock",
    referenceNumber: "AUTH-PIA-1",
    recordedBy: "office.manager@clinic",
  });

  const entry = after.claim.audit.find((a) => a.message.includes("Pre-authorisation recorded"))!;
  assert.ok(entry, "recording a decision is an auditable act");
  assert.match(entry.message, /office\.manager@clinic/, "attributed to a person");
  assert.match(entry.message, /AUTH-PIA-1/, "with the number that is the evidence");
  assert.match(entry.message, /SYNTHETIC TEST DATA/, "and synthetic data labelled as such");
});

test("the payer still refuses under CARC 197 — an approval is not a guarantee of payment", async () => {
  /**
   * The doctrine, demonstrated rather than asserted. The mock adjudicator refuses the crown under
   * CARC 197 regardless of what the practice recorded, because a real payer's adjudication is a
   * separate decision from its authorisation. That is precisely why the authorisation NUMBER is the
   * valuable field: it is the practice's evidence on the appeal.
   */
  const { demo } = clinic();
  await demo.verification.create(PIA);
  const [item] = await demo.claims.list();
  await demo.claims.recordPreAuthorization(item!.id, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-PIA-1",
    recordedBy: "office.manager@clinic",
  });
  await demo.claims.submit(item!.id, { submittedBy: "office.manager@clinic" });

  const submitted = await demo.claims.list({ status: "submitted" });
  const detail = (await demo.claims.get(submitted[0]!.id))!;
  await demo.remittance.fetchAndIngest({
    payerId: detail.claim.payer.payerId!,
    payerName: "MetLife Dental",
    payeeName: "MERMAID DEMO DENTAL",
    claims: [
      {
        patientControlNumber: detail.claim.submission!.patientControlNumber,
        payerControlNumber: detail.claim.submission!.controlNumber,
        patientFirstName: "Pia",
        patientLastName: "Phase32",
        memberId: "MET90077",
        lines: detail.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
        expectedInsurancePays: detail.claim.expectedInsurancePays,
      },
    ],
  });

  const remits = await demo.remittance.list();
  const posting = (await demo.remittance.get(remits[0]!.id))!.remittance.postings[0]!;
  const carc197 = posting.adjustments.find((a) => a.code === "197");

  assert.ok(carc197, "the payer's refusal is still CARC 197 — the reason the snapshot predicted");
  assert.equal(carc197!.group, "CO", "and in the CO group, so the patient cannot be billed for it");
  /**
   * The refused amount reaches the patient nowhere. Asserted against the CARC 197 adjustment itself
   * rather than the posting's total patient share — that total legitimately carries PR-2 coinsurance
   * from the exam and the cleaning, which ARE the patient's. The cost of the missing authorisation
   * is precisely the part they cannot be charged for.
   */
  const patientAdjustments = posting.adjustments.filter((a) => a.group === "PR");
  assert.ok(
    !patientAdjustments.some((a) => a.code === "197"),
    "a pre-auth refusal must never be assigned to the patient"
  );
  assert.equal(
    carc197!.category,
    "recoverable",
    "it is the practice's to pursue — recoverable by appeal, and never billable to the patient"
  );
  assert.ok(carc197!.amount > 0, "and it is real money");
});
