/**
 * Payments that did not arrive over ACH, and what they cost to receive (F1, migration 0029).
 *
 * ── WHAT IS STORED, AND WHAT IS COMPUTED ───────────────────────────────────────────────────────
 * One row per payment. The per-payer rollup a practice actually reads is an aggregate over those
 * rows, computed on the way out rather than maintained as a counter — because a counter has to be
 * INCREMENTED, and an increment on an at-least-once bus double-counts the moment anything retries.
 * `payer_allowed_amounts` avoids the same trap by assigning rather than adding; this avoids it by
 * not keeping a total at all.
 *
 * Recording is idempotent on the remittance id. One payment posts once, so one payment is one row,
 * and a redelivered event lands on the primary key instead of inventing a second fee.
 *
 * ── THE FEE IS ALLOWED TO BE UNKNOWN, AND SAYS SO ──────────────────────────────────────────────
 * A practice that has not stated its merchant discount rate gets observations with no cost attached.
 * The rollup reports the fees it can price AND how many payments it could not, rather than summing
 * the priced ones and presenting the result as a total. A number that silently covers four of seven
 * payments is worse than one that admits the gap: it reads as complete, and it is the figure a
 * biller would quote to a payer.
 */
import { execute, many, practiceId, tx } from "@mermaid/db";
import type { Cents } from "@mermaid/shared";

/** One non-ACH payment, as observed on its remittance. */
export interface PaymentMethodObservation {
  remittanceId: string;
  /** Payer-qualified idempotency key of the payment (migration 0020) — provenance, not a key here. */
  dedupeKey: string;
  payerName: string;
  /** BPR04 verbatim, upper-cased. Never a boolean: which non-ACH method it was is what a biller acts on. */
  method: string;
  paymentTotal: Cents;
  /** Null when the practice has not stated a merchant rate. Never estimated. */
  feeCents: Cents | null;
  reverted: boolean;
  priorMethod: string | null;
  observedAt: string;
}

/** What one payer has cost this practice by not paying over ACH. */
export interface PayerPaymentMethodSummary {
  payerName: string;
  /** How many non-ACH payments have arrived from this payer. */
  payments: number;
  /** Their total value — the money a fee was charged against. */
  paymentTotal: Cents;
  /**
   * Fees across the payments that could be priced, or null when NONE could.
   *
   * Read together with `unpricedPayments`: this is a total over a subset whenever that count is
   * above zero, and presenting it without the count would overstate confidence in a figure a biller
   * may put in front of a payer.
   */
  feeCents: Cents | null;
  /** Payments with no fee attached, because no merchant rate was stated when they were observed. */
  unpricedPayments: number;
  /** The most recent method seen from this payer — what they are doing NOW. */
  latestMethod: string;
  latestObservedAt: string;
  /** Whether this payer has ever paid by ACH and then stopped. The escalation signal. */
  reverted: boolean;
}

export interface PaymentMethodRepository {
  /** Idempotent on `remittanceId` — a redelivered observation is not a second fee. */
  record(observation: PaymentMethodObservation): Promise<void>;
  /** Per-payer rollup, worst first: reverted payers, then by what they have cost. */
  summary(): Promise<PayerPaymentMethodSummary[]>;
}

/**
 * Fold observations into the per-payer view both implementations must produce.
 *
 * Exported and shared so the in-memory store and Postgres cannot drift on the one part that involves
 * a decision — what happens to the fee total when some payments could not be priced.
 */
export function foldPaymentMethods(
  observations: readonly PaymentMethodObservation[]
): PayerPaymentMethodSummary[] {
  const byPayer = new Map<string, PaymentMethodObservation[]>();
  for (const o of observations) {
    const key = o.payerName.trim().toUpperCase();
    const list = byPayer.get(key) ?? [];
    list.push(o);
    byPayer.set(key, list);
  }

  const summaries = [...byPayer.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    const latest = sorted[0]!;
    const priced = sorted.filter((o) => o.feeCents !== null);
    return {
      // The name as most recently printed, not the upper-cased grouping key — a practice reads the
      // payer's own spelling, and the normalisation exists only to stop casing splitting one payer
      // into two rows.
      payerName: latest.payerName.trim(),
      payments: sorted.length,
      paymentTotal: sorted.reduce((t, o) => t + o.paymentTotal, 0) as Cents,
      feeCents: priced.length === 0 ? null : (priced.reduce((t, o) => t + (o.feeCents ?? 0), 0) as Cents),
      unpricedPayments: sorted.length - priced.length,
      latestMethod: latest.method,
      latestObservedAt: latest.observedAt,
      reverted: sorted.some((o) => o.reverted),
    };
  });

  /**
   * Worst first. A payer that has REVERTED outranks one that has always paid by cheque, however much
   * the cheques cost: the reversion is the one a practice can still act on cheaply, because an
   * opt-out that has been undone can be redone. Within each group, by money.
   */
  return summaries.sort(
    (a, b) =>
      Number(b.reverted) - Number(a.reverted) ||
      (b.feeCents ?? 0) - (a.feeCents ?? 0) ||
      b.paymentTotal - a.paymentTotal
  );
}

export class InMemoryPaymentMethodRepository implements PaymentMethodRepository {
  #byRemittance = new Map<string, PaymentMethodObservation>();

  async record(observation: PaymentMethodObservation): Promise<void> {
    // Last write wins on the same remittance, which is what the Postgres upsert does. A replayed
    // event carries identical values, so the distinction is academic — but they must agree.
    this.#byRemittance.set(observation.remittanceId, { ...observation });
  }

  async summary(): Promise<PayerPaymentMethodSummary[]> {
    return foldPaymentMethods([...this.#byRemittance.values()]);
  }

  get size(): number {
    return this.#byRemittance.size;
  }
}

interface Row {
  remittance_id: string;
  dedupe_key: string;
  payer_name: string;
  method: string;
  payment_total_cents: string | number;
  fee_cents: string | number | null;
  reverted: boolean;
  prior_method: string | null;
  observed_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export class PgPaymentMethodRepository implements PaymentMethodRepository {
  async record(observation: PaymentMethodObservation): Promise<void> {
    /**
     * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: a redelivery carries the same values, so
     * either is correct today, but an observation that was RECOMPUTED — a merchant rate stated after
     * the fact, a corrected advice — should land rather than be silently dropped. The primary key is
     * what makes it one fee either way.
     */
    await execute(
      tx(),
      `INSERT INTO payer_payment_method_observations
         (practice_id, remittance_id, dedupe_key, payer_name, method,
          payment_total_cents, fee_cents, reverted, prior_method, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (practice_id, remittance_id) DO UPDATE SET
         dedupe_key          = EXCLUDED.dedupe_key,
         payer_name          = EXCLUDED.payer_name,
         method              = EXCLUDED.method,
         payment_total_cents = EXCLUDED.payment_total_cents,
         fee_cents           = EXCLUDED.fee_cents,
         reverted            = EXCLUDED.reverted,
         prior_method        = EXCLUDED.prior_method,
         observed_at         = EXCLUDED.observed_at`,
      [
        practiceId(),
        observation.remittanceId,
        observation.dedupeKey,
        observation.payerName,
        observation.method,
        observation.paymentTotal,
        observation.feeCents,
        observation.reverted,
        observation.priorMethod,
        observation.observedAt,
      ]
    );
  }

  async summary(): Promise<PayerPaymentMethodSummary[]> {
    /**
     * Rows out, folded in TypeScript by the same function the in-memory store uses. Aggregating in
     * SQL would be faster and would put the one decision in this feature — what a fee total means
     * when some payments could not be priced — in a second place, written in a second language,
     * where the contract test could only compare the answers and never the rule.
     */
    const rows = await many<Row>(
      tx(),
      `SELECT remittance_id, dedupe_key, payer_name, method, payment_total_cents,
              fee_cents, reverted, prior_method, observed_at
         FROM payer_payment_method_observations
        ORDER BY observed_at DESC`,
      []
    );
    return foldPaymentMethods(
      rows.map((r) => ({
        remittanceId: r.remittance_id,
        dedupeKey: r.dedupe_key,
        payerName: r.payer_name,
        method: r.method,
        paymentTotal: Number(r.payment_total_cents) as Cents,
        feeCents: r.fee_cents === null ? null : (Number(r.fee_cents) as Cents),
        reverted: r.reverted,
        priorMethod: r.prior_method,
        observedAt: iso(r.observed_at),
      }))
    );
  }
}
