-- 0010_playbook_posterior.sql — store observations, not a pre-blended rate.
--
-- THE BUG THIS FIXES (seen the first time the loop ran end to end on real data):
--
-- One won appeal moved a code's recovery odds from 30% to 83%. That is not learning, it is
-- overreacting — and a queue that reprioritises the practice's whole day on a single data point is
-- worse than one that never learns at all, because staff will follow it for a week and then stop
-- believing anything it says.
--
-- The cause was a FIXED blend: `0.25 × prior + 0.75 × observed`. With one observation the "observed
-- mean" is necessarily 0 or 1, so 75% of the answer came from a coin flip. The weight given to
-- evidence has to grow WITH the evidence.
--
-- The fix is the standard Beta-Binomial posterior mean, with the prior expressed as pseudo-counts:
--
--     rate = (prior × K + wins) / (K + observations)
--
-- With K = 10 (half the trust threshold), the behaviour is what a clinician would expect:
--     0 outcomes      → the prior, exactly
--     1 win           → 30% becomes ~36%   (a nudge, not a lurch)
--     20 wins         → ~77%               (evidence now dominates)
--     50 wins         → ~88%               (and it still never claims certainty)
--
-- That requires keeping the observations themselves rather than a rate that has already been blended
-- and can no longer be un-blended. So:
--   • `overturn_rate` now means the PRIOR — the starting belief, immutable per rule.
--   • `won_count` + `sample_size` are the evidence.
--   • The posterior is computed on read, where the formula is visible and testable.

ALTER TABLE payer_playbook_rules
  ADD COLUMN IF NOT EXISTS won_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN payer_playbook_rules.overturn_rate IS
  'The PRIOR probability of recovery — a starting belief, not an observation. The rate actually '
  'shown to users is the Beta-Binomial posterior computed from this plus won_count/sample_size.';
COMMENT ON COLUMN payer_playbook_rules.won_count IS
  'Appeals won, out of sample_size recorded outcomes.';

-- Any rate already blended under the old scheme is not recoverable into prior + observations, and
-- there is no production history to preserve — the loop had run exactly once, in development. Reset
-- the learned rules so every rate in the table means the same thing.
UPDATE payer_playbook_rules
   SET sample_size = 0,
       won_count = 0,
       trusted = FALSE
 WHERE sample_size > 0;
