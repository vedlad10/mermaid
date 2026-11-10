/**
 * Types for the selection/filter store.
 *
 * The client ships as plain ES modules and sits outside the typechecked surface deliberately — it
 * has no build step. This declaration exists because the store's contract is imported by a test,
 * and because that contract is worth stating precisely: it is the one object every screen shares,
 * and the rules encoded here (a point is a bucket, a brush is a range, selection IS filter) are the
 * reason a chart and a table cannot describe different populations.
 */

export interface Filter {
  /** The dimension being narrowed: "payer", "status", and so on. */
  dim: string;
  value: string | number;
  /** What the chip reads, e.g. "Payer: Delta Dental". */
  label?: string;
}

export interface Timeframe {
  key: string;
  days: number;
  compare: "prior" | "yoy" | "none";
}

export interface DrillEntry {
  kind: string;
  id: string;
  label: string;
  /** Screens may carry the resolved entity so the panel need not re-fetch it. */
  [extra: string]: unknown;
}

export interface Chip extends Filter {
  kind: "filter" | "point" | "brush";
}

export interface StoreState {
  timeframe: Timeframe;
  metric: string | null;
  filters: Filter[];
  point: { bucket: string } | null;
  brush: { from: string; to: string } | null;
  drill: DrillEntry[];
}

/** How a screen reads its own records for the shared predicate. */
export type Accessors<T = unknown> = Record<string, (record: T) => unknown>;

export interface Store {
  get(): StoreState;
  subscribe(fn: (state: StoreState, reason: string) => void): () => void;

  setTimeframe(key: string): void;
  setCompare(mode: Timeframe["compare"]): void;
  /** The window as ISO instants — exactly what the report endpoint takes. */
  window(now?: Date): { from: string; to: string };

  setMetric(key: string | null): void;

  toggleFilter(filter: Filter): void;
  removeFilter(filter: Filter): void;
  clearFilters(): void;
  isFiltered(dim: string, value: string | number): boolean;

  selectPoint(bucket: string): void;
  setBrush(range: { from: string; to: string } | null): void;

  pushDrill(entry: DrillEntry): void;
  replaceDrill(entry: DrillEntry): void;
  popDrill(toDepth?: number | null): void;
  closeDrill(): void;

  /** The one predicate every filtered view obeys. */
  matches<T>(record: T, accessors?: Accessors<T>): boolean;
  chips(): Chip[];
  narrowed(): boolean;
  /**
   * Return to a clean view, keeping only the timeframe. Called on every screen change.
   *
   * Everything it clears is a position inside ONE screen's picture — a point on a chart the next
   * screen does not draw, a metric key naming a spine entry it does not have, a filter on a
   * dimension it cannot read. The timeframe survives because "the last 90 days" is a question about
   * the practice rather than about a screen.
   */
  reset(): void;
  /**
   * Notify every subscriber without changing anything.
   *
   * For things that change how a screen READS without changing which records it is about —
   * presentation mode masking patient names is the case this exists for.
   */
  bump(reason?: string): void;
}

export declare const RANGES: ReadonlyArray<{ key: string; label: string; days: number }>;
export declare function createStore(initial?: Partial<StoreState>): Store;
