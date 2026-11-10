/**
 * Types for the M14 part 2 backfill operations.
 *
 * The script itself is `.mjs` like every other operational script here (migrate, provision-role,
 * encrypt-phi): they are run by `node` directly, never imported by the application, and keeping them
 * plain JavaScript keeps them readable by anyone operating the system rather than only by someone
 * with the toolchain. This declaration exists so the live-database test can import the same
 * operations the script runs instead of retyping their SQL.
 */

/** Anything that can run a parameterised query — a pool client, or an ambient transaction. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface AccountBalance {
  /** BIGINT sum, as the string Postgres returns — never coerced through a float. */
  balance: string;
  entries: number;
}

/** Balances per account key, computed the way every read path computes them. */
export function balances(client: Queryable, practiceId: string): Promise<Map<string, AccountBalance>>;

/** Human-readable descriptions of every way two balance snapshots differ. Empty means identical. */
export function diffBalances(before: Map<string, AccountBalance>, after: Map<string, AccountBalance>): string[];

/** Link one practice's unlinked ledger entries to the patient their member ID belongs to. */
export function linkForPractice(
  client: Queryable,
  practiceId: string
): Promise<{ linked: number; unresolved: number }>;
