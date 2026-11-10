/**
 * The appeal-award lifecycle, cases A–O.
 *
 * ── HOW THE EXPECTED VALUES WERE OBTAINED ──────────────────────────────────────────────────────
 * Every figure below is worked out on paper from the scenario and written as a literal. None is
 * read back from the code under test, and none is a snapshot of whatever the implementation
 * happened to produce — a test whose oracle is the system it tests can only ever confirm that the
 * system agrees with itself. Where a case has arithmetic, the derivation is written above it.
 *
 * The canonical numbers come from the audited staging claim:
 *
 *   charged        $1,425.00     the practice fee
 *   contractual    $  142.50     10% write-off, so allowed = $1,282.50
 *   first payment  $   21.49     what MetLife actually sent
 *   patient share  $  136.01
 *   denied         $1,125.00     CO-197, pre-authorisation absent, on D2750
 *   estimate E0    $  175.00     what the coverage snapshot promised — NOT the award
 *
 * $1,125.00 against an expectation of $175.00 is +$950.00, which is why the old code reported a
 * successful recovery as an overpayment. That is case F's counter-example and case D's whole point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import {
  applyAwardOutcome,
  applyAwardSettlement,
  attributeAward,
  awardAgeDays,
  awardOutstanding,
  awardUrgency,
  claimAwardTotals,
  expectationFor,
} from "../engine/award.ts";
import type { Denial } from "../types.ts";

const NOW = new Date("2026-09-15T10:00:00Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const DENIED = cents(1125);
const ESTIMATE_E0 = cents(175);

/** A triaged denial on D2750, exactly as `createFromVariance` leaves one. */
const denial = (over: Partial<Denial> = {}): Denial =>
  ({
    id: "den-1",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: "appealed",
    claimId: "claim-1",
    remittanceId: "rem-1",
    postingId: "post-1",
    carcCode: "197",
    carcDescription: "Pre-authorization absent",
    carcGroup: "CO",
    procedureCode: "D2750",
    deniedAmount: DENIED,
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    patientName: "Jack Demo",
    memberId: "DEMO0277",
    claimControlNumber: "MRM-A659B7918AA6",
    serviceDate: "2026-08-28",
    triage: {
      disposition: "appeal",
      overturnRate: 0.3,
      expectedRecovery: cents(337.5),
      recommendedAction: "Appeal with a retro-authorization request.",
      explain: [],
      guidance: "",
      triagedAt: NOW.toISOString(),
      source: "default-rule",
      trusted: false,
      sampleSize: 0,
    },
    appealDeadline: "2027-02-24",
    priority: 17,
    appeals: [],
    recoveredAmount: null,
    closeReason: null,
    detectedAt: NOW.toISOString(),
    audit: [],
    ...over,
  }) as Denial;

const won = (d: Denial = denial(), amount: Cents = DENIED, at: Date = NOW) =>
  applyAwardOutcome(d, { won: true, awardedAmount: amount, recordedBy: "biller@clinic" }, at);

// ── A. A denied claim ─────────────────────────────────────────────────────────────────────────

test("A — a denied claim carries no award and nothing outstanding", () => {
  const d = denial({ status: "triaged" });
  assert.equal(awardOutstanding(d), 0, "nothing has been awarded, so nothing is owed");
  assert.equal(d.deniedAmount, cents(1125));
  assert.equal(expectationFor({ expectedInsurancePays: ESTIMATE_E0, awardOutstanding: awardOutstanding(d) }), ESTIMATE_E0);
});

// ── B. Appeal won ─────────────────────────────────────────────────────────────────────────────

test("B — a won appeal creates a receivable and collects no cash", () => {
  const d = won();
  assert.equal(d.status, "awaiting_payment", "OPEN");
  assert.equal(d.awardedAmount, cents(1125), "what the payer agreed to");
  assert.equal(d.awardSettledAmount, 0, "what has arrived");
  assert.equal(d.recoveredAmount, null, "cash, of which there is none");
  assert.equal(awardOutstanding(d), cents(1125), "1125.00 − 0.00");
  assert.equal(d.outcomeDecision, "won");
  assert.match(d.audit.at(-1)!.message, /nothing has arrived yet/);
});

test("B — a lost appeal awards nothing and closes", () => {
  const d = applyAwardOutcome(denial(), { won: false, recordedBy: "biller", notes: "Upheld." }, NOW);
  assert.equal(d.status, "written_off");
  assert.equal(d.awardedAmount, 0);
  assert.equal(awardOutstanding(d), 0);
});

// ── C. No corrected ERA ───────────────────────────────────────────────────────────────────────

test("C — with no corrected ERA the award stays open and ages", () => {
  const d = won();
  assert.equal(awardAgeDays(d, NOW), 0);
  assert.equal(awardAgeDays(d, later(45)), 45);
  assert.equal(awardOutstanding(d), cents(1125), "still fully owed after 45 days");
  assert.equal(d.status, "awaiting_payment", "never self-closes");
});

test("C — the escalation bands are practice policy, applied to the award's age", () => {
  assert.deepEqual(awardUrgency(0), { band: "new", factor: 1.0 });
  assert.deepEqual(awardUrgency(29), { band: "new", factor: 1.0 });
  assert.deepEqual(awardUrgency(30), { band: "chase", factor: 1.25 });
  assert.deepEqual(awardUrgency(60), { band: "overdue", factor: 1.6 });
  assert.deepEqual(awardUrgency(90), { band: "escalate", factor: 2.0 });
});

// ── D. Exact corrected ERA — the L-1 case ─────────────────────────────────────────────────────

/**
 * Award $1,125.00, corrected ERA pays $1,125.00.
 *   expectation = the outstanding award, NOT E0 ⇒ 112500
 *   variance    = 112500 − 112500 = 0        ⇒ as_expected
 * Against E0 it would have been 112500 − 17500 = +95000 ⇒ "overpaid", which is the defect.
 */
test("D — an exact corrected ERA settles the award and is NOT an overpayment", () => {
  const d = won();
  const expectation = expectationFor({ expectedInsurancePays: ESTIMATE_E0, awardOutstanding: awardOutstanding(d) });
  assert.equal(expectation, cents(1125), "the award is the expectation once one is outstanding");

  const variance = (cents(1125) as number) - (expectation as number);
  assert.equal(variance, 0, "an exact settlement varies by nothing");

  const settled = applyAwardSettlement(d, { cash: cents(1125), postingId: "post-2" }, later(20));
  assert.equal(settled.status, "recovered", "cash — and only cash — closes it");
  assert.equal(settled.awardSettledAmount, cents(1125));
  assert.equal(awardOutstanding(settled), 0);
});

test("D — measured against the pre-appeal estimate the same payment looks overpaid", () => {
  const wrong = (cents(1125) as number) - (ESTIMATE_E0 as number);
  assert.equal(wrong, 95000, "+$950.00 — the false overpayment L-1 describes");
  assert.notEqual(wrong, 0, "which is why expectationFor exists");
});

// ── E. Lower corrected payment ────────────────────────────────────────────────────────────────

/** Award 112500, payer sends 80000. Outstanding = 112500 − 80000 = 32500. */
test("E — a short payment settles partly and leaves the remainder owed", () => {
  const d = applyAwardSettlement(won(), { cash: cents(800), postingId: "post-2" }, later(20));
  assert.equal(d.status, "partially_recovered", "still OPEN");
  assert.equal(d.awardSettledAmount, cents(800));
  assert.equal(awardOutstanding(d), cents(325), "1125.00 − 800.00");
});

// ── F. Higher corrected payment ───────────────────────────────────────────────────────────────

/**
 * Award 112500, payer sends 150000. The award caps at 112500; the surplus 37500 is the CLAIM's
 * overpayment, not the award's, and is carried by the money partition rather than here.
 */
test("F — an overpayment settles the award in full and never exceeds it", () => {
  const d = applyAwardSettlement(won(), { cash: cents(1500), postingId: "post-2" }, later(20));
  assert.equal(d.status, "recovered");
  assert.equal(d.awardSettledAmount, cents(1125), "capped at what was awarded");
  assert.equal(awardOutstanding(d), 0);
  assert.equal((cents(1500) as number) - (cents(1125) as number), 37500, "the surplus belongs to the claim");
});

// ── I. Duplicate appeal outcome ───────────────────────────────────────────────────────────────

test("I — recording the same win twice awards it once", () => {
  const first = won();
  const second = applyAwardOutcome(first, { won: true, awardedAmount: DENIED, recordedBy: "biller@clinic" }, later(1));
  assert.equal(second.awardedAmount, cents(1125), "assignment, not accumulation");
  assert.equal(second.awardSettledAmount, 0);
  assert.equal(awardOutstanding(second), cents(1125), "not 2250.00");
});

// ── H. Duplicate corrected ERA ────────────────────────────────────────────────────────────────

test("H — replaying the same posting does not double-credit", () => {
  const once = applyAwardSettlement(won(), { cash: cents(1125), postingId: "post-2" }, later(20));
  const twice = applyAwardSettlement(once, { cash: cents(1125), postingId: "post-2" }, later(20));
  assert.equal(twice.awardSettledAmount, cents(1125), "not 2250.00");
  assert.equal(twice.awardSettlements?.length, 1, "the posting is in the set once");
  assert.equal(twice, once, "an unchanged settlement returns the same object — nothing to re-audit");

  /** And a third replay, because a retry after a crash can happen more than once. */
  const thrice = applyAwardSettlement(twice, { cash: cents(1125), postingId: "post-2" }, later(40));
  assert.equal(thrice.awardSettledAmount, cents(1125));
  assert.equal(awardOutstanding(thrice), 0);
});

// ── J. Multiple postings ──────────────────────────────────────────────────────────────────────

/**
 * Two DISTINCT postings settle one award: $400.00 then $400.00.
 *   attributed  = 40000 + 40000 = 80000
 *   outstanding = 112500 − 80000 = 32500
 * The set of posting ids is what accumulates, so each posting contributes once and only once.
 */
test("J — cash is summed over distinct attributed postings", () => {
  const first = applyAwardSettlement(won(), { cash: cents(400), postingId: "post-2" }, later(10));
  assert.equal(first.awardSettledAmount, cents(400));
  assert.equal(first.awardSettlements?.length, 1);

  const second = applyAwardSettlement(first, { cash: cents(400), postingId: "post-3" }, later(20));
  assert.equal(second.awardSettledAmount, cents(800), "400.00 + 400.00 across two postings");
  assert.equal(awardOutstanding(second), cents(325), "1125.00 − 800.00");
  assert.equal(second.status, "partially_recovered");
  assert.deepEqual(
    second.awardSettlements?.map((s) => s.postingId),
    ["post-2", "post-3"],
    "each posting recorded exactly once"
  );
});

test("J — a third posting finishing the award closes it on cash", () => {
  const a = applyAwardSettlement(won(), { cash: cents(400), postingId: "post-2" }, later(10));
  const b = applyAwardSettlement(a, { cash: cents(400), postingId: "post-3" }, later(20));
  const c = applyAwardSettlement(b, { cash: cents(325), postingId: "post-4" }, later(30));
  assert.equal(c.awardSettledAmount, cents(1125), "400.00 + 400.00 + 325.00");
  assert.equal(awardOutstanding(c), 0);
  assert.equal(c.status, "recovered");
});

// ── K. Long-delayed corrected ERA ─────────────────────────────────────────────────────────────

test("K — a settlement arriving a year later still settles, and the age is reported honestly", () => {
  const d = won();
  assert.equal(awardAgeDays(d, later(365)), 365);
  assert.equal(awardUrgency(365).band, "escalate");
  const settled = applyAwardSettlement(d, { cash: cents(1125), postingId: "post-2" }, later(365));
  assert.equal(settled.status, "recovered", "lateness never forfeits the money");
  assert.equal(awardOutstanding(settled), 0);
});

// ── L. Historical recovered denial with no cash ───────────────────────────────────────────────

/**
 * The shape the 0024 backfill produces: awarded carries the old `recoveredAmount`, settled is zero,
 * and `recoveredAmount` is null so nothing reads a promise as a payment.
 */
test("L — a backfilled historical win is a receivable, not a recovery", () => {
  const d = denial({
    status: "awaiting_payment",
    awardedAmount: cents(1125),
    awardSettledAmount: cents(0),
    awardedAt: "2026-08-28T05:05:48.349Z",
    outcomeDecision: "won",
    awardBackfilled: true,
    recoveredAmount: null,
  });
  assert.equal(awardOutstanding(d), cents(1125));
  assert.equal(d.recoveredAmount, null, "no cash is asserted");
  assert.equal(d.awardSettledAmount, 0);
});

// ── M. Two awards on one claim ────────────────────────────────────────────────────────────────

const crown = () => won(denial({ id: "den-crown", procedureCode: "D2750" }), cents(1125));
const bridge = () => won(denial({ id: "den-bridge", procedureCode: "D2740" }), cents(800));

test("M — service-line detail attributes the payment to the award it names", () => {
  const a = attributeAward([crown(), bridge()], [{ procedureCode: "D2740", amount: cents(800) }]);
  assert.deepEqual(a, { kind: "exact", denialId: "den-bridge", reason: "procedure-code" });
});

test("M — the same inputs attribute the same way every time", () => {
  const lines = [{ procedureCode: "D2750", amount: cents(1125) }];
  const first = attributeAward([crown(), bridge()], lines);
  const second = attributeAward([bridge(), crown()], lines);
  assert.deepEqual(first, second, "order of the awards must not change the answer");
  assert.equal(first.kind === "exact" && first.denialId, "den-crown");
});

test("M′ — with two awards and no line detail it refuses rather than guessing", () => {
  const a = attributeAward([crown(), bridge()], [{ procedureCode: null, amount: cents(800) }]);
  assert.equal(a.kind, "ambiguous", "oldest-first would be a coin flip wearing a rule's costume");
  assert.deepEqual(a.kind === "ambiguous" && a.candidates.sort(), ["den-bridge", "den-crown"]);
});

test("M′ — one award and no line detail is unambiguous, so it settles", () => {
  const a = attributeAward([crown()], [{ procedureCode: null, amount: cents(1125) }]);
  assert.deepEqual(a, { kind: "sole", denialId: "den-crown", reason: "only-open-award" });
});

test("M′ — a settled award is not a candidate for further attribution", () => {
  const done = applyAwardSettlement(crown(), { cash: cents(1125), postingId: "p" }, later(5));
  const a = attributeAward([done], [{ procedureCode: "D2750", amount: cents(100) }]);
  assert.equal(a.kind, "none");
});

// ── N. Remittance before the award event ──────────────────────────────────────────────────────

/**
 * The ordering the outbox permits: `claim_domain_events` orders by `occurred_at` but claims batches
 * with SKIP LOCKED across concurrent workers, so two events have no guaranteed relative order.
 * Cash can therefore land before the award exists.
 */
test("N — cash that arrives before the award is picked up when the award appears", () => {
  const early = applyAwardSettlement(denial({ status: "appealed" }), { cash: cents(1125), postingId: "post-2" }, NOW);
  assert.equal(early.status, "appealed", "no award yet, so nothing to settle against");
  assert.equal(early.awardSettledAmount ?? 0, 0);

  const awarded = won(early);
  const reconciled = applyAwardSettlement(awarded, { cash: cents(1125), postingId: "post-2" }, later(1));
  assert.equal(reconciled.status, "recovered", "the award handler recomputes from cash already posted");
  assert.equal(reconciled.awardSettledAmount, cents(1125));
});

// ── O. Divergence detection ───────────────────────────────────────────────────────────────────

/**
 * Invariant S1: the projection equals the sum over open awards of (awarded − settled). Asserted
 * here on the owning side, and by the S1 query against the database.
 */
test("O — claim totals equal the sum of open awards, and drift is visible", () => {
  const totals = claimAwardTotals([crown(), bridge()]);
  assert.equal(totals.awarded, cents(1925), "1125.00 + 800.00");
  assert.equal(totals.settled, 0);
  assert.equal(totals.outstanding, cents(1925));

  const partly = applyAwardSettlement(bridge(), { cash: cents(300), postingId: "p" }, later(3));
  const after = claimAwardTotals([crown(), partly]);
  assert.equal(after.settled, cents(300));
  assert.equal(after.outstanding, cents(1625), "1925.00 − 300.00");
});

test("O — a fully settled award leaves the open projection, because it is no longer outstanding", () => {
  const done = applyAwardSettlement(crown(), { cash: cents(1125), postingId: "p" }, later(5));
  assert.equal(done.status, "recovered");
  assert.equal(claimAwardTotals([done]).outstanding, 0, "recovered is not an open award");
});

// ── The expectation switch, stated as a table ─────────────────────────────────────────────────

test("expectationFor returns the award when one is outstanding, the estimate otherwise", () => {
  assert.equal(expectationFor({ expectedInsurancePays: ESTIMATE_E0, awardOutstanding: cents(0) }), cents(175));
  assert.equal(expectationFor({ expectedInsurancePays: ESTIMATE_E0, awardOutstanding: cents(1125) }), cents(1125));
  assert.equal(expectationFor({ expectedInsurancePays: ESTIMATE_E0, awardOutstanding: cents(325) }), cents(325));
});
