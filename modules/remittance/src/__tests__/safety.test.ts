/**
 * Money-safety tests.
 *
 * These are the gates that stand between a payer's file and the practice's ledger. The blocker /
 * notice distinction is deliberate and load-bearing: a blocker stops money moving, while a notice
 * lets it move and tells a human to look. Getting it backwards either freezes real cash out of the
 * ledger or lets bad arithmetic through — both are worse than the gate not existing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import type { RemittanceAdvice, RemittanceClaim } from "@mermaid/edi";
import { checkRemittanceSafety, matchable, reconcile } from "../engine/safety.ts";

/**
 * A WELL-FORMED claim. Every dollar of the charge is accounted for, and CLP05 agrees with the
 * PR-group adjustments that itemise it.
 *
 * This fixture used to declare $500 of patient responsibility with `adjustments: []` — an 835 no
 * payer can produce, because CLP05 is by definition the total of the PR segments. The gates were
 * therefore being tested against a file that could not exist, which is how the CLP05/CAS
 * disagreement went unnoticed for so long: nothing in the suite ever put the two numbers side by
 * side, because the fixture only had one of them.
 *
 *   $1,425.00 charged = $800.00 paid + $500.00 patient (PR-2) + $125.00 contractual (CO-45)
 */
function claim(overrides: Partial<RemittanceClaim> = {}): RemittanceClaim {
  return {
    patientControlNumber: "MRM-000123",
    payerControlNumber: "556677889",
    statusCode: "1",
    disposition: "partial",
    charged: cents(1425),
    paid: cents(800),
    patientResponsibility: cents(500),
    patientName: "Ada Alpha",
    memberId: "ABC12345",
    lines: [],
    adjustments: [
      { group: "PR", code: "2", description: "Coinsurance amount", category: "patient", amount: cents(500), procedureCode: null },
      { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(125), procedureCode: null },
    ],
    remarks: [],
    unbalanced: false,
    ...overrides,
  };
}

function advice(overrides: Partial<RemittanceAdvice> = {}): RemittanceAdvice {
  return {
    traceNumber: "EFT100200300",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    payeeId: "1234567893",
    payeeIdQualifier: "XX",
    paymentTotal: cents(800),
    paymentMethod: "ACH",
    paymentDate: "2026-08-10",
    claims: [claim()],
    providerAdjustments: [],
    balanced: true,
    issues: [],
    ...overrides,
  };
}

const KNOWN = new Set(["MRM-000123"]);

test("a balanced, matched advice is safe to post", () => {
  const result = checkRemittanceSafety(advice(), KNOWN);
  assert.equal(result.safeToPost, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.notices, []);
});

test("an unbalanced advice blocks posting, carrying every issue through", () => {
  const result = checkRemittanceSafety(
    advice({ balanced: false, issues: ["Remittance total $999.00 does not equal claim payments.", "Claim MRM-000123: charged $1425.00 but paid + adjustments = $1424.99."] }),
    KNOWN
  );

  assert.equal(result.safeToPost, false);
  assert.equal(result.blockers.length, 2);
  assert.ok(result.blockers.every((b) => b.code === "unbalanced"));
  assert.match(result.blockers[0]!.remediation, /Do not post until the arithmetic agrees/);
});

test("a single unbalanced claim blocks the whole advice", () => {
  const result = checkRemittanceSafety(advice({ claims: [claim({ unbalanced: true })] }), KNOWN);
  assert.equal(result.safeToPost, false);
  const blocker = result.blockers.find((b) => b.code === "claim-unbalanced")!;
  assert.equal(blocker.patientControlNumber, "MRM-000123");
});

test("a reversal is never auto-posted", () => {
  const result = checkRemittanceSafety(
    advice({ claims: [claim({ disposition: "reversal", statusCode: "22", paid: cents(0) })], paymentTotal: cents(0) }),
    KNOWN
  );

  assert.equal(result.safeToPost, false);
  const blocker = result.blockers.find((b) => b.code === "reversal-present")!;
  assert.match(blocker.message, /retracting a previous payment/);
  assert.match(blocker.remediation, /post the correction by hand/);
});

test("a missing trace number blocks — idempotency cannot be guaranteed without it", () => {
  const result = checkRemittanceSafety(advice({ traceNumber: "  " }), KNOWN);
  assert.equal(result.safeToPost, false);
  assert.ok(result.blockers.some((b) => b.code === "missing-trace-number"));
});

test("an unmatched payment is a NOTICE — real cash must not be frozen out of the ledger", () => {
  const result = checkRemittanceSafety(advice({ claims: [claim({ patientControlNumber: "MRM-UNKNOWN" })] }), KNOWN);

  assert.equal(result.safeToPost, true, "the money is real and should still post");
  const notice = result.notices.find((n) => n.code === "unmatched-payment")!;
  assert.match(notice.message, /does not match any claim we recorded submitting/);
  assert.match(notice.remediation, /may have been filed outside Mermaid/);
});

test("a zero-money advice posts, with a notice that there is nothing to deposit", () => {
  const result = checkRemittanceSafety(
    advice({ paymentTotal: cents(0), claims: [claim({ paid: cents(0), disposition: "denied" })] }),
    KNOWN
  );
  assert.equal(result.safeToPost, true);
  assert.ok(result.notices.some((n) => n.code === "no-payment"));
});

/**
 * ── DELIBERATE REVERSAL OF A PREVIOUSLY-PASSING ASSERTION (M12) ────────────────────────────────
 *
 * This test used to read:
 *
 *     advice({ providerAdjustments: [{ providerId: "1234567893", reason: "WO", amount: cents(50) }] })
 *     assert.equal(result.safeToPost, true);
 *
 * It passed, and it was wrong. `WO` is overpayment recovery — the payer taking $50 back — and the
 * assertion said an unattributed takeback of any size may post itself. That is a true description
 * of what the code did and a false statement about money, the same shape as the three tests
 * replaced during the M-series.
 *
 * $50 is now above the $25 review threshold, so the same input HOLDs. The notice path it used to
 * assert is still tested — below — at an amount that genuinely belongs there.
 */
test("a provider-level recoupment above the threshold HOLDS instead of posting", () => {
  const result = checkRemittanceSafety(
    advice({
      providerAdjustments: [
        { providerId: "1234567893", reason: "WO>MRM-000123", reasonCode: "WO", referenceId: "MRM-000123", amount: cents(50) },
      ],
    }),
    KNOWN
  );

  assert.equal(result.safeToPost, false);
  const blocker = result.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.ok(blocker, "a recoupment over the threshold must be a blocker, not a notice");
  assert.match(blocker.message, /\$50\.00 in provider-level adjustments/);
  assert.match(blocker.message, /\$25\.00 review threshold/);
  // No finding of this code may remain a notice — a duplicated finding would post AND hold.
  assert.equal(result.notices.filter((n) => n.code === "provider-adjustment").length, 0);
});

test("a provider-level adjustment below the threshold still posts, and names the reason and reference", () => {
  const result = checkRemittanceSafety(
    advice({
      providerAdjustments: [
        { providerId: "1234567893", reason: "L6>MRM-000123", reasonCode: "L6", referenceId: "MRM-000123", amount: cents(4.12) },
      ],
    }),
    KNOWN
  );

  assert.equal(result.safeToPost, true);
  const notice = result.notices.find((n) => n.code === "provider-adjustment")!;
  assert.match(notice.message, /\$4\.12 in provider-level adjustments/);
  assert.match(notice.message, /under reason L6/);
  assert.match(notice.message, /claim MRM-000123/);
});

/**
 * ── THE THRESHOLD BOUNDARY (M12) ───────────────────────────────────────────────────────────────
 *
 * Three cases, because a threshold has three interesting values and only one of them is tested by
 * "above" and "below". The exact-threshold case is what pins `>` against `>=`: swap the operator
 * and every other case in this file still passes.
 */
const plb = (amount: number, overrides: Partial<{ reasonCode: string; referenceId: string | null }> = {}) => ({
  providerId: "1234567893",
  reason: "WO>MRM-000123",
  reasonCode: "WO",
  referenceId: "MRM-000123" as string | null,
  amount: cents(amount),
  ...overrides,
});

test("one cent BELOW the threshold posts as a notice", () => {
  const result = checkRemittanceSafety(advice({ providerAdjustments: [plb(24.99)] }), KNOWN);
  assert.equal(result.safeToPost, true);
  assert.equal(result.notices.filter((n) => n.code === "provider-adjustment").length, 1);
});

test("EXACTLY at the threshold posts as a notice — the bound is inclusive on the safe side", () => {
  const result = checkRemittanceSafety(advice({ providerAdjustments: [plb(25)] }), KNOWN);
  assert.equal(
    result.safeToPost,
    true,
    "the threshold is the largest amount that may post; `>=` here would hold a payment the rule allows"
  );
  assert.equal(result.notices.filter((n) => n.code === "provider-adjustment").length, 1);
  assert.equal(result.blockers.filter((b) => b.code === "provider-adjustment").length, 0);
});

test("one cent ABOVE the threshold holds", () => {
  const result = checkRemittanceSafety(advice({ providerAdjustments: [plb(25.01)] }), KNOWN);
  assert.equal(result.safeToPost, false);
  assert.equal(result.blockers.filter((b) => b.code === "provider-adjustment").length, 1);
});

test("the threshold reads money MOVED, not the net — two offsetting adjustments still hold", () => {
  // +$500 taken back and $500 credited nets to zero. Under a net test this produced no finding at
  // all, not even the old notice: two unattributed movements of real money, entirely invisible.
  const result = checkRemittanceSafety(
    advice({
      providerAdjustments: [plb(500), plb(-500, { reasonCode: "CS", referenceId: null })],
    }),
    KNOWN
  );

  assert.equal(result.safeToPost, false);
  const blocker = result.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.match(blocker.message, /\$0\.00 net \(\$1,000\.00 moved\)/);
});

test("a recoupment is attributed to the claim it names, when we recorded submitting it", () => {
  const result = checkRemittanceSafety(advice({ providerAdjustments: [plb(500)] }), KNOWN);
  const blocker = result.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.match(blocker.message, /\$500\.00 under reason WO: taken against claim MRM-000123\./);
});

test("a reference we never submitted is reported as unmatched rather than guessed at", () => {
  const result = checkRemittanceSafety(
    advice({ providerAdjustments: [plb(500, { referenceId: "MRM-999999" })] }),
    KNOWN
  );
  const blocker = result.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.match(blocker.message, /references MRM-999999, which matches no claim we recorded submitting\./);
  // The claim that IS on the advice must not be offered as a near-enough answer.
  assert.doesNotMatch(blocker.message, /taken against claim/);
});

test("a recoupment with no reference at all says so, instead of attributing it to the only claim present", () => {
  const result = checkRemittanceSafety(
    advice({ providerAdjustments: [plb(500, { referenceId: null })] }),
    KNOWN
  );
  const blocker = result.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.match(blocker.message, /the payer gave no claim reference, so this cannot be attributed to a claim\./);
  assert.doesNotMatch(blocker.message, /MRM-000123/);
});

test("holding a recoupment does not touch the claim, the postings or the arithmetic", () => {
  const held = checkRemittanceSafety(advice({ providerAdjustments: [plb(500)] }), KNOWN);
  const clean = checkRemittanceSafety(advice(), KNOWN);

  assert.equal(held.safeToPost, false);
  // The ONLY difference the recoupment makes is its own finding. No claim-level blocker appears, no
  // existing finding changes severity: a hold is a deferral, not a correction.
  const withoutPlb = held.findings.filter((f) => f.code !== "provider-adjustment");
  assert.deepEqual(withoutPlb, clean.findings.filter((f) => f.code !== "provider-adjustment"));
  assert.equal(held.blockers.filter((b) => b.code !== "provider-adjustment").length, 0);
  // And the gate says so in the remediation, because a biller reading "held" will ask.
  const blocker = held.blockers.find((b) => b.code === "provider-adjustment")!;
  assert.match(blocker.remediation, /has NOT changed the status of any claim/);
});

test("every finding tells a human what to do about it", () => {
  const result = checkRemittanceSafety(
    advice({
      balanced: false,
      issues: ["something does not add up"],
      claims: [claim({ patientControlNumber: "MRM-UNKNOWN", disposition: "reversal" })],
      providerAdjustments: [
        { providerId: "p", reason: "WO>MRM-000123", reasonCode: "WO", referenceId: "MRM-000123", amount: cents(10) },
      ],
    }),
    KNOWN
  );

  assert.ok(result.findings.length >= 4);
  for (const finding of result.findings) {
    assert.ok(finding.message.trim().length > 0, `${finding.code} has no message`);
    assert.ok(finding.remediation.trim().length > 0, `${finding.code} has no remediation`);
  }
});

test("matchable selects only the claims we recorded submitting", () => {
  const a = advice({ claims: [claim(), claim({ patientControlNumber: "MRM-OTHER" })] });
  assert.deepEqual(matchable(a, KNOWN).map((c) => c.patientControlNumber), ["MRM-000123"]);
});

// ── Daily reconciliation ──────────────────────────────────────────────────────────────

test("reconciliation balances when everything received was posted", () => {
  const report = reconcile({
    paymentTotals: [cents(800), cents(1200)],
    postedAmounts: [cents(800), cents(700), cents(500)],
    providerAdjustments: [],
  });

  assert.equal(report.balanced, true);
  assert.equal(report.drift, 0);
  assert.equal(report.paymentsReceived, cents(2000));
  assert.equal(report.amountPosted, cents(2000));
  assert.match(report.summary, /^Reconciled:/);
});

test("provider adjustments are accounted for rather than counted as drift", () => {
  // The payer sent $750 but posted $800 against claims, holding back $50 as a takeback.
  const report = reconcile({
    paymentTotals: [cents(750)],
    postedAmounts: [cents(800)],
    providerAdjustments: [cents(50)],
  });
  assert.equal(report.balanced, true);
  assert.equal(report.drift, 0);
});

test("drift is reported loudly — the ledger and the bank will disagree", () => {
  const report = reconcile({ paymentTotals: [cents(1000)], postedAmounts: [cents(900)], providerAdjustments: [] });

  assert.equal(report.balanced, false);
  assert.equal(report.drift, cents(100));
  assert.match(report.summary, /^DRIFT of \$100\.00/);
  assert.match(report.summary, /ledger and the bank will disagree/);
});

test("reconciling nothing is balanced, not an error", () => {
  const report = reconcile({ paymentTotals: [], postedAmounts: [], providerAdjustments: [] });
  assert.equal(report.balanced, true);
  assert.equal(report.paymentsReceived, 0);
});

// ── M8 — COORDINATION OF BENEFITS HOLDS, IT DOES NOT POST ─────────────────────────────────────
//
// Two independent signals that another plan is involved, and both used to pass straight through:
// an `OA` adjustment (categorised `informational`, so it balanced and reported nothing) and CLP02
// `19`/`20` (collapsed into paid/partial/denied by amount). The advice then posted and the primary's
// PR balance was billed to the patient — money a secondary payer may owe.

test("M8: an OA coordination amount BLOCKS the advice rather than posting it", () => {
  const result = checkRemittanceSafety(
    advice({
      claims: [
        claim({
          charged: cents(1000),
          paid: cents(600),
          patientResponsibility: cents(0),
          adjustments: [
            { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(100), procedureCode: null },
            { group: "OA", code: "23", description: "Impact of prior payer(s) adjudication", category: "coordination", amount: cents(300), procedureCode: null },
          ],
        }),
      ],
      paymentTotal: cents(600),
    }),
    KNOWN
  );

  assert.equal(result.safeToPost, false, "money whose owner is unknown must not post automatically");
  const finding = result.blockers.find((f) => f.code === "coordination-unresolved");
  assert.ok(finding, "and the reason must be nameable, not a generic hold");
  assert.equal(finding!.patientControlNumber, "MRM-000123");
  assert.match(finding!.message, /another payer's/);
  assert.match(finding!.remediation, /Do NOT bill the patient/);
  assert.match(finding!.remediation, /file the secondary claim/);
});

test("M8: a FORWARDED claim blocks even when it carries no OA adjustment at all", () => {
  /**
   * CLP02 `19`/`20` is the payer stating in a different field that it passed the claim on. A payer
   * may forward without itemising an OA amount, so the two signals are checked independently — one
   * of them being absent must not make the other safe.
   */
  const result = checkRemittanceSafety(
    advice({ claims: [claim({ statusCode: "19", disposition: "forwarded" })] }),
    KNOWN
  );

  assert.equal(result.safeToPost, false);
  const finding = result.blockers.find((f) => f.code === "coordination-unresolved");
  assert.ok(finding);
  assert.match(finding!.message, /FORWARDED/);
  assert.match(finding!.message, /status 19/);
});

test("M8: an ordinary single-payer advice still posts — the gate must not fire on normal traffic", () => {
  // The control. A blocker that fires on everything freezes real cash out of the ledger, which the
  // header of this file names as being as bad as no gate at all.
  const result = checkRemittanceSafety(advice(), KNOWN);
  assert.equal(result.safeToPost, true);
  assert.ok(!result.findings.some((f) => f.code === "coordination-unresolved"));
});

test("M8: coordination is reported ALONGSIDE other blockers, never instead of them", () => {
  // A COB claim that also fails to balance must surface both. Collapsing them would let a human fix
  // the coordination question and release an advice whose arithmetic is still wrong.
  const result = checkRemittanceSafety(
    advice({
      balanced: false,
      issues: ["Claim MRM-000123: charged $1000.00 but paid + adjustments = $999.00."],
      claims: [
        claim({
          statusCode: "19",
          disposition: "forwarded",
          unbalanced: true,
          adjustments: [
            { group: "PR", code: "2", description: "Coinsurance amount", category: "patient", amount: cents(500), procedureCode: null },
            { group: "CO", code: "45", description: "Charge exceeds fee schedule (contractual)", category: "contractual", amount: cents(125), procedureCode: null },
          ],
        }),
      ],
    }),
    KNOWN
  );

  const codes = result.blockers.map((f) => f.code);
  assert.ok(codes.includes("coordination-unresolved"));
  assert.ok(codes.includes("unbalanced"));
  assert.ok(codes.includes("claim-unbalanced"));
});
