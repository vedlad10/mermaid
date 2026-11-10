/**
 * Types for the schedule's shared vocabulary (`schedule.js`), for the tests that import it.
 *
 * `ScheduleItem` is the slice of the server's `AppointmentListItem` the screens read — declared
 * here rather than imported because the client sits outside the typechecked surface on purpose.
 */

export type ReadinessGroup = "verified" | "pending" | "failed" | "no-coverage";

export interface ScheduleItem {
  id: string;
  source: "mock" | "csv";
  day: string;
  scheduledFor: string;
  status: "scheduled" | "completed" | "cancelled" | "no-show";
  patientName: string;
  provider: string | null;
  plannedProcedures: { code: string; feeCents: number | null }[];
  plannedProductionCents: number | null;
  readiness: { state: string; group: ReadinessGroup; verificationId: string | null } | null;
}

export interface Schedule {
  today: string;
  timeZone: string;
  items: ScheduleItem[];
}

export declare const READINESS_GROUPS: ReadonlyArray<{ key: ReadinessGroup; label: string; tone?: "warning" | "critical" }>;
export declare function readinessWord(r: ScheduleItem["readiness"]): string;
export declare function readinessTone(item: ScheduleItem, now?: number): "warning" | "critical" | null;
export declare function clockTime(iso: string, timeZone: string): string;
export declare function addDays(day: string, n: number): string;
export declare function fetchSchedule(api: unknown, days: number): Promise<Schedule>;
export declare function scheduleProvenance(items: ScheduleItem[]): string | null;
