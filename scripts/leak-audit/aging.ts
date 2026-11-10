/**
 * A/R aging export -> AgingRow[]. Strict on purpose: a column it cannot read is an error that names
 * the line, never a guessed value, because a wrong filing date silently becomes a wrong statutory
 * finding.
 *
 * Required header names (case-insensitive): claim, payer, service_date, billed, balance.
 * Optional: submitted_date, channel (electronic | paper). A missing optional column is honest: the
 * engine then reports the dependent checks as not assessed instead of assuming.
 *
 * What it tolerates is the FORMAT of a real export, never its values: a tab-delimited `.txt` (what
 * Open Dental's query window writes), UTF-16 from Excel's "Unicode Text", a title or date-range line
 * above the header, a "Total" row, a group heading with no claim on it, amounts in accounting
 * parentheses, and a date with a time after it. Every line left out is counted and named by line
 * number, so nothing leaves the audit unseen.
 */
import { parseCsv } from "../../modules/verification/src/engine/schedule-csv.ts";
import type { AgingRow } from "./engine.ts";

const REQUIRED = ["claim", "payer", "service_date", "billed", "balance"] as const;
const OPTIONAL = ["submitted_date", "channel"] as const;
export type AgingColumn = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];
const ALL_COLUMNS: readonly AgingColumn[] = [...REQUIRED, ...OPTIONAL];

/** How far down a report title and filter lines may push the header. */
const HEADER_SEARCH_ROWS = 30;
/** "Total", "Grand Total", "Subtotal:", "Delta Dental Total". Not "Total Dental Administrators". */
const TOTAL_LABEL = /^(?:(?:grand|sub-?)\s*)?totals?:?$|\s(?:sub-?)?totals?:?$/i;

/**
 * Which header in the practice's own export holds each field. Practice-management exports name
 * their columns however they like ("Claim #", "Carrier", "Date Sent"), and no alias list is guessed
 * here: a person who has looked at the file says which column is which, once, and a wrong guess
 * about a filing date never becomes a wrong statutory finding.
 */
export type AgingColumnMap = Partial<Record<AgingColumn, string>>;

/** What was read, and what was deliberately left out, so the report can say so. */
export interface AgingRead {
  rows: AgingRow[];
  encoding: string;
  delimiter: "comma" | "tab";
  /** 1-based line the header was found on. */
  headerLine: number;
  /** Total rows recognised and left out, by line. */
  totalLines: number[];
  /** Rows of one cell with no date and no amount (a group heading such as a carrier name), by line. */
  headingLines: number[];
}

/** `claim=Claim #;payer=Carrier;service_date=DOS` → a column map. Refuses unknown field names. */
export function parseColumnMap(spec: string): AgingColumnMap {
  const map: AgingColumnMap = {};
  for (const part of spec.split(";")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    const field = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    const header = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (!(ALL_COLUMNS as readonly string[]).includes(field)) {
      throw new Error(`Unknown aging field "${field}". Fields: ${ALL_COLUMNS.join(", ")}.`);
    }
    if (header === "") throw new Error(`Aging field "${field}" is mapped to an empty header. Write it as ${field}=<header in your file>.`);
    map[field as AgingColumn] = header;
  }
  return map;
}

/**
 * The file's bytes as text. Excel's "Unicode Text" is UTF-16 with a byte-order mark; an older
 * "Text (Tab delimited)" or CSV save is Windows-1252, where a patient or carrier name with an accent
 * is not valid UTF-8. Decoded by what the bytes are, never by the file's name.
 */
export function decodeAging(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "UTF-16LE" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "UTF-16BE" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

/** A date, optionally followed by the time a spreadsheet or a DATETIME column puts after it. */
const WITH_TIME = /^(\S+?)(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp]\.?[Mm]\.?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDay(raw: string, line: number, field: string): string {
  const v = (WITH_TIME.exec(raw.trim())?.[1] ?? raw).trim();
  if (v === "") throw new Error(`Line ${line}: ${field} is empty.`);
  let y: number;
  let mo: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else if (us) {
    y = Number(us[3]);
    mo = Number(us[1]);
    d = Number(us[2]);
  } else {
    throw new Error(`Line ${line}: ${field} "${raw}" is not YYYY-MM-DD or M/D/YYYY. Two-digit years are refused.`);
  }
  if (y < 1900) {
    throw new Error(
      `Line ${line}: ${field} "${raw}" is not a plausible date.` +
        (y === 1 ? " Open Dental writes 01/01/0001 for no date: a preauthorization, or a claim never sent. Leave those out of the export." : "")
    );
  }
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error(`Line ${line}: ${field} "${raw}" is not a real calendar day.`);
  }
  return t.toISOString().slice(0, 10);
}

/** `1,234.50`, `$1,234.50`, `-12.5`, and the accounting form `(12.50)` for a negative. */
function parseMoney(raw: string, line: number, field: string): number {
  let v = raw.trim().replace(/[$,\s]/g, "");
  const paren = /^\((.*)\)$/.exec(v);
  if (paren) v = paren[1]!;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m || (paren && m[1] === "-")) throw new Error(`Line ${line}: ${field} "${raw}" is not an amount.`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || "0");
  return (paren || m[1] === "-") && cents !== 0 ? -cents : cents;
}

type Rows = { line: number; cells: string[] }[];

function indexHeader(cells: readonly string[], columns: AgingColumnMap): Map<AgingColumn, number> {
  const header = cells.map((c) => c.trim().toLowerCase());
  const index = new Map<AgingColumn, number>();
  for (const field of ALL_COLUMNS) {
    const i = header.indexOf((columns[field] ?? field).toLowerCase());
    if (i >= 0) index.set(field, i);
  }
  return index;
}

/** The first row near the top that names every required column, or null. */
function findHeader(rows: Rows, columns: AgingColumnMap): { at: number; index: Map<AgingColumn, number> } | null {
  for (let at = 0; at < Math.min(rows.length, HEADER_SEARCH_ROWS); at++) {
    const index = indexHeader(rows[at]!.cells, columns);
    if (REQUIRED.every((f) => index.has(f))) return { at, index };
  }
  return null;
}

/** No header anywhere: say which columns are missing from the row that came closest. */
function noHeaderError(rows: Rows, columns: AgingColumnMap): Error {
  let best = 0;
  let bestCount = -1;
  for (let at = 0; at < Math.min(rows.length, HEADER_SEARCH_ROWS); at++) {
    const index = indexHeader(rows[at]!.cells, columns);
    const count = REQUIRED.filter((f) => index.has(f)).length;
    if (count > bestCount) [best, bestCount] = [at, count];
  }
  const found = rows[best]!.cells.map((c) => c.trim());
  const index = indexHeader(rows[best]!.cells, columns);
  const absent = REQUIRED.filter((r) => !index.has(r));
  const lower = rows.slice(0, HEADER_SEARCH_ROWS).flatMap((r) => r.cells.map((c) => c.trim().toLowerCase()));
  const openDentalOutstanding = lower.includes("patname") && lower.includes("datesentorig");
  return new Error(
    `The aging file has ${absent.map((a) => (columns[a] ? `no "${columns[a]}" column (mapped to ${a})` : `no "${a}" column`)).join(", ")}. ` +
      `Headers found${best > 0 ? ` (line ${rows[best]!.line})` : ""}: ${found.join(", ")}. ` +
      (openDentalOutstanding
        ? "This looks like Open Dental's Outstanding Insurance Claims report. It carries no claim number and no paid claims, " +
          "so it cannot be joined to the 835s: export with the query in docs/pilot/exports/open-dental.md instead."
        : `Rename them, or map them with --aging-columns "${absent.map((a) => `${a}=<header>`).join(";")}".`)
  );
}

export function readAging(input: string | Uint8Array, columns: AgingColumnMap = {}): AgingRead {
  const { text, encoding } = typeof input === "string" ? { text: input, encoding: "UTF-8" } : decodeAging(input);
  // Comma first, then tab. A header can only be found under the file's own delimiter: under the
  // other one it is a single cell, or names split mid-word, and never every required column.
  let parsed: { delimiter: "comma" | "tab"; rows: Rows; header: NonNullable<ReturnType<typeof findHeader>> } | null = null;
  let first: Rows | null = null;
  let firstError: unknown = null;
  for (const [delimiter, ch] of [["comma", ","], ["tab", "\t"]] as const) {
    let rows: Rows;
    try {
      rows = parseCsv(text, ch);
    } catch (e) {
      firstError ??= e;
      continue;
    }
    if (rows.length === 0) throw new Error("The aging file is empty.");
    if (!first || rows[0]!.cells.length > first[0]!.cells.length) first = rows;
    const header = findHeader(rows, columns);
    if (header) {
      parsed = { delimiter, rows, header };
      break;
    }
  }
  if (!parsed) {
    if (!first) throw firstError;
    throw noHeaderError(first, columns);
  }
  const { rows, header, delimiter } = parsed;
  const index = header.index;
  for (const field of OPTIONAL) {
    const mapped = columns[field];
    if (mapped !== undefined && !index.has(field)) {
      throw new Error(`The aging file has no "${mapped}" column (mapped to ${field}). Headers found: ${rows[header.at]!.cells.map((c) => c.trim()).join(", ")}.`);
    }
  }
  const at = (name: AgingColumn): number => index.get(name) ?? -1;
  const seen = new Set<string>();
  const out: AgingRow[] = [];
  const totalLines: number[] = [];
  const headingLines: number[] = [];
  for (const { line, cells } of rows.slice(header.at + 1)) {
    if (cells.every((c) => c.trim() === "")) continue; // a trailing blank row in a spreadsheet export
    const get = (name: AgingColumn): string => (at(name) < 0 ? "" : (cells[at(name)] ?? "").trim());
    const claim = get("claim");
    // A summary row carries a "Total" label and no service date. A real claim always has a date.
    if ((claim === "" || TOTAL_LABEL.test(claim)) && get("service_date") === "" && cells.some((c) => TOTAL_LABEL.test(c.trim()))) {
      totalLines.push(line);
      continue;
    }
    // A group heading (a carrier's name above its claims, in whichever column) is one cell with no
    // date and no amount beside it. It is listed by line in the report, so a reader can check it.
    if (get("service_date") === "" && get("billed") === "" && get("balance") === "" && cells.filter((c) => c.trim() !== "").length === 1) {
      headingLines.push(line);
      continue;
    }
    if (!claim) throw new Error(`Line ${line}: claim is empty.`);
    if (seen.has(claim)) throw new Error(`Line ${line}: claim "${claim}" appears twice.`);
    seen.add(claim);
    const channelRaw = get("channel").toLowerCase();
    if (channelRaw !== "" && channelRaw !== "electronic" && channelRaw !== "paper") {
      throw new Error(`Line ${line}: channel "${channelRaw}" must be electronic or paper.`);
    }
    out.push({
      claim,
      payer: get("payer"),
      serviceDate: parseDay(get("service_date"), line, "service_date"),
      submittedOn: get("submitted_date") ? parseDay(get("submitted_date"), line, "submitted_date") : null,
      channel: channelRaw === "" ? null : (channelRaw as "electronic" | "paper"),
      billedCents: parseMoney(get("billed"), line, "billed"),
      balanceCents: parseMoney(get("balance"), line, "balance"),
    });
  }
  return { rows: out, encoding, delimiter, headerLine: rows[header.at]!.line, totalLines, headingLines };
}

export function parseAging(text: string, columns: AgingColumnMap = {}): AgingRow[] {
  return readAging(text, columns).rows;
}

/** One line for the report's file list: what was read, and every line deliberately left out. */
export function describeAgingRead(r: AgingRead): string {
  const lines = (ns: number[]): string => (ns.length <= 10 ? ns.join(", ") : `${ns.slice(0, 10).join(", ")} and ${ns.length - 10} more`);
  const parts = [`${r.rows.length} claim${r.rows.length === 1 ? "" : "s"} read, ${r.delimiter === "tab" ? "tab-delimited" : "comma-delimited"}, ${r.encoding}`];
  if (r.headerLine > 1) parts.push(`header on line ${r.headerLine}; the ${r.headerLine - 1} line${r.headerLine === 2 ? "" : "s"} above it not read`);
  if (r.totalLines.length > 0) parts.push(`total row${r.totalLines.length === 1 ? "" : "s"} left out (line ${lines(r.totalLines)})`);
  if (r.headingLines.length > 0) parts.push(`group heading${r.headingLines.length === 1 ? "" : "s"} with no date or amount left out (line ${lines(r.headingLines)})`);
  return parts.join("; ") + ".";
}

export function agingToCsv(rows: readonly AgingRow[]): string {
  const money = (c: number): string => `${Math.trunc(c / 100)}.${String(Math.abs(c % 100)).padStart(2, "0")}`;
  const lines = ["claim,payer,service_date,submitted_date,channel,billed,balance"];
  for (const r of rows) {
    lines.push(
      [r.claim, r.payer, r.serviceDate, r.submittedOn ?? "", r.channel ?? "", money(r.billedCents), money(r.balanceCents)].join(",")
    );
  }
  return lines.join("\n") + "\n";
}
