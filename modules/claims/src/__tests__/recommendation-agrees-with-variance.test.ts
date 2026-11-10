/**
 * The line a biller acts on must not contradict the panel below it.
 *
 * ── THE DEFECT, READ OFF THE LIVE SCREEN ───────────────────────────────────────────────────────
 * On Gina Demo, eight inches apart on one claim:
 *
 *   Recommended action   "The payer is done — it settled its share IN FULL ($47.99).
 *                         $1,234.51 was assigned to the patient: bill them…"
 *   Payer vs estimate    "The payer paid $72.01 LESS than the estimate promised…
 *                         the patient was quoted from the estimate, so check what they
 *                         were told before billing the difference."
 *
 * Both statements are true of different things — "in full" describes the payer's OBLIGATION, the
 * panel describes the ESTIMATE — and together they are unreadable. Worse, the top line gave the
 * instruction ("bill them") that the panel below it warns against, and the top line is the one a
 * biller acts on. A patient quoted from an estimate the payer then undercut is precisely the case
 * where billing the difference without checking starts the dispute.
 *
 * ── WHY THE COMPARISON IS NET OF APPEAL RECOVERIES ─────────────────────────────────────────────
 * Judged gross, Jack Demo looks like a $971.49 OVERPAYMENT: estimated $175.00, paid $1,146.49. It
 * is a $1,125.00 appeal win sitting on top of a primary adjudication that came in $153.51 UNDER
 * estimate. The variance engine already judges net for exactly this reason, and a recommendation
 * judged gross would have contradicted the panel in the opposite direction — telling a biller to
 * check for a takeback on money the practice had fought for and won.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import { buildClaimView, claimVariance } from "../view.ts";

/** Through the public view builder, which is what the screen actually renders. */
const recommendedAction = (c: Claim, now: Date): string => buildClaimView(c, now).recommendedAction;
import type { Claim } from "../types.ts";

const BASE = {
  id: "claim-1",
  verificationId: "ver-1",
  status: "paid" as const,
  createdAt: "2026-08-28T04:40:10.051Z",
  updatedAt: "2026-08-28T04:40:14.843Z",
  serviceDate: "2026-08-28",
  filingDeadline: "2027-08-28",
  patient: { firstName: "Test", lastName: "Patient", dateOfBirth: "1990-01-01", memberId: "M1", address: null },
  payer: { payerId: "p1", payerName: "Test Dental", planName: "PPO", groupNumber: null },
  totalFee: cents(1425),
  lines: [],
  audit: [],
  scrub: null,
  submission: null,
  voidReason: null,
  coverageSnapshot: null,
  filingRiskRaised: null,
  expectedPatientPays: cents(0),
};

/**
 * A claim carrying one adjudicating posting. `restatesPatientResponsibility` is what makes the
 * posting the one the totals are selected from — advices restate a split, they never sum.
 */
function claim(opts: {
  expected: number;
  paid: number;
  patient: number;
  appeal?: number;
}): Claim {
  return {
    ...BASE,
    expectedInsurancePays: cents(opts.expected),
    payments: [
      {
        remittanceId: "rem-1",
        postingId: "post-1",
        paidAmount: cents(opts.paid),
        patientResponsibility: cents(opts.patient),
        contractualAdjustment: cents(142.5),
        coordinationPending: cents(0),
        restatesPatientResponsibility: true,
        adjudicatedAt: "2026-08-28T04:40:14.843Z",
        traceNumber: "EFT1",
        outcome: "paid",
        settled: true,
      },
    ],
    appealRecoveries: opts.appeal
      ? [{ denialId: "d1", settledAmount: cents(opts.appeal), settledAt: "2026-08-30T15:02:52.189Z" }]
      : [],
  } as unknown as Claim;
}

const NOW = new Date("2026-09-02T12:00:00Z");

test("an underpaid-vs-estimate claim never says the payer settled IN FULL", () => {
  /** Gina Demo's figures exactly. */
  const c = claim({ expected: 120, paid: 47.99, patient: 1234.51 });
  const action = recommendedAction(c, NOW);

  assert.ok(!/in full/i.test(action), `still claims fullness: ${action}`);
  assert.match(action, /\$72\.01 short/, "it must name the shortfall");
  assert.match(action, /\$120\.00 estimated/, "and what it fell short of");
  assert.match(action, /check what they were told before billing/i, "and carry the panel's warning");
});

test("the recommendation and the variance panel report the SAME shortfall", () => {
  /**
   * The assertion that keeps them from drifting apart again. Both are derived from the claim; this
   * pins that they are derived the same way.
   */
  for (const c of [
    claim({ expected: 120, paid: 47.99, patient: 1234.51 }),
    claim({ expected: 175, paid: 1146.49, patient: 136.01, appeal: 1125 }),
    claim({ expected: 65, paid: 1132.98, patient: 149.52, appeal: 1125 }),
  ]) {
    const v = claimVariance(c, NOW)!;
    const action = recommendedAction(c, NOW);
    if (!v.material) continue;
    const shortfall = Math.abs(v.unexplained);
    const printed = `$${(shortfall / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    assert.ok(
      action.includes(printed),
      `the panel reports ${printed} and the recommendation says: ${action}`
    );
  }
});

test("an appeal win is not read as an overpayment", () => {
  /**
   * Jack Demo. Gross this is +$971.49 and a naive check would tell a biller to look for a duplicate
   * payment or a takeback — about money the practice appealed for and won.
   */
  const c = claim({ expected: 175, paid: 1146.49, patient: 136.01, appeal: 1125 });
  const action = recommendedAction(c, NOW);

  assert.ok(!/overpaid|duplicate|takeback|refund/i.test(action), action);
  assert.match(action, /won on appeal/, "the recovery is named, because it explains the size of the payment");
  assert.match(action, /\$153\.51 short/, "and the real signal — the primary came in under estimate — survives");
});

test("a claim paid as estimated still reads exactly as it always did", () => {
  /**
   * Nils Demo: $800.00 expected, $799.99 paid. One cent of pro-rata rounding is not a variance, and
   * a recommendation that flagged it would be a badge nobody reads.
   */
  const c = claim({ expected: 800, paid: 799.99, patient: 482.51 });
  const action = recommendedAction(c, NOW);

  assert.match(action, /settled its share in full/);
  assert.ok(!/short/.test(action), `a penny of rounding must not be reported as a shortfall: ${action}`);
  assert.match(action, /\$482\.51 was assigned to the patient/);
});

test("a claim with no patient share and a real shortfall says where it went", () => {
  const c = claim({ expected: 800, paid: 600, patient: 0 });
  const action = recommendedAction(c, NOW);

  assert.ok(!/in full/i.test(action));
  assert.match(action, /\$200\.00 short/);
  assert.match(action, /assigned nothing to the patient/);
});
