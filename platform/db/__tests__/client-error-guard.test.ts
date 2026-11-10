/**
 * A dropped database connection must not kill the process.
 *
 * ── THE CRASH THIS PINS ────────────────────────────────────────────────────────────────────────
 * node-postgres routes connection errors two ways: an IDLE pooled client's error is emitted on the
 * POOL, a CHECKED-OUT client's error is emitted on the CLIENT. `getPool()` has listened on the pool
 * since M6; nothing listened on the client. A managed endpoint dropping an idle connection under a
 * long checkout — the outbox worker, the monitors, a slow request — therefore produced:
 *
 *     Error: Connection terminated unexpectedly
 *     Emitted 'error' event on Client instance
 *     node:events:487  throw er; // Unhandled 'error' event
 *
 * and the whole server died. Observed twice against Neon, about half an hour apart, and it is also
 * the real cause of the live-database suite's cascading "flaky" failures.
 *
 * ── WHY THIS TEST FORKS A CHILD PROCESS ────────────────────────────────────────────────────────
 * The property is *the process stays alive*, and that cannot be asserted from inside the process
 * that would be dying. An in-process `assert.doesNotThrow` around an emit proves nothing: an
 * unhandled `'error'` does not throw at the emit site, it goes to the uncaught-exception path and
 * terminates the runtime. So each case runs in a real child and the assertion is on its exit code.
 *
 * The control case is the point of the pair: it must CRASH. If both children exit 0, this test has
 * stopped testing anything, and the guard could be deleted without it noticing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
/**
 * The file:// URL, NOT an OS path. Windows rejects `import("C:\...")` with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME — the dynamic loader takes a URL, and a drive letter reads as an
 * unknown protocol. Caught by this very test failing on the first run.
 */
const POOL = new URL("../pool.ts", import.meta.url).href;

/** Run a snippet in a child node process; return its exit code and stderr. */
function runChild(source: string): { code: number; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { code: 0, stderr: stdout };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: String(e.stderr ?? "") };
  }
}

/** A stand-in for a checked-out pooled client: an EventEmitter that can also be released. */
const FAKE_CLIENT = `
  import { EventEmitter } from "node:events";
  class FakeClient extends EventEmitter {
    async query() { return { rows: [] }; }
    release() {}
  }
  const client = new FakeClient();
`;

const DROP = `
  // Exactly what node-postgres does when the far end goes away mid-checkout.
  client.emit("error", new Error("Connection terminated unexpectedly"));
  // If the process is still alive one tick later, the guard held.
  setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 10);
`;

test("the control case genuinely crashes — without the guard, a checked-out client kills the process", () => {
  const { code, stderr } = runChild(FAKE_CLIENT + DROP);

  assert.notEqual(code, 0, "an unguarded client error MUST take the process down, or this test proves nothing");
  assert.match(stderr, /Connection terminated unexpectedly/);
  assert.doesNotMatch(stderr, /SURVIVED/, "the process must not have reached the next tick");
});

test("a checked-out client whose connection drops does NOT kill the process", () => {
  const { code, stderr } = runChild(`
    ${FAKE_CLIENT}
    const { guardCheckedOutClient } = await import(${JSON.stringify(POOL)});
    guardCheckedOutClient(client);
    ${DROP}
  `);

  assert.equal(code, 0, `the guarded process must survive. stderr:\n${stderr}`);
  assert.match(stderr, /SURVIVED/);
});

test("the guard survives repeated drops on the same client", () => {
  // A flapping connection emits more than once. The listener must not be a one-shot.
  const { code, stderr } = runChild(`
    ${FAKE_CLIENT}
    const { guardCheckedOutClient } = await import(${JSON.stringify(POOL)});
    guardCheckedOutClient(client);
    for (let i = 0; i < 25; i++) client.emit("error", new Error("Connection terminated unexpectedly"));
    setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 10);
  `);

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /SURVIVED/);
});

test("the guard returns the same client, and does not swallow query rejections", () => {
  /**
   * The half that matters for correctness rather than uptime: swallowing the EVENT must not swallow
   * the FAILURE. node-postgres rejects every in-flight query when a connection dies, and the caller
   * still has to see that — `runOnClient` rolls back and destroys the client on it. A guard that
   * made a dead connection look healthy would be far worse than the crash.
   */
  const { code, stderr } = runChild(`
    import { EventEmitter } from "node:events";
    class FakeClient extends EventEmitter {
      async query() { throw new Error("Connection terminated unexpectedly"); }
      release() {}
    }
    const client = new FakeClient();
    const { guardCheckedOutClient } = await import(${JSON.stringify(POOL)});
    const same = guardCheckedOutClient(client);
    if (same !== client) { console.error("guard did not return the same client"); process.exit(2); }
    client.emit("error", new Error("Connection terminated unexpectedly"));
    try {
      await client.query("SELECT 1");
      console.error("the query resolved — the failure was swallowed");
      process.exit(3);
    } catch {
      console.log("SURVIVED_AND_STILL_REJECTS");
      process.exit(0);
    }
  `);

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /SURVIVED_AND_STILL_REJECTS/);
});

test("a non-EventEmitter client is passed through untouched", () => {
  // `openTransaction` takes an injected connector so its retry policy can be driven by a fake, and
  // a fake is a plain object. The guard must not assume it can subscribe to one.
  const { code, stderr } = runChild(`
    const { guardCheckedOutClient } = await import(${JSON.stringify(POOL)});
    const plain = { async query() { return { rows: [] }; }, release() {} };
    const out = guardCheckedOutClient(plain);
    if (out !== plain) { console.error("did not pass the fake through"); process.exit(2); }
    console.log("SURVIVED");
    process.exit(0);
  `);

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /SURVIVED/);
});

test("guarding the same client twice adds only one listener — a recycled client must not leak", () => {
  /**
   * A pool recycles clients, so `guardCheckedOutClient` runs against the SAME emitter on every
   * checkout. The first version subscribed unconditionally and Node started warning at eleven:
   *
   *     MaxListenersExceededWarning: 11 error listeners added to [Client].
   *
   * Caught by the live database suite, not by this file, because nothing here checked out a client
   * more than once. It does now — a leak that only appears after ten checkouts is exactly the kind
   * that reaches production.
   */
  const { code, stderr } = runChild(`
    ${FAKE_CLIENT}
    const { guardCheckedOutClient } = await import(${JSON.stringify(POOL)});
    for (let i = 0; i < 50; i++) guardCheckedOutClient(client);
    const n = client.listenerCount("error");
    if (n !== 1) { console.error("expected exactly 1 error listener, got " + n); process.exit(2); }
    // Still guarded after all that, and still surviving.
    ${DROP}
  `);

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /SURVIVED/);
  assert.doesNotMatch(stderr, /MaxListenersExceededWarning/, "the guard must not accumulate listeners");
});
