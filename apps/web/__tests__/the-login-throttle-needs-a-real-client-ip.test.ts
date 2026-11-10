/**
 * The login throttle, exercised over real HTTP against the value the deployment declares.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE `clientIpFrom` UNIT TESTS ─────────────────────────
 * Those prove which value is READ. This proves what the value is FOR: `authRateLimiter` is
 * module-scoped in `server.ts` and keys its buckets on whatever `clientIp` returned, so a mistake
 * that pure tests cannot see — reading the right header into the wrong key, or resolving it once
 * per process instead of once per request — shows up only here, as two clients sharing an
 * allowance or one client getting a fresh one per request.
 *
 * It is a FILE of its own rather than a test in `server.test.ts` because that limiter is process
 * state: `node --test` gives each file its own process, so these buckets start empty and are not
 * spent by the other suites' logins. Every address below is from a documentation range (TEST-NET-3,
 * TEST-NET-2, 2001:db8::/32) so nothing here can collide with a real client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { resetConfigCache } from "@mermaid/config";
import { createApp } from "../server.ts";
import { buildServices } from "../wiring.ts";

/** Capacity from `DEFAULT_AUTH_RATE_LIMIT`: ten in a burst, then two a minute. */
const CAPACITY = 10;

/**
 * Declare the deployment shape for the app under test, then build it.
 *
 * `resetConfigCache()` before AND after: the config is memoized, so a declaration left behind here
 * would silently rewrite the topology of whatever test file ran next in this process.
 */
async function withApp(
  trustProxy: string,
  fn: (base: string) => Promise<void>
): Promise<void> {
  const saved = { NODE_ENV: process.env.NODE_ENV, TRUST_PROXY: process.env.TRUST_PROXY, DATABASE_URL: process.env.DATABASE_URL };
  process.env.NODE_ENV = "development";
  process.env.TRUST_PROXY = trustProxy;
  // In-memory: this is about which bucket a request lands in, and a database is only a way to fail.
  delete process.env.DATABASE_URL;
  resetConfigCache();

  const server = createApp(buildServices({ inMemory: true, bus: new InMemoryOutbox() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
  }
}

/**
 * One sign-in attempt, costing exactly one token.
 *
 * ── WHY THE BODY IS DELIBERATELY EMPTY ─────────────────────────────────────────────────────────
 * The throttle is taken BEFORE the credentials are read, because `scrypt` is expensive and
 * verifying first would make a flood a denial of service as well as a guessing attack. So an
 * attempt that never reaches the password check still spends its token — which is what lets this
 * file prove bucket identity with no database and no seeded account. Authentication itself is
 * Postgres-backed and is proven in `tests/db/auth.test.ts`.
 *
 * The assertions below therefore read "did this request get PAST the throttle", not "did it sign
 * in": 400 is the validation error waiting on the other side, and 429 is the throttle itself.
 */
async function attemptLogin(base: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
  await res.text();
  return res.status;
}

/** Past the throttle: anything the router said after it, which must not be the throttle's own 429. */
const PASSED = (status: number) => status !== 429;

test("two clients behind the declared edge get their own allowances", async () => {
  /**
   * The failure this pins: every request arriving from the platform's
   * router over loopback, so one bucket covered the whole internet. Ten staff signing in at 8am
   * exhaust it between them — and an attacker can lock out a practice with ten wrong passwords.
   */
  await withApp("cloudflare", async (base) => {
    const alice = { "cf-connecting-ip": "203.0.113.9" };
    const mallory = { "cf-connecting-ip": "198.51.100.7" };

    for (let i = 0; i < CAPACITY; i++) {
      assert.ok(PASSED(await attemptLogin(base, mallory)), `attempt ${i + 1} should get past the throttle`);
    }
    assert.equal(await attemptLogin(base, mallory), 429, "the eleventh guess from one address is throttled");

    // …and the receptionist on a different connection is unaffected, which is the whole point.
    assert.ok(PASSED(await attemptLogin(base, alice)), "a different client must not inherit a spent bucket");
  });
});

test("a client cannot buy itself a fresh bucket by writing its own forwarding headers", async () => {
  /**
   * A credential-stuffing script varying `x-forwarded-for` per request is the attack the previous
   * implementation was vulnerable to. Under a `cloudflare` declaration that header is not read at
   * all, so every one of these requests is the SAME client — the one the edge named — and the
   * eleventh is refused however many identities the attacker claimed.
   */
  await withApp("cloudflare", async (base) => {
    const attacker = "203.0.113.42";

    for (let i = 0; i < CAPACITY; i++) {
      const status = await attemptLogin(base, {
        "cf-connecting-ip": attacker,
        "x-forwarded-for": `10.0.0.${i}`,
        "true-client-ip": `10.1.0.${i}`,
        forwarded: `for=10.2.0.${i}`,
      });
      assert.ok(PASSED(status), `attempt ${i + 1} should get past the throttle`);
    }

    assert.equal(
      await attemptLogin(base, { "cf-connecting-ip": attacker, "x-forwarded-for": "10.0.0.99" }),
      429,
      "varying a client-written header must not reset the allowance"
    );
  });
});

test("a forged cf-connecting-ip is ignored where no edge was declared", async () => {
  /**
   * The mirror image, and the reason the header is declared rather than detected: on a deployment
   * with nothing in front of it, `cf-connecting-ip` is just a string a stranger sent. Every request
   * below claims a different one and they all land in the loopback bucket together.
   */
  await withApp("0", async (base) => {
    for (let i = 0; i < CAPACITY; i++) {
      assert.ok(PASSED(await attemptLogin(base, { "cf-connecting-ip": `203.0.113.${i}` })));
    }
    assert.equal(
      await attemptLogin(base, { "cf-connecting-ip": "203.0.113.200" }),
      429,
      "an undeclared edge header must not choose the rate-limit identity"
    );
  });
});

test("an IPv6 client is its own bucket too, and the address survives the round trip", async () => {
  await withApp("cloudflare", async (base) => {
    const six = { "cf-connecting-ip": "2001:db8::dead:beef" };
    const four = { "cf-connecting-ip": "203.0.113.77" };

    for (let i = 0; i < CAPACITY; i++) assert.ok(PASSED(await attemptLogin(base, six)));
    assert.equal(await attemptLogin(base, six), 429);
    assert.ok(PASSED(await attemptLogin(base, four)), "an IPv4 client does not share an IPv6 client's bucket");
  });
});
