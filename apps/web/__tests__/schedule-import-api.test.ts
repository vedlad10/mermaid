/**
 * Schedule import over HTTP, in memory: preview then import, a person's column mapping honoured,
 * and malformed requests refused before anything is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp } from "../server.ts";
import { buildServices } from "../wiring.ts";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(buildServices({ inMemory: true, bus: new InMemoryOutbox() }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A column named "Visit" that no alias recognises, so the person has to map it.
const CSV = 'Visit,Date,Time,Patient,DOB\nV1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990\n';

test("preview says what is missing; a person's mapping fixes it; the import then brings the visit in", async () => {
  await withServer(async (base) => {
    const bare = (await (await post(base, "/api/v1/appointments/import/preview", { csv: CSV })).json()) as any;
    assert.ok(bare.fileProblems.some((p: string) => /Appointment ID/.test(p)));
    assert.equal(bare.mapping.externalId, null);
    assert.ok(bare.fields.length > 0, "the preview lists the fields a person can map");

    const mapped = (await (await post(base, "/api/v1/appointments/import/preview", { csv: CSV, mapping: { externalId: "Visit" } })).json()) as any;
    assert.deepEqual(mapped.fileProblems, []);
    assert.equal(mapped.ready, 1);

    const imported = (await (await post(base, "/api/v1/appointments/import", { csv: CSV, mapping: { externalId: "Visit" } })).json()) as any;
    assert.equal(imported.created, 1);

    const list = (await (await fetch(`${base}/api/v1/appointments?from=2026-09-30T00:00:00Z&to=2026-10-03T00:00:00Z`)).json()) as any;
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].externalId, "V1");
    assert.equal(list.items[0].source, "csv");
  });
});

test("malformed requests are refused before any row is read", async () => {
  await withServer(async (base) => {
    for (const body of [{}, { csv: "" }, { csv: 5 }, { csv: CSV, mapping: [] }, { csv: CSV, mapping: { nope: "x" } }, { csv: CSV, mapping: { date: 4 } }]) {
      const res = await post(base, "/api/v1/appointments/import", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const unclosed = await post(base, "/api/v1/appointments/import/preview", { csv: 'a,b\n1,"unclosed\n' });
    assert.equal(unclosed.status, 400);
    assert.equal(((await unclosed.json()) as any).error.code, "invalid-csv");
  });
});
