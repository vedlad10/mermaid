/**
 * The Money screen's evidence list must be about the period its metrics are about.
 *
 * ── THE DEFECT, WITH THE FIGURES IT PRODUCED ───────────────────────────────────────────────────
 * The timeframe control governs this screen: Collected re-queries the report for [from, to], and
 * the chart titles itself "last N days". The evidence table read the advice list unfiltered. On the
 * demonstration practice that read:
 *
 *      7 days   Collected  $3,682.50   ·  table 97 advices carrying $25,270.45
 *     30 days   Collected $11,763.31   ·  table 97 advices carrying $25,270.45
 *     90 days   Collected $25,270.45   ·  table 97 advices carrying $25,270.45
 *
 * Two true figures about two different periods, sitting one above the other with nothing saying so.
 * At 90 days they coincide exactly — which is why every look at the demo missed it, and why the
 * 7-day and 30-day cases below are the ones that matter.
 *
 * ── WHAT THIS TEST REFUSES TO ASSERT ───────────────────────────────────────────────────────────
 * That the windowed list SUMS to Collected. It does not, and making it do so would be the wrong
 * fix. The engine windows `payment_posted` on `postedAt`, the day money reached the ledger; an
 * advice carries `receivedAt`, the day it arrived. For 8 of this practice's 97 postings those dates
 * differ — an advice held in August and released in September arrives in one window and posts in
 * another. They count different objects over different events, and the list endpoint is not even
 * given `postedAt`. A test demanding they tie out would force somebody to move a figure to match a
 * list.
 *
 * ── THE RULE THAT IS NOT A WINDOW ──────────────────────────────────────────────────────────────
 * Held advices are never filtered out. Held money is a POSITION — cash sitting unposted until a
 * person acts — which is what the Held tile reports and why that tile stays all-time. The rows are
 * also the only place the action that resolves them lives, and the oldest held advice is both the
 * most urgent and the first to fall outside a 7-day window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advicesInWindow } from "../public/money.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const windowOf = (days: number) => ({ from: new Date(NOW - days * DAY).toISOString(), to: new Date(NOW).toISOString() });

/** Arrival ages chosen to straddle all three window edges. */
const ADVICES = [
  { id: "d1", receivedAt: at(1), status: "posted" },
  { id: "d3", receivedAt: at(3), status: "posted" },
  { id: "d10", receivedAt: at(10), status: "posted" },
  { id: "d29", receivedAt: at(29), status: "posted" },
  { id: "d45", receivedAt: at(45), status: "posted" },
  { id: "d89", receivedAt: at(89), status: "posted" },
  { id: "d120", receivedAt: at(120), status: "posted" },
];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

test("a 7-day window carries only what arrived in the last 7 days", () => {
  assert.deepEqual(ids(advicesInWindow(ADVICES, windowOf(7))), ["d1", "d3"]);
});

test("a 30-day window carries more, and still not everything", () => {
  assert.deepEqual(ids(advicesInWindow(ADVICES, windowOf(30))), ["d1", "d10", "d29", "d3"]);
});

test("a 90-day window carries everything inside 90 days and excludes what is older", () => {
  const got = ids(advicesInWindow(ADVICES, windowOf(90)));
  assert.deepEqual(got, ["d1", "d10", "d29", "d3", "d45", "d89"]);
  assert.equal(got.includes("d120"), false, "a 120-day-old advice is not in a 90-day window");
});

test("the three windows nest, which is the property the screen's timeframe control implies", () => {
  const w7 = new Set(ids(advicesInWindow(ADVICES, windowOf(7))));
  const w30 = ids(advicesInWindow(ADVICES, windowOf(30)));
  const w90 = ids(advicesInWindow(ADVICES, windowOf(90)));
  for (const id of w7) assert.ok(w30.includes(id), `${id} is in 7d but not 30d`);
  for (const id of w30) assert.ok(w90.includes(id), `${id} is in 30d but not 90d`);
  assert.ok(w7.size < w30.length && w30.length < w90.length, "each widening must admit more");
});

test("a held advice stays in every window, however old", () => {
  /* The rule that is not a window. An advice held for four months is the most urgent row on the
     screen and the first any window would drop. */
  const held = [...ADVICES, { id: "held-120", receivedAt: at(120), status: "held" }];
  for (const days of [7, 30, 90]) {
    assert.ok(
      ids(advicesInWindow(held, windowOf(days))).includes("held-120"),
      `a 120-day-old held advice fell out of the ${days}-day window`
    );
  }
});

test("held rows are the ONLY exception — an old posted advice is still excluded", () => {
  const mixed = [
    { id: "old-held", receivedAt: at(200), status: "held" },
    { id: "old-posted", receivedAt: at(200), status: "posted" },
  ];
  assert.deepEqual(ids(advicesInWindow(mixed, windowOf(7))), ["old-held"]);
});

test("an unreadable window shows everything rather than nothing", () => {
  /* The safe failure. A list that silently empties looks exactly like "no money has arrived", which
     is the most alarming thing this screen can say and the least likely to be true. */
  for (const bad of [null, undefined, { from: "not-a-date", to: "also-not" }, {}]) {
    assert.equal(
      advicesInWindow(ADVICES, bad as never).length,
      ADVICES.length,
      `a window of ${JSON.stringify(bad)} should not hide rows`
    );
  }
});

test("an advice with no readable arrival date is excluded, not crashed on", () => {
  const rows = [...ADVICES, { id: "undated", receivedAt: "", status: "posted" }];
  const got = ids(advicesInWindow(rows, windowOf(90)));
  assert.equal(got.includes("undated"), false, "an undated posted advice cannot be placed in a window");
});

test("the boundaries are inclusive at both ends", () => {
  const w = windowOf(30);
  const edge = [
    { id: "at-from", receivedAt: w.from, status: "posted" },
    { id: "at-to", receivedAt: w.to, status: "posted" },
  ];
  assert.deepEqual(ids(advicesInWindow(edge, w)), ["at-from", "at-to"]);
});

test("the input list is not mutated", () => {
  const before = ADVICES.map((a) => a.id);
  advicesInWindow(ADVICES, windowOf(7));
  assert.deepEqual(ADVICES.map((a) => a.id), before);
});

/* ══ The rule has to be WIRED IN, not merely exported ═════════════════════════════════════════ */

test("the table and the payer breakdown both route through the window", () => {
  /*
   * Every assertion above holds for a function nobody calls. The defect being fixed was exactly
   * that shape — the rule existed in the reader's head and not in `visible()` — so this checks the
   * two call sites that put it on screen. Source-level on purpose: the alternative is mounting the
   * screen against a stub DOM, which `every-screen-mounts-without-throwing.test.ts` already owns.
   */
  const src = readFileSync(new URL("../public/money.js", import.meta.url), "utf8");

  const visible = src.match(/const visible = \(\) =>[^;]+;/);
  assert.ok(visible, "money.js no longer defines visible()");
  assert.match(visible![0], /advicesInWindow/, "the evidence table does not apply the timeframe window");

  const payers = src.match(/const byPayer = new Map\(\);[\s\S]{0,220}/);
  assert.ok(payers, "money.js no longer builds the payer breakdown");
  assert.match(payers![0], /advicesInWindow/, "the payer breakdown does not apply the timeframe window");
});

test("the position tiles are NOT windowed, which is the distinction worth protecting", () => {
  /*
   * Held / Worth pursuing / With another plan are current positions, not totals for a period. If
   * `moneyValue` ever starts reading the windowed list, those tiles silently become period figures
   * and the basis lines under them ("waiting on a person") stop being true.
   */
  const src = readFileSync(new URL("../public/money.js", import.meta.url), "utf8");
  const fn = src.match(/function moneyValue\([\s\S]{0,700}/);
  assert.ok(fn, "money.js no longer defines moneyValue()");
  assert.equal(
    /advicesInWindow/.test(fn![0]),
    false,
    "the position tiles have been windowed — Held is a position, not a total for the period"
  );
});
