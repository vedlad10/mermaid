// verify.mjs — live smoke test of the P1 foundation against a real Postgres.
// Run AFTER `npm run migrate`:  npm run db:verify
//
// Proves the guarantees that unit tests cannot (they have no database):
//   0. The connecting ROLE can actually be subject to RLS.
//   1. RLS tenant isolation — practice A cannot see practice B's rows.
//   2. Write-side isolation — practice A cannot INSERT a row belonging to practice B.
//   3. Fail-closed — with no practice context, tenant tables return nothing and reject writes.
//   4. Auth-lookup bypass — find_user_for_auth finds the row pre-context (so login can work).
//   5. Append-only audit via record_audit.
//
// EVERY step runs inside an explicit transaction. That is not incidental: `set_current_practice`
// uses `set_config(..., true)`, which is TRANSACTION-LOCAL, so a practice set outside a transaction
// is gone by the next statement. Transaction scoping is also mandatory rather than merely tidy under
// a transaction-pooling proxy (PgBouncer, Neon's `-pooler` endpoint), where consecutive statements
// may land on different backend connections — a session-level context would leak between tenants.
// This mirrors `withPractice` in pool.ts exactly; if the two ever diverge, this file is wrong.
import { connect } from "./connect.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("SKIP: DATABASE_URL not set — provide a managed Postgres URL to verify P1 live.");
  process.exit(2);
}

/** Verified TLS via the shared policy — this script reads every tenant table (NEW-04). */
const client = await connect({ connectionString: url });
const fail = (m) => { throw new Error(m); };
let pA, pB;

/**
 * Run `fn` in a transaction, optionally under a practice context.
 * `practiceId === null` explicitly clears the context (the pre-auth boundary).
 */
async function inTx(practiceId, fn) {
  await client.query("BEGIN");
  try {
    if (practiceId !== undefined) {
      await client.query("SELECT set_current_practice($1)", [practiceId]);
    }
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Assert that `fn` is rejected by the database, and that it is rejected for the RIGHT reason. */
async function expectRejected(label, practiceId, fn, codes) {
  try {
    await inTx(practiceId, fn);
  } catch (e) {
    if (!codes.includes(e.code)) {
      fail(`${label}: rejected, but with SQLSTATE ${e.code} (${e.message}) rather than ${codes.join("/")}`);
    }
    return;
  }
  fail(`${label}: the database ALLOWED it`);
}

/**
 * Step 0 — role capability preflight.
 *
 * Migration 0002 FORCEs row-level security, which makes even the table OWNER subject to it. But a
 * SUPERUSER or a role with BYPASSRLS still bypasses RLS entirely. Under such a role every isolation
 * check below fails, and the failure reads as "RLS LEAK" — which looks like a defect in the schema
 * when it is in fact a misconfigured connection. This check turns a confusing hour into one line.
 *
 * A tenant-isolation proof run as a superuser is not a weaker proof; it is not a proof at all.
 */
async function preflightRole() {
  const { rows } = await client.query(
    `SELECT current_user AS role,
            current_database() AS db,
            rolsuper     AS is_superuser,
            rolbypassrls AS bypasses_rls
       FROM pg_roles WHERE rolname = current_user`
  );
  const r = rows[0];
  if (!r) fail("cannot read privileges for the current role");
  console.log(`  role=${r.role} db=${r.db} superuser=${r.is_superuser} bypassrls=${r.bypasses_rls}`);

  if (r.is_superuser || r.bypasses_rls) {
    fail(
      `the connecting role "${r.role}" ${r.is_superuser ? "is a SUPERUSER" : "has BYPASSRLS"}, so it ignores row-level ` +
        `security entirely. Tenant isolation CANNOT be proven under this role — any result below would be meaningless.\n\n` +
        `    Fix: provision an unprivileged application role and point DATABASE_URL at it:\n` +
        `      DATABASE_ADMIN_URL=<owner-url> npm run db:provision-role\n`
    );
  }
}

try {
  await preflightRole();

  // Two throwaway practices. `practices` is the tenant ROOT and carries no RLS of its own.
  [pA, pB] = await inTx(undefined, async () => [
    (await client.query("INSERT INTO practices (name) VALUES ('verify-A') RETURNING id")).rows[0].id,
    (await client.query("INSERT INTO practices (name) VALUES ('verify-B') RETURNING id")).rows[0].id,
  ]);

  // A patient in each, each under its own practice context.
  const patA = await inTx(pA, async () =>
    (await client.query(
      "INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob) VALUES ($1,'V-A','Ada','Alpha','1990-01-01') RETURNING id",
      [pA]
    )).rows[0].id
  );
  await inTx(pB, () =>
    client.query(
      "INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob) VALUES ($1,'V-B','Ben','Beta','1990-01-01')",
      [pB]
    )
  );

  // (1) Read isolation: under A, B's patient is invisible; A's own is visible.
  const seenFromA = await inTx(pA, async () =>
    (await client.query("SELECT chart_id FROM patients")).rows.map((r) => r.chart_id)
  );
  if (!seenFromA.includes("V-A")) fail("RLS: practice A cannot see its own patient");
  if (seenFromA.includes("V-B")) fail("RLS LEAK: practice A can see practice B's patient");

  // (2) Write isolation: under A, writing a row tagged for B is refused by the policy's WITH CHECK.
  // A read-only proof is only half of tenant isolation — cross-tenant WRITES are the worse failure.
  await expectRejected(
    "RLS write isolation",
    pA,
    () =>
      client.query(
        "INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob) VALUES ($1,'V-X','Mal','Icious','1990-01-01')",
        [pB]
      ),
    ["42501"] // insufficient_privilege — RLS WITH CHECK violation
  );

  // …and A cannot UPDATE B's row into visibility either.
  const updatedOtherTenant = await inTx(pA, async () =>
    (await client.query("UPDATE patients SET first_name = 'Hacked' WHERE chart_id = 'V-B'")).rowCount
  );
  if (updatedOtherTenant !== 0) fail(`RLS LEAK: practice A updated ${updatedOtherTenant} of practice B's rows`);

  // (3) Fail-closed: no practice context → no tenant rows, and no tenant writes.
  const seenNoCtx = await inTx(null, async () =>
    (await client.query("SELECT count(*)::int AS n FROM patients")).rows[0].n
  );
  if (seenNoCtx !== 0) fail(`fail-closed violated: ${seenNoCtx} patient rows visible with no practice context`);

  await expectRejected(
    "fail-closed write",
    null,
    () =>
      client.query(
        "INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob) VALUES ($1,'V-Y','No','Context','1990-01-01')",
        [pA]
      ),
    ["42501"]
  );

  // (4) Auth-lookup bypass: seed a user under A, then find it with NO practice context.
  // Login has a genuine chicken-and-egg problem — you cannot set the practice context until you
  // know which practice the user belongs to. A SECURITY DEFINER function is the narrow, audited
  // hole that solves it without opening the table itself.
  await inTx(pA, () =>
    client.query(
      "INSERT INTO staff_users (practice_id, email, name, role, password_hash) VALUES ($1,'verify-user@a.example','V User','biller','x')",
      [pA]
    )
  );
  const { found, directNoCtx } = await inTx(null, async () => ({
    found: (await client.query("SELECT * FROM find_user_for_auth('verify-user@a.example')")).rows,
    directNoCtx: (await client.query("SELECT count(*)::int AS n FROM staff_users")).rows[0].n,
  }));
  if (found.length !== 1 || found[0].practice_id !== pA) {
    fail("auth lookup: find_user_for_auth did not return the seeded user pre-context");
  }
  if (directNoCtx !== 0) fail("staff_users leaked with no context outside the auth-lookup function");

  // (5) Append-only audit writer works, and its rows are themselves tenant-scoped.
  await inTx(undefined, () =>
    client.query("SELECT record_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      pA, "00000000-0000-0000-0000-000000000001", null, "biller",
      "verify", "patient", patA, null, null, "success", "127.0.0.1",
    ])
  );
  const audited = await inTx(pA, async () =>
    (await client.query("SELECT count(*)::int AS n FROM audit_events WHERE action='verify'")).rows[0].n
  );
  if (audited < 1) fail("record_audit did not append an audit event");

  const auditFromB = await inTx(pB, async () =>
    (await client.query("SELECT count(*)::int AS n FROM audit_events WHERE action='verify'")).rows[0].n
  );
  if (auditFromB !== 0) fail("RLS LEAK: practice B can see practice A's audit events");

  console.log("✔ P1 live verification PASSED");
  console.log("  · RLS read isolation      — A cannot see B's rows");
  console.log("  · RLS write isolation     — A cannot insert or update rows belonging to B");
  console.log("  · fail-closed             — no practice context ⇒ no reads, no writes");
  console.log("  · auth-lookup bypass      — find_user_for_auth works pre-context, table stays sealed");
  console.log("  · append-only audit       — record_audit writes, and audit rows are tenant-scoped");
} catch (e) {
  console.error("✖ P1 live verification FAILED:", e.message);
  process.exitCode = 1;
} finally {
  /**
   * Cleanup (best effort): tenant rows under their own context, then the practices.
   *
   * ── AUDIT ROWS ARE DELIBERATELY NOT DELETED HERE ───────────────────────────────────────────
   * This block used to begin `DELETE FROM audit_events`, and it worked — because the application
   * role held DELETE on the audit trail, which is precisely the drift `provision-app-role.mjs`
   * exists to prevent and which readiness now reports as `audit_trail_append_only`. With the revoke
   * restored, that statement is refused, and because the whole cleanup sat in one `try` the refusal
   * took the rest of it down with it: `verify-A` and `verify-B` were left behind on every run.
   *
   * So the statement is gone rather than caught. An append-only trail is append-only for this role,
   * including when this role would find it convenient — there is no version of this script that gets
   * to be the exception. The rows it leaves are tenant-scoped and orphaned, and
   * `npm run db:clean-tests` sweeps them under `DATABASE_ADMIN_URL`, which is the credential that
   * legitimately can.
   *
   * Each step is also isolated now. A cleanup where one failure silently cancels four others is how
   * litter accumulates without anybody seeing an error for it.
   */
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      console.error(`cleanup warning (${what}):`, e.message);
    }
  };
  for (const p of [pA, pB].filter(Boolean)) {
    await attempt(`staff_users ${p}`, () => inTx(p, () => client.query("DELETE FROM staff_users WHERE practice_id = $1", [p])));
    await attempt(`patients ${p}`, () => inTx(p, () => client.query("DELETE FROM patients WHERE practice_id = $1", [p])));
  }
  for (const p of [pA, pB].filter(Boolean)) {
    await attempt(`practice ${p}`, () => inTx(undefined, () => client.query("DELETE FROM practices WHERE id = $1", [p])));
  }
  await client.end();
}
