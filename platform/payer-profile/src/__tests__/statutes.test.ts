/**
 * The statute table (F5) — what this system claims to know about the law, and what it refuses to.
 *
 * Two kinds of test here, and the first kind is the unusual one: assertions about the TABLE rather
 * than about code. A rule with no citation, or a rate nobody read from a statute, is not a bug that
 * surfaces as a failure — it surfaces as a confident demand letter with an invented number in it,
 * six months later, in front of the payer the practice is trying to collect from. So the shape of
 * the data is pinned here, and a future entry that omits its provenance fails before it ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_PAY_RULES,
  RECOUPMENT_RULES,
  STATES_WITH_PROMPT_PAY_RULES,
  STATES_WITH_RECOUPMENT_RULES,
  governsOn,
  promptPayRuleFor,
  recoupmentRuleFor,
  type EffectiveDating,
} from "../statutes.ts";

const ALL: readonly (EffectiveDating & { state: string })[] = [...PROMPT_PAY_RULES, ...RECOUPMENT_RULES];

// ── Provenance: the rule this file exists to enforce ────────────────────────────────────────────

test("every rule names the statute it came from, where it was read, and when", () => {
  for (const rule of ALL) {
    assert.ok(rule.citation.trim().length > 0, `${rule.state} has no citation`);
    assert.ok(rule.source.startsWith("https://"), `${rule.state} has no readable source`);
    assert.match(rule.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${rule.state} has no verification date`);
    assert.equal(rule.state, rule.state.toUpperCase(), `${rule.state} is not a normalised state code`);
  }
});

test("every rule carries what would defeat it", () => {
  /**
   * The ERISA one above all. A self-funded plan is not bound by any of this, an 835 does not state
   * funding type, and roughly half of commercial dental lives sit in self-funded arrangements. A
   * worklist row reading "$41.03 owed" is a lie by omission; the same row plus "unless this plan is
   * self-funded" is the same arithmetic and an honest instruction.
   */
  for (const rule of ALL) {
    assert.ok(rule.defeasibleBy.length > 0, `${rule.state} claims nothing could defeat it`);
    assert.ok(
      rule.defeasibleBy.some((d) => /ERISA/.test(d)),
      `${rule.state} does not mention ERISA preemption, which defeats every one of these rules`
    );
  }
});

test("a recoupment rule states its window exactly one way", () => {
  // Months and days are not interchangeable — 18 months is not 540 days, and a rule that set both
  // would leave the engine choosing. See the month-clamping test beside the engine.
  for (const rule of RECOUPMENT_RULES) {
    const stated = [rule.windowMonths, rule.windowDays].filter((v) => v !== null);
    assert.equal(stated.length, 1, `${rule.state} states its window ${stated.length} ways`);
  }
});

test("a prompt-pay rule never gives a paper claim LESS time than an electronic one", () => {
  for (const rule of PROMPT_PAY_RULES) {
    assert.ok(
      rule.paperDays >= rule.electronicDays,
      `${rule.state} would demand interest sooner on paper than on an 837, which no statute does`
    );
    assert.ok(rule.rateBps > 0, `${rule.state} states a rate of zero, which is not a rate`);
  }
});

// ── Selection ───────────────────────────────────────────────────────────────────────────────────

test("an unlisted state is null, and null is the answer rather than a fallback", () => {
  for (const state of ["WY", "MT", "AK", "", "  "]) {
    assert.equal(promptPayRuleFor(state, "2026-09-01"), null, `${state} should have no prompt-pay rule`);
    assert.equal(recoupmentRuleFor(state, "2026-09-01"), null, `${state} should have no recoupment rule`);
  }
});

test("California is deliberately absent, and its absence is the point", () => {
  /**
   * Ins. Code § 10123.13 has been amended recently and the sources consulted disagreed on whether
   * the current standard is 10% or 15%, and whether the count is working days or calendar days. Two
   * of those four combinations produce a demand letter with the wrong number on it. Until someone
   * reads the current text, California gets nothing — and this test is what stops a future edit
   * quietly filling the gap with the most common answer.
   */
  assert.equal(promptPayRuleFor("CA", "2026-09-01"), null);
  assert.ok(!STATES_WITH_PROMPT_PAY_RULES.includes("CA"));
});

test("casing and padding do not decide whether a practice is protected", () => {
  assert.ok(promptPayRuleFor("nj", "2026-09-01"));
  assert.ok(promptPayRuleFor("  NJ  ", "2026-09-01"));
  assert.equal(promptPayRuleFor(" nj ", "2026-09-01")!.state, "NJ");
});

test("the states this system can speak about are exactly the ones in the tables", () => {
  // A settings screen reads these. A list that overclaimed would offer a practice protection the
  // system cannot deliver, which is the same failure as an invented rate wearing a different hat.
  assert.deepEqual(STATES_WITH_PROMPT_PAY_RULES, ["NJ", "NY", "OR"]);
  assert.deepEqual(STATES_WITH_RECOUPMENT_RULES, ["LA", "NY", "TX"]);
  assert.equal(
    promptPayRuleFor("TX", "2026-09-01"),
    null,
    "Texas has a verified recoupment window and no verified prompt-pay rule — the two lists are independent"
  );
});

// ── Effective dating ────────────────────────────────────────────────────────────────────────────

const dated = (from: string | null, to: string | null): EffectiveDating => ({
  effectiveFrom: from,
  effectiveTo: to,
  citation: "Fixture",
  source: "https://example.invalid/fixture",
  verifiedOn: "2026-09-15",
  defeasibleBy: ["ERISA fixture"],
});

test("a rule governs from its effective date, and not the day before", () => {
  const rule = dated("2026-01-01", null);
  assert.equal(governsOn(rule, "2025-12-31"), false);
  assert.equal(governsOn(rule, "2026-01-01"), true);
  assert.equal(governsOn(rule, "2030-06-01"), true);
});

test("a superseded rule stops governing on the day its successor starts, not the day after", () => {
  /**
   * Half-open at the end deliberately. If both the old rule and its replacement governed the
   * changeover day, two rules would claim the same payment and the answer would depend on array
   * order. Statutes hand over at a boundary; so does this.
   */
  const old = dated(null, "2026-01-01");
  const next = dated("2026-01-01", null);
  assert.equal(governsOn(old, "2025-12-31"), true);
  assert.equal(governsOn(old, "2026-01-01"), false);
  assert.equal(governsOn(next, "2026-01-01"), true);
});

test("an unverified effective date is open-ended backwards, and stays null rather than being guessed", () => {
  /**
   * Every shipped rule carries `effectiveFrom: null`, which means something specific: the date this
   * version took effect has NOT been verified, only that it was in force on `verifiedOn`. Filling it
   * with a plausible enactment date would be exactly the invented fact this whole file exists to
   * keep out — and the day someone verifies a real date, the null becomes a date and findings before
   * it stop being raised, with no other change.
   */
  assert.ok(
    PROMPT_PAY_RULES.every((r) => r.effectiveFrom === null),
    "if a shipped rule gains a real effective date, update this test rather than deleting it"
  );
  assert.equal(governsOn(dated(null, null), "1999-01-01"), true);
});

test("a timestamp is accepted wherever a day is, and only its date half is used", () => {
  const rule = dated("2026-01-01", null);
  assert.equal(governsOn(rule, "2026-01-01T23:59:59.999Z"), true);
  assert.equal(governsOn(rule, "2025-12-31T23:59:59.999Z"), false);
});
