-- 0001_conventions.sql — foundational conventions for Mermaid's single Postgres database.
--
-- This migration establishes cross-cutting building blocks used by every later migration.
-- It intentionally creates NO domain tables (those arrive in P1) — P0 is the safe foundation.
--
-- Conventions established here (see docs/MODULE-BOUNDARIES.md):
--   • UUID primary keys via gen_random_uuid() (pgcrypto).
--   • updated_at maintained by trigger (set_updated_at).
--   • Every JSONB document column MUST carry a top-level "snapshot_version" (risk review §1.5) —
--     enforced per-column by later migrations via jsonb_has_version().
--   • Tenant isolation is enforced by Postgres RLS keyed on practice_id (see 0002) — NOT by
--     application WHERE clauses alone.

-- gen_random_uuid(), digest(), etc. Available on managed Postgres (Neon/Supabase/RDS).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Standard updated_at maintenance. Attach with:
--   CREATE TRIGGER trg_<table>_updated BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- JSONB snapshot-version guard. Use in a CHECK constraint on every JSONB document column:
--   ALTER TABLE verifications
--     ADD CONSTRAINT verifications_record_versioned CHECK (jsonb_has_version(record));
-- Prevents the silent schema-drift failure mode called out in architecture-risk-review.md §1.5.
CREATE OR REPLACE FUNCTION jsonb_has_version(doc jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT doc IS NULL
      OR (jsonb_typeof(doc) = 'object'
          AND (doc ? 'snapshot_version')
          AND jsonb_typeof(doc -> 'snapshot_version') = 'number');
$$;
