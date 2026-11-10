/**
 * The 277CA a REAL clearinghouse sent, parsed by the real parser.
 *
 * Every other 277CA test in this repository feeds `parse277CA` something `build277CA` produced.
 * That proves the two agree with each other and nothing about whether either agrees with X12 — and
 * both defects below survived a full suite of those round-trips, because Mermaid's builder emits
 * neither a backtick separator nor an HL hierarchy. A codec tested only against itself is tested
 * against its own assumptions.
 *
 * This payload is verbatim from Stedi TEST on 2026-08-23, captured off the wire by
 * `scripts/stedi-claim-probe.mjs` (variant `bad-npi`). It is kept byte-for-byte on purpose: the
 * moment it is tidied up it stops being evidence and becomes another fixture we wrote ourselves.
 * Everything Mermaid sent is synthetic — Stedi's own sandbox member, a placeholder address, and a
 * deliberately invalid billing NPI. No PHI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse277CA } from "../mock/x12-837.ts";

/**
 * Stedi's answer to an 837D whose billing NPI failed its check digit: `HTTP 400`, body
 * `"status":"ERROR"`, `errors[0].code = "33"`, "Invalid NPI … Correct and resubmit."
 *
 * Note ISA16 — a BACKTICK. Note the hierarchy — the refusal is at HL*3, the PROVIDER level, while
 * the claim's own STC at HL*4 reads A1, accepted.
 */
const REAL_277CA =
  "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*RECEIVER       *260823*1935*^*00501*744538180*0*T*`~" +
  "GS*HN*STEDITEST*RECEIVER*20260823*193516*1*X*005010X214~" +
  "ST*277*0001*005010X214~" +
  "BHT*0085*08*01M0R1XG5E7HH2BXCFSGYYMCQC*20260823*193516*TH~" +
  "HL*1**20*1~" +
  "NM1*AY*2*STEDI INC*****46*117151744~" +
  "TRN*1*01M0R1XG5E7HH2BXCFSGYYMCQC~" +
  "DTP*050*D8*20260823~" +
  "DTP*009*D8*20260823~" +
  "HL*2*1*21*1~" +
  "NM1*41*2*MERMAID DEMO DENTAL*****46*000000000~" +
  "TRN*2*847856660~" +
  "STC*A1`20*20260823*WQ*142.50~" +
  "QTY*90*1~" +
  "AMT*YU*142.50~" +
  "HL*3*2*19*1~" +
  "NM1*85*2*MERMAID DEMO DENTAL*****XX*1234567890~" +
  "TRN*1*0~" +
  "STC*A7`562`85**U*142.50******A7`569~" +
  "REF*TJ*000000000~" +
  "QTY*QC*1~" +
  "AMT*YY*142.50~" +
  "HL*4*3*PT*0~" +
  "NM1*QC*1*Doe*Jordan****MI*AETNA9wcSu~" +
  "TRN*2*MRM513713041~" +
  "STC*A1`20*20260823*WQ*142.50~" +
  "REF*D9*11111111-2222-4333-8444-5555513713041~" +
  "DTP*472*RD8*20260820-20260820~" +
  "SE*27*0001~" +
  "GE*1*1~" +
  "IEA*1*744538180~";

const CLM01 = "MRM513713041";

test("the payload declares a backtick separator, and STC01 is split on the one it declares", () => {
  const parsed = parse277CA(REAL_277CA);
  const claim = parsed.claims.find((c) => c.patientControlNumber === CLM01);

  assert.ok(claim, `no claim matched ${CLM01} — the acknowledgement would be unattributable`);
  assert.notEqual(
    claim.statusCategory,
    "A1`20",
    "an unsplit composite — the category and the code are being read as a single string"
  );
  assert.notEqual(claim.statusCode, null, "a null status code means the composite never split");
});

test("a provider-level A7 rejects the claim beneath it — the false ACCEPTANCE this caught", () => {
  const parsed = parse277CA(REAL_277CA);
  const claim = parsed.claims.find((c) => c.patientControlNumber === CLM01);
  assert.ok(claim, "the claim must be attributable before its status can mean anything");

  /**
   * THE LOAD-BEARING ASSERTION.
   *
   * Stedi refused this claim: HTTP 400, status ERROR, error code 33, and `STC*A7`562`85` at the
   * billing-provider level — 562 is "Entity's National Provider Identifier", 85 is "Billing
   * Provider". The claim's OWN status is `A1`20`, accepted, because the claim itself is well
   * formed; it is the provider on it that is not, so it was never forwarded to Aetna.
   *
   * Reading only the claim-level STC returned `accepted: true` for a claim that exists nowhere
   * downstream. A biller would have seen it filed, waited for a remittance that is never coming, and
   * found out when the timely-filing window had closed.
   */
  assert.equal(claim.accepted, false, "Stedi refused this claim — recording it accepted loses it");
  assert.equal(claim.statusCategory, "A7", "the reported status must be the refusal, not the claim's own A1");
  assert.equal(claim.statusCode, "562", "562 — Entity's National Provider Identifier");
});

test("the levels above the claim are not themselves claims", () => {
  const parsed = parse277CA(REAL_277CA);

  /**
   * `TRN*2*847856660` at the receiver level and `TRN*1*0` at the provider level are trace numbers.
   * Read flatly they became claims numbered "847856660" and "0" — matching no submission Mermaid
   * ever made, and giving the provider-level A7 somewhere to sit where nothing would read it.
   */
  assert.deepEqual(
    parsed.claims.map((c) => c.patientControlNumber),
    [CLM01],
    "one claim was submitted, so one claim may be reported"
  );
  assert.equal(parsed.receiverStatus?.statusCategory, "A1", "the batch itself was received");
});
