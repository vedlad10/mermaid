/**
 * Types for the parts of the Claims screen that are pure logic rather than DOM.
 *
 * The client ships as plain ES modules with no build step and sits outside the typechecked surface
 * deliberately. This declaration covers only what a test imports — the two functions that decide
 * what the flow chart and the hold ranking actually CONTAIN. They are exported for that reason:
 * both are read by more than one part of the screen, and a second implementation of either is how a
 * column and the table beneath it would come to describe different claims.
 *
 * `mountClaims` is not declared. It takes a live DOM node and returns a live screen; nothing that
 * can be typechecked here would say anything true about it.
 */

/** The bands of the lifecycle flow, bottom-up. */
export type FlowStage = "waiting" | "withPayer" | "answered";

/** What is holding a claim up — one answer per claim, in descending severity. */
export type Hold = "nopayer" | "errors" | "unreleased" | "warnings" | "none";

export declare const HOLDS: ReadonlyArray<{
  key: Exclude<Hold, "none">;
  label: string;
  note: string;
  match(claim: unknown): boolean;
}>;

export declare function holdOf(claim: unknown): Hold;

/**
 * Which band a claim belonged to at the END of a day, or null if it belonged to none — because it
 * did not exist yet, could not be dated, or was withdrawn from the cycle.
 *
 * @param dayEndMs the exclusive end of the day, in epoch milliseconds
 */
export declare function stageOnDay(claim: unknown, dayEndMs: number): FlowStage | null;

export declare function mountClaims(stage: unknown, deps: { store: unknown; api: unknown }): unknown;
