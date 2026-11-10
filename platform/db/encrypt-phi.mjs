// encrypt-phi.mjs — backfill: encrypt the raw-PHI columns of rows written before PHI_ENCRYPTION_KEY
// existed (M10).
//
// WHY THIS IS A SEPARATE STEP. `decryptPhi` passes through anything that is not already an envelope,
// so enabling encryption is a deploy with no maintenance window: new writes are encrypted, old rows
// keep reading. That is the right trade — but it leaves history in the clear, and history is exactly
// what a stolen backup contains. This closes that, on your schedule rather than the deploy's.
//
// SAFE TO RUN REPEATEDLY. Every value is checked with `isEncrypted` first, so a second run is a no-op
// and an interrupted run resumes. It is also safe to run while the app is up: each row is read and
// rewritten in its own statement, and the app never reads a column it did not write.
//
// ── AND SINCE NEW-25, IT ALSO RE-BINDS ────────────────────────────────────────────────────────
// The envelope gained a second version. `v1:` is authenticated but UNBOUND — it proves a ciphertext
// was not altered and says nothing about where it belongs, so a value could be copied from one
// patient's row to another's and would decrypt perfectly there. `v2:` binds practice, table, column
// and row into the additional authenticated data, so a moved value fails its tag check.
//
// Every new write is `v2:`. Existing `v1:` rows cannot be upgraded without decrypting and
// re-encrypting them, which touches live PHI and needs the key — an operator's decision on a
// schedule, not something a deploy does silently. `--rebind` is that operation.
//
// ⚠ UNTIL `--rebind` HAS RUN, rows still carrying `v1:` remain movable. That is the residual, and
// `--dry` counts it so it is a number somebody can see rather than a footnote.
//
// Usage:
//   PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi              apply (plaintext → v2)
//   PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi -- --dry     report what would change, touch nothing
//   PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi -- --rebind  ALSO upgrade v1 → v2 (row-bound)
//
// Connects as DATABASE_ADMIN_URL when set (this is maintenance, not application traffic) and
// therefore bypasses RLS deliberately: a backfill that could only see one tenant would be useless.
import { connect } from './connect.mjs';
import { decryptPhi, encryptPhi, isEncrypted, isRowBound, phiEncryptionEnabled } from '../crypto/src/phi.ts';

const DRY = process.argv.includes('--dry');
const REBIND = process.argv.includes('--rebind');
const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('FATAL: set DATABASE_URL (or DATABASE_ADMIN_URL).');
  process.exit(1);
}
if (!phiEncryptionEnabled()) {
  console.error('FATAL: PHI_ENCRYPTION_KEY is not set — there is nothing to encrypt with.');
  console.error('Generate one: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"');
  process.exit(1);
}

/**
 * Every place raw PHI is stored.
 *
 * `column` targets are plain TEXT. `jsonPath` targets live inside an aggregate document, which is
 * why each is rewritten with `jsonb_set` rather than by replacing the whole document: rewriting the
 * document from JavaScript would risk a concurrent update being lost, and would drag every
 * snapshot_version concern into a maintenance script that has no business knowing about them.
 */
const TARGETS = [
  { table: 'verifications', jsonPath: ['cardText'], bindColumn: 'cardText', label: 'insurance card text' },
  { table: 'verifications', jsonPath: ['raw271'], bindColumn: 'raw271', label: 'payer 271' },
  { table: 'claims', jsonPath: ['submission', 'raw837'], bindColumn: 'raw837', label: 'filed 837' },
  { table: 'remittances', column: 'raw_835', bindColumn: 'raw_835', label: 'raw 835 (column)' },
  { table: 'remittances', jsonPath: ['raw835'], bindColumn: 'record.raw835', label: 'raw 835 (document)' },
  { table: 'era_sources', column: 'credential', bindColumn: 'credential', label: 'clearinghouse credential' },
];

/**
 * The location a value at this target belongs to (NEW-25).
 *
 * MUST match what the repository computes, element for element — the binding is a string comparison
 * with extra steps, and a `bindColumn` that disagrees by one character produces ciphertext the
 * application cannot read. `bindColumn` is written out per target rather than derived from the JSON
 * path for exactly that reason: `record.raw835` and `raw_835` are two different places holding the
 * same 835, and they are deliberately not interchangeable.
 */
const locationOf = (target, row) => ({
  practiceId: row.practice_id,
  table: target.table,
  column: target.bindColumn,
  rowId: row.id,
});

/**
 * What has to happen to one stored value: nothing, encrypt it, or re-bind it.
 *
 * `unbound` is only actionable with `--rebind`, and it is COUNTED either way — the point of the dry
 * run is to be able to say how many rows are still movable, which is the residual this whole
 * version bump leaves behind until somebody schedules the maintenance.
 */
function actionFor(value) {
  if (isRowBound(value)) return 'bound';
  if (isEncrypted(value)) return 'unbound';
  return 'plaintext';
}

/** Plaintext → bound, or v1 → bound. Returns null when there is nothing to do. */
function rebound(value, at) {
  const action = actionFor(value);
  if (action === 'bound') return null;
  if (action === 'unbound') {
    if (!REBIND) return null;
    // Decrypted with NO location — a v1 value has none, which is the thing being fixed.
    return encryptPhi(decryptPhi(value), at);
  }
  return encryptPhi(value, at);
}

/**
 * One target's line of the report.
 *
 * `unbound` is called out separately and by name, because it is the residual this whole version
 * bump leaves behind: those rows ARE encrypted — a stolen backup is still inert — but their
 * ciphertext is not tied to the row it sits in, so it could be moved between patients or between
 * practices without anything noticing. Folding it into "encrypted" would hide exactly the number
 * somebody needs to decide when to schedule `--rebind`.
 */
function report(where, label, changed, unbound, total) {
  const verb = DRY ? 'would be' : '';
  const bindNote =
    unbound > 0 && !REBIND
      ? ` — ${unbound} still UNBOUND (v1); run with --rebind to tie ${unbound === 1 ? 'it' : 'them'} to ${unbound === 1 ? 'its' : 'their'} row`
      : '';
  console.log(`  ${where} (${label}): ${changed} of ${total} ${verb} rewritten${bindNote}`);
}

async function backfillColumn(client, target) {
  const { table, column, label } = target;
  const { rows } = await client.query(
    `SELECT id, practice_id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`
  );
  let changed = 0;
  let unbound = 0;
  for (const row of rows) {
    if (actionFor(row.value) === 'unbound') unbound += 1;
    const next = rebound(row.value, locationOf(target, row));
    if (next === null) continue;
    changed += 1;
    if (DRY) continue;
    await client.query(`UPDATE ${table} SET ${column} = $2 WHERE id = $1`, [row.id, next]);
  }
  report(`${table}.${column}`, label, changed, unbound, rows.length);
  return { changed, unbound: REBIND ? 0 : unbound };
}

async function backfillJson(client, target) {
  const { table, jsonPath, label } = target;
  const pathSql = `record #>> '{${jsonPath.join(',')}}'`;
  const { rows } = await client.query(
    `SELECT id, practice_id, ${pathSql} AS value FROM ${table} WHERE ${pathSql} IS NOT NULL`
  );
  let changed = 0;
  let unbound = 0;
  for (const row of rows) {
    if (actionFor(row.value) === 'unbound') unbound += 1;
    const next = rebound(row.value, locationOf(target, row));
    if (next === null) continue;
    changed += 1;
    if (DRY) continue;
    await client.query(
      `UPDATE ${table} SET record = jsonb_set(record, $2::text[], to_jsonb($3::text)) WHERE id = $1`,
      [row.id, `{${jsonPath.join(',')}}`, next]
    );
  }
  report(`${table}.record.${jsonPath.join('.')}`, label, changed, unbound, rows.length);
  return { changed, unbound: REBIND ? 0 : unbound };
}

async function main() {
  const client = await connect({ connectionString });
  console.log(DRY ? 'Dry run — nothing will be written.\n' : 'Encrypting raw PHI in place.\n');

  let total = 0;
  let stillUnbound = 0;
  try {
    for (const target of TARGETS) {
      const result = target.column
        ? await backfillColumn(client, target)
        : await backfillJson(client, target);
      total += result.changed;
      stillUnbound += result.unbound;
    }
  } finally {
    await client.end();
  }

  console.log(
    `
${DRY ? 'Would rewrite' : 'Rewrote'} ${total} value(s). ` +
      (total === 0 ? 'Nothing was left in the clear.' : DRY ? 'Re-run without --dry to apply.' : 'Done.')
  );

  /**
   * Stated last, and stated plainly. These rows ARE encrypted — a stolen backup is inert — but
   * their ciphertext is not bound to the row it sits in, so anyone with UPDATE and no key can move
   * PHI between patients and between practices, and every read presents it as that patient's own.
   *
   * Reported rather than done automatically, because `--rebind` decrypts and re-encrypts live PHI,
   * and that belongs on somebody's maintenance schedule rather than in whichever command they
   * happened to run first.
   */
  if (stillUnbound > 0) {
    console.log(
      `
! ${stillUnbound} value(s) are encrypted but NOT bound to their row (v1). Until they are, ` +
        `a ciphertext copied into another patient's or another practice's row decrypts there ` +
        `without complaint.
  Fix: PHI_ENCRYPTION_KEY=... npm run db:encrypt-phi -- --rebind`
    );
  }
}

main().catch((e) => {
  console.error('\nBackfill error:', e.message);
  process.exit(1);
});
