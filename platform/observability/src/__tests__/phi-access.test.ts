/**
 * The read-trail writer and reader (0037), against a recording fake transaction. The live-database
 * behaviour — RLS, append-only, the practice check in the writer — is pinned in
 * tests/db/phi-access-log.test.ts; this pins what goes on the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { listPhiAccess, recordPhiAccess, type Queryable } from "../audit.ts";

function recorder(rows: unknown[] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  const tx: Queryable = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, calls };
}

test("a read is written through the SECURITY DEFINER writer, never by a direct INSERT", async () => {
  const { tx, calls } = recorder();
  await recordPhiAccess(tx, {
    practiceId: "p-1",
    traceId: "t-1",
    actorId: "u-1",
    actorRole: "front_desk",
    resource: "patients",
    resourceId: "directory",
    route: "/api/v1/patients/directory",
    ip: "203.0.113.9",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /^SELECT record_phi_access\(/);
  assert.doesNotMatch(calls[0]!.text, /INSERT/i);
  assert.deepEqual(calls[0]!.params, ["p-1", "t-1", "u-1", "front_desk", "patients", "directory", "/api/v1/patients/directory", "203.0.113.9"]);
});

test("the reader is bounded, whatever limit a caller asks for", async () => {
  for (const [asked, sent] of [[undefined, 200], [0, 1], [-5, 1], [50, 50], [5000, 1000], [12.7, 12]] as const) {
    const { tx, calls } = recorder();
    await listPhiAccess(tx, asked === undefined ? {} : { limit: asked });
    assert.equal(calls[0]!.params[2], sent, `limit ${asked}`);
  }
});

test("rows come back in the API's shape, nulls kept as nulls", async () => {
  const { tx } = recorder([
    { created_at: new Date("2026-10-15T10:00:00Z"), actor_id: "u-1", actor_role: "biller", resource: "claims", resource_id: null, route: "/api/v1/claims", ip: null },
  ]);
  assert.deepEqual(await listPhiAccess(tx), [
    { at: "2026-10-15T10:00:00.000Z", actorId: "u-1", actorRole: "biller", resource: "claims", resourceId: null, route: "/api/v1/claims", ip: null },
  ]);
});
