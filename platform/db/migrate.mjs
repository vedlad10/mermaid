// migrate.mjs — forward-only SQL migration runner for Mermaid's single Postgres database.
//
// Doctrine (mirrors the two donor apps): plain Node ESM, no build step, minimal deps.
// Migrations are numbered .sql files in ./migrations, applied in order, recorded with a checksum so
// an edited-after-apply file is caught loudly.
//
// ── THE WHOLE RUN IS ONE TRANSACTION, HELD UNDER AN ADVISORY LOCK (DEC-2) ──────────────────────
// This used to apply EACH FILE in its own transaction. That invariant is deliberately changed, and
// the reason is that nothing serialised two runners.
//
// `pending` is computed by reading `_migrations` and is only written back after each file succeeds,
// so two concurrent runs — two app instances booting, a rolling deploy running migrate on every
// replica, a person running it while CI does — both read the same empty `pending` and both execute
// the same DDL. A file whose statements are individually idempotent (`CREATE TABLE IF NOT EXISTS`)
// but which also INSERTS or UPDATES rows — 0014 seeds the payer catalog, 0015 and 0016 backfill —
// can commit twice and apply its data change twice. No checksum catches that: nothing about the
// file changed.
//
// A SESSION-level `pg_advisory_lock` was implemented first and rejected on evidence. This
// deployment's connection string points at a PgBouncer pooler, which can hand two logical clients
// the same server backend; advisory locks are re-entrant per backend, so `pg_try_advisory_lock`
// returned TRUE while another client held it. A lock that reports success without excluding anyone
// is worse than no lock, because it manufactures confidence.
//
// `pg_advisory_xact_lock` is transaction-scoped, and a transaction is pinned to one backend for its
// duration even through a transaction-mode pooler — so the exclusion is real here. It requires a
// transaction that spans the whole run, which is why the per-file boundary goes.
//
// The trade-off, stated plainly: a failure in the last migration now rolls back the earlier ones in
// the same run. That is a LOSS of granularity and a GAIN in atomicity — the database is never left
// halfway through a deploy's worth of schema change, which is the state that is hardest to reason
// about at 3am. Postgres has transactional DDL, so this costs nothing structurally; no migration in
// this repository uses a statement that cannot run inside a transaction block (`CREATE INDEX
// CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`). Adding one would require revisiting this decision,
// and the check below refuses rather than letting it fail halfway.
//
// ── …AND THAT ONLY BECAME TRUE WHEN THE FILES STOPPED CARRYING THEIR OWN (NEW-02) ───────────────
// Everything above describes the intent. It was not what happened. Eighteen of the twenty migration
// files each opened with `BEGIN;` and ended with `COMMIT;`, and `client.query(sql)` sends a
// multi-statement string over the SIMPLE query protocol, where Postgres runs the statements exactly
// as written. So the FILE's `COMMIT` committed the RUNNER's transaction — at the end of the very
// first migration applied. The advisory lock, being transaction-scoped, was released with it; every
// later file ran in its own implicit transaction; and the `ROLLBACK` in the catch block below had
// nothing left to roll back. The design said "one transaction, one lock" and the code delivered
// neither, silently, because a `BEGIN` inside a transaction is only a warning.
//
// The files were stripped of transaction control, and `assertRunnerOwnsTransaction` below refuses
// any migration that reintroduces it. See sql-transaction-control.mjs for the scanner (a plain
// regex cannot do this — PL/pgSQL blocks open with `BEGIN` too) and migration-checksum-history.mjs
// for how databases that had already applied the pre-strip text are reconciled.
//
// Usage:
//   node migrate.mjs            apply all pending migrations
//   node migrate.mjs --status   list applied + pending, then exit (no changes)
//
// Connection: DATABASE_ADMIN_URL if set (DDL/role setup), else DATABASE_URL.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './connect.mjs';
import { findTransactionControl } from './sql-transaction-control.mjs';
import { SUPERSEDED_CHECKSUMS } from './migration-checksum-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The advisory-lock key for the migration run. Arbitrary but STABLE — every runner must name the
 * same number or they will not exclude each other. Passed as a string because `pg` sends JS numbers
 * above 2^31 as float8, which does not bind to `pg_advisory_xact_lock(bigint)`.
 */
const MIGRATION_LOCK_KEY = '8531207419776002';

/** Numbered .sql files sorted by their integer prefix (0001, 0002, …). */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { id: parseInt(file, 10), file, sql, checksum: sha256(sql) };
    });
}

/**
 * Refuse any migration that manages its own transaction.
 *
 * This runs over EVERY migration, not just the pending ones, so a fresh database and an up-to-date
 * one fail identically — a rule that only bites on some machines is not a rule. It is cheap: the
 * files are already read.
 */
export function assertRunnerOwnsTransaction(migrations) {
  for (const m of migrations) {
    const found = findTransactionControl(m.sql);
    if (found.length === 0) continue;
    const where = found.map((f) => `${f.statement} (line ${f.line})`).join(', ');
    throw new Error(
      `migration ${m.file} contains transaction control: ${where}. The RUNNER owns the ` +
        `transaction — it applies the whole pending set in one, and holds pg_advisory_xact_lock ` +
        `inside it so a concurrent runner is excluded. A COMMIT in a migration file commits the ` +
        `runner's transaction and releases that lock mid-run, which is exactly the bug this guard ` +
        `exists to prevent. Remove it; the file is already atomic.`
    );
  }
}

/**
 * A statement that cannot run inside a transaction block would fail halfway through the run and
 * take every earlier file's rollback with it. None exists today; refusing here means the day
 * somebody adds one, they are told to revisit this design rather than discovering it mid-deploy.
 */
function assertTransactionSafe(pending) {
  const nonTransactional = pending.filter((m) =>
    /(CREATE|DROP)\s+INDEX\s+CONCURRENTLY|VACUUM|CREATE\s+DATABASE|CREATE\s+TABLESPACE/i.test(m.sql)
  );
  if (nonTransactional.length > 0) {
    throw new Error(
      `migration ${nonTransactional[0].file} contains a statement that cannot run inside a ` +
        `transaction block, and the runner applies the whole pending set in ONE transaction so a ` +
        `concurrent run can be excluded (see the header). Split it out and apply it deliberately, ` +
        `or revisit the single-transaction decision.`
    );
  }
}

/**
 * Compare each applied migration's recorded checksum against the file on disk.
 *
 * Returns `{ repairs }` for rows whose recorded checksum is a blessed historical one (see
 * migration-checksum-history.mjs), and throws on any other mismatch. The distinction is the whole
 * point: an unrecognised mismatch is an edited migration, which is a bug, and no amount of
 * inconvenience justifies continuing past it.
 */
export function reconcileChecksums(migrations, applied) {
  const repairs = [];
  for (const m of migrations) {
    const prior = applied.get(m.id);
    if (!prior || prior.checksum === m.checksum) continue;

    /**
     * Both ends must match: the recorded row is the text this entry supersedes, AND the file on
     * disk is the exact text it supersedes it WITH. A blessed entry therefore authorises one
     * transition and nothing else — it cannot be reused to wave through a later edit to the same
     * file, which is the failure mode an "allowed to differ" list would have.
     */
    const blessed = SUPERSEDED_CHECKSUMS.get(m.id);
    if (blessed && blessed.from === prior.checksum && blessed.to === m.checksum) {
      repairs.push({ id: m.id, file: m.file, from: prior.checksum, to: m.checksum });
      continue;
    }

    throw new Error(
      `migration ${m.file} was modified after it was applied ` +
        `(recorded ${prior.checksum.slice(0, 12)}, now ${m.checksum.slice(0, 12)}). ` +
        `Migrations are immutable once applied — add a new migration instead.`
    );
  }
  return { repairs };
}

/**
 * Apply every pending migration, and repair any blessed checksum drift, under one transaction and
 * one advisory lock.
 *
 * Exported so the live-database tests can drive the real runner against a throwaway directory and
 * table instead of asserting on a copy of its logic. The defaults are what the CLI uses.
 */
export async function runMigrations({
  client,
  dir = MIGRATIONS_DIR,
  table = '_migrations',
  lockKey = MIGRATION_LOCK_KEY,
  statusOnly = false,
  log = console.log,
} = {}) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id          INTEGER PRIMARY KEY,
      file        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Map(
    (await client.query(`SELECT id, file, checksum FROM ${table} ORDER BY id`)).rows.map((r) => [
      r.id,
      r,
    ])
  );
  const migrations = loadMigrations(dir);

  assertRunnerOwnsTransaction(migrations);
  const { repairs } = reconcileChecksums(migrations, applied);

  const pending = migrations.filter((m) => !applied.has(m.id));

  if (statusOnly) {
    log(`Applied (${applied.size}):`);
    for (const m of migrations.filter((x) => applied.has(x.id))) log(`  ✔ ${m.file}`);
    log(`Pending (${pending.length}):`);
    for (const m of pending) log(`  … ${m.file}`);
    if (repairs.length > 0) {
      log(`Checksum repairs queued (${repairs.length}) — see migration-checksum-history.mjs:`);
      for (const r of repairs) log(`  ↻ ${r.file}`);
    }
    return { applied: [], repaired: [] };
  }

  if (pending.length === 0 && repairs.length === 0) {
    log('Database is up to date — no pending migrations.');
    return { applied: [], repaired: [] };
  }

  assertTransactionSafe(pending);

  /**
   * One transaction for the whole run, and the lock is taken INSIDE it.
   *
   * `pg_advisory_xact_lock` blocks rather than failing: a concurrent deploy should wait for the
   * migration, not abort on it. It is released by COMMIT or ROLLBACK — there is no unlock path to
   * forget, and no way for a crashed process to leave it held, which is the other reason to prefer
   * it over the session-level lock even where a pooler is not involved.
   *
   * The second runner wakes up after the first commits, re-reads the migrations table inside its
   * own transaction, finds nothing pending, and exits cleanly.
   */
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Re-read under the lock. The first runner may have applied everything while this one waited,
    // and acting on the pre-lock snapshot is exactly the race the lock exists to close.
    const appliedNow = new Map(
      (await client.query(`SELECT id, checksum FROM ${table}`)).rows.map((r) => [r.id, r])
    );
    const toApply = pending.filter((m) => !appliedNow.has(m.id));
    const toRepair = repairs.filter((r) => appliedNow.get(r.id)?.checksum === r.from);

    if (toApply.length === 0 && toRepair.length === 0) {
      await client.query('COMMIT');
      log('Another runner applied these first — database is up to date.');
      return { applied: [], repaired: [] };
    }

    for (const r of toRepair) {
      await client.query(`UPDATE ${table} SET checksum = $2 WHERE id = $1`, [r.id, r.to]);
      log(
        `Repaired checksum for ${r.file} (${r.from.slice(0, 12)} → ${r.to.slice(0, 12)}) — ` +
          `blessed by migration-checksum-history.mjs; the schema is unchanged.`
      );
    }

    for (const m of toApply) {
      await client.query(m.sql);
      await client.query(`INSERT INTO ${table} (id, file, checksum) VALUES ($1, $2, $3)`, [
        m.id,
        m.file,
        m.checksum,
      ]);
      // Through `log`, not process.stdout: `log: () => {}` has to mean silent, and the live test
      // anchors on this callback to know the critical section has actually been entered.
      log(`Applied ${m.file}`);
    }
    await client.query('COMMIT');
    if (toApply.length > 0) {
      log(`Done — applied ${toApply.length} migration(s) in one transaction.`);
    } else {
      log('Done — checksums reconciled, no schema change.');
    }
    return { applied: toApply.map((m) => m.file), repaired: toRepair.map((r) => r.file) };
  } catch (e) {
    await client.query('ROLLBACK');
    log('FAILED — the entire run was rolled back.');
    throw e;
  }
}

async function main() {
  // An argument this runner does not understand must NOT fall through to "apply".
  //
  // `--status` is the only flag, and anything else previously meant the default action, which is to
  // write DDL to whatever database is configured. So `migrate.mjs status`, `--statu`, or `--dry-run`
  // all silently applied migrations — the reading most likely to be a typo produced the least
  // reversible outcome. That is the opposite of how everything else here behaves: an undeclared
  // route is refused, a monitor that cannot take a reading alarms, an unbalanced 835 stops before
  // money moves. A migration runner is the last place to be generous about what it accepts.
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--status');
  if (unknown.length > 0) {
    console.error(`FATAL: unrecognized argument(s): ${unknown.join(' ')}`);
    console.error('Usage: node migrate.mjs [--status]');
    console.error('Refusing to run — an unrecognized argument is not permission to apply migrations.');
    process.exit(2);
  }

  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('FATAL: set DATABASE_URL (or DATABASE_ADMIN_URL) before running migrations.');
    console.error('Copy .env.example to .env and point it at your Postgres instance.');
    process.exit(1);
  }

  const client = await connect({ connectionString });
  try {
    await runMigrations({ client, statusOnly: args.includes('--status') });
  } finally {
    await client.end();
  }
}

// Only the CLI entry connects and exits; importing this module runs nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('\nMigration error:', e.message);
    process.exit(1);
  });
}
