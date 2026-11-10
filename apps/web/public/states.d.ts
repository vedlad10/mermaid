/**
 * Types for the shared state treatments (spec §7).
 *
 * Only the two pieces of pure logic a test needs are declared precisely: the load lifecycle, which
 * is where a failure stops being an unhandled rejection, and the freshness verdict, which is where
 * "we do not know how old this is" stops being indistinguishable from "it is current".
 */

/** The mutable handle a screen shares with `load` and reads from its render path. */
export interface LoadHandle {
  loading: boolean;
  failed: Error | null;
  loaded: boolean;
}

/**
 * Run a screen's fetch, calling `render` at the start, on failure, and on completion.
 *
 * Never rethrows: a failure becomes `handle.failed`, because rethrowing would give the screen its
 * error state and leave the crash in the console at the same time.
 */
export declare function load(
  handle: LoadHandle,
  fetchAll: () => Promise<void>,
  render: () => void
): Promise<void>;

export type FreshnessState = "live" | "synced" | "stale" | "unknown";

/**
 * How current a reading is. An absent or unparseable timestamp is `unknown` — never `live` — so the
 * indicator fails toward "we do not know" rather than toward "this is current".
 */
export declare function freshness(
  atIso: string | null | undefined,
  nowMs?: number
): { state: FreshnessState; label: string };

export declare function freshnessTag(atIso: string | null | undefined, nowMs?: number): HTMLElement;

/**
 * The §7.3 failure treatment, or the §7.6 restricted one when the error carries a 403.
 *
 * A permission boundary is not a failure: it gets its own copy, keeps the server's sentence about
 * which role is missing, states the SHAPE of what the screen would show, and offers no retry —
 * because nothing about pressing it would change the answer.
 */
/**
 * Turn a transport failure into a sentence, and leave everything else alone.
 *
 * A browser reports a request that never reached a server as "Failed to fetch" (Chrome), "Load
 * failed" (Safari) or "NetworkError when attempting to fetch resource." (Firefox) — three sentences
 * for one condition, none of which names it. Those become a plain statement with the raw string
 * kept alongside for support; anything from the server is returned unchanged, because its own words
 * are the only thing that says what actually broke.
 */
export declare function explainNetwork(message: string): string;

export declare function errorBlock(opts: {
  what: string;
  stakes?: string;
  /** What this screen displays, for the restricted treatment. */
  shows?: string;
  /** An `api()` error carries `status` and `code` so a 403 can be told from an outage. */
  error?: (Error & { status?: number; code?: string | null }) | null;
  retry?: () => void;
}): HTMLElement;

export declare function spineSkeleton(host: HTMLElement, labels: string[]): void;
export declare function blockSkeleton(host: HTMLElement, height: number, lines?: number): void;
export declare function tableSkeleton(host: HTMLElement, rows?: number, rowHeight?: number): void;
export declare function stageSkeleton(
  stage: HTMLElement,
  header: HTMLElement | null,
  geo?: { metrics?: string[]; chartHeight?: number; rows?: number }
): void;
export declare function restoreLayout(stage: HTMLElement, layout: Element[]): void;

/**
 * Re-read a live screen on an interval, returning a function that stops it.
 *
 * Never runs while the tab is hidden or while `shouldRun` is false, and swallows failures — a
 * background refresh of a screen that already has data must not replace it with an error state.
 */
export declare function poll(
  intervalMs: number,
  shouldRun: () => boolean,
  run: () => Promise<void> | void
): () => void;
