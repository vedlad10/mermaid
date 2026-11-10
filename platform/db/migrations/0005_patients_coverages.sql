-- 0005_patients_coverages.sql — Module: verification (owns patients + coverages).
-- The front of the Patient Financial Record spine. Tenant tables → full RLS. The verification
-- record itself and the estimate arrive in 0006 (P2); here we establish patient + coverage identity
-- so both halves of the cycle can reference the same patient.

CREATE TABLE patients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id),
  chart_id    TEXT NOT NULL,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  dob         DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (practice_id, chart_id)
);
CREATE INDEX idx_patients_name ON patients(practice_id, last_name, first_name);
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('patients');

CREATE TABLE coverages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id      UUID NOT NULL REFERENCES practices(id),
  patient_id       UUID NOT NULL REFERENCES patients(id),
  payer_id         UUID NOT NULL REFERENCES payers(id),
  member_id        TEXT NOT NULL,
  group_number     TEXT,
  plan_type        TEXT CHECK (plan_type IN ('PPO','HMO','indemnity') OR plan_type IS NULL),
  cob_order        SMALLINT NOT NULL DEFAULT 1 CHECK (cob_order BETWEEN 1 AND 3),
  effective_date   DATE,
  term_date        DATE,
  -- raw card text is PHI kept for audit/provenance; stored here as text now, moved behind
  -- column encryption (pgcrypto) as part of the pre-PHI encryption task (risk §4). Not logged.
  raw_card_text    TEXT,
  benefit_snapshot JSONB,                            -- versioned when populated (P2)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coverages_snapshot_versioned CHECK (jsonb_has_version(benefit_snapshot))
);
CREATE INDEX idx_coverages_patient ON coverages(patient_id);
CREATE INDEX idx_coverages_payer ON coverages(payer_id);
CREATE TRIGGER trg_coverages_updated BEFORE UPDATE ON coverages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('coverages');
