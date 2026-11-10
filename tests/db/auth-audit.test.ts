/**
 * Every authentication event reaches the audit trail — over real HTTP, against a real database
 * (NEW-05).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `recordAudit` had ONE production call site: `auditRequest`, which writes a row per non-GET API
 * request that reaches a handler. Authentication never reaches one. `handleAuthApi` runs before the
 * per-request transaction opens, and a failed sign-in is refused before any handler at all.
 *
 * So `audit_events` recorded what people did with their sessions and nothing about how those
 * sessions came to exist — no sign-in, no sign-out, no failed attempt, no password reset. Those are
 * the rows a breach investigation opens with, and the ones §164.312(b) exists for.
 *
 * ── WHY THESE ASSERTIONS READ THE TABLE DIRECTLY ─────────────────────────────────────────────────
 * The rows are written through `record_audit`, a SECURITY DEFINER function the app role can call
 * but whose table it has no INSERT on — that is what makes the trail append-only. Reading it back
 * with an admin client asserts the row exists AS STORED, rather than trusting a code path that
 * claims to have written it.
 *
 * A failed sign-in for an address nobody holds is stored with `practice_id = NULL`, and that is
 * deliberate: it belongs to no tenant, and `audit_read` scopes tenant reads to their own practice.
 * Only a platform operator sees those, which is the correct audience for "somebody is scanning".
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createUser } from "@mermaid/auth";
import { resetConfigCache } from "@mermaid/config";
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

/**
 * The owner connection, so rows with a null practice_id — which no tenant may read — are visible.
 *
 * ── WHY THIS REFUSES TO FALL BACK ────────────────────────────────────────────────────────────────
 * It used to read `DATABASE_ADMIN_URL || DATABASE_URL`. On a machine with only the latter set, that
 * silently produced a reader that is not an owner: `DATABASE_URL` is `mermaid_app`, RLS-subject, and
 * these queries run with no practice context, so `audit_read`'s `practice_id = current_practice()`
 * matches nothing. Every assertion in this file then failed as `0 !== 1` — which reads exactly like
 * authentication events not reaching the audit trail at all, on the one suite whose whole subject is
 * HIPAA §164.312(b).
 *
 * A fallback that turns a configuration gap into a false report of a broken compliance control is
 * worse than no fallback. This asks for the connection it actually needs and says so when it is
 * missing, which is the same stance `harness.ts` takes on `DATABASE_URL`: skip loudly, never pass
 * (or fail) quietly for the wrong reason.
 */
async function adminClient(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error(
      "DATABASE_ADMIN_URL is not set. These assertions read audit_events as the table OWNER, because " +
        "rows with a null practice_id are readable by no tenant. Falling back to DATABASE_URL (the " +
        "RLS-subject app role) would return zero rows and report working audit logging as broken."
    );
  }
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const { rows } = await admin.query<{ is_owner: boolean }>(
    "SELECT pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_events'), 'member') AS is_owner"
  );
  if (!rows[0]?.is_owner) {
    throw new Error(
      "DATABASE_ADMIN_URL does not connect as a role that owns audit_events, so it cannot see rows " +
        "with a null practice_id — the very rows these tests assert on."
    );
  }
  return admin;
}

interface AuditRow {
  practice_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  outcome: string;
  ip: string | null;
  after_json: { reason?: string } | null;
}

/** Every audit row about this email address, oldest first. */
async function rowsFor(email: string): Promise<AuditRow[]> {
  const c = await adminClient();
  const { rows } = await c.query<AuditRow>(
    `SELECT practice_id, actor_id, actor_role, action, resource, resource_id, outcome, ip, after_json
       FROM audit_events
      WHERE resource_id = $1
      ORDER BY created_at, action`,
    [email]
  );
  return rows;
}

async function account(label: string): Promise<{ email: string; password: string; practiceId: string }> {
  const practiceId = await makePractice(label);
  created.push(practiceId);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () =>
    createUser(practiceId, { email, name: `${label} Owner`, role: "owner", password })
  );
  return { email, password, practiceId };
}

const login = async (email: string, password: string) =>
  fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

test("a successful sign-in writes an audit row naming the actor and the practice", dbTest, async () => {
  const { email, password, practiceId } = await account("audit-ok");

  const res = await login(email, password);
  assert.equal(res.status, 200);

  const rows = await rowsFor(email);
  assert.equal(rows.length, 1, "exactly one row — a sign-in is one event");
  const row = rows[0]!;
  assert.equal(row.action, "login");
  assert.equal(row.outcome, "success");
  assert.equal(row.resource, "session");
  assert.equal(row.practice_id, practiceId, "scoped to the practice, so its own auditor can read it");
  assert.ok(row.actor_id, "and it names WHO signed in");
  assert.equal(row.actor_role, "owner");
  assert.equal(row.after_json, null, "nothing about the credential is stored on a success");
});

test("a FAILED sign-in is audited — the row a breach investigation opens with", dbTest, async () => {
  /**
   * The case the request auditor structurally could not cover: the request is refused before any
   * handler runs, so nothing downstream ever saw it.
   */
  const { email, practiceId } = await account("audit-bad");

  const res = await login(email, "not-the-password");
  assert.equal(res.status, 401);

  const denied = (await rowsFor(email)).filter((r) => r.outcome === "denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.action, "login");
  assert.equal(
    denied[0]!.practice_id,
    practiceId,
    "a guess against a REAL account belongs to that practice — its owner should be able to see it"
  );
  assert.equal(
    denied[0]!.after_json?.reason,
    "bad_password",
    "the response says only 'invalid email or password' so it cannot enumerate accounts; the log " +
      "is the only place the distinction survives, and it is the distinction that matters"
  );
});

test("an attempt on an address nobody holds is audited with no tenant", dbTest, async () => {
  const email = `nobody-${randomBytes(4).toString("hex")}@example.test`;

  const res = await login(email, "whatever");
  assert.equal(res.status, 401);

  const rows = await rowsFor(email);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "denied");
  assert.equal(rows[0]!.after_json?.reason, "no_such_user");
  assert.equal(
    rows[0]!.practice_id,
    null,
    "it belongs to no practice, and must not be filed under one — a scan is a platform concern"
  );
  assert.equal(rows[0]!.actor_id, null);
});

test("signing out writes its own row, and only when a session actually ended", dbTest, async () => {
  const { email, password } = await account("audit-out");

  const res = await login(email, password);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };

  const out = await fetch(`${await app()}/api/v1/auth/logout`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf },
  });
  assert.equal(out.status, 200);

  const actions = (await rowsFor(email)).map((r) => `${r.action}:${r.outcome}`);
  assert.deepEqual(actions.sort(), ["login:success", "logout:success"]);

  // A logout with no cookie is a browser tidying up, not an event. Recording those would bury the
  // sign-outs that actually ended a session.
  const before = (await rowsFor(email)).length;
  await fetch(`${await app()}/api/v1/auth/logout`, { method: "POST", headers: { "x-csrf-token": csrf } });
  assert.equal((await rowsFor(email)).length, before, "no session, no event");
});

test("a password reset is audited at both ends", dbTest, async () => {
  const { email } = await account("audit-reset");
  const url = await app();

  const requested = await fetch(`${url}/api/v1/auth/password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.status, 202);
  const { token } = (await requested.json()) as { token: string | null };
  assert.ok(token, "outside production the token comes back, which is what makes this testable");

  const confirmed = await fetch(`${url}/api/v1/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, token, password: "a-brand-new-passphrase" }),
  });
  assert.equal(confirmed.status, 200);

  const rows = await rowsFor(email);
  assert.deepEqual(
    rows.map((r) => `${r.action}:${r.outcome}`).sort(),
    ["password_reset_confirmed:success", "password_reset_requested:success"]
  );
  for (const r of rows) {
    assert.equal(r.resource, "credential", "a reset is about the credential, not the session");
  }
});

test("no attempted password reaches the audit table, in any form", dbTest, async () => {
  /**
   * The rule that costs nothing to keep and everything to break. A password typed into the email
   * field, or against the wrong account, is still a live credential — and this table is retained
   * for years and readable by every auditor in the practice.
   */
  const { email, password } = await account("audit-nopw");
  const secret = "hunter2-unmistakable-string";

  await login(email, secret);
  await login(email, password);

  const c = await adminClient();
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_events
      WHERE created_at > now() - interval '5 minutes'
        AND (COALESCE(before_json::text, '') || COALESCE(after_json::text, '') ||
             COALESCE(resource_id, '')) LIKE '%' || $1 || '%'`,
    [secret]
  );
  assert.equal(Number(rows[0]!.n), 0, "the attempted password must appear nowhere");
});

/**
 * ── THE ROW IS ONLY AS USEFUL AS THE ADDRESS IN IT ─────────────────────────────────────────────
 * A deployment that declares nothing in front of it writes `ip = ::1` on every one of these rows,
 * because the platform's router reaches the process over loopback. The
 * trail recorded that somebody signed in and said nothing about from where — which is most of what
 * a breach investigation wants from it.
 *
 * `clientIpFrom` is unit-tested against every header shape; this asserts the two ends are actually
 * connected: the declared source reaches the stored row, over real HTTP, through `record_audit`,
 * read back as the owner. And that the header a client can write does NOT.
 */
async function underDeclaredSource<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = value;
  resetConfigCache();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
    resetConfigCache();
  }
}

const loginFrom = async (email: string, password: string, headers: Record<string, string>) =>
  fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email, password }),
  });

test("the audit row stores the client address the declared edge reported", dbTest, async () => {
  const { email, password } = await account("audit-ip");

  await underDeclaredSource("cloudflare", async () => {
    const res = await loginFrom(email, password, {
      "cf-connecting-ip": "203.0.113.9",
      // The client's own claim, sent alongside. Cloudflare appends to this chain rather than
      // replacing it, so a forged entry is exactly what a real attacker's request looks like.
      "x-forwarded-for": "6.6.6.6, 203.0.113.9, 172.71.150.4",
    });
    assert.equal(res.status, 200);
  });

  const rows = await rowsFor(email);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ip, "203.0.113.9", "the edge's own header, not the socket and not the chain");
});

test("a forged header cannot write an address into the trail", dbTest, async () => {
  /**
   * The same request with NOTHING declared in front of this process. Both headers are then a
   * stranger's claim, and a trail that recorded one would be stating a falsehood about a person —
   * worse than the honest loopback address it falls back to.
   */
  const { email, password } = await account("audit-ip-spoof");

  await underDeclaredSource("0", async () => {
    const res = await loginFrom(email, password, {
      "cf-connecting-ip": "6.6.6.6",
      "x-forwarded-for": "6.6.6.6",
    });
    assert.equal(res.status, 200);
  });

  const rows = await rowsFor(email);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.ip, "6.6.6.6", "an undeclared header must never become an audit fact");
  assert.match(String(rows[0]!.ip), /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/, "the socket, honestly");
});
