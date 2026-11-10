-- 0034 — when a payer says another plan is involved, that becomes a case someone owns.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
-- A payer signals coordination of benefits two ways — CLP02 19/20 ("forwarded to another payer")
-- and OA-23 money ("the impact of another payer's adjudication"). Mermaid held such an advice, and
-- then let any free-text reason release it. On staging three were released with "Reconciled against
-- the payer's paper EOB", which answers a different question; six more carried $1,527.01 assigned to
-- another plan with no secondary plan recorded anywhere and no work item for anyone to file it; and
-- nothing in the system could say whether a second plan existed, because `coverages.cob_order` is
-- never written and the payers' own other-payer data was not being read.
--
-- ── WHAT A ROW IS ────────────────────────────────────────────────────────────────────────────────
-- One per claim (practice + patient control number): the payer's evidence, a PERSON's answer to
-- "does this patient have another plan" (outcome, source, date, who — never inferred), and the
-- secondary claim that answer leads to. The aggregate lives in `record`, versioned like every other
-- aggregate here; the columns beside it exist to be indexed and constrained.
--
-- `work_status` is DERIVED by the service from the record on every write, never set on its own, so
-- the index and the document cannot disagree. The CHECKs make an impossible pair unrepresentable:
-- confirmed coverage with no evidence, or evidence with coverage still "unconfirmed".
--
-- ── WHAT IT DELIBERATELY DOES NOT TOUCH ──────────────────────────────────────────────────────────
-- No existing row in any table changes. No coverage row is created and `cob_order` is not written:
-- a confirmed second plan is evidence on the case, and becomes a coverage record only through the
-- ordinary verification of its card. Cases for advices received before this migration are opened by
-- `scripts/sync-coordination-cases.ts`, which is idempotent and reads — never rewrites — remittances.

CREATE TABLE coordination_cases (
  id                      UUID PRIMARY KEY,
  practice_id             UUID NOT NULL REFERENCES practices(id),
  patient_control_number  TEXT NOT NULL,
  coverage_status         TEXT NOT NULL
                            CHECK (coverage_status IN ('unconfirmed', 'no-other-coverage', 'other-coverage')),
  work_status             TEXT NOT NULL
                            CHECK (work_status IN ('not-needed', 'awaiting-coverage', 'ready-to-file',
                                                   'return-to-primary', 'filed', 'closed')),
  -- Money the payer assigned to another plan, as its current word (a rejected copy never counts).
  -- Tracked here, not collected: nothing reads this as cash.
  assigned_cents          BIGINT NOT NULL CHECK (assigned_cents >= 0),
  record                  JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,

  CONSTRAINT coordination_one_case_per_claim UNIQUE (practice_id, patient_control_number),
  CONSTRAINT coordination_cases_record_versioned CHECK (jsonb_has_version(record)),
  CONSTRAINT coordination_confirmed_has_evidence CHECK (
    (coverage_status = 'unconfirmed') = (record->'confirmation' IS NULL OR record->'confirmation' = 'null'::jsonb)
  ),
  -- Money assigned to another plan always has SOME secondary work; no money never does.
  CONSTRAINT coordination_work_matches_money CHECK (
    (assigned_cents = 0 AND work_status IN ('not-needed', 'closed'))
    OR (assigned_cents > 0 AND work_status <> 'not-needed')
  )
);

SELECT enable_tenant_rls('coordination_cases');

-- The two worklists: coverage nobody has answered, and secondary work that is still open.
CREATE INDEX idx_coordination_unconfirmed
  ON coordination_cases (practice_id, created_at)
  WHERE coverage_status = 'unconfirmed';
CREATE INDEX idx_coordination_open_work
  ON coordination_cases (practice_id, work_status)
  WHERE work_status IN ('awaiting-coverage', 'ready-to-file', 'return-to-primary', 'filed');

CREATE TRIGGER trg_coordination_cases_updated BEFORE UPDATE ON coordination_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
