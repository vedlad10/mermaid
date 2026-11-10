/**
 * Denial persistence seam.
 *
 * `getByPostingReason` is the idempotency key, and it is not a convenience: the outbox delivers
 * `variance.detected` at least once, and a duplicated denial is duplicated work in a queue whose
 * entire value rests on everything in it being real. A biller who finds the same crown twice stops
 * trusting the list. In Postgres this is backed by a UNIQUE constraint.
 */
import { OPEN_DENIAL_STATUSES } from "./types.ts";
import type { Denial, DenialStatus } from "./types.ts";

export interface DenialFilter {
  status?: DenialStatus;
  /** Only denials where the money is still in play. */
  openOnly?: boolean;
  /**
   * Every denial raised against any of these claims — one human's recovery history (M14).
   *
   * Reached by claim rather than by patient because that is the relationship a denial actually has:
   * a payer denies a CLAIM line, and `idx_denials_claim` has indexed that since migration 0008. The
   * caller resolves the person to their claims; this answers for the payer's decisions on them.
   *
   * An empty array matches nothing — the only safe reading of "these claims" when there are none.
   */
  claimIds?: string[];
}

export interface DenialRepository {
  save(denial: Denial): Promise<Denial>;
  update(denial: Denial): Promise<Denial>;
  getById(id: string): Promise<Denial | null>;
  /**
   * Read a denial FOR UPDATE — the read every mutating path uses, so concurrent mutators
   * serialize instead of overwriting each other's read-modify-write. Postgres backs it with a row
   * lock; the in-memory store passes through (single process, no second connection). The race that
   * matters: an approve landing beside a revise could otherwise sign a letter the approver never
   * read, and lose the revision.
   */
  lockById(id: string): Promise<Denial | null>;
  /** The idempotency lookup: one denial per (posting, reason code, procedure). */
  getByPostingReason(postingId: string, carcCode: string, procedureCode: string | null): Promise<Denial | null>;
  list(filter?: DenialFilter): Promise<Denial[]>;
}

/**
 * ── DERIVED, BECAUSE THIS EXACT LIST WAS WRONG ONCE ALREADY (F-2) ──────────────────────────────
 * Phase 3 added `awaiting_payment` and `partially_recovered` to `OPEN_DENIAL_STATUSES`. The Postgres
 * repository was corrected for precisely this and carries the note; this one — the double the whole
 * business suite and the database-free demo run against — was left on the pre-Phase-3 three.
 *
 * A test double that defines "open" differently from production is worse than a wrong constant. It
 * means the suite cannot reproduce the production behaviour it is meant to protect: a won-but-unpaid
 * award vanished from the Recover worklist in SQL, and every test written to catch that would have
 * passed here regardless, because the double dropped it too.
 */
const OPEN = [...OPEN_DENIAL_STATUSES];

const reasonKey = (postingId: string, carcCode: string, procedureCode: string | null): string =>
  `${postingId}|${carcCode}|${procedureCode ?? ""}`;

export class InMemoryDenialRepository implements DenialRepository {
  #denials = new Map<string, Denial>();
  /** (posting, reason) → denial id. The in-memory stand-in for the UNIQUE constraint. */
  #byReason = new Map<string, string>();

  async save(denial: Denial): Promise<Denial> {
    if (this.#denials.has(denial.id)) throw new Error(`denial ${denial.id} already exists`);
    const key = reasonKey(denial.postingId, denial.carcCode, denial.procedureCode);
    if (this.#byReason.has(key)) {
      throw new Error(`a denial already exists for posting ${denial.postingId} reason ${denial.carcCode}`);
    }
    this.#denials.set(denial.id, structuredClone(denial));
    this.#byReason.set(key, denial.id);
    return structuredClone(denial);
  }

  async update(denial: Denial): Promise<Denial> {
    if (!this.#denials.has(denial.id)) throw new Error(`denial ${denial.id} not found`);
    this.#denials.set(denial.id, structuredClone(denial));
    return structuredClone(denial);
  }

  async getById(id: string): Promise<Denial | null> {
    const found = this.#denials.get(id);
    return found ? structuredClone(found) : null;
  }

  /** No lock to take in memory — single process, single flow. The contract lives in Postgres. */
  async lockById(id: string): Promise<Denial | null> {
    return this.getById(id);
  }

  async getByPostingReason(
    postingId: string,
    carcCode: string,
    procedureCode: string | null
  ): Promise<Denial | null> {
    const id = this.#byReason.get(reasonKey(postingId, carcCode, procedureCode));
    return id ? this.getById(id) : null;
  }

  async list(filter?: DenialFilter): Promise<Denial[]> {
    let all = [...this.#denials.values()].map((d) => structuredClone(d));
    if (filter?.status) all = all.filter((d) => d.status === filter.status);
    if (filter?.openOnly) all = all.filter((d) => OPEN.includes(d.status));
    if (filter?.claimIds) {
      const ids = new Set(filter.claimIds);
      all = all.filter((d) => ids.has(d.claimId));
    }
    // Most valuable first; the service re-sorts, but a sensible default matters for direct readers.
    return all.sort((a, b) => b.priority - a.priority || b.detectedAt.localeCompare(a.detectedAt));
  }

  get size(): number {
    return this.#denials.size;
  }
}
