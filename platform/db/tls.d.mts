/**
 * Types for the shared TLS policy.
 *
 * Plain `.mjs` so the operational scripts can import it without a toolchain; this declaration is
 * what lets `pool.ts` share the identical decision rather than keeping a second copy of it.
 */

/** Verified TLS, or `false` for the local escape hatch. */
export type TlsOption = false | { rejectUnauthorized: true };

/** Remove `sslmode` from a connection string, leaving every other byte identical. */
export function withoutSslMode(connectionString: string): string;

/** The host a connection string names, lower-cased, or null when it names none. */
export function hostOf(connectionString: string): string | null;

/** True when the connection string names a loopback LITERAL (never a name that resolves to one). */
export function isLoopback(connectionString: string): boolean;

/**
 * Verified TLS unless `PGSSLMODE=disable` AND the host is a loopback literal — both, or neither.
 */
export function resolveTls(connectionString: string, env?: NodeJS.ProcessEnv): TlsOption;

/** `pg` options with `sslmode` stripped and `ssl` resolved. */
export function connectionOptions(
  connectionString: string,
  env?: NodeJS.ProcessEnv
): { connectionString: string; ssl: TlsOption };
