/**
 * 837D / 277CA codec tests. As with the 271 suite, the point is that the PRODUCTION parser is
 * exercised — a build → parse round-trip, plus the failure modes that must be loud rather than
 * silently benign.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ackForClaim,
  attributeLineStatuses,
  build837D,
  build277CA,
  parse277CA,
  parseSegments,
  controlNumber,
} from "../mock/x12-837.ts";
import type { X12ClaimRequest } from "../mock/x12-837.ts";

const NOW = new Date("2026-07-27T14:30:00Z");

const CLAIM: X12ClaimRequest = {
  claimId: "11111111-2222-3333-4444-555555555555",
  patientControlNumber: "MRM-000123",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  subscriberFirstName: "Ada",
  subscriberLastName: "Alpha",
  memberId: "ABC12345",
  dateOfBirth: "1990-04-12",
  groupNumber: "GRP100",
  billingProviderName: "MERMAID DEMO DENTAL",
  billingProviderNpi: "1234567893",
  billingProviderTaxId: "987654321",
  serviceDate: "2026-07-27",
  totalCharge: 1425,
  lines: [
    { lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 65, serviceDate: "2026-07-27" },
    { lineNumber: 2, procedureCode: "D1110", quantity: 1, chargeAmount: 110, serviceDate: "2026-07-27" },
    { lineNumber: 3, procedureCode: "D2750", toothNumber: "19", surfaces: "MO", quantity: 1, chargeAmount: 1250, serviceDate: "2026-07-27" },
  ],
};

function segmentsOf(raw: string, id: string) {
  return parseSegments(raw).filter((s) => s.id === id);
}

test("build837D emits a well-formed dental claim envelope", () => {
  const raw = build837D(CLAIM, NOW);
  const st = segmentsOf(raw, "ST")[0]!;

  assert.equal(st.elements[0], "837");
  assert.equal(st.elements[2], "005010X224A2", "dental claims use the 837D implementation guide");
  assert.equal(segmentsOf(raw, "BHT")[0]!.elements[5], "CH", "BHT06 CH = chargeable claim, not a predetermination");
  assert.ok(raw.startsWith("ISA*"));
  assert.ok(raw.endsWith("~"));
});

test("the claim carries the subscriber, payer and billing provider identifiers", () => {
  const raw = build837D(CLAIM, NOW);
  const nm1 = segmentsOf(raw, "NM1");

  // `elements` is zero-indexed from NM101, so NM109 (the identifier) is elements[8].
  const subscriber = nm1.find((s) => s.elements[0] === "IL")!;
  assert.equal(subscriber.elements[2], "Alpha");
  assert.equal(subscriber.elements[3], "Ada");
  assert.equal(subscriber.elements[7], "MI", "member ID qualifier");
  assert.equal(subscriber.elements[8], "ABC12345");

  const payer = nm1.find((s) => s.elements[0] === "PR")!;
  assert.equal(payer.elements[8], "delta-dental");

  const billing = nm1.find((s) => s.elements[0] === "85")!;
  assert.equal(billing.elements[8], "1234567893", "billing provider NPI in loop 2010AA");

  assert.equal(segmentsOf(raw, "SBR")[0]!.elements[2], "GRP100");
  assert.equal(segmentsOf(raw, "DMG")[0]!.elements[1], "19900412", "DOB converted to X12 D8");
});

test("CLM carries the control number and total charge; REF*D9 round-trips the claim id", () => {
  const raw = build837D(CLAIM, NOW);
  const clm = segmentsOf(raw, "CLM")[0]!;

  assert.equal(clm.elements[0], "MRM-000123");
  assert.equal(clm.elements[1], "1425.00");
  assert.equal(clm.elements[4], "11:B:1", "office place of service, original claim frequency");

  const d9 = segmentsOf(raw, "REF").find((s) => s.elements[0] === "D9")!;
  assert.equal(d9.elements[1], CLAIM.claimId);
});

test("each service line emits LX + SV3, and tooth-specific lines emit TOO", () => {
  const raw = build837D(CLAIM, NOW);

  assert.equal(segmentsOf(raw, "LX").length, 3);
  const sv3 = segmentsOf(raw, "SV3");
  assert.equal(sv3.length, 3);
  assert.equal(sv3[2]!.elements[0], "AD:D2750", "AD qualifier + CDT code");
  assert.equal(sv3[2]!.elements[1], "1250.00");
  assert.equal(sv3[2]!.elements[5], "1", "SV306 quantity");

  const too = segmentsOf(raw, "TOO");
  assert.equal(too.length, 1, "only the crown is tooth-specific");
  assert.equal(too[0]!.elements[1], "19");
  assert.equal(too[0]!.elements[2], "MO");
});

test("SE counts the transaction segments and the trailers close the envelope", () => {
  const raw = build837D(CLAIM, NOW);
  const segments = parseSegments(raw);
  const stIndex = segments.findIndex((s) => s.id === "ST");
  const seIndex = segments.findIndex((s) => s.id === "SE");

  assert.equal(segments[seIndex]!.elements[0], String(seIndex - stIndex + 1));
  assert.equal(segments[seIndex]!.elements[1], "0001", "SE02 must match ST02");
  assert.equal(segments.at(-1)!.id, "IEA");
});

test("control numbers are deterministic — a resubmission is recognizable as a duplicate", () => {
  assert.equal(controlNumber("MRM-000123delta-dental"), controlNumber("MRM-000123delta-dental"));
  assert.notEqual(controlNumber("MRM-000123delta-dental"), controlNumber("MRM-000124delta-dental"));
  assert.match(controlNumber("seed"), /^\d{9}$/);
});

test("build277CA → parse277CA round-trips an acceptance", () => {
  const raw = build277CA(
    {
      patientControlNumber: "MRM-000123",
      payerControlNumber: "556677889",
      payerName: "Delta Dental",
      accepted: true,
      statusCategory: "A1",
      statusCode: "19",
      message: "Claim received and accepted for processing.",
      totalCharge: 1425,
    },
    NOW
  );
  const parsed = parse277CA(raw);

  assert.equal(parsed.claims.length, 1);
  const claim = parsed.claims[0]!;
  assert.equal(claim.accepted, true);
  assert.equal(claim.statusCategory, "A1");
  assert.equal(claim.statusCode, "19");
  assert.equal(claim.patientControlNumber, "MRM-000123");
  assert.equal(claim.payerControlNumber, "556677889");
  assert.equal(claim.message, "Claim received and accepted for processing.");
  assert.deepEqual(claim.lineStatuses, []);
});

test("a rejection round-trips with its itemized line errors", () => {
  const raw = build277CA(
    {
      patientControlNumber: "MRM-000123",
      payerControlNumber: "556677889",
      payerName: "Delta Dental",
      accepted: false,
      statusCategory: "A3",
      statusCode: "400",
      message: "One or more service lines were returned as unprocessable.",
      totalCharge: 1425,
      lineErrors: [{ lineNumber: 2, procedureCode: "D1110", code: "400", message: "Line 2 carries no charge." }],
    },
    NOW
  );
  const parsed = parse277CA(raw);

  const claim = parsed.claims[0]!;
  assert.equal(claim.accepted, false);
  assert.equal(claim.statusCategory, "A3");
  assert.equal(claim.lineStatuses.length, 1);
  assert.deepEqual(claim.lineStatuses[0], {
    procedureCode: "D1110",
    lineItemControlNumber: null,
    sequence: 1,
    code: "400",
    message: "Line 2 carries no charge.",
  });
});

test("an unrecognized status category is treated as NOT accepted", () => {
  const raw = build277CA(
    {
      patientControlNumber: "MRM-1",
      payerControlNumber: "1",
      payerName: "Delta Dental",
      accepted: false,
      statusCategory: "ZZ",
      statusCode: "999",
      message: "Unknown status.",
      totalCharge: 100,
    },
    NOW
  );
  assert.equal(parse277CA(raw).claims[0]!.accepted, false, "an unknown status must never read as submitted");
});

/**
 * ── M19: EVERY STATUS BELONGS TO A CLAIM, AND ACCEPTANCE IS UNANIMOUS ──────────────────────────
 *
 * A real 277CA carries STC segments at several hierarchical levels — 2200B for the information
 * receiver (the batch) and 2200D per claim — and may report on many claims at once. The parser used
 * to keep ONE global status and ONE global TRN, both overwritten by whatever came last.
 *
 * These acknowledgements are written out as raw segments rather than built with `build277CA`,
 * because the builder emits exactly one claim: the shape being guarded against is one the builder
 * cannot produce, and a test that can only construct the safe shape proves nothing about the
 * dangerous one.
 */
const MULTI_CLAIM_ACK = [
  "ST*277*0001*005010X214~",
  "BHT*0085*08*0001*20260101*0000*TH~",
  "NM1*PR*2*Delta Dental~",
  // 2200B — the batch was received. Says nothing about any claim inside it.
  "STC*A1:19*20260101*WQ*0.00~",
  "TRN*2*MRM-000123~",
  "STC*A3:33*20260101*U*100.00~",
  "REF*1K*555~",
  "MSG*Subscriber and subscriber id not found.~",
  "TRN*2*MRM-000124~",
  "STC*A1:19*20260101*WQ*200.00~",
  "REF*1K*556~",
  "MSG*Claim received and accepted for processing.~",
  "SE*12*0001~",
].join("");

test("a 277CA reporting on two claims keeps each claim's own outcome", () => {
  const parsed = parse277CA(MULTI_CLAIM_ACK);

  assert.equal(parsed.claims.length, 2);

  const rejected = parsed.claims[0]!;
  assert.equal(rejected.patientControlNumber, "MRM-000123");
  assert.equal(rejected.accepted, false, "the FIRST claim was returned unprocessable and must stay that way");
  assert.equal(rejected.statusCategory, "A3");
  assert.equal(rejected.statusCode, "33");
  assert.equal(rejected.payerControlNumber, "555");
  assert.equal(rejected.message, "Subscriber and subscriber id not found.");

  const accepted = parsed.claims[1]!;
  assert.equal(accepted.patientControlNumber, "MRM-000124");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.payerControlNumber, "556", "REF*1K binds to the claim it follows, not to the file");
});

test("a receiver-level status is not mistaken for a claim's status", () => {
  const parsed = parse277CA(MULTI_CLAIM_ACK);

  assert.deepEqual(parsed.receiverStatus, {
    statusCategory: "A1",
    statusCode: "19",
    message: "",
  });
  // The batch-level A1 must not have made the rejected claim look accepted.
  assert.equal(parsed.claims[0]!.accepted, false);
});

test("an acceptance that follows a rejection on the SAME claim does not overwrite it", () => {
  const raw = [
    "ST*277*0001*005010X214~",
    "NM1*PR*2*Delta Dental~",
    "TRN*2*MRM-000123~",
    "STC*A3:33*20260101*U*100.00~",
    // A second claim-level status, accepting. Last-STC-wins would read the claim as filed.
    "STC*A1:19*20260101*WQ*100.00~",
    "SE*6*0001~",
  ].join("");

  const claim = parse277CA(raw).claims[0]!;
  assert.equal(claim.accepted, false, "acceptance is unanimous — one A3 is enough to refuse");
  assert.equal(claim.statusCategory, "A3", "the status reported is the one a biller has to act on");
  assert.equal(claim.statusCode, "33");
});

test("ackForClaim answers about the claim that was submitted, and refuses to guess", () => {
  const parsed = parse277CA(MULTI_CLAIM_ACK);

  assert.equal(ackForClaim(parsed, "MRM-000124")?.accepted, true);
  assert.equal(ackForClaim(parsed, "MRM-000123")?.accepted, false);
  assert.equal(
    ackForClaim(parsed, "MRM-999999"),
    null,
    "an ack about other people's claims is not evidence about ours"
  );
});

test("a single-claim ack is still returned when the payer echoed a different number, so the M10 guard sees it", () => {
  const raw = build277CA(
    {
      patientControlNumber: "MRM-000999",
      payerControlNumber: "1",
      payerName: "Delta Dental",
      accepted: true,
      statusCategory: "A1",
      statusCode: "19",
      message: "Accepted.",
      totalCharge: 100,
    },
    NOW
  );
  const selected = ackForClaim(parse277CA(raw), "MRM-000123");
  assert.equal(
    selected?.patientControlNumber,
    "MRM-000999",
    "the mismatch is ClaimService's to refuse, with a message a biller can act on"
  );
});

test("parse277CA fails loud on a non-277 payload, on empty input, and on a 277 with no status", () => {
  assert.throws(() => parse277CA(""), /Empty EDI payload/);
  assert.throws(() => parse277CA(build837D(CLAIM, NOW)), /not an X12 277/);
  assert.throws(() => parse277CA("ST*277*0001*005010X214~SE*2*0001~"), /no STC status segments/);
});

// ── Sweep: no element may carry a delimiter ────────────────────────────────────────────────────
//
// `build837D` already refused a CLM01 containing `*` or `~`, and its comment gave the reason: such a
// value splits the segment and produces "a structurally different claim than the one authorised".
// That reasoning was never applied to any other element, and every other element is interpolated the
// same way — subscriber names and addresses come from what someone typed at check-in.
//
// The consequence is worse than a rejection. An extra `*` shifts every following element by one
// position, so a payer reads a WELL-FORMED claim that says something else; a `~` ends the segment
// early. Our own parser round-trips the corruption happily, which is why no fixture ever caught it.

test("a subscriber name carrying an element separator is refused, not silently shifted", () => {
  /**
   * Without the guard this rendered `NM1*IL*1*AL*PHA*Ada*...`, which parses cleanly as a claim whose
   * NM104 is "PHA" and whose member-ID qualifier has moved two positions along.
   */
  assert.throws(
    () => build837D({ ...CLAIM, subscriberLastName: "AL*PHA" }, NOW),
    /contains a delimiter/,
    "an element separator inside a name must stop the claim"
  );
});

test("a segment terminator anywhere in the claim is refused", () => {
  for (const patch of [
    { subscriberFirstName: "Ada~" },
    { memberId: "ABC~12345" },
    { billingProviderName: "FIXTURE~DENTAL" },
    { payerName: "Delta~Dental" },
  ]) {
    assert.throws(() => build837D({ ...CLAIM, ...patch }, NOW), /contains a delimiter/, JSON.stringify(patch));
  }
});

test("the refusal names the segment and element position it found", () => {
  // A biller or an operator has to be able to find the offending field without reading the codec.
  assert.throws(
    () => build837D({ ...CLAIM, memberId: "ABC*123" }, NOW),
    (err: Error) => /NM1\d\d? contains a delimiter/.test(err.message) && err.message.includes('"ABC*123"')
  );
});

test("a component separator is still allowed — composites are built with it", () => {
  // CLM05 is "11:B:1" and SV301 is "AD:D0120". A guard that rejected ":" would refuse every claim.
  const raw = build837D(CLAIM, NOW);
  assert.equal(segmentsOf(raw, "CLM")[0]!.elements[4], "11:B:1");
  assert.ok(raw.includes("AD:D0120"));
});

test("a clean claim is unaffected — every fixture value still renders", () => {
  const raw = build837D(CLAIM, NOW);
  assert.ok(raw.startsWith("ISA*"));
  assert.equal(segmentsOf(raw, "NM1").find((s) => s.elements[0] === "IL")!.elements[2], "Alpha");
});

// ── DEC-1 — a 277CA names a procedure, not one of our line numbers ─────────────────────────────
//
// `build277CA` used to emit `SVC*AD:LINE2` and `parse277CA` read it back with /LINE(\d+)/. The mock
// parsed its own invention perfectly, which is exactly why nothing caught that a real payer puts the
// PROCEDURE in SVC01. On the live Stedi path the pattern never matched, so a line-level STC was
// folded into the claim's own statuses: an acknowledgement accepting the claim while rejecting one
// line read as a rejected claim with no line errors, and the practice refiled a claim the payer
// already held — the CARC 18 duplicate the REF*F8 guard exists to prevent.
//
// Attribution now happens against the lines actually submitted, and refuses where the evidence does
// not single one out.

const LINES = (codes: string[]) => codes.map((procedureCode, i) => ({ lineNumber: i + 1, procedureCode }));

const status = (over: Partial<Parameters<typeof attributeLineStatuses>[0][number]> = {}) => ({
  procedureCode: "D0120",
  lineItemControlNumber: null,
  sequence: 1,
  code: "400",
  message: "unprocessable",
  ...over,
});

test("DEC-1: a unique procedure code attributes to its line", () => {
  const { attributed, unattributed } = attributeLineStatuses(
    [status({ procedureCode: "D2750" })],
    LINES(["D0120", "D1110", "D2750"])
  );

  assert.equal(unattributed.length, 0);
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0]!.lineNumber, 3);
  assert.equal(attributed[0]!.procedureCode, "D2750");
  assert.equal(attributed[0]!.matchedBy, "unique-procedure-code");
});

test("DEC-1: a duplicated procedure attributes by sequence when the counts align", () => {
  // Two D2391 lines, and the payer reported two D2391 statuses. The k-th reported is the k-th
  // submitted — deterministic, and the only alignment the evidence supports.
  const { attributed, unattributed } = attributeLineStatuses(
    [
      status({ procedureCode: "D2391", sequence: 1, message: "first" }),
      status({ procedureCode: "D2391", sequence: 2, message: "second" }),
    ],
    LINES(["D2391", "D0120", "D2391"])
  );

  assert.equal(unattributed.length, 0);
  assert.deepEqual(attributed.map((a) => a.lineNumber), [1, 3]);
  assert.deepEqual(attributed.map((a) => a.message), ["first", "second"]);
  assert.ok(attributed.every((a) => a.matchedBy === "procedure-code-sequence"));
});

test("DEC-1: a duplicated procedure with nothing to disambiguate is NOT guessed at", () => {
  /**
   * The case the whole decision turns on. Two D2391 lines, ONE reported status: the payer has not
   * said which. Assigning it to the first match would send a biller to correct a line the payer
   * never complained about — they refile, and are rejected again for the line they never touched.
   */
  const { attributed, unattributed } = attributeLineStatuses(
    [status({ procedureCode: "D2391" })],
    LINES(["D2391", "D2391"])
  );

  assert.equal(attributed.length, 0, "no line may be picked from two equally likely ones");
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0]!.reason, "ambiguous-duplicate-procedure");
  assert.equal(unattributed[0]!.procedureCode, "D2391");
  assert.equal(unattributed[0]!.sequence, 1, "the payer's own ordering is preserved for the reader");
});

test("DEC-1: a procedure this claim does not carry is unattributable, not invented", () => {
  const { attributed, unattributed } = attributeLineStatuses(
    [status({ procedureCode: "D9999" })],
    LINES(["D0120", "D1110"])
  );

  assert.equal(attributed.length, 0);
  assert.equal(unattributed[0]!.reason, "unknown-procedure-code");
});

test("DEC-1: an unreadable SVC01 is unattributable rather than dropped", () => {
  const { attributed, unattributed } = attributeLineStatuses(
    [status({ procedureCode: null })],
    LINES(["D0120"])
  );

  assert.equal(attributed.length, 0);
  assert.equal(unattributed[0]!.reason, "no-procedure-code");
  assert.equal(unattributed[0]!.message, "unprocessable", "the payer's own words survive for a human");
});

test("DEC-1: an echoed line control number beats everything, including a duplicate", () => {
  // REF*6R is the payer handing back OUR identifier. Mermaid does not send one today, but a
  // clearinghouse that supplies it removes the ambiguity entirely, and discarding it would force a
  // guess where none was needed.
  const { attributed, unattributed } = attributeLineStatuses(
    [status({ procedureCode: "D2391", lineItemControlNumber: "2" })],
    LINES(["D2391", "D2391"])
  );

  assert.equal(unattributed.length, 0);
  assert.equal(attributed[0]!.lineNumber, 2);
  assert.equal(attributed[0]!.matchedBy, "line-control-number");
});

test("DEC-1: real Stedi-shaped SVC*AD:D0120 parses as a line status, not a claim status", () => {
  /**
   * The shape that broke it. Built by hand rather than through `build277CA`, because the mock is
   * what caused the defect and cannot be the witness for its own fix.
   */
  const raw = [
    "ST*277*0001*005010X214~",
    "BHT*0085*08*ACK1*20260727*0000*TH~",
    "NM1*PR*2*Delta Dental~",
    "TRN*2*MRM-000123~",
    "STC*A1:19*20260727*WQ*1425.00~",
    "REF*1K*PAYER-777~",
    "SVC*AD:D0120*65.00~",
    "STC*A7:400*20260727*U*65.00********Missing tooth number.~",
    "SE*8*0001~",
  ].join("");

  const parsed = parse277CA(raw);
  const claim = ackForClaim(parsed, "MRM-000123")!;

  // The claim itself was ACCEPTED. Before this, the line's A7 was read as a claim-level status and
  // flipped the whole claim to rejected with no line errors at all.
  assert.equal(claim.accepted, true, "a line-level rejection is not a claim-level one");
  assert.equal(claim.statusCategory, "A1");
  assert.equal(claim.lineStatuses.length, 1);
  assert.equal(claim.lineStatuses[0]!.procedureCode, "D0120");
  assert.equal(claim.lineStatuses[0]!.sequence, 1);
  assert.equal(claim.lineStatuses[0]!.message, "Missing tooth number.");

  const { attributed } = attributeLineStatuses(claim.lineStatuses, LINES(["D0120", "D1110"]));
  assert.equal(attributed[0]!.lineNumber, 1);
});

test("DEC-1: claim-level and line-level statuses stay separate on one acknowledgement", () => {
  const raw = [
    "ST*277*0001*005010X214~",
    "BHT*0085*08*ACK1*20260727*0000*TH~",
    "NM1*PR*2*Delta Dental~",
    "STC*A1:20*20260727*WQ*0.00~", // 2200B — the batch, not any claim
    "TRN*2*MRM-000123~",
    "STC*A3:33*20260727*U*1425.00~", // the claim itself
    "SVC*AD:D2750*1250.00~",
    "STC*A7:456*20260727*U*1250.00********Tooth number missing.~",
    "SE*9*0001~",
  ].join("");

  const parsed = parse277CA(raw);
  assert.equal(parsed.receiverStatus?.statusCategory, "A1", "the batch status belongs to the batch");

  const claim = ackForClaim(parsed, "MRM-000123")!;
  assert.equal(claim.accepted, false, "the claim's own A3 stands");
  assert.equal(claim.statusCategory, "A3");
  assert.equal(claim.lineStatuses.length, 1, "and the line status is not counted among them");
  assert.equal(claim.lineStatuses[0]!.code, "456");
});

test("the billing provider's taxonomy is PRV*BI*PXC in loop 2000A, between HL*1 and the billing NM1", () => {
  /**
   * Stedi's payer edits, 2026-10-15: "Missing Billing Provider taxonomy code. This code is required
   * when no rendering provider or assistant surgeon is reported" (277CA A6:145:85). With this
   * segment the same test claim cleared the edits; without it, it never could.
   */
  const segs = parseSegments(build837D({ ...CLAIM, billingProviderTaxonomy: "1223G0001X" }, NOW));
  const hl1 = segs.findIndex((s) => s.id === "HL" && s.elements[0] === "1");
  assert.deepEqual(segs[hl1 + 1], { id: "PRV", elements: ["BI", "PXC", "1223G0001X"] });
  assert.equal(segs[hl1 + 2]!.id, "NM1");
  assert.equal(segs[hl1 + 2]!.elements[0], "85");

  // And SE still counts every segment it carries.
  const se = segs.find((s) => s.id === "SE")!;
  const st = segs.findIndex((s) => s.id === "ST");
  assert.equal(Number(se.elements[0]), segs.indexOf(se) - st + 1);
});

test("with no taxonomy configured the claim's bytes are exactly what they always were", () => {
  assert.equal(build837D({ ...CLAIM }, NOW), build837D({ ...CLAIM, billingProviderTaxonomy: "" }, NOW));
  assert.equal(segmentsOf(build837D(CLAIM, NOW), "PRV").length, 0);
});
