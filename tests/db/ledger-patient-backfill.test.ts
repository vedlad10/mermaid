/**
 * M14 part 2 — the ledger backfill, proven against a real database.
 *
 * ── WHY THIS FILE IS THE ACCEPTANCE CRITERION ──────────────────────────────────────────────────
 * This is the change that touches balances a patient can be billed for. The unified architecture
 * calls it the highest-risk item in the M11–M15 plan (risk R6) and requires acceptance "by comparing
 * every account balance before and after", not by inspection. This file is that comparison.
 *
 * It drives the SAME functions `platform/db/backfill-ledger-patients.mjs` runs, imported rather than
 * retyped. A backfill verified by a test containing its own separate copy of the UPDATE proves the
 * test's SQL is safe and says nothing about the script's — the exact trap the M10 `openOnly` drift
 * sprang.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { deriveChartId } from "@mermaid/verification";
import { balances, diffBalances, linkForPractice } from "../../platform/db/backfill-ledger-patients.mjs";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

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

const ADA = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

/** Ada, with two member IDs across two employers — and money owed under each. */
async function seedLegacyLedger(practiceId: string) {
  return withPractice(practiceId, async () => {
    const tx = requireContext().tx;

    const { rows: patientRows } = await tx.query(
      `INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [practiceId, deriveChartId(ADA), ADA.firstName, ADA.lastName, ADA.dateOfBirth]
    );
    const patientId = (patientRows[0] as { id: string }).id;

    // Both member IDs belong to the same human — an old plan and a current one.
    for (const memberId of ["MET30001", "DD99999"]) {
      await tx.query(
        "INSERT INTO coverages (practice_id, patient_id, member_id) VALUES ($1,$2,$3)",
        [practiceId, patientId, memberId]
      );
    }

    // Ledger entries written the pre-M14 way: patient_id NULL, keyed only on the member ID.
    const entries = [
      { key: "MET30001", kind: "charge", cents: 12_500, ref: "posting:a" },
      { key: "MET30001", kind: "payment", cents: -5_000, ref: null },
      { key: "DD99999", kind: "charge", cents: 8_000, ref: "posting:b" },
      // A member ID with no coverage on file — legitimate, and must survive unresolved.
      { key: "LEGACY-KEY", kind: "charge", cents: 2_500, ref: "posting:c" },
    ];
    for (const [i, e] of entries.entries()) {
      await tx.query(
        `INSERT INTO ledger_entries
           (id, practice_id, patient_key, patient_name, kind, amount_cents, occurred_at,
            description, claim_id, denial_id, source_ref, recorded_by)
         VALUES (gen_random_uuid(),$1,$2,'Ada Alpha',$3,$4,$5,'seeded',NULL,NULL,$6,'system')`,
        [practiceId, e.key, e.kind, e.cents, new Date(Date.UTC(2026, 5, i + 1)).toISOString(), e.ref]
      );
    }

    return patientId;
  });
}

test("the backfill links entries to their patient and NO balance moves", dbTest, async () => {
  const practiceId = await practice("m14-backfill");
  const patientId = await seedLegacyLedger(practiceId);

  await withPractice(practiceId, async () => {
    const tx = requireContext().tx;

    // ── BEFORE ────────────────────────────────────────────────────────────────────────────────
    const before = await balances(tx, practiceId);
    assert.equal(before.size, 3, "three member-ID accounts before the backfill");
    assert.equal(before.get("MET30001")!.balance, "7500", "12500 charged less 5000 paid");
    assert.equal(before.get("DD99999")!.balance, "8000");
    assert.equal(before.get("LEGACY-KEY")!.balance, "2500");

    // ── BACKFILL ──────────────────────────────────────────────────────────────────────────────
    const { linked, unresolved } = await linkForPractice(tx, practiceId);
    assert.equal(linked, 3, "three entries had a coverage on file");
    assert.equal(unresolved, 1, "the legacy key has no coverage and stays unresolved");

    // ── AFTER: the criterion the whole milestone is gated on ──────────────────────────────────
    const after = await balances(tx, practiceId);
    assert.deepEqual(
      diffBalances(before, after),
      [],
      "FINANCIAL INTEGRITY: not one account balance may change. This is the acceptance criterion."
    );

    // …and the account keys themselves are untouched, so every existing query still works.
    assert.deepEqual([...after.keys()].sort(), ["DD99999", "LEGACY-KEY", "MET30001"]);

    // ── THE CAPABILITY THIS BUYS ──────────────────────────────────────────────────────────────
    // One human, two member IDs, ONE balance — which `patient_key` alone can never produce.
    const { rows } = await tx.query(
      `SELECT sum(amount_cents)::bigint AS balance, count(*)::int AS entries
         FROM ledger_entries WHERE practice_id = $1 AND patient_id = $2`,
      [practiceId, patientId]
    );
    // Coerced explicitly: a BIGINT sum arrives as a string from a bare pg client and as a number
    // through the app pool's type parser. `balances()` normalises for exactly this reason, and the
    // before/after comparison is unaffected because both snapshots come from it; this ad-hoc query
    // does not, so it says what it means about the value rather than about its representation.
    const unified = rows[0] as { balance: string | number; entries: number };
    assert.equal(Number(unified.balance), 15_500, "7500 + 8000 — one person, one number, across two plans");
    assert.equal(unified.entries, 3);
  });
});

test("the backfill is idempotent — a second run changes nothing", dbTest, async () => {
  const practiceId = await practice("m14-idempotent");
  await seedLegacyLedger(practiceId);

  await withPractice(practiceId, async () => {
    const tx = requireContext().tx;
    const first = await linkForPractice(tx, practiceId);
    const afterFirst = await balances(tx, practiceId);

    const second = await linkForPractice(tx, practiceId);
    const afterSecond = await balances(tx, practiceId);

    assert.equal(first.linked, 3);
    assert.equal(second.linked, 0, "nothing left to link — only NULL rows are considered");
    assert.deepEqual(diffBalances(afterFirst, afterSecond), [], "and still no balance moves");
  });
});

test("the backfill is reversible — rollback restores the pre-migration state exactly", dbTest, async () => {
  const practiceId = await practice("m14-rollback");
  await seedLegacyLedger(practiceId);

  await withPractice(practiceId, async () => {
    const tx = requireContext().tx;
    const original = await balances(tx, practiceId);

    await linkForPractice(tx, practiceId);
    // The documented rollback (`--rollback`): nothing depends on the column being populated.
    await tx.query("UPDATE ledger_entries SET patient_id = NULL WHERE practice_id = $1", [practiceId]);

    const restored = await balances(tx, practiceId);
    assert.deepEqual(diffBalances(original, restored), [], "balances identical after a full round trip");

    const { rows } = await tx.query(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE practice_id = $1 AND patient_id IS NOT NULL",
      [practiceId]
    );
    assert.equal((rows[0] as { n: number }).n, 0, "every link cleared — the table is exactly as it was");
  });
});

test("an unresolved entry keeps working — its account is still its member ID", dbTest, async () => {
  const practiceId = await practice("m14-unresolved");
  await seedLegacyLedger(practiceId);

  await withPractice(practiceId, async () => {
    const tx = requireContext().tx;
    await linkForPractice(tx, practiceId);

    const after = await balances(tx, practiceId);
    assert.equal(
      after.get("LEGACY-KEY")!.balance,
      "2500",
      "money we cannot attribute to a person is still money the patient owes — never dropped"
    );

    const { rows } = await tx.query(
      "SELECT patient_id FROM ledger_entries WHERE practice_id = $1 AND patient_key = 'LEGACY-KEY'",
      [practiceId]
    );
    assert.equal((rows[0] as { patient_id: string | null }).patient_id, null, "null is a legitimate outcome");
  });
});

test("the backfill never crosses a tenant — one practice's coverage cannot claim another's money", dbTest, async () => {
  const mine = await practice("m14-tenant-a");
  const theirs = await practice("m14-tenant-b");
  await seedLegacyLedger(mine);

  // The other practice has a coverage for the SAME member ID, belonging to a different person.
  await withPractice(theirs, async () => {
    const tx = requireContext().tx;
    const { rows } = await tx.query(
      `INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob)
       VALUES ($1,'MRM-OTHER','Bea','Beta','1988-02-02') RETURNING id`,
      [theirs]
    );
    await tx.query("INSERT INTO coverages (practice_id, patient_id, member_id) VALUES ($1,$2,'MET30001')", [
      theirs,
      (rows[0] as { id: string }).id,
    ]);
  });

  await withPractice(mine, async () => {
    const tx = requireContext().tx;
    await linkForPractice(tx, mine);

    const { rows } = await tx.query(
      `SELECT DISTINCT p.last_name FROM ledger_entries le
         JOIN patients p ON p.id = le.patient_id
        WHERE le.practice_id = $1`,
      [mine]
    );
    const names = rows.map((r) => (r as { last_name: string }).last_name);
    assert.deepEqual(names, ["Alpha"], "only this practice's own patient may be linked to its money");
  });
});
