-- 0014_payer_catalog_is_usable.sql — make the payer catalog keyable by the identifier everything holds.
--
-- THE PROBLEM THIS FIXES.
--
-- `payers` has existed since migration 0004 with `filing_window_days` and `appeal_window_days` on
-- it, and has never held a single row. Meanwhile `modules/claims/src/engine/deadline.ts` carries a
-- hardcoded six-payer map of exactly those windows, with a comment saying it is a placeholder until
-- the payer profile lands. So the system has had two sources of truth for one fact since M4, and the
-- authoritative one has been inert.
--
-- Reading the real table requires being able to look a payer up by the identifier the rest of the
-- system actually carries. Migration 0009 already settled what that is: every module identifies a
-- payer by its CLEARINGHOUSE SLUG — `delta-dental`, `metlife-dental` — produced by verification's
-- payer identification and carried on every domain event thereafter. `payers.id` is a UUID nothing
-- holds; `payers.edi_payer_id` is the slug.
--
-- So the slug needs to be unique, both to make it a legitimate key and to let a seed be idempotent
-- via ON CONFLICT. Rows are seeded by the application at boot (PayerProfileService.ensureDefaults),
-- not here: the window values are policy, they change without a schema change, and a migration is
-- the wrong place to keep policy.
--
-- NULL remains permitted — a payer catalogued for reporting before its clearinghouse code is known
-- is legitimate — and Postgres treats NULLs as distinct in a unique index, so several may coexist.

CREATE UNIQUE INDEX IF NOT EXISTS uq_payers_edi_payer_id
  ON payers (edi_payer_id)
  WHERE edi_payer_id IS NOT NULL;

COMMENT ON COLUMN payers.edi_payer_id IS
  'The clearinghouse slug (delta-dental, metlife-dental). THE key for this table in practice: it is '
  'what every module, coverage snapshot and domain event carries. Unique where present.';
