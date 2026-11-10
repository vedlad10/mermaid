-- 0031 — when the practice was paid, and what the law says about how late it was.
--
-- ── WHY THIS EXISTS (F5) ─────────────────────────────────────────────────────────────────────────
-- Two statutory clocks run on every paid claim and nothing in this system was reading either.
--
--   PROMPT PAY  — a payer that takes longer than the statute allows to pay a CLEAN claim owes simple
--                 interest on it. Most never volunteer it, and no remittance, report or aging bucket
--                 records the obligation, because the only evidence of it is date arithmetic nobody
--                 performs. The money is real and it is invisible.
--   RECOUPMENT  — a payer may only claw back a past payment for so long. Texas gives 180 days,
--                 Louisiana 18 months, New York 24. A PLB `WO` arriving after the window is a
--                 takeback the practice can demand back — and today it is simply deducted, balanced
--                 against the advice, and reconciled without comment.
--
-- ── WHY A SEPARATE PAYMENT INDEX ─────────────────────────────────────────────────────────────────
-- The recoupment window is measured from the day the practice was PAID, and a takeback arriving
-- today names a claim that may have been paid two years ago. Answering "when were we paid for
-- control number MRM-000123?" from `remittances` means reading whole aggregates, each carrying its
-- postings and an ENCRYPTED raw 835 — decrypting a practice's entire payment history to read one
-- date per claim is the cost that gets a feature deleted. So the clock keeps its own narrow index:
-- control number, payer, date, amount. Four columns, one row per claim payment.
--
-- It follows that the window can only be dated for claims paid since this was switched on. That is a
-- real limitation with an honest consequence: a takeback we cannot date produces a REFUSAL
-- (`original-payment-unknown`), never a guess. A defence built on an invented payment date is worse
-- than no defence, because it is one the payer can disprove.
--
-- ── WHY THE FIRST PAYMENT WINS ───────────────────────────────────────────────────────────────────
-- `ON CONFLICT DO NOTHING`, not `DO UPDATE`. A supplemental cheque on the same claim months later is
-- not the date the window runs from. Overwriting would silently RESTART the clock and hand the payer
-- months of recovery time it is not entitled to — a bug that would only ever be discovered by losing
-- a dispute the practice should have won.
--
-- ── WHY CLAIMED AND RECOVERED ARE TWO COLUMNS THAT NEVER MERGE ───────────────────────────────────
-- `claimed_cents` is arithmetic this system performed. `recovered_cents` is cash that arrived, moved
-- off zero only by a person who saw it. A savings report that added the first into the second would
-- tell a practice owner it had collected money nobody has sent, and a savings number only has to be
-- caught disagreeing with the bank once to be worthless forever after.
--
-- The conflict clause below therefore refreshes the arithmetic and the provenance and deliberately
-- leaves `recovered_cents`, `outcome` and `outcome_note` alone: a redelivered event must not reopen
-- a dispute somebody already closed.
--
-- ── WHY THE CITATION IS STORED ON EVERY ROW ──────────────────────────────────────────────────────
-- Statutes change and this table outlives the version of the code that wrote into it. A finding that
-- said only "$41.03 is owed" would be unusable the day the rule table is edited — nobody could tell
-- whether the row was computed under the old rule or the new one. `citation`, `source`, `verified_on`
-- and `evidence` together make every row re-derivable, which is the difference between a number in a
-- letter to a payer and a number in a letter to a payer that survives being questioned.
--
-- `defeasible_by` is the other half of that honesty. Each entry is a real and common reason the money
-- is NOT actually owed — a self-funded ERISA plan, preempting state law entirely, above all. A row
-- that presented the arithmetic without them would be a lie by omission, so they travel with it.
--
-- ── TENANT-SCOPED ────────────────────────────────────────────────────────────────────────────────
-- When a practice was paid, and what it is owed, are that practice's facts.

CREATE TABLE claim_payment_clock (
  practice_id            UUID NOT NULL REFERENCES practices(id),
  -- CLP01 — the clinic's own control number, which is what a PLB names when a payer recoups.
  patient_control_number TEXT NOT NULL,

  payer_id               TEXT,
  payer_name             TEXT NOT NULL,

  -- A DATE, not a timestamp. Every one of these statutes counts calendar days from the date of
  -- payment, and storing an instant would invite a timezone to decide whether a takeback taken on
  -- the last day of the window was inside it.
  paid_at                DATE NOT NULL,
  paid_cents             BIGINT NOT NULL CHECK (paid_cents >= 0),

  -- Provenance: which advice this came from, so the date can be checked against the file.
  remittance_id          UUID NOT NULL,

  PRIMARY KEY (practice_id, patient_control_number)
);

SELECT enable_tenant_rls('claim_payment_clock');


CREATE TABLE statutory_clock_findings (
  practice_id     UUID NOT NULL REFERENCES practices(id),
  -- The advice this was found on. Keyed here, with `subject`, so an at-least-once bus cannot raise
  -- a second demand for the same money: a practice shown the same $41.03 twice will claim it twice.
  remittance_id   UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('prompt-pay-interest', 'recoupment-out-of-time')),
  -- The claim control number for prompt pay; the PLB reference for a recoupment. A payer can take
  -- back several claims on one advice and each is its own dispute, which is why this is in the key.
  subject         TEXT NOT NULL,

  payer_id        TEXT,
  payer_name      TEXT NOT NULL,
  -- The jurisdiction whose statute was applied, stored because it is an ASSUMPTION: this system
  -- takes the practice's own state, and which state's law governs a given plan is genuinely a
  -- question about where the plan is issued. Recording it means a wrong answer is findable later.
  state           TEXT NOT NULL,

  claimed_cents   BIGINT NOT NULL CHECK (claimed_cents >= 0),
  recovered_cents BIGINT NOT NULL DEFAULT 0 CHECK (recovered_cents >= 0),

  citation        TEXT NOT NULL,
  source          TEXT NOT NULL,
  verified_on     DATE NOT NULL,
  -- What a person should actually do about it. Written by the engine, stored rather than regenerated
  -- so the instruction a biller followed is still readable after the wording changes.
  action          TEXT NOT NULL,
  defeasible_by   TEXT[] NOT NULL,
  -- The engine's working: elapsed days, allowed days, principal, rate. This is what makes the figure
  -- re-derivable rather than asserted.
  evidence        JSONB NOT NULL,

  detected_at     TIMESTAMPTZ NOT NULL,
  outcome         TEXT NOT NULL DEFAULT 'open'
                    CHECK (outcome IN ('open', 'recovered', 'written-off', 'not-pursued')),
  outcome_note    TEXT,

  -- Cash cannot have arrived against a finding nobody has closed. Without this, a partial write
  -- would produce a row reporting recovery while still sitting in the open worklist, and the
  -- savings report and the worklist would disagree about the same dollars.
  CONSTRAINT recovery_requires_an_outcome CHECK (recovered_cents = 0 OR outcome <> 'open'),

  PRIMARY KEY (practice_id, remittance_id, kind, subject)
);

SELECT enable_tenant_rls('statutory_clock_findings');

-- The worklist reading: what is still open, worst first.
CREATE INDEX idx_clock_findings_open
  ON statutory_clock_findings (practice_id, detected_at DESC)
  WHERE outcome = 'open';

-- And the scorecard reading: which payers are late, and which are taking money back out of time.
CREATE INDEX idx_clock_findings_by_payer
  ON statutory_clock_findings (practice_id, payer_id, kind, detected_at DESC);
