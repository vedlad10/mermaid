/**
 * Five REAL dental 271s from Stedi's test environment, and what a dental practice must read in them.
 *
 * Captured 2026-10-15 through the production `StediEdiAdapter` (see fixtures/stedi-271-dental.ts).
 * Every expected value below was read by hand from the raw segments, not from the parser, so these
 * tests check the parser against the payer rather than against itself — the closed loop that let
 * the defects pinned here survive every earlier test.
 *
 * What the capture found, all of it money:
 *   1. Coinsurance read INVERTED. EB01 `A` EB08 is the patient's share; it was stored as the plan's.
 *      Preventive care showed as 0% covered, and an orthodontic benefit the payer excludes as 100%.
 *   2. No precedence on coinsurance: an out-of-network rate replaced the in-network one.
 *   3. Cigna and UnitedHealthcare state the deductible and maximum only under `30`, which B1 refused
 *      everywhere — Cigna's $2,000 maximum became $0 from a four-code imaging limit.
 *   4. MetLife (`22` service year) and BCBS California (`25` contract) state annual figures under
 *      periods other than `23`, and both maximums were dropped.
 *   5. A payer that could not answer (AAA 42) was reported as an invalid member ID, not retryable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build271, parse271 } from "../mock/x12-271.ts";
import { StediEdiAdapter } from "../vendors/stedi/index.ts";
import { STEDI_SANDBOX_271 } from "./fixtures/stedi-271.ts";
import {
  STEDI_DENTAL_271_AAA42_UNABLE_TO_RESPOND,
  STEDI_DENTAL_271_AAA72_INVALID_MEMBER_ID,
  STEDI_DENTAL_271_AMERITAS,
  STEDI_DENTAL_271_BCBS_CA,
  STEDI_DENTAL_271_CIGNA,
  STEDI_DENTAL_271_METLIFE,
  STEDI_DENTAL_271_UHC_DENTAL,
} from "./fixtures/stedi-271-dental.ts";

// ── 1. Coinsurance is the patient's share ───────────────────────────────────────────────────────

test("Ameritas: 'covered at 100%' reads as 100% covered, and the excluded orthodontics as 0%", () => {
  // `EB*A**35*****0` is followed by "TYPE 1 PROCEDURES COVERED AT 100%", and `EB*A**38*****1` is
  // the patient paying 100% of orthodontia. The old reading had both backwards.
  const p = parse271(STEDI_DENTAL_271_AMERITAS);
  assert.deepEqual(p.coveragePercentages, { diagnostic: 100, preventive: 100, basic: 100, major: 100, orthodontic: 0 });
  assert.equal(p.deductible.annual, 50);
  assert.equal(p.deductible.remaining, 50);
  assert.equal(p.annualMaximum.amount, 2500, "the annual maximum, not the $250 carry-over listed after it");
  assert.equal(p.annualMaximum.remaining, 2500);
});

test("MetLife: an 80% restorative benefit is 80%, and the in-network column is the one read", () => {
  // `EB*A**25*GP****.2***U*Y` — patient 20%. Every row comes twice, N then Y.
  const p = parse271(STEDI_DENTAL_271_METLIFE);
  assert.deepEqual(p.coveragePercentages, { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 });
  assert.equal(p.trace.coinsuranceConflicts.length, 0, "25 is basic's own service type, so 26/24/40 at 50% do not tie it");
});

test("MetLife: service-year (`22`) figures are the annual ones", () => {
  const p = parse271(STEDI_DENTAL_271_METLIFE);
  assert.equal(p.annualMaximum.amount, 1250, "stated only as `…*22*1250`");
  assert.equal(p.annualMaximum.remaining, 968.5);
  assert.equal(p.deductible.annual, 50);
  assert.equal(p.deductible.remaining, null, "MetLife does not state what is left of it — still unknown");
});

test("UnitedHealthcare: a composite `41^23` row covers both categories, and `30` carries the deductible", () => {
  const p = parse271(STEDI_DENTAL_271_UHC_DENTAL);
  assert.deepEqual(p.coveragePercentages, { preventive: 100, diagnostic: 100 }, "nothing invented for the categories it did not state");
  assert.equal(p.deductible.annual, 0);
  assert.equal(p.deductible.remaining, 0);
  assert.equal(p.annualMaximum.amount, null, "UHC states no maximum in this file");
});

// ── 2. Precedence, and an honest answer when the payer gives two ───────────────────────────────

test("BCBS California: in-network beats out-of-network, and a same-scope disagreement quotes the lower rate", () => {
  /**
   * Its restorative (`25`) rows are 80% for "BASIC RESTORATIVE" and 50% for "MAJOR RESTORATIVE",
   * both in-network, with no code list to say which procedure is which. The lower is quoted and the
   * choice is on the record; out-of-network rows (70% / 50%) never compete.
   */
  const p = parse271(STEDI_DENTAL_271_BCBS_CA);
  assert.deepEqual(p.coveragePercentages, { diagnostic: 100, preventive: 100, basic: 50, major: 50, orthodontic: 0 });
  assert.deepEqual(p.trace.coinsuranceConflicts, [{ scope: "category", key: "basic", planPercents: [50, 80] }]);
});

test("BCBS California: a contract-period (`25`) maximum is the annual one, and orthodontia's own figures never stand in", () => {
  const p = parse271(STEDI_DENTAL_271_BCBS_CA);
  assert.equal(p.annualMaximum.amount, 1500);
  assert.equal(p.annualMaximum.remaining, 1356);
  // The only annual-period deductible in the file is orthodontia's ($0). It is not the plan's.
  assert.equal(p.deductible.annual, null);
  assert.equal(p.deductible.remaining, 50);
});

test("Cigna: plan figures under `30` are read, because the file is a dental plan's own answer", () => {
  const p = parse271(STEDI_DENTAL_271_CIGNA);
  assert.equal(p.deductible.annual, 50);
  assert.equal(p.deductible.remaining, 50);
  assert.equal(p.annualMaximum.amount, 2000, "this was $0 — a 3D-imaging limit standing in for the plan's maximum");
  assert.equal(p.annualMaximum.remaining, 2000);
});

test("Cigna: a rate the payer listed codes for is read per code", () => {
  const p = parse271(STEDI_DENTAL_271_CIGNA).procedureCoveragePercentages;
  assert.equal(p["D0120"], 100, "periodic exam");
  assert.equal(p["D0801"], 50, "3D imaging, the other diagnostic tier");
  assert.equal(p["D0210"], 100, "full-mouth X-rays, listed under service type 4");
  assert.equal(p["D1110"], 100, "adult cleaning");
  assert.equal(p["D2391"], 90, "a composite filling: in-network 10%, never the out-of-network 20%");
  assert.equal(p["D2750"], 60, "a crown");
  assert.equal(p["D2920"], 90, "recementing a crown, the other crown tier");
});

test("Cigna: where the category blends tiers, the lower is quoted and the blend is recorded", () => {
  const p = parse271(STEDI_DENTAL_271_CIGNA);
  assert.equal(p.coveragePercentages.basic, 60);
  assert.equal(p.coveragePercentages.diagnostic, 50);
  assert.deepEqual(
    p.trace.coinsuranceConflicts.filter((c) => c.scope === "category").map((c) => c.key),
    ["diagnostic", "basic", "major"]
  );
  assert.equal(p.trace.coinsuranceConflicts.filter((c) => c.scope === "procedure").length, 0);
});

// ── 3. What must NOT change ──────────────────────────────────────────────────────────────────────

test("B1 holds: the Aetna MEDICAL answer still yields no dental figure, `30` included", () => {
  const p = parse271(STEDI_SANDBOX_271);
  assert.equal(p.deductible.annual, null);
  assert.equal(p.deductible.remaining, null);
  assert.equal(p.annualMaximum.amount, null);
  assert.deepEqual(p.coveragePercentages, {});
  assert.deepEqual(p.procedureCoveragePercentages, {});
});

test("the mock writes the patient's share, as a payer does, and round-trips to the same plan percentages", () => {
  const raw = build271({
    payerName: "Delta Dental",
    planName: "PPO",
    memberId: "ABC12345",
    active: true,
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    deductibleAnnual: 50,
    deductibleRemaining: 25,
    annualMaximum: 1500,
    annualMaximumRemaining: 900,
  });
  assert.match(raw, /EB\*A\*IND\*25\*{5}0\.2~/, "80% basic is written as the patient's 20%");
  assert.match(raw, /EB\*A\*IND\*38\*{5}1~/, "0% orthodontia is the patient paying all of it");
  assert.deepEqual(parse271(raw).coveragePercentages, { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 });
});

test("a patient share outside 0–1 is refused, not turned into a negative or 1900% benefit", () => {
  const raw = [
    "ST*271*0001",
    "NM1*PR*2*Delta Dental",
    "EB*1*IND*35",
    "EB*A*IND*25*****20", // a whole-number percent, not X12's fraction
    "EB*A*IND*36*****-0.1",
    "SE*6*0001",
  ].join("~") + "~";
  const p = parse271(raw);
  assert.deepEqual(p.coveragePercentages, {});
  assert.equal(p.trace.skipped.filter((s) => s.startsWith("EB*A")).length, 2);
});

test("a code list counts only when it is codes alone, and only right after its coinsurance row", () => {
  const raw = [
    "ST*271*0001",
    "NM1*PR*2*Delta Dental",
    "EB*1*IND*35",
    "EB*A*IND*25*****.1****Y",
    "MSG*D2391 D2392",
    "MSG*FILLINGS SUCH AS D2140 ARE COVERED", // prose that mentions a code is never read for money
    "EB*C*IND*35***23*50****Y",
    "MSG*D2750", // belongs to no coinsurance row
    "SE*9*0001",
  ].join("~") + "~";
  const p = parse271(raw);
  assert.deepEqual(p.procedureCoveragePercentages, { D2391: 90, D2392: 90 });
});

test("a per-procedure (EB13) row never sets a plan-level figure", () => {
  const raw = [
    "ST*271*0001",
    "NM1*PR*2*Delta Dental",
    "EB*1*IND*35",
    "EB*F*IND*****23*99*****Y*AD:D2750",
    "EB*F*IND*35***23*1500****Y",
    "SE*6*0001",
  ].join("~") + "~";
  assert.equal(parse271(raw).annualMaximum.amount, 1500);
});

test("lifetime (`32`) figures are never the annual maximum", () => {
  const raw = ["ST*271*0001", "NM1*PR*2*Delta", "EB*1*IND*35", "EB*F*IND*35***32*1000****Y", "SE*5*0001"].join("~") + "~";
  assert.equal(parse271(raw).annualMaximum.amount, null);
});

// ── 4. Through the adapter, as production runs it ───────────────────────────────────────────────

const adapterReturning = (body: Record<string, unknown>): StediEdiAdapter =>
  new StediEdiAdapter({
    apiKey: "test_notarealkey",
    baseUrl: "https://healthcare.us.stedi.example",
    timeoutMs: 5_000,
    testMode: true,
    provider: { organizationName: "MERMAID DEMO DENTAL", npi: "1234567893" },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ meta: { applicationMode: "test" }, ...body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });

const CIGNA_REQUEST = {
  payerId: "cigna-dental",
  clearinghouseId: "62308",
  payerName: "Cigna",
  memberId: "U3141592653",
  patient: { firstName: "Jaguar", lastName: "Dent", dateOfBirth: "1996-05-05" },
};

test("the Stedi adapter carries per-code rates onto Benefits, and a blended category lowers confidence", async () => {
  const result = await adapterReturning({ x12: STEDI_DENTAL_271_CIGNA }).checkEligibility(CIGNA_REQUEST);
  assert.equal(result.ok, true);
  const b = result.data!.benefits;
  assert.equal(b.procedureCoveragePercentages?.["D2391"], 90);
  assert.equal(b.annualMaximum.amount, 200_000, "$2,000 in integer cents");
  assert.equal(result.data!.perFieldConfidence.coveragePercentages, 0.6, "stated, but the payer gave two rates for some categories");
});

test("a payer with no conflicting rates keeps full confidence", async () => {
  const result = await adapterReturning({ x12: STEDI_DENTAL_271_METLIFE }).checkEligibility({ ...CIGNA_REQUEST, clearinghouseId: "10134" });
  assert.equal(result.data!.perFieldConfidence.coveragePercentages, 0.9);
  assert.equal(result.data!.benefits.procedureCoveragePercentages, undefined, "absent when the payer lists no codes");
});

test("AAA 42 'unable to respond' is the payer being down: retryable, and not blamed on the member ID", async () => {
  const result = await adapterReturning({
    x12: STEDI_DENTAL_271_AAA42_UNABLE_TO_RESPOND,
    errors: [{ code: "42", description: "Unable to Respond at Current Time" }],
  }).checkEligibility(CIGNA_REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.error!.code, "unavailable");
  assert.equal(result.error!.retryable, true);
  assert.match(result.error!.message, /Unable to Respond at Current Time/, "the payer's own words still reach the screen");
  assert.match(result.error!.message, /nothing in the patient's details is known to be wrong/);
});

test("AAA 72 is still an invalid member ID the front desk must correct", async () => {
  const result = await adapterReturning({
    x12: STEDI_DENTAL_271_AAA72_INVALID_MEMBER_ID,
    errors: [{ code: "72", description: "Invalid/Missing Subscriber/Insured ID" }],
  }).checkEligibility(CIGNA_REQUEST);
  assert.equal(result.error!.code, "invalid_member_id");
  assert.equal(result.error!.retryable, false);
});

test("a provider-side refusal (AAA 43) is not blamed on the patient, and is not retried blindly", async () => {
  const result = await adapterReturning({
    x12: STEDI_DENTAL_271_AAA42_UNABLE_TO_RESPOND.replace("AAA*N**42*R", "AAA*N**43*C"),
    errors: [{ code: "43", description: "Invalid/Missing Provider Identification" }],
  }).checkEligibility(CIGNA_REQUEST);
  assert.equal(result.error!.code, "unavailable");
  assert.equal(result.error!.retryable, false);
  assert.match(result.error!.message, /practice's setup/);
});
