/**
 * The Claims state-flow, and the two rules that keep it honest.
 *
 * ── WHAT THE CHART CLAIMS ──────────────────────────────────────────────────────────────────────
 * §8.3 asks for a stacked flow of claims by lifecycle state across time, so a band that swells while
 * the one above it stays flat reads as a payer that has stopped answering. Mermaid stores no
 * day-by-day state table, so the position of a claim on a past date has to be reconstructed.
 *
 * It is reconstructed from three timestamps somebody actually wrote down — raised, released, first
 * paid — and from nothing else. That is a derivation, not an interpolation between known points,
 * which is the line §4.4 draws and the reason this chart is allowed to exist at all.
 *
 * ── THE SECOND RULE, WHICH IS EASIER TO BREAK ──────────────────────────────────────────────────
 * The table under the chart must contain exactly the claims the clicked column was drawn from. The
 * only way to guarantee that is for both to ask the SAME function, which is why `stageOnDay` is a
 * module-scope export rather than two similar conditions in two places. A second predicate that
 * agreed on the day it was written is a predicate that will disagree later, and the disagreement
 * would present as a column of six claims over a table of five.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdOf, stageOnDay } from "../public/claims.js";

const DAY = 86400000;
/** The end of a UTC day, which is the instant `stageOnDay` closes a column at. */
const endOf = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`) + DAY;

const claim = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  status: "submitted",
  createdAt: "2026-08-10T09:00:00.000Z",
  submittedAt: null,
  firstPaidAt: null,
  totalFee: 142500,
  ...over,
});

test("a claim does not exist on the chart before the day it was raised", () => {
  const c = claim();
  assert.equal(stageOnDay(c, endOf("2026-08-09")), null, "the day before");
  assert.equal(stageOnDay(c, endOf("2026-08-10")), "waiting", "the day itself, once it has happened");
});

test("the three bands follow the three recorded milestones, in order", () => {
  const c = claim({
    createdAt: "2026-08-10T09:00:00.000Z",
    submittedAt: "2026-08-14T15:00:00.000Z",
    firstPaidAt: "2026-08-28T11:00:00.000Z",
  });
  assert.equal(stageOnDay(c, endOf("2026-08-10")), "waiting", "raised, nobody has released it");
  assert.equal(stageOnDay(c, endOf("2026-08-13")), "waiting", "still sitting with us");
  assert.equal(stageOnDay(c, endOf("2026-08-14")), "withPayer", "released the same day it moves");
  assert.equal(stageOnDay(c, endOf("2026-08-27")), "withPayer", "the fortnight the payer had it");
  assert.equal(stageOnDay(c, endOf("2026-08-28")), "answered");
  assert.equal(stageOnDay(c, endOf("2026-09-30")), "answered", "and stays answered");
});

test("a day is closed at its end, so an event at 23:59 counts on the day it happened", () => {
  /* Anchoring on the day's START would push every late-evening submission into tomorrow's column,
     which is how a chart quietly reports that nothing was filed on a day the practice filed. */
  const c = claim({ createdAt: "2026-08-10T00:30:00.000Z", submittedAt: "2026-08-14T23:59:00.000Z" });
  assert.equal(stageOnDay(c, endOf("2026-08-14")), "withPayer");
});

test("a voided claim is absent from the flow rather than stacked at the bottom of it", () => {
  /**
   * A void is not a STAGE of the lifecycle — it is a claim withdrawn from it. Stacking it under the
   * live ones inflates every column from the void onward with work nobody is doing, and the whole
   * value of the chart is reading how much is genuinely in flight.
   */
  const c = claim({ status: "void", submittedAt: "2026-08-14T15:00:00.000Z" });
  assert.equal(stageOnDay(c, endOf("2026-08-20")), null);
});

test("an undatable claim is dropped, never defaulted into a band", () => {
  /* `Date.parse` of a malformed value is NaN and every comparison against NaN is false, so a naive
     version of this places the claim in `waiting` forever — a permanent phantom column. */
  assert.equal(stageOnDay(claim({ createdAt: "not-a-date" }), endOf("2026-08-20")), null);
});

test("a milestone that cannot be parsed falls back to the last one that could", () => {
  /* Better to under-state progress than to invent it: a claim whose payment date is unreadable is
     reported as still with the payer, which is what the record can actually support. */
  const c = claim({ submittedAt: "2026-08-14T15:00:00.000Z", firstPaidAt: "garbage" });
  assert.equal(stageOnDay(c, endOf("2026-08-30")), "withPayer");
});

test("a claim paid without a recorded submission is still reported as answered", () => {
  /* The milestones are independent facts, not a state machine. A claim whose submission record was
     never written but whose money arrived is answered, and saying otherwise to preserve a tidy
     sequence would rewrite history to look neater than it was. */
  const c = claim({ submittedAt: null, firstPaidAt: "2026-08-28T11:00:00.000Z" });
  assert.equal(stageOnDay(c, endOf("2026-08-29")), "answered");
});

/* ══ The hold ranking is a partition, not a set of overlapping tests ══════════════════════════ */

test("every claim lands in exactly one hold, so the bars sum to the money actually held up", () => {
  /**
   * Overlapping groups would double-count: a claim with no payer AND a scrub error would appear in
   * two bars, and a ranking of dollars that adds up to more than the practice is owed is a ranking
   * nobody can act on.
   *
   * It also has to be single-valued for a second reason. The shared store filters by reading ONE
   * value off a record; a claim belonging to several groups could not be expressed that way, so
   * clicking a bar would narrow the table to a population that disagreed with the bar's own count.
   */
  const noPayerAndBroken = { payerName: null, scrubErrors: 3, scrubWarnings: 1, canSubmit: false, submittedAt: null };
  assert.equal(holdOf(noPayerAndBroken), "nopayer", "the most severe answer wins, and only it");
});

test("the holds are ordered by what actually blocks hardest", () => {
  assert.equal(
    holdOf({ payerName: null, scrubErrors: 0, scrubWarnings: 0, canSubmit: true, submittedAt: null }),
    "nopayer",
    "no routing id means it cannot be transmitted at all"
  );
  assert.equal(
    holdOf({ payerName: "Delta Dental", scrubErrors: 2, scrubWarnings: 0, canSubmit: false, submittedAt: null }),
    "errors",
    "the payer would reject it as filed"
  );
  assert.equal(
    holdOf({ payerName: "Delta Dental", scrubErrors: 0, scrubWarnings: 0, canSubmit: true, submittedAt: null }),
    "unreleased",
    "clean, and waiting on a person to press submit"
  );
  assert.equal(
    holdOf({ payerName: "Delta Dental", scrubErrors: 0, scrubWarnings: 2, canSubmit: false, submittedAt: "2026-08-14T00:00:00.000Z" }),
    "warnings",
    "already filed, but the scrubber had a reservation"
  );
});

test("a claim nothing is holding up reports none, rather than being swept into the last bar", () => {
  assert.equal(
    holdOf({ payerName: "Delta Dental", scrubErrors: 0, scrubWarnings: 0, canSubmit: false, submittedAt: "2026-08-14T00:00:00.000Z" }),
    "none"
  );
});
