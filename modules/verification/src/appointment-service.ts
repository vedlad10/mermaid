/**
 * The schedule as a service: the one door visits come in through, and the read every schedule
 * surface draws from.
 *
 * ── SYNC IS PER VISIT, NOT PER FILE ───────────────────────────────────────────────────────────────
 * A practice's export has thousands of rows and one of them will be malformed. Refusing the file
 * over it would leave the whole schedule blank; so each visit is accepted or rejected on its own,
 * and every rejection is returned with its reason for the importer to show.
 *
 * ── ABSENCE IS NOT CANCELLATION ───────────────────────────────────────────────────────────────────
 * An export covers a date range. A visit missing from this one may simply be outside it, so nothing
 * is ever cancelled or deleted for being absent. A visit is cancelled when a source SAYS so.
 */
import { randomUUID } from "node:crypto";
import { calendarDay, type Cents } from "@mermaid/shared";
import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentRepository,
  type AppointmentSource,
  type AppointmentStatus,
  type PlannedProcedure,
  type ScheduledVisit,
} from "./appointments.ts";
import { coverageReadiness, latestVerification, planKey, type Readiness } from "./engine/readiness.ts";
import { IMPORT_FIELDS, planScheduleImport, type ColumnMapping } from "./engine/schedule-csv.ts";
import type { PatientDirectory } from "./patients.ts";
import type { VerificationRepository } from "./repository.ts";
import type { VerificationInput } from "./pipeline.ts";
import type { VerificationRecord } from "./types.ts";

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  rejected: { externalId: string; reason: string }[];
}

export interface AppointmentListItem {
  id: string;
  source: AppointmentSource;
  externalId: string;
  scheduledFor: string;
  /**
   * The visit's calendar day in the PRACTICE's time zone. Computed here, where the zone is known,
   * so no screen has to redo time-zone arithmetic to decide which day a 7pm visit belongs to.
   */
  day: string;
  durationMinutes: number | null;
  provider: string | null;
  status: AppointmentStatus;
  patientId: string;
  patientName: string;
  chartId: string;
  plannedProcedures: PlannedProcedure[];
  /**
   * The sum of the planned fees, or null when it cannot be stated honestly: no procedures planned,
   * or any fee the source did not give. A partial sum would be read as the visit's production.
   */
  plannedProductionCents: number | null;
  /** Null unless the visit is still `scheduled` — readiness is a question about a future visit. */
  readiness: Readiness | null;
}

/** The widest window one read may ask for — the timeline is 14 days; this leaves room. */
export const MAX_WINDOW_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export class InvalidAppointmentWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAppointmentWindowError";
  }
}

// An offset or Z is REQUIRED — see `ScheduledVisit.scheduledFor`.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a visit cannot be accepted, or null when it can. */
export function visitProblem(visit: ScheduledVisit): string | null {
  if (typeof visit.externalId !== "string" || !visit.externalId.trim()) return "missing appointment id";
  if (typeof visit.scheduledFor !== "string" || !INSTANT.test(visit.scheduledFor) || Number.isNaN(Date.parse(visit.scheduledFor))) {
    return "scheduledFor must be a date-time with a UTC offset";
  }
  if (!APPOINTMENT_STATUSES.includes(visit.status)) return `unknown status "${String(visit.status)}"`;
  const p = visit.patient;
  if (!p || !p.firstName?.trim() || !p.lastName?.trim()) return "missing patient name";
  if (!ISO_DATE.test(p.dateOfBirth ?? "") || Number.isNaN(Date.parse(p.dateOfBirth))) return "missing or invalid patient date of birth";
  const d = visit.durationMinutes;
  if (d != null && (!Number.isInteger(d) || d <= 0)) return "durationMinutes must be a positive whole number";
  for (const proc of visit.plannedProcedures ?? []) {
    if (!proc.code?.trim()) return "a planned procedure has no code";
    if (proc.feeCents != null && (!Number.isInteger(proc.feeCents) || proc.feeCents < 0)) {
      return `planned fee for ${proc.code} must be whole, non-negative cents`;
    }
  }
  const stated = visit.statedProductionCents;
  if (stated != null && (!Number.isInteger(stated) || stated < 0)) return "statedProductionCents must be whole, non-negative cents";
  return null;
}

const content = (
  a: Pick<Appointment, "patientId" | "scheduledFor" | "durationMinutes" | "provider" | "status" | "plannedProcedures" | "statedProductionCents">
) =>
  JSON.stringify([a.patientId, a.scheduledFor, a.durationMinutes, a.provider, a.status, a.plannedProcedures, a.statedProductionCents ?? null]);

/**
 * A visit's planned production, or null when it cannot be stated honestly.
 *
 * The source's own stated total wins when there is one: it is the practice's figure for the visit,
 * and an export that gives a total and some per-code fees is telling us which one it stands behind.
 * Without a total, it is the sum of per-code fees — and only when every one is known, because a
 * partial sum would be read as the whole.
 */
export function plannedProduction(procedures: readonly PlannedProcedure[], stated: number | null = null): number | null {
  if (stated !== null) return stated;
  if (procedures.length === 0) return null;
  let total = 0;
  for (const p of procedures) {
    if (p.feeCents == null) return null;
    total += p.feeCents;
  }
  return total;
}

export class AppointmentService {
  #repo: AppointmentRepository;
  #patients: PatientDirectory;
  #verifications: VerificationRepository;
  #timeZone: string;
  #uow: AppointmentUnitOfWork;

  constructor(
    repo: AppointmentRepository,
    patients: PatientDirectory,
    verifications: VerificationRepository,
    /** The practice's IANA timezone — a 7pm visit in Chicago is on the Chicago day, not the UTC one. */
    timeZone = "UTC",
    /**
     * How `runDue` opens its short transactions. Inline without a database; with one, the
     * composition root passes `withCurrentPractice`, which joins an ambient transaction or opens a
     * fresh one when only the practice scope is set.
     */
    unitOfWork: AppointmentUnitOfWork = InlineAppointmentUnitOfWork
  ) {
    this.#repo = repo;
    this.#patients = patients;
    this.#verifications = verifications;
    this.#timeZone = timeZone;
    this.#uow = unitOfWork;
  }

  async sync(source: AppointmentSource, visits: readonly ScheduledVisit[], now: Date = new Date()): Promise<SyncResult> {
    if (!APPOINTMENT_SOURCES.includes(source)) throw new Error(`unknown appointment source "${String(source)}"`);
    const result: SyncResult = { created: 0, updated: 0, unchanged: 0, rejected: [] };
    const at = now.toISOString();

    for (const visit of visits) {
      const problem = visitProblem(visit);
      if (problem) {
        result.rejected.push({ externalId: String(visit?.externalId ?? ""), reason: problem });
        continue;
      }
      const patient = await this.#patients.ensure({
        firstName: visit.patient.firstName.trim(),
        lastName: visit.patient.lastName.trim(),
        dateOfBirth: visit.patient.dateOfBirth,
      });
      const fields = {
        patientId: patient.id,
        // Normalised to UTC so equal instants written with different offsets compare equal.
        scheduledFor: new Date(visit.scheduledFor).toISOString(),
        durationMinutes: visit.durationMinutes ?? null,
        provider: visit.provider?.trim() || null,
        status: visit.status,
        plannedProcedures: (visit.plannedProcedures ?? []).map((p) => ({ code: p.code.trim().toUpperCase(), feeCents: p.feeCents ?? null })),
        statedProductionCents: visit.statedProductionCents ?? null,
      };
      const externalId = visit.externalId.trim();

      const inserted = await this.#repo.insertIfAbsent({
        id: randomUUID(),
        source,
        externalId,
        ...fields,
        createdAt: at,
        updatedAt: at,
      });
      if (inserted) {
        result.created += 1;
        continue;
      }
      const existing = await this.#repo.lockByExternalId(source, externalId);
      if (!existing) throw new Error(`appointment ${source}/${externalId} vanished between insert and lock`);
      if (content(existing) === content(fields)) {
        result.unchanged += 1;
        continue;
      }
      await this.#repo.update({ ...existing, ...fields, updatedAt: at });
      result.updated += 1;
    }
    return result;
  }

  /** Every visit in `[from, to)`, soonest first, each with its coverage readiness. */
  async list(from: Date, to: Date): Promise<AppointmentListItem[]> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new InvalidAppointmentWindowError("from and to must be valid dates");
    }
    if (to <= from) throw new InvalidAppointmentWindowError("to must be after from");
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      throw new InvalidAppointmentWindowError(`a window may span at most ${MAX_WINDOW_DAYS} days`);
    }

    const appointments = await this.#repo.listBetween(from.toISOString(), to.toISOString());
    // One patient often has several visits in a window; look each up once.
    const byPatient = new Map<string, Promise<PatientFacts | null>>();
    const factsFor = (patientId: string) => {
      let facts = byPatient.get(patientId);
      if (!facts) {
        facts = this.#patientFacts(patientId);
        byPatient.set(patientId, facts);
      }
      return facts;
    };

    const items: AppointmentListItem[] = [];
    for (const a of appointments) {
      const facts = await factsFor(a.patientId);
      const day = calendarDay(new Date(a.scheduledFor), this.#timeZone);
      items.push({
        id: a.id,
        source: a.source,
        externalId: a.externalId,
        scheduledFor: a.scheduledFor,
        day,
        durationMinutes: a.durationMinutes,
        provider: a.provider,
        status: a.status,
        patientId: a.patientId,
        patientName: facts ? `${facts.firstName} ${facts.lastName}`.trim() : "Unknown patient",
        chartId: facts?.chartId ?? "",
        plannedProcedures: a.plannedProcedures,
        plannedProductionCents: plannedProduction(a.plannedProcedures, a.statedProductionCents ?? null),
        readiness:
          a.status === "scheduled"
            ? coverageReadiness(
                new Date(a.scheduledFor),
                day,
                facts?.records ?? [],
                facts?.hasCoverageOnFile ?? false
              )
            : null,
      });
    }
    return items;
  }

  /**
   * Read a schedule export and say what importing it would do — nothing is written (stage 4).
   *
   * The preview a person reviews before the one click that imports: which column became which
   * field, which rows will come in, and every row that will not, by line, with the reason.
   */
  previewImport(csv: string, mapping: Partial<ColumnMapping> = {}): ImportPreview {
    const plan = planScheduleImport(csv, this.#timeZone, mapping);
    const ready = plan.rows.filter((r) => r.visit).map((r) => r.visit!);
    const days = ready.map((v) => calendarDay(new Date(v.scheduledFor), this.#timeZone)).sort();
    return {
      headers: plan.headers,
      mapping: plan.mapping,
      fields: IMPORT_FIELDS,
      fileProblems: plan.fileProblems,
      total: plan.rows.length,
      ready: ready.length,
      problems: plan.rows.filter((r) => r.problem).map((r) => ({ line: r.line, problem: r.problem! })).slice(0, MAX_LISTED_PROBLEMS),
      problemCount: plan.rows.filter((r) => r.problem).length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      sample: ready.slice(0, 5).map((v) => ({
        externalId: v.externalId,
        day: calendarDay(new Date(v.scheduledFor), this.#timeZone),
        scheduledFor: v.scheduledFor,
        patientName: `${v.patient.firstName} ${v.patient.lastName}`,
        status: v.status,
        productionCents: plannedProduction(v.plannedProcedures ?? [], v.statedProductionCents ?? null),
      })),
    };
  }

  /**
   * Import a schedule export: re-read on the server — never trusting a list the browser parsed —
   * then through `sync`, so re-importing the same export changes nothing. A file with a problem
   * that stops the whole file imports nothing; otherwise each row stands or falls on its own.
   */
  async importCsv(csv: string, mapping: Partial<ColumnMapping> = {}, now: Date = new Date()): Promise<ImportResult> {
    const plan = planScheduleImport(csv, this.#timeZone, mapping);
    if (plan.fileProblems.length > 0) {
      return { fileProblems: plan.fileProblems, created: 0, updated: 0, unchanged: 0, rejected: [] };
    }
    const byId = new Map(plan.rows.filter((r) => r.visit).map((r) => [r.visit!.externalId, r.line]));
    const result = await this.sync("csv", plan.rows.filter((r) => r.visit).map((r) => r.visit!), now);
    return {
      fileProblems: [],
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      rejected: [
        ...plan.rows.filter((r) => r.problem).map((r) => ({ line: r.line, reason: r.problem! })),
        ...result.rejected.map((r) => ({ line: byId.get(r.externalId) ?? null, reason: r.reason })),
      ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    };
  }

  /** The practice's time zone, and the calendar day `now` falls on in it. */
  calendar(now: Date = new Date()): { timeZone: string; today: string } {
    return { timeZone: this.#timeZone, today: calendarDay(now, this.#timeZone) };
  }

  /**
   * What "Verify all due" would do right now, without doing it (stage 3).
   *
   * Every visit in the next `VERIFY_HORIZON_DAYS` whose coverage is not ready appears, marked either
   * `check` or `skip` with the reason — so a person sees exactly what one click will send to the
   * clearinghouse, and why the rest will not be sent. Nothing here calls a payer.
   */
  async due(now: Date = new Date()): Promise<DuePreview> {
    return (await this.#duePlan(now)).preview;
  }

  /**
   * Run the checks a person asked for: one eligibility request per PATIENT, sequentially.
   *
   * ── WHAT THIS REFUSES TO DO ───────────────────────────────────────────────────────────────────
   * It never runs on its own — the only caller is a route a person clicks. It re-derives what is due
   * at the moment of the click rather than trusting the list the screen showed, so a visit verified
   * in another tab since then is reported "no longer due" instead of being checked twice. It checks
   * a patient once however many visits they have in the window. And it stops at
   * `MAX_PATIENTS_PER_RUN`, because each request is a real one to a real clearinghouse.
   *
   * ── ONE PATIENT'S FAILURE IS ONE PATIENT'S ────────────────────────────────────────────────────
   * Each check runs in its own unit of work: a payer timeout for one patient is reported against
   * that patient's visits and the run goes on. The reads are units of work too, so the whole run
   * can execute where no transaction is open — which is where a route that waits on a third party
   * belongs (NEW-10).
   */
  async runDue(appointmentIds: readonly string[], verify: VerifyFn, now: Date = new Date()): Promise<DueRunResult> {
    const { preview, sources } = await this.#uow.run(() => this.#duePlan(now));
    const requested = new Set(appointmentIds);
    const results: DueVisitResult[] = [];
    const notRun = (v: Pick<DueVisit, "appointmentId" | "patientName" | "scheduledFor" | "day">, message: string) =>
      results.push({ ...pick(v), outcome: "not-run", readiness: null, verificationId: null, message });

    const known = new Set(preview.visits.map((v) => v.appointmentId));
    for (const id of requested) {
      if (!known.has(id)) {
        results.push({
          appointmentId: id, patientName: "", scheduledFor: "", day: "", outcome: "not-run", readiness: null,
          verificationId: null, message: "No longer due for a check — it was verified or changed since the list was shown.",
        });
      }
    }

    // Grouped by patient, soonest visit first, so the cap keeps the most urgent people.
    const groups = new Map<string, DueVisit[]>();
    for (const v of preview.visits) {
      if (!requested.has(v.appointmentId)) continue;
      if (v.will === "skip") { notRun(v, v.reason); continue; }
      const g = groups.get(v.patientId) ?? [];
      g.push(v);
      groups.set(v.patientId, g);
    }

    let checked = 0;
    for (const [patientId, visits] of groups) {
      if (checked >= MAX_PATIENTS_PER_RUN) {
        for (const v of visits) notRun(v, `Over the ${MAX_PATIENTS_PER_RUN}-patient limit for one run. Run again for the rest.`);
        continue;
      }
      const source = sources.get(patientId)!;
      checked += 1;
      try {
        const view = await this.#uow.run(() => verify(checkInput(source), now));
        for (const v of visits) {
          // Across every plan, with the new run added — the same answer the schedule will now show.
          const readiness = coverageReadiness(new Date(v.scheduledFor), v.day, [...source.records, view.record], true);
          results.push({ ...pick(v), outcome: "checked", readiness, verificationId: view.record.id, message: readiness.reason });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const v of visits) {
          results.push({
            ...pick(v), outcome: "error", readiness: null, verificationId: null,
            message: `The check could not be completed: ${message.slice(0, 200)}`,
          });
        }
      }
    }
    return { checked, results };
  }

  async #duePlan(now: Date): Promise<{ preview: DuePreview; sources: Map<string, CheckSource> }> {
    const items = await this.list(now, new Date(now.getTime() + VERIFY_HORIZON_DAYS * DAY_MS));
    const facts = new Map<string, PatientFacts | null>();
    const factsFor = async (patientId: string) => {
      if (!facts.has(patientId)) facts.set(patientId, await this.#patientFacts(patientId));
      return facts.get(patientId) ?? null;
    };

    const visits: DueVisit[] = [];
    const sources = new Map<string, CheckSource>();
    for (const a of items) {
      if (a.status !== "scheduled" || !a.readiness || a.readiness.group === "verified") continue;
      const base = {
        appointmentId: a.id, patientId: a.patientId, patientName: a.patientName,
        scheduledFor: a.scheduledFor, day: a.day, state: a.readiness.state,
      };
      const skip = (reason: string) => visits.push({ ...base, will: "skip", reason });

      if (a.readiness.state === "needs-review") {
        skip("The last check is waiting for a person to review it. Checking again would not answer that.");
        continue;
      }
      if (a.readiness.state === "no-coverage") {
        skip("No insurance on file. Verify from the patient's card first.");
        continue;
      }
      const f = await factsFor(a.patientId);
      /*
       * Re-check the plan the visit's answer rests on — its newest run that carries a card — not
       * whichever card was typed last. With two plans, the last card entered may be the one plan
       * that is already fine. Only when that plan has no card on file does it fall back to any card.
       */
      const chosen = f?.records.find((r) => r.id === a.readiness!.verificationId) ?? null;
      const card =
        (chosen && latestVerification(f!.records.filter((r) => planKey(r) === planKey(chosen) && Boolean(r.cardText?.trim())))) ??
        f?.latestWithCard ??
        null;
      if (!card) {
        skip("No card on file to check again. Verify from the patient's card first.");
        continue;
      }
      const lastAt = f?.latest ? Date.parse(f.latest.createdAt) : NaN;
      if (now.getTime() - lastAt < RECHECK_COOLDOWN_MS) {
        const mins = Math.max(1, Math.round((now.getTime() - lastAt) / 60_000));
        skip(`Checked ${mins} min ago. Wait ${RECHECK_COOLDOWN_MS / 60_000} minutes between checks so a failing one is not repeated at a cost.`);
        continue;
      }
      if (!sources.has(a.patientId)) sources.set(a.patientId, { record: card, records: f!.records, plannedProcedures: a.plannedProcedures });
      visits.push({ ...base, will: "check", reason: CHECK_REASON[a.readiness.state] ?? "Coverage is not ready for this visit." });
    }
    const checks = new Set(visits.filter((v) => v.will === "check").map((v) => v.patientId)).size;
    return {
      preview: { horizonDays: VERIFY_HORIZON_DAYS, maxPatients: MAX_PATIENTS_PER_RUN, checks, visits },
      sources,
    };
  }

  async #patientFacts(patientId: string): Promise<PatientFacts | null> {
    const patient = await this.#patients.findById(patientId);
    if (!patient) return null;
    const memberIds = await this.#patients.memberIdsFor(patientId);
    const records = await this.#verifications.list({ patient: { patientId, memberIds } });
    return {
      firstName: patient.firstName,
      lastName: patient.lastName,
      chartId: patient.chartId,
      records,
      latest: latestVerification(records),
      // A check can only be re-run from a card someone already entered — never invented.
      latestWithCard: latestVerification(records.filter((r) => Boolean(r.cardText?.trim()))),
      hasCoverageOnFile: memberIds.length > 0,
    };
  }
}

interface PatientFacts {
  firstName: string;
  lastName: string;
  chartId: string;
  /** Every verification for this patient, across all their plans. Readiness groups them by plan. */
  records: VerificationRecord[];
  latest: ReturnType<typeof latestVerification>;
  latestWithCard: ReturnType<typeof latestVerification>;
  hasCoverageOnFile: boolean;
}

/* ── Verify all due (stage 3) ─────────────────────────────────────────────────────────────────── */

/** How far ahead a run looks — the category's pre-visit window, as Dental Verify used. */
export const VERIFY_HORIZON_DAYS = 3;
/** Each check is a real request to a real clearinghouse; one click sends at most this many. */
export const MAX_PATIENTS_PER_RUN = 20;
/** A patient checked this recently is not checked again, so a failing check is not repeated at a cost. */
export const RECHECK_COOLDOWN_MS = 15 * 60_000;

/** A local unit of work. The claims module has one; module boundaries forbid importing it. */
export interface AppointmentUnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
export const InlineAppointmentUnitOfWork: AppointmentUnitOfWork = { run: (fn) => fn() };

export interface DueVisit {
  appointmentId: string;
  patientId: string;
  patientName: string;
  scheduledFor: string;
  day: string;
  state: Readiness["state"];
  will: "check" | "skip";
  reason: string;
}

export interface DuePreview {
  horizonDays: number;
  maxPatients: number;
  /** PATIENTS a run would check — fewer than the `check` visits when one person has two. */
  checks: number;
  visits: DueVisit[];
}

export interface DueVisitResult {
  appointmentId: string;
  patientName: string;
  scheduledFor: string;
  day: string;
  /** `checked`: a payer answered and readiness is recomputed; `error`: the check failed; `not-run`: skipped. */
  outcome: "checked" | "error" | "not-run";
  readiness: Readiness | null;
  verificationId: string | null;
  message: string;
}

export interface DueRunResult {
  /** Patients actually sent to the clearinghouse. */
  checked: number;
  results: DueVisitResult[];
}

/** Whatever creates a verification — the configured service, so a run uses the real adapter. */
export type VerifyFn = (input: VerificationInput, now: Date) => Promise<{ record: VerificationRecord }>;

interface CheckSource {
  record: VerificationRecord;
  /** Every run for the patient, so a result can be judged across all their plans. */
  records: VerificationRecord[];
  plannedProcedures: PlannedProcedure[];
}

const CHECK_REASON: Partial<Record<Readiness["state"], string>> = {
  stale: "The last check will be out of date by the visit.",
  failed: "The last check did not produce usable benefits.",
  inactive: "The payer said inactive. Checking again in case that has changed.",
  unconfirmed: "The payer did not confirm the plan is active.",
  unverified: "Coverage on file has not been checked.",
};

const pick = (v: Pick<DueVisit, "appointmentId" | "patientName" | "scheduledFor" | "day">) => ({
  appointmentId: v.appointmentId,
  patientName: v.patientName,
  scheduledFor: v.scheduledFor,
  day: v.day,
});

/**
 * The verification a due visit is checked with: the patient and card exactly as someone last
 * entered them, priced against THIS visit's planned procedures. A visit with no planned procedures
 * reuses the last check's plan rather than asking a payer about nothing.
 */
function checkInput(source: CheckSource): VerificationInput {
  const planned = source.plannedProcedures.map((p) => ({
    code: p.code,
    quantity: 1,
    ...(p.feeCents !== null ? { fee: p.feeCents as Cents } : {}),
  }));
  return {
    patient: source.record.patient,
    cardText: source.record.cardText ?? "",
    planItems: planned.length > 0 ? planned : source.record.planItems,
  };
}

/* ── Schedule import (stage 4) ────────────────────────────────────────────────────────────────── */

/** A preview lists at most this many row problems; the count beside it is always the full one. */
export const MAX_LISTED_PROBLEMS = 200;

export interface ImportPreview {
  headers: string[];
  mapping: ColumnMapping;
  fields: typeof IMPORT_FIELDS;
  /** Problems with the whole file. Any one means nothing would be imported. */
  fileProblems: string[];
  total: number;
  ready: number;
  problems: { line: number; problem: string }[];
  problemCount: number;
  firstDay: string | null;
  lastDay: string | null;
  sample: { externalId: string; day: string; scheduledFor: string; patientName: string; status: string; productionCents: number | null }[];
}

export interface ImportResult {
  fileProblems: string[];
  created: number;
  updated: number;
  unchanged: number;
  /** Every row that did not come in, with the line of the file it was on when known. */
  rejected: { line: number | null; reason: string }[];
}
