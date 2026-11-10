-- 0011_analytics_facts.sql — Module: analytics. An event-sourced fact table.
--
-- WHY A PROJECTION AND NOT A JOIN. The obvious way to report on revenue would be to query the
-- verifications, claims, remittances and denials tables together. Analytics may not do that: a
-- module never reads another module's tables (docs/MODULE-BOUNDARIES.md, enforced in CI). That rule
-- is usually described as protecting a future service split, but here it produces a better design
-- for its own sake — a reporting module that JOINs across four transactional schemas becomes the
-- thing that makes all four of them hard to change.
--
-- So Analytics subscribes to the domain events every other module already publishes and writes one
-- row per business fact. The consequences are all favourable:
--
--   • Reporting queries never touch a transactional table, so a heavy month-end report cannot
--     contend with a clinic filing a claim.
--   • The fact row records what was true WHEN IT HAPPENED. A payer renamed next year does not
--     silently rewrite last year's scorecard.
--   • Adding a metric means replaying events, not migrating a live schema.
--
-- ONE WIDE TABLE rather than a star schema. At the scale this serves — hundreds of practices, a few
-- thousand facts each per year — a single partial-indexed table answers every question in the
-- dashboard with an index scan, and it stays legible. A dimensional model is the right move when a
-- warehouse arrives, and `fact_type` + `meta` are shaped so that extraction is mechanical.

CREATE TABLE analytics_facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     UUID NOT NULL REFERENCES practices(id),

  /**
   * The business event this row records. Deliberately a small, closed vocabulary: every one of these
   * corresponds to a real moment in the revenue cycle that a practice owner would name unprompted.
   */
  fact_type       TEXT NOT NULL CHECK (fact_type IN (
                    'verification_completed',   -- an estimate was produced
                    'verification_flagged',     -- an estimate needed a human
                    'claim_submitted',          -- money was billed
                    'payment_posted',           -- money arrived
                    'denial_created',           -- money was withheld for a reason worth pursuing
                    'appeal_outcome'            -- a recovery attempt resolved
                  )),

  -- When the business event happened, NOT when this row was written. A replayed projection must
  -- reproduce the same report.
  occurred_at     TIMESTAMPTZ NOT NULL,

  -- Dimensions, denormalised on purpose: a fact records the world as it was.
  payer_id        TEXT,
  payer_name      TEXT,
  procedure_code  TEXT,
  carc_code       TEXT,

  -- Correlation, so a fact can be traced back to the aggregate that produced it.
  verification_id UUID,
  claim_id        UUID,
  denial_id       UUID,

  /**
   * Money, in integer cents. Meaning varies by fact_type, which is why both columns exist:
   *   verification_completed → amount = total fee,        expected = expected from insurance
   *   claim_submitted        → amount = billed,           expected = expected from insurance
   *   payment_posted         → amount = actually paid,    expected = what the estimate promised
   *   denial_created         → amount = denied,           expected = expected recovery
   *   appeal_outcome         → amount = recovered,        expected = denied
   */
  amount_cents    BIGINT NOT NULL DEFAULT 0,
  expected_cents  BIGINT NOT NULL DEFAULT 0,

  -- Outcome flag for facts that have one (appeal won/lost).
  won             BOOLEAN,

  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  /**
   * IDEMPOTENCY. The outbox delivers at least once, and a double-counted fact silently corrupts
   * every number on the dashboard — the worst kind of bug, because the report still looks plausible.
   * The source event's id is therefore the natural key.
   */
  source_event_id UUID NOT NULL,
  CONSTRAINT analytics_facts_one_per_event UNIQUE (practice_id, source_event_id, fact_type)
);

-- Every dashboard query is "this practice, this window, optionally this fact type".
CREATE INDEX idx_analytics_window ON analytics_facts (practice_id, occurred_at DESC);
CREATE INDEX idx_analytics_type ON analytics_facts (practice_id, fact_type, occurred_at DESC);
-- The payer scorecard.
CREATE INDEX idx_analytics_payer ON analytics_facts (practice_id, payer_id, occurred_at DESC)
  WHERE payer_id IS NOT NULL;
-- "Which denial reasons cost us the most" — a partial index keeps it proportional to denials, not
-- to all history.
CREATE INDEX idx_analytics_carc ON analytics_facts (practice_id, carc_code, occurred_at DESC)
  WHERE carc_code IS NOT NULL;

SELECT enable_tenant_rls('analytics_facts');
