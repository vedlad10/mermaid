/**
 * Session + reset token primitives — pure crypto (node:crypto), no DB. Tokens are random 256-bit
 * values; only their SHA-256 hash is ever stored, so a leaked DB row can't be replayed as a cookie.
 */
import { randomBytes, createHash } from "node:crypto";

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export interface NewSession {
  token: string;      // returned to the client as the `sid` cookie (never stored)
  csrf: string;       // returned for the double-submit CSRF twin
  tokenHash: string;  // stored in `sessions.token_hash`
  expiresAt: number;  // epoch ms
}

export function newSession(ttlHours: number, now: number = Date.now()): NewSession {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  return { token, csrf, tokenHash: sha256(token), expiresAt: now + ttlHours * 3_600_000 };
}

export const hashSessionToken = (token: string): string => sha256(token);

export const isExpired = (expiresAt: number, now: number = Date.now()): boolean => expiresAt <= now;

export interface NewResetToken {
  token: string;      // delivered to the user (email in prod)
  tokenHash: string;  // stored
  exp: number;        // epoch SECONDS
}

export function newResetToken(ttlSeconds: number, now: number = Date.now()): NewResetToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256(token), exp: Math.floor(now / 1000) + ttlSeconds };
}

export const resetTokenExpired = (exp: number, now: number = Date.now()): boolean =>
  exp <= Math.floor(now / 1000);

/**
 * How often a session's `last_seen_at` is written. Activity inside this granularity is not worth a
 * write on every request; the cost is that idleness is measured to within a minute.
 */
export const SESSION_TOUCH_GRANULARITY_MS = 60_000;

export interface IdleDecision {
  /** The session has been left alone longer than the idle window: end it. */
  expired: boolean;
  /** When to record activity, or null when nothing newer than the stored value happened. */
  touchAt: number | null;
}

/**
 * Automatic logoff (45 CFR 164.312(a)(2)(iii)), decided from three facts and nothing else.
 *
 * `reportedIdleMs` is what the browser says: how long since a real key or pointer input. It is what
 * keeps an unattended screen from staying signed in on the strength of its own polling — a poll an
 * hour after the last keystroke reports an hour of idleness, so it records no activity, and the
 * session ends on schedule. Null means no report (a script, an older tab) and counts as activity
 * now, which is the old behaviour.
 *
 * A client could lie and report zero. It does not matter: the control is against a screen nobody is
 * at, not against a person holding a session, who could simply keep using it.
 *
 * The idle test reads the STORED value, before this request's activity is applied, so a request that
 * arrives after the window has already passed cannot resurrect the session it would have touched.
 */
export function idleDecision(input: {
  lastSeenAt: number;
  now: number;
  idleWindowMs: number;
  reportedIdleMs: number | null;
}): IdleDecision {
  const { lastSeenAt, now, idleWindowMs, reportedIdleMs } = input;
  if (now - lastSeenAt > idleWindowMs) return { expired: true, touchAt: null };
  const activityAt = reportedIdleMs === null ? now : now - Math.max(0, reportedIdleMs);
  const worthWriting = activityAt - lastSeenAt >= SESSION_TOUCH_GRANULARITY_MS;
  return { expired: false, touchAt: worthWriting ? activityAt : null };
}
