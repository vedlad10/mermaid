// sql-transaction-control.mjs — find transaction-control statements in a migration file.
//
// ── WHY THIS EXISTS (NEW-02) ─────────────────────────────────────────────────────────────────────
// `migrate.mjs` applies the whole pending set inside ONE transaction, and takes
// `pg_advisory_xact_lock` inside it, because that is the only lock that excludes a second runner
// through this deployment's pooler (see the runner header and tests/db/migration-lock.test.ts).
//
// Eighteen migration files each carried their own `BEGIN; … COMMIT;`. `client.query(sql)` sends a
// multi-statement string over the SIMPLE query protocol, where Postgres executes the statements as
// written — so the file's `BEGIN` was a no-op warning inside the runner's open transaction, and the
// file's `COMMIT` **ended the runner's transaction**. From that moment:
//
//   • the advisory lock was released — a concurrent runner could enter mid-run;
//   • every later file ran in its own implicit transaction — the whole-run atomicity was gone;
//   • a failure in the last file could no longer roll back the earlier ones, and the `ROLLBACK` in
//     the runner's catch block had no transaction to roll back.
//
// The runner owns the transaction now. The files must not contain transaction control, and this
// module is how that is detected rather than trusted.
//
// ── WHY A SCANNER AND NOT A REGEX ────────────────────────────────────────────────────────────────
// `BEGIN` is also PL/pgSQL block syntax, and these migrations are full of it:
//
//     CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
//     BEGIN                         <- NOT transaction control
//       NEW.updated_at = now();
//     END;
//     $$;
//
// A naive `/^BEGIN/m` flags that and makes the guard unusable. So the text is scanned with SQL's
// actual lexical rules — line comments, block comments (nestable in Postgres), single-quoted
// strings, quoted identifiers, and dollar-quoted bodies are skipped — and only a keyword found at
// STATEMENT level counts.

/** Statements that open, close, or subdivide a transaction. Matched case-insensitively. */
const CONTROL = [
  /^BEGIN\s*(?:WORK|TRANSACTION)?\s*;/i,
  /^START\s+TRANSACTION\b/i,
  /^COMMIT\s*(?:WORK|TRANSACTION)?\s*;/i,
  /^COMMIT\s+PREPARED\b/i,
  /^ROLLBACK\b/i,
  /^SAVEPOINT\s+\S/i,
  /^RELEASE\s+(?:SAVEPOINT\s+)?\S/i,
  /^PREPARE\s+TRANSACTION\b/i,
  /^SET\s+TRANSACTION\b/i,
  /^SET\s+CONSTRAINTS\b/i,
];

/**
 * `BEGIN` opens a PL/pgSQL block as well as a transaction, and the two are told apart by the
 * semicolon: transaction control is `BEGIN;`, the block opener is a bare `BEGIN` followed by
 * statements. That is why the pattern above requires the `;` — and why this note exists, because
 * "just also match bare BEGIN" is the obvious-looking change that breaks every plpgsql migration.
 */

/** Opens a dollar-quoted body: `$$` or `$tag$`. Postgres identifiers allow non-ASCII letters. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/;

/**
 * Walk `sql` and yield the offset of every position that starts a statement — that is, the first
 * non-whitespace, non-comment character of the file, and of everything following a top-level `;`.
 *
 * Skips, without interpreting: `-- line comments`, nestable block comments, 'single quoted strings'
 * (including the '' escape), "quoted identifiers", and $tag$ dollar-quoted bodies $tag$.
 */
function* statementStarts(sql) {
  let i = 0;
  let atStatementStart = true;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (atStatementStart && !/\s/.test(ch) && two !== '--' && two !== '/*') {
      yield i;
      atStatementStart = false;
    }

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }

    if (two === '/*') {
      // Postgres block comments nest, unlike SQL-standard ones.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') {
          depth++;
          i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
        continue;
      }
    }

    if (ch === ';') {
      atStatementStart = true;
      i++;
      continue;
    }

    i++;
  }
}

/**
 * Every transaction-control statement in `sql`, as `{ statement, line }` (1-based line numbers).
 *
 * An empty array means the text can safely be handed to a runner that owns the transaction itself.
 */
export function findTransactionControl(sql) {
  const found = [];
  for (const start of statementStarts(sql)) {
    const rest = sql.slice(start);
    for (const pattern of CONTROL) {
      const m = pattern.exec(rest);
      if (!m) continue;
      found.push({
        statement: m[0].trim().replace(/\s+/g, ' '),
        line: sql.slice(0, start).split('\n').length,
      });
      break;
    }
  }
  return found;
}
