/**
 * Reading the files a practice hands over. The only I/O in the audit besides writing the report.
 *
 * One unreadable file must not end the run: a month of ERAs with one truncated download is the
 * ordinary case, not the exception. Each file is read on its own, hashed (so the report can say
 * exactly what it read, PILOT-PREREQUISITES B4), and a failure is RECORDED against the file and
 * surfaced in the report's data checks, never skipped silently.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse835All } from "../../platform/edi/mock/x12-835.ts";
import type { AdviceSource, IntakeFile } from "./engine.ts";

const REMITTANCE_EXTENSION = /\.(835|edi|txt|x12)$/i;
/** Files an operating system or a sync client leaves in a folder. Not the practice's, not reported. */
const SYSTEM_FILE = /^(\.|desktop\.ini$|thumbs\.db$)/i;

export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function describe(name: string, bytes: Buffer | string, advices: number, error: string | null, note?: string): IntakeFile {
  return { name, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), advices, error, ...(note ? { note } : {}) };
}

/** Parse one file's text. Never throws: a failure comes back as the file's error. */
export function readEra(name: string, bytes: Buffer | string): { advices: AdviceSource[]; file: IntakeFile } {
  try {
    const advices = parse835All(bytes.toString()).map((parsed) => ({ source: name, parsed }));
    return { advices, file: describe(name, bytes, advices.length, null) };
  } catch (e) {
    return { advices: [], file: describe(name, bytes, 0, e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Every file in a directory, in name order. A file that is not a remittance (a PDF EOB, a
 * spreadsheet) is listed as unread with the reason, because a practice that sent its EOBs as PDFs
 * needs to be told they were not read, not shown a report that silently omits them.
 */
export function readEraDir(dir: string): { advices: AdviceSource[]; files: IntakeFile[] } {
  const advices: AdviceSource[] = [];
  const files: IntakeFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SYSTEM_FILE.test(name)) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (!REMITTANCE_EXTENSION.test(name)) {
      files.push(describe(name, bytes, 0, "not read: only .835, .edi, .x12 and .txt remittance files are, so a PDF or paper EOB needs a person"));
      continue;
    }
    const r = readEra(name, bytes);
    advices.push(...r.advices);
    files.push(r.file);
  }
  return { advices, files };
}
