/**
 * Every money-moving write, reconciled against the database rather than against its own answer.
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────────────────────────────
 * The suite already proves each half separately. `vertical-patient-money.test.ts` drives the real
 * HTTP contract end to end, but on in-memory services. `ledger.test.ts` runs against real Postgres,
 * but calls `PatientLedgerService` directly. Neither asks the question a practice actually cares
 * about: when a person presses a button and the screen says the money moved, did it move IN THE
 * DATABASE, by exactly that amount, once?
 *
 * That is a real class of defect and not a hypothetical one — a route can return 200 with a
 * plausible body while writing nothing, writing twice, or writing a different figure, and every
 * assertion made against the response would pass. So each test here reads `ledger_entries` and the
 * patient balance straight out of Postgres before the call and again after, and asserts the DELTA.
 * The response is checked too, but it is never the evidence.
 *
 * ── WHY IT USES ITS OWN CONNECTION FOR THE READS ─────────────────────────────────────────────────
 * Through `withPractice`, so the reads are RLS-scoped exactly as the application's are. A read that
 * bypassed tenancy could report a row the app itself would never see, which would turn a tenancy
 * bug into a passing test.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createUser } from "@mermaid/auth";
import { requireContext, withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { NullEventPublisher } from "@mermaid/events";
import type { RemittancePostedBody } from "@mermaid/events";
import { PatientLedgerService, PgLedgerRepository } from "@mermaid/patient-ledger";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const created: string[] = [];

let server: Server | null = null;
let base = "";

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
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
  return { practiceId, call };
}

/**
 * What the ledger actually holds for a patient, read from Postgres.
 *
 * Keyed on `patient_key` — the member id — because that is what the HTTP route resolves a patient
 * by. Reconciling against a different key than the API uses would leave the one mismatch most worth
 * catching invisible.
 *
 * The balance is a plain SUM because the SIGN IS ENFORCED BY THE DATABASE: migration constraints
 * require `amount_cents > 0` for a charge and `< 0` for everything else. Re-deriving the sign here
 * with a CASE would double-negate every payment, and worse, it would hide a row that had been stored
 * with the wrong sign — the exact corruption that CHECK constraint exists to make impossible.
 */
async function ledgerState(practiceId: string, patientKey: string) {
  return withPractice(practiceId, async () => {
    const { rows } = await requireContext().tx.query(
      `SELECT count(*) AS n, coalesce(sum(amount_cents), 0) AS total
         FROM ledger_entries WHERE patient_key = $1`,
      [patientKey]
    );
    const row = rows[0] as { n: string; total: string } | undefined;
    return { entries: Number(row?.n ?? 0), balance: Number(row?.total ?? 0) };
  });
}

const ledger = () => new PatientLedgerService(new PgLedgerRepository(), new NullEventPublisher());

/** A posted remittance, the event that gives a patient something to owe. */
const posted = (memberId: string, patientResponsibility: number): RemittancePostedBody =>
  ({
    remittanceId: crypto.randomUUID(),
    postingId: crypto.randomUUID(),
    claimId: crypto.randomUUID(),
    patientControlNumber: `MRM-${randomBytes(4).toString("hex").toUpperCase()}`,
    postedAt: NOW.toISOString(),
    traceNumber: `EFT${randomBytes(4).toString("hex").toUpperCase()}`,
    payerId: "delta-dental",
    payerName: "Delta Dental",
    patientName: "Ada Alpha",
    memberId,
    paymentDate: "2026-09-01",
    chargedAmount: cents(1425),
    paidAmount: cents(800),
    patientResponsibility: cents(patientResponsibility),
    contractualAdjustments: cents(425),
    expectedInsurancePays: cents(800),
    variance: cents(0),
    outcome: "as_expected",
    settled: true,
  }) as unknown as RemittancePostedBody;

/**
 * A patient carrying a real balance, created the way the product creates one — through the posting
 * that made them owe it, not by inserting a row.
 *
 * The member id is unique per test because these run against a SHARED database: a fixed key would
 * pick up whatever an earlier run left behind, and every delta below would be measured against
 * somebody else's history.
 */
async function patientOwing(practiceId: string, amount: number): Promise<string> {
  const memberId = `MW${randomBytes(5).toString("hex").toUpperCase()}`;
  await withPractice(practiceId, () => ledger().chargeFromPosting(posted(memberId, amount), NOW));
  const state = await ledgerState(practiceId, memberId);
  assert.equal(state.balance, cents(amount), "the fixture must actually owe money, or nothing below is a test");
  return memberId;
}

test("a patient payment moves the balance in the database by exactly what was sent", dbTest, async () => {
  const t = await tenant("money-write-payment");
  const patientKey = await patientOwing(t.practiceId, 400);

  const before = await ledgerState(t.practiceId, patientKey);
  const res = await t.call("POST", `/api/v1/patients/${patientKey}/payment`, {
    amountDollars: 150,
    note: "card on file",
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const after = await ledgerState(t.practiceId, patientKey);
  assert.equal(after.entries, before.entries + 1, "exactly one row — a payment is one event");
  assert.equal(
    after.balance,
    before.balance - cents(150),
    "the balance in Postgres must move by the amount sent, not by whatever the response says"
  );
});

test("a write-off moves the balance too, and is a different KIND of row", dbTest, async () => {
  const t = await tenant("money-write-writeoff");
  const patientKey = await patientOwing(t.practiceId, 400);

  const before = await ledgerState(t.practiceId, patientKey);
  const res = await t.call("POST", `/api/v1/patients/${patientKey}/writeoff`, {
    amountDollars: 100,
    note: "goodwill",
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const after = await ledgerState(t.practiceId, patientKey);
  assert.equal(after.entries, before.entries + 1);
  assert.equal(after.balance, before.balance - cents(100));

  /**
   * A write-off and a payment both reduce what is owed and are not the same event: one is cash that
   * arrived, the other is revenue given up. Collapsing them would make the practice's collections
   * figure a fiction, so the distinction is asserted where it is stored rather than where it is
   * displayed.
   */
  const kinds = await withPractice(t.practiceId, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT kind FROM ledger_entries WHERE patient_key = $1 AND kind <> 'charge'",
      [patientKey]
    );
    return (rows as { kind: string }[]).map((r) => r.kind);
  });
  assert.deepEqual(kinds, ["writeoff"], `a write-off must not be stored as a payment: ${kinds.join(", ")}`);
});

test("a refused write leaves the database exactly as it was", dbTest, async () => {
  /**
   * The half that matters more than the happy path. A route that validates its input but has already
   * written something, or that reports a refusal while a partial row lands, produces a balance
   * nobody can explain — and the response body says nothing about it either way.
   */
  const t = await tenant("money-write-refused");
  const patientKey = await patientOwing(t.practiceId, 400);

  const before = await ledgerState(t.practiceId, patientKey);
  for (const [label, body] of [
    ["a negative amount", { amountDollars: -50, note: "x" }],
    ["a fractional cent", { amountDollars: 10.005, note: "x" }],
    ["no amount at all", { note: "x" }],
  ] as const) {
    const res = await t.call("POST", `/api/v1/patients/${patientKey}/payment`, body);
    assert.ok(res.status >= 400, `${label} should be refused, got ${res.status}`);
    const after = await ledgerState(t.practiceId, patientKey);
    assert.deepEqual(after, before, `${label} was refused but the ledger changed anyway`);
  }
});

test("the same payment sent twice is two payments, and the balance says so", dbTest, async () => {
  /**
   * The opposite hazard to a duplicate remittance, and the reason `ledger_entries` has a PARTIAL
   * unique index on `source_ref IS NOT NULL`: a redelivered posting must not double-charge, but a
   * patient who pays $50 twice in one day has paid $100. Getting this backwards in either direction
   * either swallows real money or invents it.
   */
  const t = await tenant("money-write-twice");
  const patientKey = await patientOwing(t.practiceId, 400);

  const before = await ledgerState(t.practiceId, patientKey);
  for (let i = 0; i < 2; i++) {
    const res = await t.call("POST", `/api/v1/patients/${patientKey}/payment`, { amountDollars: 50, note: "cash" });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }

  const after = await ledgerState(t.practiceId, patientKey);
  assert.equal(after.entries, before.entries + 2, "two payments are two rows");
  assert.equal(after.balance, before.balance - cents(100), "and two rows are two hundred dollars");
});

test("every money write left an audit row naming who did it", dbTest, async () => {
  /**
   * Money moved with no record of who moved it is the finding an auditor opens with, and the audit
   * trail is written by a different mechanism than the ledger (`record_audit`, SECURITY DEFINER), so
   * one succeeding proves nothing about the other. Read as the app reads it — RLS-scoped to this
   * practice — because a row the tenant cannot see is a row that does not answer their auditor.
   */
  const t = await tenant("money-write-audited");
  const patientKey = await patientOwing(t.practiceId, 400);

  const res = await t.call("POST", `/api/v1/patients/${patientKey}/writeoff`, { amountDollars: 25, note: "audit" });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const rows = await withPractice(t.practiceId, async () => {
    const { rows } = await requireContext().tx.query(
      `SELECT action, actor_id, outcome FROM audit_events
        WHERE practice_id = $1 AND resource_id = $2 ORDER BY created_at DESC`,
      [t.practiceId, patientKey]
    );
    return rows as { action: string; actor_id: string | null; outcome: string }[];
  });

  assert.ok(rows.length > 0, "a write-off that leaves no audit row cannot be investigated later");
  assert.ok(
    rows.some((r) => r.actor_id !== null),
    "an audit row that does not name the actor answers 'something happened' and nothing else"
  );
});
