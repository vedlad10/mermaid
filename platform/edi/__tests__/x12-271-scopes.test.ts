/**
 * A 271 carries several deductibles, and only one of them is the patient's.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────────────────────
 * Real payers itemise the same plan at several scopes: individual and family, in-network and
 * out-of-network. `parse271` read EB01 and EB07 and wrote all of them into one slot, so whichever
 * segment came LAST in the file won. On an ordinary Delta Dental response that produced a $200
 * out-of-network deductible instead of $50, and a $4,500 / $3,900 FAMILY maximum instead of the
 * patient's own $1,500 / $1,200 — an estimate built on $2,700 of benefit the patient did not have.
 *
 * It survived every existing test because `build271` only ever emits `IND` with no network
 * qualifier: one candidate per slot, where last-wins and correct are indistinguishable.
 *
 * These fixtures are hand-built rather than produced by `build271`, deliberately. A codec tested
 * only against its own writer is tested against its own assumptions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse271 } from "../mock/x12-271.ts";

/** EB01 EB02 EB03 EB04 EB05 EB06 EB07 EB08 EB09 EB10 EB11 EB12 */
const eb = (eb01: string, level: string, period: string, amount: string, network = ""): string =>
  ["EB", eb01, level, "35", "", "", period, amount, "", "", "", "", network].join("*");

const HEAD = [
  ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "DELTA          ", "ZZ", "CLINIC         ", "260811", "0000", "^", "00501", "000000001", "0", "P", ":"].join("*"),
  ["GS", "HB", "DELTA", "CLINIC", "20260811", "0000", "1", "X", "005010X279A1"].join("*"),
  ["ST", "271", "0001", "005010X279A1"].join("*"),
  ["NM1", "PR", "2", "Delta Dental"].join("*"),
  ["NM1", "IL", "1", "ALPHA", "ADA", "", "", "", "MI", "ABC12345"].join("*"),
  ["EB", "1", "IND", "35", "", "PPO Premier"].join("*"),
];
const TAIL = [["SE", "20", "0001"].join("*"), ["GE", "1", "1"].join("*"), ["IEA", "1", "1"].join("*")];
const build = (rows: string[]): string => [...HEAD, ...rows, ...TAIL].join("~") + "~";

const INDIVIDUAL_IN_NETWORK = [
  eb("C", "IND", "23", "50", "Y"),
  eb("C", "IND", "29", "50", "Y"),
  eb("F", "IND", "23", "1500", "Y"),
  eb("F", "IND", "29", "1200", "Y"),
];
const FAMILY = [eb("C", "FAM", "23", "150", "Y"), eb("C", "FAM", "29", "150", "Y"), eb("F", "FAM", "23", "4500", "Y"), eb("F", "FAM", "29", "3900", "Y")];
const OUT_OF_NETWORK = [eb("C", "IND", "23", "200", "N"), eb("C", "IND", "29", "200", "N")];

function assertPatientsOwn(raw: string): void {
  const p = parse271(raw);
  assert.equal(p.deductible.annual, 50, "the patient's own in-network deductible");
  assert.equal(p.deductible.remaining, 50);
  assert.equal(p.annualMaximum.amount, 1500, "the patient's own maximum, not the family's");
  assert.equal(p.annualMaximum.remaining, 1200);
}

test("the individual in-network benefit wins, whatever order the payer sends them in", () => {
  // Every ordering, because the defect was purely positional: the old parser was correct only when
  // the right segment happened to be last.
  assertPatientsOwn(build([...INDIVIDUAL_IN_NETWORK, ...FAMILY, ...OUT_OF_NETWORK]));
  assertPatientsOwn(build([...FAMILY, ...OUT_OF_NETWORK, ...INDIVIDUAL_IN_NETWORK]));
  assertPatientsOwn(build([...OUT_OF_NETWORK, ...INDIVIDUAL_IN_NETWORK, ...FAMILY]));
  assertPatientsOwn(build([...FAMILY, ...INDIVIDUAL_IN_NETWORK, ...OUT_OF_NETWORK]));
});

test("segments for a scope we did not choose are counted, not silently dropped", () => {
  const p = parse271(build([...INDIVIDUAL_IN_NETWORK, ...FAMILY, ...OUT_OF_NETWORK]));
  assert.equal(p.trace.supersededBenefits, 6, "4 family + 2 out-of-network");
  assert.equal(p.trace.skipped.length, 0, "they are real benefits, not malformed segments");
});

test("a payer that sends only family benefits still yields a usable answer", () => {
  // Lower precedence must not mean discarded — nothing better arriving is not a reason to return an
  // empty plan and quote the patient the full fee.
  const p = parse271(build(FAMILY));
  assert.equal(p.deductible.annual, 150);
  assert.equal(p.annualMaximum.amount, 4500);
  assert.equal(p.annualMaximum.remaining, 3900);
});

test("out-of-network is used only when the payer offers nothing in-network", () => {
  const p = parse271(build(OUT_OF_NETWORK));
  assert.equal(p.deductible.annual, 200);
  assert.equal(p.deductible.remaining, 200);
});

test("a payer that omits EB02 and EB12 entirely is unaffected", () => {
  // The overwhelmingly common shape, and the one every existing fixture used. It must keep parsing
  // exactly as it did — this fix may not cost anything that already worked.
  const p = parse271(build([eb("C", "", "23", "75"), eb("C", "", "29", "25"), eb("F", "", "23", "2000"), eb("F", "", "29", "800")]));
  assert.equal(p.deductible.annual, 75);
  assert.equal(p.deductible.remaining, 25);
  assert.equal(p.annualMaximum.amount, 2000);
  assert.equal(p.annualMaximum.remaining, 800);
  assert.equal(p.trace.supersededBenefits, 0);
});

test("an explicit individual benefit still beats an unqualified one", () => {
  const p = parse271(build([eb("C", "", "23", "999"), eb("C", "IND", "23", "50", "Y")]));
  assert.equal(p.deductible.annual, 50);
  // …and the reverse order, since that is the case the old code got right by accident.
  assert.equal(parse271(build([eb("C", "IND", "23", "50", "Y"), eb("C", "", "23", "999")])).deductible.annual, 50);
});

test("a duplicated segment at the same scope is idempotent, not additive", () => {
  // Payers do repeat segments. The value must settle, never accumulate.
  const p = parse271(build([eb("C", "IND", "23", "50", "Y"), eb("C", "IND", "23", "50", "Y"), eb("C", "IND", "23", "50", "Y")]));
  assert.equal(p.deductible.annual, 50);
});

test("malformed benefit segments are skipped rather than misread", () => {
  /**
   * The behaviour that saved this audit from a false positive: a first attempt at these fixtures put
   * the time qualifier in EB05 instead of EB06, and the parser refused every one of them rather than
   * reading the wrong element as money. Worth pinning — silently accepting a misaligned segment is
   * how a deductible becomes a service-type code.
   */
  const misaligned = ["EB", "C", "IND", "35", "", "23", "50"].join("*"); // qualifier one element early
  const p = parse271(build([misaligned, ...INDIVIDUAL_IN_NETWORK]));
  assert.equal(p.trace.skipped.length, 1);
  assert.equal(p.deductible.annual, 50, "the well-formed segment still lands");
});

/**
 * ── V3: which network column applies is the PRACTICE's fact ─────────────────────────────────────
 *
 * The fix above always preferred EB12 `Y`. That is right for an in-network practice and silently
 * wrong for everyone else: an out-of-network practice was quoted the in-network deductible and
 * maximum, so it told patients insurance would cover more than it would, and absorbed or re-billed
 * the difference. Nothing in a 271 says whether we participate — the payer is answering about the
 * member, not about us — so it has to be stated.
 *
 * Same hand-built fixtures, and both columns are genuinely present in every one: a test where only
 * one column exists cannot tell a correct selection from a lucky one.
 */
const OON_FULL = [
  eb("C", "IND", "23", "200", "N"),
  eb("C", "IND", "29", "175", "N"),
  eb("F", "IND", "23", "1000", "N"),
  eb("F", "IND", "29", "800", "N"),
];

test("an out-of-network practice is quoted from the out-of-network column", () => {
  const raw = build([...INDIVIDUAL_IN_NETWORK, ...FAMILY, ...OON_FULL]);
  const p = parse271(raw, "out-of-network");

  assert.equal(p.deductible.annual, 200, "the out-of-network deductible, not the $50 in-network one");
  assert.equal(p.deductible.remaining, 175);
  assert.equal(p.annualMaximum.amount, 1000, "the out-of-network maximum");
  assert.equal(p.annualMaximum.remaining, 800);
});

test("an in-network practice is quoted from the in-network column", () => {
  const raw = build([...INDIVIDUAL_IN_NETWORK, ...FAMILY, ...OON_FULL]);
  const p = parse271(raw, "in-network");

  assert.equal(p.deductible.annual, 50);
  assert.equal(p.annualMaximum.amount, 1500);
  assert.equal(p.annualMaximum.remaining, 1200);
});

test("`unknown` participation behaves exactly as the parser did before V3 — no deployment moves", () => {
  // The compatibility guarantee. `unknown` is the default everywhere, so if this drifts, every
  // existing deployment's quotes drift with it and nobody asked for that.
  const raw = build([...INDIVIDUAL_IN_NETWORK, ...FAMILY, ...OON_FULL]);
  assert.deepEqual(parse271(raw, "unknown"), parse271(raw), "the default must be a no-op");
  assert.equal(parse271(raw, "unknown").deductible.annual, 50, "which is the in-network preference");
});

test("family still loses to individual in BOTH directions — network selection did not replace scope", () => {
  // The two ranks are independent, and the V3 change touches only one of them. An out-of-network
  // practice must still be quoted the individual figure, not the family one.
  const famOon = [eb("C", "FAM", "23", "600", "N"), eb("F", "FAM", "23", "9000", "N")];
  const p = parse271(build([...OON_FULL, ...famOon, ...INDIVIDUAL_IN_NETWORK]), "out-of-network");

  assert.equal(p.deductible.annual, 200, "individual out-of-network, not family out-of-network");
  assert.equal(p.annualMaximum.amount, 1000);
});

test("an unqualified segment is still used when the wanted column is absent", () => {
  // A payer that sends no EB12 at all must not leave an out-of-network practice with nothing. The
  // unqualified segment outranks the column we are NOT in, and loses to the one we are.
  const unqualified = [eb("C", "IND", "23", "75"), eb("F", "IND", "23", "2000")];
  const p = parse271(build([...INDIVIDUAL_IN_NETWORK, ...unqualified]), "out-of-network");

  assert.equal(p.deductible.annual, 75, "the unqualified figure beats the in-network one we cannot use");
  assert.equal(p.annualMaximum.amount, 2000);
});

// ── M9 — EB03 decides WHICH BENEFIT a segment describes ───────────────────────────────────────
//
// EB03 is the service type, and `benefitPrecedence` ignored it entirely. A payer answering a dental
// inquiry routinely quotes more than one: the dental annual maximum (35) beside an ORTHODONTIC
// lifetime maximum (38), or a general health-plan figure (30). All of them landed in the same slot
// with an identical rank, and because the comparison is strictly-greater the FIRST in the file won.
//
// So which figure a patient was quoted against depended on segment order. Capped low they are
// over-quoted and decline treatment; capped high the practice is promised money the payer will not
// pay. Same defect class as family-vs-individual, one element over.
//
// `build271` emitted only `35`, which is exactly why this survived every existing test.

/** Like `eb`, but for a service type other than dental. */
const ebOfType = (eb01: string, level: string, serviceType: string, period: string, amount: string): string =>
  ["EB", eb01, level, serviceType, "", "", period, amount].join("*");

test("M9: an orthodontic lifetime maximum listed FIRST does not become the dental annual maximum", () => {
  const orthodonticFirst = [
    ebOfType("F", "IND", "38", "23", "1000"), // ortho lifetime max — a different benefit entirely
    ebOfType("F", "IND", "38", "29", "1000"),
    eb("F", "IND", "23", "1500", "Y"), // the dental annual maximum, the one that applies
    eb("F", "IND", "29", "1200", "Y"),
  ];
  const p = parse271(build(orthodonticFirst));

  assert.equal(p.annualMaximum.amount, 1500, "the DENTAL maximum, not the orthodontic one that came first");
  assert.equal(p.annualMaximum.remaining, 1200);
  assert.notEqual(p.annualMaximum.amount, 1000, "the figure the old first-wins ordering picked");
});

test("M9: a medical-plan deductible does not displace the dental one, whatever the order", () => {
  const medicalFirst = [
    ebOfType("C", "IND", "30", "23", "2500"), // health benefit plan coverage — not this inquiry
    ebOfType("C", "IND", "30", "29", "2500"),
    eb("C", "IND", "23", "50", "Y"),
    eb("C", "IND", "29", "50", "Y"),
  ];
  const p = parse271(build(medicalFirst));

  assert.equal(p.deductible.annual, 50, "$2,500 is the medical deductible and would wreck the estimate");
  assert.equal(p.deductible.remaining, 50);
});

test("M9: the service type outranks BOTH network and coverage level", () => {
  /**
   * It has to. An in-network INDIVIDUAL orthodontic maximum is not a better answer for the dental
   * maximum than an unqualified dental one — it is a different number. Ranking it below the other
   * two dimensions would let a perfectly-qualified wrong benefit win.
   */
  const p = parse271(
    build([
      ["EB", "F", "IND", "38", "", "", "23", "9999", "", "", "", "", "Y"].join("*"), // ideal scope, wrong benefit
      ebOfType("F", "FAM", "35", "23", "1500"), // worse scope, RIGHT benefit
    ])
  );

  assert.equal(p.annualMaximum.amount, 1500, "the right benefit at the wrong scope beats the wrong benefit");
});

test("M9: an unqualified service type is still used when nothing states 35", () => {
  // The control, and the mirror of the network rule above: a payer that omits EB03 must not leave
  // the practice with nothing. Unqualified sits between the wanted type and any other.
  const p = parse271(
    build([
      ebOfType("F", "IND", "38", "23", "1000"),
      ["EB", "F", "IND", "", "", "", "23", "1750"].join("*"),
    ])
  );

  assert.equal(p.annualMaximum.amount, 1750, "the unqualified figure beats the orthodontic one");
});

// ── B1 — A NON-DENTAL BENEFIT IS NOT A DENTAL BENEFIT ─────────────────────────────────────────
//
// `serviceRank` scored `35 → 2`, empty `→ 1`, everything else `→ 0`. The accept test is
// `rank > (previous ?? NO_MATCH)` with `NO_MATCH = -1`, so a rank of 0 still beat "nothing chosen":
// the first NON-DENTAL figure in the file was admitted whenever no dental one existed.
//
// Measured against the live Aetna sandbox 271 (verification 32dc3a29), which answered a dental
// inquiry with a purely medical benefit set — no EB03 in the whole file names a dental service
// type. `EB*F*FAM*48***23*240`, a hospital-inpatient FAMILY limitation, became the patient's dental
// annual maximum ($240 / $190), and medical `EB*C` segments became a $0 deductible. Both then
// scored 0.9 confidence, because confidence tests non-nullness and not provenance.

test("B1: a `35` segment wins outright over every other qualification", () => {
  const p = parse271(
    build([
      ebOfType("F", "IND", "36", "23", "1000"), // major services — real dental, but a category
      ["EB", "F", "IND", "", "", "", "23", "1750"].join("*"), // unqualified
      eb("F", "IND", "23", "1500", "Y"), // `35`, dental care itself
    ])
  );
  assert.equal(p.annualMaximum.amount, 1500, "explicit dental care outranks both category and unqualified");
});

test("B1: a category service type is used when nothing states `35`", () => {
  const p = parse271(build([ebOfType("F", "IND", "36", "23", "1000"), ebOfType("F", "IND", "36", "29", "800")]));
  assert.equal(p.annualMaximum.amount, 1000, "a major-services maximum is real dental evidence");
  assert.equal(p.annualMaximum.remaining, 800);
});

test("B1: a NON-DENTAL service type is refused outright, not admitted as a fallback", () => {
  // The exact shape from the live Aetna response: a hospital-inpatient family limitation, and a
  // medical deductible, in a file with no dental service type anywhere.
  const p = parse271(
    build([
      ebOfType("F", "FAM", "48", "23", "240"),
      ebOfType("F", "FAM", "48", "29", "190"),
      ebOfType("C", "FAM", "30", "23", "0"),
      ebOfType("C", "FAM", "30", "29", "0"),
    ])
  );

  assert.equal(p.annualMaximum.amount, null, "a hospital limitation must never become the dental maximum");
  assert.equal(p.annualMaximum.remaining, null);
  assert.equal(p.deductible.annual, null, "a medical deductible must never become the dental deductible");
  assert.equal(p.deductible.remaining, null);
  // Refused, not silently dropped: the reviewer can still see the payer offered something.
  assert.ok(p.trace.supersededBenefits > 0, "the discarded non-dental benefits stay on the record");
});

test("B1: a composite EB03 carrying any non-dental component is refused entirely", () => {
  // `UC^86` and `48^50` both appear in the live Aetna file. A benefit qualified as dental AND
  // something else does not establish a dental figure, and guessing which half the amount belongs
  // to is the inference this rejection exists to prevent.
  const mixed = parse271(build([ebOfType("F", "IND", "35^48", "23", "1500")]));
  assert.equal(mixed.annualMaximum.amount, null, "one non-dental component disqualifies the segment");

  // All-dental composites are still judged, on their best component.
  const allDental = parse271(build([ebOfType("F", "IND", "36^35", "23", "1500")]));
  assert.equal(allDental.annualMaximum.amount, 1500, "every component is dental, so the segment qualifies");
});

test("M9: a superseded benefit is counted, so a surprising estimate can be explained", () => {
  const p = parse271(
    build([ebOfType("F", "IND", "38", "23", "1000"), eb("F", "IND", "23", "1500", "Y")])
  );
  assert.ok(p.trace.supersededBenefits > 0, "the payer offered another scope and it is on the record");
});
