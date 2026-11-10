/**
 * Claim persistence seam. Modules never see raw SQL from the outside — they depend on THIS
 * interface, exactly as Verification does (blueprint doc 09's swappable-adapter discipline applied
 * to storage):
 *
 *   • InMemoryClaimRepository — the dev/demo store used by the clinic web demo and tests.
 *   • (future) a Postgres-backed repository over @mermaid/db with RLS — the production path, landing
 *     with the `claims` / `claim_lines` tables (blueprint doc 03).
 *
 * `getByVerificationId` is not a convenience: it is what makes claim creation idempotent under the
 * outbox's at-least-once delivery. Without it, a redelivered `verification.completed` produces a
 * second claim for the same treatment — and two claims for one visit is a duplicate-billing
 * incident, not a cosmetic bug. In Postgres this is backed by a UNIQUE index on `verification_id`.
 */
import { OPEN_STATUSES } from "./engine/status.ts";
import type { Claim, ClaimStatus } from "./types.ts";

export interface ClaimFilter {
  status?: ClaimStatus;
  /** Restrict to claims the clinic still has to act on — `OPEN_STATUSES` in `engine/status.ts`. */
  openOnly?: boolean;
  /**
   * Every claim filed under any of these member IDs.
   *
   * ⚠ NOT A PATIENT SCOPE, and it never was one. A member ID identifies a POLICY: a dental plan
   * issues one to the subscriber and covers the whole family under it, which `coverages` records as
   * a row per family member (`UNIQUE (practice_id, member_id, patient_id)` — many-to-many, by
   * design). `ClaimPatient.memberId` says the same thing in this module's own words: "the POLICY
   * this claim is filed under — not an identifier for this person."
   *
   * Used as a person's key it returns every family member's claims, and the denials that hang off
   * them. Use `verificationIds` to ask for one human's claims; this remains for asking about a
   * policy, which is a different and still-legitimate question.
   *
   * An empty array matches nothing, which is the correct reading of "these IDs" when there are none
   * — not "all claims", which is how a filter accidentally becomes a data leak.
   */
  memberIds?: string[];
  /**
   * Every claim built from any of these verifications — ONE HUMAN's billing history (B2).
   *
   * ── WHY THE VERIFICATION IS THE PATIENT KEY ────────────────────────────────────────────────────
   * `claims.verification_id` is NOT NULL and `UNIQUE (practice_id, verification_id)`, so a claim has
   * exactly one verification and a verification has at most one claim. `verifications.patient_id`
   * is the patient master's own answer to whose visit it was, resolved on name and date of birth —
   * never on the member ID, and therefore never ambiguous for a family sharing one policy.
   *
   * That makes claim → verification → patient the authoritative chain, and it already exists: no
   * `claims.patient_id`, no migration, no backfill, and no second copy of the member-ID mapping to
   * drift out of step with `coverages`. The objection recorded on `memberIds` above — that copying
   * the mapping into this table would be a second place for it to drift — still holds, and this
   * respects it.
   *
   * ── WHY THE CALLER RESOLVES THEM ───────────────────────────────────────────────────────────────
   * The join is not done here. Every repository in this codebase reads its OWN module's tables and
   * only those, and a `claims`-to-`verifications` join would be the first exception — one the
   * in-memory store could not mirror, which is precisely how two implementations of one port start
   * disagreeing. So the composition root, which already holds the patient's verifications, passes
   * their ids down. Both stores then answer the same question the same way.
   *
   * Legacy rows need no special case here. A verification written before the patient master carries
   * a NULL `patient_id` and is matched by member ID in ITS OWN scope, so it is already in the set
   * the caller resolved — its claim arrives through this filter without `claims` ever comparing a
   * member ID.
   *
   * An empty array matches nothing, for the same reason as above.
   */
  verificationIds?: string[];
}

export interface ClaimRepository {
  /** Insert a freshly-built claim. Throws if the id already exists. */
  save(claim: Claim): Promise<Claim>;
  /** Persist changes to an existing claim. Throws if not found. */
  update(claim: Claim): Promise<Claim>;
  getById(id: string): Promise<Claim | null>;
  /**
   * Read a claim FOR UPDATE — the read every mutating path must use.
   *
   * ── THE LOST UPDATE THIS EXISTS TO PREVENT ─────────────────────────────────────────────────────
   * Every mutation here is read-modify-write over the whole aggregate: read the document, build a
   * new one, UPDATE the row. Two transactions doing that concurrently both read the same starting
   * point, and the second commit silently overwrites the first — which is not hypothetical, because
   * the outbox runs in the web process AND a background worker, both draining with SKIP LOCKED, so
   * two `remittance.posted` events for the same claim can be in flight at once. The second posting
   * would erase the first from `claim.payments`: a recorded payment gone, revenue understated, and
   * no error anywhere. The same race lets two clicks of the submit button both pass the gate and
   * file the claim twice.
   *
   * Postgres backs this with `SELECT … FOR UPDATE`, so the second reader waits and then sees the
   * first writer's committed claim. The in-memory store cannot lock and does not need to for its
   * job (the DB-free demo and single-flow tests); the contract is that MUTATING service paths call
   * this, and the backend that has real concurrency enforces it.
   */
  lockById(id: string): Promise<Claim | null>;
  /** The idempotency key for event-driven creation. */
  getByVerificationId(verificationId: string): Promise<Claim | null>;
  /**
   * Live claims already filed for THIS PERSON on this date of service.
   *
   * ── NAME AND DATE OF BIRTH IS THE PATIENT SCOPE ────────────────────────────────────────────────
   * Not a member ID: the case this exists to catch is a second policy, which by definition means a
   * different member ID for the same person. Not a patient id either — `claims` deliberately holds
   * none, and reaching into the patient master from here would cross a module boundary no other
   * repository crosses.
   *
   * It does not need to. `deriveChartId` resolves a person on surname, given name and date of birth,
   * so two verifications resolve to the SAME `patients` row exactly when those three match — which
   * makes this predicate equivalent to the verification→patient chain, computed from fields the
   * claim already carries. Name alone was not: two different people who share a name (a father and
   * son, a live pair in this database) were read as one, and every claim of theirs on a shared date
   * flagged the other's.
   *
   * Normalisation mirrors `deriveChartId`'s: case, surrounding whitespace and internal runs of
   * whitespace are insignificant. Accents and punctuation are deliberately NOT folded there, so they
   * are not folded here — "O'Brien" and "OBrien" stay two people in both places or the two would
   * disagree about who somebody is.
   *
   * VOID and REJECTED claims are excluded. A withdrawn claim is not a duplicate of anything, and a
   * claim the payer refused AT INTAKE was never accepted — refiling it is the correct act, not a
   * second billing of one service.
   */
  filedOnDateFor(
    patient: { firstName: string; lastName: string; dateOfBirth: string },
    serviceDate: string
  ): Promise<Claim[]>;
  list(filter?: ClaimFilter): Promise<Claim[]>;
}

/**
 * What "open" means — ONE definition, from the status engine.
 *
 * This used to be a local list here that omitted `partially_paid` and `denied`, while the Postgres
 * repository mirrored the engine's list and included them. The two backends therefore returned
 * different worklists for the same filter: the DB-free demo hid every adjudicated claim, production
 * showed them, and nothing failed. A seam whose implementations disagree is worse than no seam,
 * because the in-memory suite then certifies behaviour that production does not have.
 */
const OPEN: readonly ClaimStatus[] = OPEN_STATUSES;

/**
 * Statuses a claim can hold and still not be something a second filing would DUPLICATE.
 *
 * `void` is withdrawn — it is not a duplicate of anything. `rejected` is the payer refusing AT
 * INTAKE, before adjudication: the claim was never accepted, so correcting and refiling it is the
 * prescribed act rather than a second billing of one service. Warning on either would fire the
 * control on the routine case, which is how staff learn to clear it by reflex — and then clear the
 * real one too.
 *
 * Shared by both stores so the two cannot drift about what "already filed" means.
 */
export const CLOSED_TO_DUPLICATES: readonly ClaimStatus[] = ["void", "rejected"];

/**
 * In-memory demo/dev repository. Claims are deep-cloned in and out so a caller can never mutate
 * stored state by reference — mimicking a real DB round-trip, which keeps demo and test behaviour
 * honest against the eventual Postgres implementation.
 */
export class InMemoryClaimRepository implements ClaimRepository {
  #claims = new Map<string, Claim>();
  /** verificationId → claimId. The in-memory stand-in for the UNIQUE index. */
  #byVerification = new Map<string, string>();

  async save(claim: Claim): Promise<Claim> {
    if (this.#claims.has(claim.id)) {
      throw new Error(`claim ${claim.id} already exists`);
    }
    if (this.#byVerification.has(claim.verificationId)) {
      throw new Error(`verification ${claim.verificationId} already has a claim`);
    }
    this.#claims.set(claim.id, structuredClone(claim));
    this.#byVerification.set(claim.verificationId, claim.id);
    return structuredClone(claim);
  }

  async update(claim: Claim): Promise<Claim> {
    if (!this.#claims.has(claim.id)) {
      throw new Error(`claim ${claim.id} not found`);
    }
    this.#claims.set(claim.id, structuredClone(claim));
    return structuredClone(claim);
  }

  async getById(id: string): Promise<Claim | null> {
    const found = this.#claims.get(id);
    return found ? structuredClone(found) : null;
  }

  /** No lock to take in memory — single process, single flow. The contract lives in Postgres. */
  async lockById(id: string): Promise<Claim | null> {
    return this.getById(id);
  }

  async getByVerificationId(verificationId: string): Promise<Claim | null> {
    const id = this.#byVerification.get(verificationId);
    return id ? this.getById(id) : null;
  }

  async filedOnDateFor(
    patient: { firstName: string; lastName: string; dateOfBirth: string },
    serviceDate: string
  ): Promise<Claim[]> {
    // The twin of the port's predicate — the same normalisation `deriveChartId` applies, so both
    // stores answer "is this the same person" the way the patient master does.
    const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
    const samePerson = (c: Claim) =>
      norm(c.patient.firstName) === norm(patient.firstName) &&
      norm(c.patient.lastName) === norm(patient.lastName) &&
      c.patient.dateOfBirth.slice(0, 10) === patient.dateOfBirth.slice(0, 10);
    return [...this.#claims.values()]
      .filter(
        (c) => !CLOSED_TO_DUPLICATES.includes(c.status) && c.serviceDate === serviceDate && samePerson(c)
      )
      .map((c) => structuredClone(c));
  }

  async list(filter?: ClaimFilter): Promise<Claim[]> {
    let all = [...this.#claims.values()].map((c) => structuredClone(c));
    if (filter?.status) all = all.filter((c) => c.status === filter.status);
    if (filter?.openOnly) all = all.filter((c) => OPEN.includes(c.status));
    if (filter?.memberIds) {
      const ids = new Set(filter.memberIds);
      all = all.filter((c) => ids.has(c.patient.memberId));
    }
    if (filter?.verificationIds) {
      // The twin of the port's `verification_id = ANY(...)`. Both are exact-set membership on a
      // NOT NULL column, so neither store has an "unknown" case to disagree about.
      const ids = new Set(filter.verificationIds);
      all = all.filter((c) => ids.has(c.verificationId));
    }
    // Newest first; the service re-ranks by work-priority for the queue view.
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Test/demo helper — number of stored claims. */
  get size(): number {
    return this.#claims.size;
  }
}
