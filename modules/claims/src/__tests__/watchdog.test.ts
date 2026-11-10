/**
 * The silent-claim watchdog engine (F4).
 *
 * The rule this file exists to protect is the one in the middle: SILENCE IS NOT DENIAL, and the
 * three kinds of silence have mutually destructive remedies. Refiling an unacknowledged claim is
 * correct; refiling a stalled one manufactures the duplicate denial the replacement gate exists to
 * prevent. So the tests below are mostly about which category a claim lands in, and about the
 * claims that must produce nothing at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import {
  assessSilence,
  rankBySilenceUrgency,
  silenceWorsened,
  REJECTED_IDLE_DAYS,
  STALLED_DAYS,
  UNACKNOWLEDGED_DAYS,
  type SilenceFinding,
  type SilenceInput,
} from "../engine/watchdog.ts";

const NOW = new Date("2026-09-16T09:00:00Z");

/** Filed 2026-08-01, so 46 days silent at NOW. Deadline far out unless a test moves it. */
const filed = (over: Partial<SilenceInput> = {}): SilenceInput => ({
  status: "submitted",
  submission: { submittedAt: "2026-08-01", outcome: "accepted", controlNumber: "CH-99881" },
  filingDeadline: "2027-06-01",
  expectedInsurancePays: cents(650),
  hasPayment: false,
  ...over,
});

const at = (day: string) => new Date(`${day}T09:00:00Z`);

// ── Silence is not denial ───────────────────────────────────────────────────────────────────────

test("an adjudicated claim is never silent, whatever else is true of it", () => {
  /**
   * The line the whole feature turns on. A denial is an ANSWER — it has a reason code, it belongs to
   * the denials module, and it is worked by appeal or correction. Surfacing it here would put one
   * claim in two worklists under two incompatible remedies, which is worse than surfacing neither.
   */
  for (const status of ["denied", "paid", "partially_paid"] as const) {
    const { finding, refusedBecause } = assessSilence(filed({ status }), NOW);
    assert.equal(finding, null, `${status} is an answer, not silence`);
    assert.equal(refusedBecause, "not-a-silent-status");
  }
});

test("a claim that was never filed has nothing to be silent about", () => {
  for (const status of ["draft", "ready", "void"] as const) {
    assert.equal(assessSilence(filed({ status }), NOW).refusedBecause, "not-a-silent-status");
  }
  assert.equal(
    assessSilence(filed({ submission: null }), NOW).refusedBecause,
    "never-filed",
    "and a submitted status with no submission record is a data fault, not a chase"
  );
});

test("money posted beats the status — the payer answered", () => {
  // A claim with a payment should not be in `submitted` at all. If it is, the status is what is
  // wrong, and telling a biller to chase a payer that has already paid teaches them to ignore this.
  assert.equal(assessSilence(filed({ hasPayment: true }), NOW).refusedBecause, "the-payer-already-answered");
});

// ── The three kinds ─────────────────────────────────────────────────────────────────────────────

test("acknowledged then quiet is STALLED — call, do not refile", () => {
  const { finding } = assessSilence(filed(), NOW);
  assert.equal(finding!.category, "stalled");
  assert.equal(finding!.daysSilent, 46);
  assert.match(finding!.action, /CH-99881/, "the control number is what a biller quotes on the phone");
  assert.match(finding!.action, /Do not refile/);
  assert.match(finding!.action, /duplicate denial/);
});

test("filed and never acknowledged is UNACKNOWLEDGED — refile, there is nothing to duplicate", () => {
  const { finding } = assessSilence(
    filed({ submission: { submittedAt: "2026-08-01", outcome: "accepted", controlNumber: "" } }),
    NOW
  );
  assert.equal(finding!.category, "unacknowledged");
  assert.match(finding!.action, /refile/);
  assert.match(finding!.action, /no .*acknowledged claim for a refiling to duplicate/);
});

test("an acknowledgement that names nothing is not an acknowledgement", () => {
  /**
   * `submit` records a submission even when the clearinghouse acknowledged without an identifier.
   * Reading that as receipt turns an unacknowledged claim — refile it — into a stalled one — do not
   * refile it, and the claim then sits unfiled until its deadline passes.
   */
  for (const controlNumber of ["", "   "]) {
    const { finding } = assessSilence(
      filed({ submission: { submittedAt: "2026-08-01", outcome: "accepted", controlNumber } }),
      NOW
    );
    assert.equal(finding!.category, "unacknowledged");
  }
});

test("a rejected claim is REJECTED-NOT-REFILED, and the wording refuses to call it a denial", () => {
  /**
   * The quietest and most expensive of the three. A biller who reads "rejected" as "denied" looks
   * for an appeal path, finds none, and the claim sits — while the filing clock runs against a
   * submission the payer does not count as having happened.
   */
  const { finding } = assessSilence(
    filed({
      status: "rejected",
      submission: { submittedAt: "2026-09-01", outcome: "rejected", controlNumber: "CH-1" },
    }),
    NOW
  );
  assert.equal(finding!.category, "rejected-not-refiled");
  assert.equal(finding!.daysSilent, 15);
  assert.match(finding!.action, /NOT a denial/);
  assert.match(finding!.action, /nothing to appeal/);
  assert.match(finding!.action, /clock never stopped/);
});

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────

test("each threshold fires on its day and not the day before", () => {
  // Off-by-one here is either a queue full of claims filed yesterday, or a week of silence nobody
  // is told about.
  const unack = (day: string) =>
    assessSilence(
      filed({ submission: { submittedAt: "2026-09-01", outcome: "accepted", controlNumber: "" } }),
      at(day)
    );
  assert.equal(unack("2026-09-07").refusedBecause, "too-soon-to-chase", `${UNACKNOWLEDGED_DAYS} days, not 6`);
  assert.equal(unack("2026-09-08").finding!.category, "unacknowledged");

  const stalled = (day: string) =>
    assessSilence(filed({ submission: { submittedAt: "2026-09-01", outcome: "accepted", controlNumber: "X" } }), at(day));
  assert.equal(stalled("2026-09-30").refusedBecause, "too-soon-to-chase", `${STALLED_DAYS} days, not 29`);
  assert.equal(stalled("2026-10-01").finding!.category, "stalled");

  const rejected = (day: string) =>
    assessSilence(
      filed({ status: "rejected", submission: { submittedAt: "2026-09-01", outcome: "rejected", controlNumber: "X" } }),
      at(day)
    );
  assert.equal(rejected("2026-09-05").refusedBecause, "too-soon-to-chase", `${REJECTED_IDLE_DAYS} days, not 4`);
  assert.equal(rejected("2026-09-06").finding!.category, "rejected-not-refiled");
});

test("a rejected claim is chased sooner than a submitted one, because the ball is here", () => {
  const day = at("2026-09-08");
  const submission = { submittedAt: "2026-09-01", outcome: "rejected" as const, controlNumber: "X" };
  assert.equal(assessSilence(filed({ status: "rejected", submission }), day).finding!.category, "rejected-not-refiled");
  assert.equal(
    assessSilence(filed({ submission: { ...submission, outcome: "accepted" } }), day).refusedBecause,
    "too-soon-to-chase",
    "the payer still has a fortnight of ordinary adjudication left"
  );
});

// ── Timely-filing risk ──────────────────────────────────────────────────────────────────────────

test("the finding carries the same filing picture every other surface shows", () => {
  const { finding } = assessSilence(filed({ filingDeadline: "2026-09-25" }), NOW);
  assert.equal(finding!.filing.daysRemaining, 9);
  assert.equal(finding!.filing.risk, "urgent");
  assert.ok(
    finding!.filing.estimated,
    "no filing window in this system is payer-sourced, and the caveat must reach the watchdog too"
  );
  assert.match(finding!.action, /9 days remain to refile/);
  assert.match(finding!.action, /estimate, not this payer's stated terms/);
});

test("an expired deadline is stated as what it is, without telling anyone to write the claim off", () => {
  // `FILING_WINDOWS_ARE_PAYER_SOURCED` is false, so the deadline is Mermaid's estimate. Instructing
  // a practice to abandon revenue on an unverified constant is the exact failure M7 stripped out.
  const { finding } = assessSilence(filed({ filingDeadline: "2026-08-20" }), NOW);
  assert.equal(finding!.filing.risk, "expired");
  assert.match(finding!.action, /Confirm the real filing window with the payer/);
  assert.doesNotMatch(finding!.action, /write.{0,5}off/i);
});

test("the practice's timezone decides what day it is", () => {
  /**
   * The same reasoning as `filingStatus`: "how many days has this been silent" compares calendar
   * days, and today is a fact about where the clinic is. Just after midnight UTC it is still
   * yesterday evening in Los Angeles — the window in which end-of-day sweeps actually run — and the
   * claim has been silent for one day fewer there.
   */
  const justAfterMidnightUtc = new Date("2026-09-17T04:30:00Z");
  const input = filed({ submission: { submittedAt: "2026-08-01", outcome: "accepted", controlNumber: "X" } });
  assert.equal(assessSilence(input, justAfterMidnightUtc, "UTC").finding!.daysSilent, 47);
  assert.equal(assessSilence(input, justAfterMidnightUtc, "America/Los_Angeles").finding!.daysSilent, 46);
});

// ── Ranking ─────────────────────────────────────────────────────────────────────────────────────

const row = (id: string, over: Partial<SilenceFinding> & { risk?: SilenceFinding["filing"]["risk"] }) => ({
  id,
  finding: {
    category: "stalled" as const,
    daysSilent: over.daysSilent ?? 30,
    amountAtRisk: over.amountAtRisk ?? cents(100),
    action: "",
    filing: { deadline: "2027-01-01", daysRemaining: 100, risk: over.risk ?? "safe", message: "", estimated: true, estimateNote: null, source: null },
  } as SilenceFinding,
});

test("timely-filing risk outranks the amount, by a distance", () => {
  /**
   * The instinct is to sort by money, and it inverts exactly the thing that matters. A stalled
   * claim worth $2,000 with eight months left is a phone call. An unacknowledged claim worth $200
   * with nine days left is money about to stop existing.
   */
  const ranked = rankBySilenceUrgency([
    row("big-and-safe", { amountAtRisk: cents(2000), risk: "safe" }),
    row("small-and-urgent", { amountAtRisk: cents(200), risk: "urgent" }),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["small-and-urgent", "big-and-safe"]);
});

test("within one risk band, longest silent first, then largest", () => {
  const ranked = rankBySilenceUrgency([
    row("c", { risk: "urgent", daysSilent: 10, amountAtRisk: cents(900) }),
    row("a", { risk: "urgent", daysSilent: 60, amountAtRisk: cents(100) }),
    row("b", { risk: "urgent", daysSilent: 10, amountAtRisk: cents(5000) }),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["a", "b", "c"]);
});

test("the order is total, so a queue does not reshuffle between reads", () => {
  const identical = [row("zeta", {}), row("alpha", {}), row("mid", {})];
  assert.deepEqual(rankBySilenceUrgency(identical).map((r) => r.id), ["alpha", "mid", "zeta"]);
  assert.deepEqual(
    rankBySilenceUrgency([...identical].reverse()).map((r) => r.id),
    ["alpha", "mid", "zeta"],
    "input order must not survive into the output"
  );
});

test("ranking does not mutate what it was given", () => {
  const input = [row("b", { risk: "urgent" }), row("a", { risk: "safe" })];
  rankBySilenceUrgency(input);
  assert.deepEqual(input.map((r) => r.id), ["b", "a"]);
});

// ── Escalation ──────────────────────────────────────────────────────────────────────────────────

test("a claim nobody has raised is always worth raising", () => {
  assert.equal(silenceWorsened(null, { category: "stalled", risk: "safe" }), true);
  assert.equal(silenceWorsened(undefined, { category: "stalled", risk: "safe" }), true);
});

test("the same news twice is not news", () => {
  // An alert that fires on every sweep is an alert staff learn to scroll past, and the claims most
  // likely to be scrolled past are the oldest — exactly the ones this feature exists for.
  const raised = { category: "stalled" as const, risk: "approaching" as const };
  assert.equal(silenceWorsened(raised, { ...raised }), false);
  assert.equal(silenceWorsened(raised, { category: "stalled", risk: "safe" }), false, "and improvement is not news either");
});

test("a worsening deadline re-raises even when the category is unchanged", () => {
  /**
   * The reason both halves are recorded. A claim can sit `unacknowledged` for months while its
   * filing risk goes approaching → urgent → expired, and an escalation keyed only on the category
   * would fall silent precisely as the deadline closed in.
   */
  const raised = { category: "unacknowledged" as const, risk: "approaching" as const };
  assert.equal(silenceWorsened(raised, { category: "unacknowledged", risk: "urgent" }), true);
  assert.equal(silenceWorsened(raised, { category: "unacknowledged", risk: "expired" }), true);
});

test("a change of category re-raises, because the remedy changed", () => {
  // Going from "refile it" to "do not refile it" is the most important thing this system can say
  // about a claim, and it must never be suppressed as a repeat.
  const raised = { category: "unacknowledged" as const, risk: "urgent" as const };
  assert.equal(silenceWorsened(raised, { category: "stalled", risk: "urgent" }), true);
  assert.equal(silenceWorsened(raised, { category: "rejected-not-refiled", risk: "safe" }), true);
});

// ── Money ───────────────────────────────────────────────────────────────────────────────────────

test("the amount at risk is the claim's inherited estimate, not a figure invented here", () => {
  const { finding } = assessSilence(filed({ expectedInsurancePays: cents(1125) as Cents }), NOW);
  assert.equal(finding!.amountAtRisk, cents(1125));
});

// ── Regression: one finding, one calendar ───────────────────────────────────────────────────────

test("the silence is counted on the PRACTICE's calendar, not on UTC", () => {
  /**
   * Found by probing, not by a failing test. `submittedAt` is an INSTANT, and the engine sliced its
   * first ten characters — the UTC day — while the other half of the same finding, `filingStatus`,
   * counts in the practice's own zone. One finding, two calendars.
   *
   * For every US practice an afternoon filing lands on the FOLLOWING UTC day, so silence was
   * understated by one everywhere: a Los Angeles claim filed at 19:00 on the 31st was dated the 1st.
   * This is the defect `filingStatus` carries its own long comment about, arrived at from the other
   * end — there the count's finish was wrong, here its start was.
   */
  const filedLateAfternoonLA = "2026-08-01T02:00:00.000Z"; // 2026-07-31 19:00 in Los Angeles
  const now = new Date("2026-09-16T12:00:00Z"); // 2026-09-16 05:00 in Los Angeles

  const input = filed({
    submission: { submittedAt: filedLateAfternoonLA, outcome: "accepted", controlNumber: "X" },
  });

  assert.equal(assessSilence(input, now, "America/Los_Angeles").finding!.daysSilent, 47);
  assert.equal(assessSilence(input, now, "UTC").finding!.daysSilent, 46, "and UTC still counts in UTC");
});

test("a one-day error at a threshold is the difference between acting and not acting", () => {
  // The behavioural consequence, pinned separately: the engine has to FIRE for the practice whose
  // claim has genuinely been silent seven days, not on the day after.
  const input = filed({
    submission: { submittedAt: "2026-09-10T02:00:00.000Z", outcome: "accepted", controlNumber: "" },
  });
  const now = new Date("2026-09-16T12:00:00Z");

  assert.equal(assessSilence(input, now, "America/Los_Angeles").finding!.category, "unacknowledged");
  assert.equal(
    assessSilence(input, now, "UTC").refusedBecause,
    "too-soon-to-chase",
    "in UTC the same claim is only six days old, and that is the correct answer there"
  );
});

test("a date-only submission is already a calendar day and is not shifted", () => {
  /**
   * The same bug with its sign flipped, and the reason the conversion is conditional. Reading
   * "2026-08-01" as an instant places it at UTC midnight, which converts BACKWARDS into July for
   * every practice west of Greenwich — inventing a day of silence instead of losing one.
   */
  const input = filed({ submission: { submittedAt: "2026-08-01", outcome: "accepted", controlNumber: "X" } });
  const now = new Date("2026-09-16T12:00:00Z");

  assert.equal(assessSilence(input, now, "America/Los_Angeles").finding!.daysSilent, 46);
  assert.equal(assessSilence(input, now, "UTC").finding!.daysSilent, 46);
  assert.equal(
    assessSilence(input, now, "Asia/Tokyo").finding!.daysSilent,
    46,
    "a plain day means the same thing in every zone, which is the point of storing one"
  );
});
