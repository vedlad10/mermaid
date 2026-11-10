/**
 * Types for the command palette (spec §5.7).
 *
 * Only the query router is declared. It is the part that can be wrong in a way nobody notices — a
 * claim number silently searched as free text simply returns nothing — and it is the only part that
 * can be exercised without a DOM.
 */

export type PaletteRoute =
  /** No query: show recents, not everything. */
  | { kind: "recent"; term: string }
  /** Five or more digits: a claim or subscriber identifier. */
  | { kind: "id"; term: string }
  /** A `D` and up to four digits: a procedure code, normalised to upper case. */
  | { kind: "code"; term: string }
  /** A `$` prefix with at least one digit behind it. `cents` is exact. */
  | { kind: "amount"; term: string; cents: number }
  /** Everything else: patients, payers, screens and actions at once. */
  | { kind: "text"; term: string };

/** Decide what a query is asking for from its SHAPE, which is information the query already carries. */
export declare function routeQuery(raw: string | null | undefined): PaletteRoute;

export declare function createPalette(deps: {
  api: (method: string, path: string) => Promise<unknown>;
  go: (tab: string) => void;
  openDrill: (entry: { kind: string; id: string; label: string }) => void;
}): { el: HTMLElement; open(): void; close(): void; isOpen(): boolean };
