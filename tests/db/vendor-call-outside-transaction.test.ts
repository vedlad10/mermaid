/**
 * A clearinghouse call holds no lock and no transaction while it waits (NEW-10).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `ClaimService.submit` ran as ONE transaction: lock the claim `FOR UPDATE`, validate it, send the
 * 837, write the answer. The vendor timeout is thirty seconds, and for all of it the row lock and
 * one of the pool's ten connections were held.
 *
 * Ten concurrent submissions to a slow clearinghouse is the entire pool. Every other request in the
 * process — a screen loading, a payment being taken at the desk, the outbox draining — then waits on
 * somebody else's server, and it presents as "the app is down", which is the hardest kind of outage
 * to trace back to a vendor being slow.
 *
 * ── HOW THIS IS MEASURED ─────────────────────────────────────────────────────────────────────────
 * A mock adapter blocks until the test releases it. While it blocks, a SECOND, independent
 * connection tries to take `FOR UPDATE NOWAIT` on the claim row. That is the evidence, and it is
 * evidence rather than a stopwatch on purpose: a timing assertion passes on a fast machine with the
 * bug fully present.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { withCurrentPractice, withPractice, withPracticeScope } from "@mermaid/db";
import { ClaimService, ClaimNotSubmittableError, PgClaimRepository } from "@mermaid/claims";
import { MockEdiAdapter } from "@mermaid/edi";
import type { ClaimAcknowledgement, ClaimSubmissionRequest, EdiAdapter, EdiResult } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { PgVerificationRepository, VerificationService, type VerificationInput } from "@mermaid/verification";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const created: string[] = [];
let probe: pg.Client | null = null;

after(async () => {
  if (probe) await probe.end().catch(() => {});
  await dropPractices(...created);
  await shutdown();
});

/** An independent connection, so what it observes is not this process's own transaction. */
async function prober(): Promise<pg.Client> {
  if (probe) return probe;
  probe = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL });
  await probe.connect();
  return probe;
}

const CLEAN: VerificationInput = {
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
  ],
};

/** An adapter that blocks inside `submitClaim` until the test releases it. */
function blockingAdapter(): { adapter: EdiAdapter; entered: Promise<void>; release: () => void } {
  const real = new MockEdiAdapter();
  let announce: () => void = () => {};
  let unblock: () => void = () => {};
  const entered = new Promise<void>((r) => (announce = r));
  const blocked = new Promise<void>((r) => (unblock = r));

  const adapter: EdiAdapter = {
    checkEligibility: (r) => real.checkEligibility(r),
    async submitClaim(r: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      announce();
      await blocked;
      return real.submitClaim(r);
    },
    fetchRemittance: (r) => real.fetchRemittance(r),
    parseRemittance: (raw) => real.parseRemittance(raw),
    parseRemittanceAll: (raw) => real.parseRemittanceAll(raw),
    listRemittanceArtifacts: (r) => real.listRemittanceArtifacts(r),
    fetchRemittanceArtifact: (id) => real.fetchRemittanceArtifact(id),
  };
  return { adapter, entered, release: () => unblock() };
}

/** The real unit of work, exactly as `wiring.ts` passes it when there is a database. */
const UNIT_OF_WORK = { run: <T>(fn: () => Promise<T>): Promise<T> => withCurrentPractice(() => fn()) };

async function readyClaim(practiceId: string, claims: ClaimService): Promise<string> {
  const verification = new VerificationService(
    new PgVerificationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );
  const verified = await withPractice(practiceId, () => verification.create(CLEAN, NOW));
  const payload = (await withPractice(practiceId, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(practiceId, () => claims.createFromVerification(payload, NOW));
  assert.equal(built.claim.status, "ready", "the fixture claim must scrub clean");
  return built.claim.id;
}

test("a slow clearinghouse holds no row lock while it answers", dbTest, async () => {
  const practiceId = await makePractice("vendor-call-lock");
  created.push(practiceId);

  const { adapter, entered, release } = blockingAdapter();
  const claims = new ClaimService(
    new PgClaimRepository(),
    adapter,
    BILLING_PROVIDER,
    new NullEventPublisher(),
    undefined,
    "UTC",
    UNIT_OF_WORK
  );
  const claimId = await readyClaim(practiceId, claims);

  // A practice SCOPE, not a transaction — which is what the self-transacting submit route gives it.
  const submission = withPracticeScope(practiceId, () =>
    claims.submit(claimId, { submittedBy: "biller" }, NOW)
  );
  await entered;

  const c = await prober();
  await c.query("BEGIN");
  let lockError: unknown = null;
  try {
    await c.query("SELECT id FROM claims WHERE id = $1 FOR UPDATE NOWAIT", [claimId]);
  } catch (err) {
    lockError = err;
  }
  await c.query("ROLLBACK");

  assert.equal(
    lockError,
    null,
    `the claim row is still locked while the clearinghouse is being waited on: ${
      lockError instanceof Error ? lockError.message : String(lockError)
    }. Every other path that touches this claim — a correction, a void, the ops screen — blocks for ` +
      `as long as the vendor takes, and so does one of the pool's ten connections.`
  );

  // ── The intent was COMMITTED before the 837 left ──────────────────────────────────────────────
  const attempt = await c.query(
    "SELECT record -> 'submissionAttempt' AS attempt FROM claims WHERE id = $1",
    [claimId]
  );
  const marker = (attempt.rows[0] as { attempt: { startedBy: string } | null }).attempt;
  assert.equal(
    marker?.startedBy,
    "biller",
    "the attempt must be committed before the call — otherwise a crash mid-flight leaves a claim " +
      "indistinguishable from one nobody has touched, and the next person presses Submit again"
  );

  release();
  const view = await submission;
  assert.equal(view.claim.status, "submitted");

  const settled = await c.query(
    "SELECT record -> 'submissionAttempt' AS attempt FROM claims WHERE id = $1",
    [claimId]
  );
  assert.equal(
    (settled.rows[0] as { attempt: unknown }).attempt,
    null,
    "and the marker is cleared once the payer has answered — nothing is in flight any more"
  );
});

test("the in-flight marker is what refuses a second submitter now, not the lock", dbTest, async () => {
  /**
   * ── THE PROPERTY THE LOCK USED TO PROVIDE BY ACCIDENT ────────────────────────────────────────
   * Holding `FOR UPDATE` across the vendor call serialized two presses of Submit: the second
   * blocked, then found the claim `submitted`. Releasing the lock for the call — the entire point
   * of this change — takes that away, so the exclusion has to be stated rather than inherited from
   * a lock held for an unrelated reason.
   *
   * Without this, the fix would have traded a connection-pool stall for a claim filed twice, which
   * is a far worse bug.
   */
  const practiceId = await makePractice("vendor-call-race");
  created.push(practiceId);

  const { adapter, entered, release } = blockingAdapter();
  const claims = new ClaimService(
    new PgClaimRepository(),
    adapter,
    BILLING_PROVIDER,
    new NullEventPublisher(),
    undefined,
    "UTC",
    UNIT_OF_WORK
  );
  const claimId = await readyClaim(practiceId, claims);

  const first = withPracticeScope(practiceId, () =>
    claims.submit(claimId, { submittedBy: "biller-one" }, NOW)
  );
  await entered;

  await assert.rejects(
    () => withPracticeScope(practiceId, () => claims.submit(claimId, { submittedBy: "biller-two" }, NOW)),
    (err: Error) => {
      assert.ok(err instanceof ClaimNotSubmittableError);
      assert.match(err.message, /no answer has come back yet/);
      assert.match(err.message, /biller-one/, "and it says who is waiting on it");
      return true;
    }
  );

  release();
  assert.equal((await first).claim.status, "submitted");
});

test("a stale attempt does not wedge the claim forever", dbTest, async () => {
  /**
   * A process killed between the call and the answer would otherwise leave a claim nobody can file
   * without a database console. Resubmitting is SAFE by construction — `patientControlNumber` is
   * derived from the claim id, so the payer sees the same number and recognises the same claim —
   * which is why the window can expire at all.
   */
  const practiceId = await makePractice("vendor-call-stale");
  created.push(practiceId);

  const claims = new ClaimService(
    new PgClaimRepository(),
    new MockEdiAdapter(),
    BILLING_PROVIDER,
    new NullEventPublisher(),
    undefined,
    "UTC",
    UNIT_OF_WORK
  );
  const claimId = await readyClaim(practiceId, claims);

  await withPractice(practiceId, async () => {
    const repo = new PgClaimRepository();
    const claim = await repo.lockById(claimId);
    await repo.update({
      ...claim!,
      submissionAttempt: {
        // An hour ago: well past the window, which is minutes.
        startedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        startedBy: "a-process-that-died",
        patientControlNumber: "MRM-STALE",
      },
    });
  });

  const view = await withPracticeScope(practiceId, () =>
    claims.submit(claimId, { submittedBy: "biller" }, NOW)
  );
  assert.equal(view.claim.status, "submitted", "an abandoned attempt must not block filing forever");
});
