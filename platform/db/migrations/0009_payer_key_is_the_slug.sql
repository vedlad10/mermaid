-- 0009_payer_key_is_the_slug.sql — the playbook is keyed by the payer's clearinghouse slug, not a UUID.
--
-- THE MISMATCH THIS FIXES (found the first time the playbook was queried against a real database):
--
-- Migration 0004 declared `payer_playbook_rules.payer_id UUID REFERENCES payers(id)`, anticipating
-- that payers would be rows in a catalog with generated keys. In practice every module identifies a
-- payer by its CLEARINGHOUSE SLUG — `delta-dental`, `metlife-dental` — produced by the verification
-- module's payer identification, carried on the coverage snapshot, written onto claims, echoed by
-- remittances, and travelling on every domain event. Nothing anywhere holds a payer UUID, and the
-- `payers` table has never been populated.
--
-- So the FK was speculative and the type was wrong: `WHERE payer_id = 'metlife-dental'` fails with
-- `invalid input syntax for type uuid`. The in-memory repository has no such constraint, which is
-- exactly why this survived a green unit suite and appeared on first contact with Postgres.
--
-- The honest fix is to store what the system actually uses. The `payers` table remains as the richer
-- catalog (filing/appeal windows, average days to pay) and is keyed by the same slug via its
-- `edi_payer_id` column when it is eventually populated — one identifier for a payer, everywhere.

-- The unique index is over an expression on payer_id, so it must be rebuilt around the type change.
DROP INDEX IF EXISTS uq_playbook_rule;
DROP INDEX IF EXISTS idx_playbook_lookup;

ALTER TABLE payer_playbook_rules DROP CONSTRAINT IF EXISTS payer_playbook_rules_payer_id_fkey;
ALTER TABLE payer_playbook_rules
  ALTER COLUMN payer_id TYPE TEXT USING payer_id::text;

COMMENT ON COLUMN payer_playbook_rules.payer_id IS
  'Clearinghouse payer slug (e.g. delta-dental). NULL = a platform-wide default rule. Matches the '
  'payer identity every module carries; see payers.edi_payer_id for the catalog key.';

CREATE INDEX idx_playbook_lookup ON payer_playbook_rules(payer_id, carc_code, cdt_code);
-- COALESCE because both payer_id and cdt_code are nullable, and NULLs do not compare equal: a plain
-- UNIQUE over the three columns would happily admit a hundred identical global rules.
CREATE UNIQUE INDEX uq_playbook_rule
  ON payer_playbook_rules (COALESCE(payer_id, ''), carc_code, COALESCE(cdt_code, ''));
