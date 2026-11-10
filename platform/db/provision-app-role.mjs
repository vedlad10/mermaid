// provision-app-role.mjs — create the unprivileged application role that RLS actually applies to.
//
// WHY THIS EXISTS. Managed Postgres hands you an owner role, and on several hosts (Neon, Supabase)
// that role carries BYPASSRLS. Migration 0002 FORCEs row-level security, which subjects the table
// OWNER to it — but a BYPASSRLS role ignores RLS entirely, so tenant isolation cannot be proven, or
// enforced, while the application connects as that role.
//
// So the production shape is two roles, and it is not optional for a multi-tenant deployment:
//
//   DATABASE_ADMIN_URL → the owner. Runs migrations (DDL). The app never holds this.
//   DATABASE_URL       → this role. LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE.
//                        DML only, and fully subject to every tenant policy.
//
// Idempotent: safe to re-run. Re-running rotates nothing unless --rotate is passed.
//
// Usage:  DATABASE_ADMIN_URL=... node platform/db/provision-app-role.mjs [--rotate]
import { connect } from './connect.mjs';
import { randomBytes } from "node:crypto";

const APP_ROLE = process.env.APP_DB_ROLE || "mermaid_app";
const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

if (!adminUrl) {
  console.error("FATAL: set DATABASE_ADMIN_URL (or DATABASE_URL) to an owner/admin connection string.");
  process.exit(1);
}

/**
 * URL-safe password — it has to survive being embedded in a connection string.
 *
 * `APP_DB_PASSWORD` overrides generation, which is what an automated environment needs: CI has to
 * know the password in advance to build DATABASE_URL. Interactively, leave it unset and let a random
 * one be generated and printed once.
 */
const newPassword = () => process.env.APP_DB_PASSWORD || randomBytes(24).toString("base64url");

const client = await connect({ connectionString: adminUrl });

try {
  const me = (await client.query(
    "SELECT current_user AS role, current_database() AS db, rolcreaterole FROM pg_roles WHERE rolname = current_user"
  )).rows[0];
  if (!me.rolcreaterole) {
    throw new Error(
      `role "${me.role}" lacks CREATEROLE, so it cannot provision the application role. ` +
        `Run this as an admin, or create "${APP_ROLE}" by hand using the statements in this file.`
    );
  }

  const existing = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE])).rowCount;
  // An explicit password is always (re)applied, so a re-run converges on the configured value
  // rather than leaving a stale one behind.
  const rotate = process.argv.includes("--rotate") || Boolean(process.env.APP_DB_PASSWORD);
  let password = null;

  if (!existing) {
    password = newPassword();
    // Explicit negatives: every one of these is a way to accidentally bypass or subvert RLS.
    await client.query(
      `CREATE ROLE ${quoteIdent(APP_ROLE)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteLiteral(password)}`
    );
    console.log(`✔ created role ${APP_ROLE} (NOSUPERUSER, NOBYPASSRLS)`);
  } else if (rotate) {
    password = newPassword();
    await client.query(`ALTER ROLE ${quoteIdent(APP_ROLE)} PASSWORD ${quoteLiteral(password)}`);
    console.log(`✔ rotated password for ${APP_ROLE}`);
  } else {
    console.log(`• role ${APP_ROLE} already exists (pass --rotate to issue a new password)`);
  }

  // Defensive: an existing role may predate this script, or have been altered since.
  //
  // Only the attributes that are actually WRONG are altered. Re-asserting a correct value is not
  // free: `ALTER ROLE ... NOSUPERUSER` is rejected outright unless the caller is a superuser, even
  // when the role is already NOSUPERUSER. Under a managed host's owner role (which is never a
  // superuser) an unconditional ALTER therefore fails on a correctly-provisioned role.
  const attrs = (await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
    [APP_ROLE]
  )).rows[0];
  const corrections = [
    attrs.rolsuper ? "NOSUPERUSER" : null,
    attrs.rolbypassrls ? "NOBYPASSRLS" : null,
    attrs.rolcreatedb ? "NOCREATEDB" : null,
    attrs.rolcreaterole ? "NOCREATEROLE" : null,
  ].filter(Boolean);
  if (corrections.length > 0) {
    console.log(`• correcting ${APP_ROLE}: ${corrections.join(" ")}`);
    await client.query(`ALTER ROLE ${quoteIdent(APP_ROLE)} ${corrections.join(" ")}`);
  }

  // Connect + schema usage.
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(me.db)} TO ${quoteIdent(APP_ROLE)}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)}`);

  // DML on everything that exists now…
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdent(APP_ROLE)}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(APP_ROLE)}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${quoteIdent(APP_ROLE)}`);

  // …and on everything this owner creates later, so a future migration needs no follow-up grant.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(APP_ROLE)}`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(APP_ROLE)}`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${quoteIdent(APP_ROLE)}`
  );

  // NEVER granted: CREATE on the schema, or any DDL. The application must not be able to drop a
  // policy, alter a table, or create one.
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdent(APP_ROLE)}`);

  /**
   * …EXCEPT the audit trail, which is append-only and must stay that way.
   *
   * ── WHY THIS REVOKE EXISTS ───────────────────────────────────────────────────────────────────
   * `0003_core_tenancy.sql` states that "the app role is granted no direct DML on this table (see
   * ops role setup)". That was not true of this file: the blanket `ON ALL TABLES` grant above
   * swept `audit_events` up with everything else. Probing staging as `mermaid_app` confirmed it held
   * INSERT, UPDATE and DELETE here.
   *
   * The revoke lives in this file rather than in a migration or a one-off console command because
   * the blanket grant above re-runs on every provisioning pass and would re-grant what a manual
   * revoke had removed. Ordering it after the grant is what makes this idempotent.
   *
   * The trail was nevertheless intact, because `audit_events` is the one tenant table with no
   * `FOR ALL` policy — only `audit_read FOR SELECT` — and Postgres default-denies any command that
   * no policy covers. So a single mechanism was holding the line, and the documented one was not
   * it.
   *
   * That is a fragile place to leave a HIPAA §164.312(b) control. Every other tenant table gets
   * its policy from `enable_tenant_rls()`, which creates `FOR ALL … WITH CHECK`. Applying that
   * helper to `audit_events` — the obvious "make it consistent with the others" tidy-up — would
   * have silently activated the grants underneath and let the application rewrite its own audit
   * trail within its own tenant. One line, no error, no test failure.
   *
   * Revoking makes the two mechanisms independent: the grant is gone AND no policy admits the
   * write. Either alone refuses; a mistake has to be made twice to matter.
   *
   * SELECT is retained: `audit_read` scopes reads to the practice, and the product shows people
   * their own activity trail. INSERT arrives through `record_audit()`, a SECURITY DEFINER function
   * owned by the migration role, which is unaffected by a revoke on the table.
   */
  /**
   * ── AND WHY IT HAS TO TOLERATE THE TABLE NOT BEING THERE YET (CI) ────────────────────────────
   *
   * This script has to run BEFORE migrations — `ALTER DEFAULT PRIVILEGES` only covers objects
   * created after it, which is the whole reason the grants above are set first and why the CI
   * workflow orders it that way. But `audit_events` is created BY a migration, so on a database
   * that has never been migrated this statement is the one thing here that cannot succeed.
   *
   * On a laptop and on staging the table already exists, so the contradiction never showed. In CI,
   * where every run starts from an empty Postgres, it failed every time: `relation "audit_events"
   * does not exist`, at this line, before a single test had run.
   *
   * The resolution is not to skip the revoke — it is a HIPAA §164.312(b) control and skipping it
   * silently is how it stops being one. It is to recognise that provisioning a fresh database is
   * inherently TWO passes, which `DEPLOYING.md` already tells operators ("re-run db:provision-role
   * after every migration"), and to make the first pass say plainly that the guarantee is not in
   * place yet rather than printing a tick it has not earned.
   */
  const auditExists = (await client.query("SELECT to_regclass('public.audit_events') IS NOT NULL AS present"))
    .rows[0].present;
  if (auditExists) {
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_events FROM ${quoteIdent(APP_ROLE)}`);
  }
  /**
   * The read trail (0037) gets the same treatment, for the same reason: written only through
   * `record_phi_access`, never edited. RLS already refuses the app role's direct writes (the table
   * has a SELECT policy and nothing else); revoking the grant makes that two locks, not one.
   */
  const accessTrailExists = (
    await client.query("SELECT to_regclass('public.phi_access_events') IS NOT NULL AS present")
  ).rows[0].present;
  if (accessTrailExists) {
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON phi_access_events FROM ${quoteIdent(APP_ROLE)}`);
  }

  const check = (await client.query(
    "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
    [APP_ROLE]
  )).rows[0];
  if (check.rolsuper || check.rolbypassrls) {
    throw new Error(`${APP_ROLE} still bypasses RLS — refusing to report success.`);
  }
  console.log(`✔ ${APP_ROLE}: superuser=${check.rolsuper} bypassrls=${check.rolbypassrls} — subject to RLS`);

  /**
   * The append-only guarantee, asserted rather than assumed.
   *
   * The `rolbypassrls` check above refuses to report success on a role that could read past tenant
   * scope; this is the same refusal for a role that could rewrite the audit trail. Both exist
   * because this script's output is the only place anyone looks to confirm the database is set up
   * correctly, and a provisioner that prints a tick it has not earned is worse than none.
   */
  if (!auditExists) {
    /**
     * Loud, and not a tick. An empty grant list on a table that does not exist is not the
     * append-only guarantee — it is the absence of a table, and reporting the two identically is
     * exactly the "prints a tick it has not earned" failure this block exists to prevent.
     */
    console.log(
      `• audit_events does not exist yet, so the append-only revoke has NOT been applied.
` +
        `  This is the expected first pass on a fresh database: the default privileges above must be
` +
        `  set before the migrations that create the tables. Run the migrations, then run this again —
` +
        `  the second pass is what makes the audit trail append-only.`
    );
  } else {
    const auditDml = (await client.query(
      `SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) AS held
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name = 'audit_events'
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
      [APP_ROLE]
    )).rows[0];
    if (auditDml?.held) {
      throw new Error(
        `${APP_ROLE} still holds ${auditDml.held} on audit_events — the trail is not append-only. Refusing to report success.`
      );
    }
    console.log(`✔ ${APP_ROLE}: no INSERT/UPDATE/DELETE/TRUNCATE on audit_events — trail is append-only`);
  }
  // The read trail (0037), verified the same way once it exists. Before its migration there is
  // nothing to verify, and this says so rather than printing a tick it has not earned.
  if (!accessTrailExists) {
    console.log("• phi_access_events not created yet — re-run after migrating to verify the read trail is append-only");
  } else {
    const accessDml = (await client.query(
      `SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) AS held
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name = 'phi_access_events'
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
      [APP_ROLE]
    )).rows[0];
    if (accessDml?.held) {
      throw new Error(
        `${APP_ROLE} still holds ${accessDml.held} on phi_access_events — the read trail is not append-only. Refusing to report success.`
      );
    }
    console.log(`✔ ${APP_ROLE}: no INSERT/UPDATE/DELETE/TRUNCATE on phi_access_events — read trail is append-only`);
  }

  if (password && !process.env.APP_DB_PASSWORD) {
    // Printed once. The caller writes it into DATABASE_URL; it is not stored anywhere by this
    // script. Suppressed when the password came from the environment — it is already known there,
    // and echoing it would put a live credential into CI logs.
    console.log(`\nPASSWORD=${password}`);
  }
} finally {
  await client.end();
}

/** Quote an identifier for interpolation (role/db names are not parameterizable). */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** Quote a string literal — used only for the generated password. */
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
