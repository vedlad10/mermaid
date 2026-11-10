-- 0022 — a payer becomes DATA, so adding one stops being a deploy.
--
-- ── WHAT WAS WRONG (NEW-08) ─────────────────────────────────────────────────────────────────────
-- `modules/verification/src/engine/payer.ts` carried a seven-row `REGISTRY` array: the slug, the
-- display name, a hand-written regular expression matched against the payer name read off the card,
-- and the clearinghouse's id for that payer. Its own comment said so — "MOCK registry for now. Once
-- the Payer Profile module is live on the database, identification consults it instead of this
-- static list."
--
-- Meanwhile `payers` has existed since 0004 and been seeded since 0014, and holds the SAME payers
-- keyed on the SAME slug. So the two facts about a payer that decide whether a patient can be
-- verified at all — does the card name match, and what id routes the request — lived in a source
-- file, while the facts about deadlines lived in a table.
--
-- The consequence is not abstract. A practice whose card says "Ameritas" cannot verify that patient,
-- cannot file that claim, and cannot be helped by anyone without a code change, a review and a
-- deploy. The claim scrubber made it worse by treating `missing-payer` as a hard error, so the
-- claim could not be filed manually either — the system refused to let a human do the thing it
-- could not do itself.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
-- 1. `payers.clearinghouse_id` — the id that actually goes on the wire, alongside the windows the
--    table already held. A DIFFERENT namespace from `edi_payer_id`, which despite its name is
--    Mermaid's own slug (migration 0009 settled that, and 0014's comment records it).
-- 2. `payer_aliases` — the name-matching patterns, as ROWS. One payer has many: a card may say
--    "Delta Dental", "DELTA DENTAL OF CA" or "deltadental". Rows rather than a regex column, so an
--    administrator can add one from a screen without writing a regular expression, and so no value
--    an administrator types can become a catastrophically slow pattern against every card.
--
-- Two match kinds, because the array they replace needed both:
--   • `contains` — the alias appears anywhere in the normalised name. Right for a distinctive brand
--     ("delta dental" matching "DELTA DENTAL PPO OF CALIFORNIA").
--   • `word`     — the alias appears as a whole word. Right for a short or ambiguous one: the old
--     array bounded `moda` for exactly this reason, so "Modality Benefits" is not routed to Moda
--     Health. Sending an eligibility request to a company that has never heard of the patient
--     surfaces as "not covered", which reads like an answer rather than a mistake.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────────────────────────
-- It seeds nothing. Migration 0014 settled that too, and its reasoning holds for these columns
-- exactly as it did for the windows: "the window values are policy, they change without a schema
-- change, and a migration is the wrong place to keep policy." `PayerProfileService.ensureDefaults`
-- seeds at boot, idempotently, and an administrator's edits survive it.
--
-- REVERSAL (this runner is forward-only by design; the inverse is stated so it is never guessed):
--   DROP TABLE IF EXISTS payer_aliases;
--   ALTER TABLE payers DROP COLUMN IF EXISTS clearinghouse_id;

ALTER TABLE payers
  ADD COLUMN IF NOT EXISTS clearinghouse_id TEXT;

COMMENT ON COLUMN payers.clearinghouse_id IS
  'The payer''s id AT THE CLEARINGHOUSE (Stedi calls Aetna 60054). A DIFFERENT namespace from '
  'edi_payer_id, which despite its name holds Mermaid''s own slug. Leading zeros are significant. '
  'NULL means this deployment has no id for the payer — a verification then says so plainly rather '
  'than sending the slug, which produces a 271 with no benefit segments.';

CREATE TABLE IF NOT EXISTS payer_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id    UUID NOT NULL REFERENCES payers(id) ON DELETE CASCADE,
  -- Stored already normalised (lower-case, non-alphanumerics collapsed to single spaces) so the
  -- match is a plain comparison rather than a per-row transformation, and so two administrators
  -- typing "Delta-Dental" and "delta dental" cannot create two rows that mean one thing.
  alias       TEXT NOT NULL CHECK (alias = lower(alias) AND alias <> ''),
  match_kind  TEXT NOT NULL DEFAULT 'contains' CHECK (match_kind IN ('contains', 'word')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One alias means one payer. Two payers claiming "dental" would make routing depend on row order,
-- which is how an eligibility request reaches a company that has never heard of the patient.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payer_aliases_alias ON payer_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_payer_aliases_payer ON payer_aliases (payer_id);

COMMENT ON TABLE payer_aliases IS
  'What a card may say for a payer. Rows rather than a regex column: an administrator adds one from '
  'a screen without writing a regular expression, and nothing they type can become a pathologically '
  'slow pattern run against every card (NEW-08).';

-- `payers` and `payer_aliases` are shared reference data with no practice_id and no RLS, exactly
-- like `payers` itself since 0004. A payer catalog is not tenant data — every practice bills the
-- same Delta Dental — and giving it a tenant column would fragment the routing table per clinic.
