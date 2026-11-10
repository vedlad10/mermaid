/**
 * Coverage dates, parsed from raw X12 — the test whose absence let V6 live.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────────────────────
 * `isoDay` tested `/^d{8}$/` instead of `/^\d{8}$/`. The missing backslash made it match the literal
 * string "dddddddd" and nothing else, so it returned null for every real date. `DTP*346` and
 * `DTP*347` were read off the wire, converted to null, and reported as though the payer had said
 * nothing about the plan's dates.
 *
 * ── WHY IT SURVIVED ────────────────────────────────────────────────────────────────────────────
 * Both fields are legitimately nullable — null means "the payer did not state a window" — so a
 * permanent null looks exactly like a quiet payer. The coverage-window ENGINE is correct and well
 * covered, but `coverage-window.test.ts` constructs `benefits({ effectiveDate, terminationDate })`
 * directly. Nothing anywhere drove a date from raw X12 through the parser and asserted the value.
 * The consequence in production: a patient whose plan had terminated verified clean, and the claim
 * was filed into a guaranteed denial.
 *
 * These fixtures are therefore hand-built from segments rather than produced by `build271` — and
 * every date assertion checks the VALUE, not merely that something non-null came back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse271 } from "../mock/x12-271.ts";

const HEAD = [
  ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "DELTA          ", "ZZ", "CLINIC         ", "260811", "0000", "^", "00501", "000000001", "0", "P", ":"].join("*"),
  ["GS", "HB", "DELTA", "CLINIC", "20260811", "0000", "1", "X", "005010X279A1"].join("*"),
  ["ST", "271", "0001", "005010X279A1"].join("*"),
  ["NM1", "PR", "2", "Delta Dental"].join("*"),
  ["NM1", "IL", "1", "ALPHA", "ADA", "", "", "", "MI", "ABC12345"].join("*"),
  // An active benefit, so the parser has something to report and does not reject the payload.
  ["EB", "1", "IND", "35", "", "PPO Premier"].join("*"),
];
const TAIL = [["SE", "20", "0001"].join("*"), ["GE", "1", "1"].join("*"), ["IEA", "1", "1"].join("*")];
const build = (rows: string[]): string => [...HEAD, ...rows, ...TAIL].join("~") + "~";

const dtp = (qualifier: string, format: string, value: string): string => ["DTP", qualifier, format, value].join("*");

test("DTP*346 and DTP*347 produce the payer's real coverage window", () => {
  // The whole point of the fix, and the assertion that would have failed before it: real ISO dates,
  // not nulls.
  const parsed = parse271(build([dtp("346", "D8", "20260101"), dtp("347", "D8", "20261231")]));

  assert.equal(parsed.coverage.effectiveDate, "2026-01-01", "DTP*346 is the plan begin date");
  assert.equal(parsed.coverage.terminationDate, "2026-12-31", "DTP*347 is the plan end date");
});

test("each date parses independently of the other", () => {
  // A payer that states only one of the two is ordinary. The one it stated must survive, and the
  // one it did not must stay null rather than borrowing from its neighbour.
  const beginOnly = parse271(build([dtp("346", "D8", "20250701")]));
  assert.equal(beginOnly.coverage.effectiveDate, "2025-07-01");
  assert.equal(beginOnly.coverage.terminationDate, null, "an unstated end date is null, not invented");

  const endOnly = parse271(build([dtp("347", "D8", "20260630")]));
  assert.equal(endOnly.coverage.effectiveDate, null);
  assert.equal(endOnly.coverage.terminationDate, "2026-06-30");
});

test("a terminated plan is visible in the parsed window — the case that was silently lost", () => {
  /**
   * The defect's real-world shape. A plan that ended in March, verified in August: before the fix
   * this came back with terminationDate null, the coverage-window engine had nothing to test the
   * service date against, and the verification read as clean.
   */
  const parsed = parse271(build([dtp("346", "D8", "20250101"), dtp("347", "D8", "20260331")]));

  assert.equal(parsed.coverage.terminationDate, "2026-03-31");
  assert.ok(
    parsed.coverage.terminationDate! < "2026-08-11",
    "the engine can now see that the plan ended before the date of service"
  );
});

test("an RD8 range on DTP*291 fills both ends", () => {
  // Many payers state the window as one ranged segment instead of two dated ones.
  const parsed = parse271(build([dtp("291", "RD8", "20260101-20261231")]));

  assert.equal(parsed.coverage.effectiveDate, "2026-01-01");
  assert.equal(parsed.coverage.terminationDate, "2026-12-31");
});

test("an explicit DTP*346/347 is not overwritten by a later DTP*291 range", () => {
  // `??=` on the 291 branch means the specific segments win. Asserted because the ordering is the
  // kind of thing a refactor silently reverses, and the specific statement is the better source.
  const parsed = parse271(
    build([dtp("346", "D8", "20260201"), dtp("347", "D8", "20260901"), dtp("291", "RD8", "20200101-20301231")])
  );

  assert.equal(parsed.coverage.effectiveDate, "2026-02-01");
  assert.equal(parsed.coverage.terminationDate, "2026-09-01");
});

test("malformed dates are rejected, and never become plausible wrong ones", () => {
  /**
   * The other half of the fix. Eight digits is the X12 shape, not proof of a real day — and a date
   * that is silently WRONG is worse than one that is missing, because null is reported honestly as
   * "the payer did not say" while a rolled-over date is used to decide whether coverage had ended.
   *
   * `20260230` is the case with teeth: `new Date(2026, 1, 30)` rolls forward to March 2nd, so a
   * naive parser would invent a real date the payer never sent.
   */
  const rejected = [
    "2026123",       // seven digits
    "202612311",     // nine digits
    "2026-12-31",    // already hyphenated, not the D8 shape
    "dddddddd",      // what the broken regex actually matched
    "abcdefgh",
    "        ",
    "",
    "20261301",      // month 13
    "20260230",      // February 30th — rolls forward if not checked
    "20260000",      // month and day zero
    "20260431",      // April has 30 days
  ];

  for (const value of rejected) {
    const parsed = parse271(build([dtp("346", "D8", value), dtp("347", "D8", value)]));
    assert.equal(parsed.coverage.effectiveDate, null, `"${value}" must not parse as an effective date`);
    assert.equal(parsed.coverage.terminationDate, null, `"${value}" must not parse as a termination date`);
  }
});

test("real boundary dates still parse — rejection must not overshoot", () => {
  // A validator that rejects malformed input is only useful if it accepts valid input, including
  // the edges a naive range check gets wrong. 2028 is a leap year; 2026 is not.
  const cases: [string, string][] = [
    ["20260101", "2026-01-01"], // first day of a year
    ["20261231", "2026-12-31"], // last day of a year
    ["20280229", "2028-02-29"], // leap day, valid
    ["20260228", "2026-02-28"], // last day of a non-leap February
  ];

  for (const [d8, iso] of cases) {
    assert.equal(parse271(build([dtp("346", "D8", d8)])).coverage.effectiveDate, iso, `${d8} must parse`);
  }

  // …and the leap day that does NOT exist in a non-leap year is still refused.
  assert.equal(parse271(build([dtp("346", "D8", "20260229")])).coverage.effectiveDate, null, "2026 is not a leap year");
});

test("a 271 with no DTP segments reports null — silence is still silence", () => {
  // The pre-existing meaning of null must survive the fix: it says the payer stated no window, and
  // it must never be read as "coverage is open-ended".
  const parsed = parse271(build([]));

  assert.equal(parsed.coverage.effectiveDate, null);
  assert.equal(parsed.coverage.terminationDate, null);
});
