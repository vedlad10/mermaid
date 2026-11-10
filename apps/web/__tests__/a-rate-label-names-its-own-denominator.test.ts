/**
 * A rate's LABEL must name the quantity the engine actually divides by.
 *
 * ── THE DEFECT, AS IT ACTUALLY APPEARED ────────────────────────────────────────────────────────
 * The payer scorecard on Insights read, left to right:
 *
 *     Payer | Claims | Billed | Collected | Collected of billed | Denial rate | Days to pay
 *
 * "Collected of billed" sits one column along from "Billed", so the label reads as an instruction:
 * divide this cell by that one. The engine does not do that. `report.ts` computes
 * `ratio(collected, expected)` — against what the ESTIMATES promised — and it does so deliberately,
 * because the filed figure still contains the contractual write-off every in-network practice
 * agrees to and never collects.
 *
 * On the seeded demonstration practice the two readings are not close:
 *
 *     collected ÷ filed     = $25,270.45 ÷ $81,745.00 =  31%   ← what the label told a reader to do
 *     collected ÷ expected  =                            60%   ← what the cell actually showed
 *
 * A practice owner reading 60% under a label that says it means 31% is not reading a slightly
 * imprecise screen; they are reading a different claim about their business than the one the
 * software is making. And the spine at the top of THE SAME SCREEN already said "Collected of
 * expected", so the screen disagreed with itself in two places a reader sees at once.
 *
 * ── WHY THIS TEST READS THE ENGINE RATHER THAN A FIXED STRING ──────────────────────────────────
 * Asserting `label === "Collected of expected"` would pass for ever while saying nothing: it echoes
 * the source back at itself, and the day someone changes the denominator in `report.ts` the label
 * goes stale with the test still green. That is the exact failure mode being guarded against, so
 * the guard has to be anchored on the other side.
 *
 * So this parses the engine's own `ratio(...)` calls and requires the label to name whichever
 * denominator it finds. Change the arithmetic and this fails until the words follow it.
 *
 * The sibling rule lives in `a-rate-is-never-quoted-bare.test.ts`: a rate must carry the SIZE of
 * what it was computed over. This one is the other half — it must also carry the IDENTITY of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCORECARD } from "../public/insights.js";

const engine = readFileSync(new URL("../../../modules/analytics/src/engine/report.ts", import.meta.url), "utf8");

/** The denominator the engine divides `field` by, read out of its own source. */
function denominatorOf(field: string): string {
  const m = engine.match(new RegExp(`${field}:\\s*ratio\\(\\s*([A-Za-z0-9_.]+)\\s*,\\s*([A-Za-z0-9_.]+)\\s*\\)`));
  assert.ok(m, `${field} is no longer computed with ratio(...) in report.ts — this test needs updating with it`);
  return m![2]!;
}

/**
 * How a denominator identifier is allowed to be said in a label, in words a dentist uses.
 * `filedToPayers` is "filed"; the word "billed" is NOT acceptable for it — `MoneySummary` retires
 * that word outright ("the ambiguity was the word itself") because it once meant both what went to
 * payers and every live claim, on two screens, at two different totals.
 */
const SPOKEN: Record<string, string> = {
  expected: "expected",
  filedToPayers: "filed",
  denied: "denied",
  patientBilled: "billed",
};

test("the engine still computes these rates as ratios, so the labels have something to match", () => {
  assert.equal(denominatorOf("collectionRate"), "expected");
  assert.equal(denominatorOf("denialRate"), "filedToPayers");
});

test("the scorecard's collection-rate column names the quantity it is divided by", () => {
  const col = SCORECARD.find((c) => c.key === "collectionRate");
  assert.ok(col, "the scorecard no longer has a collection-rate column");

  const word = SPOKEN[denominatorOf("collectionRate")]!;
  assert.match(
    col!.label.toLowerCase(),
    new RegExp(word),
    `"${col!.label}" does not name its denominator — the engine divides by ${denominatorOf("collectionRate")}`
  );
});

test("no rate column names a denominator the engine does not use", () => {
  /*
   * The original bug in its general form. "Collected of billed" named `filedToPayers`, which is a
   * real column on the same table and is not what the rate divides by — the most confusing kind of
   * wrong, because the reader can do the arithmetic and get a different answer.
   */
  const wrongWords: Record<string, string[]> = {
    collectionRate: ["filed", "billed"],
    denialRate: ["expected"],
  };
  for (const [key, forbidden] of Object.entries(wrongWords)) {
    const col = SCORECARD.find((c) => c.key === key);
    if (!col) continue;
    for (const w of forbidden) {
      assert.ok(
        !col.label.toLowerCase().includes(w),
        `"${col.label}" names "${w}", but ${key} divides by ${denominatorOf(key)}`
      );
    }
  }
});

test("the retired word does not come back as a column heading", () => {
  /* `MoneySummary`: "'Billed' is retired rather than qualified, because the ambiguity was the word
     itself." A column keyed on `filedToPayers` is Filed. */
  const filed = SCORECARD.find((c) => c.key === "filedToPayers");
  assert.ok(filed, "the scorecard no longer has a filed column");
  assert.equal(filed!.label.toLowerCase().includes("billed"), false, `"${filed!.label}" resurrects the retired word`);
});

test("every scorecard column still declares how to render itself", () => {
  /* Cheap structural guard: a column with no `kind` renders as "[object Object]" in a cell. */
  for (const col of SCORECARD) {
    assert.ok(col.key, "a column has no key");
    assert.ok(col.label && col.label.trim().length > 0, `${col.key} has no label`);
    assert.ok(["count", "money", "rate", "days"].includes(col.kind), `${col.key} has an unknown kind: ${col.kind}`);
  }
});
