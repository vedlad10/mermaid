/**
 * A negative adjustment moves money onto a person, and nothing was watching.
 *
 * ── THE DEFECT, PROVED THROUGH THE REAL INGEST PATH ────────────────────────────────────────────
 * `@mermaid/shared` states five laws a money partition obeys. I5 is the simplest of them: every
 * amount is a non-negative whole number of cents, because a credit is a DIRECTION and direction
 * lives in which bucket money sits in, never in its sign.
 *
 * Those laws were enforced in `checkPartition`, in its own unit tests, and in `scripts/check-
 * invariants.ts` — and nowhere on the path money actually travels. `computeVariance` calls
 * `buildPartition` and reads `unexplained` off it; it has never called `checkPartition`.
 *
 * The end-to-end proof — the same file through `parse835` and `ingestArtifact` — lives in
 * apps/web/__tests__/negative-adjustment-ingest.test.ts, because only the app layer may know the
 * wiring exists. This file tests the gate itself.
 *
 * The 835 that posted:
 *
 *   CLP*MRM-NEG1*1*1000.00*600.00*500.00      charged 1000, paid 600, patient 500
 *   CAS*CO*45*-100.00                          a contractual write-off, REVERSED
 *   CAS*PR*2*500.00
 *
 * Every published gate passed. 600 + (−100) + 500 = 1000, so the advice BALANCES. CLP05 agrees with
 * the PR total, so the patient-responsibility cross-check passes. CLP02 is not 22, so the reversal
 * gate ignores it. Result: `status: posted`, `holdReason: none`, `findings: []` — auto-posted, and
 * the patient billed $500 where a well-formed advice would have said $300.
 *
 * The negative moved $200 onto a person, silently, with the system reporting everything in order.
 *
 * It breaks I1 as well: `allowed = charged − contractual` = $1,100 against a $1,000 charge.
 *
 * ── WHY THIS IS A BLOCKER AND NOT A NOTICE ─────────────────────────────────────────────────────
 * The soft gates in this engine exist because refusing real money creates a worse reconciliation
 * problem than recording it with a question attached. This is the opposite: the figures are wrong,
 * and the one that is wrong is the one the practice bills a patient from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemittanceAdvice } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { checkRemittanceSafety } from "../engine/safety.ts";

const RECEIVED = new Date("2026-08-10T09:00:00Z");

/**
 * The gate's own verdict, called directly.
 *
 * `RemittanceView` deliberately does not carry the findings — it carries `holdReason`, the sentence
 * a biller reads. Detail assertions therefore belong at the pure boundary, where the finding still
 * has its severity and its remediation.
 */
const verdict = (adjustments: { group: string; code: string; amount: number; category: string }[]) =>
  checkRemittanceSafety(
    {
      payerName: "Delta Dental",
      payerId: "delta-dental",
      traceNumber: "EFT1",
      paymentDate: "2026-08-10",
      paymentMethod: "ACH",
      paymentTotal: cents(600),
      issues: [],
      providerAdjustments: [],
      claims: [
        {
          patientControlNumber: "MRM-NEG1",
          payerControlNumber: "556677889",
          patientFirstName: "Neg",
          patientLastName: "Case",
          charged: cents(1000),
          paid: cents(600),
          patientResponsibility: cents(500),
          contractualAdjustment: cents(-100),
          coordinationPending: cents(0),
          unbalanced: false,
          status: "paid",
          lines: [],
          adjustments,
        },
      ],
    } as unknown as RemittanceAdvice,
    new Set(["MRM-NEG1"]),
    RECEIVED
  );

test("a negative adjustment is a blocker, and names what posting it would do", () => {
  const result = verdict([
    { group: "CO", code: "45", amount: cents(-100), category: "contractual" },
    { group: "PR", code: "2", amount: cents(500), category: "patient" },
  ]);
  const f = result.findings.find((x) => x.code === "negative-adjustment")!;

  assert.ok(f, `no finding: ${JSON.stringify(result.findings.map((x) => x.code))}`);
  assert.equal(result.safeToPost, false, "a blocker must stop the advice posting on its own");
  assert.equal(f.severity, "blocker", "the billed figure is wrong; a notice would let it post");
  assert.match(f.message, /MRM-NEG1/);
  assert.match(f.message, /\$100\.00/, "the magnitude, without its sign");
  assert.match(f.message, /CO-45/, "the group and reason code, so it can be found in the file");
  assert.match(f.remediation, /against the one it corrects/i);
  assert.match(f.remediation, /bill a patient for a write-off/i, "and what it costs to get wrong");
});

test("ordinary positive adjustments do not trip it", () => {
  /**
   * A blocker that stops normal remittances is one a practice learns to click past, and then it
   * stops working for the case it was built for.
   */
  const clean = verdict([
    { group: "CO", code: "45", amount: cents(100), category: "contractual" },
    { group: "PR", code: "2", amount: cents(300), category: "patient" },
  ]);
  assert.ok(!clean.findings.some((f) => f.code === "negative-adjustment"));
});

test("a zero adjustment is not negative", () => {
  const zero = verdict([{ group: "CO", code: "45", amount: cents(0), category: "contractual" }]);
  assert.ok(!zero.findings.some((f) => f.code === "negative-adjustment"));
});

test("every negative on the claim is reported, not just the first", () => {
  /**
   * A corrected advice can reverse more than one adjustment, and a biller reading a single line
   * would fix one and post the rest.
   */
  const many = verdict([
    { group: "CO", code: "45", amount: cents(-100), category: "contractual" },
    { group: "PR", code: "2", amount: cents(-50), category: "patient" },
  ]);
  const found = many.findings.filter((f) => f.code === "negative-adjustment");
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => /CO-45/.test(f.message)));
  assert.ok(found.some((f) => /PR-2/.test(f.message)));
});
