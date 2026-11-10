/**
 * The schedule on screen (§8.1's strip, §8.2's readiness timeline) says only what the schedule knows.
 *
 * Every assertion here is a way the two widgets could state something false about a practice's day:
 * a total built from the fees that happen to be known, a cancelled visit counted as production, an
 * amber alarm on a visit next week, a fortnight with its empty weekend silently closed up, or a demo
 * schedule shown as though it were the practice's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Schedule, ScheduleItem } from "../public/schedule.js";

const { scheduleStrip } = await import("../public/today.js");
const { readinessPlan, HORIZON_DAYS } = await import("../public/verify-readiness.js");
const { readinessTone, readinessWord, scheduleProvenance } = await import("../public/schedule.js");

const NOW = Date.parse("2026-10-01T13:00:00.000Z");
let n = 0;
const visit = (over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id: `a${++n}`,
  source: "csv",
  day: "2026-10-01",
  scheduledFor: "2026-10-01T15:00:00.000Z",
  status: "scheduled",
  patientName: "Ada Alpha",
  provider: "Dr. Reyes",
  plannedProcedures: [{ code: "D1110", feeCents: 12_000 }],
  plannedProductionCents: 12_000,
  readiness: { state: "verified", group: "verified", verificationId: "v1" },
  ...over,
});
const schedule = (items: ScheduleItem[]): Schedule => ({ today: "2026-10-01", timeZone: "America/Chicago", items });

test("the strip lists only today's visits, on the practice's clock", () => {
  const s = scheduleStrip(schedule([visit(), visit({ day: "2026-10-02", scheduledFor: "2026-10-02T15:00:00.000Z" })]), NOW);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]!.time, "10:00 AM", "15:00Z is 10:00 in Chicago in October");
  assert.equal(s.rows[0]!.detail, "Dr. Reyes · D1110");
});

test("planned production is the practice's own sum, or nothing — never the fees that happen to be known", () => {
  assert.equal(scheduleStrip(schedule([visit(), visit({ plannedProductionCents: 30_000 })]), NOW).production, 42_000);
  assert.equal(scheduleStrip(schedule([visit(), visit({ plannedProductionCents: null })]), NOW).production, null);
});

test("a cancelled visit stays in the day but counts toward nothing", () => {
  const s = scheduleStrip(
    schedule([visit(), visit({ status: "cancelled", plannedProductionCents: 125_000, readiness: null })]),
    NOW
  );
  assert.equal(s.rows.length, 2);
  assert.equal(s.count, 1);
  assert.equal(s.production, 12_000);
  const cancelled = s.rows.find((r) => !r.booked)!;
  assert.equal(cancelled.word, "Cancelled");
  assert.equal(cancelled.tone, null);
});

test("amber is for inside 24 hours; failed coverage is critical at any distance", () => {
  const pending = { state: "unverified", group: "pending" as const, verificationId: null };
  const failed = { state: "inactive", group: "failed" as const, verificationId: "v9" };
  assert.equal(readinessTone(visit({ readiness: pending, scheduledFor: "2026-10-01T20:00:00.000Z" }), NOW), "warning");
  assert.equal(readinessTone(visit({ readiness: pending, scheduledFor: "2026-10-08T20:00:00.000Z" }), NOW), null);
  assert.equal(readinessTone(visit({ readiness: failed, scheduledFor: "2026-10-08T20:00:00.000Z" }), NOW), "critical");
  assert.equal(readinessTone(visit(), NOW), null, "a verified visit claims no colour");
  assert.equal(readinessTone(visit({ readiness: null, status: "cancelled" }), NOW), null);
  assert.equal(readinessWord(failed), "Payer says inactive");
  assert.equal(readinessWord(null), "—");
});

test("the fortnight keeps every day, including the ones with nothing booked", () => {
  const plan = readinessPlan(schedule([visit(), visit({ day: "2026-10-05", scheduledFor: "2026-10-05T15:00:00.000Z" })]));
  assert.equal(plan.points.length, HORIZON_DAYS);
  assert.equal(plan.points[0]!.tick, "Today");
  assert.deepEqual(
    plan.points.map((p) => p.bucket).slice(0, 5),
    ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]
  );
  assert.equal(plan.points[1]!.note, "nothing booked");
});

test("a column weighs production only when every booked fee is known; otherwise it counts, whole", () => {
  const pending = { state: "needs-review", group: "pending" as const, verificationId: "v2" };
  const byMoney = readinessPlan(schedule([visit(), visit({ plannedProductionCents: 125_000, readiness: pending })]));
  assert.equal(byMoney.unit, "production");
  assert.deepEqual(byMoney.points[0]!.parts, { verified: 12_000, "no-coverage": 0, pending: 125_000, failed: 0 });
  assert.equal(byMoney.notReadyWeight, 125_000);
  assert.equal(byMoney.totalWeight, 137_000);

  const byCount = readinessPlan(schedule([visit(), visit({ plannedProductionCents: null, readiness: pending })]));
  assert.equal(byCount.unit, "visits");
  assert.deepEqual(byCount.points[0]!.parts, { verified: 1, "no-coverage": 0, pending: 1, failed: 0 });
  assert.equal(byCount.notReady, 1);
});

test("cancelled visits are not drawn, and an empty schedule is not a verified one", () => {
  const plan = readinessPlan(schedule([visit({ status: "cancelled", readiness: null })]));
  assert.equal(plan.booked, 0);
  assert.equal(plan.notReady, 0);
  assert.ok(plan.points.every((p) => Object.values(p.parts).every((v) => v === 0)));
});

test("a demo schedule says so; the practice's own says nothing", () => {
  assert.equal(scheduleProvenance([visit(), visit()]), null);
  assert.equal(scheduleProvenance([visit({ source: "mock" }), visit({ source: "mock" })]), "Demo schedule — invented visits");
  assert.equal(scheduleProvenance([visit({ source: "mock" }), visit()]), "1 demo visit mixed in");
});

/* ── "Verify all due": the sentences a person reads before and after the one click ─────────────── */

const { duePreviewSummary, dueRunSummary } = await import("../public/verify-readiness.js");
const dueVisit = (will: "check" | "skip", patient: string) => ({
  appointmentId: `${patient}-${will}`, patientName: patient, scheduledFor: "2026-10-02T15:00:00.000Z",
  day: "2026-10-02", will, reason: will === "check" ? "Out of date." : "No insurance on file.",
});

test("the preview counts PATIENTS for the button — one person's two visits are one request", () => {
  const s = duePreviewSummary({
    horizonDays: 3, maxPatients: 20, checks: 1,
    visits: [dueVisit("check", "Ada"), { ...dueVisit("check", "Ada"), appointmentId: "Ada-2" }, dueVisit("skip", "Grace")],
  });
  assert.equal(s.button, "Check 1 patient now");
  assert.match(s.sentence, /1 patient can be checked now, covering 2 visits\./);
  assert.match(s.sentence, /1 visit needs a person instead/);
});

test("with nothing checkable there is no button; with nothing due it says every visit is verified", () => {
  const skipsOnly = duePreviewSummary({ horizonDays: 3, maxPatients: 20, checks: 0, visits: [dueVisit("skip", "Grace")] });
  assert.equal(skipsOnly.button, null);
  assert.match(skipsOnly.sentence, /Nothing here can be checked automatically/);
  const none = duePreviewSummary({ horizonDays: 3, maxPatients: 20, checks: 0, visits: [] });
  assert.equal(none.button, null);
  assert.match(none.sentence, /Every booked visit in that window is verified/);
});

test("the button never promises more than one run sends", () => {
  const visits = Array.from({ length: 25 }, (_, i) => ({ ...dueVisit("check", `P${i}`), appointmentId: `p${i}` }));
  const s = duePreviewSummary({ horizonDays: 3, maxPatients: 20, checks: 25, visits });
  assert.equal(s.button, "Check 20 patients now");
  assert.match(s.sentence, /One run checks the first 20; run again for the rest\./);
});

test("the run's sentence says what came back, including what did not work", () => {
  const sentence = dueRunSummary({
    checked: 3,
    results: [
      { outcome: "checked", readiness: { group: "verified" } },
      { outcome: "checked", readiness: { group: "failed" } },
      { outcome: "error", readiness: null },
      { outcome: "not-run", readiness: null },
    ],
  });
  assert.equal(sentence, "Checked 3 patients. 1 of 2 visits are now ready. 1 visit could not be checked. 1 visit was not run.");
});

/* ── Schedule import: the sentence a person decides on, and the one they read after ──────────── */

const { importSummary, importResultSummary } = await import("../public/schedule-import.js");

test("the import preview says how many will come in, over which days, and how many will not", () => {
  const base = { fileProblems: [], total: 3, ready: 2, problemCount: 1, firstDay: "2026-10-01", lastDay: "2026-10-09" };
  assert.equal(importSummary(base), "2 of 3 appointments ready to import, Thu, Oct 1 to Fri, Oct 9. 1 row cannot be imported — each is listed with its line.");
  assert.equal(importSummary({ ...base, problemCount: 0, ready: 3, lastDay: "2026-10-01" }), "3 of 3 appointments ready to import for Thu, Oct 1.");
  assert.match(importSummary({ ...base, fileProblems: ["No column is mapped to Date."] }), /Nothing can be imported/);
});

test("the import result counts new, updated, unchanged and refused — nothing is summed away", () => {
  assert.equal(
    importResultSummary({ fileProblems: [], created: 1, updated: 2, unchanged: 3, rejected: [{ line: 4, reason: "x" }] }),
    "Imported: 1 new visit, 2 updated, 3 unchanged. 1 row was not imported."
  );
  assert.match(importResultSummary({ fileProblems: ["x"], created: 0, updated: 0, unchanged: 0, rejected: [] }), /Nothing was imported/);
});
