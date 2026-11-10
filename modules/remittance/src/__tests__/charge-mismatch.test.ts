/**
 * The payer's stated charge, against the charge the practice actually filed.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Every balance check in the safety gate asks whether an advice agrees with ITSELF: paid plus
 * adjustments must equal its charge, no bucket may exceed it, CLP05 must match the PR total. All of
 * them pass on a file whose charge is simply wrong.
 *
 * Ingested against the deployed build: an advice claiming $999,999.99 charged and $999,999.99 paid,
 * on a claim the practice filed for $1,425.00. Charge equals payment and there are no adjustments,
 * so it balances perfectly — and it POSTED. The variance machinery then recorded a $999,934.99
 * overpayment, but only after the cash was booked. A practice's collections figure would have
 * carried a million dollars it never received until somebody read the flag.
 *
 * ── WHY THE CHECK IS ONE-SIDED ───────────────────────────────────────────────────────────────────
 * The first version compared the charges in both directions and broke eight award-settlement tests,
 * which is exactly the review this needed. A CORRECTED advice legitimately covers a SUBSET of a
 * claim's lines — an appeal re-adjudicating one crown states that crown's charge, not the whole
 * claim's — so a payer charge smaller than the filed total is ordinary and must stay ordinary.
 *
 * Larger is the direction that cannot be innocent: no adjudication of part of a claim charges more
 * than the practice billed for all of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import { checkRemittanceSafety, type ClaimContext } from "../engine/safety.ts";
import type { RemittanceAdvice } from "@mermaid/edi";

const CLAIM = "MRM-CHARGE-1";
const KNOWN = new Set([CLAIM]);
const NOW = new Date("2026-09-01T12:00:00Z");
const FILED = cents(1425) as Cents;

const advice = (charged: number, paid: number): RemittanceAdvice =>
  ({
    payerName: "MetLife Dental",
    payerId: "metlife",
    traceNumber: "EFT-CHARGE-1",
    paymentDate: "2026-09-01",
    paymentMethod: "ACH",
    paymentTotal: cents(paid),
    issues: [],
    providerAdjustments: [],
    claims: [
      {
        patientControlNumber: CLAIM,
        payerControlNumber: "1",
        patientFirstName: "Charge",
        patientLastName: "Case",
        charged: cents(charged),
        paid: cents(paid),
        patientResponsibility: cents(0),
        unbalanced: false,
        status: "paid",
        disposition: "paid_full",
        lines: [],
        adjustments: [{ category: "contractual", group: "CO", code: "45", amount: cents(charged - paid), description: "", procedureCode: null }],
      },
    ],
  }) as unknown as RemittanceAdvice;

const ctx = (filedCharge?: Cents): Map<string, ClaimContext> =>
  new Map([[CLAIM, { awardOutstanding: 0 as Cents, ...(filedCharge !== undefined ? { filedCharge } : {}) }]]);

const codes = (r: ReturnType<typeof checkRemittanceSafety>) => r.findings.map((f) => f.code);

test("an advice charging far more than the practice filed is blocked", () => {
  const result = checkRemittanceSafety(advice(999999.99, 999999.99), KNOWN, NOW, [], ctx(FILED));

  const finding = result.findings.find((f) => f.code === "charge-mismatch");
  assert.ok(finding, `expected a charge mismatch, got: ${codes(result).join(", ")}`);
  assert.equal(finding.severity, "blocker", "a file that may not be about this claim must not post on its own");
  assert.equal(result.safeToPost, false);
  assert.match(finding.message, /\$999,999\.99/);
  assert.match(finding.message, /\$1,425\.00/, "the practice's own figure has to be in the message to be actionable");
});

test("a corrected advice covering PART of the claim is left alone", () => {
  /**
   * The case that broke the first version of this check. An appeal that re-adjudicates one crown
   * states that crown's charge. Blocking it would hold every award settlement the product exists to
   * collect.
   */
  const result = checkRemittanceSafety(advice(1250, 1125), KNOWN, NOW, [], ctx(FILED));
  assert.ok(
    !codes(result).includes("charge-mismatch"),
    `a partial correction must not be flagged: ${codes(result).join(", ")}`
  );
});

test("an exact match is left alone", () => {
  const result = checkRemittanceSafety(advice(1425, 1282.5), KNOWN, NOW, [], ctx(FILED));
  assert.ok(!codes(result).includes("charge-mismatch"));
});

test("a rounding-sized difference is not a mismatch", () => {
  /** Materiality, so a payer a cent out on a $1,425.00 claim does not stop a real payment. */
  const result = checkRemittanceSafety(advice(1425.01, 1282.5), KNOWN, NOW, [], ctx(FILED));
  assert.ok(
    !codes(result).includes("charge-mismatch"),
    `one cent is rounding, not a mismatch: ${codes(result).join(", ")}`
  );
});

test("a claim with no recorded expectation is not accused of a mismatch", () => {
  /**
   * An unmatched payment already has its own notice explaining that the money is real and will be
   * posted unmatched. Adding a charge mismatch on top would describe a disagreement with a figure
   * that does not exist.
   */
  const result = checkRemittanceSafety(advice(999999.99, 999999.99), new Set(), NOW, [], ctx(undefined));
  assert.ok(!codes(result).includes("charge-mismatch"), codes(result).join(", "));
  assert.ok(codes(result).includes("unmatched-payment"), "the unmatched notice is the right one here");
});
