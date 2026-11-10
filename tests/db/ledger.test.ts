/**
 * The patient ledger against a real database.
 *
 * Three claims made by `modules/patient-ledger` cannot be established in memory:
 *
 *  1. **A patient is never charged twice for one event**, even when two workers race the same
 *     redelivery. The service checks nothing — it hands the decision to a partial UNIQUE index. This
 *     is the failure that leaves the building, as a demand for money the patient does not owe.
 *
 *  2. **A human entry is never mistaken for a redelivery.** The index is partial on
 *     `source_ref IS NOT NULL` precisely so a second payment from the same patient is a second
 *     payment. Get that wrong in either direction and either money is double-charged or a real
 *     payment is silently swallowed.
 *
 *  3. **The sign convention is enforced by the database.** A CHECK constraint, not a convention, is
 *     what stops a row from silently inverting a balance.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { NullEventPublisher } from "@mermaid/events";
import type { DenialClosedBody, RemittancePostedBody } from "@mermaid/events";
import { PatientLedgerService, PgLedgerRepository } from "@mermaid/patient-ledger";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

const service = () => new PatientLedgerService(new PgLedgerRepository(), new NullEventPublisher());

const posted = (overrides: Partial<RemittancePostedBody> = {}): RemittancePostedBody => ({
  remittanceId: crypto.randomUUID(),
  postingId: crypto.randomUUID(),
  claimId: crypto.randomUUID(),
  patientControlNumber: "MRM-000123",
  postedAt: "2026-09-01T09:00:00.000Z",
  traceNumber: "EFT100200300",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  paymentDate: "2026-09-01",
  chargedAmount: cents(1425),
  paidAmount: cents(800),
  patientResponsibility: cents(200),
  contractualAdjustments: cents(425),
  expectedInsurancePays: cents(800),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
  ...overrides,
});

const closed = (overrides: Partial<DenialClosedBody> = {}): DenialClosedBody => ({
  denialId: crypto.randomUUID(),
  claimId: crypto.randomUUID(),
  closedAt: "2026-09-05T09:00:00.000Z",
  closedBy: "biller@clinic",
  closedAs: "patient_billed",
  reason: "Plan excludes this procedure; the patient agreed to self-pay.",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  carcCode: "204",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  deniedAmount: cents(125),
  ...overrides,
});

/**
 * A ledger repository whose reads dawdle.
 *
 * The double-charge race lives between `entriesFor` and `append` inside `chargeFromPosting`, and
 * that window is one network round-trip wide — too narrow to hit reliably from a test. Holding the
 * read open makes the overlap a certainty: both transactions have provably read before either has
 * written. With the patient lock in place the hold happens INSIDE the lock, so the second caller
 * still serializes; without it, both charge.
 */
class SlowReadLedger extends PgLedgerRepository {
  override async entriesFor(patientKey: string) {
    const entries = await super.entriesFor(patientKey);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return entries;
  }
}

/** Two live pooled connections, so the "concurrent" caller is not just waiting on a TLS handshake. */
async function warmTwoConnections(p: string): Promise<void> {
  await Promise.all([
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
  ]);
}

/**
 * ── THE DOUBLE CHARGE THAT LEAVES THE BUILDING ─────────────────────────────────────────────────
 * Two postings for ONE claim are two genuinely different events — a payer re-adjudication under a
 * new trace, a corrected advice — so the `source_ref` unique index passes both. The only guard is
 * the delta arithmetic, and the delta is a read-then-write: unserialized, both handlers read the
 * same prior state, both compute the full patient share, and the patient is billed twice. The
 * account is brand new here on purpose — zero rows was exactly the case `FOR UPDATE` row locking
 * could not cover, which is why `lockPatient` is an advisory lock.
 */
test("two concurrent postings for one claim charge the patient once", dbTest, async () => {
  const p = await practice("ledger-race-charge");
  await warmTwoConnections(p);

  const svc = new PatientLedgerService(new SlowReadLedger(), new NullEventPublisher());
  const claimId = crypto.randomUUID();
  const first = posted({ claimId, postingId: crypto.randomUUID(), settled: false });
  const second = posted({ claimId, postingId: crypto.randomUUID(), settled: false });

  await Promise.all([
    withPractice(p, () => svc.chargeFromPosting(first, NOW)),
    withPractice(p, () => svc.chargeFromPosting(second, NOW)),
  ]);

  const statement = (await withPractice(p, () => svc.statement("ABC12345", NOW)))!;
  assert.equal(
    statement.account.balance,
    cents(200),
    "the payer's latest word on the patient's share is $200 — twice that is a demand for money not owed"
  );
  const charges = statement.entries.filter((e) => e.kind === "charge");
  assert.equal(charges.length, 1, "the second posting restates the share; it must not restate the charge");
});

// ── Round trip ────────────────────────────────────────────────────────────────────────

test("an entry round-trips with its cents, its sign and its provenance", dbTest, async () => {
  const p = await practice("ledger-roundtrip");
  const event = posted();

  await withPractice(p, () => service().chargeFromPosting(event, NOW));

  const statement = (await withPractice(p, () => service().statement("ABC12345", NOW)))!;
  assert.ok(statement);
  assert.equal(typeof statement.account.balance, "number", "BIGINT cents must not arrive as a string");
  assert.equal(statement.account.balance, cents(200));
  assert.equal(statement.entries[0]!.amount, cents(200), "a charge is stored positive");
  assert.equal(statement.entries[0]!.claimId, event.claimId);
  assert.equal(statement.entries[0]!.sourceRef, `posting:${event.postingId}`);
  assert.equal(statement.entries[0]!.occurredAt, event.postedAt, "the business moment must not shift");
});

test("a reduction is stored NEGATIVE, so a balance is a sum and not a switch statement", dbTest, async () => {
  const p = await practice("ledger-sign");
  await withPractice(p, () => service().chargeFromPosting(posted(), NOW));
  await withPractice(p, () =>
    service().recordPayment("ABC12345", { amount: cents(50), recordedBy: "front.desk@clinic" }, NOW)
  );

  const rows = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT kind, amount_cents FROM ledger_entries ORDER BY kind"
    );
    return rows as { kind: string; amount_cents: number }[];
  });
  assert.deepEqual(rows, [
    { kind: "charge", amount_cents: cents(200) },
    { kind: "payment", amount_cents: -cents(50) },
  ]);
});

test("the database refuses a row whose sign contradicts its kind", dbTest, async () => {
  const p = await practice("ledger-check");
  await assert.rejects(
    withPractice(p, () =>
      requireContext().tx.query(
        `INSERT INTO ledger_entries
           (id, practice_id, patient_key, patient_name, kind, amount_cents, occurred_at,
            description, recorded_by)
         VALUES (gen_random_uuid(), $1, 'ABC12345', 'Ada Alpha', 'payment', 500, now(), 'bad', 'someone')`,
        [p]
      )
    ),
    /ledger_sign_matches_kind/,
    "a convention nothing enforces is a convention that will be broken"
  );
});

// ── Idempotency ───────────────────────────────────────────────────────────────────────

test("a redelivered posting charges the patient exactly once", dbTest, async () => {
  const p = await practice("ledger-redeliver");
  const event = posted();

  await withPractice(p, () => service().chargeFromPosting(event, NOW));
  const second = await withPractice(p, () => service().chargeFromPosting(event, NOW));

  assert.equal(second, null);
  assert.equal(await visibleCount(p, "ledger_entries"), 1);
});

test("two workers racing one redelivered posting still charge once", dbTest, async () => {
  const p = await practice("ledger-race");
  const event = posted();

  // Separate `withPractice` calls take separate pooled connections — genuinely concurrent
  // transactions, the shape a second outbox worker produces.
  const results = await Promise.all([
    withPractice(p, () => service().chargeFromPosting(event, NOW)),
    withPractice(p, () => service().chargeFromPosting(event, NOW)),
    withPractice(p, () => service().chargeFromPosting(event, NOW)),
  ]);

  assert.equal(results.filter(Boolean).length, 1, "exactly one transaction may claim the insert");
  assert.equal(await visibleCount(p, "ledger_entries"), 1);
  assert.equal((await withPractice(p, () => service().statement("ABC12345", NOW)))!.account.balance, cents(200));
});

test("a redelivered denial close charges once", dbTest, async () => {
  const p = await practice("ledger-denial-redeliver");
  const event = closed();

  await withPractice(p, () => service().chargeFromDenial(event, NOW));
  await withPractice(p, () => service().chargeFromDenial(event, NOW));
  assert.equal(await visibleCount(p, "ledger_entries"), 1);
});

test("two payments from one patient are two payments, not a redelivery", dbTest, async () => {
  const p = await practice("ledger-two-payments");
  await withPractice(p, () => service().chargeFromPosting(posted(), NOW));
  await withPractice(p, () =>
    service().recordPayment("ABC12345", { amount: cents(50), recordedBy: "front.desk" }, NOW)
  );
  await withPractice(p, () =>
    service().recordPayment("ABC12345", { amount: cents(50), recordedBy: "front.desk" }, NOW)
  );

  assert.equal(await visibleCount(p, "ledger_entries"), 3, "the unique index is PARTIAL for exactly this");
  assert.equal((await withPractice(p, () => service().statement("ABC12345", NOW)))!.account.balance, cents(100));
});

// ── Tenant isolation ──────────────────────────────────────────────────────────────────

test("one practice's patient balances are invisible to another", dbTest, async () => {
  const [pA, pB] = [await practice("ledger-iso-a"), await practice("ledger-iso-b")];
  await withPractice(pA, () => service().chargeFromPosting(posted(), NOW));

  assert.equal(await withPractice(pB, () => service().statement("ABC12345", NOW)), null);
  assert.equal(await visibleCount(pB, "ledger_entries"), 0);
  assert.equal((await withPractice(pB, () => service().summary(NOW))).totalOutstanding, 0);
  assert.equal((await withPractice(pA, () => service().summary(NOW))).totalOutstanding, cents(200));
});

test("the same posting recorded by two practices is two charges, one each", dbTest, async () => {
  const [pA, pB] = [await practice("ledger-iso-key-a"), await practice("ledger-iso-key-b")];
  const event = posted();

  assert.ok(await withPractice(pA, () => service().chargeFromPosting(event, NOW)));
  assert.ok(
    await withPractice(pB, () => service().chargeFromPosting(event, NOW)),
    "the uniqueness key is scoped to the practice — one tenant must not block another"
  );
  assert.equal(await visibleCount(pA, "ledger_entries"), 1);
  assert.equal(await visibleCount(pB, "ledger_entries"), 1);
});

test("RLS is enforced by the database, not by the repository's WHERE clause", dbTest, async () => {
  const [pA, pB] = [await practice("ledger-rls-a"), await practice("ledger-rls-b")];
  await withPractice(pA, () => service().chargeFromPosting(posted(), NOW));

  const leaked = await withPractice(pB, async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM ledger_entries");
    return (rows[0] as { n: number }).n;
  });
  assert.equal(leaked, 0);
});

// ── Queries answered in SQL ───────────────────────────────────────────────────────────

test("the owing filter is answered in SQL, and excludes settled accounts", dbTest, async () => {
  const p = await practice("ledger-owing");

  await withPractice(p, async () => {
    const s = service();
    await s.chargeFromPosting(posted({ memberId: "OWES", patientName: "Still Owes" }), NOW);
    await s.chargeFromPosting(posted({ memberId: "PAID", patientName: "Paid Up" }), NOW);
    await s.recordPayment("PAID", { amount: cents(200), recordedBy: "front.desk" }, NOW);
  });

  const owing = await withPractice(p, () => service().list({ withBalanceOnly: true }, NOW));
  assert.deepEqual(owing.map((a) => a.patientKey), ["OWES"]);

  // But the settled account still exists — a paid patient is not a deleted one.
  assert.ok(await withPractice(p, () => service().statement("PAID", NOW)));
});

test("the practice summary aggregates every account", dbTest, async () => {
  const p = await practice("ledger-summary");
  const old = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();

  await withPractice(p, async () => {
    const s = service();
    await s.chargeFromPosting(
      posted({ memberId: "A", patientName: "A", postedAt: old, patientResponsibility: cents(100) }),
      NOW
    );
    await s.chargeFromPosting(posted({ memberId: "B", patientName: "B", patientResponsibility: cents(250) }), NOW);
    await s.recordPayment("B", { amount: cents(50), recordedBy: "front.desk" }, NOW);
  });

  const summary = await withPractice(p, () => service().summary(NOW));
  assert.equal(summary.accountsWithBalance, 2);
  assert.equal(summary.totalOutstanding, cents(300));
  assert.equal(summary.aging.d90_plus, cents(100), "the 120-day charge ages correctly through the driver");
  assert.equal(summary.aging.current, cents(200));
});

test("the ledger refuses to run with no practice context at all", dbTest, async () => {
  await assert.rejects(
    (async () => {
      const { withoutPractice } = await import("@mermaid/db");
      return withoutPractice(() => service().chargeFromPosting(posted(), NOW));
    })(),
    /practice context/
  );
});
