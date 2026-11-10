/**
 * The audit trail is append-only for the application role — asserted against the live database.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `0003_core_tenancy.sql` states that "the app role is granted no direct DML on this table (see ops
 * role setup)". The ops role setup is `platform/db/provision-app-role.mjs`, and it granted
 * `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` — which includes `audit_events`.
 * Probing staging as `mermaid_app` confirmed the role held all four.
 *
 * The trail was still intact, because `audit_events` is the one tenant table with no `FOR ALL`
 * policy — only `audit_read FOR SELECT` — and Postgres default-denies any command no policy covers.
 * So the guarantee held, by a mechanism nothing documented and nothing tested.
 *
 * ── WHY THAT WAS WORTH FIXING RATHER THAN JUST DOCUMENTING ───────────────────────────────────────
 * Every other tenant table gets its policy from `enable_tenant_rls()`, which creates `FOR ALL … WITH
 * CHECK`. Applying that helper to `audit_events` — the obvious "make it consistent" tidy-up, one
 * line, reviewable in ten seconds — would have activated the grants underneath and let the
 * application rewrite its own audit trail within its own tenant. No error, no failing test.
 *
 * ── WHAT THIS TEST PINS ──────────────────────────────────────────────────────────────────────────
 * Both mechanisms, separately, because the point of the fix is that they are independent:
 *   1. the grant is gone, so a policy change alone cannot unlock writes;
 *   2. no policy admits the write, so a stray grant alone cannot either.
 * A regression that removes one is a finding; a regression that removes both is a breach, and this
 * fails on the first.
 *
 * The suite connects as `mermaid_app` (`DATABASE_URL` is the unprivileged role — see
 * `provision-app-role.mjs`), so these attempts are the real ones, not a simulation via `SET ROLE`.
 * An earlier version of the offline probe DID use `SET ROLE`, could not perform it, and reported the
 * resulting errors as the database refusing the writes — a green verdict on five untested cases.
 * Hence the role assertion first: a test that cannot fail proves nothing.
 */
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { requireContext, withPractice, withoutPractice } from "@mermaid/db";
import { recordAudit } from "@mermaid/observability";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

const WRITES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

const FIXTURE_ACTION = "append.only.fixture";

/** How many fixture rows this practice can see right now. */
async function fixtureRows(practiceId: string): Promise<number> {
  return withPractice(practiceId, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT count(*) AS n FROM audit_events WHERE practice_id = $1 AND action = $2",
      [practiceId, FIXTURE_ACTION]
    );
    return Number((rows[0] as { n: string } | undefined)?.n ?? 0);
  });
}

test("the suite runs as an unprivileged, RLS-subject role", dbTest, async () => {
  const { rows } = await withoutPractice(() =>
    requireContext().tx.query(
      "SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user"
    )
  );
  const me = rows[0] as { rolsuper: boolean; rolbypassrls: boolean } | undefined;
  assert.ok(me, "current_user must resolve to a role");
  assert.equal(me.rolsuper, false, "a superuser bypasses every check below, making them vacuous");
  assert.equal(me.rolbypassrls, false, "a BYPASSRLS role ignores the policies these tests rely on");
});

test("the application role holds no write grant on audit_events", dbTest, async () => {
  const { rows } = await withoutPractice(() =>
    requireContext().tx.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = current_user AND table_name = 'audit_events'`
    )
  );
  const held = (rows as { privilege_type: string }[]).map((r) => r.privilege_type);
  for (const write of WRITES) {
    assert.ok(
      !held.includes(write),
      `the app role holds ${write} on audit_events — provision-app-role.mjs must revoke it`
    );
  }
  assert.ok(held.includes("SELECT"), "SELECT is retained deliberately: people read their own activity trail");
});

test("no policy on audit_events admits anything but SELECT", dbTest, async () => {
  const { rows } = await withoutPractice(() =>
    requireContext().tx.query(
      "SELECT policyname, cmd FROM pg_policies WHERE tablename = 'audit_events'"
    )
  );
  assert.ok(rows.length > 0, "audit_events must keep its read policy — with none at all, nobody can read it");
  for (const p of rows as { policyname: string; cmd: string }[]) {
    assert.equal(
      p.cmd,
      "SELECT",
      `policy "${p.policyname}" is FOR ${p.cmd}; a FOR ALL policy here (as enable_tenant_rls creates) ` +
        "would make audit_events writable the moment any grant returned"
    );
  }
});

test("a forged audit row is refused outright", dbTest, async () => {
  const practice = await makePractice("audit-append-only");
  created.push(practice);

  await assert.rejects(
    () =>
      withPractice(practice, () =>
        requireContext().tx.query(
          `INSERT INTO audit_events (practice_id, actor_role, action, resource, resource_id, outcome)
           VALUES ($1, 'owner', 'forged.by.test', 'probe', 'probe', 'success')`,
          [practice]
        )
      ),
    /permission denied|row-level security/i,
    "the application must not be able to write a row into its own audit trail"
  );
});

test("an existing audit row cannot be rewritten or erased", dbTest, async () => {
  const practice = await makePractice("audit-append-only-mutate");
  created.push(practice);

  /**
   * Written through `recordAudit`, the production writer, rather than by calling `record_audit`
   * directly in SQL. The revoke this file guards could break audit logging altogether — and it
   * would break it in the TypeScript wrapper's path, not in a hand-written query — so the fixture
   * is created the way the application creates one. A test that proved the trail unforgeable while
   * audit logging was silently dead would be worse than no test.
   *
   * Aiming at this practice's own row rather than another tenant's is deliberate: cross-tenant
   * refusal is tenant isolation, which is a different test. What this one needs is the row the
   * application has the strongest possible claim to.
   */
  await withPractice(practice, () =>
    recordAudit(requireContext().tx, {
      practiceId: practice,
      traceId: randomUUID(),
      actorRole: "owner",
      action: FIXTURE_ACTION,
      resource: "probe",
      resourceId: "probe",
      outcome: "success",
    })
  );
  assert.equal(
    await fixtureRows(practice),
    1,
    "the sanctioned writer must still work — a revoke that broke record_audit() would be a worse bug"
  );

  const attempts = [
    ["UPDATE", `UPDATE audit_events SET action = 'rewritten' WHERE practice_id = $1 AND action = $2`],
    ["DELETE", `DELETE FROM audit_events WHERE practice_id = $1 AND action = $2`],
  ] as const;

  for (const [label, sql] of attempts) {
    /**
     * Either outcome is acceptable, because Postgres refuses these two differently depending on
     * which mechanism trips first: with no grant it raises "permission denied"; with a grant but no
     * covering policy it runs and matches zero rows. Both are refusals. What must never happen is a
     * write that lands — which is why the row count is re-read afterwards either way rather than
     * trusting the statement's own report.
     */
    let affected: number | null = null;
    try {
      affected = await withPractice(practice, async () => {
        const r = await requireContext().tx.query(sql, [practice, FIXTURE_ACTION]);
        return r.rowCount ?? 0;
      });
    } catch (e) {
      assert.match(
        (e as Error).message,
        /permission denied|row-level security/i,
        `${label} failed for an unrelated reason`
      );
    }
    if (affected !== null) {
      assert.equal(affected, 0, `${label} reported ${affected} audit rows modified — the trail is not append-only`);
    }
    assert.equal(
      await fixtureRows(practice),
      1,
      `the fixture row did not survive ${label} — the trail is not append-only`
    );
  }
});
