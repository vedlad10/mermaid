-- 0019 — where an ERA comes from, and which practice it belongs to.
--
-- ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────────────────────
-- Everything Mermaid has received until now, it asked for: a 270 goes out and the 271 comes back on
-- the same socket, inside a request that already knows whose it is. An ERA inverts that. A payer
-- releases money on its own schedule, and the file arrives with no session, no user, and no
-- trustworthy statement of which practice it belongs to.
--
-- The tempting answer is to read the payee out of the 835 (loop 1000B N1*PE) and look up the
-- practice. That is exactly wrong. The payee identifier is supplied by whoever wrote the file, so
-- treating it as the tenant SELECTOR means a payer's — or an attacker's — bytes decide which
-- ledger money lands in. Cross-practice posting would then be one malformed file away, and RLS
-- could not help, because the application would have set the practice context itself.
--
-- ── THE ANSWER: THE CREDENTIAL IS THE TENANT ─────────────────────────────────────────────────────
-- Each practice registers its OWN clearinghouse credential. Polling is per-source, and the tenant
-- is whichever practice's credential fetched the artifact — known before a single byte is parsed
-- and not derivable from the payload at all. A file cannot choose its own practice because nothing
-- in the file is ever consulted to make that choice.
--
-- The payee identifier still earns its keep, as a CROSS-CHECK rather than a selector: if the ERA's
-- payee disagrees with the NPI this source registered, the remittance is HELD for a human. That
-- catches the real-world failure — a credential pointed at the wrong Stedi account — without ever
-- letting the payload pick a tenant.
--
-- ── WHY TWO TABLES ───────────────────────────────────────────────────────────────────────────────
-- `era_sources` is configuration: one row per practice, carrying the credential and the cursor.
-- `era_artifacts` is the work ledger: one row per file Stedi has told us about. They are separate
-- because losing an ERA and mis-configuring a practice are different failures. An artifact row is
-- written the moment an id is DISCOVERED — before it is fetched, before it is parsed — so a crash
-- anywhere downstream leaves a durable record that is retried rather than a payment nobody knows
-- was offered.

-- ── Sources ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE era_sources (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        UUID NOT NULL REFERENCES practices(id),
  -- 'stedi' today. Named so a second clearinghouse does not require a schema change.
  vendor             TEXT NOT NULL DEFAULT 'stedi' CHECK (vendor IN ('stedi', 'mock')),
  -- The practice's OWN credential, encrypted at rest with the same AES-GCM envelope as PHI.
  -- This column is the tenant selector; everything else about ERA routing follows from it.
  credential         TEXT NOT NULL,
  -- The practice's NPI, as it should appear in loop 1000B N1*PE. The cross-check, never the
  -- selector. NULL means "not registered", which downgrades the check to a notice rather than
  -- silently passing every file.
  payee_npi          TEXT,
  -- Opaque vendor cursor (Stedi's pageToken). Durable so a restart does not re-walk history or,
  -- worse, skip it.
  cursor             TEXT,
  -- Polling lease + backoff, same mechanics as the outbox: a claimed source is invisible to other
  -- workers until this passes.
  next_poll_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  poll_attempts      INTEGER NOT NULL DEFAULT 0,
  last_polled_at     TIMESTAMPTZ,
  last_error         TEXT,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One source per practice per vendor. A practice with two credentials for one clearinghouse is a
  -- configuration mistake, and it would poll the same account twice.
  CONSTRAINT era_sources_one_per_vendor UNIQUE (practice_id, vendor)
);
CREATE TRIGGER trg_era_sources_updated BEFORE UPDATE ON era_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('era_sources');

-- ── Artifacts ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE era_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        UUID NOT NULL REFERENCES practices(id),
  source_id          UUID NOT NULL REFERENCES era_sources(id),
  -- Stedi's fileExecutionId. The unit of exactly-once: discovery is an upsert on this, so polling
  -- the same window twice cannot enqueue the same file twice.
  file_execution_id  TEXT NOT NULL,
  -- What the vendor told us about it at discovery, for provenance and for triage when a fetch
  -- fails and there is nothing else to look at.
  transaction_id     TEXT,
  processed_at       TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','ingested','failed','held')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead_lettered      BOOLEAN NOT NULL DEFAULT false,
  last_error         TEXT,
  -- How many remittances this artifact produced. A file may carry several cheques.
  remittance_count   INTEGER NOT NULL DEFAULT 0,
  ingested_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE exactly-once guarantee at the artifact layer. Scoped to the practice because two practices
  -- polling two Stedi accounts could in principle be handed the same id namespace.
  CONSTRAINT era_artifacts_one_per_file UNIQUE (practice_id, file_execution_id)
);
CREATE TRIGGER trg_era_artifacts_updated BEFORE UPDATE ON era_artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT enable_tenant_rls('era_artifacts');

CREATE INDEX era_artifacts_work ON era_artifacts (next_attempt_at)
  WHERE status = 'pending' AND dead_lettered = false;

-- ── The worker's narrow, audited holes through RLS ───────────────────────────────────────────────
--
-- Same pattern, and the same justification, as `claim_domain_events` (0006/0007) and
-- `find_user_for_auth` (0003): the poller must see every practice's due work, and a per-practice
-- scan per tick does not scale. These functions are the ONLY thing that sees across tenants. Every
-- byte of fetching, parsing and posting happens afterwards inside set_current_practice(), so all
-- module code stays fully RLS-scoped.
--
-- Note what these deliberately do NOT return: `claim_era_sources` hands back the credential because
-- the caller must authenticate with it, and nothing else about the practice. There is no function
-- here that maps a payee identifier to a practice, because that mapping is precisely what must not
-- exist — see the header.

CREATE OR REPLACE FUNCTION claim_era_sources(p_limit integer, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF era_sources
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE era_sources s
     SET poll_attempts = s.poll_attempts + 1,
         next_poll_at  = now() + make_interval(secs => p_lease_seconds)
   WHERE s.id IN (
     SELECT c.id
       FROM era_sources c
      WHERE c.enabled = true
        AND c.next_poll_at <= now()
      ORDER BY c.next_poll_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
  RETURNING s.*;
$$;

CREATE OR REPLACE FUNCTION claim_era_artifacts(p_limit integer, p_lease_seconds integer DEFAULT 300)
RETURNS SETOF era_artifacts
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE era_artifacts a
     SET attempts        = a.attempts + 1,
         next_attempt_at = now() + make_interval(secs => p_lease_seconds)
   WHERE a.id IN (
     SELECT c.id
       FROM era_artifacts c
      WHERE c.status = 'pending'
        AND c.dead_lettered = false
        AND c.next_attempt_at <= now()
      ORDER BY c.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
  RETURNING a.*;
$$;
