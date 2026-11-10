/**
 * One visit is counted once, however many events describe it (NEW-12).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `analytics_facts` deduplicates on `(practice, source_event_id, fact_type)`, which makes it
 * idempotent under the outbox's at-least-once delivery — the right guarantee for REDELIVERY, and no
 * guarantee at all about the same subject being announced by two DIFFERENT events.
 *
 * `VerificationService.review` had no already-settled guard, so re-reviewing a verification that had
 * already settled republished `verification.completed`: a new event, a new id, the same visit. The
 * funnel then counted it twice.
 *
 *   • `billingRate` is claims submitted ÷ verifications completed. The denominator grew and the
 *     rate fell, so a practice appeared to be leaving money unbilled that it had in fact billed.
 *   • `reviewRate` is flagged ÷ (completed + flagged), so a flagged-then-approved verification sat
 *     on both sides of its own ratio.
 *
 * Nothing was loud. Every number stayed internally consistent, and the drift went in the direction
 * of the practices that use human review most.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { InMemoryFactRepository, factDedupeKey } from "../repository.ts";
import type { Fact } from "../types.ts";

const base = (over: Partial<Fact> = {}): Fact => ({
  sourceEventId: "event-1",
  factType: "verification_completed",
  occurredAt: "2026-09-01T12:00:00.000Z",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  procedureCode: null,
  carcCode: null,
  verificationId: "ver-1",
  claimId: null,
  denialId: null,
  amount: cents(100),
  expected: cents(80),
  won: null,
  meta: {},
  ...over,
});

test("the SAME verification announced by two different events is ONE fact", () => {
  const repo = new InMemoryFactRepository();
  const fact = (eventId: string): Fact =>
    base({ sourceEventId: eventId, dedupeKey: "verification_completed:ver-1" });

  return Promise.all([repo.record(fact("event-1")), repo.record(fact("event-2"))]).then(async ([a, b]) => {
    assert.equal(a, true, "the first announcement records a fact");
    assert.equal(
      b,
      false,
      "the second must not. It is the same visit — re-reviewing a settled verification republished " +
        "`verification.completed` with a new event id, and the funnel counted the visit twice."
    );
    assert.equal(await repo.count(), 1);
  });
});

test("REDELIVERY of one event is still deduplicated — the guarantee that already existed", async () => {
  const repo = new InMemoryFactRepository();
  // No dedupe key: the fact types where a subject legitimately produces several facts.
  const fact = base({ factType: "payment_posted", sourceEventId: "event-9" });

  assert.equal(await repo.record(fact), true);
  assert.equal(await repo.record({ ...fact }), false, "the same event redelivered writes nothing new");
  assert.equal(await repo.count(), 1);
});

test("a fact type where the SUBJECT legitimately repeats is not collapsed", () => {
  /**
   * The failure a blanket subject-key would cause, and the reason the key is stated per fact type
   * rather than derived from a column. A claim really is paid by a primary AND a secondary payer,
   * and a denial really can be appealed at two levels — collapsing those deletes money from the
   * reports, which is worse than the double-count being fixed.
   */
  const repo = new InMemoryFactRepository();
  const primary = base({ factType: "payment_posted", sourceEventId: "event-a", claimId: "claim-1" });
  const secondary = base({ factType: "payment_posted", sourceEventId: "event-b", claimId: "claim-1" });

  return Promise.all([repo.record(primary), repo.record(secondary)]).then(async ([a, b]) => {
    assert.equal(a, true);
    assert.equal(b, true, "two payers paying one claim is two payments");
    assert.equal(await repo.count(), 2);
  });
});

test("a fact with no stated key falls back to exactly what the table enforced before", () => {
  /**
   * The compatibility guarantee. Four of the eight fact types state no key, and their behaviour has
   * to be unchanged — `<factType>:<sourceEventId>` is the old `(source_event_id, fact_type)` tuple,
   * written as a string.
   */
  assert.equal(
    factDedupeKey(base({ factType: "payment_posted", sourceEventId: "abc" })),
    "payment_posted:abc"
  );
  assert.equal(
    factDedupeKey(base({ dedupeKey: "verification_completed:ver-7" })),
    "verification_completed:ver-7",
    "and a stated key wins"
  );
});

test("two DIFFERENT verifications are still two facts", () => {
  /**
   * The control. A key derived wrongly — from the fact type alone, say — would collapse an entire
   * practice's funnel to one row and every rate to 100%, which is the shape of bug that looks like
   * the system working.
   */
  const repo = new InMemoryFactRepository();
  return Promise.all([
    repo.record(base({ verificationId: "ver-1", dedupeKey: "verification_completed:ver-1" })),
    repo.record(base({ verificationId: "ver-2", dedupeKey: "verification_completed:ver-2" })),
  ]).then(async (results) => {
    assert.deepEqual(results, [true, true]);
    assert.equal(await repo.count(), 2);
  });
});
