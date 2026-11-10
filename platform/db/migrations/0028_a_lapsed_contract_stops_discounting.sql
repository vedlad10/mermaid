-- 0028 — notice when a payer stops applying the contract we learned from it.
--
-- ── THE DEFECT (F-1 fallout, mine) ──────────────────────────────────────────────────────────────
-- A contracted rate is learned ONLY from a CO adjustment, because only group CO means "the provider
-- may not bill this to the patient". That is right for learning. What was wrong is what happens when
-- the CO stops arriving.
--
-- A practice that leaves a payer's network keeps being paid — at full price, with no contractual
-- reduction at all. `allowedFromLine` correctly returns null for those lines, so nothing is learned;
-- but nothing is UNLEARNED either. The rate observed while in network stays in the table forever,
-- and every future estimate keeps quoting a discount the payer no longer gives. The patient is told
-- they owe less than they do, and finds out after treatment.
--
-- That is the failure F-1 exists to prevent, running in the opposite direction. Absence of a CO
-- adjustment was being treated as "no information" when it is in fact evidence — the same
-- unknown-versus-absence distinction this codebase draws everywhere else.
--
-- ── WHAT THIS COLUMN COUNTS ─────────────────────────────────────────────────────────────────────
-- Consecutive adjudications of this code by this payer that carried NO contractual reduction, since
-- the last one that did. Any CO observation resets it to zero, because the contract is evidently
-- still being applied.
--
-- Consecutive, not cumulative, and that is the whole design: a single full-price line is ordinary —
-- a service outside the agreement, a secondary payer, a plan that covers it differently — and
-- alarming on one would fire constantly. Several in a row, on a code the payer used to discount, is
-- a contract that has lapsed.
--
-- Additive: existing rows get 0, which reads as "the contract has not been contradicted since we
-- learned it" — exactly what was true of every row before this column existed.

ALTER TABLE payer_allowed_amounts
  ADD COLUMN full_price_since INTEGER NOT NULL DEFAULT 0
    CONSTRAINT payer_allowed_amounts_full_price_since_check CHECK (full_price_since >= 0);

COMMENT ON COLUMN payer_allowed_amounts.full_price_since IS
  'Consecutive adjudications of this code carrying NO contractual reduction, since the last one that did. Zero means the contract is still being applied. Rising means it may have lapsed and this rate should not be quoted from.';
