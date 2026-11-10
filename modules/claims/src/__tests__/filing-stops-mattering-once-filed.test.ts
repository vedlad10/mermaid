/**
 * A filing deadline is a risk until the payer has the claim, and history afterwards.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `filingStatus` is arithmetic on a date and nothing else — it has no idea whether the claim was
 * ever filed. Every screen read it directly, so a claim submitted and PAID a year ago reported
 * `risk: "expired"`, and the UI rendered a red "expired" badge in the worklist and an expired
 * countdown gauge on the claim's own screen.
 *
 * That is the worst kind of severity indicator: loud, permanent, and about nothing. Staff learn
 * that red means "a date went by" rather than "you are about to lose this money", and then the
 * badge fails on the claims where it is real.
 *
 * `filingMatters` is the missing question — is this still the practice's problem? — asked once, in
 * the module that owns claim status, so the list and the detail screen cannot disagree about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimListItem, filingMatters } from "../view.ts";
import type { Claim, ClaimStatus } from "../types.ts";

/** A deadline that has comfortably passed, so `filingStatus` reports `expired` for every case. */
const LONG_PAST = "2020-01-01";
const NOW = new Date("2026-09-01T00:00:00.000Z");

const claim = (status: ClaimStatus): Claim =>
  ({
    id: `claim-${status}`,
    status,
    totalFee: cents(1425),
    expectedInsurancePays: cents(800),
    expectedPatientPays: cents(625),
    payments: [],
    lines: [],
    audit: [],
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
    payer: { id: "delta-dental", name: "Delta Dental", payerName: "Delta Dental" },
    serviceDate: "2019-06-01",
    createdAt: "2019-06-01T00:00:00.000Z",
    updatedAt: "2019-06-01T00:00:00.000Z",
    filingDeadline: LONG_PAST,
    verificationId: "ver-1",
    scrub: null,
    submission: null,
    voidReason: null,
    coverageSnapshot: { snapshot_version: 1, verifiedAt: "2019-06-01T00:00:00.000Z" },
  }) as unknown as Claim;

test("filing matters only while getting the claim to the payer is still the practice's job", () => {
  for (const status of ["draft", "ready", "rejected"] as ClaimStatus[]) {
    assert.equal(filingMatters(claim(status)), true, `${status}: the window is still live`);
  }
  for (const status of ["submitted", "partially_paid", "paid", "denied", "void"] as ClaimStatus[]) {
    assert.equal(filingMatters(claim(status)), false, `${status}: the payer already has it`);
  }
});

test("a paid claim still carries an expired deadline, and says filing no longer matters", () => {
  /**
   * Both halves. The DATE has genuinely passed and the view must not lie about that — the deadline
   * is still on the record. What changes is whether it is presented as a live risk.
   */
  const item = buildClaimListItem(claim("paid"), NOW);
  assert.equal(item.filingRisk, "expired", "the arithmetic is unchanged and still honest");
  assert.equal(item.filingMatters, false, "but it is history, not a countdown");
});

test("a ready claim past its deadline is still a live risk", () => {
  /**
   * The case the badge exists for, and the one that must keep working: an unfiled claim whose
   * window has closed is money about to be lost.
   */
  const item = buildClaimListItem(claim("ready"), NOW);
  assert.equal(item.filingRisk, "expired");
  assert.equal(item.filingMatters, true);
});

test("a rejected claim keeps its countdown — it must be corrected inside the same window", () => {
  /**
   * Rejection is refusal at intake, not adjudication. The clock never stopped, and treating it as
   * filed would silence the warning on exactly the claims that still need refiling.
   */
  assert.equal(filingMatters(claim("rejected")), true);
});

test("the list row carries the coordinated amount, so a COB claim is not a silent row", () => {
  /**
   * A coordinated claim has no denial and no material shortfall, so every badge branch was empty
   * and the worklist said nothing about the largest number on the claim.
   */
  const c = claim("partially_paid");
  const withCob = {
    ...c,
    payments: [
      {
        postingId: "p1",
        remittanceId: "r1",
        postedAt: "2026-08-28T00:00:00.000Z",
        traceNumber: "T1",
        paidAmount: cents(799.99),
        patientResponsibility: cents(0),
        contractualAdjustments: cents(142.5),
        coordinationAmount: cents(482.51),
        restatesPatientResponsibility: false,
        variance: cents(-0.01),
        outcome: "as_expected",
        settled: false,
      },
    ],
  } as unknown as Claim;

  assert.equal(buildClaimListItem(withCob, NOW).coordinationPending, cents(482.51));
  assert.equal(buildClaimListItem(c, NOW).coordinationPending, cents(0), "and stays zero otherwise");
});
