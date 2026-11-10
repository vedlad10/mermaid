/**
 * Types for the advice drill's action panel (`coordination.js`).
 *
 * Deliberately loose on the view: the panel reads only the fields the server decides with —
 * `releaseBlocked`, `canPost`, `coordination` — and the advice's status and postings. It never
 * re-derives whether release is allowed.
 */

export interface AdviceActionsOptions {
  /** The app's fetch wrapper: `api("GET" | "POST", path, body?)`, resolving to parsed JSON. */
  api: (method: string, path: string, body?: Record<string, unknown>) => Promise<any>;
  /** Redraw the drill from the server after any action succeeds. */
  reload: () => Promise<void>;
}

/**
 * Everything a person can do with this advice — release, reject, answer a coverage question, move a
 * secondary claim — as one section, or null when there is nothing to decide.
 */
export declare function renderAdviceActions(view: Record<string, any>, options: AdviceActionsOptions): Promise<HTMLElement | null>;

/** A one-line worklist label for a coordination item: its coverage or secondary-claim state. */
export declare function coordinationLabel(item: { coverageStatus: string; workStatus: string }): string;
