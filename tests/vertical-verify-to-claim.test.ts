/**
 * The vertical, end to end: card text → verification → coverage snapshot → domain event → claim →
 * scrub → human submit gate → 837 → payer acknowledgement.
 *
 * This test lives in `tests/` rather than in either module because it is the ONE place allowed to
 * import both bounded contexts (CI forbids it inside `modules/**`). What it proves is exactly what
 * the boundary rule is for: the two modules meet only through the event catalog and the shared
 * coverage snapshot, and yet the whole business flow works.
 *
 * The money assertion is the thesis in one line: the number the patient was quoted at verification
 * is the number on the claim, byte for byte, with no recalculation anywhere in between.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import {
  InMemoryVerificationRepository,
  VerificationService,
  type VerificationInput,
} from "@mermaid/verification";
import { ClaimService, InMemoryClaimRepository, registerClaimsSubscriptions } from "@mermaid/claims";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const NOW = new Date("2026-07-27T12:00:00Z");
const silent = createLogger(() => {});

const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };

/** The composition root — the only place that knows both modules exist. */
function clinic() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const adapter = new MockEdiAdapter();
  const verification = new VerificationService(new InMemoryVerificationRepository(), adapter, bus);
  const claims = new ClaimService(new InMemoryClaimRepository(), adapter, BILLING_PROVIDER, bus);
  registerClaimsSubscriptions(bus, claims);
  return { bus, verification, claims };
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

const CLEAN_VISIT = () => visit("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");

test("a verified patient's estimate becomes a filed claim without a human touching billing data", async () => {
  const { verification, claims } = clinic();

  const verified = await verification.create(CLEAN_VISIT(), NOW);
  assert.equal(verified.record.status, "verified");

  // No explicit call into claims — the event did it.
  const claim = await claims.getByVerification(verified.record.id, NOW);
  assert.ok(claim, "the completed verification should have produced a claim");
  assert.equal(claim.claim.status, "ready");
  assert.equal(claim.canSubmit, true);
});

test("the claim inherits the exact estimate the patient was quoted", async () => {
  const { verification, claims } = clinic();
  const verified = await verification.create(CLEAN_VISIT(), NOW);
  const calculation = verified.record.calculation!;
  const claim = (await claims.getByVerification(verified.record.id, NOW))!.claim;

  assert.equal(claim.totalFee, calculation.totalFee);
  assert.equal(claim.expectedInsurancePays, calculation.totalInsurancePays);
  assert.equal(claim.expectedPatientPays, calculation.totalPatientPays);
  assert.equal(claim.coverageSnapshot.verificationId, verified.record.id);

  claim.lines.forEach((line, i) => {
    assert.equal(line.fee, calculation.lines[i]!.fee);
    assert.equal(line.expectedInsurancePays, calculation.lines[i]!.insurancePays);
    assert.equal(line.expectedPatientPays, calculation.lines[i]!.patientPays);
  });
});

test("a human releases the claim and the payer acknowledges it", async () => {
  const { verification, claims, bus } = clinic();
  const verified = await verification.create(CLEAN_VISIT(), NOW);
  const draft = (await claims.getByVerification(verified.record.id, NOW))!;

  const filed = await claims.submit(draft.claim.id, { submittedBy: "office.manager@clinic" }, NOW);

  assert.equal(filed.claim.status, "submitted");
  assert.equal(filed.claim.submission!.outcome, "accepted");
  assert.ok(filed.claim.submission!.raw837!.includes("SV3*AD:D2750*1250.00"), "the crown is on the wire at its quoted fee");
  assert.ok(filed.claim.submission!.raw837!.includes("TOO*JP*19"), "the tooth number survived the whole pipeline");

  assert.deepEqual(
    bus.all().map((e) => e.type),
    ["verification.completed", "claim.submitted"],
    "the two contexts communicated only through the outbox"
  );
  assert.equal(bus.pending().length, 0);
});

test("a verification needing review produces NO claim until a human settles it", async () => {
  const { verification, claims, bus } = clinic();

  // Member IDs ending "00" come back inactive → routed to a human.
  const flagged = await verification.create(visit("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);
  assert.equal(flagged.record.status, "needs_review");
  assert.equal(await claims.getByVerification(flagged.record.id, NOW), null, "an unreviewed estimate must never reach billing");
  assert.deepEqual(bus.all().map((e) => e.type), ["verification.needs_review"]);

  // A human approves it; now — and only now — a claim exists.
  const reviewed = await verification.review(flagged.record.id, { decision: "approved", notes: "Confirmed by phone." }, NOW);
  assert.equal(reviewed.record.status, "reviewed");

  const claim = await claims.getByVerification(flagged.record.id, NOW);
  assert.ok(claim, "approving the review should release it to billing");
  // Coverage was inactive, so the scrubber holds it in draft — the human decision does not
  // override the payer's answer.
  assert.equal(claim.claim.status, "draft");
  assert.equal(claim.canSubmit, false);
  assert.equal(claim.blockers[0]!.code, "inactive-coverage");
});

test("a rejected review never reaches billing at all", async () => {
  const { verification, claims } = clinic();
  const flagged = await verification.create(visit("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);
  await verification.review(flagged.record.id, { decision: "rejected", notes: "Wrong patient." }, NOW);
  assert.equal(await claims.getByVerification(flagged.record.id, NOW), null);
});

test("a verification with no payer connector produces no claim", async () => {
  const { verification, claims } = clinic();
  const orphan = await verification.create(visit("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"), NOW);
  assert.equal(orphan.record.benefits, null);
  assert.equal(await claims.getByVerification(orphan.record.id, NOW), null);
});

test("a redelivered verification.completed event does not double-bill the patient", async () => {
  const { verification, claims, bus } = clinic();
  const verified = await verification.create(CLEAN_VISIT(), NOW);

  // Force the outbox to hand the same event to the subscriber again.
  await bus.drain(NOW);
  const completed = bus.ofType("verification.completed")[0]!;
  await claims.createFromVerification(completed.payload, NOW);

  const all = await claims.list(undefined, NOW);
  assert.equal(all.length, 1, "one visit, one claim");
  assert.equal(all[0]!.verificationId, verified.record.id);
});

test("the whole flow is deterministic — two identical clinics produce identical claims", async () => {
  const runOnce = async () => {
    const { verification, claims } = clinic();
    const verified = await verification.create(CLEAN_VISIT(), NOW);
    const claim = (await claims.getByVerification(verified.record.id, NOW))!.claim;
    // Ids are random by design; everything else must match exactly.
    const { id, verificationId, coverageSnapshot, audit, ...rest } = claim;
    return {
      ...rest,
      snapshot: { ...coverageSnapshot, verificationId: "<id>" },
      audit: audit.map((entry) => ({ ...entry, message: entry.message.replaceAll(verificationId, "<id>") })),
    };
  };

  assert.deepEqual(await runOnce(), await runOnce());
});
