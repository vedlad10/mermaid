/**
 * Two-step sign-in, over real HTTP against a real database (migration 0038).
 *
 * What these pin, in the order a person meets them: enrolling stores the secret encrypted and hands
 * out recovery codes once; a password alone then earns a session that can do nothing but give the
 * code; the code REPLACES that session; a code signs in once; a recovery code signs in once; five
 * wrong codes end the attempt; an administrator can clear a lost phone and that ends the person's
 * sessions; and where the deployment requires MFA, a person without it must enrol before anything.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { base32Decode, createUser, hotp, totpStep } from "@mermaid/auth";
import { resetConfigCache } from "@mermaid/config";
import { withPractice } from "@mermaid/db";
import type { Role } from "@mermaid/shared";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";
let admin: pg.Client | null = null;

after(async () => {
  delete process.env.MFA_REQUIRED;
  resetConfigCache();
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

async function owner(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set; these tests read stored MFA state as the owner.");
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  return admin;
}

const PASSWORD = "correct-horse-battery";

interface Client {
  cookie: string;
  csrf: string;
}

async function account(practiceId: string, role: Role = "owner"): Promise<{ email: string; id: string }> {
  const email = `mfa-${role}-${randomBytes(4).toString("hex")}@example.test`;
  const { id } = await withPractice(practiceId, () => createUser(practiceId, { email, name: `MFA ${role}`, role, password: PASSWORD }));
  return { email, id };
}

async function practice(label: string): Promise<string> {
  const id = await makePractice(label);
  created.push(id);
  return id;
}

const cookieOf = (res: Response): string | null => {
  const token = /mermaid_sid=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return token ? `mermaid_sid=${token}` : null;
};

async function signIn(email: string): Promise<{ body: Record<string, unknown>; client: Client }> {
  const res = await fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  return { body, client: { cookie: cookieOf(res)!, csrf: String(body.csrf) } };
}

async function post(client: Client, path: string, body: unknown = {}) {
  const res = await fetch(`${await app()}${path}`, {
    method: "POST",
    headers: { cookie: client.cookie, "x-csrf-token": client.csrf, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: string } };
  return { status: res.status, json, cookie: cookieOf(res) };
}

const claims = async (client: Client) => (await fetch(`${await app()}/api/v1/claims`, { headers: { cookie: client.cookie } })).status;

/** The code an authenticator app would show, `offset` steps from now. */
const codeFor = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + offset);

/** Sign in fully, enrol an authenticator, and return the secret and the recovery codes. */
async function enrolled(practiceId: string, role: Role = "owner") {
  const who = await account(practiceId, role);
  const { client } = await signIn(who.email);
  const setup = await post(client, "/api/v1/auth/mfa/setup");
  assert.equal(setup.status, 200);
  const secret = String(setup.json.secret);
  assert.match(String(setup.json.otpauthUri), /^otpauth:\/\/totp\//);
  const enable = await post(client, "/api/v1/auth/mfa/enable", { code: codeFor(secret) });
  assert.equal(enable.status, 200);
  const recoveryCodes = enable.json.recoveryCodes as string[];
  assert.equal(recoveryCodes.length, 10);
  await post(client, "/api/v1/auth/logout");
  return { ...who, secret, recoveryCodes };
}

test("enrolling stores the secret encrypted and bound, and hands out recovery codes once", dbTest, async () => {
  const p = await practice("mfa-enrol");
  const who = await enrolled(p);
  const { rows } = await (await owner()).query(
    "SELECT mfa_secret, mfa_pending_secret, mfa_enabled_at, array_length(mfa_recovery_hashes, 1) AS codes FROM staff_users WHERE id = $1",
    [who.id]
  );
  const row = rows[0]!;
  assert.ok(row.mfa_enabled_at, "on");
  assert.equal(row.mfa_pending_secret, null, "the enrolment is no longer pending");
  assert.match(row.mfa_secret, /^v2:/, "encrypted and bound to its row and column");
  assert.ok(!String(row.mfa_secret).includes(who.secret), "the secret itself is not on disk");
  assert.equal(row.codes, 10, "ten recovery codes, stored as hashes");
  for (const c of who.recoveryCodes) {
    const { rows: leaked } = await (await owner()).query("SELECT 1 FROM staff_users WHERE $1 = ANY(mfa_recovery_hashes)", [c]);
    assert.equal(leaked.length, 0, "no recovery code is stored as itself");
  }
});

test("a password alone earns a session that can only give the code, and the code replaces it", dbTest, async () => {
  const p = await practice("mfa-signin");
  const who = await enrolled(p);

  const { body, client: pending } = await signIn(who.email);
  assert.equal(body.mfa, "verify");
  assert.equal(body.user, undefined, "nothing about the account until the factor is given");
  assert.equal(await claims(pending), 401, "the password-only session reaches nothing");

  const wrong = await post(pending, "/api/v1/auth/mfa/verify", { code: "000000" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error?.code, "bad_mfa_code");

  // The next step: enrolment spent the current one, and a code signs in once.
  const right = await post(pending, "/api/v1/auth/mfa/verify", { code: codeFor(who.secret, 1) });
  assert.equal(right.status, 200);
  assert.ok(right.cookie && right.cookie !== pending.cookie, "a NEW session, not the pending one upgraded");
  const full: Client = { cookie: right.cookie!, csrf: String(right.json.csrf) };
  assert.equal(await claims(full), 200);
  assert.equal(await claims(pending), 401, "the password-only token is dead");
});

test("a code signs in once; the next step's code still works", dbTest, async () => {
  const p = await practice("mfa-replay");
  const who = await enrolled(p);
  // Enrolment spent the current step, so start from the next one.
  const code = codeFor(who.secret, 1);

  const first = (await signIn(who.email)).client;
  assert.equal((await post(first, "/api/v1/auth/mfa/verify", { code })).status, 200);

  const second = (await signIn(who.email)).client;
  assert.equal((await post(second, "/api/v1/auth/mfa/verify", { code })).status, 401, "the same code again is a replay");
});

test("a recovery code signs in once", dbTest, async () => {
  const p = await practice("mfa-recovery");
  const who = await enrolled(p);
  const recovery = who.recoveryCodes[3]!.toLowerCase(); // however it is typed

  const first = (await signIn(who.email)).client;
  assert.equal((await post(first, "/api/v1/auth/mfa/verify", { code: recovery })).status, 200);
  const second = (await signIn(who.email)).client;
  assert.equal((await post(second, "/api/v1/auth/mfa/verify", { code: recovery })).status, 401, "spent");
});

test("the fifth wrong code ends the attempt; the password is needed again", dbTest, async () => {
  const p = await practice("mfa-attempts");
  const who = await enrolled(p);
  const { client } = await signIn(who.email);
  for (let i = 0; i < 5; i++) assert.equal((await post(client, "/api/v1/auth/mfa/verify", { code: "000000" })).status, 401);
  const after = await post(client, "/api/v1/auth/mfa/verify", { code: codeFor(who.secret, 1) });
  assert.equal(after.status, 401);
  assert.equal(after.json.error?.code, "unauthenticated", "the pending session is gone, even for a right code");
});

test("an administrator clears a lost phone, which ends that person's sessions; never their own", dbTest, async () => {
  const p = await practice("mfa-reset");
  const boss = await account(p, "owner");
  const worker = await enrolled(p, "biller");

  // The biller is signed in somewhere.
  const pending = (await signIn(worker.email)).client;
  const theirs = await post(pending, "/api/v1/auth/mfa/verify", { code: codeFor(worker.secret, 1) });
  const workerSession: Client = { cookie: theirs.cookie!, csrf: String(theirs.json.csrf) };
  assert.equal(await claims(workerSession), 200);

  const { client: bossClient } = await signIn(boss.email);
  assert.equal((await post(bossClient, `/api/v1/users/${worker.id}/mfa/reset`)).status, 200);
  assert.equal(await claims(workerSession), 401, "their sessions ended with it");
  const { body } = await signIn(worker.email);
  assert.equal(body.mfa, null, "the factor is cleared (and optional on this deployment)");

  const own = await post(bossClient, `/api/v1/users/${boss.id}/mfa/reset`);
  assert.equal(own.status, 409, "an administrator cannot strip their own factor this way");

  const { rows } = await (await owner()).query("SELECT action FROM audit_events WHERE resource_id = $1 AND action = 'mfa_reset'", [worker.email]);
  assert.equal(rows.length, 1, "audited against the person whose factor was cleared");
});

test("where MFA is required, a person without it must enrol before reaching anything", dbTest, async () => {
  process.env.MFA_REQUIRED = "1";
  resetConfigCache();
  try {
    const p = await practice("mfa-required");
    const who = await account(p, "front_desk");
    const { body, client } = await signIn(who.email);
    assert.equal(body.mfa, "enroll");
    assert.equal(await claims(client), 401);

    const setup = await post(client, "/api/v1/auth/mfa/setup");
    assert.equal(setup.status, 200);
    const done = await post(client, "/api/v1/auth/mfa/enable", { code: codeFor(String(setup.json.secret)) });
    assert.equal(done.status, 200);
    assert.equal((done.json.recoveryCodes as string[]).length, 10);
    assert.ok(done.cookie && done.cookie !== client.cookie, "enrolling at the sign-in step replaces the pending session");
    const full: Client = { cookie: done.cookie!, csrf: String(done.json.csrf) };
    assert.equal(await claims(full), 403, "signed in — the front desk simply may not read claims");

    const off = await post(full, "/api/v1/auth/mfa/disable", { password: PASSWORD, code: codeFor(String(setup.json.secret), 1) });
    assert.equal(off.status, 403, "it cannot be turned off where it is required");
  } finally {
    delete process.env.MFA_REQUIRED;
    resetConfigCache();
  }
});
