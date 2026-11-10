/**
 * 835 interchange handling — several transaction sets in one file, and the payee's identity.
 *
 * ── WHAT THESE COVER, AND WHY IT WAS INVISIBLE ─────────────────────────────────────────────────
 * `parse835` used to find the FIRST `ST` and then read every segment in the payload. A file holding
 * three cheques therefore produced ONE result: `payment` and `trace` overwritten by each successive
 * BPR/TRN — last wins — and every CLP from every set in a single claims array. The second `ST` was
 * not even recorded as skipped.
 *
 * Nothing caught it because the mock builds one transaction set per call, so the codec was only
 * ever tested against its own writer — the exact failure mode that let five mandatory 837D segments
 * stay missing until a real clearinghouse rejected them. Every multi-set payload here is therefore
 * assembled by CONCATENATING built interchanges, which is what a clearinghouse actually hands over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build835, parse835, parse835All, parseSegments, type Build835Claim } from "../mock/x12-835.ts";

const NOW = new Date("2026-08-10T09:00:00Z");

const line = (procedureCode: string, charged: number, paid: number) => ({
  procedureCode,
  charged,
  paid,
  quantity: 1,
  ...(charged === paid ? {} : { adjustments: [{ group: "CO", code: "45", amount: charged - paid }] }),
});

function claim(patientControlNumber: string, charged: number, paid: number): Build835Claim {
  return {
    patientControlNumber,
    payerControlNumber: `PAYER-${patientControlNumber}`,
    statusCode: charged === paid ? "1" : "2",
    charged,
    paid,
    patientResponsibility: 0,
    patientFirstName: "Ada",
    patientLastName: "Alpha",
    memberId: "ABC12345",
    lines: [line("D0120", charged, paid)],
  };
}

/** One complete interchange — ISA through IEA — carrying a single 835. */
const cheque = (traceNumber: string, payerName: string, claims: Build835Claim[], total: number, payeeNpi?: string) =>
  build835(
    {
      payerName,
      payeeName: "MERMAID DEMO DENTAL",
      ...(payeeNpi ? { payeeNpi } : {}),
      traceNumber,
      paymentTotal: total,
      paymentDate: "2026-08-10",
      claims,
    },
    NOW
  );

// ── A synthetic file must never claim to be a real one ───────────────────────────────────────────

test("every generated 835 declares itself TEST data in ISA15", () => {
  /**
   * ── WHY THIS FIELD, ON THIS GENERATOR ─────────────────────────────────────────────────────────
   * ISA15 is the one element in an interchange that states whether it is production or test data.
   * This generator exists to produce synthetic advices, and it hardcoded `P`.
   *
   * That is not cosmetic, because Mermaid RETAINS the raw 835 — encrypted — as the evidence for
   * money it posted, and `reconcileAll` re-derives the payer's own total from it. The artefact kept
   * to prove what a payer said was itself asserting it came from a real payer. Someone auditing a
   * balance months later, or any tool separating real advices from fixtures, would have been
   * reading a file that lied about its own provenance. It was found on live staging, on the file
   * settling Pia Phase32's appeal.
   *
   * The Stedi adapter already holds this line — `usageIndicator: testMode ? "T" : "P"` — and
   * refuses to start when the flag and the credential disagree. The mock produces far more of this
   * system's stored 835s and had no such discipline.
   */
  const isa = cheque("EFT1", "Delta Dental", [claim("MRM-000001", 6500, 6500)], 6500)
    .split("~")[0]!
    .split("*");
  assert.equal(isa[15], "T", `ISA15 must be T on a generated file, got "${isa[15]}"`);
  assert.equal(isa[0], "ISA", "sanity: the first segment is the interchange header");
});

// ── The delimiters are the PAYER'S, not ours ─────────────────────────────────────────────────────
//
// X12 does not fix the delimiters; the ISA header declares them and every reader is required to take
// them from there. This codec hard-coded `*` and `~` — the set Mermaid's own builder writes — so it
// round-tripped its own output perfectly and rejected a real payer's file that used any other legal
// set. That is not a cosmetic incompatibility: `parse835All` throws "Payload is not an X12 835
// transaction", the ERA worker records a PERMANENT parse failure, the artifact dead-letters, and the
// payer's money never reaches the ledger.
//
// Built by hand rather than through `build835`, deliberately — a codec tested only against its own
// writer is exactly how five mandatory 837D segments stayed missing until a clearinghouse rejected
// them.

/** The same cheque, written with the OTHER common legal delimiter set, declared in its ISA. */
const PIPE_DELIMITED_835 =
  "ISA|00|          |00|          |ZZ|SENDER         |ZZ|RECEIVER       |260810|1200|^|00501|000000001|0|T|^\n" +
  [
    "GS|HP|SENDER|RECEIVER|20260810|1200|1|X|005010X221A1",
    "ST|835|0001",
    "BPR|I|100.00|C|ACH|||||||||||20260810",
    "TRN|1|EFT100200300|1999999992",
    "N1|PR|DELTA DENTAL",
    "N1|PE|MERMAID DEMO DENTAL|XX|1234567893",
    "CLP|MRM-000123|1|150.00|100.00|50.00||556677889",
    "NM1|QC|1|ALPHA|ADA||||MI|ABC12345",
    "SVC|AD^D0120|150.00|100.00||1",
    "CAS|PR|1|50.00",
    "SE|10|0001",
    "GE|1|1",
    "IEA|1|000000001",
  ].join("\n");

test("a payer's own delimiters are read from the ISA header, not assumed to be ours", () => {
  const [advice] = parse835All(PIPE_DELIMITED_835);
  assert.ok(advice, "a legal 835 must not be rejected for choosing legal delimiters");

  // Every field that decides where money goes has to survive the other delimiter set intact.
  assert.equal(advice!.payment!.total, 10_000, "$100.00 in cents");
  assert.equal(advice!.trace!.number, "EFT100200300", "the trace IS the idempotency key");
  assert.equal(advice!.payerName, "DELTA DENTAL");
  assert.equal(advice!.payeeId, "1234567893", "the payee cross-check has nothing to compare without this");
  assert.equal(advice!.claims.length, 1);
  assert.equal(advice!.claims[0]!.patientControlNumber, "MRM-000123", "the claim match key");
  assert.equal(advice!.claims[0]!.charged, 15_000);
  assert.equal(advice!.claims[0]!.paid, 10_000);
  assert.equal(advice!.claims[0]!.patientResponsibility, 5_000);

  // The `^` component separator: a composite read with the wrong one comes back unsplit, turning
  // `AD^D0120` into a procedure code no catalog holds.
  assert.equal(advice!.claims[0]!.lines[0]!.procedureCode, "D0120");

  // And the arithmetic still has to add up, which is what proves nothing was quietly dropped.
  assert.equal(advice!.balanced, true, `unexpected issues: ${advice!.issues.join(" | ")}`);
});

test("a payload with no parseable ISA still reads with Mermaid's own delimiters", () => {
  // Every codec test builds bare segment fragments, and the mock's 271 has no ISA either. The
  // fallback is what keeps those working, so it is asserted rather than assumed.
  const segments = parseSegments("ST*835*0001~BPR*I*100.00*C*ACH~SE*2*0001~");
  assert.deepEqual(
    segments.map((s) => s.id),
    ["ST", "BPR", "SE"]
  );
  assert.equal(segments[1]!.elements[1], "100.00");
});

// ── Multiple transaction sets ────────────────────────────────────────────────────────────────────

test("a file carrying two cheques is REFUSED by parse835 rather than merged", () => {
  const file = cheque("EFT-AAA", "Delta Dental", [claim("MRM-A", 100, 100)], 100) +
    cheque("EFT-BBB", "Cigna Dental", [claim("MRM-B", 200, 200)], 200);

  assert.throws(
    () => parse835(file),
    (e: unknown) =>
      e instanceof Error &&
      /2 separate 835 transaction sets/.test(e.message) &&
      /parse835All/.test(e.message),
    "the refusal must say how many payments are in the file and what to call instead"
  );
});

test("parse835All keeps each cheque's money entirely separate — the actual defect", () => {
  const file = cheque("EFT-AAA", "Delta Dental", [claim("MRM-A", 100, 100)], 100) +
    cheque("EFT-BBB", "Cigna Dental", [claim("MRM-B", 200, 200)], 200);

  const sets = parse835All(file);
  assert.equal(sets.length, 2);

  // Under the old parser BOTH of these read EFT-BBB / Cigna / $200 with all three claims attached,
  // because the last BPR and TRN overwrote the first. Asserting VALUES, not just the count.
  assert.equal(sets[0]!.trace?.number, "EFT-AAA");
  assert.equal(sets[0]!.payerName, "Delta Dental");
  assert.equal(sets[0]!.payment?.total, 10_000);
  assert.deepEqual(sets[0]!.claims.map((c) => c.patientControlNumber), ["MRM-A"]);

  assert.equal(sets[1]!.trace?.number, "EFT-BBB");
  assert.equal(sets[1]!.payerName, "Cigna Dental");
  assert.equal(sets[1]!.payment?.total, 20_000);
  assert.deepEqual(sets[1]!.claims.map((c) => c.patientControlNumber), ["MRM-B"]);

  // And each balances on its own. A merged read would have compared one BPR against every claim.
  assert.ok(sets.every((s) => s.balanced), "each cheque must balance independently");
});

test("claims never leak between transaction sets, even when the file is large", () => {
  const file =
    cheque("EFT-1", "Delta Dental", [claim("MRM-1", 100, 100), claim("MRM-2", 50, 50)], 150) +
    cheque("EFT-2", "Cigna Dental", [claim("MRM-3", 75, 75)], 75) +
    cheque("EFT-3", "Aetna", [claim("MRM-4", 20, 20), claim("MRM-5", 30, 30)], 50);

  const sets = parse835All(file);
  assert.equal(sets.length, 3);
  assert.deepEqual(
    sets.map((s) => s.claims.map((c) => c.patientControlNumber)),
    [["MRM-1", "MRM-2"], ["MRM-3"], ["MRM-4", "MRM-5"]]
  );
  assert.deepEqual(sets.map((s) => s.trace?.number), ["EFT-1", "EFT-2", "EFT-3"]);
  assert.deepEqual(sets.map((s) => s.payment?.total), [15_000, 7_500, 5_000]);
});

test("a single-cheque file still parses through parse835 unchanged", () => {
  // The common case must not have been made harder to reach by the refusal above.
  const one = cheque("EFT-SOLO", "Delta Dental", [claim("MRM-S", 100, 100)], 100);
  const parsed = parse835(one);
  assert.equal(parsed.trace?.number, "EFT-SOLO");
  assert.equal(parsed.claims.length, 1);
  assert.ok(parsed.balanced);
  assert.deepEqual(parse835All(one), [parsed]);
});

test("an interchange mixing an 835 with another transaction set is refused, not filtered", () => {
  // Silently keeping only the 835s would discard a 277CA riding in the same file without a word.
  const mixed = cheque("EFT-AAA", "Delta Dental", [claim("MRM-A", 100, 100)], 100).replace(
    "ST*835*0001~",
    "ST*277*0001~ST*835*0001~"
  );
  assert.throws(() => parse835All(mixed), /mixes 835 remittances with other transaction sets/);
});

test("empty and non-835 payloads still throw, and neither parser invents a result", () => {
  for (const parse of [parse835, parse835All]) {
    assert.throws(() => parse(""), /Empty EDI payload/);
    assert.throws(() => parse("   "), /Empty EDI payload/);
    assert.throws(() => parse("ST*277*0001~SE*2*0001~"), /not an X12 835/);
  }
});

// ── Payee identity (N1*PE) ───────────────────────────────────────────────────────────────────────

test("the payee's NPI and its qualifier are read off real X12, not left permanently empty", () => {
  /**
   * The V6 lesson applied: a field that is ALWAYS empty is indistinguishable from "the payer did
   * not say". So this drives a real id through the builder and asserts the VALUE that comes out,
   * rather than only checking that the property exists.
   */
  const raw = cheque("EFT-NPI", "Delta Dental", [claim("MRM-N", 100, 100)], 100, "1234567893");
  assert.match(raw, /N1\*PE\*MERMAID DEMO DENTAL\*XX\*1234567893~/);

  const parsed = parse835(raw);
  assert.equal(parsed.payeeId, "1234567893");
  assert.equal(parsed.payeeIdQualifier, "XX");
  assert.equal(parsed.payeeName, "MERMAID DEMO DENTAL");
});

test("a payer who sends a bare payee name is still read, and emits no dangling qualifier", () => {
  const raw = cheque("EFT-BARE", "Delta Dental", [claim("MRM-B", 100, 100)], 100);
  // An N1 carrying a qualifier with nothing behind it is malformed — the omission must be total.
  const n1 = parseSegments(raw).find((s) => s.id === "N1" && s.elements[0] === "PE");
  assert.deepEqual(n1?.elements, ["PE", "MERMAID DEMO DENTAL"]);

  const parsed = parse835(raw);
  assert.equal(parsed.payeeName, "MERMAID DEMO DENTAL");
  assert.equal(parsed.payeeId, "", "absent is empty, and empty is honest");
  assert.equal(parsed.payeeIdQualifier, "");
});

test("each transaction set carries its OWN payee, so a batch cannot misattribute one", () => {
  // The routing case this field exists for: a clearinghouse batch addressed to two practices.
  const file =
    cheque("EFT-P1", "Delta Dental", [claim("MRM-1", 100, 100)], 100, "1234567893") +
    cheque("EFT-P2", "Delta Dental", [claim("MRM-2", 100, 100)], 100, "1999999992");

  const sets = parse835All(file);
  assert.deepEqual(sets.map((s) => s.payeeId), ["1234567893", "1999999992"]);
});
