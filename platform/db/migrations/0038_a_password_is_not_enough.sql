-- 0038 — a password is not enough.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
-- Signing in to a system holding every patient's coverage, claims and payments took an email and a
-- password, and nothing else. A password reused from a breached site, or typed into a phishing page,
-- was the whole of the defence. Credential compromise is the commonest way into a healthcare system,
-- and HHS's proposed Security Rule update makes multi-factor authentication a requirement rather
-- than an addressable choice.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- Time-based one-time passwords (RFC 6238 — any authenticator app), with single-use recovery codes.
--
-- staff_users:
--   mfa_secret          the TOTP secret, ENCRYPTED and bound to this row (platform/crypto `v2:`)
--   mfa_pending_secret  an enrolment in progress, not yet proven by a code; same encryption
--   mfa_enabled_at      when the person proved they hold the secret; NULL = MFA off
--   mfa_last_step       the last accepted 30-second step, so a code signs in ONCE
--   mfa_recovery_hashes SHA-256 of the unused recovery codes; a used one is removed
--
-- sessions:
--   mfa_pending         TRUE between a correct password and a correct code. The guard refuses such a
--                       session everywhere except the second step, and it lives five minutes.
--   mfa_attempts        wrong codes against it; the fifth ends it.
--
-- `find_user_for_auth` says whether MFA is on; `find_session_for_auth` says whether the session is
-- still waiting for its second factor. Both change result type, so both are dropped and recreated.
--
-- REVERSAL (forward-only runner; the inverse is stated so it is never guessed):
--   recreate both functions from 0003 / 0036;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_pending, DROP COLUMN IF EXISTS mfa_attempts;
--   ALTER TABLE staff_users DROP COLUMN IF EXISTS mfa_secret, ... mfa_recovery_hashes;

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS mfa_secret          TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_secret  TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_last_step       BIGINT,
  ADD COLUMN IF NOT EXISTS mfa_recovery_hashes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN staff_users.mfa_secret IS
  'TOTP secret (base32), encrypted at rest and bound to this row. NULL with mfa_enabled_at NULL = MFA off.';
COMMENT ON COLUMN staff_users.mfa_last_step IS
  'Last accepted TOTP step (unix seconds / 30). A code at or before it is refused, so one code signs in once.';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mfa_pending  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_attempts INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN sessions.mfa_pending IS
  'Password proven, second factor not yet. Refused by the guard everywhere but the MFA step; five-minute life.';

DROP FUNCTION IF EXISTS find_user_for_auth(text);
CREATE FUNCTION find_user_for_auth(p_email text)
RETURNS TABLE(id uuid, practice_id uuid, email text, name text, role text,
              password_hash text, disabled boolean, reset_token_hash text, reset_token_exp bigint,
              mfa_enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT u.id, u.practice_id, u.email, u.name, u.role,
           u.password_hash, u.disabled, u.reset_token_hash, u.reset_token_exp,
           u.mfa_enabled_at IS NOT NULL
      FROM staff_users u WHERE u.email = lower(p_email);
  PERFORM set_config('app.auth_lookup', 'off', true);
END; $$;

DROP FUNCTION IF EXISTS find_session_for_auth(text);
CREATE FUNCTION find_session_for_auth(p_token_hash text)
RETURNS TABLE(token_hash text, practice_id uuid, user_id uuid, csrf text, expires_at bigint,
              role text, name text, email text, disabled boolean, last_seen_at bigint,
              mfa_pending boolean, mfa_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT s.token_hash, s.practice_id, s.user_id, s.csrf, s.expires_at,
           u.role, u.name, u.email, u.disabled,
           COALESCE(s.last_seen_at, (extract(epoch FROM s.created_at) * 1000)::bigint),
           s.mfa_pending, s.mfa_attempts
      FROM sessions s JOIN staff_users u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash;
  PERFORM set_config('app.auth_lookup', 'off', true);
END; $$;
