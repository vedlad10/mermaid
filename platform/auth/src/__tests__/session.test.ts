import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newSession, hashSessionToken, sha256, isExpired, newResetToken, resetTokenExpired,
} from "../session.ts";
import { idleDecision, SESSION_TOUCH_GRANULARITY_MS } from "../session.ts";
import { reportedIdleMs } from "../service.ts";
import { sessionIdleMinutes } from "@mermaid/config";

test("newSession issues token + csrf + hash + expiry; only the hash matches storage", () => {
  const now = 1_000_000;
  const s = newSession(12, now);
  assert.ok(s.token.length > 20);
  assert.ok(s.csrf.length > 20);
  assert.notEqual(s.token, s.csrf);
  assert.equal(s.tokenHash, hashSessionToken(s.token));
  assert.notEqual(s.tokenHash, s.token); // stored value is not the cookie value
  assert.equal(s.expiresAt, now + 12 * 3_600_000);
});

test("hashSessionToken/sha256 are deterministic", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abd"));
});

test("isExpired compares against now", () => {
  assert.equal(isExpired(100, 99), false);
  assert.equal(isExpired(100, 100), true);
  assert.equal(isExpired(100, 101), true);
});

test("reset tokens carry an epoch-seconds expiry and hash", () => {
  const now = 2_000_000; // ms
  const rt = newResetToken(3600, now);
  assert.equal(rt.tokenHash, sha256(rt.token));
  assert.equal(rt.exp, Math.floor(now / 1000) + 3600);
  assert.equal(resetTokenExpired(rt.exp, now), false);
  assert.equal(resetTokenExpired(rt.exp, (rt.exp + 1) * 1000), true);
});

// ── Automatic logoff (0036) ───────────────────────────────────────────────────────────────────

const W = 30 * 60_000;
const T = 1_800_000_000_000;

test("a session untouched past the window is expired, whatever the request says", () => {
  assert.deepEqual(idleDecision({ lastSeenAt: T - W - 1, now: T, idleWindowMs: W, reportedIdleMs: 0 }), { expired: true, touchAt: null });
  // Exactly at the window is still alive: the window is how long it MAY sit untouched.
  assert.equal(idleDecision({ lastSeenAt: T - W, now: T, idleWindowMs: W, reportedIdleMs: 0 }).expired, false);
});

test("a poll from an untouched browser records no activity", () => {
  const d = idleDecision({ lastSeenAt: T - 10 * 60_000, now: T, idleWindowMs: W, reportedIdleMs: 10 * 60_000 });
  assert.deepEqual(d, { expired: false, touchAt: null });
});

test("a real input records activity at the moment of the input, not of the request", () => {
  const d = idleDecision({ lastSeenAt: T - 10 * 60_000, now: T, idleWindowMs: W, reportedIdleMs: 2_000 });
  assert.equal(d.touchAt, T - 2_000);
});

test("no report counts as activity now; activity inside a minute is not worth a write", () => {
  assert.equal(idleDecision({ lastSeenAt: T - 5 * 60_000, now: T, idleWindowMs: W, reportedIdleMs: null }).touchAt, T);
  assert.equal(
    idleDecision({ lastSeenAt: T - SESSION_TOUCH_GRANULARITY_MS + 1, now: T, idleWindowMs: W, reportedIdleMs: 0 }).touchAt,
    null
  );
});

test("the idle header is a non-negative whole number of milliseconds, or no report at all", () => {
  assert.equal(reportedIdleMs("1500"), 1500);
  assert.equal(reportedIdleMs(" 0 "), 0);
  assert.equal(reportedIdleMs(["42", "7"]), 42);
  for (const bad of [undefined, "", "-5", "1.5", "abc", "1e9", "9999999999999"]) assert.equal(reportedIdleMs(bad), null, String(bad));
});

test("SESSION_IDLE_MINUTES defaults to 30, and a bad value refuses to boot rather than becoming another value", () => {
  assert.equal(sessionIdleMinutes(undefined), 30);
  assert.equal(sessionIdleMinutes(""), 30);
  assert.equal(sessionIdleMinutes("15"), 15);
  for (const bad of ["0", "-1", "721", "15.5", "thirty", "off"]) assert.throws(() => sessionIdleMinutes(bad), /SESSION_IDLE_MINUTES/, bad);
});
