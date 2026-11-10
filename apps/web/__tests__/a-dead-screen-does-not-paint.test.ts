/**
 * A screen that has been unmounted may not render again.
 *
 * ── THE DEFECT, AND HOW IT WAS FOUND ───────────────────────────────────────────────────────────
 * `load` renders in a `finally`, and nothing asked whether the screen that requested it still
 * existed. Switching tabs while the first fetch was in the air produced this:
 *
 *   Today.load() starts → the user clicks Claims → Today.destroy() clears the stage →
 *   Claims renders → Today's fetch resolves → Today's render() paints Today back into the stage
 *
 * leaving the rail, the page title and `data-stage-titled` all saying "claims" over a screen
 * showing Today's triage board. It was caught by photographing the app at 375px on a slow machine,
 * where Today's first fetch had not landed before the click. Every metric said the page was fine:
 * no overflow, no error state, no stuck skeleton, correct viewport. The screenshot showed the wrong
 * screen.
 *
 * ── WHY IT LOOKED LIKE IT NEVER HAPPENED ───────────────────────────────────────────────────────
 * On a fast connection the window between mount and first paint is a few hundred milliseconds, so
 * nobody clicks inside it. A practice on bad surgery wifi lives inside that window all day, and
 * "the screen showed me the wrong thing" is the kind of report that gets closed as unreproducible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../public/", import.meta.url));
const states = readFileSync(DIR + "states.js", "utf8");

/**
 * The real thing, imported the only way this codebase can import a browser module from a test: as
 * text, evaluated. `states.js` has no DOM dependency in `load` — it takes callbacks — so this runs
 * the shipped implementation rather than a copy of it.
 */
async function loadStates(): Promise<{
  load: (h: Record<string, unknown>, f: () => Promise<void>, r: () => void) => Promise<void>;
  retire: (h: Record<string, unknown>) => void;
}> {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(states).toString("base64")}`);
  return mod as never;
}

const handle = () => ({ loading: false, failed: null, loaded: false });

test("a load that finishes after the screen is gone does not render", async () => {
  const { load, retire } = await loadStates();
  const h = handle();
  const painted: string[] = [];

  let release!: () => void;
  const inFlight = new Promise<void>((r) => (release = r));

  const running = load(h, () => inFlight, () => painted.push("render"));

  /* The skeleton paint is correct and expected — the screen is alive at that point. */
  assert.deepEqual(painted, ["render"], "the loading state should paint");

  /* The user switches tabs. */
  retire(h);
  release();
  await running;

  assert.deepEqual(
    painted,
    ["render"],
    "the screen was unmounted while its fetch was in the air, and it painted anyway — over whatever " +
      "screen replaced it"
  );
});

test("a load that fails after the screen is gone does not render its error either", async () => {
  /**
   * The `finally` runs on both paths, so the error state had the same defect and is the worse of
   * the two: a failure belonging to a screen nobody is looking at, reported on top of a screen that
   * is working.
   */
  const { load, retire } = await loadStates();
  const h = handle();
  const painted: string[] = [];

  let fail!: (e: Error) => void;
  const inFlight = new Promise<void>((_, rej) => (fail = rej));

  const running = load(h, () => inFlight, () => painted.push("render"));
  retire(h);
  fail(new Error("payer timed out"));
  await running;

  assert.deepEqual(painted, ["render"], "a dead screen reported its error over a live one");
  assert.equal((h as { failed: Error | null }).failed?.message, "payer timed out", "still recorded");
});

test("a retired handle refuses to start a new load at all", async () => {
  const { load, retire } = await loadStates();
  const h = handle();
  let fetched = false;

  retire(h);
  await load(h, async () => { fetched = true; }, () => { throw new Error("must not paint"); });

  assert.equal(fetched, false, "an unmounted screen should not still be fetching");
});

test("the guard does not break the ordinary path", async () => {
  /* The failure mode of a guard is refusing everything, which would look like a screen that never
     loads — so the living case is asserted beside the dead one. */
  const { load } = await loadStates();
  const h = handle();
  const painted: string[] = [];

  await load(h, async () => {}, () => painted.push("render"));

  assert.deepEqual(painted, ["render", "render"], "skeleton then result");
  assert.equal((h as { loaded: boolean }).loaded, true);
});

test("every screen retires its handle when it is destroyed", () => {
  /**
   * The guard in `states.js` is inert unless each screen sets the flag. Eight screens share this
   * lifecycle, and one that forgets has the original bug back with no sign of it.
   */
  const screens = readdirSync(DIR).filter(
    (f) => f.endsWith(".js") && readFileSync(DIR + f, "utf8").includes('from "./states.js"')
  );
  assert.ok(screens.length >= 8, `expected the eight screens, found ${screens.length}`);

  const missing = screens.filter((f) => {
    const text = readFileSync(DIR + f, "utf8");
    if (!/\bload as loadWithStates\b|\bload\(/.test(text)) return false;
    const destroy = text.match(/destroy\(\)\s*\{[^}]*\}/);
    return !destroy || !destroy[0].includes("retire(");
  });

  assert.deepEqual(
    missing,
    [],
    "these screens run a load through states.js but never retire their handle, so an unmount " +
      "leaves the in-flight render free to paint over the next screen"
  );
});
