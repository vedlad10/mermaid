/**
 * Reading a payer's contracted rate out of its own remittances (F-1).
 *
 * The rate learned here is what a patient is eventually quoted from, so every test below is really
 * about one question: when is an observation NOT evidence of a contracted rate? Recording a bad one
 * is worse than recording none — a missing rate falls back to the billed fee, which is today's
 * behaviour, while a wrong one silently misquotes every future patient for that procedure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import {
  allowedFromLine,
  foldFullPrice,
  chargedPerUnit,
  contractualWriteOff,
  foldObservation,
  type AllowedAmount,
} from "../allowed-amounts.ts";

/** A line whose only reduction is contractual — the ordinary in-network case. */
const line = (charged: number, writeOff: number, quantity = 1) => ({
  cdtCode: "D2750",
  charged: cents(charged),
  quantity,
  adjustments: writeOff === 0 ? [] : [{ group: "CO", amount: cents(writeOff) }],
});

const withAdjustments = (charged: number, adjustments: { group: string; amount: number }[], quantity = 1) => ({
  cdtCode: "D2750",
  charged: cents(charged),
  quantity,
  adjustments: adjustments.map((a) => ({ group: a.group, amount: cents(a.amount) })),
});

// ── What one line tells us ────────────────────────────────────────────────────────────────────

test("a contracted reduction states the allowed amount exactly", () => {
  assert.equal(allowedFromLine(line(1250, 125)), cents(1125), "the payer's own arithmetic, read back");
});

test("no contractual reduction is not evidence of a contracted rate", () => {
  /**
   * The trap. A payer that paid the full billed fee may simply have no contract with this practice.
   * Recording allowed = fee would teach the estimate that an out-of-network fee is a contracted one,
   * and every later quote against that code would be built on it.
   */
  assert.equal(allowedFromLine(line(1250, 0)), null);
});

test("a write-off that swallows the whole charge is a denial, not a fee schedule", () => {
  assert.equal(allowedFromLine(line(1250, 1250)), null, "an allowance of zero is not a rate");
  assert.equal(allowedFromLine(line(1250, 1400)), null, "and a negative one is a parse fault");
});

test("a line billed at nothing says nothing", () => {
  assert.equal(allowedFromLine(line(0, 0)), null);
});

test("the allowance is always strictly between nothing and the full charge", () => {
  for (const [charged, writeOff] of [[1250, 1], [1250, 1249], [65, 5], [10, 9]] as const) {
    const allowed = allowedFromLine(line(charged, writeOff))!;
    assert.ok(allowed > 0 && allowed < cents(charged), `${charged}/${writeOff} → ${allowed}`);
  }
});

// ── A rate is stored PER UNIT ─────────────────────────────────────────────────────────────────

/**
 * The 835 states a line TOTAL; an estimate multiplies a UNIT rate back out. Conflating them would
 * double the allowance on exactly the multi-unit procedures where the money is largest.
 */
test("a multi-unit line states a per-unit rate, not the line total", () => {
  const l = line(130, 13, 2);
  assert.equal(allowedFromLine(l), cents(58.5), "$130.00 billed, $13.00 written off, two units");
  assert.equal(chargedPerUnit(l), cents(65));
});

test("a single-unit line is unchanged by the division", () => {
  assert.equal(allowedFromLine(line(1250, 125)), cents(1125));
  assert.equal(chargedPerUnit(line(1250, 125)), cents(1250));
});

test("a rate that does not divide evenly rounds to the cent rather than refusing", () => {
  /** $100.00 less $1.00 over three units is $33.00 exactly; $100.00 less $0.99 is $33.0033… */
  assert.equal(allowedFromLine(line(100, 1, 3)), cents(33));
  assert.equal(allowedFromLine(line(100, 0.99, 3)), 3300, "3300¢, a third of a cent from exact");
});

test("a quantity that cannot divide a rate produces no observation", () => {
  for (const q of [0, -1, 1.5, Number.NaN]) {
    assert.equal(allowedFromLine(line(1250, 125, q)), null, `quantity ${q}`);
  }
});

// ── ONLY a contractual obligation is evidence of a contracted rate ────────────────────────────

/**
 * The most safety-critical rule in this file, and the one a mutation slipped past when it lived in
 * the caller: learning from every adjustment group instead of CO alone passed the entire suite.
 *
 * The groups mean different things, and confusing them with CO is dangerous in a specific
 * direction — it produces an "allowed amount" BELOW what the payer allows, which then quotes the
 * patient less than they owe and turns into an unexpected bill after treatment is done.
 */
test("patient responsibility is not a discount", () => {
  const l = withAdjustments(1250, [{ group: "PR", amount: 500 }]);
  assert.equal(contractualWriteOff(l), 0, "PR money is the PATIENT'S, not written off");
  assert.equal(allowedFromLine(l), null, "and a line with no contractual reduction states no rate");
});

test("coordination of benefits is another payer's share, not a contracted rate", () => {
  const l = withAdjustments(1250, [{ group: "OA", amount: 400 }]);
  assert.equal(contractualWriteOff(l), 0);
  assert.equal(allowedFromLine(l), null);
});

test("a payer-initiated reduction is a decision about one claim, not a standing rate", () => {
  const l = withAdjustments(1250, [{ group: "PI", amount: 200 }]);
  assert.equal(contractualWriteOff(l), 0);
  assert.equal(allowedFromLine(l), null);
});

test("only the CO portion counts when a line carries several groups at once", () => {
  /** The realistic shape: the payer writes off $125.00 by contract and assigns $500.00 to the patient. */
  const l = withAdjustments(1250, [
    { group: "CO", amount: 125 },
    { group: "PR", amount: 500 },
  ]);
  assert.equal(contractualWriteOff(l), cents(125));
  assert.equal(allowedFromLine(l), cents(1125), "the allowance is $1,125.00, not $625.00");
});

test("several contractual reductions on one line add up", () => {
  const l = withAdjustments(1250, [
    { group: "CO", amount: 100 },
    { group: "CO", amount: 25 },
    { group: "PR", amount: 500 },
  ]);
  assert.equal(contractualWriteOff(l), cents(125));
  assert.equal(allowedFromLine(l), cents(1125));
});

// ── Folding observations over time ────────────────────────────────────────────────────────────

const obs = (allowed: number, charged: number, at: string) => ({
  payerId: "delta-dental",
  cdtCode: "D2750",
  allowed: cents(allowed),
  charged: cents(charged),
  observedAt: at,
});

test("the first observation becomes the rate", () => {
  const a = foldObservation(null, obs(1125, 1250, "2026-08-01T00:00:00.000Z"));
  assert.equal(a.allowed, cents(1125));
  assert.equal(a.observations, 1);
  assert.equal(a.restatements, 1);
  assert.equal(a.firstSeenAt, a.lastSeenAt);
});

test("the payer restating the same rate builds confidence without changing it", () => {
  let a: AllowedAmount = foldObservation(null, obs(1125, 1250, "2026-08-01T00:00:00.000Z"));
  a = foldObservation(a, obs(1125, 1250, "2026-08-15T00:00:00.000Z"));
  a = foldObservation(a, obs(1125, 1250, "2026-08-20T00:00:00.000Z"));
  assert.equal(a.allowed, cents(1125));
  assert.equal(a.observations, 3);
  assert.equal(a.restatements, 1, "the payer has never disagreed with itself");
  assert.equal(a.lastSeenAt, "2026-08-20T00:00:00.000Z");
});

test("a renegotiated rate replaces the old one and says that it moved", () => {
  /**
   * Deliberately NOT averaged. The mean of a rate and the rate that replaced it is a number the
   * payer has never allowed and never will, and quoting a patient from it would be wrong in a way
   * neither figure was.
   */
  let a: AllowedAmount = foldObservation(null, obs(1125, 1250, "2026-08-01T00:00:00.000Z"));
  a = foldObservation(a, obs(1180, 1250, "2026-09-01T00:00:00.000Z"));
  assert.equal(a.allowed, cents(1180), "the current rate, not $1,152.50");
  assert.equal(a.restatements, 2, "and the practice can see the contract moved");
  assert.equal(a.observations, 2);
});

test("a redelivered or out-of-order observation never rolls the dates backwards", () => {
  /** The bus is at-least-once and orders only within a practice, not globally. */
  let a: AllowedAmount = foldObservation(null, obs(1125, 1250, "2026-08-15T00:00:00.000Z"));
  a = foldObservation(a, obs(1125, 1250, "2026-08-01T00:00:00.000Z"));
  assert.equal(a.lastSeenAt, "2026-08-15T00:00:00.000Z", "the later reading stays the latest");
  assert.equal(a.firstSeenAt, "2026-08-01T00:00:00.000Z", "and the earlier one becomes the first");
});

test("restatements counts how often the payer changed its mind, not how many rates exist", () => {
  /**
   * The name this column was given first — `distinctValues` — described arithmetic it does not do.
   * A payer alternating between two rates records three restatements and there are two values, and
   * that IS the count worth keeping: oscillation is instability, and a rate that keeps moving is
   * what makes a quote built on it a guess.
   */
  let a = foldObservation(null, obs(1000, 1250, "2026-08-01T00:00:00.000Z"));
  a = foldObservation(a, obs(1050, 1250, "2026-08-02T00:00:00.000Z"));
  a = foldObservation(a, obs(1000, 1250, "2026-08-03T00:00:00.000Z"));

  assert.equal(a.restatements, 3, "three times the payer said something different from last time");
  assert.equal(a.observations, 3);
  assert.equal(a.allowed, cents(1000), "and the current rate is the most recent, not an average");
});

// ── A contract that has lapsed must stop discounting quotes ───────────────────────────────────

/**
 * ── THE DEFECT THIS CLOSES (F-1 fallout) ───────────────────────────────────────────────────────
 * A rate is learned only from a CO adjustment, which is right. What was missing is the other
 * direction: a practice that LEAVES a payer's network keeps being paid at full price, so
 * `allowedFromLine` correctly learns nothing — and nothing UNLEARNS the rate either. The allowance
 * observed while in network stayed in the table forever and every estimate went on quoting a
 * discount the payer no longer gives, telling the patient they owe less than they do.
 *
 * That is the failure F-1 exists to prevent, running the other way. Absence of a CO adjustment was
 * being read as "no information" when it is evidence.
 */
test("a full-price adjudication counts against a rate without changing it", () => {
  const learned = foldObservation(null, obs(1125, 1250, "2026-01-01T00:00:00.000Z"));
  const after = foldFullPrice(learned, "2026-02-01T00:00:00.000Z")!;

  assert.equal(after.allowed, cents(1125), "the rate is untouched — nothing was learned, only doubted");
  assert.equal(after.fullPriceSince, 1);
  assert.equal(after.lastSeenAt, "2026-02-01T00:00:00.000Z", "the payer was heard from, even saying nothing");
});

test("consecutive full-price adjudications accumulate", () => {
  let a = foldObservation(null, obs(1125, 1250, "2026-01-01T00:00:00.000Z"));
  for (const d of ["2026-02-01", "2026-03-01", "2026-04-01"]) a = foldFullPrice(a, `${d}T00:00:00.000Z`)!;
  assert.equal(a.fullPriceSince, 3, "three payments in a row with no contractual reduction");
  assert.equal(a.allowed, cents(1125), "and still no change to what we believe the rate was");
});

test("the payer applying the contract again clears the doubt", () => {
  /**
   * The reason the count is CONSECUTIVE and not cumulative. One full-price line is ordinary — a
   * service outside the agreement, a secondary payer — and a cumulative count would creep upward
   * over years of normal operation until it fired on a contract that was never in question.
   */
  let a = foldObservation(null, obs(1125, 1250, "2026-01-01T00:00:00.000Z"));
  a = foldFullPrice(a, "2026-02-01T00:00:00.000Z")!;
  a = foldFullPrice(a, "2026-03-01T00:00:00.000Z")!;
  assert.equal(a.fullPriceSince, 2);

  a = foldObservation(a, obs(1125, 1250, "2026-04-01T00:00:00.000Z"));
  assert.equal(a.fullPriceSince, 0, "the contract is evidently still being applied");
});

test("a full-price payment for a code we hold no rate for records nothing", () => {
  /**
   * A no-op by design. A payment at full price says nothing about a contract that never existed, and
   * recording it would fill the table with every code this practice has no agreement on.
   */
  assert.equal(foldFullPrice(null, "2026-02-01T00:00:00.000Z"), null);
});

test("an out-of-order full-price observation does not roll the date backwards", () => {
  const a = foldObservation(null, obs(1125, 1250, "2026-05-01T00:00:00.000Z"));
  const after = foldFullPrice(a, "2026-01-01T00:00:00.000Z")!;
  assert.equal(after.lastSeenAt, "2026-05-01T00:00:00.000Z");
  assert.equal(after.fullPriceSince, 1, "but it still counts — the payer did adjudicate at full price");
});
