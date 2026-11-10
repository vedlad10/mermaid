-- 0026 — what a payer actually allows for a procedure, learned from its own remittances.
--
-- ── WHY THIS EXISTS (F-1) ────────────────────────────────────────────────────────────────────────
-- The estimate engine computes insurance and patient shares from the PRACTICE'S BILLED FEE:
--
--     coveredFee   = unitFee * quantity
--     insurancePays = coverage% * (coveredFee - deductible)
--     patientPays   = fee - insurancePays
--
-- For an in-network practice that is wrong twice, in opposite directions. The payer pays a
-- percentage of its CONTRACTED ALLOWED AMOUNT, not of whatever the practice bills, so the insurance
-- figure is overstated. And the difference between the billed fee and the allowed amount is a
-- contractual write-off that nobody owes — quoting it to the patient bills them for money no one
-- will ever collect. On staging the payer's own advice shows $142.50 of exactly this per claim.
--
-- The over-quote is the expensive half. A patient who declines a crown because they were told it
-- costs $71.25 more than it does is revenue the practice never sees and never knows it lost.
--
-- ── WHY THIS IS LEARNED AND NOT ENTERED ──────────────────────────────────────────────────────────
-- The payer states its allowed amount every time it pays. An 835 service line carries the charge and
-- its CAS adjustments, and group CO — "contractual obligation" — is by definition the portion a
-- contracted provider may not bill the patient. So:
--
--     allowed = line charge - (CO adjustments on that line)
--
-- That involves no assumption about anyone's contract. It is the payer's own arithmetic, read back.
-- Asking a practice to key in a fee schedule per payer per code would be hundreds of rows that go
-- stale the first time a contract is renegotiated; this cannot go stale, because it is re-observed
-- on every remittance.
--
-- Deliberately restricted to CO. An OUT-of-network payer reduces a charge under group OA or PR, and
-- that money often IS the patient's — learning from those groups would teach the system that an
-- out-of-network patient owes less than they do, which is the same error pointed the other way.
-- Only CO means "written off by contract", so only CO is evidence of a contracted rate.
--
-- ── WHAT THIS TABLE DOES AND DOES NOT DECIDE ─────────────────────────────────────────────────────
-- It records an observation. It does not change an estimate: nothing reads it yet, and when the
-- estimate does read it, a code with no observation falls back to the billed fee, which is exactly
-- today's behaviour. Adding data changes nothing until a code has been seen.
--
-- It also does not touch the DENIED path. When a covered service is denied outright, whether the
-- patient is liable for the full billed fee or only the contracted allowed amount depends on the
-- provider agreement, and that is a question for the practice rather than an assumption for this
-- schema to bake in.

-- ── WHY THIS IS TENANT-SCOPED WHEN THE PLAYBOOK BESIDE IT IS NOT ────────────────────────────────
-- `payer_playbook_rules` is deliberately global: how often Delta overturns a CO-197 appeal is
-- knowledge every practice should benefit from, and one practice's outcome informs the next.
--
-- A contracted rate is the opposite kind of fact. It is the specific commercial term THIS practice
-- negotiated with THIS payer; the practice down the road has a different one. Sharing it would be
-- wrong twice — it would quote patients from another practice's contract, and it would leak a
-- commercially sensitive term between tenants. So this table is under RLS like clinical data, and
-- the contrast with its neighbour is intentional rather than an oversight.

CREATE TABLE payer_allowed_amounts (
  practice_id     UUID NOT NULL REFERENCES practices(id),
  payer_id        TEXT NOT NULL,
  cdt_code        TEXT NOT NULL,

  -- The most recent observation. A contracted rate is a fact the payer restates on every advice, so
  -- the LATEST reading is the current one — an average would blend a renegotiated rate with the one
  -- it replaced and settle somewhere that was never true.
  allowed_cents   BIGINT NOT NULL CHECK (allowed_cents >= 0),
  -- What the practice billed when that allowance was observed. Kept because the pair is what makes
  -- the observation auditable: "you billed $1,250.00, Delta allowed $1,125.00" is checkable against
  -- the remittance; "$1,125.00" alone is a number with no provenance.
  charged_cents   BIGINT NOT NULL CHECK (charged_cents >= 0),

  -- How many times this payer has stated an allowance for this code, and whether it has ever
  -- disagreed with itself. A rate observed once is usable; a rate that keeps changing is a fact
  -- about the contract that a person should see rather than something to quietly average away.
  observations    INTEGER NOT NULL DEFAULT 1 CHECK (observations > 0),
  distinct_values INTEGER NOT NULL DEFAULT 1 CHECK (distinct_values > 0),

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An allowance above the charge is not a contracted rate, it is a parse fault or a credit; the
  -- estimate must never be handed one, because it would quote insurance paying more than the fee.
  CONSTRAINT allowed_never_exceeds_charged CHECK (allowed_cents <= charged_cents),

  PRIMARY KEY (practice_id, payer_id, cdt_code)
);

SELECT enable_tenant_rls('payer_allowed_amounts');

-- The estimate reads by (payer, code) for every line of a treatment plan, on a screen a patient is
-- waiting at. The primary key already serves it; this index exists for the other direction — "what
-- has this payer allowed across everything", which is how a practice checks a contract.
CREATE INDEX idx_payer_allowed_by_payer ON payer_allowed_amounts (practice_id, payer_id, last_seen_at DESC);
