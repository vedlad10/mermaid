/**
 * Postgres ledger repository.
 *
 * Unlike every other module here, this one does NOT store a JSONB aggregate. A ledger entry is not
 * an aggregate — it is a row that is written once and never updated, and the questions asked of it
 * ("everything for this patient", "every account with a balance") are relational. Columns also make
 * the two things that matter enforceable by the database rather than by convention: the UNIQUE index
 * on `source_ref` (no patient is ever charged twice for one event) and the CHECK that a charge is
 * positive and every other kind negative (no entry can silently flip the sign of a balance).
 */
import { iso, many, one, practiceId, tx } from "@mermaid/db";
import type { Cents } from "@mermaid/shared";
import type { LedgerEntry, EntryKind } from "./types.ts";
import type { LedgerFilter, LedgerRepository } from "./repository.ts";

interface Row {
  id: string;
  patient_key: string;
  patient_name: string;
  kind: string;
  amount_cents: number;
  occurred_at: Date | string;
  description: string;
  claim_id: string | null;
  denial_id: string | null;
  source_ref: string | null;
  recorded_by: string;
  patient_id: string | null;
}

const toEntry = (row: Row): LedgerEntry => ({
  id: row.id,
  patientKey: row.patient_key,
  patientName: row.patient_name,
  kind: row.kind as EntryKind,
  amount: row.amount_cents as Cents,
  occurredAt: iso(row.occurred_at),
  description: row.description,
  claimId: row.claim_id,
  denialId: row.denial_id,
  sourceRef: row.source_ref,
  patientId: row.patient_id,
  recordedBy: row.recorded_by,
});

const COLUMNS = `id, patient_key, patient_name, kind, amount_cents, occurred_at,
                 description, claim_id, denial_id, source_ref, recorded_by, patient_id`;

export class PgLedgerRepository implements LedgerRepository {
  async append(entry: LedgerEntry): Promise<boolean> {
    const row = await one<{ id: string }>(
      tx(),
      `INSERT INTO ledger_entries
         (id, practice_id, patient_key, patient_name, kind, amount_cents, occurred_at,
          description, claim_id, denial_id, source_ref, recorded_by, patient_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       -- The WHERE clause is NOT optional: idx_ledger_source is a PARTIAL unique index, and Postgres
       -- will not accept it as a conflict arbiter unless the inference predicate matches its own
       -- ("there is no unique or exclusion constraint matching the ON CONFLICT specification").
       -- A human entry has no source_ref, falls outside the index, and therefore always inserts —
       -- which is the intent: a second payment from the same patient is a second payment.
       ON CONFLICT (practice_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        entry.id,
        practiceId(),
        entry.patientKey,
        entry.patientName,
        entry.kind,
        entry.amount,
        entry.occurredAt,
        entry.description,
        entry.claimId,
        entry.denialId,
        entry.sourceRef,
        entry.recordedBy,
        entry.patientId,
      ]
    );
    // No row means the conflict fired: this event had already produced a charge. Note the partial
    // index — a human entry (source_ref NULL) never conflicts, because a second payment from the
    // same patient is a second payment, not a redelivery.
    return row !== undefined;
  }

  async entriesFor(patientKey: string): Promise<LedgerEntry[]> {
    const rows = await many<Row>(
      tx(),
      `SELECT ${COLUMNS} FROM ledger_entries WHERE patient_key = $1 ORDER BY occurred_at, id`,
      [patientKey]
    );
    return rows.map(toEntry);
  }

  /**
   * Serialise concurrent money movements against one account (M16).
   *
   * A transaction-scoped ADVISORY lock keyed on (practice, patient), not `FOR UPDATE` on the
   * account's rows. The row-lock version had a hole its own comment waved away: locking zero rows
   * locks nothing, so the one read-then-write it could not protect was the account's FIRST charge —
   * two concurrent postings for a brand-new account each saw an empty ledger, each computed the full
   * delta, and the patient was charged twice. `#humanEntry` was defended by its no-entries refusal;
   * `chargeFromPosting`'s delta arithmetic is not, and a double-charged patient is the one failure
   * in this module that leaves the building.
   *
   * The advisory lock exists whether or not any row does, is released at COMMIT/ROLLBACK like the
   * row lock was, and is scoped to the practice by keying on it — one practice cannot contend with
   * another's accounts, let alone lock them.
   */
  async lockPatient(patientKey: string): Promise<void> {
    await many<{ locked: unknown }>(
      tx(),
      `SELECT pg_advisory_xact_lock(hashtextextended('ledger:' || $1 || ':' || $2, 0)) AS locked`,
      [practiceId(), patientKey]
    );
  }

  async list(filter?: LedgerFilter): Promise<LedgerEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.patientKey) {
      params.push(filter.patientKey);
      where.push(`patient_key = $${params.length}`);
    }
    if (filter?.patient) {
      // The SQL twin of `inPatientScope`. Two indexed paths, ORed: `idx_ledger_patient_id`
      // (migration 0016) for entries the patient master resolved, and `idx_ledger_patient` from 0013
      // for every account key this person is known by — including keys that never resolved, whose
      // money is still theirs and must not vanish from a unified balance.
      //
      // `patient_id IS NULL` on the key arm is what keeps "keys that never resolved" to exactly
      // that. A member ID is a policy, not a person, so without the guard the arm also claims
      // entries that DO name a patient — and a family sharing one subscriber id would read each
      // other's balances.
      params.push(filter.patient.patientId);
      const byPatient = `patient_id = $${params.length}`;
      params.push(filter.patient.patientKeys);
      where.push(`(${byPatient} OR (patient_id IS NULL AND patient_key = ANY($${params.length}::text[])))`);
    }
    if (filter?.withBalanceOnly) {
      /**
       * Answered in SQL so a practice with years of settled accounts does not read all of them to
       * display the handful that still owe something.
       *
       * Grouped on the SAME expression the service groups rows by (F-4). It used to group on
       * `patient_key` alone, which is the policy — so once rows became per-person, a patient with a
       * settled balance inside a family that still owed money would have been pulled into the owing
       * list, and one who owed money inside a family that netted to zero would have vanished from
       * it. The two groupings have to be the same expression or the filter and the display disagree.
       */
      where.push(
        `coalesce('id:' || patient_id::text, 'key:' || patient_key) IN (
           SELECT coalesce('id:' || patient_id::text, 'key:' || patient_key)
             FROM ledger_entries GROUP BY 1 HAVING sum(amount_cents) <> 0)`
      );
    }
    const rows = await many<Row>(
      tx(),
      `SELECT ${COLUMNS} FROM ledger_entries${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY patient_key, occurred_at, id`,
      params
    );
    return rows.map(toEntry);
  }
}
