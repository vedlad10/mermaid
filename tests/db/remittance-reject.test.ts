/**
 * Rejecting a held remittance, against a real database, through the real HTTP API.
 *
 * ── WHAT ONLY POSTGRES CAN PROVE ───────────────────────────────────────────────────────────────
 * The service and API suites prove the decision logic in memory. Four things exist only here:
 *
 *   1. `remittances.status` is CHECK-constrained. 'rejected' is a new value, and without migration
 *      0033 the rejection would fail at UPDATE — so this is the test that the migration is applied
 *      and correct, not merely written.
 *   2. The audit row is append-only at the GRANT layer (the app role has no DML on audit_events) and
 *      is written in the request's own transaction. The reason a person gave has to be IN that row,
 *      read back as the table's owner, or "immutable audit event" is a claim about a mutable JSONB.
 *   3. Money moves only through `remittance.posted` in the durable outbox. Its absence for the
 *      rejected advice is asserted on `domain_events` itself.
 *   4. READINESS — the endpoint a deploy gates on — reads the held pile per practice. It must stay
 *      red through a refused release and turn green only when the item is correctly disposed of.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
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
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

/** The table owner, so audit_events and domain_events are read AS STORED, not through RLS. */
async function adminClient(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set — these assertions read tables as their owner.");
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  return admin;
}

/** A signed-in owner of a fresh practice: cookie + CSRF, the way a browser holds them. */
async function owner(): Promise<{ practiceId: string; cookie: string; csrf: string }> {
  const practiceId = await makePractice("reject-remit");
  created.push(practiceId);
  const email = `reject-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () => createUser(practiceId, { email, name: "Reject Owner", role: "owner", password }));
  const res = await fetch(`${await app()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  return { practiceId, cookie, csrf };
}

const cigna = (trace: string, date: string, claim: string): string => {
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
      `CLP*${claim}*1*1425.00*799.99*0.00*CI*333273831`,
      "NM1*QC*1*Demo*Kira****MI*DEMO0123",
      "SVC*AD:D2750*1425.00*799.99**1",
      "CAS*CO*45*625.01",
      "SE*10*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~"
  );
};

async function heldCheck(cookie: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${await app()}/api/v1/ops/readiness`, { headers: { cookie } });
  const body = (await res.json()) as { checks: { name: string; ok: boolean; detail: string }[] };
  const check = body.checks.find((c) => c.name === "money.held_remittance_age");
  assert.ok(check, "readiness must report the held-remittance check");
  return check;
}

test("a duplicate held past the review window keeps readiness red until it is REJECTED", dbTest, async () => {
  const { practiceId, cookie, csrf } = await owner();
  const claim = `MRM-REJ${randomBytes(4).toString("hex").toUpperCase()}`;
  // Received five days ago: past the three-day review window, so the held pile is overdue.
  const received = new Date(Date.now() - 5 * 86_400_000);

  const services = buildServices();
  const { originalId, copyId } = await withPractice(practiceId, async () => {
    /**
     * File the claim first. `remittance.posted` — the event that moves money into the claim and the
     * ledger — is published only for a posting matched to a claim the practice filed, so without
     * this the positive control below would find nothing and the negative one would prove nothing.
     */
    await services.remittance.recordExpectation({
      claimId: crypto.randomUUID(),
      verificationId: crypto.randomUUID(),
      submittedAt: "2026-08-20T10:00:00.000Z",
      submittedBy: "biller@clinic",
      patient: { firstName: "Kira", lastName: "Demo", dateOfBirth: "1990-04-12", memberId: "DEMO0123" },
      payerId: "cigna-dental",
      payerName: "Cigna Dental",
      patientControlNumber: claim,
      payerControlNumber: "556677889",
      totalFee: 142500,
      expectedInsurancePays: 79999,
      serviceDate: "2026-08-19",
    } as Parameters<typeof services.remittance.recordExpectation>[0]);
    const original = await services.remittance.ingestRaw(cigna(`EFT${randomBytes(4).toString("hex")}`, "2026-08-28", claim), received);
    assert.equal(original.remittance.status, "posted");
    const copy = await services.remittance.ingestRaw(cigna(`EFT${randomBytes(4).toString("hex")}`, "2026-08-31", claim), received);
    assert.equal(copy.remittance.status, "held");
    return { originalId: original.remittance.id, copyId: copy.remittance.id };
  });

  assert.equal((await heldCheck(cookie)).ok, false, "an overdue held advice keeps the deployment not-ready");

  // A refused release is not a disposal: nothing moves and readiness stays exactly as it was.
  const release = await fetch(`${await app()}/api/v1/remittances/${copyId}/release`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify({ reason: "Clear the board" }),
  });
  assert.equal(release.status, 409);
  assert.equal(((await release.json()) as any).error.code, "duplicate-adjudication");
  assert.equal((await heldCheck(cookie)).ok, false);

  const reject = await fetch(`${await app()}/api/v1/remittances/${copyId}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify({ kind: "duplicate", reason: "Same adjudication, one deposit" }),
  });
  assert.equal(reject.status, 200);
  assert.equal((await heldCheck(cookie)).ok, true, "correctly disposed of — and only then — readiness clears");

  const db = await adminClient();

  // 1. The widened CHECK accepted the new state, and the evidence is still there.
  const row = (await db.query(
    "SELECT status, trace_number, raw_835 IS NOT NULL AS has_file FROM remittances WHERE id = $1",
    [copyId]
  )).rows[0];
  assert.equal(row.status, "rejected");
  assert.equal(row.has_file, true, "the payer's own file is kept");
  const postings = (await db.query("SELECT count(*)::int AS n FROM postings WHERE remittance_id = $1", [copyId])).rows[0];
  assert.equal(postings.n, 1, "and its postings projection, as evidence — never as money");

  // 2. One append-only audit row for the decision, carrying WHAT and WHY, in the request's transaction.
  const audits = (await db.query(
    `SELECT action, outcome, actor_role, after_json FROM audit_events
      WHERE resource = 'remittances' AND resource_id = $1 AND action = 'reject'`,
    [copyId]
  )).rows;
  assert.equal(audits.length, 1, "one decision, one row");
  assert.equal(audits[0].outcome, "success");
  assert.equal(audits[0].actor_role, "owner");
  assert.equal(audits[0].after_json.kind, "duplicate");
  assert.equal(audits[0].after_json.reason, "Same adjudication, one deposit");
  assert.equal(audits[0].after_json.paymentTotalCents, 79999);
  assert.match(String(audits[0].after_json.duplicateOfTrace), /^EFT/);

  // 3. No money event was ever written for it — the outbox is the only road to the ledger. The
  //    original is the positive control: the same query must FIND its event, or a zero below would
  //    prove nothing about the copy.
  const postedEventsFor = async (remittanceId: string) =>
    (await db.query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE practice_id = $1 AND event_type = 'remittance.posted' AND payload->>'remittanceId' = $2`,
      [practiceId, remittanceId]
    )).rows[0].n as number;
  assert.ok((await postedEventsFor(originalId)) >= 1, "the query sees money events where they exist");
  assert.equal(await postedEventsFor(copyId), 0, "and there is none for the rejected copy");
});

test("the refused release itself is audited as an error, and changes nothing", dbTest, async () => {
  const { practiceId, cookie, csrf } = await owner();
  const claim = `MRM-REJ${randomBytes(4).toString("hex").toUpperCase()}`;
  const services = buildServices();
  const copyId = await withPractice(practiceId, async () => {
    await services.remittance.ingestRaw(cigna(`EFT${randomBytes(4).toString("hex")}`, "2026-08-28", claim));
    return (await services.remittance.ingestRaw(cigna(`EFT${randomBytes(4).toString("hex")}`, "2026-08-31", claim))).remittance.id;
  });

  const res = await fetch(`${await app()}/api/v1/remittances/${copyId}/release`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify({ reason: "Review and release" }),
  });
  assert.equal(res.status, 409);

  const db = await adminClient();
  const status = (await db.query("SELECT status FROM remittances WHERE id = $1", [copyId])).rows[0].status;
  assert.equal(status, "held");
  const attempts = (await db.query(
    "SELECT outcome FROM audit_events WHERE resource = 'remittances' AND resource_id = $1 AND action = 'release'",
    [copyId]
  )).rows;
  assert.deepEqual(attempts.map((a) => a.outcome), ["error"], "someone TRIED to post a duplicate, and the trail says so");
});
