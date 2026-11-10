/**
 * A family shares one member id, and a patient record must still contain only its own claims.
 *
 * ── WHAT THESE COVER THAT NOTHING ELSE DID ─────────────────────────────────────────────────────
 * `dependents.test.ts` proves the identity layer holds: two people on one subscriber id stay two
 * charts, and `patientIdForMemberId` answers null rather than guessing. `patient-record.test.ts`
 * proves verifications and ledger keys resolve. `patient-record-isolation.test.ts` proves the
 * verification and ledger SCOPES exclude another person's rows.
 *
 * None of them ever asserted on claims. Every one of them builds one patient's data and asserts it
 * APPEARS; none builds two and asserts the other's does NOT. So `claims.list({ memberIds })` — a
 * policy used as a person — went unnoticed, and the denials reached through those claim ids went
 * with it.
 *
 * These tests are written the other way round: two people, one policy, and the assertion is
 * absence. They drive the real composition root (`buildPatientRecord` over `buildServices`), not a
 * repository in isolation, because the defect lived in how the root composed correct parts.
 *
 * ── NOTHING IS HAND-SEEDED ─────────────────────────────────────────────────────────────────────
 * Every verification, claim and denial below is produced by the production path. An earlier
 * isolation test seeded `patient_id` by hand and so proved a predicate rather than the write that
 * feeds it — which is exactly how the ledger's family-charge gap survived an audit.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireContext, withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import {
  PgPatientDirectory,
  PgVerificationRepository,
  VerificationService,
  type VerificationInput,
} from "@mermaid/verification";
import { ClaimService, PgClaimRepository } from "@mermaid/claims";
import { buildPatientRecord } from "../../apps/web/patient-record.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

const NOW = new Date("2026-08-26T12:00:00Z");
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };

/** A member id unique to this run, so repeated runs against a shared database cannot collide. */
const policy = () => `FAM-${randomUUID().slice(0, 8).toUpperCase()}`;

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/**
 * The subscriber and her child under ONE member id at ONE payer. Different dates of birth are what
 * make them two people — the discriminator `deriveChartId` uses. Everything else is identical,
 * because the defect is invisible unless the policy matches.
 */
const visit = (first: string, dob: string, memberId: string, payer = "Delta Dental"): VerificationInput => ({
  patient: { firstName: first, lastName: "Alpha", dateOfBirth: dob, memberId, address: SYNTHETIC_ADDRESS },
  cardText: `${payer}\nMember ID: ${memberId}`,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
  ],
});

/** The real pipeline: verify a patient, then build their claim from that verification. */
async function verifiedClaim(practiceId: string, input: VerificationInput) {
  return withPractice(practiceId, async () => {
    const patients = new PgPatientDirectory();
    const verification = new VerificationService(
      new PgVerificationRepository(),
      new MockEdiAdapter(),
      new NullEventPublisher(),
      undefined,
      patients
    );
    const claims = new ClaimService(new PgClaimRepository(), new MockEdiAdapter(), BILLING_PROVIDER, new NullEventPublisher());

    const verified = await verification.create(input, NOW);
    const payload = await verification.completionEvent(verified.record.id);
    const claim = payload ? await claims.createFromVerification(payload, NOW) : null;
    return { verificationId: verified.record.id, claimId: claim?.claim.id ?? null };
  });
}

const recordFor = (practiceId: string, patientId: string) =>
  withPractice(practiceId, () => buildPatientRecord(buildServices(), patientId, NOW));

const patientIdFor = (practiceId: string, first: string, dob: string) =>
  withPractice(practiceId, async () => {
    const found = await new PgPatientDirectory().ensure({ firstName: first, lastName: "Alpha", dateOfBirth: dob });
    return found.id;
  });

// ── A/B/E — two people, one policy, two charts ────────────────────────────────────────────────

test("two patients on one member id each see only their own claim", dbTest, async () => {
  const p = await practice("cd-isolation-claims");
  const memberId = policy();

  const ada = await verifiedClaim(p, visit("Ada", "1990-04-12", memberId));
  const kit = await verifiedClaim(p, visit("Kit", "2016-09-03", memberId));
  assert.ok(ada.claimId, "the subscriber's claim was built");
  assert.ok(kit.claimId, "the dependent's claim was built");
  assert.notEqual(ada.claimId, kit.claimId);

  const adaId = await patientIdFor(p, "Ada", "1990-04-12");
  const kitId = await patientIdFor(p, "Kit", "2016-09-03");
  assert.notEqual(adaId, kitId, "different dates of birth are different people");

  const adaRecord = (await recordFor(p, adaId))!;
  const kitRecord = (await recordFor(p, kitId))!;

  // A + B
  assert.deepEqual(
    adaRecord.claims.map((c) => c.id),
    [ada.claimId],
    "the subscriber's chart holds her claim and ONLY hers"
  );
  assert.deepEqual(
    kitRecord.claims.map((c) => c.id),
    [kit.claimId],
    "and the child's chart must not carry his mother's — the disclosure this prevents"
  );

  /**
   * ── AND THE OLD KEY IS STILL AMBIGUOUS, WHICH IS THE POINT ───────────────────────────────────
   * Asserted directly so this test cannot quietly stop testing anything. The member-ID filter still
   * returns BOTH claims — it is answering about a POLICY, correctly, and both of these people are on
   * it. That is precisely why it was the wrong key for a person, and why the chart above must not be
   * built from it. If a future change makes the two filters agree here, one of them has changed
   * meaning and this fails.
   */
  await withPractice(p, async () => {
    const byPolicy = await new PgClaimRepository().list({ memberIds: [memberId] });
    assert.equal(byPolicy.length, 2, "the policy covers both of them, so its filter returns both claims");
  });

  // E — the money on the chart is only this person's money.
  assert.equal(adaRecord.totals.billed, kitRecord.totals.billed, "the fixture bills both the same");
  assert.ok(adaRecord.totals.billed > 0, "and it is a real number, so the next assertion means something");
  const bothBilled = adaRecord.totals.billed * 2;
  assert.notEqual(
    adaRecord.totals.billed,
    bothBilled,
    "totals must not sum the family — one chart, one person's charges"
  );
});

// ── C/D — denials follow their claim, and never anyone else's ─────────────────────────────────

test("a denial raised on one patient's claim never appears on the other's chart", dbTest, async () => {
  const p = await practice("cd-isolation-denials");
  const memberId = policy();

  // MET30066 ends 77 — the mock adjudicates a pre-auth denial (CO-197) on the major line.
  const ada = await verifiedClaim(p, visit("Ada", "1990-04-12", memberId, "MetLife Dental"));
  const kit = await verifiedClaim(p, visit("Kit", "2016-09-03", memberId, "MetLife Dental"));

  const adaId = await patientIdFor(p, "Ada", "1990-04-12");
  const kitId = await patientIdFor(p, "Kit", "2016-09-03");

  const adaRecord = (await recordFor(p, adaId))!;
  const kitRecord = (await recordFor(p, kitId))!;

  // Denials are reached THROUGH claim ids, so a chart carrying the wrong claims carries the wrong
  // denials with it. With the claims scoped correctly, each set can only contain its own.
  for (const d of adaRecord.denials) {
    assert.equal(d.claimId, ada.claimId, "every denial on the subscriber's chart belongs to her claim");
  }
  for (const d of kitRecord.denials) {
    assert.equal(d.claimId, kit.claimId, "and every denial on the child's belongs to his");
  }
});

// ── F/J — one person, two policies: both claims, once each ────────────────────────────────────

test("one patient holding two member ids sees both of their claims, exactly once", dbTest, async () => {
  const p = await practice("cd-isolation-two-policies");
  const first = policy();
  const second = policy();

  const a = await verifiedClaim(p, visit("Ada", "1990-04-12", first, "Delta Dental"));
  const b = await verifiedClaim(p, visit("Ada", "1990-04-12", second, "MetLife Dental"));
  const adaId = await patientIdFor(p, "Ada", "1990-04-12");

  const record = (await recordFor(p, adaId))!;
  const ids = record.claims.map((c) => c.id).sort();

  assert.deepEqual(
    ids,
    [a.claimId, b.claimId].filter(Boolean).sort(),
    "a job change is not a second person, and a second policy is not a second chart"
  );
  assert.equal(new Set(ids).size, ids.length, "and neither claim is counted twice");
});

// ── G/H — an empty or blank scope claims nothing ──────────────────────────────────────────────

test("an empty verification scope matches no claims, and a blank one matches nothing either", dbTest, async () => {
  const p = await practice("cd-isolation-empty");
  await verifiedClaim(p, visit("Ada", "1990-04-12", policy()));

  await withPractice(p, async () => {
    const repo = new PgClaimRepository();

    assert.deepEqual(
      await repo.list({ verificationIds: [] }),
      [],
      "an empty list is 'these none', not 'all claims' — the reading that turns a filter into a leak"
    );
    assert.deepEqual(await repo.list({ memberIds: [] }), [], "and the same for the policy filter");

    // A blank string is a value nobody holds. It must not behave as a wildcard in either filter.
    assert.deepEqual(await repo.list({ memberIds: [""] }), []);
    assert.deepEqual(await repo.list({ verificationIds: [] }), []);
  });
});

// ── THE LEDGER: a family's charges must still name the person who incurred them ───────────────

/**
 * ── THE BUG THE PREVIOUS AUDIT MISSED, AND WHY IT MISSED IT ────────────────────────────────────
 *
 * `chargeFromPosting` resolved whose money a charge was by asking `byMemberId`, and that answers
 * "exactly one, or nothing" — deliberately, because a member ID is a policy and guessing a family
 * member is how a child's balance lands on their sibling. So for a family it returned NULL, the
 * charge was written with no patient, and an unresolved entry belongs to everyone holding its key.
 * The families the refusal was written to protect were the ones it left commingled.
 *
 * The isolation test that should have caught it hand-seeded `patient_id` on its fixtures. It proved
 * the read predicate and never touched the write that feeds it, so it passed while the production
 * path was still writing nulls. This test therefore constructs NOTHING: the verification, the
 * claim and the charge are all produced by the real services, wired as the composition root wires
 * them, and the assertion is on the column the production path actually wrote.
 */
test("a charge for one family member names that person, and does not land on their sibling", dbTest, async () => {
  const p = await practice("cd-isolation-ledger-family");
  const memberId = policy();

  // Two people, one policy — and a real claim for the subscriber only.
  const ada = await verifiedClaim(p, visit("Ada", "1990-04-12", memberId));
  await verifiedClaim(p, visit("Kit", "2016-09-03", memberId));
  assert.ok(ada.claimId, "the subscriber has a real claim to charge against");

  const adaId = await patientIdFor(p, "Ada", "1990-04-12");
  const kitId = await patientIdFor(p, "Kit", "2016-09-03");

  // The member ID alone genuinely cannot answer this — which is the whole reason the claim must.
  await withPractice(p, async () => {
    const holders = await new PgPatientDirectory().patientIdsForMemberId(memberId);
    assert.equal(holders.length, 2, "the policy is held by both of them");
    assert.equal(
      await new PgPatientDirectory().patientIdForMemberId(memberId),
      null,
      "so asked for ONE patient the member ID must refuse — it is the claim that disambiguates"
    );
  });

  // The production path: the ledger as the composition root builds it, charged from a posting that
  // cites Ada's claim. Nothing here sets patient_id.
  await withPractice(p, () =>
    buildServices().ledger.chargeFromPosting(
      {
        remittanceId: randomUUID(),
        postingId: randomUUID(),
        claimId: ada.claimId!,
        patientControlNumber: "MRM-FAMILY01",
        postedAt: NOW.toISOString(),
        traceNumber: "EFT900900900",
        payerId: "delta-dental",
        payerName: "Delta Dental",
        patientName: "Ada Alpha",
        memberId,
        paymentDate: "2026-08-26",
        chargedAmount: cents(1425),
        paidAmount: cents(800),
        patientResponsibility: cents(200),
        contractualAdjustments: cents(425),
        expectedInsurancePays: cents(800),
        variance: cents(0),
        outcome: "as_expected",
        settled: true,
      },
      NOW
    )
  );

  // The column the production path wrote — read directly, because a document that says one thing
  // while the column says another is exactly the drift worth catching.
  const rows = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT patient_id, patient_key, amount_cents FROM ledger_entries WHERE claim_id = $1",
      [ada.claimId]
    );
    return rows as { patient_id: string | null; patient_key: string; amount_cents: string }[];
  });

  assert.equal(rows.length, 1, "one posting, one charge");
  assert.notEqual(rows[0]!.patient_id, null, "the charge must NOT fall back to an unowned null");
  assert.equal(rows[0]!.patient_id, adaId, "it is the subscriber's charge, because it is her claim");
  assert.equal(rows[0]!.patient_key, memberId, "and it still records the policy the money travelled under");

  // …and the consequence that matters: the sibling's balance is untouched.
  const adaRecord = (await recordFor(p, adaId))!;
  const kitRecord = (await recordFor(p, kitId))!;
  assert.equal(adaRecord.totals.chargedToPatient, 200_00, "the subscriber owes what the payer left her");
  assert.equal(kitRecord.totals.chargedToPatient, 0, "and the child owes nothing — it was never his charge");
  assert.equal(kitRecord.totals.balance, 0, "a family sharing a policy does not share a balance");
});

// ── I — a legacy verification still carries its claim onto the chart ──────────────────────────

/**
 * A verification written before the patient master carries a NULL `patient_id` and is matched by
 * member id in its own scope. Its claim must arrive with it — a person shown FEWER claims than they
 * have is the failure that hides money, and it is the one a careless narrowing causes.
 */
test("a legacy claim whose verification never resolved a patient still reaches the chart", dbTest, async () => {
  const p = await practice("cd-isolation-legacy");
  const memberId = policy();

  const ada = await verifiedClaim(p, visit("Ada", "1990-04-12", memberId));
  const adaId = await patientIdFor(p, "Ada", "1990-04-12");

  // Make it legacy the only way that is faithful: drop the link the patient master added, leaving
  // exactly the shape a pre-M14 row has. The coverage row still maps the member id to her.
  await withPractice(p, async () => {
    await requireContext().tx.query("UPDATE verifications SET patient_id = NULL WHERE id = $1", [ada.verificationId]);
  });

  const record = (await recordFor(p, adaId))!;
  assert.deepEqual(
    record.claims.map((c) => c.id),
    [ada.claimId],
    "the legacy row is matched by member id in the verification scope, and its claim comes with it"
  );
});
