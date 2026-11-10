-- 0037 — who looked at this patient.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────────────────────────
-- `audit_events` answers "who CHANGED this, and when": every non-GET request and every sign-in. It
-- deliberately records no reads — its own call site says "PHI access logging is a separate, coarser
-- control and a separate decision" — and that control was never built. So nothing could answer the
-- first question of a privacy complaint or a breach investigation: who OPENED this patient's record?
-- HIPAA's audit-controls standard (45 CFR 164.312(b)) covers activity in systems containing ePHI,
-- not only writes.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- `phi_access_events`: one row per authenticated read of patient-bearing data by a person who is at
-- the screen. Written in the SAME transaction as the read it records, through a SECURITY DEFINER
-- writer, exactly like `record_audit`, so the app role can add rows and never alter or remove them.
--
-- What is NOT written, on purpose:
--   • background polls from a screen nobody has touched for two minutes (the browser reports its
--     idleness, 0036) — a refresh nobody is looking at is not a person viewing a record, and at one
--     a minute per screen it would bury the reads that are;
--   • query strings — a patient search term is itself PHI, and copying it into a log copies the PHI;
--   • reference data and the payer catalog, which carry no patient data.
--
-- `practice_id` has no foreign key, deliberately: the trail must outlive the tenant it describes,
-- as `audit_events` does. Retention follows the practice's records policy (HIPAA documentation is
-- six years); nothing here purges it.
--
-- REVERSAL (forward-only runner; the inverse is stated so it is never guessed):
--   DROP FUNCTION IF EXISTS record_phi_access(uuid, uuid, uuid, text, text, text, text, text);
--   DROP TABLE IF EXISTS phi_access_events;

CREATE TABLE IF NOT EXISTS phi_access_events (
  id          BIGSERIAL PRIMARY KEY,
  practice_id UUID NOT NULL,
  trace_id    UUID NOT NULL,
  actor_id    UUID NOT NULL,
  actor_role  TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  route       TEXT NOT NULL,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phi_access_recent   ON phi_access_events (practice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phi_access_resource ON phi_access_events (practice_id, resource, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phi_access_actor    ON phi_access_events (practice_id, actor_id, created_at DESC);

COMMENT ON TABLE phi_access_events IS
  'Who read patient-bearing data, and when (45 CFR 164.312(b)). Append-only: written only through '
  'record_phi_access(), readable only within the practice. Background polls from an untouched screen '
  'and query strings are deliberately not recorded. No FK on practice_id: the trail outlives the tenant.';

-- Readable within the practice; no INSERT/UPDATE/DELETE policy at all, so RLS refuses every direct
-- write by the app role. ENABLED, not forced, so the owner-run writer below can insert.
ALTER TABLE phi_access_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phi_access_read ON phi_access_events;
CREATE POLICY phi_access_read ON phi_access_events FOR SELECT
  USING (practice_id = current_practice());

CREATE OR REPLACE FUNCTION record_phi_access(
  p_practice_id uuid, p_trace_id uuid, p_actor_id uuid, p_actor_role text,
  p_resource text, p_resource_id text, p_route text, p_ip text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- A request may only write into the trail of the practice whose context it is running in. The
  -- writer bypasses RLS by running as the owner, so this is the check RLS would otherwise make.
  IF p_practice_id IS DISTINCT FROM current_practice() THEN
    RAISE EXCEPTION 'record_phi_access: practice % is not the current practice', p_practice_id;
  END IF;
  INSERT INTO phi_access_events (practice_id, trace_id, actor_id, actor_role, resource, resource_id, route, ip)
  VALUES (p_practice_id, p_trace_id, p_actor_id, p_actor_role, p_resource, p_resource_id, p_route, p_ip);
END; $$;
