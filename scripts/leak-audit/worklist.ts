/**
 * The findings as a worklist a biller opens in a spreadsheet and works down: one row per finding,
 * with blank status / owner / notes columns to fill in. Pure, so the same report always renders the
 * same bytes.
 *
 * Two rules:
 *   · Payer names and claim numbers come from files the practice did not write (a payer's 835). A
 *     cell that begins with = + - @ is a formula to a spreadsheet, so every text cell that could
 *     begin that way is prefixed with an apostrophe. The estimate column is a plain number, so it
 *     still sums.
 *   · The bucket is its own column, so nobody sums estimated-recoverable, at-stake and
 *     avoidable-cost into one figure by accident: they are different kinds of number.
 */
import type { AuditReport } from "./engine.ts";

const HEADER = [
  "id",
  "category",
  "bucket",
  "confidence",
  "claim",
  "payer",
  "cdt_code",
  "date",
  "estimate_usd",
  "next_step",
  "evidence",
  "caveats",
  "synthetic",
  "status",
  "owner",
  "notes",
] as const;

/** Neutralise spreadsheet formulas, then quote per RFC 4180. */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const dollars = (cents: number | null): string => {
  if (cents === null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

export function renderWorklistCsv(r: AuditReport): string {
  const lines = [HEADER.join(",")];
  for (const f of r.findings) {
    lines.push(
      [
        csvText(f.id),
        csvText(f.category),
        csvText(f.bucket),
        csvText(f.confidence),
        csvText(f.claim ?? ""),
        csvText(f.payer),
        csvText(f.cdtCode ?? ""),
        csvText(f.date ?? ""),
        dollars(f.estimatedCents),
        csvText(f.action),
        csvText(f.evidence.join(" | ")),
        csvText(f.caveats.join(" | ")),
        f.synthetic ? "yes" : "no",
        "",
        "",
        "",
      ].join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
