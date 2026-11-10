/**
 * Postgres connection pool, the tenant-scoped transaction helper that makes RLS work, and the
 * ambient transaction context that makes the outbox genuinely transactional.
 *
 * `withPractice` is how EVERY request touches tenant data: it opens a transaction, sets the
 * practice context (from the authenticated session — never from client input), runs the callback
 * under RLS, and commits. A missed `WHERE practice_id = ?` cannot leak another practice's rows
 * because the database itself filters them (migration 0002).
 *
 * ── WHY THERE IS AN AMBIENT CONTEXT ──────────────────────────────────────────────────────────
 * The outbox's core promise is that a domain event is written in the SAME transaction as the
 * business write that caused it — otherwise an event can be lost after a commit, or emitted for a
 * write that rolled back. But a service does `repo.save(record)` and then `publisher.publish(...)`
 * as two separate calls; if each opened its own transaction, that promise would be broken.
 *
 * So the transaction is established ONCE per request by `withPractice` and published through
 * AsyncLocalStorage. Repositories and the event bus both join the ambient transaction rather than
 * opening their own. The module services did not have to change at all, which is the point:
 * atomicity is a property of the seam, not something every call site has to remember.
 *
 * `requireContext()` throws when there is no ambient transaction. That is deliberate — in a
 * multi-tenant system a query that runs with no practice context is a bug, and failing loudly beats
 * quietly returning nothing (or, under a mis-provisioned role, everything).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { getConfig } from "@mermaid/config";
import { connectionOptions } from "./tls.mjs";

/**
 * Money is INTEGER CENTS in BIGINT columns, and node-postgres returns int8 as a STRING by default
 * (because int8 can exceed JS's safe-integer range). Every int8 this schema stores — cents, counts —
 * sits far inside 2^53, so parsing to a number is safe and avoids scattering `Number(...)` casts
 * through every repository, where a single omission would silently produce string concatenation
 * instead of arithmetic.
 *
 * OID 20 = int8. Applied once, at module load.
 */
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} exceeds JavaScript's safe-integer range; refusing to read it as a number`);
  }
  return n;
});

/**
 * A `DATE` is a CALENDAR DAY, not an instant, and must never become one.
 *
 * By default node-postgres parses date columns into a JS `Date` at LOCAL midnight. Read that back
 * with UTC getters and the day shifts; read it back with local getters and it shifts for anyone in a
 * different timezone. Either way a service date or a filing deadline can move by a day — which in
 * this domain means a claim filed against the wrong date of service, or a timely-filing deadline
 * computed a day early or late.
 *
 * So date columns are handed back as the plain `YYYY-MM-DD` string Postgres already stores. Every
 * date in the domain is an ISO day string, so this is also exactly the shape the code wants.
 *
 * OID 1082 = date.
 */
pg.types.setTypeParser(1082, (value: string) => value);

/** Structural transaction handle — services/repositories depend on this, not on `pg` directly,
 *  so repository logic is unit-testable with a fake tx. */
export interface Tx {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** The ambient unit of work: one transaction, scoped to one practice (or to none, pre-auth). */
export interface DbContext {
  tx: Tx;
  /** Null only inside `withoutPractice` — the pre-authentication boundary and the outbox worker. */
  practiceId: string | null;
}

const storage = new AsyncLocalStorage<DbContext>();

let pool: pg.Pool | null = null;

/**
 * Re-exported so this module stays the place the application asks about TLS, while the DECISION
 * lives in one plain-JavaScript module the six operational scripts share (NEW-04). A second copy
 * here would be a second thing to get wrong.
 */
export { withoutSslMode, resolveTls } from "./tls.mjs";

/**
 * ── TLS IS PINNED HERE, NOT INHERITED FROM THE CONNECTION STRING ────────────────────────────────
 *
 * Every connection must be encrypted AND must verify the server's certificate and hostname. That
 * was previously true only by convention: `.env.example` documents `?sslmode=require`, and nothing
 * checked it.
 *
 * Pinning it is not as simple as adding an `ssl` option, because node-postgres resolves the two
 * sources in an order that surprises:
 *
 *     config = Object.assign({}, config, parse(config.connectionString))
 *                                        ^ connection-parameters.js — the URL WINS
 *
 * Measured against pg 8.22.0, that gives:
 *
 *     ssl:{rejectUnauthorized:true} + `?sslmode=require`    → {}                        (pin DISCARDED)
 *     ssl:{rejectUnauthorized:true} + `?sslmode=no-verify`  → {rejectUnauthorized:false} (pin INVERTED)
 *     no sslmode at all, no ssl option                      → false                      (NO TLS)
 *
 * So an `ssl` option passed alongside the raw string would be a control that does not control —
 * silently inert today, and silently reversed by a URL that says `no-verify`. The parameter is
 * therefore stripped first, which is what lets the explicit setting survive the merge.
 *
 * Behaviour for the current configuration is UNCHANGED: `sslmode=require` already resolves to
 * `{}`, and an empty object means TLS with Node's default `rejectUnauthorized: true` — certificate
 * and hostname both verified. This states that outcome instead of inheriting it, and closes the two
 * ways the URL could quietly weaken it. It also survives the change pg has announced for v9, where
 * `require` drops to encryption without verification.
 *
 * ── AND IT USED TO BE UNCONDITIONAL, WHICH BROKE EVERY LOCAL PATH (NEW-03) ──────────────────────
 * CI runs a `postgres:16` service container and this repository's own docker-compose runs another,
 * and neither speaks TLS. An unconditional pin does not fail closed against those — it fails the
 * entire suite on every machine, and the pressure that produces is pressure to delete the pin.
 *
 * `resolveTls` in ./tls.mjs relaxes it only when PGSSLMODE=disable AND the host is a loopback
 * LITERAL: two keys, both required, neither of which a remote deployment can turn by accident. The
 * decision lives there because six operational scripts need the identical one.
 */
function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      ...connectionOptions(getConfig().databaseUrl),
      max: 10,
      // A managed/pooled endpoint drops idle connections; fail fast rather than hanging a request.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // An error on an IDLE pooled client belongs to no request. Without a listener, Node's default
    // handling of an EventEmitter 'error' would take down the process.
    pool.on("error", () => {});
  }
  return pool;
}

/** The ambient transaction, or null when not inside one. */
export const currentContext = (): DbContext | null => storage.getStore() ?? null;

/**
 * The ambient transaction, or a thrown error. Repositories use this: it turns "I forgot to open a
 * tenant-scoped transaction" into a loud failure at the call site instead of a silent empty result.
 */
export function requireContext(): DbContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "no ambient database transaction — repository calls must run inside withPractice() (or " +
        "withoutPractice() for the pre-auth boundary). This guard exists so that a tenant query can " +
        "never run without a practice context."
    );
  }
  return ctx;
}

/** The practice this unit of work is scoped to; throws outside a practice-scoped transaction. */
export function requirePracticeId(): string {
  const { practiceId } = requireContext();
  if (!practiceId) {
    throw new Error("this operation requires a practice context, but the current transaction has none");
  }
  return practiceId;
}

/**
 * Run `fn` inside a transaction scoped to `practiceId` (RLS enforced).
 *
 * Re-entrant: when an ambient transaction for the SAME practice is already open, `fn` joins it
 * rather than opening a nested one. That is what lets a request wrap everything in one unit of work
 * while individual services still read as though they manage their own. Re-entering with a
 * DIFFERENT practice is refused outright — silently switching tenants mid-transaction is precisely
 * the failure RLS exists to prevent.
 */
export async function withPractice<T>(practiceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) {
    if (existing.practiceId && existing.practiceId !== practiceId) {
      throw new Error(
        `refusing to switch practice context mid-transaction (${existing.practiceId} → ${practiceId})`
      );
    }
    if (!existing.practiceId) {
      // Promoting a context-free transaction to a tenant-scoped one is legitimate (login does it),
      // but the database context must actually be set or RLS will not apply.
      await existing.tx.query("SELECT set_current_practice($1)", [practiceId]);
      return storage.run({ tx: existing.tx, practiceId }, () => fn(existing.tx));
    }
    return fn(existing.tx);
  }

  return runTransaction(practiceId, fn);
}

/**
 * Run `fn` in a transaction with NO practice context — for the pre-auth boundary only
 * (login lookup by email, session lookup by token, both via SECURITY DEFINER functions that
 * return the row telling us which practice the request belongs to), and for the outbox worker,
 * whose queue mechanics deliberately span tenants.
 */
export async function withoutPractice<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn(existing.tx);

  return runTransaction(null, fn);
}

/**
 * ── A PRACTICE CONTEXT THAT HOLDS NO TRANSACTION (NEW-10) ────────────────────────────────────────
 *
 * Every request opens ONE transaction for its whole duration, and that is right for almost all of
 * them: the business write and its domain event commit together or not at all.
 *
 * It is wrong for the handful that call a third party. `ClaimService.submit` sends an 837 to a
 * clearinghouse with a 30-second timeout, and it did so holding both a `SELECT … FOR UPDATE` on the
 * claim row and one of the pool's ten connections. Ten concurrent submissions to a slow vendor is
 * the entire pool, and every other request in the process — a screen loading, a payment being
 * taken, the outbox draining — waits on a network call to somebody else's server.
 *
 * So those paths need to know WHICH practice they are for without a transaction being open. This
 * carries exactly that: the practice id, and nothing else. A handler running inside it opens short
 * transactions as it needs them, and holds none while it waits.
 *
 * Deliberately a second AsyncLocalStorage rather than a nullable `tx` on `DbContext`: every
 * repository in this system calls `requireContext().tx`, and making that field nullable would turn
 * a loud "you forgot to open a transaction" into a runtime null somewhere far away.
 */
const practiceScope = new AsyncLocalStorage<string>();

/** Run `fn` knowing which practice it is for, WITHOUT opening a transaction. */
export function withPracticeScope<T>(practiceId: string, fn: () => Promise<T>): Promise<T> {
  return practiceScope.run(practiceId, fn);
}

/** The ambient practice — from an open transaction, or from a scope with none. Null outside both. */
export function currentPracticeId(): string | null {
  return storage.getStore()?.practiceId ?? practiceScope.getStore() ?? null;
}

/**
 * Open a SHORT transaction for the ambient practice.
 *
 * The unit of work a self-transacting handler uses between vendor calls. Joins an ambient
 * transaction if one is open — so a handler that is NOT self-transacting behaves exactly as it did
 * — and opens a fresh one when only the scope is set.
 */
export function withCurrentPractice<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const practiceId = currentPracticeId();
  if (!practiceId) {
    throw new Error(
      "no ambient practice — withCurrentPractice() needs either an open practice transaction or a " +
        "withPracticeScope(). This guard exists so a tenant write can never run without a tenant."
    );
  }
  return withPractice(practiceId, fn);
}

// ── Resilience: transient connections, and never reusing a suspect one ────────────────
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
// The database is a managed, network-attached service. It closes idle connections, it is restarted
// for maintenance, it fails over, and a serverless endpoint suspends when nothing is talking to it.
// The pool therefore hands out sockets that are already dead, and does so predictably: after a quiet
// period, the next request gets one.
//
// Two things were wrong with how that was handled, and they are different problems:
//
//  1. **Nothing retried.** Acquiring a connection, or issuing the `BEGIN`, could fail on a socket
//     that had died while idle, and the request 500'd. The user's fix was to press the button again
//     — the same thing a retry does, only slower and visible to a clinic.
//
//  2. **A suspect connection went back into the pool.** `client.release()` with no argument returns
//     the client for REUSE. When `ROLLBACK` had itself failed, that client's transaction state was
//     unknown: possibly still open, possibly still carrying `set_current_practice` from the tenant
//     whose request just failed. The next request to draw it would run inside someone else's
//     practice context. RLS would still be armed — for the WRONG practice. That is the one failure
//     mode this entire codebase is built to make impossible, arrived at through a connection pool
//     rather than through a query.
//
// Both are fixed below. The second is the one that mattered.

/** Errors that mean "the connection was not usable", as opposed to "the statement was wrong". */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // Postgres: admin shutdown, crash shutdown, cannot connect now (starting up), too many clients.
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

const TRANSIENT_MESSAGES =
  /connection terminated|connection closed|server closed the connection|timeout exceeded|socket hang up|terminating connection/i;

/**
 * Whether this failure is worth trying again on a fresh connection.
 *
 * Deliberately narrow. A constraint violation, a type error, a permission denial and an RLS refusal
 * are all answers — retrying them wastes time and, worse, makes a bug look intermittent. Only a
 * failure to have a usable connection at all qualifies.
 *
 * Exported so it can be tested directly; there is no way to unplug a network from a unit test.
 */
export function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && TRANSIENT_MESSAGES.test(message);
}

/**
 * How many times to try to GET a working connection and open a transaction on it.
 *
 * Three attempts covers the case this exists for — a pool holding one or two sockets that died while
 * idle — without turning a genuine outage into a request that hangs for a minute before failing. The
 * backoff is short for the same reason: a clinic waiting on a screen would rather be told than kept.
 */
const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = [50, 200];

/**
 * Open a transaction and run `fn` in it.
 *
 * ── WHAT IS AND IS NOT RETRIED ─────────────────────────────────────────────────────────────────
 * ONLY the acquisition and the transaction preamble — `connect`, `BEGIN`, `set_current_practice`.
 * Everything from the moment `fn` starts is left alone.
 *
 * That boundary is not a limitation, it is the point. Retrying `fn` would re-run a caller's work
 * whose effects are not all inside the transaction: an event published to the in-process bus, a
 * metric already counted, an EDI call already made to a clearinghouse. Rolling back the database does
 * not roll those back, and a "safe" retry that submits a claim twice is a duplicate-billing incident
 * — the exact failure the outbox's idempotency rules exist to prevent, reintroduced by the layer
 * underneath them. The preamble, by contrast, has no effects at all, so retrying it is provably safe.
 */
async function runTransaction<T>(practiceId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await openTransaction(() => getPool().connect().then(guardCheckedOutClient), practiceId);
  return runOnClient(client, practiceId, fn);
}

/**
 * Keep a dropped connection from killing the process.
 *
 * ── THE CRASH THIS EXISTS TO PREVENT ───────────────────────────────────────────────────────────
 * `getPool()` already installs `pool.on("error")`, and its comment says why: without a listener,
 * Node's default handling of an EventEmitter `'error'` takes down the process. That handler is real
 * but it is not enough, because node-postgres routes the two cases differently:
 *
 *   • an IDLE client in the pool errors  → the POOL emits it        (covered, since M6)
 *   • a CHECKED-OUT client errors        → the CLIENT emits it      (nobody was listening)
 *
 * A managed Postgres endpoint drops idle connections as a matter of course. Any checkout held
 * across one of those — the outbox worker draining, the monitors, a slow request — therefore had a
 * live `Client` emitting `'error'` with no listener on it:
 *
 *     Error: Connection terminated unexpectedly
 *     Emitted 'error' event on Client instance
 *     node:events:487  throw er; // Unhandled 'error' event
 *
 * The whole process died. In-flight requests were lost, the outbox worker stopped, and nothing
 * restarted it. Observed twice against Neon, roughly half an hour apart. It is also the true cause
 * of the live-database suite's long-standing "flakiness": the cascading failures that always passed
 * in isolation were this crash taking the runner down mid-file, which is why holding one variable
 * at a time never reproduced them.
 *
 * ── WHY SWALLOWING IS CORRECT HERE, AND NOT A SUPPRESSED ERROR ─────────────────────────────────
 * This listener deliberately does nothing with the error, exactly as `pool.on("error")` does. It is
 * not hiding a failure: when a connection dies, node-postgres ALSO rejects every query in flight on
 * it, so the operation still fails, `runOnClient` still rolls back or destroys the client, and the
 * caller still sees the error. The only thing this changes is that the death of one connection stops
 * being the death of the process.
 *
 * `on` is feature-detected because `openTransaction` takes an injected connector so its retry policy
 * can be driven by a fake — and a fake is a plain object, not an EventEmitter.
 */
/**
 * Marks a client that has already been guarded.
 *
 * ── WHY THIS IS NOT OPTIONAL ───────────────────────────────────────────────────────────────────
 * A pool RECYCLES clients: the same `Client` object is checked out, released, and checked out again
 * for the life of the process. Subscribing on every checkout therefore stacks a new listener on the
 * same emitter each time, without ever removing one. Node warns at ten —
 *
 *     MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 *     11 error listeners added to [Client].
 *
 * — and keeps going silently after that, so a long-lived process accumulates listeners in proportion
 * to how much work it has done. The first version of this guard did exactly that; the live database
 * suite surfaced it within a hundred checkouts.
 *
 * A symbol on the client is the right marker because its lifetime IS the client's: when the pool
 * discards the connection, the flag goes with it, and a genuinely new client gets a genuinely new
 * listener. A module-level WeakSet would work too, but this keeps the fact attached to the thing it
 * describes rather than in a side table.
 */
const GUARDED = Symbol.for("mermaid.db.clientErrorGuarded");

export function guardCheckedOutClient<T extends ReleasableClient>(client: T): T {
  const emitter = client as unknown as {
    on?: (event: string, listener: (err: Error) => void) => void;
    [GUARDED]?: boolean;
  };
  if (typeof emitter.on !== "function") return client;
  // Idempotent: a recycled client is already guarded, and subscribing again would leak a listener
  // per checkout. See GUARDED above.
  if (emitter[GUARDED]) return client;
  emitter[GUARDED] = true;
  emitter.on("error", () => {
    /* Intentionally empty — see above. The in-flight query rejects on its own. */
  });
  return client;
}

/**
 * A connection with an open, correctly-scoped transaction on it — retrying transient failures.
 *
 * Split out and exported so the retry policy can be driven by a test with a fake connector; there is
 * no way to unplug a network from a unit test, and this is the code that exists for the moment it is
 * unplugged. `connect` is injected for the same reason.
 */
export async function openTransaction(
  connect: () => Promise<ReleasableClient>,
  practiceId: string | null,
  sleep: (ms: number) => Promise<void> = delay
): Promise<ReleasableClient> {
  let lastError: unknown;

  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    const final = attempt === CONNECT_ATTEMPTS - 1;
    let client: ReleasableClient;
    try {
      client = await connect();
    } catch (err) {
      lastError = err;
      if (!isTransientConnectionError(err) || final) throw err;
      await sleep(CONNECT_BACKOFF_MS[attempt] ?? 200);
      continue;
    }

    try {
      await client.query("BEGIN");
      if (practiceId !== null) await client.query("SELECT set_current_practice($1)", [practiceId]);
      return client;
    } catch (err) {
      // `release(err)` DESTROYS the client instead of returning it to the pool. A socket that could
      // not even begin a transaction must never be handed to the next request.
      client.release(err instanceof Error ? err : new Error(String(err)));
      lastError = err;
      if (!isTransientConnectionError(err) || final) throw err;
      await sleep(CONNECT_BACKOFF_MS[attempt] ?? 200);
    }
  }

  throw lastError;
}

/** The part of a pooled client this module depends on — a `Tx` that can be given back. */
export interface ReleasableClient extends Tx {
  release(err?: Error): void;
}

/**
 * Run the caller's work on an open transaction, then commit — or roll back and discard.
 *
 * Exported alongside `openTransaction` so the poisoned-connection property can be tested directly:
 * it is the one behaviour here whose failure is a tenant-isolation breach rather than an error.
 */
export async function runOnClient<T>(
  client: ReleasableClient,
  practiceId: string | null,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  let poisoned: Error | null = null;
  try {
    const result = await storage.run({ tx: client, practiceId }, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    /**
     * If the ROLLBACK itself fails, this connection's state is UNKNOWN — it may still be inside a
     * transaction, and it is still carrying whatever `set_current_practice` this request set. It is
     * poisoned, and the next request to draw it from the pool would inherit another tenant's
     * practice context with RLS armed for the wrong practice.
     *
     * So it is destroyed rather than returned. Losing a connection costs one reconnect; reusing this
     * one costs tenant isolation, which is the guarantee everything else here rests on.
     */
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      poisoned = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    client.release(poisoned ?? undefined);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
