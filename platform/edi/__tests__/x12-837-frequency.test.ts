/**
 * A corrected claim must reach the payer as a REPLACEMENT, not as a new claim.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────────────────────
 * `build837D` hardcoded CLM05-3 to "1" — original. This codebase explicitly supports correcting and
 * refiling after a denial (`modules/claims/src/engine/timeline.ts:46`: "a claim can be corrected and
 * refiled after a denial, producing a second submission"), and the claim state machine allows
 * `denied → draft → ready → submitted`.
 *
 * So every corrected claim arrived at the payer looking like a brand-new one, carrying the same
 * CLM01 as a claim the payer already had on file. Payers deny that as CARC 18, duplicate claim —
 * which means the correction workflow reliably manufactured the next denial for the practice to
 * work. A replacement is frequency 7 and quotes the payer's own control number in REF*F8.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build837D } from "../mock/x12-837.ts";

const BASE = {
  claimId: "11111111-2222-4333-8444-555555555555",
  patientControlNumber: "MRM-ABC123",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  subscriberFirstName: "Ada",
  subscriberLastName: "Alpha",
  memberId: "ABC12345",
  dateOfBirth: "1990-04-12",
  billingProviderName: "REAL DENTAL",
  billingProviderNpi: "1699999992",
  billingProviderTaxId: "123456789",
  serviceDate: "2026-08-10",
  totalCharge: 1425,
  lines: [
    { lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 65, serviceDate: "2026-08-10" },
    { lineNumber: 2, procedureCode: "D2750", quantity: 1, chargeAmount: 1250, serviceDate: "2026-08-10", toothNumber: "19" },
    { lineNumber: 3, procedureCode: "D1110", quantity: 1, chargeAmount: 110, serviceDate: "2026-08-10" },
  ],
};

const segmentsOf = (x12: string): string[][] => x12.split("~").filter(Boolean).map((s) => s.split("*"));
const find = (x12: string, id: string): string[][] => segmentsOf(x12).filter((s) => s[0] === id);
const clm05 = (x12: string): string[] => find(x12, "CLM")[0]![5]!.split(":");

test("a first filing is an ORIGINAL claim, and quotes no prior control number", () => {
  const x12 = build837D({ ...BASE } as never);
  assert.deepEqual(clm05(x12), ["11", "B", "1"], "office place of service, frequency 1");
  assert.equal(find(x12, "REF").some((r) => r[1] === "F8"), false, "nothing to replace yet");
});

test("a refiling is a REPLACEMENT, and names the claim it replaces", () => {
  const x12 = build837D({ ...BASE, claimFrequency: "7", originalClaimControlNumber: "PAYER-CTRL-99887" } as never);
  assert.deepEqual(clm05(x12), ["11", "B", "7"], "frequency 7 = replacement of a prior claim");

  const f8 = find(x12, "REF").find((r) => r[1] === "F8");
  assert.ok(f8, "a replacement without REF*F8 leaves the payer unable to tell what it replaces");
  assert.equal(f8![2], "PAYER-CTRL-99887");
});

test("the clinic's own control number is stable across a refiling", () => {
  // CLM01 identifies the CLAIM, not the filing. Changing it on a correction would present the
  // payer with two unrelated claims for one episode of care.
  const first = build837D({ ...BASE } as never);
  const refiled = build837D({ ...BASE, claimFrequency: "7", originalClaimControlNumber: "X1" } as never);
  assert.equal(find(first, "CLM")[0]![1], "MRM-ABC123");
  assert.equal(find(refiled, "CLM")[0]![1], "MRM-ABC123");
});

/**
 * ── M11 — THIS TEST REPLACES ONE THAT PINNED THE DEFECT ────────────────────────────────────────
 *
 * The previous version asserted that a replacement with no original control number "degrades to
 * omitting REF*F8, not to a blank one", on the reasoning that "the scrubber is where that should be
 * caught". The scrubber does not catch it — there is no pre-auth-style rule for claim frequency
 * anywhere in `scrubClaim` — so the degraded form was not a safety net, it was the shipped
 * behaviour, and the test held it in place.
 *
 * What actually goes on the wire in that case is CLM05-3 `7` with nothing saying what is being
 * replaced. The payer is told to supersede a claim and not told which, so it denies the refiling as
 * a duplicate (CARC 18) — the correction workflow manufacturing the next denial, which is the exact
 * failure the frequency work above exists to prevent.
 *
 * It is reachable: a submission recorded with no payer control number (a clearinghouse that
 * acknowledged without an identifier) leaves `claim.submission.controlNumber` empty, and
 * `ClaimService.submit` still elects frequency `7` because a prior submission exists.
 *
 * So the codec refuses, for the same reason it refuses an invalid CLM01: anything can call this
 * builder, and a malformed claim must not be constructible. Downgrading to frequency `1` instead
 * would file a second ORIGINAL under a control number the payer already holds — the duplicate this
 * whole file exists to prevent, arrived at from the other direction.
 */
test("M11: a replacement with no original control number is REFUSED, not degraded", () => {
  for (const missing of [null, undefined, "", "   "]) {
    assert.throws(
      () => build837D({ ...BASE, claimFrequency: "7", originalClaimControlNumber: missing } as never),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /REPLACEMENT/);
        assert.match(e.message, /REF\*F8/);
        assert.match(e.message, /duplicate/i);
        return true;
      },
      `frequency 7 with originalClaimControlNumber=${JSON.stringify(missing)} must not build`
    );
  }
});

test("M11: the refusal is specific to frequency 7 — an original still builds without one", () => {
  // The guard must not become a general requirement for a control number nobody has yet. A first
  // filing has nothing to replace, and blocking it would stop every new claim in the practice.
  const x12 = build837D({ ...BASE, claimFrequency: "1", originalClaimControlNumber: null } as never);
  assert.deepEqual(clm05(x12), ["11", "B", "1"]);
  assert.equal(find(x12, "REF").some((r) => r[1] === "F8"), false);
});

test("M11: a replacement's REF*F8 is trimmed, so padding cannot survive to the payer", () => {
  // The payer matches the original on this value exactly; surrounding whitespace survives the wire
  // and stops the match, which is the same round-trip hazard CLM01 refuses whitespace for.
  const x12 = build837D({ ...BASE, claimFrequency: "7", originalClaimControlNumber: "  PAYER-77  " } as never);
  assert.equal(find(x12, "REF").find((r) => r[1] === "F8")![2], "PAYER-77");
});

// ── Line-level construction, since these fixtures are here anyway ────────────────────────────────

test("every service line is emitted once, in order, with its own charge and date", () => {
  const x12 = build837D({ ...BASE } as never);
  const lx = find(x12, "LX").map((s) => s[1]);
  const sv3 = find(x12, "SV3");
  assert.deepEqual(lx, ["1", "2", "3"], "no duplicated or dropped lines");
  assert.equal(sv3.length, 3);
  assert.deepEqual(sv3.map((s) => s[1]), ["AD:D0120", "AD:D2750", "AD:D1110"]);
  assert.deepEqual(sv3.map((s) => s[2]), ["65.00", "1250.00", "110.00"], "two decimal places, per line");
});

test("the claim total is the sum of its lines", () => {
  /**
   * CLM02 is passed in rather than derived, so the codec cannot enforce this on its own — the
   * scrubber blocks a mismatch before filing. Asserted here so that if the codec ever starts
   * deriving it, or the caller starts passing something else, one of the two fails loudly.
   */
  const x12 = build837D({ ...BASE } as never);
  const total = Number(find(x12, "CLM")[0]![2]);
  const lines = find(x12, "SV3").reduce((sum, s) => sum + Number(s[2]), 0);
  assert.equal(total, lines);
  assert.equal(total, 1425);
});

test("a tooth number rides with its own line and nowhere else", () => {
  const x12 = build837D({ ...BASE } as never);
  const segs = segmentsOf(x12);
  const too = segs.filter((s) => s[0] === "TOO");
  assert.equal(too.length, 1, "only the crown carries a tooth");
  assert.equal(too[0]![2], "19");
  // …and it follows the SV3 it belongs to, not some other line.
  const tooAt = segs.findIndex((s) => s[0] === "TOO");
  const priorSv3 = segs.slice(0, tooAt).reverse().find((s) => s[0] === "SV3");
  assert.equal(priorSv3![1], "AD:D2750", "the tooth must attach to the crown, not to the exam");
});

test("a zero-dollar line still serialises as an explicit 0.00", () => {
  // Zero-charge lines are real (bundled services, courtesy). An empty SV302 is a malformed segment.
  const x12 = build837D({
    ...BASE,
    totalCharge: 65,
    lines: [
      { lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 65, serviceDate: "2026-08-10" },
      { lineNumber: 2, procedureCode: "D0330", quantity: 1, chargeAmount: 0, serviceDate: "2026-08-10" },
    ],
  } as never);
  assert.deepEqual(find(x12, "SV3").map((s) => s[2]), ["65.00", "0.00"]);
});

test("a high-dollar line keeps its cents and gains no separators", () => {
  const x12 = build837D({
    ...BASE,
    totalCharge: 12345.67,
    lines: [{ lineNumber: 1, procedureCode: "D6010", quantity: 1, chargeAmount: 12345.67, serviceDate: "2026-08-10" }],
  } as never);
  // "12,345.67" would be a malformed monetary element. Locale formatting must never reach the wire.
  assert.equal(find(x12, "SV3")[0]![2], "12345.67");
  assert.equal(find(x12, "CLM")[0]![2], "12345.67");
});
