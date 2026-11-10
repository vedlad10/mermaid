/**
 * Postgres implementation of `DenialRepository` — a drop-in behind the seam, same shape as every
 * other module's.
 *
 * The `denials_one_per_posting_reason` UNIQUE constraint is the real idempotency guarantee.
 * `createFromVariance` checks first, but that is check-then-act and loses to two concurrent
 * deliveries of the same `variance.detected`. A duplicated denial is duplicated work in a queue
 * whose entire value is that everything in it is real.
 */
import { execute, fromDocument, isoDate, isUniqueViolation, many, one, practiceId, toDocument, tx } from "@mermaid/db";
import type { DenialFilter, DenialRepository } from "./repository.ts";
import type { Denial } from "./types.ts";
import { OPEN_DENIAL_STATUSES } from "./types.ts";

/** Schema version of the persisted denial document. Bump + add an upcaster on any shape change. */
export const DENIAL_RECORD_VERSION = 3;

/**
 * v1 → v2, two additions, and both nulls mean the same honest thing: *this was genuinely not
 * recorded then*, as opposed to *we stopped recording it*.
 *
 * - `appeals[].narrative` — every v1 appeal was written entirely deterministically, because AI
 *   drafting did not exist. A reader six months from now must be able to be certain that a null
 *   narrative on an old appeal means "a template wrote this", and that certainty is exactly what an
 *   optional field read as `?? null` would not give them.
 * - `carcGroup` — the CAS01 group the payer sent. Null rather than "CO", because a recoverable
 *   denial is not always CO (PI-group adjustments are recoverable too), so a default here would be
 *   inventing a fact about a payer's own coding on records that never carried it.
 */
/**
 * v2 → v3 — appeal AWARDS (F-2).
 *
 * A v2 denial recorded a win by setting `status: "recovered"` and a `recoveredAmount`, which
 * conflated "a person said the payer agreed" with "the money arrived". v3 splits those into
 * `awardedAmount` (workflow) and `awardSettledAmount` (cash).
 *
 * Every added field is null or absent, and that is the honest reading: a v2 record genuinely does
 * not know whether cash ever arrived, because nothing tracked it. Deliberately NOT re-deriving an
 * award from `recoveredAmount` here — the 0024 backfill does that, once, after checking for
 * evidence of cash. Doing it in a read-time upcaster would silently reclassify every historical
 * denial on every read, without the evidence check and with no audit entry saying it happened.
 */
export const UPCASTERS = {
  2: (doc: { snapshot_version: number }) => ({
    ...doc,
    outcomeDecision: null,
    awardedAmount: null,
    awardSettledAmount: null,
    awardedAt: null,
    awardSettlements: [],
    snapshot_version: 3,
  }),
  1: (doc: { snapshot_version: number }) => {
    const denial = doc as unknown as { appeals?: Record<string, unknown>[] };
    return {
      ...doc,
      carcGroup: null,
      appeals: (denial.appeals ?? []).map((appeal) => ({ ...appeal, narrative: null })),
      snapshot_version: 2,
    };
  },
};

/**
 * v3 → v2, so a rollback can still read what v3 wrote.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────
 * Without it a version bump is a ONE-WAY DOOR: deploy code that writes v3, roll it back, and every
 * denial touched in between is unreadable rather than merely degraded — an outage on exactly the
 * records the failed release touched. That is not hypothetical here. The 0024 backfill stamped v3
 * on staging BEFORE this reader knew the version existed, and the live Recover screen answered
 * `500 snapshot_version 3 is newer than this code understands (2)` until this was added.
 *
 * The award fields are dropped and the workflow figure is put back where a v2 reader looks for it,
 * which restores v2 behaviour exactly — including its defect. That is the correct trade for a
 * rollback: the old code behaves like the old code.
 */
export const DOWNCASTERS = {
  3: (doc: { snapshot_version: number }) => {
    const d = doc as unknown as Record<string, unknown>;
    const { awardedAmount, awardSettledAmount, awardedAt, awardSettlements, outcomeDecision, ...rest } = d;
    const settled = typeof awardSettledAmount === "number" ? awardSettledAmount : null;
    const awarded = typeof awardedAmount === "number" ? awardedAmount : null;
    return {
      ...rest,
      status: rest.status === "awaiting_payment" || rest.status === "partially_recovered" ? "appealed" : rest.status,
      recoveredAmount: settled && settled > 0 ? settled : (rest.recoveredAmount ?? awarded ?? null),
      snapshot_version: 2,
    };
  },
};

interface Row {
  record: unknown;
}

const toDenial = (row: Row): Denial =>
  fromDocument<Denial>(row.record, DENIAL_RECORD_VERSION, UPCASTERS, DOWNCASTERS);

/**
 * Kept in step with OPEN_DENIAL_STATUSES; `new` was removed at B3 because nothing ever wrote it.
 *
 * ── THIS LIST IS LOAD-BEARING AND WAS MISSED ONCE (F-2) ───────────────────────────────────────
 * Phase 3 added `awaiting_payment` and `partially_recovered` to the TypeScript constant and to
 * `idx_denials_queue`, and did not add them here — so `openOnly` filtered them out in SQL and a
 * won-but-unpaid award vanished from the Recover worklist. That is precisely the
 * money-disappears-from-every-screen symptom the whole phase exists to remove, reintroduced one
 * layer below where it was fixed. Derived from the shared constant now, so the two cannot drift.
 */
const OPEN = [...OPEN_DENIAL_STATUSES];

export class PgDenialRepository implements DenialRepository {
  async save(denial: Denial): Promise<Denial> {
    try {
      await execute(
        tx(),
        `INSERT INTO denials
           (id, practice_id, claim_id, remittance_id, posting_id, carc_code, carc_description,
            procedure_code, denied_amount_cents, payer_id, payer_name, patient_name, status,
            disposition, overturn_rate, priority, appeal_deadline, record, detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          denial.id,
          practiceId(),
          denial.claimId,
          denial.remittanceId,
          denial.postingId,
          denial.carcCode,
          denial.carcDescription,
          denial.procedureCode,
          denial.deniedAmount,
          denial.payerId,
          denial.payerName,
          denial.patientName,
          denial.status,
          denial.triage?.disposition ?? null,
          denial.triage?.overturnRate ?? null,
          denial.priority,
          denial.appealDeadline,
          toDocument(denial, DENIAL_RECORD_VERSION),
          denial.detectedAt,
        ]
      );
    } catch (e) {
      if (isUniqueViolation(e, "denials_one_per_posting_reason")) {
        throw new Error(
          `a denial already exists for posting ${denial.postingId} reason ${denial.carcCode}`
        );
      }
      if (isUniqueViolation(e)) throw new Error(`denial ${denial.id} already exists`);
      throw e;
    }
    return denial;
  }

  async update(denial: Denial): Promise<Denial> {
    const changed = await execute(
      tx(),
      `UPDATE denials
          SET status = $2,
              disposition = $3,
              overturn_rate = $4,
              priority = $5,
              appeal_deadline = $6,
              record = $7
        WHERE id = $1`,
      [
        denial.id,
        denial.status,
        denial.triage?.disposition ?? null,
        denial.triage?.overturnRate ?? null,
        denial.priority,
        denial.appealDeadline,
        toDocument(denial, DENIAL_RECORD_VERSION),
      ]
    );
    if (changed === 0) throw new Error(`denial ${denial.id} not found`);
    return denial;
  }

  async getById(id: string): Promise<Denial | null> {
    const row = await one<Row>(tx(), "SELECT record FROM denials WHERE id = $1", [id]);
    return row ? toDenial(row) : null;
  }

  /**
   * The mutating read — `FOR UPDATE`, so concurrent mutators of one denial serialize.
   *
   * The race this closes is not hypothetical bookkeeping: a revise clears an approval because a
   * signature belongs to specific words, and an approve racing that revise on an unlocked read
   * could commit a denial whose OLD letter carries the new signature — a payer-facing letter
   * nobody actually signed off, and the reviser's edit silently gone.
   */
  async lockById(id: string): Promise<Denial | null> {
    const row = await one<Row>(tx(), "SELECT record FROM denials WHERE id = $1 FOR UPDATE", [id]);
    return row ? toDenial(row) : null;
  }

  /** The idempotency lookup. `IS NOT DISTINCT FROM` because procedure_code is nullable. */
  async getByPostingReason(
    postingId: string,
    carcCode: string,
    procedureCode: string | null
  ): Promise<Denial | null> {
    const row = await one<Row>(
      tx(),
      `SELECT record FROM denials
        WHERE posting_id = $1 AND carc_code = $2 AND procedure_code IS NOT DISTINCT FROM $3`,
      [postingId, carcCode, procedureCode]
    );
    return row ? toDenial(row) : null;
  }

  async list(filter?: DenialFilter): Promise<Denial[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.openOnly) {
      params.push(OPEN);
      where.push(`status = ANY($${params.length})`);
    }
    if (filter?.claimIds) {
      // Served by `idx_denials_claim` (migration 0008). Empty matches nothing, as in-memory does.
      params.push(filter.claimIds);
      where.push(`claim_id = ANY($${params.length}::uuid[])`);
    }
    const sql =
      `SELECT record FROM denials` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY priority DESC, detected_at DESC, id DESC`;
    return (await many<Row>(tx(), sql, params)).map(toDenial);
  }

  /** Exported for the live tests, which assert on the extracted columns directly. */
  async readColumns(id: string): Promise<Record<string, unknown> | undefined> {
    const row = await one<Record<string, unknown>>(
      tx(),
      `SELECT status, disposition, overturn_rate, priority, appeal_deadline, denied_amount_cents
         FROM denials WHERE id = $1`,
      [id]
    );
    return row ? { ...row, appeal_deadline: row.appeal_deadline ? isoDate(row.appeal_deadline) : null } : undefined;
  }
}
