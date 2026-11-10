import { test } from "node:test";
import assert from "node:assert/strict";
import { can, isRole, ROLES, PERMISSIONS } from "../roles.ts";

test("owner and admin have every permission", () => {
  for (const p of PERMISSIONS.owner) assert.ok(can("owner", p));
  assert.ok(can("owner", "users.manage"));
  assert.ok(can("admin", "org.manage"));
});

test("auditor is read-only everywhere — no write permission", () => {
  const writes = [...PERMISSIONS.owner].filter((p) => p.endsWith(".write") || p === "users.manage" || p === "org.manage");
  for (const w of writes) assert.equal(can("auditor", w), false, `auditor must not have ${w}`);
  assert.ok(can("auditor", "claims.read"));
  assert.ok(can("auditor", "audit.read"));
});

test("front_desk cannot touch claims or billing", () => {
  assert.equal(can("front_desk", "claims.write"), false);
  assert.equal(can("front_desk", "remittances.write"), false);
  assert.ok(can("front_desk", "patients.write"));
  assert.ok(can("front_desk", "verifications.read"));
});

test("insurance_coordinator can verify but not bill", () => {
  assert.ok(can("insurance_coordinator", "verifications.write"));
  assert.equal(can("insurance_coordinator", "claims.write"), false);
  assert.equal(can("insurance_coordinator", "users.manage"), false);
});

test("biller can work the back half but not manage users", () => {
  assert.ok(can("biller", "claims.write"));
  assert.ok(can("biller", "remittances.write"));
  assert.ok(can("biller", "appeals.write"));
  assert.equal(can("biller", "users.manage"), false);
  assert.equal(can("biller", "payers.write"), false);
});

test("dentist has narrow appeal access only", () => {
  assert.ok(can("dentist", "appeals.write"));
  assert.ok(can("dentist", "verifications.read"));
  assert.equal(can("dentist", "claims.write"), false);
});

/**
 * The role held `appeals.write` but not `denials.read`, so a dentist could approve and send an
 * appeal against a payer decision they were forbidden to read — the dangerous half of the screen
 * granted and the harmless half withheld. A denial and its appeal are one piece of work.
 */
test("a dentist can READ what they are allowed to appeal", () => {
  assert.ok(can("dentist", "appeals.write"), "the whole point of the role");
  assert.ok(can("dentist", "denials.read"), "and therefore the denial being appealed");
});

/**
 * …but writing revenue off is a decision about whose money it is, not a clinical one. `denials.write`
 * gates closing a denial (written off, or moved to the patient's balance) and stays with the roles
 * that own the money.
 */
test("a dentist cannot decide whose money a denial is", () => {
  assert.equal(can("dentist", "denials.write"), false, "closing a denial is a billing decision");
  assert.equal(can("dentist", "patients.write"), false);
  assert.equal(can("dentist", "remittances.write"), false);
  for (const role of ["biller", "office_manager", "owner", "admin"] as const) {
    assert.ok(can(role, "denials.write"), `${role} owns the money and must still be able to close one`);
  }
});

test("isRole guards unknown strings and there are exactly 8 roles", () => {
  assert.equal(ROLES.length, 8);
  assert.ok(isRole("owner"));
  assert.equal(isRole("superuser"), false);
  assert.equal(isRole(42), false);
});
