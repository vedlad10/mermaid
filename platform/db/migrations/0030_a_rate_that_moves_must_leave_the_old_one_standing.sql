-- 0030 — effective-dated rate history, and the variances measured against it.
--
-- ── WHY THIS EXISTS (F2) ─────────────────────────────────────────────────────────────────────────
-- `payer_allowed_amounts` (0026) holds ONE row per (payer, code) carrying the payer's most recent
-- stated allowance. Its fold does this:
--
--     allowed: next.allowed    -- the prior value is discarded
--
-- It keeps a restatement COUNT and throws the prior VALUE away. Which means the single most
-- expensive thing a payer can do to a practice — quietly cut a fee schedule — erases its own
-- evidence. The first advice at the lower figure overwrites the higher one, and from the second
-- advice onward the payer is paying exactly what this system believes it owes. The variance
-- converges to zero at precisely the moment there is something to see.
--
-- A practice cannot argue with a payer from a counter. "You restated this rate twice" is not an
-- appeal. "You allowed $1,125.00 on this code from 2026-03-04 through 2026-08-19, across nine
-- advices, and then paid $980.00 without notice" is an appeal, and it is only sayable if the old
-- figure is still on disk.
--
-- ── WHY A SEPARATE TABLE RATHER THAN A HISTORY COLUMN ON 0026 ────────────────────────────────────
-- 0026 is read by the estimate path's schedule load and by the monitors, and its shape is a promise
-- to both. This is additive: 0026 keeps its row and keeps its fold, unchanged, and this accumulates
-- alongside it. Turning F2 on therefore cannot change a quote, which is what shadow mode has to mean
-- for a table that money is computed from.
--
-- ── WHY AN EPOCH IS NOT JUST A LOG LINE ──────────────────────────────────────────────────────────
-- An append-only log of every observation would preserve the evidence and answer none of the
-- questions. What a biller needs is the PERIOD: one row per stretch over which the payer said the
-- same number. That is what makes a date range provable, and it is what makes "is this claim short?"
-- a single comparison rather than a statistical exercise over a log.
--
-- Status is the judgement, and it is the part that keeps a fee cut from laundering itself into the
-- baseline:
--
--   confirmed  — the current claim about the contract. Every observation is measured against it.
--   candidate  — a figure the payer has stated that disagrees with the confirmed one, waiting for
--                corroboration. It is NOT the baseline. A single differing advice can be a
--                renegotiated schedule or a one-off underpayment, and those have opposite remedies;
--                only repetition separates them. Promoting on first sight would let one short
--                payment redefine "correct" and make the shortfall unrecoverable by arithmetic.
--   superseded — closed. Never deleted, never edited. This is the evidence.
--
-- ── WHY THE PAYER NAME IS STORED SEPARATELY FROM THE PAYER ID ────────────────────────────────────
-- `payer_id` is the slug from the claim's own expectation: who the practice contracted with.
-- `observed_payer_name` is what the 835 actually printed: who adjudicated. Those are normally the
-- same party and the gap between them is a finding in itself — a claim contracted with one payer,
-- returning repriced under another entity's name at a different rate, is a rental network applying
-- its own fee schedule instead of the one the practice signed. Storing only the slug would make the
-- leased-network case undetectable, because the repriced claim looks like an ordinary underpayment
-- from a payer whose rate apparently changed.
--
-- ── SHADOW MODE ──────────────────────────────────────────────────────────────────────────────────
-- Nothing reads `allowed_amount_variances` to make a decision. No estimate consults it, no appeal is
-- generated from it, no money moves. It accumulates so that the classifier can be judged against
-- real traffic before anything is allowed to act on it — which is the only honest way to turn on a
-- detector whose false positives would have a biller phoning payers about money they were paid.
--
-- ── TENANT-SCOPED ────────────────────────────────────────────────────────────────────────────────
-- A contracted rate is the specific commercial term THIS practice negotiated. Sharing an epoch
-- across tenants would quote one practice from another's contract and leak a commercial term.

CREATE TABLE payer_allowed_amount_epochs (
  practice_id         UUID NOT NULL REFERENCES practices(id),
  payer_id            TEXT NOT NULL,
  cdt_code            TEXT NOT NULL,

  -- Monotonic within (practice, payer, code). Epoch 1 is the first rate ever observed.
  seq                 INTEGER NOT NULL CHECK (seq > 0),
  status              TEXT NOT NULL CHECK (status IN ('confirmed', 'candidate', 'superseded')),

  allowed_cents       BIGINT NOT NULL CHECK (allowed_cents >= 0),
  -- The billed fee at the time, kept for the same reason 0026 keeps it: the PAIR is what makes the
  -- observation auditable against the remittance. A rate with no charge beside it is a number with
  -- no provenance, and provenance is the entire product here.
  charged_cents       BIGINT NOT NULL CHECK (charged_cents >= 0),

  -- Advices that stated THIS figure. A candidate supersedes the baseline on reaching the
  -- corroboration threshold; the count is what that decision is made from, and what a person is
  -- shown when asked to believe the rate moved.
  observations        INTEGER NOT NULL DEFAULT 1 CHECK (observations > 0),

  -- The payer name the advice printed, when it printed one. NULL is silence, not evidence of
  -- anything: the leased-network test requires both sides to be present and refuses to fire on an
  -- absent name rather than treat absence as a different entity.
  observed_payer_name TEXT,

  opened_at           TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL,
  -- Set when the epoch is superseded or abandoned. NULL while it is still a live claim about the
  -- contract. This column is the "effective-dated" in effective-dated history.
  closed_at           TIMESTAMPTZ,

  CONSTRAINT allowed_never_exceeds_charged_in_epoch CHECK (allowed_cents <= charged_cents),
  -- A closed epoch has a close date and an open one does not. Without this, a superseded row with a
  -- NULL close date would read as an unbounded period and a date-range claim built from it would be
  -- false in exactly the direction that loses an appeal.
  CONSTRAINT closed_epochs_are_dated CHECK (
    (status = 'superseded' AND closed_at IS NOT NULL) OR
    (status <> 'superseded' AND closed_at IS NULL)
  ),

  PRIMARY KEY (practice_id, payer_id, cdt_code, seq)
);

SELECT enable_tenant_rls('payer_allowed_amount_epochs');

-- Exactly one live baseline per code. The fold maintains this, and the fold is unit-tested — but
-- the fold is one process's opinion and this is the database's, and a second confirmed epoch would
-- mean every comparison silently depends on which row came back first.
CREATE UNIQUE INDEX one_confirmed_epoch_per_code
  ON payer_allowed_amount_epochs (practice_id, payer_id, cdt_code)
  WHERE status = 'confirmed';

-- And at most one candidate waiting, for the same reason: two open candidates is two competing
-- claims about the same contract, and nothing would decide between them.
CREATE UNIQUE INDEX one_candidate_epoch_per_code
  ON payer_allowed_amount_epochs (practice_id, payer_id, cdt_code)
  WHERE status = 'candidate';


-- ── What the comparison found ────────────────────────────────────────────────────────────────────
--
-- One row per (remittance, payer, code) that produced a finding. Keyed on the remittance for the
-- same reason 0029 is: delivery is at-least-once, one payment posts once, and a redelivered
-- observation must collide with its own row rather than become a second shortfall. A practice shown
-- the same $145.00 twice will chase it twice.

CREATE TABLE allowed_amount_variances (
  practice_id         UUID NOT NULL REFERENCES practices(id),
  remittance_id       UUID NOT NULL,
  payer_id            TEXT NOT NULL,
  cdt_code            TEXT NOT NULL,

  -- What it was. See the engine for why the order of these tests is the order of what is provable.
  --   line-underpayment — short of the payer's own confirmed rate, with no better explanation.
  --   leased-network    — repriced by an entity other than the one the practice contracted with.
  --   schedule-drift    — the confirmed rate itself moved, and stayed moved.
  --   abp-downgrade     — paid at the confirmed rate of a named LESSER procedure.
  classification      TEXT NOT NULL CHECK (
    classification IN ('line-underpayment', 'leased-network', 'schedule-drift', 'abp-downgrade')
  ),

  observed_cents      BIGINT NOT NULL CHECK (observed_cents >= 0),
  expected_cents      BIGINT NOT NULL CHECK (expected_cents >= 0),
  -- Stored rather than derived so a row remains readable as it was written, even if the arithmetic
  -- above it is ever changed. Negative is money short; positive is the payer paying more than known.
  delta_cents         BIGINT NOT NULL,

  -- The epoch the comparison was made against, so any finding can be re-derived from the history
  -- rather than taken on trust. A finding that cannot be re-derived is an assertion.
  against_epoch       INTEGER NOT NULL CHECK (against_epoch > 0),
  observed_payer_name TEXT,

  -- Whether this is money to pursue — deliberately NOT inferable from the classification. An
  -- alternate-benefit downgrade is contractual and appealing it loses, though the difference is
  -- billable to the patient; drift upward is a raise. A consumer that read "it has a classification,
  -- so it is a shortfall" would eventually have a biller chase a payer for a raise.
  recoverable         BOOLEAN NOT NULL,
  -- The lesser code whose rate the payment matched. Only ever set for an alternate-benefit
  -- downgrade, and it is the whole evidence for that reading: not "this looks like a downgrade" but
  -- "you paid this code at D2150's rate, to the cent".
  downgraded_to       TEXT,

  detected_at         TIMESTAMPTZ NOT NULL,

  CONSTRAINT downgraded_to_only_on_downgrades CHECK (
    downgraded_to IS NULL OR classification = 'abp-downgrade'
  ),

  PRIMARY KEY (practice_id, remittance_id, payer_id, cdt_code)
);

SELECT enable_tenant_rls('allowed_amount_variances');

-- The two readings a practice actually asks for: "what is outstanding, worst first" and "what has
-- this payer been doing". Partial on `recoverable` because the worklist only ever wants that half,
-- and a downgrade sitting in it is noise a biller has to learn to ignore.
CREATE INDEX idx_allowed_variances_recoverable
  ON allowed_amount_variances (practice_id, detected_at DESC)
  WHERE recoverable;

CREATE INDEX idx_allowed_variances_by_payer
  ON allowed_amount_variances (practice_id, payer_id, cdt_code, detected_at DESC);
