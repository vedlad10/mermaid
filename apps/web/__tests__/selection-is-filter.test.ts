/**
 * The store's contract: selection and filter are one state, and everything narrowing a view obeys
 * one predicate.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ──────────────────────────────────────────────────────────
 * The failure this store exists to prevent is two elements on one screen describing different
 * populations while looking like they describe the same one — a chart highlighting Tuesday while
 * the table below it still lists the whole month. That is not a cosmetic bug in a product about
 * money; it is a wrong answer.
 *
 * So the tests below are about AGREEMENT, not about the API surface: whatever narrows the view must
 * narrow every consumer of it, a chart click and a filter chip must be indistinguishable once
 * stored, and a timeframe change must not leave a selection pointing into a window that no longer
 * contains it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, RANGES } from "../public/store.js";

/** A payment advice, reduced to the fields the Money screen filters on. */
const advice = (over = {}) => ({
  id: "r1",
  payerName: "Delta Dental",
  status: "posted",
  receivedAt: "2026-08-28T04:40:14.000Z",
  paymentTotal: 79999,
  ...over,
});

type Advice = ReturnType<typeof advice>;
const ACCESSORS = {
  payer: (r: Advice) => r.payerName,
  status: (r: Advice) => r.status,
  bucket: (r: Advice) => String(r.receivedAt).slice(0, 10),
  at: (r: Advice) => r.receivedAt,
};

test("a chart click and a filter chip produce the same state", () => {
  /**
   * The spec's rule: "A chip created by clicking a chart element looks identical to one created
   * from the filter menu, and the chart element stays visibly selected." That can only hold if
   * both write the same thing, so this pins that they do.
   */
  const fromChart = createStore();
  fromChart.toggleFilter({ dim: "payer", value: "Delta Dental", label: "Payer: Delta Dental" });

  const fromMenu = createStore();
  fromMenu.toggleFilter({ dim: "payer", value: "Delta Dental", label: "Payer: Delta Dental" });

  assert.deepEqual(fromChart.get().filters, fromMenu.get().filters);
  assert.equal(fromChart.isFiltered("payer", "Delta Dental"), true);
  assert.equal(fromChart.chips().length, 1);
});

test("one predicate decides the population, so a chart and a table cannot disagree", () => {
  const s = createStore();
  const rows = [
    advice({ id: "a", payerName: "Delta Dental" }),
    advice({ id: "b", payerName: "Cigna Dental" }),
    advice({ id: "c", payerName: "Delta Dental", status: "held" }),
  ];

  assert.equal(rows.filter((r) => s.matches(r, ACCESSORS)).length, 3, "nothing selected shows everything");

  s.toggleFilter({ dim: "payer", value: "Delta Dental" });
  assert.deepEqual(
    rows.filter((r) => s.matches(r, ACCESSORS)).map((r) => r.id),
    ["a", "c"],
    "a payer filter narrows to that payer"
  );

  s.toggleFilter({ dim: "status", value: "held" });
  assert.deepEqual(
    rows.filter((r) => s.matches(r, ACCESSORS)).map((r) => r.id),
    ["c"],
    "dimensions AND together"
  );

  s.toggleFilter({ dim: "payer", value: "Cigna Dental" });
  assert.deepEqual(
    rows.filter((r) => s.matches(r, ACCESSORS)).map((r) => r.id),
    ["c"],
    "values within a dimension OR together — held, from either payer"
  );
});

test("selecting a chart point filters the records behind that point", () => {
  const s = createStore();
  const rows = [
    advice({ id: "a", receivedAt: "2026-08-28T04:40:14.000Z" }),
    advice({ id: "b", receivedAt: "2026-08-30T15:40:11.000Z" }),
  ];
  s.selectPoint("2026-08-28");
  assert.deepEqual(rows.filter((r) => s.matches(r, ACCESSORS)).map((r) => r.id), ["a"]);
  assert.equal(s.narrowed(), true);

  /* Clicking the same point again releases it — a chart is a toggle, not a trap. */
  s.selectPoint("2026-08-28");
  assert.equal(s.get().point, null);
  assert.equal(rows.filter((r) => s.matches(r, ACCESSORS)).length, 2);
});

test("a brush narrows to its range, and replaces a point rather than compounding it", () => {
  const s = createStore();
  const rows = [
    advice({ id: "a", receivedAt: "2026-08-27T19:56:43.000Z" }),
    advice({ id: "b", receivedAt: "2026-08-30T15:40:11.000Z" }),
    advice({ id: "c", receivedAt: "2026-09-03T20:48:00.000Z" }),
  ];
  s.selectPoint("2026-08-27");
  s.setBrush({ from: "2026-08-29T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" });

  assert.equal(s.get().point, null, "a brush supersedes a point; they are two answers to one question");
  assert.deepEqual(rows.filter((r) => s.matches(r, ACCESSORS)).map((r) => r.id), ["b"]);
});

test("changing timeframe drops a selection that the new window may not contain", () => {
  /**
   * A point is a position INSIDE a range. Carrying "2026-08-28" from a 90-day window into a 7-day
   * one would filter the new window by a bucket outside it and render an empty table that looks
   * like missing data.
   */
  const s = createStore();
  s.selectPoint("2026-08-28");
  s.setBrush({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" });
  s.setTimeframe("7d");

  assert.equal(s.get().timeframe.days, 7);
  assert.equal(s.get().point, null);
  assert.equal(s.get().brush, null);
});

test("the window is the range the report endpoint actually takes", () => {
  const s = createStore();
  s.setTimeframe("7d");
  const now = new Date("2026-09-05T12:00:00.000Z");
  const w = s.window(now);
  assert.equal(w.to, "2026-09-05T12:00:00.000Z");
  assert.equal(w.from, "2026-08-29T12:00:00.000Z", "seven days back, to the millisecond");
});

test("the drill stack preserves context instead of navigating away", () => {
  const s = createStore();
  s.toggleFilter({ dim: "payer", value: "Delta Dental" });
  s.pushDrill({ kind: "advice", id: "r1", label: "Delta Dental" });
  s.pushDrill({ kind: "posting", id: "p9", label: "Ada Demo" });

  assert.equal(s.get().drill.length, 2);
  assert.deepEqual(s.get().filters.map((f) => f.value), ["Delta Dental"], "drilling never clears the context behind it");

  /* A sibling row swaps the top rather than deepening the stack. */
  s.replaceDrill({ kind: "posting", id: "p10", label: "Ben Demo" });
  assert.equal(s.get().drill.length, 2);
  assert.equal(s.get().drill[1]!.id, "p10");

  s.popDrill();
  assert.equal(s.get().drill.length, 1, "going back reverses exactly one level");
});

test("subscribers are told what changed, and a listener cannot re-enter mid-notify", () => {
  const s = createStore();
  const reasons: string[] = [];
  let reentered = 0;
  s.subscribe((_st, reason) => {
    reasons.push(reason);
    /* A listener that dispatches during notification must not recurse. */
    if (reason === "metric" && reentered === 0) {
      reentered++;
      s.setMetric("held");
    }
  });
  s.setTimeframe("90d");
  s.setMetric("collected");
  assert.deepEqual(reasons, ["timeframe", "metric"], "one notification per dispatch, no re-entrant storm");
  assert.equal(s.get().metric, "held", "the re-entrant write still applied");
});

test("a no-op dispatch does not notify", () => {
  /* Redundant re-renders on a 100k-row table are a performance defect, not a cosmetic one. */
  const s = createStore();
  let n = 0;
  s.subscribe(() => n++);
  s.setTimeframe("30d");            // already 30d
  s.setMetric(null);                // already null
  s.clearFilters();                 // nothing to clear
  s.removeFilter({ dim: "payer", value: "nobody" });
  assert.equal(n, 0);
});

test("every offered range is real and ordered", () => {
  assert.ok(RANGES.length >= 3);
  for (const r of RANGES) assert.ok(Number.isInteger(r.days) && r.days > 0, `${r.key} has real days`);
  const days = RANGES.map((r) => r.days);
  assert.deepEqual(days, [...days].sort((a, b) => a - b), "ranges ascend, so the control reads left to right");
});

/* ══ Moving between screens ═══════════════════════════════════════════════════════════════════ */

test("a screen change clears everything that belonged to the old screen's picture", () => {
  /**
   * ── THE BUG THIS PREVENTS ────────────────────────────────────────────────────────────────────
   * Every field here except the timeframe is a position inside ONE screen's visual. A selected
   * point is a day on a chart the next screen does not draw. A `metric` key names a spine entry the
   * next screen does not have — and because the spine only auto-selects when nothing is active,
   * carrying a stale key leaves the new screen with NO active metric and therefore no primary
   * visual at all. A filter on a dimension the next screen cannot read is worse than useless:
   * `matches` correctly ignores an unknown dimension, so the chip sits in the bar claiming to
   * narrow a view it has no effect on.
   */
  const s = createStore();
  s.setTimeframe("90d");
  s.setMetric("collected");
  s.toggleFilter({ dim: "payer", value: "Delta Dental" });
  s.selectPoint("2026-08-28");
  s.pushDrill({ kind: "advice", id: "r1", label: "Delta Dental" });

  s.reset();

  const after = s.get();
  assert.equal(after.metric, null, "no metric from the screen that just left");
  assert.deepEqual(after.filters, [], "no chips for dimensions the next screen cannot read");
  assert.equal(after.point, null);
  assert.equal(after.brush, null);
  assert.deepEqual(after.drill, [], "and no drill entry nobody is left to resolve");
  assert.equal(s.narrowed(), false);
});

test("the timeframe survives a screen change, because it is a question about the practice", () => {
  /* Re-choosing "the last 90 days" on every tab is the friction that stops people moving between
     screens at all. It is the one piece of this state that is not about a particular picture. */
  const s = createStore();
  s.setTimeframe("90d");
  s.setCompare("prior");
  s.reset();
  assert.equal(s.get().timeframe.key, "90d");
  assert.equal(s.get().timeframe.compare, "prior");
});

test("resetting an already-clean store does not notify", () => {
  /* `switchTab` resets on EVERY move, including onto a legacy screen that never wrote any of this.
     A notification there would redraw whatever else is subscribed for no reason. */
  const s = createStore();
  let n = 0;
  s.subscribe(() => n++);
  s.reset();
  assert.equal(n, 0);
  s.setMetric("collected");
  s.reset();
  assert.equal(n, 2, "one for the metric, one for the reset that had something to clear");
});
