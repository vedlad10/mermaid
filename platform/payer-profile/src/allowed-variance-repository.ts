/**
 * The store behind the allowed-amount variance engine (F2, migration 0030).
 *
 * ── WHAT THIS IS RESPONSIBLE FOR ───────────────────────────────────────────────────────────────
 * Loading a code's rate history, handing it to `foldRateObservation`, writing back what came out,
 * and recording any finding. The judgement is entirely in the engine — this moves rows. The one
 * thing it owes the engine is that the history it loads is COMPLETE, because an engine that is fed
 * a truncated history will happily confirm a rate cut it should have contested.
 *
 * ── WHY THE WHOLE HISTORY IS REWRITTEN RATHER THAN PATCHED ─────────────────────────────────────
 * `foldRateObservation` returns the full epoch list, and this upserts every row of it. That is more
 * writes than strictly necessary — usually one or two epochs actually changed — and it is worth it:
 * the alternative is a diff, and a diff is a second statement of the fold's rules written in SQL,
 * where the two can disagree about which epoch closed. The lists are short (a code's rate moves
 * rarely; a history of more than a handful of epochs is itself the finding) so the cost is a few
 * rows per observation.
 *
 * It rewrites, but it never DELETES and never lowers an epoch's `allowed`. The engine guarantees the
 * list only grows; this writes what it is given, and the contract test asserts the superseded figure
 * is still readable afterwards.
 *
 * ── SHADOW MODE ────────────────────────────────────────────────────────────────────────────────
 * Findings are recorded and read by nothing that decides anything. No estimate consults an epoch, no
 * appeal is built from a variance, no money moves.
 */
import { execute, many, practiceId, tx } from "@mermaid/db";
import type { Cents } from "@mermaid/shared";
import {
  confirmedEpoch,
  foldRateObservation,
  type FoldInput,
  type FoldOptions,
  type RateEpoch,
  type VarianceClassification,
  type VarianceFinding,
} from "./allowed-variance.ts";

/** A finding as stored: the engine's verdict plus which payment it was found on. */
export interface StoredVariance extends VarianceFinding {
  remittanceId: string;
  detectedAt: string;
}

export interface AllowedVarianceRepository extends PeerRateLoader {
  /** Every epoch for one code, oldest first. */
  history(payerId: string, cdtCode: string): Promise<RateEpoch[]>;
  /**
   * Fold one observed allowance into the history and record whatever it found.
   *
   * Returns the finding so a caller can act on it — and in shadow mode nothing does, which is the
   * point: the return value exists for tests and for the day the feature is allowed to speak.
   */
  observe(input: FoldInput & { remittanceId: string }, options?: FoldOptions): Promise<VarianceFinding | null>;
  /** Findings, most recent first. `recoverableOnly` is the worklist reading. */
  findings(options?: { recoverableOnly?: boolean; limit?: number }): Promise<StoredVariance[]>;
}

/**
 * This payer's other confirmed rates, which the alternate-benefit test needs.
 *
 * Loaded by the caller and passed into the engine rather than reached for from inside it, so a
 * finding stays reproducible from its inputs. A downgrade claim — "you paid D2392 at D2150's rate,
 * to the cent" — is the kind of statement that ends up in front of a payer, and it has to be
 * re-derivable from what was recorded rather than from whatever the table happens to hold later.
 */
export interface PeerRateLoader {
  confirmedRatesForPayer(payerId: string): Promise<Map<string, Cents>>;
}

const epochsEqual = (a: RateEpoch, b: RateEpoch): boolean =>
  a.status === b.status &&
  a.allowed === b.allowed &&
  a.charged === b.charged &&
  a.observations === b.observations &&
  a.openedAt === b.openedAt &&
  a.lastSeenAt === b.lastSeenAt &&
  a.closedAt === b.closedAt &&
  a.observedPayerName === b.observedPayerName;

/** Which epochs actually changed. Short lists, but writing twelve unchanged rows per advice adds up. */
export function changedEpochs(before: readonly RateEpoch[], after: readonly RateEpoch[]): RateEpoch[] {
  const prior = new Map(before.map((e) => [e.seq, e]));
  return after.filter((e) => {
    const was = prior.get(e.seq);
    return was === undefined || !epochsEqual(was, e);
  });
}

// ── In-memory ───────────────────────────────────────────────────────────────────────────────────

export class InMemoryAllowedVarianceRepository implements AllowedVarianceRepository {
  /** Nested rather than one map under a joined key, so no separator can appear inside a payer slug. */
  #epochs = new Map<string, Map<string, RateEpoch[]>>();
  /** Keyed exactly as the primary key is, so a redelivery overwrites rather than accumulates. */
  #findings = new Map<string, StoredVariance>();

  async history(payerId: string, cdtCode: string): Promise<RateEpoch[]> {
    return (this.#epochs.get(payerId)?.get(cdtCode) ?? []).map((e) => ({ ...e }));
  }

  async confirmedRatesForPayer(payerId: string): Promise<Map<string, Cents>> {
    const rates = new Map<string, Cents>();
    for (const [code, epochs] of this.#epochs.get(payerId) ?? []) {
      const confirmed = confirmedEpoch(epochs);
      if (confirmed) rates.set(code, confirmed.allowed);
    }
    return rates;
  }

  async observe(
    input: FoldInput & { remittanceId: string },
    options: FoldOptions = {}
  ): Promise<VarianceFinding | null> {
    const forPayer = this.#epochs.get(input.payerId) ?? new Map<string, RateEpoch[]>();
    const result = foldRateObservation(forPayer.get(input.cdtCode) ?? [], input, options);
    forPayer.set(input.cdtCode, result.epochs);
    this.#epochs.set(input.payerId, forPayer);

    if (result.finding) {
      this.#findings.set(`${input.remittanceId} ${input.payerId} ${input.cdtCode}`, {
        ...result.finding,
        remittanceId: input.remittanceId,
        detectedAt: input.observedAt,
      });
    }
    return result.finding;
  }

  async findings(options: { recoverableOnly?: boolean; limit?: number } = {}): Promise<StoredVariance[]> {
    let rows = [...this.#findings.values()];
    if (options.recoverableOnly) rows = rows.filter((f) => f.recoverable);
    rows.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  /** Test affordance — how many findings are held, regardless of filtering. */
  get size(): number {
    return this.#findings.size;
  }
}

// ── Postgres ────────────────────────────────────────────────────────────────────────────────────

interface EpochRow {
  seq: number;
  status: RateEpoch["status"];
  allowed_cents: string | number;
  charged_cents: string | number;
  observations: number;
  observed_payer_name: string | null;
  opened_at: Date | string;
  last_seen_at: Date | string;
  closed_at: Date | string | null;
}

interface VarianceRow {
  remittance_id: string;
  payer_id: string;
  cdt_code: string;
  classification: VarianceClassification;
  observed_cents: string | number;
  expected_cents: string | number;
  delta_cents: string | number;
  against_epoch: number;
  observed_payer_name: string | null;
  recoverable: boolean;
  downgraded_to: string | null;
  detected_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));

const toEpoch = (row: EpochRow): RateEpoch => ({
  seq: row.seq,
  status: row.status,
  allowed: Number(row.allowed_cents) as Cents,
  charged: Number(row.charged_cents) as Cents,
  observations: row.observations,
  openedAt: iso(row.opened_at),
  lastSeenAt: iso(row.last_seen_at),
  closedAt: isoOrNull(row.closed_at),
  observedPayerName: row.observed_payer_name,
});

const toVariance = (row: VarianceRow): StoredVariance => ({
  remittanceId: row.remittance_id,
  payerId: row.payer_id,
  cdtCode: row.cdt_code,
  classification: row.classification,
  observed: Number(row.observed_cents) as Cents,
  expected: Number(row.expected_cents) as Cents,
  delta: Number(row.delta_cents) as Cents,
  againstEpoch: row.against_epoch,
  observedPayerName: row.observed_payer_name,
  recoverable: row.recoverable,
  ...(row.downgraded_to === null ? {} : { downgradedTo: row.downgraded_to }),
  detectedAt: iso(row.detected_at),
});

export class PgAllowedVarianceRepository implements AllowedVarianceRepository {
  async history(payerId: string, cdtCode: string): Promise<RateEpoch[]> {
    const rows = await many<EpochRow>(
      tx(),
      `SELECT * FROM payer_allowed_amount_epochs
        WHERE payer_id = $1 AND cdt_code = $2
        ORDER BY seq`,
      [payerId, cdtCode]
    );
    return rows.map(toEpoch);
  }

  async confirmedRatesForPayer(payerId: string): Promise<Map<string, Cents>> {
    const rows = await many<{ cdt_code: string; allowed_cents: string | number }>(
      tx(),
      `SELECT cdt_code, allowed_cents FROM payer_allowed_amount_epochs
        WHERE payer_id = $1 AND status = 'confirmed'`,
      [payerId]
    );
    return new Map(rows.map((r) => [r.cdt_code, Number(r.allowed_cents) as Cents]));
  }

  async observe(
    input: FoldInput & { remittanceId: string },
    options: FoldOptions = {}
  ): Promise<VarianceFinding | null> {
    const t = tx();
    /**
     * `FOR UPDATE` over the code's whole history, so a second advice for the same code cannot read
     * the same baseline and open a second candidate against it. The dispatcher already runs handler
     * and checkpoint in one transaction, so this blocks rather than interleaves — the same guarantee
     * `PgAllowedAmountRepository` relies on, stated here because it is load-bearing for a fold whose
     * decision depends on the rows it just read.
     */
    const rows = await many<EpochRow>(
      t,
      `SELECT * FROM payer_allowed_amount_epochs
        WHERE payer_id = $1 AND cdt_code = $2
        ORDER BY seq
          FOR UPDATE`,
      [input.payerId, input.cdtCode]
    );
    const before = rows.map(toEpoch);
    const result = foldRateObservation(before, input, options);

    for (const epoch of changedEpochs(before, result.epochs)) {
      await execute(
        t,
        `INSERT INTO payer_allowed_amount_epochs
           (practice_id, payer_id, cdt_code, seq, status, allowed_cents, charged_cents,
            observations, observed_payer_name, opened_at, last_seen_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (practice_id, payer_id, cdt_code, seq) DO UPDATE SET
           status              = EXCLUDED.status,
           observations        = EXCLUDED.observations,
           observed_payer_name = EXCLUDED.observed_payer_name,
           last_seen_at        = EXCLUDED.last_seen_at,
           closed_at           = EXCLUDED.closed_at`,
        [
          practiceId(),
          input.payerId,
          input.cdtCode,
          epoch.seq,
          epoch.status,
          epoch.allowed,
          epoch.charged,
          epoch.observations,
          epoch.observedPayerName,
          epoch.openedAt,
          epoch.lastSeenAt,
          epoch.closedAt,
        ]
      );
    }

    if (result.finding) {
      const f = result.finding;
      await execute(
        t,
        `INSERT INTO allowed_amount_variances
           (practice_id, remittance_id, payer_id, cdt_code, classification, observed_cents,
            expected_cents, delta_cents, against_epoch, observed_payer_name, recoverable,
            downgraded_to, detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (practice_id, remittance_id, payer_id, cdt_code) DO UPDATE SET
           classification      = EXCLUDED.classification,
           observed_cents      = EXCLUDED.observed_cents,
           expected_cents      = EXCLUDED.expected_cents,
           delta_cents         = EXCLUDED.delta_cents,
           against_epoch       = EXCLUDED.against_epoch,
           observed_payer_name = EXCLUDED.observed_payer_name,
           recoverable         = EXCLUDED.recoverable,
           downgraded_to       = EXCLUDED.downgraded_to,
           detected_at         = EXCLUDED.detected_at`,
        [
          practiceId(),
          input.remittanceId,
          f.payerId,
          f.cdtCode,
          f.classification,
          f.observed,
          f.expected,
          f.delta,
          f.againstEpoch,
          f.observedPayerName,
          f.recoverable,
          f.downgradedTo ?? null,
          input.observedAt,
        ]
      );
    }

    return result.finding;
  }

  async findings(options: { recoverableOnly?: boolean; limit?: number } = {}): Promise<StoredVariance[]> {
    const rows = await many<VarianceRow>(
      tx(),
      `SELECT * FROM allowed_amount_variances
        WHERE ($1::boolean IS NOT TRUE OR recoverable)
        ORDER BY detected_at DESC
        LIMIT $2`,
      [options.recoverableOnly ?? false, options.limit ?? 500]
    );
    return rows.map(toVariance);
  }
}
