/**
 * A deadline is a calendar day in a place.
 *
 * `platform/db/pool.ts` already refuses to let Postgres turn a `DATE` into an instant, and says why:
 * "a service date or a filing deadline can move by a day — which in this domain means a claim filed
 * against the wrong date of service, or a timely-filing deadline computed a day early or late."
 *
 * The deadline engines reintroduced exactly that one layer up, by answering "what day is it today?"
 * with the UTC day. These pin the primitive that fixes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValidTimeZone, calendarDay, daysBetween, zonedInstant } from "../calendar.ts";

test("the calendar day is the day in the practice's zone, not the server's", () => {
  // 03:00 UTC on the 12th is still the evening of the 11th on the US west coast.
  const instant = new Date("2026-08-12T03:00:00Z");
  assert.equal(calendarDay(instant, "UTC"), "2026-08-12");
  assert.equal(calendarDay(instant, "America/Los_Angeles"), "2026-08-11");
  assert.equal(calendarDay(instant, "America/New_York"), "2026-08-11");
  // And east of UTC the disagreement runs the other way.
  assert.equal(calendarDay(new Date("2026-08-11T22:00:00Z"), "Asia/Tokyo"), "2026-08-12");
});

test("daysBetween counts whole days and survives a DST transition", () => {
  assert.equal(daysBetween("2026-08-11", "2026-08-11"), 0);
  assert.equal(daysBetween("2026-08-11", "2026-08-12"), 1);
  assert.equal(daysBetween("2026-08-12", "2026-08-11"), -1);
  /**
   * US DST ends 2026-11-01. Anchoring both ends at UTC midnight is what makes this safe: a "day"
   * spanning the transition is 25 hours long in local time, and a naive local-midnight subtraction
   * divided by 86,400,000 rounds it to the wrong integer.
   */
  assert.equal(daysBetween("2026-10-31", "2026-11-02"), 2);
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2); // and the spring-forward side
  assert.equal(daysBetween("2026-02-27", "2026-03-01"), 2); // non-leap February boundary
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2); // leap February boundary
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1); // year boundary
});

test("a nonsense timezone is refused at configuration time, not mid-calculation", () => {
  assert.doesNotThrow(() => assertValidTimeZone("UTC"));
  assert.doesNotThrow(() => assertValidTimeZone("America/Los_Angeles"));
  assert.doesNotThrow(() => assertValidTimeZone(" America/New_York "));
  assert.throws(() => assertValidTimeZone("America/Nowhere"), /not a recognised IANA timezone/);
  assert.throws(() => assertValidTimeZone("GMT+5"), /not a recognised IANA timezone/);
});

test("the legacy fixed-offset abbreviations are refused, because they hide daylight saving", () => {
  /**
   * ICU accepts these, which is why they need their own guard. `EST` is UTC-5 all year: a New York
   * practice that sets it is an hour adrift from March to November, and an hour is enough to move
   * anything happening near midnight onto the wrong calendar day. It fails silently, and it looks
   * entirely reasonable in a config file.
   */
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en-CA", { timeZone: "EST" }), "ICU does accept it");
  assert.throws(() => assertValidTimeZone("EST"), /fixed-offset abbreviation/);
  assert.throws(() => assertValidTimeZone("PST"), /fixed-offset abbreviation/);

  // And the reason, demonstrated: mid-summer, EST and America/New_York disagree by an hour, which
  // straddles midnight here and yields two different days for one instant.
  const instant = new Date("2026-08-12T04:30:00Z");
  assert.equal(calendarDay(instant, "EST"), "2026-08-11");
  assert.equal(calendarDay(instant, "America/New_York"), "2026-08-12");
});

test("zonedInstant reads a local clock in the practice's zone, and inverts calendarDay", () => {
  // 9:30 in Chicago in October is CDT, five hours behind UTC.
  assert.equal(zonedInstant("2026-10-01", "09:30", "America/Chicago"), "2026-10-01T14:30:00.000Z");
  // In January it is CST, six hours behind — the offset is the zone's on THAT day, not today's.
  assert.equal(zonedInstant("2027-01-05", "09:30", "America/Chicago"), "2027-01-05T15:30:00.000Z");
  // 7pm Chicago is the next day in UTC, and calendarDay brings it back to the practice's day.
  const evening = zonedInstant("2026-09-30", "19:00", "America/Chicago")!;
  assert.equal(evening, "2026-10-01T00:00:00.000Z");
  assert.equal(calendarDay(new Date(evening), "America/Chicago"), "2026-09-30");
  assert.equal(zonedInstant("2026-10-01", "09:30"), "2026-10-01T09:30:00.000Z", "defaults to UTC");
  // East of UTC too.
  assert.equal(zonedInstant("2026-10-01", "09:30", "Asia/Kolkata"), "2026-10-01T04:00:00.000Z");
});

test("zonedInstant: a skipped local time is null; a repeated one is the EARLIER instant", () => {
  // US spring-forward 2026-03-08: 02:00 → 03:00, so 02:30 never happens in New York.
  assert.equal(zonedInstant("2026-03-08", "02:30", "America/New_York"), null);
  assert.equal(zonedInstant("2026-03-08", "03:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  // US fall-back 2026-11-01: 01:30 happens at EDT (05:30Z) and again at EST (06:30Z).
  assert.equal(zonedInstant("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
});

test("zonedInstant refuses malformed or impossible input rather than rolling it over", () => {
  for (const [day, time] of [["2026-02-30", "09:00"], ["2026-13-01", "09:00"], ["2026-10-01", "24:00"], ["2026-10-01", "9:30"], ["10/01/2026", "09:30"]]) {
    assert.equal(zonedInstant(day!, time!, "America/Chicago"), null, `${day} ${time}`);
  }
});
