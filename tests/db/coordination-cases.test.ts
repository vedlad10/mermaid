/**
 * Coordination of benefits (migration 0034), against a real database, through the real HTTP API.
 *
 * ── WHAT ONLY POSTGRES CAN PROVE ───────────────────────────────────────────────────────────────
 * The engine, service and HTTP suites prove the decisions in memory. What exists only here:
 *
 *   1. `coordination_cases` CHECKs: a case cannot claim a coverage answer without the evidence that
 *      answer rests on, and its stored work status cannot disagree with its money. Written through
 *      the owner role, bypassing the application, to prove the TABLE refuses it and not the code.
 *   2. RLS: another practice cannot see a case.
 *   3. A status-19 advice with no answer is refused release, and no `remittance.posted` exists for
 *      it — the outbox is the only road to the ledger.
 *   4. The coverage answer lands in the append-only audit row, with its outcome, source and date.
 *   5. The backfill (`scripts/sync-coordination-cases.ts`) opens the case a pre-0034 advice never
 *      got, and a second run changes nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { createUser } from "@mermaid/auth";
import { withPractice } from "@mermaid/db";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

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

async function adminClient(): Promise<pg.Client> {
  if (admin) return admin;
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set — these assertions read tables as their owner.");
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  return admin;
}

async function owner(): Promise<{ practiceId: string; cookie: string; csrf: string }> {
  const practiceId = await makePractice("coordination");
  created.push(practiceId);
  const email = `cob-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () => createUser(practiceId, { email, name: "COB Owner", role: "owner", password }));
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

/** R1's shape: forwarded (CLP02 19), OA-23 coordination, and no NM1*TT naming the other plan. */
const forwarded = (trace: string, claim: string): string =>
  [
    "ISA*00*          *00*          *ZZ*Cigna Dental   *ZZ*CLINIC         *260920*0000*^*00501*000000001*0*P*:",
    "GS*HP*Cigna Dental*CLINIC*20260920*0000*1*X*005010X221A1",
    "ST*835*0001",
    "BPR*I*799.99*C*ACH************20260920",
    `TRN*1*${trace}*Cigna Dent`,
    "N1*PR*Cigna Dental",
    "N1*PE*MERMAID DEMO DENTAL",
    `CLP*${claim}*19*1425.00*799.99*0.00*CI*333273831`,
    "NM1*QC*1*Demo*Kira****MI*DEMO0123",
    "SVC*AD:D2750*1425.00*799.99**1",
    "CAS*CO*45*142.50",
    "CAS*OA*23*482.51",
    "SE*11*0001",
    "GE*1*1",
    "IEA*1*000000001",
  ].join("~") + "~";

async function heldForwarded(practiceId: string): Promise<{ claim: string; remittanceId: string }> {
  const claim = `MRM-COB${randomBytes(4).toString("hex").toUpperCase()}`;
  const services = buildServices();
  const remittanceId = await withPractice(practiceId, async () => {
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
    const view = await services.remittance.ingestRaw(forwarded(`EFT${randomBytes(4).toString("hex")}`, claim));
    assert.equal(view.remittance.status, "held");
    return view.remittance.id;
  });
  return { claim, remittanceId };
}

const postedEventsFor = async (practiceId: string, remittanceId: string): Promise<number> =>
  (await (await adminClient()).query(
    `SELECT count(*)::int AS n FROM domain_events
      WHERE practice_id = $1 AND event_type = 'remittance.posted' AND payload->>'remittanceId' = $2`,
    [practiceId, remittanceId]
  )).rows[0].n as number;

test("a forwarded advice opens a case, is refused release until coverage is answered, and the answer is audited", dbTest, async () => {
  const { practiceId, cookie, csrf } = await owner();
  const { claim, remittanceId } = await heldForwarded(practiceId);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
  const db = await adminClient();

  const stored = (await db.query(
    "SELECT id, coverage_status, work_status, assigned_cents FROM coordination_cases WHERE practice_id = $1 AND patient_control_number = $2",
    [practiceId, claim]
  )).rows;
  assert.equal(stored.length, 1, "one case per claim");
  const caseId = stored[0].id as string;
  assert.equal(stored[0].coverage_status, "unconfirmed", "coverage is never inferred");
  assert.equal(stored[0].work_status, "awaiting-coverage");
  assert.equal(Number(stored[0].assigned_cents), 48251);

  // A reason is not an answer.
  const refused = await post(`/api/v1/remittances/${remittanceId}/release`, { reason: "Looks fine" });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as any).error.code, "coverage-unconfirmed");
  assert.equal((await db.query("SELECT status FROM remittances WHERE id = $1", [remittanceId])).rows[0].status, "held");
  assert.equal(await postedEventsFor(practiceId, remittanceId), 0, "no money moved");

  // An answer without its source says what is missing and writes nothing.
  const incomplete = await post(`/api/v1/coordination-cases/${caseId}/confirm-coverage`, { outcome: "other-coverage", confirmedOn: "2026-09-24" });
  assert.equal(incomplete.status, 400);
  assert.ok(((await incomplete.json()) as any).error.missing.length > 0);
  assert.equal((await db.query("SELECT coverage_status FROM coordination_cases WHERE id = $1", [caseId])).rows[0].coverage_status, "unconfirmed");

  const confirmed = await post(`/api/v1/coordination-cases/${caseId}/confirm-coverage`, {
    outcome: "other-coverage",
    source: "payer-portal",
    confirmedOn: "2026-09-24",
    secondary: { payerName: "Delta Dental", memberId: "DD-778" },
  });
  assert.equal(confirmed.status, 200);

  const audit = (await db.query(
    `SELECT outcome, actor_role, after_json FROM audit_events
      WHERE resource = 'coordination-cases' AND resource_id = $1 AND action = 'confirm-coverage'`,
    [caseId]
  )).rows;
  assert.equal(audit.length, 2, "the refused attempt and the answer — both on the trail");
  const success = audit.find((a) => a.outcome === "success")!;
  assert.equal(success.actor_role, "owner");
  assert.equal(success.after_json.outcome, "other-coverage");
  assert.equal(success.after_json.source, "payer-portal");
  assert.equal(success.after_json.confirmedOn, "2026-09-24");
  assert.equal(success.after_json.secondaryPayer, "Delta Dental");

  const released = await post(`/api/v1/remittances/${remittanceId}/release`, { reason: "Other coverage confirmed on the portal" });
  assert.equal(released.status, 200);
  assert.ok((await postedEventsFor(practiceId, remittanceId)) >= 1, "released — the primary's payment moves");

  const after = (await db.query("SELECT work_status, assigned_cents FROM coordination_cases WHERE id = $1", [caseId])).rows[0];
  assert.equal(after.work_status, "ready-to-file");
  const paid = (await db.query("SELECT coalesce(sum(paid_cents), 0)::int AS n FROM postings WHERE remittance_id = $1", [remittanceId])).rows[0].n;
  assert.equal(paid, 79999, "only what this payer paid is collected — the $482.51 is tracked, not booked");

  // Another practice sees nothing.
  const stranger = await makePractice("coordination-stranger");
  created.push(stranger);
  assert.equal(await visibleCount(stranger, "coordination_cases"), 0);
  assert.equal(await visibleCount(practiceId, "coordination_cases"), 1);
});

test("the table refuses a coverage answer without evidence, and a work status that disagrees with the money", dbTest, async () => {
  const { practiceId } = await owner();
  const { claim } = await heldForwarded(practiceId);
  const db = await adminClient();
  const attempt = async (sql: string): Promise<string | null> => {
    await db.query("BEGIN");
    try {
      await db.query(sql, [practiceId, claim]);
      return null;
    } catch (err) {
      return (err as { constraint?: string }).constraint ?? String(err);
    } finally {
      await db.query("ROLLBACK");
    }
  };
  assert.equal(
    await attempt("UPDATE coordination_cases SET coverage_status = 'no-other-coverage' WHERE practice_id = $1 AND patient_control_number = $2"),
    "coordination_confirmed_has_evidence"
  );
  assert.equal(
    await attempt("UPDATE coordination_cases SET work_status = 'not-needed' WHERE practice_id = $1 AND patient_control_number = $2"),
    "coordination_work_matches_money"
  );
});

test("the backfill opens the case a pre-0034 advice never got — and a second run changes nothing", dbTest, async () => {
  const { practiceId } = await owner();
  const { claim } = await heldForwarded(practiceId);
  const db = await adminClient();
  // Simulate an advice that arrived before 0034: it has no case.
  await db.query("DELETE FROM coordination_cases WHERE practice_id = $1 AND patient_control_number = $2", [practiceId, claim]);

  const services = buildServices();
  const first = await withPractice(practiceId, () => services.remittance.syncCoordinationCases());
  assert.equal(first.opened, 1);
  const second = await withPractice(practiceId, () => services.remittance.syncCoordinationCases());
  assert.deepEqual({ opened: second.opened, updated: second.updated }, { opened: 0, updated: 0 }, "idempotent");
  const row = (await db.query(
    "SELECT coverage_status, work_status FROM coordination_cases WHERE practice_id = $1 AND patient_control_number = $2",
    [practiceId, claim]
  )).rows;
  assert.deepEqual(row, [{ coverage_status: "unconfirmed", work_status: "awaiting-coverage" }]);

  // The operator script is that same sync, walking every practice — and it rolls back on --dry-run.
  await db.query("DELETE FROM coordination_cases WHERE practice_id = $1 AND patient_control_number = $2", [practiceId, claim]);
  const run = promisify(execFile);
  const dry = await run(process.execPath, ["scripts/sync-coordination-cases.ts", "--dry-run"], { env: process.env });
  assert.match(dry.stdout, /rolled back/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM coordination_cases WHERE practice_id = $1", [practiceId])).rows[0].n, 0);
  const real = await run(process.execPath, ["scripts/sync-coordination-cases.ts"], { env: process.env });
  assert.match(real.stdout, /practice\(s\):/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM coordination_cases WHERE practice_id = $1", [practiceId])).rows[0].n, 1);
  const audits = (await db.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE practice_id = $1 AND resource = 'coordination_cases' AND action = 'sync'",
    [practiceId]
  )).rows[0].n;
  assert.equal(audits, 1, "the real run leaves one audit row per practice; the dry run leaves none");
});
