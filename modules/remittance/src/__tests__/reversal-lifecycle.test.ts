/**
 * What a payer takeback does to the money, from the gate to the recovery queue.
 *
 * ── THE LIFECYCLE, TRACED ────────────────────────────────────────────────────────────────────────
 * A CLP-22 reversal is a payer retracting a payment it already made. `parseAmount` keeps the sign it
 * arrives with, so the claim reaches the engine as a negative payment with negative CAS amounts.
 * From there:
 *
 *   safety gate      `reversal-present` BLOCKER — never auto-posts. Correct, and unchanged.
 *   partition        I5 records both negatives. It does not throw: a held advice's view is built by
 *                    this same path, and a 500 would hide the very finding the hold exists to show.
 *   patient balance  already safe — the ledger applies a SIGNED delta against the payer's latest
 *                    word, so a share reversed to zero credits the patient back rather than
 *                    charging them twice (see patient-ledger/service.ts).
 *   recovery queue   reads only POSTED advices, so a held reversal contributes nothing.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * The last two lines are only true while the advice stays held, and a blocker is OVERRIDABLE by a
 * person with a name and a reason — deliberately, because a retraction is real and somebody has to
 * record it. Overriding it ran the takeback through arithmetic that assumes money flows one way. A
 * $400 reversal on a $1,000 claim produced:
 *
 *     allowed      $1,600   charged minus a NEGATIVE write-off — larger than the bill
 *     unexplained  $2,000   twice the charge, in money the payer was said to have mislaid
 *     outcome      underpaid by $800
 *
 * and `unexplained` feeds `outstandingOf`, so the claim entered the recovery queue for $2,000 that
 * nobody withheld. The practice chases a payer for money it never held, on a claim worth half that.
 *
 * `computeVariance` now refuses to answer when any figure is negative, exactly as it already refuses
 * when there is no expectation, and for the reason stated there: a variance against a baseline that
 * does not exist is a fabricated number, and fabricated shortfalls poison the recovery queue.
 *
 * ── THE EXTERNAL DEPENDENCY, MARKED ──────────────────────────────────────────────────────────────
 * Nothing here reverses anything. Undoing a takeback means identifying WHICH prior posting is being
 * retracted, and an 835 reversal carries no reliable pointer to the advice it retracts — payers
 * identify it by their own control number, out of band, or not at all. That correspondence cannot be
 * established from the file, so the safe behaviour is to record the retraction, compute nothing from
 * it, and leave the matching to the person the hold summons.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, buildPartition, checkPartition } from "@mermaid/shared";
import { computeVariance } from "../engine/variance.ts";
import { checkRemittanceSafety } from "../engine/safety.ts";
import type { RemittanceAdvice } from "@mermaid/edi";
import type { VarianceReason } from "../types.ts";

const CLAIM = "MRM-REVERSAL-1";

const adjustment = (amount: number, category = "contractual", group = "CO", code = "45"): VarianceReason =>
  ({ category, group, code, amount: cents(amount), description: "", procedureCode: null }) as VarianceReason;

/** A payer retracting a $400 payment on a $1,000 claim. */
const takeback = {
  chargedAmount: cents(1000),
  paidAmount: cents(-400),
  patientResponsibility: cents(0),
  adjustments: [adjustment(-600)],
};

/** The same claim adjudicated normally, so the refusal can be shown to be about the sign. */
const ordinary = {
  chargedAmount: cents(1000),
  paidAmount: cents(400),
  patientResponsibility: cents(0),
  adjustments: [adjustment(600)],
};

test("a takeback produces no variance at all — there is no honest baseline to compare against", () => {
  assert.equal(
    computeVariance(takeback, cents(400)),
    null,
    "running a retraction through adjudication arithmetic invents a shortfall that never happened"
  );
});

test("an ordinary claim still adjudicates — the refusal is about the sign, not about everything", () => {
  const v = computeVariance(ordinary, cents(400));
  assert.ok(v, "a well-formed claim must still get an answer");
  assert.equal(v.outcome, "as_expected");
  assert.equal(v.variance, 0);
});

test("an unlabelled negative adjustment is refused too — a takeback without the label", () => {
  /**
   * The CLP-22 gate only catches payers that send a formal retraction. The $200-onto-a-patient bug
   * came from a negative CAS on a claim that was NOT marked as a reversal, and it is the same event
   * without the label — so it gets the same answer, from the sign rather than from the status code.
   */
  const unlabelled = { ...ordinary, adjustments: [adjustment(600), adjustment(-100, "recoverable", "PI", "97")] };
  assert.equal(computeVariance(unlabelled, cents(400)), null);
});

test("the money that WOULD have been fabricated is worth naming", () => {
  /**
   * Not an assertion about behaviour — an assertion about the size of the hazard, so a future reader
   * who is tempted to relax the guard can see what it costs. The partition is still built from the
   * raw figures, because I5 deliberately does not throw; what changed is that nothing downstream
   * reads a variance off it any more.
   */
  const p = buildPartition({
    charged: takeback.chargedAmount,
    payerPaid: takeback.paidAmount,
    contractual: takeback.adjustments[0]!.amount,
    patientResponsibility: cents(0),
  });

  assert.equal(p.allowed, cents(1600), "an allowed amount larger than the charge is the tell");
  assert.equal(p.unexplained, cents(2000), "twice the charge, in money nobody withheld");

  const violations = checkPartition(p);
  assert.ok(
    violations.some((v) => v.invariant === "I5" && /payerPaid is negative/.test(v.detail)),
    "I5 sees it"
  );
  assert.ok(
    violations.some((v) => v.invariant === "I5" && /contractual is negative/.test(v.detail)),
    "and sees both halves of it"
  );
});

test("the gate still refuses to auto-post a reversal, which is the first line of defence", () => {
  const advice = {
    payerName: "Cigna Dental",
    payerId: "cigna-dental",
    traceNumber: "EFT-REVERSAL-1",
    paymentDate: "2026-08-31",
    paymentMethod: "ACH",
    paymentTotal: cents(-400),
    issues: [],
    providerAdjustments: [],
    claims: [
      {
        patientControlNumber: CLAIM,
        payerControlNumber: "998877",
        patientFirstName: "Kira",
        patientLastName: "Demo",
        charged: cents(1000),
        paid: cents(-400),
        patientResponsibility: cents(0),
        disposition: "reversal",
        status: "reversal",
        unbalanced: false,
        lines: [],
        adjustments: [adjustment(-600)],
      },
    ],
  } as unknown as RemittanceAdvice;

  const result = checkRemittanceSafety(advice, new Set([CLAIM]), new Date("2026-08-31T12:00:00Z"));
  assert.equal(result.safeToPost, false, "a retraction is never posted by the machine");
  assert.ok(
    result.findings.some((f) => f.code === "reversal-present" && f.severity === "blocker"),
    result.findings.map((f) => f.code).join(", ")
  );
});
