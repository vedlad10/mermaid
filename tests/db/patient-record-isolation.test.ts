/**
 * A family shares one member id, so a member id may never be used to decide WHO a record belongs to.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `tests/db/dependents.test.ts` already proves the identity layer holds the line: two people on one
 * subscriber id stay two charts, two coverages, and `patientIdForMemberId` answers `null` rather
 * than guessing which of them money belongs to. All of that still works and none of it changed.
 *
 * What it did not cover is the READ path built on top of it. `buildPatientRecord` resolves a
 * person to every member id they hold and passes that set to the verification and ledger stores as
 * a scope. Both stores matched `patient_id = $1 OR <member id is in the set>` — an OR with no
 * condition on the second arm — so a row that NAMED a different patient was still claimed by
 * anyone sharing the policy. A parent's verification was returned inside their child's record, on
 * live data, with no tenant boundary crossed and nothing in the database violated.
 *
 * RLS could never have caught this: both people are legitimately in the same practice, so every row
 * is legitimately visible. It is an aggregation-key defect, not an isolation one.
 *
 * ── WHAT THESE TESTS PIN ─────────────────────────────────────────────────────────────────────────
 * Both halves, because fixing this one-sidedly is worse than not fixing it:
 *
 *   • a row that names its patient answers ONLY for that patient, and
 *   • a row whose `patient_id` never resolved is STILL returned for every key its owner holds —
 *     the legacy case the OR was written for, and the one a careless narrowing would silently drop.
 *
 * A person shown a balance that is too LOW because a row went invisible is the worse failure of the
 * two, which is why the second half is tested as hard as the first.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import {
  PgPatientDirectory,
  PgVerificationRepository,
  VerificationService,
  type VerificationInput,
} from "@mermaid/verification";
import { PgLedgerRepository } from "@mermaid/patient-ledger";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

const NOW = new Date("2026-08-26T12:00:00Z");
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

/** A member id unique to this run, so repeated runs against a shared database cannot collide. */
const policy = () => `FAM-${randomUUID().slice(0, 8).toUpperCase()}`;

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/**
 * The subscriber and her child, verified under the SAME member id at the SAME payer.
 *
 * Different dates of birth are what make them two people — the discriminator `deriveChartId` uses
 * and `dependents.test.ts` already proves. Everything else about them is deliberately identical,
 * because the defect this file exists for is invisible unless the member id matches.
 */
const visit = (first: string, dob: string, memberId: string): VerificationInput => ({
  patient: { firstName: first, lastName: "Alpha", dateOfBirth: dob, memberId, address: SYNTHETIC_ADDRESS },
  cardText: `Delta Dental\nMember ID: ${memberId}`,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
  ],
});

test("two people on one member id do not read each other's verifications", dbTest, async () => {
  const p = await practice("record-isolation-verifications");
  const memberId = policy();

  const { adaId, kitId, adaVerificationId, kitVerificationId } = await withPractice(p, async () => {
    const directory = new PgPatientDirectory();
    /**
     * The directory is wired in DELIBERATELY. It is what makes `create` resolve each visit to a
     * patient and stamp `patient_id` on the row — and a row that names its patient is the entire
     * subject of this test. Without it both verifications persist with a NULL `patient_id`, both
     * legitimately match the legacy member-id arm, and the test passes for the wrong reason.
     */
    const service = new VerificationService(
      new PgVerificationRepository(),
      new MockEdiAdapter(),
      new NullEventPublisher(),
      undefined,
      directory
    );

    const ada = await service.create(visit("Ada", "1990-04-12", memberId), NOW);
    const kit = await service.create(visit("Kit", "2016-09-03", memberId), NOW);

    const adaPatient = await directory.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
    const kitPatient = await directory.ensure({ firstName: "Kit", lastName: "Alpha", dateOfBirth: "2016-09-03" });

    return {
      adaId: adaPatient.id,
      kitId: kitPatient.id,
      adaVerificationId: ada.record.id,
      kitVerificationId: kit.record.id,
    };
  });

  assert.notEqual(adaId, kitId, "different dates of birth are different people");
  assert.notEqual(adaVerificationId, kitVerificationId);

  const repo = new PgVerificationRepository();

  // Each person is scoped exactly as `buildPatientRecord` scopes them: their own id, plus every
  // member id they hold — which here is the one they BOTH hold.
  const forAda = await withPractice(p, () => repo.list({ patient: { patientId: adaId, memberIds: [memberId] } }));
  const forKit = await withPractice(p, () => repo.list({ patient: { patientId: kitId, memberIds: [memberId] } }));

  assert.deepEqual(
    forAda.map((v) => v.id),
    [adaVerificationId],
    "the subscriber's record must hold her verification and ONLY hers — her child's is not hers to see"
  );
  assert.deepEqual(
    forKit.map((v) => v.id),
    [kitVerificationId],
    "and the child's record must not carry his mother's, which is the disclosure this prevents"
  );
});

test("two people on one member id do not read each other's money", dbTest, async () => {
  const p = await practice("record-isolation-ledger");
  const memberId = policy();

  const { adaId, kitId } = await withPractice(p, async () => {
    const directory = new PgPatientDirectory();
    const ada = await directory.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
    const kit = await directory.ensure({ firstName: "Kit", lastName: "Alpha", dateOfBirth: "2016-09-03" });
    await directory.linkCoverage(ada.id, memberId, "delta-dental");
    await directory.linkCoverage(kit.id, memberId, "delta-dental", {
      relationship: "child",
      subscriber: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
    });
    return { adaId: ada.id, kitId: kit.id };
  });

  const repo = new PgLedgerRepository();
  const entry = (patientId: string | null, name: string, amount: number, ref: string) => ({
    id: randomUUID(),
    patientKey: memberId,
    patientName: name,
    kind: "charge" as const,
    amount: cents(amount),
    occurredAt: NOW.toISOString(),
    description: `${name} owes ${amount}`,
    claimId: null,
    denialId: null,
    sourceRef: ref,
    recordedBy: "system",
    patientId,
  });

  await withPractice(p, async () => {
    await repo.append(entry(adaId, "Ada Alpha", 100, `iso-ada-${randomUUID()}`));
    await repo.append(entry(kitId, "Kit Alpha", 250, `iso-kit-${randomUUID()}`));
  });

  const adaEntries = await withPractice(p, () =>
    repo.list({ patient: { patientId: adaId, patientKeys: [memberId] } })
  );
  const kitEntries = await withPractice(p, () =>
    repo.list({ patient: { patientId: kitId, patientKeys: [memberId] } })
  );

  assert.deepEqual(
    adaEntries.map((e) => e.amount),
    [cents(100)],
    "the subscriber's balance is hers alone — her child's charge is not a line on her statement"
  );
  assert.deepEqual(
    kitEntries.map((e) => e.amount),
    [cents(250)],
    "and a payment against one of them can never reduce the other's balance"
  );
});

/**
 * ── THE HALF THAT MUST NOT REGRESS ───────────────────────────────────────────────────────────────
 *
 * The member-id arm exists for entries whose `patient_id` never resolved: money recorded before the
 * patient master existed, or taken against a key that maps to a family and therefore resolves to
 * `null` rather than to a guess. Those entries are still this person's money, and a unified balance
 * that silently drops them shows a patient a number that is too low — which is worse than showing
 * one that is too high, because nobody goes looking for it.
 */
test("an entry whose patient never resolved still belongs to everyone holding that key", dbTest, async () => {
  const p = await practice("record-isolation-legacy");
  const memberId = policy();

  const adaId = await withPractice(p, async () => {
    const directory = new PgPatientDirectory();
    const ada = await directory.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
    await directory.linkCoverage(ada.id, memberId, "delta-dental");
    return ada.id;
  });

  const repo = new PgLedgerRepository();
  await withPractice(p, () =>
    repo.append({
      id: randomUUID(),
      patientKey: memberId,
      patientName: "Ada Alpha",
      kind: "charge",
      amount: cents(75),
      occurredAt: NOW.toISOString(),
      description: "recorded before the patient master existed",
      claimId: null,
      denialId: null,
      sourceRef: `iso-legacy-${randomUUID()}`,
      recordedBy: "system",
      // The whole point: this row names no patient.
      patientId: null,
    })
  );

  const entries = await withPractice(p, () =>
    repo.list({ patient: { patientId: adaId, patientKeys: [memberId] } })
  );

  assert.deepEqual(
    entries.map((e) => e.amount),
    [cents(75)],
    "an unresolved entry must still reach the person who holds its key — narrowing the OR must not " +
      "cost a patient money that is demonstrably theirs"
  );
});
