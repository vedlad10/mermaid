-- 0016_the_patient_is_the_spine.sql — M14 deliverable 4. The read paths a patient record needs.
--
-- Deliverables 1–3 made one human one record and pointed the money at it. This adds nothing to the
-- data model: it makes "everything about this person" an index scan instead of a table scan, and it
-- fixes an index that migration 0015 believed it had created and had not.
--
-- ── THE BUG THIS FIXES ─────────────────────────────────────────────────────────────────────────
-- 0015 wrote:
--
--     CREATE INDEX IF NOT EXISTS idx_ledger_patient ON ledger_entries (practice_id, patient_id)
--       WHERE patient_id IS NOT NULL;
--
-- and 0013 had already created an index of that NAME over a different column:
--
--     CREATE INDEX idx_ledger_patient ON ledger_entries (practice_id, patient_key, occurred_at);
--
-- `IF NOT EXISTS` matches on the index NAME, not on its definition, so 0015's statement succeeded
-- and did nothing. Both migrations are recorded as applied and the index the unified per-person
-- balance was supposed to use has never existed — `docs/UNIFIED-ARCHITECTURE.md` says outright that
-- "`idx_ledger_patient` indexes the grouping", and it does not.
--
-- Nothing was broken by it, which is exactly why it survived: the query planner simply fell back to
-- a scan on a table small enough that nobody noticed. It is the quietest possible failure, and the
-- lesson is worth the comment — `IF NOT EXISTS` on a CREATE INDEX makes a name collision silent, so
-- an index added later must never reuse an earlier name.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   DROP INDEX IF EXISTS idx_ledger_patient_id;
--   DROP INDEX IF EXISTS idx_verifications_patient;
--   DROP INDEX IF EXISTS idx_claims_member;

-- ── 1. The unified balance ─────────────────────────────────────────────────────────────────────
-- One human's money across every member ID they have ever held. A distinct name from 0013's, which
-- keys the per-ACCOUNT reads that the statement screen still uses; both are wanted, and this is the
-- one 0015 intended.
CREATE INDEX IF NOT EXISTS idx_ledger_patient_id
  ON ledger_entries (practice_id, patient_id, occurred_at)
  WHERE patient_id IS NOT NULL;

-- ── 2. The verifications on a person's record ──────────────────────────────────────────────────
-- `verifications.patient_id` has existed since 0006 with a comment saying it "becomes NOT NULL when
-- the verification flow writes `patients` rows (it reads them today, it does not create them)".
-- Since M14 part 1 the flow DOES create them, so the column is finally written — and this is the
-- index that makes reading by it worth doing. Still nullable, and deliberately: rows written before
-- the patient master existed carry NULL, and the patient record falls back to matching on the
-- member IDs that person holds rather than pretending those verifications never happened.
CREATE INDEX IF NOT EXISTS idx_verifications_patient
  ON verifications (practice_id, patient_id, created_at DESC)
  WHERE patient_id IS NOT NULL;

-- ── 3. The claims on a person's record ─────────────────────────────────────────────────────────
-- Claims are reached by member ID — the identity that travels with the money from the verification
-- to the payer's advice, and the one `coverages` resolves to a person. `claims` carries no
-- patient_id and needs none: `coverages` is the mapping, and duplicating it into another table
-- would be another place for it to drift.
CREATE INDEX IF NOT EXISTS idx_claims_member
  ON claims (practice_id, member_id, created_at DESC);

-- Denials need no index here. A denial belongs to a CLAIM, `denials.member_id` does not exist as a
-- column (the member ID lives inside the record document), and `idx_denials_claim` from 0008
-- already serves "the denials on these claims" — which is how the patient record reaches them.
