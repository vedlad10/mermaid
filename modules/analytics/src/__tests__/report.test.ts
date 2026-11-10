/**
 * Reporting-engine tests.
 *
 * Two things get the most attention. First, that the ratios are computed against the right
 * denominator — a collection rate measured against BILLED rather than against EXPECTED would look
 * alarming at every in-network practice and mean nothing, because billed includes the contractual
 * write-off. Second, that the insights are earned: every sentence must be traceable to an arithmetic
 * threshold, because a dashboard that editorialises is one nobody can argue with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { AnalyticsService, InMemoryFactRepository, buildReport } from "../index.ts";
import type { Fact, Period } from "../index.ts";

const PERIOD: Period = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
let seq = 0;

function fact(overrides: Partial<Fact> & Pick<Fact, "factType">): Fact {
  seq += 1;
  return {
    sourceEventId: `evt-${seq}`,
    occurredAt: "2026-09-15T10:00:00.000Z",
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
    ...overrides,
  };
}

/** One clean cycle: verified, billed $1,425 expecting $800, and $800 arrived. */
const CLEAN_CYCLE = (claimId: string): Fact[] => [
  fact({ factType: "verification_completed", verificationId: `v-${claimId}`, amount: cents(1425), expected: cents(800) }),
  fact({ factType: "claim_submitted", claimId, amount: cents(1425), expected: cents(800) }),
  fact({
    factType: "payment_posted",
    claimId,
    occurredAt: "2026-09-25T10:00:00.000Z",
    amount: cents(800),
    expected: cents(800),
  }),
];

// ── Funnel ────────────────────────────────────────────────────────────────────────────

test("the funnel shows where work goes, and names the drop between stages", () => {
  const facts = [
    ...CLEAN_CYCLE("c-1"),
    fact({ factType: "verification_completed", amount: cents(500), expected: cents(300) }),
    fact({ factType: "verification_flagged" }),
  ];
  const { funnel } = buildReport(facts, PERIOD);

  assert.equal(funnel.verificationsCompleted, 2);
  assert.equal(funnel.verificationsFlagged, 1);
  assert.equal(funnel.claimsSubmitted, 1);
  assert.equal(funnel.claimsPaid, 1);
  assert.equal(funnel.billingRate, 0.5, "one of two completed verifications became a claim");
  assert.equal(funnel.reviewRate, 0.333, "one of three verifications needed a human");
});

test("an empty period reports zeros and null rates, never NaN", () => {
  const { funnel, money } = buildReport([], PERIOD);
  assert.equal(funnel.verificationsCompleted, 0);
  assert.equal(funnel.billingRate, null);
  assert.equal(money.collectionRate, null);
  assert.equal(money.recoveryRate, null);
});

// ── Money ─────────────────────────────────────────────────────────────────────────────

test("the collection rate is measured against EXPECTED, not against billed", () => {
  // Billed $1,425 but only ever expected $800 back — the rest is the patient's and the contractual
  // write-off. Collecting the full $800 is 100%, not 56%.
  const { money } = buildReport(CLEAN_CYCLE("c-1"), PERIOD);

  assert.equal(money.filedToPayers, cents(1425));
  assert.equal(money.expected, cents(800));
  assert.equal(money.collected, cents(800));
  assert.equal(money.collectionRate, 1, "a fully-paid claim is 100% collected, however large the write-off");
});

test("denial and recovery rates use their own denominators", () => {
  const facts = [
    ...CLEAN_CYCLE("c-1"),
    fact({ factType: "denial_created", claimId: "c-1", carcCode: "197", amount: cents(400), expected: cents(120) }),
    fact({ factType: "appeal_outcome", claimId: "c-1", carcCode: "197", won: true, amount: cents(300), expected: cents(400) }),
  ];
  const { money } = buildReport(facts, PERIOD);

  assert.equal(money.denied, cents(400));
  assert.equal(money.recovered, cents(300));
  assert.equal(money.denialRate, ratioOf(cents(400), cents(1425)));
  assert.equal(money.recoveryRate, 0.75);
});

test("a lost appeal recovers nothing", () => {
  const facts = [
    fact({ factType: "denial_created", carcCode: "96", amount: cents(500) }),
    fact({ factType: "appeal_outcome", carcCode: "96", won: false, amount: cents(0), expected: cents(500) }),
  ];
  const { money } = buildReport(facts, PERIOD);
  assert.equal(money.recovered, 0);
  assert.equal(money.recoveryRate, 0);
});

// ── Payer scorecard ───────────────────────────────────────────────────────────────────

test("payers are scored separately and ranked by what they are worth", () => {
  const facts = [
    ...CLEAN_CYCLE("c-1"),
    fact({ factType: "claim_submitted", claimId: "c-2", payerId: "cigna-dental", payerName: "Cigna Dental", amount: cents(200), expected: cents(150) }),
    fact({ factType: "payment_posted", claimId: "c-2", payerId: "cigna-dental", payerName: "Cigna Dental", amount: cents(150), expected: cents(150), occurredAt: "2026-09-20T10:00:00.000Z" }),
  ];
  const { payers } = buildReport(facts, PERIOD);

  assert.equal(payers.length, 2);
  assert.equal(payers[0]!.payerName, "Delta Dental", "the larger payer leads the page");
  assert.equal(payers[0]!.filedToPayers, cents(1425));
  assert.equal(payers[0]!.collectionRate, 1);
  assert.equal(payers[1]!.payerName, "Cigna Dental");
});

test("days-to-pay is matched per claim, not averaged across bulk totals", () => {
  const facts = [
    fact({ factType: "claim_submitted", claimId: "fast", occurredAt: "2026-09-01T00:00:00.000Z", amount: cents(100), expected: cents(100) }),
    fact({ factType: "payment_posted", claimId: "fast", occurredAt: "2026-09-11T00:00:00.000Z", amount: cents(100), expected: cents(100) }),
    fact({ factType: "claim_submitted", claimId: "slow", occurredAt: "2026-09-01T00:00:00.000Z", amount: cents(100), expected: cents(100) }),
    fact({ factType: "payment_posted", claimId: "slow", occurredAt: "2026-09-21T00:00:00.000Z", amount: cents(100), expected: cents(100) }),
  ];
  const { payers } = buildReport(facts, PERIOD);
  assert.equal(payers[0]!.averageDaysToPay, 15, "10 days and 20 days average to 15");
});

test("a payer with no payment yet reports null days-to-pay rather than zero", () => {
  const facts = [fact({ factType: "claim_submitted", claimId: "c-1", amount: cents(100), expected: cents(80) })];
  assert.equal(buildReport(facts, PERIOD).payers[0]!.averageDaysToPay, null);
});

test("one payer is ONE row, whatever the 835 chose to call them", () => {
  // The regression this guards: `remittance.posted` used to carry no payer slug, so payments grouped
  // under the display name while submissions grouped under the slug. Every payer appeared twice —
  // once with all the billing and no money, once with all the money and no billing — which made
  // per-payer collection rates meaningless and days-to-pay permanently null.
  const facts = [
    fact({ factType: "claim_submitted", claimId: "c-1", occurredAt: "2026-09-01T00:00:00.000Z", amount: cents(1425), expected: cents(800) }),
    fact({
      factType: "payment_posted",
      claimId: "c-1",
      occurredAt: "2026-09-13T00:00:00.000Z",
      // The 835 shouts the name; only the slug ties it back to the claim.
      payerName: "DELTA DENTAL",
      amount: cents(800),
      expected: cents(800),
    }),
  ];
  const { payers } = buildReport(facts, PERIOD);

  assert.equal(payers.length, 1, "a payer must not be split across two rows");
  assert.equal(payers[0]!.filedToPayers, cents(1425));
  assert.equal(payers[0]!.collected, cents(800));
  assert.equal(payers[0]!.collectionRate, 1);
  assert.equal(payers[0]!.averageDaysToPay, 12, "days-to-pay only works when both halves are one payer");
});

test("an unidentified payer still groups by name, case-insensitively", () => {
  const facts = [
    fact({ factType: "claim_submitted", claimId: "c-1", payerId: null, payerName: "Obscure Plan Co", occurredAt: "2026-09-01T00:00:00.000Z", amount: cents(400), expected: cents(300) }),
    fact({ factType: "payment_posted", claimId: "c-1", payerId: null, payerName: "OBSCURE PLAN CO", occurredAt: "2026-09-06T00:00:00.000Z", amount: cents(300), expected: cents(300) }),
  ];
  const { payers } = buildReport(facts, PERIOD);
  assert.equal(payers.length, 1);
  assert.equal(payers[0]!.payerId, null);
  assert.equal(payers[0]!.averageDaysToPay, 5);
});

test("a payer that was only ever eligibility-checked is not a scorecard row", () => {
  const facts = [
    ...CLEAN_CYCLE("c-1"),
    // Frank's crown had no tooth number, so the scrubber blocked the claim — Aetna was checked and
    // never billed. An all-dashes row on a behaviour scorecard is noise, not information.
    fact({ factType: "verification_completed", payerId: "aetna-dental", payerName: "Aetna Dental", amount: cents(1425), expected: cents(800) }),
  ];
  const { payers } = buildReport(facts, PERIOD);
  assert.equal(payers.length, 1);
  assert.equal(payers[0]!.payerName, "Delta Dental");
});

// ── Denial reasons ────────────────────────────────────────────────────────────────────

test("denial reasons are ranked by money, and carry their own recovery rate", () => {
  const facts = [
    fact({ factType: "denial_created", carcCode: "197", amount: cents(1125) }),
    fact({ factType: "denial_created", carcCode: "197", amount: cents(875) }),
    fact({ factType: "denial_created", carcCode: "16", amount: cents(65) }),
    fact({ factType: "appeal_outcome", carcCode: "197", won: true, amount: cents(1000), expected: cents(1125) }),
  ];
  const { topDenialReasons } = buildReport(facts, PERIOD);

  assert.equal(topDenialReasons[0]!.carcCode, "197");
  assert.equal(topDenialReasons[0]!.count, 2);
  assert.equal(topDenialReasons[0]!.denied, cents(2000));
  assert.equal(topDenialReasons[0]!.recovered, cents(1000));
  assert.equal(topDenialReasons[0]!.recoveryRate, 0.5);
  assert.equal(topDenialReasons[0]!.description, "Pre-authorization absent");
  assert.equal(topDenialReasons[1]!.carcCode, "16");
});

// ── Insights ──────────────────────────────────────────────────────────────────────────

test("every insight is earned by arithmetic, and reads as a sentence", () => {
  const facts = [
    ...CLEAN_CYCLE("c-1"),
    fact({ factType: "denial_created", claimId: "c-1", carcCode: "197", amount: cents(1125) }),
    fact({ factType: "denial_created", claimId: "c-2", carcCode: "197", amount: cents(875) }),
  ];
  const { insights } = buildReport(facts, PERIOD);

  assert.ok(insights.length > 0);
  for (const line of insights) {
    assert.ok(line.trim().length > 0);
    assert.ok(/[.!]$/.test(line.trim()), `an insight should read as a sentence: "${line}"`);
  }
  // The most actionable line: a repeated code is a process defect, not bad luck.
  assert.ok(insights.some((i) => /197/.test(i) && /process defect/.test(i)));
});

test("a quiet period says so instead of inventing observations", () => {
  assert.deepEqual(buildReport([], PERIOD).insights, ["No activity in this period yet."]);
});

test("a healthy practice is told it is healthy", () => {
  const { insights } = buildReport(CLEAN_CYCLE("c-1"), PERIOD);
  assert.ok(insights.some((i) => /the front half and the billing half agree/.test(i)));
});

test("collecting MORE than estimated is a gap, and is never called agreement", () => {
  /**
   * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────────
   * The healthy branch was `pct >= 95` with no upper bound, so every figure above 95 got "the front
   * half and the billing half agree". Live staging reported 125% and said exactly that, in green.
   *
   * A 25% overshoot is the same size of disagreement as 75% would be, pointing the other way — and
   * it is the more expensive direction. If payers routinely pay MORE than the estimate says, then
   * patients are being quoted too much and the practice is losing case acceptance on treatment
   * people could actually have afforded.
   */
  const facts = [
    fact({ factType: "claim_submitted", claimId: "c-1", amount: cents(1425), expected: cents(800) }),
    fact({ factType: "payment_posted", claimId: "c-1", amount: cents(1000), expected: cents(800) }),
  ];
  const { insights, money } = buildReport(facts, PERIOD);

  assert.equal(money.collectionRate, 1.25, "the arithmetic itself is unchanged");
  const line = insights.find((i) => /Collecting 125%/.test(i))!;
  assert.ok(line, "the rate is still reported");
  assert.doesNotMatch(line, /agree/, "125% is not agreement");
  assert.match(line, /MORE than quoted/, "the direction has to be named");
  assert.match(line, /\$200\.00/, "and the size of it");
  assert.match(line, /over-quoted/, "and the consequence a practice owner can act on");
});

test("a modest overshoot is still healthy — the band has to be a band", () => {
  /**
   * A few percent either way is rounding and coinsurance, not a finding. If every 103% raised an
   * alarm the sentence would be noise, and the 125% case would be lost in it.
   */
  const facts = [
    fact({ factType: "claim_submitted", claimId: "c-1", amount: cents(1425), expected: cents(1000) }),
    fact({ factType: "payment_posted", claimId: "c-1", amount: cents(1030), expected: cents(1000) }),
  ];
  const { insights } = buildReport(facts, PERIOD);
  assert.ok(insights.some((i) => /the front half and the billing half agree/.test(i)));
});

test("a shortfall is quantified, not merely flagged", () => {
  const facts = [
    fact({ factType: "claim_submitted", claimId: "c-1", amount: cents(1425), expected: cents(800) }),
    fact({ factType: "payment_posted", claimId: "c-1", amount: cents(400), expected: cents(800) }),
  ];
  const { insights } = buildReport(facts, PERIOD);
  assert.ok(insights.some((i) => /\$400\.00 of expected revenue has not arrived/.test(i)));
});

test("the engine is pure — the same facts always produce the same report", () => {
  const facts = [...CLEAN_CYCLE("c-1"), fact({ factType: "denial_created", carcCode: "16", amount: cents(65) })];
  assert.deepEqual(buildReport(facts, PERIOD), buildReport(facts, PERIOD));
});

// ── Service ───────────────────────────────────────────────────────────────────────────

test("recording is idempotent on the source event id", async () => {
  const repo = new InMemoryFactRepository();
  const service = new AnalyticsService(repo);
  const f = fact({ factType: "claim_submitted", claimId: "c-1", amount: cents(100), expected: cents(80) });

  assert.equal(await service.record(f), true);
  assert.equal(await service.record(f), false, "a redelivered event must not be counted twice");
  assert.equal(repo.size, 1);

  const report = await service.report(PERIOD);
  assert.equal(report.money.filedToPayers, cents(100), "and the number stays right");
});

test("facts outside the window are excluded", async () => {
  const service = new AnalyticsService(new InMemoryFactRepository());
  await service.record(fact({ factType: "claim_submitted", occurredAt: "2026-08-15T10:00:00.000Z", amount: cents(999) }));
  await service.record(fact({ factType: "claim_submitted", occurredAt: "2026-09-15T10:00:00.000Z", amount: cents(100) }));

  const report = await service.report(PERIOD);
  assert.equal(report.money.filedToPayers, cents(100));
});

test("the window's upper bound is exclusive, so a boundary fact is never double-counted", async () => {
  const service = new AnalyticsService(new InMemoryFactRepository());
  await service.record(fact({ factType: "claim_submitted", occurredAt: PERIOD.to, amount: cents(500) }));
  assert.equal((await service.report(PERIOD)).money.filedToPayers, 0);
});

/**
 * The exclusive bound above is right for a window a caller chose, and wrong for the one we choose
 * ourselves. With the default `to` set to exactly "now", anything recorded in the current
 * millisecond fell outside its own report — so a write-off posted and then immediately reported on
 * showed as forgiven nowhere, and `tests/vertical-patient-money.test.ts` failed in CI whenever both
 * HTTP round-trips finished inside one millisecond. The money was never wrong; the window was.
 */
test("a fact recorded this very millisecond is in the default report — the window we choose includes now", async () => {
  const service = new AnalyticsService(new InMemoryFactRepository());
  const stamp = "2026-09-15T10:00:00.000Z";
  await service.record(
    fact({ factType: "patient_collected", occurredAt: stamp, amount: cents(507.51), won: false })
  );

  const report = await service.report(undefined, new Date(stamp));
  assert.equal(report.money.patientForgiven, cents(507.51), "the write-off is in its own report");
});

test("an explicitly requested window keeps its exclusive bound — the default moving must not move it", async () => {
  const service = new AnalyticsService(new InMemoryFactRepository());
  await service.record(fact({ factType: "claim_submitted", occurredAt: PERIOD.to, amount: cents(500) }));

  // Same instant as the boundary, requested explicitly: still excluded, exactly as above.
  assert.equal((await service.report(PERIOD, new Date(PERIOD.to))).money.filedToPayers, 0);
});

const ratioOf = (a: number, b: number): number => Math.round((a / b) * 1000) / 1000;
