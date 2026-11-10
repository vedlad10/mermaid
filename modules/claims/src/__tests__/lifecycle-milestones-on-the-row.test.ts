/**
 * The three recorded milestones a claim row now carries, and the one that must not be read naively.
 *
 * ── WHY THESE ARE ON THE ROW AT ALL ────────────────────────────────────────────────────────────
 * A status cannot answer the questions the Claims screen asks. `paid` says nothing about whether the
 * payer took four days or ninety, nor whether the claim was rejected on the way in. Both facts were
 * already on the claim — in `submission` and in `payments` — and neither was reachable without
 * opening every record, so the screen could not compute a clean-claim rate or a median time to
 * adjudication at all.
 *
 * ── THE ONE THAT IS EASY TO GET WRONG ──────────────────────────────────────────────────────────
 * `firstPaidAt` is the EARLIEST posting, not `payments[0]`. Payments are appended in the order
 * remittances arrive, which is normally chronological and is not guaranteed to be: a payer file
 * processed late, or a corrected advice carrying an earlier payment date, lands after a payment it
 * precedes. Reading `[0]` would then report the later date as the moment of adjudication and stretch
 * the practice's median for a claim the payer actually answered on time — a figure a practice reads
 * as its payer's speed, so a quiet inflation of it is worse than an obvious break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimListItem } from "../view.ts";
import type { Claim, ClaimPayment, ClaimSubmission } from "../types.ts";

const NOW = new Date("2026-09-06T00:00:00.000Z");

const payment = (postedAt: string, paid = 100): ClaimPayment =>
  ({
    postingId: `posting-${postedAt}`,
    remittanceId: "rem-1",
    postedAt,
    traceNumber: "TRACE1",
    paidAmount: cents(paid),
    patientResponsibility: cents(0),
    contractualAdjustments: cents(0),
    variance: null,
    outcome: "paid",
    settled: true,
  }) as unknown as ClaimPayment;

const submission = (outcome: "accepted" | "rejected"): ClaimSubmission =>
  ({
    submittedAt: "2026-08-01T09:00:00.000Z",
    submittedBy: "morgan@clinic.example",
    patientControlNumber: "MRM-1",
    controlNumber: "CH-1",
    outcome,
    statusCategory: null,
    statusCode: null,
    message: "",
    lineErrors: [],
  }) as unknown as ClaimSubmission;

const claim = (over: Partial<Claim> = {}): Claim =>
  ({
    id: "claim-1",
    status: "paid",
    totalFee: cents(1425),
    expectedInsurancePays: cents(800),
    expectedPatientPays: cents(625),
    payments: [],
    lines: [],
    audit: [],
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
    payer: { id: "delta-dental", name: "Delta Dental", payerName: "Delta Dental" },
    serviceDate: "2026-07-20",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    filingDeadline: "2027-07-20",
    verificationId: "ver-1",
    scrub: null,
    submission: null,
    voidReason: null,
    coverageSnapshot: { snapshot_version: 1, verifiedAt: "2026-07-20T00:00:00.000Z" },
    ...over,
  }) as unknown as Claim;

test("a claim that has not moved carries nulls, not zeroes", () => {
  const row = buildClaimListItem(claim(), NOW);
  assert.equal(row.submittedAt, null, "never released");
  assert.equal(row.submissionOutcome, null, "so the payer's intake never answered");
  assert.equal(row.firstPaidAt, null, "and nothing was ever paid");
  /*
   * The distinction is the point. A consumer that treated a missing `submittedAt` as the epoch would
   * report a twenty-thousand-day-old claim; every consumer is written to skip rather than substitute,
   * and null is what makes that possible.
   */
  assert.equal(row.updatedAt, "2026-08-14T00:00:00.000Z", "but it does say when it last changed");
});

test("the milestones are read straight off the claim once they exist", () => {
  const row = buildClaimListItem(
    claim({ submission: submission("accepted"), payments: [payment("2026-08-14T12:00:00.000Z")] }),
    NOW
  );
  assert.equal(row.submittedAt, "2026-08-01T09:00:00.000Z");
  assert.equal(row.submissionOutcome, "accepted");
  assert.equal(row.firstPaidAt, "2026-08-14T12:00:00.000Z");
});

test("a rejection at the payer's intake is reported as such, not hidden behind the claim status", () => {
  const row = buildClaimListItem(claim({ status: "rejected", submission: submission("rejected") }), NOW);
  assert.equal(row.submissionOutcome, "rejected", "the clean-claim rate is computed from this");
});

test("firstPaidAt is the EARLIEST posting even when a later-arriving advice pays an earlier date", () => {
  /**
   * The real sequence this guards. A claim is paid on 14 August. Weeks later the payer sends a
   * corrected advice whose payment date is 2 August — earlier than the first, and appended second
   * because that is when it arrived.
   *
   * `payments[0]` would answer "14 August" and put the payer's response time at 13 days. The claim
   * was actually answered in 1.
   */
  const row = buildClaimListItem(
    claim({
      submission: submission("accepted"),
      payments: [payment("2026-08-14T12:00:00.000Z"), payment("2026-08-02T08:00:00.000Z", 20)],
    }),
    NOW
  );
  assert.equal(
    row.firstPaidAt,
    "2026-08-02T08:00:00.000Z",
    "the moment the payer stopped deliberating, not the order the files landed in"
  );
});

test("an appeal settled months later does not become the claim's adjudication date", () => {
  /**
   * The other direction, and the more common one: a claim paid in August, topped up by a won appeal
   * in November. Taking the LAST posting would report the appeal's duration as the payer's, and
   * inflate the practice's own median every single time it wins one.
   */
  const row = buildClaimListItem(
    claim({
      submission: submission("accepted"),
      payments: [payment("2026-08-14T12:00:00.000Z"), payment("2026-11-30T12:00:00.000Z", 400)],
    }),
    NOW
  );
  assert.equal(row.firstPaidAt, "2026-08-14T12:00:00.000Z");
});

test("an unparseable payment timestamp is skipped rather than ranked as NaN", () => {
  /**
   * `Date.parse` of a malformed value is NaN, and every comparison against NaN is false — so a
   * naive minimum would either return the bad value or return nothing at all depending on where it
   * sat in the list. Neither is acceptable when a real payment exists beside it.
   */
  const row = buildClaimListItem(
    claim({
      submission: submission("accepted"),
      payments: [payment("not-a-date"), payment("2026-08-14T12:00:00.000Z")],
    }),
    NOW
  );
  assert.equal(row.firstPaidAt, "2026-08-14T12:00:00.000Z", "the real payment still wins");
});

test("timestamps are compared as instants, so a zone offset does not sort into the wrong place", () => {
  /**
   * `"2026-08-14T12:00:00.000Z"` and `"2026-08-14T09:00:00.000+05:30"` are 03:30 and 12:00 UTC — the
   * offset value is EARLIER. Compared as strings, "2026-08-14T09..." also sorts first by luck; the
   * case that breaks string comparison is the opposite one below, where the later instant sorts
   * first lexically.
   */
  const row = buildClaimListItem(
    claim({
      submission: submission("accepted"),
      /* 02:00 UTC, written with an offset — lexically LATER than the 06:00Z beside it. */
      payments: [payment("2026-08-14T06:00:00.000Z"), payment("2026-08-14T07:30:00.000+05:30", 30)],
    }),
    NOW
  );
  assert.equal(
    row.firstPaidAt,
    "2026-08-14T07:30:00.000+05:30",
    "02:00 UTC precedes 06:00 UTC, however the two strings happen to sort"
  );
});
