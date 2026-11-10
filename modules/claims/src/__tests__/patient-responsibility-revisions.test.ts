/**
 * What the patient owes when a claim has been adjudicated more than once — cases G and G′ (L-2).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `totalPatientResponsibility` read `payments.at(-1)?.patientResponsibility`. That is correct only
 * while a claim has exactly one posting, which was true of every claim in the system until appeals
 * began producing corrected remittances. A second posting that settles an award states
 * `patientResponsibility: 0` — it pays the practice and re-adjudicates nothing — so `.at(-1)` would
 * report that the patient owes nothing and silently erase a real balance.
 *
 * Summing is worse in the other direction: each advice RESTATES the patient's share rather than
 * adding to it, so two advices each saying $482.51 would bill the patient $965.02.
 *
 * The figure is therefore SELECTED, and a payment that says nothing about the patient leaves the
 * previous answer standing. Every expected value below is derived from the scenario, not read back
 * from the implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimListItem, patientResponsibilityRetracted, totalPatientResponsibility } from "../view.ts";
import type { Claim, ClaimPayment } from "../types.ts";

/** Nora's audited claim: allowed $1,282.50 = payer $799.99 + patient $482.51. */
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

/** A genuine re-adjudication that moves the patient's share to zero: it restates the write-off too. */
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
};

const claim = (payments: ClaimPayment[]): Claim =>
  ({
    id: "claim-1",
    status: "paid",
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
    // Needed only by the whole-view tests at the foot of this file; the rule tests below use the
    // function directly and never touch these.
    filingDeadline: "2027-08-28",
    verificationId: "ver-1",
    scrub: null,
    submission: null,
    voidReason: null,
  }) as unknown as Claim;

/** The rule under test, exercised directly — the surrounding view needs a whole claim this does not. */
const responsibilityOf = (c: Claim): number => totalPatientResponsibility(c);

// ── G. A corrected ERA that says nothing about the patient ────────────────────────────────────

test("G — a single adjudication reports what it adjudicated", () => {
  assert.equal(responsibilityOf(claim([ORIGINAL])), cents(482.51));
});

test("G — an award settlement stating $0 does NOT erase the patient's balance", () => {
  const c = claim([ORIGINAL, AWARD_SETTLEMENT]);
  assert.equal(
    responsibilityOf(c),
    cents(482.51),
    "the second advice paid the practice and re-adjudicated nothing"
  );
  assert.ok(patientResponsibilityRetracted(c), "and it is flagged, because a human must confirm which it was");
});

test("G — the balance is not summed either: two advices are not two debts", () => {
  const c = claim([ORIGINAL, { ...ORIGINAL, postingId: "post-1b", postedAt: "2026-09-01T00:00:00.000Z" }]);
  assert.equal(responsibilityOf(c), cents(482.51), "not 965.02");
});

// ── G′. A genuine re-adjudication to zero ─────────────────────────────────────────────────────

test("G′ — the payer's OWN word decides whether a zero is real", () => {
  /**
   * ── WHY THIS TEST CHANGED ─────────────────────────────────────────────────────────────────────
   * It used to assert that a posting carrying a contractual write-off had therefore re-adjudicated
   * the patient's share, and its own message conceded the doubt: "the distinction is not certain
   * without CLP02". Staging settled the doubt. Pia Phase32's appeal award arrived as
   * `patientResponsibility: 0` with a $125.00 contractual write-off on the line it paid — byte for
   * byte the shape below — and the heuristic erased a real $149.52. The ledger, which consumes the
   * payer's own `restatesPatientResponsibility`, held the balance correctly the whole time.
   *
   * An appeal award and a genuine re-adjudication are NOT distinguishable by content. So the flag
   * decides, and the two cases are now stated separately.
   */
  const restated: ClaimPayment = { ...REPLACEMENT_ZEROING_PR, restatesPatientResponsibility: true };
  const c = claim([ORIGINAL, restated]);
  assert.equal(responsibilityOf(c), cents(0), "the payer said it re-adjudicated the patient's share");
  assert.ok(patientResponsibilityRetracted(c), "still flagged, so a human can confirm the zero");
});

test("G′ — without the payer's word, a balance stands rather than vanishing", () => {
  /**
   * The legacy path, for payments recorded before the flag existed. The codebase's stated
   * preference governs: erring toward "the patient still owes it" is a mistake a person can find
   * and reverse; erasing a balance is not. `patientResponsibilityRetracted` is the escape hatch —
   * it flags exactly this claim for review rather than leaving it silent.
   */
  const c = claim([ORIGINAL, REPLACEMENT_ZEROING_PR]);
  assert.equal(
    responsibilityOf(c),
    ORIGINAL.patientResponsibility,
    "a write-off on a paid line is not a statement about the patient"
  );
  assert.ok(patientResponsibilityRetracted(c), "and it is flagged, so the zero is not simply ignored");
});

test("G′ — a later adjudication wins over an earlier one", () => {
  const revised: ClaimPayment = { ...ORIGINAL, postingId: "post-4", postedAt: "2026-11-01T00:00:00.000Z", patientResponsibility: cents(300) };
  assert.equal(responsibilityOf(claim([ORIGINAL, revised])), cents(300));
  assert.equal(patientResponsibilityRetracted(claim([ORIGINAL, revised])), false, "nothing was retracted");
});

test("no payments at all means nothing has been adjudicated", () => {
  assert.equal(responsibilityOf(claim([])), 0);
  assert.equal(patientResponsibilityRetracted(claim([])), false);
});

// ── The list item must carry the SELECTED figure, not a sum ────────────────────────────────────

/**
 * ── WHY THIS IS ITS OWN TEST ───────────────────────────────────────────────────────────────────
 * Everything above tests `totalPatientResponsibility` directly. `buildClaimListItem` now exposes
 * that figure on the claim list, where the patient record reads it to compare what somebody was
 * quoted against what they were charged — and a caller re-deriving it by summing would silently
 * reintroduce the exact double-bill this file exists to prevent.
 *
 * That is not hypothetical: mutating the list item to sum instead of select passed every test in
 * this repository, including all of the ones above, because they exercise the function and never the
 * caller. The comment on the field warned about precisely this and the warning was not enforced.
 */
test("the claim list reports the patient's CURRENT share, not the sum of every advice", () => {
  /**
   * Two advices, each stating $482.51 as the patient's share — a re-adjudication, not an addition.
   * Summing bills $965.02 for a $482.51 balance.
   */
  const restated: ClaimPayment = { ...ORIGINAL, postingId: "post-9", remittanceId: "rem-9" };
  const item = buildClaimListItem(claim([ORIGINAL, restated]), new Date("2026-11-01T00:00:00Z"));

  assert.equal(
    item.patientResponsibility,
    ORIGINAL.patientResponsibility,
    "each advice restates the share; two of them are not twice the money"
  );
});

test("a later advice that adjudicates nothing leaves the earlier share standing on the list", () => {
  /** The award settlement: it pays the practice and re-adjudicates nothing, so PR is silent, not zero. */
  const item = buildClaimListItem(claim([ORIGINAL, AWARD_SETTLEMENT]), new Date("2026-11-01T00:00:00Z"));
  assert.equal(item.patientResponsibility, ORIGINAL.patientResponsibility, "silence is not a balance of zero");
});

test("a re-adjudication the payer CONFIRMED does reach the list", () => {
  const restated: ClaimPayment = { ...REPLACEMENT_ZEROING_PR, restatesPatientResponsibility: true };
  const item = buildClaimListItem(claim([ORIGINAL, restated]), new Date("2026-11-01T00:00:00Z"));
  assert.equal(item.patientResponsibility, 0, "the payer said so — this one is real");
});

test("an appeal award carrying a write-off does NOT wipe the list figure", () => {
  /**
   * The staging defect, at the list. Pia Phase32 read "Patient owes $0.00" on the claim while the
   * ledger held $149.52 — one fact, two surfaces, only the ledger taught the rule.
   */
  const award: ClaimPayment = {
    ...AWARD_SETTLEMENT,
    contractualAdjustments: cents(125),
    restatesPatientResponsibility: false,
  };
  const item = buildClaimListItem(claim([ORIGINAL, award]), new Date("2026-11-01T00:00:00Z"));
  assert.equal(
    item.patientResponsibility,
    ORIGINAL.patientResponsibility,
    "paying a line carries that line's write-off and says nothing about the patient"
  );
});
