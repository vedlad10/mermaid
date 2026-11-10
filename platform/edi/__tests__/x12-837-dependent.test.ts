/**
 * A claim for a patient covered under someone else's policy — 837D loop 2000C (NEW-01).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `build837D` had no notion of a dependent. SBR02 was the literal "18" (self), HL04 the literal
 * "0" (no level follows), and the patient's name went in NM1*IL against the member id — the
 * subscriber loop. A dental plan issues ONE member id to the subscriber and covers the family under
 * it, so every claim for a child was filed asserting the child holds the policy. A payer either
 * rejects that or adjudicates it against the wrong person's benefits, and neither failure names the
 * cause.
 *
 * ── A NOTE ON WHERE THE RELATIONSHIP GOES ────────────────────────────────────────────────────────
 * The intuitive place to look for "19" (child) is SBR02, because that is where "18" lives. It is
 * not correct, and this suite asserts it is NOT there. 005010X224A2 makes SBR02 situational —
 * "Required when the patient is the subscriber or is considered to be the subscriber. If not
 * required by this implementation guide, do not send" — and puts the dependent's relationship in
 * **PAT01 of loop 2000C**. Two elements answering two different questions.
 *
 * That distinction is not academic here: the same guide's rule about SBR08 being unused is what a
 * live clearinghouse rejected this codec for once already ("Element SBR-08 is not used by this
 * guide"). Sending a relationship code in a situational element the guide says to omit is the same
 * class of error, and it would be found the same way — in production, by a payer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build837D, parseSegments } from "../mock/x12-837.ts";
import type { X12ClaimRequest } from "../mock/x12-837.ts";

const NOW = new Date("2026-07-27T14:30:00Z");

/** Ada holds the policy; her son Kit is the patient. Both are on the claim, in different loops. */
const SELF: X12ClaimRequest = {
  claimId: "11111111-2222-3333-4444-555555555555",
  patientControlNumber: "MRM-000123",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  subscriberFirstName: "Ada",
  subscriberLastName: "Alpha",
  memberId: "ABC12345",
  dateOfBirth: "1990-04-12",
  groupNumber: "GRP100",
  subscriberStreet: "1 Main St",
  subscriberCity: "Springfield",
  subscriberState: "CA",
  subscriberZip: "90001",
  subscriberGender: "F",
  billingProviderName: "MERMAID DEMO DENTAL",
  billingProviderNpi: "1234567893",
  billingProviderTaxId: "987654321",
  serviceDate: "2026-07-27",
  totalCharge: 175,
  lines: [{ lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 175, serviceDate: "2026-07-27" }],
};

const DEPENDENT: X12ClaimRequest = {
  ...SELF,
  dependent: {
    firstName: "Kit",
    lastName: "Alpha",
    dateOfBirth: "2016-09-03",
    relationshipCode: "19",
    street: "1 Main St",
    city: "Springfield",
    state: "CA",
    zip: "90001",
    gender: "M",
  },
};

const seg = (raw: string, id: string) => parseSegments(raw).filter((s) => s.id === id);

test("a dependent claim names the SUBSCRIBER in 2010BA, against the member id", () => {
  const raw = build837D(DEPENDENT, NOW);
  const il = seg(raw, "NM1").find((s) => s.elements[0] === "IL")!;

  assert.equal(il.elements[2], "Alpha", "NM103 — the policy holder's surname");
  assert.equal(il.elements[3], "Ada", "NM104 — the policy holder's given name, NOT the patient's");
  assert.equal(il.elements[7], "MI");
  assert.equal(il.elements[8], "ABC12345", "the member id belongs to the subscriber loop");
});

test("the PATIENT is a separate 2000C level, with the relationship in PAT01", () => {
  const raw = build837D(DEPENDENT, NOW);

  const hls = seg(raw, "HL");
  const patientLevel = hls.find((s) => s.elements[2] === "23");
  assert.ok(patientLevel, "HL03 '23' opens the dependent level — without it there is no 2000C loop");
  assert.equal(patientLevel!.elements[0], "3", "HL01 sequence");
  assert.equal(patientLevel!.elements[1], "2", "HL02 — its parent is the subscriber level");
  assert.equal(patientLevel!.elements[3], "0", "HL04 — nothing nests below a patient");

  const subscriberLevel = hls.find((s) => s.elements[2] === "22")!;
  assert.equal(
    subscriberLevel.elements[3],
    "1",
    "HL04 on the subscriber level must announce the child level. It was hardcoded '0', which told " +
      "the payer no patient loop follows while one did."
  );

  const pat = seg(raw, "PAT");
  assert.equal(pat.length, 1, "exactly one PAT segment, in the patient loop");
  assert.equal(pat[0]!.elements[0], "19", "PAT01 — X12 element 1069, child");

  const qc = seg(raw, "NM1").find((s) => s.elements[0] === "QC")!;
  assert.ok(qc, "NM1*QC carries the patient's own name in loop 2010CA");
  assert.equal(qc.elements[2], "Alpha");
  assert.equal(qc.elements[3], "Kit");
  assert.equal(
    qc.elements[8] ?? "",
    "",
    "and NO identifier — a dependent has no member id of their own, which is the whole reason this " +
      "loop exists"
  );
});

test("SBR02 is EMPTY for a dependent, and '18' only when the patient is the subscriber", () => {
  /**
   * The assertion that will look wrong to a reader expecting "19" here. See the file header: the
   * guide says SBR02 is sent only when the patient is the subscriber, and a relationship code in a
   * situational element the guide tells you to omit is exactly the mistake a clearinghouse rejected
   * this codec for in SBR08.
   */
  const dependent = seg(build837D(DEPENDENT, NOW), "SBR")[0]!;
  assert.equal(dependent.elements[1], "", "SBR02 must not be sent when the patient is a dependent");
  assert.notEqual(dependent.elements[1], "19", "the relationship belongs in PAT01, not here");
  assert.equal(dependent.elements[2], "GRP100", "and SBR03 must not have shifted");
  // SBR09 is elements[8]: `elements` is zero-indexed from SBR01, so index 8 is the ninth element.
  assert.equal(dependent.elements[8], "CI", "nor SBR09 — the filing indicator must not shift");

  const self = seg(build837D(SELF, NOW), "SBR")[0]!;
  assert.equal(self.elements[1], "18", "a self claim still says self");
});

test("the dependent's own date of birth and gender go in 2010CA, not the subscriber's", () => {
  const dmg = seg(build837D(DEPENDENT, NOW), "DMG");
  assert.equal(dmg.length, 2, "one DMG per person on the claim");

  assert.equal(dmg[0]!.elements[1], "19900412", "2010BA — the subscriber's");
  assert.equal(dmg[0]!.elements[2], "F");
  assert.equal(dmg[1]!.elements[1], "20160903", "2010CA — the patient's");
  assert.equal(dmg[1]!.elements[2], "M");
});

test("an ordinary self claim is byte-for-byte what it always was", () => {
  /**
   * The regression that matters most. Almost every dental claim has the patient as the subscriber,
   * and a change that quietly altered those bytes would be found by a payer, at scale, on claims
   * that were filing perfectly well.
   */
  const raw = build837D(SELF, NOW);
  assert.equal(seg(raw, "HL").length, 2, "no patient level");
  assert.equal(seg(raw, "PAT").length, 0, "no PAT segment");
  assert.equal(seg(raw, "NM1").filter((s) => s.elements[0] === "QC").length, 0, "no 2010CA name");
  assert.equal(seg(raw, "HL").find((s) => s.elements[2] === "22")!.elements[3], "0", "HL04 stays 0");
});

test("the segment count in SE counts the dependent loop", () => {
  /**
   * SE01 is the number of segments in the transaction set, and a payer validates it. The count is
   * derived from the array, so the six segments the patient loop adds must show up — a hardcoded
   * or stale count would make every dependent claim structurally invalid.
   */
  const selfCount = Number(seg(build837D(SELF, NOW), "SE")[0]!.elements[0]);
  const depCount = Number(seg(build837D(DEPENDENT, NOW), "SE")[0]!.elements[0]);

  assert.equal(depCount - selfCount, 6, "HL, PAT, NM1*QC, N3, N4, DMG");
  assert.equal(
    depCount,
    parseSegments(build837D(DEPENDENT, NOW)).filter((s) => !["ISA", "GS", "GE", "IEA"].includes(s.id)).length,
    "and it must equal the segments actually between ST and SE inclusive"
  );
});

test("PAT01 '18' is refused — a subscriber has no dependent loop", () => {
  /**
   * "Self" inside the loop that exists only because the patient is NOT the subscriber is a
   * contradiction, and a plausible-looking one: 18 is the code a reader coming from SBR02 would
   * reach for. Refused at the builder because anything at all can call it.
   */
  assert.throws(
    () => build837D({ ...DEPENDENT, dependent: { ...DEPENDENT.dependent!, relationshipCode: "18" } }, NOW),
    /PAT01 "18"/
  );
});
