-- 0012_open_work_indexes.sql — the unified Today queue's read path (M8).
--
-- The Today queue is COMPOSED at request time from each module's own worklist rather than
-- materialised (see apps/web/today.ts for why). That decision is only affordable if "what is still
-- open" is an index scan proportional to the OPEN work, not to all history — otherwise the first
-- screen a clinic opens every morning gets slower every month it is used.
--
-- Verification was the one context that could not express "still open" in SQL at all: its filter
-- only supported an exact status, so the queue read every verification the practice had ever run and
-- discarded the settled ones in TypeScript. That is fixed here and in
-- modules/verification/src/repository.pg.ts.
--
-- WHY THE PREDICATE IS NOT SIMPLY `status <> 'verified'`. A `failed` verification that a human has
-- already REJECTED is finished work — the human-in-the-loop decision was "this is unusable". Only a
-- `failed` verification nobody has looked at still needs a person. The predicate below is the exact
-- SQL twin of `needsAPerson()` in modules/verification/src/repository.ts; if one changes, so must the
-- other, or the index silently stops matching the query and Postgres falls back to a seq scan.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   DROP INDEX IF EXISTS idx_verifications_open;
--   DROP INDEX IF EXISTS idx_postings_actionable_remittance;

CREATE INDEX idx_verifications_open
  ON verifications (practice_id, created_at DESC)
  WHERE status = 'needs_review'
     OR (status = 'failed' AND coalesce(jsonb_typeof(record -> 'review'), 'null') = 'null');

-- The remittance half of the same screen asks "…or posted but still holding money someone owes us",
-- which is an EXISTS correlated on remittance_id (modules/remittance/src/repository.pg.ts). The
-- existing idx_postings_recovery is ordered by posted_at for the recovery queue and cannot serve
-- that lookup; this one can, and stays proportional to actionable postings rather than to all of
-- them.
CREATE INDEX idx_postings_actionable_remittance
  ON postings (remittance_id)
  WHERE actionable;
