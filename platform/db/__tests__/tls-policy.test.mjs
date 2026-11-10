/**
 * The TLS decision, and who is allowed to relax it (NEW-03, NEW-04).
 *
 * ── THE TWO THINGS THAT WERE WRONG ───────────────────────────────────────────────────────────────
 * 1. The pool pinned `{ rejectUnauthorized: true }` UNCONDITIONALLY. CI runs a `postgres:16`
 *    service container and this repository's own docker-compose runs another, and neither speaks
 *    TLS — so the pin did not fail closed in any useful sense. It failed the whole live suite on
 *    every machine, which is the kind of control people delete.
 *
 * 2. Six operational scripts had no `ssl` option at all. node-postgres resolves that to NO TLS when
 *    the URL omits `sslmode`, so migrate (owner role, applies DDL), provision-app-role (writes the
 *    application password) and encrypt-phi (reads every encrypted column out and back in) had the
 *    weakest transport in the system behind the strongest privileges.
 *
 * These tests hold the escape hatch to two keys and pin the fact that every script turns them the
 * same way — the property that decays first once there are six copies of a policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionOptions, hostOf, isLoopback, resolveTls, withoutSslMode } from '../tls.mjs';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const NEON = 'postgresql://mermaid_app:pw@ep-REDACTED.REGION.aws.neon.tech/neondb?sslmode=require';
const CI = 'postgres://mermaid_app:ci-app-password@localhost:5432/mermaid_test';
const COMPOSE = 'postgres://mermaid_app:local-app-password@localhost:5433/mermaid_dev';

test('with no PGSSLMODE at all, everything gets verified TLS', () => {
  for (const url of [NEON, CI, COMPOSE, 'postgres://u:p@127.0.0.1:5432/db']) {
    assert.deepEqual(resolveTls(url, {}), { rejectUnauthorized: true }, url);
  }
});

test('the escape hatch needs BOTH keys — the variable and a loopback literal', () => {
  const disable = { PGSSLMODE: 'disable' };

  // Both: the documented local paths, which is the whole reason the hatch exists.
  assert.equal(resolveTls(CI, disable), false, "CI's service container speaks no TLS");
  assert.equal(resolveTls(COMPOSE, disable), false, 'nor does docker-compose');

  // One without the other, in each direction.
  assert.deepEqual(
    resolveTls(NEON, disable),
    { rejectUnauthorized: true },
    'a REMOTE host with PGSSLMODE=disable still gets verified TLS. Unencrypted Postgres over a ' +
      'network carries the password and every row of PHI in clear text, and no environment ' +
      'variable should be able to authorise that — it fails safe rather than honouring the request.'
  );
  assert.deepEqual(
    resolveTls(CI, {}),
    { rejectUnauthorized: true },
    'and a local host alone is not enough: a connection string that merely omits sslmode is the ' +
      'shape of an OVERSIGHT, which is exactly how "no TLS" happens by accident'
  );
});

test('only a loopback LITERAL counts — never a name that resolves to one', () => {
  /**
   * Deliberately not "does this hostname resolve to 127.0.0.1". Resolution is asynchronous, which
   * this decision cannot be, and it is influenced by DNS — a name pointing at loopback today can
   * point elsewhere tomorrow, turning a development convenience into a way to strip TLS off a real
   * connection. A literal cannot be re-pointed.
   */
  assert.equal(isLoopback('postgres://u:p@localhost:5432/db'), true);
  assert.equal(isLoopback('postgres://u:p@127.0.0.1:5432/db'), true);
  assert.equal(isLoopback('postgres://u:p@[::1]:5432/db'), true);

  assert.equal(isLoopback('postgres://u:p@localhost.evil.example:5432/db'), false);
  assert.equal(isLoopback('postgres://u:p@db.internal:5432/db'), false);
  assert.equal(isLoopback('postgres://u:p@10.0.0.5:5432/db'), false, 'private is not loopback');

  // A string naming no host at all could be a unix socket. "Could be" is not the standard for
  // switching encryption off.
  assert.equal(isLoopback('postgres:///mermaid_dev'), false);
  assert.equal(hostOf('not a url at all'), null);
  assert.equal(isLoopback('not a url at all'), false);
});

test('sslmode is stripped so the resolved setting survives node-postgres’s merge', () => {
  /**
   * node-postgres merges as `Object.assign({}, config, parse(config.connectionString))` — the URL
   * wins. An `ssl` option passed alongside a raw string is inert when the URL sets `sslmode`, and
   * REVERSED when it says `no-verify`. Stripping is what makes the option mean anything.
   */
  const opts = connectionOptions(NEON, {});
  assert.equal(opts.connectionString.includes('sslmode'), false);
  assert.deepEqual(opts.ssl, { rejectUnauthorized: true });

  const noVerify = connectionOptions('postgres://u:p@h/db?sslmode=no-verify', {});
  assert.equal(noVerify.connectionString.includes('sslmode'), false, 'a URL may not opt out');
  assert.deepEqual(noVerify.ssl, { rejectUnauthorized: true });
});

test('the credential is never re-encoded — only the one parameter is touched', () => {
  /**
   * The reason this is textual rather than `new URL(...).toString()`. A password carrying reserved
   * characters round-trips through URL serialisation with different percent-encoding, and the
   * resulting failure is an authentication error that looks like the database is down.
   */
  assert.equal(
    withoutSslMode('postgres://mermaid_app:p%40ss%2Fw0rd%3A%21@ep-x.aws.neon.tech:5432/db?sslmode=require'),
    'postgres://mermaid_app:p%40ss%2Fw0rd%3A%21@ep-x.aws.neon.tech:5432/db'
  );
  assert.equal(
    withoutSslMode('postgres://u:p@h/db?a=1&sslmode=verify-full&b=2'),
    'postgres://u:p@h/db?a=1&b=2'
  );
});

test('no operational script builds its own connection any more', () => {
  /**
   * The regression that actually happened: `pool.ts` was pinned and six scripts were not, because
   * nothing tied them together. This is what ties them together — a new script that reaches for
   * `new pg.Client({ connectionString })` fails here rather than in a year, silently, in transit.
   */
  const offenders = [];
  for (const file of readdirSync(DB_DIR).filter((f) => f.endsWith('.mjs'))) {
    // The connector and the policy are where the construction is SUPPOSED to happen.
    if (file === 'connect.mjs' || file === 'tls.mjs') continue;
    const source = readFileSync(join(DB_DIR, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    if (/new\s+pg\.(Client|Pool)\s*\(/.test(code) && !/connectionOptions\s*\(/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these build a raw connection with no TLS policy — use connect() from ./connect.mjs, or ' +
      'connectionOptions() from ./tls.mjs for a Pool'
  );
});
