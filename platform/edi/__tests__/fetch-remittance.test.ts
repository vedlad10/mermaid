/**
 * MockEdiAdapter remittance tests — the adapter boundary, not the wire format.
 *
 * Two things these guard. First, that every synthesized advice BALANCES: if the fake payer could
 * emit an unbalanced 835, the parser's balance assertions would be testing the builder rather than
 * the parser, and the remittance module's money-safety gate would be untested. Second, that
 * adjustments arrive already CATEGORIZED — the difference between "write this off" and "chase this"
 * is the module's whole reason to exist, and it must not be re-derived downstream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { MockEdiAdapter } from "../mock/index.ts";
import type { RemittanceRequest, RemittanceRequestClaim } from "../adapter.ts";

const adapter = new MockEdiAdapter();

function claim(memberId: string, overrides: Partial<RemittanceRequestClaim> = {}): RemittanceRequestClaim {
  return {
    patientControlNumber: "MRM-000123",
    payerControlNumber: "556677889",
    patientFirstName: "Ada",
    patientLastName: "Alpha",
    memberId,
    lines: [
      { procedureCode: "D0120", charged: cents(65), quantity: 1 },
      { procedureCode: "D1110", charged: cents(110), quantity: 1 },
      { procedureCode: "D2750", charged: cents(1250), quantity: 1 },
    ],
    expectedInsurancePays: cents(800),
    ...overrides,
  };
}

const request = (claims: RemittanceRequestClaim[]): RemittanceRequest => ({
  payerId: "delta-dental",
  payerName: "Delta Dental",
  payeeName: "MERMAID DEMO DENTAL",
  paymentDate: "2026-08-10",
  claims,
});

async function fetchOne(c: RemittanceRequestClaim) {
  const result = await adapter.fetchRemittance(request([c]));
  assert.equal(result.ok, true);
  const advice = result.data![0]!;
  return { advice, claim: advice.claims[0]! };
}

test("a normal claim is paid, and the advice balances exactly", async () => {
  const { advice, claim: c } = await fetchOne(claim("ABC12345"));

  assert.equal(advice.balanced, true, `unexpected issues: ${advice.issues.join(" | ")}`);
  assert.equal(advice.traceNumber.startsWith("EFT"), true);
  assert.equal(advice.paymentMethod, "ACH");
  assert.equal(advice.paymentDate, "2026-08-10");
  assert.equal(advice.paymentTotal, c.paid);
  assert.equal(c.disposition, "partial");
  assert.ok(c.paid > 0);
  // The identity every posting depends on.
  const adjustments = c.adjustments.reduce((sum, a) => sum + a.amount, 0);
  assert.equal(c.paid + adjustments, c.charged);
});

test("adjustments arrive categorized: contractual, patient, recoverable", async () => {
  const { claim: c } = await fetchOne(claim("ABC12345"));

  const contractual = c.adjustments.filter((a) => a.category === "contractual");
  assert.ok(contractual.length > 0);
  assert.equal(contractual[0]!.code, "45");
  assert.equal(contractual[0]!.description, "Charge exceeds fee schedule (contractual)");

  const patient = c.adjustments.filter((a) => a.category === "patient");
  assert.ok(patient.length > 0, "coinsurance is the patient's to pay");
  assert.equal(patient[0]!.code, "2");

  assert.equal(c.adjustments.filter((a) => a.category === "recoverable").length, 0, "a clean claim has nothing to chase");
});

test("member ID ending 00 → whole claim denied as coverage terminated (patient's balance)", async () => {
  const { advice, claim: c } = await fetchOne(claim("MEM10000"));

  assert.equal(advice.balanced, true);
  assert.equal(c.disposition, "denied");
  assert.equal(c.paid, 0);
  assert.equal(advice.paymentTotal, 0);
  // One CO-27 per line, as a payer itemizes it — together they account for the whole charge.
  const termination = c.adjustments.filter((a) => a.code === "27");
  assert.equal(termination.length, c.lines.length);
  assert.equal(termination.reduce((sum, a) => sum + a.amount, 0), c.charged);
  assert.ok(termination.every((a) => a.category === "patient"), "coverage had ended — the payer owes nothing");
  assert.deepEqual(c.remarks.map((r) => r.code), ["N130"]);
});

test("member ID ending 77 → the crown is denied for a missing pre-auth (RECOVERABLE)", async () => {
  const { advice, claim: c } = await fetchOne(claim("MET30077"));

  assert.equal(advice.balanced, true);
  const preAuth = c.adjustments.find((a) => a.code === "197")!;
  assert.equal(preAuth.category, "recoverable", "this is money a clinic can actually chase");
  assert.equal(preAuth.procedureCode, "D2750", "the payer picked a fight over the highest-charge line");
  assert.equal(preAuth.amount, cents(1125), "the allowed amount, after the contractual reduction");
  assert.equal(c.lines.find((l) => l.procedureCode === "D2750")!.paid, 0);
  assert.ok(c.paid > 0, "the other lines were still paid");
  assert.deepEqual(c.remarks.map((r) => r.code), ["N54"]);
});

test("member ID ending 99 → benefit maximum reached; the shortfall is the patient's", async () => {
  const { advice, claim: c } = await fetchOne(claim("CIG20099"));

  assert.equal(advice.balanced, true);
  const benefitMax = c.adjustments.find((a) => a.code === "119")!;
  assert.equal(benefitMax.category, "patient", "CO-119 is the patient's to pay despite the CO group");
  assert.ok(c.paid > 0 && c.paid < cents(800), "only part of what was expected");
  assert.equal(c.adjustments.filter((a) => a.category === "recoverable").length, 0);
});

test("every mock scenario produces a balanced advice", async () => {
  for (const memberId of ["ABC12345", "MEM10000", "MET30077", "CIG20099", "AET40123"]) {
    const { advice } = await fetchOne(claim(memberId));
    assert.equal(advice.balanced, true, `${memberId} produced an unbalanced advice: ${advice.issues.join(" | ")}`);
  }
});

test("several claims are remitted in one advice, and the payment total is their sum", async () => {
  const result = await adapter.fetchRemittance(
    request([
      claim("ABC12345"),
      claim("CIG20099", { patientControlNumber: "MRM-000456", payerControlNumber: "556677890" }),
    ])
  );
  const advice = result.data![0]!;

  assert.equal(advice.claims.length, 2);
  assert.equal(advice.balanced, true);
  assert.equal(advice.paymentTotal, advice.claims.reduce((sum, c) => sum + c.paid, 0));
});

test("fetching with no claims returns no advices rather than an empty payment", async () => {
  const result = await adapter.fetchRemittance(request([]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, []);
});

test("the trace number is deterministic — the same fetch is recognisably the same remittance", async () => {
  const a = await adapter.fetchRemittance(request([claim("ABC12345")]));
  const b = await adapter.fetchRemittance(request([claim("ABC12345")]));
  assert.equal(a.data![0]!.traceNumber, b.data![0]!.traceNumber);

  const other = await adapter.fetchRemittance(request([claim("ABC12345", { patientControlNumber: "MRM-999" })]));
  assert.notEqual(a.data![0]!.traceNumber, other.data![0]!.traceNumber);
});

test("parseRemittance normalizes an 835 the clinic already holds", async () => {
  const fetched = await adapter.fetchRemittance(request([claim("ABC12345")]));
  const raw = fetched.raw!;

  const parsed = adapter.parseRemittance(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data!.traceNumber, fetched.data![0]!.traceNumber);
  assert.deepEqual(parsed.data, fetched.data![0], "one code path for money, however the file arrived");
});

test("parseRemittance reports a bad payload as a transport-level parse error", () => {
  const notAnEra = adapter.parseRemittance("ST*837*0001*005010X224A2~SE*2*0001~");
  assert.equal(notAnEra.ok, false);
  assert.equal(notAnEra.error!.code, "parse_error");
  assert.equal(notAnEra.error!.retryable, false);

  assert.equal(adapter.parseRemittance("").ok, false);
});

test("an unbalanced 835 still comes back ok:true — it is a real file a human must reconcile", async () => {
  const fetched = await adapter.fetchRemittance(request([claim("ABC12345")]));
  const tampered = fetched.raw!.replace(/CAS\*PR\*2\*([\d.]+)\*/, "CAS*PR*2*1.00*");

  const parsed = adapter.parseRemittance(tampered);
  assert.equal(parsed.ok, true, "refusing to post is the module's decision, not the adapter's");
  assert.equal(parsed.data!.balanced, false);
  assert.ok(parsed.data!.issues.length > 0);
  assert.ok(parsed.data!.paymentTotal > 0, "the payment information survives");
});

test("an impossible BPR16 payment date is stored as no date, and the money is still read and balanced", async () => {
  /**
   * `remittances.payment_date` is a DATE column. A payer's impossible date (a public 835 sample
   * carries `20002316`, month 23) used to pass through as "2000-23-16" and would have failed the
   * INSERT, taking the whole ERA's ingest with it.
   */
  const fetched = await adapter.fetchRemittance(request([claim("ABC12345")]));
  const raw = fetched.raw!.replace(/(BPR\*[^~]*\*)(\d{8})~/, "$120262316~");
  assert.notEqual(raw, fetched.raw, "the fixture must actually carry the bad date");

  const parsed = adapter.parseRemittance(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data!.paymentDate, "", "no date rather than a date Postgres refuses");
  assert.equal(parsed.data!.balanced, true, "a bad date is not an arithmetic failure — the gate must still be able to release it");
  assert.equal(parsed.data!.paymentTotal, fetched.data![0]!.paymentTotal);
});
