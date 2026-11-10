import { test } from "node:test";
import assert from "node:assert/strict";
import { build270, build271, parse271, parseSegments } from "../mock/x12-271.ts";

const activeInput = {
  payerName: "Delta Dental",
  planName: "Delta Dental PPO",
  memberId: "ABC12345",
  active: true,
  coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
  deductibleAnnual: 50,
  deductibleRemaining: 25,
  annualMaximum: 1500,
  annualMaximumRemaining: 900,
};

test("build271 → parse271 round-trips an active plan (production parser exercised)", () => {
  const parsed = parse271(build271(activeInput, new Date("2026-07-15")));
  assert.equal(parsed.eligibility, "active");
  assert.equal(parsed.planName, "Delta Dental PPO");
  assert.equal(parsed.memberId, "ABC12345");
  assert.equal(parsed.coveragePercentages.basic, 80);
  assert.equal(parsed.coveragePercentages.major, 50);
  assert.equal(parsed.deductible.annual, 50);
  assert.equal(parsed.deductible.remaining, 25);
  assert.equal(parsed.annualMaximum.amount, 1500);
  assert.equal(parsed.annualMaximum.remaining, 900);
  assert.ok(parsed.trace.benefitSegments > 0);
});

test("build271 → parse271 reports inactive coverage", () => {
  const parsed = parse271(build271({ ...activeInput, active: false }, new Date("2026-07-15")));
  assert.equal(parsed.eligibility, "inactive");
});

test("parse271 rejects a non-271 payload", () => {
  const notA271 = build270(
    { payerName: "Delta Dental", payerId: "DELTA", providerName: "CLINIC", providerNpi: "1234567890", subscriberLastName: "Alpha", subscriberFirstName: "Ada", memberId: "ABC12345", dateOfBirth: "1990-01-01" },
    new Date("2026-07-15")
  );
  assert.throws(() => parse271(notA271), /not an X12 271/);
});

test("parse271 fails loud on empty input and on a 271 with no benefit segments", () => {
  assert.throws(() => parse271(""), /Empty EDI payload/);
  // A 271 envelope with no EB segments must throw rather than yield a silent zero-benefit plan.
  const bare = "ST*271*0001~NM1*PR*2*Delta~SE*3*0001~";
  assert.throws(() => parse271(bare), /no EB benefit segments/);
});

test("build270 produces a 270 eligibility inquiry with the dental EQ", () => {
  const raw = build270(
    { payerName: "Cigna", payerId: "CIGNA", providerName: "CLINIC", providerNpi: "1234567890", subscriberLastName: "Beta", subscriberFirstName: "Ben", memberId: "XYZ99887", dateOfBirth: "1985-05-05" },
    new Date("2026-07-15")
  );
  const segs = parseSegments(raw);
  assert.ok(segs.find((s) => s.id === "ST" && s.elements[0] === "270"));
  assert.ok(segs.find((s) => s.id === "EQ" && s.elements[0] === "35"));
});
