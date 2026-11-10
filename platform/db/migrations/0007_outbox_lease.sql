-- 0007_outbox_lease.sql — give claimed outbox events a visibility lease.
--
-- THE BUG THIS FIXES (found by tests/db/outbox.test.ts, "SKIP LOCKED lets concurrent workers split
-- a batch without double-processing"):
--
-- `FOR UPDATE SKIP LOCKED` only holds a row for the lifetime of the CLAIMING transaction. The worker
-- deliberately commits that transaction immediately, so it never holds row locks while running
-- handlers — which can be slow, and must not block a second worker's claim. But that means the
-- moment the claim commits, the event is unlocked and still `published_at IS NULL`, so a concurrent
-- worker can claim the very same event and run every handler for it a second time, in parallel.
--
-- SKIP LOCKED alone therefore gives mutual exclusion only while nothing useful is happening. The
-- standard fix is a LEASE: claiming pushes `next_attempt_at` into the future, so the event is
-- invisible to other workers for the lease window while the claimer processes it.
--
--   • Worker crashes mid-handler → the lease expires and the event is retried. Nothing is lost.
--   • Handler is slower than the lease → the event may be redelivered. Handlers are idempotent by
--     contract (at-least-once delivery), so this degrades to duplicate work, never to wrong data.
--
-- The lease replaces the backoff value on a claim; `settle_domain_event` overwrites it on failure
-- with the real backoff, and on success `published_at` takes the row out of contention entirely.

-- The signature changes (a lease argument is added), so the old overload must go rather than linger.
DROP FUNCTION IF EXISTS claim_domain_events(integer);

CREATE OR REPLACE FUNCTION claim_domain_events(p_limit integer, p_lease_seconds integer DEFAULT 60)
RETURNS SETOF domain_events
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE domain_events e
     SET attempts        = e.attempts + 1,
         -- The lease. Until this passes, no other worker's claim query will see the row.
         next_attempt_at = now() + make_interval(secs => p_lease_seconds)
   WHERE e.id IN (
     SELECT c.id
       FROM domain_events c
      WHERE c.published_at IS NULL
        AND c.dead_lettered = false
        AND c.next_attempt_at <= now()
      ORDER BY c.occurred_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
  RETURNING e.*;
$$;
