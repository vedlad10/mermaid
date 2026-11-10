-- 0024 — a won appeal is a promise, not a payment.
--
-- ── WHY THIS EXISTS (F-2) ────────────────────────────────────────────────────────────────────────
-- `recordOutcome` writes `status = 'recovered'` and a `recoveredAmount`, and `recovered` is a CLOSED
-- status. So the moment a human records a win the denial leaves every worklist, the Recover queue
-- empties, and the patient record reports money "recovered" beside cash that never arrived. Nothing
-- in the system then tracks that the payer owes it. A staging audit found exactly that: $1,125.00
-- recorded as recovered against $21.49 actually collected, with no receivable, no follow-up, and no
-- screen on which the difference appears.
--
-- This migration adds the vocabulary for the gap between WINNING and BEING PAID. It adds no money
-- and moves no money; the historical conversion is a separate, explicitly-approved backfill.
--
-- ── NO TRANSACTION CONTROL IN THIS FILE ──────────────────────────────────────────────────────────
-- The runner wraps the whole run in one transaction under `pg_advisory_xact_lock`, and
-- `assertRunnerOwnsTransaction` refuses any migration that reintroduces BEGIN/COMMIT. For the same
-- reason the index below is rebuilt the ordinary blocking way rather than the non-blocking variant,
-- which cannot run inside a transaction. See the production-scale note at the foot of this file.

-- ── A. The receivable a won appeal creates ──────────────────────────────────────────────────────
--
-- `claim_expectations` is Remittance's own projection of what a claim was promised, built purely
-- from events (it may not read Claims' tables — docs/MODULE-BOUNDARIES.md). An award is another
-- such promise, so it belongs here beside the estimate rather than in a new table: the ERA matcher
-- already loads this row by control number, so settlement needs no second lookup and no new
-- cross-module read.
--
-- Held SEPARATELY from `expected_insurance_cents` and never added into it. That column is a
-- historical record of what the estimate promised and has to stay readable as exactly that.
--
-- Zero is a safe default here in a way it is not for the nullable `Benefits` figures. Those
-- distinguish "the payer did not state it" from zero; here, *no award outstanding* genuinely IS
-- zero, so absence and zero are the same fact and NOT NULL DEFAULT 0 loses nothing.
ALTER TABLE claim_expectations
  ADD COLUMN award_outstanding_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE claim_expectations
  ADD CONSTRAINT claim_expectations_award_non_negative
    CHECK (award_outstanding_cents >= 0);

COMMENT ON COLUMN claim_expectations.award_outstanding_cents IS
  'Money a payer agreed to pay on appeal and has not yet sent. 0 = nothing outstanding. A posting '
  'matched to a claim with a non-zero value here is compared against THIS figure, not against '
  'expected_insurance_cents — comparing a corrected ERA against the pre-appeal estimate reports a '
  'settlement as an overpayment (L-1). Owned by denials; this column is a projection of '
  'sum(awardedAmount - awardSettledAmount) over that claim''s open awards.';

-- ── B. The two statuses that hold "won" apart from "paid" ───────────────────────────────────────
--
--   awaiting_payment     the payer agreed and has sent nothing yet
--   partially_recovered  the payer sent some of it; the remainder is still owed
--
-- Both are OPEN, so the work stays on the Recover worklist instead of vanishing at the moment it
-- becomes collectable. `recovered` stops meaning "a human said we won" and starts meaning "cash
-- arrived and was posted" — the only transition in this machine that money, rather than a person,
-- is allowed to trigger.
ALTER TABLE denials DROP CONSTRAINT denials_status_check;

ALTER TABLE denials ADD CONSTRAINT denials_status_check
  CHECK (status = ANY (ARRAY[
    'new', 'triaged', 'appealing', 'appealed',
    'awaiting_payment', 'partially_recovered',
    'recovered', 'written_off', 'patient_billed'
  ]));

-- ── C. The work queue has to be able to see the new open states ─────────────────────────────────
--
-- `idx_denials_queue` is PARTIAL on a status list. Left alone, an `awaiting_payment` denial would be
-- invisible to the index that drives the Recover worklist — which is the exact "money disappears
-- from every actionable screen" symptom this migration exists to fix, reintroduced one layer down.
DROP INDEX idx_denials_queue;

CREATE INDEX idx_denials_queue
  ON denials (practice_id, priority DESC, detected_at DESC)
  WHERE status = ANY (ARRAY[
    'new', 'triaged', 'appealing', 'appealed',
    'awaiting_payment', 'partially_recovered'
  ]);

-- `idx_denials_deadline` is deliberately NOT changed. Its predicate covers the statuses where an
-- APPEAL DEADLINE still matters ('new','triaged','appealing'); once an appeal is won the deadline is
-- spent. Award aging is a different clock — and, per the design review, one with no payer-stated due
-- date at all, so it is derived from `awardedAt` rather than stored as a deadline nobody published.

-- ── AT PRODUCTION SCALE THIS FILE WOULD DIFFER ──────────────────────────────────────────────────
-- Three statements above are cheap only because staging holds one denial and ten expectations:
--
--   • ADD CONSTRAINT ... CHECK scans the table under ACCESS EXCLUSIVE. At scale: add it NOT VALID
--     (metadata only), then VALIDATE CONSTRAINT in a separate transaction under SHARE UPDATE
--     EXCLUSIVE, which does not block writers.
--   • Rebuilding the queue index takes ACCESS EXCLUSIVE. At scale both the build and the drop want
--     the non-blocking variants, and neither of those can run inside the runner's transaction — so
--     that rebuild becomes an operational runbook step rather than a migration file.
--   • A long DDL queued behind a long read blocks every writer behind it. At scale set a
--     lock_timeout and retry, so the migration fails fast instead of stalling the application.
--
-- ADD COLUMN ... NOT NULL DEFAULT 0 is metadata-only on PostgreSQL 11+ and needs no such treatment.
--
-- (This note is worded around the runner's own guard: migrate.mjs rejects a file whose TEXT matches
-- the non-transactional-statement pattern, and that check — unlike its comment-aware sibling in
-- sql-transaction-control.mjs — scans the raw string. Spelling those statements out here, even in a
-- comment, is enough to fail the migration.)
