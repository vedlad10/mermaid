/**
 * Every authentication event, on the audit trail (NEW-05).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `recordAudit` had exactly one production call site: `auditRequest`, which writes a row for each
 * non-GET API request that reaches a handler. Authentication happens BEFORE that — `handleAuthApi`
 * runs outside the per-request transaction, and a failed login never gets that far at all.
 *
 * So the audit trail recorded what people did with their sessions and nothing whatever about how
 * those sessions came to exist. Sign-ins, sign-outs, failed sign-ins and password resets — the
 * events a breach investigation opens with, and the ones HIPAA §164.312(b) exists for — were
 * visible only in an application log, which is not append-only, not tenant-scoped, and not
 * retained on the same terms.
 *
 * ── WHY THIS LIVES IN THE AUTH MODULE ────────────────────────────────────────────────────────────
 * The route could write these rows, and it would be wrong twice over. A failed login is the case
 * that matters most, and the route deliberately cannot see WHY it failed — `authenticate` collapses
 * "no such user", "wrong password" and "account disabled" into one `AuthError` precisely so the
 * response cannot be used to enumerate accounts. That distinction is exactly what a security
 * reviewer needs ("is someone guessing against a REAL account?"), and this is the only layer that
 * holds it. Recording it here keeps it out of the response and in the log where it belongs.
 *
 * The second reason is coverage: any future caller of `login`, from a CLI or a test harness or a
 * second front end, is audited because the function audits itself.
 *
 * ── WHAT IS NEVER RECORDED ───────────────────────────────────────────────────────────────────────
 * The attempted password, in any form — not the value, not its length, not a hash. A password typed
 * into the wrong field is one of the most common ways a real credential ends up in a log, and the
 * audit table is retained for years and readable by every auditor in the practice. There is no
 * parameter here that could carry one.
 */
import { withoutPractice } from "@mermaid/db/pool";
import { logger, recordAudit } from "@mermaid/observability";
import { randomUUID } from "node:crypto";

/** The authentication events worth a row. `resource` is always `session` or `credential`. */
export type AuthAction =
  | "login"
  | "logout"
  /** Ended by the server because nobody used it for SESSION_IDLE_MINUTES — automatic logoff. */
  | "session_idle_expired"
  /** Second factor (0038): the password was right and a code was asked for; the code was wrong. */
  | "mfa_challenged"
  | "mfa_failed"
  /** A person enrolled an authenticator, turned theirs off, or had an administrator clear it. */
  | "mfa_enrolled"
  | "mfa_disabled"
  | "mfa_reset"
  | "password_reset_requested"
  | "password_reset_confirmed";

/**
 * Why a login failed — recorded, never returned.
 *
 * `no_such_user` and `bad_password` are indistinguishable to the person at the keyboard by design.
 * They are very different facts to somebody reading the log a month later: a thousand
 * `no_such_user` rows are a scanner, a thousand `bad_password` rows against one address are an
 * attack on a specific person's account.
 */
export type LoginFailure = "no_such_user" | "bad_password" | "account_disabled";

export interface AuthAuditEvent {
  action: AuthAction;
  outcome: "success" | "denied" | "error";
  /** Known only once a real user has been resolved. Null for a failed or anonymous attempt. */
  practiceId?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  /**
   * The email as TYPED, lower-cased. It is an identifier the person offered, not PHI, and without
   * it a failed-login row says only that somebody failed — which answers nothing.
   */
  email?: string | null;
  ip?: string | null;
  reason?: LoginFailure | null;
  traceId?: string;
}

/**
 * Write one authentication event.
 *
 * ── WHY A FAILURE HERE DOES NOT FAIL THE REQUEST ─────────────────────────────────────────────────
 * The successful-login row is written inside the same transaction as the session insert (see
 * `login`), so for that event a lost audit row means a lost session — the strict coupling the
 * request auditor already uses. Everything else runs in its own transaction, and the alternative to
 * swallowing a failure is worse in each case: a 500 on a failed login turns the audit table into an
 * availability dependency of the sign-in page AND leaks that something unusual happened, and a 500
 * on logout leaves the session cookie live because the deletion already committed.
 *
 * So it is logged at error level on the security channel, where the operational alerting is, and
 * the caller proceeds. That is a stated trade-off rather than a silent catch.
 */
export async function recordAuthEvent(e: AuthAuditEvent): Promise<void> {
  try {
    await withoutPractice((tx) =>
      recordAudit(tx, {
        practiceId: e.practiceId ?? null,
        traceId: e.traceId ?? randomUUID(),
        actorId: e.actorId ?? null,
        actorRole: e.actorRole ?? null,
        action: e.action,
        resource: e.action.startsWith("password_reset") ? "credential" : "session",
        // The subject of the event, for a row whose actor is unknown. A failed login has no
        // actor_id to key on, and "which account was targeted" is the first question asked of it.
        resourceId: e.email ? e.email.trim().toLowerCase() : null,
        outcome: e.outcome,
        ip: e.ip ?? null,
        // NEVER the password, or anything derived from it. See the module header.
        ...(e.reason ? { after: { reason: e.reason } } : {}),
      })
    );
  } catch (err) {
    logger.error("Failed to write an authentication audit row.", {
      channel: "security",
      action: e.action,
      outcome: e.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Write one authentication event on a transaction the caller already owns.
 *
 * Used by `login` so the row commits WITH the session it describes: a session that exists with no
 * record of being created, or a record of a sign-in that did not happen, are both worse than a
 * sign-in that failed outright.
 */
export async function recordAuthEventInTx(
  tx: Parameters<typeof recordAudit>[0],
  e: AuthAuditEvent
): Promise<void> {
  await recordAudit(tx, {
    practiceId: e.practiceId ?? null,
    traceId: e.traceId ?? randomUUID(),
    actorId: e.actorId ?? null,
    actorRole: e.actorRole ?? null,
    action: e.action,
    resource: e.action.startsWith("password_reset") ? "credential" : "session",
    resourceId: e.email ? e.email.trim().toLowerCase() : null,
    outcome: e.outcome,
    ip: e.ip ?? null,
    ...(e.reason ? { after: { reason: e.reason } } : {}),
  });
}
