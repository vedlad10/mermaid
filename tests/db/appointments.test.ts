/**
 * The schedule (migration 0035), against a real database and through the real HTTP API.
 *
 *   1. The Postgres store keeps the service's promises: re-importing changes nothing, a moved visit
 *      updates in place, and a window read is ordered and half-open.
 *   2. Tenancy: one practice's appointment id is its own — another practice may use the same one,
 *      and neither can see the other's visit.
 *   3. `GET /api/v1/appointments` answers with readiness, and refuses a malformed window with a 400
 *      rather than a 500.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createUser } from "@mermaid/auth";
import { withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import { zonedInstant } from "@mermaid/shared";
import type { ScheduledVisit } from "@mermaid/verification";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const created: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";
// Built on first use, not at import: without a database every test here is skipped, and
// constructing Postgres-backed services for no test would be the only thing this file did.
let built: ReturnType<typeof buildServices> | null = null;
const svc = () => (built ??= buildServices());

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

const NOW = new Date("2026-09-28T12:00:00.000Z");
const FROM = new Date("2026-09-28T00:00:00.000Z");
const TO = new Date("2026-10-12T00:00:00.000Z");

const visit = (over: Partial<ScheduledVisit> = {}): ScheduledVisit => ({
  externalId: "APT-1",
  scheduledFor: "2026-10-01T09:30:00-05:00",
  durationMinutes: 60,
  provider: "Dr. Reyes",
  status: "scheduled",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
  plannedProcedures: [{ code: "D1110", feeCents: 12_000 }],
  ...over,
});

test("the Postgres store: created, unchanged on re-import, updated in place, read in order", dbTest, async () => {
  const p = await practice("appointments-store");
  await withPractice(p, async () => {
    const first = await svc().appointments.sync("csv", [visit(), visit({ externalId: "APT-0", scheduledFor: "2026-09-30T08:00:00Z" })], NOW);
    assert.deepEqual(first, { created: 2, updated: 0, unchanged: 0, rejected: [] });

    const again = await svc().appointments.sync("csv", [visit()], NOW);
    assert.deepEqual(again, { created: 0, updated: 0, unchanged: 1, rejected: [] });

    const moved = await svc().appointments.sync("csv", [visit({ scheduledFor: "2026-10-02T09:30:00-05:00" })], NOW);
    assert.equal(moved.updated, 1);

    const items = await svc().appointments.list(FROM, TO);
    assert.deepEqual(
      items.map((i) => [i.externalId, i.scheduledFor]),
      [
        ["APT-0", "2026-09-30T08:00:00.000Z"],
        ["APT-1", "2026-10-02T14:30:00.000Z"],
      ]
    );
    assert.equal(items[1]!.plannedProductionCents, 12_000);
    assert.equal(items[1]!.readiness!.state, "no-coverage");
  });
  assert.equal(await visibleCount(p, "appointments"), 2);
});

test("an appointment id belongs to its practice: the same id twice, and neither sees the other", dbTest, async () => {
  const a = await practice("appointments-a");
  const b = await practice("appointments-b");
  await withPractice(a, () => svc().appointments.sync("csv", [visit()], NOW));
  const inB = await withPractice(b, () => svc().appointments.sync("csv", [visit({ provider: "Dr. B" })], NOW));
  assert.equal(inB.created, 1, "practice B's APT-1 is a new visit, not practice A's");

  const seenByA = await withPractice(a, () => svc().appointments.list(FROM, TO));
  const seenByB = await withPractice(b, () => svc().appointments.list(FROM, TO));
  assert.deepEqual(seenByA.map((i) => i.provider), ["Dr. Reyes"]);
  assert.deepEqual(seenByB.map((i) => i.provider), ["Dr. B"]);
  assert.notEqual(seenByA[0]!.id, seenByB[0]!.id);
});

test("GET /api/v1/appointments answers with readiness, and a malformed window is a 400", dbTest, async () => {
  const p = await practice("appointments-http");
  await withPractice(p, () => svc().appointments.sync("csv", [visit()], NOW));

  const email = `appt-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(p, () => createUser(p, { email, name: "Front Desk", role: "front_desk", password }));
  server = createApp(svc());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;

  const ok = await fetch(`${base}/api/v1/appointments?from=${FROM.toISOString()}&to=${TO.toISOString()}`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { items: { externalId: string; readiness: { group: string } }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.externalId, "APT-1");
  assert.equal(body.items[0]!.readiness.group, "no-coverage");

  const backwards = await fetch(`${base}/api/v1/appointments?from=${TO.toISOString()}&to=${FROM.toISOString()}`, { headers: { cookie } });
  assert.equal(backwards.status, 400);
  const garbage = await fetch(`${base}/api/v1/appointments?from=not-a-date`, { headers: { cookie } });
  assert.equal(garbage.status, 400);
});

/** Log a user in against the shared test server; returns the cookie and CSRF twin a POST needs. */
async function loginAs(practiceId: string, role: "owner" | "front_desk" | "dentist"): Promise<{ cookie: string; csrf: string }> {
  if (!server) {
    server = createApp(svc());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const email = `due-${role}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () => createUser(practiceId, { email, name: `Due ${role}`, role, password }));
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie, csrf };
}

test("Verify all due: a front desk may look but not send, and one practice cannot run another's visits", dbTest, async () => {
  const a = await practice("due-a");
  const b = await practice("due-b");
  const now = Date.now();
  // Ada in practice A, checked forty days ago against the mock connector, booked for tomorrow.
  await withPractice(a, async () => {
    await svc().via(new MockEdiAdapter()).verification.create(
      {
        patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
        cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
        planItems: [{ code: "D0120", quantity: 1 }],
      },
      new Date(now - 40 * 86_400_000)
    );
    await svc().appointments.sync("csv", [visit({ externalId: "DUE-1", scheduledFor: new Date(now + 86_400_000).toISOString() })]);
  });

  const desk = await loginAs(a, "front_desk");
  const preview = await fetch(`${base}/api/v1/appointments/due`, { headers: { cookie: desk.cookie } });
  assert.equal(preview.status, 200, "seeing what is due is a read");
  const due = (await preview.json()) as { checks: number; visits: { appointmentId: string; will: string }[] };
  assert.equal(due.checks, 1);
  const id = due.visits[0]!.appointmentId;

  const post = (who: { cookie: string; csrf: string }) =>
    fetch(`${base}/api/v1/appointments/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: who.cookie, "x-csrf-token": who.csrf },
      body: JSON.stringify({ appointmentIds: [id] }),
    });

  assert.equal((await post(desk)).status, 403, "sending checks takes verifications.write, which a front desk does not hold");

  // Practice B's owner names practice A's visit: RLS makes it invisible, so nothing is sent.
  const other = await post(await loginAs(b, "owner"));
  assert.equal(other.status, 200);
  const otherRun = (await other.json()) as { checked: number; results: { outcome: string; patientName: string }[] };
  assert.equal(otherRun.checked, 0);
  assert.equal(otherRun.results[0]!.outcome, "not-run");
  assert.equal(otherRun.results[0]!.patientName, "", "nothing about practice A's patient is revealed");

  const own = await post(await loginAs(a, "owner"));
  assert.equal(own.status, 200);
  const ownRun = (await own.json()) as { checked: number; results: { outcome: string; readiness: { state: string } }[] };
  assert.equal(ownRun.checked, 1);
  assert.equal(ownRun.results[0]!.outcome, "checked");
  assert.equal(ownRun.results[0]!.readiness.state, "verified");
});

test("Schedule import: a dentist cannot import; the front desk can, and a re-import changes nothing", dbTest, async () => {
  const p = await practice("import");
  const csv =
    "Appt ID,Date,Time,Patient,DOB,Sched Prod\n" +
    'IMP-1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990,$185.00\n';
  const send = (who: { cookie: string; csrf: string }) =>
    fetch(`${base}/api/v1/appointments/import`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: who.cookie, "x-csrf-token": who.csrf },
      body: JSON.stringify({ csv }),
    });

  assert.equal((await send(await loginAs(p, "dentist"))).status, 403, "importing creates patients; a dentist may not");
  assert.equal(await visibleCount(p, "appointments"), 0, "a refused import writes nothing");

  const desk = await loginAs(p, "front_desk");
  const first = await send(desk);
  assert.equal(first.status, 200);
  const created = (await first.json()) as { created: number; unchanged: number; rejected: unknown[] };
  assert.equal(created.created, 1);
  assert.deepEqual(created.rejected, []);

  const again = (await (await send(desk)).json()) as { created: number; updated: number; unchanged: number };
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 1, "the same export twice changes nothing");
  assert.equal(await visibleCount(p, "appointments"), 1);

  const [row] = await withPractice(p, () => svc().appointments.list(FROM, TO));
  assert.equal(
    row!.scheduledFor,
    zonedInstant("2026-10-01", "09:30", svc().timeZone ?? "UTC"),
    "9:30 AM is read on the practice's own clock, whatever zone this environment configures"
  );
  assert.equal(row!.plannedProductionCents, 18_500, "the export's stated total survives a real database round trip");
});
