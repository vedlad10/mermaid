/**
 * Rejecting a held advice, over the real HTTP API — and the refusals a person meets on the way.
 *
 * The service tests prove what reject and release DO. These prove what a biller SEES: that a refused
 * release arrives as a 409 naming the action that works (not the 502 "clearinghouse_error" these
 * refusals used to fall through to, which sent an operator to check a clearinghouse that was never
 * involved), that a rejection states what the advice was, and that the rejected advice stops
 * counting as held money on the list a Money screen is drawn from.
 *
 * In-memory composition root, like `server.test.ts`: this is about the API contract. Persistence,
 * the widened CHECK constraint and the append-only audit row are proven against Postgres in
 * `tests/db/remittance-reject.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp } from "../server.ts";
import { buildServices, testInterchangePolicy } from "../wiring.ts";

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

/** The staging Cigna advice, with the trace and date that distinguished its copies. */
const cigna = (trace: string, date: string): string => {
  const d8 = date.replaceAll("-", "");
  return (
    [
      `ISA*00*          *00*          *ZZ*Cigna Dental   *ZZ*CLINIC         *${d8.slice(2)}*0000*^*00501*000000001*0*P*:`,
      `GS*HP*Cigna Dental*CLINIC*${d8}*0000*1*X*005010X221A1`,
      "ST*835*0001",
      `BPR*I*799.99*C*ACH************${d8}`,
      `TRN*1*${trace}*Cigna Dent`,
      "N1*PR*Cigna Dental",
      "N1*PE*MERMAID DEMO DENTAL",
      "CLP*MRM-HTTPDUP0001*1*1425.00*799.99*0.00*CI*333273831",
      "NM1*QC*1*Demo*Kira****MI*DEMO0123",
      "SVC*AD:D2750*1425.00*799.99**1",
      "CAS*CO*45*625.01",
      "SE*10*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~"
  );
};

async function upload(base: string, raw: string): Promise<any> {
  const res = await fetch(`${base}/api/v1/remittances`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: raw,
  });
  assert.ok(res.status < 300, `upload failed: ${res.status} ${await res.clone().text()}`);
  return res.json();
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test("a duplicate's release is refused with a 409 that names reject — never a clearinghouse error", async () => {
  await withServer(async (base) => {
    await upload(base, cigna("EFT227219236", "2026-08-28"));
    const copy = await upload(base, cigna("EFT860280126", "2026-08-31"));
    assert.equal(copy.remittance.status, "held");

    const release = await post(base, `/api/v1/remittances/${copy.remittance.id}/release`, {
      releasedBy: "biller@clinic",
      reason: "Review and release",
    });
    assert.equal(release.status, 409);
    assert.equal(release.json.error?.code, "duplicate-adjudication");
    assert.match(release.json.error?.message ?? "", /reject it instead/);
  });
});

test("a rejection must say what the advice was, and why", async () => {
  await withServer(async (base) => {
    await upload(base, cigna("EFT227219236", "2026-08-28"));
    const copy = await upload(base, cigna("EFT860280126", "2026-08-31"));
    const path = `/api/v1/remittances/${copy.remittance.id}/reject`;

    const noKind = await post(base, path, { rejectedBy: "biller@clinic", reason: "Duplicate" });
    assert.equal(noKind.status, 400, "a default kind would record a decision nobody made");
    const badKind = await post(base, path, { kind: "spam", rejectedBy: "biller@clinic", reason: "Duplicate" });
    assert.equal(badKind.status, 400);
    const noReason = await post(base, path, { kind: "duplicate", rejectedBy: "biller@clinic" });
    assert.equal(noReason.status, 400);
  });
});

test("a rejected duplicate leaves the held pile and carries no money on the list", async () => {
  await withServer(async (base) => {
    await upload(base, cigna("EFT227219236", "2026-08-28"));
    const copy = await upload(base, cigna("EFT860280126", "2026-08-31"));

    const before = (await (await fetch(`${base}/api/v1/remittances`)).json()) as any;
    assert.equal(before.held, 1);

    const rejected = await post(base, `/api/v1/remittances/${copy.remittance.id}/reject`, {
      kind: "duplicate",
      rejectedBy: "biller@clinic",
      reason: "Same adjudication as EFT227219236; one deposit",
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.remittance.status, "rejected");
    assert.equal(rejected.json.remittance.rejection.duplicateOfTrace, "EFT227219236");
    assert.equal(rejected.json.canPost, false);

    const after = (await (await fetch(`${base}/api/v1/remittances`)).json()) as any;
    assert.equal(after.held, 0);
    assert.equal(after.heldTotal, 0);
    const row = after.items.find((i: any) => i.id === copy.remittance.id);
    assert.equal(row.status, "rejected", "still on the list — the evidence is kept");
    assert.equal(row.totalRecoverable, 0);
    assert.equal(row.totalWithOtherPayers, 0);

    const again = await post(base, `/api/v1/remittances/${copy.remittance.id}/release`, {
      releasedBy: "biller@clinic",
      reason: "Changed my mind",
    });
    assert.equal(again.status, 409);
    assert.equal(again.json.error?.code, "rejected");
  });
});

test("test files are refused exactly where the deployment can reach real payers", () => {
  assert.equal(testInterchangePolicy({ filesToRealPayers: true }), "refuse");
  assert.equal(testInterchangePolicy({ filesToRealPayers: false }), "accept");
});

test("over HTTP: a held duplicate offers reject, not release, and a refusal says only what is true", async () => {
  await withServer(async (base) => {
    await upload(base, cigna("EFT227219236", "2026-08-28"));
    const copy = await upload(base, cigna("EFT860280126", "2026-08-31"));

    const detail = (await (await fetch(`${base}/api/v1/remittances/${copy.remittance.id}`)).json()) as any;
    assert.equal(detail.canPost, false);
    assert.equal(detail.releaseBlocked.rejectAs, "duplicate");
    assert.match(detail.recommendedAction, /^Do not release/);

    const list = (await (await fetch(`${base}/api/v1/remittances`)).json()) as any;
    assert.equal(list.items.find((i: any) => i.id === copy.remittance.id).releaseBlocked.code, "duplicate-adjudication");

    const release = await post(base, `/api/v1/remittances/${copy.remittance.id}/release`, {
      releasedBy: "biller@clinic",
      reason: "Review and release",
    });
    assert.equal(release.status, 409, "the same status as before — only the words changed");
    assert.doesNotMatch(release.json.error.message, /retrieval failed/);
    assert.match(release.json.error.message, /^The payer's claim control number 333273831/);
  });
});
