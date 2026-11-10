/**
 * What happens when the database is a network service that sometimes is not there.
 *
 * The database is managed and network-attached: it closes idle connections, it is restarted for
 * maintenance, it fails over, and a serverless endpoint suspends when nothing is talking to it. The
 * pool consequently hands out sockets that are already dead, and does so predictably — after a quiet
 * period, the next request gets one.
 *
 * These drive that with a fake connector, because there is no way to unplug a network from a unit
 * test and this is precisely the code that exists for the moment it is unplugged.
 *
 * The most important case is the last one. A connection whose ROLLBACK failed is in an unknown
 * transaction state and still carries the `set_current_practice` of the request that just failed;
 * returning it to the pool would give the next request another tenant's practice context with RLS
 * armed for the wrong practice. That is the one failure this whole codebase is built to make
 * impossible, reached through a connection pool rather than through a query.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTransientConnectionError,
  openTransaction,
  runOnClient,
  type ReleasableClient,
} from "../pool.ts";

const noSleep = async (): Promise<void> => {};

/** A fake pooled client that records every statement and every way it was given back. */
function fakeClient(behaviour: { failOn?: RegExp; failWith?: Error } = {}) {
  const statements: string[] = [];
  const released: { err?: Error }[] = [];
  const client: ReleasableClient = {
    async query(text: string) {
      statements.push(text);
      if (behaviour.failOn?.test(text)) {
        throw behaviour.failWith ?? Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
      }
      return { rows: [], rowCount: 0 };
    },
    release(err?: Error) {
      released.push({ err });
    },
  };
  return { client, statements, released };
}

const transient = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });

// ── Which failures are worth retrying ─────────────────────────────────────────────────

test("a dropped socket is transient; a constraint violation is not", () => {
  assert.equal(isTransientConnectionError(transient()), true);
  assert.equal(isTransientConnectionError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTransientConnectionError(new Error("terminating connection due to administrator command")), true);
  assert.equal(isTransientConnectionError(Object.assign(new Error("shutdown"), { code: "57P01" })), true);

  /**
   * The narrowness is the point. A constraint violation, a permission denial and an RLS refusal are
   * ANSWERS — retrying them wastes a clinic's time and, worse, makes a deterministic bug look
   * intermittent, which is how it survives an investigation.
   */
  assert.equal(isTransientConnectionError(Object.assign(new Error("duplicate key"), { code: "23505" })), false);
  assert.equal(isTransientConnectionError(Object.assign(new Error("permission denied"), { code: "42501" })), false);
  assert.equal(isTransientConnectionError(new Error("verification not found")), false);
  assert.equal(isTransientConnectionError(null), false);
  assert.equal(isTransientConnectionError("ECONNRESET"), false, "a bare string is not an error object");
});

// ── Retrying the acquisition ──────────────────────────────────────────────────────────

test("a connection that died while idle is retried, not surfaced as a 500", async () => {
  let attempts = 0;
  const good = fakeClient();

  const client = await openTransaction(
    async () => {
      attempts += 1;
      if (attempts === 1) throw transient();
      return good.client;
    },
    "practice-1",
    noSleep
  );

  assert.equal(attempts, 2, "the first socket was dead; the second worked");
  assert.equal(client, good.client);
  assert.deepEqual(good.statements, ["BEGIN", "SELECT set_current_practice($1)"]);
});

test("a BEGIN that fails on a dead socket destroys that client rather than reusing it", async () => {
  const dead = fakeClient({ failOn: /BEGIN/ });
  const good = fakeClient();
  const clients = [dead.client, good.client];

  await openTransaction(async () => clients.shift()!, "practice-1", noSleep);

  assert.equal(dead.released.length, 1);
  assert.ok(dead.released[0]!.err, "release(err) discards the client; release() would return it for reuse");
  assert.equal(good.released.length, 0, "the working client is still in use by the caller");
});

test("a real error is not retried — it is the answer, and retrying hides it", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      openTransaction(
        async () => {
          attempts += 1;
          throw Object.assign(new Error("permission denied for table claims"), { code: "42501" });
        },
        "practice-1",
        noSleep
      ),
    /permission denied/
  );
  assert.equal(attempts, 1, "a permission failure will fail identically three times");
});

test("retries are bounded — a genuine outage fails rather than hanging the request", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      openTransaction(
        async () => {
          attempts += 1;
          throw transient();
        },
        "practice-1",
        noSleep
      ),
    /Connection terminated/
  );
  assert.equal(attempts, 3, "a clinic waiting on a screen would rather be told than kept");
});

test("a context-free transaction sets no practice — the pre-auth boundary", async () => {
  const { client, statements } = fakeClient();
  await openTransaction(async () => client, null, noSleep);
  assert.deepEqual(statements, ["BEGIN"], "login must not be scoped to a practice it has not resolved yet");
});

// ── The caller's work, and giving the connection back ─────────────────────────────────

test("a successful unit of work commits and returns the connection for reuse", async () => {
  const { client, statements, released } = fakeClient();
  const result = await runOnClient(client, "practice-1", async () => "done");

  assert.equal(result, "done");
  assert.deepEqual(statements, ["COMMIT"]);
  assert.equal(released.length, 1);
  assert.equal(released[0]!.err, undefined, "a clean connection goes back into the pool");
});

test("a failing unit of work rolls back and still returns a healthy connection", async () => {
  const { client, statements, released } = fakeClient();

  await assert.rejects(
    () =>
      runOnClient(client, "practice-1", async () => {
        throw new Error("duplicate key");
      }),
    /duplicate key/
  );

  assert.deepEqual(statements, ["ROLLBACK"]);
  assert.equal(released[0]!.err, undefined, "the transaction failed, the connection did not");
});

/**
 * ── THE ONE THAT MATTERS ───────────────────────────────────────────────────────────────────────
 *
 * `client.release()` with no argument returns the client for REUSE. When ROLLBACK has itself failed,
 * that client's transaction state is unknown — possibly still open, and still carrying the
 * `set_current_practice` of the request that just died. The next request to draw it would run inside
 * ANOTHER TENANT'S practice context, with RLS armed for the wrong practice.
 *
 * Losing a connection costs one reconnect. Reusing this one costs tenant isolation.
 */
test("a connection whose ROLLBACK failed is destroyed, never returned to the pool", async () => {
  const { client, released } = fakeClient({ failOn: /ROLLBACK/, failWith: transient() });

  await assert.rejects(
    () =>
      runOnClient(client, "practice-1", async () => {
        throw new Error("the original failure");
      }),
    /the original failure/,
    "the caller must still see what actually went wrong, not the rollback's error"
  );

  assert.equal(released.length, 1);
  assert.ok(
    released[0]!.err,
    "a connection that may still be inside another practice's transaction must be destroyed"
  );
});

test("a COMMIT that fails also destroys nothing it should not — the error reaches the caller", async () => {
  const { client, released } = fakeClient({ failOn: /COMMIT/ });

  await assert.rejects(() => runOnClient(client, "practice-1", async () => "done"), /Connection terminated/);
  // ROLLBACK is attempted after the failed COMMIT and succeeds against this fake, so the connection
  // is not poisoned — the failure was the commit, and the caller is told the write did not land.
  assert.equal(released.length, 1);
  assert.equal(released[0]!.err, undefined);
});
