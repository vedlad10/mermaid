/**
 * Fact persistence seam.
 *
 * `record` is idempotent on the SOURCE EVENT ID. That is not a nicety: the outbox delivers at least
 * once, and a double-counted fact silently corrupts every number on the dashboard — the worst class
 * of bug here, because the report still looks entirely plausible afterwards.
 */
import type { Fact, Period } from "./types.ts";

export interface FactRepository {
  /** Idempotent on `(sourceEventId, factType)`. Returns false when the fact was already recorded. */
  record(fact: Fact): Promise<boolean>;
  /** Every fact in the window, `to` exclusive. */
  inPeriod(period: Period): Promise<Fact[]>;
  count(): Promise<number>;
}

/**
 * What makes a fact unique within a practice (NEW-12).
 *
 * The recorder's own `dedupeKey` when it stated one — three fact types do, because their subject
 * produces exactly one fact however many events describe it — and otherwise the source event, which
 * is exactly what this keyed on before and what the four multi-per-subject types still need.
 *
 * Exported and shared so the in-memory double and Postgres cannot disagree about which two facts
 * are the same fact; `repository-contract.test.ts` is what would otherwise have to notice.
 */
export const factDedupeKey = (fact: Fact): string =>
  fact.dedupeKey ?? `${fact.factType}:${fact.sourceEventId}`;

const key = factDedupeKey;

export class InMemoryFactRepository implements FactRepository {
  #facts = new Map<string, Fact>();

  async record(fact: Fact): Promise<boolean> {
    if (this.#facts.has(key(fact))) return false;
    this.#facts.set(key(fact), structuredClone(fact));
    return true;
  }

  async inPeriod(period: Period): Promise<Fact[]> {
    return [...this.#facts.values()]
      .filter((f) => f.occurredAt >= period.from && f.occurredAt < period.to)
      .map((f) => structuredClone(f))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async count(): Promise<number> {
    return this.#facts.size;
  }

  get size(): number {
    return this.#facts.size;
  }
}
