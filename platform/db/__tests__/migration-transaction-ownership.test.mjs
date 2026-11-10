/**
 * The migration runner owns the transaction — and the files must not take it back (NEW-02).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `migrate.mjs` documents, at length, that the whole pending set is applied in ONE transaction, with
 * `pg_advisory_xact_lock` taken inside it, because that is the only lock that excludes a second
 * runner through this deployment's pooler. Eighteen of the twenty migration files then opened
 * `BEGIN;` and closed `COMMIT;` of their own. Multi-statement SQL goes over the simple query
 * protocol, so those ran as written: the FIRST file's `COMMIT` committed the RUNNER's transaction,
 * released the advisory lock, and left every later file running in its own implicit transaction.
 *
 * Both properties the design paid for — mutual exclusion and whole-run atomicity — were absent, and
 * nothing said so, because `BEGIN` inside an open transaction is a warning and not an error.
 *
 * ── WHAT THESE TESTS PIN ─────────────────────────────────────────────────────────────────────────
 * These are the cheap half: the scanner's precision, and the guard that runs on every migrate.
 * `tests/db/migration-runner.test.ts` is the other half — it drives the real runner against a real
 * database to show that the lock actually excludes and that a failing run actually rolls back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTransactionControl } from '../sql-transaction-control.mjs';
import {
  assertRunnerOwnsTransaction,
  loadMigrations,
  reconcileChecksums,
} from '../migrate.mjs';
import { SUPERSEDED_CHECKSUMS } from '../migration-checksum-history.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

test('every migration on disk leaves the transaction to the runner', () => {
  const offenders = loadMigrations(MIGRATIONS_DIR)
    .map((m) => ({ file: m.file, found: findTransactionControl(m.sql) }))
    .filter((x) => x.found.length > 0);

  assert.deepEqual(
    offenders,
    [],
    'a migration that opens its own transaction commits the runner out of ITS transaction, ' +
      'releasing the advisory lock mid-run'
  );
});

test('the guard refuses a migration that manages its own transaction', () => {
  for (const sql of [
    'BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;',
    'CREATE TABLE t (id int);\nCOMMIT;',
    'START TRANSACTION;\nCREATE TABLE t (id int);',
    'CREATE TABLE t (id int);\nSAVEPOINT halfway;',
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nCREATE TABLE t (id int);',
  ]) {
    assert.throws(
      () => assertRunnerOwnsTransaction([{ id: 99, file: '0099_bad.sql', sql }]),
      /transaction control/i,
      `should have been refused: ${JSON.stringify(sql)}`
    );
  }
});

test("the guard does NOT mistake PL/pgSQL's BEGIN for a transaction", () => {
  /**
   * The reason the check is a scanner and not `/^BEGIN/m`. Every one of these appears in the real
   * migrations; a guard that flagged them would have to be turned off, and a guard that is off is
   * not a guard.
   */
  const plpgsql = `
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$;

    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        CREATE ROLE app;
      END IF;
    END
    $do$;

    -- BEGIN; and COMMIT; in a comment are not statements either.
    COMMENT ON TABLE practices IS 'BEGIN; is text here, not control';
  `;
  assert.deepEqual(findTransactionControl(plpgsql), []);
  assert.doesNotThrow(() => assertRunnerOwnsTransaction([{ id: 1, file: 'ok.sql', sql: plpgsql }]));
});

test('an edited migration is still fatal — only the one recorded transition is forgiven', () => {
  const blessed = SUPERSEDED_CHECKSUMS.get(1);
  const file = { id: 1, file: '0001_conventions.sql' };

  assert.throws(
    () => reconcileChecksums([{ ...file, checksum: blessed.to }], new Map([[1, { checksum: 'x' }]])),
    /modified after it was applied/,
    'an unrecognised recorded checksum means an edited migration, never waved through'
  );

  assert.throws(
    () => reconcileChecksums([{ ...file, checksum: 'edited-later' }], new Map([[1, { checksum: blessed.from }]])),
    /modified after it was applied/,
    'and the entry must not license a DIFFERENT replacement than the one it names — otherwise it ' +
      'becomes a permanent hole in the immutability guard for that file'
  );

  const { repairs } = reconcileChecksums(
    [{ ...file, checksum: blessed.to }],
    new Map([[1, { checksum: blessed.from }]])
  );
  assert.deepEqual(
    repairs.map((r) => [r.id, r.from, r.to]),
    [[1, blessed.from, blessed.to]],
    'only the exact recorded transition is repaired in place'
  );
});

test('the blessed replacements are the files as they stand, and name real migrations', () => {
  /**
   * `to` is what makes an entry expire: it pins the post-strip text. Edit any of these eighteen
   * files for some other reason and this fails, telling you to write a new migration — rather than
   * the stale entry quietly blessing the new content too.
   */
  const onDisk = new Map(loadMigrations(MIGRATIONS_DIR).map((m) => [m.id, m]));

  for (const [id, blessed] of SUPERSEDED_CHECKSUMS) {
    const m = onDisk.get(id);
    assert.ok(m, `history names migration ${id}, which does not exist`);
    assert.equal(
      m.checksum,
      blessed.to,
      `${m.file} no longer hashes to the replacement its history entry names. The entry covers ONE ` +
        `transition — if the file needed to change again, that is a new migration.`
    );
    assert.notEqual(blessed.from, blessed.to, `history entry ${id} supersedes nothing`);
  }
});
