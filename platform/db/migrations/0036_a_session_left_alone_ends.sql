-- 0036 — a session left alone ends.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
-- A session had one clock: an absolute expiry, 12 hours after sign-in (SESSION_TTL_HOURS). Nothing
-- measured whether anybody was still there. A front-desk workstation left signed in at 9am kept a
-- live session, and whatever patient was on screen, until 9pm. HIPAA's automatic-logoff safeguard
-- (45 CFR 164.312(a)(2)(iii)) exists for exactly that workstation.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- `sessions.last_seen_at` — epoch ms of the last USER activity the session saw. Not the last
-- request: the Today and Ops screens poll every minute, and counting a poll as presence would keep
-- an unattended screen signed in forever. The client reports how long it has been since a real key
-- or pointer input, and the server records activity at `now - that`. See `idleDecision`.
--
-- NULL for sessions that predate this column; the lookup reads those as `created_at`, so an old
-- session is judged from when it began rather than treated as fresh.
--
-- `find_session_for_auth` returns the column. Its result type changes, which CREATE OR REPLACE
-- cannot do, so it is dropped and recreated with the same body, ownership and SECURITY DEFINER.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   recreate find_session_for_auth from 0003 (DROP, then CREATE without last_seen_at);
--   ALTER TABLE sessions DROP COLUMN IF EXISTS last_seen_at;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;

COMMENT ON COLUMN sessions.last_seen_at IS
  'Epoch ms of the last USER activity this session saw (a key or pointer input the client reported), '
  'never of a background poll. NULL predates 0036 and reads as created_at. A session idle longer than '
  'SESSION_IDLE_MINUTES is deleted on its next use.';

DROP FUNCTION IF EXISTS find_session_for_auth(text);

CREATE FUNCTION find_session_for_auth(p_token_hash text)
RETURNS TABLE(token_hash text, practice_id uuid, user_id uuid, csrf text, expires_at bigint,
              role text, name text, email text, disabled boolean, last_seen_at bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);
  RETURN QUERY
    SELECT s.token_hash, s.practice_id, s.user_id, s.csrf, s.expires_at,
           u.role, u.name, u.email, u.disabled,
           COALESCE(s.last_seen_at, (extract(epoch FROM s.created_at) * 1000)::bigint)
      FROM sessions s JOIN staff_users u ON u.id = s.user_id
     WHERE s.token_hash = p_token_hash;
  PERFORM set_config('app.auth_lookup', 'off', true);
END; $$;
