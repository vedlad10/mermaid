/**
 * The output gate. These tests are about one property: an answer that is not the shape we asked for
 * is REFUSED, not repaired. Everything downstream — a member ID going to a payer, a sentence a
 * biller signs — assumes that.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeSchema, parseJsonObject, validate } from "../schema.ts";
import { schema } from "../adapter.ts";

interface Card {
  payerName: string | null;
  memberId: string | null;
  active: boolean;
}

const CARD = schema<Card>({
  payerName: { kind: "string", nullable: true, maxLength: 80 },
  memberId: { kind: "string", nullable: true, maxLength: 40 },
  active: { kind: "boolean" },
});

describe("parseJsonObject", () => {
  it("reads a bare JSON object", () => {
    const result = parseJsonObject('{"a":1}');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { a: 1 });
  });

  it("unwraps a fenced block, because models add fences no matter what the prompt says", () => {
    const result = parseJsonObject('```json\n{"a":1}\n```');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { a: 1 });
  });

  it("unwraps conversational preamble around the object", () => {
    const result = parseJsonObject('Sure! Here is the result:\n{"a":1}\nLet me know if you need more.');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { a: 1 });
  });

  it("refuses a top-level array — the schema describes an object", () => {
    assert.equal(parseJsonObject("[1,2,3]").ok, false);
  });

  it("refuses prose with no object in it", () => {
    assert.equal(parseJsonObject("I could not read the card.").ok, false);
  });

  it("refuses an empty response", () => {
    assert.equal(parseJsonObject("   ").ok, false);
  });
});

describe("validate", () => {
  it("accepts a well-formed object and trims its strings", () => {
    const result = validate(CARD, { payerName: "  Delta Dental ", memberId: "ABC12345", active: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { payerName: "Delta Dental", memberId: "ABC12345", active: true });
  });

  it("drops unknown keys rather than failing — the asked-for fields were still answered", () => {
    const result = validate(CARD, { payerName: "Cigna", memberId: "X1", active: false, notes: "looked blurry" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && Object.hasOwn(result.value as object, "notes"), false);
  });

  it("fails when a field is missing entirely", () => {
    const result = validate(CARD, { payerName: "Cigna", memberId: "X1" });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.errors.join() : "", /"active" is missing/);
  });

  it("treats the strings models write for absence as null, on nullable fields", () => {
    for (const marker of ["N/A", "none", "not visible", "unknown", "-", ""]) {
      const result = validate(CARD, { payerName: marker, memberId: "X1", active: true });
      assert.equal(result.ok, true, `expected "${marker}" to be accepted as absent`);
      assert.equal(result.ok && (result.value as Card).payerName, null);
    }
  });

  it("does NOT coerce a stringified number — a model answering in the wrong type has not answered", () => {
    const money = schema<{ amount: number }>({ amount: { kind: "number" } });
    const result = validate(money, { amount: "1,250.00" });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.errors.join() : "", /must be a finite number/);
  });

  it("rejects NaN and Infinity, which JSON.parse can produce via unusual input", () => {
    const money = schema<{ amount: number }>({ amount: { kind: "number" } });
    assert.equal(validate(money, { amount: Number.NaN }).ok, false);
    assert.equal(validate(money, { amount: Number.POSITIVE_INFINITY }).ok, false);
  });

  it("enforces maxLength, so a runaway answer cannot become a field", () => {
    const result = validate(CARD, { payerName: "x".repeat(200), memberId: "X1", active: true });
    assert.equal(result.ok, false);
  });

  it("enforces a pattern when one is given", () => {
    const npi = schema<{ npi: string }>({ npi: { kind: "string", pattern: /^\d{10}$/ } });
    assert.equal(validate(npi, { npi: "1234567893" }).ok, true);
    assert.equal(validate(npi, { npi: "12345" }).ok, false);
  });

  it("enforces an enum's values", () => {
    const s = schema<{ status: string }>({ status: { kind: "enum", values: ["active", "inactive"] } });
    assert.equal(validate(s, { status: "active" }).ok, true);
    assert.equal(validate(s, { status: "probably active" }).ok, false);
  });

  it("validates string arrays and drops blank items", () => {
    const s = schema<{ tags: string[] }>({ tags: { kind: "stringArray", maxItems: 3 } });
    const result = validate(s, { tags: ["a", "  ", "b"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && (result.value as { tags: string[] }).tags, ["a", "b"]);
    assert.equal(validate(s, { tags: ["a", "b", "c", "d"] }).ok, false);
    assert.equal(validate(s, { tags: [1, 2] }).ok, false);
  });

  it("reports every problem at once, so a degrade is diagnosable from one log line", () => {
    const result = validate(CARD, { active: "yes" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.errors.length, 3);
  });

  it("refuses null on a non-nullable field", () => {
    const result = validate(CARD, { payerName: null, memberId: null, active: null });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.errors.join() : "", /"active" was null/);
  });
});

describe("describeSchema", () => {
  it("names every field, so the prompt and the validator cannot drift", () => {
    const description = describeSchema(CARD);
    for (const field of Object.keys(CARD.fields)) {
      assert.match(description, new RegExp(`"${field}"`));
    }
  });

  it("tells the model to use null where the validator accepts null", () => {
    assert.match(describeSchema(CARD), /"payerName": string \| null/);
  });
});
