/**
 * Types for the Insights screen's exported parts.
 *
 * Only what is genuinely shared leaves this module. `SCORECARD` is exported because a test has to
 * be able to read the payer table's column definitions: the labels on two of those columns name the
 * arithmetic the analytics engine performs, and when the engine's denominator and the column's
 * wording drift apart the screen states something the software does not compute. That drift is not
 * visible to typecheck, to the mount test, or to a reader of either file alone — it is only visible
 * when the two are compared, so something has to be able to compare them.
 *
 * See `a-rate-label-names-its-own-denominator.test.ts` for the comparison, and the note above
 * `SCORECARD` itself for the defect that prompted it.
 */

/** One column of the payer scorecard. */
export interface ScorecardColumn {
  /** The `PayerScore` field this column reads. */
  key: string;
  /**
   * The column heading.
   *
   * For a `rate` column this must name the quantity the engine divides BY, in the words a practice
   * uses — the denominator is never itself a column, so the heading is the only place a reader can
   * learn it.
   */
  label: string;
  kind: "count" | "money" | "rate" | "days";
  /** Which direction is better, for the micro-bar's tone. Absent where neither is. */
  good?: "high" | "low";
}

export declare const SCORECARD: readonly ScorecardColumn[];

export declare function mountInsights(
  stage: HTMLElement,
  deps: { store: unknown; api: (method: string, path: string) => Promise<unknown> }
): { destroy(): void } | void;
