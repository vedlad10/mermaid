/**
 * The one real time series in the product, and the rules that keep it honest.
 *
 * ── WHY IT IS ALLOWED TO EXIST AT ALL ──────────────────────────────────────────────────────────
 * Every other figure Mermaid shows is a POSITION — what is true at this instant. A dashboard asked
 * for trends and there were none to give, because analytics retained no series. It turns out one was
 * already there: every posted payment writes a fact with the moment it happened, so "cash posted per
 * day" can be folded from the same facts the period totals are folded from, and reconciles with
 * `money.collected` by construction rather than by agreement.
 *
 * That distinction is the whole reason this is not fabrication. Nothing here is sampled, smoothed,
 * extrapolated or fitted — it is a regrouping of facts that already exist.
 *
 * ── AND THE RULES THAT STOP IT BECOMING FABRICATION ────────────────────────────────────────────
 * A day with no payments is ABSENT, not zero. Padding the window would draw a collapse every time a
 * practice has a weekend, and would make a four-day-old deployment look like a business in decline.
 * The surface says how many days actually had activity, which is the honest denominator, and refuses
 * to draw anything below two — one bar is a rectangle, and a rectangle is not a series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildReport } from "../engine/report.ts";
import type { Fact } from "../types.ts";

const PERIOD = { from: "2026-08-02T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" };

const fact = (over: Partial<Fact> & { factType: Fact["factType"] }): Fact =>
  ({
    sourceEventId: `e-${over.occurredAt ?? ""}-${over.amount ?? 0}-${Math.random()}`,
    occurredAt: "2026-08-15T00:00:00.000Z",
    payerId: "delta-dental",
    payerName: "Delta Dental",
    procedureCode: null,
    carcCode: null,
    verificationId: null,
    claimId: null,
    denialId: null,
    amount: cents(0),
    expected: cents(0),
    won: null,
    meta: null,
    ...over,
  }) as Fact;

const posted = (day: string, amount: number) =>
  fact({ factType: "payment_posted", occurredAt: `${day}T14:00:00.000Z`, amount: cents(amount) });

/** The live staging shape exactly: four days with activity, two of them adjacent. */
const STAGING = [
  posted("2026-08-26", 774.99),
  posted("2026-08-26", 774.99),
  posted("2026-08-27", 1634.72),
  posted("2026-08-27", 1634.72),
  posted("2026-08-29", 3215.47),
  posted("2026-08-30", 1574.98),
];

test("the series sums to the period's collected total, by construction", () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. Two figures folded from one set of facts must agree, or the
   * chart is telling a different story from the number beside it.
   */
  const report = buildReport(STAGING, PERIOD);
  const seriesTotal = report.dailyCollections.reduce((t, d) => t + d.collected, 0);
  assert.equal(seriesTotal, report.money.collected);
  assert.ok(seriesTotal > 0, "the fixture must contain payments, or this proves nothing");
});

test("days with no payments are absent, never drawn as zero", () => {
  const { dailyCollections } = buildReport(STAGING, PERIOD);
  assert.deepEqual(
    dailyCollections.map((d) => d.day),
    ["2026-08-26", "2026-08-27", "2026-08-29", "2026-08-30"],
    "the 28th had no payment and must not appear"
  );
  assert.ok(
    dailyCollections.every((d) => d.collected > 0),
    "a zero-value day would be padding, and padding a quiet week reads as a collapse"
  );
});

test("the series is oldest first, so a chart can render it in order", () => {
  const { dailyCollections } = buildReport([...STAGING].reverse(), PERIOD);
  const days = dailyCollections.map((d) => d.day);
  assert.deepEqual(days, [...days].sort(), "input order must not decide chart order");
});

test("each day carries the count of payments behind it", () => {
  const { dailyCollections } = buildReport(STAGING, PERIOD);
  const byDay = new Map(dailyCollections.map((d) => [d.day, d]));
  assert.equal(byDay.get("2026-08-26")!.payments, 2);
  assert.equal(byDay.get("2026-08-29")!.payments, 1);
  assert.equal(
    dailyCollections.reduce((t, d) => t + d.payments, 0),
    STAGING.length,
    "every payment fact belongs to exactly one day"
  );
});

test("only payments count — a claim or a denial on the same day does not", () => {
  /**
   * The series answers "when did cash arrive". A claim filed is work, not money, and a denial is
   * money refused; folding either in would make the chart mean something else entirely while still
   * looking correct.
   */
  const mixed = [
    posted("2026-08-26", 100),
    fact({ factType: "claim_submitted", occurredAt: "2026-08-26T09:00:00.000Z", amount: cents(999) }),
    fact({ factType: "denial_created", occurredAt: "2026-08-26T10:00:00.000Z", amount: cents(555) }),
    posted("2026-08-27", 200),
  ];
  const { dailyCollections } = buildReport(mixed, PERIOD);
  assert.equal(dailyCollections.length, 2);
  assert.equal(dailyCollections[0]!.collected, cents(100));
  assert.equal(dailyCollections[0]!.payments, 1);
});

test("a period with nothing collected reports an empty series, not a flat line", () => {
  const { dailyCollections, money } = buildReport(
    [fact({ factType: "claim_submitted", amount: cents(500) })],
    PERIOD
  );
  assert.deepEqual(dailyCollections, []);
  assert.equal(money.collected, cents(0));
});
