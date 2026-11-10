-- 0004_payer_profile.sql — Module: payer-profile.
-- The shared "brain" (roadmap §2). Payers and playbook rules are GLOBAL reference data — not
-- tenant-scoped — matching the source-of-truth roadmap schema: one payer catalog, one set of
-- CARC×CDT rules whose overturn_rate/sample_size accumulate across the platform. The small-sample
-- sanity gate (blueprint doc 11; HITL §9) is what protects a rule from being swung by one practice's
-- outlier outcome before it is trusted broadly. (Per-practice overlays can be layered later without
-- schema change to these tables.)

CREATE TABLE payers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  edi_payer_id       TEXT,                          -- clearinghouse payer code
  filing_window_days INTEGER NOT NULL DEFAULT 365,
  appeal_window_days INTEGER NOT NULL DEFAULT 90,
  avg_days_to_pay    INTEGER NOT NULL DEFAULT 21,
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payers_name ON payers(name);
CREATE TRIGGER trg_payers_updated BEFORE UPDATE ON payers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payer_playbook_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id          UUID REFERENCES payers(id),     -- NULL = default rule for any payer
  carc_code         TEXT NOT NULL,
  cdt_code          TEXT,                            -- NULL = applies to any procedure
  disposition       TEXT NOT NULL,                   -- appeal | write_off | rebill | patient_resp | post_normal
  recommended_action TEXT NOT NULL DEFAULT '',
  guidance          TEXT NOT NULL DEFAULT '',
  overturn_rate     NUMERIC(4,3) NOT NULL DEFAULT 0.400,
  sample_size       INTEGER NOT NULL DEFAULT 0,      -- drives the small-sample sanity gate
  trusted           BOOLEAN NOT NULL DEFAULT FALSE,  -- promoted past the sanity gate (doc 11)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_playbook_lookup ON payer_playbook_rules(payer_id, carc_code, cdt_code);
CREATE TRIGGER trg_playbook_updated BEFORE UPDATE ON payer_playbook_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No RLS: global reference data, read-shared across practices, writes guarded at the app layer
-- (payers.write permission — owner/admin/office_manager/biller-manager).
