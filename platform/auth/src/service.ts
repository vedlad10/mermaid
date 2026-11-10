/**
 * Authentication service — bootstrap/seed, login, session resolution, logout, password reset, and
 * admin user creation. Composes the pure primitives (password, session, guard) with the repository
 * and the RLS-scoped transaction helpers.
 *
 * Security properties preserved from the donor apps:
 *  • timing-uniform login (hash a dummy when the user is absent → no user enumeration);
 *  • reset requests/confirms resolve the same way whether or not the email exists;
 *  • a password reset revokes every session issued under the old credential.
 */
import { randomBytes } from "node:crypto";
import { withPractice, withoutPractice } from "@mermaid/db/pool";
import { getConfig } from "@mermaid/config";
import { asId, isRole, isUuid, type Role, type Permission } from "@mermaid/shared";
import { logger } from "@mermaid/observability";
import { hashPassword, verifyPassword } from "./password.ts";
import { newSession, newResetToken, hashSessionToken, sha256, isExpired, resetTokenExpired, idleDecision } from "./session.ts";
import { authorizeRequest, type RequestMeta } from "./guard.ts";
import { AuthError, type AuthUser, type ResolvedSession } from "./types.ts";
import { recordAuthEvent, recordAuthEventInTx, type LoginFailure } from "./audit.ts";
import { recordAudit } from "@mermaid/observability";
import { randomUUID } from "node:crypto";
import * as repo from "./repository.ts";

// A well-formed hash to compare against when the user doesn't exist (keeps login timing uniform).
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

function toAuthUser(row: repo.UserAuthRow): AuthUser {
  return {
    id: asId(row.id),
    practiceId: asId(row.practice_id),
    email: row.email,
    name: row.name,
    role: row.role,
  };
}

// ── Login ─────────────────────────────────────────────────────────────────────────
export async function authenticate(email: string, password: string): Promise<AuthUser> {
  return toAuthUser(await verifyCredentials(email, password));
}

/** The password check behind `authenticate`, returning the row so `login` can see MFA state. */
async function verifyCredentials(email: string, password: string): Promise<repo.UserAuthRow> {
  const row = await withoutPractice((tx) => repo.findUserForAuth(tx, email));
  const hash = row?.password_hash ?? DUMMY_HASH;
  const valid = await verifyPassword(password, hash);
  if (!row || row.disabled || !valid) {
    /**
     * The response collapses three different facts into one message so it cannot be used to
     * enumerate accounts, and the DUMMY_HASH above keeps the timing uniform for the same reason.
     * The distinction still matters — to a security reviewer, a month later, reading the audit
     * trail — so it is attached to the error rather than thrown away, and `login` records it.
     *
     * On the error and not returned, because every caller that is not the audit path must keep
     * treating this as one indivisible refusal.
     */
    const failure: LoginFailure = !row ? "no_such_user" : row.disabled ? "account_disabled" : "bad_password";
    throw Object.assign(new AuthError(401, "bad_credentials", "invalid email or password"), {
      auditReason: failure,
      auditActorId: row ? asId(row.id) : null,
      auditPracticeId: row ? asId(row.practice_id) : null,
    });
  }
  return row;
}

/** The audit facts `authenticate` attaches to its refusal. Absent on any other error. */
interface AuthFailureDetail {
  auditReason?: LoginFailure;
  auditActorId?: string | null;
  auditPracticeId?: string | null;
}

export interface LoginResult {
  token: string;
  csrf: string;
  expiresAt: number;
  user: AuthUser;
  /**
   * Null: signed in. Otherwise the password was right and the second factor is owed (0038) —
   * `verify` a code from the person's authenticator, or `enroll` one first because this deployment
   * requires it and they have none. The session issued for either can do nothing else.
   */
  mfa: null | "verify" | "enroll";
}

/** How long a password-only session may wait for its second factor. */
export const MFA_PENDING_TTL_MS = 5 * 60_000;

export async function login(email: string, password: string, ip: string | null): Promise<LoginResult> {
  let row: repo.UserAuthRow;
  try {
    row = await verifyCredentials(email, password);
  } catch (err) {
    /**
     * A FAILED sign-in is the event a breach investigation opens with, and it was recorded nowhere
     * — the request auditor never runs for it, because the request never reaches a handler (NEW-05).
     */
    const detail = err as AuthFailureDetail;
    await recordAuthEvent({
      action: "login",
      outcome: "denied",
      email,
      ip,
      practiceId: detail.auditPracticeId ?? null,
      actorId: detail.auditActorId ?? null,
      ...(detail.auditReason ? { reason: detail.auditReason } : {}),
    });
    throw err;
  }
  const user = toAuthUser(row);

  /**
   * A second factor is owed when the person has one, or when this deployment requires one and they
   * have none yet. Either way the password earns only a PENDING session: five minutes, confined by
   * the guard to the MFA step, and replaced — never upgraded in place — once the factor is given.
   */
  const mfa = row.mfa_enabled ? "verify" : getConfig().mfaRequired ? "enroll" : null;
  if (mfa) {
    const s = newSession(getConfig().sessionTtlHours);
    const expiresAt = Date.now() + MFA_PENDING_TTL_MS;
    await withPractice(user.practiceId, async (tx) => {
      await repo.insertSession(tx, {
        tokenHash: s.tokenHash,
        practiceId: user.practiceId,
        userId: user.id,
        csrf: s.csrf,
        expiresAt,
        ip,
        mfaPending: true,
      });
      await recordAuthEventInTx(tx, {
        action: "mfa_challenged",
        outcome: "success",
        practiceId: user.practiceId,
        actorId: user.id,
        actorRole: user.role,
        email: user.email,
        ip,
      });
    });
    return { token: s.token, csrf: s.csrf, expiresAt, user, mfa };
  }

  return { ...(await startSession(user, ip)), mfa: null };
}

/**
 * Issue a full session and record the sign-in — the one place both happen.
 *
 * In the SAME transaction as the session it describes. A session that exists with no record of
 * being created, and a record of a sign-in that did not happen, are both worse than a sign-in that
 * failed outright — the same coupling `auditRequest` uses for every other write. `replacing` is the
 * pending session a second factor has just satisfied: deleted in the same transaction, so the
 * password-only token can never be used again.
 */
export async function startSession(
  user: AuthUser,
  ip: string | null,
  replacing: string | null = null
): Promise<Omit<LoginResult, "mfa">> {
  const s = newSession(getConfig().sessionTtlHours);
  await withPractice(user.practiceId, async (tx) => {
    if (replacing) await repo.deleteSession(tx, replacing);
    await repo.insertSession(tx, {
      tokenHash: s.tokenHash,
      practiceId: user.practiceId,
      userId: user.id,
      csrf: s.csrf,
      expiresAt: s.expiresAt,
      ip,
    });
    await recordAuthEventInTx(tx, {
      action: "login",
      outcome: "success",
      practiceId: user.practiceId,
      actorId: user.id,
      actorRole: user.role,
      email: user.email,
      ip,
    });
  });
  return { token: s.token, csrf: s.csrf, expiresAt: s.expiresAt, user };
}

// ── Session resolution + logout ─────────────────────────────────────────────────────
/**
 * What the browser says about the person at it: milliseconds since their last key or pointer input,
 * or null when it said nothing. See `idleDecision`.
 */
export interface SessionActivity {
  reportedIdleMs: number | null;
}

export async function resolveSession(
  sidToken: string | null | undefined,
  activity: SessionActivity = { reportedIdleMs: null },
  now: number = Date.now()
): Promise<ResolvedSession | null> {
  if (!sidToken) return null;
  const tokenHash = hashSessionToken(sidToken);
  const row = await withoutPractice((tx) => repo.findSessionForAuth(tx, tokenHash));
  if (!row || row.disabled) return null;
  if (isExpired(row.expires_at, now)) {
    await withPractice(asId(row.practice_id), (tx) => repo.deleteSession(tx, tokenHash));
    return null;
  }
  /**
   * Automatic logoff. The absolute expiry above bounds a session's LIFE; this bounds how long it may
   * sit untouched. Ended sessions are deleted and audited in one transaction, so the log shows that
   * the system ended it rather than that someone stopped appearing.
   */
  const idle = idleDecision({
    lastSeenAt: row.last_seen_at,
    now,
    idleWindowMs: getConfig().sessionIdleMinutes * 60_000,
    reportedIdleMs: activity.reportedIdleMs,
  });
  if (idle.expired) {
    await withPractice(asId(row.practice_id), async (tx) => {
      await repo.deleteSession(tx, tokenHash);
      await recordAuthEventInTx(tx, {
        action: "session_idle_expired",
        outcome: "success",
        practiceId: asId(row.practice_id),
        actorId: asId(row.user_id),
        actorRole: row.role,
        email: row.email,
        ip: null,
      });
    });
    return null;
  }
  if (idle.touchAt !== null) {
    const touchAt = idle.touchAt;
    await withPractice(asId(row.practice_id), (tx) => repo.touchSession(tx, tokenHash, touchAt));
  }
  return {
    tokenHash: row.token_hash,
    csrf: row.csrf,
    mfaPending: row.mfa_pending === true,
    user: {
      id: asId(row.user_id),
      practiceId: asId(row.practice_id),
      email: row.email,
      name: row.name,
      role: row.role,
    },
  };
}

export async function logout(sidToken: string | null | undefined, ip: string | null = null): Promise<void> {
  const session = await resolveSession(sidToken);
  // No session is not an event: a logout with no cookie, or with one already expired, is a browser
  // tidying up. Recording those would bury the sign-outs that actually ended a session.
  if (!session) return;
  await withPractice(session.user.practiceId, async (tx) => {
    await repo.deleteSession(tx, session.tokenHash);
    await recordAuthEventInTx(tx, {
      action: "logout",
      outcome: "success",
      practiceId: session.user.practiceId,
      actorId: session.user.id,
      actorRole: session.user.role,
      email: session.user.email,
      ip,
    });
  });
}

/** Resolve the session from the cookie, then apply the pure CSRF + RBAC decision. */
export async function guard(
  sidToken: string | null | undefined,
  csrfHeader: string | null,
  meta: { method: string; permission: Permission | null; csrfExempt?: boolean; allowMfaPending?: boolean },
  activity: SessionActivity = { reportedIdleMs: null }
): Promise<ResolvedSession> {
  const session = await resolveSession(sidToken, activity);
  return authorizeRequest(session, { ...meta, csrfHeader } satisfies RequestMeta);
}

/**
 * The `x-mermaid-idle-ms` request header: whole milliseconds since the person's last input, or null
 * when absent or not a non-negative integer. Malformed counts as "no report", which is activity —
 * the same as every client before this header existed.
 */
export function reportedIdleMs(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d{1,12}$/.test(value.trim())) return null;
  return Number(value.trim());
}

// ── Password reset ──────────────────────────────────────────────────────────────────
export async function requestPasswordReset(
  email: string,
  ip: string | null = null
): Promise<{ token: string | null }> {
  const row = await withoutPractice((tx) => repo.findUserForAuth(tx, email));
  if (!row || row.disabled) {
    /**
     * Audited even though the caller is told nothing. A reset requested for an address that is not
     * on file is exactly the shape of a probe, and the response is deliberately identical to the
     * success case so it cannot be used to enumerate accounts — which means the log is the ONLY
     * place the difference survives.
     */
    await recordAuthEvent({
      action: "password_reset_requested",
      outcome: "denied",
      email,
      ip,
      ...(row ? { practiceId: asId(row.practice_id), actorId: asId(row.id), reason: "account_disabled" as const } : { reason: "no_such_user" as const }),
    });
    return { token: null }; // same shape whether or not the email exists
  }
  const rt = newResetToken(getConfig().resetTtlSeconds);
  await withPractice(asId(row.practice_id), async (tx) => {
    await repo.setResetToken(tx, row.id, rt.tokenHash, rt.exp);
    await recordAuthEventInTx(tx, {
      action: "password_reset_requested",
      outcome: "success",
      practiceId: asId(row.practice_id),
      actorId: asId(row.id),
      actorRole: row.role,
      email: row.email,
      ip,
    });
  });
  logger.info("Password reset requested.", { channel: "security", actorId: row.id });
  return { token: rt.token };
}

export async function confirmPasswordReset(
  email: string,
  token: string,
  newPassword: string,
  ip: string | null = null
): Promise<void> {
  const row = await withoutPractice((tx) => repo.findUserForAuth(tx, email));

  /**
   * A refused confirmation is audited before it is thrown. Somebody presenting a wrong or expired
   * reset token against a real account is the single most interesting row this table can hold, and
   * the response says only "invalid or expired" so the log is where the detail lives.
   *
   * `newPassword` is never touched here, and must never be: a password typed against the wrong
   * account is still a live credential, and this table is retained for years.
   */
  const refuse = async (reason: LoginFailure, error: AuthError): Promise<never> => {
    await recordAuthEvent({
      action: "password_reset_confirmed",
      outcome: "denied",
      email,
      ip,
      reason,
      ...(row ? { practiceId: asId(row.practice_id), actorId: asId(row.id) } : {}),
    });
    throw error;
  };

  if (!row || !row.reset_token_hash || !row.reset_token_exp) {
    await refuse(row ? "bad_password" : "no_such_user", new AuthError(400, "invalid_token", "invalid or expired reset token"));
  }
  if (resetTokenExpired(row!.reset_token_exp!)) {
    await refuse("bad_password", new AuthError(400, "invalid_token", "reset token has expired"));
  }
  if (sha256(token) !== row!.reset_token_hash) {
    await refuse("bad_password", new AuthError(400, "invalid_token", "invalid or expired reset token"));
  }
  if (newPassword.length < 10) {
    await refuse("bad_password", new AuthError(422, "weak_password", "password must be at least 10 characters"));
  }
  const passwordHash = await hashPassword(newPassword);
  await withPractice(asId(row!.practice_id), async (tx) => {
    await repo.updatePassword(tx, row!.id, passwordHash);
    await repo.deleteSessionsForUser(tx, row!.id); // old credential is suspect → revoke all sessions
    await recordAuthEventInTx(tx, {
      action: "password_reset_confirmed",
      outcome: "success",
      practiceId: asId(row!.practice_id),
      actorId: asId(row!.id),
      actorRole: row!.role,
      email: row!.email,
      ip,
    });
  });
  logger.info("Password reset completed.", { channel: "security", actorId: row!.id });
}

// ── Admin: create a user in the current practice ────────────────────────────────────
export async function createUser(
  practiceId: string,
  input: { email: string; name: string; role: string; password: string }
): Promise<{ id: string }> {
  if (!isRole(input.role)) throw new AuthError(422, "invalid_role", "invalid role");
  const role: Role = input.role; // captured after narrowing (closure below would widen it back)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new AuthError(422, "invalid_email", "invalid email");
  if (input.password.length < 10) throw new AuthError(422, "weak_password", "password must be at least 10 characters");
  const passwordHash = await hashPassword(input.password);
  return withPractice(asId(practiceId), async (tx) => {
    const exists = await repo.emailExists(tx, input.email);
    if (exists?.exists) throw new AuthError(409, "conflict", "email already exists");
    const created = await repo.insertUser(tx, {
      practiceId,
      email: input.email,
      name: input.name,
      role,
      passwordHash,
    });
    return { id: created!.id };
  });
}

/**
 * Add a colleague to the practice, without anybody choosing their password.
 *
 * -- WHY THIS DOES NOT TAKE A PASSWORD ---------------------------------------------------------
 * `createUser` does, because the bootstrap seeder needs it. An administrator adding a hygienist
 * must not: a password one person types and another person uses is a shared secret from the moment
 * it exists, it arrives over whatever channel was convenient, and every later action by that
 * account is deniable. So the account is created with a random credential nobody sees, and the
 * person sets their own through the reset flow the product already has.
 *
 * The token is RETURNED rather than emailed because no mail provider is configured -- that needs a
 * hosting decision and a BAA (the M13 gate). Until then the administrator hands it over, which is
 * the same documented manual process `auth:issue-reset` exists for. When mail is configured this
 * function should stop returning it.
 */
export async function inviteUser(
  practiceId: string,
  input: { email: string; name: string; role: string },
  ip: string | null = null
): Promise<{ id: string; resetToken: string | null }> {
  /**
   * 32 random bytes, held only long enough to be hashed. Nobody -- not the administrator, not this
   * process after it returns -- can authenticate as this account until the reset is completed.
   */
  const unusable = randomBytes(32).toString("base64url");
  const { id } = await createUser(practiceId, { ...input, password: unusable });
  const { token } = await requestPasswordReset(input.email, ip);
  return { id, resetToken: token };
}

export async function listUsers(practiceId: string) {
  return withPractice(asId(practiceId), (tx) => repo.listUsers(tx));
}

/**
 * The roles that can ever restore access to a practice.
 *
 * `users.manage` belongs to `owner` and `admin` and to nobody else (roles.ts) -- an office manager
 * holds every working permission and the contractual override, and still cannot administer
 * accounts. So these two roles are the only ones who can undo a mistake made here.
 */
const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];

/**
 * Refuse any change that would leave the practice with nobody who can administer it.
 *
 * -- WHY THIS IS CHECKED IN THE SAME TRANSACTION AS THE WRITE --------------------------------
 * Two owners, two browser tabs, each disabling the other: both read "2 admins remain" and both
 * proceed, and the practice is locked out of its own system with no path back short of an engineer
 * with a psql session. The count and the update share one transaction so the second one loses.
 *
 * The failure this prevents is not recoverable through the product. Every other mistake on this
 * screen can be undone by somebody; this one cannot be undone by anybody.
 */
async function refuseIfLastAdmin(
  tx: Parameters<typeof repo.enabledAdminCount>[0],
  target: { id: string; role: Role; disabled: boolean },
  after: { role: Role; disabled: boolean }
): Promise<void> {
  const wasAdmin = !target.disabled && ADMIN_ROLES.includes(target.role);
  const staysAdmin = !after.disabled && ADMIN_ROLES.includes(after.role);
  if (!wasAdmin || staysAdmin) return;

  const remaining = Number((await repo.enabledAdminCount(tx))?.count ?? "0");
  if (remaining <= 1) {
    throw new AuthError(
      409,
      "last_admin",
      "This is the only owner or administrator left. Promote somebody else first, or the practice " +
        "will have nobody who can manage accounts."
    );
  }
}

/**
 * The target of an administrative change, or a 404.
 *
 * The UUID shape is checked BEFORE the query, and a malformed id is answered exactly as a missing
 * one. Two reasons. `staff_users.id` is a `uuid` column, so Postgres raises
 * `invalid input syntax for type uuid` on anything else -- an unhandled driver error surfacing to
 * the caller as a 500 for what is really "no such user". And answering malformed and absent
 * differently would say which ids are well-formed, which is a shape this endpoint has no reason to
 * confirm.
 */
async function findTarget(
  tx: Parameters<typeof repo.getUserById>[0],
  userId: string
): Promise<{ id: string; role: Role; disabled: boolean; email: string }> {
  const target = isUuid(userId) ? await repo.getUserById(tx, userId) : null;
  if (!target) throw new AuthError(404, "not_found", "No such user in this practice.");
  return target;
}

/**
 * Enable or disable one account.
 *
 * Disabling rather than deleting is deliberate: `audit_events` references a user by id, and a
 * departed biller's history has to stay readable. `login` already refuses a disabled account, and
 * every session they hold is destroyed here rather than left to expire -- an access change that
 * takes effect in up to a fortnight is not an access change.
 */
export async function setUserAccess(
  practiceId: string,
  actorId: string,
  userId: string,
  disabled: boolean,
  ip: string | null = null
): Promise<void> {
  if (actorId === userId) {
    throw new AuthError(409, "self_lockout", "You cannot disable your own account.");
  }
  await withPractice(asId(practiceId), async (tx) => {
    const target = await findTarget(tx, userId);
    await refuseIfLastAdmin(tx, target, { role: target.role, disabled });

    await repo.setUserDisabled(tx, userId, disabled);
    // Revoked now, not at expiry. A disabled account with a live session is still signed in.
    if (disabled) await repo.deleteSessionsForUser(tx, userId);

    await recordAudit(tx, {
      practiceId,
      traceId: randomUUID(),
      action: disabled ? "user_disabled" : "user_enabled",
      resource: "staff_user",
      resourceId: target.email,
      before: { disabled: target.disabled },
      after: { disabled },
      outcome: "success",
      actorId,
      ip,
    });
  });
}

/**
 * Change one account's role.
 *
 * Separate from `setUserAccess` because they are different decisions with different blast radii,
 * and a single "edit user" endpoint would let one careless request do both.
 */
export async function setUserRole(
  practiceId: string,
  actorId: string,
  userId: string,
  role: string,
  ip: string | null = null
): Promise<void> {
  if (!isRole(role)) throw new AuthError(422, "invalid_role", "invalid role");
  const next: Role = role;
  if (actorId === userId) {
    /**
     * Not a courtesy. An owner who demotes themselves to `dentist` loses `users.manage` in the same
     * statement that removes it, so they cannot put it back -- the one action on this screen whose
     * mistake is unrecoverable by the person who made it.
     */
    throw new AuthError(409, "self_demotion", "You cannot change your own role. Ask another owner or administrator.");
  }
  await withPractice(asId(practiceId), async (tx) => {
    const target = await findTarget(tx, userId);
    if (target.role === next) return;
    await refuseIfLastAdmin(tx, target, { role: next, disabled: target.disabled });

    await repo.setUserRole(tx, userId, next);
    /**
     * A role change is an authorisation change, and sessions carry the role. Signing them out is
     * what makes the new permissions take effect on their next request rather than whenever they
     * happen to log in again.
     */
    await repo.deleteSessionsForUser(tx, userId);

    await recordAudit(tx, {
      practiceId,
      traceId: randomUUID(),
      action: "user_role_changed",
      resource: "staff_user",
      resourceId: target.email,
      before: { role: target.role },
      after: { role: next },
      outcome: "success",
      actorId,
      ip,
    });
  });
}

// ── Bootstrap: seed a demo practice with one account per role ────────────────────────
const SEED: { email: string; name: string; role: Role; envKey: string }[] = [
  { email: "owner@clinic.example", name: "Olivia Owner", role: "owner", envKey: "AUTH_SEED_OWNER_PASSWORD" },
  { email: "admin@clinic.example", name: "Avery Admin", role: "admin", envKey: "AUTH_SEED_ADMIN_PASSWORD" },
  { email: "manager@clinic.example", name: "Morgan Manager", role: "office_manager", envKey: "AUTH_SEED_MANAGER_PASSWORD" },
  { email: "coordinator@clinic.example", name: "Casey Coordinator", role: "insurance_coordinator", envKey: "AUTH_SEED_COORDINATOR_PASSWORD" },
  { email: "reception@clinic.example", name: "Riley Reception", role: "front_desk", envKey: "AUTH_SEED_RECEPTION_PASSWORD" },
  { email: "biller@clinic.example", name: "Blair Biller", role: "biller", envKey: "AUTH_SEED_BILLER_PASSWORD" },
  { email: "dentist@clinic.example", name: "Dr. Dana Dentist", role: "dentist", envKey: "AUTH_SEED_DENTIST_PASSWORD" },
  { email: "auditor@clinic.example", name: "Val Viewer", role: "auditor", envKey: "AUTH_SEED_AUDITOR_PASSWORD" },
];

/** Every environment variable this bootstrap reads a password from. */
export const SEED_PASSWORD_ENV_KEYS: readonly string[] = SEED.map((a) => a.envKey);

/**
 * How a deployment is allowed to bootstrap its demo accounts.
 *
 *   off      — never seed. Forced in production; available anywhere.
 *   random   — seed with passwords nobody knows. Any `AUTH_SEED_*_PASSWORD` that IS set is
 *              honoured and the rest are random. Get in with `auth:issue-reset`.
 *   explicit — seed only when the operator supplied a password for EVERY role. Refuses
 *              otherwise rather than half-applying.
 */
export type SeedMode = "off" | "random" | "explicit";

const SEED_MODES: readonly SeedMode[] = ["off", "random", "explicit"];

/**
 * ── WHY "NOT PRODUCTION" WAS THE WRONG QUESTION (F-3) ─────────────────────────────────
 *
 * This module used to log every generated password whenever `!config.isProd`, which treats
 * a hosted deployment exactly like a developer laptop. It is not one: its stdout is
 * retained by the hosting platform and readable by anyone with dashboard access, and the
 * seeded accounts include `owner`.
 *
 * Two faults compounded, and both are fixed here:
 *
 *   1. Credentials were written to a log at all. Nothing in this file emits password
 *      material in any mode now — see `announceSeeded`, whose parameter list is the
 *      guarantee rather than a promise to remember.
 *   2. "Not production" was read as "local". The mode is now an explicit deployment
 *      decision, so an environment that has not thought about bootstrapping cannot
 *      silently inherit a developer convenience.
 *
 * Takes `env` and `isProd` as arguments rather than reading globals, so the decision is
 * testable without a database, a config cache, or a process restart.
 */
export function resolveSeedMode(env: NodeJS.ProcessEnv, isProd: boolean): SeedMode {
  const raw = env.AUTH_SEED_MODE?.trim();
  if (isProd) {
    /**
     * Production never bootstraps demo accounts. A deployment that asked for it is
     * misconfigured, and refusing loudly beats silently downgrading to "off" — a silent
     * downgrade is how an operator concludes the setting works and then relies on it.
     */
    if (raw && raw !== "off") {
      throw new Error(
        `AUTH_SEED_MODE="${raw}" is refused in production — demo accounts are never seeded there. ` +
          `Unset it, or set it to "off".`
      );
    }
    return "off";
  }
  if (!raw) return "random";
  if (!SEED_MODES.includes(raw as SeedMode)) {
    throw new Error(`AUTH_SEED_MODE must be one of ${SEED_MODES.join(", ")} — got "${raw}".`);
  }
  return raw as SeedMode;
}

/**
 * The passwords the operator supplied, and the keys they did not.
 *
 * Both halves are returned because the two seeding modes want different things from the
 * same read: `random` uses whatever is present and randomises the rest, while `explicit`
 * treats any absence as a refusal. Seeding four of eight accounts with known passwords and
 * four with random ones produces a deployment nobody can fully use and nobody can fully
 * audit, so `explicit` will not do it.
 */
export function collectSuppliedPasswords(env: NodeJS.ProcessEnv): {
  supplied: { email: string; password: string }[];
  missing: string[];
} {
  const supplied: { email: string; password: string }[] = [];
  const missing: string[] = [];
  for (const acct of SEED) {
    const value = env[acct.envKey]?.trim();
    if (value) supplied.push({ email: acct.email, password: value });
    else missing.push(acct.envKey);
  }
  return { supplied, missing };
}

/**
 * What a bootstrap is allowed to say about itself.
 *
 * Takes EMAILS and nothing else, and that is the point: a function which cannot receive a
 * password cannot log one. That is a structural guarantee rather than a convention, and it
 * is what stops F-3 being reintroduced by someone adding one more helpful field to the log
 * line.
 */
export function announceSeeded(mode: Exclude<SeedMode, "off">, emails: string[]): void {
  if (mode === "explicit") {
    logger.warn("Seeded demo accounts using operator-supplied passwords.", {
      channel: "security",
      emails,
    });
    return;
  }
  /**
   * ── THIS USED TO BE UNACTIONABLE ADVICE (NEW-27) ───────────────────────────────────────
   *
   * "Use the reset flow to log in" was true of a flow that could not deliver anything:
   * production writes the token to the user row and returns null, because no email provider
   * is configured (that needs a hosting decision and a BAA — the M13 gate). So a fresh
   * deployment had eight accounts whose passwords nobody knew and no path to any of them.
   *
   * The passwords still are not logged, and must not be. `auth:issue-reset` mints a token on
   * the machine and prints it once, through the same `requestPasswordReset` the endpoint uses.
   */
  logger.warn("Seeded accounts with RANDOM passwords. Nobody knows them, deliberately.", {
    channel: "security",
    emails,
    howToGetIn:
      "Run `npm run auth:issue-reset -- <email>` on this machine. It prints a single-use reset " +
      "token to stdout — never to a log — which completes at POST /api/v1/auth/password-reset/confirm.",
  });
}

export async function ensureSeeded(): Promise<void> {
  const practices = await withoutPractice((tx) => repo.countPractices(tx));
  if ((practices?.count ?? 0) > 0) return;

  const config = getConfig();
  const mode = resolveSeedMode(process.env, config.isProd);
  if (mode === "off") {
    /**
     * The advice has to differ by environment, because the two situations have different exits.
     * Production REFUSES every seeding mode, so telling a production operator to set
     * `AUTH_SEED_MODE=explicit` sends them at a door this function has already locked — the kind of
     * unactionable instruction NEW-27 removed from this file once already.
     */
    logger.warn("Bootstrap is disabled — no practice and no accounts were created.", {
      channel: "security",
      seedMode: mode,
      howToGetIn: config.isProd
        ? "Production never seeds demo accounts. Create the first practice and its owner out of " +
          "band, then use `npm run auth:issue-reset -- <email>` to set that owner a password."
        : "Set AUTH_SEED_MODE=explicit together with a password in every AUTH_SEED_*_PASSWORD " +
          "variable, or leave it unset to seed with random passwords and use " +
          "`npm run auth:issue-reset -- <email>` to get in.",
    });
    return;
  }

  /**
   * Resolved BEFORE anything is written. The previous order inserted the practice first and
   * discovered problems afterwards, which on any failure left a practice row with no users —
   * a half-bootstrapped tenant that `countPractices` then reports as seeded, so the next boot
   * skips seeding entirely and the deployment is permanently unusable.
   */
  const { supplied, missing } = collectSuppliedPasswords(process.env);
  if (mode === "explicit" && missing.length) {
    throw new Error(
      `AUTH_SEED_MODE=explicit requires a password for every seeded role. Missing: ${missing.join(", ")}.`
    );
  }
  const byEmail = new Map(supplied.map((s) => [s.email, s.password]));

  const practice = await withoutPractice((tx) => repo.insertPractice(tx, "Demo Dental Practice"));
  const practiceId = asId<string>(practice!.id);

  await withPractice(practiceId, async (tx) => {
    for (const acct of SEED) {
      /**
       * Scoped to this iteration and never collected. The old code accumulated every
       * generated password into an array that outlived the loop purely so it could be
       * logged; with nothing to log there is nothing to accumulate, and the material cannot
       * reach a caller that might.
       */
      const password = byEmail.get(acct.email) ?? randomBytes(9).toString("base64url");
      await repo.insertUser(tx, {
        practiceId,
        email: acct.email,
        name: acct.name,
        role: acct.role,
        passwordHash: await hashPassword(password),
      });
    }
  });

  announceSeeded(
    mode,
    SEED.map((a) => a.email)
  );
}
