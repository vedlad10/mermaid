/**
 * Auth data access — the SOLE SQL surface for staff_users + sessions. Pre-auth lookups go through
 * the SECURITY DEFINER functions (migration 0003); everything else runs under the caller's practice
 * context (RLS).
 */
import { one, execute, many } from "@mermaid/db/repository";
import type { Tx } from "@mermaid/db/pool";
import type { Role } from "@mermaid/shared";

export interface UserAuthRow {
  id: string;
  practice_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  disabled: boolean;
  reset_token_hash: string | null;
  reset_token_exp: number | null;
  /** A second factor is enrolled (0038). */
  mfa_enabled: boolean;
}

export interface SessionAuthRow {
  token_hash: string;
  practice_id: string;
  user_id: string;
  csrf: string;
  expires_at: number;
  role: Role;
  name: string;
  email: string;
  disabled: boolean;
  /** Epoch ms of the last USER activity (0036); created_at for a session that predates it. */
  last_seen_at: number;
  /** Password proven, second factor not yet (0038). */
  mfa_pending: boolean;
  /** Wrong codes entered against this pending session. */
  mfa_attempts: number;
}

export interface UserListRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  /** Whether this person has a second factor enrolled — shown to whoever administers access. */
  mfa_enabled: boolean;
}

// ── Pre-auth (SECURITY DEFINER; no practice context) ────────────────────────────────
export const findUserForAuth = (tx: Tx, email: string) =>
  one<UserAuthRow>(tx, "SELECT * FROM find_user_for_auth($1)", [email]);

export const findSessionForAuth = (tx: Tx, tokenHash: string) =>
  one<SessionAuthRow>(tx, "SELECT * FROM find_session_for_auth($1)", [tokenHash]);

// ── Sessions (under practice context) ───────────────────────────────────────────────
export const insertSession = (
  tx: Tx,
  s: {
    tokenHash: string;
    practiceId: string;
    userId: string;
    csrf: string;
    expiresAt: number;
    ip: string | null;
    /** A session that has proven the password but not yet the second factor (0038). */
    mfaPending?: boolean;
  }
) =>
  execute(
    tx,
    "INSERT INTO sessions (token_hash, practice_id, user_id, csrf, expires_at, ip, last_seen_at, mfa_pending) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [s.tokenHash, s.practiceId, s.userId, s.csrf, s.expiresAt, s.ip, Date.now(), s.mfaPending === true]
  );

/** One more wrong code against a pending session; returns the new count. */
export const incrementMfaAttempts = (tx: Tx, tokenHash: string) =>
  one<{ mfa_attempts: number }>(
    tx,
    "UPDATE sessions SET mfa_attempts = mfa_attempts + 1 WHERE token_hash = $1 RETURNING mfa_attempts",
    [tokenHash]
  );

/** Record user activity. Forward-only, so two overlapping requests cannot move it backwards. */
export const touchSession = (tx: Tx, tokenHash: string, atMs: number) =>
  execute(
    tx,
    "UPDATE sessions SET last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $2) WHERE token_hash = $1",
    [tokenHash, atMs]
  );

export const deleteSession = (tx: Tx, tokenHash: string) =>
  execute(tx, "DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);

export const deleteSessionsForUser = (tx: Tx, userId: string) =>
  execute(tx, "DELETE FROM sessions WHERE user_id = $1", [userId]);

export const deleteExpiredSessions = (tx: Tx, nowMs: number) =>
  execute(tx, "DELETE FROM sessions WHERE expires_at < $1", [nowMs]);

// ── Users ───────────────────────────────────────────────────────────────────────────
export const insertUser = (
  tx: Tx,
  u: { practiceId: string; email: string; name: string; role: Role; passwordHash: string }
) =>
  one<{ id: string }>(
    tx,
    `INSERT INTO staff_users (practice_id, email, name, role, password_hash)
     VALUES ($1, lower($2), $3, $4, $5) RETURNING id`,
    [u.practiceId, u.email, u.name, u.role, u.passwordHash]
  );

export const listUsers = (tx: Tx) =>
  many<UserListRow>(
    tx,
    "SELECT id, email, name, role, disabled, mfa_enabled_at IS NOT NULL AS mfa_enabled FROM staff_users ORDER BY name"
  );

/** One user by id, within the practice context -- returns null for a user in another practice. */
export const getUserById = (tx: Tx, userId: string) =>
  one<UserListRow>(
    tx,
    "SELECT id, email, name, role, disabled, mfa_enabled_at IS NOT NULL AS mfa_enabled FROM staff_users WHERE id = $1",
    [userId]
  );

/**
 * How many enabled accounts hold a role that can administer the practice.
 *
 * Read before disabling or demoting anyone, because the answer decides whether the practice is
 * about to lock itself out of its own system. `users.manage` belongs to `owner` and `admin` only
 * (roles.ts), so those are the roles that can ever restore access.
 */
export const enabledAdminCount = (tx: Tx) =>
  one<{ count: string }>(
    tx,
    "SELECT COUNT(*)::text AS count FROM staff_users WHERE disabled = false AND role IN ('owner','admin')"
  );

export const setUserDisabled = (tx: Tx, userId: string, disabled: boolean) =>
  execute(tx, "UPDATE staff_users SET disabled = $2, updated_at = now() WHERE id = $1", [userId, disabled]);

export const setUserRole = (tx: Tx, userId: string, role: Role) =>
  execute(tx, "UPDATE staff_users SET role = $2, updated_at = now() WHERE id = $1", [userId, role]);

export const emailExists = (tx: Tx, email: string) =>
  one<{ exists: boolean }>(tx, "SELECT EXISTS(SELECT 1 FROM staff_users WHERE email = lower($1)) AS exists", [email]);

export const updatePassword = (tx: Tx, userId: string, passwordHash: string) =>
  execute(
    tx,
    "UPDATE staff_users SET password_hash = $2, reset_token_hash = NULL, reset_token_exp = NULL WHERE id = $1",
    [userId, passwordHash]
  );

export const setResetToken = (tx: Tx, userId: string, tokenHash: string, exp: number) =>
  execute(tx, "UPDATE staff_users SET reset_token_hash = $2, reset_token_exp = $3 WHERE id = $1", [
    userId,
    tokenHash,
    exp,
  ]);

// ── Second factor (0038; under practice context) ────────────────────────────────────
export interface UserMfaRow {
  email: string;
  password_hash: string;
  /** Encrypted, bound to (practice, staff_users, mfa_secret, user id). */
  mfa_secret: string | null;
  /** Encrypted, bound to (practice, staff_users, mfa_pending_secret, user id). */
  mfa_pending_secret: string | null;
  mfa_enabled: boolean;
  mfa_last_step: number | null;
  mfa_recovery_hashes: string[];
}

export const getUserMfa = (tx: Tx, userId: string) =>
  one<UserMfaRow>(
    tx,
    `SELECT email, password_hash, mfa_secret, mfa_pending_secret, mfa_enabled_at IS NOT NULL AS mfa_enabled,
            mfa_last_step, mfa_recovery_hashes
       FROM staff_users WHERE id = $1`,
    [userId]
  );

export const setPendingMfaSecret = (tx: Tx, userId: string, encrypted: string) =>
  execute(tx, "UPDATE staff_users SET mfa_pending_secret = $2, updated_at = now() WHERE id = $1", [userId, encrypted]);

/** Promote a proven enrolment. Only from a pending secret, so a replayed request cannot re-enable. */
export const enableMfa = (tx: Tx, userId: string, encrypted: string, step: number, recoveryHashes: string[]) =>
  execute(
    tx,
    `UPDATE staff_users
        SET mfa_secret = $2, mfa_pending_secret = NULL, mfa_enabled_at = now(),
            mfa_last_step = $3, mfa_recovery_hashes = $4, updated_at = now()
      WHERE id = $1 AND mfa_pending_secret IS NOT NULL`,
    [userId, encrypted, step, recoveryHashes]
  );

/**
 * Accept a code's step, atomically. Zero rows means another request already used this step or a
 * later one — the replay guard holds even when two sign-ins race with the same code.
 */
export const advanceMfaStep = (tx: Tx, userId: string, step: number) =>
  execute(
    tx,
    "UPDATE staff_users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)",
    [userId, step]
  );

/** Spend a recovery code. Zero rows means it was never valid, or has already been used. */
export const consumeRecoveryCode = (tx: Tx, userId: string, hash: string) =>
  execute(
    tx,
    "UPDATE staff_users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) WHERE id = $1 AND $2 = ANY(mfa_recovery_hashes)",
    [userId, hash]
  );

export const clearMfa = (tx: Tx, userId: string) =>
  execute(
    tx,
    `UPDATE staff_users
        SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL,
            mfa_last_step = NULL, mfa_recovery_hashes = '{}', updated_at = now()
      WHERE id = $1`,
    [userId]
  );

// ── Bootstrap (practices has no RLS) ─────────────────────────────────────────────────
export const countPractices = (tx: Tx) =>
  one<{ count: number }>(tx, "SELECT count(*)::int AS count FROM practices");

export const insertPractice = (tx: Tx, name: string) =>
  one<{ id: string }>(tx, "INSERT INTO practices (name) VALUES ($1) RETURNING id", [name]);
