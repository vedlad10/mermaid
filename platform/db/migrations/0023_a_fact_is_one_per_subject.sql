-- 0023 — an analytics fact is one per SUBJECT, not one per event.
--
-- ── WHAT WAS WRONG (NEW-12) ─────────────────────────────────────────────────────────────────────
-- `analytics_facts` is deduplicated by `UNIQUE (practice_id, source_event_id, fact_type)`, which
-- makes it idempotent under the outbox's at-least-once delivery: the same event redelivered writes
-- the same row twice and the second insert does nothing. That is exactly right for redelivery.
--
-- It is not what the numbers need. `VerificationService.review` had no already-settled guard, so
-- re-reviewing a verification that had already settled RE-PUBLISHED `verification.completed` — a
-- NEW event, with a new id, describing the SAME verification. A different source_event_id is a
-- different row, so the funnel counted one visit twice:
--
--   • `billingRate` is claims submitted ÷ verifications completed. The denominator grew and the
--     rate fell, so a practice appeared to be leaving money unbilled that it had in fact billed.
--   • `reviewRate` is flagged ÷ (completed + flagged), and a flagged-then-approved verification
--     produces one of each — so the same visit sat on both sides of its own ratio.
--
-- Nothing was loud. Every number stayed internally consistent, and the only symptom was a rate that
-- drifted in the direction of the practices that use human review most.
--
-- ── WHY A DEDUPE KEY AND NOT SIMPLY KEYING ON THE VERIFICATION ──────────────────────────────────
-- "One fact per subject" is true of some fact types and false of others, and getting that backwards
-- would delete real money from the reports:
--
--   one per subject          several per subject
--   ───────────────────────  ────────────────────────────────────────────────────────────
--   verification_completed   payment_posted    — primary and secondary payers both pay one claim
--   verification_flagged     appeal_outcome    — a denial can be appealed at two levels
--   denial_created           patient_charged   — a patient is charged many times
--                            patient_collected
--
-- So the KEY is stated by whoever records the fact, rather than derived here from a column. A
-- subscription that knows its fact is one-per-subject says so; one that does not falls back to the
-- source event, which is the behaviour every fact type has today.
--
-- ── THE BACKFILL IS THE OLD BEHAVIOUR, EXACTLY ──────────────────────────────────────────────────
-- Existing rows get `fact_type:source_event_id`, which is precisely the tuple the old constraint
-- enforced. No existing row can collide, no report changes on deploy, and the only thing that
-- changes is what a FUTURE duplicate does.
--
-- The old constraint stays. It is strictly weaker than the new one for the fact types that now
-- carry a subject key, and still the operative one for those that do not; dropping it would remove a
-- guarantee to add one.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   DROP INDEX IF EXISTS uq_analytics_facts_dedupe;
--   ALTER TABLE analytics_facts DROP COLUMN IF EXISTS dedupe_key;

ALTER TABLE analytics_facts
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Every existing row, keyed exactly as the old constraint keyed it.
UPDATE analytics_facts
   SET dedupe_key = fact_type || ':' || source_event_id::text
 WHERE dedupe_key IS NULL;

ALTER TABLE analytics_facts
  ALTER COLUMN dedupe_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_facts_dedupe
  ON analytics_facts (practice_id, dedupe_key);

COMMENT ON COLUMN analytics_facts.dedupe_key IS
  'What makes this fact unique within a practice. `verification:<id>` for the types where one '
  'subject produces exactly one fact; `<fact_type>:<source_event_id>` for the types where a subject '
  'legitimately produces several (a claim paid by two payers, a denial appealed twice). Stated by '
  'the recorder rather than derived here, because which of the two applies is a fact about the '
  'event, not about the table (NEW-12).';
