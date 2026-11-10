/**
 * The migration runner's two load-bearing properties, against the real database (NEW-02).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * `migration-lock.test.ts` next door proves what the two LOCK TYPES do through this pooler. It
 * cannot prove what the RUNNER does, and said so: "there are normally no pending migrations, so the
 * runner's critical section is never executed by a test at all". It compensated by reading the
 * source for `pg_advisory_xact_lock` — which the source did contain, the whole time the runner was
 * broken.
 *
 * It was broken because eighteen migration FILES carried `BEGIN; … COMMIT;`. Multi-statement SQL
 * goes over the simple query protocol, so the first file's `COMMIT` committed the runner's
 * transaction, released the transaction-scoped lock, and dropped whole-run atomicity — while every
 * source-reading assertion still passed. Nothing short of executing the critical section could have
 * caught that, so these two tests execute it.
 *
 * ── HOW THEY STAY SAFE AGAINST A SHARED DATABASE ─────────────────────────────────────────────────
 * They drive the real `runMigrations` against a throwaway migrations DIRECTORY, a throwaway ledger
 * TABLE, and a throwaway lock KEY, creating uniquely-named tables they drop afterwards. The live
 * `_migrations` ledger and the real schema are never touched — running this against the shared
 * development database, or twice at once, changes nothing an operator would notice.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runMigrations } from "../../platform/db/migrate.mjs";
import { dbTest } from "./harness.ts";

const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || "";

/**
 * A lock key per test, in a range of this suite's own so a real concurrent deploy is neither
 * blocked by nor blocks it. Per-test rather than shared: a test that fails mid-critical-section
 * leaves its holder transaction open, and a shared key turns that into every LATER test blocking
 * until the server times the connection out — five minutes each, reported as the later test being
 * slow. One failure should cost one failure.
 */
let nextLockKey = 8531207419776090;
const lockKey = (): string => String(nextLockKey++);

const clients: pg.Client[] = [];
const dirs: string[] = [];
const tables: string[] = [];

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  clients.push(c);
  return c;
}

/** A suffix unique to this test, so two runs of the suite cannot collide on a table name. */
function unique(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * A throwaway migrations directory. `files` is `[sql, …]` in order; each becomes NNNN_step.sql.
 * The ledger table name is returned with it and remembered for cleanup.
 */
function scratch(files: string[]): { dir: string; table: string } {
  const dir = mkdtempSync(join(tmpdir(), "mermaid-migrate-"));
  dirs.push(dir);
  files.forEach((sql, i) => {
    writeFileSync(join(dir, `${String(i + 1).padStart(4, "0")}_step.sql`), sql);
  });
  const table = `_migrations_test_${unique()}`;
  tables.push(table);
  return { dir, table };
}

/**
 * How many of `names` exist as relations. Counted rather than listed because `count(*)` comes back
 * as a number here — an int8 parser is registered by the application's pool, which these tests load
 * through the harness — and comparing against a string silently fails.
 */
async function countRelations(c: pg.Client, names: string[]): Promise<number> {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[])`, [
    names,
  ]);
  return Number((rows[0] as { n: number }).n);
}

after(async () => {
  if (connectionString) {
    const c = clients[0] ?? (await client());
    for (const t of tables) await c.query(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
  }
  for (const c of clients) await c.end().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("the lock is held for the WHOLE run, not just until the first migration commits", dbTest, async () => {
  /**
   * ── THIS IS THE ONE THAT CAUGHT IT ─────────────────────────────────────────────────────────────
   * The obvious test — hold the lock, start a runner, watch it wait — passes on the BROKEN code
   * too, and that is worth knowing. The runner takes the lock as the first statement inside its
   * transaction, before any migration file runs, so acquisition was never the problem.
   *
   * The problem was the RELEASE. With `COMMIT;` inside migration 0001, the runner's transaction
   * ended there — and `pg_advisory_xact_lock` is released by COMMIT. From that moment the runner
   * was still applying files 2..N with the lock held by nobody, so a second deploy could walk in
   * and apply the same pending set concurrently. That is how a seeding migration runs twice.
   *
   * So the assertion is not "does a second runner wait" but "can anyone take this lock at ANY point
   * before the run finishes". A prober polls for it throughout; it must never succeed.
   */
  const stamp = unique();
  const tableA = `mig_a_${stamp}`;
  const tableB = `mig_b_${stamp}`;
  const { dir, table } = scratch([
    `CREATE TABLE ${tableA} (id int);`,
    // Wide enough for the prober to land inside the run several times over.
    `SELECT pg_sleep(3);`,
    `CREATE TABLE ${tableB} (id int);`,
  ]);
  tables.push(tableA, tableB);

  const key = lockKey();
  const runner = await client();
  const prober = await client();

  /**
   * Probing must not start before the runner has entered its critical section — for the first
   * second or so it is still doing setup round trips and the lock is legitimately free. The first
   * applied file is the anchor: the runner reports it AFTER running that migration's SQL, which on
   * the broken code is exactly where the file's own COMMIT had already released the lock.
   */
  let running = true;
  let inCriticalSection = false;
  const run = runMigrations({
    client: runner,
    dir,
    table,
    lockKey: key,
    log: (m) => {
      if (m.startsWith("Applied ")) inCriticalSection = true;
    },
  }).finally(() => {
    running = false;
  });

  let stolenAfter: number | null = null;
  let probes = 0;
  const started = Date.now();
  while (running) {
    if (inCriticalSection) {
      await prober.query("BEGIN");
      const { rows } = await prober.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [key]);
      const free = (rows[0] as { ok: boolean }).ok;
      await prober.query("ROLLBACK");
      probes++;
      if (free && running && stolenAfter === null) stolenAfter = Date.now() - started;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  await run;

  assert.ok(probes > 3, `the run finished too fast to probe meaningfully (${probes} probes)`);
  assert.equal(
    stolenAfter,
    null,
    `the migration lock became free ${stolenAfter}ms into a run that was still applying files — ` +
      `a concurrent deploy would enter here and re-apply the pending set`
  );
  assert.equal(await countRelations(prober, [tableA, tableB]), 2, "and the run still completed");
});

test("a runner waits rather than failing when another holds the lock", dbTest, async () => {
  /**
   * The complement: exclusion must BLOCK, not abort. A rolling deploy running migrate on every
   * replica should queue behind the first one and then find nothing pending — not crash the pod.
   */
  const tableA = `mig_a_${unique()}`;
  const { dir, table } = scratch([`CREATE TABLE ${tableA} (id int);`]);
  tables.push(tableA);

  const key = lockKey();
  const holder = await client();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock($1)", [key]);

  const runner = await client();
  let settled = false;
  const run = runMigrations({ client: runner, dir, table, lockKey: key, log: () => {} }).then((r) => {
    settled = true;
    return r;
  });

  try {
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(settled, false, "the runner must wait for the holder");
    assert.equal(await countRelations(holder, [tableA]), 0, "and apply nothing while it waits");
  } finally {
    // Release even on failure, so the blocked runner can finish and this test's damage stops here.
    await holder.query("COMMIT").catch(() => {});
    await run.catch(() => {});
  }

  assert.deepEqual((await run).applied, ["0001_step.sql"], "and proceed once the lock is released");
});

test("a failing final migration leaves the ledger and the schema exactly as they were", dbTest, async () => {
  /**
   * The atomicity half. With `COMMIT` inside the files, migrations 1 and 2 were already committed
   * by the time 3 failed: the database was left in a state that exists in no migration's output and
   * that `--status` reports as "up to date" for the first two — the hardest thing to diagnose.
   */
  const stamp = unique();
  const tableA = `mig_a_${stamp}`;
  const tableB = `mig_b_${stamp}`;
  const { dir, table } = scratch([
    `CREATE TABLE ${tableA} (id int);`,
    `CREATE TABLE ${tableB} (id int);`,
    // Deliberate: a column that does not exist. Chosen over `1/0` because it fails at plan time the
    // way a genuine bad migration does, rather than at execution of a trivially-constant expression.
    `INSERT INTO ${tableA} (no_such_column) VALUES (1);`,
  ]);
  tables.push(tableA, tableB);

  const key = lockKey();
  const runner = await client();
  await assert.rejects(
    runMigrations({ client: runner, dir, table, lockKey: key, log: () => {} }),
    /no_such_column/i,
    "the run must fail loudly rather than stopping quietly at migration 2"
  );

  assert.equal(
    await countRelations(runner, [tableA, tableB]),
    0,
    "migrations 1 and 2 must have rolled back with 3 — a half-applied deploy is the state that " +
      "cannot be reasoned about"
  );

  const ledger = await runner.query(`SELECT count(*) AS n FROM ${table}`);
  assert.equal(Number((ledger.rows[0] as { n: string }).n), 0, "and nothing may be recorded as applied");

  /**
   * The ledger table itself survives because it is created before the transaction opens — that is
   * deliberate and harmless (it is empty, and CREATE TABLE IF NOT EXISTS). Proving the harness can
   * observe success at all is what makes the assertions above mean something: drop the failing file
   * and the same directory applies cleanly.
   */
  rmSync(join(dir, "0003_step.sql"));
  const ok = await runMigrations({ client: runner, dir, table, lockKey: key, log: () => {} });
  assert.deepEqual(ok.applied, ["0001_step.sql", "0002_step.sql"]);

  assert.equal(await countRelations(runner, [tableA, tableB]), 2);
});

test("a migration that opens its own transaction is refused before anything runs", dbTest, async () => {
  /**
   * The guard, exercised through the real entry point. A unit test proves the scanner; this proves
   * nothing reaches the database when it fires — including the ledger row, which a runner that
   * checked only after applying would have written.
   */
  const stamp = unique();
  const tableA = `mig_a_${stamp}`;
  const { dir, table } = scratch([`BEGIN;\nCREATE TABLE ${tableA} (id int);\nCOMMIT;`]);
  tables.push(tableA);

  const runner = await client();
  await assert.rejects(
    runMigrations({ client: runner, dir, table, lockKey: lockKey(), log: () => {} }),
    /transaction control/i
  );

  assert.equal(await countRelations(runner, [tableA]), 0, "the refused migration must not have run");
});
