-- 0032 — the jurisdiction a practice is in, and what its processor charges it.
--
-- ── WHY THESE TWO, AND WHY TOGETHER ──────────────────────────────────────────────────────────────
-- Both were read from the ENVIRONMENT, and both are facts about a practice rather than about a
-- deployment. One deployment serving two practices gave them the same answer, and the answer was
-- load-bearing in each case:
--
--   BILLING_PROVIDER_STATE       decides which prompt-pay and recoupment statutes apply (F5). A
--                                group with an Oregon office and a Texas one got one state's law
--                                for both — so either the Oregon practice was told nothing about
--                                takebacks it could dispute, or the Texas one was told about a
--                                window Texas does not grant.
--   MERCHANT_DISCOUNT_RATE_BPS   decides what a non-ACH payment COST (F1). Two practices do not
--                                share a merchant agreement, and quoting one practice's processor
--                                rate on another's payments is an invented figure wearing a real
--                                one's clothes.
--
-- The environment value stays as the FALLBACK, so a single-practice deployment behaves exactly as it
-- did and nothing has to be backfilled before this is safe to apply.
--
-- ── WHY NULL IS A REAL ANSWER IN BOTH COLUMNS ────────────────────────────────────────────────────
-- Not "unset, so use a sensible default". NULL means the practice has not stated it, and both
-- features already know what to do with that: F5 raises no finding for a state it has no verified
-- rule for, and F1 detects the payment but reports its cost as unknown rather than as zero. A
-- default here would turn "we do not know" into a number somebody could act on.
--
-- ── WHY A TABLE AND NOT COLUMNS ON `practices` ───────────────────────────────────────────────────
-- `practices` is the tenant root: it is read by the pre-authentication path and by the outbox worker
-- outside any tenant scope, and it deliberately carries no RLS policy of its own. Settings ARE
-- tenant data — one practice's merchant rate is a commercial term another must never read — so they
-- belong in a table that can be scoped like every other tenant table.

CREATE TABLE practice_settings (
  practice_id                UUID PRIMARY KEY REFERENCES practices(id),

  -- Two-letter state code, upper-cased by the writer. NULL means the practice has not stated one,
  -- which is not the same as being in a state this system has no rule for — both produce no finding,
  -- but only one of them is a question somebody can answer.
  jurisdiction_state         TEXT CHECK (jurisdiction_state IS NULL OR jurisdiction_state ~ '^[A-Z]{2}$'),

  -- Basis points. 295 = 2.95%. Bounded at 100% because a processor taking more than the payment is
  -- not a rate, it is a typo — and this figure multiplies real money on a screen a biller reads.
  merchant_discount_rate_bps INTEGER CHECK (
    merchant_discount_rate_bps IS NULL OR (merchant_discount_rate_bps >= 0 AND merchant_discount_rate_bps <= 10000)
  ),

  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT enable_tenant_rls('practice_settings');

CREATE TRIGGER trg_practice_settings_updated BEFORE UPDATE ON practice_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── A third kind of statutory-clock finding ──────────────────────────────────────────────────────
--
-- F5 has been driven entirely by remittances, so it only ever assessed claims a payer PAID. Every
-- one of the verified statutes requires the payer to pay OR DENY within the window, which means a
-- claim still unanswered at day 60 is already past its deadline — and that claim produces no
-- remittance, so nothing looked at it. The most expensive prompt-pay case was the invisible one.
--
-- ── WHY IT IS A DIFFERENT KIND, AND NOT AN INTEREST FINDING ──────────────────────────────────────
-- Because there is no principal. Interest accrues on the amount ultimately paid, and on an unpaid
-- claim that amount is unknown — the payer has not said what it will allow. Computing interest from
-- the practice's own estimate would be inventing the one figure the demand rests on, which is the
-- error this whole feature is built to avoid.
--
-- So this kind asserts only what is checkable: the statutory deadline has passed and the claim is
-- still unanswered. Its `claimed_cents` is ZERO, and the savings report counts it separately from
-- money — an alert, not an amount. What the practice is exposed to travels in `evidence` where it is
-- labelled as this system's own estimate.
-- ── WHAT `remittance_id` HOLDS FOR THIS KIND ────────────────────────────────────────────────────
-- There is no remittance: the whole point is that the payer never sent one. The column holds the
-- CLAIM id instead, which keeps the primary key doing its job — one deadline finding per claim, so
-- a sweep that runs hourly cannot raise the same alert twice. The column is not renamed because it
-- is the source record the finding was made from in both cases, and renaming a live column to say
-- so would cost more than the sentence you are reading.
ALTER TABLE statutory_clock_findings DROP CONSTRAINT statutory_clock_findings_kind_check;
ALTER TABLE statutory_clock_findings ADD CONSTRAINT statutory_clock_findings_kind_check
  CHECK (kind IN ('prompt-pay-interest', 'recoupment-out-of-time', 'prompt-pay-deadline-passed'));

-- A deadline finding is an alert about a claim, not a claim about money. Nothing may ever write a
-- non-zero amount against one, because a savings report that totalled estimates alongside measured
-- interest would be reporting a figure no payer has agreed and no arithmetic can defend.
ALTER TABLE statutory_clock_findings ADD CONSTRAINT deadline_findings_claim_no_money
  CHECK (kind <> 'prompt-pay-deadline-passed' OR (claimed_cents = 0 AND recovered_cents = 0));
