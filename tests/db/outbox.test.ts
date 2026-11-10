/**
 * Durable outbox, against a real Postgres.
 *
 * These assert the guarantees the in-memory implementation could only approximate. The transactional
 * one is the most important: an event enqueued by a business transaction that then ROLLS BACK must
 * not exist. No in-memory double can fail that test, because it has no transaction to roll back.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice, withoutPractice } from "@mermaid/db";
import { PostgresEventBus } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const silent = createLogger(() => {});
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

const bus = (opts = {}) =>
  new PostgresEventBus({ logger: silent, metrics: createMetrics(), backoffSeconds: 0, ...opts });

const needsReview = (id: string) => ({
  verificationId: id,
  raisedAt: "2026-08-01T10:00:00.000Z",
  patientName: "Ada Alpha",
  confidence: 0.42,
  reasons: ["Low card confidence."],
  priority: 70,
});

test("an event enqueued in a transaction that ROLLS BACK never exists", dbTest, async () => {
  const p = await practice("rollback");
  const b = bus();

  await assert.rejects(
    withPractice(p, async () => {
      await b.publish("verification.needs_review", "v-rollback", needsReview("v-rollback"));
      throw new Error("business write failed");
    }),
    /business write failed/
  );

  assert.equal(await visibleCount(p, "domain_events"), 0, "the outbox must not carry an event for a rolled-back write");
});

test("an event survives the process — it is a row, not a queue in memory", dbTest, async () => {
  const p = await practice("durable");
  await withPractice(p, async () => {
    await bus().publish("verification.needs_review", "v-durable", needsReview("v-durable"));
  });

  // A brand-new bus instance, as a restarted worker would be.
  const seen: string[] = [];
  const worker = bus();
  worker.subscribe("verification.needs_review", "queue", (e) => {
    seen.push(e.payload.verificationId);
  });
  await worker.drain();

  assert.deepEqual(seen, ["v-durable"]);
});

test("events are tenant-scoped: a practice sees only its own", dbTest, async () => {
  const [pA, pB] = [await practice("iso-a"), await practice("iso-b")];
  const b = bus();
  await withPractice(pA, () => b.publish("verification.needs_review", "v-a", needsReview("v-a")));
  await withPractice(pB, () => b.publish("verification.needs_review", "v-b", needsReview("v-b")));

  assert.equal(await visibleCount(pA, "domain_events"), 1);
  assert.equal(await visibleCount(pB, "domain_events"), 1);
});

test("the worker sees every practice's backlog, but handlers run scoped to one", dbTest, async () => {
  const [pA, pB] = [await practice("worker-a"), await practice("worker-b")];
  const b = bus();
  await withPractice(pA, () => b.publish("verification.needs_review", "v-wa", needsReview("v-wa")));
  await withPractice(pB, () => b.publish("verification.needs_review", "v-wb", needsReview("v-wb")));

  const contexts: { practice: string; visible: number }[] = [];
  b.subscribe("verification.needs_review", "context-probe", async (e) => {
    // The suite shares a database, so ignore anything another test published.
    if (e.practiceId !== pA && e.practiceId !== pB) return;
    // Inside a handler the ambient transaction is scoped to THIS event's practice, so a query
    // sees exactly one event — its own. That is the property that keeps module code tenant-safe
    // even though the queue mechanics deliberately span tenants.
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM domain_events");
    contexts.push({ practice: e.practiceId!, visible: (rows[0] as { n: number }).n });
  });

  await b.drainAll();

  assert.equal(contexts.length, 2, "the worker claimed both practices' events");
  assert.deepEqual(contexts.map((c) => c.visible), [1, 1], "each handler saw only its own tenant");
  assert.deepEqual(new Set(contexts.map((c) => c.practice)), new Set([pA, pB]));
});

test("retry re-delivers only to the subscriber that failed", dbTest, async () => {
  const p = await practice("checkpoint");
  const b = bus();
  let healthy = 0;
  let flaky = 0;
  b.subscribe("verification.needs_review", "healthy", () => {
    healthy += 1;
  });
  b.subscribe("verification.needs_review", "flaky", () => {
    flaky += 1;
    if (flaky === 1) throw new Error("transient");
  });

  await withPractice(p, () => b.publish("verification.needs_review", "v-cp", needsReview("v-cp")));

  const first = await b.drain();
  assert.equal(healthy, 1);
  assert.equal(flaky, 1);
  assert.equal(first.dispatched, 0, "one subscriber failed, so the event is not yet fully published");

  const second = await b.drain();
  assert.equal(healthy, 1, "the healthy subscriber must not see the event twice");
  assert.equal(flaky, 2);
  assert.equal(second.dispatched, 1);
  assert.equal(await pendingFor(p), 0);
});

test("a handler's work and its delivery checkpoint commit together", dbTest, async () => {
  const p = await practice("atomic-handler");
  const b = bus();
  let attempts = 0;

  // The handler writes, then fails — so both the write and the checkpoint must roll back, and the
  // retry must see a clean slate rather than a half-applied effect.
  b.subscribe("verification.needs_review", "writes-then-fails", async (e) => {
    attempts += 1;
    await requireContext().tx.query(
      "INSERT INTO patients (practice_id, chart_id, first_name, last_name, dob) VALUES ($1,$2,'X','Y','1990-01-01')",
      [e.practiceId, `chart-${attempts}`]
    );
    if (attempts === 1) throw new Error("failed after writing");
  });

  await withPractice(p, () => b.publish("verification.needs_review", "v-atomic", needsReview("v-atomic")));
  await b.drain();
  assert.equal(await visibleCount(p, "patients"), 0, "the failed handler's write must have rolled back");

  await b.drain();
  assert.equal(attempts, 2);
  assert.equal(await visibleCount(p, "patients"), 1, "the retry applied exactly once");
});

test("a permanently failing subscriber is dead-lettered and stops being retried", dbTest, async () => {
  const p = await practice("deadletter");
  const b = bus({ maxAttempts: 2 });
  let calls = 0;
  b.subscribe("verification.needs_review", "always-fails", () => {
    calls += 1;
    throw new Error("permanent");
  });

  await withPractice(p, () => b.publish("verification.needs_review", "v-dl", needsReview("v-dl")));
  await b.drain();
  const second = await b.drain();

  assert.equal(calls, 2);
  assert.equal(second.deadLettered, 1);
  assert.equal(await pendingFor(p), 0, "a dead letter is parked, not pending");

  await b.drain();
  assert.equal(calls, 2, "a dead-lettered event is never retried automatically");
});

test("an event with no subscribers is published rather than left pending forever", dbTest, async () => {
  const p = await practice("nosubs");
  const b = bus();
  await withPractice(p, () => b.publish("verification.needs_review", "v-ns", needsReview("v-ns")));

  const report = await b.drain();
  assert.equal(report.dispatched, 1);
  assert.equal(await pendingFor(p), 0);
});

test("SKIP LOCKED lets concurrent workers split a batch without double-processing", dbTest, async () => {
  const p = await practice("skiplocked");
  const publisher = bus();
  await withPractice(p, async () => {
    for (let i = 0; i < 8; i++) {
      await publisher.publish("verification.needs_review", `v-c${i}`, needsReview(`v-c${i}`));
    }
  });

  // Two independent workers, drained concurrently, as two app processes would.
  const handled: string[] = [];
  const makeWorker = (name: string) => {
    const w = bus({ batchSize: 4 });
    w.subscribe("verification.needs_review", "shared-consumer", async (e) => {
      if (e.practiceId !== p) return; // the suite shares a database
      handled.push(`${name}:${e.payload.verificationId}`);
    });
    return w;
  };
  const [w1, w2] = [makeWorker("w1"), makeWorker("w2")];
  await Promise.all([w1.drainAll(), w2.drainAll()]);

  const ids = handled.map((h) => h.split(":")[1]!);
  assert.equal(new Set(ids).size, 8, "every event was handled");
  assert.equal(ids.length, 8, "and none was handled twice — the claim lease held (migration 0007)");
  assert.equal(await pendingFor(p), 0);
});

test("publishing outside a practice context is refused", dbTest, async () => {
  const b = bus();
  await assert.rejects(
    withoutPractice(() => b.publish("verification.needs_review", "v-x", needsReview("v-x"))),
    /no practice context/
  );
});

test("publishing outside any transaction is refused", dbTest, async () => {
  const b = bus();
  await assert.rejects(
    () => b.publish("verification.needs_review", "v-x", needsReview("v-x")),
    /no ambient database transaction/
  );
});

test("the payload round-trips through JSONB with its version intact", dbTest, async () => {
  const p = await practice("payload");
  const b = bus();
  const body = needsReview("v-payload");
  await withPractice(p, () => b.publish("verification.needs_review", "v-payload", body));

  let received: unknown = null;
  b.subscribe("verification.needs_review", "reader", (e) => {
    received = e.payload;
  });
  await b.drain();

  assert.deepEqual(received, { ...body, snapshot_version: 1 });
});

/** Pending (unpublished, not dead-lettered) events for one practice. */
async function pendingFor(practiceId: string): Promise<number> {
  return withPractice(practiceId, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT count(*)::int AS n FROM domain_events WHERE published_at IS NULL AND dead_lettered = false"
    );
    return (rows[0] as { n: number }).n;
  });
}
