/**
 * The load lifecycle (§7), and the defect that made it worth extracting.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────────────
 * Every rebuilt screen loaded like this:
 *
 *     async function load() {
 *       loading = true;
 *       try { ...fetch... } finally { loading = false }
 *       drawAll();
 *     }
 *
 * There is no `catch`. A failing request threw out of `load()` as an unhandled rejection, `drawAll`
 * never ran, and the screen stayed blank for ever — no message, no retry, nothing to distinguish
 * "the server is down" from "you have no claims". On a screen about money those are opposite facts.
 *
 * ── WHY THE HANDLE IS SHAPED THIS WAY ──────────────────────────────────────────────────────────
 * `load` renders three times — at the start so a skeleton can appear, on failure, and on
 * completion — and decides none of them. Eight screens differ too much to share a renderer and do
 * not differ at all in needing all three to happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * A stub whose `append` actually appends.
 *
 * It was a no-op, which was fine while this file only exercised `load` and `freshness` — and
 * useless the moment it needed to read back what `errorBlock` had built. A stub that silently
 * discards what is written to it cannot tell a correct render from an empty one.
 */
const makeEl = () => {
  const children: unknown[] = [];
  return {
    className: "", textContent: "", type: "", style: {}, children,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {},
    append: (...kids: unknown[]) => { children.push(...kids); },
    replaceChildren: (...kids: unknown[]) => { children.length = 0; children.push(...kids); },
  };
};
(globalThis as Record<string, unknown>).document = { createElement: () => makeEl() };

const { freshness, load } = await import("../public/states.js");

const handle = () => ({ loading: false, failed: null as Error | null, loaded: false });

test("a successful load renders twice: once for the skeleton, once for the data", async () => {
  const h = handle();
  const seen: Array<{ loading: boolean; loaded: boolean }> = [];
  await load(h, async () => {}, () => seen.push({ loading: h.loading, loaded: h.loaded }));

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { loading: true, loaded: false }, "the first render is the skeleton's chance");
  assert.deepEqual(seen[1], { loading: false, loaded: true }, "the second has the data");
  assert.equal(h.failed, null);
});

test("a failure becomes a state, and never an unhandled rejection", async () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. `load` must not rethrow: rethrowing would give the screen
   * its error state AND leave the crash in the console, and the next person would fix the console.
   */
  const h = handle();
  let rendered = 0;
  await load(h, async () => { throw new Error("payer portal returned no response"); }, () => rendered++);

  assert.equal(h.failed?.message, "payer portal returned no response");
  assert.equal(h.loading, false, "and the screen is not left thinking it is still loading");
  assert.equal(h.loaded, false, "a failed load has no data, so it did not load");
  assert.equal(rendered, 2, "the screen was still told to draw, which is how the error reaches it");
});

test("a non-Error rejection is still an Error by the time a screen reads it", async () => {
  /* A screen renders `failed.message`; a string rejection would render `undefined`. */
  const h = handle();
  await load(h, async () => { throw "gateway timeout"; }, () => {});
  assert.ok(h.failed instanceof Error);
  assert.equal(h.failed.message, "gateway timeout");
});

test("a retry after a failure clears the error before it starts", async () => {
  /* Otherwise the second attempt renders its skeleton underneath the first attempt's error. */
  const h = handle();
  await load(h, async () => { throw new Error("first"); }, () => {});
  assert.ok(h.failed);

  const duringFirstRender: Array<Error | null> = [];
  await load(h, async () => {}, () => duringFirstRender.push(h.failed));
  assert.equal(duringFirstRender[0], null, "the error is gone by the first render of the retry");
  assert.equal(h.failed, null);
  assert.equal(h.loaded, true);
});

test("a second load while one is in flight is ignored, not queued", async () => {
  /* Two concurrent fetches racing to write the same screen state is how a screen shows the older
     answer. The guard is on the handle, so it holds across the module boundary too. */
  const h = handle();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const first = load(h, async () => { calls++; await gate; }, () => {});
  await load(h, async () => { calls++; }, () => {});
  release();
  await first;
  assert.equal(calls, 1);
});

/* ══ §7.5 freshness ═══════════════════════════════════════════════════════════════════════════ */

const AT = Date.parse("2026-09-06T12:00:00.000Z");

test("freshness has three states, and the third is the reason it exists", () => {
  assert.equal(freshness("2026-09-06T11:59:30.000Z", AT).state, "live");
  assert.equal(freshness("2026-09-06T11:45:00.000Z", AT).state, "synced");
  /**
   * The one that matters. Data quietly presented as current when it is hours old is the failure
   * this indicator exists to prevent — a component that only ever says "synced" IS that failure
   * with a dot next to it.
   */
  const stale = freshness("2026-09-06T08:00:00.000Z", AT);
  assert.equal(stale.state, "stale");
  assert.match(stale.label, /stale/);
});

test("a missing or unreadable timestamp is 'never synced', never 'live'", () => {
  /* Failing toward "we do not know" rather than toward "it is current" is the whole point. */
  for (const bad of [null, undefined, "", "not-a-date"]) {
    assert.equal(freshness(bad as unknown as string, AT).state, "unknown");
  }
});

test("the label says how long, not merely that time has passed", () => {
  assert.equal(freshness("2026-09-06T11:56:00.000Z", AT).label, "synced 4m ago");
  assert.equal(freshness("2026-09-06T10:00:00.000Z", AT).label, "synced 2h ago");
});

/* ══ §7.6 A permission boundary is not a failure ══════════════════════════════════════════════ */

/**
 * The distinction these assert is not cosmetic. A 403 rendered with the failure copy — "could not
 * be loaded", "Try again" — describes an outage that is not happening, and sends someone looking
 * for a bug in a system that is working exactly as configured.
 *
 * `errorBlock` builds DOM, so these read what it produced through the stub rather than a string.
 */
const textOf = (el: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const node = n as { textContent?: string; children?: unknown[] };
    if (typeof node?.textContent === "string" && node.textContent) out.push(node.textContent);
    for (const k of node?.children ?? []) walk(k);
  };
  walk(el);
  return out;
};

test("a 403 states which role is missing and what the screen would have shown", async () => {
  const { errorBlock } = await import("../public/states.js");
  const forbidden = Object.assign(new Error("Your role (front desk) does not have access to this."), { status: 403 });

  const el = errorBlock({
    what: "Claims could not be loaded.",
    stakes: "Any claim waiting for release is still waiting.",
    shows: "every claim in its lifecycle, and what is stuck",
    error: forbidden,
    retry: () => {},
  });
  const text = textOf(el).join(" | ");

  assert.match(text, /Not visible to your role/, "the headline says what happened, not that it failed");
  assert.match(text, /front desk/, "and keeps the server's own sentence about which role is missing");
  assert.match(text, /every claim in its lifecycle/, "§7.6: the SHAPE of what exists, not a blank space");
  assert.doesNotMatch(text, /could not be loaded/, "the failure copy must not appear");
  assert.doesNotMatch(text, /Try again/, "and there is no retry — nothing about pressing it changes the answer");
});

test("a dropped connection is explained, not quoted", async () => {
  /**
   * ── "Failed to fetch" WAS THE ONLY THING THIS SCREEN SAID ──────────────────────────────────────
   * Photographing the error state with the API blocked put the fetch API's own words on screen as
   * the entire explanation of why a practice could not see its coverage checks. Three browsers
   * produce three different sentences for that one condition and none of them names it, so the §7
   * block's "why" slot — the middle of what failed / why / the way back — was carrying a phrase
   * that means something only to whoever wrote the fetch call.
   *
   * It matters more than a wording nit because of what it implies: a request that never left says
   * the practice's data is intact and pressing Try again is worth doing, which is the opposite of
   * what a bare error string suggests.
   */
  const { errorBlock, explainNetwork } = await import("../public/states.js");

  for (const raw of [
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
    "The Internet connection appears to be offline.",
  ]) {
    const text = textOf(errorBlock({
      what: "Verifications could not be loaded.",
      stakes: "Coverage checks waiting on a person are not visible here.",
      error: new Error(raw),
      retry: () => {},
    })).join(" | ");

    assert.match(text, /could not reach the server/i, `${raw} was left unexplained`);
    assert.ok(text.includes(raw), `${raw} must survive verbatim — support asks the caller to read it out`);
  }

  /* A real server error is NOT a transport failure, and rewriting it would hide the only sentence
     that says what actually broke. */
  assert.equal(
    explainNetwork("Connection terminated unexpectedly"),
    "Connection terminated unexpectedly",
    "an error from the server keeps its own words"
  );
  assert.equal(explainNetwork("Your role does not have access."), "Your role does not have access.");
});

test("a 500 keeps the failure treatment, retry included", () => {
  /* The other side of the same branch: a real outage must not be softened into a permission note. */
  return import("../public/states.js").then(({ errorBlock }) => {
    const broken = Object.assign(new Error("Connection terminated"), { status: 500 });
    const text = textOf(errorBlock({
      what: "Claims could not be loaded.",
      stakes: "Any claim waiting for release is still waiting.",
      shows: "every claim in its lifecycle",
      error: broken,
      retry: () => {},
    })).join(" | ");

    assert.match(text, /could not be loaded/);
    assert.match(text, /Try again/);
    assert.doesNotMatch(text, /Not visible to your role/);
  });
});

test("an error with no status at all is treated as a failure, not as a permission boundary", () => {
  /* Failing toward "something is broken" is right: telling someone their role is the problem when
     it is not sends them to an administrator who cannot help. */
  return import("../public/states.js").then(({ errorBlock }) => {
    const text = textOf(errorBlock({
      what: "Claims could not be loaded.", shows: "claims", error: new Error("Failed to fetch"), retry: () => {},
    })).join(" | ");
    assert.match(text, /could not be loaded/);
    assert.doesNotMatch(text, /role/);
  });
});

/* ══ Polling: the liveness §8.1 and §8.8 describe, with the three restraints ═══════════════════ */

/**
 * The tick is driven BY HAND rather than by the clock.
 *
 * The first version of these waited 45ms for a 10ms interval and asserted two ticks had happened.
 * It passed, and then failed on the next run under load — a flaky test is worse than no test,
 * because the next person learns to re-run rather than to read it. Capturing the callback tests the
 * same logic (the visibility check, the guard, the error swallowing) and cannot be raced.
 */
function withCapturedInterval<T>(fn: (tick: () => Promise<void>, state: { ms: number | null; cleared: boolean }) => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const realSet = g.setInterval as typeof setInterval;
  const realClear = g.clearInterval as typeof clearInterval;
  const state = { ms: null as number | null, cleared: false };
  let captured: (() => void) | null = null;
  g.setInterval = ((fn2: () => void, ms: number) => { captured = fn2; state.ms = ms; return 1 as unknown as NodeJS.Timeout; }) as unknown as typeof setInterval;
  g.clearInterval = (() => { state.cleared = true; captured = null; }) as unknown as typeof clearInterval;
  const tick = async () => { await (captured ?? (() => {}))(); };
  return fn(tick, state).finally(() => { g.setInterval = realSet; g.clearInterval = realClear; });
}

const doc = () => (globalThis as Record<string, unknown>).document as Record<string, unknown>;

test("a poll runs on its interval, and stops when told to", async () => {
  doc().visibilityState = "visible";
  doc().addEventListener = () => {};
  doc().removeEventListener = () => {};
  const { poll } = await import("../public/states.js");

  await withCapturedInterval(async (tick, state) => {
    let runs = 0;
    const stop = poll(60_000, () => true, () => { runs++; });
    assert.equal(state.ms, 60_000, "scheduled at the interval it was given");
    await tick();
    await tick();
    assert.equal(runs, 2);
    stop();
    assert.equal(state.cleared, true, "and the timer is actually cleared, not merely forgotten");
  });
});

test("nothing polls while the tab is hidden", async () => {
  /**
   * A practice leaves this open all day beside a practice-management system. A background tab
   * quietly re-querying a database every minute for eight hours is a cost paid for nothing.
   */
  const { poll } = await import("../public/states.js");
  await withCapturedInterval(async (tick) => {
    doc().visibilityState = "hidden";
    let runs = 0;
    const stop = poll(60_000, () => true, () => { runs++; });
    await tick();
    await tick();
    assert.equal(runs, 0);
    doc().visibilityState = "visible";
    await tick();
    assert.equal(runs, 1, "and resumes the moment the tab is looked at again");
    stop();
  });
});

test("nothing polls while the caller says not to", async () => {
  /* The screens pass "no drill panel is open": a reader looking at one record must not have the
     screen behind it move, least of all the row they came from. */
  const { poll } = await import("../public/states.js");
  await withCapturedInterval(async (tick) => {
    doc().visibilityState = "visible";
    let runs = 0;
    let allowed = false;
    const stop = poll(60_000, () => allowed, () => { runs++; });
    await tick();
    assert.equal(runs, 0, "held while the guard is false");
    allowed = true;
    await tick();
    assert.equal(runs, 1, "and resumes without needing to be restarted");
    stop();
  });
});

test("a failed poll is silent, because the screen already has data", async () => {
  /**
   * §7.3's error treatment is for a screen with nothing to show. Turning a transient blip in a
   * background refresh into a full error state would erase good data to report a problem that has
   * already passed.
   */
  const { poll } = await import("../public/states.js");
  await withCapturedInterval(async (tick) => {
    doc().visibilityState = "visible";
    let ticks = 0;
    const stop = poll(60_000, () => true, async () => { ticks++; throw new Error("gateway timeout"); });
    await assert.doesNotReject(async () => { await tick(); await tick(); });
    assert.equal(ticks, 2, "and it keeps trying rather than giving up after the first failure");
    stop();
  });
});
