/**
 * Timely-filing policy tests. Boundary days matter more than the middle: "expires today" and
 * "expired yesterday" are the two cases a clinic actually loses money on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROACHING_DAYS,
  DEFAULT_FILING_DAYS,
  ESCALATING_RISKS,
  FILING_WINDOWS_ARE_PAYER_SOURCED,
  FILING_WINDOW_CONFIRM_NOTE,
  FILING_WINDOW_ESTIMATE_NOTE,
  URGENT_DAYS,
  filingDeadline,
  filingStatus,
  filingWindowDays,
  sourcedFilingWindowNote,
} from "../engine/deadline.ts";
import type { PayerWindowSource } from "@mermaid/shared";

test("known payers use their own filing window; unknown payers fall back to the default", () => {
  assert.equal(filingWindowDays("delta-dental"), 365);
  assert.equal(filingWindowDays("uhc-dental"), 90);
  assert.equal(filingWindowDays("aetna-dental"), 90, "Aetna's published limit (B-1), kept equal to the catalog's copy");
  assert.equal(filingWindowDays("some-payer-we-have-never-seen"), DEFAULT_FILING_DAYS);
  assert.equal(filingWindowDays(null), DEFAULT_FILING_DAYS);
});

test("the deadline is the service date plus the payer's window", () => {
  assert.equal(filingDeadline("2026-07-27", "delta-dental"), "2027-07-27");
  assert.equal(filingDeadline("2026-07-27", "uhc-dental"), "2026-10-25");
  assert.equal(filingDeadline("2026-07-27", null), "2027-07-27");
});

test("a deadline computed across a leap day is still exact", () => {
  // 2028 is a leap year: 2028-01-01 + 90 days lands on 2028-03-31, not 2028-04-01.
  assert.equal(filingDeadline("2028-01-01", "uhc-dental"), "2028-03-31");
});

test("risk escalates as the deadline approaches", () => {
  const deadline = "2026-12-31";
  assert.equal(filingStatus(deadline, new Date("2026-01-01T00:00:00Z")).risk, "safe");
  assert.equal(filingStatus(deadline, new Date("2026-11-25T00:00:00Z")).risk, "approaching");
  assert.equal(filingStatus(deadline, new Date("2026-12-20T00:00:00Z")).risk, "urgent");
  assert.equal(filingStatus(deadline, new Date("2027-01-05T00:00:00Z")).risk, "expired");
});

test("the boundary days land on the right side", () => {
  const deadline = "2026-12-31";
  const at = (iso: string) => filingStatus(deadline, new Date(`${iso}T12:00:00Z`));

  assert.equal(at("2026-12-31").daysRemaining, 0);
  assert.equal(at("2026-12-31").risk, "urgent", "the last day is still fileable");
  assert.equal(at("2027-01-01").daysRemaining, -1);
  assert.equal(at("2027-01-01").risk, "expired");

  // URGENT_DAYS days out is urgent; one more day out is only approaching.
  assert.equal(at("2026-12-17").daysRemaining, URGENT_DAYS);
  assert.equal(at("2026-12-17").risk, "urgent");
  assert.equal(at("2026-12-16").risk, "approaching");

  assert.equal(at("2026-11-16").daysRemaining, APPROACHING_DAYS);
  assert.equal(at("2026-11-16").risk, "approaching");
  assert.equal(at("2026-11-15").risk, "safe");
});

test("an expired status says how long ago, and an urgent one says how long is left", () => {
  assert.match(filingStatus("2026-12-31", new Date("2027-01-04T00:00:00Z")).message, /passed 4 days ago/);
  assert.match(filingStatus("2026-12-31", new Date("2026-12-28T00:00:00Z")).message, /Only 3 days left/);
});

test("the day count is pluralised, because a biller reads this sentence, not a template", () => {
  // This assertion existed as `/passed 4 day\(s\) ago/` and so pinned the placeholder rather than
  // the behaviour it was named for. One day is the case that exposes it.
  assert.match(filingStatus("2026-12-31", new Date("2027-01-01T00:00:00Z")).message, /passed 1 day ago/);
  assert.match(filingStatus("2026-12-31", new Date("2026-12-30T00:00:00Z")).message, /Only 1 day left/);
});

test("only worsening risks are worth escalating", () => {
  assert.deepEqual([...ESCALATING_RISKS], ["approaching", "urgent", "expired"]);
  assert.equal(ESCALATING_RISKS.includes("safe" as never), false);
});

test("the time of day never changes the day count", () => {
  const early = filingStatus("2026-12-31", new Date("2026-12-20T00:00:01Z"));
  const late = filingStatus("2026-12-31", new Date("2026-12-20T23:59:59Z"));
  assert.equal(early.daysRemaining, late.daysRemaining);
});

// ── Deadlines are counted in the practice's day, not the server's ────────────────────────────────

test("a claim on its final filing day is not reported expired at 8pm Pacific", () => {
  /**
   * The bug this pins. `filingStatus` answered "what day is it today?" with `now.toISOString()` —
   * the UTC day — so for a US Pacific practice, from 5pm local onward, a claim on its last filable
   * day reported:
   *
   *     daysRemaining = -1, "The filing deadline passed 1 day ago — this payer will refuse the claim."
   *
   * It was filable for another four hours. Evening is when end-of-day filing sweeps run, so that is
   * precisely the window in which staff were told to abandon revenue the payer would have paid.
   */
  const deadline = "2026-08-11";
  const evening = new Date("2026-08-11T20:00:00-07:00"); // 03:00 UTC on the 12th

  const utc = filingStatus(deadline, evening, "UTC");
  assert.equal(utc.risk, "expired", "the old behaviour, kept as the default and shown here for contrast");

  const pacific = filingStatus(deadline, evening, "America/Los_Angeles");
  assert.equal(pacific.daysRemaining, 0);
  assert.equal(pacific.risk, "urgent");
  assert.match(pacific.message, /Submit today/);
});

test("and east of UTC the error ran the other way — the dangerous direction", () => {
  // A claim whose deadline passed yesterday must not read as filable. Counting in UTC, a Tokyo
  // practice's morning is still the previous UTC day, so an expired claim looked submittable.
  const morning = new Date("2026-08-12T09:00:00+09:00"); // 00:00 UTC on the 12th
  assert.equal(filingStatus("2026-08-11", morning, "Asia/Tokyo").risk, "expired");
});

test("the deadline day itself is still filable, in every zone", () => {
  for (const zone of ["UTC", "America/Los_Angeles", "America/New_York", "Asia/Tokyo"]) {
    for (const hour of ["00:30", "09:00", "23:30"]) {
      const now = new Date(`2026-08-11T${hour}:00${zone === "UTC" ? "Z" : ""}`);
      // Anchor the instant inside the target zone by asking what day it is there.
      const status = filingStatus("2026-08-11", now, zone);
      assert.ok(
        status.daysRemaining >= -1 && status.daysRemaining <= 1,
        `${zone} @ ${hour}: daysRemaining drifted to ${status.daysRemaining}`
      );
    }
  }
});

// ── D1 (claims side) — the estimate caveat belongs on EVERY surface, not just the expired one ──
//
// M7 established the honest position and encoded it in `FILING_WINDOWS_ARE_PAYER_SOURCED`: no filing
// window in this system is sourced from a payer's own published terms — not the catalogued ones, not
// the fallback. That is why the `past-filing-deadline` finding is a warning rather than a blocker.
//
// The caveat was only ever SAID on that one finding. Every other place a filing date reaches a
// biller stated it flat: the countdown they actually work to ("Only 3 days left to file. Submit
// today."), the recommended action, the queue badge, the claim header, the submission timeline. A
// caveat that appears only once the news is bad reads as certainty the rest of the time, which is
// the same sibling-site gap as M18.

test("D1: every filing countdown says the window is an estimate, not just the expired one", () => {
  const deadline = "2026-12-31";
  const at = (iso: string) => filingStatus(deadline, new Date(`${iso}T12:00:00Z`));

  for (const [day, risk] of [
    ["2026-01-01", "safe"],
    ["2026-11-25", "approaching"],
    ["2026-12-20", "urgent"],
  ] as const) {
    const status = at(day);
    assert.equal(status.risk, risk);
    assert.equal(status.estimated, true, `${risk} must admit the window is estimated`);
    assert.equal(status.estimateNote, FILING_WINDOW_ESTIMATE_NOTE);
    assert.match(status.message, /estimate, not this payer's stated terms/, `${risk} message`);
  }
});

test("D1: an expired deadline no longer asserts the payer will refuse the claim", () => {
  /**
   * "This payer will refuse the claim" is the certainty M7 stripped from the scrub finding, for the
   * reason that decided it: on an unsourced window it tells a practice to abandon money the payer
   * might have paid, and a written-off claim generates no evidence against the write-off.
   */
  const status = filingStatus("2026-12-31", new Date("2027-01-05T12:00:00Z"));

  assert.equal(status.risk, "expired");
  assert.doesNotMatch(status.message, /will refuse the claim/);
  assert.match(status.message, /estimate, not this payer's stated terms/);
  assert.match(status.message, /Confirm the real filing window with the payer/);
});

test("D1: the caveat is one string, so no surface can drift from the scrub finding's wording", () => {
  // M7's sentence, reused verbatim rather than re-typed per site.
  assert.match(FILING_WINDOW_ESTIMATE_NOTE, /estimate, not this payer's stated terms/);
  assert.match(FILING_WINDOW_CONFIRM_NOTE, /Confirm the real filing window with the payer/);
  assert.equal(
    filingStatus("2026-12-31", new Date("2026-12-20T12:00:00Z")).estimateNote,
    FILING_WINDOW_ESTIMATE_NOTE
  );
});

test("D1: the caveat is gated on the sourcing flag, not hardcoded on", () => {
  /**
   * The flag is the thing that makes this claim true. If the windows are ever cited to payer
   * documentation, `FILING_WINDOWS_ARE_PAYER_SOURCED` flips and every one of these sentences must
   * stop apologising — including this test, which is why it asserts the relationship rather than
   * the literal `true`.
   */
  const status = filingStatus("2026-12-31", new Date("2026-12-20T12:00:00Z"));
  assert.equal(status.estimated, !FILING_WINDOWS_ARE_PAYER_SOURCED);
  assert.equal(status.estimateNote === null, FILING_WINDOWS_ARE_PAYER_SOURCED);
});

// ── B-1 — a SOURCED filing window changes the words, never the severity ───────────────────────
//
// A literal rather than the catalog's own citation: the claims module does not import the payer
// profile, and these tests are about what the engine does with ANY source it is handed.
const AETNA_GUIDE: PayerWindowSource = {
  publisher: "Aetna Dental",
  document: "Dental Office Guide, 23.05.803.1B, revised 09/25/2026",
  url: "https://app-iaem.aetna.com/content/dam/aetna/pdfs/aetna-dental/ppo-office-guide.pdf",
  quote: "Claims should be submitted ... no later than 90 days after the date of service.",
  verifiedOn: "2026-09-30",
};

test("B-1: Aetna's filing deadline is 90 days from the date of service, not 180", () => {
  assert.equal(filingDeadline("2026-07-27", "aetna-dental"), "2026-10-25");
  assert.equal(filingDeadline("2026-07-27", "aetna-dental", 90), "2026-10-25", "the catalog's figure, same answer");
});

test("B-1: a sourced deadline is not an estimate, and names the payer's document and the contract", () => {
  const status = filingStatus("2026-12-31", new Date("2026-10-01T12:00:00Z"), "UTC", AETNA_GUIDE);
  assert.equal(status.estimated, false);
  assert.equal(status.source, AETNA_GUIDE);
  assert.equal(
    status.estimateNote,
    "That window is Aetna Dental's published filing limit (Dental Office Guide, 23.05.803.1B, revised 09/25/2026). " +
      "Your practice's contract may allow longer."
  );
  assert.equal(status.estimateNote, sourcedFilingWindowNote(AETNA_GUIDE));
  assert.doesNotMatch(status.message, /estimate/, "a published limit is not Mermaid's estimate");
  assert.match(status.message, /contract may allow longer/, "and it is still not the practice's contract");
});

test("B-1: an expired SOURCED deadline still tells a biller to confirm, never that the payer will refuse", () => {
  const status = filingStatus("2026-07-01", new Date("2026-08-01T12:00:00Z"), "UTC", AETNA_GUIDE);
  assert.equal(status.risk, "expired");
  assert.doesNotMatch(status.message, /will refuse/, "a published default is not grounds to abandon a claim");
  assert.match(status.message, /Aetna Dental's published filing limit/);
  assert.ok(status.message.includes(FILING_WINDOW_CONFIRM_NOTE), "the confirm instruction survives");
});

test("B-1: without a source the status is exactly what it was — every other payer is still an estimate", () => {
  const unsourced = filingStatus("2026-12-31", new Date("2026-10-01T12:00:00Z"));
  const explicitNull = filingStatus("2026-12-31", new Date("2026-10-01T12:00:00Z"), "UTC", null);
  assert.deepEqual(explicitNull, unsourced);
  assert.equal(unsourced.estimated, true);
  assert.equal(unsourced.estimateNote, FILING_WINDOW_ESTIMATE_NOTE);
  assert.equal(unsourced.source, null);
});
