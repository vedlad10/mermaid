/**
 * Who looked at this patient — the read trail, over real HTTP against a real database (0037).
 *
 * `audit_events` records every change and deliberately no reads. These pin the separate control
 * that answers the first question of a privacy complaint: a read of patient-bearing data by a person
 * at the screen leaves exactly one row, in its own practice, that nobody can edit or erase — and a
 * background poll, a reference lookup, and a search term do not.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createUser } from "@mermaid/auth";
import { requireContext, withPractice } from "@mermaid/db";
import type { Role } from "@mermaid/shared";
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

async function owner(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set; the trail is read back as stored, by the owner.");
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  return admin;
}

async function person(practiceId: string, role: Role): Promise<{ cookie: string; userId: string }> {
  const email = `${role}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  const user = await withPractice(practiceId, () => createUser(practiceId, { email, name: `${role} person`, role, password }));
  const res = await fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const token = /mermaid_sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return { cookie: `mermaid_sid=${token}`, userId: String((user as { id: string }).id) };
}

async function practice(label: string): Promise<string> {
  const id = await makePractice(label);
  created.push(id);
  return id;
}

const get = async (cookie: string, path: string, idleMs = 0) =>
  fetch(`${await app()}${path}`, { headers: { cookie, "x-mermaid-idle-ms": String(idleMs) } });

async function trail(practiceId: string): Promise<{ actor_id: string; resource: string; resource_id: string | null; route: string }[]> {
  const { rows } = await (await owner()).query(
    "SELECT actor_id, resource, resource_id, route FROM phi_access_events WHERE practice_id = $1 ORDER BY id",
    [practiceId]
  );
  return rows;
}

test("a person opening patient data leaves one row: who, what, and never the search term", dbTest, async () => {
  const p = await practice("phi-read");
  const me = await person(p, "front_desk");

  assert.equal((await get(me.cookie, "/api/v1/patients/directory?query=Alpha%20Ada")).status, 200);
  const rows = await trail(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor_id, me.userId);
  assert.equal(rows[0]!.resource, "patients");
  assert.equal(rows[0]!.route, "/api/v1/patients/directory", "the query string — a patient's name — is not copied into the log");
});

test("a poll from an untouched screen, a reference lookup and a refused read leave nothing", dbTest, async () => {
  const p = await practice("phi-quiet");
  const desk = await person(p, "front_desk");

  assert.equal((await get(desk.cookie, "/api/v1/patients/directory", 5 * 60_000)).status, 200, "answered");
  assert.equal((await get(desk.cookie, "/api/v1/reference/cdt")).status, 200);
  assert.equal((await get(desk.cookie, "/api/v1/remittances")).status, 403, "front desk may not read remittances");
  assert.deepEqual(await trail(p), [], "a refresh nobody is looking at is not a person viewing a record");
});

test("the trail is readable by an auditor, filtered by record or by person, and by nobody without audit.read", dbTest, async () => {
  const p = await practice("phi-audit");
  const desk = await person(p, "front_desk");
  const manager = await person(p, "office_manager");
  await get(desk.cookie, "/api/v1/patients/directory");

  const all = await get(manager.cookie, `/api/v1/ops/access-log?actorId=${desk.userId}`);
  assert.equal(all.status, 200);
  const { items } = (await all.json()) as { items: { actorId: string; resource: string }[] };
  assert.ok(items.length >= 1 && items.every((i) => i.actorId === desk.userId));

  assert.equal((await get(desk.cookie, "/api/v1/ops/access-log")).status, 403, "the front desk cannot read who looked at what");
});

test("the app role cannot write, edit or erase the trail directly, nor read another practice's", dbTest, async () => {
  const a = await practice("phi-append-a");
  const b = await practice("phi-append-b");
  const desk = await person(a, "front_desk");
  await get(desk.cookie, "/api/v1/patients/directory");
  assert.equal((await trail(a)).length, 1);

  await withPractice(a, async () => {
    const tx = requireContext().tx;
    await assert.rejects(
      tx.query(
        "INSERT INTO phi_access_events (practice_id, trace_id, actor_id, actor_role, resource, route) VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'owner', 'x', '/x')",
        [a]
      ),
      "a forged row is refused"
    );
  });
  await withPractice(a, async () => {
    const tx = requireContext().tx;
    // Refused by the revoked grant, or matched by no policy — either way nothing is touched.
    const del = await tx.query("DELETE FROM phi_access_events").catch(() => ({ rowCount: 0 }));
    const upd = await tx.query("UPDATE phi_access_events SET route = '/nothing'").catch(() => ({ rowCount: 0 }));
    assert.equal(del.rowCount, 0);
    assert.equal(upd.rowCount, 0);
  });
  assert.equal((await trail(a)).length, 1, "the row survives");
  assert.equal((await trail(a))[0]!.route, "/api/v1/patients/directory", "unaltered");

  const seenByB = await withPractice(b, async () => (await requireContext().tx.query("SELECT count(*)::int AS n FROM phi_access_events")).rows[0]);
  assert.equal((seenByB as { n: number }).n, 0, "practice B sees none of A's trail");

  // And the writer refuses to file a row into a practice other than the one in context.
  await withPractice(b, async () => {
    await assert.rejects(
      requireContext().tx.query("SELECT record_phi_access($1, gen_random_uuid(), gen_random_uuid(), 'owner', 'x', NULL, '/x', NULL)", [a]),
      /not the current practice/
    );
  });
});
