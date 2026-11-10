/**
 * The schedule — the persistence seam for `appointments` (migration 0035).
 *
 * Verification owns it for the same reason it owns `patients`: an appointment is where the
 * front-half workflow starts (Appointment → Verification → Estimate), and the question every schedule
 * surface asks of it — "is this visit's coverage ready?" — is a verification question.
 *
 * ── WHERE APPOINTMENTS COME FROM ──────────────────────────────────────────────────────────────────
 * Mermaid does not book visits; the practice-management system does. Every source — a CSV export
 * today, an API later — produces the same normalised `ScheduledVisit`, and `AppointmentService.sync`
 * is the one door they come through. A source's own appointment id is the identity, so importing
 * the same export twice changes nothing.
 *
 * Two implementations behind one interface, like every other repository here.
 */
import type { PatientIdentity } from "./engine/identity.ts";

export type AppointmentSource = "mock" | "csv";
export const APPOINTMENT_SOURCES: readonly AppointmentSource[] = ["mock", "csv"];

export type AppointmentStatus = "scheduled" | "completed" | "cancelled" | "no-show";
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ["scheduled", "completed", "cancelled", "no-show"];

/**
 * A procedure the practice plans to perform at the visit, as the SOURCE stated it.
 *
 * `feeCents` is null when the source did not say. It is never looked up or estimated here: a
 * schedule's production figure is the practice's own number, and one Mermaid filled in would be
 * read as theirs.
 */
export interface PlannedProcedure {
  code: string;
  feeCents: number | null;
}

/** One visit as a source describes it — the contract every schedule source produces. */
export interface ScheduledVisit {
  /** The source system's own appointment id. The identity of the visit, not a hint. */
  externalId: string;
  /**
   * An INSTANT, with its offset (`2026-10-01T09:30:00-05:00` or `…Z`).
   *
   * A bare local time is refused rather than read as UTC: "9:30" is a different moment in every
   * practice, and a visit filed five hours early is shown on the wrong day. Converting a source's
   * local clock using the practice's time zone is the source adapter's job.
   */
  scheduledFor: string;
  durationMinutes?: number | null;
  provider?: string | null;
  status: AppointmentStatus;
  patient: PatientIdentity;
  plannedProcedures?: PlannedProcedure[];
  /**
   * The visit's total scheduled production AS THE SOURCE STATED IT, in cents — what most exports
   * give instead of a fee per procedure. Kept as the practice's own number, never split across codes.
   */
  statedProductionCents?: number | null;
}

export interface Appointment {
  id: string;
  source: AppointmentSource;
  externalId: string;
  patientId: string;
  scheduledFor: string;
  durationMinutes: number | null;
  provider: string | null;
  status: AppointmentStatus;
  plannedProcedures: PlannedProcedure[];
  /**
   * See `ScheduledVisit.statedProductionCents`. OPTIONAL on read: documents written before stage 4
   * do not carry it, and absent means the source stated no total — the same as null.
   */
  statedProductionCents?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppointmentRepository {
  getById(id: string): Promise<Appointment | null>;
  /**
   * Insert unless this source has already sent this appointment. Returns whether it inserted.
   *
   * Losing the race to `appointments_one_per_source_id` is ordinary — two imports of the same export
   * — so it must leave the transaction usable for the caller to re-read and update.
   */
  insertIfAbsent(appointment: Appointment): Promise<boolean>;
  lockByExternalId(source: AppointmentSource, externalId: string): Promise<Appointment | null>;
  update(appointment: Appointment): Promise<Appointment>;
  /** Every appointment with `from <= scheduledFor < to`, soonest first. */
  listBetween(from: string, to: string): Promise<Appointment[]>;
}

const key = (source: AppointmentSource, externalId: string): string => `${source}\u0000${externalId}`;

export class InMemoryAppointmentRepository implements AppointmentRepository {
  #rows = new Map<string, Appointment>();

  async getById(id: string): Promise<Appointment | null> {
    const found = [...this.#rows.values()].find((a) => a.id === id);
    return found ? structuredClone(found) : null;
  }
  async insertIfAbsent(appointment: Appointment): Promise<boolean> {
    const k = key(appointment.source, appointment.externalId);
    if (this.#rows.has(k)) return false;
    this.#rows.set(k, structuredClone(appointment));
    return true;
  }
  async lockByExternalId(source: AppointmentSource, externalId: string): Promise<Appointment | null> {
    const found = this.#rows.get(key(source, externalId));
    return found ? structuredClone(found) : null;
  }
  async update(appointment: Appointment): Promise<Appointment> {
    this.#rows.set(key(appointment.source, appointment.externalId), structuredClone(appointment));
    return structuredClone(appointment);
  }
  async listBetween(from: string, to: string): Promise<Appointment[]> {
    const lo = Date.parse(from);
    const hi = Date.parse(to);
    return [...this.#rows.values()]
      .filter((a) => {
        const at = Date.parse(a.scheduledFor);
        return at >= lo && at < hi;
      })
      // Ties by id with a plain comparison, which is how Postgres orders a UUID — `localeCompare`
      // may skip the hyphens and disagree with the database about which visit comes first.
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => structuredClone(a));
  }
}
