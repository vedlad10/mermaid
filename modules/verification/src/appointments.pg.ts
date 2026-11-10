/**
 * Postgres implementation of `AppointmentRepository` (migration 0035).
 *
 * The aggregate is one versioned JSONB document; `scheduled_for` and `status` are extracted on write
 * so the window query is an index range scan. Every method runs in the ambient transaction opened
 * by `withPractice`, and rows are written with the practice from that context, never from the
 * aggregate — RLS refuses anything else.
 *
 * No PHI encryption here, deliberately: nothing in this document is a raw artifact from outside.
 * The patient is a foreign key to `patients`, and the visit's time, provider and planned codes are
 * the same kind of structured fact `claims` stores in the clear.
 */
import { execute, fromDocument, many, one, practiceId, toDocument, tx } from "@mermaid/db";
import type { Appointment, AppointmentRepository, AppointmentSource } from "./appointments.ts";

/** Schema version of the persisted appointment document. Bump + add an upcaster on any shape change. */
export const APPOINTMENT_RECORD_VERSION = 1;
const UPCASTERS = {};

interface Row {
  record: unknown;
}

const toAppointment = (row: Row): Appointment =>
  fromDocument<Appointment>(row.record, APPOINTMENT_RECORD_VERSION, UPCASTERS);

export class PgAppointmentRepository implements AppointmentRepository {
  async getById(id: string): Promise<Appointment | null> {
    const row = await one<Row>(tx(), "SELECT record FROM appointments WHERE id = $1", [id]);
    return row ? toAppointment(row) : null;
  }

  async insertIfAbsent(a: Appointment): Promise<boolean> {
    // ON CONFLICT DO NOTHING rather than a savepoint: a re-imported visit is ordinary, and the
    // transaction must stay usable for the caller to lock the existing row and update it.
    const rows = await many(
      tx(),
      `INSERT INTO appointments
         (id, practice_id, patient_id, source, external_id, scheduled_for, status, record, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (practice_id, source, external_id) DO NOTHING
       RETURNING id`,
      [
        a.id,
        practiceId(),
        a.patientId,
        a.source,
        a.externalId,
        a.scheduledFor,
        a.status,
        toDocument(a, APPOINTMENT_RECORD_VERSION),
        a.createdAt,
        a.updatedAt,
      ]
    );
    return rows.length > 0;
  }

  async lockByExternalId(source: AppointmentSource, externalId: string): Promise<Appointment | null> {
    const row = await one<Row>(
      tx(),
      "SELECT record FROM appointments WHERE source = $1 AND external_id = $2 FOR UPDATE",
      [source, externalId]
    );
    return row ? toAppointment(row) : null;
  }

  async update(a: Appointment): Promise<Appointment> {
    await execute(
      tx(),
      `UPDATE appointments
          SET patient_id = $2, scheduled_for = $3, status = $4, record = $5
        WHERE id = $1`,
      [a.id, a.patientId, a.scheduledFor, a.status, toDocument(a, APPOINTMENT_RECORD_VERSION)]
    );
    return a;
  }

  async listBetween(from: string, to: string): Promise<Appointment[]> {
    const rows = await many<Row>(
      tx(),
      `SELECT record FROM appointments
        WHERE scheduled_for >= $1 AND scheduled_for < $2
        ORDER BY scheduled_for, id`,
      [from, to]
    );
    return rows.map(toAppointment);
  }
}
