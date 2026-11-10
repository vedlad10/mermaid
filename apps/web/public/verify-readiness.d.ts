/** Types for the pure half of Verify's readiness block (`verify-readiness.js`). */
import type { ReadinessGroup, Schedule } from "./schedule.js";

export declare const HORIZON_DAYS: number;

export interface ReadinessPlan {
  /** What a column's height measures. Never both in one chart. */
  unit: "production" | "visits";
  points: { at: string; bucket: string; label: string; tick: string; parts: Record<ReadinessGroup, number>; note: string }[];
  booked: number;
  notReady: number;
  notReadyWeight: number;
  totalWeight: number;
}

export declare function readinessPlan(schedule: Schedule, days?: number): ReadinessPlan;
export declare function mountReadiness(host: unknown, deps: { api: unknown; store: unknown; onChanged?: (() => Promise<void>) | null }): { reload(): Promise<void>; destroy(): void };

/** The server's "Verify all due" preview (`GET /api/v1/appointments/due`). */
export interface DuePreviewLike {
  horizonDays: number;
  maxPatients: number;
  checks: number;
  visits: { appointmentId: string; patientName: string; scheduledFor: string; day: string; will: "check" | "skip"; reason: string }[];
}
/** The server's run result (`POST /api/v1/appointments/verify`). */
export interface DueRunLike {
  checked: number;
  results: { outcome: "checked" | "error" | "not-run"; readiness: { group: string } | null }[];
}
export declare function duePreviewSummary(due: DuePreviewLike): { checks: number; sentence: string; button: string | null };
export declare function dueRunSummary(run: DueRunLike): string;
