/**
 * Request authorization. `authorizeRequest` is the PURE decision (CSRF + RBAC) given an already
 * resolved session — unit-testable without a DB. `guard` (in service.ts) resolves the session from
 * the cookie first, then delegates here.
 */
import { can, type Permission } from "@mermaid/shared";
import { AuthError, type ResolvedSession } from "./types.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RequestMeta {
  method: string;
  csrfHeader: string | null;
  /** Permission required by the route; null = any authenticated user. */
  permission: Permission | null;
  /** Routes exempt from CSRF (login/logout issue/clear the cookie themselves). */
  csrfExempt?: boolean;
  /**
   * Routes a session that has not yet given its second factor may reach (0038): the MFA step itself
   * and signing out. Everything else refuses such a session, whatever its role.
   */
  allowMfaPending?: boolean;
}

/**
 * Decide whether a resolved session may perform this request. Throws a typed AuthError otherwise.
 * Order: authentication → CSRF (mutations) → RBAC.
 */
export function authorizeRequest(session: ResolvedSession | null, meta: RequestMeta): ResolvedSession {
  if (!session) throw new AuthError(401, "unauthenticated", "login required");
  /**
   * Before CSRF and RBAC: a password alone is not a sign-in when a second factor is owed, so the
   * session's role means nothing yet. 401, so the client returns to the sign-in step.
   */
  if (session.mfaPending && !meta.allowMfaPending) {
    throw new AuthError(401, "mfa_required", "Finish signing in: enter the code from your authenticator app.");
  }

  if (MUTATING.has(meta.method.toUpperCase()) && !meta.csrfExempt) {
    if (!meta.csrfHeader || meta.csrfHeader !== session.csrf) {
      throw new AuthError(403, "csrf", "missing or invalid CSRF token");
    }
  }

  if (meta.permission && !can(session.user.role, meta.permission)) {
    /**
     * Addressed to the person, not to the developer.
     *
     * This used to read "role dentist lacks queue.read", and the client shows an API error message
     * verbatim. So a clinician who opened the wrong screen was handed an internal permission
     * identifier and no idea what to do about it. The role name and the permission are still here
     * -- they are what a support conversation needs -- but the sentence now says what happened and
     * who can change it.
     */
    throw new AuthError(
      403,
      "forbidden",
      `Your role (${session.user.role.replace(/_/g, " ")}) does not have access to this. ` +
        `An owner or office manager can grant it. [${meta.permission}]`
    );
  }

  return session;
}
