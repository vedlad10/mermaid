-- 0008_denials_appeals.sql — Module: denials-appeals, plus the uniqueness the shared brain needs.
--
-- Completes the revenue cycle's recovery half: a payer withheld money for a reason worth pursuing,
-- and this is where a clinic actually goes and gets it. Denials and appeals are TENANT-SCOPED (a
-- practice's denials are its own); the playbook they consult is GLOBAL (migration 0004), because an
-- overturn rate is only meaningful once it accumulates across many practices.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- The playbook's missing uniqueness
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- 0004 created `payer_playbook_rules` with a lookup index but no UNIQUE constraint, so nothing
-- stopped two rules for the same (payer, code, procedure family) — and the learning writer needs a
-- conflict target to upsert against, or every recorded outcome would append a rule instead of
-- updating one.
--
-- Expression index over COALESCE because both `payer_id` and `cdt_code` are nullable and NULLs do
-- not compare equal: a plain UNIQUE(payer_id, carc_code, cdt_code) would happily admit a hundred
-- identical global rules.
CREATE UNIQUE INDEX uq_playbook_rule
  ON payer_playbook_rules (COALESCE(payer_id::text, ''), carc_code, COALESCE(cdt_code, ''));

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Denials
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- One row per denied REASON, not per claim: a payer can withhold money on one claim for two
-- unrelated codes, and those are two different pieces of work with different dispositions, different
-- evidence and possibly different outcomes. Collapsing them to one row per claim is how a practice
-- ends up appealing a bundling denial with radiographs.

CREATE TABLE denials (
  id                   UUID PRIMARY KEY,
  practice_id          UUID NOT NULL REFERENCES practices(id),

  claim_id             UUID NOT NULL,
  remittance_id        UUID NOT NULL,
  -- The posting this denial was detected on. Together with the reason code it is the idempotency
  -- key: the outbox delivers at least once, and a duplicated denial is duplicated work in a queue
  -- whose entire value is that everything in it is real.
  posting_id           UUID NOT NULL,

  carc_code            TEXT NOT NULL,
  carc_description     TEXT NOT NULL,
  procedure_code       TEXT,
  denied_amount_cents  BIGINT NOT NULL,

  payer_id             TEXT,
  payer_name           TEXT,
  patient_name         TEXT,

  status               TEXT NOT NULL CHECK (status IN
                         ('new','triaged','appealing','appealed','recovered','written_off','patient_billed')),
  disposition          TEXT,
  -- Probability of recovery at triage time, snapshotted. The playbook keeps learning; the number a
  -- human saw when they made a decision must not change underneath them afterwards.
  overturn_rate        NUMERIC(4,3),
  -- 0–100 work ranking: expected value × urgency × actionability.
  priority             INTEGER NOT NULL DEFAULT 0,
  -- The last day this payer will accept an appeal. Missing it is unrecoverable revenue.
  appeal_deadline      DATE,

  record               JSONB NOT NULL,
  detected_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT denials_record_versioned CHECK (jsonb_has_version(record)),
  CONSTRAINT denials_one_per_posting_reason UNIQUE (practice_id, posting_id, carc_code, procedure_code)
);
-- The recovery worklist: open denials, most valuable first.
CREATE INDEX idx_denials_queue ON denials (practice_id, priority DESC, detected_at DESC)
  WHERE status IN ('new','triaged','appealing','appealed');
CREATE INDEX idx_denials_claim ON denials (practice_id, claim_id);
-- Appeal deadlines are the same class of silent revenue loss as timely filing.
CREATE INDEX idx_denials_deadline ON denials (practice_id, appeal_deadline)
  WHERE status IN ('new','triaged','appealing');
CREATE TRIGGER trg_denials_updated BEFORE UPDATE ON denials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('denials');

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Appeals
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- A denial can be appealed more than once (first level, then second level), so appeals are their own
-- rows rather than a column on the denial.

CREATE TABLE appeals (
  id                UUID PRIMARY KEY,
  practice_id       UUID NOT NULL REFERENCES practices(id),
  denial_id         UUID NOT NULL REFERENCES denials(id) ON DELETE CASCADE,

  level             SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  status            TEXT NOT NULL CHECK (status IN ('draft','submitted','won','lost','withdrawn')),

  -- The drafted letter and its evidence checklist. Deterministically generated; an LLM may polish
  -- the prose but never decides the disposition (blueprint doc 10).
  letter            TEXT NOT NULL,
  checklist         JSONB NOT NULL,

  -- The human gate. Null until a person approves it; nothing is ever sent without both.
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ,

  -- The outcome, once known. This is what feeds the learning loop.
  outcome_recorded_at TIMESTAMPTZ,
  recovered_cents   BIGINT,
  outcome_notes     TEXT,

  record            JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT appeals_record_versioned CHECK (jsonb_has_version(record)),
  CONSTRAINT appeals_one_per_level UNIQUE (practice_id, denial_id, level)
);
CREATE INDEX idx_appeals_denial ON appeals (practice_id, denial_id);
CREATE INDEX idx_appeals_open ON appeals (practice_id, created_at DESC)
  WHERE status IN ('draft','submitted');
CREATE TRIGGER trg_appeals_updated BEFORE UPDATE ON appeals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('appeals');
