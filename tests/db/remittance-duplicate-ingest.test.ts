/**
 * Two ingests of ONE payment, racing, against a real database (B-5).
 *
 * ── WHY THIS NEEDS POSTGRES ────────────────────────────────────────────────────────────────────
 * The in-memory store has no transaction, so it cannot exhibit the failure this closes. In
 * Postgres a statement that raises ABORTS its transaction: after
 * `remittances_one_per_dedupe_key` fires, every later command in that request answers `current
 * transaction is aborted, commands ignored until end of transaction block`. The loser therefore
 * lost not just the insert but the whole request — it could not even re-read the row it collided
 * with.
 *
 * That is what made an ordinary redelivery expensive in two different ways:
 *   • the manual upload route returned a 500;
 *   • the ERA worker read the untyped throw as permanent and DEAD-LETTERED the artifact, reporting
 *     a payer's file as abandoned money when its money was already on the ledger.
 *
 * The fix is a SAVEPOINT around the insert plus a typed `DuplicateRemittanceError`, so the loser
 * rolls back only the failed statement and re-reads the winner. These tests drive both paths.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { MockEdiAdapter } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import { createLogger } from "@mermaid/observability";
import {
  DuplicateRemittanceError,
  EraIngestService,
  PgEraArtifactRepository,
  PgEraSourceRepository,
  PgExpectationRepository,
  PgRemittanceRepository,
  RemittanceService,
  type EraSource,
} from "@mermaid/remittance";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const NPI = "1234567893";
const silent = createLogger(() => {});
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
 * A repository whose dedupe PRE-CHECK is blind exactly once.
 *
 * That is the shape of the race rather than a convenience: the loser's courtesy check runs before
 * the winner commits and sees nothing, and its recovery read — the one the savepoint exists to make
 * possible — runs afterwards and sees the row. Everything else, including `save`, is the real
 * Postgres implementation.
 */
class BlindOncePreCheck extends PgRemittanceRepository {
  #blinded = false;
  override async getByDedupeKey(dedupeKey: string) {
    if (this.#blinded) return super.getByDedupeKey(dedupeKey);
    this.#blinded = true;
    return null;
  }
}

const expectation = (practiceControlNumber: string) => ({
  claimId: crypto.randomUUID(),
  verificationId: crypto.randomUUID(),
  submittedAt: "2026-08-25T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: practiceControlNumber,
  payerControlNumber: "556677889",
  totalFee: cents(65),
  expectedInsurancePays: cents(65),
  serviceDate: "2026-08-24",
});

/** A real, balanced 835 from the mock clearinghouse. */
async function era835(controlNumber: string, payeeNpi = NPI): Promise<string> {
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-09-01",
    claims: [
      {
        patientControlNumber: controlNumber,
        payerControlNumber: "556677889",
        patientFirstName: "Ada",
        patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [{ procedureCode: "D0120", charged: cents(65), quantity: 1 }],
        expectedInsurancePays: cents(65),
      },
    ],
  });
  return fetched.raw!.replace(/N1\*PE\*([^~]*)~/, `N1*PE*$1*XX*${payeeNpi}~`);
}

const countRemittances = (practiceId: string): Promise<number> =>
  withPractice(practiceId, async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM remittances");
    return (rows[0] as { n: number }).n;
  });

// ── PATH 1: the manual upload route ──────────────────────────────────────────────────────────────

test("the manual upload path: the loser gets the winner's remittance, not an exception", dbTest, async () => {
  const p = await practice("dupe-upload");
  const raw = await era835("MRM-DUP-001");

  const winnerService = new RemittanceService(
    new PgRemittanceRepository(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );
  await withPractice(p, () => winnerService.recordExpectation(expectation("MRM-DUP-001")));
  const first = await withPractice(p, () => winnerService.ingestRaw(raw, NOW));

  // A second upload of the same file whose pre-check misses — i.e. the race, deterministically.
  const loserService = new RemittanceService(
    new BlindOncePreCheck(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );
  const second = await withPractice(p, () => loserService.ingestRaw(raw, NOW));

  assert.equal(second.remittance.id, first.remittance.id, "the loser is handed the winner's row");
  assert.equal(second.remittance.dedupeKey, first.remittance.dedupeKey);
  assert.equal(await countRemittances(p), 1, "one payment, one remittance row");
});

test("the transaction survives the collision — the savepoint, not the request, absorbs it", dbTest, async () => {
  /**
   * The property the savepoint exists for, asserted directly. Without it the failed INSERT poisons
   * the transaction and the very next statement raises `current transaction is aborted` — so the
   * caller could not re-read, could not audit, and could not commit anything else it had done.
   */
  const p = await practice("dupe-savepoint");
  const raw = await era835("MRM-DUP-002");

  const service = new RemittanceService(
    new PgRemittanceRepository(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );
  await withPractice(p, () => service.recordExpectation(expectation("MRM-DUP-002")));
  const first = await withPractice(p, () => service.ingestRaw(raw, NOW));

  const stillUsable = await withPractice(p, async () => {
    const repo = new PgRemittanceRepository();
    // Provoke the constraint directly, inside this transaction.
    await assert.rejects(
      () => repo.save({ ...first.remittance, id: crypto.randomUUID() }),
      (e: unknown) => e instanceof DuplicateRemittanceError && e.dedupeKey === first.remittance.dedupeKey,
      "the refusal is typed, so a caller can recognise it without matching on prose"
    );
    // …and the transaction still works afterwards. This is the whole point.
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM remittances");
    return (rows[0] as { n: number }).n;
  });

  assert.equal(stillUsable, 1, "the transaction read normally after the collision");
});

// ── PATH 2: the ERA worker ───────────────────────────────────────────────────────────────────────

test("the ERA path: a duplicate artifact settles as ingested, and is NOT dead-lettered", dbTest, async () => {
  const p = await practice("dupe-era");
  const raw = await era835("MRM-DUP-003");

  const source: EraSource = {
    id: "unused-until-registered",
    practiceId: p,
    vendor: "mock",
    credential: "test_credential_never_logged",
    payeeNpi: NPI,
    cursor: null,
    enabled: true,
    lastPolledAt: null,
    lastError: null,
  };

  const registered = await withPractice(p, () => new PgEraSourceRepository().upsert(source));

  // The winner: this payment is already on the ledger under a DIFFERENT artifact, which is exactly
  // how a clearinghouse re-serving one cheque presents it.
  const winnerService = new RemittanceService(
    new PgRemittanceRepository(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );
  await withPractice(p, () => winnerService.recordExpectation(expectation("MRM-DUP-003")));
  await withPractice(p, () =>
    winnerService.ingestArtifact(
      raw,
      { resolution: "source-credential", vendor: "mock", artifactId: "exec-first", expectedPayeeId: NPI },
      NOW
    )
  );

  // The loser: a second artifact carrying the same cheque, whose pre-check misses.
  const adapter = new MockEdiAdapter();
  adapter.stageRemittanceArtifact("exec-second", raw);
  const loserService = new RemittanceService(
    new BlindOncePreCheck(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );

  const outcome = await withPractice(p, async () => {
    const artifacts = new PgEraArtifactRepository();
    const { artifact } = await artifacts.discover({
      practiceId: p,
      sourceId: registered.id,
      fileExecutionId: "exec-second",
      transactionId: null,
      processedAt: null,
    });
    const era = new EraIngestService(adapter, new PgEraSourceRepository(), artifacts, loserService, silent);
    const report = await era.ingestArtifact({ ...registered, id: registered.id }, artifact, NOW);
    return { report, settled: await artifacts.get("exec-second") };
  });

  assert.equal(outcome.report.failed, 0, "a payment already on the ledger is not a failure");
  assert.equal(
    outcome.report.deadLettered,
    0,
    "dead-lettering sends a human to retrieve a file whose money is already posted"
  );
  assert.equal(outcome.settled!.deadLettered, false);
  assert.notEqual(outcome.settled!.status, "failed");
  assert.equal(await countRemittances(p), 1, "and still exactly one remittance for the one payment");
});
