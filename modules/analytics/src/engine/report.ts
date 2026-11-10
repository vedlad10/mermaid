/**
 * The reporting engine — facts in, a practice report out.
 *
 * Pure and deterministic: the same facts always produce the same report, which is what makes a
 * number on a dashboard something a practice owner can act on rather than something they have to
 * re-check. No I/O, no clock beyond the period it is given.
 *
 * The `insights` are the part that matters most and the part most easily done badly. They are
 * deliberately deterministic rules over the aggregates — not generated prose. A sentence that tells
 * a clinic "your collection rate fell" must be true because arithmetic says so, and must be
 * reproducible when they ask why. An LLM could phrase these more warmly; it must never decide which
 * ones are true (blueprint doc 10).
 */
import { addCents, describeCarc, formatUsd, type Cents } from "@mermaid/shared";
import type { DenialReason, Fact, Funnel, MoneySummary, PayerScore, Period, PracticeReport,
  DailyCollection,
} from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = 0 as Cents;

const sum = (values: Cents[]): Cents => addCents(...values);
const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

const of = (facts: Fact[], type: Fact["factType"]): Fact[] => facts.filter((f) => f.factType === type);

export function buildFunnel(facts: Fact[]): Funnel {
  const completed = of(facts, "verification_completed").length;
  const flagged = of(facts, "verification_flagged").length;
  const submitted = of(facts, "claim_submitted").length;
  // "Paid" means a payment landed against the claim, whatever its size — a partially paid claim has
  // still moved through the cycle, and counting only fully-settled ones would understate throughput.
  const paid = of(facts, "payment_posted").length;

  return {
    verificationsCompleted: completed,
    verificationsFlagged: flagged,
    claimsSubmitted: submitted,
    claimsPaid: paid,
    billingRate: ratio(submitted, completed),
    reviewRate: ratio(flagged, completed + flagged),
  };
}

/**
 * Estimate-vs-actual, over a MATCHED population (F-7).
 *
 * ── WHY THIS IS NOT `collected − expected` ─────────────────────────────────────────────────────
 * The obvious form is wrong, and wrong in a way that looks plausible on a dashboard. `expected` is
 * summed over claims SUBMITTED in the period; `collected` over payments POSTED in it. Payers take
 * weeks — the report computes the mean days-to-payment precisely because they do — so those are two
 * different populations of claims. A practice whose estimates are perfect but whose volume is
 * growing files more this month than it gets paid for this month, and the metric would report a
 * large "estimate shortfall" that is really a growing business. A metric that reports a systematic
 * error where none exists is worse than no metric: the practice would go looking for a fee-schedule
 * fault it does not have.
 *
 * Every `payment_posted` fact carries the paid amount AND the expectation of the claim it paid, so
 * the comparison can be made per claim and summed — same claims on both sides, whenever they were
 * filed.
 *
 * The expectation is counted once per claim. A claim legitimately paid by a primary AND a secondary
 * payer produces two facts, both carrying that one claim's expectation; the paid amounts genuinely
 * add, the expectation does not. Summing it twice would invent a shortfall the size of the whole
 * claim on exactly the coordination-of-benefits cases that are hardest to check by hand.
 */
function estimateAccuracyOf(
  payments: Fact[],
  outcomes: Fact[]
): Pick<MoneySummary, "estimateVariance" | "estimateAccuracy"> {
  const paid = sum(payments.map((f) => f.amount));

  const seen = new Set<string>();
  const expectations: Cents[] = [];
  for (const [i, f] of payments.entries()) {
    // A fact with no claim id cannot be matched to a sibling payment, so it is counted on its own.
    // Better a possible double-count on a malformed fact than dropping a real expectation.
    const key = f.claimId ?? `unmatched:${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    expectations.push(f.expected);
  }
  const expected = sum(expectations);

  /**
   * Cash won on appeal is EXPLAINED, and is removed for the same reason the claim screen removes it:
   * a practice that appealed two denials and won $2,250.00 is not a practice whose payers pay more
   * than estimated. Left in, staging reported +32% estimate accuracy — "payers pay you a third more
   * than you quote" — when the truth is they paid $300.11 LESS and two appeals were won. That is not
   * a small distortion of the signal, it is the opposite sign.
   *
   * Restricted to claims that are in the PAID population above, which is what keeps both sides
   * measuring the same claims. A recovery on a claim no payment landed on this period is not
   * subtracted, because its cash is not in `paid` either.
   *
   * One case this cannot net: an appeal recorded in a previous window whose corrected cash arrives
   * in this one. The two are tightly coupled in practice — the payer records the outcome and sends
   * the corrected advice together — but where they straddle a boundary, the per-claim figure on the
   * claim screen is the authoritative one, because it is not scoped to a window at all.
   */
  const paidClaims = new Set(payments.map((f) => f.claimId).filter((id): id is string => Boolean(id)));
  const recovered = sum(
    outcomes.filter((f) => f.won === true && f.claimId !== null && paidClaims.has(f.claimId)).map((f) => f.amount)
  );

  const variance = (paid - expected - recovered) as Cents;

  return {
    // Signed, because the direction is the whole message: payers paying LESS than estimated is what
    // leaves a patient with a bill bigger than the one they were quoted.
    estimateVariance: variance,
    estimateAccuracy: expected === 0 ? null : Math.round((variance / expected) * 1000) / 1000,
  };
}

export function buildMoney(facts: Fact[]): MoneySummary {
  const submitted = of(facts, "claim_submitted");
  const payments = of(facts, "payment_posted");
  const denials = of(facts, "denial_created");
  const outcomes = of(facts, "appeal_outcome");

  const filedToPayers = sum(submitted.map((f) => f.amount));
  const expected = sum(submitted.map((f) => f.expected));
  const collected = sum(payments.map((f) => f.amount));
  const denied = sum(denials.map((f) => f.amount));
  const recovered = sum(outcomes.filter((f) => f.won).map((f) => f.amount));

  // The patient side (M9). `won` on a patient_collected fact means the money actually arrived; false
  // means the practice forgave it. Both reduce the balance; only one is revenue.
  const patientCharges = of(facts, "patient_charged");
  const patientSettlements = of(facts, "patient_collected");
  const patientBilled = sum(patientCharges.map((f) => f.amount));
  const patientCollected = sum(patientSettlements.filter((f) => f.won).map((f) => f.amount));
  const patientForgiven = sum(patientSettlements.filter((f) => !f.won).map((f) => f.amount));

  return {
    filedToPayers,
    expected,
    collected,
    denied,
    recovered,
    // Against EXPECTED, not against what was filed: the filed figure includes the contractual write-off every in-network
    // practice takes, so a collection rate measured against it would look alarming and mean nothing.
    collectionRate: ratio(collected, expected),
    denialRate: ratio(denied, filedToPayers),
    recoveryRate: ratio(recovered, denied),
    patientBilled,
    patientCollected,
    patientForgiven,
    patientCollectionRate: ratio(patientCollected, patientBilled),
    ...estimateAccuracyOf(payments, outcomes),
    totalCollected: (collected + patientCollected) as Cents,
  };
}

/**
 * The grouping key for one payer's facts.
 *
 * The SLUG when there is one, because that is the identity every module carries; the display name,
 * case-folded, only as a fallback for a payer the clearinghouse never identified. Case-folding
 * matters: an 835 shouts "METLIFE DENTAL" where a 271 says "MetLife Dental", and two rows for one
 * payer is a scorecard nobody can act on.
 */
const payerKey = (fact: Fact): string => fact.payerId ?? fact.payerName!.trim().toLowerCase();

export function buildPayerScores(facts: Fact[]): PayerScore[] {
  const byPayer = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (!fact.payerName) continue;
    const key = payerKey(fact);
    byPayer.set(key, [...(byPayer.get(key) ?? []), fact]);
  }

  const scores: PayerScore[] = [];
  for (const [, payerFacts] of byPayer) {
    const submitted = of(payerFacts, "claim_submitted");
    const payments = of(payerFacts, "payment_posted");
    const denials = of(payerFacts, "denial_created");
    const outcomes = of(payerFacts, "appeal_outcome");

    const filedToPayers = sum(submitted.map((f) => f.amount));
    const expected = sum(submitted.map((f) => f.expected));
    const collected = sum(payments.map((f) => f.amount));
    const denied = sum(denials.map((f) => f.amount));

    // A payer the practice merely ran an eligibility check against has no behaviour to score. An
    // all-dashes row is noise on a page whose whole job is to rank payers by how they actually act.
    if (submitted.length === 0 && filedToPayers === 0 && collected === 0 && denied === 0) continue;

    scores.push({
      // Prefer a fact that carries the slug; a fallback-keyed group may have it on a later row.
      payerId: payerFacts.find((f) => f.payerId)?.payerId ?? null,
      payerName: payerFacts[0]!.payerName!,
      claimsSubmitted: submitted.length,
      filedToPayers,
      expected,
      collected,
      denied,
      recovered: sum(outcomes.filter((f) => f.won).map((f) => f.amount)),
      collectionRate: ratio(collected, expected),
      denialRate: ratio(denied, filedToPayers),
      averageDaysToPay: averageDaysToPay(submitted, payments),
    });
  }

  // Most filed first — a payer that is 2% of revenue does not belong at the top of the page.
  return scores.sort((a, b) => b.filedToPayers - a.filedToPayers);
}

/**
 * Mean days between a claim being submitted and a payment landing on it.
 *
 * Matched per claim rather than by comparing bulk averages, because a payer that pays small claims
 * fast and large ones slowly would otherwise look consistent.
 */
function averageDaysToPay(submitted: Fact[], payments: Fact[]): number | null {
  const submittedAt = new Map<string, string>();
  for (const fact of submitted) {
    if (fact.claimId) submittedAt.set(fact.claimId, fact.occurredAt);
  }

  const spans: number[] = [];
  for (const payment of payments) {
    const start = payment.claimId ? submittedAt.get(payment.claimId) : undefined;
    if (!start) continue;
    const days = (new Date(payment.occurredAt).getTime() - new Date(start).getTime()) / DAY_MS;
    if (days >= 0) spans.push(days);
  }
  if (spans.length === 0) return null;
  return Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10;
}

export function buildDenialReasons(facts: Fact[], limit = 8): DenialReason[] {
  const byCode = new Map<string, { denied: Cents; recovered: Cents; count: number }>();

  for (const fact of of(facts, "denial_created")) {
    if (!fact.carcCode) continue;
    const entry = byCode.get(fact.carcCode) ?? { denied: ZERO, recovered: ZERO, count: 0 };
    entry.denied = (entry.denied + fact.amount) as Cents;
    entry.count += 1;
    byCode.set(fact.carcCode, entry);
  }
  for (const fact of of(facts, "appeal_outcome")) {
    if (!fact.carcCode || !fact.won) continue;
    const entry = byCode.get(fact.carcCode) ?? { denied: ZERO, recovered: ZERO, count: 0 };
    entry.recovered = (entry.recovered + fact.amount) as Cents;
    byCode.set(fact.carcCode, entry);
  }

  return [...byCode.entries()]
    .map(([carcCode, e]) => ({
      carcCode,
      description: describeCarc(carcCode),
      count: e.count,
      denied: e.denied,
      recovered: e.recovered,
      recoveryRate: ratio(e.recovered, e.denied),
    }))
    .sort((a, b) => b.denied - a.denied)
    .slice(0, limit);
}

/**
 * Deterministic observations, in the order a practice owner would want them: the money first, then
 * what is going wrong, then what is going right.
 *
 * Every sentence is earned by an arithmetic threshold. None is generated.
 */
/**
 * What the period says about the ESTIMATES, in one sentence.
 *
 * ── THE CASH RATIO IS NOT THE ESTIMATE VERDICT ───────────────────────────────────────
 * `collectionRate` is collected ÷ expected. It says nothing about WHY the two differ, and on live
 * staging it read 125% purely because two appeals were won: $9,609.87 collected against $7,660.00
 * expected, of which $2,250.00 was recovered money. This sentence used to interpret that as
 *
 *     "payers are paying $1,949.87 MORE than quoted"
 *
 * while the tile rendered beside it — driven by `estimateVariance`, which nets appeal wins out —
 * said "3.9% under", i.e. payers paid $300.13 LESS. One screen, two opposite answers to the same
 * question, and the narrative was giving the wrong one.
 *
 * `estimateAccuracyOf` already documents why netting is the honest version: left in, recoveries do
 * not merely distort the signal, they invert it. So the headline stays the cash ratio — that is
 * what `collectionRate` means, and it is not wrong — while every JUDGEMENT about the estimates now
 * comes from the netted figure, which is the one the tile shows.
 *
 * ── OVER-COLLECTION IS A GAP, NOT AGREEMENT ─────────────────────────────────────────
 * The older rule this keeps: `>= 95` once had no upper bound, so it called 125% "agreement". A 25%
 * overshoot is the same size of disagreement as 75% would be, pointing the other way, and it was
 * being told to an owner in green. It matters in one specific way — if payers routinely pay MORE
 * than the estimate says, patients are being quoted too much, and the practice is losing case
 * acceptance on treatment people could afford.
 */
function estimateSentence(money: MoneySummary): string {
  const pct = Math.round((money.collectionRate ?? 0) * 100);
  const head = `Collecting ${pct}% of what the estimates promised`;
  const shortfall = Math.abs(money.estimateVariance) as Cents;
  const cashGap = (money.expected - money.collected) as Cents;

  /* Nothing answered means nothing has tested the estimates, so only the cash may be spoken about. */
  if (money.estimateAccuracy === null) {
    return pct >= 95
      ? `${head}. No claim has been answered yet, so nothing has tested the estimates.`
      : `${head}. ${formatUsd(cashGap)} of expected revenue has not arrived.`;
  }

  /*
   * The cash ratio and the netted verdict can only disagree in sign because appeal money is sitting
   * in the cash. Naming the recovery is what lets a reader see the sentence and the tile as one fact
   * rather than two contradictory ones.
   */
  const nettedContradictsCash = pct >= 95 && money.estimateAccuracy < -0.05;
  if (pct > 110 || nettedContradictsCash) {
    if (money.estimateVariance > 0) {
      return `${head} — payers are paying ${formatUsd(money.estimateVariance)} MORE than quoted, net of ` +
        `anything won on appeal. Either the estimates understate coverage, in which case patients are ` +
        `being over-quoted, or money arrived that was never estimated (claims filed in an earlier period).`;
    }
    if (money.recovered > 0) {
      return `${head}, but ${formatUsd(money.recovered)} of that was won on appeal. Net of appeal wins ` +
        `payers paid ${formatUsd(shortfall)} LESS than quoted.`;
    }
    return money.estimateVariance === 0
      ? `${head}. Net of anything won on appeal the estimates were on the nose.`
      : `${head}. Net of anything won on appeal payers paid ${formatUsd(shortfall)} LESS than quoted.`;
  }

  if (pct >= 95) return `${head} — the front half and the billing half agree.`;
  if (pct >= 80) {
    return `${head}. The ${formatUsd(cashGap)} gap is worth understanding before it becomes normal.`;
  }
  return `Collecting only ${pct}% of what the estimates promised. ` +
    `${formatUsd(cashGap)} of expected revenue has not arrived.`;
}

export function buildInsights(
  funnel: Funnel,
  money: MoneySummary,
  payers: PayerScore[],
  reasons: DenialReason[]
): string[] {
  const insights: string[] = [];

  if (funnel.verificationsCompleted === 0 && funnel.claimsSubmitted === 0) {
    return ["No activity in this period yet."];
  }

  if (money.collectionRate !== null) {
    insights.push(estimateSentence(money));
  }

  if (money.denied > 0) {
    const outstanding = (money.denied - money.recovered) as Cents;
    insights.push(
      money.recoveryRate !== null && money.recoveryRate > 0
        ? `${formatUsd(money.denied)} was denied; ${formatUsd(money.recovered)} has been recovered (${Math.round(money.recoveryRate * 100)}%), leaving ${formatUsd(outstanding)} still in play.`
        : `${formatUsd(money.denied)} was denied and none of it has been worked yet.`
    );
  }

  // The patient side is where most practices quietly lose the most, because unlike a payer balance
  // nobody chases it — so it earns a sentence whenever there is one to say.
  if (money.patientBilled > 0) {
    const outstanding = (money.patientBilled - money.patientCollected - money.patientForgiven) as Cents;
    const collectedPct = Math.round((money.patientCollectionRate ?? 0) * 100);
    insights.push(
      outstanding > 0
        ? `Patients were billed ${formatUsd(money.patientBilled)} and have paid ${formatUsd(money.patientCollected)} (${collectedPct}%). ` +
            `${formatUsd(outstanding)} is still on patient accounts — the half of the revenue cycle nobody chases.`
        : `Patients were billed ${formatUsd(money.patientBilled)} and every balance has been settled.`
    );
  }

  // The single most actionable line on the page: not "you were denied", but "this is the one to fix".
  const worst = reasons[0];
  if (worst && worst.count > 1) {
    insights.push(
      `${worst.carcCode} (${worst.description}) is the costliest reason — ${worst.count} denials worth ${formatUsd(worst.denied)}. ` +
        `A recurring code is usually a process defect, not ${worst.count} unlucky claims.`
    );
  }

  const struggling = payers.filter((p) => p.claimsSubmitted >= 2 && p.denialRate !== null && p.denialRate > 0.25);
  if (struggling.length > 0) {
    const p = struggling[0]!;
    insights.push(
      `${p.payerName} denied ${Math.round(p.denialRate! * 100)}% of what was billed to them across ${p.claimsSubmitted} claims.`
    );
  }

  const slow = payers.filter((p) => p.averageDaysToPay !== null && p.averageDaysToPay > 30);
  if (slow.length > 0) {
    const p = slow[0]!;
    insights.push(`${p.payerName} takes ${p.averageDaysToPay} days on average to pay — plan cash flow around it.`);
  }

  if (funnel.reviewRate !== null && funnel.reviewRate > 0.4 && funnel.verificationsCompleted + funnel.verificationsFlagged >= 5) {
    insights.push(
      `${Math.round(funnel.reviewRate * 100)}% of verifications needed a human. That is front-desk time spent on cases the system could not settle on its own.`
    );
  }

  if (funnel.billingRate !== null && funnel.billingRate < 0.8 && funnel.verificationsCompleted >= 5) {
    insights.push(
      `Only ${Math.round(funnel.billingRate * 100)}% of completed verifications became claims. Verified treatment that is never billed is the quietest revenue leak there is.`
    );
  }

  return insights;
}

/**
 * Cash posted per day, for the days that actually have some.
 *
 * ── WHY ONLY THE DAYS WITH ACTIVITY ────────────────────────────────────────────────────────────
 * Padding the window with zero-days would draw a chart that looks like a collapse whenever a
 * practice has a quiet week, and would make a four-day-old deployment look like a business in
 * decline. A day with no payments is not a day the practice collected nothing — on most windows it
 * is a weekend, or a day before the practice existed. The series reports what happened and the
 * surface says how many days that was.
 *
 * ── WHY THIS IS NOT A TREND ────────────────────────────────────────────────────────────────────
 * It is a record, not a projection. Nothing here smooths, extrapolates or fits a line, because with
 * the volumes a single practice generates any of those would be decoration wearing the costume of
 * analysis. Read from the same facts every other figure in this report is read from, so it
 * reconciles with `money.collected` by construction.
 */
function buildDailyCollections(facts: Fact[]): DailyCollection[] {
  const byDay = new Map<string, { cents: number; count: number }>();
  for (const fact of facts) {
    if (fact.factType !== "payment_posted") continue;
    const day = fact.occurredAt.slice(0, 10);
    const bucket = byDay.get(day) ?? { cents: 0, count: 0 };
    bucket.cents += fact.amount ?? 0;
    bucket.count += 1;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .map(([day, b]) => ({ day, collected: b.cents as Cents, payments: b.count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export function buildReport(facts: Fact[], period: Period): PracticeReport {
  const funnel = buildFunnel(facts);
  const money = buildMoney(facts);
  const payers = buildPayerScores(facts);
  const topDenialReasons = buildDenialReasons(facts);
  return {
    period,
    funnel,
    money,
    payers,
    topDenialReasons,
    dailyCollections: buildDailyCollections(facts),
    insights: buildInsights(funnel, money, payers, topDenialReasons),
  };
}
