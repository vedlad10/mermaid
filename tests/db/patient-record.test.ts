/**
 * M14 deliverable 4 — the unified patient record's READ PATHS, against a real database.
 *
 * ── WHY THIS NEEDS A DATABASE ──────────────────────────────────────────────────────────────────
 * `tests/vertical-patient-timeline.test.ts` already drives the assembled record over HTTP, and it
 * runs in memory. What it cannot prove is anything about SQL, and every one of the joins added for
 * this deliverable is a new WHERE clause:
 *
 *   • `verifications` matched by `patient_id` OR any of the patient's member IDs — a two-branch OR
 *     whose in-memory twin is a `||` in TypeScript. Those two have drifted before (the M10 `openOnly`
 *     divergence), and the consequence here is a patient's history that is complete on a laptop and
 *     missing rows in production.
 *   • `ledger_entries` matched by `patient_id` OR any account key. If this one under-matches, a
 *     patient is shown a balance that is too LOW — the worst direction for it to be wrong.
 *   • Empty-array semantics. `= ANY('{}')` is false for every row, which is the only safe reading of
 *     "claims under these member IDs" when there are none; a filter that quietly matched everything
 *     instead would be a cross-patient data leak wearing a filter's clothes.
 *
 * And one property that is not about SQL at all: the whole record must be invisible across practices.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import {
  PgPatientDirectory,
  PgVerificationRepository,
  VerificationService,
  deriveChartId,
} from "@mermaid/verification";
import { PgClaimRepository } from "@mermaid/claims";
import { PgLedgerRepository, PatientLedgerService } from "@mermaid/patient-ledger";
import { cents } from "@mermaid/shared";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
const NOW = new Date("2026-08-03T12:00:00Z");

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

const ADA = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

const visit = (memberId: string, payer: string) => ({
  patient: { ...ADA, memberId },
  cardText: `${payer}\nMember ID: ${memberId}`,
  planItems: [{ code: "D0120", quantity: 1 }],
});

/** A verification service on the real repositories, wired exactly as the composition root does. */
function services() {
  const patients = new PgPatientDirectory();
  const verification = new VerificationService(
    new PgVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );
  return { patients, verification };
}

/**
 * Run one unit of work in its own practice-scoped transaction.
 *
 * ── ONE TRANSACTION PER OPERATION, NOT ONE PER TEST ────────────────────────────────────────────
 * This mirrors the app, where `withPractice` wraps a REQUEST. It also matters mechanically: a
 * managed Postgres sets `idle_in_transaction_session_timeout`, and a test that ran two verification
 * pipelines inside one transaction — each several round trips against a remote instance — sat idle
 * long enough to be terminated with `25P03`. That is the database behaving correctly and the test
 * behaving unlike the thing it is testing.
 *
 * Repositories read the ambient transaction, so they are constructed INSIDE the callback; one built
 * outside would be bound to whichever transaction happened to be open when it was made.
 */
const inPractice = <T>(practiceId: string, fn: (s: ReturnType<typeof services>) => Promise<T>): Promise<T> =>
  withPractice(practiceId, () => fn(services()));

/** Verify one patient under one member ID — one request, one transaction. */
const verifyOnce = (practiceId: string, memberId: string, payer: string) =>
  inPractice(practiceId, ({ verification }) => verification.create(visit(memberId, payer), NOW));

// ── The patient master ────────────────────────────────────────────────────────────────

test("a verification writes verifications.patient_id — the column 0006 has been waiting for", dbTest, async () => {
  const practiceId = await practice("record-link");

  const view = await verifyOnce(practiceId, "MET30001", "MetLife Dental");

  await inPractice(practiceId, async ({ patients }) => {
    const ada = await patients.findByChartId(deriveChartId(ADA));
    assert.ok(ada, "the patient master was written");

    // Read the COLUMN, not the document: the whole point is that the link is a queryable column, and
    // a record whose JSONB says one thing while the column says another is the drift to catch here.
    const { rows } = await requireContext().tx.query(
      "SELECT patient_id FROM verifications WHERE id = $1",
      [view.record.id]
    );
    assert.equal((rows[0] as { patient_id: string | null }).patient_id, ada!.id);
  });
});

test("the directory finds a person by name or chart id, and matches nothing when nothing matches", dbTest, async () => {
  const practiceId = await practice("record-directory");

  await verifyOnce(practiceId, "MET30001", "MetLife Dental");

  await inPractice(practiceId, async ({ patients }) => {
    assert.equal((await patients.list("alpha")).length, 1, "surname, case-insensitively");
    assert.equal((await patients.list("Ada")).length, 1, "given name");
    assert.equal((await patients.list(deriveChartId(ADA))).length, 1, "chart id");
    assert.equal((await patients.list("nobodyhere")).length, 0);

    // A wildcard in the query is a literal, not a pattern: otherwise a search box is a way to ask for
    // every row in the table, which is a full scan dressed up as a search.
    assert.equal((await patients.list("%")).length, 0, "the caller does not get to supply wildcards");
  });
});

test("one human's member IDs come back from coverages, both of them", dbTest, async () => {
  const practiceId = await practice("record-members");

  await verifyOnce(practiceId, "MET30001", "MetLife Dental");
  // A year later: same person, new employer, new member ID. A SEPARATE request, as it would be.
  await verifyOnce(practiceId, "ABC12345", "Delta Dental");

  await inPractice(practiceId, async ({ patients }) => {
    const ada = (await patients.list())[0]!;
    assert.deepEqual(await patients.memberIdsFor(ada.id), ["ABC12345", "MET30001"]);
  });
});

// ── The filters the record is assembled from ──────────────────────────────────────────

test("verifications resolve by patient_id OR member ID — pre-M14 rows do not vanish", dbTest, async () => {
  const practiceId = await practice("record-verifications");

  const linked = await verifyOnce(practiceId, "MET30001", "MetLife Dental");
  const legacy = await verifyOnce(practiceId, "ABC12345", "Delta Dental");

  /**
   * A verification written before the patient master existed: `patient_id` NULL, member ID only.
   * Simulated by nulling the column, which is exactly the state every historical row is in.
   * Pretending those verifications never happened would make the record LESS trustworthy than the
   * queue it was assembled from.
   */
  await withPractice(practiceId, async () => {
    await requireContext().tx.query("UPDATE verifications SET patient_id = NULL WHERE id = $1", [
      legacy.record.id,
    ]);
  });

  await inPractice(practiceId, async ({ patients }) => {
    const ada = (await patients.list())[0]!;
    const found = await new PgVerificationRepository().list({
      patient: { patientId: ada.id, memberIds: await patients.memberIdsFor(ada.id) },
    });
    const ids = found.map((r) => r.id).sort();
    assert.deepEqual(ids, [linked.record.id, legacy.record.id].sort(), "both branches of the OR");
  });
});

test("an empty member-ID list matches nothing, in every repository", dbTest, async () => {
  const practiceId = await practice("record-empty");

  await verifyOnce(practiceId, "MET30001", "MetLife Dental");

  await withPractice(practiceId, async () => {
    /**
     * The dangerous direction. `= ANY('{}')` is false for every row; a filter that instead ignored an
     * empty list and returned EVERYTHING would hand one patient's screen another patient's claims.
     * A patient with no coverage on file is a real state — this is what it must produce.
     */
    assert.deepEqual(await new PgClaimRepository().list({ memberIds: [] }), []);
    assert.deepEqual(
      await new PgLedgerRepository().list({ patient: { patientId: crypto.randomUUID(), patientKeys: [] } }),
      []
    );
  });
});

test("the unified balance spans every account key, including one that never resolved", dbTest, async () => {
  const practiceId = await practice("record-balance");

  await verifyOnce(practiceId, "MET30001", "MetLife Dental");
  await verifyOnce(practiceId, "ABC12345", "Delta Dental");

  await inPractice(practiceId, async ({ patients }) => {
    const ada = (await patients.list())[0]!;

    const ledgerRepo = new PgLedgerRepository();
    const ledger = new PatientLedgerService(ledgerRepo, undefined, {
      byMemberId: (memberId: string) => patients.patientIdForMemberId(memberId),
    });

    // The acceptance criterion, stated in the milestone: 12,500 − 5,000 under one plan plus 8,000
    // under another is ONE person and ONE number.
    await ledger.chargeFromPosting(posting("MET30001", 12_500, "a"), NOW);
    await ledger.recordPayment("MET30001", { amount: cents(50), recordedBy: "front.desk@clinic" }, NOW);
    await ledger.chargeFromPosting(posting("ABC12345", 8_000, "b"), NOW);

    const unified = await ledger.unifiedStatement(
      { patientId: ada.id, patientKeys: await patients.memberIdsFor(ada.id) },
      NOW
    );
    assert.equal(unified!.account.balance, 15_500, "7500 + 8000 — one person, across two plans");
    assert.equal(unified!.entries.length, 3);

    /**
     * …and the per-ACCOUNT statement is untouched. The unified view is a NEW query alongside the old
     * one, never a redefinition of it — the property migration 0015 was built around, and the reason
     * no balance anywhere could move because of M14.
     */
    const account = await ledger.statement("MET30001", NOW);
    assert.equal(account!.account.balance, 7_500, "the member-ID account still answers as it always did");
  });
});

test("a legacy account key that never resolved is still part of the person's balance", dbTest, async () => {
  const practiceId = await practice("record-legacy");

  await verifyOnce(practiceId, "MET30001", "MetLife Dental");

  await inPractice(practiceId, async ({ patients }) => {
    const ada = (await patients.list())[0]!;

    const ledger = new PatientLedgerService(new PgLedgerRepository(), undefined, {
      byMemberId: (memberId: string) => patients.patientIdForMemberId(memberId),
    });
    await ledger.chargeFromPosting(posting("MET30001", 10_000, "resolved"), NOW);
    // No coverage on file for this key, so `patient_id` stays NULL — legitimate, and never a reason
    // to refuse the money. It is still this person's money if the caller says the key is theirs.
    await ledger.chargeFromPosting(posting("LEGACY-KEY", 2_500, "unresolved"), NOW);

    const unified = await ledger.unifiedStatement(
      { patientId: ada.id, patientKeys: ["MET30001", "LEGACY-KEY"] },
      NOW
    );
    assert.equal(unified!.account.balance, 12_500, "a balance shown too LOW is the worse failure");
  });
});

// ── Tenancy ───────────────────────────────────────────────────────────────────────────

test("one practice's patient record is invisible to another, id in hand", dbTest, async () => {
  const [a, b] = [await practice("record-iso-a"), await practice("record-iso-b")];

  await verifyOnce(a, "MET30001", "MetLife Dental");
  const adaId = await inPractice(a, async ({ patients }) => (await patients.list())[0]!.id);

  await withPractice(b, async () => {
    const patients = new PgPatientDirectory();
    // The id is not a capability. RLS makes the row invisible rather than forbidden, which is the
    // correct answer for a caller who must not learn that it exists.
    assert.equal(await patients.findById(adaId), null);
    assert.deepEqual(await patients.memberIdsFor(adaId), []);
    assert.deepEqual(await patients.list("alpha"), []);
  });
});

/** A `remittance.posted` payload carrying what the payer left the patient. */
function posting(memberId: string, patientResponsibility: number, ref: string) {
  return {
    remittanceId: crypto.randomUUID(),
    postingId: crypto.randomUUID(),
    claimId: crypto.randomUUID(),
    patientControlNumber: `MRM-${ref}`,
    postedAt: NOW.toISOString(),
    traceNumber: `TRACE-${ref}`,
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    patientName: "Ada Alpha",
    memberId,
    paymentDate: "2026-08-03",
    chargedAmount: cents(0),
    paidAmount: cents(0),
    patientResponsibility: patientResponsibility as never,
    contractualAdjustments: cents(0),
    expectedInsurancePays: cents(0),
    variance: cents(0),
    outcome: "as_expected",
    settled: true,
  } as never;
}
