// clean-test-data.mjs — remove throwaway practices left behind by an interrupted test run.
//
// The live-database suite creates practices named `test-*` and deletes them in an `after` hook. Kill
// the run mid-suite (Ctrl+C, a CI timeout) and those hooks never fire, leaving orphaned tenants that
// slow later runs and clutter a shared development database.
//
// Deliberately narrow: it only ever touches practices whose name starts with `test-`, so it cannot
// remove a real tenant even if pointed at the wrong database.
//
// Usage:  npm run db:clean-tests
import { connect } from './connect.mjs';

const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: set DATABASE_URL (or DATABASE_ADMIN_URL).");
  process.exit(1);
}

// ── WHY THE TABLE LIST IS DISCOVERED AND NOT WRITTEN DOWN ────────────────────────────────────────
//
// This was a hardcoded, hand-ordered list, and it drifted: `analytics_facts` (0011),
// `ledger_entries` (0013) and `era_artifacts` / `era_sources` (0019) were all added to the schema and
// never added here. The script then died on `ledger_entries_patient_id_fkey` every time it ran, so
// nobody could clean the database — and the litter it was meant to remove is what eventually made
// `tests/db/era-tenancy.test.ts` fail: 115 leftover `era_sources` rows, 65 of them permanently due,
// starving `claim_era_sources`' oldest-first LIMIT of the rows a test had just registered.
//
// A list that must be updated by hand every migration is a list that will be wrong again. So the
// tenant tables are read from the catalog — anything carrying a `practice_id` — and deleted in
// whatever order the foreign keys actually permit, discovered by retrying until no further progress
// is possible. Adding a tenant table in a future migration now needs no change here at all.
async function tenantTables(client) {
  const { rows } = await client.query(`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'practice_id'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name <> 'practices'
     ORDER BY c.table_name`);
  return rows.map((r) => r.table_name);
}

/**
 * Delete from every tenant table, retrying until nothing more can go.
 *
 * A foreign-key violation means "a child still references this row", i.e. the order was wrong for
 * THIS table on THIS pass — not that the delete is impossible. Each pass runs every remaining table
 * in its own savepoint, keeps the ones that succeed, and repeats while progress is being made. When
 * a pass achieves nothing, whatever is left is a genuine problem and is reported rather than hidden.
 */
async function deleteAllTenantRows(client, tables, predicate) {
  let remaining = [...tables];
  let deleted = 0;
  while (remaining.length > 0) {
    const failed = [];
    let progressed = false;
    for (const table of remaining) {
      await client.query("SAVEPOINT tbl");
      try {
        const result = await client.query(`DELETE FROM ${table} WHERE ${predicate}`);
        await client.query("RELEASE SAVEPOINT tbl");
        deleted += result.rowCount ?? 0;
        progressed = true;
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT tbl");
        if (err?.code !== "23503") throw err; // only FK ordering is retryable
        failed.push(table);
      }
    }
    if (!progressed) {
      throw new Error(
        `could not clear ${failed.join(", ")} — a foreign key outside the tenant tables still ` +
          `references them, which needs a human rather than another pass`
      );
    }
    remaining = failed;
  }
  return deleted;
}

const client = await connect({ connectionString: url });
try {
  const tables = await tenantTables(client);
  const { rows } = await client.query("SELECT id, name FROM practices WHERE name LIKE 'test-%'");
  if (rows.length === 0) {
    console.log("✔ no orphaned test practices");
  } else {
    // One transaction: either the whole tenant is gone or nothing moved. A half-deleted practice is
    // worse litter than an untouched one, because its remaining rows reference a tenant that is gone.
    await client.query("BEGIN");
    try {
      const scoped = "practice_id IN (SELECT id FROM practices WHERE name LIKE 'test-%')";
      const deleted = await deleteAllTenantRows(client, tables, scoped);
      const removed = await client.query("DELETE FROM practices WHERE name LIKE 'test-%'");
      await client.query("COMMIT");
      console.log(
        `✔ removed ${removed.rowCount} orphaned test practice(s) and ${deleted} row(s) across ` +
          `${tables.length} tenant table(s)`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  /**
   * Rows whose practice no longer exists at all.
   *
   * These predate the FK-safe deletion above — earlier versions of this script died partway and left
   * children behind, and `era_sources` was never in its list to begin with. An orphaned `era_sources`
   * row is not inert: it stays `enabled`, its poll lease expires, and it is DUE for ever, competing
   * for `claim_era_sources`' oldest-first batch against real work.
   */
  await client.query("BEGIN");
  try {
    const orphaned = await deleteAllTenantRows(
      client,
      tables,
      "practice_id NOT IN (SELECT id FROM practices)"
    );
    await client.query("COMMIT");
    if (orphaned) console.log(`✔ removed ${orphaned} row(s) belonging to practices that no longer exist`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // (The old special case for orphaned `domain_events` is gone: the sweep above covers every table
  // carrying a `practice_id`, which is what that block was hand-written to do for one of them.)

  /**
   * ── THE LITTER THAT IS NOT A TENANT (audit B-6) ────────────────────────────────────────────────
   *
   * Everything above is keyed on `practice_id`, so it can only ever reach tenant rows. The payer
   * catalog is deliberately GLOBAL — one registry shared by every practice, which is the whole point
   * of it — and so nothing here has ever swept it. An audit of the development database found 43
   * payers, of which 36 were throwaway rows from interrupted test runs: `Catalogued Only`,
   * `First Claimant`, `Testwell 89121F4B Dental`, `Test Payer Renamed`.
   *
   * That is not cosmetic. The catalog is read at the edge of every verification to resolve a card's
   * payer name, and `GET /api/v1/payer-profile/payers` renders it to an administrator. A registry
   * where six real payers are outnumbered five to one by fixtures is a screen nobody can use, and it
   * is the screen a dental practice would be shown.
   *
   * ── WHY THE PATTERNS ARE LISTED RATHER THAN INFERRED ─────────────────────────────────────────
   * Each one is a literal generator in the suite, cited so a reader can check it rather than trust
   * it. Nothing is matched on "looks like a test": a real payer slug is a readable name, and a rule
   * loose enough to catch `Testwell` by its shape would eventually catch a small regional plan.
   *
   *   test-payer-%   tests/db/payer-catalog.test.ts:90  `test-payer-${randomBytes(4)...}`
   *                  plus the fixed `test-payer-a` / `test-payer-b` pair
   *   t%-catalog     tests/db/denials.test.ts:310       `${RUN}-catalog`, RUN = `t${Date.now(36)}`
   *
   * Aliases are removed first: `payer_aliases` references `payers`, and the FK would otherwise
   * refuse the delete and take the whole transaction with it.
   */
  const TEST_PAYER_PATTERNS = ["test-payer-%", "t%-catalog"];
  await client.query("BEGIN");
  try {
    const scoped = TEST_PAYER_PATTERNS.map((_, i) => `edi_payer_id LIKE $${i + 1}`).join(" OR ");
    const aliases = await client.query(
      `DELETE FROM payer_aliases WHERE payer_id IN (SELECT id FROM payers WHERE ${scoped})`,
      TEST_PAYER_PATTERNS
    );
    const payers = await client.query(`DELETE FROM payers WHERE ${scoped}`, TEST_PAYER_PATTERNS);
    await client.query("COMMIT");
    if (payers.rowCount) {
      console.log(
        `✔ removed ${payers.rowCount} throwaway payer(s) from the shared catalog` +
          (aliases.rowCount ? ` and ${aliases.rowCount} alias(es)` : "")
      );
    } else {
      console.log("✔ the payer catalog holds no throwaway rows");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  /**
   * Tables the migration-runner suite creates to prove the runner, left behind when a run is killed.
   *
   * `tests/db/migration-runner.test.ts` builds `_migrations_test_<id>` ledgers and `mig_a_<id>`
   * subject tables. They sit in `public` beside the real schema, so `\dt` and every "what is in this
   * database" query returns them, and a reader has to know the suite to know they are noise.
   *
   * Matched on the two literal prefixes and nothing else, and `_migrations` itself — the real ledger,
   * which shares a prefix with the fixtures — is excluded by name rather than by hoping the pattern
   * misses it. Dropping the migration ledger would make the next deploy re-run all 28 migrations.
   */
  const stray = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> '_migrations'
       AND (table_name LIKE '\\_migrations\\_test\\_%' OR table_name LIKE 'mig\\_a\\_%')
     ORDER BY table_name`);
  if (stray.rows.length === 0) {
    console.log("✔ no leftover migration-test tables");
  } else {
    for (const { table_name: name } of stray.rows) {
      // Identifiers cannot be parameterised. Every name here came from the catalog and matched one
      // of two prefixes, so it is already known to be a plain identifier; quoting it is belt-and-
      // braces rather than the only defence.
      await client.query(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}" CASCADE`);
    }
    console.log(`✔ dropped ${stray.rows.length} leftover migration-test table(s)`);
  }
} finally {
  await client.end();
}
