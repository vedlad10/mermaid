/**
 * A practice's schedule export, read into `ScheduledVisit`s — the CSV source (stage 4).
 *
 * Pure: text in, visits and refusals out. Nothing here writes; `AppointmentService.sync` is still the
 * one door, and it re-validates every visit this produces.
 *
 * ── ANY SYSTEM'S EXPORT, BY ITS COLUMN NAMES ─────────────────────────────────────────────────────
 * Dentrix, Eaglesoft and Open Dental each name their columns differently, and a practice may have
 * customised theirs. So columns are matched by a list of known names (`ALIASES`), and whatever that
 * guesses, a person can override before anything is imported. A required column that is neither
 * detected nor mapped stops the whole file: without an appointment id there is no identity to make a
 * re-import idempotent, and without a date there is no visit.
 *
 * ── A ROW IS READ STRICTLY, OR REFUSED WITH ITS LINE NUMBER ──────────────────────────────────────
 * The failures that matter are the quiet ones: `03/04/2026` read as 3 April when the practice meant
 * 4 March, `9:30` read as UTC, `75` read as a birth year of 2075, a `$1,250` fee read as 1 dollar.
 * Each parser here accepts the forms a US practice-management export actually produces and refuses
 * everything else, because a visit filed on the wrong day is worse than a visit the importer asked a
 * person about.
 *
 *   dates     YYYY-MM-DD, or M/D/YYYY (US order — these are US systems). Two-digit years refused.
 *   times     9:30 AM, 9:30am, 09:30, 14:30, 9:30:00 PM. Converted with the PRACTICE's time zone.
 *   money     1250, 1250.00, $1,250.00. Never negative.
 *   codes     CDT codes (D + four digits), separated by commas, semicolons or spaces.
 */
import { zonedInstant } from "@mermaid/shared";
import type { AppointmentStatus, ScheduledVisit } from "../appointments.ts";

/**
 * The most rows one import reads — a month for a busy practice. Not larger: the import is one
 * transaction of a few statements per row against a remote database, and a hosted request has about
 * a hundred seconds before the platform abandons it. A year of schedule is a mistake, not a batch.
 */
export const MAX_IMPORT_ROWS = 2000;

export type ImportField =
  | "externalId"
  | "date"
  | "time"
  | "firstName"
  | "lastName"
  | "patientName"
  | "dateOfBirth"
  | "provider"
  | "status"
  | "procedures"
  | "production"
  | "duration";

export const IMPORT_FIELDS: readonly { key: ImportField; label: string; required: boolean }[] = [
  { key: "externalId", label: "Appointment ID", required: true },
  { key: "date", label: "Date", required: true },
  { key: "time", label: "Time", required: true },
  { key: "firstName", label: "Patient first name", required: false },
  { key: "lastName", label: "Patient last name", required: false },
  { key: "patientName", label: "Patient name (Last, First)", required: false },
  { key: "dateOfBirth", label: "Date of birth", required: true },
  { key: "provider", label: "Provider", required: false },
  { key: "status", label: "Status", required: false },
  { key: "procedures", label: "Procedures (CDT codes)", required: false },
  { key: "production", label: "Scheduled production", required: false },
  { key: "duration", label: "Length (minutes)", required: false },
];

/**
 * Header names seen in the wild, normalised (lower case, letters and digits only). The first
 * matching column wins; a person can always override.
 */
const ALIASES: Record<ImportField, string[]> = {
  externalId: ["appointmentid", "apptid", "aptnum", "appointmentnumber", "apptnum", "appointmentno", "apptno", "id"],
  date: ["date", "appointmentdate", "apptdate", "aptdate", "scheduleddate", "visitdate"],
  time: ["time", "appointmenttime", "appttime", "apttime", "starttime", "start"],
  firstName: ["firstname", "patientfirstname", "patfirstname", "fname", "first"],
  lastName: ["lastname", "patientlastname", "patlastname", "lname", "last"],
  patientName: ["patient", "patientname", "name", "patname"],
  dateOfBirth: ["dateofbirth", "dob", "birthdate", "birthday", "patientdob", "patientbirthdate"],
  provider: ["provider", "providername", "prov", "doctor", "dentist", "hygienist", "provabbr"],
  status: ["status", "appointmentstatus", "apptstatus", "aptstatus", "confirmed", "confirmation"],
  procedures: ["procedures", "procedurecodes", "procs", "codes", "cdtcodes", "adacodes", "proccodes", "procedure"],
  production: ["production", "scheduledproduction", "schedprod", "prod", "amount", "fee", "fees", "total", "estproduction"],
  duration: ["duration", "length", "minutes", "lengthminutes", "durationminutes", "apptlength"],
};

const normHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/* ── CSV ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * RFC 4180, as exports actually write it: a byte-order mark, CRLF or LF, fields quoted with `"`
 * and quotes doubled inside them, embedded newlines inside quotes. Blank lines are dropped.
 * Returns each record with the 1-based line it STARTED on, so a refusal can name it.
 * `delimiter` is a tab for the tab-delimited `.txt` exports practice software writes; quoting is
 * the same.
 */
export function parseCsv(text: string, delimiter: "," | "\t" = ","): { line: number; cells: string[] }[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endRecord = () => {
    cells.push(field);
    if (!(cells.length === 1 && cells[0]!.trim() === "")) out.push({ line: start, cells });
    cells = [];
    field = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      // A line break inside a quoted field is normalised like one between records: CRLF → LF.
      if (c === "\r" && src[i + 1] === "\n") { i += 1; continue; }
      if (c === "\n") line += 1;
      field += c; i += 1; continue;
    }
    if (c === '"' && field === "") { quoted = true; i += 1; continue; }
    if (c === delimiter) { cells.push(field); field = ""; i += 1; continue; }
    if (c === "\r") { i += 1; continue; }
    if (c === "\n") { endRecord(); line += 1; start = line; i += 1; continue; }
    field += c; i += 1;
  }
  if (quoted) throw new Error(`The file ends inside a quoted field that began on line ${start}.`);
  if (field !== "" || cells.length > 0) endRecord();
  return out;
}

/* ── Mapping ─────────────────────────────────────────────────────────────────────────────────── */

/** Field → the header it is read from. Null when no column is used for it. */
export type ColumnMapping = Record<ImportField, string | null>;

export function detectMapping(headers: readonly string[]): ColumnMapping {
  const norm = headers.map(normHeader);
  const taken = new Set<number>();
  const mapping = {} as ColumnMapping;
  for (const f of IMPORT_FIELDS) {
    const idx = ALIASES[f.key].map((a) => norm.findIndex((h, i) => h === a && !taken.has(i))).find((i) => i >= 0);
    if (idx !== undefined) {
      taken.add(idx);
      mapping[f.key] = headers[idx]!;
    } else {
      mapping[f.key] = null;
    }
  }
  // A split name wins over a combined one; a combined "Patient" column is only used when it must be.
  if (mapping.firstName && mapping.lastName) mapping.patientName = null;
  return mapping;
}

/** What stops the whole file, in words — an empty list means it can be read row by row. */
export function mappingProblems(mapping: ColumnMapping, headers: readonly string[]): string[] {
  const problems: string[] = [];
  for (const f of IMPORT_FIELDS) {
    const h = mapping[f.key];
    if (h !== null && !headers.includes(h)) problems.push(`"${h}" is mapped to ${f.label} but is not a column in this file.`);
    if (f.required && !h) problems.push(`No column is mapped to ${f.label}.`);
  }
  if (!(mapping.firstName && mapping.lastName) && !mapping.patientName) {
    problems.push("Map either Patient first name and Patient last name, or Patient name (Last, First).");
  }
  const used = Object.values(mapping).filter((h): h is string => Boolean(h));
  const dupes = used.filter((h, i) => used.indexOf(h) !== i);
  for (const d of new Set(dupes)) problems.push(`"${d}" is mapped to more than one field.`);
  return problems;
}

/* ── Values ──────────────────────────────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD`, or null. M/D/YYYY is read in US order; two-digit years are refused, not guessed. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `HH:MM` on a 24-hour clock, or null. */
export function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s?(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!match) return null;
  let h = Number(match[1]);
  const mi = Number(match[2]);
  const meridiem = match[3]?.replace(/\./g, "");
  if (mi > 59) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    if (meridiem === "am" && h === 12) h = 0;
    if (meridiem === "pm" && h !== 12) h += 12;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Whole cents from a dollar amount as exports write it, or null. Never negative, never a float. */
export function parseMoney(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
}

const STATUS_WORDS: Record<string, AppointmentStatus> = {
  "": "scheduled", scheduled: "scheduled", booked: "scheduled", confirmed: "scheduled", unconfirmed: "scheduled",
  "not confirmed": "scheduled", pending: "scheduled", arrived: "scheduled", "in chair": "scheduled", seated: "scheduled",
  complete: "completed", completed: "completed", done: "completed", "checked out": "completed", checkedout: "completed",
  cancelled: "cancelled", canceled: "cancelled", broken: "cancelled", deleted: "cancelled", unscheduled: "cancelled",
  "no show": "no-show", "no-show": "no-show", noshow: "no-show", missed: "no-show", failed: "no-show",
};

export function parseStatus(raw: string): AppointmentStatus | null {
  return STATUS_WORDS[raw.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** CDT codes, or null when any token is not one — a stray word is a question, not a code. */
export function parseProcedures(raw: string): string[] | null {
  const tokens = raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const codes: string[] = [];
  for (const t of tokens) {
    if (!/^D\d{4}$/i.test(t)) return null;
    codes.push(t.toUpperCase());
  }
  return codes;
}

/* ── Rows ────────────────────────────────────────────────────────────────────────────────────── */

export interface ImportRow {
  /** The line of the file the row started on, so a person can find it. */
  line: number;
  visit: ScheduledVisit | null;
  problem: string | null;
}

export interface ImportPlan {
  headers: string[];
  mapping: ColumnMapping;
  /** Problems with the FILE — any one of them means nothing is imported. */
  fileProblems: string[];
  rows: ImportRow[];
}

/**
 * Read a whole export. `override` replaces the detected mapping field by field (null clears one).
 * Throws only on text that is not CSV at all; everything else is a stated problem.
 */
export function planScheduleImport(text: string, timeZone: string, override: Partial<ColumnMapping> = {}): ImportPlan {
  const records = parseCsv(text);
  if (records.length === 0) {
    return { headers: [], mapping: detectMapping([]), fileProblems: ["The file is empty."], rows: [] };
  }
  const headers = records[0]!.cells.map((h) => h.trim());
  const mapping: ColumnMapping = { ...detectMapping(headers) };
  for (const [k, v] of Object.entries(override) as [ImportField, string | null | undefined][]) {
    if (v !== undefined && k in mapping) mapping[k] = v === "" ? null : v;
  }
  const fileProblems = mappingProblems(mapping, headers);
  const body = records.slice(1);
  if (body.length === 0) fileProblems.push("The file has a header row and no appointments.");
  if (body.length > MAX_IMPORT_ROWS) {
    fileProblems.push(`The file has ${body.length} appointments; one import reads at most ${MAX_IMPORT_ROWS}. Export a shorter date range.`);
  }
  if (fileProblems.length > 0) return { headers, mapping, fileProblems, rows: [] };

  const col = (f: ImportField) => (mapping[f] ? headers.indexOf(mapping[f]!) : -1);
  const idx = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, col(f.key)])) as Record<ImportField, number>;

  const rows = body.map(({ line, cells }): ImportRow => {
    const get = (f: ImportField) => (idx[f] >= 0 ? (cells[idx[f]] ?? "").trim() : "");
    const refuse = (problem: string): ImportRow => ({ line, visit: null, problem });

    const externalId = get("externalId");
    if (!externalId) return refuse("No appointment ID.");

    const day = parseDate(get("date"));
    if (!day) return refuse(`Date "${get("date")}" is not a date this importer reads (use M/D/YYYY or YYYY-MM-DD).`);
    const time = parseTime(get("time"));
    if (!time) return refuse(`Time "${get("time")}" is not a time this importer reads (use 9:30 AM or 14:30).`);
    const scheduledFor = zonedInstant(day, time, timeZone);
    if (!scheduledFor) return refuse(`${day} ${time} does not exist in ${timeZone} — the clocks skip that hour.`);

    let firstName = get("firstName");
    let lastName = get("lastName");
    if (!(idx.firstName >= 0 && idx.lastName >= 0)) {
      const whole = get("patientName");
      const comma = /^([^,]+),\s*(.+)$/.exec(whole);
      if (!comma) return refuse(`Patient "${whole}" is not in "Last, First" form, so first and last name cannot be told apart.`);
      lastName = comma[1]!.trim();
      firstName = comma[2]!.trim();
    }
    if (!firstName || !lastName) return refuse("Patient name is missing.");

    const dateOfBirth = parseDate(get("dateOfBirth"));
    if (!dateOfBirth) return refuse(`Date of birth "${get("dateOfBirth")}" is not a date this importer reads.`);

    let status: AppointmentStatus = "scheduled";
    if (idx.status >= 0) {
      const s = parseStatus(get("status"));
      if (!s) return refuse(`Status "${get("status")}" is not one this importer knows.`);
      status = s;
    }

    let codes: string[] = [];
    if (idx.procedures >= 0) {
      const c = parseProcedures(get("procedures"));
      if (!c) return refuse(`Procedures "${get("procedures")}" contain something that is not a CDT code.`);
      codes = c;
    }

    let statedProductionCents: number | null = null;
    if (idx.production >= 0 && get("production") !== "") {
      statedProductionCents = parseMoney(get("production"));
      if (statedProductionCents === null) return refuse(`Production "${get("production")}" is not an amount.`);
    }

    let durationMinutes: number | null = null;
    if (idx.duration >= 0 && get("duration") !== "") {
      const n = Number(get("duration"));
      if (!Number.isInteger(n) || n <= 0) return refuse(`Length "${get("duration")}" is not a whole number of minutes.`);
      durationMinutes = n;
    }

    return {
      line,
      problem: null,
      visit: {
        externalId,
        scheduledFor,
        durationMinutes,
        provider: get("provider") || null,
        status,
        patient: { firstName, lastName, dateOfBirth },
        // The export states a total, not a fee per code — kept as the export's own number.
        plannedProcedures: codes.map((code) => ({ code, feeCents: null })),
        statedProductionCents,
      },
    };
  });

  /*
   * The same appointment twice in one file is a question about the file, not two visits — and not
   * one visit either. Keeping the first would silently pick a winner between two rows that may
   * disagree about the time or the patient, so EVERY occurrence is refused and each names the others.
   */
  const lines = new Map<string, number[]>();
  for (const r of rows) if (r.visit) lines.set(r.visit.externalId, [...(lines.get(r.visit.externalId) ?? []), r.line]);
  for (const r of rows) {
    const all = r.visit ? lines.get(r.visit.externalId)! : [];
    if (all.length > 1) {
      r.problem = `Appointment ID "${r.visit!.externalId}" appears on lines ${all.join(", ")}; none of them was imported.`;
      r.visit = null;
    }
  }
  return { headers, mapping, fileProblems: [], rows };
}
