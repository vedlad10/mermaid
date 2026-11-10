/**
 * Verification persistence seam. Modules never see raw SQL from the outside — they depend on THIS
 * interface. Two implementations sit behind it, exactly as the EDI adapter is swappable (blueprint
 * doc 09):
 *
 *   • InMemoryVerificationRepository — the dev/demo store used by the clinic web demo and tests.
 *   • (future) a Postgres-backed repository over @mermaid/db with RLS — the production path, landing
 *     with migration 0006 once a database is provisioned (blueprint docs 03, 14; HANDOFF §14 M3).
 *
 * The in-memory store is single-practice demo scope; it is NOT a replacement for RLS. Tenant
 * isolation remains a Postgres RLS guarantee (design decision §12.4) — the DB implementation is a
 * drop-in behind this same interface, no service/UI change.
 */
import type { VerificationRecord, VerificationStatus } from "./types.ts";

/**
 * Everything belonging to one human (M14 deliverable 4).
 *
 * Two keys, matched as an OR, and both are needed. `patientId` is exact and is what every
 * verification written since the patient master landed carries. `memberIds` catches the rest: a
 * verification run before M14 has a NULL `patient_id`, and pretending it never happened would make
 * the patient record less trustworthy than the queue it was assembled from. The member IDs come from
 * the same `coverages` mapping the ledger resolves through, so the two halves cannot disagree about
 * whose money is whose.
 */
export interface PatientScope {
  patientId: string;
  memberIds: string[];
}

export interface VerificationFilter {
  status?: VerificationStatus;
  /**
   * Restrict to verifications a human still has to settle.
   *
   * NOT the same as "not verified". A `failed` verification that a person has already REJECTED is
   * finished work — the human-in-the-loop decision was "this is unusable", and re-offering it is how
   * a worklist teaches staff to distrust it. A `failed` verification nobody has looked at (unknown
   * payer, no benefits returned) genuinely does need a person, and stays.
   */
  openOnly?: boolean;
  /** Everything for one patient — see `PatientScope`. */
  patient?: PatientScope;
}

/**
 * The member ID a verification was run under, as a MATCH KEY.
 *
 * Two other places read the same two fields and must NOT be folded into this, because they want
 * different things from them:
 *
 *   • `repository.pg.ts` writes the `member_id` COLUMN — storage, untrimmed, nullable.
 *   • `view.ts` builds a display value, `?? null`, so a screen can show a dash.
 *
 * This one is neither: it normalises to a string that can be compared against the member IDs
 * `coverages` holds, and returns `""` — never null — so the caller's emptiness check is one branch.
 * Three readings of two fields is not duplication; collapsing them would couple a storage concern to
 * a matching concern and the first change to either would be made in the wrong place.
 */
export const verificationMemberId = (record: VerificationRecord): string =>
  (record.card.memberId.value ?? record.patient.memberId ?? "").trim();

/**
 * True when this record belongs to the scoped patient, by id or by any member ID they hold.
 *
 * ── THE MEMBER-ID ARM IS FOR UNRESOLVED ROWS ONLY ──────────────────────────────────────────────
 * A member ID identifies a POLICY, not a person: a dental plan issues one to the subscriber and
 * covers the whole family under it, which `service.ts` records as a coverage per family member. So
 * a member ID that matches proves the record belongs to this policy — never that it belongs to this
 * patient.
 *
 * Reaching for it on a record that already NAMES its patient is therefore how a parent's
 * verification appears on their child's chart. Once `patientId` is set it is the only answer, and a
 * mismatch is a no rather than a reason to go looking for a second opinion.
 *
 * The fallback survives untouched for the case it was written for: a verification from before the
 * patient master landed carries a NULL `patientId`, and dropping those would make the record less
 * trustworthy than the queue it was assembled from.
 */
export const inPatientScope = (record: VerificationRecord, scope: PatientScope): boolean => {
  if (record.patientId) return record.patientId === scope.patientId;
  const memberId = verificationMemberId(record);
  return memberId !== "" && scope.memberIds.includes(memberId);
};

/** True when a person still has to act on this record — the predicate `openOnly` filters by. */
export const needsAPerson = (record: VerificationRecord): boolean =>
  record.status === "needs_review" || (record.status === "failed" && record.review === null);

export interface VerificationRepository {
  /** Insert a freshly-produced record. Throws if the id already exists. */
  save(record: VerificationRecord): Promise<VerificationRecord>;
  /** Persist changes to an existing record (e.g. after a human review). Throws if not found. */
  update(record: VerificationRecord): Promise<VerificationRecord>;
  getById(id: string): Promise<VerificationRecord | null>;
  /**
   * Read a record FOR UPDATE — the read `review()` must start from.
   *
   * Recording a review is read-modify-write: read the record, stamp the decision, save, then
   * announce. Two reviewers deciding the same flagged verification at once both read the pre-review
   * record, and the second write silently erases the first person's decision and notes from the
   * audit trail — on the screen a practice quotes when a patient disputes what they were told.
   *
   * Both also announce, and `verification.completed` is where a claim comes from. The claim itself
   * is safe (creation is idempotent on `verificationId`), but analytics keys on the SOURCE EVENT
   * id, so two events for one verification are two facts and the funnel over-counts completions —
   * the same shape as the remittance double-release.
   *
   * Postgres backs this with a row lock; the in-memory store passes through, having no second
   * connection to race with.
   */
  lockById(id: string): Promise<VerificationRecord | null>;
  list(filter?: VerificationFilter): Promise<VerificationRecord[]>;
}

/**
 * In-memory demo/dev repository. Records are deep-cloned on the way in and out so callers can never
 * mutate stored state by reference — mimicking the isolation a real DB round-trip gives you, which
 * keeps demo/test behaviour honest against the eventual Postgres implementation.
 */
export class InMemoryVerificationRepository implements VerificationRepository {
  #records = new Map<string, VerificationRecord>();

  async save(record: VerificationRecord): Promise<VerificationRecord> {
    if (this.#records.has(record.id)) {
      throw new Error(`verification ${record.id} already exists`);
    }
    this.#records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async update(record: VerificationRecord): Promise<VerificationRecord> {
    if (!this.#records.has(record.id)) {
      throw new Error(`verification ${record.id} not found`);
    }
    this.#records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async getById(id: string): Promise<VerificationRecord | null> {
    const found = this.#records.get(id);
    return found ? structuredClone(found) : null;
  }

  /** No lock to take in memory — single process, single flow. The contract lives in Postgres. */
  async lockById(id: string): Promise<VerificationRecord | null> {
    return this.getById(id);
  }

  async list(filter?: VerificationFilter): Promise<VerificationRecord[]> {
    let all = [...this.#records.values()].map((r) => structuredClone(r));
    if (filter?.status) all = all.filter((r) => r.status === filter.status);
    if (filter?.openOnly) all = all.filter(needsAPerson);
    if (filter?.patient) {
      const scope = filter.patient;
      all = all.filter((r) => inPatientScope(r, scope));
    }
    // Newest first; the service re-ranks by work-priority for the queue view.
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Test/demo helper — number of stored records. */
  get size(): number {
    return this.#records.size;
  }
}
