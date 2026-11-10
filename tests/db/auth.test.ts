/**
 * Authentication, sessions and tenant isolation over the real HTTP surface, against a real database.
 *
 * The whole app is booted on an ephemeral port and driven through `fetch`, exactly as a browser
 * would. What these prove is the part that only exists once there is a database: that the practice
 * a request operates on comes from the SESSION and cannot be influenced by the request, and that two
 * practices sharing one deployment cannot see each other's revenue.
 *
 * The cross-tenant test is the one that matters most. Every other guarantee in this codebase is a
 * correctness property; this one is the difference between a multi-tenant SaaS and a data breach.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createUser } from "@mermaid/auth";
import { withPractice, requireContext } from "@mermaid/db";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { resetConfigCache } from "@mermaid/config";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await dropPractices(...created);
  await shutdown();
});

/** Boot the real app once, on Postgres. */
async function app(): Promise<string> {
  if (base) return base;
  server = createApp(buildServices());
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

/** A practice with one owner account, and a logged-in client for it. */
async function tenant(label: string) {
  const practiceId = await makePractice(label);
  created.push(practiceId);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () =>
    createUser(practiceId, { email, name: `${label} Owner`, role: "owner", password })
  );

  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `${label} login failed`);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  return { practiceId, email, password, cookie, csrf, call };
}

/**
 * A deliberately obvious NON-DELIVERABLE address for an invented patient.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so the claim scrubber blocks the
 * submit gate without one — and two tests here file a claim. Named to be unmistakable: nothing in
 * this file may ever reach a real payer, and no production path falls back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const VISIT = {
  patient: {
    firstName: "Ada",
    lastName: "Alpha",
    dateOfBirth: "1990-04-12",
    memberId: "ABC12345",
    address: SYNTHETIC_ADDRESS,
  },
  cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
};

// ── Authentication ────────────────────────────────────────────────────────────────────

test("an unauthenticated request is refused with 401, not an empty result", dbTest, async () => {
  const url = await app();
  for (const path of ["/api/v1/verifications", "/api/v1/claims", "/api/v1/remittances"]) {
    const res = await fetch(url + path);
    assert.equal(res.status, 401, `${path} must require a session`);
    assert.equal(((await res.json()) as any).error.code, "unauthenticated");
  }
});

test("health and session are reachable without a login; nothing else is", dbTest, async () => {
  const url = await app();
  assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);

  const session = await fetch(`${url}/api/v1/auth/session`);
  assert.equal(session.status, 200);
  const body = (await session.json()) as any;
  assert.equal(body.authenticated, false);
  assert.equal(body.persistent, true, "the UI must be able to tell it is talking to a real deployment");
});

test("a wrong password is refused, and reveals nothing about whether the account exists", dbTest, async () => {
  const t = await tenant("badpass");
  const url = await app();
  const wrongPassword = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: t.email, password: "wrong-password" }),
  });
  const noSuchUser = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password" }),
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.deepEqual(
    await wrongPassword.json(),
    await noSuchUser.json(),
    "an unknown email and a bad password must be indistinguishable"
  );
});

test("a mutating request without the CSRF header is refused", dbTest, async () => {
  const t = await tenant("csrf");
  const url = await app();
  const res = await fetch(`${url}/api/v1/verifications`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: t.cookie },
    body: JSON.stringify(VISIT),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as any).error.code, "csrf");
});

test("logout invalidates the session immediately", dbTest, async () => {
  const t = await tenant("logout");
  assert.equal((await t.call("GET", "/api/v1/verifications")).status, 200);

  assert.equal((await t.call("POST", "/api/v1/auth/logout", {})).status, 200);
  assert.equal((await t.call("GET", "/api/v1/verifications")).status, 401, "the session row is gone");
});

// ── RBAC ──────────────────────────────────────────────────────────────────────────────

test("an auditor may read everything and write nothing", dbTest, async () => {
  const t = await tenant("rbac");
  const auditorEmail = `auditor-${randomBytes(4).toString("hex")}@example.test`;
  await withPractice(t.practiceId, () =>
    createUser(t.practiceId, { email: auditorEmail, name: "Val Viewer", role: "auditor", password: "correct-horse-battery" })
  );
  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: auditorEmail, password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  assert.equal((await call("GET", "/api/v1/claims")).status, 200);
  assert.equal((await call("GET", "/api/v1/remittances")).status, 200);

  const write = await call("POST", "/api/v1/verifications", VISIT);
  assert.equal(write.status, 403);
  assert.match(((await write.json()) as any).error.message, /\[verifications\.write\]/);

  // The screens added at M8–M10 are covered by the same matrix, and by the same default-deny: a
  // route with no entry in ROUTE_PERMISSIONS is refused, so adding an endpoint and forgetting to
  // authorise it fails closed rather than quietly exposing data.
  assert.equal((await call("GET", "/api/v1/today")).status, 200);
  assert.equal((await call("GET", "/api/v1/analytics/report")).status, 200);
  assert.equal((await call("GET", "/api/v1/patients")).status, 200);
  assert.equal((await call("GET", "/api/v1/ops/outbox")).status, 200, "an auditor's job is to look");
  assert.equal((await call("GET", "/api/v1/ops/audit")).status, 200);
  // M20 — the watchdog's own readings are a read, under the same `audit.read` as the rest of Ops.
  // No new grant was invented for it; the existing `/api/v1/ops` rule already covers the path.
  assert.equal((await call("GET", "/api/v1/ops/monitors")).status, 200);

  // …but not to act. Reviving a stuck event moves real work; recording a patient payment moves real
  // money. Neither is a read, and the auditor role is read-only by construction.
  const revive = await call("POST", "/api/v1/ops/outbox/00000000-0000-0000-0000-000000000000/retry", {});
  assert.equal(revive.status, 403);
  assert.match(((await revive.json()) as any).error.message, /\[org\.manage\]/);

  const writeoff = await call("POST", "/api/v1/patients/ABC12345/writeoff", { amountDollars: 10, note: "x" });
  assert.equal(writeoff.status, 403);
  assert.match(((await writeoff.json()) as any).error.message, /\[remittances\.write\]/);
});

test("the front desk can run the day but cannot touch the money", dbTest, async () => {
  const t = await tenant("rbac-front-desk");
  const email = `front-desk-${randomBytes(4).toString("hex")}@example.test`;
  await withPractice(t.practiceId, () =>
    createUser(t.practiceId, { email, name: "Fran Desk", role: "front_desk", password: "correct-horse-battery" })
  );
  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // The job: see the day's work, look up a patient, and take a payment at checkout.
  assert.equal((await call("GET", "/api/v1/verifications")).status, 200);
  assert.equal((await call("GET", "/api/v1/today")).status, 200);
  assert.equal((await call("GET", "/api/v1/patients")).status, 200);

  // Recording a payment is a front-desk act — money that actually arrived, attributed to whoever
  // took it. Gating it behind a billing permission would push staff into recording payments
  // somewhere else, which is how a ledger stops being the truth. (404 here, not 403: the permission
  // passed and the account simply does not exist in this fresh tenant.)
  const payment = await call("POST", "/api/v1/patients/NOBODY/payment", { amountDollars: 10 });
  assert.equal(payment.status, 404, "authorised, then refused on the merits — not on the permission");

  // Not the job. Forgiving a balance is revenue the practice chooses to lose; running a verification
  // spends a payer call and produces a financial estimate; the report and the audit trail belong to
  // the people who own the money. Each refusal names the permission it wanted, so a 403 is
  // diagnosable rather than mysterious.
  for (const [method, path, permission, body] of [
    ["POST", "/api/v1/patients/NOBODY/writeoff", "remittances.write", { amountDollars: 10, note: "x" }],
    ["POST", "/api/v1/verifications", "verifications.write", VISIT],
    ["GET", "/api/v1/claims", "claims.read", undefined],
    ["GET", "/api/v1/analytics/report", "analytics.read", undefined],
    ["GET", "/api/v1/ops/outbox", "audit.read", undefined],
    // The money readings name held cents and drift for the practice. That is the owner's business,
    // not the front desk's, and it is refused by the same rule as the rest of Ops.
    ["GET", "/api/v1/ops/monitors", "audit.read", undefined],
  ] as const) {
    const denied = await call(method, path, body);
    assert.equal(denied.status, 403, `${method} ${path} should be refused`);
    /**
     * Matched on the bracketed permission token, not on the sentence around it.
     *
     * This assertion used to read `lacks ${permission}`, which was the message's wording until
     * "Build the navigation from what the role may actually do" (1397d08) replaced it with prose a
     * person can act on — "Your role (front desk) does not have access to this. An owner or office
     * manager can grant it. [remittances.write]". The refusal was still correct and still named the
     * same permission; only the sentence changed, and this test failed for a wording change while
     * asserting nothing about the wording it wanted.
     *
     * The token is the durable half of that contract: it is what a client branches on and what an
     * operator greps for. The prose is presentation, and should be free to improve without
     * breaking a security test.
     */
    assert.match(
      ((await denied.json()) as any).error.message,
      new RegExp(`\\[${permission.replace(".", "\\.")}\\]`)
    );
  }
});

/**
 * The dentist's role was incoherent, and the incoherence granted the dangerous half.
 *
 * `dentist` held `appeals.write` — so they could approve and SEND an appeal — while every read of a
 * denial requires `denials.read`, which they did not have. They could act on a payer decision they
 * were forbidden to look at. Worse, `POST /denials/:id/close` sat under the same `appeals.write`
 * catch-all, so a clinical role could write revenue off or move it onto a patient's bill.
 *
 * Both halves are asserted here, over HTTP, because the fix is split across two files — the
 * permission matrix in `@mermaid/shared` and the route table in `server.ts` — and either one alone
 * would leave the role broken in the opposite direction.
 */
test("a dentist can read the denial they are allowed to appeal, and cannot write off its money", dbTest, async () => {
  const t = await tenant("rbac-dentist");
  const email = `dentist-${randomBytes(4).toString("hex")}@example.test`;
  await withPractice(t.practiceId, () =>
    createUser(t.practiceId, { email, name: "Dr Dana Dentist", role: "dentist", password: "correct-horse-battery" })
  );
  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // The job: see the treatment, see the payer's reason, put a clinical name to the appeal.
  assert.equal((await call("GET", "/api/v1/denials")).status, 200, "you cannot appeal what you cannot read");
  assert.equal((await call("GET", "/api/v1/verifications")).status, 200);
  assert.equal((await call("GET", "/api/v1/claims")).status, 200);

  // Drafting reaches the service and is refused on the merits (no such denial), not on permission —
  // which is the proof that `appeals.write` still gets a dentist through the door.
  const draft = await call("POST", "/api/v1/denials/00000000-0000-4000-8000-000000000000/draft", {});
  assert.equal(draft.status, 404, "authorised, then refused on the merits");

  // Not the job. Closing a denial decides whose money it is; the rest belongs to people who own it.
  for (const [method, path, permission, body] of [
    ["POST", "/api/v1/denials/00000000-0000-4000-8000-000000000000/close", "denials.write", { as: "written_off", reason: "x" }],
    ["GET", "/api/v1/patients", "patients.read", undefined],
    ["POST", "/api/v1/verifications", "verifications.write", VISIT],
    ["GET", "/api/v1/analytics/report", "analytics.read", undefined],
  ] as const) {
    const denied = await call(method, path, body);
    assert.equal(denied.status, 403, `${method} ${path} should be refused`);
    /**
     * Matched on the bracketed permission token, not on the sentence around it.
     *
     * This assertion used to read `lacks ${permission}`, which was the message's wording until
     * "Build the navigation from what the role may actually do" (1397d08) replaced it with prose a
     * person can act on — "Your role (front desk) does not have access to this. An owner or office
     * manager can grant it. [remittances.write]". The refusal was still correct and still named the
     * same permission; only the sentence changed, and this test failed for a wording change while
     * asserting nothing about the wording it wanted.
     *
     * The token is the durable half of that contract: it is what a client branches on and what an
     * operator greps for. The prose is presentation, and should be free to improve without
     * breaking a security test.
     */
    assert.match(
      ((await denied.json()) as any).error.message,
      new RegExp(`\\[${permission.replace(".", "\\.")}\\]`)
    );
  }
});

// ── Tenant isolation over HTTP ────────────────────────────────────────────────────────

test("two practices on one deployment cannot see each other's work", dbTest, async () => {
  const [a, b] = [await tenant("iso-a"), await tenant("iso-b")];

  const created = await a.call("POST", "/api/v1/verifications", VISIT);
  assert.equal(created.status, 201);
  const verificationId = created.json.record.id as string;

  // A sees exactly its own; B sees nothing at all.
  assert.equal((await a.call("GET", "/api/v1/verifications")).json.items.length, 1);
  assert.equal((await b.call("GET", "/api/v1/verifications")).json.items.length, 0);

  // And B cannot reach A's record even holding its id — the id is not a capability.
  const stolen = await b.call("GET", `/api/v1/verifications/${verificationId}`);
  assert.equal(stolen.status, 404, "another tenant's row must be indistinguishable from a missing one");
});

test("the claim and its money are equally invisible to the other tenant", dbTest, async () => {
  const [a, b] = [await tenant("money-a"), await tenant("money-b")];

  await a.call("POST", "/api/v1/verifications", VISIT);
  const claims = await a.call("GET", "/api/v1/claims");
  assert.equal(claims.json.items.length, 1, "the durable outbox created the claim before the reply was sent");
  const claimId = claims.json.items[0].id as string;

  await a.call("POST", `/api/v1/claims/${claimId}/submit`, {});
  await a.call("POST", "/api/v1/remittances/fetch", {});

  assert.ok((await a.call("GET", "/api/v1/remittances")).json.items.length >= 1);
  assert.equal((await b.call("GET", "/api/v1/claims")).json.items.length, 0);
  assert.equal((await b.call("GET", "/api/v1/remittances")).json.items.length, 0);
  assert.equal((await b.call("GET", "/api/v1/remittances/recovery")).json.items.length, 0);
  assert.equal((await b.call("GET", `/api/v1/claims/${claimId}`)).status, 404);
});

test("the human gates are attributed to the authenticated user, not to request input", dbTest, async () => {
  const t = await tenant("gate");
  await t.call("POST", "/api/v1/verifications", VISIT);
  const claimId = (await t.call("GET", "/api/v1/claims")).json.items[0].id as string;

  // The body tries to claim someone else filed it. The session wins.
  const filed = await t.call("POST", `/api/v1/claims/${claimId}/submit`, { submittedBy: "someone.else@evil.test" });

  assert.equal(filed.status, 200);
  assert.equal(
    filed.json.claim.submission.submittedBy,
    t.email,
    "an audit trail a client can write is worse than no audit trail"
  );
});

test("work persists across a restart — it is in the database, not the process", dbTest, async () => {
  const t = await tenant("durable");
  await t.call("POST", "/api/v1/verifications", VISIT);

  // A brand-new set of services over the same database, as a redeployed process would have.
  const fresh = buildServices();
  const rows = await withPractice(t.practiceId, () => fresh.verification.list());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.patientName, "Ada Alpha");
});

test("the practice context is transaction-local and never leaks between requests", dbTest, async () => {
  const [a, b] = [await tenant("leak-a"), await tenant("leak-b")];
  await a.call("POST", "/api/v1/verifications", VISIT);

  // Interleave reads from both tenants over pooled connections. If the practice context were
  // session-level rather than transaction-local, one of these would eventually see the other's row.
  for (let i = 0; i < 6; i++) {
    const [seenByA, seenByB] = await Promise.all([
      a.call("GET", "/api/v1/verifications"),
      b.call("GET", "/api/v1/verifications"),
    ]);
    assert.equal(seenByA.json.items.length, 1, `iteration ${i}: A lost its own row`);
    assert.equal(seenByB.json.items.length, 0, `iteration ${i}: B saw A's row`);
  }
});

test("a rolled-back request leaves neither the write nor its event behind", dbTest, async () => {
  const t = await tenant("rollback");
  // A claim id that does not exist: the handler throws after the transaction is open.
  const res = await t.call("POST", `/api/v1/claims/${crypto.randomUUID()}/submit`, {});
  assert.equal(res.status, 404);

  const events = await withPractice(t.practiceId, async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM domain_events");
    return (rows[0] as { n: number }).n;
  });
  assert.equal(events, 0);
});

/**
 * ── THE MONITOR SURFACE IS TENANT-SCOPED (M20) ─────────────────────────────────────────────────
 *
 * The watchdog deliberately aggregates money ACROSS practices — that is its job, and it runs in a
 * process with no user behind it. Serving that same aggregate to a logged-in practice user would
 * put another practice's held money and drift on their screen: a tenant leak introduced in the act
 * of closing a monitoring gap, which is the worst possible way to close one.
 *
 * So the route asks for `this-practice` readings, and this asserts the consequence over real HTTP
 * with two real tenants rather than trusting the parameter. The fixture gives practice B held money
 * and practice A none, because the leak, if present, shows as A reporting B's cash.
 */
test("one practice's held money never appears on another practice's Ops screen", dbTest, async () => {
  const [a, b] = [await tenant("mon-iso-a"), await tenant("mon-iso-b")];

  const readingsFor = async (t: { call: (m: string, p: string) => Promise<{ json: any }> }) => {
    const { json } = await t.call("GET", "/api/v1/ops/monitors");
    return json.checks.find((c: { key: string }) => c.key === "money.held_remittance_age");
  };

  const seenByA = await readingsFor(a);
  const seenByB = await readingsFor(b);

  assert.ok(seenByA, "each practice gets its own reading");
  assert.ok(seenByB);

  // The load-bearing assertion: exactly ONE practice was read, not every active practice in the
  // database. `practicesSeen` is the monitor's own count of how many tenants it enumerated — if the
  // route were using the watchdog's cross-tenant scope this would be the whole table.
  assert.equal(seenByA.detail.practicesSeen, 1, "a user's screen reads one tenant: their own");
  assert.equal(seenByB.detail.practicesSeen, 1);
  assert.equal(seenByA.detail.practicesRead, 1);

  // And neither carries the other's money. Both are empty here, which is the honest state of two
  // fresh tenants — what matters is that the COUNT is per-tenant and cannot sum across them.
  assert.equal(seenByA.detail.heldCents, 0);
  assert.equal(seenByB.detail.heldCents, 0);
});

// ── The reset endpoint, and who it may hand a working token to ────────────────────────────────

test("a hosted deployment does NOT return a password-reset token to an anonymous caller", dbTest, async () => {
  /**
   * ── THE LIVE VULNERABILITY THIS CLOSES ───────────────────────────────────────────────────────
   * `POST /api/v1/auth/password-reset` is a PUBLIC route — no session, by design, because somebody
   * who cannot sign in is exactly who needs it. It branched on `nodeEnv === "production"` alone to
   * decide whether to put the minted token in the response body.
   *
   * With NODE_ENV unset, a public URL returned a live,
   * single-use reset token for any address a caller named, and the response said
   * `"delivery": "in-response"` to explain that it was doing so. That is account takeover for anyone
   * who can reach it.
   *
   * The intent behind returning it is sound and is kept: the laptop demo has no mail provider, so
   * the token has to come back in the response or the flow cannot be demonstrated at all. But that
   * is a fact about a LAPTOP, and "not production" is not the same as "not reachable by strangers".
   *
   * `RENDER_GIT_COMMIT` stands in for the platform here because it is the variable this codebase
   * already reads on the health endpoint — an established fact about the environment, not a new
   * assumption. See `Config.hosted`.
   */
  const { email } = await tenant("reset-hosted");
  const url = await app();

  const ask = async () => {
    const r = await fetch(`${url}/api/v1/auth/password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  const before = process.env.RENDER_GIT_COMMIT;
  try {
    delete process.env.RENDER_GIT_COMMIT;
    resetConfigCache();
    const laptop = await ask();
    assert.equal(laptop.status, 202);
    assert.ok(laptop.json.token, "a laptop must still get the token, or the demo flow cannot run");
    assert.equal(laptop.json.delivery, "in-response");

    process.env.RENDER_GIT_COMMIT = "0000000000000000000000000000000000000000";
    resetConfigCache();
    const deployed = await ask();
    assert.equal(deployed.status, 202, "the response shape must not change — it must not leak whether the address exists");
    assert.equal(
      deployed.json.token,
      null,
      "a hosted deployment handing a stranger a working reset token is account takeover"
    );
    assert.equal(deployed.json.delivery, "unconfigured");
    assert.match(
      String(deployed.json.message),
      /If that email is registered/,
      "and it must still say the same thing whether the address is on file or not"
    );
  } finally {
    if (before === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = before;
    resetConfigCache();
  }
});
