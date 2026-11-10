/**
 * M14 part 2 — backfill `ledger_entries.patient_id` from the coverages on file.
 *
 * ── WHAT MAKES THIS SAFE ───────────────────────────────────────────────────────────────────────
 * This touches the table that decides what a patient is asked to pay, which makes it the
 * highest-risk change in the M11–M15 plan. Four properties, in order of how much they matter:
 *
 *   1. **It cannot change a balance.** The only column written is `patient_id`, which no balance
 *      query reads — a balance is `sum(amount_cents)` grouped by `patient_key`, exactly as before.
 *      Financial integrity here is structural, not merely tested.
 *   2. **It proves that anyway.** Every account's balance is captured before and compared after, and
 *      the run ABORTS AND ROLLS BACK on any difference. A structural argument you have not checked
 *      is an assumption.
 *   3. **It is idempotent.** Only rows with `patient_id IS NULL` are considered, and re-running finds
 *      nothing to do. Safe to run twice, safe to run after a partial failure.
 *   4. **It is reversible.** `--rollback` sets every `patient_id` back to NULL, returning the table
 *      to its pre-migration behaviour exactly, because nothing depends on the column being populated.
 *
 * Everything runs in ONE transaction per practice: either a practice is fully backfilled with its
 * balances verified, or nothing about it changed.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────────────────────────
 *   node --env-file-if-exists=.env platform/db/backfill-ledger-patients.mjs           # dry run
 *   node --env-file-if-exists=.env platform/db/backfill-ledger-patients.mjs --apply
 *   node --env-file-if-exists=.env platform/db/backfill-ledger-patients.mjs --rollback
 *
 * Dry run is the default deliberately: a script that migrates money on being invoked with no
 * arguments is one somebody eventually runs by accident.
 *
 * Uses DATABASE_URL (the unprivileged app role) rather than the admin URL — this is DML, and it must
 * be subject to the same RLS every other write is. A backfill that can only work as a superuser is a
 * backfill nobody can prove is tenant-safe.
 */
import pg from "pg";
import { connectionOptions } from "./tls.mjs";
import { pathToFileURL } from "node:url";

const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");

/**
 * The three operations below are EXPORTED so the live-database test drives the same code this
 * script runs, rather than a re-typed copy of its SQL.
 *
 * That is not tidiness. A backfill verified by a test containing its own separate UPDATE proves the
 * test's SQL is safe and says nothing about the script's — which is precisely the trap the M10
 * `openOnly` drift sprang, and precisely what `tests/db/repository-contract.test.ts` exists to stop
 * recurring. One definition, exercised by both.
 */

/** Balances per account key, the same way every read path computes them. */
export async function balances(client, practiceId) {
  const { rows } = await client.query(
    `SELECT patient_key, sum(amount_cents)::bigint AS balance, count(*)::int AS entries
       FROM ledger_entries WHERE practice_id = $1
      GROUP BY patient_key ORDER BY patient_key`,
    [practiceId]
  );
  return new Map(rows.map((r) => [r.patient_key, { balance: String(r.balance), entries: r.entries }]));
}

export function diffBalances(before, after) {
  const problems = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) problems.push(`account ${key}: disappeared entirely`);
    else if (a.balance !== b.balance) problems.push(`account ${key}: balance ${b.balance} → ${a.balance}`);
    else if (a.entries !== b.entries) problems.push(`account ${key}: ${b.entries} entries → ${a.entries}`);
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`account ${key}: appeared from nowhere`);
  return problems;
}

/**
 * Link one practice's unlinked ledger entries to the patient their member ID belongs to.
 *
 * Only rows with `patient_id IS NULL` are touched, which is what makes a second run a no-op and a
 * re-run after a partial failure safe.
 */
export async function linkForPractice(client, practiceId) {
  // The mapping: a member ID belongs to whoever the coverage on file says it does.
  const { rowCount: linked } = await client.query(
    `UPDATE ledger_entries le
        SET patient_id = c.patient_id
       FROM coverages c
      WHERE le.practice_id = $1
        AND le.patient_id IS NULL
        AND c.practice_id = le.practice_id
        AND c.member_id = le.patient_key`,
    [practiceId]
  );

  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE practice_id = $1 AND patient_id IS NULL`,
    [practiceId]
  );
  return { linked, unresolved: rows[0].n };
}

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — nothing to back-fill.");
    process.exitCode = 1;
    return;
  }
  // The shared TLS policy, same as the pool and every other operational script (NEW-04). This one
  // reads and rewrites the table that decides what a patient is asked to pay.
  const pool = new pg.Pool({ ...connectionOptions(url), max: 4 });
  const client = await pool.connect();
  let totalLinked = 0;
  let totalUnresolved = 0;

  try {
    const { rows: practices } = await client.query("SELECT id, name FROM practices ORDER BY name");
    if (practices.length === 0) console.log("No practices found.");

    for (const practice of practices) {
      await client.query("BEGIN");
      // Every statement below is RLS-scoped to this practice, exactly like an ordinary request.
      await client.query("SELECT set_current_practice($1)", [practice.id]);

      const before = await balances(client, practice.id);

      if (ROLLBACK) {
        const { rowCount } = await client.query(
          "UPDATE ledger_entries SET patient_id = NULL WHERE practice_id = $1 AND patient_id IS NOT NULL",
          [practice.id]
        );
        const after = await balances(client, practice.id);
        const problems = diffBalances(before, after);
        if (problems.length > 0) {
          await client.query("ROLLBACK");
          console.error(`✖ ${practice.name}: ROLLED BACK — balances moved:\n   ${problems.join("\n   ")}`);
          process.exitCode = 1;
          continue;
        }
        if (APPLY) {
          await client.query("COMMIT");
          console.log(`↩ ${practice.name}: cleared ${rowCount} patient link(s)`);
        } else {
          await client.query("ROLLBACK");
          console.log(`  ${practice.name}: would clear ${rowCount} patient link(s) [dry run]`);
        }
        continue;
      }

      const { linked, unresolved } = await linkForPractice(client, practice.id);

      const after = await balances(client, practice.id);
      const problems = diffBalances(before, after);

      if (problems.length > 0) {
        // This should be impossible — only patient_id was written — which is exactly why it is
        // checked. An impossible thing that happens anyway must not be committed.
        await client.query("ROLLBACK");
        console.error(`✖ ${practice.name}: ROLLED BACK — balances moved:\n   ${problems.join("\n   ")}`);
        process.exitCode = 1;
        continue;
      }

      if (APPLY) {
        await client.query("COMMIT");
        console.log(`✔ ${practice.name}: linked ${linked}, unresolved ${unresolved}, balances unchanged (${before.size} account(s))`);
      } else {
        await client.query("ROLLBACK");
        console.log(`  ${practice.name}: would link ${linked}, leaving ${unresolved} unresolved [dry run]`);
      }

      totalLinked += linked;
      totalUnresolved += unresolved;
    }

    console.log(
      `\n${APPLY || ROLLBACK ? "" : "[DRY RUN — nothing written. Re-run with --apply] "}` +
        `linked ${totalLinked}, unresolved ${totalUnresolved}.`
    );
    if (totalUnresolved > 0 && !ROLLBACK) {
      // Not an error. An entry whose member ID has no coverage on file is legitimate money — the
      // account still works on patient_key. Reported so the number is visible rather than assumed.
      console.log(
        "Unresolved entries keep working on their member-ID account; they simply cannot yet be\n" +
          "grouped with the same person's other coverages."
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Only when invoked directly. The live-database test imports the operations above, and importing a
// module must never migrate anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
