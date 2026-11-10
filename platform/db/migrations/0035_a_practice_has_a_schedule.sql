-- 0035 — a practice has a schedule, and Mermaid can finally see it.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
-- Every screen that should start from the day's patients started from verifications instead,
-- because there was no appointment entity at all. Today's schedule strip (§8.1) and Verify's
-- 14-day coverage-readiness timeline (§8.2) both state that gap in place. The blueprint already
-- names the routes (`GET /api/v1/appointments`, doc 06); this is the table behind them.
--
-- ── WHAT A ROW IS ────────────────────────────────────────────────────────────────────────────────
-- One visit as the practice-management system knows it, keyed by that system's own id: re-importing
-- the same export updates rows rather than duplicating them. `source` is part of the key because
-- two sources (a CSV today, an API later) number their appointments independently.
--
-- The aggregate lives in `record`, versioned like every other aggregate here; `scheduled_for` and
-- `status` sit beside it to be indexed. Planned procedures and their fees are in the record and are
-- the SOURCE's statement — nothing here prices a visit.
--
-- ── WHAT IT DELIBERATELY DOES NOT HOLD ───────────────────────────────────────────────────────────
-- No verification state. Whether a visit is covered is derived on every read from the patient's
-- verifications and the freshness policy, so it can never go stale in a column. And no raw export
-- row: the parsed visit is kept, the file is not.

CREATE TABLE appointments (
  id             UUID PRIMARY KEY,
  practice_id    UUID NOT NULL REFERENCES practices(id),
  patient_id     UUID NOT NULL REFERENCES patients(id),
  source         TEXT NOT NULL CHECK (source IN ('mock', 'csv')),
  external_id    TEXT NOT NULL CHECK (length(btrim(external_id)) > 0),
  scheduled_for  TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no-show')),
  record         JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT appointments_one_per_source_id UNIQUE (practice_id, source, external_id),
  CONSTRAINT appointments_record_versioned CHECK (jsonb_has_version(record))
);

SELECT enable_tenant_rls('appointments');

-- The one query every schedule surface runs: a practice's visits in a time window.
CREATE INDEX idx_appointments_window ON appointments (practice_id, scheduled_for);
CREATE INDEX idx_appointments_patient ON appointments (patient_id);

CREATE TRIGGER trg_appointments_updated BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
