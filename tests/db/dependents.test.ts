/**
 * A family shares one member id — and the database must stop merging them into one person (NEW-01).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `coverages` carried `UNIQUE (practice_id, member_id)` and `linkCoverage` wrote
 * `ON CONFLICT (practice_id, member_id) DO UPDATE SET patient_id = EXCLUDED.patient_id`.
 *
 * A dental plan issues ONE member id to the subscriber and covers the spouse and children under it,
 * so verifying a second family member did not add a coverage row — it RE-POINTED the existing one
 * at the new patient. Nothing was loud, because nothing was violated: the index was satisfied at
 * every step. What followed is that `patientIdForMemberId`, the mapping the patient ledger resolves
 * money through, answered with whichever family member walked in most recently. Two children's
 * balances became one child's, and the row that said otherwise had been overwritten in place.
 *
 * These tests use the real Postgres directory against the real constraint. An in-memory double
 * could be made to agree with either behaviour; only the database settles what the index does.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { PgPatientDirectory } from "@mermaid/verification";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";
import { findFamilies, restore } from "../../platform/db/backfill-dependents.mjs";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

/** A member id unique to this run, so repeated runs against a shared database cannot collide. */
const policy = () => `FAM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

test("two patients on ONE member id stay two coverages, two people, two records", dbTest, async () => {
  const p = await practice("dependents");
  const memberId = policy();

  await withPractice(p, async () => {
    const directory = new PgPatientDirectory();

    // Ada holds the policy. Kit is her son, verified under the same member id — same surname, same
    // practice, DIFFERENT date of birth, which is what makes them two people.
    const ada = await directory.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
    const kit = await directory.ensure({ firstName: "Kit", lastName: "Alpha", dateOfBirth: "2016-09-03" });
    assert.notEqual(ada.id, kit.id, "different dates of birth are different people, by chart id");

    await directory.linkCoverage(ada.id, memberId, "delta-dental");
    await directory.linkCoverage(kit.id, memberId, "delta-dental", {
      relationship: "child",
      subscriber: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
    });

    // ── The row that used to be stolen ────────────────────────────────────────────────────────
    const adaCoverages = await directory.coveragesFor(ada.id);
    const kitCoverages = await directory.coveragesFor(kit.id);

    assert.deepEqual(
      adaCoverages,
      [{ memberId, payerKey: "delta-dental", relationship: "self" }],
      "the subscriber must still hold her own coverage after her child is verified under it"
    );
    assert.deepEqual(kitCoverages, [
      {
        memberId,
        payerKey: "delta-dental",
        relationship: "child",
        subscriber: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
      },
    ]);

    // ── And the money mapping refuses to guess ────────────────────────────────────────────────
    assert.deepEqual(
      (await directory.patientIdsForMemberId(memberId)).sort(),
      [ada.id, kit.id].sort(),
      "the member id belongs to both of them, and the honest answer says so"
    );
    assert.equal(
      await directory.patientIdForMemberId(memberId),
      null,
      "asked for ONE patient it must answer null, not an arbitrary family member. The ledger " +
        "leaves an entry unlinked on null; money attached to the wrong sibling is not recoverable."
    );
  });
});

test("re-verifying the SAME person is still idempotent, and never demotes a dependent", dbTest, async () => {
  /**
   * The property the old constraint was protecting, which must survive the fix: a repeat visit
   * updates in place rather than accumulating rows. And the new asymmetry — a later visit that did
   * not re-read the card must not quietly turn a known child back into the policy holder, which
   * would put the wrong name in loop 2010BA of the next claim.
   */
  const p = await practice("dependents-idempotent");
  const memberId = policy();

  await withPractice(p, async () => {
    const directory = new PgPatientDirectory();
    const kit = await directory.ensure({ firstName: "Kit", lastName: "Beta", dateOfBirth: "2016-09-03" });

    await directory.linkCoverage(kit.id, memberId, "delta-dental", {
      relationship: "child",
      subscriber: { firstName: "Ada", lastName: "Beta" },
    });
    // A second visit that knew nothing but the member id.
    await directory.linkCoverage(kit.id, memberId);

    const coverages = await directory.coveragesFor(kit.id);
    assert.equal(coverages.length, 1, "one person, one coverage per member id");
    assert.equal(coverages[0]!.relationship, "child", "silence must not demote a known dependent");
    assert.equal(coverages[0]!.payerKey, "delta-dental", "nor erase the payer — the same rule");
    assert.deepEqual(coverages[0]!.subscriber, { firstName: "Ada", lastName: "Beta" });
  });
});

test("one person may not hold the same member id twice — the uniqueness that IS true", dbTest, async () => {
  /**
   * Widening the index must not have removed uniqueness altogether. The old one said "one member id,
   * one person" and merged families; the new one says "one member id, one person, one row", which
   * is what stops a repeat visit accumulating duplicates that would double every balance query.
   */
  const p = await practice("dependents-unique");
  const memberId = policy();

  await withPractice(p, async () => {
    const directory = new PgPatientDirectory();
    const ada = await directory.ensure({ firstName: "Ada", lastName: "Gamma", dateOfBirth: "1990-04-12" });
    await directory.linkCoverage(ada.id, memberId, "delta-dental");

    await assert.rejects(
      requireContext().tx.query(
        "INSERT INTO coverages (practice_id, patient_id, member_id) VALUES ($1,$2,$3)",
        [p, ada.id, memberId]
      ),
      /uq_coverages_practice_member_patient|duplicate key/i,
      "the database itself must refuse a second row for the same person on the same policy"
    );
  });
});

test("the constraint is per PRACTICE — two clinics may both know the same member id", dbTest, async () => {
  const a = await practice("dependents-tenant-a");
  const b = await practice("dependents-tenant-b");
  const memberId = policy();

  const adaA = await withPractice(a, async () => {
    const d = new PgPatientDirectory();
    const ada = await d.ensure({ firstName: "Ada", lastName: "Delta", dateOfBirth: "1990-04-12" });
    await d.linkCoverage(ada.id, memberId, "delta-dental");
    return ada.id;
  });

  await withPractice(b, async () => {
    const d = new PgPatientDirectory();
    const ada = await d.ensure({ firstName: "Ada", lastName: "Delta", dateOfBirth: "1990-04-12" });
    await d.linkCoverage(ada.id, memberId, "delta-dental");
    assert.equal(
      await d.patientIdForMemberId(memberId),
      ada.id,
      "practice B resolves its OWN patient — a member id shared across tenants is not ambiguity"
    );
    assert.notEqual(ada.id, adaA, "and they are different rows, RLS-separated");
  });
});

test("the backfill reconstructs a family the old constraint collapsed", dbTest, async () => {
  /**
   * The recovery path. `coverages` cannot show what was lost — the row was updated in place — but
   * `verifications` recorded a patient_id and a member_id per visit and was never subject to the
   * constraint. This stages exactly the wreckage the old code left (two verifications, ONE coverage
   * row) and drives the real backfill functions over it.
   */
  const p = await practice("dependents-backfill");
  const memberId = policy();

  const { adaId, kitId } = await withPractice(p, async () => {
    const d = new PgPatientDirectory();
    const ada = await d.ensure({ firstName: "Ada", lastName: "Epsilon", dateOfBirth: "1990-04-12" });
    const kit = await d.ensure({ firstName: "Kit", lastName: "Epsilon", dateOfBirth: "2016-09-03" });

    // Both were verified under the one policy…
    for (const patientId of [ada.id, kit.id]) {
      await requireContext().tx.query(
        `INSERT INTO verifications
           (id, practice_id, patient_id, status, payer_id, member_id,
            patient_first_name, patient_last_name, record, created_at)
         VALUES ($1,$2,$3,'verified','delta-dental',$4,'x','Epsilon',
                 '{"snapshot_version":1}'::jsonb, now())`,
        [crypto.randomUUID(), p, patientId, memberId]
      );
    }
    // …and the old constraint left exactly ONE coverage row, pointing at whoever came last.
    await d.linkCoverage(kit.id, memberId, "delta-dental");
    return { adaId: ada.id, kitId: kit.id };
  });

  /**
   * The backfill functions take a `Queryable` and scope every statement by practice_id explicitly,
   * because the real script runs under the ADMIN role where there is no tenant context to rely on.
   * Driving them through the pooled transaction here proves the same SQL, and RLS narrows the sweep
   * to this practice — which is stricter than production, not weaker.
   */
  const families = await withPractice(p, () => findFamilies(requireContext().tx));
  const family = families.find((f: { memberId: string }) => f.memberId === memberId);
  assert.ok(family, "a member id verified for two patients is exactly what a collapsed family is");
  assert.deepEqual(family!.missing, [adaId], "and the subscriber's own link is the one that was lost");

  await withPractice(p, async () => {
    const written = await restore(requireContext().tx, { practiceId: p, memberId, patientId: adaId });
    assert.equal(written, 1);

    const d = new PgPatientDirectory();
    assert.deepEqual(
      (await d.patientIdsForMemberId(memberId)).sort(),
      [adaId, kitId].sort(),
      "both people hold the policy again"
    );
    assert.equal(
      (await d.coveragesFor(adaId))[0]!.relationship,
      "self",
      "restored as self — a verification recorded no relationship, and inventing one would put a " +
        "fabricated fact on a claim. The scrubber asks for the real one when a claim is filed."
    );
  });

  // Idempotent: a second run finds the link already there and writes nothing.
  await withPractice(p, async () => {
    assert.equal(await restore(requireContext().tx, { practiceId: p, memberId, patientId: adaId }), 0);
  });
});
