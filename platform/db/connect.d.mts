import type pg from "pg";

/** A connected client with the shared TLS policy applied. `ssl` cannot be overridden by a caller. */
export function connect(options: { connectionString: string } & Record<string, unknown>): Promise<pg.Client>;

/** DATABASE_ADMIN_URL, else DATABASE_URL, else null. */
export function adminUrl(env?: NodeJS.ProcessEnv): string | null;
