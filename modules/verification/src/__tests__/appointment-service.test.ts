/**
 * The schedule service over the in-memory stores: how visits come in, and what a read says about them.
 *
 * The rules pinned here are the ones a CSV import will lean on hardest — re-importing an export
 * changes nothing, one bad row never costs the rest of the file, a visit is only cancelled when the
 * source says so, and a bare local time is refused rather than guessed at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppointmentService, MAX_WINDOW_DAYS, plannedProduction, visitProblem } from "../appointment-service.ts";
import { InMemoryAppointmentRepository, type ScheduledVisit } from "../appointments.ts";
import { InMemoryPatientDirectory } from "../patients.ts";
import { InMemoryVerificationRepository } from "../repository.ts";
import type { VerificationRecord } from "../types.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const FROM = new Date("2026-09-28T00:00:00.000Z");
const TO = new Date("2026-10-12T00:00:00.000Z");

const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
const visit = (over: Partial<ScheduledVisit> = {}): ScheduledVisit => ({
  externalId: "APT-1",
  scheduledFor: "2026-10-01T09:30:00-05:00",
  durationMinutes: 60,
  provider: "Dr. Reyes",
  status: "scheduled",
  patient: ada,
  plannedProcedures: [
    { code: "D1110", feeCents: 12_000 },
    { code: "d0120", feeCents: 6_500 },
  ],
  ...over,
});

const setup = (timeZone = "UTC") => {
  const patients = new InMemoryPatientDirectory();
  const verifications = new InMemoryVerificationRepository();
  const service = new AppointmentService(new InMemoryAppointmentRepository(), patients, verifications, timeZone);
  return { patients, verifications, service };
};

test("a new visit is created, normalised to UTC, and its patient enters the patient master", async () => {
  const { service, patients } = setup();
  const result = await service.sync("csv", [visit()], NOW);
  assert.deepEqual(result, { created: 1, updated: 0, unchanged: 0, rejected: [] });

  const [item] = await service.list(FROM, TO);
  assert.equal(item!.scheduledFor, "2026-10-01T14:30:00.000Z");
  assert.equal(item!.patientName, "Ada Alpha");
  assert.equal(item!.plannedProcedures[1]!.code, "D0120", "codes are upper-cased");
  assert.equal((await patients.list()).length, 1);
});

test("re-importing the same export changes nothing — the same instant in another offset included", async () => {
  const { service } = setup();
  await service.sync("csv", [visit()], NOW);
  const again = await service.sync("csv", [visit({ scheduledFor: "2026-10-01T14:30:00Z" })], NOW);
  assert.deepEqual(again, { created: 0, updated: 0, unchanged: 1, rejected: [] });
  assert.equal((await service.list(FROM, TO)).length, 1);
});

test("a moved visit is updated in place, not duplicated", async () => {
  const { service } = setup();
  await service.sync("csv", [visit()], NOW);
  const moved = await service.sync("csv", [visit({ scheduledFor: "2026-10-02T09:30:00-05:00" })], NOW);
  assert.equal(moved.updated, 1);
  const items = await service.list(FROM, TO);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.scheduledFor, "2026-10-02T14:30:00.000Z");
});

test("the same appointment id from two sources is two visits — sources number independently", async () => {
  const { service } = setup();
  await service.sync("csv", [visit()], NOW);
  await service.sync("mock", [visit()], NOW);
  assert.equal((await service.list(FROM, TO)).length, 2);
});

test("one bad row is rejected with its reason and never costs the rest of the file", async () => {
  const { service } = setup();
  const result = await service.sync(
    "csv",
    [
      visit({ externalId: "OK-1" }),
      visit({ externalId: "LOCAL", scheduledFor: "2026-10-01T09:30:00" }),
      visit({ externalId: "NODOB", patient: { ...ada, dateOfBirth: "" } }),
      visit({ externalId: "OK-2" }),
    ],
    NOW
  );
  assert.equal(result.created, 2);
  assert.deepEqual(
    result.rejected.map((r) => r.externalId),
    ["LOCAL", "NODOB"]
  );
  assert.match(result.rejected[0]!.reason, /UTC offset/);
});

test("visitProblem refuses what a source could plausibly send wrong", () => {
  assert.equal(visitProblem(visit()), null);
  assert.match(visitProblem(visit({ externalId: "  " }))!, /appointment id/);
  assert.match(visitProblem(visit({ scheduledFor: "2026-10-01" }))!, /UTC offset/);
  assert.match(visitProblem(visit({ scheduledFor: "2026-13-45T09:00:00Z" }))!, /UTC offset/);
  assert.match(visitProblem(visit({ status: "broken" as never }))!, /unknown status/);
  assert.match(visitProblem(visit({ patient: { ...ada, lastName: "" } }))!, /patient name/);
  assert.match(visitProblem(visit({ durationMinutes: 0 }))!, /durationMinutes/);
  assert.match(visitProblem(visit({ plannedProcedures: [{ code: "D1110", feeCents: 12.5 }] }))!, /whole, non-negative cents/);
  assert.match(visitProblem(visit({ plannedProcedures: [{ code: "", feeCents: null }] }))!, /no code/);
});

test("absence is not cancellation: a visit missing from the next export stays scheduled", async () => {
  const { service } = setup();
  await service.sync("csv", [visit({ externalId: "A" }), visit({ externalId: "B" })], NOW);
  await service.sync("csv", [visit({ externalId: "A" })], NOW);
  const items = await service.list(FROM, TO);
  // Same instant, so the order is by (random) id — compare as a set.
  assert.deepEqual(
    items.map((i) => [i.externalId, i.status]).sort(),
    [["A", "scheduled"], ["B", "scheduled"]]
  );
});

test("a cancellation the source states is recorded, and a cancelled visit has no readiness", async () => {
  const { service } = setup();
  await service.sync("csv", [visit()], NOW);
  await service.sync("csv", [visit({ status: "cancelled" })], NOW);
  const [item] = await service.list(FROM, TO);
  assert.equal(item!.status, "cancelled");
  assert.equal(item!.readiness, null);
});

test("planned production is the practice's own sum, or null — never a partial one", () => {
  assert.equal(plannedProduction([{ code: "D1110", feeCents: 12_000 }, { code: "D0120", feeCents: 6_500 }]), 18_500);
  assert.equal(plannedProduction([{ code: "D1110", feeCents: 12_000 }, { code: "D0120", feeCents: null }]), null);
  assert.equal(plannedProduction([]), null);
});

test("the window is validated, capped, and half-open", async () => {
  const { service } = setup();
  await service.sync("csv", [visit({ externalId: "EDGE", scheduledFor: "2026-10-12T00:00:00Z" })], NOW);
  assert.equal((await service.list(FROM, TO)).length, 0, "`to` is exclusive");
  await assert.rejects(service.list(TO, FROM), /after from/);
  await assert.rejects(service.list(new Date("nope"), TO), /valid dates/);
  const tooWide = new Date(FROM.getTime() + (MAX_WINDOW_DAYS + 1) * 86_400_000);
  await assert.rejects(service.list(FROM, tooWide), /at most/);
});

test("readiness reads the patient's own verifications, through the coverage on file", async () => {
  const { service, patients, verifications } = setup();
  await service.sync("csv", [visit()], NOW);
  const [before] = await service.list(FROM, TO);
  assert.equal(before!.readiness!.state, "no-coverage");

  await patients.linkCoverage(before!.patientId, "ABC12345", "delta");
  const [onFile] = await service.list(FROM, TO);
  assert.equal(onFile!.readiness!.state, "unverified");

  await verifications.save({
    id: "v-ada",
    createdAt: "2026-09-27T10:00:00.000Z",
    status: "verified",
    patientId: before!.patientId,
    patient: { ...ada, memberId: "ABC12345" },
    card: { memberId: { value: "ABC12345" } },
    benefits: { eligibility: "active", coverage: { effectiveDate: null, terminationDate: null } },
    review: null,
  } as unknown as VerificationRecord);
  const [verified] = await service.list(FROM, TO);
  assert.equal(verified!.readiness!.state, "verified");
  assert.equal(verified!.readiness!.verificationId, "v-ada");
});

test("the visit's day is the PRACTICE's day: a plan ending Sep 30 still covers a 7pm Chicago visit that is Oct 1 in UTC", async () => {
  const { service, patients, verifications } = setup("America/Chicago");
  await service.sync("csv", [visit({ scheduledFor: "2026-09-30T19:00:00-05:00" })], NOW);
  const [item] = await service.list(FROM, TO);
  await patients.linkCoverage(item!.patientId, "ABC12345", "delta");
  await verifications.save({
    id: "v-window",
    createdAt: "2026-09-27T10:00:00.000Z",
    status: "verified",
    patientId: item!.patientId,
    patient: { ...ada, memberId: "ABC12345" },
    card: { memberId: { value: "ABC12345" } },
    benefits: { eligibility: "active", coverage: { effectiveDate: null, terminationDate: "2026-09-30" } },
    review: null,
  } as unknown as VerificationRecord);
  const [read] = await service.list(FROM, TO);
  assert.equal(read!.scheduledFor, "2026-10-01T00:00:00.000Z");
  assert.equal(read!.readiness!.state, "verified");
});
