/**
 * Patient responsibility has exactly one meaning, and every field that states it must agree.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────────────────────
 * An 835 states patient responsibility twice: as a claim total on CLP05, and itemised as PR-group
 * CAS segments. Mermaid read both — the ledger raised the patient's charge from CLP05, the variance
 * engine explained the shortfall from the CAS segments — and never compared them.
 *
 * A real remittance drove them apart. Cora Chen / Cigna, trace EFT861550327:
 *
 *   charged  $1,425.00
 *   paid        $47.99
 *   CAS        $1,234.51 of patient responsibility
 *   CLP05          $0.00
 *
 * The screen said "bill the patient $1,234.51". The ledger, reading CLP05, raised no charge. The
 * recovery queue, seeing no recoverable category, showed nothing. And the recommended action read
 * "Posted. $47.99 received and fully accounted for; nothing outstanding with this payer."
 *
 * $1,234.51 was not pursued from the payer, not billed to the patient, and absent from A/R — under
 * an affirmative all-clear. That is the worst failure shape an RCM product has: silent revenue loss
 * that reports itself as success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCents, cents } from "@mermaid/shared";
import type { RemittanceAdvice, RemittanceClaim } from "@mermaid/edi";
import { checkRemittanceSafety } from "../engine/safety.ts";
import { computeVariance, type PaidClaim } from "../engine/variance.ts";

/**
 * `computeVariance` returns null for an UNKNOWN expectation, which is a state none of these tests
 * describe — every one of them states a figure. Asserted rather than silenced with `!`, so a
 * function that started refusing everything would fail here instead of passing quietly.
 */
const variance = (
  paid: Parameters<typeof computeVariance>[0],
  expected: Parameters<typeof computeVariance>[1]
): NonNullable<ReturnType<typeof computeVariance>> => {
  const v = computeVariance(paid, expected);
  assert.ok(v, "a stated expectation must produce a variance");
  return v;
};


const KNOWN = new Set(["MRM-CORA"]);

function advice(claim: RemittanceClaim): RemittanceAdvice {
  return {
    traceNumber: "EFT861550327",
    payerName: "Cigna Dental",
    payeeName: "MERMAID DEMO DENTAL",
    payeeId: "1234567893",
    payeeIdQualifier: "XX",
    paymentTotal: claim.paid,
    paymentMethod: "ACH",
    paymentDate: "2026-08-10",
    claims: [claim],
    providerAdjustments: [],
    balanced: true,
    issues: [],
  };
}

/** The exact shape that leaked: CAS says the patient owes it, CLP05 says nobody does. */
function contradictoryClaim(): RemittanceClaim {
  return {
    patientControlNumber: "MRM-CORA",
    payerControlNumber: "522481112",
    statusCode: "1",
    disposition: "partial",
    charged: cents(1425),
    paid: cents(47.99),
    patientResponsibility: cents(0), // CLP05 — disagrees with the PR segment below
    patientName: "Cora Chen",
    memberId: "CIG20099",
    lines: [],
    adjustments: [
      { group: "PR", code: "119", description: "Benefit maximum reached", category: "patient", amount: cents(1234.51), procedureCode: null },
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(142.5), procedureCode: null },
    ],
    remarks: [],
    unbalanced: false,
  };
}

test("a claim whose CLP05 contradicts its PR segments is HELD, not posted on a guess", () => {
  const result = checkRemittanceSafety(advice(contradictoryClaim()), KNOWN);

  assert.equal(result.safeToPost, false, "money two fields disagree about must not post");
  const finding = result.findings.find((f) => f.code === "patient-responsibility-mismatch");
  assert.ok(finding, "the mismatch must be named, not merely blocked");
  assert.equal(finding!.severity, "blocker");
  // Both numbers appear, because a human reconciling against the paper EOB needs to know which two
  // figures disagree — "this claim is unbalanced" would send them looking for the wrong thing.
  assert.match(finding!.message, /\$0\.00/);
  assert.match(finding!.message, /\$1,234\.51/);
});

test("the same claim with agreeing figures posts cleanly", () => {
  const claim = { ...contradictoryClaim(), patientResponsibility: cents(1234.51) };
  const result = checkRemittanceSafety(advice(claim), KNOWN);
  assert.equal(result.findings.some((f) => f.code === "patient-responsibility-mismatch"), false);
  assert.equal(result.safeToPost, true);
});

test("a claim with no patient responsibility on either side is not a mismatch", () => {
  const claim: RemittanceClaim = {
    ...contradictoryClaim(),
    patientResponsibility: cents(0),
    adjustments: [
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(1377.01), procedureCode: null },
    ],
  };
  const result = checkRemittanceSafety(advice(claim), KNOWN);
  assert.equal(result.findings.some((f) => f.code === "patient-responsibility-mismatch"), false);
});

test("the money partitions exactly once — nothing is counted twice or lost", () => {
  /**
   * The invariant neither engine asserted. Every dollar of the charge must land in exactly one of
   * paid / contractual / patient / recoverable / informational, and the leftover is `unexplained`.
   * Had this been checked at ingest, both defects would have surfaced on the first remittance.
   */
  const claim = { ...contradictoryClaim(), patientResponsibility: cents(1234.51) };
  const paid: PaidClaim = {
    chargedAmount: claim.charged,
    paidAmount: claim.paid,
    patientResponsibility: claim.patientResponsibility,
    adjustments: claim.adjustments,
  };
  const v = variance(paid, cents(120));

  const partition = addCents(
    v.actualPaid,
    v.contractualAdjustments,
    v.patientResponsibility,
    v.recoverableAmount,
    v.unexplainedAmount
  );
  assert.equal(partition, claim.charged, "paid + contractual + patient + recoverable + unexplained must equal the charge");
  assert.equal(v.unexplainedAmount, 0);
  assert.equal(v.patientResponsibility, cents(1234.51));
});

test("a benefit maximum the PAYER absorbed is recoverable, and never a patient charge", () => {
  // CO-119: the payer is stating the practice eats it. Not billable onward, and not a write-off to
  // accept quietly either — it is money we did not receive, so it belongs in front of a person.
  const claim: RemittanceClaim = {
    ...contradictoryClaim(),
    patientResponsibility: cents(0),
    adjustments: [
      { group: "CO", code: "119", description: "Benefit maximum reached", category: "recoverable", amount: cents(1234.51), procedureCode: null },
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(142.5), procedureCode: null },
    ],
  };
  const paid: PaidClaim = {
    chargedAmount: claim.charged,
    paidAmount: claim.paid,
    patientResponsibility: claim.patientResponsibility,
    adjustments: claim.adjustments,
  };
  const v = variance(paid, cents(120));

  assert.equal(v.patientResponsibility, 0, "a CO adjustment may never be billed to the patient");
  assert.equal(v.recoverableAmount, cents(1234.51));
  assert.equal(v.actionable, true, "money we did not receive and may not bill on must reach a human");
  // And the safety gate agrees with the arithmetic: CLP05 of zero is correct here.
  assert.equal(
    checkRemittanceSafety(advice(claim), KNOWN).findings.some((f) => f.code === "patient-responsibility-mismatch"),
    false
  );
});

// ── Over-attribution ─────────────────────────────────────────────────────────────────────────────

test("a claim accounting for MORE than it was billed is held, not silently clamped", () => {
  /**
   * `computeVariance` derives unexplained money as `max(0, charged − accountedFor)`. When the
   * adjustments and payment together exceed the charge, that clamp erases the excess and the claim
   * reads as perfectly explained — so a duplicated CAS segment on a payer's file becomes an
   * inflated patient charge or an inflated write-off, with nothing on any screen to show for it.
   */
  const claim: RemittanceClaim = {
    ...contradictoryClaim(),
    patientResponsibility: cents(1234.51),
    adjustments: [
      { group: "PR", code: "119", description: "Benefit maximum reached", category: "patient", amount: cents(1234.51), procedureCode: null },
      // The same fee-schedule reduction delivered twice — the shape a duplicated CAS segment takes.
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(142.5), procedureCode: null },
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(142.5), procedureCode: null },
    ],
  };
  const result = checkRemittanceSafety(advice(claim), KNOWN);

  const finding = result.findings.find((f) => f.code === "over-attributed");
  assert.ok(finding, "money attributed beyond the charge must be named");
  assert.equal(finding!.severity, "blocker");
  assert.equal(result.safeToPost, false);
  assert.match(finding!.message, /\$142\.50 more than was billed/);
});

test("a claim accounting for exactly its charge is not over-attributed", () => {
  const claim = { ...contradictoryClaim(), patientResponsibility: cents(1234.51) };
  const result = checkRemittanceSafety(advice(claim), KNOWN);
  assert.equal(result.findings.some((f) => f.code === "over-attributed"), false);
  assert.equal(result.safeToPost, true);
});
