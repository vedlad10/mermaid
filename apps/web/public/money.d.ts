/**
 * Types for the Money screen's exported parts.
 *
 * `advicesInWindow` is exported because the timeframe rule it encodes is not observable from the
 * screen without one: three of the four tiles are deliberately all-time positions while the metric
 * beside them is windowed, and a test is the only thing that can hold that distinction in place.
 * See the note above the function for why held advices are never windowed out.
 */

/** The fields of a payer advice this rule reads. The list endpoint returns considerably more. */
export interface AdviceRow {
  receivedAt: string;
  status: string;
  [key: string]: unknown;
}

/** The active timeframe, as `store.window()` returns it — ISO-8601 instants. */
export interface Window {
  from: string;
  to: string;
}

/**
 * The advices the selected timeframe is about: those that ARRIVED inside it, plus every held
 * advice regardless of age. A window that cannot be parsed returns the list unfiltered, because
 * showing everything is the safe failure and showing nothing is not.
 */
export declare function advicesInWindow<T extends AdviceRow>(advices: T[] | null | undefined, window: Window | null | undefined): T[];

export declare function mountMoney(
  stage: HTMLElement,
  deps: {
    store: unknown;
    api: (method: string, path: string) => Promise<unknown>;
    apiRaw: (path: string, body: unknown) => Promise<unknown>;
    notify: (message: string) => void;
  }
): { destroy(): void } | void;
