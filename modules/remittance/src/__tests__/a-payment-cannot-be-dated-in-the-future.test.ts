/**
 * Money cannot have moved on a day that has not arrived.
 *
 * ── THE DEFECT, FOUND BY TRACING ONE CLAIM ─────────────────────────────────────────────────────
 * Pia Phase32's appeal-settlement advice on live staging carried:
 *
 *     ISA*00*...*260830*0000*^*00501*227677593*0*P*:      <- interchange written 30 Aug 2026
 *     BPR*I*1125.00*C*ACH************20261005              <- funds effective 5 Oct 2026
 *
 * It was ingested on 30 August and posted. Today was 1 September. So the Money screen reported
 * "Paid 2026-10-05" for cash booked 36 days earlier, and every aged report that reads
 * `paymentDate` was working from a date that had not happened.
 *
 * BPR16 is the effective date of the funds transfer. A future one is a corrupt file, a
 * misconfigured sender, or a fixture that escaped — and in each case the money it describes has
 * not moved.
 *
 * ── WHY A NOTICE AND NOT A BLOCKER ─────────────────────────────────────────────────────────────
 * Same reasoning as an unmatched payment. The cash may well be real, and refusing to record it
 * creates a worse reconciliation problem than recording it with a questionable date. It needs a
 * person to look, not a wall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { checkRemittanceSafety } from "../engine/safety.ts";
import type { RemittanceAdvice } from "@mermaid/edi";

const NOW = new Date("2026-09-01T00:00:00.000Z");

const advice = (paymentDate: string): RemittanceAdvice =>
  ({
    traceNumber: "EFT760248528",
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentTotal: cents(1125),
    paymentDate,
    balanced: true,
    issues: [],
    providerAdjustments: [],
    claims: [
      {
        patientControlNumber: "MRM-DD3FE4173F16",
        payerControlNumber: "176307890",
        patientFirstName: "Pia",
        patientLastName: "Phase32",
        memberId: "MET90001",
        charged: cents(1250),
        paid: cents(1125),
        patientResponsibility: cents(0),
        unbalanced: false,
        status: "1",
        lines: [],
        adjustments: [],
        remarks: [],
      },
    ],
  }) as unknown as RemittanceAdvice;

const codes = (paymentDate: string) =>
  checkRemittanceSafety(advice(paymentDate), new Set(["MRM-DD3FE4173F16"]), NOW).findings.map((f) => f.code);

test("a payment dated after today is flagged", () => {
  assert.ok(
    codes("2026-10-05").includes("payment-date-in-the-future"),
    "the exact advice that posted on staging must now raise a finding"
  );
});

test("it is a notice, not a blocker — the cash may still be real", () => {
  /**
   * Blocking would leave genuine money unrecorded, which is the worse reconciliation problem. The
   * advice still posts; a person is told the date cannot be right.
   */
  const result = checkRemittanceSafety(advice("2026-10-05"), new Set(["MRM-DD3FE4173F16"]), NOW);
  assert.ok(
    result.notices.some((f) => f.code === "payment-date-in-the-future"),
    "must be raised as a notice"
  );
  assert.ok(
    !result.blockers.some((f) => f.code === "payment-date-in-the-future"),
    "and must not block posting"
  );
});

test("today and yesterday are ordinary", () => {
  for (const day of ["2026-09-01", "2026-08-30", "2026-01-01"]) {
    assert.ok(
      !codes(day).includes("payment-date-in-the-future"),
      `${day} is in the past or present and must pass silently`
    );
  }
});

test("tomorrow is allowed, because a payer in a later timezone is not an error", () => {
  /**
   * One day of slack. Without it, every advice stamped by a sender already into the next calendar
   * day would raise a finding, and a check that fires on ordinary traffic is one people learn to
   * dismiss — which would cost the $1,125.00 case above its warning.
   */
  assert.ok(!codes("2026-09-02").includes("payment-date-in-the-future"));
  assert.ok(codes("2026-09-03").includes("payment-date-in-the-future"), "two days out is not a timezone");
});

test("a missing or malformed date raises nothing here", () => {
  /**
   * Absent and unparseable dates are somebody else's finding — inventing a second complaint about
   * them from this check would report the same defect twice under a misleading name.
   */
  for (const day of ["", "not-a-date", "20261005"]) {
    assert.ok(!codes(day).includes("payment-date-in-the-future"), `"${day}" is not a future date`);
  }
});
