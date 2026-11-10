-- 0021 — a family shares ONE member id, and that must stop merging them into one person.
--
-- ── WHAT WAS WRONG (NEW-01) ─────────────────────────────────────────────────────────────────────
-- Migration 0015 added:
--
--     CREATE UNIQUE INDEX uq_coverages_practice_member ON coverages (practice_id, member_id);
--
-- and justified it as "One member ID identifies one person within a practice… stating it as a
-- constraint makes a violation loud instead of silently merging two people's money."
--
-- The premise is false for dental insurance, and the constraint produced the exact outcome it was
-- written to prevent. A plan issues ONE member id to the SUBSCRIBER; the spouse and every child are
-- verified under that same id. So the second family member through the door did not add a coverage
-- row — `linkCoverage` writes `ON CONFLICT (practice_id, member_id) DO UPDATE SET patient_id =
-- EXCLUDED.patient_id`, which RE-POINTED the one row at the newly verified child.
--
-- Nothing was loud. There was no violation to raise: the unique index was satisfied at every step.
-- What followed is that `patientIdForMemberId` — the mapping the patient ledger resolves money
-- through — answered with whichever family member was verified most recently. Every ledger entry
-- for the whole family, past and future, resolved to that one person. Two children's balances
-- became one child's balance, and the record of whose it had been was overwritten in place.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- 1. The uniqueness that is actually true: one coverage per (practice, member id, PATIENT). A
--    family may share a member id; one person may not hold the same member id twice.
-- 2. `relationship_to_subscriber`, so the fact is recorded where it is first learned rather than
--    inferred later. Defaults to 'self' — every row written before today was a patient treated as
--    the subscriber, which is exactly what 'self' means, so the backfill is the default.
-- 3. The subscriber's NAME, for the rows where the patient is not the subscriber. An 837D for a
--    dependent must name the policy holder in loop 2010BA, and nothing else in the schema knows it.
--
-- The subscriber's MEMBER ID is deliberately not a column: it is `member_id`, the one already here.
-- A dependent is identified to the payer by the subscriber's policy, which is the whole reason this
-- bug existed. Storing it twice would give it two places to disagree.
--
-- ── WHAT THIS MIGRATION CANNOT DO ───────────────────────────────────────────────────────────────
-- It cannot recover the coverage rows the old constraint destroyed. `DO UPDATE SET patient_id`
-- overwrote them in place; there is no history to read. `platform/db/backfill-dependents.mjs`
-- reconstructs what it can from `verifications`, which recorded a patient_id and a member_id per
-- visit and was never subject to this constraint — run it after this migration. It reports what it
-- could not resolve rather than guessing.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   DROP INDEX IF EXISTS uq_coverages_practice_member_patient;
--   CREATE UNIQUE INDEX uq_coverages_practice_member ON coverages (practice_id, member_id);
--     -- ⚠ will FAIL where a family has been correctly recorded, which is the point.
--   ALTER TABLE coverages DROP COLUMN relationship_to_subscriber,
--                         DROP COLUMN subscriber_first_name,
--                         DROP COLUMN subscriber_last_name,
--                         DROP COLUMN subscriber_dob;

-- ── 1. Uniqueness that matches how plans issue member ids ──────────────────────────────────────
-- Created BEFORE the old one is dropped: the table is never without a uniqueness guarantee, so a
-- concurrent writer cannot slip a genuine duplicate in between the two statements. (Both run inside
-- the runner's single transaction, so this is belt and braces — and it is free.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_coverages_practice_member_patient
  ON coverages (practice_id, member_id, patient_id);

DROP INDEX IF EXISTS uq_coverages_practice_member;

COMMENT ON INDEX uq_coverages_practice_member_patient IS
  'A family shares one member id — the subscriber''s. Uniqueness is per PERSON within that id. The '
  'narrower (practice_id, member_id) index this replaces silently re-pointed a family''s coverage '
  'at whichever member was verified last, merging their money (NEW-01).';

-- ── 2. The relationship, recorded where it is learned ──────────────────────────────────────────
ALTER TABLE coverages
  ADD COLUMN IF NOT EXISTS relationship_to_subscriber TEXT NOT NULL DEFAULT 'self';

-- Added separately from the column so it is named, and so the reversal above can drop it by name.
ALTER TABLE coverages
  DROP CONSTRAINT IF EXISTS coverages_relationship_known;
ALTER TABLE coverages
  ADD CONSTRAINT coverages_relationship_known
  CHECK (relationship_to_subscriber IN ('self', 'spouse', 'child', 'other'));

COMMENT ON COLUMN coverages.relationship_to_subscriber IS
  'X12 element 1069, as Mermaid names it: self (18), spouse (01), child (19), other (G8). Defaults '
  'to self because every row written before dependents were modelled was a patient treated as the '
  'subscriber — which is what self means, so the default IS the backfill.';

-- ── 3. Who holds the policy, when it is not the patient ────────────────────────────────────────
-- Nullable, and must stay nullable: for a subscriber's own coverage there is no other person to
-- name, and a sentinel like the patient's own name would make "is this a dependent" unanswerable.
ALTER TABLE coverages
  ADD COLUMN IF NOT EXISTS subscriber_first_name TEXT,
  ADD COLUMN IF NOT EXISTS subscriber_last_name  TEXT,
  ADD COLUMN IF NOT EXISTS subscriber_dob        DATE;

ALTER TABLE coverages
  DROP CONSTRAINT IF EXISTS coverages_dependent_names_its_subscriber;
ALTER TABLE coverages
  ADD CONSTRAINT coverages_dependent_names_its_subscriber
  CHECK (
    relationship_to_subscriber = 'self'
    OR (subscriber_first_name IS NOT NULL AND subscriber_last_name IS NOT NULL)
  );

COMMENT ON CONSTRAINT coverages_dependent_names_its_subscriber ON coverages IS
  'A dependent''s 837D must name the policy holder in loop 2010BA. Recording the relationship '
  'without the name would produce a coverage that is known to be un-filable only at the submit '
  'gate, months later.';

-- ── 4. The lookup the ledger resolves money through ────────────────────────────────────────────
-- `patientIdForMemberId` can no longer be a single-row read: a member id legitimately returns a
-- whole family now, and the caller must handle that rather than take the first row (which is what
-- `SELECT patient_id FROM coverages WHERE member_id = $1` did — arbitrary, and silently so).
CREATE INDEX IF NOT EXISTS idx_coverages_member
  ON coverages (practice_id, member_id);
