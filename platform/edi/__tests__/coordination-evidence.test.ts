/**
 * What a payer says about another plan, read from its own EDI — and nothing it did not say.
 *
 *   835 (005010X221A1) loop 2100 `NM1*TT` — the crossover carrier: the plan the payer forwarded to.
 *   271 (005010X279A1) `EB*R` with loop 2120 (`LS*2120` … `LE*2120`) — other or additional payer.
 *
 * Both are EVIDENCE for the person confirming coverage. Absent segments must produce absent
 * fields, never a guess; and an other-payer loop must never be mistaken for the payer itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOCK_OTHER_PLAN, MockEdiAdapter, holdsOtherCoverage } from "../mock/index.ts";
import { parse271 } from "../mock/x12-271.ts";

const edi = new MockEdiAdapter();

// ── 835: the crossover carrier ────────────────────────────────────────────────────────────────

const advice = (extra: string[] = []) =>
  [
    "ISA*00*          *00*          *ZZ*Cigna Dental   *ZZ*CLINIC         *260901*0000*^*00501*000000001*0*P*:",
    "GS*HP*Cigna Dental*CLINIC*20260901*0000*1*X*005010X221A1",
    "ST*835*0001",
    "BPR*I*799.99*C*ACH************20260901",
    "TRN*1*EFTXOVER1*Cigna Dent",
    "N1*PR*Cigna Dental",
    "N1*PE*MERMAID DEMO DENTAL",
    "CLP*MRM-XOVER1*19*1425.00*799.99*0.00*CI*333273831",
    "NM1*QC*1*Demo*Kira****MI*DEMO0123",
    ...extra,
    "SVC*AD:D2750*1425.00*799.99**1",
    "CAS*CO*45*142.50",
    "CAS*OA*23*482.51",
    "SE*11*0001",
    "GE*1*1",
    "IEA*1*000000001",
  ].join("~") + "~";

test("835: a named crossover carrier is captured exactly as sent", () => {
  const parsed = edi.parseRemittance(advice(["NM1*TT*2*DELTA DENTAL OF CALIFORNIA*****PI*94276"]));
  assert.ok(parsed.ok, parsed.error?.message);
  assert.deepEqual(parsed.data!.claims[0]!.crossoverCarrier, { name: "DELTA DENTAL OF CALIFORNIA", idQualifier: "PI", id: "94276" });
  // The patient's own name is not disturbed by a second NM1 in the loop.
  assert.equal(parsed.data!.claims[0]!.patientName, "Kira Demo");
});

test("835: no NM1*TT means no crossover carrier — status 19 alone names nobody", () => {
  const parsed = edi.parseRemittance(advice());
  assert.ok(parsed.ok);
  assert.equal(parsed.data!.claims[0]!.disposition, "forwarded");
  assert.equal(parsed.data!.claims[0]!.crossoverCarrier, undefined);
});

test("835: an NM1*TT with no name is not a carrier", () => {
  const parsed = edi.parseRemittance(advice(["NM1*TT*2******PI*94276"]));
  assert.ok(parsed.ok);
  assert.equal(parsed.data!.claims[0]!.crossoverCarrier, undefined);
});

// ── 271: other or additional payer ────────────────────────────────────────────────────────────

const eligibility = (body: string[]) =>
  [
    "ISA*00*          *00*          *ZZ*CIGNA          *ZZ*CLINIC         *260901*1200*^*00501*000000001*0*P*:",
    "GS*HB*CIGNA*CLINIC*20260901*1200*1*X*005010X279A1",
    "ST*271*0001*005010X279A1",
    "BHT*0022*11*REQ1*20260901*1200",
    "HL*1**20*1",
    "NM1*PR*2*CIGNA DENTAL*****PI*62308",
    "HL*2*1*21*1",
    "NM1*1P*2*MERMAID DEMO DENTAL*****XX*1234567893",
    "HL*3*2*22*0",
    "NM1*IL*1*DEMO*KIRA****MI*DEMO0123",
    "DMG*D8*19900412",
    "DTP*346*D8*20260101",
    "EB*1*IND*35**DENTAL PPO",
    ...body,
    "SE*20*0001",
    "GE*1*1",
    "IEA*1*000000001",
  ].join("~") + "~";

const OTHER_PAYER_LOOP = [
  "EB*R*IND*35*GP*OTHER DENTAL COVERAGE",
  "DTP*346*D8*20250101",
  "LS*2120",
  "NM1*SEP*2*DELTA DENTAL OF CALIFORNIA*****PI*94276",
  "LE*2120",
];

test("271: EB*R with a 2120 loop is read as the other plan, role and all", () => {
  const parsed = parse271(eligibility(OTHER_PAYER_LOOP));
  assert.deepEqual(parsed.otherPayers, [
    {
      role: "secondary",
      name: "DELTA DENTAL OF CALIFORNIA",
      idQualifier: "PI",
      id: "94276",
      insuranceType: "GP",
      planDescription: "OTHER DENTAL COVERAGE",
    },
  ]);
});

test("271: the other plan's NM1*PR never replaces the payer", () => {
  // The latent defect this work found: every NM1*PR used to overwrite `payerName`, last one winning,
  // so a 271 naming the patient's other plan silently turned it into the patient's payer.
  const withPrEntity = OTHER_PAYER_LOOP.map((s) => s.replace("NM1*SEP", "NM1*PR"));
  const parsed = parse271(eligibility(withPrEntity));
  assert.equal(parsed.payerName, "CIGNA DENTAL");
  assert.equal(parsed.otherPayers[0]!.name, "DELTA DENTAL OF CALIFORNIA");
  assert.equal(parsed.otherPayers[0]!.role, "unspecified", "PR says 'a payer', not which position it holds");
});

test("271: the other plan's dates never replace this patient's coverage window", () => {
  const parsed = parse271(eligibility(OTHER_PAYER_LOOP));
  assert.equal(parsed.coverage.effectiveDate, "2026-01-01", "the 2025 date belongs to the other plan");
});

test("271: EB*R without a 2120 loop says another plan exists, and names nobody", () => {
  const parsed = parse271(eligibility(["EB*R*IND*35"]));
  assert.deepEqual(parsed.otherPayers, [
    { role: "unspecified", name: null, idQualifier: null, id: null, insuranceType: null, planDescription: null },
  ]);
});

test("271: no EB*R means no other payer — and nothing else about the answer changes", () => {
  const parsed = parse271(eligibility([]));
  assert.deepEqual(parsed.otherPayers, []);
  assert.equal(parsed.payerName, "CIGNA DENTAL");
  assert.equal(parsed.eligibility, "active");
  assert.equal(parsed.planName, "DENTAL PPO");
  assert.equal(parsed.coverage.effectiveDate, "2026-01-01");
});

// ── The mock's coordination scenario is internally consistent ─────────────────────────────────


const mockEligibility = (memberId: string) =>
  edi.checkEligibility({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    memberId,
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
  });

const mockAdvice = async (memberId: string) => {
  const fetched = await edi.fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [
      {
        patientControlNumber: `MRM-${memberId}`,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId,
        lines: [{ procedureCode: "D2750", charged: 100000 as never, quantity: 1 }],
        expectedInsurancePays: 60000 as never,
      },
    ],
  });
  assert.ok(fetched.ok, fetched.error?.message);
  return fetched.data![0]!.claims[0]!;
};

test("mock: a member with another plan gets a 271 that names it — and only that member does", async () => {
  assert.equal(holdsOtherCoverage("ABC00023"), true);
  const cob = await mockEligibility("ABC00023");
  assert.deepEqual(cob.data!.benefits.otherPayers, [
    { role: "secondary", name: MOCK_OTHER_PLAN.name, idQualifier: "PI", id: MOCK_OTHER_PLAN.id, insuranceType: "GP", planDescription: "OTHER DENTAL COVERAGE" },
  ]);
  assert.equal(cob.data!.benefits.payerName, "Delta Dental", "the payer is still the payer");
  assert.equal(cob.data!.eligibility, "active");

  const ordinary = await mockEligibility("ABC12345");
  assert.equal(ordinary.data!.benefits.otherPayers, undefined, "no other plan: nothing is fabricated");
});

test("mock: a forwarded claim names the same plan its 271 did — never a bare status 19", async () => {
  const cob = await mockAdvice("ABC00023");
  assert.equal(cob.disposition, "forwarded");
  assert.deepEqual(cob.crossoverCarrier, { name: MOCK_OTHER_PLAN.name, idQualifier: "PI", id: MOCK_OTHER_PLAN.id });

  const ordinary = await mockAdvice("ABC12345");
  assert.notEqual(ordinary.disposition, "forwarded");
  assert.equal(ordinary.crossoverCarrier, undefined);
});
