/**
 * Retrospective revenue-leak audit: command line.
 *
 *   node scripts/revenue-leak-audit.ts --synthetic --out docs/pilot/synthetic-audit
 *   node scripts/revenue-leak-audit.ts --era-dir <dir> --aging <csv> --state NJ --as-of 2026-09-30 \
 *        --practice-label "<name>" --safeguards-attestation <file> --out <dir outside the repository>
 *
 * Synthetic mode needs nothing. Real-data mode REFUSES to read a single file unless a safeguards
 * attestation is supplied and complete (see docs/pilot/PILOT-PREREQUISITES.md). The attestation is a
 * speed bump and a record, not a security control: it exists so that reading real PHI is never an
 * accident of a command typed in a hurry. For the same reason a real report is never written inside
 * this repository, where it would be one `git add -A` from being committed.
 *
 * Writes report.html (the one to open), report.md, worklist.csv (one row per finding, for the
 * biller) and findings.json. Read-only otherwise: no network, no database.
 *
 * Exit codes: 0 written; 1 bad input; 2 usage; 3 refused (safeguards); 4 written, but a data check
 * failed and the report must not be shown to anyone until it is resolved.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditLeaks, type AdviceSource, type AuditReport } from "./leak-audit/engine.ts";
import { renderMarkdown, CHECK_WORD } from "./leak-audit/report.ts";
import { renderHtml } from "./leak-audit/report-html.ts";
import { renderWorklistCsv } from "./leak-audit/worklist.ts";
import { buildSyntheticDataset } from "./leak-audit/synthetic.ts";
import { agingToCsv, describeAgingRead, parseColumnMap, readAging } from "./leak-audit/aging.ts";
import { describe, readEra, readEraDir } from "./leak-audit/intake.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Every line the attestation file must contain, verbatim. */
export const REQUIRED_ATTESTATIONS: readonly string[] = [
  "BAA: executed",
  "Environment: dedicated, access-controlled, encrypted at rest",
  "PHI-key: managed outside the repository",
  "Retention: agreed and written down",
  "Compliance-review: completed",
  "Output-handling: reports are PHI and are stored as PHI",
];

export function missingAttestations(text: string): string[] {
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  return REQUIRED_ATTESTATIONS.filter((r) => !lines.has(r));
}

/** True when `path` is the repository or anywhere under it. Case-blind on Windows, like its file system. */
export function isInsideRepository(path: string, root: string = REPO_ROOT): boolean {
  const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(fold(resolve(root)), fold(resolve(path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

class UsageError extends Error {}

function writeReport(out: string, report: AuditReport): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.html"), renderHtml(report));
  writeFileSync(join(out, "report.md"), renderMarkdown(report));
  writeFileSync(join(out, "worklist.csv"), renderWorklistCsv(report));
  writeFileSync(join(out, "findings.json"), JSON.stringify(report, null, 2) + "\n");
}

/** The data checks, on the terminal: what a person must look at before opening the report. */
function printChecks(report: AuditReport): void {
  for (const c of report.dataChecks) {
    if (c.status === "ok") continue;
    console.error(`  ${CHECK_WORD[c.status].padEnd(13)} ${c.check}: ${c.detail}`);
  }
}

function main(): number {
  const out = arg("out");
  if (flag("synthetic")) {
    const target = out ?? "docs/pilot/synthetic-audit";
    const data = buildSyntheticDataset();
    const advices: AdviceSource[] = [];
    const files = data.advices.map((a) => {
      const r = readEra(a.file, a.raw);
      advices.push(...r.advices);
      return r.file;
    });
    const agingCsv = agingToCsv(data.aging);
    const report = auditLeaks(advices, data.aging, data.context, { files, aging: describe("aging.csv", agingCsv, 0, null) });
    writeReport(target, report);
    writeFileSync(join(target, "ground-truth.json"), JSON.stringify(data.truth, null, 2));
    writeFileSync(join(target, "aging.csv"), agingCsv);
    mkdirSync(join(target, "835"), { recursive: true });
    for (const a of data.advices) writeFileSync(join(target, "835", a.file), a.raw);
    console.log(
      `synthetic audit written to ${target}: ${report.findings.length} findings; ` +
        `estimated recoverable ${report.totals.estimatedRecoverableCents / 100} (ESTIMATED, NOT RECOVERED). Open ${join(target, "report.html")}.`
    );
    return 0;
  }

  const eraDir = arg("era-dir");
  const agingPath = arg("aging");
  const attestation = arg("safeguards-attestation");
  if (!eraDir || !agingPath) {
    throw new UsageError(
      "usage: --synthetic [--out <dir>] | --era-dir <dir> --aging <csv> --state <XX> --as-of <YYYY-MM-DD> " +
        "--safeguards-attestation <file> --out <dir outside the repository> " +
        '[--practice-label "<name>"] [--merchant-rate-bps <n>] [--aging-columns "claim=<header>;payer=<header>;..."]'
    );
  }
  // ── the safeguards come before anything is read ──
  if (!attestation || !existsSync(attestation)) {
    console.error(
      "REFUSING: real-data mode needs --safeguards-attestation <file>. " +
        "Do not read real patient data until the prerequisites in docs/pilot/PILOT-PREREQUISITES.md are met."
    );
    return 3;
  }
  const missing = missingAttestations(readFileSync(attestation, "utf8"));
  if (missing.length > 0) {
    console.error(`REFUSING: attestation incomplete. Missing lines:\n  ${missing.join("\n  ")}`);
    return 3;
  }
  if (!out) {
    throw new UsageError("--out <dir> is required in real-data mode: the report contains claim-level data and must go somewhere chosen, not a default.");
  }
  if (isInsideRepository(out)) {
    console.error(
      `REFUSING: --out ${out} is inside the repository (${REPO_ROOT}). A real report is PHI and must never sit one ` +
        "`git add` away from a commit. Write it to the encrypted location the attestation describes."
    );
    return 3;
  }

  // ── arguments that change what a finding says ──
  const asOf = arg("as-of");
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new UsageError("--as-of YYYY-MM-DD is required (reports are measured to a stated day, not to today).");
  }
  const stateArg = arg("state");
  if (stateArg !== undefined && !/^[A-Za-z]{2}$/.test(stateArg)) {
    throw new UsageError(`--state "${stateArg}" is not a two-letter state code.`);
  }
  const rateArg = arg("merchant-rate-bps");
  let merchantRateBps: number | null = null;
  if (rateArg !== undefined) {
    if (!/^\d+$/.test(rateArg) || Number(rateArg) > 10_000) {
      throw new UsageError(`--merchant-rate-bps "${rateArg}" must be a whole number of basis points, 0 to 10000 (2.9% is 290).`);
    }
    merchantRateBps = Number(rateArg);
  }
  const columnsArg = arg("aging-columns");
  const columns = columnsArg ? parseColumnMap(columnsArg) : {};

  if (!existsSync(eraDir)) throw new Error(`--era-dir ${eraDir} does not exist.`);
  if (!existsSync(agingPath)) throw new Error(`--aging ${agingPath} does not exist.`);
  const { advices, files } = readEraDir(eraDir);
  const agingBytes = readFileSync(agingPath);
  const agingRead = readAging(agingBytes, columns);
  const agingNote = describeAgingRead(agingRead);
  console.log(`aging export ${basename(agingPath)}: ${agingNote}`);
  const report = auditLeaks(
    advices,
    agingRead.rows,
    {
      practiceLabel: arg("practice-label") ?? "Practice",
      state: stateArg ? stateArg.toUpperCase() : null,
      asOf,
      merchantRateBps,
      synthetic: false,
    },
    { files, aging: describe(basename(agingPath), agingBytes, 0, null, agingNote) }
  );
  writeReport(out, report);
  console.log(
    `audit written to ${out}: ${report.findings.length} findings from ${report.inputs.uniqueAdvices} distinct remittances. ` +
      `Open ${join(out, "report.html")}. These files contain claim-level data; handle them as PHI.`
  );
  printChecks(report);
  if (report.dataChecks.some((c) => c.status === "fail")) {
    console.error("A data check FAILED: resolve it before this report is shown to anyone.");
    return 4;
  }
  return 0;
}

if (process.argv[1] && /revenue-leak-audit\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  try {
    process.exitCode = main();
  } catch (e) {
    // A person ran this; a stack trace tells them nothing they can act on. The message names the
    // file, the line or the flag.
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
