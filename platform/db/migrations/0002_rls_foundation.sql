-- 0002_rls_foundation.sql — Row-Level Security foundation (architecture-risk-review.md §1.1, §3, §6).
--
-- The #1 risk in the design is tenant isolation being application-enforced. One missed
-- `WHERE practice_id = ?` leaks PHI across practices. We close that at the database:
-- every tenant table gets an RLS policy keyed on a per-transaction session variable that the
-- app sets from the authenticated session — never from client input.
--
-- Request lifecycle (implemented in platform/auth, wired in P1):
--   BEGIN;
--   SELECT set_current_practice('<practice_uuid_from_session>');
--   ... queries run under RLS; rows from other practices are invisible ...
--   COMMIT;
--
-- IMPORTANT: the application MUST connect as a NON-owner, NON-superuser role. Table owners and
-- superusers bypass RLS unless FORCE is set; we FORCE it as belt-and-suspenders, but the app
-- role must still be unprivileged. Role creation is environment-specific (some managed hosts
-- restrict CREATE ROLE), so it is documented here and performed by ops, not this migration.

-- Set the active practice for the current transaction. `true` = local to the transaction,
-- so it never leaks across pooled connections. NULL/empty clears it (no tenant context).
CREATE OR REPLACE FUNCTION set_current_practice(p uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('app.current_practice', COALESCE(p::text, ''), true);
$$;

-- Read the active practice; NULL when unset. Used by every tenant RLS policy.
CREATE OR REPLACE FUNCTION current_practice() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_practice', true);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
END;
$$;

-- One call to make a table tenant-isolated. Every P1+ tenant table invokes this after creation:
--   SELECT enable_tenant_rls('patients');
-- It enables + FORCEs RLS and installs the standard practice-scoped policy for all commands.
-- A NULL practice context matches no rows (fail-closed): no tenant set => nothing visible.
CREATE OR REPLACE FUNCTION enable_tenant_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE tbl text := target::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (practice_id = current_practice()) '
    || 'WITH CHECK (practice_id = current_practice())',
    tbl
  );
END;
$$;
