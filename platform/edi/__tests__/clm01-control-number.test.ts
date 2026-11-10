/**
 * V4 — CLM01, the clinic's own claim control number, has a hard payer ceiling.
 *
 * ── WHAT THIS GUARDS ───────────────────────────────────────────────────────────────────────────
 * X12 types CLM01 as AN 1/38, but the 005010X224A2 dental guide and the payer companion guides
 * behind it cap it at 20. Stedi rejected a deliberately-probed 23-character control number.
 *
 * Mermaid generates `MRM-` plus twelve hex characters — 16, comfortably inside. So this cannot fire
 * today, and that is precisely the reason it exists: nothing about the current derivation is
 * load-bearing, and a future environment prefix or resubmission suffix would cross the line in
 * silence. The failure it prevents is expensive — a syntactically perfect claim leaves the practice,
 * spends a submission, and returns as a payer rejection naming a value no screen displays.
 *
 * The delimiter cases are the sharper half. A control number containing `*` or `~` would not be
 * rejected by anyone: it would SPLIT THE CLM SEGMENT and produce a structurally different claim than
 * the one a human authorised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLM01_MAX_LENGTH, isValidClaimControlNumber } from "../adapter.ts";
import { build837D, type X12ClaimRequest } from "../mock/x12-837.ts";

test("the documented limit is 20, and the boundary is inclusive", () => {
  assert.equal(CLM01_MAX_LENGTH, 20, "the payer limit Stedi enforces");
  assert.equal(isValidClaimControlNumber("A".repeat(20)), true, "exactly 20 is accepted");
  assert.equal(isValidClaimControlNumber("A".repeat(21)), false, "21 is one too many");
  // The value Stedi actually rejected.
  assert.equal(isValidClaimControlNumber("A".repeat(23)), false);
});

test("Mermaid's own generated control numbers pass, and are not near the limit", () => {
  // The shape build.ts produces: MRM- plus twelve uppercase hex characters.
  const generated = "MRM-4F2A9C1B7E30";
  assert.equal(generated.length, 16);
  assert.equal(isValidClaimControlNumber(generated), true);
});

test("an empty control number is refused — CLM01 is mandatory", () => {
  assert.equal(isValidClaimControlNumber(""), false);
});

test("X12 delimiters are refused, because they would split the segment rather than fail", () => {
  /**
   * The case with teeth. `*` is the element separator, `~` the segment terminator, `:` the component
   * separator and `^` the repetition separator. A control number carrying one does not produce an
   * error anywhere — it silently restructures the CLM segment.
   */
  for (const bad of ["MRM-123*456", "MRM-123~456", "MRM-123:456", "MRM-123^456"]) {
    assert.equal(isValidClaimControlNumber(bad), false, `${bad} must be refused`);
  }
});

test("whitespace is refused — it survives the wire and breaks the payer's echo", () => {
  // The payer returns the control number in CLP01. Anything that does not round-trip byte-for-byte
  // stops a paid claim reconciling against the claim it paid.
  for (const bad of [" MRM-123", "MRM-123 ", "MRM 123", "\tMRM-123"]) {
    assert.equal(isValidClaimControlNumber(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("ordinary alphanumerics and hyphens are accepted", () => {
  for (const good of ["MRM-4F2A9C1B7E30", "A", "12345", "ABC-123-XYZ", "0".repeat(20)]) {
    assert.equal(isValidClaimControlNumber(good), true, `${good} must be accepted`);
  }
});

/**
 * ── THE WIRE-LEVEL BACKSTOP ────────────────────────────────────────────────────────────────────
 * The scrubber tells a human; this makes it impossible. They are not the same guarantee — anything
 * can call the builder, including a retry path or a future caller with its own idea of a control
 * number — so the codec refuses independently of whether a scrub ever ran.
 */
const CLAIM: X12ClaimRequest = {
  claimId: "11111111-2222-3333-4444-555555555555",
  patientControlNumber: "MRM-4F2A9C1B7E30",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  subscriberFirstName: "Ada",
  subscriberLastName: "Alpha",
  memberId: "ABC12345",
  dateOfBirth: "1990-04-12",
  groupNumber: "GRP100",
  // Clearly-marked synthetic sandbox data — never a production fallback.
  subscriberStreet: "1 SYNTHETIC TEST WAY",
  subscriberCity: "SPRINGFIELD",
  subscriberState: "CA",
  subscriberZip: "900010000",
  billingProviderName: "MERMAID DEMO DENTAL",
  billingProviderNpi: "1234567893",
  billingProviderTaxId: "987654321",
  serviceDate: "2026-07-27",
  totalCharge: 110,
  lines: [{ lineNumber: 1, procedureCode: "D1110", quantity: 1, chargeAmount: 110, serviceDate: "2026-07-27" }],
};

test("build837D produces a claim for a valid control number", () => {
  // The control case. If this ever stops passing, the refusals below prove nothing.
  const raw = build837D(CLAIM);
  assert.match(raw, /CLM\*MRM-4F2A9C1B7E30\*/, "CLM01 carries the control number verbatim");
});

test("build837D REFUSES an over-long control number rather than truncating it", () => {
  /**
   * Throwing, not truncating, is the deliberate choice. A shortened control number would break the
   * duplicate detection it exists for: the payer would see a claim it cannot match to the original,
   * which is how the same treatment gets paid twice.
   */
  assert.throws(
    () => build837D({ ...CLAIM, patientControlNumber: "MRM-" + "A".repeat(21) }),
    /Refusing to build an 837D/,
    "an over-long CLM01 must never reach a payer"
  );
});

test("build837D refuses a control number that would split the segment", () => {
  assert.throws(() => build837D({ ...CLAIM, patientControlNumber: "MRM-12*34" }), /Refusing to build an 837D/);
  assert.throws(() => build837D({ ...CLAIM, patientControlNumber: "MRM-12~34" }), /Refusing to build an 837D/);
  assert.throws(() => build837D({ ...CLAIM, patientControlNumber: "" }), /Refusing to build an 837D/);
});
