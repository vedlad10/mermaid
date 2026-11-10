/**
 * Calendar days, in the practice's own timezone.
 *
 * ── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────────────────────────
 * `platform/db/pool.ts` already refuses to let Postgres turn a `DATE` into an instant, and says why:
 * "a service date or a filing deadline can move by a day — which in this domain means a claim filed
 * against the wrong date of service, or a timely-filing deadline computed a day early or late."
 *
 * The deadline engines then reintroduced exactly that, one layer up. They answered "what day is it
 * today?" with `now.toISOString().slice(0, 10)` — the day in UTC, which is not the day in the room
 * where the claim is being filed. For a US Pacific practice the two disagree from late afternoon
 * onward, so a claim on its final filing day was reported:
 *
 *     20:00 Pacific → daysRemaining = -1, "The filing deadline passed 1 day ago —
 *                     this payer will refuse the claim."
 *
 * It was still filable for another four hours. A biller reading that abandons revenue the payer
 * would have paid, and evening is exactly when end-of-day filing sweeps run. East of UTC the error
 * runs the other way and is worse: a claim reads filable a day after the payer stopped accepting it.
 *
 * A deadline is a calendar day in a place. Comparing it to an instant without naming the place is
 * the same category error the driver layer already rejects.
 */

/** IANA timezone name, e.g. `America/Los_Angeles`. `UTC` is always valid. */
export type TimeZone = string;

/**
 * The calendar day (`YYYY-MM-DD`) that `instant` falls on, in `timeZone`.
 *
 * `en-CA` is used because its short date format IS ISO order; formatting to parts and reassembling
 * would be equivalent but slower and no clearer. Node ships full ICU, so every IANA zone resolves.
 */
export function calendarDay(instant: Date, timeZone: TimeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** The wall-clock reading of `ms` in `timeZone`, re-expressed as if that reading were UTC. */
function wallClockAsUtc(ms: number, timeZone: TimeZone): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
}

/**
 * The instant at which the clocks in `timeZone` read `day` + `time` — the inverse of `calendarDay`.
 *
 * A schedule exported from a practice's system says "Oct 1, 9:30" and means 9:30 in that practice.
 * Reading it as UTC files a Chicago morning visit five hours early, which lands an evening one on
 * the wrong day. This is the one place that conversion is done.
 *
 * ── THE TWO HOURS A YEAR THAT HAVE NO SINGLE ANSWER ────────────────────────────────────────────
 * A local time the clocks SKIP (02:30 on a spring-forward night) never happens: `null`, so the
 * caller rejects the row instead of shifting it an hour. A local time the clocks pass TWICE (01:30
 * on a fall-back night) is resolved to the EARLIER instant, stated here so it is a decision rather
 * than whichever guess the arithmetic reached first.
 *
 * @param day  `YYYY-MM-DD`
 * @param time `HH:MM`, 24-hour
 * @returns ISO instant (`…Z`), or null when that local time does not exist or the input is malformed
 */
export function zonedInstant(day: string, time: string, timeZone: TimeZone = "UTC"): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (h > 23 || mi > 59) return null;
  const target = Date.UTC(y, mo - 1, da, h, mi);
  // Rejects Feb 30 and friends: Date.UTC rolls them over silently.
  if (new Date(target).getUTCDate() !== da || new Date(target).getUTCMonth() !== mo - 1) return null;

  // An offset is at most a day, so every instant whose wall clock can read `target` lies within
  // one offset of it. Try the offsets in force a day either side and keep the ones that land.
  const candidates = new Set<number>();
  for (const probe of [target - 86_400_000, target, target + 86_400_000]) {
    const guess = target - (wallClockAsUtc(probe, timeZone) - probe);
    if (wallClockAsUtc(guess, timeZone) === target) candidates.add(guess);
  }
  if (candidates.size === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

/**
 * Whole days from `fromDay` to `toDay`, both `YYYY-MM-DD`. Negative when `toDay` is in the past.
 *
 * Both are anchored at UTC midnight before subtracting, which is safe precisely BECAUSE they are
 * already calendar days rather than instants: no zone is involved, so no DST transition can make a
 * "day" 23 or 25 hours long and round the difference to the wrong integer.
 */
export function daysBetween(fromDay: string, toDay: string): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const from = Date.parse(`${fromDay.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toDay.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

/**
 * Validate an IANA timezone name, or throw.
 *
 * Called at configuration time rather than per request: a typo in `PRACTICE_TIMEZONE` would
 * otherwise surface as `RangeError` from deep inside a deadline calculation, on the one code path
 * whose failure costs a claim.
 */
export function assertValidTimeZone(timeZone: string): void {
  const name = timeZone.trim();

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name }).format(new Date(0));
  } catch {
    throw new Error(
      `FATAL: "${timeZone}" is not a recognised IANA timezone. Filing and appeal deadlines are ` +
        `calendar days in the practice's own timezone; a wrong one moves every deadline by a day. ` +
        `Use a name like "America/Los_Angeles".`
    );
  }

  /**
   * ICU accepts the legacy abbreviations, and they are a trap.
   *
   * `EST` and `PST` resolve — but they are FIXED-OFFSET zones that do not observe daylight time. A
   * New York practice that sets `PRACTICE_TIMEZONE=EST` is an hour adrift for roughly eight months
   * of the year, and an hour is enough to change the calendar day for anything happening near
   * midnight. It fails silently and it looks completely reasonable in a config file, which is the
   * combination worth refusing outright.
   *
   * `UTC` is exempt: it is fixed by definition and is the honest default for a deployment that has
   * genuinely not been told where the practice is.
   */
  if (name.toUpperCase() !== "UTC" && !name.includes("/")) {
    throw new Error(
      `FATAL: "${timeZone}" is a fixed-offset abbreviation, not a region. It does not observe ` +
        `daylight saving, so deadlines drift by an hour for most of the year and can land on the ` +
        `wrong calendar day. Use the region name — "America/New_York", not "EST".`
    );
  }
}
