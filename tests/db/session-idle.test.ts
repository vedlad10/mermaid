/**
 * Automatic logoff, over real HTTP against a real database (migration 0036).
 *
 * A session used to have only an absolute 12-hour expiry, so a workstation left signed in kept its
 * session — and whatever patient was on screen — for the rest of the day. These pin the control that
 * replaced that: a session idle past SESSION_IDLE_MINUTES (default 30) ends on its next use and the
 * ending is audited; a background poll does NOT count as somebody being there; real activity does.
 *
 * Idleness is staged by moving `sessions.last_seen_at` with the owner connection rather than by
 * waiting thirty minutes, and read back the same way, so the assertions are about what is STORED.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createUser } from "@mermaid/auth";
import { withPractice } from "@mermaid/db";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";
let admin: pg.Client | null = null;

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (admin) await admin.end().catch(() => {});
  await dropPractices(...created);
  await shutdown();
});

async function app(): Promise<string> {
  if (base) return base;
  server = createApp(buildServices());
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

/** The owner connection: `sessions` is RLS-forced, and these tests move and read rows directly. */
async function owner(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set; these tests move session clocks as the owner.");
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  return admin;
}

const MINUTE = 60_000;

/** Sign a fresh owner in over HTTP; returns the cookie and the stored session's key. */
async function signedIn(label: string): Promise<{ cookie: string; tokenHash: string; email: string }> {
  const practiceId = await makePractice(label);
  created.push(practiceId);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () => createUser(practiceId, { email, name: `${label} Owner`, role: "owner", password }));

  const res = await fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { idleTimeoutMs?: number };
  assert.equal(body.idleTimeoutMs, 30 * MINUTE, "the browser is told the window, so it can lock on its own clock");
  const token = /mermaid_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "a session cookie was issued");
  return { cookie: `mermaid_sid=${token}`, tokenHash: createHash("sha256").update(token).digest("hex"), email };
}

const get = async (cookie: string, idleMs: number | null) =>
  fetch(`${await app()}/api/v1/claims`, {
    headers: { cookie, ...(idleMs === null ? {} : { "x-mermaid-idle-ms": String(idleMs) }) },
  });

async function lastSeen(tokenHash: string): Promise<number | null> {
  const { rows } = await (await owner()).query<{ last_seen_at: string | null }>(
    "SELECT last_seen_at FROM sessions WHERE token_hash = $1",
    [tokenHash]
  );
  if (rows.length === 0) return null;
  return rows[0]!.last_seen_at === null ? null : Number(rows[0]!.last_seen_at);
}

const setLastSeen = async (tokenHash: string, at: number | null) =>
  (await owner()).query("UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1", [tokenHash, at]);

test("a session left alone past the idle window ends on its next use, and the ending is audited", dbTest, async () => {
  const s = await signedIn("idle-ends");
  assert.equal((await get(s.cookie, 0)).status, 200);

  await setLastSeen(s.tokenHash, Date.now() - 31 * MINUTE);
  assert.equal((await get(s.cookie, 0)).status, 401, "a click after 31 untouched minutes is too late");
  assert.equal(await lastSeen(s.tokenHash), null, "the session row is gone, not merely refused");

  const { rows } = await (await owner()).query<{ action: string; outcome: string }>(
    "SELECT action, outcome FROM audit_events WHERE resource_id = $1 ORDER BY created_at",
    [s.email]
  );
  assert.deepEqual(rows.map((r) => r.action), ["login", "session_idle_expired"], "the log shows the system ended it");
});

test("a background poll does not keep an unattended screen signed in", dbTest, async () => {
  const s = await signedIn("idle-poll");
  const tenMinutesAgo = Date.now() - 10 * MINUTE;
  await setLastSeen(s.tokenHash, tenMinutesAgo);

  // Today's one-minute poll, from a browser nobody has touched for ten minutes.
  assert.equal((await get(s.cookie, 10 * MINUTE)).status, 200, "still inside the window, so it is answered");
  assert.equal(await lastSeen(s.tokenHash), tenMinutesAgo, "but it records no activity");

  // Twenty-one more minutes of polling: the stored clock never moved, so the session ends.
  await setLastSeen(s.tokenHash, Date.now() - 31 * MINUTE);
  assert.equal((await get(s.cookie, 31 * MINUTE)).status, 401);
});

test("a real click records activity, so a working person is never signed out", dbTest, async () => {
  const s = await signedIn("idle-active");
  await setLastSeen(s.tokenHash, Date.now() - 20 * MINUTE);
  const before = Date.now();

  assert.equal((await get(s.cookie, 0)).status, 200);
  assert.ok((await lastSeen(s.tokenHash))! >= before, "the clock moved to the click");

  // A request with no report at all (a script, an older tab) counts as activity, as it always did.
  await setLastSeen(s.tokenHash, Date.now() - 20 * MINUTE);
  const again = Date.now();
  assert.equal((await get(s.cookie, null)).status, 200);
  assert.ok((await lastSeen(s.tokenHash))! >= again);
});

test("a session from before 0036 is judged from when it began, not treated as fresh", dbTest, async () => {
  const s = await signedIn("idle-legacy");
  await setLastSeen(s.tokenHash, null);
  await (await owner()).query("UPDATE sessions SET created_at = now() - interval '40 minutes' WHERE token_hash = $1", [
    s.tokenHash,
  ]);
  assert.equal((await get(s.cookie, 0)).status, 401);
});
