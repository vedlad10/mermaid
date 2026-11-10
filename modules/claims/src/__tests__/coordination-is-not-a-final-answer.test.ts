/**
 * A claim under coordination of benefits is neither finished nor the patient's problem yet.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * Kira Demo's Cigna advice pays $799.99 on a $1,425.00 charge, writes off $142.50 under contract,
 * and assigns $482.51 to a second plan (CARC 23 / `OA`, claim forwarded under CLP02 19). The
 * remittance module modelled all of that correctly — `coordinationAmount: 48251`,
 * `adjudication: "coordination_pending"` — and the patient ledger already refused to bill it.
 *
 * `ClaimPayment` did not carry the field. So the claim recorded the payment and the write-off and
 * dropped the coordination, and its own figures accounted for $942.49 of a $1,425.00 charge while
 * the totals block read "Patient owes $0.00" beside the gap.
 *
 * Two false statements at once, on the screen a biller reconciles from: that the claim is finished,
 * and that the patient owes nothing. The second is the expensive one — a coordinated advice states
 * `patientResponsibility: 0` exactly as a fully covered cleaning does, and the two mean opposite
 * things.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import {
  buildClaimView,
  patientShareIsPending,
  totalCoordinationPending,
  totalPatientResponsibility,
} from "../view.ts";
import type { Claim, ClaimPayment } from "../types.ts";

/** Kira Demo's advice: $1,425.00 = payer $799.99 + contract $142.50 + secondary $482.51. */
const COORDINATED: ClaimPayment = {
  postingId: "post-cob",
  remittanceId: "rem-cob",
  postedAt: "2026-08-28T04:40:14.825Z",
  traceNumber: "EFT-COB-1",
  paidAmount: cents(799.99),
  patientResponsibility: cents(0),
  contractualAdjustments: cents(142.5),
  coordinationAmount: cents(482.51),
  variance: cents(-0.01),
  outcome: "as_expected",
  /** A coordinated advice is deliberately NOT settled — another plan has not ruled. */
  settled: false,
};

/** The secondary finally rules: it pays some and assigns the rest to the patient. */
const SECONDARY_RULED: ClaimPayment = {
  postingId: "post-secondary",
  remittanceId: "rem-secondary",
  postedAt: "2026-09-20T09:00:00.000Z",
  traceNumber: "EFT-SEC-1",
  paidAmount: cents(300),
  patientResponsibility: cents(182.51),
  contractualAdjustments: cents(142.5),
  coordinationAmount: cents(0),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
  /** The payer's own word: this advice re-adjudicated the patient's share. */
  restatesPatientResponsibility: true,
};

/** An ordinary single-payer advice — no secondary anywhere in sight. */
const ORDINARY: ClaimPayment = {
  postingId: "post-plain",
  remittanceId: "rem-plain",
  postedAt: "2026-08-28T04:40:49.311Z",
  traceNumber: "EFT-PLAIN-1",
  paidAmount: cents(799.99),
  patientResponsibility: cents(482.51),
  contractualAdjustments: cents(142.5),
  variance: cents(-0.01),
  outcome: "underpaid",
  settled: true,
};

const claim = (payments: ClaimPayment[]): Claim =>
  ({
    id: "claim-kira",
    status: payments.length ? (payments.some((p) => p.settled) ? "paid" : "partially_paid") : "submitted",
    totalFee: cents(1425),
    expectedInsurancePays: cents(800),
    expectedPatientPays: cents(625),
    payments,
    lines: [],
    audit: [],
    patient: { firstName: "Kira", lastName: "Demo", dateOfBirth: "1990-01-01" },
    payer: { id: "cigna-dental", name: "Cigna Dental" },
    serviceDate: "2026-08-27",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    filingDeadline: "2027-08-27",
    verificationId: "ver-kira",
    scrub: null,
    submission: { controlNumber: "333273831", patientControlNumber: "MRM-BDEDD701FE6B" },
    voidReason: null,
  }) as unknown as Claim;

const NOW = new Date("2026-09-01T00:00:00.000Z");

test("a coordinated claim accounts for every cent of what was billed", () => {
  /**
   * The identity the totals block exists to display, extended to the fourth bucket. Without
   * `coordinationPending` the sum is $942.49 against a $1,425.00 charge.
   */
  const c = claim([COORDINATED]);
  const v = buildClaimView(c, NOW);

  assert.equal(v.coordinationPending, cents(482.51));
  assert.equal(
    v.paidAmount + v.patientResponsibility + v.contractualAdjustment + v.coordinationPending,
    c.totalFee,
    "paid + patient + write-off + with-other-insurance must equal the billed fee"
  );
});

test("the patient's share is flagged as provisional, not reported as zero owed", () => {
  /**
   * The distinction that cannot be inferred from the amount. A coordinated advice and a fully
   * covered cleaning both state `patientResponsibility: 0`; one means "nothing is owed", the other
   * means "nobody knows yet".
   */
  const v = buildClaimView(claim([COORDINATED]), NOW);
  assert.equal(v.patientResponsibility, cents(0));
  assert.equal(v.patientShareIsPending, true, "zero under coordination is not an answer");
});

test("an ordinary claim is never flagged as pending", () => {
  /** The flag must stay rare, or it means nothing. */
  const v = buildClaimView(claim([ORDINARY]), NOW);
  assert.equal(v.coordinationPending, cents(0));
  assert.equal(v.patientShareIsPending, false);
  assert.equal(v.patientResponsibility, cents(482.51), "here $482.51 IS the patient's, and billable");
});

test("once the secondary rules, the coordination clears and the balance becomes real", () => {
  /**
   * The other end of the story, and the reason the aggregate SELECTS rather than sums. The
   * secondary's advice restates the split; adding would leave $482.51 pending forever on a claim
   * that has been fully adjudicated.
   */
  const v = buildClaimView(claim([COORDINATED, SECONDARY_RULED]), NOW);
  assert.equal(v.coordinationPending, cents(0), "no plan is still deciding");
  assert.equal(v.patientShareIsPending, false);
  assert.equal(v.patientResponsibility, cents(182.51), "and now the patient's share is billable");
});

test("the recommended action names the secondary claim, and never an appeal", () => {
  /**
   * The `partially_paid` branch produced: "The payer paid $799.99 of an expected $800.00. $0.01 is
   * still outstanding — check the remittance for the reasons and decide whether to appeal."
   *
   * It reported a penny, said nothing about $482.51, and proposed the wrong instrument: nothing was
   * denied, and the money is collected by filing with the OTHER plan.
   */
  const action = buildClaimView(claim([COORDINATED]), NOW).recommendedAction;

  assert.match(action, /\$482\.51/, "the coordinated amount must be named");
  assert.match(action, /secondary/i, "and the instrument that collects it");
  assert.doesNotMatch(action, /appeal/i, "nothing was denied — an appeal is the wrong instrument");
  assert.doesNotMatch(action, /\$0\.01/, "a penny is not the headline on a $482.51 coordination");
});

test("the coordinated figure is read from the same posting as the patient's share", () => {
  /**
   * They describe one split of one charge. Taking the patient's share from one advice and the
   * coordination from another would produce a pair that never coexisted, and the totals would stop
   * adding up for a reason invisible on the screen.
   */
  for (const payments of [[COORDINATED], [COORDINATED, SECONDARY_RULED]]) {
    const c = claim(payments);
    const source = [...payments]
      .reverse()
      .find((p) => p.patientResponsibility > 0 || p.contractualAdjustments > 0)!;
    assert.equal(totalPatientResponsibility(c), source.patientResponsibility);
    assert.equal(totalCoordinationPending(c), source.coordinationAmount ?? 0);
  }
});

test("a payment recorded before the field existed reads as no coordination", () => {
  /** Additive by design: an older claim must look exactly as it always did. */
  const legacy = { ...ORDINARY } as Record<string, unknown>;
  delete legacy.coordinationAmount;
  const c = claim([legacy as unknown as ClaimPayment]);
  assert.equal(totalCoordinationPending(c), cents(0));
  assert.equal(patientShareIsPending(c), false);
});
