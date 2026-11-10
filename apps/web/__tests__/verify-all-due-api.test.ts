/**
 * "Verify all due" over HTTP, in memory: the preview, the single click, and the two refusals the
 * route owns — a malformed request, and a second run while one is still going.
 *
 * The patient is checked against the mock connector (no EDI adapter is configured under `npm test`),
 * through the same `VerificationService.create` a person's manual check uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp } from "../server.ts";
import { buildServices, type Services } from "../wiring.ts";

const DAY = 86_400_000;

async function withServer(services: Services, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(services);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/v1/appointments/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Ada, verified forty days ago — so her visit tomorrow is booked against a check that has expired. */
async function staleAda(services: Services): Promise<string> {
  const now = Date.now();
  await services.verification.create(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new Date(now - 40 * DAY)
  );
  await services.appointments.sync("csv", [{
    externalId: "APT-ADA",
    scheduledFor: new Date(now + DAY).toISOString(),
    status: "scheduled",
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
    plannedProcedures: [{ code: "D1110", feeCents: 12_000 }],
  }]);
  const due = await services.appointments.due();
  assert.equal(due.visits.length, 1);
  return due.visits[0]!.appointmentId;
}

test("the preview names what will be checked; one click checks it; a second click checks nothing", async () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const id = await staleAda(services);
  await withServer(services, async (base) => {
    const preview = (await (await fetch(`${base}/api/v1/appointments/due`)).json()) as any;
    assert.equal(preview.checks, 1);
    assert.equal(preview.visits[0].will, "check");
    assert.match(preview.visits[0].reason, /out of date by the visit/);

    const res = await post(base, { appointmentIds: [id] });
    assert.equal(res.status, 200);
    const run = (await res.json()) as any;
    assert.equal(run.checked, 1);
    assert.equal(run.results[0].outcome, "checked");
    assert.equal(run.results[0].readiness.state, "verified");
    assert.ok(run.results[0].verificationId, "the new verification is named so a screen can open it");

    const after = (await (await fetch(`${base}/api/v1/appointments/due`)).json()) as any;
    assert.equal(after.visits.length, 0, "the visit is ready now, so nothing is due");

    const again = (await (await post(base, { appointmentIds: [id] })).json()) as any;
    assert.equal(again.checked, 0, "a repeated click sends nothing");
    assert.equal(again.results[0].outcome, "not-run");
  });
});

test("a malformed request is refused before anything is sent", async () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  await withServer(services, async (base) => {
    for (const body of [{}, { appointmentIds: [] }, { appointmentIds: "x" }, { appointmentIds: [1, 2] }]) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});

test("a second run while the first is still going is refused with 409, and the first still finishes", async () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  // Stand in for a slow clearinghouse: the first run parks until the test lets it go.
  services.appointments.runDue = async () => {
    started();
    await gate;
    return { checked: 0, results: [] };
  };
  await withServer(services, async (base) => {
    const first = post(base, { appointmentIds: ["a1"] });
    await running;
    const second = await post(base, { appointmentIds: ["a1"] });
    assert.equal(second.status, 409);
    const body = (await second.json()) as any;
    assert.equal(body.error.code, "run-in-progress");

    release();
    assert.equal((await first).status, 200);
    // And the guard is released: the next click is accepted.
    assert.equal((await post(base, { appointmentIds: ["a1"] })).status, 200);
  });
});
