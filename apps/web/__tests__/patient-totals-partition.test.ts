/**
 * Cash and the recovery workflow are two different columns (F-9).
 *
 * ── THE TWO MISTAKES THIS REPLACES ─────────────────────────────────────────────────────────────
 * `totals.recovered` sat between `denied` and `chargedToPatient`, in a block of figures that
 * otherwise all describe money that has moved.
 *
 * Before F-2 it was written the moment a person recorded a won appeal, so the patient record
 * reported $1,125.00 "recovered" beside $21.49 actually collected. An owner reading that column
 * would reasonably conclude the money had arrived.
 *
 * F-2 made it cash, which fixed the lie and left a subtler one: recovered cash arrives as a posting,
 * so it is already inside `paidByPayers`. Two overlapping figures side by side in a column that
 * otherwise adds up invites exactly the addition that counts them twice.
 *
 * These tests pin both halves — that no workflow figure sits among the cash, and that the recovery
 * figures partition the money rather than overlapping it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildTotals } from "../patient-record.ts";

/** Jack's audited claim: billed $1,425.00, payer paid $21.49, $1,125.00 denied under CO-197. */
const claim = (over: Record<string, unknown> = {}) =>
  ({
    id: "claim-1",
    status: "partially_paid",
    totalFee: cents(1425),
    expectedInsurancePays: cents(175),
    paidAmount: cents(21.49),
    outstanding: cents(153.51),
    ...over,
  }) as never;

const denial = (over: Record<string, unknown> = {}) =>
  ({
    id: "den-1",
    status: "triaged",
    deniedAmount: cents(1125),
    awardedAmount: null,
    awardSettledAmount: null,
    awardOutstanding: 0,
    recoveredAmount: null,
    ...over,
  }) as never;

const ledger = { account: { charged: cents(136.01), paid: 0, forgiven: 0, balance: cents(136.01) } } as never;

// ── Nothing about the workflow sits among the cash ────────────────────────────────────────────

test("the cash block holds only figures describing money that has moved", () => {
  /**
   * `recovery` and `quote` are both excluded, for the same reason and not as exceptions to the rule.
   * Recovery is a WORKFLOW state — money disputed, agreed, arrived. Quote accuracy is a MEASUREMENT
   * of what a patient was told against what they were charged; no money moves because a quote was
   * wrong. Mixing either into the cash block is precisely the defect this test exists to catch,
   * which is why the guard below names them rather than widening the list.
   */
  const totals = buildTotals([claim()], [denial()], ledger);
  const cashKeys = Object.keys(totals).filter((k) => k !== "recovery" && k !== "quote");
  assert.deepEqual(cashKeys.sort(), [
    "balance",
    "billed",
    "chargedToPatient",
    /**
     * `coordinationPending` belongs here, beside `outstandingFromPayers`, and the distinction is
     * worth stating because it is the one this test polices.
     *
     * The block is not "money that has already arrived" — `expectedFromPayers` and
     * `outstandingFromPayers` are both money that has not moved. It is the patient's CASH POSITION:
     * what was billed, what came in, what is still expected, and what is left. Coordinated money is
     * expected money whose payer is simply a different one, so it sits with its siblings.
     *
     * `recovery` and `quote` remain excluded because they are not cash positions at all — one is a
     * dispute's workflow state, the other a measurement of a quote's accuracy.
     */
    "coordinationPending",
    "expectedFromPayers",
    "forgiven",
    "outstandingFromPayers",
    "paidByPatient",
    "paidByPayers",
  ]);
  assert.ok(!("recovered" in totals), "a workflow figure among the cash is the defect");
  assert.ok(!("denied" in totals), "and so is a disputed one");
  assert.ok(!("quoted" in totals), "and so is a measurement of what somebody was told");
  assert.ok(!("variance" in totals), "which has not moved a cent either way");
});

test("quote accuracy is its own block, and only counts claims the payer has ruled on", () => {
  /**
   * A claim still in flight has a quote and no answer. Counting it would report every unfiled claim
   * as a variance the size of its own estimate — unknown is not a discrepancy.
   */
  const unruled = buildTotals([claim({ status: "submitted" })], [denial()], ledger);
  assert.equal(unruled.quote.claims, 0, "nothing to compare until the payer answers");
  assert.equal(unruled.quote.variance, 0);
});

test("a claim still awaiting a SECOND plan is not a quote error", () => {
  /**
   * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────────
   * A coordinated claim IS adjudicated — the primary ruled — but it states
   * `patientResponsibility: 0` because a second plan has not. Counting it recorded the entire quote
   * as error: Kira Demo's record read "quoted $625.00 … the payer assigned them $0.00 — $625.00
   * less than they were told. The estimate was cautious; the balance is lower than promised."
   *
   * Nothing about that is true. It is an unanswered question scored as a perfect outcome, printed
   * directly beneath a warning not to quote the patient anything yet — two adjacent sentences
   * contradicting each other, and the reassuring one is the one a person acts on.
   */
  const pending = buildTotals(
    [claim({ status: "partially_paid", expectedPatientPays: cents(625), patientResponsibility: cents(0), coordinationPending: cents(482.51) })],
    [denial()],
    ledger
  );
  assert.equal(pending.quote.claims, 0, "a plan is still deciding — there is nothing to compare");
  assert.equal(pending.quote.variance, 0);
  assert.equal(pending.coordinationPending, cents(482.51), "but the money is still reported");
});

test("the same claim rejoins the measurement once the secondary has ruled", () => {
  /**
   * Excluded while pending, not excluded forever. The comparison becomes possible the moment the
   * coordination clears, and that is exactly when it becomes worth making.
   */
  const settled = buildTotals(
    [claim({ status: "paid", expectedPatientPays: cents(625), patientResponsibility: cents(482.51), coordinationPending: 0 })],
    [denial()],
    ledger
  );
  assert.equal(settled.quote.claims, 1);
  assert.equal(settled.quote.quoted, cents(625));
  assert.equal(settled.quote.assigned, cents(482.51));
  assert.equal(settled.quote.variance, cents(-142.49), "quoted more than the payer assigned");
});

// ── The three recovery states partition the money ─────────────────────────────────────────────

test("a disputed denial is denied, and nothing else", () => {
  const t = buildTotals([claim()], [denial({ status: "triaged" })], ledger);
  assert.equal(t.recovery.denied, cents(1125));
  assert.equal(t.recovery.awarded, 0);
  assert.equal(t.recovery.awardOutstanding, 0);
  assert.equal(t.recovery.recoveredCash, 0);
});

test("a won appeal moves out of `denied` and into the receivable — never both", () => {
  /**
   * The money is no longer disputed once the payer agrees; it is owed. Leaving it in `denied` while
   * also reporting it outstanding would show the practice chasing the same dollar twice.
   */
  const t = buildTotals(
    [claim()],
    [denial({ status: "awaiting_payment", awardedAmount: cents(1125), awardSettledAmount: 0, awardOutstanding: cents(1125) })],
    ledger
  );
  assert.equal(t.recovery.denied, 0, "not disputed any more");
  assert.equal(t.recovery.awarded, cents(1125));
  assert.equal(t.recovery.awardOutstanding, cents(1125));
  assert.equal(t.recovery.recoveredCash, 0, "and none of it has arrived");
});

test("winning an appeal moves no cash figure at all", () => {
  const before = buildTotals([claim()], [denial({ status: "appealed" })], ledger);
  const after = buildTotals(
    [claim()],
    [denial({ status: "awaiting_payment", awardedAmount: cents(1125), awardSettledAmount: 0, awardOutstanding: cents(1125) })],
    ledger
  );
  assert.equal(after.paidByPayers, before.paidByPayers, "$21.49 either way");
  assert.equal(after.balance, before.balance);
  assert.equal(after.chargedToPatient, before.chargedToPatient);
});

test("a settled award is cash, and is reported as a subset rather than an addition", () => {
  /**
   * The corrected remittance paid $1,125.00, so the claim's own `paidAmount` is $1,146.49 — the
   * award cash is inside it. `recoveredCash` states the same money for the recovery story; adding
   * the two would report $2,271.49 on a $1,425.00 claim.
   */
  const t = buildTotals(
    [claim({ status: "paid", paidAmount: cents(1146.49), outstanding: 0 })],
    [denial({ status: "recovered", awardedAmount: cents(1125), awardSettledAmount: cents(1125), awardOutstanding: 0 })],
    ledger
  );
  assert.equal(t.paidByPayers, cents(1146.49));
  assert.equal(t.recovery.recoveredCash, cents(1125));
  assert.ok(t.recovery.recoveredCash <= t.paidByPayers, "a subset, never an addition");
  assert.equal(t.recovery.denied, 0);
  assert.equal(t.recovery.awardOutstanding, 0, "nothing left owed");
});

test("a partial settlement splits between arrived and still owed, and they sum to the award", () => {
  const t = buildTotals(
    [claim()],
    [denial({ status: "partially_recovered", awardedAmount: cents(1125), awardSettledAmount: cents(800), awardOutstanding: cents(325) })],
    ledger
  );
  assert.equal(t.recovery.recoveredCash, cents(800));
  assert.equal(t.recovery.awardOutstanding, cents(325));
  assert.equal(
    t.recovery.recoveredCash + t.recovery.awardOutstanding,
    t.recovery.awarded,
    "800.00 + 325.00 = 1125.00"
  );
});

test("a written-off denial is neither disputed nor owed nor recovered", () => {
  const t = buildTotals([claim()], [denial({ status: "written_off" })], ledger);
  assert.equal(t.recovery.denied, 0, "it has an owner now — the practice absorbed it");
  assert.equal(t.recovery.awardOutstanding, 0);
  assert.equal(t.recovery.recoveredCash, 0);
});

test("the three states never overlap, across a mixed set of denials", () => {
  const t = buildTotals(
    [claim()],
    [
      denial({ id: "a", status: "triaged", deniedAmount: cents(500) }),
      denial({ id: "b", status: "awaiting_payment", deniedAmount: cents(300), awardedAmount: cents(300), awardSettledAmount: 0, awardOutstanding: cents(300) }),
      denial({ id: "c", status: "recovered", deniedAmount: cents(200), awardedAmount: cents(200), awardSettledAmount: cents(200), awardOutstanding: 0 }),
    ],
    ledger
  );
  assert.equal(t.recovery.denied, cents(500), "only the disputed one");
  assert.equal(t.recovery.awardOutstanding, cents(300), "only the agreed-and-unpaid one");
  assert.equal(t.recovery.recoveredCash, cents(200), "only the arrived one");
  assert.equal(
    t.recovery.denied + t.recovery.awardOutstanding + t.recovery.recoveredCash,
    cents(1000),
    "each dollar in exactly one state"
  );
});

// ── What the patient was told, against what they were charged ─────────────────────────────────

/**
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * `expectedPatientPays` was stored, displayed and scrub-validated, and never once compared against
 * what the person actually owed. F-7 built this comparison for the PAYER side and its own message
 * tells a biller to "check what they were told before billing the difference" — with no way to
 * check. The figure sat on a verification from three weeks ago.
 *
 * The patient side matters more, for a reason unrelated to the amounts. An insurance variance is a
 * practice problem: chase the payer. A quote variance is a trust problem: somebody was given a
 * number, decided about their care with it, and got a different bill.
 */
test("a patient quoted less than the payer assigned is reported, with the direction", () => {
  /** Quoted $500.00, payer assigned $625.00 — the patient owes $125.00 more than they were told. */
  const t = buildTotals(
    [claim({ status: "paid", expectedPatientPays: cents(500), patientResponsibility: cents(625) })],
    [denial()],
    ledger
  );
  assert.equal(t.quote.quoted, cents(500));
  assert.equal(t.quote.assigned, cents(625));
  assert.equal(t.quote.variance, cents(125), "positive means they owe MORE than they were told");
  assert.equal(t.quote.claims, 1);
});

test("a patient quoted more than the payer assigned reports the other direction", () => {
  const t = buildTotals(
    [claim({ status: "paid", expectedPatientPays: cents(700), patientResponsibility: cents(625) })],
    [denial()],
    ledger
  );
  assert.equal(t.quote.variance, cents(-75), "a cautious estimate, not a surprise");
});

test("an accurate quote reports no variance at all", () => {
  const t = buildTotals(
    [claim({ status: "paid", expectedPatientPays: cents(625), patientResponsibility: cents(625) })],
    [denial()],
    ledger
  );
  assert.equal(t.quote.variance, 0);
  assert.equal(t.quote.claims, 1, "and it still counts as compared — zero is an answer");
});

test("several adjudicated claims are compared together", () => {
  const t = buildTotals(
    [
      claim({ id: "c1", status: "paid", expectedPatientPays: cents(500), patientResponsibility: cents(625) }),
      claim({ id: "c2", status: "denied", expectedPatientPays: cents(100), patientResponsibility: cents(90) }),
      claim({ id: "c3", status: "submitted", expectedPatientPays: cents(999), patientResponsibility: 0 }),
    ],
    [denial()],
    ledger
  );
  assert.equal(t.quote.claims, 2, "the unadjudicated claim is not compared");
  assert.equal(t.quote.quoted, cents(600), "500.00 + 100.00 — the in-flight 999.00 is excluded");
  assert.equal(t.quote.assigned, cents(715));
  assert.equal(t.quote.variance, cents(115));
});

test("a voided claim is excluded, like everywhere else in these totals", () => {
  const t = buildTotals(
    [claim({ status: "void", expectedPatientPays: cents(500), patientResponsibility: cents(625) })],
    [denial()],
    ledger
  );
  assert.equal(t.quote.claims, 0);
});
