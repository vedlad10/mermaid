/**
 * Types for the metric spine (§5.1), and for the one rule in it worth stating precisely.
 */

/** One metric in the spine. `value` and `format` are what make the §6 count-up possible. */
export interface SpineMetric {
  key: string;
  label: string;
  /** The formatted figure, used for the first draw and whenever the basis changed. */
  display: string;
  /** The raw figure. Without it a change can only snap, because text cannot be interpolated. */
  value?: number;
  /** How an interpolated value is written during a count. */
  format?: (v: number) => string;
  delta?: number | null;
  basis?: string;
  series?: number[];
  tone?: "warning" | "critical" | null;
  zero?: boolean;
}

export interface Spine {
  /**
   * Replace the metrics.
   *
   * `basis` says what these figures are ABOUT — the window, the filters, the population. A figure
   * counts to its new value only when the basis is UNCHANGED (§6.2: the same question, a new
   * answer, so the movement is the information). When the basis differs the figure snaps, because
   * "the old value was about a different thing entirely and counting between them implies a false
   * relationship".
   */
  update(metrics: SpineMetric[], opts?: { basis?: string | null }): void;
  destroy(): void;
}

export declare function createSpine(host: HTMLElement, opts: { store: unknown; metrics?: SpineMetric[] }): Spine;
export declare function createDrill(host: HTMLElement, opts: { store: unknown; render: unknown }): { destroy(): void };
