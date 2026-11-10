/**
 * Types for the migration runner.
 *
 * The script itself is `.mjs` like every other operational script here (provision-role,
 * encrypt-phi, backfill-ledger-patients): they are run by `node` directly and keeping them plain
 * JavaScript keeps them readable by anyone operating the system rather than only by someone with
 * the toolchain. This declaration exists so the live-database test can drive the REAL runner —
 * against a throwaway directory and table — instead of asserting on a copy of its logic.
 */

/** Anything that can run a parameterised query — a raw client, or an ambient transaction. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface Migration {
  id: number;
  file: string;
  sql: string;
  checksum: string;
}

/** Numbered .sql files in `dir`, sorted by their integer prefix. */
export function loadMigrations(dir?: string): Migration[];

/**
 * Throw if any migration manages its own transaction. The runner owns it — a `COMMIT` in a file
 * commits the runner's transaction and releases the advisory lock mid-run.
 */
export function assertRunnerOwnsTransaction(migrations: Pick<Migration, 'id' | 'file' | 'sql'>[]): void;

/**
 * Checksum drift between the files and the recorded rows: blessed historical transitions come back
 * as repairs, anything else throws.
 */
export function reconcileChecksums(
  migrations: Pick<Migration, 'id' | 'file' | 'checksum'>[],
  applied: Map<number, { checksum: string }>
): { repairs: { id: number; file: string; from: string; to: string }[] };

export interface RunMigrationsOptions {
  client: Queryable;
  /** Defaults to the runner's own ./migrations. */
  dir?: string;
  /** Defaults to `_migrations`. Overridden by tests so they never touch the real ledger. */
  table?: string;
  /** Defaults to the production advisory-lock key. */
  lockKey?: string;
  statusOnly?: boolean;
  log?: (message: string) => void;
}

/** Apply every pending migration under one transaction and one advisory lock. */
export function runMigrations(
  options: RunMigrationsOptions
): Promise<{ applied: string[]; repaired: string[] }>;
