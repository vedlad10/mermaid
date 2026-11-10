-- 0029 — every payer reimbursement that did not arrive over ACH.
--
-- ── WHY THIS EXISTS (F1) ─────────────────────────────────────────────────────────────────────────
-- A payer reimbursing by virtual credit card hands the practice a 16-digit number to run through a
-- card terminal. The merchant processor then takes its percentage — commonly 2.5–3.5% — out of money
-- the practice had already earned, on a claim the payer had already discounted to a contracted rate.
--
-- Nothing on the remittance says this happened. The advice balances, the claims post, and the fee is
-- taken somewhere else entirely: in a merchant statement nobody reconciles against an 835. So the
-- leak is invisible precisely because every individual part of it looks correct.
--
-- ── WHY THE RULE IS "NOT ACH" AND NOT "IS A CARD" ────────────────────────────────────────────────
-- There is no virtual-card payment method code. BPR04 in 835 v5010 carries ACH, CHK, FWT, BOP and
-- NON — CMS says so explicitly in the Guidance Letter 2022-04 FAQ, noting the standard has codes for
-- ACH, check and wire "but not by VCC". A payer paying by card therefore has nowhere honest to put
-- it and files it under one of the others. A card cannot be detected by looking for itself; it is
-- only detectable as the ABSENCE of ACH.
--
-- That is why this table stores the method verbatim rather than a boolean. "Not ACH" is the trigger;
-- WHICH not-ACH it was is what a biller needs to open the conversation with the payer.
--
-- ── WHY ONE ROW PER REMITTANCE, RATHER THAN A RUNNING TOTAL PER PAYER ────────────────────────────
-- Because the remittance id is what makes this idempotent. One payment posts once
-- (`remittances_one_per_dedupe_key`), so one payment produces at most one row here, and a redelivered
-- event collides with the primary key instead of counting a second fee. A per-payer counter would
-- have to be incremented, and an increment on an at-least-once bus double-counts the moment anything
-- retries — the exact failure `payer_allowed_amounts` avoids by assigning rather than adding.
--
-- The per-payer view a practice actually reads is an aggregate over these rows, computed on the way
-- out. That keeps the stored fact auditable ("this specific payment, on this date, by cheque") while
-- the rollup stays a query concern.
--
-- ── WHY THE FEE IS NULLABLE ──────────────────────────────────────────────────────────────────────
-- The cost is `payment × the practice's own merchant discount rate`, and that rate lives on a
-- merchant statement this system has never seen. Unset, the column is NULL — not a default of 3%.
-- A plausible figure is indistinguishable on a screen from a measured one, and a biller cannot argue
-- with a payer using a number this system invented. Detection never depends on knowing the price.
--
-- ── TENANT-SCOPED, LIKE THE ALLOWED AMOUNTS BESIDE IT ────────────────────────────────────────────
-- What one practice's processor charges it, and which payers pay it by card, are that practice's
-- commercial facts. Same reasoning as migration 0026, same RLS.

CREATE TABLE payer_payment_method_observations (
  practice_id         UUID NOT NULL REFERENCES practices(id),

  -- The payment this observation is about. One payment, one row — this is the idempotency.
  remittance_id       UUID NOT NULL,

  -- Carried as provenance rather than as a key. It is payer-qualified (migration 0020), so a
  -- consumer that sees the same value twice is looking at a redelivery and not at a second fee.
  dedupe_key          TEXT NOT NULL,

  -- The payer as it named itself on the advice. This, not a slug: an EFT enrolment is filed with
  -- whoever printed their name in the BPR, and that is the entity a biller has to telephone.
  payer_name          TEXT NOT NULL,

  -- BPR04 verbatim, upper-cased. Never a boolean — see above.
  method              TEXT NOT NULL,

  payment_total_cents BIGINT NOT NULL CHECK (payment_total_cents > 0),

  -- NULL means "the practice has not stated its merchant rate", never "free". A zero here is a real
  -- statement by a practice whose processor charges nothing for these.
  fee_cents           BIGINT NULL CHECK (fee_cents IS NULL OR fee_cents >= 0),

  -- This payer paid by ACH before and has stopped. The documented re-enrolment pattern: a fresh card
  -- product months after an opt-out re-enrols anyone whose staff simply processes it. It is a
  -- separate and louder fact than a first sighting, because no human catches it unaided across
  -- hundreds of remittances.
  reverted            BOOLEAN NOT NULL DEFAULT FALSE,

  -- What this payer used last time, when there was a last time. NULL on a first sighting.
  prior_method        TEXT NULL,

  observed_at         TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (practice_id, remittance_id)
);

SELECT enable_tenant_rls('payer_payment_method_observations');

-- The practice-facing question is "which payers are charging me, and how much has it cost" — a
-- rollup per payer, most recent first. Nothing reads this by remittance except the idempotent write,
-- which the primary key already serves.
CREATE INDEX idx_payment_method_by_payer
  ON payer_payment_method_observations (practice_id, payer_name, observed_at DESC);
