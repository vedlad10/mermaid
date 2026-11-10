/**
 * Postgres implementations of `RemittanceRepository` and `ExpectationRepository` — drop-ins behind
 * the seams M5 established.
 *
 * Two things here are more than mechanical translation:
 *
 *  1. **Idempotency is enforced by the database.** `remittances_one_per_dedupe_key` is what actually
 *     guarantees one payment posts exactly once. The service checks first, but that is
 *     check-then-act: two concurrent ingests of the same re-served ERA can both see "not posted yet".
 *     A double-posted remittance corrupts the ledger a practice bills patients from, so the UNIQUE
 *     constraint is the real guarantee and this repository is written to rely on it.
 *
 *  2. **Postings are projected into their own table.** The remittance aggregate remains
 *     authoritative, but the recovery queue — "where is our missing revenue?" — must be an indexed
 *     query across every remittance, not a scan of JSONB documents. Postings are rewritten inside
 *     the same transaction as their parent, so the projection can never drift from the aggregate.
 */
import { execute, fromDocument, isoDate, isUniqueViolation, many, one, practiceId, toDocument, tx } from "@mermaid/db";
import { decryptPhi, encryptPhi, type PhiLocation } from "@mermaid/crypto";
import type { Cents, Versioned } from "@mermaid/shared";
import { assignedOf, workStatusOf, type CoordinationCase } from "./coordination.ts";
import {
  DuplicateRemittanceError,
  type CoordinationRepository,
  type ExpectationRepository,
  type HeldRemittanceSummary,
  type RemittanceFilter,
  type RemittanceRepository,
} from "./repository.ts";
import type { ClaimExpectation, Posting, Remittance } from "./types.ts";

/** Schema version of the persisted remittance document. Bump + add an upcaster on any shape change. */
export const REMITTANCE_RECORD_VERSION = 4;

/**
 * v1 → v2 (M12): `providerAdjustments` entries gained `reasonCode` and `referenceId`.
 *
 * Derived from the `reason` string every v1 document already stored, which is PLB03 verbatim — so
 * this is a re-read of data that was always there, not an invention. A v1 document whose reason
 * carried no composite yields `referenceId: null`, which is the same answer the parser gives that
 * file today.
 *
 * No SQL migration: the shape lives inside the JSONB aggregate, and this is the mechanism that
 * exists for exactly that. Documents are upcast on read and rewritten at v2 on the next save.
 */
const UPCASTERS = {
  1: (doc: Versioned): Versioned => {
    const record = doc as Versioned & { providerAdjustments?: { reason?: string }[] };
    const adjustments = (record.providerAdjustments ?? []).map((p) => {
      const [code, reference] = (p.reason ?? "").split(/[:>]/);
      return { ...p, reasonCode: code ?? "", referenceId: reference ? reference : null };
    });
    return { ...record, providerAdjustments: adjustments, snapshot_version: 2 } as Versioned;
  },
  /**
   * v2 → v3: `usageIndicator` (ISA15) and `rejection`, and the `rejected` status they belong to.
   *
   * Both are genuinely UNKNOWN for a v2 document rather than derivable, so nothing is invented:
   * `usageIndicator` becomes `null` ("the envelope was not read"), which the gate never treats as a
   * test file, and `rejection` stays absent because no v2 document could have been rejected — the
   * status did not exist. The raw 835 is deliberately NOT re-parsed here to recover ISA15: an
   * upcaster runs on every read, and decrypting and parsing a PHI document to answer a question
   * nobody asked of this row would be a cost paid on the hot path for no reader.
   */
  2: (doc: Versioned): Versioned => {
    const record = doc as Versioned & { usageIndicator?: unknown };
    return { ...record, usageIndicator: record.usageIndicator ?? null, snapshot_version: 3 } as Versioned;
  },
  /**
   * v3 → v4 (0034): a posting may carry `crossoverCarrier`, the NM1*TT the payer named. Genuinely
   * unknown for a v3 document — it was never read — so it stays absent, which every reader treats as
   * "the payer named no other plan". The retained 835 is deliberately not re-parsed here, for the
   * same reason v2 → v3 did not: an upcaster runs on every read.
   */
  3: (doc: Versioned): Versioned => ({ ...doc, snapshot_version: 4 }) as Versioned,
};

interface Row {
  record: unknown;
}

/**
 * PHI at rest (M10). A raw 835 names every patient on the advice, every procedure they had, and what
 * was paid for it — the single richest PHI document this system stores. It is kept because a
 * reconciliation you cannot evidence against the payer's own file is not a reconciliation, and it is
 * encrypted in both places it lives: the `raw_835` column and the aggregate document.
 */
const withRaw = (remittance: Remittance, transform: (v: string) => string | null): Remittance =>
  remittance.raw835 ? { ...remittance, raw835: transform(remittance.raw835) } : remittance;

/**
 * Where this aggregate's PHI lives, for the encryption binding (NEW-25).
 *
 * The id comes from the aggregate itself — ids are generated by the module, not the database — and
 * the practice from the ambient transaction, which RLS has already scoped to this row's own tenant.
 * Re-derived on every read from where the value was FOUND, never stored, so a ciphertext moved to
 * another row computes a different AAD and fails its tag check instead of decrypting there.
 */
const rawAt = (remittanceId: string, column: string): PhiLocation => ({
  practiceId: practiceId(),
  table: "remittances",
  column,
  rowId: remittanceId,
});

const toRemittance = (row: Row): Remittance => {
  const remittance = fromDocument<Remittance>(row.record, REMITTANCE_RECORD_VERSION, UPCASTERS);
  return withRaw(remittance, (v) => decryptPhi(v, rawAt(remittance.id, "record.raw835")));
};

/**
 * The document as stored: identical to the aggregate except that the raw 835 is ciphertext.
 *
 * The COLUMN is part of the binding, and the 835 lives in two places — this document and the
 * `raw_835` column beside it. They are bound separately (`record.raw835` and `raw_835`), so the two
 * copies are not interchangeable either: a value lifted from the column into the document, or the
 * reverse, fails its tag check.
 */
const storedDocument = (remittance: Remittance) =>
  toDocument(
    withRaw(remittance, (v) => encryptPhi(v, rawAt(remittance.id, "record.raw835"))),
    REMITTANCE_RECORD_VERSION
  );

/**
 * The savepoint the duplicate-insert probe runs inside.
 *
 * ── WHY A SAVEPOINT IS NOT OPTIONAL HERE ───────────────────────────────────────────────────────
 * A statement that raises in Postgres puts its transaction into an ABORTED state: every subsequent
 * command answers `current transaction is aborted, commands ignored until end of transaction
 * block`. So the moment `remittances_one_per_dedupe_key` fires, the request has lost not just the
 * insert but the transaction — the caller cannot re-read the row it collided with, cannot write an
 * audit line, and cannot commit anything else it had already done.
 *
 * That is what turned an ordinary redelivery into a 500 on the upload route and a dead-lettered
 * artifact on the ERA path. Rolling back to a savepoint discards only the failed INSERT and leaves
 * the transaction usable, which is what lets the service treat the collision as the no-op it is.
 *
 * A fixed name is safe: `save()` never nests inside itself, and `ROLLBACK TO`/`RELEASE` bind to the
 * most recent savepoint of that name.
 */
const INSERT_SAVEPOINT = "remittance_insert";

export class PgRemittanceRepository implements RemittanceRepository {
  async save(remittance: Remittance): Promise<Remittance> {
    const t = tx();
    await t.query(`SAVEPOINT ${INSERT_SAVEPOINT}`);
    try {
      await execute(
        t,
        `INSERT INTO remittances
           (id, practice_id, trace_number, dedupe_key, status, payer_name, payee_name,
            payment_total_cents, payment_method, payment_date, balanced, hold_reason, raw_835,
            record, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          remittance.id,
          practiceId(),
          remittance.traceNumber,
          remittance.dedupeKey,
          remittance.status,
          remittance.payerName,
          remittance.payeeName,
          remittance.paymentTotal,
          remittance.paymentMethod || null,
          remittance.paymentDate || null,
          remittance.balanced,
          remittance.holdReason,
          encryptPhi(remittance.raw835, rawAt(remittance.id, "raw_835")),
          storedDocument(remittance),
          remittance.receivedAt,
        ]
      );
    } catch (e) {
      // FIRST, unconditionally — until this runs the transaction is aborted and nothing else can
      // be asked of it, including the re-read the caller is about to attempt.
      await t.query(`ROLLBACK TO SAVEPOINT ${INSERT_SAVEPOINT}`);
      if (isUniqueViolation(e, "remittances_one_per_dedupe_key")) {
        throw new DuplicateRemittanceError(remittance.dedupeKey);
      }
      if (isUniqueViolation(e)) throw new Error(`remittance ${remittance.id} already exists`);
      throw e;
    }
    // Released rather than left standing: one request can ingest several advices from one ERA file,
    // and an unreleased savepoint per advice is state the transaction carries for no reason.
    await t.query(`RELEASE SAVEPOINT ${INSERT_SAVEPOINT}`);
    await this.#writePostings(remittance);
    return remittance;
  }

  async update(remittance: Remittance): Promise<Remittance> {
    const changed = await execute(
      tx(),
      `UPDATE remittances
          SET status = $2,
              balanced = $3,
              hold_reason = $4,
              payment_total_cents = $5,
              record = $6
        WHERE id = $1`,
      [
        remittance.id,
        remittance.status,
        remittance.balanced,
        remittance.holdReason,
        remittance.paymentTotal,
        storedDocument(remittance),
      ]
    );
    if (changed === 0) throw new Error(`remittance ${remittance.id} not found`);
    await this.#writePostings(remittance);
    return remittance;
  }

  async getById(id: string): Promise<Remittance | null> {
    const row = await one<Row>(tx(), "SELECT record FROM remittances WHERE id = $1", [id]);
    return row ? toRemittance(row) : null;
  }

  /**
   * The mutating read. `FOR UPDATE` makes a second releaser WAIT and then re-read the committed
   * row, so it sees `posted` and returns rather than publishing the same money a second time. See
   * the seam's doc comment for why the downstream idempotency keys do not cover this.
   */
  async lockById(id: string): Promise<Remittance | null> {
    const row = await one<Row>(tx(), "SELECT record FROM remittances WHERE id = $1 FOR UPDATE", [id]);
    return row ? toRemittance(row) : null;
  }

  /** The idempotency lookup. */
  async getByDedupeKey(dedupeKey: string): Promise<Remittance | null> {
    const row = await one<Row>(tx(), "SELECT record FROM remittances WHERE dedupe_key = $1", [dedupeKey]);
    return row ? toRemittance(row) : null;
  }

  async list(filter?: RemittanceFilter): Promise<Remittance[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.needsAttention) {
      // Held, or holding money someone still owes us. Answered from the postings projection so it
      // stays an index scan rather than a JSONB walk.
      // `actionable` is frozen at ingest and stays true after a won appeal pays the money back, so
      // it cannot be the whole test: it kept fully-recovered advices on the Today board. Pair it
      // with an outstanding balance, mirroring `outstandingOf` in view.ts.
      where.push(
        // A REJECTED advice keeps its postings rows as evidence; they must never read as money owed,
        // so the postings branch is confined to posted advices.
        `(status = 'held' OR (status = 'posted' AND EXISTS (
            SELECT 1 FROM postings p
             WHERE p.remittance_id = remittances.id
               AND p.actionable
               AND (COALESCE(p.recoverable_cents, 0) - COALESCE(p.resolved_recoverable_cents, 0) > 0
                    OR COALESCE(p.unexplained_cents, 0) > 0))))`
      );
    }
    const sql =
      `SELECT record FROM remittances` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY received_at DESC, id DESC`;
    return (await many<Row>(tx(), sql, params)).map(toRemittance);
  }

  /**
   * The held pile, in one statement.
   *
   * Reads the indexed columns only — never `record` — so the monitor's per-tick, per-practice cost
   * stays a narrow aggregate rather than decrypting every raw 835 the practice has ever received.
   *
   * `COUNT`/`MIN`/`SUM` in a single row so the three numbers describe the same instant. Taken as
   * three statements, a remittance released between them would report a count that excludes it and
   * a total that still carries its money.
   *
   * RLS scopes this to the caller's practice, exactly as it scopes `list()`, and `tx()` refuses to
   * resolve without a practice context at all — so this fails closed rather than answering "nothing
   * is held" to a caller who never established a tenant. There is no cross-tenant variant of this
   * query and there must not be one: the monitor enumerates practices and asks each inside its own
   * transaction, the same shape the reconciliation check uses.
   */
  async heldSummary(): Promise<HeldRemittanceSummary> {
    const row = await one<{ count: string; oldest: Date | null; total: string | null }>(
      tx(),
      `SELECT COUNT(*)::text                             AS count,
              MIN(received_at)                           AS oldest,
              COALESCE(SUM(payment_total_cents), 0)::text AS total
         FROM remittances
        WHERE status = 'held'`
    );
    return {
      count: Number(row?.count ?? 0),
      oldestReceivedAt: row?.oldest ? row.oldest.toISOString() : null,
      // SUM over bigint comes back as a string; Number() on it is exact well past any practice's
      // lifetime of cents, and parsing here keeps the seam's contract integer-cents like everywhere.
      totalCents: Number(row?.total ?? 0),
    };
  }

  async priorPaymentMethod(payerName: string, excludingRemittanceId: string): Promise<string | null> {
    /**
     * `UPPER(TRIM(...))` on both sides rather than a plain `=`, because the comparison decides
     * whether a practice is told its payer has started charging it to be paid. A payer that prints
     * "Delta Dental" one month and "DELTA DENTAL " the next has not become a different payer, and
     * reading it as one would report every such advice as a first sighting and never as a reversion.
     *
     * RLS scopes this to the practice, as it does every statement here — no `practice_id` predicate
     * is written by hand anywhere in this repository.
     */
    const row = await one<{ payment_method: string | null }>(
      tx(),
      `SELECT payment_method
         FROM remittances
        WHERE UPPER(TRIM(payer_name)) = UPPER(TRIM($1))
          AND id <> $2
        ORDER BY received_at DESC
        LIMIT 1`,
      [payerName, excludingRemittanceId]
    );
    if (!row) return null;
    return row.payment_method ?? "";
  }

  /**
   * Rewrite this remittance's postings projection. Delete-then-insert inside the parent's
   * transaction: postings are immutable in the domain, but a held remittance's postings are
   * (re)stamped when it is released, and a wholesale rewrite cannot leave a stale row behind.
   */
  async #writePostings(remittance: Remittance): Promise<void> {
    await execute(tx(), "DELETE FROM postings WHERE remittance_id = $1", [remittance.id]);
    for (const posting of remittance.postings) {
      await execute(
        tx(),
        `INSERT INTO postings
           (id, practice_id, remittance_id, claim_id, patient_control_number, payer_control_number,
            patient_name, charged_cents, paid_cents, patient_resp_cents, expected_insurance_cents,
            contractual_cents, recoverable_cents, unexplained_cents, variance_cents, outcome,
            actionable, posted_at, resolved_recoverable_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          posting.id,
          practiceId(),
          remittance.id,
          posting.claimId,
          posting.patientControlNumber,
          posting.payerControlNumber || null,
          posting.patientName || null,
          posting.chargedAmount,
          posting.paidAmount,
          posting.patientResponsibility,
          posting.variance?.expectedInsurancePays ?? null,
          posting.variance?.contractualAdjustments ?? null,
          posting.variance?.recoverableAmount ?? null,
          posting.variance?.unexplainedAmount ?? null,
          posting.variance?.variance ?? null,
          posting.variance?.outcome ?? null,
          posting.variance?.actionable ?? false,
          posting.postedAt,
          posting.resolvedRecoverable ?? 0,
        ]
      );
    }
  }
}

export class PgExpectationRepository implements ExpectationRepository {
  /**
   * Idempotent by control number. Last write wins rather than throwing: a redelivered
   * `claim.submitted` carries identical data, and a genuine resubmission under the same control
   * number should refresh the expectation.
   */
  async record(expectation: ClaimExpectation): Promise<ClaimExpectation> {
    await execute(
      tx(),
      `INSERT INTO claim_expectations
         (practice_id, patient_control_number, claim_id, verification_id, payer_id, payer_name,
          member_id, patient_name, submitted_at, service_date, total_fee_cents, expected_insurance_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (practice_id, patient_control_number) DO UPDATE
         SET claim_id = EXCLUDED.claim_id,
             verification_id = EXCLUDED.verification_id,
             payer_id = EXCLUDED.payer_id,
             payer_name = EXCLUDED.payer_name,
             member_id = EXCLUDED.member_id,
             patient_name = EXCLUDED.patient_name,
             submitted_at = EXCLUDED.submitted_at,
             service_date = EXCLUDED.service_date,
             total_fee_cents = EXCLUDED.total_fee_cents,
             expected_insurance_cents = EXCLUDED.expected_insurance_cents`,
      [
        practiceId(),
        expectation.patientControlNumber,
        expectation.claimId,
        expectation.verificationId,
        expectation.payerId,
        expectation.payerName,
        expectation.memberId,
        expectation.patientName,
        expectation.submittedAt,
        expectation.serviceDate,
        expectation.totalFee,
        expectation.expectedInsurancePays,
      ]
    );
    return expectation;
  }

  async getByControlNumber(patientControlNumber: string): Promise<ClaimExpectation | null> {
    const row = await one<Record<string, unknown>>(
      tx(),
      `SELECT claim_id, verification_id, patient_control_number, payer_id, payer_name,
              member_id, patient_name, submitted_at, service_date, total_fee_cents, expected_insurance_cents,
              award_outstanding_cents
         FROM claim_expectations WHERE patient_control_number = $1`,
      [patientControlNumber]
    );
    return row ? toExpectation(row) : null;
  }

  async setAwardOutstanding(patientControlNumber: string, amount: Cents): Promise<boolean> {
    const row = await one<{ patient_control_number: string }>(
      tx(),
      `UPDATE claim_expectations SET award_outstanding_cents = $2, updated_at = now()
         WHERE patient_control_number = $1 AND award_outstanding_cents IS DISTINCT FROM $2
       RETURNING patient_control_number`,
      [patientControlNumber, amount]
    );
    return row !== undefined && row !== null;
  }

  async knownControlNumbers(): Promise<Set<string>> {
    const rows = await many<{ patient_control_number: string }>(
      tx(),
      "SELECT patient_control_number FROM claim_expectations"
    );
    return new Set(rows.map((r) => r.patient_control_number));
  }

  async list(): Promise<ClaimExpectation[]> {
    const rows = await many<Record<string, unknown>>(
      tx(),
      `SELECT claim_id, verification_id, patient_control_number, payer_id, payer_name,
              member_id, patient_name, submitted_at, service_date, total_fee_cents, expected_insurance_cents,
              award_outstanding_cents
         FROM claim_expectations ORDER BY submitted_at DESC`
    );
    return rows.map(toExpectation);
  }
}

function toExpectation(row: Record<string, unknown>): ClaimExpectation {
  const submittedAt = row.submitted_at;
  const serviceDate = row.service_date;
  return {
    claimId: String(row.claim_id),
    verificationId: String(row.verification_id),
    patientControlNumber: String(row.patient_control_number),
    payerId: row.payer_id === null ? null : String(row.payer_id),
    payerName: row.payer_name === null ? null : String(row.payer_name),
    memberId: String(row.member_id ?? ""),
    patientName: String(row.patient_name ?? ""),
    submittedAt: submittedAt instanceof Date ? submittedAt.toISOString() : String(submittedAt),
    // DATE columns arrive as plain YYYY-MM-DD strings (see pool.ts): a calendar day must never
    // round-trip through a timestamp, or it shifts by a day for readers in another timezone.
    serviceDate: isoDate(serviceDate),
    totalFee: row.total_fee_cents as never,
    expectedInsurancePays: row.expected_insurance_cents as never,
    awardOutstanding: (row.award_outstanding_cents ?? 0) as never,
  };
}

// ── Coordination cases ───────────────────────────────────────────────────────────────────────

/** Schema version of the persisted coordination case. Bump + add an upcaster on any shape change. */
export const COORDINATION_RECORD_VERSION = 1;

interface CoordinationRow {
  record: unknown;
}

const toCase = (row: CoordinationRow): CoordinationCase =>
  fromDocument<CoordinationCase>(row.record, COORDINATION_RECORD_VERSION, {});

/**
 * Postgres storage for coordination cases. RLS scopes every statement to the transaction's practice
 * (`enable_tenant_rls` in 0034); no `practice_id` predicate is written by hand except on INSERT,
 * where the row has to say whose it is.
 *
 * The indexed columns are written FROM the aggregate on every save — `work_status` in particular is
 * derived, never passed — so the worklist indexes cannot drift from the documents they summarise.
 */
export class PgCoordinationRepository implements CoordinationRepository {
  async getById(id: string): Promise<CoordinationCase | null> {
    const row = await one<CoordinationRow>(tx(), "SELECT record FROM coordination_cases WHERE id = $1", [id]);
    return row ? toCase(row) : null;
  }

  async lockById(id: string): Promise<CoordinationCase | null> {
    const row = await one<CoordinationRow>(tx(), "SELECT record FROM coordination_cases WHERE id = $1 FOR UPDATE", [id]);
    return row ? toCase(row) : null;
  }

  async lockByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null> {
    const row = await one<CoordinationRow>(
      tx(),
      "SELECT record FROM coordination_cases WHERE patient_control_number = $1 FOR UPDATE",
      [patientControlNumber]
    );
    return row ? toCase(row) : null;
  }

  async getByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null> {
    const row = await one<CoordinationRow>(
      tx(),
      "SELECT record FROM coordination_cases WHERE patient_control_number = $1",
      [patientControlNumber]
    );
    return row ? toCase(row) : null;
  }

  async list(): Promise<CoordinationCase[]> {
    return (await many<CoordinationRow>(tx(), "SELECT record FROM coordination_cases ORDER BY created_at DESC, id DESC")).map(toCase);
  }

  async insertIfAbsent(c: CoordinationCase): Promise<boolean> {
    // ON CONFLICT DO NOTHING rather than a savepoint: losing the race to the one-case-per-claim key
    // is ordinary, and it must leave the transaction usable so the caller can re-read and merge.
    const rows = await many(
      tx(),
      `INSERT INTO coordination_cases
         (id, practice_id, patient_control_number, coverage_status, work_status, assigned_cents, record, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (practice_id, patient_control_number) DO NOTHING
       RETURNING id`,
      [
        c.id,
        practiceId(),
        c.patientControlNumber,
        c.coverageStatus,
        workStatusOf(c),
        assignedOf(c).cents,
        toDocument(c, COORDINATION_RECORD_VERSION),
        c.createdAt,
        c.updatedAt,
      ]
    );
    return rows.length > 0;
  }

  async update(c: CoordinationCase): Promise<CoordinationCase> {
    await execute(
      tx(),
      `UPDATE coordination_cases
          SET coverage_status = $2, work_status = $3, assigned_cents = $4, record = $5
        WHERE id = $1`,
      [c.id, c.coverageStatus, workStatusOf(c), assignedOf(c).cents, toDocument(c, COORDINATION_RECORD_VERSION)]
    );
    return c;
  }
}
