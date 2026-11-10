/**
 * M20 — the money checks must reach a screen, not only a log file.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────────
 * `runChecks` computes reconciliation drift, held-remittance age and abandoned ERA files. Until
 * this change its ONLY non-test caller was `startMonitors`, which calls `emit`, which writes a log
 * line. Meanwhile `/api/v1/ops/readiness` hand-rolled a different, smaller set of checks — database,
 * outbox, PHI — and never consulted `runChecks` at all.
 *
 * Two parallel health mechanisms, and the money one was the invisible half. In a single-practice
 * deployment with no log aggregation the human fallback for every silent money failure in this
 * system was *somebody reads the logs* — which is the same shape as `EraArtifactRepository.list()`
 * having no readers (M13) and `AlertGate.isFiring` having none either: a computed answer nobody asks.
 *
 * These tests assert the two properties that make the fix real rather than cosmetic: a firing check
 * reaches the transport a browser actually uses, and a check that could NOT be taken reports as a
 * failure rather than as silence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { buildServices, type Services } from "../wiring.ts";
import { DEFAULT_THRESHOLDS, HELD_REMITTANCE_AGE, RECONCILIATION_DRIFT, takeReadings } from "../monitors.ts";

const at = (ms: number): Date => new Date(1_700_000_000_000 + ms);

async function withServer(services: Services, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(services);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const get = async (base: string, path: string): Promise<{ status: number; json: any }> => {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
};

/** Money readings a test can drive, complete by construction — same reasoning as `monitors.test.ts`. */
const remittanceFake = (overrides: Record<string, unknown> = {}) => ({
  reconcileAll: async () => ({
    paymentsReceived: 0,
    amountPosted: 0,
    providerAdjustments: 0,
    drift: 0,
    balanced: true,
    summary: "nothing to reconcile",
  }),
  heldSummary: async () => ({ count: 0, oldestReceivedAt: null, totalCents: 0 }),
  deadLetteredArtifacts: async () => [],
  // No coordination cases unless a test states some (0034).
  listCoordinationCases: async () => [],
  ...overrides,
  /**
   * The held-age check reads UNATTENDED held money since 0034 — held cash not waiting on a coverage
   * answer. A fake with no coordination cases has none waiting, so its unattended money IS its held
   * money: follow whatever `heldSummary` the test stated, unless it states this directly.
   */
  unattendedHeldSummary:
    (overrides as { unattendedHeldSummary?: unknown }).unattendedHeldSummary ??
    (overrides as { heldSummary?: unknown }).heldSummary ??
    (async () => ({ count: 0, oldestReceivedAt: null, totalCents: 0 })),
});

const withMoney = (services: Services, overrides: Record<string, unknown>): Services =>
  ({ ...services, remittance: { ...services.remittance, ...remittanceFake(overrides) } }) as unknown as Services;

// ── 1. The route exists and answers the browser ────────────────────────────────────────

test("a healthy system reports healthy, and every check is listed rather than only the bad ones", async () => {
  await withServer(buildServices({ inMemory: true }), async (base) => {
    const { status, json } = await get(base, "/api/v1/ops/monitors");

    assert.equal(status, 200);
    assert.equal(json.healthy, true);
    assert.deepEqual(json.firing, [], "nothing is wrong, so nothing is firing");
    // The full list matters: an operator needs to see that a check RAN and was fine, which is a
    // different statement from the check being absent.
    const keys = json.checks.map((c: { key: string }) => c.key);
    assert.ok(keys.includes(RECONCILIATION_DRIFT), "the drift check must be reported, not just alerted");
    assert.ok(keys.includes(HELD_REMITTANCE_AGE), "and so must held money — the reading drift cannot take");
    assert.ok(
      json.checks.every((c: { ok: boolean }) => c.ok),
      "a healthy system has no failing check"
    );
  });
});

// ── 2. A firing money check reaches the screen ─────────────────────────────────────────

test("money held past its review window is FIRING on the API, not only in a log file", async () => {
  // Held three weeks: reconciles perfectly, in the bank against nothing, and nobody working it.
  const services = withMoney(buildServices({ inMemory: true }), {
    heldSummary: async () => ({
      count: 2,
      oldestReceivedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
      totalCents: 143_200,
    }),
  });

  await withServer(services, async (base) => {
    const { json } = await get(base, "/api/v1/ops/monitors");

    assert.equal(json.healthy, false);
    const held = json.firing.find((f: { key: string }) => f.key === HELD_REMITTANCE_AGE);
    assert.ok(held, "held money past the review window must reach the screen");
    assert.match(held.message, /held/i);
    // The AMOUNT has to travel with it. "2 held" is a number an operator defers; "2 held, $1,432"
    // is a decision.
    assert.equal(held.detail.heldCents, 143_200);
    assert.equal(held.detail.heldCount, 2);
  });
});

test("reconciliation drift is firing on the API", async () => {
  const services = withMoney(buildServices({ inMemory: true }), {
    reconcileAll: async () => ({
      paymentsReceived: 100_000,
      amountPosted: 99_500,
      providerAdjustments: 0,
      drift: 500,
      balanced: false,
      summary: "DRIFT of $5.00",
    }),
  });

  await withServer(services, async (base) => {
    const { json } = await get(base, "/api/v1/ops/monitors");
    const drift = json.firing.find((f: { key: string }) => f.key === RECONCILIATION_DRIFT);
    assert.ok(drift, "the ledger and the bank disagreeing must be visible to a person");
    assert.equal(drift.detail.driftCents, 500);
  });
});

// ── 3. FAIL-CLOSED — the property that is easiest to lose with a second consumer ───────

/**
 * ── A CHECK THAT COULD NOT RUN IS NOT A HEALTHY CHECK ──────────────────────────────────────────
 * This is the M13 property, and adding a second reader of `runChecks` is exactly when it gets lost:
 * the obvious `.filter(c => c.breaching)` on a reading that THREW yields nothing, and the screen
 * renders "all clear" over a watchdog that is blind. "Nothing is held" and "could not ask" must
 * never look the same.
 */
test("a money reading that THROWS reports unmonitored — never healthy", async () => {
  const services = withMoney(buildServices({ inMemory: true }), {
    heldSummary: async () => {
      throw new Error("the held-money query is broken");
    },
  });

  await withServer(services, async (base) => {
    const { json } = await get(base, "/api/v1/ops/monitors");

    assert.equal(json.healthy, false, "a blind watchdog is not a healthy one");
    const held = json.firing.find((f: { key: string }) => f.key === HELD_REMITTANCE_AGE);
    assert.ok(held, "the failed reading must surface, not vanish");
    assert.match(held.message, /unmonitored/i, "and it must say it could not look, not that all is well");
  });
});

test("an outbox that cannot be read reports unmonitored on the API too", async () => {
  const base = buildServices({ inMemory: true });
  const services = {
    ...base,
    bus: {
      ...base.bus,
      backlog: async () => {
        throw new Error("queue unreachable");
      },
    },
  } as unknown as Services;

  await withServer(services, async (b) => {
    const { json } = await get(b, "/api/v1/ops/monitors");
    assert.equal(json.healthy, false);
    assert.ok(
      json.firing.some((f: { message: string }) => /unmonitored/i.test(f.message)),
      "a queue nobody can read is a finding, not a silence"
    );
  });
});

// ── 4. ONE DEFINITION OF HEALTHY ──────────────────────────────────────────────────────

/**
 * Readiness used to compute its own outbox check while the watchdog computed a different one, and
 * the money checks appeared in neither. If the two can disagree, the one an operator happens to
 * look at decides whether they act — which is not a property a health surface may have.
 */
test("readiness and the monitor surface cannot disagree — they are the same readings", async () => {
  const services = withMoney(buildServices({ inMemory: true }), {
    heldSummary: async () => ({
      count: 1,
      oldestReceivedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      totalCents: 50_000,
    }),
  });

  await withServer(services, async (base) => {
    const monitors = (await get(base, "/api/v1/ops/monitors")).json;
    const readiness = await get(base, "/api/v1/ops/readiness");

    const firingKeys = monitors.firing.map((f: { key: string }) => f.key).sort();
    const failedChecks = readiness.json.checks
      .filter((c: { ok: boolean }) => !c.ok)
      .map((c: { name: string }) => c.name)
      .sort();

    assert.deepEqual(failedChecks, firingKeys, "every firing monitor must be a failing readiness check");
    assert.equal(readiness.json.ready, false, "and a system with money stopped is not ready");
    assert.equal(readiness.status, 503, "which the transport must say too, not only the body");
  });
});

test("readiness still reports the infrastructure checks the watchdog knows nothing about", async () => {
  await withServer(buildServices({ inMemory: true }), async (base) => {
    const { json } = await get(base, "/api/v1/ops/readiness");
    const names = json.checks.map((c: { name: string }) => c.name);
    // Database reachability and PHI configuration are not money conditions; consuming the watchdog
    // must not have dropped them.
    assert.ok(names.includes("database"), "readiness still owns infrastructure");
    assert.ok(names.includes("phi_encryption"));
    // And it now carries the money checks it never had.
    assert.ok(names.includes(HELD_REMITTANCE_AGE), "readiness gained the money half it was missing");
  });
});

// ── 5. Reading must not MUTATE the alerting state machine ─────────────────────────────

/**
 * `AlertGate` is a state machine: `evaluate` advances a streak and stamps a cooldown. If the route
 * asked the gate, rendering the Ops page would advance the alerting state — a page refresh could
 * consume the cooldown that decides whether an operator is told at all, and a screen nobody opened
 * would alert differently from one that was.
 *
 * `takeReadings` takes no gate, which is the structural guarantee. Asserted directly so a future
 * change that threads a gate through here has to fail a test to do it.
 */
test("taking a reading is idempotent and gate-free", async () => {
  const services = withMoney(buildServices({ inMemory: true }), {
    heldSummary: async () => ({
      count: 1,
      oldestReceivedAt: new Date(at(0).getTime() - 30 * 86_400_000).toISOString(),
      totalCents: 1_000,
    }),
  });

  const first = await takeReadings(services, DEFAULT_THRESHOLDS, at(0), "this-practice");
  const second = await takeReadings(services, DEFAULT_THRESHOLDS, at(0), "this-practice");

  assert.deepEqual(second, first, "the same instant must produce the same reading, however many times asked");
  assert.ok(
    first.some((r) => r.key === HELD_REMITTANCE_AGE && r.breaching),
    "and it is breaching both times — not suppressed by a cooldown the second time"
  );
});
