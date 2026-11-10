import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "../../pipeline.ts";
import { verificationProvenance } from "../provenance.ts";
import { clearinghouseIdFor, CLEARINGHOUSE_NAME } from "../payer.ts";
import { buildListItem, buildVerificationView } from "../../view.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents, type TreatmentPlanItem } from "@mermaid/shared";
import type { PatientInfo, VerificationRecord } from "../../types.ts";

const adapter = new MockEdiAdapter();
const NOW = new Date("2026-08-10T12:00:00Z");
const patient = (o: Partial<PatientInfo> = {}): PatientInfo => ({
  firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: "ABC12345", ...o,
});
const PROCS: TreatmentPlanItem[] = [
  { code: "D0120", quantity: 1 },
  { code: "D2391", quantity: 1, fee: cents(210) },
];

const mockRun = (o: Partial<PatientInfo> = {}, card = "Delta Dental\nMember ID: ABC12345") =>
  runVerification({ patient: patient(o), cardText: card, planItems: PROCS }, adapter, NOW);

// ── The three states that used to look identical ─────────────────────────────────────────────────

test("mock connector benefits are labelled demo data, never as a payer confirmation", async () => {
  const record = await mockRun();
  const p = verificationProvenance(record);

  assert.equal(record.dataSource, "mock");
  assert.equal(p.kind, "mock");
  assert.match(p.label, /DEMO DATA/);
  assert.match(p.explanation, /No clearinghouse was contacted/);
  // The badge must not be able to read as a real check, however a hurried person skims it.
  assert.doesNotMatch(p.label, /REAL|LIVE/);
  // Benefits DID come back — from the mock. Both facts are true at once, and the row has to say so.
  assert.equal(p.benefitsRetrieved, true);
  assert.ok(p.deductible && p.annualMaximum);
});

test("a clearinghouse that answered with no benefits is not labelled as a source of truth", () => {
  /**
   * The exact shape the demo was producing before this existed: a real 271 from a real
   * clearinghouse about a member the payer has never issued. `dataSource` says "edi" — truthfully —
   * and there is nothing in it. That row read as "verified by Stedi" on every screen.
   */
  const record = emptyEdiRecord();
  const p = verificationProvenance(record);

  assert.equal(record.dataSource, "edi");
  assert.equal(p.kind, "none");
  assert.equal(p.label, "NO BENEFITS RETRIEVED");
  assert.equal(p.benefitsRetrieved, false);
  assert.match(p.benefitsNote, /no benefit segments/);
  assert.match(p.explanation, /Nothing here is confirmed coverage/);
  assert.equal(p.eligibility, null);
  assert.equal(p.deductible, null);
  assert.equal(p.annualMaximum, null);
});

test("a real 271 with benefits and a TEST usage indicator is labelled a real clearinghouse test", () => {
  const p = verificationProvenance(ediRecordWithBenefits("T"));
  assert.equal(p.kind, "test");
  assert.equal(p.label, `REAL ${CLEARINGHOUSE_NAME.toUpperCase()} TEST`);
  assert.equal(p.dataSource, "edi");
  assert.equal(p.benefitsRetrieved, true);
  assert.equal(p.eligibility, "active");
  assert.match(p.explanation, /not a real person's coverage/);
});

test("a production usage indicator is labelled as a live payer, and only then", () => {
  const live = verificationProvenance(ediRecordWithBenefits("P"));
  assert.equal(live.kind, "live");
  assert.match(live.label, /LIVE PAYER/);

  // The safe direction: benefits over EDI whose environment cannot be read are NOT called a test.
  // Guessing "test" would understate a live payer's answer; guessing "live" would overstate a
  // sandbox's. Saying so is the only honest option.
  const unknown = verificationProvenance(ediRecordWithBenefits(null));
  assert.equal(unknown.kind, "test");
  assert.match(unknown.label, /ENVIRONMENT UNCONFIRMED/);
  assert.doesNotMatch(unknown.label, /LIVE/);
});

// ── The fields the operator asked to see ─────────────────────────────────────────────────────────

test("the clearinghouse id is namespaced, because a bare payer number means nothing", async () => {
  const record = await mockRun({}, "Aetna Dental\nMember ID: AET40123");
  assert.equal(record.payerId, "aetna-dental");
  assert.equal(clearinghouseIdFor("aetna-dental"), "60054");

  // On a MOCK record no clearinghouse was contacted, so neither field is claimed — the registry
  // knows an id for Aetna, but no request was addressed with it and the screen must not imply one.
  const mock = verificationProvenance(record);
  assert.equal(mock.clearinghouseId, null);
  assert.equal(mock.clearinghouseName, null);

  // On an EDI record it is present, and it is attributed.
  const edi = verificationProvenance({ ...record, dataSource: "edi" });
  assert.equal(edi.clearinghouseId, "60054");
  assert.equal(edi.clearinghouseName, CLEARINGHOUSE_NAME);
});

test("a payer with no clearinghouse id reports none rather than inventing one", async () => {
  const record = await mockRun({ memberId: "MOD11111" }, "Moda Health\nMember ID: MOD11111");
  assert.equal(record.payerId, "moda-dental");
  assert.equal(clearinghouseIdFor("moda-dental"), null);
  assert.equal(verificationProvenance({ ...record, dataSource: "edi" }).clearinghouseId, null);
});

test("every field the operator asked for is present on every verification", async () => {
  for (const record of [await mockRun(), emptyEdiRecord(), ediRecordWithBenefits("T")]) {
    const p = verificationProvenance(record);
    assert.ok(["edi", "portal", "manual", "mock"].includes(p.dataSource), "dataSource");
    assert.ok("payerName" in p, "payer");
    assert.ok("clearinghouseId" in p && "clearinghouseName" in p, "clearinghouse");
    assert.ok(typeof p.status === "string" && p.status.length > 0, "verification status");
    assert.equal(typeof p.benefitsRetrieved, "boolean", "benefit retrieval result");
    assert.ok("amountAtStake" in p, "amount at stake");
    assert.ok(p.label.length > 0 && p.explanation.length > 0);
  }
});

test("amount at stake is the patient's share once priced, and the plan total before", async () => {
  const priced = await mockRun();
  const p = verificationProvenance(priced);
  assert.ok(priced.calculation);
  assert.equal(p.amountAtStake, priced.calculation!.totalPatientPays);
  assert.equal(p.amountAtStakeLabel, "patient's share");

  // With no estimate there is still money exposed — the whole plan is undetermined, not zero.
  const unpriced = verificationProvenance(emptyEdiRecord());
  assert.equal(unpriced.amountAtStake, cents(210));
  assert.equal(unpriced.amountAtStakeLabel, "unpriced treatment plan");
});

// ── Provenance must describe the RECORD, not the process reading it ──────────────────────────────

test("provenance reads the record, so history cannot be relabelled by changing configuration", async () => {
  /**
   * The failure this rules out: deriving the badge from `EDI_ADAPTER` would restamp every record
   * ever written the moment a deployment switched clearinghouse — turning months of demo rows into
   * "REAL STEDI TEST" without a byte of data changing. Two records, same process, different truths.
   */
  const seeded = await mockRun();
  const real = ediRecordWithBenefits("T");
  assert.notEqual(verificationProvenance(seeded).kind, verificationProvenance(real).kind);
  assert.equal(verificationProvenance(seeded).kind, "mock");
  assert.equal(verificationProvenance(real).kind, "test");
});

test("an error envelope stored in raw271 is not mistaken for a payer transmission", () => {
  const p = verificationProvenance({
    ...emptyEdiRecord(),
    raw271: '{"error":"payer unavailable","usage":"*T*~GS"}',
  });
  assert.equal(p.kind, "none");
  assert.doesNotMatch(p.label, /REAL/);
});

// ── The view models carry it, which is the point ─────────────────────────────────────────────────

test("both the list row and the detail view carry provenance", async () => {
  const record = await mockRun();
  const row = buildListItem(record, NOW);
  const view = buildVerificationView(record, NOW);
  assert.equal(row.provenance.kind, "mock");
  assert.equal(view.provenance.kind, "mock");
  assert.deepEqual(row.provenance, view.provenance);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A record shaped exactly as the running demo produced them: real EDI transport, real 271, nothing
 * in it. Built by hand rather than by calling Stedi, because a unit test must not need the network.
 */
// ── M24 instance 4: the discarded scope reaches a person ─────────────────────────────────────────

/**
 * `parse271` has counted superseded benefit segments since M9, and until now nothing outside a test
 * ever read the count. That is the M24 shape: a correct, load-bearing answer computed and then
 * discarded, invisible to every gate because the function is well tested in isolation and has no
 * consumer. These tests are the consumer's guarantee — remove the wiring and they fail.
 */
test("M24: a scope the payer stated and this quote discarded is disclosed to a coordinator", () => {
  const record: VerificationRecord = { ...emptyEdiRecord(), supersededBenefits: 2 };
  const p = verificationProvenance(record);

  assert.equal(p.supersededBenefits, 2);
  assert.match(p.supersededNote, /also stated 2 benefit segments for another coverage scope/);
  assert.match(p.supersededNote, /check the patient's before quoting them/);
});

test("M24: one discarded segment is described in the singular", () => {
  const p = verificationProvenance({ ...emptyEdiRecord(), supersededBenefits: 1 });
  assert.match(p.supersededNote, /1 benefit segment for another/);
});

test("M24: nothing discarded says nothing, and never-counted is not the same as zero", () => {
  // Zero: the payer offered nothing we threw away. There is no disclosure to make.
  const none = verificationProvenance({ ...emptyEdiRecord(), supersededBenefits: 0 });
  assert.equal(none.supersededBenefits, 0);
  assert.equal(none.supersededNote, "");

  // Absent: an older record, or no adapter answered. Kept distinct from zero on purpose — a field
  // that is always empty is indistinguishable from a payer who never spoke (the V6 lesson).
  const older = verificationProvenance(emptyEdiRecord());
  assert.equal(older.supersededBenefits, null);
  assert.equal(older.supersededNote, "");
});

test("M24: the count survives the adapter and the pipeline, not just the parser", async () => {
  const record = await mockRun();
  assert.notEqual(
    record.supersededBenefits,
    undefined,
    "the pipeline must stamp what the adapter reported — an unstamped record is the defect returning"
  );
  assert.equal(typeof record.supersededBenefits, "number");
});

function emptyEdiRecord(): VerificationRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: NOW.toISOString(),
    status: "needs_review",
    patient: patient(),
    card: {
      payerName: { value: "Delta Dental", confidence: 0.95, source: "ocr", explanation: "" },
      memberId: { value: "ABC12345", confidence: 0.92, source: "ocr", explanation: "" },
      groupNumber: { value: null, confidence: 0, source: "ocr", explanation: "" },
      planName: { value: null, confidence: 0, source: "ocr", explanation: "" },
      subscriberName: { value: null, confidence: 0, source: "ocr", explanation: "" },
      effectiveDate: { value: null, confidence: 0, source: "ocr", explanation: "" },
    },
    planItems: PROCS,
    benefits: null,
    calculation: null,
    exceptions: [],
    confidence: { overall: 0.4, components: [], reviewThreshold: 0.75 },
    reportText: "",
    review: null,
    audit: [],
    dataSource: "edi",
    payerId: "delta-dental",
    raw271: "ISA*00*...*T*00501*000000001*0*T*:~GS*HB*...~ST*271*0001~SE*2*0001~GE*1*1~IEA*1*1~",
  };
}

/** The same, but with benefits and a chosen ISA usage indicator (`T`, `P`, or none at all). */
function ediRecordWithBenefits(usage: "T" | "P" | null): VerificationRecord {
  const base = emptyEdiRecord();
  return {
    ...base,
    status: "verified",
    raw271:
      usage === null
        ? "ST*271*0001~EB*1*IND*35~SE*2*0001~"
        : `ISA*00*...*${usage}*00501*000000001*0*${usage}*:~GS*HB*...~ST*271*0001~EB*1*IND*35~SE*2*0001~`,
    benefits: {
      eligibility: "active",
      payerName: "Aetna",
      planName: "Sandbox PPO",
      deductible: { individualAnnual: cents(100), remaining: cents(100), appliesTo: ["basic", "major"] },
      annualMaximum: { amount: cents(240), used: cents(50), remaining: cents(190) },
      coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
      waitingPeriods: [],
      frequencyLimits: [],
      exclusions: [],
      excludedCodes: [],
    },
  };
}
