/**
 * Production-readiness controls, against a real database (M10).
 *
 * Three claims, none of which can be established anywhere else:
 *
 *  1. **PHI is ciphertext in the column.** Not "the repository calls encrypt" — that a `SELECT` by
 *     someone holding a database credential does not return a patient's insurance card. The only way
 *     to know is to read the column directly, which is exactly what an attacker with a stolen backup
 *     would do.
 *
 *  2. **The audit trail is append-only by construction.** The application role has no INSERT and no
 *     UPDATE path to `audit_events` other than a SECURITY DEFINER function, so it cannot rewrite
 *     history even if it wanted to. That is a property of the grants, not of the code.
 *
 *  3. **A dead-lettered event can be revived, and only within its own practice.** The outbox is the
 *     one component whose failure is invisible from every business screen; an operator has to be able
 *     to see and restart stalled work, and must not be able to touch another tenant's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { NullEventPublisher, PostgresEventBus } from "@mermaid/events";
import { recordAudit } from "@mermaid/observability";
import { isEncrypted } from "@mermaid/crypto";
import { PgVerificationRepository, VerificationService, type VerificationInput } from "@mermaid/verification";
import { ClaimService, PgClaimRepository } from "@mermaid/claims";
import {
  CLEANED_TENANT_TABLES,
  UNCLEANABLE_TENANT_TABLES,
  dbTest,
  dropPractices,
  makePractice,
  shutdown,
  tenantTablesInSchema,
} from "./harness.ts";

/**
 * ── THE HARNESS'S OWN CLEANUP LIST MUST MATCH THE SCHEMA ──────────────────────────────────────
 *
 * `dropPractices` clears a HAND-WRITTEN list of tenant tables. It has drifted twice: `era_artifacts`
 * and `era_sources` arrived with migration 0019 and were never added, which silted the database up
 * until `era-tenancy` failed intermittently; and `feature_flags` (migration 0003) was never there at
 * all.
 *
 * The consequence is not a missed delete. `feature_flags.practice_id REFERENCES practices(id)` with
 * no ON DELETE CASCADE, so a throwaway practice holding a flag cannot be deleted: teardown fails on
 * the foreign key and abandons the whole tenant. `clean-test-data.mjs` already learned this and now
 * discovers its tables from the catalog, with the comment "a list that must be updated by hand every
 * migration is a list that will be wrong again".
 *
 * This is that check, for the harness. It fails the moment a migration adds a `practice_id` column
 * the cleanup does not know about — which is when it is cheap to fix, rather than months later as an
 * intermittent failure in an unrelated test.
 */
test("the harness cleans every tenant table the schema actually has", dbTest, async () => {
  const inSchema = await tenantTablesInSchema();
  assert.ok(inSchema.length > 0, "the catalog query must find tenant tables at all");

  /**
   * The exemption is subtracted here rather than filtered out of the catalog query, so a table
   * that stops being cleanable has to be named in one place and justified there. `audit_events` is
   * the only member: the app role cannot delete from an append-only trail, and giving it that
   * power to tidy up after tests would undo the control the trail exists to provide.
   */
  const mustClean = inSchema.filter((t) => !UNCLEANABLE_TENANT_TABLES.includes(t));
  const missing = mustClean.filter((t) => !CLEANED_TENANT_TABLES.includes(t));
  assert.deepEqual(
    missing,
    [],
    `dropPractices() would leave rows behind in: ${missing.join(", ")}. Add them to TENANT_TABLES ` +
      `in tests/db/harness.ts, children before parents.`
  );

  // An exemption for a table the schema no longer has is stale in the same way a cleanup entry is.
  const phantom = UNCLEANABLE_TENANT_TABLES.filter((t) => !inSchema.includes(t));
  assert.deepEqual(phantom, [], `UNCLEANABLE_TENANT_TABLES names tables that no longer exist: ${phantom.join(", ")}`);

  // And an exemption must be a real exemption: naming a table in both lists is a contradiction.
  const both = UNCLEANABLE_TENANT_TABLES.filter((t) => CLEANED_TENANT_TABLES.includes(t));
  assert.deepEqual(both, [], `named as both cleaned and uncleanable: ${both.join(", ")}`);

  // The reverse, so the list cannot rot the other way after a table is dropped.
  const stale = CLEANED_TENANT_TABLES.filter((t) => !inSchema.includes(t));
  assert.deepEqual(stale, [], `TENANT_TABLES names tables that no longer exist: ${stale.join(", ")}`);
});

const NOW = new Date("2026-09-01T12:00:00Z");
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };
const created: string[] = [];

/**
 * A key for this file only. Set before any repository runs and removed afterwards, so the rest of
 * the suite keeps exercising the unencrypted path — which is itself the thing being proved
 * deployable.
 */
const KEY = Buffer.from(
  "mermaid-test-key-do-not-use-anywhere-else!!".slice(0, 32),
  "utf8"
).toString("base64");
const originalKey = process.env.PHI_ENCRYPTION_KEY;
process.env.PHI_ENCRYPTION_KEY = KEY;

after(async () => {
  if (originalKey === undefined) delete process.env.PHI_ENCRYPTION_KEY;
  else process.env.PHI_ENCRYPTION_KEY = originalKey;
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/**
 * A deliberately obvious NON-DELIVERABLE address for an invented patient.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so the claim scrubber blocks the
 * submit gate without one — and the tests here file claims and assert on what was persisted.
 * Named to be unmistakable: nothing in this file may ever reach a real payer, and no production path
 * falls back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const CLEAN = (): VerificationInput => ({
  patient: {
    firstName: "Ada",
    lastName: "Alpha",
    dateOfBirth: "1990-04-12",
    memberId: "ABC12345",
    address: SYNTHETIC_ADDRESS,
  },
  cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) },
  ],
});

function services() {
  const adapter = new MockEdiAdapter();
  const quiet = new NullEventPublisher();
  return {
    verification: new VerificationService(new PgVerificationRepository(), adapter, quiet),
    claims: new ClaimService(new PgClaimRepository(), adapter, BILLING_PROVIDER, quiet),
  };
}

// ── PHI at rest ───────────────────────────────────────────────────────────────────────

test("a stored insurance card is ciphertext in the column, and plaintext to the app", dbTest, async () => {
  const p = await practice("phi-card");
  const created = await withPractice(p, () => services().verification.create(CLEAN(), NOW));

  // What someone holding a database credential — or a stolen backup — actually sees.
  const raw = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT record::text AS doc FROM verifications WHERE id = $1",
      [created.record.id]
    );
    return (rows[0] as { doc: string }).doc;
  });

  assert.ok(!raw.includes("Group #: GRP100"), "the card text must not be readable in the column");
  /**
   * `v2:` since NEW-25 — the BOUND envelope. `v1:` is still readable, so rows written before the
   * binding existed keep working, but nothing may still WRITE one: a v1 value is authenticated and
   * unbound, so it could be copied into another patient's row and would decrypt there. Asserting
   * the version rather than merely "is encrypted" is what would catch a regression to the weaker
   * envelope, which is invisible in every other way.
   */
  assert.ok(raw.includes("v2:"), "and what IS there must be the row-bound envelope");
  assert.ok(!raw.includes("v1:"), "nothing may still write the unbound one");

  // The application, holding the key, sees exactly what it wrote.
  const read = (await withPractice(p, () => services().verification.get(created.record.id, NOW)))!;
  assert.equal(read.record.cardText, CLEAN().cardText);
  assert.deepEqual(read.record, created.record, "encryption must be invisible above the repository");
});

test("the 271 the payer returned is encrypted too", dbTest, async () => {
  const p = await practice("phi-271");
  const created = await withPractice(p, () => services().verification.create(CLEAN(), NOW));
  if (!created.record.raw271) return; // the mock does not always retain one

  const raw = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT record ->> 'raw271' AS raw271 FROM verifications WHERE id = $1",
      [created.record.id]
    );
    return (rows[0] as { raw271: string | null }).raw271;
  });
  assert.ok(raw && isEncrypted(raw), "a 271 names the patient and their benefits");
});

test("the filed 837 is encrypted, and still round-trips for provenance", dbTest, async () => {
  const p = await practice("phi-837");
  const { verification, claims } = services();

  const verified = await withPractice(p, () => verification.create(CLEAN(), NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(p, () => claims.createFromVerification(payload, NOW));
  const filed = await withPractice(p, () => claims.submit(built.claim.id, { submittedBy: "biller" }, NOW));
  assert.ok(filed.claim.submission?.raw837?.includes("ST*837*"));

  const stored = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT record -> 'submission' ->> 'raw837' AS raw837 FROM claims WHERE id = $1",
      [built.claim.id]
    );
    return (rows[0] as { raw837: string }).raw837;
  });
  assert.ok(isEncrypted(stored), "the 837 carries the patient, the procedures and the fees");
  assert.ok(!stored.includes("D2750"));

  const read = (await withPractice(p, () => claims.get(built.claim.id, NOW)))!;
  assert.ok(read.claim.submission!.raw837!.includes("SV3*AD:D2750"), "provenance survives the round trip");
});

// ── The audit trail ───────────────────────────────────────────────────────────────────

test("an audit row is written through the SECURITY DEFINER function and reads back", dbTest, async () => {
  const p = await practice("audit-write");

  await withPractice(p, async () => {
    await recordAudit(requireContext().tx, {
      practiceId: p,
      traceId: crypto.randomUUID(),
      actorRole: "biller",
      action: "submit",
      resource: "claims",
      resourceId: "claim-1",
      outcome: "success",
      ip: "127.0.0.1",
    });
  });

  const rows = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT action, resource, outcome, actor_role FROM audit_events WHERE practice_id = $1",
      [p]
    );
    return rows as { action: string; resource: string; outcome: string; actor_role: string }[];
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { action: "submit", resource: "claims", outcome: "success", actor_role: "biller" });
});

test("one practice cannot read another's audit trail", dbTest, async () => {
  const [pA, pB] = [await practice("audit-iso-a"), await practice("audit-iso-b")];
  await withPractice(pA, () =>
    recordAudit(requireContext().tx, {
      practiceId: pA,
      traceId: crypto.randomUUID(),
      action: "close",
      resource: "denials",
      outcome: "success",
    })
  );

  const seenFromB = await withPractice(pB, async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM audit_events");
    return (rows[0] as { n: number }).n;
  });
  assert.equal(seenFromB, 0, "an audit trail readable across tenants is a breach, not a feature");
});

/**
 * ── THE APPEND-ONLY TEST MOVED TO `audit-append-only.test.ts` ────────────────────────────────────
 * A test lived here called "audit is append-only by grant". It was not: its own comment conceded
 * "the app role holds DML on tables generally", and what it actually asserted was that an UPDATE
 * matched zero rows because `audit_events` has only a SELECT policy. The grant in the title did not
 * exist — `provision-app-role.mjs` granted DML on ALL tables in the schema, this one included.
 *
 * The grant is revoked now, so the UPDATE raises `permission denied` before it can report a row
 * count, and the successor file asserts both mechanisms independently, tolerates either failure
 * mode, and creates its fixture through the production `recordAudit` writer.
 */

// ── Outbox operations ─────────────────────────────────────────────────────────────────

test("a dead-lettered event can be revived, and only from its own practice", dbTest, async () => {
  const [pA, pB] = [await practice("ops-revive-a"), await practice("ops-revive-b")];
  const bus = new PostgresEventBus();

  const event = await withPractice(pA, () =>
    bus.publish(
      "claim.filing_risk",
      crypto.randomUUID(),
      {
        claimId: crypto.randomUUID(),
        verificationId: crypto.randomUUID(),
        raisedAt: NOW.toISOString(),
        filingDeadline: "2026-12-31",
        daysRemaining: 3,
        risk: "urgent",
        amountAtRisk: cents(500),
        payerName: "Delta Dental",
      },
      { practiceId: pA, occurredAt: NOW }
    )
  );

  // Park it, as `maxAttempts` failures would.
  await withPractice(pA, async () => {
    await requireContext().tx.query("UPDATE domain_events SET dead_lettered = true, attempts = 5 WHERE id = $1", [
      event.id,
    ]);
  });

  assert.equal(
    await withPractice(pB, () => bus.revive(event.id)),
    false,
    "another practice's stuck event is not yours to restart"
  );

  assert.equal(await withPractice(pA, () => bus.revive(event.id)), true);

  const row = await withPractice(pA, async () => {
    const { rows } = await requireContext().tx.query(
      "SELECT dead_lettered, attempts FROM domain_events WHERE id = $1",
      [event.id]
    );
    return rows[0] as { dead_lettered: boolean; attempts: number };
  });
  assert.equal(row.dead_lettered, false);
  assert.equal(row.attempts, 0, "the backoff is a function of attempts; leaving it maxed defers the retry an hour");

  // And reviving something that is not dead-lettered reports so rather than pretending.
  assert.equal(await withPractice(pA, () => bus.revive(event.id)), false);
});

test("the ops event list is the practice's own, and never leaves the tenant", dbTest, async () => {
  const [pA, pB] = [await practice("ops-list-a"), await practice("ops-list-b")];
  const bus = new PostgresEventBus();

  await withPractice(pA, () =>
    bus.publish(
      "verification.needs_review",
      crypto.randomUUID(),
      {
        verificationId: crypto.randomUUID(),
        raisedAt: NOW.toISOString(),
        patientName: "Ada Alpha",
        confidence: 0.4,
        reasons: ["low confidence"],
        priority: 60,
      },
      { practiceId: pA, occurredAt: NOW }
    )
  );

  assert.equal((await withPractice(pA, () => bus.recentEvents(10))).length, 1);
  assert.equal(
    (await withPractice(pB, () => bus.recentEvents(10))).length,
    0,
    "the operations console is tenant-scoped like every other screen"
  );
});
