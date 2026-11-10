/**
 * A group practice must name the dentist who did the work (NEW-22).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Only 837D loop 2010AA was ever emitted: the entity that gets PAID. For a solo practice that is
 * right and complete, and 005010X224A2 says to omit 2310B when the rendering provider is the billing
 * provider.
 *
 * For a group it is a false statement. The billing NPI is the practice's corporate one, so a claim
 * without 2310B tells the payer that the corporation personally performed a crown — and the payer
 * checks credentialing and network participation against the RENDERING provider, so the claim is
 * denied or paid out-of-network for a reason that names none of this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaimDraft } from "../engine/build.ts";
import { scrubClaim } from "../engine/scrub.ts";
import type { Claim, ScrubCode } from "../types.ts";
import { BILLING_PROVIDER, NOW, PATIENT, snapshot } from "./fixtures.ts";

const SOLO = { billingProvider: BILLING_PROVIDER };
const GROUP = { billingProvider: BILLING_PROVIDER, practiceIsGroup: true };

function claim(mutate: (c: Claim) => void = () => {}): Claim {
  const c = buildClaimDraft(
    { verificationId: "ver-0001", patient: { ...PATIENT }, coverageSnapshot: snapshot() },
    NOW
  );
  mutate(c);
  return c;
}

const codes = (c: Claim, ctx: typeof SOLO): ScrubCode[] => scrubClaim(c, ctx, NOW).findings.map((f) => f.code);

test("NEW-22: a group practice's claim is BLOCKED until it names the treating dentist", () => {
  const result = scrubClaim(claim(), GROUP, NOW);
  const finding = result.findings.find((f) => f.code === "missing-rendering-provider");

  assert.ok(finding, "a group claim naming nobody who rendered the care must not reach a payer");
  assert.equal(finding!.severity, "error", "a warning would let it file and be misadjudicated");
  assert.equal(result.clean, false);
  assert.match(finding!.remediation, /not the group's/i, "and it must say which NPI is wanted");
});

test("NEW-22: naming the dentist unblocks it", () => {
  const c = claim((x) => {
    x.renderingProvider = { firstName: "Rhea", lastName: "Mockdentist", npi: "1111111112", taxonomyCode: "1223G0001X" };
  });
  const result = scrubClaim(c, GROUP, NOW);
  assert.equal(result.clean, true, `unexpected findings: ${JSON.stringify(result.findings)}`);
});

test("NEW-22: an NPI whose check digit does not compute is refused", () => {
  /**
   * A structurally invalid NPI is a guaranteed payer rejection, and it is the shape a transposed
   * digit takes. The same check the billing NPI already gets, applied to the one that decides
   * whether the payer thinks this dentist is in network.
   */
  const c = claim((x) => {
    x.renderingProvider = { firstName: "Rhea", lastName: "Mockdentist", npi: "1234567890", taxonomyCode: "1223G0001X" };
  });
  const finding = scrubClaim(c, GROUP, NOW).findings.find((f) => f.code === "missing-rendering-provider");

  assert.ok(finding);
  assert.equal(finding!.severity, "error");
  assert.match(finding!.message, /check digit/i);
});

test("NEW-22: a SOLO practice is asked for nothing — the guide forbids the loop there", () => {
  /**
   * The regression that matters most. Almost every claim in this system is a solo practice's, and a
   * rule that fired on those would block the entire ordinary workload on a segment 005010X224A2
   * says not to send.
   */
  assert.deepEqual(codes(claim(), SOLO).filter((c) => c === "missing-rendering-provider"), []);
  assert.equal(scrubClaim(claim(), SOLO, NOW).clean, true);
});

test("NEW-22: a partially-named provider is refused, not half-accepted", () => {
  /**
   * NM1*82 with a name and no NPI, or an NPI and no name, is a malformed segment rather than a
   * smaller amount of information — the same rule the patient address follows.
   */
  for (const partial of [
    { firstName: "Rhea", lastName: "", npi: "1111111112", taxonomyCode: "1223G0001X" },
    { firstName: "", lastName: "Mockdentist", npi: "1111111112", taxonomyCode: "1223G0001X" },
    { firstName: "Rhea", lastName: "Mockdentist", npi: "", taxonomyCode: "1223G0001X" },
    // The one a live clearinghouse caught: a complete name and NPI, no taxonomy, no PRV segment.
    { firstName: "Rhea", lastName: "Mockdentist", npi: "1111111112", taxonomyCode: "" },
  ]) {
    const c = claim((x) => {
      x.renderingProvider = partial;
    });
    assert.ok(
      codes(c, GROUP).includes("missing-rendering-provider"),
      `should have been refused: ${JSON.stringify(partial)}`
    );
  }
});
