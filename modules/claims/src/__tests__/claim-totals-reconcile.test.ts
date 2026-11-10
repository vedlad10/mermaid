/**
 * A settled claim's totals must still account for the whole charge.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The claim screen's totals block showed "Patient was quoted" only while `payments` was empty, and
 * swapped it out for "Received" as soon as a payer ruled. So an adjudicated claim read:
 *
 *     Charge $1,425.00 · Expected from insurance $800.00 · Received $799.99
 *
 * and said nothing about the remaining $625.01 — on the one row a biller reconciles from. Both
 * missing figures (the $142.50 the contract took off and the $482.51 assigned to the patient) were
 * already on the screen, in a sentence inside the payments card further down, which is not where
 * anyone adds up a claim. The patient's share disappeared from the summary at exactly the moment it
 * became collectable.
 *
 * ── WHY THE ASSERTION IS AN IDENTITY ───────────────────────────────────────────────────────────
 * Asserting "the view reports $482.51" would pin one fixture. The property that matters is that the
 * three figures the screen now shows ACCOUNT FOR the billed fee, whatever the payer did — so that
 * is what is asserted, and it holds for a plain adjudication, an appeal award, and a
 * re-adjudication alike.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimView, totalContractualAdjustment, totalPatientResponsibility } from "../view.ts";
import type { Claim, ClaimPayment } from "../types.ts";

/** Nora's audited claim: $1,425.00 billed = payer $799.99 + patient $482.51 + contract $142.50. */
const ORIGINAL: ClaimPayment = {
  postingId: "post-1",
  remittanceId: "rem-1",
  postedAt: "2026-08-28T04:40:49.311Z",
  traceNumber: "EFT500096448",
  paidAmount: cents(799.99),
  patientResponsibility: cents(482.51),
  contractualAdjustments: cents(142.5),
  variance: cents(-0.01),
  outcome: "underpaid",
  settled: true,
};

/** A corrected remittance settling an appeal award: money to the practice, silent on the patient. */
const AWARD_SETTLEMENT: ClaimPayment = {
  postingId: "post-2",
  remittanceId: "rem-2",
  postedAt: "2026-10-02T09:00:00.000Z",
  traceNumber: "EFT500099001",
  paidAmount: cents(1125),
  patientResponsibility: cents(0),
  contractualAdjustments: cents(0),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
};

/** A genuine re-adjudication moving the patient's share to zero: it restates the write-off too. */
const REPLACEMENT_ZEROING_PR: ClaimPayment = {
  postingId: "post-3",
  remittanceId: "rem-3",
  postedAt: "2026-10-05T09:00:00.000Z",
  traceNumber: "EFT500099002",
  paidAmount: cents(482.51),
  patientResponsibility: cents(0),
  contractualAdjustments: cents(142.5),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
  /**
   * The payer's own word that this advice re-adjudicated the patient's share. Without it a
   * write-off on a paid line is indistinguishable from an appeal award, and the selector
   * conservatively leaves the earlier balance standing — see patient-responsibility-revisions.
   */
  restatesPatientResponsibility: true,
};

const claim = (payments: ClaimPayment[]): Claim =>
  ({
    id: "claim-1",
    status: payments.length ? "paid" : "submitted",
    totalFee: cents(1425),
    expectedInsurancePays: cents(800),
    expectedPatientPays: cents(625),
    payments,
    lines: [],
    audit: [],
    patient: { firstName: "Nora", lastName: "Demo", dateOfBirth: "1990-01-01" },
    payer: { id: "delta-dental", name: "Delta Dental" },
    serviceDate: "2026-08-28",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    filingDeadline: "2027-08-28",
    verificationId: "ver-1",
    scrub: null,
    submission: null,
    voidReason: null,
  }) as unknown as Claim;

const NOW = new Date("2026-10-06T00:00:00.000Z");

test("the view carries the patient's share and the write-off, not just the payer's half", () => {
  const view = buildClaimView(claim([ORIGINAL]), NOW);
  assert.equal(view.patientResponsibility, cents(482.51), "the figure a biller has to collect");
  assert.equal(view.contractualAdjustment, cents(142.5), "and the one nobody may collect");
});

test("what the screen shows accounts for the whole billed fee", () => {
  /** The identity the totals block exists to display. */
  const c = claim([ORIGINAL]);
  const view = buildClaimView(c, NOW);
  assert.equal(
    view.paidAmount + view.patientResponsibility + view.contractualAdjustment,
    c.totalFee,
    "charge, received, patient and write-off must reconcile on a settled claim"
  );
});

test("an appeal award does not double the write-off or erase the patient's balance", () => {
  /**
   * The award settlement is silent on the patient and states no contractual adjustment. Summing
   * would report $285.00 written off against a charge that only ever lost $142.50; reading the last
   * posting would report that the patient owes nothing. Both are wrong, and both are money.
   */
  const view = buildClaimView(claim([ORIGINAL, AWARD_SETTLEMENT]), NOW);
  assert.equal(view.patientResponsibility, cents(482.51), "the patient's balance survives an award");
  assert.equal(view.contractualAdjustment, cents(142.5), "and the write-off is restated, never added");
});

test("a genuine re-adjudication to zero is honoured on both figures", () => {
  const view = buildClaimView(claim([ORIGINAL, REPLACEMENT_ZEROING_PR]), NOW);
  assert.equal(view.patientResponsibility, cents(0), "the payer really did move the patient's share");
  assert.equal(view.contractualAdjustment, cents(142.5), "the replacement restates the write-off");
});

test("before any payer rules, both figures are zero and the estimate is what the screen shows", () => {
  /**
   * The unadjudicated case must not borrow the estimate into these fields. The screen deliberately
   * shows "Patient was quoted" from the ESTIMATE until a payer has ruled — reporting the quote here
   * would make a quote indistinguishable from an assignment.
   */
  const view = buildClaimView(claim([]), NOW);
  assert.equal(view.patientResponsibility, cents(0));
  assert.equal(view.contractualAdjustment, cents(0));
});

test("the two aggregates always come from the same posting", () => {
  /**
   * They describe one split of one charge. Selecting the patient's share from one advice and the
   * write-off from another would produce a pair that never coexisted, and the totals would stop
   * adding up for a reason nobody could see on the screen.
   */
  for (const payments of [[ORIGINAL], [ORIGINAL, AWARD_SETTLEMENT], [ORIGINAL, REPLACEMENT_ZEROING_PR]]) {
    const c = claim(payments);
    const source = [...payments]
      .reverse()
      .find((p) => p.patientResponsibility > 0 || p.contractualAdjustments > 0)!;
    assert.equal(totalPatientResponsibility(c), source.patientResponsibility);
    assert.equal(totalContractualAdjustment(c), source.contractualAdjustments);
  }
});
