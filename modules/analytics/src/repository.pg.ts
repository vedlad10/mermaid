/**
 * Postgres fact repository.
 *
 * The UNIQUE constraint on `(practice_id, source_event_id, fact_type)` is what actually guarantees
 * idempotency — the service checks nothing, it simply lets `ON CONFLICT DO NOTHING` decide. A
 * double-counted fact would corrupt every figure on the dashboard while leaving it looking correct,
 * so the guarantee belongs in the database rather than in a code path that could be bypassed.
 */
import { iso, many, one, practiceId, tx } from "@mermaid/db";
import type { Cents } from "@mermaid/shared";
import type { Fact, FactType, Period } from "./types.ts";
import { factDedupeKey } from "./repository.ts";
import type { FactRepository } from "./repository.ts";

interface Row {
  fact_type: string;
  occurred_at: Date | string;
  payer_id: string | null;
  payer_name: string | null;
  procedure_code: string | null;
  carc_code: string | null;
  verification_id: string | null;
  claim_id: string | null;
  denial_id: string | null;
  amount_cents: number;
  expected_cents: number;
  won: boolean | null;
  meta: Record<string, unknown> | null;
  source_event_id: string;
}

const toFact = (row: Row): Fact => ({
  sourceEventId: row.source_event_id,
  factType: row.fact_type as FactType,
  occurredAt: iso(row.occurred_at),
  payerId: row.payer_id,
  payerName: row.payer_name,
  procedureCode: row.procedure_code,
  carcCode: row.carc_code,
  verificationId: row.verification_id,
  claimId: row.claim_id,
  denialId: row.denial_id,
  amount: row.amount_cents as Cents,
  expected: row.expected_cents as Cents,
  won: row.won,
  meta: row.meta,
});

export class PgFactRepository implements FactRepository {
  async record(fact: Fact): Promise<boolean> {
    const row = await one<{ id: string }>(
      tx(),
      `INSERT INTO analytics_facts
         (practice_id, fact_type, occurred_at, payer_id, payer_name, procedure_code, carc_code,
          verification_id, claim_id, denial_id, amount_cents, expected_cents, won, meta,
          source_event_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       -- ON dedupe_key, not on the source event (NEW-12). The old constraint still exists and
       -- still catches a redelivery; this one additionally catches the SAME SUBJECT announced by a
       -- second, different event — which is how one visit was counted twice.
       ON CONFLICT (practice_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        practiceId(),
        fact.factType,
        fact.occurredAt,
        fact.payerId,
        fact.payerName,
        fact.procedureCode,
        fact.carcCode,
        fact.verificationId,
        fact.claimId,
        fact.denialId,
        fact.amount,
        fact.expected,
        fact.won,
        fact.meta,
        fact.sourceEventId,
        factDedupeKey(fact),
      ]
    );
    // No row returned means the conflict fired: this event had already been counted.
    return row !== undefined;
  }

  async inPeriod(period: Period): Promise<Fact[]> {
    const rows = await many<Row>(
      tx(),
      `SELECT * FROM analytics_facts
        WHERE occurred_at >= $1 AND occurred_at < $2
        ORDER BY occurred_at`,
      [period.from, period.to]
    );
    return rows.map(toFact);
  }

  async count(): Promise<number> {
    const row = await one<{ n: number }>(tx(), "SELECT count(*)::int AS n FROM analytics_facts");
    return row?.n ?? 0;
  }
}
