/**
 * A refiling must reach the payer as a replacement that NAMES what it replaces — and the biller
 * must learn that at the gate, not by pressing Submit and catching an exception.
 *
 * ── WHAT THIS ADDS TO GUARDS THAT ALREADY EXIST ────────────────────────────────────────────────
 * Two refusals already stand between a nameless replacement and a payer: `build837D` will not
 * construct the 837, and `ClaimService.submit` throws before it gets that far
 * (`x12-837-frequency.test.ts` pins both). Neither is visible until a human commits to an action
 * they expect to succeed. Every other reason a claim cannot be filed is surfaced by the scrubber in
 * advance, with a remediation beside it; this one was not, and the frequency test says so in as many
 * words — "there is no pre-auth-style rule for claim frequency anywhere in `scrubClaim`".
 *
 * The money at stake is the CARC 18 duplicate denial: a correction filed as a fresh original matches
 * the payer's duplicate logic on patient, provider, date and codes, and is denied — so the workflow
 * that exists to fix a denial manufactures the next one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaimDraft } from "../engine/build.ts";
import { scrubClaim } from "../engine/scrub.ts";
import type { Claim, ClaimSubmission, ScrubCode } from "../types.ts";
import { BILLING_PROVIDER, NOW, PATIENT, snapshot } from "./fixtures.ts";

const CTX = { billingProvider: BILLING_PROVIDER };

const submission = (over: Partial<ClaimSubmission> = {}): ClaimSubmission => ({
  submittedAt: "2026-08-10T15:04:05.000Z",
  submittedBy: "biller@clinic",
  patientControlNumber: "MRM-ABC123DEF456",
  controlNumber: "PAYER-CTRL-99887",
  outcome: "accepted",
  statusCategory: "A1",
  statusCode: "19",
  message: "Accepted",
  lineErrors: [],
  ...over,
});

function claim(mutate: (c: Claim) => void = () => {}): Claim {
  const c = buildClaimDraft({ verificationId: "ver-0001", patient: { ...PATIENT }, coverageSnapshot: snapshot() }, NOW);
  mutate(c);
  return c;
}

const codes = (c: Claim): ScrubCode[] => scrubClaim(c, CTX, NOW).findings.map((f) => f.code);
const finding = (c: Claim) =>
  scrubClaim(c, CTX, NOW).findings.find((f) => f.code === "replacement-without-control-number");

test("a first filing has nothing to replace, so the rule stays quiet", () => {
  assert.equal(codes(claim()).includes("replacement-without-control-number"), false);
});

test("a refiling that knows the payer's control number scrubs clean", () => {
  const c = claim((x) => {
    x.submission = submission();
  });
  assert.equal(codes(c).includes("replacement-without-control-number"), false);
});

test("a refiling with NO payer control number is blocked at the gate, before Submit", () => {
  const c = claim((x) => {
    x.submission = submission({ controlNumber: "" });
  });
  const f = finding(c);
  assert.ok(f, "the biller must meet this on the submit gate, not as an exception from the codec");
  assert.equal(f.severity, "error", "submission genuinely is blocked; a warning would misdescribe it");
  assert.match(f.message, /REPLACEMENT/);
  assert.match(f.message, /CARC 18|duplicate/i, "name the denial this produces");
  assert.match(f.remediation, /control number/i, "say what to go and get");
});

test("whitespace is not a control number", () => {
  // The payer matches REF*F8 exactly; a blank-but-present value fails the same way an empty one does,
  // which is why `ClaimService.submit` trims before testing it. The gate must agree with the service.
  for (const blank of ["   ", "\t", "\n"]) {
    const c = claim((x) => {
      x.submission = submission({ controlNumber: blank });
    });
    assert.ok(finding(c), `a control number of ${JSON.stringify(blank)} must not pass`);
  }
});

test("the gate's verdict matches what submit would actually do", () => {
  /**
   * The two must not drift. `ClaimService.submit` refuses on exactly
   * `claim.submission && !claim.submission.controlNumber.trim()`; if the scrubber ever disagreed,
   * it would either block a claim that files perfectly well or promise one that cannot.
   */
  const wouldSubmitRefuse = (c: Claim): boolean =>
    Boolean(c.submission && !c.submission.controlNumber.trim());

  const cases: Claim[] = [
    claim(),
    claim((x) => { x.submission = submission(); }),
    claim((x) => { x.submission = submission({ controlNumber: "" }); }),
    claim((x) => { x.submission = submission({ controlNumber: "  " }); }),
  ];

  for (const c of cases) {
    assert.equal(
      Boolean(finding(c)),
      wouldSubmitRefuse(c),
      "the scrubber and the service must agree on whether this claim can be filed"
    );
  }
});

test("a rejected prior filing still counts as a filing", () => {
  // A claim the payer REJECTED at intake was still sent, and the payer may hold it. Refiling is
  // still a replacement, so a missing control number is still the problem.
  const c = claim((x) => {
    x.submission = submission({ outcome: "rejected", controlNumber: "", message: "Rejected at intake" });
  });
  assert.ok(finding(c));
});
