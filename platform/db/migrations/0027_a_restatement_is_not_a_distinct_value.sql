-- 0027 — name the column for what it actually counts.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
-- `payer_allowed_amounts.distinct_values` does not count distinct values. `foldObservation`
-- increments it whenever an observation DIFFERS FROM THE PREVIOUS ONE, so a payer that alternates
-- between two rates — $1,000.00, $1,050.00, $1,000.00 — records three, and there are two.
--
-- The count it keeps is the useful one: oscillation is instability, and a rate that keeps moving is
-- exactly what a practice needs to know about before quoting a patient from it. What was wrong was
-- the NAME, and a name that lies about its own arithmetic is how the next person to read it computes
-- something else. `restatements` is what the payer did: it said something different from last time.
--
-- ── WHY NOW ─────────────────────────────────────────────────────────────────────────────────────
-- The table is empty. 0026 shipped hours ago and no remittance has posted against it yet, so this
-- rename costs nothing today and would cost a data migration on a live fee schedule later. A wrong
-- name is cheapest to fix in the window where nobody depends on it.

ALTER TABLE payer_allowed_amounts RENAME COLUMN distinct_values TO restatements;

-- The CHECK travels with the column, but its NAME does not — Postgres keeps the old constraint name
-- through a rename, which would leave `..._distinct_values_check` describing a column that no longer
-- exists. Renamed too, so a constraint violation names something a reader can find.
ALTER TABLE payer_allowed_amounts
  RENAME CONSTRAINT payer_allowed_amounts_distinct_values_check TO payer_allowed_amounts_restatements_check;

COMMENT ON COLUMN payer_allowed_amounts.restatements IS
  'How many times this payer has stated an allowance DIFFERENT from the one before it. One means the rate has never moved. Rising means the contracted rate is unstable and quotes built on it are guesses.';
