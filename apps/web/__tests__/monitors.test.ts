/**
 * The monitors, driven against real services.
 *
 * `runChecks` returns its decisions instead of logging them, which is what lets these tests assert
 * on what an operator would be TOLD rather than scrape a log for a substring. The point of each
 * case is a failure that leaves every business screen looking healthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertGate } from "@mermaid/observability";
import {
  DEFAULT_THRESHOLDS,
  ERA_DEAD_LETTERS,
  HELD_REMITTANCE_AGE,
  OUTBOX_DEAD_LETTERS,
  OUTBOX_LAG,
  RECONCILIATION_DRIFT,
  runChecks,
  startMonitors,
} from "../monitors.ts";
import { buildServices, type Services } from "../wiring.ts";
import { HELD_REMITTANCE_REVIEW_DAYS } from "../today.ts";
import { LAPSED_CONTRACTED_RATE, UNSTABLE_CONTRACTED_RATE } from "../monitors.ts";

const at = (ms: number): Date => new Date(1_700_000_000_000 + ms);

/**
 * A complete stand-in for the remittance service's three money readings.
 *
 * Spreading the real service (`{...services.remittance}`) copies own properties only — every method
 * lives on the prototype, so the spread silently produces an object with none of them. That was
 * invisible while the monitor asked exactly one question the fakes always overrode by hand; the
 * moment it asked a second, the fake answered "not a function" and the reading was lost. Defaults
 * are supplied here so a fake is complete by construction and a test overrides only what it is about.
 */
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

/** Fire every check `n` times so a sustained condition clears the gate's streak requirement. */
async function sustain(services: Services, gate: AlertGate, n: number, thresholds = DEFAULT_THRESHOLDS) {
  let last: Awaited<ReturnType<typeof runChecks>> = [];
  for (let i = 0; i < n; i++) last = await runChecks(services, gate, thresholds, at(i * 1_000));
  return last;
}

test("a healthy system produces no alerts at all", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 0 });

  const notes = await runChecks(services, gate, DEFAULT_THRESHOLDS, at(0));
  assert.deepEqual(notes, [], "silence is the correct output for a system with nothing wrong");
});

test("a stalled outbox is announced — the failure no business screen reveals", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 2, cooldownMs: 60_000 });

  // An event that has sat undelivered far longer than the threshold allows.
  const stalled = {
    backlog: async () => ({ pending: 3, dead: 0, oldestPending: at(-30 * 60_000).toISOString() }),
  };
  const withStall = { ...services, bus: { ...services.bus, ...stalled } } as unknown as Services;

  const notes = await sustain(withStall, gate, 2);
  const lag = notes.find((n) => n.key === OUTBOX_LAG);

  assert.equal(lag?.kind, "firing");
  assert.match(lag!.message, /not draining/);
  assert.match(lag!.message, /learning loop is stalled/);
  assert.equal(lag!.detail.pending, 3);
});

test("a dead-lettered event is announced — it is a business fact that never happened", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const withDead = {
    ...services,
    bus: { ...services.bus, backlog: async () => ({ pending: 0, dead: 2, oldestPending: null }) },
  } as unknown as Services;

  const notes = await runChecks(withDead, gate, DEFAULT_THRESHOLDS, at(0));
  const dead = notes.find((n) => n.key === OUTBOX_DEAD_LETTERS);

  assert.equal(dead?.kind, "firing");
  assert.equal(dead!.detail.dead, 2);
  assert.match(dead!.message, /exhausted their retries/);
});

test("money that does not reconcile is announced, and the tolerance is zero", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const drifting = {
    ...services,
    remittance: remittanceFake({
      reconcileAll: async () => ({
        paymentsReceived: 100_000,
        amountPosted: 99_900,
        providerAdjustments: 0,
        drift: 100,
        balanced: false,
        summary: "posted 100 cents less than the payers sent",
      }),
    }),
  } as unknown as Services;

  const notes = await runChecks(drifting, gate, DEFAULT_THRESHOLDS, at(0));
  const money = notes.find((n) => n.key === RECONCILIATION_DRIFT);

  assert.equal(money?.kind, "firing", "one cent of drift is a person's problem, not a rounding tolerance");
  assert.equal(money!.detail.driftCents, 100);
  assert.match(money!.message, /does not reconcile/);
  /** Same rule as the held-money alert: the sentence a person acts on states money as money. */
  assert.match(money!.message, /\$1\.00 of drift/, "not '100 cent(s)'");
  assert.doesNotMatch(money!.message, /cent\(s\)/);
});

test("a monitor that cannot take its reading says so rather than going quiet", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const broken = {
    ...services,
    bus: {
      ...services.bus,
      backlog: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    },
  } as unknown as Services;

  const notes = await runChecks(broken, gate, DEFAULT_THRESHOLDS, at(0));
  const lag = notes.find((n) => n.key === OUTBOX_LAG);

  // A monitor that throws takes the timer down and then watches nothing — the very failure it
  // exists to prevent, reached from the other direction.
  assert.equal(lag?.kind, "firing");
  assert.match(lag!.message, /now unmonitored/);
  assert.match(String(lag!.detail.error), /connection terminated/);
});

test("checks keep running after one of them fails", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const halfBroken = {
    ...services,
    bus: {
      ...services.bus,
      backlog: async () => {
        throw new Error("down");
      },
    },
    remittance: remittanceFake({
      reconcileAll: async () => ({
        paymentsReceived: 0,
        amountPosted: 50,
        providerAdjustments: 0,
        drift: 50,
        balanced: false,
        summary: "drift",
      }),
    }),
  } as unknown as Services;

  const notes = await runChecks(halfBroken, gate, DEFAULT_THRESHOLDS, at(0));
  assert.ok(notes.some((n) => n.key === OUTBOX_LAG), "the queue failure was reported");
  assert.ok(
    notes.some((n) => n.key === RECONCILIATION_DRIFT),
    "and the money was still checked — one blind monitor must not blind the others"
  );
});

test("the in-memory demo starts no monitors — there is no durable queue to stall", () => {
  const services = buildServices({ inMemory: true });
  const handle = startMonitors(services);
  handle.stop();
  assert.equal(services.persistent, false);
});

/**
 * ── THE REGRESSION THIS FILE EXISTED WITHOUT ───────────────────────────────────────────────────
 *
 * The money check called `remittance.reconcileAll()` directly from a `setInterval` tick. Under
 * Postgres every repository read requires the ambient practice-scoped transaction that `withPractice`
 * opens; with no request behind the tick there was none, so the call threw on EVERY tick and the
 * catch reported "the money is now unmonitored". The watchdog had never once looked at the money.
 *
 * Nothing above caught it, because `buildServices({inMemory: true})` uses repositories that need no
 * transaction — the tests exercised a code path production never took. So this case asserts the
 * property that actually differs: a persistent deployment must scope the reconciliation per practice
 * rather than calling it bare, and the alert must report how many practices it managed to check.
 */
test("under Postgres the reconciliation is scoped per practice, not called bare", async () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });
  const scoped: string[] = [];

  // A stand-in for the durable deployment: `persistent` true, and a reconcileAll that refuses to run
  // outside a practice scope exactly as the Postgres repository does.
  const services = buildServices({ inMemory: true });
  const persistent = {
    ...services,
    persistent: true,
    bus: { ...services.bus, backlog: async () => ({ pending: 0, dead: 0, oldestPending: null }) },
    remittance: remittanceFake({
      reconcileAll: async () => {
        if (scoped.length === 0) throw new Error("no ambient database transaction");
        return {
          paymentsReceived: 0,
          amountPosted: 0,
          providerAdjustments: 0,
          drift: 0,
          balanced: true,
          summary: "nothing to reconcile",
        };
      },
    }),
  } as unknown as Services;

  // `reconcileEveryPractice` reaches the database to enumerate practices, which this suite has no
  // connection for. Driving it through the seam it actually uses would need one, so the assertion
  // here is the narrower, still-decisive one: with no practice ever scoped, the check FAILS — which
  // is precisely what production was doing silently every minute.
  const notes = await runChecks(persistent, gate, DEFAULT_THRESHOLDS, at(0));
  const money = notes.find((n) => n.key === RECONCILIATION_DRIFT);

  assert.equal(money?.kind, "firing");
  assert.match(
    money!.message,
    /now unmonitored/,
    "an unscoped reconciliation must be loud, not silently reported as healthy money"
  );

  // …and once a scope exists the SAME services reconcile for real, and the alert now reports how
  // much of the money it actually managed to look at — the number whose absence hid the bug.
  scoped.push("practice-1");
  const drifting = {
    ...persistent,
    persistent: false, // the in-memory path: one implicit practice, no transaction to open
    remittance: remittanceFake({
      reconcileAll: async () => ({
        paymentsReceived: 100_000,
        amountPosted: 99_900,
        providerAdjustments: 0,
        drift: 100,
        balanced: false,
        summary: "posted 100 cents less than the payers sent",
      }),
    }),
  } as unknown as Services;

  const checked = await runChecks(drifting, new AlertGate({ consecutive: 1, cooldownMs: 0 }), DEFAULT_THRESHOLDS, at(1_000));
  const reconciled = checked.find((n) => n.key === RECONCILIATION_DRIFT);
  assert.equal(reconciled?.kind, "firing");
  assert.equal(reconciled!.detail.practicesChecked, 1, "the alert reports how much of the money it saw");
  assert.equal(reconciled!.detail.practicesBreaching, 1);
  assert.equal(reconciled!.detail.driftCents, 100);
});

/**
 * ── STOPPED MONEY ──────────────────────────────────────────────────────────────────────────────
 *
 * The two readings drift cannot take, for opposite reasons.
 *
 * A HELD remittance is a row in the table, so `reconcileAll()` sums it and reports the practice
 * balanced — correctly — while the payer's cash sits in the bank against no ledger entry and nobody
 * works it. An ABANDONED ERA file never became a row at all, so it contributes to neither side of
 * the sum and the practice reports balanced for the opposite reason. Both look healthy from every
 * other angle in this file, which is exactly why they are here.
 */

const heldFor = (days: number): { count: number; oldestReceivedAt: string | null; totalCents: number } => ({
  count: 1,
  oldestReceivedAt: new Date(at(0).getTime() - days * 86_400_000).toISOString(),
  totalCents: 60_000,
});

test("money held past the review window is announced, with the amount at risk", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const stuck = {
    ...services,
    remittance: remittanceFake({ heldSummary: async () => ({ ...heldFor(9), count: 3, totalCents: 412_50 }) }),
  } as unknown as Services;

  const notes = await runChecks(stuck, gate, DEFAULT_THRESHOLDS, at(0));
  const held = notes.find((n) => n.key === HELD_REMITTANCE_AGE);

  assert.equal(held?.kind, "firing");
  assert.equal(held!.detail.heldCount, 3);
  assert.equal(
    held!.detail.heldCents,
    41_250,
    "the MONEY, not just the count — '3 held' is deferrable, '3 held, $412.50' is a decision"
  );
  assert.match(held!.message, /in the bank against nothing/);
  assert.match(held!.message, /9 day/);
  /**
   * The sentence a person is woken by has to be readable as money. It said "41250 cent(s)" — in the
   * one message whose whole purpose is to make somebody act, and directly under a comment arguing
   * that an alert without the money is not actionable. $412.50 misread as $41,250 is a different
   * decision at six in the morning.
   */
  assert.match(held!.message, /\$412\.50/, "dollars and cents, as everywhere else in the system");
  assert.doesNotMatch(held!.message, /cent\(s\)/, "never a raw integer for a human to divide by 100");

  // …and the reading that hides it: this same practice reconciles perfectly.
  const drift = notes.find((n) => n.key === RECONCILIATION_DRIFT);
  assert.equal(drift, undefined, "held money reconciles — which is the whole reason it needed its own reading");
});

test("money held inside the review window is not an alert", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const fresh = {
    ...services,
    remittance: remittanceFake({ heldSummary: async () => heldFor(1) }),
  } as unknown as Services;

  const notes = await runChecks(fresh, gate, DEFAULT_THRESHOLDS, at(0));
  assert.equal(
    notes.find((n) => n.key === HELD_REMITTANCE_AGE),
    undefined,
    "yesterday's hold is normal traffic; alerting on it is how a monitor gets muted"
  );
});

test("an abandoned ERA file is announced, and the tolerance is zero", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const abandoned = {
    ...services,
    remittance: remittanceFake({
      deadLetteredArtifacts: async () => [{ id: "a1", fileExecutionId: "file-lost-1", deadLettered: true }],
    }),
  } as unknown as Services;

  const notes = await runChecks(abandoned, gate, DEFAULT_THRESHOLDS, at(0));
  const dead = notes.find((n) => n.key === ERA_DEAD_LETTERS);

  assert.equal(dead?.kind, "firing", "one abandoned payment file is one too many — the same zero as the outbox");
  assert.equal(dead!.detail.deadLetters, 1);
  assert.match(dead!.message, /never reached the ledger/);
});

/**
 * The gate's job, on the new keys specifically. A condition that persists is announced ONCE and then
 * again when it clears — a monitor that repeats itself every 60 seconds is one people filter, and a
 * filtered monitor is worse than none because the dashboard still shows its tile.
 */
test("a persistent hold is announced once, not once a tick, and its recovery is announced too", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  let summary = heldFor(9);
  const stuck = {
    ...services,
    remittance: remittanceFake({ heldSummary: async () => summary }),
  } as unknown as Services;

  const first = await runChecks(stuck, gate, DEFAULT_THRESHOLDS, at(0));
  assert.equal(first.filter((n) => n.key === HELD_REMITTANCE_AGE).length, 1, "said once");

  for (let tick = 1; tick <= 5; tick++) {
    const repeat = await runChecks(stuck, gate, DEFAULT_THRESHOLDS, at(tick * 1_000));
    assert.equal(
      repeat.filter((n) => n.key === HELD_REMITTANCE_AGE).length,
      0,
      "and not again on every tick while nothing has changed"
    );
  }

  // A person releases it.
  summary = { count: 0, oldestReceivedAt: null, totalCents: 0 };
  const cleared = await runChecks(stuck, gate, DEFAULT_THRESHOLDS, at(6_000));
  const recovery = cleared.find((n) => n.key === HELD_REMITTANCE_AGE);
  assert.equal(recovery?.kind, "resolved", "clearing is worth exactly one line: it tells an operator to stop looking");
  assert.match(recovery!.message, /No remittance has been held longer/);
});

/**
 * ── THE ASSERTION AN EARLIER VERSION OF THIS TEST COULD NOT MAKE ───────────────────────────────
 *
 * The first draft asserted that a failed reading produces no alert. It passed — and it passed just
 * as happily against a mutation that treated a failed reading as `{count: 0}`, because "nothing is
 * held" and "could not ask" both compute to zero milliseconds of age and both fire nothing. The
 * test was hollow, and it was hollow in precisely the direction this whole body of work is about: a
 * broken query reading as good news.
 *
 * Silence was also the wrong BEHAVIOUR, not just an untestable one. So a check that could not take
 * its reading now says so, exactly as the outbox and drift checks already do, and this test asserts
 * the sentence an operator would actually receive. Restore the conflation and it fails.
 */
test("a reading that fails is announced as unmonitored, never as zero held and zero abandoned", async () => {
  const services = buildServices({ inMemory: true });
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });

  const broken = {
    ...services,
    remittance: remittanceFake({
      heldSummary: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      deadLetteredArtifacts: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    }),
  } as unknown as Services;

  const notes = await runChecks(broken, gate, DEFAULT_THRESHOLDS, at(0));

  const held = notes.find((n) => n.key === HELD_REMITTANCE_AGE);
  assert.equal(held?.kind, "firing", "a monitor that cannot look must not report the all-clear");
  assert.match(held!.message, /now unmonitored/);
  assert.equal(held!.detail.practicesRead, 0, "and it says how much it managed to see: none of it");
  assert.equal(held!.detail.practicesSeen, 1);

  const era = notes.find((n) => n.key === ERA_DEAD_LETTERS);
  assert.equal(era?.kind, "firing");
  assert.match(era!.message, /now unmonitored/);

  assert.equal(
    notes.find((n) => n.key === RECONCILIATION_DRIFT),
    undefined,
    "and the reading that DID work is unaffected: one blind reading must not blind the other two"
  );
});

// ── The board and the watchdog must call a hold late at the same instant ──────────────────────

/**
 * `DEFAULT_THRESHOLDS.heldRemittanceAgeMs` was written out as `3 * 86_400_000`, restating
 * `HELD_REMITTANCE_REVIEW_DAYS` from `today.ts` under a comment saying the two must not disagree.
 * They already did: the board marks a hold urgent AT day three (`heldDays >= 3`) while this alarmed
 * only after three full days had elapsed (`>`). For up to a day the queue showed urgent work and the
 * watchdog reported "no remittance has been held longer than the review window" — so an operator
 * checking the alert would have been told the board was crying wolf.
 *
 * The threshold is now derived from the same constant and both comparisons are `>=`.
 */
test("the monitor's window is the board's window, not a copy of it", () => {
  assert.equal(
    DEFAULT_THRESHOLDS.heldRemittanceAgeMs,
    HELD_REMITTANCE_REVIEW_DAYS * 86_400_000,
    "one constant, so the two surfaces cannot drift apart"
  );
});

test("a hold that is exactly at the window is late on BOTH surfaces", async () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });
  const services = {
    ...buildServices({ inMemory: true }),
    remittance: remittanceFake({ heldSummary: async () => heldFor(HELD_REMITTANCE_REVIEW_DAYS) }),
  } as unknown as Services;

  const note = (await runChecks(services, gate, DEFAULT_THRESHOLDS, at(0))).find(
    (n) => n.key === HELD_REMITTANCE_AGE
  );
  assert.equal(note?.kind, "firing", "the board calls this urgent, so the watchdog must agree");
});

test("a hold one day short of the window is late on neither", async () => {
  const gate = new AlertGate({ consecutive: 1, cooldownMs: 60_000 });
  const services = {
    ...buildServices({ inMemory: true }),
    remittance: remittanceFake({ heldSummary: async () => heldFor(HELD_REMITTANCE_REVIEW_DAYS - 1) }),
  } as unknown as Services;

  const note = (await runChecks(services, gate, DEFAULT_THRESHOLDS, at(0))).find(
    (n) => n.key === HELD_REMITTANCE_AGE
  );
  assert.equal(note, undefined, "alarming early would teach an operator to ignore the alert");
});

// ── A contracted rate the payer keeps changing ────────────────────────────────────────────────

/**
 * The estimate quotes patients from learned allowances, and L-3 prices denied lines from them too.
 * `restatements` counted how often a payer had contradicted itself from the day the store was built
 * — and nothing read it. Computed, stored, surfaced nowhere: the exact defect F-7 existed to close,
 * reappearing inside the feature that fixed it.
 */
const withRates = (
  rates: { payerId: string; cdtCode: string; allowed: number; restatements: number; fullPriceSince?: number }[]
) =>
  ({
    ...buildServices({ inMemory: true }),
    remittance: remittanceFake(),
    allowedAmounts: {
      listAll: async () =>
        rates.map((r) => ({
          ...r,
          charged: r.allowed,
          observations: r.restatements,
          fullPriceSince: r.fullPriceSince ?? 0,
          firstSeenAt: "",
          lastSeenAt: "",
        })),
    },
  }) as unknown as Services;

const rateNote = async (services: Services) =>
  (await runChecks(services, new AlertGate({ consecutive: 1, cooldownMs: 60_000 }), DEFAULT_THRESHOLDS, at(0))).find(
    (n) => n.key === UNSTABLE_CONTRACTED_RATE
  );

test("a rate the payer has restated repeatedly is raised, and named", async () => {
  const note = await rateNote(
    withRates([{ payerId: "delta-dental", cdtCode: "D2750", allowed: 100_000, restatements: 4 }])
  );
  assert.equal(note?.kind, "firing");
  assert.equal(note!.detail.unstable, 1);
  assert.match(note!.message, /D2750/, "the code a person has to go and check");
  assert.match(note!.message, /delta-dental/);
  assert.match(note!.message, /keeps\s+contradicting|contradicting/, "and why it matters for a quote");
});

test("a single renegotiation is not an alarm", async () => {
  /**
   * Contracts change. The newest reading is simply the current rate, and alarming on it would fire
   * on every practice every year — which is how an alert stops being read.
   */
  assert.equal(
    await rateNote(withRates([{ payerId: "delta-dental", cdtCode: "D2750", allowed: 100_000, restatements: 2 }])),
    undefined
  );
});

test("a stable schedule raises nothing", async () => {
  assert.equal(
    await rateNote(withRates([{ payerId: "delta-dental", cdtCode: "D2750", allowed: 100_000, restatements: 1 }])),
    undefined
  );
});

test("a fee schedule that could not be read says so rather than reporting stability", async () => {
  const broken = {
    ...buildServices({ inMemory: true }),
    remittance: remittanceFake(),
    allowedAmounts: { listAll: async () => { throw new Error("unreadable"); } },
  } as unknown as Services;
  const note = await rateNote(broken);
  assert.equal(note?.kind, "firing");
  assert.match(note!.message, /now unmonitored/);
});

// ── A contract the payer has stopped applying ─────────────────────────────────────────────────

const lapsedNote = async (services: Services) =>
  (await runChecks(services, new AlertGate({ consecutive: 1, cooldownMs: 60_000 }), DEFAULT_THRESHOLDS, at(0))).find(
    (n) => n.key === LAPSED_CONTRACTED_RATE
  );

test("a rate the payer has stopped applying is raised, and says what it costs the patient", async () => {
  /**
   * The estimate is still quoting a discount the payer no longer gives. Every quote since the run
   * began has told a patient they owe less than they do — and the practice finds out when the
   * balance arrives, not when the quote is given.
   */
  const note = await lapsedNote(
    withRates([{ payerId: "delta-dental", cdtCode: "D2750", allowed: 112_500, restatements: 1, fullPriceSince: 4 }])
  );
  assert.equal(note?.kind, "firing");
  assert.equal(note!.detail.lapsed, 1);
  assert.match(note!.message, /D2750/);
  assert.match(note!.message, /owe less than they do/, "the consequence, not just the count");
});

test("one or two full-price adjudications are not a lapsed contract", async () => {
  /** Ordinary traffic: a service outside the agreement, a secondary payer. Alarming here is noise. */
  for (const run of [0, 1, 2]) {
    assert.equal(
      await lapsedNote(
        withRates([{ payerId: "delta-dental", cdtCode: "D2750", allowed: 112_500, restatements: 1, fullPriceSince: run }])
      ),
      undefined,
      `fullPriceSince ${run} must not fire`
    );
  }
});

test("a rate can be unstable without being lapsed, and the two alerts stay separate", async () => {
  /**
   * They mean different things and want different actions: restatements says the contract MOVED and
   * the rate should be confirmed; full-price says the contract is not being applied at all. Merging
   * them would tell a practice to check a fee schedule when they have actually left the network.
   */
  const services = withRates([
    { payerId: "delta-dental", cdtCode: "D2750", allowed: 112_500, restatements: 5, fullPriceSince: 0 },
  ]);
  assert.equal((await lapsedNote(services)), undefined, "unstable is not lapsed");
  const notes = await runChecks(services, new AlertGate({ consecutive: 1, cooldownMs: 60_000 }), DEFAULT_THRESHOLDS, at(0));
  assert.ok(notes.some((n) => n.key === UNSTABLE_CONTRACTED_RATE), "but it IS unstable");
});
