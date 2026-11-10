/** Types for the pure half of the schedule importer (`schedule-import.js`). */

export interface ImportPreviewLike {
  fileProblems: string[];
  total: number;
  ready: number;
  problemCount: number;
  firstDay: string | null;
  lastDay: string | null;
}
export interface ImportResultLike {
  fileProblems: string[];
  created: number;
  updated: number;
  unchanged: number;
  rejected: { line: number | null; reason: string }[];
}
export declare function importSummary(p: ImportPreviewLike): string;
export declare function importResultSummary(r: ImportResultLike): string;
export declare function mountImport(
  host: unknown,
  deps: { api: unknown; timeZone?: () => string | null; onImported?: (() => Promise<void>) | null }
): { destroy(): void };
