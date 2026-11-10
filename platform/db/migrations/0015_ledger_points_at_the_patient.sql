-- 0015_ledger_points_at_the_patient.sql — M14 part 2. The ledger learns whose money it is.
--
-- ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────────────
-- `ledger_entries.patient_key` is the member ID the claim was filed under. That was the right
-- interim (migration 0013's own comment says so: the identity the money already carries, rather
-- than a second one invented in the ledger) and it has a ceiling — one human with two coverages is
-- two unrelated accounts, and a member-ID change orphans their history. M14 part 1 built the patient
-- master; this points the money at it.
--
-- ── EVERY CHANGE HERE IS ADDITIVE, AND THAT IS THE SAFETY PROPERTY ─────────────────────────────
-- No column is dropped, no column is made NOT NULL, and no existing query changes. A balance is
-- still `sum(amount_cents)` over the same rows grouped the same way, so no balance CAN move as a
-- result of this migration — the unified per-person view is a NEW query alongside, not a
-- redefinition of the old one. That is deliberate: this touches money a patient can be billed for,
-- and the only backfill worth trusting is one that cannot change an answer even if it is wrong.
--
-- Rollback is therefore `UPDATE ledger_entries SET patient_id = NULL` — see
-- `platform/db/backfill-ledger-patients.mjs --rollback`. The column may stay; nothing depends on it
-- being populated.
--
-- ── WHY patient_id IS NOT MADE NOT NULL ────────────────────────────────────────────────────────
-- The unified architecture's step 9 says "nullable → backfill → then enforce", and enforcement here
-- deliberately does NOT mean a NOT NULL constraint. An entry whose member ID has no coverage on
-- file — a payment taken for a patient whose verification predates the patient master, or a manual
-- adjustment against a legacy key — is legitimate money that must still be recordable. A NOT NULL
-- would turn "we could not resolve who this is" into "the front desk cannot take this payment",
-- which is a worse failure than a null.
--
-- Enforcement lives where it belongs instead: the write path always resolves and sets it when a
-- coverage exists, and the unresolved count is a monitored invariant with a test, not a constraint
-- that can refuse a payment.

-- ── 1. The link itself ─────────────────────────────────────────────────────────────────────────
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id);

COMMENT ON COLUMN ledger_entries.patient_id IS
  'The patient this money belongs to. NULL when the member ID could not be resolved to a coverage — '
  'legitimate, and never a reason to refuse an entry. patient_key remains the account key for every '
  'existing query; this exists so one human with several member IDs can be seen as one person.';

-- Grouping a practice's ledger by person is now a first-class read.
CREATE INDEX IF NOT EXISTS idx_ledger_patient ON ledger_entries (practice_id, patient_id)
  WHERE patient_id IS NOT NULL;

-- ── 2. The mapping the backfill resolves through ───────────────────────────────────────────────
--
-- `coverages` has existed since migration 0005 carrying exactly (patient_id, member_id) and has
-- never been written. It is the natural home for "which person does this member ID belong to", and
-- verification is where the two are first seen together.

-- A coverage whose payer is not in the catalog is still a coverage. We know the person and we know
-- their member ID; the payer catalog is separate reference data and must not gate recording a fact
-- about a patient. (`payers` itself stood empty until M12 seeded it.)
ALTER TABLE coverages ALTER COLUMN payer_id DROP NOT NULL;

-- One member ID identifies one person within a practice. This is not a new assumption — it is the
-- one `ledger_entries.patient_key` has been making since migration 0013 by using the member ID as
-- an account key. Stating it as a constraint makes the resolution lookup a single indexed read and
-- makes a violation loud instead of silently merging two people's money.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coverages_practice_member
  ON coverages (practice_id, member_id);
