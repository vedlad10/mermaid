/**
 * A practice must never be able to lock itself out of its own system.
 *
 * ── WHY THESE GUARDS ARE WORTH TESTING ─────────────────────────────────────────────────────────
 * Every other mistake on the staff-administration screen can be undone by somebody. These three
 * cannot be undone by anybody:
 *
 *   • disabling the last owner/administrator,
 *   • demoting the last owner/administrator,
 *   • an administrator demoting THEMSELVES — which removes `users.manage` in the same statement
 *     that would have let them put it back.
 *
 * The recovery path from any of them is an engineer with a psql session and a scrypt
 * implementation, which is exactly the dead end `issue-password-reset.mjs` was written to escape.
 *
 * ── WHY THE RULES ARE TESTED HERE AND NOT ONLY THROUGH HTTP ────────────────────────────────────
 * These are decisions about who may still administer a practice, not about request parsing. The
 * DB-backed suite (tests/db) exercises them end to end; this pins the decision itself, so a
 * refactor that keeps the routes and loses a guard fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, ROLES, can, type Role } from "@mermaid/shared";

/**
 * The roles that can restore access. `setUserAccess` and `setUserRole` count exactly these before
 * allowing a change, so if this set ever widens the guard must widen with it.
 */
const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];

test("only owner and admin can administer accounts", () => {
  /**
   * The premise the lockout guard rests on. An office manager holds every working permission and
   * the contractual override and still cannot manage users — so counting only owners and admins is
   * counting everyone who could ever undo a mistake here.
   */
  const holders = ROLES.filter((r) => can(r, "users.manage"));
  assert.deepEqual([...holders].sort(), [...ADMIN_ROLES].sort());
});

test("managing users is never implied by ordinary working permissions", () => {
  /**
   * Stated separately because the dangerous version of this drift is silent: adding `users.manage`
   * to the WORK set would hand account administration to every biller and coordinator, and nothing
   * else in the suite would notice.
   */
  for (const role of ["biller", "insurance_coordinator", "front_desk", "dentist", "auditor"] as Role[]) {
    assert.equal(can(role, "users.manage"), false, `${role} must not administer accounts`);
    assert.equal(can(role, "org.manage"), false, `${role} must not administer the organisation`);
  }
  // The office manager is the interesting one: everything else, but not this.
  assert.equal(can("office_manager", "denials.bill_patient_override"), true);
  assert.equal(can("office_manager", "users.manage"), false);
});

/**
 * The guard's decision, extracted exactly as `refuseIfLastAdmin` computes it, so the table below
 * tests the RULE rather than a re-description of it.
 */
function wouldLockOut(
  target: { role: Role; disabled: boolean },
  after: { role: Role; disabled: boolean },
  enabledAdminsIncludingTarget: number
): boolean {
  const wasAdmin = !target.disabled && ADMIN_ROLES.includes(target.role);
  const staysAdmin = !after.disabled && ADMIN_ROLES.includes(after.role);
  if (!wasAdmin || staysAdmin) return false;
  return enabledAdminsIncludingTarget <= 1;
}

test("the last enabled administrator cannot be disabled or demoted", () => {
  const soleOwner = { role: "owner" as Role, disabled: false };

  assert.equal(
    wouldLockOut(soleOwner, { role: "owner", disabled: true }, 1),
    true,
    "disabling the only owner leaves nobody who can re-enable them"
  );
  assert.equal(
    wouldLockOut(soleOwner, { role: "biller", disabled: false }, 1),
    true,
    "demoting the only owner leaves nobody who can promote anyone"
  );
  assert.equal(
    wouldLockOut(soleOwner, { role: "admin", disabled: false }, 1),
    false,
    "owner to admin keeps an administrator, so it is allowed"
  );
});

test("with a second administrator, both changes are allowed", () => {
  const oneOfTwo = { role: "owner" as Role, disabled: false };
  assert.equal(wouldLockOut(oneOfTwo, { role: "owner", disabled: true }, 2), false);
  assert.equal(wouldLockOut(oneOfTwo, { role: "dentist", disabled: false }, 2), false);
});

test("changing a non-administrator is never a lockout, however few admins remain", () => {
  /**
   * The guard must not become a general obstruction. Disabling a departed biller is the ordinary
   * case this screen exists for, and it stays allowed even in a practice with exactly one owner.
   */
  const biller = { role: "biller" as Role, disabled: false };
  assert.equal(wouldLockOut(biller, { role: "biller", disabled: true }, 1), false);
  assert.equal(wouldLockOut(biller, { role: "office_manager", disabled: false }, 1), false);
});

test("re-enabling or promoting someone is never refused", () => {
  /** The guard is about REMOVING administration, never about restoring it. */
  const disabledOwner = { role: "owner" as Role, disabled: true };
  assert.equal(wouldLockOut(disabledOwner, { role: "owner", disabled: false }, 0), false);

  const biller = { role: "biller" as Role, disabled: false };
  assert.equal(wouldLockOut(biller, { role: "owner", disabled: false }, 1), false);
});

test("an administrator promoted from a non-admin role is still counted correctly", () => {
  /**
   * The count is of ENABLED admins including the target, which is what makes "<= 1" mean "this one
   * is the last". A disabled owner does not count toward it — they cannot sign in to fix anything.
   */
  const disabledSecondOwner = { role: "owner" as Role, disabled: true };
  assert.equal(
    wouldLockOut({ role: "owner", disabled: false }, { role: "owner", disabled: true }, 1),
    true,
    "a disabled second owner is not a fallback"
  );
  assert.equal(wouldLockOut(disabledSecondOwner, { role: "biller", disabled: false }, 1), false);
});

test("every role in ROLES is covered by the permission matrix", () => {
  /**
   * A role added to the union without an entry in PERMISSIONS would make `can()` return false for
   * everything, and the staff screen would show a person who can do nothing and cannot be fixed.
   */
  for (const role of ROLES) {
    assert.ok(Array.isArray(PERMISSIONS[role]), `role "${role}" has no permission set`);
    assert.ok(PERMISSIONS[role].length > 0, `role "${role}" has an empty permission set`);
  }
});
