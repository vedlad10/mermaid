/**
 * Postgres patient master.
 *
 * The upsert arbitrates on `(practice_id, chart_id)` — the unique constraint migration 0005 already
 * declared. Nothing new was needed to make identity resolution work, because the chart id is derived
 * from the identity rather than allocated (see `engine/identity.ts`): the constraint that was there
 * for a PMS-supplied id serves a derived one identically.
 *
 * `practice_id` comes from the ambient transaction, never from the caller — the same rule every
 * repository here follows, and the one RLS enforces underneath regardless.
 */
import { execute, many, one, practiceId, tx } from "@mermaid/db";
import type { SubscriberIdentity, SubscriberRelationship } from "@mermaid/shared";
import { deriveChartId, type PatientIdentity } from "./engine/identity.ts";
import { IncompletePatientAddressError, normalizeAddress, normalizeSubscriber } from "./patients.ts";
import type {
  CoverageHolder,
  PatientCoverageLink,
  PatientDemographics,
  PatientDirectory,
  PatientRecord,
} from "./patients.ts";
import type { PatientAddress } from "./types.ts";

interface CoverageRow {
  member_id: string;
  edi_payer_id: string | null;
  relationship_to_subscriber: string;
  subscriber_first_name: string | null;
  subscriber_last_name: string | null;
  subscriber_dob: string | null;
}

/**
 * Storage shape to contract shape. The relationship column is NOT NULL with a CHECK, so the cast is
 * safe; it is written out rather than inferred so the compiler notices if the column ever widens.
 */
function toCoverageLink(r: CoverageRow): PatientCoverageLink {
  const relationship = r.relationship_to_subscriber as SubscriberRelationship;
  const subscriber: SubscriberIdentity | undefined =
    r.subscriber_first_name && r.subscriber_last_name
      ? {
          firstName: r.subscriber_first_name,
          lastName: r.subscriber_last_name,
          ...(r.subscriber_dob ? { dateOfBirth: r.subscriber_dob } : {}),
        }
      : undefined;
  return {
    memberId: r.member_id,
    payerKey: r.edi_payer_id || null,
    relationship,
    ...(relationship !== "self" && subscriber ? { subscriber } : {}),
  };
}

interface Row {
  id: string;
  chart_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  gender: string | null;
}

/**
 * An address is all-or-nothing.
 *
 * Migration 0017 made every column independently nullable so a partially-known person is still
 * storable, but a HALF address is not an address: an 837 carrying N3 with no N4 is malformed, and a
 * claim built from `{street, city, state: undefined}` would be worse than one built from nothing —
 * the scrubber's missing-address rule would pass and the payer would reject after filing. So a row
 * missing any component reads back as "not collected", which is what the scrubber correctly blocks.
 */
const toAddress = (row: Row): PatientRecord["address"] => {
  const { address_street: street, address_city: city, address_state: state, address_zip: zip } = row;
  if (!street || !city || !state || !zip) return undefined;
  return { street, city, state, zip };
};

const toPatient = (row: Row): PatientRecord => {
  const address = toAddress(row);
  const gender = row.gender;
  return {
    id: row.id,
    chartId: row.chart_id,
    firstName: row.first_name,
    lastName: row.last_name,
    // `dob` is a DATE; the pool's type parser hands dates back as the plain YYYY-MM-DD string already.
    dateOfBirth: String(row.dob).slice(0, 10),
    ...(address ? { address } : {}),
    // The CHECK constraint already restricts this to M/F/U, so the narrowing is a type-level
    // formality rather than a validation — but it is asserted, not cast, so a column that somehow
    // held something else reads back as "not collected" instead of reaching an 837 as a bad DMG03.
    ...(gender === "M" || gender === "F" || gender === "U" ? { gender } : {}),
  };
};

export class PgPatientDirectory implements PatientDirectory {
  async ensure(identity: PatientIdentity, demographics?: PatientDemographics): Promise<PatientRecord> {
    const chartId = deriveChartId(identity);
    // Shared with the in-memory directory so the two cannot drift; see `normalizeAddress`.
    const address = normalizeAddress(demographics?.address);
    const row = await one<Row>(
      tx(),
      `INSERT INTO patients
         (practice_id, chart_id, first_name, last_name, dob,
          address_street, address_city, address_state, address_zip, gender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (practice_id, chart_id) DO UPDATE
         -- Refresh the spelling but never the identity: chart_id is derived from name and date of
         -- birth, so a row that conflicts is by construction the same person. A corrected spelling
         -- should propagate; a different person cannot arrive down this path.
         SET first_name = EXCLUDED.first_name,
             last_name  = EXCLUDED.last_name,
             -- FORWARD ONLY. A visit that collected an address overwrites what was on file; a visit
             -- that collected none leaves it standing. COALESCE in this order is what makes that
             -- true, and the argument order is the whole behaviour — reversed, a repeat visit could
             -- never correct an address; omitted, every visit without one would erase it and turn a
             -- filable claim into a blocked claim with no visible cause.
             address_street = COALESCE(EXCLUDED.address_street, patients.address_street),
             address_city   = COALESCE(EXCLUDED.address_city,   patients.address_city),
             address_state  = COALESCE(EXCLUDED.address_state,  patients.address_state),
             address_zip    = COALESCE(EXCLUDED.address_zip,    patients.address_zip),
             gender         = COALESCE(EXCLUDED.gender,         patients.gender)
       RETURNING *`,
      [
        practiceId(),
        chartId,
        identity.firstName.trim(),
        identity.lastName.trim(),
        identity.dateOfBirth.slice(0, 10),
        // Already normalised and complete-or-undefined, so these five are all-NULL or all-present —
        // which is what keeps the COALESCE from stitching a new street onto an old city.
        address?.street ?? null,
        address?.city ?? null,
        address?.state ?? null,
        address?.zip ?? null,
        demographics?.gender ?? null,
      ]
    );
    return toPatient(row!);
  }

  async updateAddress(patientId: string, address: PatientAddress | null): Promise<PatientRecord | null> {
    const normalized = address === null ? undefined : normalizeAddress(address);
    // Refused loudly, not dropped — see `IncompletePatientAddressError`. A correction that silently
    // did nothing would leave the desk believing the claim is unblocked.
    if (address !== null && !normalized) throw new IncompletePatientAddressError();

    /**
     * A plain UPDATE, not an upsert. This corrects a patient the practice already has; if the id
     * does not resolve, that is a caller error and must surface as "no such patient" rather than
     * quietly creating a row with an address and no name.
     *
     * No practice predicate: RLS supplies it, so another tenant's patient simply does not match and
     * the caller learns nothing about its existence. `updated_at` moves via the table's trigger.
     *
     * Unlike `ensure`, these are assigned directly rather than COALESCEd. That asymmetry IS the
     * feature: check-in silence must preserve, a deliberate correction must be able to clear.
     */
    const row = await one<Row>(
      tx(),
      `UPDATE patients
          SET address_street = $2,
              address_city   = $3,
              address_state  = $4,
              address_zip    = $5
        WHERE id = $1
        RETURNING *`,
      [patientId, normalized?.street ?? null, normalized?.city ?? null, normalized?.state ?? null, normalized?.zip ?? null]
    );
    return row ? toPatient(row) : null;
  }

  /**
   * ── `coverages.cob_order` IS NOT WRITTEN HERE, AND THAT IS DELIBERATE ──────────────────────────
   *
   * Migration 0005 declares `cob_order SMALLINT NOT NULL DEFAULT 1 CHECK (cob_order BETWEEN 1 AND 3)`
   * and nothing in the codebase has ever written or read it. Every row in every deployment therefore
   * holds `1`, which is indistinguishable from a considered statement that this policy is primary.
   *
   * So it must never be treated as one. Coordination of benefits decides which plan pays first, and
   * that order is a property of a person on a date — it changes with a job, a divorce, or a child
   * ageing off — not a property of the policy row this writes. Deriving it would also mean guessing
   * rules (the birthday rule, subscriber-over-dependent, active-over-COBRA) that a court order can
   * override and that this system holds no data to evaluate.
   *
   * The approved design keeps the column as a SUGGESTION a human confirms, with the sequence actually
   * filed recorded on the claim. Until that lands, the honest state is: unwritten, unread, and safe
   * only because nothing consults it. Recorded here because this is the function a reader will open
   * when they wonder why the column is empty.
   */
  async linkCoverage(
    patientId: string,
    memberId: string,
    payerKey?: string | null,
    holder?: CoverageHolder
  ): Promise<void> {
    const key = memberId.trim();
    if (!key) return;
    const payer = payerKey?.trim() || null;
    const subscriber = normalizeSubscriber(holder?.subscriber);
    const relationship = holder?.relationship ?? null;
    await execute(
      tx(),
      /**
       * `payer_id` is resolved from the SLUG in the statement itself, through the SAME predicate
       * `PgPlaybookRepository.findPayer` uses (`WHERE edi_payer_id = $1`). Deliberately not a second
       * lookup mechanism and not a cross-module call: `payers` is a shared reference table with no
       * `practice_id` and no RLS, so it reads correctly inside this practice-scoped transaction, and
       * the resolution stays in the repository that owns the column.
       *
       * An unknown or absent slug yields NULL from the subselect, so the row still writes. That is
       * the point: a coverage the practice genuinely holds must never fail to record because
       * Mermaid does not have the payer catalogued. Null means "unknown payer" everywhere it is
       * read — never "matches every payer" (M14).
       */
      `INSERT INTO coverages (
         practice_id, patient_id, member_id, payer_id,
         relationship_to_subscriber, subscriber_first_name, subscriber_last_name, subscriber_dob
       )
       VALUES ($1,$2,$3, (SELECT id FROM payers WHERE edi_payer_id = $4),
               COALESCE($5, 'self'), $6, $7, $8)
       -- ── THE ARBITER GAINED A THIRD TERM, AND THAT IS THE FIX (NEW-01) ──────────────────────
       -- This was ON CONFLICT (practice_id, member_id) DO UPDATE SET patient_id = EXCLUDED...,
       -- on the reasoning that a plan reassigning an identifier should re-point the mapping rather
       -- than fail. What it actually did, on every family, was let the second child verified STEAL
       -- the first child's coverage row — and with it every ledger entry that resolved through it.
       --
       -- A dental plan issues ONE member id to the subscriber and covers dependents under it, so
       -- the row belongs to (member id, PERSON). Re-linking the same person still updates in place,
       -- which is what keeps a repeat visit idempotent.
       --
       -- payer_id moves forward only when this visit RESOLVED one. A later visit that could not
       -- name the payer must not erase what an earlier visit established, which is the same
       -- forward-only rule the patient address already follows (V2). The relationship and the
       -- subscriber name follow it too: a repeat visit that did not re-read the card must not
       -- demote a known dependent back to self and put the wrong name in loop 2010BA.
       ON CONFLICT (practice_id, member_id, patient_id) DO UPDATE
         SET payer_id                   = COALESCE(EXCLUDED.payer_id, coverages.payer_id),
             relationship_to_subscriber = COALESCE($5, coverages.relationship_to_subscriber),
             subscriber_first_name      = COALESCE(EXCLUDED.subscriber_first_name, coverages.subscriber_first_name),
             subscriber_last_name       = COALESCE(EXCLUDED.subscriber_last_name, coverages.subscriber_last_name),
             subscriber_dob             = COALESCE(EXCLUDED.subscriber_dob, coverages.subscriber_dob)`,
      [
        practiceId(),
        patientId,
        key,
        payer,
        relationship,
        subscriber?.firstName ?? null,
        subscriber?.lastName ?? null,
        subscriber?.dateOfBirth ?? null,
      ]
    );
  }

  async coveragesFor(patientId: string): Promise<PatientCoverageLink[]> {
    // LEFT JOIN, not JOIN: a row whose `payer_id` is null — every row written before M14 — must
    // still come back, carrying `payerKey: null`. An inner join would hide exactly the rows the
    // null-handling rule exists for, and the detector would never see them to refuse them.
    const rows = await many<CoverageRow>(
      tx(),
      `SELECT c.member_id,
              p.edi_payer_id,
              c.relationship_to_subscriber,
              c.subscriber_first_name,
              c.subscriber_last_name,
              to_char(c.subscriber_dob, 'YYYY-MM-DD') AS subscriber_dob
         FROM coverages c
         LEFT JOIN payers p ON p.id = c.payer_id
        WHERE c.patient_id = $1
        ORDER BY c.member_id`,
      [patientId]
    );
    return rows.map(toCoverageLink);
  }

  async patientIdForMemberId(memberId: string): Promise<string | null> {
    const found = await this.patientIdsForMemberId(memberId);
    // Exactly one, or nothing. The single-row read this replaces returned an arbitrary family
    // member and gave the caller no way to know it had chosen — which is how a child's balance
    // lands on their sibling.
    return found.length === 1 ? found[0]! : null;
  }

  async patientIdsForMemberId(memberId: string): Promise<string[]> {
    const rows = await many<{ patient_id: string }>(
      tx(),
      "SELECT patient_id FROM coverages WHERE member_id = $1 ORDER BY patient_id",
      [memberId.trim()]
    );
    return rows.map((r) => r.patient_id);
  }

  async findByChartId(chartId: string): Promise<PatientRecord | null> {
    const row = await one<Row>(tx(), "SELECT * FROM patients WHERE chart_id = $1", [chartId]);
    return row ? toPatient(row) : null;
  }

  async findById(id: string): Promise<PatientRecord | null> {
    // No practice predicate: RLS supplies it, and a row from another tenant is invisible rather than
    // forbidden — which is the correct answer for a caller who must not learn that it exists.
    const row = await one<Row>(tx(), "SELECT * FROM patients WHERE id = $1", [id]);
    return row ? toPatient(row) : null;
  }

  async list(query?: string): Promise<PatientRecord[]> {
    const needle = query?.trim();
    if (!needle) {
      return (await many<Row>(tx(), "SELECT * FROM patients ORDER BY last_name, first_name")).map(toPatient);
    }
    // Parameterised, and the wildcards are added here rather than accepted from the caller so a
    // query of "%" cannot turn a search into a full scan dressed up as one.
    const rows = await many<Row>(
      tx(),
      `SELECT * FROM patients
        WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR chart_id ILIKE $1
        ORDER BY last_name, first_name`,
      [`%${needle.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]
    );
    return rows.map(toPatient);
  }

  async memberIdsFor(patientId: string): Promise<string[]> {
    const rows = await many<{ member_id: string }>(
      tx(),
      "SELECT member_id FROM coverages WHERE patient_id = $1 ORDER BY member_id",
      [patientId]
    );
    return rows.map((r) => r.member_id);
  }
}
