import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeRequest } from "../guard.ts";
import { AuthError, type ResolvedSession } from "../types.ts";
import { asId } from "@mermaid/shared";

const session = (role: string): ResolvedSession => ({
  tokenHash: "hash",
  csrf: "csrf-token",
  mfaPending: false,
  user: { id: asId("u1"), practiceId: asId("p1"), email: "x@y.z", name: "X", role: role as ResolvedSession["user"]["role"] },
});

test("unauthenticated request is rejected 401", () => {
  assert.throws(
    () => authorizeRequest(null, { method: "GET", csrfHeader: null, permission: "claims.read" }),
    (e: unknown) => e instanceof AuthError && e.status === 401 && e.code === "unauthenticated"
  );
});

test("a read passes when the role has the permission", () => {
  const s = authorizeRequest(session("biller"), { method: "GET", csrfHeader: null, permission: "claims.read" });
  assert.equal(s.user.role, "biller");
});

test("a role lacking the permission is forbidden 403", () => {
  assert.throws(
    () => authorizeRequest(session("front_desk"), { method: "GET", csrfHeader: null, permission: "claims.read" }),
    (e: unknown) => e instanceof AuthError && e.status === 403 && e.code === "forbidden"
  );
});

test("a mutation without a matching CSRF token is rejected 403", () => {
  assert.throws(
    () => authorizeRequest(session("biller"), { method: "POST", csrfHeader: "wrong", permission: "claims.write" }),
    (e: unknown) => e instanceof AuthError && e.code === "csrf"
  );
  assert.throws(
    () => authorizeRequest(session("biller"), { method: "POST", csrfHeader: null, permission: "claims.write" }),
    (e: unknown) => e instanceof AuthError && e.code === "csrf"
  );
});

test("a mutation with the matching CSRF token and permission passes", () => {
  const s = authorizeRequest(session("biller"), { method: "POST", csrfHeader: "csrf-token", permission: "claims.write" });
  assert.equal(s.user.role, "biller");
});

test("csrfExempt routes (login/logout) skip the CSRF check", () => {
  const s = authorizeRequest(session("owner"), {
    method: "POST", csrfHeader: null, permission: null, csrfExempt: true,
  });
  assert.equal(s.user.role, "owner");
});

test("auditor cannot perform a write even with a valid CSRF token", () => {
  assert.throws(
    () => authorizeRequest(session("auditor"), { method: "POST", csrfHeader: "csrf-token", permission: "claims.write" }),
    (e: unknown) => e instanceof AuthError && e.code === "forbidden"
  );
});

// ── A password alone is not a sign-in when a second factor is owed (0038) ─────────────────────

test("a session still owed its second factor is refused everywhere, whatever its role", () => {
  const pending = { ...session("owner"), mfaPending: true };
  for (const permission of [null, "claims.read", "users.manage"] as const) {
    assert.throws(
      () => authorizeRequest(pending, { method: "GET", csrfHeader: null, permission }),
      (e: unknown) => e instanceof AuthError && e.status === 401 && e.code === "mfa_required",
      String(permission)
    );
  }
});

test("…except on the MFA step itself, where CSRF still applies", () => {
  const pending = { ...session("owner"), mfaPending: true };
  assert.equal(
    authorizeRequest(pending, { method: "POST", csrfHeader: "csrf-token", permission: null, allowMfaPending: true }),
    pending
  );
  assert.throws(
    () => authorizeRequest(pending, { method: "POST", csrfHeader: "wrong", permission: null, allowMfaPending: true }),
    (e: unknown) => e instanceof AuthError && e.code === "csrf"
  );
});
