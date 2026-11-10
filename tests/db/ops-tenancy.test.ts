/**
 * An operations screen shows THIS practice's queue, not the deployment's (NEW-06).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `PgOutbox.backlog()` reads through `domain_event_backlog()`, a SECURITY DEFINER function that
 * aggregates the whole `domain_events` table with no practice predicate. That is correct and
 * necessary for the outbox WORKER and the internal watchdog: a tenant whose queue has stalled is
 * invisible from inside any other tenant.
 *
 * It was also what three user-facing routes served — `/ops/outbox`, `/ops/monitors` and
 * `/ops/readiness`. So a clinic's operations screen reported pending counts, dead-letter counts and
 * an oldest-pending timestamp aggregated over every OTHER clinic on the deployment:
 *
 *   • a busy neighbour made a perfectly healthy queue read as stalled, and readiness return 503;
 *   • a neighbour's dead letters appeared as work for this practice to retry — and `revive` is
 *     correctly RLS-scoped, so the retry silently did nothing;
 *   • the numbers themselves leaked another tenant's event volume, in a system whose entire tenancy
 *     story is that no practice learns anything about another.
 *
 * Two practices with pending events is the only configuration that can show any of this, which is
 * why this test exists against a real database rather than as an assertion about a function name.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireContext, withPractice, withoutPractice } from "@mermaid/db";
import { PostgresEventBus } from "@mermaid/events";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

/** The defaults are fine here — nothing in these tests drains, so nothing logs. */
const outbox = (): PostgresEventBus => new PostgresEventBus();

/**
 * Write `count` UNDELIVERED events straight into the table for this practice.
 *
 * Inserted directly rather than published through the bus: publishing would hand them to the
 * request-scoped drain and they would not stay pending, and what this test needs is a backlog that
 * sits still while it is measured.
 */
async function pending(practiceId: string, count: number, deadLettered = false): Promise<void> {
  await withPractice(practiceId, async () => {
    for (let i = 0; i < count; i++) {
      await requireContext().tx.query(
        `INSERT INTO domain_events
           (id, practice_id, event_type, aggregate_id, payload, occurred_at, attempts,
            published_at, dead_lettered, next_attempt_at)
         VALUES ($1,$2,'test.ops_tenancy',$3,'{"snapshot_version":1}'::jsonb, now(), 0, NULL, $4, now())`,
        [randomUUID(), practiceId, randomUUID(), deadLettered]
      );
    }
  });
}

test("two practices with pending events each see only their own count", dbTest, async () => {
  const a = await makePractice("ops-tenancy-a");
  const b = await makePractice("ops-tenancy-b");
  created.push(a, b);

  await pending(a, 3);
  await pending(b, 5);
  await pending(b, 2, true);

  const seenByA = await withPractice(a, () => outbox().practiceBacklog());
  const seenByB = await withPractice(b, () => outbox().practiceBacklog());

  assert.equal(seenByA.pending, 3, "practice A must not be shown practice B's five pending events");
  assert.equal(seenByA.dead, 0, "nor B's dead letters, which A could not retry even if it tried");
  assert.equal(seenByB.pending, 5);
  assert.equal(seenByB.dead, 2);
});

test("the oldest-pending timestamp is this practice's oldest, not the deployment's", dbTest, async () => {
  /**
   * The one that turns into a false alarm. Readiness computes lag from this and returns 503 above a
   * threshold, so a neighbour's week-old stuck event made a clinic whose queue drained in
   * milliseconds fail its own health check — with a message about a stall that was not theirs and
   * an event they cannot see, let alone retry.
   */
  const a = await makePractice("ops-tenancy-old-a");
  const b = await makePractice("ops-tenancy-old-b");
  created.push(a, b);

  await withPractice(b, async () => {
    await requireContext().tx.query(
      `INSERT INTO domain_events
         (id, practice_id, event_type, aggregate_id, payload, occurred_at, attempts,
          published_at, dead_lettered, next_attempt_at)
       VALUES ($1,$2,'test.ops_tenancy',$3,'{"snapshot_version":1}'::jsonb,
               now() - interval '7 days', 0, NULL, false, now())`,
      [randomUUID(), b, randomUUID()]
    );
  });
  await pending(a, 1);

  const seenByA = await withPractice(a, () => outbox().practiceBacklog());
  assert.ok(seenByA.oldestPending, "A does have an event of its own");
  const ageMs = Date.now() - new Date(seenByA.oldestPending!).getTime();
  assert.ok(
    ageMs < 60_000,
    `A's oldest pending event is ${Math.round(ageMs / 1000)}s old — it is being shown B's week-old ` +
      `one, which is how a healthy practice fails its own readiness check`
  );
});

test("the GLOBAL aggregate still exists, and still sees across tenants — for the watchdog", dbTest, async () => {
  /**
   * The complement, and the reason this is a scoping change rather than a deletion. The outbox
   * worker and the internal watchdog must see every practice: a stalled tenant is invisible from
   * inside any other one, and an alerting mechanism that can only see the tenant asking it is not
   * an alerting mechanism.
   */
  const a = await makePractice("ops-tenancy-global-a");
  const b = await makePractice("ops-tenancy-global-b");
  created.push(a, b);

  await pending(a, 2);
  await pending(b, 2);

  const global = await withoutPractice(() => outbox().backlog());
  const scoped = await withPractice(a, () => outbox().practiceBacklog());

  assert.ok(
    global.pending >= 4,
    "the watchdog must see both practices' events — it is the only thing that can"
  );
  assert.ok(
    global.pending > scoped.pending,
    "and the two answers must genuinely differ here, or this test is proving nothing"
  );
});
