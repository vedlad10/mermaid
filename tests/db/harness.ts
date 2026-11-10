/**
 * Shared harness for the live-database tests.
 *
 * These are the tests that could not exist before M6: everything about tenant isolation, durable
 * delivery and idempotency-under-concurrency is a property of Postgres, not of TypeScript, and an
 * in-memory double cannot prove any of it.
 *
 * They SKIP cleanly when `DATABASE_URL` is unset so the suite still runs on a machine (or in a CI
 * job) with no database — but they must never be allowed to silently no-op where a database DOES
 * exist, which is why `describeDb` reports the skip loudly rather than passing quietly.
 *
 * Every test creates throwaway practices and deletes them afterwards, so the suite is safe to run
 * repeatedly against a shared development database.
 *
 * ⚠ These files must run SEQUENTIALLY (`--test-concurrency=1`, set in the `test:db` script). They
 * share one database and one outbox queue, and any drain claims from the global backlog — so two
 * files running in parallel steal each other's events. That is the queue behaving correctly (any
 * worker may take any event, which is what makes it horizontally scalable); the tests are what have
 * to accommodate it.
 *
 * ⚠ For the same reason, DO NOT run these while `npm run web` is up against the same database: its
 * background worker will claim the tests' events and dispatch them to ITS subscribers, after which a
 * test's own `drain()` finds nothing and fails, seemingly at random. The fix is to stop the app, not
 * to weaken the queue.
 */
import { closePool, requireContext, withPractice, withoutPractice } from "@mermaid/db";

/**
 * ⚠ THE TEST SUITE NEVER TALKS TO A REAL CLEARINGHOUSE.
 *
 * These tests load `.env` for `DATABASE_URL`, and `.env` also carries `EDI_ADAPTER`. On a machine
 * configured for a live vendor that meant every test verification was a real eligibility request:
 * Stedi answered for a member no payer has issued, returned a 271 with no benefit segments, the
 * verification never completed, no `verification.completed` event was published, and the outbox
 * created no claim. Two tenant-isolation tests then failed on `0 !== 1` — reporting a broken
 * security boundary that was in fact perfectly intact.
 *
 * That failure mode is the mild one. The same configuration sends fixture member IDs to a third
 * party on every run, spends vendor quota, and makes the suite's result depend on a developer's
 * local file and on someone else's uptime.
 *
 * Pinned here rather than in the npm script because `EDI_ADAPTER=mock npm run test:db` is not
 * portable to a Windows shell, and a guarantee that only holds on some machines is not one. Set
 * before any module reads config, and the memoized adapter is cleared so an earlier read cannot
 * survive into these tests.
 */
process.env.EDI_ADAPTER = "mock";
const { resetEdiAdapter } = await import("@mermaid/edi");
resetEdiAdapter();

export const HAS_DB = Boolean(process.env.DATABASE_URL);

/** `{ skip }` options for node:test — one place, so the reason reads the same everywhere. */
export const dbTest = HAS_DB
  ? {}
  : { skip: "DATABASE_URL not set — live-database tests need a real Postgres" };

/** Create a throwaway practice and return its id. */
export async function makePractice(name: string): Promise<string> {
  return withoutPractice(async () => {
    const { rows } = await requireContext().tx.query(
      "INSERT INTO practices (name) VALUES ($1) RETURNING id",
      [`test-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`]
    );
    return (rows[0] as { id: string }).id;
  });
}

// Children before parents — these tables reference practices without ON DELETE CASCADE, by
// design: a production tenant must never be deletable by accident.
//
// Module scope rather than function-local so `CLEANED_TENANT_TABLES` can expose it to the coverage
// test below. Order is load-bearing; the test asserts membership, never order.
const TENANT_TABLES = [
    "analytics_facts",
    /**
     * ── AND `payer_allowed_amounts` DRIFTED IN THE SAME WAY ────────────────────────────────────
     * Third time, same cause: the table arrived with migration 0026 and nobody added it here. A
     * throwaway practice that had learned an allowed amount could not be deleted at all, because
     * `payer_allowed_amounts.practice_id` references practices(id) with no ON DELETE CASCADE, so
     * teardown failed on the foreign key and left the whole tenant behind.
     *
     * Unlike the ERA tables this one announced itself: `tenantTablesAreCovered` — added after the
     * second drift precisely so there would not be a third silent one — named it directly. It is
     * listed first because nothing references it, so it has no children to precede.
     */
    "payer_allowed_amounts",
    /**
     * ── AND `coordination_cases` (0034) ──────────────────────────────────────────────────────────
     * Added with the table rather than after the coverage test names it. References only
     * practices(id); nothing references it.
     */
    "coordination_cases",
    /**
     * `appointments` (0035), added with the table. It references `patients(id)`, so it must be
     * cleaned before `patients` below; nothing references it, so the front of the list is safe.
     */
    "appointments",
    /**
     * ── AND SIX MORE, FROM MIGRATIONS 0029–0032 ────────────────────────────────────────────────
     * Fourth time, caught by `tenantTablesAreCovered` in CI on the first push that carried them:
     * `auth.test.ts` and `repository-contract.test.ts` failed in their `after` hooks on the
     * practices FK. Each references only practices(id) — no table references any of them — so,
     * like `payer_allowed_amounts`, they have no children to precede and sit at the front.
     */
    "payer_payment_method_observations",
    "allowed_amount_variances",
    "payer_allowed_amount_epochs",
    "statutory_clock_findings",
    "claim_payment_clock",
    "practice_settings",
    /**
     * ── THE ERA TABLES WERE MISSING, AND IT MADE THE SUITE UNRELIABLE ──────────────────────────
     * `era_artifacts` and `era_sources` arrived with migration 0019 and were never added here, so
     * every run of the live suite left its ERA sources behind. They accumulate, they stay `enabled`,
     * and their lease expires — so they are permanently DUE.
     *
     * `claim_era_sources` takes `ORDER BY next_poll_at LIMIT p_limit`, oldest first. Once enough
     * orphans exist they fill the batch before the two rows a test has just registered, and
     * "the cross-tenant claim sees every practice" starts failing — intermittently at first, then
     * always, on a machine whose database has been used enough. Nothing about the code under test
     * changed; the shared database simply silted up.
     *
     * Verified rather than assumed: with the orphans leased out by a probe the test passes, and with
     * them due it fails, deterministically.
     *
     * Artifacts before sources — `era_artifacts.source_id` references `era_sources(id)`, and neither
     * has ON DELETE CASCADE, deliberately (a production tenant must not be deletable by accident).
     */
    "era_artifacts",
    "era_sources",
    "ledger_entries",
    "appeals",
    "denials",
    "domain_event_deliveries",
    "domain_events",
    "postings",
    "remittances",
    "claim_expectations",
    "claims",
    "verifications",
    // audit_events is deliberately absent — see UNCLEANABLE_TENANT_TABLES below.
    "sessions",
    "staff_users",
    "coverages",
    "patients",
    /**
     * ── AND `feature_flags` WAS MISSING TOO ────────────────────────────────────────────────────
     * Same drift as the ERA tables above, and the same root cause: a list maintained by hand
     * against a schema that keeps growing. `feature_flags.practice_id` REFERENCES practices(id)
     * with no ON DELETE CASCADE (migration 0003), so a throwaway practice carrying a per-practice
     * flag could not be deleted at all — teardown would fail on the foreign key and leave the whole
     * tenant behind, which is exactly the silt that made the ERA tests flaky.
     *
     * Latent rather than observed: no test writes a flag today. It is fixed now because the first
     * one that does would meet a confusing FK error in an `after` hook, and because
     * `tenantTablesAreCovered` below now makes the list self-checking.
     */
    "feature_flags",
];

/**
 * Delete everything belonging to these practices, children first.
 *
 * Runs WITHOUT a practice context on purpose: cleanup must not depend on the very isolation the
 * tests are exercising, and these statements are scoped by an explicit `practice_id` predicate.
 */
export async function dropPractices(...practiceIds: (string | null | undefined)[]): Promise<void> {
  // node:test runs `after` hooks even when every test in the file was skipped, so cleanup must not
  // reach for a database that was never configured.
  if (!HAS_DB) return;
  const ids = practiceIds.filter((p): p is string => Boolean(p));
  for (const practiceId of ids) {
    await withPractice(practiceId, async () => {
      const tx = requireContext().tx;
      for (const table of TENANT_TABLES) {
        await tx.query(`DELETE FROM ${table} WHERE practice_id = $1`, [practiceId]);
      }
    });
  }
  await withoutPractice(async () => {
    for (const practiceId of ids) {
      await requireContext().tx.query("DELETE FROM practices WHERE id = $1", [practiceId]);
    }
  });
}

/**
 * Every tenant table this harness must clear, discovered from the catalog rather than remembered.
 *
 * Exported so a test can hold the hand-written list above to the actual schema. `clean-test-data.mjs`
 * learned this lesson first — its own comment says "a list that must be updated by hand every
 * migration is a list that will be wrong again", which is why that script stopped hardcoding one.
 * This harness kept its list and drifted twice: the ERA tables (0019) and `feature_flags` (0003).
 */
export async function tenantTablesInSchema(): Promise<string[]> {
  return withoutPractice(async () => {
    const { rows } = await requireContext().tx.query(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'practice_id'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name <> 'practices'
        ORDER BY 1`
    );
    return (rows as { table_name: string }[]).map((r) => r.table_name);
  });
}

/**
 * Tenant tables this harness deliberately does NOT clear, and why.
 *
 * ── audit_events ─────────────────────────────────────────────────────────────────────────────────
 * The application role holds no INSERT/UPDATE/DELETE on it: the trail is append-only, written only
 * through the `record_audit` SECURITY DEFINER function, and `tests/db/audit-append-only.test.ts`
 * pins that. Cleanup runs on the app connection like everything else here, so it cannot delete
 * these rows — and it never could. Until the grant was revoked the DELETE ran happily and matched
 * zero rows, because `audit_events` has no `FOR ALL` policy and RLS filtered every candidate away.
 * The entry in the list above had been inert since it was written; revoking the grant only changed
 * a silent no-op into an error.
 *
 * Leaving the rows is safe in a way the ERA silt was not. `audit_events.practice_id` carries no
 * foreign key — deliberately, so the trail outlives the tenant it describes, which is what a
 * retention-bound audit log is for — so a leftover row never blocks deleting a practice. Nothing
 * reads the table except scoped by `practice_id`, and a dropped practice's id is never asked for
 * again, so the rows are inert rather than accumulating pressure on any test's behaviour.
 *
 * Purging them needs the owner connection, which this suite does not hold by design. That is a
 * housekeeping job for `clean-test-data.mjs`, not a reason to give the application a way to erase
 * its own audit trail.
 */
export const UNCLEANABLE_TENANT_TABLES: readonly string[] = [
  "audit_events",
  // The read trail (0037): append-only through `record_phi_access`, no FK on practice_id, for every
  // reason given above for audit_events.
  "phi_access_events",
];

/** The tables `dropPractices` will clear — exposed for the coverage test. */
export const CLEANED_TENANT_TABLES: readonly string[] = TENANT_TABLES;

/** Count rows visible in `table` from inside `practiceId`'s context — an RLS assertion helper. */
export async function visibleCount(practiceId: string, table: string): Promise<number> {
  return withPractice(practiceId, async () => {
    const { rows } = await requireContext().tx.query(`SELECT count(*)::int AS n FROM ${table}`);
    return (rows[0] as { n: number }).n;
  });
}

/** Release the pool so the test process can exit. No-op when no database was configured. */
export const shutdown = async (): Promise<void> => {
  if (!HAS_DB) return;
  await closePool();
};
