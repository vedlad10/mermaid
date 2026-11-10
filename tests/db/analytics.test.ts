/**
 * Analytics facts against a real database.
 *
 * Two properties are claimed by `modules/analytics` and neither can be proved in memory:
 *
 *  1. **Idempotency is the DATABASE's guarantee, not the service's.** `PgFactRepository.record`
 *     checks nothing — it hands the decision to `ON CONFLICT DO NOTHING` on
 *     `(practice_id, source_event_id, fact_type)`. The in-memory double checks a `Map`, which proves
 *     only that the double works. The interesting case is two *concurrent* transactions racing the
 *     same redelivered event, which is exactly what an at-least-once outbox with more than one
 *     worker produces, and which only a unique index can settle.
 *
 *  2. **A practice's numbers are invisible to every other practice.** A reporting table is the most
 *     dangerous place for an RLS gap, because the failure mode is not an error — it is a dashboard
 *     that quietly includes someone else's revenue.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice, withoutPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { AnalyticsService, PgFactRepository, type Fact } from "@mermaid/analytics";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

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

const service = () => new AnalyticsService(new PgFactRepository());

const fact = (overrides: Partial<Fact> = {}): Fact => ({
  sourceEventId: crypto.randomUUID(),
  factType: "claim_submitted",
  occurredAt: "2026-09-15T10:00:00.000Z",
  payerId: "metlife-dental",
  payerName: "MetLife Dental",
  procedureCode: null,
  carcCode: null,
  verificationId: crypto.randomUUID(),
  claimId: crypto.randomUUID(),
  denialId: null,
  amount: cents(1450),
  expected: cents(1015),
  won: null,
  meta: { serviceDate: "2026-09-14" },
  ...overrides,
});

const PERIOD = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

// ── Round trip ────────────────────────────────────────────────────────────────────────

test("a fact round-trips through Postgres with its cents and its JSONB intact", dbTest, async () => {
  const p = await practice("fact-roundtrip");
  const original = fact();

  assert.equal(await withPractice(p, () => service().record(original)), true);

  const [read] = await withPractice(p, () => new PgFactRepository().inPeriod(PERIOD));
  assert.ok(read);
  assert.equal(typeof read.amount, "number", "BIGINT cents must not come back as a string");
  assert.equal(read.amount, cents(1450));
  assert.equal(read.expected, cents(1015));
  assert.equal(read.occurredAt, original.occurredAt, "the business moment must not shift");
  assert.deepEqual(read.meta, { serviceDate: "2026-09-14" });
  assert.equal(read.sourceEventId, original.sourceEventId);
});

// ── Idempotency ───────────────────────────────────────────────────────────────────────

test("a redelivered event is counted exactly once", dbTest, async () => {
  const p = await practice("fact-redeliver");
  const event = fact();

  assert.equal(await withPractice(p, () => service().record(event)), true);
  assert.equal(
    await withPractice(p, () => service().record(event)),
    false,
    "the second delivery must report that it changed nothing"
  );
  assert.equal(await visibleCount(p, "analytics_facts"), 1);
});

test("two workers racing the same redelivered event still record one fact", dbTest, async () => {
  const p = await practice("fact-race");
  const event = fact({ factType: "payment_posted", amount: cents(1015), expected: cents(1015) });

  // Separate `withPractice` calls take separate pooled connections, so these are genuinely
  // concurrent transactions — the shape a second outbox worker produces.
  const results = await Promise.all([
    withPractice(p, () => service().record(event)),
    withPractice(p, () => service().record(event)),
    withPractice(p, () => service().record(event)),
  ]);

  assert.equal(results.filter(Boolean).length, 1, "exactly one transaction may claim the insert");
  assert.equal(await visibleCount(p, "analytics_facts"), 1);

  // And the money is not doubled — the reason this test exists at all.
  const report = await withPractice(p, () => service().report(PERIOD));
  assert.equal(report.money.collected, cents(1015));
});

test("the same event id under a different fact type is a different fact", dbTest, async () => {
  const p = await practice("fact-type-key");
  const id = crypto.randomUUID();

  await withPractice(p, () => service().record(fact({ sourceEventId: id, factType: "claim_submitted" })));
  await withPractice(p, () =>
    service().record(fact({ sourceEventId: id, factType: "payment_posted", amount: cents(900) }))
  );

  assert.equal(await visibleCount(p, "analytics_facts"), 2, "the natural key includes the fact type");
});

// ── Tenant isolation ──────────────────────────────────────────────────────────────────

test("one practice's revenue is invisible to another", dbTest, async () => {
  const [pA, pB] = [await practice("fact-iso-a"), await practice("fact-iso-b")];

  await withPractice(pA, () => service().record(fact({ amount: cents(2000), expected: cents(2000) })));

  assert.equal(await visibleCount(pB, "analytics_facts"), 0);
  assert.equal((await withPractice(pB, () => service().report(PERIOD))).money.filedToPayers, 0);
  assert.equal((await withPractice(pA, () => service().report(PERIOD))).money.filedToPayers, cents(2000));
});

test("the same source event recorded by two practices is two facts, one each", dbTest, async () => {
  const [pA, pB] = [await practice("fact-iso-key-a"), await practice("fact-iso-key-b")];
  const event = fact();

  assert.equal(await withPractice(pA, () => service().record(event)), true);
  assert.equal(
    await withPractice(pB, () => service().record(event)),
    true,
    "the uniqueness key is scoped to the practice — one tenant must not block another"
  );
  assert.equal(await visibleCount(pA, "analytics_facts"), 1);
  assert.equal(await visibleCount(pB, "analytics_facts"), 1);
});

test("a fact cannot be written with no practice context at all", dbTest, async () => {
  await assert.rejects(
    withoutPractice(() => service().record(fact())),
    /practice context/,
    "fail closed: a projection write outside a tenant is a bug, not an untenanted row"
  );
});

test("RLS is enforced by the database, not by the repository's WHERE clause", dbTest, async () => {
  const [pA, pB] = [await practice("fact-rls-a"), await practice("fact-rls-b")];
  await withPractice(pA, () => service().record(fact()));

  // Deliberately unqualified: if RLS were off, this would see pA's row from inside pB.
  const leaked = await withPractice(pB, async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM analytics_facts");
    return (rows[0] as { n: number }).n;
  });
  assert.equal(leaked, 0);
});

// ── The window ────────────────────────────────────────────────────────────────────────

test("the reporting window includes `from` and excludes `to`", dbTest, async () => {
  const p = await practice("fact-window");
  await withPractice(p, async () => {
    const s = service();
    await s.record(fact({ occurredAt: PERIOD.from, amount: cents(100), expected: cents(100) }));
    await s.record(fact({ occurredAt: PERIOD.to, amount: cents(999), expected: cents(999) }));
    await s.record(fact({ occurredAt: "2026-08-31T23:59:59.999Z", amount: cents(777), expected: cents(777) }));
  });

  const report = await withPractice(p, () => service().report(PERIOD));
  assert.equal(report.funnel.claimsSubmitted, 1, "an exclusive upper bound cannot double-count a boundary");
  assert.equal(report.money.filedToPayers, cents(100));
});

// ── The report, from durable facts ────────────────────────────────────────────────────

test("a full cycle's facts produce the practice report a dashboard renders", dbTest, async () => {
  const p = await practice("fact-report");
  const claimId = crypto.randomUUID();
  const denialId = crypto.randomUUID();

  await withPractice(p, async () => {
    const s = service();
    await s.record(
      fact({
        factType: "verification_completed",
        occurredAt: "2026-09-02T09:00:00.000Z",
        amount: cents(1450),
        expected: cents(1015),
      })
    );
    await s.record(fact({ claimId, occurredAt: "2026-09-03T09:00:00.000Z" }));
    await s.record(
      fact({
        factType: "payment_posted",
        claimId,
        occurredAt: "2026-09-23T09:00:00.000Z",
        amount: cents(700),
        expected: cents(1015),
      })
    );
    await s.record(
      fact({
        factType: "denial_created",
        claimId,
        denialId,
        carcCode: "197",
        procedureCode: "D2750",
        occurredAt: "2026-09-23T09:05:00.000Z",
        amount: cents(315),
        expected: cents(126),
      })
    );
    await s.record(
      fact({
        factType: "appeal_outcome",
        claimId,
        denialId,
        carcCode: "197",
        procedureCode: "D2750",
        occurredAt: "2026-09-28T09:00:00.000Z",
        amount: cents(315),
        expected: cents(315),
        won: true,
      })
    );
  });

  const report = await withPractice(p, () => service().report(PERIOD));

  assert.equal(report.funnel.verificationsCompleted, 1);
  assert.equal(report.funnel.claimsSubmitted, 1);
  assert.equal(report.funnel.claimsPaid, 1);
  assert.equal(report.money.filedToPayers, cents(1450));
  assert.equal(report.money.expected, cents(1015));
  assert.equal(report.money.collected, cents(700));
  assert.equal(report.money.denied, cents(315));
  assert.equal(report.money.recovered, cents(315));

  const [payer] = report.payers;
  assert.ok(payer);
  assert.equal(payer.payerName, "MetLife Dental");
  assert.equal(payer.averageDaysToPay, 20, "days-to-pay is matched per claim across two fact rows");

  const [reason] = report.topDenialReasons;
  assert.equal(reason?.carcCode, "197");
  assert.equal(reason?.recoveryRate, 1);
  assert.ok(report.insights.length > 0);
});

test("factCount is a live operational signal that the projection is being fed", dbTest, async () => {
  const p = await practice("fact-count");
  assert.equal(await withPractice(p, () => service().factCount()), 0);
  await withPractice(p, () => service().record(fact()));
  assert.equal(await withPractice(p, () => service().factCount()), 1);
});
