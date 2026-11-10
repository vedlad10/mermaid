/**
 * Importing a schedule export through the service: a preview writes nothing, an import goes through
 * `sync` so the same export twice changes nothing, and the export's own production total is what
 * the schedule then reports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppointmentService } from "../appointment-service.ts";
import { InMemoryAppointmentRepository } from "../appointments.ts";
import { InMemoryPatientDirectory } from "../patients.ts";
import { InMemoryVerificationRepository } from "../repository.ts";

const CSV =
  "Appt ID,Date,Time,Patient,DOB,Provider,Status,Procedures,Sched Prod\n" +
  'A1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990,Dr. Reyes,Confirmed,"D0120, D1110",$185.00\n' +
  'A2,10/1/2026,11:00 AM,"Booker, Ben",11/3/1978,Dr. Reyes,Broken,D2750,"$1,250.00"\n' +
  'A3,10/1/26,1:00 PM,"Chen, Cora",6/21/1985,Dr. Okafor,,D2391,220\n';

const FROM = new Date("2026-09-30T00:00:00Z");
const TO = new Date("2026-10-03T00:00:00Z");

const setup = () => {
  const patients = new InMemoryPatientDirectory();
  const service = new AppointmentService(new InMemoryAppointmentRepository(), patients, new InMemoryVerificationRepository(), "America/Chicago");
  return { service, patients };
};

test("a preview reports what an import would do and writes nothing", async () => {
  const { service, patients } = setup();
  const p = service.previewImport(CSV);
  assert.deepEqual(p.fileProblems, []);
  assert.equal(p.total, 3);
  assert.equal(p.ready, 2);
  assert.equal(p.problemCount, 1);
  assert.equal(p.problems[0]!.line, 4);
  assert.equal(p.firstDay, "2026-10-01");
  assert.equal(p.sample[0]!.productionCents, 18_500);
  assert.equal((await service.list(FROM, TO)).length, 0, "no visit was written");
  assert.equal((await patients.list()).length, 0, "no patient was written");
});

test("an import brings the good rows in with the export's own production, and reports the rest by line", async () => {
  const { service } = setup();
  const r = await service.importCsv(CSV, {}, new Date("2026-09-28T12:00:00Z"));
  assert.deepEqual(r.fileProblems, []);
  assert.equal(r.created, 2);
  assert.deepEqual(r.rejected.map((x) => x.line), [4]);

  const items = await service.list(FROM, TO);
  const ada = items.find((a) => a.externalId === "A1")!;
  assert.equal(ada.scheduledFor, "2026-10-01T14:30:00.000Z");
  assert.equal(ada.plannedProductionCents, 18_500, "the stated total, not a sum of unknown fees");
  assert.equal(items.find((a) => a.externalId === "A2")!.status, "cancelled", "Broken is a cancellation");
});

test("importing the same export twice changes nothing; a changed row updates in place", async () => {
  const { service } = setup();
  await service.importCsv(CSV);
  const again = await service.importCsv(CSV);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 2);

  const moved = await service.importCsv(CSV.replace("A1,10/1/2026,9:30 AM", "A1,10/1/2026,10:30 AM"));
  assert.equal(moved.updated, 1);
  assert.equal(moved.unchanged, 1);
  assert.equal((await service.list(FROM, TO)).length, 2);
});

test("a file-level problem imports nothing at all", async () => {
  const { service } = setup();
  const r = await service.importCsv("Date,Time,Patient,DOB\n10/1/2026,9:30 AM,\"Alpha, Ada\",4/12/1990\n");
  assert.ok(r.fileProblems.length > 0);
  assert.equal(r.created, 0);
  assert.equal((await service.list(FROM, TO)).length, 0);
});
