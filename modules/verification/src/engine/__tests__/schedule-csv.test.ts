/**
 * Reading a practice's schedule export. Each test pins one way a CSV import goes quietly wrong: a
 * date read in the wrong order, a local time read as UTC, a two-digit year guessed, a fee read in
 * the wrong unit, a name split in the wrong place, or one appointment read as two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMPORT_ROWS,
  detectMapping,
  parseCsv,
  parseDate,
  parseMoney,
  parseProcedures,
  parseStatus,
  parseTime,
  planScheduleImport,
} from "../schedule-csv.ts";

test("CSV: quotes, doubled quotes, embedded newlines and commas, CRLF, a BOM, blank lines", () => {
  const text = '﻿ID,Patient,Note\r\n1,"Alpha, Ada","said ""hi""\r\nthen left"\r\n\r\n2,"Booker, Ben",\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows.map((r) => r.cells), [
    ["ID", "Patient", "Note"],
    ["1", "Alpha, Ada", 'said "hi"\nthen left'],
    ["2", "Booker, Ben", ""],
  ]);
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 5], "each record names the line it started on");
  assert.throws(() => parseCsv('a,"unclosed\n'), /quoted field that began on line 1/);
});

test("dates: ISO and US M/D/YYYY only; impossible dates and two-digit years are refused, not guessed", () => {
  assert.equal(parseDate("2026-10-01"), "2026-10-01");
  assert.equal(parseDate("3/4/2026"), "2026-03-04", "US order: March 4, not April 3");
  assert.equal(parseDate("10/01/2026"), "2026-10-01");
  for (const bad of ["2/30/2026", "13/1/2026", "3/4/26", "1975", "", "2026/10/01", "Oct 1 2026"]) {
    assert.equal(parseDate(bad), null, bad);
  }
});

test("times: 12- and 24-hour forms; noon and midnight are right; nonsense is refused", () => {
  assert.equal(parseTime("9:30 AM"), "09:30");
  assert.equal(parseTime("9:30am"), "09:30");
  assert.equal(parseTime("12:15 PM"), "12:15");
  assert.equal(parseTime("12:15 AM"), "00:15");
  assert.equal(parseTime("2:05:00 PM"), "14:05");
  assert.equal(parseTime("14:30"), "14:30");
  assert.equal(parseTime("9:30 p.m."), "21:30");
  for (const bad of ["13:00 PM", "0:30 AM", "24:00", "9:60", "930", "noon", ""]) assert.equal(parseTime(bad), null, bad);
});

test("money is whole cents from dollars as exports write them, never negative, never a float", () => {
  assert.equal(parseMoney("1250"), 125_000);
  assert.equal(parseMoney("$1,250.00"), 125_000);
  assert.equal(parseMoney("185.5"), 18_550);
  assert.equal(parseMoney("0.07"), 7);
  for (const bad of ["-10", "1.234", "abc", "$", "1,25.0.0"]) assert.equal(parseMoney(bad), null, bad);
});

test("procedures are CDT codes or the row is questioned; statuses map to four, unknown words refused", () => {
  assert.deepEqual(parseProcedures("D0120, d1110;D2750  D0274"), ["D0120", "D1110", "D2750", "D0274"]);
  assert.deepEqual(parseProcedures(""), []);
  assert.equal(parseProcedures("D1110, cleaning"), null);
  assert.equal(parseStatus("Confirmed"), "scheduled");
  assert.equal(parseStatus("Broken"), "cancelled");
  assert.equal(parseStatus("No Show"), "no-show");
  assert.equal(parseStatus("Checked Out"), "completed");
  assert.equal(parseStatus(""), "scheduled");
  assert.equal(parseStatus("Tentative-ish"), null);
});

test("columns are recognised by the names real exports use", () => {
  const dentrixish = detectMapping(["Appt ID", "Appt Date", "Appt Time", "Patient", "Birthdate", "Provider", "Status", "Procedures", "Sched Prod", "Length"]);
  assert.equal(dentrixish.externalId, "Appt ID");
  assert.equal(dentrixish.date, "Appt Date");
  assert.equal(dentrixish.time, "Appt Time");
  assert.equal(dentrixish.patientName, "Patient");
  assert.equal(dentrixish.dateOfBirth, "Birthdate");
  assert.equal(dentrixish.production, "Sched Prod");
  assert.equal(dentrixish.duration, "Length");
  const openDentalish = detectMapping(["AptNum", "AptDateTime", "Start Time", "LName", "FName", "DOB", "ProvAbbr"]);
  assert.equal(openDentalish.externalId, "AptNum");
  assert.equal(openDentalish.firstName, "FName");
  assert.equal(openDentalish.lastName, "LName");
  assert.equal(openDentalish.provider, "ProvAbbr");
  assert.equal(openDentalish.patientName, null, "split names win over a combined column");
});

const HEADER = "Appt ID,Date,Time,Patient,DOB,Provider,Status,Procedures,Production\n";
const plan = (rows: string, tz = "America/Chicago", override = {}) => planScheduleImport(HEADER + rows, tz, override);

test("a row becomes a visit at the PRACTICE's local time, with the export's own production total", () => {
  const p = plan('A1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990,Dr. Reyes,Confirmed,"D0120, D1110","$185.00"\n');
  assert.deepEqual(p.fileProblems, []);
  const v = p.rows[0]!.visit!;
  assert.equal(v.scheduledFor, "2026-10-01T14:30:00.000Z", "9:30 in Chicago in October is 14:30 UTC");
  assert.deepEqual(v.patient, { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
  assert.equal(v.status, "scheduled");
  assert.deepEqual(v.plannedProcedures, [{ code: "D0120", feeCents: null }, { code: "D1110", feeCents: null }], "a total is never split across codes");
  assert.equal(v.statedProductionCents, 18_500);
});

test("each bad row is refused with its line and reason; the good rows around it still come in", () => {
  const p = plan(
    [
      'A1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990,,,,',
      'A2,10/1/26,9:30 AM,"Booker, Ben",11/3/1978,,,,',
      "A3,10/1/2026,9:30 AM,Ben Booker,11/3/1978,,,,",
      'A4,10/1/2026,9:30 AM,"Chen, Cora",6/21/85,,,,',
      'A5,10/1/2026,9:30 AM,"Diaz, Dev",2/15/2001,,Tentative,,',
      'A6,3/8/2026,2:30 AM,"Ford, Frank",8/8/1994,,,,',
      'A7,10/1/2026,10:00 AM,"Green, Grace",3/14/1988,,,,',
    ].join("\n") + "\n"
  );
  const by = new Map(p.rows.map((r) => [r.line, r]));
  assert.ok(by.get(2)!.visit);
  assert.match(by.get(3)!.problem!, /Date "10\/1\/26"/);
  assert.match(by.get(4)!.problem!, /"Last, First" form/);
  assert.match(by.get(5)!.problem!, /Date of birth "6\/21\/85"/);
  assert.match(by.get(6)!.problem!, /Status "Tentative"/);
  assert.match(by.get(7)!.problem!, /clocks skip that hour/, "2:30 AM on spring-forward night never happens in Chicago");
  assert.ok(by.get(8)!.visit);
});

test("one appointment id twice in a file is refused on every line, never a silent winner", () => {
  const p = plan(
    'A1,10/1/2026,9:30 AM,"Alpha, Ada",4/12/1990,,,,\n' +
    'A1,10/2/2026,9:30 AM,"Alpha, Ada",4/12/1990,,,,\n' +
    'A2,10/2/2026,9:30 AM,"Booker, Ben",11/3/1978,,,,\n'
  );
  assert.equal(p.rows[0]!.visit, null);
  assert.equal(p.rows[1]!.visit, null);
  assert.match(p.rows[0]!.problem!, /lines 2, 3; none of them was imported/);
  assert.ok(p.rows[2]!.visit);
});

test("a file that cannot be read at all imports nothing and says why", () => {
  const noId = planScheduleImport("Date,Time,Patient,DOB\n10/1/2026,9:30 AM,\"Alpha, Ada\",4/12/1990\n", "UTC");
  assert.ok(noId.fileProblems.some((p) => /Appointment ID/.test(p)));
  assert.equal(noId.rows.length, 0);

  const override = planScheduleImport("Visit,Date,Time,Patient,DOB\nV1,10/1/2026,9:30 AM,\"Alpha, Ada\",4/12/1990\n", "UTC", { externalId: "Visit" });
  assert.deepEqual(override.fileProblems, [], "a person's mapping fixes what detection missed");
  assert.equal(override.rows[0]!.visit!.externalId, "V1");

  const twice = planScheduleImport(HEADER + "A1,10/1/2026,9:30 AM,\"A, B\",1/1/1990,,,,\n", "UTC", { provider: "Patient" });
  assert.ok(twice.fileProblems.some((p) => /mapped to more than one field/.test(p)));

  assert.ok(planScheduleImport("", "UTC").fileProblems.includes("The file is empty."));
  assert.ok(planScheduleImport(HEADER, "UTC").fileProblems.some((p) => /no appointments/.test(p)));

  const big = HEADER + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `A${i},10/1/2026,9:30 AM,"A, B",1/1/1990,,,,`).join("\n");
  assert.ok(planScheduleImport(big, "UTC").fileProblems.some((p) => /at most/.test(p)));
});
