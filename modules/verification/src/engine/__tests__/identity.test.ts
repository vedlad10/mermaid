/**
 * Patient identity resolution.
 *
 * The property under test is the one the unified RCM workflow's central node depends on: the same
 * human, arriving twice, must be the same record. Everything else in this system keys off that —
 * a balance, a history, a statement someone reads aloud.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveChartId, sameIdentity } from "../identity.ts";

const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

test("the same identity always derives the same chart id", () => {
  assert.equal(deriveChartId(ada), deriveChartId({ ...ada }));
});

test("a chart id is stable across trivial differences in how a name was typed", () => {
  // These are the same person typed by three different receptionists.
  for (const variant of [
    { firstName: "ada", lastName: "alpha", dateOfBirth: "1990-04-12" },
    { firstName: "  Ada  ", lastName: "Alpha ", dateOfBirth: "1990-04-12" },
    { firstName: "ADA", lastName: "ALPHA", dateOfBirth: "1990-04-12T00:00:00Z" },
  ]) {
    assert.equal(deriveChartId(variant), deriveChartId(ada), `"${variant.firstName}" must resolve to Ada`);
  }
});

test("a different date of birth is a different person — a parent and child sharing a name do not merge", () => {
  const child = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "2016-04-12" };
  assert.notEqual(deriveChartId(child), deriveChartId(ada));
  assert.equal(sameIdentity(child, ada), false);
});

test("a different surname is a different person", () => {
  assert.notEqual(deriveChartId({ ...ada, lastName: "Beta" }), deriveChartId(ada));
});

test("spelling differences a human should reconcile are NOT silently merged", () => {
  // Deliberate: merging "O'Brien" and "OBrien" would be the identity system making a
  // clinical-record decision on its own. They stay distinct until a person says otherwise.
  assert.notEqual(
    deriveChartId({ firstName: "Sean", lastName: "O'Brien", dateOfBirth: "1980-01-01" }),
    deriveChartId({ firstName: "Sean", lastName: "OBrien", dateOfBirth: "1980-01-01" })
  );
});

test("a chart id is sayable and does not leak the patient's name or birth date", () => {
  const id = deriveChartId(ada);
  assert.match(id, /^MRM-[0-9A-F]{10}$/, "short, prefixed, and quotable over the phone");
  assert.ok(!id.toLowerCase().includes("ada"));
  assert.ok(!id.toLowerCase().includes("alpha"));
  assert.ok(!id.includes("1990"), "a chart id is quoted where a birth date should not be");
});
