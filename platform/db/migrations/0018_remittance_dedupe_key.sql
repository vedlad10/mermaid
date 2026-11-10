-- 0018 — separate the remittance's IDENTITY from its idempotency KEY.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
-- `remittances_one_per_trace UNIQUE (practice_id, trace_number)` is what actually guarantees one
-- payment posts once, and it is load-bearing: the service's check-then-act cannot survive two
-- concurrent ingests of the same re-served ERA, so the constraint is the real guarantee.
--
-- But `trace_number` is NOT NULL and an 835 is allowed to arrive without a TRN. Both such files
-- store the empty string, so the SECOND trace-less remittance a practice ever receives collides
-- with the FIRST — two unrelated payments, one of them permanently un-ingestable. Today that is a
-- loud error in front of a person who re-uploads a file. On the ERA path it is a delivery that
-- fails, retries, exhausts, and lands in a clearinghouse error queue where nobody is looking.
--
-- ── WHY A NEW COLUMN RATHER THAN A PARTIAL INDEX ────────────────────────────────────────────────
-- `UNIQUE (practice_id, trace_number) WHERE trace_number <> ''` would stop the collision, and would
-- also remove idempotency entirely from exactly the files that have no other protection: a payer
-- who re-sends a trace-less remittance would post it twice. Weaker in precisely the case that is
-- already the least safe.
--
-- So identity and idempotency become two columns. `trace_number` keeps carrying what the payer
-- actually said — including nothing, which the safety gate still BLOCKS on — and `dedupe_key`
-- carries the value uniqueness is enforced on. When there is a trace number the two agree. When
-- there is not, the service derives a content hash of the raw 835, so a redelivery of the same file
-- is recognised while a different trace-less file is not mistaken for it.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────────────────────────
-- Existing rows copy `trace_number` verbatim, which is exactly what they were being deduplicated on
-- a moment ago. No row changes meaning and no existing uniqueness is loosened.

ALTER TABLE remittances ADD COLUMN dedupe_key TEXT;

UPDATE remittances SET dedupe_key = trace_number WHERE dedupe_key IS NULL;

ALTER TABLE remittances ALTER COLUMN dedupe_key SET NOT NULL;

-- Order matters: the new guarantee is in place before the old one is dropped, so there is no
-- instant in this transaction where a practice's remittances are unprotected.
ALTER TABLE remittances
  ADD CONSTRAINT remittances_one_per_dedupe_key UNIQUE (practice_id, dedupe_key);

ALTER TABLE remittances DROP CONSTRAINT remittances_one_per_trace;
