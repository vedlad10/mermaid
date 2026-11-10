/**
 * Start the DB-free laptop demo, whatever `.env` says about the database.
 *
 *   npm run web:demo            # port 3000
 *   PORT=3002 npm run web:demo  # anywhere else
 *
 * ── WHY THIS EXISTS RATHER THAN `DATABASE_URL= npm run web` ────────────────────────────────────
 * That form works in a POSIX shell and cannot be expressed on Windows: the OS discards environment
 * variables set to the empty string, so `DATABASE_URL=` sets nothing, `--env-file` then loads the
 * real one from `.env`, and the "demo" quietly comes up against the production database — durable,
 * login-gated, and not what anyone asked for. It looks like it worked, which is the problem.
 *
 * Deleting the variable in-process is unambiguous on every platform. It happens after `--env-file`
 * has loaded and before the composition root reads config, which is the only window that matters.
 */
delete process.env.DATABASE_URL;
process.env.PORT = process.env.PORT ?? "3000";

/**
 * `server.ts` starts itself only when it is the entry point — `import.meta.url` against
 * `process.argv[1]` — so that importing it from a test does not bind a port. Importing it from here
 * would therefore load the module and exit silently, which is exactly what it did the first time.
 *
 * Pointing `argv[1]` at the server before importing satisfies that guard honestly: this process IS
 * running the server as its program, which is what the check is asking.
 */
const { fileURLToPath } = await import("node:url");
const serverUrl = new URL("../apps/web/server.ts", import.meta.url);

// Two different shapes on purpose, and Windows will not forgive mixing them: `argv[1]` must be an
// OS path (the guard runs `pathToFileURL` on it), while dynamic `import()` needs the file:// URL —
// a bare `C:\...` is read as a URL with an unsupported `c:` scheme.
process.argv[1] = fileURLToPath(serverUrl);

await import(serverUrl.href);
