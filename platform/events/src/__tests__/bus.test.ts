/**
 * Outbox tests. These assert the delivery *guarantees* the rest of the platform is allowed to
 * depend on — not just that a callback fires. If any of these break, every downstream module's
 * idempotency assumptions break with them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, createMetrics } from "@mermaid/observability";
import { InMemoryOutbox, NullEventPublisher } from "../bus.ts";
import { DOMAIN_EVENT_TYPES, EVENT_PAYLOAD_VERSION, isDomainEventType, type VerificationNeedsReviewBody } from "../catalog.ts";
import type { Cents } from "@mermaid/shared";

const silent = createLogger(() => {});

function outbox(opts: { autoDrain?: boolean; maxAttempts?: number } = {}) {
  return new InMemoryOutbox({ logger: silent, metrics: createMetrics(), ...opts });
}

const needsReview: VerificationNeedsReviewBody = {
  verificationId: "v-1",
  raisedAt: "2026-07-27T10:00:00.000Z",
  patientName: "Ada Alpha",
  confidence: 0.42,
  reasons: ["Low card confidence."],
  priority: 70,
};

test("publish stamps a versioned payload and dispatches to subscribers", async () => {
  const bus = outbox();
  const seen: string[] = [];
  bus.subscribe("verification.needs_review", "today-queue", (e) => {
    seen.push(e.payload.verificationId);
  });

  const event = await bus.publish("verification.needs_review", "v-1", needsReview);

  assert.equal(event.payload.snapshot_version, EVENT_PAYLOAD_VERSION);
  assert.equal(event.payload.patientName, "Ada Alpha");
  assert.deepEqual(seen, ["v-1"]);
  assert.equal(bus.pending().length, 0, "auto-drain should leave nothing pending");
});

test("an event with no subscribers is still recorded and marked published", async () => {
  const bus = outbox();
  await bus.publish("verification.needs_review", "v-1", needsReview);
  const all = bus.all();
  assert.equal(all.length, 1);
  assert.ok(all[0]!.publishedAt, "no subscribers means nothing to wait for");
});

test("autoDrain:false leaves the event pending until drain() is called", async () => {
  const bus = outbox({ autoDrain: false });
  let calls = 0;
  bus.subscribe("verification.needs_review", "today-queue", () => {
    calls += 1;
  });

  await bus.publish("verification.needs_review", "v-1", needsReview);
  assert.equal(calls, 0);
  assert.equal(bus.pending().length, 1);

  const report = await bus.drain();
  assert.equal(calls, 1);
  assert.equal(report.dispatched, 1);
  assert.equal(report.pending, 0);
});

test("a failing handler never throws out of publish — the business write already committed", async () => {
  const bus = outbox();
  bus.subscribe("verification.needs_review", "explodes", () => {
    throw new Error("downstream is down");
  });

  const event = await bus.publish("verification.needs_review", "v-1", needsReview);

  assert.equal(event.publishedAt, null);
  assert.equal(bus.pending().length, 1);
  assert.match(bus.pending()[0]!.lastError ?? "", /explodes: downstream is down/);
});

test("retry re-delivers only to the subscriber that failed (per-subscriber checkpointing)", async () => {
  const bus = outbox({ autoDrain: false });
  let healthy = 0;
  let flaky = 0;
  bus.subscribe("verification.needs_review", "healthy", () => {
    healthy += 1;
  });
  bus.subscribe("verification.needs_review", "flaky", () => {
    flaky += 1;
    if (flaky === 1) throw new Error("transient");
  });

  await bus.publish("verification.needs_review", "v-1", needsReview);
  await bus.drain();
  assert.equal(healthy, 1);
  assert.equal(flaky, 1);

  const second = await bus.drain();
  assert.equal(healthy, 1, "the healthy subscriber must not see the event twice");
  assert.equal(flaky, 2);
  assert.equal(second.dispatched, 1);
  assert.equal(bus.pending().length, 0);
});

test("an event is dead-lettered after maxAttempts and never retried again", async () => {
  const bus = outbox({ autoDrain: false, maxAttempts: 3 });
  let calls = 0;
  bus.subscribe("verification.needs_review", "always-fails", () => {
    calls += 1;
    throw new Error("permanent");
  });

  await bus.publish("verification.needs_review", "v-1", needsReview);
  await bus.drain();
  await bus.drain();
  const third = await bus.drain();

  assert.equal(calls, 3);
  assert.equal(third.deadLettered, 1);
  assert.equal(bus.deadLetters().length, 1);
  assert.equal(bus.pending().length, 0, "dead letters are parked, not pending");

  await bus.drain();
  assert.equal(calls, 3, "a dead-lettered event is never retried automatically");
});

test("an event published from inside a handler is dispatched in the same pass", async () => {
  const bus = outbox();
  const order: string[] = [];
  bus.subscribe("verification.needs_review", "escalator", async () => {
    order.push("needs_review");
    await bus.publish("claim.filing_risk", "c-1", {
      claimId: "c-1",
      verificationId: "v-1",
      raisedAt: "2026-07-27T10:00:00.000Z",
      filingDeadline: "2026-08-01",
      daysRemaining: 5,
      risk: "urgent",
      amountAtRisk: 120000 as Cents,
      payerName: "Delta Dental",
    });
  });
  bus.subscribe("claim.filing_risk", "queue", () => {
    order.push("filing_risk");
  });

  await bus.publish("verification.needs_review", "v-1", needsReview);

  assert.deepEqual(order, ["needs_review", "filing_risk"]);
  assert.equal(bus.pending().length, 0);
});

test("registering the same subscriber name twice for one event type is refused", () => {
  const bus = outbox();
  bus.subscribe("verification.needs_review", "queue", () => {});
  assert.throws(
    () => bus.subscribe("verification.needs_review", "queue", () => {}),
    /already registered/
  );
});

test("drain reports outbox lag — the mandated monitoring signal", async () => {
  const bus = outbox({ autoDrain: false });
  bus.subscribe("verification.needs_review", "stuck", () => {
    throw new Error("nope");
  });

  const occurredAt = new Date("2026-07-27T10:00:00.000Z");
  await bus.publish("verification.needs_review", "v-1", needsReview, { occurredAt });
  const report = await bus.drain(new Date("2026-07-27T10:05:00.000Z"));

  assert.equal(report.pending, 1);
  assert.equal(report.oldestPendingMs, 5 * 60 * 1000);
});

test("inspection methods hand back copies — callers cannot mutate the outbox", async () => {
  const bus = outbox();
  await bus.publish("verification.needs_review", "v-1", needsReview);
  const snapshot = bus.ofType("verification.needs_review");
  snapshot[0]!.payload.patientName = "tampered";
  assert.equal(bus.ofType("verification.needs_review")[0]!.payload.patientName, "Ada Alpha");
});

test("ofType filters the outbox by event type", async () => {
  const bus = outbox();
  await bus.publish("verification.needs_review", "v-1", needsReview);
  await bus.publish("verification.needs_review", "v-2", { ...needsReview, verificationId: "v-2" });
  const found = bus.ofType("verification.needs_review");
  assert.deepEqual(found.map((e) => e.payload.verificationId), ["v-1", "v-2"]);
});

test("NullEventPublisher accepts events and reports them published", async () => {
  const publisher = new NullEventPublisher();
  const event = await publisher.publish("verification.needs_review", "v-1", needsReview);
  assert.equal(event.payload.snapshot_version, EVENT_PAYLOAD_VERSION);
  assert.ok(event.publishedAt);
});

test("isDomainEventType guards the catalog at the edge", () => {
  assert.ok(isDomainEventType("claim.submitted"));
  assert.equal(isDomainEventType("claim.invented"), false);
  assert.equal(isDomainEventType(42), false);
});

/**
 * The catalog list must cover the catalog map (F-1 fallout).
 *
 * `DOMAIN_EVENT_TYPES` was hand-maintained and had already drifted: `denial.recovery.settled` was
 * being published while absent from the list, so `isDomainEventType` — whose own test above says it
 * "guards the catalog at the edge" — would have refused a legitimate event the moment anyone wired
 * it to a real edge. It is now derived from a `Record<DomainEventType, true>`, so an omission is a
 * compile error; this asserts the runtime consequence a type cannot.
 */
test("every event the system can publish is one the guard accepts", () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    assert.ok(isDomainEventType(type), `${type} is in the list but the guard rejects it`);
  }
  for (const published of [
    "denial.recovery.settled",
    "remittance.allowed_amounts_observed",
    "remittance.posted",
    "appeal.outcome.recorded",
  ]) {
    assert.ok(isDomainEventType(published), `${published} is published in production and must be recognised`);
  }
});
