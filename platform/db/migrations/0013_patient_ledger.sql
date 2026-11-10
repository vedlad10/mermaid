-- 0013_patient_ledger.sql — Module: patient-ledger (M9). The patient's half of every dollar.
--
-- WHY AN APPEND-ONLY LEDGER AND NOT A BALANCE COLUMN. The obvious shape is `patients.balance_cents`,
-- incremented and decremented. It is the wrong one for money a person will be asked to pay: when a
-- patient disputes a statement, the only useful answer is HOW THE NUMBER WAS ARRIVED AT, and a
-- mutable total cannot produce one. Every movement is therefore an immutable row and the balance is
-- a fold over them.
--
-- WHY THIS ONE IS RELATIONAL WHILE EVERY OTHER MODULE STORES A JSONB AGGREGATE. A ledger entry is not
-- an aggregate — it is written once, never updated, and the questions asked of it are relational
-- ("everything for this patient", "every account still owing"). Columns also let the database enforce
-- the two things that actually matter here rather than leaving them to convention.

CREATE TABLE ledger_entries (
  id            UUID PRIMARY KEY,
  practice_id   UUID NOT NULL REFERENCES practices(id),

  /**
   * The account key: the member ID the claim was filed under.
   *
   * This is the patient identity that travels with the money from verification through to the
   * payer's advice. A practice-management system would key on its own patient record; this system
   * does not create one (`patients` exists and nothing writes it), and inventing a second identity
   * here would be worse than using the one the money already carries. When the patient master is
   * populated this becomes a FK and the member ID becomes an attribute of it.
   */
  patient_key   TEXT NOT NULL,
  -- Denormalised on purpose, like a payer name on an analytics fact: a statement reprinted next year
  -- must read the way it read when it was issued.
  patient_name  TEXT NOT NULL,

  kind          TEXT NOT NULL CHECK (kind IN ('charge','payment','adjustment','writeoff')),

  /**
   * SIGNED integer cents: a charge is positive, everything that reduces a balance is negative. The
   * balance is then `sum(amount_cents)` rather than a switch statement someone will one day add a
   * case to and forget to negate — and the CHECK below means no row can silently violate it.
   */
  amount_cents  BIGINT NOT NULL,
  CONSTRAINT ledger_sign_matches_kind CHECK (
    (kind = 'charge' AND amount_cents > 0) OR (kind <> 'charge' AND amount_cents < 0)
  ),

  -- The business moment, not the write time: a redelivered event can be written after a later one.
  occurred_at   TIMESTAMPTZ NOT NULL,
  description   TEXT NOT NULL,

  -- Provenance, so any line on a statement can be traced back to the claim that caused it.
  claim_id      UUID,
  denial_id     UUID,

  /**
   * IDEMPOTENCY. The id of the thing that caused this entry ('posting:<uuid>', 'denial:<uuid>').
   *
   * The outbox delivers at least once. A double-charged patient is the single worst failure this
   * product can produce: unlike a wrong dashboard figure it does not stay inside the building, it
   * goes out as a demand for money the patient does not owe. So the guarantee lives here, in a
   * unique index, not in a service check two concurrent workers can both pass.
   *
   * NULL for entries a human created. A second payment from the same patient is a second payment,
   * not a redelivery — which is why the index below is PARTIAL rather than a plain UNIQUE (in
   * Postgres, NULLs would not conflict anyway, but stating it explicitly keeps the intent readable).
   */
  source_ref    TEXT,

  -- Never 'system' for money leaving a balance; the service refuses an unattributed reduction.
  recorded_by   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_ledger_source ON ledger_entries (practice_id, source_ref)
  WHERE source_ref IS NOT NULL;

-- The statement screen: one patient's entries, oldest first.
CREATE INDEX idx_ledger_patient ON ledger_entries (practice_id, patient_key, occurred_at);
-- The A/R aging screen and the Today queue both scan the practice's charges by age.
CREATE INDEX idx_ledger_aging ON ledger_entries (practice_id, occurred_at)
  WHERE kind = 'charge';

SELECT enable_tenant_rls('ledger_entries');

/**
 * Patient identity travels with the money.
 *
 * `claim_expectations` is the ledger Remittance compares every payment against. It knew what was
 * promised and by whom, but not FOR WHOM — so when a payer assigned part of the bill to the patient,
 * there was no way to say which patient without asking the Claims module, which no module may do.
 *
 * Existing rows are backfilled to empty strings rather than left NULL: a missing member ID means the
 * ledger cannot attribute a charge, and the service already treats that as "skip", so an empty
 * string and a NULL behave identically while the NOT NULL keeps every new row honest.
 */
ALTER TABLE claim_expectations
  ADD COLUMN member_id    TEXT NOT NULL DEFAULT '',
  ADD COLUMN patient_name TEXT NOT NULL DEFAULT '';

/**
 * Analytics gains the patient side of the money.
 *
 * Adding fact types is a CHECK change rather than a new table precisely because 0011 chose one wide
 * fact table: a new metric is a new vocabulary word, not a schema migration of live data.
 */
ALTER TABLE analytics_facts DROP CONSTRAINT analytics_facts_fact_type_check;
ALTER TABLE analytics_facts ADD CONSTRAINT analytics_facts_fact_type_check
  CHECK (fact_type IN (
    'verification_completed',
    'verification_flagged',
    'claim_submitted',
    'payment_posted',
    'denial_created',
    'appeal_outcome',
    'patient_charged',      -- money moved onto a patient's account
    'patient_collected'     -- the patient paid, or the practice forgave it
  ));

-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   ALTER TABLE claim_expectations DROP COLUMN member_id, DROP COLUMN patient_name;
--   DELETE FROM analytics_facts WHERE fact_type IN ('patient_charged','patient_collected');
--   ALTER TABLE analytics_facts DROP CONSTRAINT analytics_facts_fact_type_check;
--   ALTER TABLE analytics_facts ADD CONSTRAINT analytics_facts_fact_type_check
--     CHECK (fact_type IN ('verification_completed','verification_flagged','claim_submitted',
--                          'payment_posted','denial_created','appeal_outcome'));
--   DROP TABLE ledger_entries;
