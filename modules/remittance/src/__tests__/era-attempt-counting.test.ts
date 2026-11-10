/**
 * An ERA gets all five attempts before it is dead-lettered (NEW-18).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `#failArtifact` computed the attempt number as `artifact.attempts + 1`. That is right for a store
 * that counts an attempt when one FAILS, and wrong for one that counts when the artifact is HANDED
 * OUT — which is what Postgres does: `claim_era_artifacts` increments as it leases the row, so a
 * worker that crashes mid-ingest still burns an attempt and a poisonous file cannot be retried
 * forever by killing the process.
 *
 * Adding one on top counted the same attempt twice. An ERA carrying real money went to the hand-work
 * queue on its FOURTH attempt while `ARTIFACT_MAX_ATTEMPTS` said five — and the number that would
 * have explained it was itself wrong, because the log reported five about four.
 *
 * ── WHY THE FIX IS A DECLARED PROPERTY AND NOT A GUESS ───────────────────────────────────────────
 * The service cannot infer which convention its store uses: "attempts is already non-zero" is also
 * true on the legitimate second try of a retried artifact. And making the two agree by removing the
 * claim-time increment would give up the crash protection that is the reason it exists. So the
 * repository says which it is, and the service asks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import {
  ARTIFACT_MAX_ATTEMPTS,
  EraIngestService,
  InMemoryEraArtifactRepository,
  InMemoryEraSourceRepository,
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceService,
} from "../index.ts";
import { PgEraArtifactRepository } from "../era/repository.pg.ts";
import type { EraSource } from "../era/types.ts";

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});
const PRACTICE_A = "11111111-1111-4111-8111-111111111111";
const NPI_A = "1234567893";

/**
 * `InMemoryEraArtifactRepository` that counts an attempt on HAND-OUT, as Postgres does.
 *
 * The one behavioural difference between the two stores, isolated. `reschedule` does not increment,
 * because the claim already did — which is exactly the Postgres arrangement the service now asks
 * about instead of assuming.
 */
class ClaimCountingArtifacts extends InMemoryEraArtifactRepository {
  override readonly countsAttemptsOnClaim = true;

  override async reschedule(id: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void> {
    const before = (await this.list()).find((a) => a.id === id)?.attempts ?? 0;
    await super.reschedule(id, error, nextAttemptAt, deadLetter);
    for (const a of await this.list()) if (a.id === id) a.attempts = before;
  }
}

/** One practice's ERA stack, over whichever artifact store the test wants. */
function practice(practiceId: string, artifacts: InMemoryEraArtifactRepository = new InMemoryEraArtifactRepository()) {
  const adapter = new MockEdiAdapter();
  const repo = new InMemoryRemittanceRepository();
  const expectations = new InMemoryExpectationRepository();
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const remittance = new RemittanceService(repo, expectations, adapter, bus);
  const sources = new InMemoryEraSourceRepository();
  const era = new EraIngestService(adapter, sources, artifacts, remittance, silent);

  const source: EraSource = {
    id: `src-${practiceId}`,
    practiceId,
    vendor: "mock",
    credential: "test-credential",
    payeeNpi: NPI_A,
    cursor: null,
    enabled: true,
    lastPolledAt: null,
    lastError: null,
  };
  return { adapter, artifacts, era, source };
}

test("the two stores declare their counting convention, and they differ", () => {
  /**
   * The declaration IS the fix. If these ever come to agree, one of them has changed how it counts
   * and the service's arithmetic has to change with it — which is exactly the coupling that was
   * implicit before and got the answer wrong.
   */
  assert.equal(
    new PgEraArtifactRepository().countsAttemptsOnClaim,
    true,
    "claim_era_artifacts increments as it leases the row"
  );
  assert.equal(
    new InMemoryEraArtifactRepository().countsAttemptsOnClaim,
    false,
    "the in-memory store has no claim step; it counts when a failure is recorded"
  );
});

test("the ceiling is five, and it is read from one place", () => {
  /**
   * Pinned because the off-by-one made the effective ceiling four while this constant said five, and
   * a reader reconciling the two would have believed the constant.
   */
  assert.equal(ARTIFACT_MAX_ATTEMPTS, 5);
});

test("under the CLAIM convention an artifact is dead-lettered on the FIFTH attempt, not the fourth", async () => {
  /**
   * The real service, over a store that counts the way Postgres does.
   *
   * `ClaimCountingArtifacts` is `InMemoryEraArtifactRepository` with the one difference that
   * matters: it declares `countsAttemptsOnClaim` and increments on hand-out instead of on failure,
   * exactly as `claim_era_artifacts` does. That is the smallest double that can reproduce the bug —
   * a live-database test would prove the same thing far more slowly, and the arithmetic is not in
   * the database.
   */
  const p = practice(PRACTICE_A, new ClaimCountingArtifacts());
  p.adapter.stageRemittanceArtifact("exec-timeout", "unused", {
    failure: { code: "timeout", message: "Stedi did not respond within 30000ms.", retryable: true },
  });
  await p.era.poll(p.source, NOW);

  const deadLetteredAfter: number[] = [];
  for (let attempt = 1; attempt <= ARTIFACT_MAX_ATTEMPTS; attempt++) {
    // The claim: hand the artifact out, counting the hand-out — what Postgres does before the
    // service ever sees the row.
    const artifact = { ...(await p.artifacts.list())[0]!, attempts: attempt };
    await p.era.ingestArtifact(p.source, artifact, NOW);
    if ((await p.artifacts.list())[0]!.deadLettered) deadLetteredAfter.push(attempt);
  }

  assert.deepEqual(
    deadLetteredAfter,
    [ARTIFACT_MAX_ATTEMPTS],
    `an artifact must survive attempts 1-${ARTIFACT_MAX_ATTEMPTS - 1} and dead-letter on ` +
      `${ARTIFACT_MAX_ATTEMPTS}. Before the fix it dead-lettered on ${ARTIFACT_MAX_ATTEMPTS - 1}, ` +
      `because the claim's increment and the service's +1 counted the same attempt twice — a ` +
      `payer's money file reached the hand-work queue a whole retry early.`
  );
});

test("under the FAILURE convention the count is unchanged — the in-memory path still works", async () => {
  /**
   * The control. The fix is a branch, and a branch that silently changed the other side would be a
   * new bug wearing the old one's clothes.
   */
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-timeout", "unused", {
    failure: { code: "timeout", message: "Stedi did not respond within 30000ms.", retryable: true },
  });
  await p.era.poll(p.source, NOW);

  for (let i = 0; i < ARTIFACT_MAX_ATTEMPTS - 1; i++) {
    await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);
    assert.equal(
      (await p.artifacts.list())[0]!.deadLettered,
      false,
      `attempt ${i + 1} of ${ARTIFACT_MAX_ATTEMPTS} must still be retried`
    );
  }
  await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);
  assert.equal((await p.artifacts.list())[0]!.deadLettered, true, "and the last one stops it");
});
