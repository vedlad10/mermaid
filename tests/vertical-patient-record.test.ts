
/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

/**
 * The Unified Patient Financial Record.
 *
 * The unified RCM workflow's central node is `B[("Unified Patient Financial Record")]`, with
 * `-.same record.->` edges to claim creation and to posting. It is the diagram's structural centre,
 * and until M14 it did not exist: `patients` was created by migration 0005 and written only by a
 * test fixture, while accounts were keyed on the member ID the claim was filed under.
 *
 * That interim was the right call at M9 — inventing a second identity would have been worse than
 * using the one the money already carries — but it has a ceiling, and this file asserts the property
 * that raising it is for: **one human is one record**, however many times they arrive and however
 * many coverages they hold over the years.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import {
  InMemoryPatientDirectory,
  InMemoryVerificationRepository,
  VerificationService,
  deriveChartId,
} from "@mermaid/verification";
import { InMemoryLedgerRepository, PatientLedgerService } from "@mermaid/patient-ledger";
import { cents } from "@mermaid/shared";

const VISIT_DAY = new Date("2026-07-27T12:00:00Z");
const silent = createLogger(() => {});

function frontDesk() {
  const patients = new InMemoryPatientDirectory();
  const verification = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    new InMemoryOutbox({ logger: silent, metrics: createMetrics() }),
    undefined,
    patients
  );
  return { patients, verification };
}

const visit = (patient: { firstName: string; lastName: string; dateOfBirth: string }, memberId: string, payer: string) => ({
  patient: { ...patient, memberId, address: SYNTHETIC_ADDRESS },
  cardText: `${payer}\nMember ID: ${memberId}`,
  planItems: [{ code: "D0120", quantity: 1 }],
});

/** A `remittance.posted` payload carrying what the payer left the patient. */
const posting = (memberId: string, patientResponsibility: number, sourceRef: string) =>
  ({
    remittanceId: crypto.randomUUID(),
    postingId: sourceRef.replace("posting:", ""),
    claimId: crypto.randomUUID(),
    patientControlNumber: "MRM-TEST",
    postedAt: VISIT_DAY.toISOString(),
    traceNumber: sourceRef,
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    patientName: "Ada Alpha",
    memberId,
    paymentDate: "2026-07-27",
    chargedAmount: cents(0),
    paidAmount: cents(0),
    patientResponsibility: patientResponsibility as never,
    contractualAdjustments: cents(0),
    expectedInsurancePays: cents(0),
    variance: cents(0),
    outcome: "as_expected",
    settled: true,
  }) as never;

const ADA = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

test("one human, two coverages, ONE patient record", async () => {
  const { patients, verification } = frontDesk();

  await verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);
  // A year later: same person, new employer, new payer, new member ID.
  await verification.create(visit(ADA, "DD99999", "Delta Dental"), VISIT_DAY);

  const all = await patients.list();
  assert.equal(all.length, 1, "a member-ID change must not orphan a patient into a second record");
  assert.equal(all[0]!.chartId, deriveChartId(ADA));
  assert.equal(all[0]!.firstName, "Ada");
});

test("the same person typed differently still resolves to one record", async () => {
  const { patients, verification } = frontDesk();

  await verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);
  await verification.create(
    visit({ firstName: "  ada ", lastName: "ALPHA", dateOfBirth: "1990-04-12" }, "MET30002", "MetLife Dental"),
    VISIT_DAY
  );

  assert.equal((await patients.list()).length, 1, "case and stray whitespace are not a different human");
});

test("two different people are two records", async () => {
  const { patients, verification } = frontDesk();

  await verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);
  await verification.create(
    visit({ firstName: "Bea", lastName: "Beta", dateOfBirth: "1988-02-02" }, "DD40001", "Delta Dental"),
    VISIT_DAY
  );

  assert.equal((await patients.list()).length, 2);
});

test("a patient exists whatever the verification concluded", async () => {
  const { patients, verification } = frontDesk();

  // An unreadable card: no payer identified, nothing settles. The practice has still seen this
  // person, and the front desk will look for them by name tomorrow.
  const failed = await verification.create(
    visit({ firstName: "Cora", lastName: "Gamma", dateOfBirth: "1975-09-09" }, "???", "smudged illegible card"),
    VISIT_DAY
  );

  assert.notEqual(failed.record.status, "verified", "the fixture must genuinely be an unsettled verification");
  assert.equal((await patients.list()).length, 1, "a patient is not conditional on their coverage being verifiable");
});

test("the record is created without changing what the verification returns", async () => {
  // M14 must be additive: the existing view, its status and its confidence are untouched, or every
  // screen and every downstream consumer would have to be re-verified.
  const withDirectory = frontDesk();
  const withoutDirectory = {
    verification: new VerificationService(
      new InMemoryVerificationRepository(),
      new MockEdiAdapter(),
      new InMemoryOutbox({ logger: silent, metrics: createMetrics() })
    ),
  };

  const a = await withDirectory.verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);
  const b = await withoutDirectory.verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);

  assert.equal(a.record.status, b.record.status);
  assert.equal(a.record.confidence.overall, b.record.confidence.overall);
  assert.deepEqual(
    a.record.confidence.components.map((c) => c.name),
    b.record.confidence.components.map((c) => c.name)
  );
});

// ── The ledger learns whose money it is (M14 part 2) ───────────────────────────────────────────

test("a new ledger entry carries the patient id, resolved through the coverage", async () => {
  const { patients, verification } = frontDesk();
  const ledgerRepo = new InMemoryLedgerRepository();
  const ledger = new PatientLedgerService(ledgerRepo, undefined, {
    byMemberId: (memberId: string) => patients.patientIdForMemberId(memberId),
  });

  // Ada is verified under two plans — the verification is what ties each member ID to her.
  await verification.create(visit(ADA, "MET30001", "MetLife Dental"), VISIT_DAY);
  await verification.create(visit(ADA, "DD99999", "Delta Dental"), VISIT_DAY);
  const ada = (await patients.list())[0]!;

  // The cycle charging the patient what the payer left them — the path that creates an account.
  await ledger.chargeFromPosting(posting("MET30001", 12_500, "posting:a"), VISIT_DAY);
  await ledger.chargeFromPosting(posting("DD99999", 8_000, "posting:b"), VISIT_DAY);
  // …and a payment taken at the front desk against one of them.
  await ledger.recordPayment("MET30001", { amount: cents(50), recordedBy: "front.desk@clinic" }, VISIT_DAY);

  const met = await ledgerRepo.entriesFor("MET30001");
  const delta = await ledgerRepo.entriesFor("DD99999");
  assert.equal(met.length, 2, "a charge and a payment");
  for (const entry of [...met, ...delta]) {
    assert.equal(entry.patientId, ada.id, "every movement knows whose money it is, cycle-driven or human");
  }
});

test("an unresolvable member ID still records the money — a null is not a refusal", async () => {
  const { patients } = frontDesk();
  const ledgerRepo = new InMemoryLedgerRepository();
  const ledger = new PatientLedgerService(ledgerRepo, undefined, {
    byMemberId: (memberId: string) => patients.patientIdForMemberId(memberId),
  });

  // No verification, so no coverage on file. The money must still be recordable.
  await ledger.chargeFromPosting(posting("LEGACY-KEY", 2_500, "posting:legacy"), VISIT_DAY);

  const entries = await ledgerRepo.entriesFor("LEGACY-KEY");
  assert.equal(entries.length, 1, "turning 'we cannot tell who this is' into refused money would be worse");
  assert.equal(entries[0]!.patientId, null, "null is a legitimate outcome, not a failure");
});
