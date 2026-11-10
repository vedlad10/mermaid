-- 0025 — a posting stops advertising money that has already been recovered.
--
-- ── WHY THIS EXISTS (F-5) ────────────────────────────────────────────────────────────────────────
-- A posting records what the payer said, once, and is immutable by design: "corrections arrive as
-- new postings" (modules/remittance/src/types.ts). That is right, and it is not the problem.
--
-- The problem is that `recoverable_cents` was doing two jobs at once. It recorded the payer's
-- original statement — $1,125.00 withheld under CO-197 — AND it was read as "money still worth
-- chasing". Those diverge the moment a denial is worked: the appeal was won, a corrected remittance
-- paid the $1,125.00 in full, the denial closed as recovered, and the posting still told the Recover
-- worklist there was $1,125.00 to pursue. A staging run reproduced exactly that.
--
-- ── WHY A SECOND COLUMN RATHER THAN OVERWRITING THE FIRST ───────────────────────────────────────
-- Overwriting `recoverable_cents` would make the posting stop being a faithful record of the
-- payer's advice, which is the one thing it exists to be — and it would erase the evidence a human
-- needs to understand a recovery six months later. So what WE resolved is recorded separately from
-- what the PAYER withheld, and the outstanding figure is the difference:
--
--     still recoverable = recoverable_cents - resolved_recoverable_cents
--
-- The payer's statement stays untouched, the worklist becomes correct, and the history of both is
-- readable side by side.
--
-- Additive and reversible: existing rows get 0, which means "nothing resolved yet" — exactly what
-- was true of every posting before this column existed.

ALTER TABLE postings
  ADD COLUMN resolved_recoverable_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE postings
  ADD CONSTRAINT postings_resolved_recoverable_non_negative
    CHECK (resolved_recoverable_cents >= 0);

ALTER TABLE postings
  ADD CONSTRAINT postings_resolved_not_more_than_recoverable
    CHECK (resolved_recoverable_cents <= recoverable_cents);

COMMENT ON COLUMN postings.resolved_recoverable_cents IS
  'How much of this posting''s recoverable amount has since been resolved — recovered in cash, or '
  'otherwise closed out by the denial raised from it. The payer''s own figure stays in '
  'recoverable_cents; the difference is what is still worth chasing. Written by the settlement '
  'subscriber, never by the payer''s advice.';
