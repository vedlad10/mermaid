/**
 * Ledger persistence seam.
 *
 * `append` is idempotent on `sourceRef`. That is load-bearing rather than defensive: the outbox
 * delivers at least once, and a double-charged patient is the single worst failure this product can
 * produce — it is money demanded from a person who does not owe it, and unlike a wrong dashboard
 * figure it does not stay inside the building.
 *
 * The guarantee belongs in the database (a UNIQUE index on `source_ref`), not in a service-layer
 * check that two concurrent workers can both pass.
 */
import { groupKeyFor } from "./types.ts";
import type { LedgerEntry } from "./types.ts";

/**
 * One human's money, however it is keyed (M14 deliverable 4).
 *
 * Two keys, matched as an OR, and both are load-bearing. `patientId` is the M14 grouping and catches
 * a member ID this patient holds today. `patientKeys` catches entries whose `patient_id` never
 * resolved — a payment taken against a legacy key, or money recorded before the patient master
 * existed — which are exactly the entries a unified balance must not silently drop. A person shown a
 * balance that is too LOW because a row was invisible is the worse failure of the two, so the union
 * is deliberate rather than defensive.
 */
export interface PatientScope {
  patientId: string;
  /** Every member ID / account key this person is known by. */
  patientKeys: string[];
}

export interface LedgerFilter {
  patientKey?: string;
  /** Only accounts that still owe something. */
  withBalanceOnly?: boolean;
  /** Everything belonging to one human — see `PatientScope`. */
  patient?: PatientScope;
}

/**
 * True when this entry is part of the scoped person's money. The predicate both stores implement.
 *
 * ── THE KEY ARM IS FOR UNRESOLVED ENTRIES ONLY ─────────────────────────────────────────────────
 * `patientKey` is a member ID, and a member ID is a POLICY: one is issued to the subscriber and the
 * whole family is covered under it. So a key match proves the entry belongs to this policy, never
 * that it belongs to this person — and consulting it on an entry that already names its patient is
 * precisely how one family member's balance lands on another's statement, which is the failure
 * `patientIdForMemberId` refuses to cause on the way in by answering null rather than guessing.
 *
 * A resolved entry answers for itself. The union still covers what it was written for: entries
 * whose `patientId` never resolved — a payment taken against a legacy key, or money recorded before
 * the patient master existed — are still this person's and must not vanish from a unified balance.
 */
export const inPatientScope = (entry: LedgerEntry, scope: PatientScope): boolean =>
  entry.patientId !== null
    ? entry.patientId === scope.patientId
    : scope.patientKeys.includes(entry.patientKey);

export interface LedgerRepository {
  /**
   * Append one entry. Returns false when `sourceRef` had already produced an entry — a redelivery,
   * not an error.
   */
  append(entry: LedgerEntry): Promise<boolean>;
  /** Every entry for one patient, in any order (the engine sorts). */
  entriesFor(patientKey: string): Promise<LedgerEntry[]>;
  /** Every entry the practice has. Scoped by the filter, and by RLS in the Postgres implementation. */
  list(filter?: LedgerFilter): Promise<LedgerEntry[]>;
  /**
   * Take an exclusive lock on this patient's account for the rest of the transaction (M16).
   *
   * ── WHY A READ-THEN-CHECK IS NOT ENOUGH HERE ───────────────────────────────────────────────────
   * `PatientLedgerService.#humanEntry` reads the account, computes the balance, refuses an amount
   * larger than it, and then appends — across a `READ COMMITTED` transaction boundary. Two payments
   * taken at once both read the same pre-state, both pass the check, and both are written: the
   * balance goes negative, which is precisely what that check exists to prevent and what its own
   * error message calls "a ledger nobody can reconcile".
   *
   * It is the same check-then-act shape the remittance repository already documents as insufficient
   * and backs with a UNIQUE constraint. There is no constraint available for "the sum of these rows
   * must not go below zero", so the serialisation has to be a lock.
   *
   * A no-op in memory, where there is one thread and no concurrency to lose to.
   */
  lockPatient(patientKey: string): Promise<void>;
}

const clone = (entry: LedgerEntry): LedgerEntry => structuredClone(entry);

export class InMemoryLedgerRepository implements LedgerRepository {
  #entries: LedgerEntry[] = [];
  /** The in-memory stand-in for the UNIQUE index on `source_ref`. */
  #bySource = new Set<string>();

  async append(entry: LedgerEntry): Promise<boolean> {
    if (entry.sourceRef !== null) {
      if (this.#bySource.has(entry.sourceRef)) return false;
      this.#bySource.add(entry.sourceRef);
    }
    this.#entries.push(clone(entry));
    return true;
  }

  async entriesFor(patientKey: string): Promise<LedgerEntry[]> {
    return this.#entries.filter((e) => e.patientKey === patientKey).map(clone);
  }

  /** Nothing to serialise against in a single-threaded store. See the port for why it exists. */
  async lockPatient(): Promise<void> {}

  async list(filter?: LedgerFilter): Promise<LedgerEntry[]> {
    let all = this.#entries.map(clone);
    if (filter?.patientKey) all = all.filter((e) => e.patientKey === filter.patientKey);
    if (filter?.patient) {
      const scope = filter.patient;
      all = all.filter((e) => inPatientScope(e, scope));
    }
    if (filter?.withBalanceOnly) {
      /** The same grouping the service and the SQL filter use — see the note in repository.pg.ts. */
      const balances = new Map<string, number>();
      for (const entry of this.#entries) {
        const key = groupKeyFor(entry);
        balances.set(key, (balances.get(key) ?? 0) + entry.amount);
      }
      all = all.filter((e) => (balances.get(groupKeyFor(e)) ?? 0) !== 0);
    }
    return all;
  }

  get size(): number {
    return this.#entries.length;
  }
}
