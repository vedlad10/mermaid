/**
 * Postgres repositories, against a real database.
 *
 * Two categories, and both are things an in-memory double cannot establish:
 *
 *  • **Round-trip fidelity.** A deep aggregate stored as versioned JSONB and read back must be
 *    identical — not "close enough". Money especially: BIGINT cents come back through the driver,
 *    and a value that arrives as the string "125000" instead of the number 125000 would silently
 *    concatenate rather than add, somewhere far from here.
 *
 *  • **Tenant isolation, per table.** RLS is proven generally in `db:verify`, but each new table
 *    must actually have it applied. A table where someone forgot `enable_tenant_rls` looks perfectly
 *    healthy until the day a second practice exists.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import {
  PgVerificationRepository,
  VerificationService,
  type VerificationInput,
} from "@mermaid/verification";
import { ClaimService, PgClaimRepository } from "@mermaid/claims";
import {
  PgEraArtifactRepository,
  PgEraSourceRepository,
  PgExpectationRepository,
  PgRemittanceRepository,
  RemittanceService,
} from "@mermaid/remittance";
import { NullEventPublisher } from "@mermaid/events";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/** Services on the Postgres repositories, with events suppressed so tests isolate persistence. */
function services() {
  const adapter = new MockEdiAdapter();
  const quiet = new NullEventPublisher();
  return {
    verification: new VerificationService(new PgVerificationRepository(), adapter, quiet),
    claims: new ClaimService(new PgClaimRepository(), adapter, BILLING_PROVIDER, quiet),
    remittance: new RemittanceService(
      new PgRemittanceRepository(),
      new PgExpectationRepository(),
      adapter,
      quiet
    ),
  };
}

/**
 * A deliberately obvious NON-DELIVERABLE address for an invented patient.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so the claim scrubber blocks the
 * submit gate without one — and several tests here file a claim and assert on what was persisted.
 * Named to be unmistakable: nothing in this file may ever reach a real payer, and no production path
 * falls back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const visit = (memberId: string, cardText: string): VerificationInput => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) },
  ],
});

const CLEAN = () => visit("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");

// ── Verification ──────────────────────────────────────────────────────────────────────

test("a verification round-trips through Postgres byte for byte", dbTest, async () => {
  const p = await practice("ver-roundtrip");
  const svc = services().verification;

  const created = await withPractice(p, () => svc.create(CLEAN(), NOW));
  const read = await withPractice(p, () => svc.get(created.record.id, NOW));

  assert.ok(read);
  assert.deepEqual(read.record, created.record, "the aggregate must survive JSONB unchanged");
});

test("money comes back as integer cents, not strings", dbTest, async () => {
  const p = await practice("ver-money");
  const svc = services().verification;
  const created = await withPractice(p, () => svc.create(CLEAN(), NOW));

  const read = (await withPractice(p, () => svc.get(created.record.id, NOW)))!;
  const total = read.record.calculation!.totalFee;
  assert.equal(typeof total, "number", "BIGINT cents must not arrive as a string");
  assert.ok(Number.isInteger(total));
  assert.equal(total, cents(1425));

  // And the extracted column agrees with the document it was derived from.
  const column = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT total_fee_cents, patient_pays_cents FROM verifications WHERE id = $1",
      [created.record.id]
    );
    return rows[0] as { total_fee_cents: number; patient_pays_cents: number };
  });
  assert.equal(column.total_fee_cents, read.record.calculation!.totalFee);
  assert.equal(column.patient_pays_cents, read.record.calculation!.totalPatientPays);
});

test("a review updates the stored aggregate and its extracted status", dbTest, async () => {
  const p = await practice("ver-review");
  const svc = services().verification;
  const created = await withPractice(p, () => svc.create(visit("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW));
  assert.equal(created.record.status, "needs_review");

  await withPractice(p, () => svc.review(created.record.id, { decision: "approved", notes: "By phone." }, NOW));

  const read = (await withPractice(p, () => svc.get(created.record.id, NOW)))!;
  assert.equal(read.record.status, "reviewed");
  assert.equal(read.record.review?.decision, "approved");

  const status = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query("SELECT status FROM verifications WHERE id = $1", [
      created.record.id,
    ]);
    return (rows[0] as { status: string }).status;
  });
  assert.equal(status, "reviewed", "the extracted column tracks the document");
});

test("the openOnly filter is answered in SQL, and agrees with the in-memory predicate", dbTest, async () => {
  const p = await practice("ver-open");
  const svc = services().verification;

  const { clean, flagged, unknownPayer } = await withPractice(p, async () => ({
    clean: await svc.create(CLEAN(), NOW),
    flagged: await svc.create(visit("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW),
    unknownPayer: await svc.create(visit("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"), NOW),
  }));

  const open = await withPractice(p, () => svc.list({ openOnly: true }, NOW));
  const ids = open.map((v) => v.id);
  assert.equal(ids.includes(clean.record.id), false);
  assert.ok(ids.includes(flagged.record.id));
  assert.ok(
    ids.includes(unknownPayer.record.id),
    "a failed verification nobody has reviewed still needs a person"
  );

  // The half only a database can check: `review` lives inside the JSONB document, and the SQL
  // predicate has to read a JSON null the same way the TypeScript one reads `null`.
  await withPractice(p, () =>
    svc.review(flagged.record.id, { decision: "rejected", notes: "Wrong patient." }, NOW)
  );
  const after = await withPractice(p, () => svc.list({ openOnly: true }, NOW));
  assert.equal(
    after.some((v) => v.id === flagged.record.id),
    false,
    "a rejected verification is settled work and must not come back from SQL"
  );
  assert.equal((await withPractice(p, () => svc.list(undefined, NOW))).length, 3);
});

test("verifications are invisible across practices", dbTest, async () => {
  const [pA, pB] = [await practice("ver-iso-a"), await practice("ver-iso-b")];
  const svc = services().verification;

  const mine = await withPractice(pA, () => svc.create(CLEAN(), NOW));
  await withPractice(pB, () => svc.create(CLEAN(), NOW));

  assert.equal((await withPractice(pA, () => svc.list(undefined, NOW))).length, 1);
  assert.equal(await withPractice(pB, () => svc.get(mine.record.id, NOW)), null, "practice B cannot read A's record");
  assert.equal(await visibleCount(pA, "verifications"), 1);
});

// ── Claims ────────────────────────────────────────────────────────────────────────────

test("a claim round-trips, and its inherited snapshot is intact", dbTest, async () => {
  const p = await practice("claim-roundtrip");
  const { verification, claims } = services();

  const verified = await withPractice(p, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(p, () => claims.createFromVerification(payload, NOW));

  const read = (await withPractice(p, () => claims.get(built.claim.id, NOW)))!;
  assert.deepEqual(read.claim, built.claim);
  assert.deepEqual(
    read.claim.coverageSnapshot.calculation,
    verified.record.calculation,
    "the estimate the patient was quoted survives the database unchanged"
  );
});

test("the database refuses a second claim for one verification", dbTest, async () => {
  const p = await practice("claim-unique");
  const { verification, claims } = services();
  const verified = await withPractice(p, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;

  const first = await withPractice(p, () => claims.createFromVerification(payload, NOW));
  // The service is idempotent, so this returns the existing claim rather than inserting.
  const second = await withPractice(p, () => claims.createFromVerification(payload, NOW));
  assert.equal(first.claim.id, second.claim.id);

  // And the constraint itself holds even when the service guard is bypassed entirely.
  const repo = new PgClaimRepository();
  await assert.rejects(
    withPractice(p, () => repo.save({ ...first.claim, id: crypto.randomUUID() })),
    /already has a claim/,
    "claims_one_per_verification is what actually prevents duplicate billing"
  );
});

test("claims are invisible across practices", dbTest, async () => {
  const [pA, pB] = [await practice("claim-iso-a"), await practice("claim-iso-b")];
  const { verification, claims } = services();

  const verified = await withPractice(pA, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(pA, () => verification.completionEvent(verified.record.id)))!;
  const mine = await withPractice(pA, () => claims.createFromVerification(payload, NOW));

  assert.equal(await withPractice(pB, () => claims.get(mine.claim.id, NOW)), null);
  assert.equal(await withPractice(pB, () => claims.getByVerification(verified.record.id, NOW)), null);
  assert.equal((await withPractice(pB, () => claims.list(undefined, NOW))).length, 0);
});

test("submitting persists the payer acknowledgement and the filed 837", dbTest, async () => {
  const p = await practice("claim-submit");
  const { verification, claims } = services();
  const verified = await withPractice(p, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(p, () => claims.createFromVerification(payload, NOW));

  await withPractice(p, () => claims.submit(built.claim.id, { submittedBy: "biller@clinic" }, NOW));

  const read = (await withPractice(p, () => claims.get(built.claim.id, NOW)))!;
  assert.equal(read.claim.status, "submitted");
  assert.equal(read.claim.submission?.submittedBy, "biller@clinic");
  assert.ok(read.claim.submission?.raw837?.includes("ST*837*"), "provenance survives the round trip");
});

// ── Remittance ────────────────────────────────────────────────────────────────────────

/** Verify → claim → submit → remit, all on Postgres. Returns the practice and the posted view. */
async function throughPayment(p: string) {
  const { verification, claims, remittance } = services();
  const verified = await withPractice(p, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(p, () => claims.createFromVerification(payload, NOW));
  const filed = await withPractice(p, () => claims.submit(built.claim.id, { submittedBy: "biller" }, NOW));

  await withPractice(p, () =>
    remittance.recordExpectation({
      claimId: filed.claim.id,
      verificationId: verified.record.id,
      submittedAt: filed.claim.submission!.submittedAt,
      submittedBy: "biller",
      patient: {
        firstName: filed.claim.patient.firstName,
        lastName: filed.claim.patient.lastName,
        dateOfBirth: filed.claim.patient.dateOfBirth,
        memberId: filed.claim.patient.memberId,
      },
      payerId: filed.claim.payer.payerId,
      payerName: filed.claim.payer.payerName,
      patientControlNumber: filed.claim.submission!.patientControlNumber,
      payerControlNumber: filed.claim.submission!.controlNumber,
      totalFee: filed.claim.totalFee,
      expectedInsurancePays: filed.claim.expectedInsurancePays,
      serviceDate: filed.claim.serviceDate,
    })
  );

  const [posted] = await withPractice(p, () =>
    remittance.fetchAndIngest(
      {
        payerId: filed.claim.payer.payerId!,
        payerName: filed.claim.payer.payerName!,
        payeeName: BILLING_PROVIDER.name,
        paymentDate: "2026-09-15",
        claims: [
          {
            patientControlNumber: filed.claim.submission!.patientControlNumber,
            payerControlNumber: filed.claim.submission!.controlNumber,
            patientFirstName: filed.claim.patient.firstName,
            patientLastName: filed.claim.patient.lastName,
            memberId: filed.claim.patient.memberId,
            lines: filed.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
            expectedInsurancePays: filed.claim.expectedInsurancePays,
          },
        ],
      },
      NOW
    )
  );
  return { remittance, claim: filed.claim, posted: posted! };
}

test("a remittance round-trips with its postings and variance", dbTest, async () => {
  const p = await practice("remit-roundtrip");
  const { remittance, posted } = await throughPayment(p);

  const read = (await withPractice(p, () => remittance.get(posted.remittance.id, NOW)))!;
  assert.deepEqual(read.remittance, posted.remittance);
  assert.equal(read.remittance.status, "posted");
  assert.equal(read.remittance.postings.length, 1);
  assert.ok(read.remittance.postings[0]!.variance, "variance survived JSONB");
  assert.equal(typeof read.remittance.paymentTotal, "number");
});

test("the postings projection matches the aggregate it was derived from", dbTest, async () => {
  const p = await practice("remit-projection");
  const { posted } = await throughPayment(p);
  const posting = posted.remittance.postings[0]!;

  const row = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      `SELECT paid_cents, charged_cents, expected_insurance_cents, contractual_cents, actionable
         FROM postings WHERE id = $1`,
      [posting.id]
    );
    return rows[0] as Record<string, number | boolean>;
  });

  assert.equal(row.paid_cents, posting.paidAmount);
  assert.equal(row.charged_cents, posting.chargedAmount);
  assert.equal(row.expected_insurance_cents, posting.variance!.expectedInsurancePays);
  assert.equal(row.contractual_cents, posting.variance!.contractualAdjustments);
  assert.equal(row.actionable, posting.variance!.actionable);
});

test("the database refuses a second remittance under one dedupe key", dbTest, async () => {
  const p = await practice("remit-trace");
  const { posted } = await throughPayment(p);

  const repo = new PgRemittanceRepository();
  await assert.rejects(
    withPractice(p, () => repo.save({ ...posted.remittance, id: crypto.randomUUID() })),
    /dedupe key .* already exists/,
    "remittances_one_per_dedupe_key is what actually prevents double-posted money"
  );
});

test("two trace-less remittances coexist — they are different payments", dbTest, async () => {
  /**
   * The collision migration 0018 exists to end. `trace_number` is NOT NULL, so both of these store
   * the empty string; under the old `UNIQUE (practice_id, trace_number)` the second insert violated
   * the constraint and that payment could never be recorded at all.
   *
   * Asserted against the REAL constraint rather than the in-memory stand-in, because this one is a
   * property of the schema — the in-memory repository could agree while the database still refused.
   */
  const p = await practice("remit-traceless");
  const { posted } = await throughPayment(p);
  const repo = new PgRemittanceRepository();

  const traceless = (dedupeKey: string) => ({
    ...posted.remittance,
    id: crypto.randomUUID(),
    traceNumber: "",
    dedupeKey,
    postings: [],
  });

  await withPractice(p, () => repo.save(traceless("sha256:aaaa")));
  await withPractice(p, () => repo.save(traceless("sha256:bbbb")));

  const stored = await withPractice(p, () => repo.list());
  const tracelessRows = stored.filter((r) => r.traceNumber === "");
  assert.equal(tracelessRows.length, 2, "two distinct trace-less payments must both be stored");

  // And the guarantee still holds for a genuine redelivery of the same one.
  await assert.rejects(
    withPractice(p, () => repo.save(traceless("sha256:aaaa"))),
    /dedupe key .* already exists/,
    "distinct trace-less payments coexist, but the SAME one still cannot post twice"
  );
});

test("remittances, postings and expectations are all invisible across practices", dbTest, async () => {
  const [pA, pB] = [await practice("remit-iso-a"), await practice("remit-iso-b")];
  const { remittance, posted } = await throughPayment(pA);

  assert.equal(await withPractice(pB, () => remittance.get(posted.remittance.id, NOW)), null);
  assert.equal((await withPractice(pB, () => remittance.list(undefined, NOW))).length, 0);
  assert.equal((await withPractice(pB, () => remittance.recoveryQueue(NOW))).length, 0);
  assert.equal(await visibleCount(pB, "postings"), 0);
  assert.equal(await visibleCount(pB, "claim_expectations"), 0);
  assert.equal(await visibleCount(pA, "postings"), 1);
});

test("the expectation ledger round-trips its money and dates", dbTest, async () => {
  const p = await practice("expectations");
  const { claim } = await throughPayment(p);

  const repo = new PgExpectationRepository();
  const read = await withPractice(p, () =>
    repo.getByControlNumber(claim.submission!.patientControlNumber)
  );
  assert.ok(read);
  assert.equal(read.claimId, claim.id);
  assert.equal(read.expectedInsurancePays, claim.expectedInsurancePays);
  assert.equal(typeof read.expectedInsurancePays, "number");
  assert.equal(read.serviceDate, claim.serviceDate, "a DATE must not shift by a timezone");
});

test("every repository refuses to run without a practice context", dbTest, async () => {
  const repo = new PgVerificationRepository();
  await assert.rejects(() => repo.getById(crypto.randomUUID()), /no ambient database transaction/);

  /**
   * `heldSummary` specifically, because it is the one read here that a MONITOR takes — on a bare
   * timer, with no request behind it and therefore no ambient context unless something opens one.
   *
   * That exact shape has already caused a silent outage in this system once: the reconciliation
   * check called its repository straight from a `setInterval` tick, threw on every tick for want of
   * a context, and reported "the money is now unmonitored" forever while looking like a working
   * alarm. The property that makes that recoverable is this one — it must THROW, loudly and every
   * time, rather than returning a plausible `{count: 0}` that a threshold reads as good news.
   */
  await assert.rejects(
    () => new PgRemittanceRepository().heldSummary(),
    /no ambient database transaction/,
    "an aggregate with no tenant scope must fail closed, never answer zero"
  );
});

/**
 * ── STOPPED MONEY IS TENANT-SCOPED TOO ─────────────────────────────────────────────────────────
 *
 * `heldSummary` and `deadLetteredArtifacts` are read once a minute, per practice, by a monitor that
 * runs on a bare timer with no request behind it. That is precisely the shape that produced a whole
 * milestone of silent breakage once already (the reconciliation check, which threw on every tick
 * because it had no practice context and reported "unmonitored" as though that were a reading).
 *
 * So both readings are asserted here the same way every other tenant read in this file is: one
 * practice's stopped money must be completely invisible to another's, enforced by RLS rather than
 * by a WHERE clause anyone could forget.
 *
 * The hold is written directly rather than produced from a real 835, deliberately. That a genuine
 * coordination or payee blocker HOLDS is proved off parsed X12 in `today-stopped-money.test.ts`;
 * what is under test here is the tenancy of the query, and building it from a known-held row keeps
 * this test about that and nothing else.
 */
test("held money and abandoned ERA files are invisible across practices", dbTest, async () => {
  const [pA, pB] = [await practice("held-iso-a"), await practice("held-iso-b")];
  const { posted } = await throughPayment(pA);
  const repo = new PgRemittanceRepository();

  await withPractice(pA, () =>
    repo.save({
      ...posted.remittance,
      id: crypto.randomUUID(),
      dedupeKey: `held-${crypto.randomUUID()}`,
      status: "held",
      holdReason: "coordination of benefits — another payer's share is unresolved",
      // No postings: `postings.id` is unique and the source remittance's are already stored, so
      // cloning them collides. Nothing here reads a posting — `heldSummary` is an aggregate over the
      // remittance rows alone, which is the point of it being cheap enough to run every minute.
      postings: [],
    })
  );

  const a = await withPractice(pA, () => repo.heldSummary());
  assert.equal(a.count, 1, "the practice that received the money sees it held");
  assert.equal(a.totalCents, posted.remittance.paymentTotal);
  assert.ok(a.oldestReceivedAt, "and knows since when");

  const b = await withPractice(pB, () => repo.heldSummary());
  assert.deepEqual(
    b,
    { count: 0, oldestReceivedAt: null, totalCents: 0 },
    "another practice sees none of it — a monitor enumerating tenants must not leak one's money into another's alert"
  );

  // The same property for the ERA ledger, which the Today queue reads through the service.
  const artifacts = new PgEraArtifactRepository();
  const sources = new PgEraSourceRepository();
  const source = await withPractice(pA, () =>
    sources.upsert({
      practiceId: pA,
      vendor: "mock",
      credential: "test_credential_held_iso",
      payeeNpi: null,
      cursor: null,
      enabled: true,
    })
  );
  const { artifact } = await withPractice(pA, () =>
    artifacts.discover({
      practiceId: pA,
      sourceId: source.id,
      fileExecutionId: `file-abandoned-${crypto.randomUUID()}`,
      transactionId: null,
      processedAt: null,
    })
  );
  await withPractice(pA, () => artifacts.reschedule(artifact.id, "the clearinghouse never answered", NOW, true));

  const serviceFor = () =>
    new RemittanceService(new PgRemittanceRepository(), new PgExpectationRepository(), new MockEdiAdapter(), new NullEventPublisher(), artifacts);

  assert.equal(
    (await withPractice(pA, () => serviceFor().deadLetteredArtifacts())).length,
    1,
    "the practice whose credential fetched it sees the abandoned file"
  );
  assert.equal(
    (await withPractice(pB, () => serviceFor().deadLetteredArtifacts())).length,
    0,
    "and nobody else does"
  );
});

/**
 * ── A RECOUPMENT HOLD IS TENANT-SCOPED, AND ITS ATTRIBUTION SURVIVES THE ROUND TRIP (M12) ──────
 *
 * Two properties in one test because they are the same row: a PLB hold must be invisible to another
 * practice (the money it names belongs to one of them and only one), and the `reasonCode` /
 * `referenceId` that say WHICH claim was recouped must come back out of JSONB intact. An attribution
 * that survives the gate and dies in the database is worse than none — the hold still fires, and the
 * sentence telling the biller where to look is gone.
 */
test("a held recoupment is invisible across practices, and its attribution round-trips", dbTest, async () => {
  const [pA, pB] = [await practice("plb-iso-a"), await practice("plb-iso-b")];
  const { posted } = await throughPayment(pA);
  const repo = new PgRemittanceRepository();
  const id = crypto.randomUUID();

  await withPractice(pA, () =>
    repo.save({
      ...posted.remittance,
      id,
      dedupeKey: `plb-${crypto.randomUUID()}`,
      status: "held",
      holdReason: "provider-level adjustments above the review threshold",
      postings: [],
      providerAdjustments: [
        { providerId: "1234567893", reason: "WO>MRM-000123", reasonCode: "WO", referenceId: "MRM-000123", amount: cents(500) },
        { providerId: "1234567893", reason: "L6", reasonCode: "L6", referenceId: null, amount: cents(1.25) },
      ],
    })
  );

  const readBack = await withPractice(pA, () => repo.getById(id));
  assert.deepEqual(
    readBack!.providerAdjustments,
    [
      { providerId: "1234567893", reason: "WO>MRM-000123", reasonCode: "WO", referenceId: "MRM-000123", amount: cents(500) },
      { providerId: "1234567893", reason: "L6", reasonCode: "L6", referenceId: null, amount: cents(1.25) },
    ],
    "both halves of PLB03 survive JSONB — and a null reference stays null rather than becoming an empty string"
  );

  const a = await withPractice(pA, () => repo.heldSummary());
  assert.equal(a.count, 1, "the practice whose payment was recouped sees it held");

  const b = await withPractice(pB, () => repo.heldSummary());
  assert.deepEqual(
    b,
    { count: 0, oldestReceivedAt: null, totalCents: 0 },
    "and another practice sees none of it — one tenant's takeback is not another's alert"
  );
  assert.equal(await withPractice(pB, () => repo.getById(id)), null, "nor can it read the row directly");
});

/**
 * ── A REMITTANCE STORED BEFORE M12 STILL READS (v1 → v2 upcaster) ──────────────────────────────
 *
 * `providerAdjustments` gained two fields inside the persisted aggregate, so every document written
 * before this change lacks them. Without the upcaster those rows read back with `reasonCode`
 * undefined, and the attribution helper would report "no claim reference" for a takeback whose
 * reference was on the wire all along — a wrong sentence, which is worse than a missing one.
 *
 * The v1 document is written with raw SQL on purpose: the repository can no longer produce one.
 */
test("a v1 remittance document upcasts its provider adjustments on read", dbTest, async () => {
  const pA = await practice("plb-upcast");
  const { posted } = await throughPayment(pA);
  const id = crypto.randomUUID();

  await withPractice(pA, async () => {
    const v1 = {
      ...posted.remittance,
      id,
      dedupeKey: `upcast-${crypto.randomUUID()}`,
      status: "held",
      holdReason: "written before M12",
      postings: [],
      raw835: null,
      // The v1 shape: `reason` only, exactly as the pre-M12 parser stored PLB03.
      providerAdjustments: [
        { providerId: "1234567893", reason: "WO>MRM-000123", amount: cents(500) },
        { providerId: "1234567893", reason: "L6", amount: cents(1.25) },
      ],
      snapshot_version: 1,
    };
    await requireContext().tx.query(
      `INSERT INTO remittances
         (id, practice_id, trace_number, dedupe_key, status, payer_name, payee_name,
          payment_total_cents, payment_method, payment_date, balanced, hold_reason, raw_835,
          record, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, pA, `TRACE-${id.slice(0, 8)}`, v1.dedupeKey, "held", v1.payerName, v1.payeeName,
        v1.paymentTotal, v1.paymentMethod, v1.paymentDate, true, v1.holdReason, null,
        JSON.stringify(v1), v1.receivedAt,
      ]
    );
  });

  const readBack = await withPractice(pA, () => new PgRemittanceRepository().getById(id));
  assert.deepEqual(
    readBack!.providerAdjustments,
    [
      { providerId: "1234567893", reason: "WO>MRM-000123", reasonCode: "WO", referenceId: "MRM-000123", amount: cents(500) },
      { providerId: "1234567893", reason: "L6", reasonCode: "L6", referenceId: null, amount: cents(1.25) },
    ],
    "the halves are re-derived from the `reason` string the v1 document already stored — no data invented"
  );
});

/**
 * ── AN IDENTITY COLLISION IS TENANT-SCOPED (M14) ───────────────────────────────────────────────
 *
 * The collision detector decides on `coveragesFor`, so that read is now a safety control and not
 * merely a convenience. If it could see across practices, two practices that each treat an Ada
 * Alpha born the same day would flag each other's patients forever — and, far worse, one practice
 * would learn that another holds a member ID it has no right to know exists.
 *
 * The same name, the same birth date and the SAME payer at two practices is the exact input that
 * would collide if the query leaked, which is why the fixture uses it deliberately.
 */
test("one practice's coverage links, and its collisions, are invisible to another", dbTest, async () => {
  const [pA, pB] = [await practice("collide-iso-a"), await practice("collide-iso-b")];
  const { PgPatientDirectory, detectIdentityCollision } = await import("@mermaid/verification");
  const { PgPlaybookRepository } = await import("@mermaid/payer-profile");
  const directory = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

  // Seeded here rather than assumed — `payers` is filled at wiring time, not by a migration.
  await new PgPlaybookRepository().upsertPayer({
    slug: "delta-dental",
    name: "Delta Dental",
    filingWindowDays: 365,
    appealWindowDays: 180,
  });

  const a = await withPractice(pA, async () => {
    const patient = await directory.ensure(ada);
    await directory.linkCoverage(patient.id, `A-${crypto.randomUUID().slice(0, 8)}`, "delta-dental");
    return patient;
  });
  const b = await withPractice(pB, async () => {
    const patient = await directory.ensure(ada);
    await directory.linkCoverage(patient.id, `B-${crypto.randomUUID().slice(0, 8)}`, "delta-dental");
    return patient;
  });

  assert.notEqual(a.id, b.id, "the same person at two practices is two patient rows — that is the premise");

  const seenByA = await withPractice(pA, () => directory.coveragesFor(a.id));
  const seenByB = await withPractice(pB, () => directory.coveragesFor(b.id));
  assert.equal(seenByA.length, 1, "each practice sees exactly its own coverage");
  assert.equal(seenByB.length, 1);
  assert.notEqual(seenByA[0]!.memberId, seenByB[0]!.memberId);

  // Practice B's patient id is meaningless inside practice A — RLS answers empty rather than
  // forbidden, which is the correct answer for a caller who must not learn the row exists.
  assert.deepEqual(
    await withPractice(pA, () => directory.coveragesFor(b.id)),
    [],
    "a coverage belonging to another practice must not even be readable, let alone comparable"
  );

  /**
   * And therefore practice A's patient RETURNING ON THEIR OWN COVERAGE is not flagged.
   *
   * This is the assertion that proves the isolation matters rather than merely exists. Practice B
   * holds a row for the same name, the same date of birth and the same payer under a DIFFERENT
   * member ID — precisely the shape the detector fires on. If that row were visible inside practice
   * A, this returning patient would be flagged as a collision against a person at another clinic,
   * and the front desk would be asked to confirm an identity they have no way to see.
   */
  const collision = detectIdentityCollision(await withPractice(pA, () => directory.coveragesFor(a.id)), {
    memberId: seenByA[0]!.memberId,
    payerKey: "delta-dental",
  });
  assert.equal(
    collision,
    null,
    "a returning patient must stay clean — and does so only because the other practice's identical row is invisible"
  );
});
