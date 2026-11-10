/**
 * Who the patient is to the policy — the vocabulary shared by verification, claims and the EDI
 * codec (NEW-01).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * Every layer of this system assumed the patient WAS the subscriber. `PatientInfo` carried one
 * member id and one name; the 837D builder hardcoded SBR02 to "18" (self); and `coverages` held
 * `UNIQUE (practice_id, member_id)` — one member id, one person.
 *
 * In dental that assumption is wrong for most families. A plan issues ONE member id to the
 * subscriber, and the spouse and children are all verified under it. With the unique constraint as
 * it stood, verifying a second family member did not add a coverage — `ON CONFLICT … DO UPDATE SET
 * patient_id = EXCLUDED.patient_id` re-pointed the existing row at the new patient. From that
 * moment every ledger entry, every balance and every payment for the WHOLE FAMILY resolved to
 * whichever child was verified most recently. Two people's money became one person's.
 *
 * So the relationship has to be a first-class fact, carried from the card the front desk reads all
 * the way to the wire.
 *
 * ── THE CODES ────────────────────────────────────────────────────────────────────────────────────
 * These are X12 Individual Relationship Codes (data element 1069). Only the four that a dental
 * practice actually encounters are modelled; the rest of the code list exists but naming a
 * relationship the front desk cannot distinguish would be a false precision.
 */

/** The patient's relationship to the person who holds the policy. */
export type SubscriberRelationship = "self" | "spouse" | "child" | "other";

/**
 * X12 data element 1069, Individual Relationship Code.
 *
 * `18` self · `01` spouse · `19` child · `G8` other relationship.
 */
export const X12_RELATIONSHIP_CODE: Record<SubscriberRelationship, string> = {
  self: "18",
  spouse: "01",
  child: "19",
  other: "G8",
};

/**
 * The person who holds the policy, when that is not the patient.
 *
 * Name and date of birth only. The MEMBER ID is not here on purpose: the subscriber's member id is
 * the policy's member id, which the patient already carries — that is precisely why a family shares
 * one and why the old unique constraint merged them. Storing it twice would create two places for
 * it to disagree.
 *
 * `dateOfBirth` is optional because a card names the subscriber but rarely dates them, and a
 * verification must not be refused for want of a field the payer does not require in 2010BA.
 */
export interface SubscriberIdentity {
  firstName: string;
  lastName: string;
  /** ISO date, when the practice has it. */
  dateOfBirth?: string;
}

/**
 * True when this patient is the subscriber — the ordinary case, and the one every default takes.
 *
 * Absent means self. That is what makes the whole change backward-compatible: every verification,
 * event and claim written before dependents existed reads as a subscriber, which is what it was.
 */
export function isSubscriber(relationship: SubscriberRelationship | undefined): boolean {
  return (relationship ?? "self") === "self";
}
