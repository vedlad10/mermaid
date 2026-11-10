/**
 * The second factor (migration 0038): enrol an authenticator, prove it at sign-in, turn it off.
 *
 * ── THE SHAPE ──────────────────────────────────────────────────────────────────────────────────
 * `login` proves the password and, when a factor is owed, issues a PENDING session that the guard
 * confines to the routes in this file and to signing out. Giving the factor REPLACES that session
 * with a full one (`startSession(…, replacing)`), so the password-only token is dead the moment the
 * person is really signed in — it is never upgraded in place, which is what would let a token
 * captured before the code was typed ride along after it.
 *
 * ── WHAT IS STORED ─────────────────────────────────────────────────────────────────────────────
 * The TOTP secret, encrypted and BOUND to its own row and column (`v2:`), so it cannot be decrypted
 * if copied anywhere else; an enrolment in progress sits in a separate column until a code proves
 * the person holds it. Recovery codes only as hashes. The last accepted step, so a code signs in
 * once. A password reset touches none of it: whoever controls the mailbox still needs the phone.
 */
import { decryptPhi, encryptPhi } from "@mermaid/crypto";
import { withPractice } from "@mermaid/db/pool";
import { getConfig } from "@mermaid/config";
import { verifyPassword } from "./password.ts";
import { recordAuthEventInTx } from "./audit.ts";
import { startSession, type LoginResult } from "./service.ts";
import { base32Decode, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryCodeHash, verifyTotp } from "./totp.ts";
import { AuthError, type ResolvedSession } from "./types.ts";
import * as repo from "./repository.ts";

/** The fifth wrong code ends the pending session; a new sign-in starts again from the password. */
export const MFA_MAX_ATTEMPTS = 5;

const at = (session: ResolvedSession, column: "mfa_secret" | "mfa_pending_secret") => ({
  practiceId: session.user.practiceId,
  table: "staff_users",
  column,
  rowId: session.user.id,
});

const auditBase = (session: ResolvedSession, ip: string | null) => ({
  practiceId: session.user.practiceId,
  actorId: session.user.id,
  actorRole: session.user.role,
  email: session.user.email,
  ip,
});

/**
 * Give the second factor at sign-in: a six-digit code, or one unused recovery code.
 *
 * Only for a pending session whose person HAS a factor. A wrong code is counted against the session
 * and audited; the fifth ends it. A right one is spent (its step, or the recovery code itself) in
 * the same transaction that checks it, so two sign-ins racing with one code cannot both succeed.
 */
export async function verifyMfa(session: ResolvedSession, code: string, ip: string | null, now = Date.now()): Promise<LoginResult> {
  if (!session.mfaPending) throw new AuthError(409, "not_pending", "This session is already signed in.");

  const accepted = await withPractice(session.user.practiceId, async (tx) => {
    const row = await repo.getUserMfa(tx, session.user.id);
    if (!row?.mfa_enabled || !row.mfa_secret) {
      throw new AuthError(409, "mfa_not_enrolled", "Set up an authenticator app before signing in.");
    }
    const secret = base32Decode(decryptPhi(row.mfa_secret, at(session, "mfa_secret"))!);
    const totp = verifyTotp(secret, code, now, row.mfa_last_step);
    if (totp.ok) return (await repo.advanceMfaStep(tx, session.user.id, totp.step)) === 1;
    if (/^[A-Za-z2-7]{5}[\s-]?[A-Za-z2-7]{5}$/.test(code.trim())) {
      return (await repo.consumeRecoveryCode(tx, session.user.id, recoveryCodeHash(code))) === 1;
    }
    return false;
  });

  if (!accepted) {
    await withPractice(session.user.practiceId, async (tx) => {
      const counted = await repo.incrementMfaAttempts(tx, session.tokenHash);
      if ((counted?.mfa_attempts ?? MFA_MAX_ATTEMPTS) >= MFA_MAX_ATTEMPTS) await repo.deleteSession(tx, session.tokenHash);
      await recordAuthEventInTx(tx, { action: "mfa_failed", outcome: "denied", ...auditBase(session, ip) });
    });
    throw new AuthError(401, "bad_mfa_code", "That code did not work. Check the time on your phone and try again.");
  }
  return { ...(await startSession(session.user, ip, session.tokenHash)), mfa: null };
}

/**
 * Begin enrolling an authenticator: a new secret, held as PENDING until a code proves the person
 * has it. Allowed for a signed-in person without a factor, and for a pending session that is owed
 * an enrolment (MFA required, none yet). Starting again replaces an unfinished enrolment.
 */
export async function beginMfaEnrollment(session: ResolvedSession): Promise<{ secret: string; otpauthUri: string }> {
  const secret = newTotpSecret();
  await withPractice(session.user.practiceId, async (tx) => {
    const row = await repo.getUserMfa(tx, session.user.id);
    if (row?.mfa_enabled) throw new AuthError(409, "mfa_already_enrolled", "Two-step sign-in is already on for this account.");
    await repo.setPendingMfaSecret(tx, session.user.id, encryptPhi(secret, at(session, "mfa_pending_secret"))!);
  });
  return { secret, otpauthUri: otpauthUri(secret, session.user.email) };
}

/**
 * Finish enrolling: the first code from the app proves the person holds the secret. Returns the
 * recovery codes, which are shown once and never again, and — when this was the sign-in step — the
 * full session that replaces the pending one.
 */
export async function completeMfaEnrollment(
  session: ResolvedSession,
  code: string,
  ip: string | null,
  now = Date.now()
): Promise<{ recoveryCodes: string[]; signedIn: LoginResult | null }> {
  const recovery = newRecoveryCodes();
  await withPractice(session.user.practiceId, async (tx) => {
    const row = await repo.getUserMfa(tx, session.user.id);
    if (row?.mfa_enabled) throw new AuthError(409, "mfa_already_enrolled", "Two-step sign-in is already on for this account.");
    if (!row?.mfa_pending_secret) throw new AuthError(409, "no_enrollment", "Start setting up an authenticator first.");
    const secretText = decryptPhi(row.mfa_pending_secret, at(session, "mfa_pending_secret"))!;
    const proof = verifyTotp(base32Decode(secretText), code, now, null);
    if (!proof.ok) throw new AuthError(401, "bad_mfa_code", "That code did not match. Enter the six digits your app shows now.");
    // Re-encrypted for its permanent column: the binding includes the column, so it cannot be moved.
    await repo.enableMfa(tx, session.user.id, encryptPhi(secretText, at(session, "mfa_secret"))!, proof.step, recovery.hashes);
    await recordAuthEventInTx(tx, { action: "mfa_enrolled", outcome: "success", ...auditBase(session, ip) });
  });
  const signedIn = session.mfaPending ? { ...(await startSession(session.user, ip, session.tokenHash)), mfa: null } : null;
  return { recoveryCodes: recovery.codes, signedIn };
}

/**
 * Turn one's own second factor off: the password AND a current code, so neither a stolen session
 * nor a stolen password alone can do it. Refused outright where the deployment requires MFA — an
 * administrator's reset is the path for a lost phone there.
 */
export async function disableMfa(session: ResolvedSession, password: string, code: string, ip: string | null, now = Date.now()): Promise<void> {
  if (getConfig().mfaRequired) {
    throw new AuthError(403, "mfa_required", "Two-step sign-in is required here. An administrator can reset it for a lost phone.");
  }
  await withPractice(session.user.practiceId, async (tx) => {
    const row = await repo.getUserMfa(tx, session.user.id);
    if (!row?.mfa_enabled || !row.mfa_secret) throw new AuthError(409, "mfa_not_enrolled", "Two-step sign-in is not on.");
    const passwordOk = await verifyPassword(password, row.password_hash);
    const codeOk = verifyTotp(base32Decode(decryptPhi(row.mfa_secret, at(session, "mfa_secret"))!), code, now, row.mfa_last_step).ok;
    if (!passwordOk || !codeOk) throw new AuthError(401, "bad_credentials", "The password or the code was not right.");
    await repo.clearMfa(tx, session.user.id);
    await recordAuthEventInTx(tx, { action: "mfa_disabled", outcome: "success", ...auditBase(session, ip) });
  });
}

/**
 * An administrator clears another person's second factor — the lost-phone path — and every session
 * that person holds ends with it, so they must sign in (and enrol again, where it is required).
 * Never one's own: that would let a stolen administrator session remove the factor protecting it.
 */
export async function resetUserMfa(admin: ResolvedSession, userId: string, ip: string | null): Promise<void> {
  if (userId === admin.user.id) {
    throw new AuthError(409, "own_mfa", "Turn off your own two-step sign-in from your account, with a code.");
  }
  await withPractice(admin.user.practiceId, async (tx) => {
    const target = await repo.getUserById(tx, userId);
    // RLS scopes the lookup, so a user in another practice is simply not found.
    if (!target) throw new AuthError(404, "not_found", "No such user in this practice.");
    await repo.clearMfa(tx, userId);
    await repo.deleteSessionsForUser(tx, userId);
    await recordAuthEventInTx(tx, {
      action: "mfa_reset",
      outcome: "success",
      practiceId: admin.user.practiceId,
      actorId: admin.user.id,
      actorRole: admin.user.role,
      email: target.email,
      ip,
    });
  });
}

/** Whether a person has a factor enrolled — for the session endpoint and the staff roster. */
export async function mfaEnabledFor(session: ResolvedSession): Promise<boolean> {
  return withPractice(session.user.practiceId, async (tx) => Boolean((await repo.getUserMfa(tx, session.user.id))?.mfa_enabled));
}

