/**
 * NEW-01 — reconstruct the coverage rows the old unique constraint destroyed.
 *
 * ── WHAT WAS LOST, AND WHY A BACKFILL IS NEEDED AT ALL ───────────────────────────────────────────
 * Until migration 0021, `coverages` carried `UNIQUE (practice_id, member_id)` and `linkCoverage`
 * wrote `ON CONFLICT (practice_id, member_id) DO UPDATE SET patient_id = EXCLUDED.patient_id`.
 *
 * A dental plan issues ONE member id to the subscriber and covers the spouse and children under it,
 * so the second family member verified did not add a coverage — it took over the first one. The row
 * was updated IN PLACE. There is no history: the practice's own record that the first child held
 * that member id was overwritten by the fact that the second one does.
 *
 * Migration 0021 stops it happening again. It cannot undo what already happened, because the
 * evidence is not in `coverages` any more.
 *
 * ── WHERE THE EVIDENCE SURVIVED ─────────────────────────────────────────────────────────────────
 * `verifications` records `patient_id` and `member_id` per visit and was never subject to that
 * constraint. So every time a family member was verified, a row was written saying so — and those
 * rows are still there. This script reads them and re-creates the coverage links that were
 * overwritten.
 *
 * That is a RECONSTRUCTION, and it is stated as one. Two things it deliberately does not do:
 *
 *   • It does not guess the RELATIONSHIP. A verification recorded no relationship (the field did
 *     not exist), and inferring "child" from a date of birth would put a fabricated fact on a claim.
 *     Restored rows are written as 'self' — the same default every existing row takes — and the
 *     report names them so a human can correct the ones that matter, which is at the point a claim
 *     is filed for that person and the scrubber asks.
 *   • It does not re-attribute MONEY. `ledger_entries.patient_id` is left exactly as it is. A
 *     balance that was resolved to the wrong sibling is a real problem, and the honest fix is a
 *     human looking at the ledger — not this script silently moving payments between people on the
 *     strength of a reconstruction. `--report-ledger` lists the entries a human should look at.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────────────
 *   node backfill-dependents.mjs                 report only — writes nothing
 *   node backfill-dependents.mjs --apply         re-create the missing coverage rows
 *   node backfill-dependents.mjs --report-ledger also list ledger entries whose person is now in doubt
 *
 * Connection: DATABASE_ADMIN_URL if set, else DATABASE_URL. RLS is bypassed by the admin role, and
 * every statement is explicitly scoped by practice_id regardless — a backfill that relied on the
 * session's tenant context would silently do nothing under the application role.
 */
import { fileURLToPath } from 'node:url';
import { connect } from './connect.mjs';

const APPLY = process.argv.includes('--apply');
const REPORT_LEDGER = process.argv.includes('--report-ledger');

/**
 * Member ids that were verified for more than one patient in a practice — the families the old
 * constraint collapsed — together with the coverage rows that survive for them.
 *
 * Only verifications that actually named both a patient and a member id count. A verification with
 * a null `patient_id` predates the patient master and cannot be attributed to anyone.
 */
async function findFamilies(client) {
  const { rows } = await client.query(`
    SELECT v.practice_id,
           v.member_id,
           array_agg(DISTINCT v.patient_id)  AS verified_patient_ids,
           array_agg(DISTINCT c.patient_id) FILTER (WHERE c.patient_id IS NOT NULL) AS linked_patient_ids
      FROM verifications v
      LEFT JOIN coverages c
        ON c.practice_id = v.practice_id AND c.member_id = v.member_id
     WHERE v.patient_id IS NOT NULL
       AND v.member_id IS NOT NULL
       AND v.member_id <> ''
     GROUP BY v.practice_id, v.member_id
    HAVING count(DISTINCT v.patient_id) > 1
     ORDER BY v.practice_id, v.member_id
  `);
  return rows.map((r) => ({
    practiceId: r.practice_id,
    memberId: r.member_id,
    verified: r.verified_patient_ids,
    linked: r.linked_patient_ids ?? [],
    missing: r.verified_patient_ids.filter((p) => !(r.linked_patient_ids ?? []).includes(p)),
  }));
}

/**
 * Re-create one missing link.
 *
 * The payer is copied from the SURVIVING coverage row for that member id, because a family shares
 * one policy — that is the whole premise. Where no row survives with a payer, it stays null, which
 * `coveragesFor` already treats as "unknown" rather than "matches anything".
 */
async function restore(client, { practiceId, memberId, patientId }) {
  const { rowCount } = await client.query(
    `INSERT INTO coverages (practice_id, patient_id, member_id, payer_id, relationship_to_subscriber)
     SELECT $1, $3, $2,
            (SELECT payer_id FROM coverages
              WHERE practice_id = $1 AND member_id = $2 AND payer_id IS NOT NULL LIMIT 1),
            'self'
      ON CONFLICT (practice_id, member_id, patient_id) DO NOTHING`,
    [practiceId, memberId, patientId]
  );
  return rowCount ?? 0;
}

/**
 * Ledger entries keyed on a member id that belongs to more than one person.
 *
 * These are the ones whose `patient_id` was resolved through a mapping that had already been
 * overwritten, so it may name the wrong family member. Reported, never rewritten — see the header.
 */
async function ledgerInDoubt(client, families) {
  if (families.length === 0) return [];
  const { rows } = await client.query(
    `SELECT le.practice_id, le.patient_key, le.patient_id, count(*)::int AS entries,
            sum(le.amount_cents)::bigint AS cents
       FROM ledger_entries le
       JOIN unnest($1::uuid[], $2::text[]) AS f(practice_id, member_id)
         ON f.practice_id = le.practice_id AND f.member_id = le.patient_key
      GROUP BY le.practice_id, le.patient_key, le.patient_id
      ORDER BY le.practice_id, le.patient_key`,
    [families.map((f) => f.practiceId), families.map((f) => f.memberId)]
  );
  return rows;
}

async function main() {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('FATAL: set DATABASE_URL (or DATABASE_ADMIN_URL).');
    process.exit(1);
  }

  const client = await connect({ connectionString });
  try {
    const families = await findFamilies(client);

    if (families.length === 0) {
      console.log('No member id in this database was ever verified for more than one patient.');
      console.log('Nothing was collapsed by the old constraint, so there is nothing to reconstruct.');
      return;
    }

    console.log(`Member ids verified for more than one patient: ${families.length}`);
    let missingTotal = 0;
    for (const f of families) {
      missingTotal += f.missing.length;
      console.log(
        `  ${f.memberId}  practice ${f.practiceId}  verified for ${f.verified.length} patients, ` +
          `${f.linked.length} coverage row(s) survive, ${f.missing.length} lost`
      );
    }

    if (missingTotal === 0) {
      console.log('\nEvery family already has a coverage row per person — nothing to restore.');
    } else if (!APPLY) {
      console.log(`\n${missingTotal} coverage link(s) would be re-created. Re-run with --apply.`);
      console.log(
        'Restored rows are written as relationship "self", because a verification recorded no ' +
          'relationship and inventing one would put a fabricated fact on a claim. The scrubber asks ' +
          'for the real one when a dependent claim is next filed.'
      );
    } else {
      // One transaction: either every family is reconstructed or none is, so a failure halfway
      // cannot leave a database that is neither the old shape nor the new one.
      await client.query('BEGIN');
      try {
        let restored = 0;
        for (const f of families) {
          for (const patientId of f.missing) {
            restored += await restore(client, {
              practiceId: f.practiceId,
              memberId: f.memberId,
              patientId,
            });
          }
        }
        await client.query('COMMIT');
        console.log(`\nRestored ${restored} coverage link(s).`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }

    if (REPORT_LEDGER) {
      const doubtful = await ledgerInDoubt(client, families);
      console.log(`\n── Ledger entries whose person may have been resolved wrongly (${doubtful.length}) ──`);
      console.log('NOT rewritten. A balance moved between two people by a script is worse than one');
      console.log('a human moved knowingly — these are for somebody to look at.');
      for (const r of doubtful) {
        console.log(
          `  practice ${r.practice_id}  account ${r.patient_key}  → patient ${r.patient_id ?? '(unresolved)'}  ` +
            `${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}, ${r.cents} cents`
        );
      }
    }
  } finally {
    await client.end();
  }
}

export { findFamilies, ledgerInDoubt, restore };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => {
    console.error('\nBackfill error:', e.message);
    process.exit(1);
  });
}
