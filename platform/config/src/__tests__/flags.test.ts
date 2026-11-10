import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, isKnownFlag, FEATURE_FLAGS } from "../flags.ts";

test("all phase flags default OFF (nothing implemented ships enabled)", () => {
  for (const def of Object.values(FEATURE_FLAGS)) {
    assert.equal(def.default, false, `${def.name} must default OFF`);
    assert.equal(isEnabled(def.name), false);
  }
});

test("a per-practice override wins over the default", () => {
  assert.equal(isEnabled("verification.enabled", { "verification.enabled": true }), true);
  assert.equal(isEnabled("remittance.autopost", { "verification.enabled": true }), false);
});

test("explicit false override is respected (not treated as absent)", () => {
  assert.equal(isEnabled("claims.enabled", { "claims.enabled": false }), false);
});

test("isKnownFlag guards unknown names", () => {
  assert.ok(isKnownFlag("learning.loop"));
  assert.equal(isKnownFlag("totally.made.up"), false);
  assert.equal(isKnownFlag(123), false);
});
