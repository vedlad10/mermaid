/**
 * Postgres store for learned allowed amounts (migration 0026).
 *
 * Runs inside the ambient practice transaction, unlike the playbook repository beside it, and the
 * contrast is deliberate: an overturn rate is knowledge every practice benefits from, while a
 * contracted rate is the specific commercial term THIS practice negotiated. Sharing it would quote
 * patients from another practice's contract and leak a commercial term between tenants.
 */
import { execute, many, one, practiceId, tx } from "@mermaid/db";
import type { Cents } from "@mermaid/shared";
import { foldFullPrice, foldObservation, type AllowedAmount } from "./allowed-amounts.ts";

interface Row {
  payer_id: string;
  cdt_code: string;
  allowed_cents: string | number;
  charged_cents: string | number;
  observations: number;
  restatements: number;
  full_price_since: number;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const toAllowed = (row: Row): AllowedAmount => ({
  payerId: row.payer_id,
  cdtCode: row.cdt_code,
  allowed: Number(row.allowed_cents) as Cents,
  charged: Number(row.charged_cents) as Cents,
  observations: row.observations,
  restatements: row.restatements,
  fullPriceSince: row.full_price_since,
  firstSeenAt: iso(row.first_seen_at),
  lastSeenAt: iso(row.last_seen_at),
});

export interface AllowedAmountRepository {
  find(payerId: string, cdtCode: string): Promise<AllowedAmount | null>;
  listForPayer(payerId: string): Promise<AllowedAmount[]>;
  /**
   * Every rate this practice has learned, across all payers.
   *
   * The estimate needs the whole schedule and each rate already names its own payer, so building it
   * this way depends on nothing else. Deriving the payer list from the payer CATALOG instead looked
   * equivalent and was not: a deployment whose catalog is empty produced an empty schedule while the
   * rates sat in the table, and every quote silently fell back to billed fees with nothing to show
   * that it had.
   */
  listAll(): Promise<AllowedAmount[]>;
  record(observation: {
    payerId: string;
    cdtCode: string;
    allowed: Cents;
    charged: Cents;
    observedAt: string;
  }): Promise<AllowedAmount>;
  /**
   * Note that this payer adjudicated the code with NO contractual reduction (0028).
   *
   * A no-op for a code we hold no rate for — a full-price payment says nothing about a contract that
   * never existed, and recording it would fill the table with codes this practice has no agreement
   * on.
   */
  recordFullPrice(payerId: string, cdtCode: string, observedAt: string): Promise<AllowedAmount | null>;
}

export class PgAllowedAmountRepository implements AllowedAmountRepository {
  async find(payerId: string, cdtCode: string): Promise<AllowedAmount | null> {
    const row = await one<Row>(
      tx(),
      `SELECT * FROM payer_allowed_amounts WHERE payer_id = $1 AND cdt_code = $2`,
      [payerId, cdtCode]
    );
    return row ? toAllowed(row) : null;
  }

  async listForPayer(payerId: string): Promise<AllowedAmount[]> {
    const rows = await many<Row>(
      tx(),
      `SELECT * FROM payer_allowed_amounts WHERE payer_id = $1 ORDER BY cdt_code`,
      [payerId]
    );
    return rows.map(toAllowed);
  }

  async listAll(): Promise<AllowedAmount[]> {
    const rows = await many<Row>(tx(), `SELECT * FROM payer_allowed_amounts ORDER BY payer_id, cdt_code`, []);
    return rows.map(toAllowed);
  }

  async recordFullPrice(payerId: string, cdtCode: string, observedAt: string): Promise<AllowedAmount | null> {
    const t = tx();
    const prior = await one<Row>(
      t,
      `SELECT * FROM payer_allowed_amounts WHERE payer_id = $1 AND cdt_code = $2 FOR UPDATE`,
      [payerId, cdtCode]
    );
    const next = foldFullPrice(prior ? toAllowed(prior) : null, observedAt);
    if (!next) return null;
    await execute(
      t,
      `UPDATE payer_allowed_amounts
          SET full_price_since = $3, last_seen_at = $4
        WHERE payer_id = $1 AND cdt_code = $2`,
      [payerId, cdtCode, next.fullPriceSince, next.lastSeenAt]
    );
    return next;
  }

  /**
   * Read-fold-write rather than a bare `ON CONFLICT DO UPDATE`, because `distinct_values` is a
   * decision about the PRIOR value — "has this payer said something different?" — which SQL's
   * EXCLUDED cannot express without restating the fold in a second dialect. Two statements of the
   * same rule drift; `foldObservation` is unit-tested, and this calls it.
   *
   * Safe under concurrency for the reason the dispatcher already guarantees: the handler and its
   * delivery checkpoint run inside ONE transaction, so a concurrent observation on the same key
   * blocks on the row rather than interleaving with this read.
   */
  async record(observation: {
    payerId: string;
    cdtCode: string;
    allowed: Cents;
    charged: Cents;
    observedAt: string;
  }): Promise<AllowedAmount> {
    const t = tx();
    const prior = await one<Row>(
      t,
      `SELECT * FROM payer_allowed_amounts WHERE payer_id = $1 AND cdt_code = $2 FOR UPDATE`,
      [observation.payerId, observation.cdtCode]
    );
    const next = foldObservation(prior ? toAllowed(prior) : null, observation);

    await execute(
      t,
      `INSERT INTO payer_allowed_amounts
         (practice_id, payer_id, cdt_code, allowed_cents, charged_cents,
          observations, restatements, full_price_since, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (practice_id, payer_id, cdt_code) DO UPDATE
         SET allowed_cents   = EXCLUDED.allowed_cents,
             charged_cents   = EXCLUDED.charged_cents,
             observations    = EXCLUDED.observations,
             restatements = EXCLUDED.restatements,
             full_price_since = EXCLUDED.full_price_since,
             first_seen_at   = EXCLUDED.first_seen_at,
             last_seen_at    = EXCLUDED.last_seen_at`,
      [
        practiceId(),
        next.payerId,
        next.cdtCode,
        next.allowed,
        next.charged,
        next.observations,
        next.restatements,
        next.fullPriceSince,
        next.firstSeenAt,
        next.lastSeenAt,
      ]
    );
    return next;
  }
}

/** In-memory double for tests and the demo wiring. */
export class InMemoryAllowedAmountRepository implements AllowedAmountRepository {
  #rows = new Map<string, AllowedAmount>();
  #key = (payerId: string, cdtCode: string) => `${payerId}::${cdtCode}`;

  async find(payerId: string, cdtCode: string): Promise<AllowedAmount | null> {
    return this.#rows.get(this.#key(payerId, cdtCode)) ?? null;
  }

  async listForPayer(payerId: string): Promise<AllowedAmount[]> {
    return [...this.#rows.values()].filter((r) => r.payerId === payerId).sort((a, b) => a.cdtCode.localeCompare(b.cdtCode));
  }

  async listAll(): Promise<AllowedAmount[]> {
    return [...this.#rows.values()].sort(
      (a, b) => a.payerId.localeCompare(b.payerId) || a.cdtCode.localeCompare(b.cdtCode)
    );
  }

  async recordFullPrice(payerId: string, cdtCode: string, observedAt: string): Promise<AllowedAmount | null> {
    const key = this.#key(payerId, cdtCode);
    const next = foldFullPrice(this.#rows.get(key) ?? null, observedAt);
    if (next) this.#rows.set(key, next);
    return next;
  }

  async record(observation: {
    payerId: string;
    cdtCode: string;
    allowed: Cents;
    charged: Cents;
    observedAt: string;
  }): Promise<AllowedAmount> {
    const key = this.#key(observation.payerId, observation.cdtCode);
    const next = foldObservation(this.#rows.get(key) ?? null, observation);
    this.#rows.set(key, next);
    return next;
  }
}
