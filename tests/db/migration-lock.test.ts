/**
 * The migration runner's lock, against the real database — including its pooler.
 *
 * ── WHY THIS TEST EXISTS AND WHY IT USES RAW CLIENTS (DEC-2) ───────────────────────────────────
 * `migrate.mjs` applies the whole pending set in ONE transaction so that a concurrent runner can be
 * excluded by `pg_advisory_xact_lock`. That design replaced a SESSION-level `pg_advisory_lock` which
 * was implemented, tested against this deployment's actual connection string, and rejected: it
 * points at a PgBouncer pooler, which can hand two logical clients the same server backend, and
 * advisory locks are re-entrant per backend — so `pg_try_advisory_lock` returned TRUE while another
 * client held it. A lock that reports success without excluding anyone is worse than no lock.
 *
 * The two assertions below are the difference, and they are asserted rather than remembered so that
 * the session-level lock cannot quietly come back. They use raw `pg` clients on purpose: the point
 * is the behaviour of two INDEPENDENT connections through whatever sits in front of Postgres, which
 * the pooled application helpers deliberately hide.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The key `migrate.mjs` uses. If these drift, two runners stop excluding each other. */
const MIGRATION_LOCK_KEY = "8531207419776002";

const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || "";
const clients: pg.Client[] = [];

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  clients.push(c);
  return c;
}

after(async () => {
  for (const c of clients) await c.end().catch(() => {});
});

test("a transaction-scoped advisory lock excludes a second runner, and releases on commit", async () => {
  const a = await client();
  const b = await client();

  await a.query("BEGIN");
  await a.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);

  await b.query("BEGIN");
  const held = await b.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [MIGRATION_LOCK_KEY]);
  assert.equal(held.rows[0]!.ok, false, "a second runner must not enter the critical section");
  await b.query("ROLLBACK");

  // Released by COMMIT — there is no unlock call to forget, and a crashed runner cannot leave it
  // held, which is the other reason to prefer it over the session-level lock.
  await a.query("COMMIT");

  await b.query("BEGIN");
  const after = await b.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [MIGRATION_LOCK_KEY]);
  assert.equal(after.rows[0]!.ok, true, "and the next runner must be able to proceed");
  await b.query("ROLLBACK");
});

test("the SESSION-level lock does not exclude here — the evidence that rejected it", async () => {
  /**
   * Kept as a test rather than a comment because it is the whole reason the per-file-transaction
   * invariant was given up. If this ever starts failing — if two clients stop sharing a backend —
   * that is new information about the deployment, not a broken test, and the design should be
   * re-examined rather than the assertion deleted.
   */
  const a = await client();
  const b = await client();
  const SESSION_KEY = "8531207419776003";

  /**
   * ── THE PREMISE, CHECKED BEFORE THE ASSERTION THAT DEPENDS ON IT ───────────────────────────────
   * The hazard here is a property of the POOLER: two logical clients handed the same server backend,
   * so a session-level lock re-enters instead of excluding. On a DIRECT connection each client gets
   * its own backend and the session lock excludes correctly — the assertion below is then false, and
   * the test failed saying "a lock that reports success without excluding anyone", which reads as
   * the design being wrong when it is the connection that is different.
   *
   * Run against the staging endpoint directly (no `-pooler` host) that is exactly what happened. So
   * the premise is now measured rather than assumed: same backend pid means the pooler is
   * multiplexing and the hazard is live; different pids mean it is not, and there is nothing here to
   * assert. Skipping loudly is the same stance `harness.ts` takes on a missing DATABASE_URL — a test
   * that cannot apply must say so, not fail for the wrong reason.
   *
   * The file header's warning stands either way: `migrate.mjs` must not use a session-level lock,
   * because the DEPLOYMENT points at a pooler even when a developer's connection does not.
   */
  const pidOf = async (c: pg.Client) =>
    (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const [pidA, pidB] = [await pidOf(a), await pidOf(b)];
  if (pidA !== pidB) {
    console.log(
      `  ↷ skipped: this connection is not multiplexing (backend pids ${pidA} and ${pidB}). ` +
        "The session-lock hazard only exists behind a pooler that shares a backend; connect through " +
        "the -pooler host to exercise it."
    );
    return;
  }

  await a.query("SELECT pg_advisory_lock($1)", [SESSION_KEY]);
  const held = await b.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [SESSION_KEY]);

  assert.equal(
    held.rows[0]!.ok,
    true,
    "through this pooler a second client shares the backend and re-enters the lock — which is " +
      "exactly why `migrate.mjs` must not use a session-level lock"
  );

  await b.query("SELECT pg_advisory_unlock($1)", [SESSION_KEY]).catch(() => {});
  await a.query("SELECT pg_advisory_unlock($1)", [SESSION_KEY]).catch(() => {});
});

test("the runner uses the transaction-scoped lock, and holds it inside one transaction", () => {
  /**
   * The two tests above assert what the two lock TYPES do. Neither would notice `migrate.mjs`
   * quietly going back to the session-level one — there are normally no pending migrations, so the
   * runner's critical section is never executed by a test at all. This reads the source, which is
   * the only thing that can catch that substitution.
   */
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "platform", "db", "migrate.mjs"),
    "utf8"
  );

  assert.match(source, /pg_advisory_xact_lock/, "the lock must be transaction-scoped");
  assert.doesNotMatch(
    // Comments explain WHY the session-level lock was rejected, so only executable calls count.
    source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
    /pg_advisory_lock\s*\(/,
    "the session-level lock does not exclude through this pooler and must not return"
  );
  assert.match(source, /MIGRATION_LOCK_KEY = '8531207419776002'/, "and every runner must use one key");
});
