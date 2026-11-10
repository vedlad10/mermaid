/**
 * The statutory clock engine (F5).
 *
 * This engine is unusual in the codebase: its output is a demand addressed to somebody else. A wrong
 * internal figure is a bug; a wrong figure in a letter to a payer costs the argument AND the standing
 * to win the next one. So most of what is tested below is the engine REFUSING — and each refusal is
 * a case where the arithmetic would have produced a confident, plausible, indefensible number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import {
  addMonths,
  assessPromptPay,
  assessRecoupment,
  assessUnpaidDeadline,
  type PromptPayInput,
  type RecoupmentInput,
} from "../statutory-clock.ts";
import { promptPayRuleFor, recoupmentRuleFor } from "../statutes.ts";
import { foldSavings, toStored } from "../statutory-clock-repository.ts";

const NJ = promptPayRuleFor("NJ", "2026-09-01")!;
const OR = promptPayRuleFor("OR", "2026-09-01")!;
const TX_RECOUP = recoupmentRuleFor("TX", "2026-09-01")!;
const NY_RECOUP = recoupmentRuleFor("NY", "2026-09-01")!;

const paid = (over: Partial<PromptPayInput> = {}): PromptPayInput => ({
  submittedAt: "2026-06-01",
  paidAt: "2026-07-31", // 60 days — 30 late under NJ's electronic standard
  paidCents: cents(650),
  submissionChannel: "electronic",
  adjustments: [{ group: "CO", code: "45" }],
  interestPaidAtProviderLevel: false,
  disposition: "partial",
  ...over,
});

const takeback = (over: Partial<RecoupmentInput> = {}): RecoupmentInput => ({
  reasonCode: "WO",
  referenceId: "MRM-000123",
  amountCents: cents(420),
  recoupedAt: "2026-09-01",
  originalPaidAt: "2026-01-05",
  ...over,
});

// ── Prompt pay: the arithmetic ──────────────────────────────────────────────────────────────────

test("a payer 30 days past the statutory window owes simple interest on what it paid", () => {
  const { finding, refusedBecause } = assessPromptPay(paid(), NJ);
  assert.equal(refusedBecause, null);
  assert.equal(finding!.elapsedDays, 60);
  assert.equal(finding!.allowedDays, 30);
  assert.equal(finding!.lateDays, 30);
  assert.equal(finding!.rateBps, 1200);
  // $650.00 × 12% × 30/365 = $6.41
  assert.equal(finding!.interestCents, cents(6.41));
  assert.equal(finding!.principal, cents(650));
});

test("a paper claim gets the longer window, and it changes the answer", () => {
  // NJ allows 40 days on paper against 30 electronic, so the same 35-day payment is late one way
  // and on time the other. An engine that assumed a channel would be wrong half the time.
  const late = paid({ paidAt: "2026-07-06", submissionChannel: "electronic" });
  const onTime = paid({ paidAt: "2026-07-06", submissionChannel: "paper" });

  assert.equal(assessPromptPay(late, NJ).finding!.lateDays, 5);
  assert.equal(assessPromptPay(onTime, NJ).refusedBecause, "paid-within-the-statutory-window");
});

test("the finding carries the statute it was computed from, not just the number", () => {
  const { finding } = assessPromptPay(paid(), NJ);
  assert.match(finding!.citation, /N\.J\.S\.A\. 17B:30-51/);
  assert.ok(finding!.source.startsWith("https://"));
  assert.equal(finding!.verifiedOn, "2026-09-15");
  assert.ok(
    finding!.defeasibleBy.some((d) => /self-funded \(ERISA\)/.test(d)),
    "every prompt-pay demand must travel with the preemption that could defeat it"
  );
  assert.match(finding!.action, /Confirm the plan is insured rather than self-funded/);
});

// ── Prompt pay: everything that must NOT produce a demand ───────────────────────────────────────

test("a state with no verified rule produces nothing, never a typical 30 days", () => {
  assert.deepEqual(assessPromptPay(paid(), promptPayRuleFor("CA", "2026-09-01")), {
    finding: null,
    refusedBecause: "no-rule-for-state",
  });
  assert.equal(promptPayRuleFor("WY", "2026-09-01"), null, "and an unlisted state has no rule at all");
});

test("a claim the payer asked for information on is not a clean claim", () => {
  /**
   * Every one of these statutes runs its clock on a CLEAN claim and restarts it when the payer
   * requests more. So the date interest would accrue from is the date the information arrived —
   * which is not in an 835. The engine refuses rather than accruing from the original filing, which
   * is the version of this arithmetic the payer would disprove using our own evidence.
   */
  for (const code of ["16", "17", "226", "252", "197"]) {
    const { finding, refusedBecause } = assessPromptPay(
      paid({ adjustments: [{ group: "CO", code }] }),
      NJ
    );
    assert.equal(finding, null, `CARC ${code} should not produce a demand`);
    assert.equal(refusedBecause, "claim-was-not-clean");
  }
});

test("interest already paid is never demanded twice", () => {
  assert.equal(
    assessPromptPay(paid({ interestPaidAtProviderLevel: true }), NJ).refusedBecause,
    "interest-already-paid",
    "PLB L6 is the payer saying it already paid this"
  );
  assert.equal(
    assessPromptPay(paid({ adjustments: [{ group: "PR", code: "85" }] }), NJ).refusedBecause,
    "interest-already-paid",
    "and CARC 85 is the same statement in the claim loop"
  );
});

test("a denial, a reversal and a zero-dollar adjudication carry no principal", () => {
  assert.equal(assessPromptPay(paid({ disposition: "denied" }), NJ).refusedBecause, "claim-was-not-paid");
  assert.equal(assessPromptPay(paid({ disposition: "reversal" }), NJ).refusedBecause, "claim-was-not-paid");
  assert.equal(assessPromptPay(paid({ paidCents: cents(0) }), NJ).refusedBecause, "claim-was-not-paid");
});

test("paid exactly on the last allowed day is on time", () => {
  // Off-by-one here is a demand letter for a payer that met its deadline.
  assert.equal(assessPromptPay(paid({ paidAt: "2026-07-01" }), NJ).refusedBecause, "paid-within-the-statutory-window");
  assert.equal(assessPromptPay(paid({ paidAt: "2026-07-02" }), NJ).finding!.lateDays, 1);
});

test("Oregon's own $2 floor is honoured, because the statute writes it", () => {
  /**
   * ORS 743B.452: an insurer is not required to pay interest of $2 or less. It is a legislated
   * threshold, not a presentation one — demanding $1.40 from an Oregon payer is demanding money the
   * statute says is not owed, and the payer's next letter would say so.
   */
  const small = paid({ paidCents: cents(120), paidAt: "2026-07-21" }); // 50 days, 20 late
  const { finding, refusedBecause } = assessPromptPay(small, OR);
  assert.equal(finding, null);
  assert.equal(refusedBecause, "below-the-statutory-minimum");

  // The same lateness on a claim large enough to clear the floor still reports.
  assert.ok(assessPromptPay(paid({ paidAt: "2026-07-21" }), OR).finding!.interestCents > cents(2));
});

test("a state without a floor reports the small amounts a floored state suppresses", () => {
  // The same input, two states: the difference is the statute, and nothing else.
  const small = paid({ paidCents: cents(120), paidAt: "2026-07-21" });
  assert.equal(assessPromptPay(small, OR).finding, null);
  assert.ok(assessPromptPay(small, NJ).finding!.interestCents > 0, "NJ writes no floor, so NJ gets the finding");
});

// ── Recoupment ──────────────────────────────────────────────────────────────────────────────────

test("a takeback after the window has closed is disputable, with both dates on it", () => {
  // Texas: 180 days. Paid 2026-01-05, recouped 2026-09-01 — 239 days.
  const { finding, refusedBecause } = assessRecoupment(takeback(), TX_RECOUP);
  assert.equal(refusedBecause, null);
  assert.equal(finding!.disputableCents, cents(420));
  assert.equal(finding!.daysSinceOriginalPayment, 239);
  assert.equal(finding!.windowDays, 180);
  assert.equal(finding!.windowStated, "180 days");
  assert.match(finding!.citation, /Tex\. Ins\. Code § 1301\.132/);
  assert.match(finding!.action, /2026-01-05/);
  assert.match(finding!.action, /2026-09-01/);
});

test("the same takeback inside a longer state's window is not a finding", () => {
  // New York gives 24 months for exactly the same facts. The state is the whole answer.
  assert.equal(assessRecoupment(takeback(), NY_RECOUP).refusedBecause, "within-the-recoupment-window");
});

test("a takeback we cannot date produces a refusal, never a guess", () => {
  /**
   * The index only holds claims paid since this feature was switched on, so a null original payment
   * is ordinary rather than exceptional. A defence built on an invented payment date is one the payer
   * disproves from its own records, which is worse than raising nothing.
   */
  assert.equal(
    assessRecoupment(takeback({ originalPaidAt: null }), TX_RECOUP).refusedBecause,
    "original-payment-unknown"
  );
  assert.equal(
    assessRecoupment(takeback({ referenceId: null }), TX_RECOUP).refusedBecause,
    "original-payment-unknown",
    "a payer that named no claim has told us nothing to date"
  );
});

test("a forwarding balance is not a recoupment", () => {
  // `FB` means the payer is paying it on the next advice, not that it has taken anything. Disputing
  // it would send a biller after money that is still coming.
  assert.equal(assessRecoupment(takeback({ reasonCode: "FB" }), TX_RECOUP).refusedBecause, "not-a-recoupment");
  assert.equal(assessRecoupment(takeback({ reasonCode: "L6" }), TX_RECOUP).refusedBecause, "not-a-recoupment");
});

test("a negative PLB adds money back and is not a takeback", () => {
  assert.equal(
    assessRecoupment(takeback({ amountCents: -100 as Cents }), TX_RECOUP).refusedBecause,
    "not-a-recoupment"
  );
});

test("recouped on the last day of the window is inside it", () => {
  // 2026-01-05 + 180 days = 2026-07-04.
  assert.equal(
    assessRecoupment(takeback({ recoupedAt: "2026-07-04" }), TX_RECOUP).refusedBecause,
    "within-the-recoupment-window"
  );
  assert.equal(assessRecoupment(takeback({ recoupedAt: "2026-07-05" }), TX_RECOUP).finding!.windowDays, 180);
});

test("a state with no verified recoupment rule produces nothing", () => {
  assert.equal(recoupmentRuleFor("NJ", "2026-09-01"), null, "NJ has a prompt-pay rule and no verified window");
  assert.equal(assessRecoupment(takeback(), null).refusedBecause, "no-rule-for-state");
});

// ── Month arithmetic ────────────────────────────────────────────────────────────────────────────

test("month windows clamp to the end of the month instead of rolling over", () => {
  /**
   * 18 months from 2025-08-31 is 2027-02-28, not 2027-03-03. `Date.setMonth` rolls over, and rolling
   * over LENGTHENS the window in the payer's favour — on exactly the claims that sit at a month
   * boundary, where nobody would think to check.
   */
  assert.equal(addMonths("2025-08-31", 18), "2027-02-28");
  assert.equal(addMonths("2024-08-29", 6), "2025-02-28");
  assert.equal(addMonths("2023-08-29", 6), "2024-02-29", "and a leap year is still a leap year");
  assert.equal(addMonths("2026-01-05", 24), "2028-01-05");
});

test("a 24-month window is measured in calendar months, not 730 days", () => {
  const spanning = takeback({ originalPaidAt: "2024-02-29", recoupedAt: "2026-02-28" });
  assert.equal(
    assessRecoupment(spanning, NY_RECOUP).refusedBecause,
    "within-the-recoupment-window",
    "2024-02-29 + 24 months is 2026-02-28, and that day is still inside"
  );
  assert.ok(assessRecoupment({ ...spanning, recoupedAt: "2026-03-01" }, NY_RECOUP).finding);
});

// ── Regression: a demand for nothing is still a demand ──────────────────────────────────────────

test("interest that rounds to zero cents raises no finding at all", () => {
  /**
   * Found by probing the arithmetic rather than by a failing test. Simple interest on a small
   * principal over a few days rounds to zero: a $5.00 claim one day late earns 0.16 of a cent. The
   * engine raised a finding anyway, stating that the payer owed $0.00 — a worklist row telling a
   * biller to write to a payer about nothing, and a savings report counting an opportunity worth
   * nothing.
   *
   * New Jersey is the case that matters: it writes NO de minimis floor, so nothing else was
   * stopping it. Oregon's $2.00 floor happened to cover this by accident, which is exactly why the
   * check has to be separate — the accident does not hold anywhere else.
   */
  for (const principal of [cents(0.01), cents(1), cents(5)]) {
    const { finding, refusedBecause } = assessPromptPay(
      paid({ paidCents: principal, submittedAt: "2026-06-01", paidAt: "2026-07-02" }),
      NJ
    );
    assert.equal(finding, null, `$${(principal / 100).toFixed(2)} one day late must raise nothing`);
    assert.equal(refusedBecause, "interest-rounds-to-nothing");
  }
});

test("the smallest amount that IS owed is still reported", () => {
  // The boundary the fix must not overshoot: one cent of real interest is a real, if small, claim.
  const { finding } = assessPromptPay(
    paid({ paidCents: cents(35), submittedAt: "2026-06-01", paidAt: "2026-07-02" }),
    NJ
  );
  assert.equal(finding!.interestCents, cents(0.01));
});

test("a rounded-to-zero refusal is distinct from a statutory floor", () => {
  /**
   * Two different facts that must not be conflated. Oregon's $2.00 floor is what ORS 743B.452 says;
   * rounding to nothing is arithmetic that is true in every state. A reader of the refusal needs to
   * know which one happened, because only one of them is a statement about the law.
   */
  const tiny = paid({ paidCents: cents(5), submittedAt: "2026-06-01", paidAt: "2026-07-02" });
  assert.equal(assessPromptPay(tiny, OR).refusedBecause, "interest-rounds-to-nothing");

  const under = paid({ paidCents: cents(120), submittedAt: "2026-06-01", paidAt: "2026-07-21" });
  assert.equal(assessPromptPay(under, OR).refusedBecause, "below-the-statutory-minimum");
});

// ── The claim the payer never answered at all ───────────────────────────────────────────────────

test("a claim past the pay-or-deny deadline with no answer is a finding with NO amount", () => {
  /**
   * Every verified statute requires the payer to pay OR DENY within the window, so an unanswered
   * claim past it is already late. It produces no remittance, which is why the remittance-driven
   * half of F5 could never see it — the most expensive prompt-pay case was the invisible one.
   */
  const { finding, refusedBecause } = assessUnpaidDeadline(
    { elapsedDays: 60, submissionChannel: "electronic", expectedInsurancePays: cents(900) },
    NJ
  );
  assert.equal(refusedBecause, null);
  assert.equal(finding!.kind, "prompt-pay-deadline-passed");
  assert.equal(finding!.allowedDays, 30);
  assert.equal(finding!.daysPastDeadline, 30);
  assert.equal(finding!.estimatedExposure, cents(900));
  assert.match(finding!.action, /neither paid nor denied/);
  assert.match(finding!.action, /no amount is claimed here/);
});

test("the exposure is never presented as interest owed", () => {
  /**
   * The line this whole feature is built on. Interest accrues on the amount ultimately PAID, and on
   * an unanswered claim nobody knows that amount — the payer has not said what it will allow. A
   * finding that put the practice's own estimate where a principal goes would be inventing the one
   * figure the demand rests on.
   */
  const { finding } = assessUnpaidDeadline(
    { elapsedDays: 90, submissionChannel: "electronic", expectedInsurancePays: cents(900) },
    NJ
  );
  assert.ok(!("interestCents" in finding!), "a deadline finding must carry no interest figure at all");
  assert.ok(!("principal" in finding!), "and no principal, because there is not one yet");

  const stored = toStored(finding!, {
    remittanceId: "11111111-2222-4333-8444-555555555555",
    subject: "MRM-000123",
    payerId: null,
    payerName: "Delta Dental",
    state: "NJ",
    detectedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(stored.claimedCents, 0, "stored as an alert, not as money — the database refuses anything else");
  assert.equal(stored.recoveredCents, 0);
  assert.equal(stored.evidence.estimatedExposure, cents(900), "the exposure survives, under a name that says whose estimate it is");
});

test("a deadline alert is counted, never totalled, in the savings report", () => {
  // Adding an estimate to measured interest would report one number the practice cannot defend.
  const deadline = toStored(
    assessUnpaidDeadline({ elapsedDays: 60, submissionChannel: "electronic", expectedInsurancePays: cents(900) }, NJ).finding!,
    { remittanceId: "r1", subject: "A", payerId: null, payerName: "P", state: "NJ", detectedAt: "2026-09-16T00:00:00.000Z" }
  );
  const savings = foldSavings([deadline]);
  assert.equal(savings.deadlinesPassed.findings, 1);
  assert.equal(savings.promptPay.claimedCents, 0, "it is not prompt-pay interest and must not be summed as any");
  assert.equal(savings.recoupment.claimedCents, 0);
});

test("a claim still inside the window, and a state with no rule, raise nothing", () => {
  assert.equal(
    assessUnpaidDeadline({ elapsedDays: 30, submissionChannel: "electronic", expectedInsurancePays: cents(900) }, NJ)
      .refusedBecause,
    "paid-within-the-statutory-window",
    "day 30 is the last allowed day, not the first late one"
  );
  assert.equal(
    assessUnpaidDeadline({ elapsedDays: 31, submissionChannel: "electronic", expectedInsurancePays: cents(900) }, NJ)
      .finding!.daysPastDeadline,
    1
  );
  assert.equal(
    assessUnpaidDeadline({ elapsedDays: 400, submissionChannel: "electronic", expectedInsurancePays: cents(900) }, null)
      .refusedBecause,
    "no-rule-for-state",
    "an unverified state stays silent however late the claim is"
  );
});
