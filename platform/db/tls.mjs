// tls.mjs — the ONE decision about how this process connects to Postgres (NEW-03, NEW-04).
//
// ── WHY THIS IS A MODULE AND NOT A LINE IN pool.ts ───────────────────────────────────────────────
// The pool pinned TLS correctly and nothing else did. Six operational scripts — migrate,
// provision-app-role, verify, clean-test-data, encrypt-phi, backfill-ledger-patients — each built
// their own `new pg.Client({ connectionString })` with no `ssl` option at all. Those are the
// processes that run migrations as the OWNER role, read PHI out to re-encrypt it, and provision
// credentials; they had the weakest transport in the system and the strongest privileges.
//
// Plain `.mjs` on purpose, so the scripts can import it without departing from the doctrine that
// keeps them readable by anyone operating the system, and `pool.ts` imports it through `tls.d.mts`.
// One implementation, one policy, one place to be wrong.
//
// ── WHAT node-postgres ACTUALLY DOES WITH THESE TWO SOURCES ──────────────────────────────────────
// node-postgres merges its two sources of `ssl` as
//
//     config = Object.assign({}, config, parse(config.connectionString))
//                                        ^ connection-parameters.js — the URL WINS
//
// Measured against pg 8.22.0:
//
//     ssl:{rejectUnauthorized:true} + `?sslmode=require`    → {}                        (pin DISCARDED)
//     ssl:{rejectUnauthorized:true} + `?sslmode=no-verify`  → {rejectUnauthorized:false} (pin INVERTED)
//     no sslmode at all, no ssl option                      → false                      (NO TLS)
//
// So an `ssl` option passed alongside the raw string is a control that does not control — inert
// today, and silently reversed by a URL that says `no-verify`. `sslmode` is therefore stripped from
// the string first, which is what lets the explicit setting survive the merge.

/**
 * Remove the `sslmode` parameter from a connection string, leaving everything else byte-identical.
 *
 * Textual, and deliberately not `new URL(...).toString()`: re-serialising the URL would re-encode
 * the password, and a percent-encoding that round-trips differently is an authentication failure
 * that looks like an outage. Only the one query parameter is touched.
 */
export function withoutSslMode(connectionString) {
  return connectionString
    .replace(/([?&])sslmode=[^&]*&/i, '$1')
    .replace(/[?&]sslmode=[^&]*$/i, '');
}

/**
 * Loopback addresses, as LITERALS.
 *
 * Deliberately not "a hostname that resolves to loopback". Resolution is asynchronous, which this
 * decision cannot be, and it is influenced by DNS — a name that resolves to 127.0.0.1 today can
 * resolve elsewhere tomorrow, which would turn a development convenience into a way to strip TLS
 * from a real connection. A literal cannot be re-pointed.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/**
 * The host a connection string names, lower-cased, or null when it names none.
 *
 * A connection string with no host at all (`postgres:///db`, a bare socket path) is NOT treated as
 * local. It could be a socket, but "could be" is not the standard for switching encryption off.
 */
export function hostOf(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when this connection string names a loopback literal. */
export function isLoopback(connectionString) {
  const host = hostOf(connectionString);
  return host !== null && LOOPBACK.has(host);
}

/**
 * The `ssl` option for a connection: verified TLS, or `false` for the local escape hatch.
 *
 * ── WHY AN ESCAPE HATCH EXISTS AT ALL ────────────────────────────────────────────────────────────
 * The pin was unconditional, and two documented paths have no TLS to verify: CI's `postgres:16`
 * service container (`postgres://mermaid:mermaid@localhost:5432/mermaid_test`) and the
 * docker-compose instance this repository tells developers to run for the inner loop. Against
 * either, an unconditional pin does not fail closed in a useful way — it fails the whole suite on
 * every machine, and the pressure that produces is pressure to remove the pin.
 *
 * ── WHY IT TAKES TWO KEYS TO TURN ────────────────────────────────────────────────────────────────
 * Both conditions must hold, and neither alone is enough:
 *
 *   • `PGSSLMODE=disable` — someone has SAID so, in an environment variable, on purpose. A
 *     connection string that merely omits `sslmode` does not qualify; that is the shape of an
 *     oversight, and it is exactly how the "no sslmode, no ssl option → no TLS" row above happens
 *     by accident.
 *   • the host is a loopback LITERAL — traffic that never leaves the machine. Unencrypted Postgres
 *     over a network carries the password and every row of PHI in clear text; there is no
 *     environment variable that should be able to authorise that.
 *
 * A remote host with `PGSSLMODE=disable` therefore still gets verified TLS. It fails safe rather
 * than honouring the request, because the alternative is a variable in a deployment's environment
 * silently downgrading production.
 */
export function resolveTls(connectionString, env = process.env) {
  const disabled = (env.PGSSLMODE ?? '').trim().toLowerCase() === 'disable';
  if (disabled && isLoopback(connectionString)) return false;
  return { rejectUnauthorized: true };
}

/**
 * The full `pg` client/pool options for a connection string, with TLS decided.
 *
 * `sslmode` is stripped so the resolved `ssl` survives node-postgres's merge (see the header).
 */
export function connectionOptions(connectionString, env = process.env) {
  return {
    connectionString: withoutSslMode(connectionString),
    ssl: resolveTls(connectionString, env),
  };
}
