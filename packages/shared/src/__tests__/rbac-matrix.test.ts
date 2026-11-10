/**
 * Properties the permission matrix must have, stated as tests rather than as comments.
 *
 * `roles.ts` asserts several things about itself in prose — "the auditor role is read-only
 * everywhere by construction", the contractual override is "a different set from `denials.write`"
 * held by somebody for whom the decision "is not routine". Those are exactly the claims that decay:
 * a permission added to a shared list years later can falsify any of them silently, because the
 * lists are composed (`[...READ, ...WORK]`) and nobody re-reads the prose.
 *
 * Every assertion below is derived from the matrix itself, never from a restated list of roles or
 * permissions. A test that hard-coded the expected sets would be a second copy of the thing under
 * test, and would agree with itself after the matrix had drifted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, ROLES, can } from "../roles.ts";
import type { Permission, Role } from "../roles.ts";

/** Anything that changes state. Derived from the permission's own name, not from a list. */
const mutating = (p: Permission): boolean => /\.(write|manage)$/.test(p) || p.endsWith("_override");

test("the auditor is read-only everywhere, by construction and not by intention", () => {
  const writes = PERMISSIONS.auditor.filter(mutating);
  assert.deepEqual(
    writes,
    [],
    `the auditor holds ${writes.join(", ")} — the role exists so somebody can see everything and change nothing`
  );
});

test("every role that may change something may also see it", () => {
  /**
   * A role with `x.write` and no `x.read` can act on records it cannot open. That is not a
   * theoretical tidiness point: the dentist role had exactly this shape — `appeals.write` without
   * `denials.read` — so a dentist could approve and send an appeal against a payer decision they
   * were not allowed to look at.
   */
  for (const role of ROLES) {
    for (const permission of PERMISSIONS[role]) {
      const match = /^(\w+)\.write$/.exec(permission);
      if (!match) continue;
      const read = `${match[1]}.read` as Permission;
      assert.ok(can(role, read), `${role} holds ${permission} but not ${read}`);
    }
  }
});

test("the contractual override is held by strictly fewer roles than closing a denial", () => {
  /**
   * The separation IS the control. Billing a patient for an adjustment the payer assigned to the
   * practice is a decision about whose money it is, and `roles.ts` says it belongs to somebody for
   * whom it is not routine. If the two sets ever became equal, the biller who closes denials all day
   * would hold it and the control would be gone while every test still passed.
   */
  const override = ROLES.filter((r) => can(r, "denials.bill_patient_override"));
  const close = ROLES.filter((r) => can(r, "denials.write"));

  assert.ok(override.length > 0, "somebody must be able to make the call");
  assert.ok(
    override.length < close.length,
    `override is held by ${override.length} role(s) and denials.write by ${close.length} — no longer narrower`
  );
  for (const role of override) {
    assert.ok(can(role, "denials.write"), `${role} may override the bar but not close a denial — incoherent`);
  }
});

test("no role can bill a patient against contract without also being able to see the denial", () => {
  for (const role of ROLES.filter((r) => can(r, "denials.bill_patient_override"))) {
    assert.ok(can(role, "denials.read"), `${role} may override on a denial it cannot read`);
    assert.ok(can(role, "patients.read"), `${role} may bill a patient whose account it cannot see`);
  }
});

test("the front desk cannot touch money", () => {
  /**
   * The role most people hold and the one most likely to be shared. It exists to check patients in;
   * every money permission is deliberately absent, and this is where that stays true.
   */
  for (const permission of ["claims.write", "remittances.write", "denials.write", "denials.bill_patient_override"] as Permission[]) {
    assert.equal(can("front_desk", permission), false, `front_desk holds ${permission}`);
  }
});

test("the dentist holds the clinical voice and no disposition of money", () => {
  assert.ok(can("dentist", "appeals.write"), "a dentist must be able to put their name to an appeal");
  assert.equal(
    can("dentist", "denials.write"),
    false,
    "closing a denial decides whose money it is — that is not a clinical judgement"
  );
  assert.equal(can("dentist", "denials.bill_patient_override"), false);
});

test("an unknown role is refused everything", () => {
  /** `can` is the server-side decision. A role it does not recognise must not fall open. */
  for (const permission of [...PERMISSIONS.owner]) {
    assert.equal(can("not_a_role" as Role, permission), false, `an unknown role was granted ${permission}`);
  }
});
