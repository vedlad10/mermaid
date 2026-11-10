/**
 * Repository base — the thin, typed SQL helpers every module's repository is built from. Depends
 * only on the structural `Tx` type (not `pg`), so it is unit-testable with a fake transaction.
 *
 * A module's `repository.ts` is the SOLE SQL surface for that module's tables; nothing else in the
 * codebase queries them (enforced by RLS + the module-boundary checker). These helpers keep that
 * layer boring and safe: parameterized statements only, no string interpolation of values.
 */
import type { Tx } from "./pool.ts";

/** First row or undefined. */
export async function one<T>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await tx.query(sql, params);
  return rows[0] as T | undefined;
}

/** All rows. */
export async function many<T>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await tx.query(sql, params);
  return rows as T[];
}

/** Execute a write; returns affected row count. */
export async function execute(tx: Tx, sql: string, params: unknown[] = []): Promise<number> {
  const { rowCount } = await tx.query(sql, params);
  return rowCount ?? 0;
}

/** First row, or throw a typed not-found — for "must exist" reads inside a use-case. */
export async function oneOrThrow<T>(tx: Tx, sql: string, params: unknown[], notFound: string): Promise<T> {
  const row = await one<T>(tx, sql, params);
  if (row === undefined) throw new RepositoryNotFound(notFound);
  return row;
}

export class RepositoryNotFound extends Error {
  readonly code = "not_found";
  constructor(message: string) {
    super(message);
    this.name = "RepositoryNotFound";
  }
}
