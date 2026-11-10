-- 0003_core_tenancy.sql — Module: platform/auth + platform/config.
-- Practices (tenancy root), staff users, sessions, append-only audit, feature flags.
-- Establishes the auth-vs-RLS pattern: tenant tables are fail-closed under RLS, but the pre-auth
-- lookups (by email at login, by token per request) run through narrow SECURITY DEFINER functions
-- that briefly permit the read, so authentication can find the row that TELLS us the practice.

-- ── Tenancy root (no RLS — this IS the tenant boundary) ─────────────────────────────
CREATE TABLE practices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'pilot',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_practices_updated BEFORE UPDATE ON practices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Staff users ─────────────────────────────────────────────────────────────────────
CREATE TABLE staff_users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id      UUID NOT NULL REFERENCES practices(id),
  email            TEXT NOT NULL UNIQUE,            -- stored lowercased; login resolves the practice
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN
                     ('owner','admin','office_manager','insurance_coordinator',
                      'front_desk','biller','dentist','auditor')),
  password_hash    TEXT NOT NULL,
  disabled         BOOLEAN NOT NULL DEFAULT FALSE,
  reset_token_hash TEXT,
  reset_token_exp  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_staff_users_practice ON staff_users(practice_id);
CREATE TRIGGER trg_staff_users_updated BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Sessions (server-side, hashed token) ────────────────────────────────────────────
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  practice_id UUID NOT NULL REFERENCES practices(id),
  user_id     UUID NOT NULL REFERENCES staff_users(id),
  csrf        TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,                      -- epoch ms
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ── Feature flags (per-practice override; practice_id NULL = platform-wide default) ──
CREATE TABLE feature_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID REFERENCES practices(id),
  flag        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_feature_flags_practice ON feature_flags(practice_id, flag) WHERE practice_id IS NOT NULL;
CREATE UNIQUE INDEX uq_feature_flags_global   ON feature_flags(flag) WHERE practice_id IS NULL;
CREATE TRIGGER trg_feature_flags_updated BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Append-only audit (HIPAA §164.312(b); breach-notification readiness, risk §4) ───
CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  practice_id UUID,                                 -- nullable: some auth events precede a practice
  trace_id    UUID NOT NULL,
  actor_id    UUID,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  before_json JSONB,
  after_json  JSONB,
  outcome     TEXT NOT NULL CHECK (outcome IN ('success','denied','error')),
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_practice ON audit_events(practice_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_events(resource, resource_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────────────
-- staff_users + sessions: tenant-scoped, but permit the narrow pre-auth lookup when the
-- SECURITY DEFINER auth functions below flip the transaction-local `app.auth_lookup` GUC.
CREATE OR REPLACE FUNCTION enable_tenant_rls_authable(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE tbl text := target::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s '
    || 'USING (practice_id = current_practice() OR current_setting(''app.auth_lookup'', true) = ''on'') '
    || 'WITH CHECK (practice_id = current_practice() OR current_setting(''app.auth_lookup'', true) = ''on'')',
    tbl);
END; $$;

SELECT enable_tenant_rls_authable('staff_users');
SELECT enable_tenant_rls_authable('sessions');

-- feature_flags: a practice sees its own rows + the platform-wide (NULL) defaults.
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY flags_read ON feature_flags
  USING (practice_id IS NULL OR practice_id = current_practice())
  WITH CHECK (practice_id = current_practice());   -- app writes only its own practice's overrides

-- audit_events: readable within the practice; INSERT only via record_audit() (append-only).
-- RLS enabled (not forced) so the SECURITY DEFINER writer (owner) can insert; the app role is
-- granted no direct DML on this table (see ops role setup).
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT
  USING (practice_id = current_practice());

-- ── Auth-boundary functions (SECURITY DEFINER; the only readers that bypass tenant scope) ──
CREATE OR REPLACE FUNCTION find_user_for_auth(p_email text)
RETURNS TABLE(id uuid, practice_id uuid, email text, name text, role text,
              password_hash text, disabled boolean, reset_token_hash text, reset_token_exp bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT u.id, u.practice_id, u.email, u.name, u.role,
           u.password_hash, u.disabled, u.reset_token_hash, u.reset_token_exp
      FROM staff_users u WHERE u.email = lower(p_email);
  PERFORM set_config('app.auth_lookup', 'off', true);
END; $$;

CREATE OR REPLACE FUNCTION find_session_for_auth(p_token_hash text)
RETURNS TABLE(token_hash text, practice_id uuid, user_id uuid, csrf text, expires_at bigint,
              role text, name text, email text, disabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT s.token_hash, s.practice_id, s.user_id, s.csrf, s.expires_at,
           u.role, u.name, u.email, u.disabled
      FROM sessions s JOIN staff_users u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash;
  PERFORM set_config('app.auth_lookup', 'off', true);
END; $$;

-- Append-only audit writer. The app calls this; it never INSERTs into audit_events directly.
CREATE OR REPLACE FUNCTION record_audit(
  p_practice_id uuid, p_trace_id uuid, p_actor_id uuid, p_actor_role text,
  p_action text, p_resource text, p_resource_id text,
  p_before jsonb, p_after jsonb, p_outcome text, p_ip text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_events(practice_id, trace_id, actor_id, actor_role, action, resource,
                           resource_id, before_json, after_json, outcome, ip)
  VALUES (p_practice_id, p_trace_id, p_actor_id, p_actor_role, p_action, p_resource,
          p_resource_id, p_before, p_after, p_outcome, p_ip);
END; $$;
