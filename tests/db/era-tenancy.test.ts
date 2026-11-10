/**
 * ERA tenant isolation, against the real database.
 *
 * ── WHY THESE CANNOT BE IN-MEMORY TESTS ────────────────────────────────────────────────────────
 * The in-memory ERA tests assert the SERVICE's behaviour: that a foreign payee is held, that the
 * cursor does not advance past an unread page. This file asserts something the service cannot
 * promise and could not fake — that Postgres itself refuses to show one practice another practice's
 * ERA sources and artifacts, because the application asked in the wrong tenant context.
 *
 * That distinction is the whole reason RLS exists here. If tenant isolation were only enforced in
 * TypeScript, a single missing filter would be a PHI breach; with `enable_tenant_rls` it is a query
 * that returns nothing. These tests are what prove the second sentence is true rather than intended.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { claimEraArtifacts, claimEraSources, requireContext, withPractice } from "@mermaid/db";
import { PgEraArtifactRepository, PgEraSourceRepository } from "@mermaid/remittance";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const NOW = new Date("2026-08-10T09:00:00Z");

const NPI_A = "1234567893";
const NPI_B = "1999999992";

/**
 * ── THIS FILE USED TO LEAK EVERYTHING IT CREATED ───────────────────────────────────────────────
 *
 * It was the only file in `tests/db/` with no `after` hook, so every practice, ERA source and
 * artifact it made survived the run. That is not merely untidy: a leaked `era_sources` row stays
 * `enabled`, its 300-second lease expires, and it is DUE for ever after. `claim_era_sources` takes
 * `ORDER BY next_poll_at LIMIT p_limit`, oldest first, so the residue is served BEFORE the rows a
 * test has just registered — and "the cross-tenant claim sees every practice" stops seeing them.
 *
 * Measured, not guessed: run this file twice with no cleanup between and it goes 8 pass / 2 fail,
 * then 2 pass / 8 fail. The code under test never changed; the database silted up. On a machine
 * whose database has been used enough it simply fails, and the obvious reading — "the ERA tenant
 * isolation is broken" — is wrong, which is the worst property a red test can have.
 *
 * `dropPractices` now covers `era_artifacts` and `era_sources` too (they arrived with migration 0019
 * and were never added), so this hook is what actually makes the file repeatable.
 */
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/**
 * Claim EVERY due source, not just the first page.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENED ASSERTION ────────────────────────────────────
 * `claim_era_sources` serves `ORDER BY next_poll_at LIMIT p_limit`, oldest first. A test that calls
 * it once with a fixed limit is therefore asserting something about GLOBAL database state, not about
 * its own rows: any due source older than the ones it just registered competes for that page, and
 * once enough exist the test's rows never appear at all.
 *
 * That is exactly what happened. 115 leftover `era_sources` rows had accumulated from runs before
 * the cleanup hook existed, 65 of them permanently due, and a `LIMIT 50` page was filled entirely by
 * litter. The failure was read as an ERA tenant-isolation defect; it was a dirty database.
 *
 * Draining makes the precondition explicit instead of assumed. The assertions on top are unchanged
 * and in fact prove MORE: the poller sees these practices' sources however much unrelated work is
 * queued ahead of them, rather than only when the queue happens to be short.
 *
 * Bounded so a bug in the claim function cannot spin forever — a page that returns nothing ends it,
 * and the ceiling is far above any real backlog this suite creates.
 */
async function drainSources(pageSize = 50, maxPages = 40): Promise<Awaited<ReturnType<typeof claimEraSources>>> {
  const all: Awaited<ReturnType<typeof claimEraSources>> = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await claimEraSources(pageSize);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error(`drainSources hit ${maxPages} pages — the claim function is not draining`);
}

/** The same, for the artifact queue. Same reasoning, same ordering hazard (`ORDER BY created_at`). */
async function drainArtifacts(pageSize = 50, maxPages = 40): Promise<Awaited<ReturnType<typeof claimEraArtifacts>>> {
  const all: Awaited<ReturnType<typeof claimEraArtifacts>> = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await claimEraArtifacts(pageSize);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error(`drainArtifacts hit ${maxPages} pages — the claim function is not draining`);
}

/** Register an ERA source for a practice, inside that practice's own transaction. */
async function registerSource(practiceId: string, credential: string, payeeNpi: string) {
  return withPractice(practiceId, () =>
    new PgEraSourceRepository().upsert({
      practiceId,
      vendor: "mock",
      credential,
      payeeNpi,
      cursor: null,
      enabled: true,
    })
  );
}

test("an ERA source is invisible to every other practice", dbTest, async () => {
  const [pA, pB] = [await practice("era-src-a"), await practice("era-src-b")];
  await registerSource(pA, "test_credential_A", NPI_A);

  assert.equal(await visibleCount(pA, "era_sources"), 1);
  assert.equal(await visibleCount(pB, "era_sources"), 0, "B must not see A's clearinghouse credential");

  // And the typed read agrees with the raw count — a repository cannot reach across either.
  const seenByB = await withPractice(pB, () => new PgEraSourceRepository().get("mock"));
  assert.equal(seenByB, null);
});

test("the credential is encrypted at rest and round-trips only through the repository", dbTest, async () => {
  const p = await practice("era-src-crypto");
  await registerSource(p, "test_credential_secret_value", NPI_A);

  const stored = await withPractice(p, async () => {
    const { rows } = await requireContext().tx.query("SELECT credential FROM era_sources LIMIT 1");
    return (rows[0] as { credential: string }).credential;
  });
  assert.ok(
    !stored.includes("test_credential_secret_value"),
    "the credential that decides tenancy must not sit in the clear in a database backup"
  );

  const read = await withPractice(p, () => new PgEraSourceRepository().get("mock"));
  assert.equal(read!.credential, "test_credential_secret_value");
});

/**
 * The worker resolves an artifact's source BY ITS OWN ID, and that lookup is tenant-scoped.
 *
 * It used to be `get("stedi") ?? get("mock")` — a vendor guess in priority order. With two sources
 * registered, the guess could hand the ingest the wrong credential and, worse, the wrong `payeeNpi`
 * for the tenancy cross-check: a payment from one clearinghouse checked against the other's payee.
 */
test("a source resolves by its own id, and only inside its own practice", dbTest, async () => {
  const [pA, pB] = [await practice("era-byid-a"), await practice("era-byid-b")];
  const sourceA = await registerSource(pA, "test_credential_A", NPI_A);
  const sourceB = await registerSource(pB, "test_credential_B", NPI_B);

  const mine = await withPractice(pA, () => new PgEraSourceRepository().getById(sourceA.id));
  assert.equal(mine!.id, sourceA.id);
  assert.equal(mine!.payeeNpi, NPI_A, "the cross-check NPI must come from the artifact's OWN source");

  // Knowing another practice's source id is not enough to read it — RLS decides, not a WHERE clause.
  const stolen = await withPractice(pA, () => new PgEraSourceRepository().getById(sourceB.id));
  assert.equal(stolen, null, "a source id from another practice must not resolve");

  assert.equal(await withPractice(pA, () => new PgEraSourceRepository().getById("00000000-0000-4000-8000-000000000000")), null);
});

test("an ERA artifact is invisible to every other practice", dbTest, async () => {
  const [pA, pB] = [await practice("era-art-a"), await practice("era-art-b")];
  const sourceA = await registerSource(pA, "test_credential_A", NPI_A);

  await withPractice(pA, () =>
    new PgEraArtifactRepository().discover({
      practiceId: pA,
      sourceId: sourceA.id,
      fileExecutionId: "exec-A-1",
      transactionId: "txn-A",
      processedAt: null,
    })
  );

  assert.equal(await visibleCount(pA, "era_artifacts"), 1);
  assert.equal(await visibleCount(pB, "era_artifacts"), 0);

  // B asking for A's artifact BY ITS EXACT ID still gets nothing. This is the query a confused —
  // or malicious — caller would write, and RLS is what makes the answer empty.
  const stolen = await withPractice(pB, () => new PgEraArtifactRepository().get("exec-A-1"));
  assert.equal(stolen, null, "knowing another practice's artifact id must not be enough to read it");
});

test("two practices can hold the SAME fileExecutionId without colliding", dbTest, async () => {
  /**
   * The uniqueness is `(practice_id, file_execution_id)`, not `file_execution_id` alone. Two
   * practices poll two different clearinghouse accounts whose id namespaces are not coordinated, so
   * a global unique index would let one practice's artifact block another's — a denial of service
   * on somebody else's money, delivered by coincidence.
   */
  const [pA, pB] = [await practice("era-dup-a"), await practice("era-dup-b")];
  const sourceA = await registerSource(pA, "test_credential_A", NPI_A);
  const sourceB = await registerSource(pB, "test_credential_B", NPI_B);

  const discover = (practiceId: string, sourceId: string) =>
    withPractice(practiceId, () =>
      new PgEraArtifactRepository().discover({
        practiceId,
        sourceId,
        fileExecutionId: "exec-SHARED",
        transactionId: null,
        processedAt: null,
      })
    );

  const a = await discover(pA, sourceA.id);
  const b = await discover(pB, sourceB.id);
  assert.equal(a.created, true);
  assert.equal(b.created, true, "the same vendor id in two accounts is two different artifacts");
  assert.notEqual(a.artifact.id, b.artifact.id);
});

test("re-discovering an artifact is idempotent and does not resurrect finished work", dbTest, async () => {
  const p = await practice("era-rediscover");
  const source = await registerSource(p, "test_credential", NPI_A);

  const first = await withPractice(p, () =>
    new PgEraArtifactRepository().discover({
      practiceId: p,
      sourceId: source.id,
      fileExecutionId: "exec-1",
      transactionId: null,
      processedAt: null,
    })
  );
  assert.equal(first.created, true);

  // Finish it, then have the clearinghouse offer it again — which it does, routinely.
  await withPractice(p, () =>
    new PgEraArtifactRepository().settle(first.artifact.id, "ingested", { remittanceCount: 1, at: NOW })
  );

  const second = await withPractice(p, () =>
    new PgEraArtifactRepository().discover({
      practiceId: p,
      sourceId: source.id,
      fileExecutionId: "exec-1",
      transactionId: null,
      processedAt: null,
    })
  );
  assert.equal(second.created, false);
  assert.equal(second.artifact.status, "ingested", "re-offering finished work must not make it pending again");
  assert.equal(await visibleCount(p, "era_artifacts"), 1);
});

test("the cross-tenant claim sees every practice, and hands back each one's own rows", dbTest, async () => {
  /**
   * The one audited hole through RLS. It must see across practices — that is its job — and every
   * row it returns must carry the practice it belongs to, because that value is what the worker
   * then opens a tenant transaction with. A claim that returned rows without a practice_id would
   * leave the worker guessing, which is the failure this whole design exists to prevent.
   */
  const [pA, pB] = [await practice("era-claim-a"), await practice("era-claim-b")];
  await registerSource(pA, "test_credential_A", NPI_A);
  await registerSource(pB, "test_credential_B", NPI_B);

  const claimed = await drainSources();
  const mine = claimed.filter((row) => row.practice_id === pA || row.practice_id === pB);
  assert.equal(mine.length, 2, "the poller must see both practices' due sources");
  for (const row of mine) {
    assert.ok(row.practice_id, "every claimed row must name the practice it belongs to");
    assert.ok(row.id);
  }
  // The two practices' NPIs came back attached to the right rows.
  assert.equal(mine.find((r) => r.practice_id === pA)!.payee_npi, NPI_A);
  assert.equal(mine.find((r) => r.practice_id === pB)!.payee_npi, NPI_B);
});

test("a claimed source is leased — a second claim does not hand it out again", dbTest, async () => {
  const p = await practice("era-lease");
  await registerSource(p, "test_credential", NPI_A);

  const first = (await drainSources()).filter((r) => r.practice_id === p);
  assert.equal(first.length, 1);

  const second = (await drainSources()).filter((r) => r.practice_id === p);
  assert.equal(second.length, 0, "two workers must not poll one clearinghouse account simultaneously");
});

test("a discovered artifact is claimable, and claiming leases it", dbTest, async () => {
  const p = await practice("era-artifact-claim");
  const source = await registerSource(p, "test_credential", NPI_A);
  await withPractice(p, () =>
    new PgEraArtifactRepository().discover({
      practiceId: p,
      sourceId: source.id,
      fileExecutionId: "exec-claimable",
      transactionId: null,
      processedAt: null,
    })
  );

  const first = (await drainArtifacts()).filter((r) => r.practice_id === p);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.file_execution_id, "exec-claimable");

  const second = (await drainArtifacts()).filter((r) => r.practice_id === p);
  assert.equal(second.length, 0, "leased, so a second worker does not fetch the same ERA");
});

test("a dead-lettered artifact stops being claimed", dbTest, async () => {
  const p = await practice("era-deadletter");
  const source = await registerSource(p, "test_credential", NPI_A);
  const { artifact } = await withPractice(p, () =>
    new PgEraArtifactRepository().discover({
      practiceId: p,
      sourceId: source.id,
      fileExecutionId: "exec-dead",
      transactionId: null,
      processedAt: null,
    })
  );

  await withPractice(p, () =>
    new PgEraArtifactRepository().reschedule(artifact.id, "permanent failure", NOW, true)
  );

  const claimed = (await drainArtifacts()).filter((r) => r.practice_id === p);
  assert.equal(claimed.length, 0, "a dead letter is a human's problem, not a worker's loop");

  // But it is still ON the ledger — dead-lettered is not deleted. Nothing is lost.
  assert.equal(await visibleCount(p, "era_artifacts"), 1);
  const still = await withPractice(p, () => new PgEraArtifactRepository().get("exec-dead"));
  assert.equal(still!.deadLettered, true);
  assert.match(still!.lastError ?? "", /permanent failure/);
});

test("re-registering a credential does NOT rewind the polling cursor", dbTest, async () => {
  /**
   * Rotating a key or correcting an NPI must not re-offer every ERA the practice has ever taken in.
   * The remittance dedupe key would stop the money posting twice, but the practice would still face
   * a queue of hundreds of artifacts to re-process for nothing.
   */
  const p = await practice("era-cursor-keep");
  const source = await registerSource(p, "test_credential_v1", NPI_A);
  await withPractice(p, () => new PgEraSourceRepository().recordPollSuccess(source.id, "page-42", NOW));

  await registerSource(p, "test_credential_v2", NPI_B);

  const after = await withPractice(p, () => new PgEraSourceRepository().get("mock"));
  assert.equal(after!.cursor, "page-42", "a credential rotation must not rewind history");
  assert.equal(after!.credential, "test_credential_v2");
  assert.equal(after!.payeeNpi, NPI_B);
});

// ── CONCURRENCY — what `FOR UPDATE SKIP LOCKED` is actually for ───────────────────────────────
//
// Every test above calls the claim functions SEQUENTIALLY, which cannot observe the property they
// exist for. The whole reason `claim_era_sources` / `claim_era_artifacts` use `FOR UPDATE SKIP
// LOCKED` is that N workers may poll the same table at the same instant and must take DISJOINT work
// — one worker fetching an ERA another worker is already fetching is a duplicate retrieval, and the
// only thing standing between that and a duplicate posting is the remittance dedupe key.
//
// These fire the claims genuinely in parallel (separate pool connections, overlapping transactions)
// and assert on the UNION: every row handed out exactly once, and nothing lost.

test("two workers claiming sources at once take disjoint work — nothing twice, nothing dropped", dbTest, async () => {
  const practices: string[] = [];
  for (let i = 0; i < 8; i++) {
    const p = await practice(`era-race-src-${i}`);
    await registerSource(p, `test_credential_${i}`, NPI_A);
    practices.push(p);
  }

  /**
   * FOUR pollers, in flight together, each asking for the whole set. `Promise.all` over independent
   * transactions is real overlap: each takes its own pooled connection and none waits for another.
   *
   * The worker count is deliberate rather than incidental. With two workers and a `LIMIT` equal to
   * the row count, the first can finish before the second begins and the test passes even with the
   * row locking removed — measured, not assumed. Four workers all demanding every row forces the
   * contention this guard exists for, and the mutation (dropping `FOR UPDATE SKIP LOCKED`) then
   * fails it reliably.
   */
  const workers = await Promise.all([
    claimEraSources(8),
    claimEraSources(8),
    claimEraSources(8),
    claimEraSources(8),
  ]);
  const ids = workers.flat().filter((r) => practices.includes(r.practice_id)).map((r) => r.id);

  assert.equal(new Set(ids).size, ids.length, "a source handed to two workers is a duplicate retrieval");
  assert.equal(
    new Set(ids).size,
    practices.length,
    "and between them the workers must have taken every due source — SKIP LOCKED skips locks, not work"
  );
});

test("two workers claiming artifacts at once take disjoint work", dbTest, async () => {
  const p = await practice("era-race-artifacts");
  const source = await registerSource(p, "test_credential", NPI_A);
  for (let i = 0; i < 8; i++) {
    await withPractice(p, () =>
      new PgEraArtifactRepository().discover({
        practiceId: p,
        sourceId: source.id,
        fileExecutionId: `exec-race-${i}`,
        transactionId: null,
        processedAt: null,
      })
    );
  }

  const [workerA, workerB] = await Promise.all([claimEraArtifacts(8), claimEraArtifacts(8)]);

  const mine = [...workerA, ...workerB].filter((r) => r.practice_id === p);
  const ids = mine.map((r) => r.id);

  assert.equal(new Set(ids).size, ids.length, "one ERA fetched twice is money at risk of posting twice");
  assert.equal(new Set(ids).size, 8, "and no artifact may be skipped by the race");
});

test("a source claimed by one worker is invisible to a second for the whole lease", dbTest, async () => {
  /**
   * The lease is what stops two workers hammering one clearinghouse account. Asserted across
   * genuinely concurrent claims rather than sequential ones, because sequential calls would pass
   * even if the lease were applied AFTER the row was handed out — the ordering that would break
   * under real concurrency.
   */
  const p = await practice("era-race-lease");
  await registerSource(p, "test_credential", NPI_A);

  const results = await Promise.all([claimEraSources(50), claimEraSources(50), claimEraSources(50)]);
  const takes = results.flat().filter((r) => r.practice_id === p);

  assert.equal(takes.length, 1, "exactly one of three simultaneous workers may poll this account");
});

// ── FAIL CLOSED — no tenant context means no data, never all data ─────────────────────────────

test("the ERA repositories refuse to run with no practice context at all", dbTest, async () => {
  /**
   * `requireContext()` throws outside a tenant transaction, by design: in a multi-tenant system a
   * query with no practice context is a bug, and failing loudly beats quietly returning nothing —
   * or, under a mis-provisioned role, everything.
   *
   * The queue functions are the deliberate, audited exception (they run `withoutPractice` and are
   * SECURITY DEFINER); the REPOSITORIES must never be.
   */
  await assert.rejects(
    () => new PgEraSourceRepository().get("mock"),
    /no ambient database transaction/,
    "a source read outside a tenant transaction must throw, not return null"
  );
  await assert.rejects(
    () => new PgEraArtifactRepository().get("exec-anything"),
    /no ambient database transaction/
  );
  await assert.rejects(() => new PgEraArtifactRepository().list(), /no ambient database transaction/);
});

test("practice A cannot settle, reschedule or read practice B's artifact — RLS, not a WHERE clause", dbTest, async () => {
  /**
   * The worker opens `withPractice(row.practice_id)` from the claim's own answer, so the tenant is
   * decided before any 835 is read. This proves the floor underneath that: even if a worker were
   * handed the WRONG practice — a bug, a confused retry, a hostile caller — the database refuses.
   *
   * `settle` and `reschedule` matter as much as `get`: they are the writes that mark money as
   * handled, and one practice marking another's ERA done would strand a real payment silently.
   */
  const [pA, pB] = [await practice("era-xtenant-a"), await practice("era-xtenant-b")];
  const sourceA = await registerSource(pA, "test_credential_A", NPI_A);
  const { artifact } = await withPractice(pA, () =>
    new PgEraArtifactRepository().discover({
      practiceId: pA,
      sourceId: sourceA.id,
      fileExecutionId: "exec-owned-by-A",
      transactionId: null,
      processedAt: null,
    })
  );

  // B cannot see it, by id or by listing.
  assert.equal(await withPractice(pB, () => new PgEraArtifactRepository().get("exec-owned-by-A")), null);
  assert.deepEqual(await withPractice(pB, () => new PgEraArtifactRepository().list()), []);

  // B's writes against A's artifact id land on nothing. RLS scopes the UPDATE's own WHERE.
  await withPractice(pB, () =>
    new PgEraArtifactRepository().settle(artifact.id, "ingested", { remittanceCount: 99, at: NOW })
  );
  await withPractice(pB, () =>
    new PgEraArtifactRepository().reschedule(artifact.id, "B says this failed", NOW, true)
  );

  // A's artifact is exactly as A left it.
  const mine = await withPractice(pA, () => new PgEraArtifactRepository().get("exec-owned-by-A"));
  assert.equal(mine!.status, "pending", "another practice must not be able to mark this ERA handled");
  assert.equal(mine!.deadLettered, false);
  assert.equal(mine!.lastError, null);
});

test("practice A cannot rewind or disable practice B's polling cursor", dbTest, async () => {
  // The cursor decides which ERAs are offered next. One practice moving another's would skip real
  // money, and it would look exactly like the clearinghouse having nothing to send.
  const [pA, pB] = [await practice("era-xcursor-a"), await practice("era-xcursor-b")];
  const sourceA = await registerSource(pA, "test_credential_A", NPI_A);
  await withPractice(pA, () => new PgEraSourceRepository().recordPollSuccess(sourceA.id, "page-100", NOW));

  await withPractice(pB, () => new PgEraSourceRepository().recordPollSuccess(sourceA.id, "page-1", NOW));
  await withPractice(pB, () => new PgEraSourceRepository().recordPollFailure(sourceA.id, "B says broken", NOW));

  const mine = await withPractice(pA, () => new PgEraSourceRepository().get("mock"));
  assert.equal(mine!.cursor, "page-100", "another practice must not be able to rewind this cursor");
  assert.equal(mine!.lastError, null);
});
