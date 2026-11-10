// connect.mjs — the one way an operational script opens a database connection (NEW-04).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// `pool.ts` pins verified TLS for the application. Six scripts did not: migrate.mjs,
// provision-app-role.mjs, verify.mjs, clean-test-data.mjs, encrypt-phi.mjs and
// backfill-ledger-patients.mjs each wrote `new pg.Client({ connectionString })` with no `ssl`
// option, which node-postgres resolves to NO TLS when the URL omits `sslmode` (see tls.mjs).
//
// Those are not incidental processes. They apply schema changes as the owner role, provision the
// application role's password, and read every encrypted PHI column out and back in. The transport
// with the most privilege behind it was the only transport nothing checked.
//
// One connector, so the policy cannot drift between six copies of it — and so the next script
// somebody writes inherits it instead of re-deciding.
import pg from 'pg';
import { connectionOptions } from './tls.mjs';

/**
 * A connected `pg.Client` with the shared TLS policy applied.
 *
 * `extra` is merged UNDER the resolved options, so a caller may set a statement timeout or an
 * application name but cannot override `ssl` — an escape hatch a caller can reach for is not a
 * policy. The local relaxation is available to every script through PGSSLMODE, on the same terms as
 * the pool, which is the point.
 */
export async function connect({ connectionString, ...extra } = {}) {
  if (!connectionString) {
    throw new Error('connect() needs a connectionString — set DATABASE_URL or DATABASE_ADMIN_URL.');
  }
  const client = new pg.Client({ ...extra, ...connectionOptions(connectionString) });
  await client.connect();
  return client;
}

/** The admin connection an operational script wants: DATABASE_ADMIN_URL, else DATABASE_URL. */
export function adminUrl(env = process.env) {
  return env.DATABASE_ADMIN_URL || env.DATABASE_URL || null;
}
