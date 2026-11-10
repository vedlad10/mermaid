/**
 * Remittance persistence seam, plus the expectation ledger.
 *
 * Two stores, for two genuinely different things:
 *
 *   • **Remittances** — what payers sent. Keyed by `dedupeKey`, which is what makes posting
 *     idempotent: the store itself refuses a second remittance under a key it has already seen,
 *     so double-posting is impossible even if the service's guard were bypassed. In Postgres this is
 *     a UNIQUE index on `(practice_id, dedupe_key)`.
 *
 *     The key is the payer's trace number whenever there is one. It is a separate field because a
 *     TRN is situational in an 835: keying on `traceNumber` directly made every trace-less file a
 *     duplicate of every other one, so the second a practice received could never be stored at all.
 *
 *   • **Expectations** — what the clinic was promised, projected from `claim.submitted` events.
 *     Remittance may not read Claims' tables (docs/MODULE-BOUNDARIES.md), so it keeps its own
 *     event-sourced ledger. Keyed by `patientControlNumber`, because that is the only identifier the
 *     payer echoes back in CLP01.
 *
 * As everywhere else, the in-memory implementations are the dev/demo store behind a swappable seam;
 * the Postgres+RLS versions are the production path.
 */
import type { Cents } from "@mermaid/shared";
import type { ClaimExpectation, Remittance } from "./types.ts";
import type { CoordinationCase } from "./coordination.ts";
import { outstandingOf } from "./view.ts";

/**
 * The store already holds a remittance under this dedupe key.
 *
 * ── WHY THIS IS A TYPE AND NOT A MESSAGE ───────────────────────────────────────────────────────
 * `save()` has always refused a duplicate, and it must keep refusing — the UNIQUE constraint is
 * what actually stops the same payment posting twice, and the service's `getByDedupeKey` check is
 * only a courtesy in front of it. What was missing is that the refusal arrived as a bare `Error`,
 * so the one caller that KNOWS a duplicate is normal traffic could not tell it apart from a real
 * failure without matching on the message text.
 *
 * The consequences of that were asymmetric and both wrong. On the manual upload route the plain
 * error fell through to a 500. On the ERA path it was caught as an unrecognised throw, judged
 * permanent, and the artifact was DEAD-LETTERED — sending a human to retrieve a payment file whose
 * money was already on the ledger, while the Today queue reported abandoned money that was not
 * abandoned.
 *
 * Carrying the key rather than only a sentence, so a caller can re-read the row it lost the race to.
 */
export class DuplicateRemittanceError extends Error {
  readonly code = "duplicate_dedupe_key";
  readonly dedupeKey: string;
  constructor(dedupeKey: string) {
    // The wording is load-bearing: `repositories.test.ts` and `service.test.ts` assert the refusal
    // by this message, and those assertions are the record that the constraint still refuses.
    super(`remittance with dedupe key ${dedupeKey} already exists`);
    this.name = "DuplicateRemittanceError";
    this.dedupeKey = dedupeKey;
  }
}

export interface RemittanceFilter {
  status?: Remittance["status"];
  /** Only remittances a human still has to deal with (held, or posted with actionable variance). */
  needsAttention?: boolean;
}

/**
 * How much money is stopped, and how long the oldest has been stopped for.
 *
 * ── WHY THIS IS A QUERY AND NOT A `list()` CALL ────────────────────────────────────────────────
 * The monitor asks this every tick, for every practice. `list()` reads whole remittance aggregates —
 * each one carrying its postings and an encrypted raw 835 — and decrypting a practice's entire
 * payment history once a minute to count three numbers is the kind of cost that gets a monitor
 * turned off, and a monitor that is turned off is worse than none because the dashboard still shows
 * its tile.
 *
 * `oldestReceivedAt` is null exactly when `count` is zero, and the two are read in one statement so
 * they cannot disagree about the same instant.
 */
export interface HeldRemittanceSummary {
  count: number;
  /** ISO timestamp of the longest-held remittance, or null when nothing is held. */
  oldestReceivedAt: string | null;
  /** Sum of `paymentTotal` across every held remittance, integer cents. */
  totalCents: number;
}

export interface RemittanceRepository {
  /**
   * Insert a new remittance.
   *
   * Throws `DuplicateRemittanceError` when this practice already holds one under the same dedupe
   * key — and it must stay a REFUSAL, because that constraint is the real guarantee that one
   * payment posts once. On Postgres the failed INSERT is rolled back to a savepoint first, so the
   * caller's transaction survives and can re-read the row it lost the race to; without that, the
   * whole request would be aborted by a condition the service treats as ordinary traffic.
   */
  save(remittance: Remittance): Promise<Remittance>;
  update(remittance: Remittance): Promise<Remittance>;
  getById(id: string): Promise<Remittance | null>;
  /**
   * Read a remittance FOR UPDATE — the read `release()` must start from.
   *
   * ── WHAT AN UNLOCKED RELEASE DOES ──────────────────────────────────────────────────────────────
   * Releasing is read-modify-write: read the held remittance, check it is not already posted, post
   * it, and publish one `remittance.posted` per posting. Two releases of the same remittance racing
   * — a biller double-clicking, or two people working the same hold — both read `held`, both pass
   * the already-posted guard, and both publish.
   *
   * The downstream consumers that key on the POSTING absorb it: Claims is idempotent on
   * `postingId`, and the ledger's `source_ref` unique index refuses a second charge. Analytics is
   * not, and cannot be — it is idempotent on the SOURCE EVENT id, and these are two genuinely
   * different events carrying the same money. So the practice report double-counts every dollar on
   * that advice, which is the one number a practice owner uses to decide whether the month worked.
   *
   * Postgres backs this with a row lock, so the second caller waits and then sees `posted` and
   * returns the existing view — which is exactly what the guard was always meant to do.
   */
  lockById(id: string): Promise<Remittance | null>;
  /**
   * The idempotency lookup, on the DEDUPE KEY rather than the trace number.
   *
   * Two trace-less remittances both carry `traceNumber: ""` and are different payments; looking up
   * by trace number would find the first every time and silently discard the second.
   */
  getByDedupeKey(dedupeKey: string): Promise<Remittance | null>;
  list(filter?: RemittanceFilter): Promise<Remittance[]>;
  /**
   * How much money this practice is sitting on, and since when.
   *
   * Held money is the one balance in this system that reconciles perfectly while being wrong to
   * ignore: the remittance IS in the table, so `reconcileAll()` sums it and reports zero drift, and
   * the payer's cash is nonetheless in the bank against nothing anybody is working. This is the
   * reading that makes the age of that pile observable.
   */
  heldSummary(): Promise<HeldRemittanceSummary>;
  /**
   * What method this payer used on its PREVIOUS payment, or null when this is the first (F1).
   *
   * ── WHY A NARROW QUERY AND NOT `list()` ────────────────────────────────────────────────────────
   * The same reason `heldSummary` is one: `list()` reads whole aggregates, each carrying its
   * postings and an encrypted raw 835, and decrypting a practice's payment history to read one
   * column per remittance is the cost that gets a check deleted. This reads one column.
   *
   * ── WHY KEYED ON THE PAYER NAME ────────────────────────────────────────────────────────────────
   * Because it is what a remittance carries. `#publishAllowedAmounts` keys its observations on the
   * payer SLUG from the claim's expectation, deliberately, since a contracted RATE filed against the
   * wrong payer would be quoted to patients of a payer that never agreed to it. The question here is
   * narrower and operational — "did the entity that paid me last time by ACH just pay me by card?" —
   * and the entity that paid is exactly who printed their name in the BPR. A payer that renames
   * itself reads as a first sighting, which is the safe direction: a missed reversion is a finding
   * deferred to the next payment, while a false one would send a biller to argue from a fiction.
   *
   * Excludes the remittance being assessed, so the caller may write first and ask afterwards.
   */
  priorPaymentMethod(payerName: string, excludingRemittanceId: string): Promise<string | null>;
}

export interface ExpectationRepository {
  /** Idempotent by `patientControlNumber` — a redelivered `claim.submitted` must not duplicate. */
  record(expectation: ClaimExpectation): Promise<ClaimExpectation>;
  getByControlNumber(patientControlNumber: string): Promise<ClaimExpectation | null>;
  /** Every control number we are waiting on payment for — the safety gate's match set. */
  knownControlNumbers(): Promise<Set<string>>;
  list(): Promise<ClaimExpectation[]>;
  /**
   * Set the outstanding award for a claim. ASSIGNMENT, never an increment: the caller passes a
   * figure recomputed from the denials that own it, so a replayed event converges instead of
   * accumulating. Returns false when there is no expectation to update.
   */
  setAwardOutstanding(patientControlNumber: string, amount: Cents): Promise<boolean>;
}

export class InMemoryRemittanceRepository implements RemittanceRepository {
  #remittances = new Map<string, Remittance>();
  /** dedupeKey → remittanceId. The in-memory stand-in for `remittances_one_per_dedupe_key`. */
  #byDedupeKey = new Map<string, string>();

  async save(remittance: Remittance): Promise<Remittance> {
    if (this.#remittances.has(remittance.id)) {
      throw new Error(`remittance ${remittance.id} already exists`);
    }
    // The same typed refusal Postgres raises, so `repository-contract.test.ts` holds both stores to
    // one behaviour and the service's duplicate handling is exercised by the in-memory suite too.
    if (this.#byDedupeKey.has(remittance.dedupeKey)) {
      throw new DuplicateRemittanceError(remittance.dedupeKey);
    }
    this.#remittances.set(remittance.id, structuredClone(remittance));
    this.#byDedupeKey.set(remittance.dedupeKey, remittance.id);
    return structuredClone(remittance);
  }

  async update(remittance: Remittance): Promise<Remittance> {
    if (!this.#remittances.has(remittance.id)) {
      throw new Error(`remittance ${remittance.id} not found`);
    }
    this.#remittances.set(remittance.id, structuredClone(remittance));
    return structuredClone(remittance);
  }

  async getById(id: string): Promise<Remittance | null> {
    const found = this.#remittances.get(id);
    return found ? structuredClone(found) : null;
  }

  /** No lock to take in memory — single process, single flow. The contract lives in Postgres. */
  async lockById(id: string): Promise<Remittance | null> {
    return this.getById(id);
  }

  async getByDedupeKey(dedupeKey: string): Promise<Remittance | null> {
    const id = this.#byDedupeKey.get(dedupeKey);
    return id ? this.getById(id) : null;
  }

  async list(filter?: RemittanceFilter): Promise<Remittance[]> {
    let all = [...this.#remittances.values()].map((r) => structuredClone(r));
    if (filter?.status) all = all.filter((r) => r.status === filter.status);
    if (filter?.needsAttention) {
      // Mirrors the SQL in repository.pg.ts and `outstandingOf` in view.ts: the payer flag alone
      // keeps fully-recovered advices in the queue.
      all = all.filter(
        // A REJECTED advice keeps its postings as evidence, and they must never read as money owed:
        // only a posted advice can be holding recoverable money.
        (r) =>
          r.status === "held" ||
          (r.status === "posted" && r.postings.some((p) => p.variance?.actionable && outstandingOf(p) > 0))
      );
    }
    return all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async heldSummary(): Promise<HeldRemittanceSummary> {
    const held = [...this.#remittances.values()].filter((r) => r.status === "held");
    return {
      count: held.length,
      // `reduce` rather than a sort: the minimum is the whole question, and sorting would invite a
      // reader to assume an ordering the Postgres version does not promise either.
      oldestReceivedAt: held.reduce<string | null>(
        (oldest, r) => (oldest === null || r.receivedAt < oldest ? r.receivedAt : oldest),
        null
      ),
      totalCents: held.reduce((sum, r) => sum + r.paymentTotal, 0),
    };
  }

  async priorPaymentMethod(payerName: string, excludingRemittanceId: string): Promise<string | null> {
    const key = payerName.trim().toUpperCase();
    const prior = [...this.#remittances.values()]
      .filter((r) => r.id !== excludingRemittanceId && r.payerName.trim().toUpperCase() === key)
      /**
       * Most recently RECEIVED, not most recent payment date. `receivedAt` is this system's own
       * clock and always set; `paymentDate` is the payer's and may repeat across a batch, which
       * would make "the previous one" ambiguous exactly when a payer sends several in a day.
       */
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    return prior ? prior.paymentMethod : null;
  }

  get size(): number {
    return this.#remittances.size;
  }
}

export class InMemoryExpectationRepository implements ExpectationRepository {
  #expectations = new Map<string, ClaimExpectation>();

  async record(expectation: ClaimExpectation): Promise<ClaimExpectation> {
    // Last write wins rather than throwing: a redelivered claim.submitted carries identical data,
    // and a genuine resubmission under the same control number should refresh the expectation.
    //
    // An award already recorded against this control number SURVIVES a re-record, matching the
    // Postgres ON CONFLICT clause, which does not list the award column. A resubmitted claim does
    // not un-win an appeal.
    const existing = this.#expectations.get(expectation.patientControlNumber);
    const merged: ClaimExpectation = {
      ...expectation,
      awardOutstanding: expectation.awardOutstanding ?? existing?.awardOutstanding ?? (0 as Cents),
    };
    this.#expectations.set(expectation.patientControlNumber, structuredClone(merged));
    return structuredClone(merged);
  }

  async setAwardOutstanding(patientControlNumber: string, amount: Cents): Promise<boolean> {
    const found = this.#expectations.get(patientControlNumber);
    if (!found || found.awardOutstanding === amount) return false;
    this.#expectations.set(patientControlNumber, { ...found, awardOutstanding: amount });
    return true;
  }

  async getByControlNumber(patientControlNumber: string): Promise<ClaimExpectation | null> {
    const found = this.#expectations.get(patientControlNumber);
    return found ? structuredClone(found) : null;
  }

  async knownControlNumbers(): Promise<Set<string>> {
    return new Set(this.#expectations.keys());
  }

  async list(): Promise<ClaimExpectation[]> {
    return [...this.#expectations.values()].map((e) => structuredClone(e));
  }

  get size(): number {
    return this.#expectations.size;
  }
}

// ── Coordination cases ───────────────────────────────────────────────────────────────────────

/**
 * Storage for `CoordinationCase` (see `coordination.ts`). One case per claim, enforced by the
 * database in Postgres (`coordination_one_case_per_claim`) and by the map key here.
 *
 * `insertIfAbsent` rather than a plain insert: two advices for one claim can be ingested at once,
 * and the loser must learn it lost — then re-read and merge — rather than abort its transaction.
 */
export interface CoordinationRepository {
  getById(id: string): Promise<CoordinationCase | null>;
  /** Read for an update the caller is about to write: `SELECT … FOR UPDATE` in Postgres. */
  lockById(id: string): Promise<CoordinationCase | null>;
  lockByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null>;
  /** A plain read, for views: no row lock. */
  getByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null>;
  list(): Promise<CoordinationCase[]>;
  /** True when inserted; false when a case for this claim already exists (nothing written). */
  insertIfAbsent(c: CoordinationCase): Promise<boolean>;
  update(c: CoordinationCase): Promise<CoordinationCase>;
}

export class InMemoryCoordinationRepository implements CoordinationRepository {
  #cases = new Map<string, CoordinationCase>();

  async getById(id: string): Promise<CoordinationCase | null> {
    const found = [...this.#cases.values()].find((c) => c.id === id);
    return found ? structuredClone(found) : null;
  }
  async lockById(id: string): Promise<CoordinationCase | null> {
    return this.getById(id);
  }
  async lockByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null> {
    return this.getByControlNumber(patientControlNumber);
  }
  async getByControlNumber(patientControlNumber: string): Promise<CoordinationCase | null> {
    const found = this.#cases.get(patientControlNumber);
    return found ? structuredClone(found) : null;
  }
  async list(): Promise<CoordinationCase[]> {
    return [...this.#cases.values()].map((c) => structuredClone(c)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async insertIfAbsent(c: CoordinationCase): Promise<boolean> {
    if (this.#cases.has(c.patientControlNumber)) return false;
    this.#cases.set(c.patientControlNumber, structuredClone(c));
    return true;
  }
  async update(c: CoordinationCase): Promise<CoordinationCase> {
    this.#cases.set(c.patientControlNumber, structuredClone(c));
    return structuredClone(c);
  }
}
