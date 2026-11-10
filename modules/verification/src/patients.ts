/**
 * The patient master — the persistence seam for `patients`.
 *
 * Verification owns this table (docs/ARCHITECTURE.md), because verification is where a person first
 * enters the system: a card is read, an identity is validated, and from that moment the practice has
 * a patient whether or not a claim ever follows.
 *
 * Two implementations behind one interface, like every other repository here, and both are held to
 * the same behaviour by `tests/db/repository-contract.test.ts`.
 */
import type { SubscriberIdentity, SubscriberRelationship } from "@mermaid/shared";
import type { PatientIdentity } from "./engine/identity.ts";
import { deriveChartId } from "./engine/identity.ts";
import type { PatientAddress } from "./types.ts";

export interface PatientRecord {
  id: string;
  chartId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  /**
   * Where the practice last recorded this person as living — 837D loop 2010BA N3/N4.
   *
   * Absent means NOT COLLECTED, and it must keep meaning that. Nothing may default it, and the
   * scrubber blocks filing on it rather than guessing, because an address on a claim is a statement
   * to a payer about where a patient lives.
   */
  address?: PatientAddress;
  /** DMG03. `U` is a valid X12 answer and the honest default when nobody has asked. */
  gender?: "M" | "F" | "U";
}

/**
 * The facts about a person that a visit can UPDATE but that do not IDENTIFY them.
 *
 * Kept separate from `PatientIdentity` on purpose. The chart id is a hash of surname, given name and
 * date of birth (`engine/identity.ts`), so anything folded into the identity changes the id and
 * therefore splits the record. A person who moves house is the same person: their address belongs
 * here, never in the identity.
 */
export interface PatientDemographics {
  address?: PatientAddress;
  gender?: "M" | "F" | "U";
}

export interface PatientDirectory {
  /**
   * Resolve this identity to a patient record, creating it if the practice has not seen them before.
   *
   * Idempotent: the same identity always resolves to the same row, because the chart id is derived
   * from the identity rather than allocated. Names are refreshed on a repeat visit (a corrected
   * spelling should propagate) but the identity — and therefore the id — cannot change; a genuinely
   * different name or date of birth is a different person by construction.
   *
   * `demographics` is merged FORWARD ONLY. A visit that supplies an address replaces what was on
   * file; a visit that supplies none leaves the existing one alone. It can never null a field.
   * That asymmetry is the whole point: check-in does not always collect an address, and a repeat
   * visit that quietly erased the one already on file would turn a filable claim into a blocked one
   * and give the front desk no clue why.
   */
  ensure(identity: PatientIdentity, demographics?: PatientDemographics): Promise<PatientRecord>;
  /**
   * Correct the address on file for a patient who is already known.
   *
   * ── WHY THIS IS SEPARATE FROM `ensure` ───────────────────────────────────────────────────────
   * `ensure` merges FORWARD ONLY: it can add an address or replace one, but silence never erases.
   * That is right for a check-in, where "no address typed" means "nobody asked", and it is exactly
   * wrong for a correction, where the person is deliberately restating what they know. Correcting a
   * transposed ZIP through `ensure` would work; clearing an address entered against the wrong
   * patient would not, and the front desk would have no way to undo it.
   *
   * So this is an explicit, authenticated act with its own route and its own permission, and it is
   * the only path that can set an address back to "not collected" — by passing `null`, which is a
   * statement ("this is wrong, remove it") rather than an absence.
   *
   * Returns null when no such patient exists in this practice. RLS makes another tenant's patient
   * indistinguishable from a missing one, which is the correct answer for a caller who must not
   * learn that it exists.
   */
  updateAddress(patientId: string, address: PatientAddress | null): Promise<PatientRecord | null>;
  findByChartId(chartId: string): Promise<PatientRecord | null>;
  /** By primary key — how the patient record screen is reached once a row is known. */
  findById(id: string): Promise<PatientRecord | null>;
  /**
   * Every patient, or those matching a free-text query over name and chart id.
   *
   * The query is a convenience for the directory screen, not a search engine: a practice this size
   * has hundreds of patients, not millions, and a `LIKE` over an already-indexed name ordering is
   * both sufficient and honest about what it does.
   */
  list(query?: string): Promise<PatientRecord[]>;

  /**
   * Every member ID this practice has on file for this patient.
   *
   * This is the half of the coverage mapping the patient record reads: `patientIdForMemberId` goes
   * one way (money → person, which is what the ledger needs at write time), this goes the other
   * (person → every account their money could be under). One human with a job change holds two, and
   * a record that showed only the current one would hide the balance under the old one.
   */
  memberIdsFor(patientId: string): Promise<string[]>;

  /**
   * Record that this member ID belongs to this patient.
   *
   * This is the mapping everything downstream resolves through: the money carries a member ID from
   * the coverage snapshot all the way to the payer's advice, and this is where that ID is tied back
   * to a person. `coverages` has carried (patient_id, member_id) since migration 0005 and was never
   * written; verification is where the two are first seen together, so this is where it belongs.
   *
   * ── IDEMPOTENT ON (practice, member ID, PATIENT) — AND THAT LAST TERM IS THE FIX (NEW-01) ──
   * It used to be idempotent on (practice, member ID) alone, and re-pointed the row when a member
   * ID reappeared for a different patient, on the reasoning that a plan reassigning an identifier
   * is a real-world event and refusing to save would be worse.
   *
   * The overwhelmingly more common real-world event is a FAMILY. A dental plan issues one member ID
   * to the subscriber and covers the spouse and children under it, so the second family member
   * verified did not add a coverage — it stole the first one. `patientIdForMemberId` then resolved
   * the whole family's money to whoever was verified most recently, and the row that said otherwise
   * had been overwritten in place.
   *
   * So a member ID may now belong to several patients, and each gets a row. Re-linking the SAME
   * patient still updates in place, which is what keeps a repeat visit idempotent.
   *
   * `payerKey` is Mermaid's payer SLUG (`VerificationRecord.payerId`), not the `payers` UUID. The
   * directory resolves it, because the column it lands in is a UUID foreign key and the caller has
   * no business knowing that. **An unresolvable or absent slug stores NULL** — see `coveragesFor`
   * for why that is load-bearing rather than merely tolerated (M14).
   */
  linkCoverage(
    patientId: string,
    memberId: string,
    payerKey?: string | null,
    holder?: CoverageHolder
  ): Promise<void>;

  /**
   * Every coverage this practice has on file for this patient, with the payer it belongs to.
   *
   * ── WHY THE PAYER HAD TO COME BACK WITH THE MEMBER ID (M14) ──────────────────────────────────
   * `memberIdsFor` answers "which accounts could this person's money be under". It cannot answer
   * the question that distinguishes a COLLISION from an ordinary insurance change, because both
   * look identical in member IDs alone:
   *
   *   • same name, same DOB, NEW member ID, DIFFERENT payer  → one person who changed jobs
   *   • same name, same DOB, NEW member ID, SAME payer       → probably two different people
   *
   * A detector built on member IDs alone fires on every insurance change — the common case — and a
   * warning that cries wolf on routine traffic is one staff learn to dismiss, which is worse than
   * no warning at all.
   *
   * `payerKey` is the payer SLUG, or **`null` when the practice's stored row names no payer it can
   * resolve**. Null is "unknown", never "matches anything": every coverage row written before M14
   * has a null `payer_id`, and treating those as a wildcard would flag every returning patient in
   * the existing data set.
   */
  coveragesFor(patientId: string): Promise<PatientCoverageLink[]>;

  /**
   * Which patient this member ID belongs to — or **null when the answer is not unique** (NEW-01).
   *
   * A member ID identifies a POLICY, not a person: a family shares the subscriber's. This used to
   * be `SELECT patient_id FROM coverages WHERE member_id = $1` read as a single row, which returned
   * an arbitrary family member with no indication that it had chosen. The patient ledger resolves
   * money through this call, so "arbitrary" meant a child's balance landing on their sibling.
   *
   * Null therefore means "no unique answer", covering both no coverage on file and several. Callers
   * that can tell the difference, or that can ask a human, use `patientIdsForMemberId`.
   */
  patientIdForMemberId(memberId: string): Promise<string | null>;

  /**
   * EVERY patient this member ID is on file for, ascending by id so two directories agree.
   *
   * The honest shape of the question. One element is the ordinary case; several is a family; none
   * is a member ID the practice has never verified.
   */
  patientIdsForMemberId(memberId: string): Promise<string[]>;
}

/** One member ID on file for a patient, and the payer it was verified against. */
export interface PatientCoverageLink {
  memberId: string;
  /** Mermaid's payer slug, or null when the stored row names no resolvable payer. */
  payerKey: string | null;
  /**
   * What this patient is to the policy. Always present, defaulting to `self`: every coverage
   * recorded before dependents were modelled was a patient treated as the subscriber, and `self` is
   * what that means. A caller reading this never has to decide what `undefined` implies.
   */
  relationship: SubscriberRelationship;
  /** Who holds the policy, when it is not this patient. Absent for `self`. */
  subscriber?: SubscriberIdentity;
}

/**
 * Who the coverage belongs to, beyond the member ID — supplied by whoever read the card.
 *
 * Optional in full: a caller that says nothing is describing a subscriber, which is the ordinary
 * case and the one every pre-existing call site means.
 */
export interface CoverageHolder {
  relationship?: SubscriberRelationship;
  /** Required when `relationship` is anything but `self`; an 837D must name the policy holder. */
  subscriber?: SubscriberIdentity | null;
}

/**
 * A correction was attempted with a partial address.
 *
 * Its own error type because the route turns it into a 400 with a usable message. Every component
 * is required together: an 837 carrying N3 without a complete N4 is malformed, so "street only" is
 * not a smaller correction, it is an invalid one.
 */
export class IncompletePatientAddressError extends Error {
  constructor() {
    super("A patient address needs street, city, state and ZIP together, or null to clear it.");
    this.name = "IncompletePatientAddressError";
  }
}

// The address is copied too, not shared. A shallow clone would hand every caller a reference into
// the store, and one caller mutating it would silently rewrite where a patient lives for everyone.
const clone = (p: PatientRecord): PatientRecord => ({ ...p, ...(p.address ? { address: { ...p.address } } : {}) });

/**
 * The one place an address is put into storage shape, shared by BOTH implementations.
 *
 * It lives here rather than in either repository because `repository-contract.test.ts` holds the two
 * to identical behaviour, and normalising in Postgres alone would make them disagree the moment a
 * ZIP arrived hyphenated — Postgres storing `900010000` while memory kept `90001-0000`. The contract
 * test is the reason this function exists in this file.
 *
 * Returns undefined for anything incomplete. A half address is not an address: an 837 with N3 and no
 * N4 is malformed, and a partially-filled record would satisfy the scrubber's missing-address rule
 * and then be rejected by the payer after filing, which is the expensive way to find out.
 */
export function normalizeAddress(address: PatientAddress | undefined): PatientAddress | undefined {
  if (!address) return undefined;
  const street = address.street?.trim();
  const city = address.city?.trim();
  const state = address.state?.trim().toUpperCase();
  // 5 or 9 digits with no separator is the shape an 837 carries; staff type it either way.
  const zip = address.zip?.trim().replace(/-/g, "");
  if (!street || !city || !state || !zip) return undefined;
  return { street, city, state, zip };
}

/** Case-insensitive substring match over the fields the directory screen searches. */
const matches = (patient: PatientRecord, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${patient.firstName} ${patient.lastName} ${patient.chartId}`.toLowerCase().includes(needle);
};

/**
 * The storage key for one person's coverage under one member ID. NUL-separated because neither a
 * member ID nor a UUID may contain it, so no pair of values can collide by concatenation.
 */
const coverageKey = (memberId: string, patientId: string): string => `${memberId} ${patientId}`;

/**
 * A subscriber name is stored only when it is complete. Half a name in loop 2010BA is a malformed
 * 837 rather than a smaller amount of information — the same rule the patient address follows.
 */
export function normalizeSubscriber(
  subscriber: SubscriberIdentity | null | undefined
): SubscriberIdentity | undefined {
  if (!subscriber) return undefined;
  const firstName = subscriber.firstName?.trim();
  const lastName = subscriber.lastName?.trim();
  if (!firstName || !lastName) return undefined;
  const dateOfBirth = subscriber.dateOfBirth?.slice(0, 10);
  return { firstName, lastName, ...(dateOfBirth ? { dateOfBirth } : {}) };
}

const toCoverageLink = (c: StoredCoverage): PatientCoverageLink => ({
  memberId: c.memberId,
  payerKey: c.payerKey,
  relationship: c.relationship,
  ...(c.subscriber ? { subscriber: { ...c.subscriber } } : {}),
});

interface StoredCoverage {
  memberId: string;
  patientId: string;
  payerKey: string | null;
  relationship: SubscriberRelationship;
  subscriber?: SubscriberIdentity;
}

export class InMemoryPatientDirectory implements PatientDirectory {
  #byChartId = new Map<string, PatientRecord>();
  /**
   * Keyed on `memberId patientId`, not on `memberId` (NEW-01).
   *
   * The single-key map WAS the merge bug in miniature: `set(memberId, …)` re-pointed a family's one
   * entry at whoever was verified last, exactly as `ON CONFLICT (practice_id, member_id) DO UPDATE`
   * did in Postgres. Both directories are held to identical behaviour by
   * `repository-contract.test.ts`, so the double had to gain the same second term.
   */
  #coverages = new Map<string, StoredCoverage>();

  async linkCoverage(
    patientId: string,
    memberId: string,
    payerKey?: string | null,
    holder?: CoverageHolder
  ): Promise<void> {
    const key = memberId.trim();
    if (!key) return;
    // Trimmed to null rather than stored as "": an empty payer is an unknown one, and the twin in
    // Postgres cannot resolve `''` to a row either. Both directories must agree on that.
    //
    // BY DESIGN, NOT A BUG: an UNRESOLVABLE slug diverges here. Postgres nulls it (its subselect
    // finds no `payers` row); this echoes it verbatim, because a double with no payer table cannot
    // know which slugs exist. Postgres is the behaviour that governs — see the Postgres-only test
    // "a payer slug with no row in `payers` is stored as unknown, not as itself".
    const payer = payerKey?.trim() || null;
    const existing = this.#coverages.get(coverageKey(key, patientId));
    // Forward-only on the payer — the in-memory twin of Postgres's
    // `COALESCE(EXCLUDED.payer_id, coverages.payer_id)`. A later visit that could not name the payer
    // must not erase what an earlier one established, or the collision detector would go blind on
    // exactly the second visit it exists to examine. Same rule as the patient address (V2).
    //
    // Written as an explicit `??` and not a spread: this asymmetry is load-bearing and was caught
    // diverging by `repository-contract.test.ts` before it ever reached a screen.
    //
    // The relationship and the subscriber follow the SAME rule, and for the same reason: a repeat
    // visit that did not re-read the card must not demote a known dependent back to `self`, which
    // would put the wrong name in loop 2010BA of the next claim.
    const relationship = holder?.relationship ?? existing?.relationship ?? "self";
    const subscriber = normalizeSubscriber(holder?.subscriber) ?? existing?.subscriber;
    this.#coverages.set(coverageKey(key, patientId), {
      memberId: key,
      patientId,
      payerKey: payer ?? existing?.payerKey ?? null,
      relationship,
      ...(relationship !== "self" && subscriber ? { subscriber } : {}),
    });
  }

  async coveragesFor(patientId: string): Promise<PatientCoverageLink[]> {
    return [...this.#coverages.values()]
      .filter((link) => link.patientId === patientId)
      .map(toCoverageLink)
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
  }

  async patientIdForMemberId(memberId: string): Promise<string | null> {
    const found = await this.patientIdsForMemberId(memberId);
    // Exactly one, or nothing. Several is a family, and picking one of them is how a child's
    // balance ends up on their sibling.
    return found.length === 1 ? found[0]! : null;
  }

  async patientIdsForMemberId(memberId: string): Promise<string[]> {
    const key = memberId.trim();
    return [...this.#coverages.values()]
      .filter((link) => link.memberId === key)
      .map((link) => link.patientId)
      .sort();
  }

  async ensure(identity: PatientIdentity, demographics?: PatientDemographics): Promise<PatientRecord> {
    const chartId = deriveChartId(identity);
    const existing = this.#byChartId.get(chartId);
    // Forward-only merge — the in-memory twin of Postgres's COALESCE(EXCLUDED.x, patients.x).
    // `?? existing` and NOT a spread: a demographics object present but with an undefined address
    // must still preserve what is on file. An INCOMPLETE incoming address normalises to undefined
    // and therefore preserves too, rather than half-overwriting a good one.
    const address = normalizeAddress(demographics?.address) ?? existing?.address;
    const gender = demographics?.gender ?? existing?.gender;
    const record: PatientRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      chartId,
      firstName: identity.firstName.trim(),
      lastName: identity.lastName.trim(),
      dateOfBirth: identity.dateOfBirth.slice(0, 10),
      ...(address ? { address: { ...address } } : {}),
      ...(gender ? { gender } : {}),
    };
    this.#byChartId.set(chartId, record);
    return clone(record);
  }

  async updateAddress(patientId: string, address: PatientAddress | null): Promise<PatientRecord | null> {
    const found = [...this.#byChartId.values()].find((p) => p.id === patientId);
    if (!found) return null;
    // A deliberate correction, so `null` CLEARS — unlike `ensure`, where absence preserves.
    const normalized = address === null ? undefined : normalizeAddress(address);
    // A half address is REFUSED LOUDLY rather than dropped. Silently keeping the old value would
    // tell the person at the desk their correction was saved when it was not, and they would go on
    // believing the claim is unblocked.
    if (address !== null && !normalized) throw new IncompletePatientAddressError();
    const updated: PatientRecord = { ...found, ...(normalized ? { address: normalized } : {}) };
    if (!normalized) delete updated.address;
    this.#byChartId.set(found.chartId, updated);
    return clone(updated);
  }

  async findByChartId(chartId: string): Promise<PatientRecord | null> {
    const found = this.#byChartId.get(chartId);
    return found ? clone(found) : null;
  }

  async findById(id: string): Promise<PatientRecord | null> {
    const found = [...this.#byChartId.values()].find((p) => p.id === id);
    return found ? clone(found) : null;
  }

  async list(query?: string): Promise<PatientRecord[]> {
    return [...this.#byChartId.values()]
      .filter((p) => (query ? matches(p, query) : true))
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
      .map(clone);
  }

  async memberIdsFor(patientId: string): Promise<string[]> {
    // `.values()`, and `link.memberId` — NOT the map key. The key gained a patient-id term when a
    // family stopped sharing one entry (see `#coverages`), and reading it as a member ID handed the
    // patient record `"ABC12345 <uuid>"` as an account to look money up under.
    return [...this.#coverages.values()]
      .filter((link) => link.patientId === patientId)
      .map((link) => link.memberId)
      .sort();
  }

  get size(): number {
    return this.#byChartId.size;
  }
}
