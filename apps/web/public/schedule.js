/**
 * The schedule's shared vocabulary — what each readiness state is CALLED and what colour it may
 * claim — for the two screens that draw appointments: Today's strip (§8.1) and Verify's readiness
 * timeline (§8.2).
 *
 * One module rather than two copies because the two screens describe the same visit, often side by
 * side in one session: a visit Today calls "Not verified" that Verify calls "Pending" is two answers
 * to one question, and the reader cannot tell which to believe.
 *
 * Readiness itself is computed on the server (engine/readiness.ts). Nothing here re-derives it; this
 * only chooses words and a tone for an answer that has already been given.
 */

/** The four groups §8.2 draws, bottom-up — the band needing a person always on top. */
export const READINESS_GROUPS = [
  { key: "verified", label: "Verified" },
  { key: "no-coverage", label: "No insurance on file" },
  { key: "pending", label: "Not ready", tone: "warning" },
  /* Critical, as §8.1 specifies for a failed verification: a visit treated against coverage the
     payer refused is money that WILL be lost unless someone acts before the patient sits down. */
  { key: "failed", label: "Coverage failed", tone: "critical" },
];

/** The finer state, in the words a front desk would use. */
const STATE_WORDS = {
  verified: "Verified",
  stale: "Out of date by the visit",
  unconfirmed: "Payer did not confirm",
  "needs-review": "Needs review",
  unverified: "Not checked",
  inactive: "Payer says inactive",
  failed: "Check failed",
  "no-coverage": "No insurance on file",
};

export const readinessWord = (r) => (r ? STATE_WORDS[r.state] ?? r.state : "—");

const DAY = 86_400_000;

/**
 * The colour a visit's readiness may claim, or null for the quiet default.
 *
 * Failed coverage is critical at any distance. Everything else a person must fix — not checked,
 * waiting on review, no insurance on file — is a warning only inside 24 hours, as §8.1 specifies:
 * an unverified visit next Thursday is the ordinary state of a schedule, not an alarm, and a strip
 * that painted every one of them amber would teach its reader to ignore amber.
 */
export function readinessTone(item, now = Date.now()) {
  const r = item.readiness;
  if (!r) return null;
  if (r.group === "failed") return "critical";
  if (r.group === "verified") return null;
  const until = Date.parse(item.scheduledFor) - now;
  return until <= DAY ? "warning" : null;
}

/** "9:30 AM" on the PRACTICE's clock — the server says which zone that is. */
export function clockTime(iso, timeZone) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone || "UTC" });
  } catch {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  }
}

/** `YYYY-MM-DD` + n days, as calendar arithmetic — a day, not 24 hours of instants. */
export const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * The schedule for `days` practice days starting today.
 *
 * The request window is widened by a day each side because the server's window is in instants and
 * the practice's day is not: a 7pm Chicago visit is tomorrow in UTC. The server stamps every visit
 * with its practice-local `day`, and that — not the instant — decides which day it belongs to.
 */
export async function fetchSchedule(api, days) {
  const now = Date.now();
  const from = new Date(now - DAY).toISOString();
  const to = new Date(now + (days + 1) * DAY).toISOString();
  const res = await api("GET", `/api/v1/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const today = res.today;
  const last = addDays(today, days - 1);
  return {
    today,
    timeZone: res.timeZone,
    items: (res.items ?? []).filter((a) => a.day >= today && a.day <= last),
  };
}

/**
 * Where these visits came from, as a label — or null when they are the practice's own feed.
 *
 * §1.5: provenance is part of the number. A demo schedule is invented, and a screen that listed it
 * without saying so would be presenting fiction as a practice's day.
 */
export function scheduleProvenance(items) {
  const mock = items.filter((a) => a.source === "mock").length;
  if (mock === 0) return null;
  return mock === items.length
    ? "Demo schedule — invented visits"
    : `${mock} demo ${mock === 1 ? "visit" : "visits"} mixed in`;
}
