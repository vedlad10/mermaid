/**
 * Types for the parts of the Recover screen that are pure logic rather than DOM.
 *
 * Only the rules a test needs to hold are declared, and both are compliance rules rather than
 * conveniences: §4.4's small-n suppression, and §8.5's insistence that a passed appeal deadline is
 * a different fact from an approaching one. `mountRecover` takes a live DOM node and is not
 * usefully typeable here.
 */

/** The severity bands of the appeal-deadline horizon. */
export type HorizonTone = "past" | "critical" | "warning" | "open" | "unknown";

/**
 * Whether a sample is large enough to quote a rate from (§4.4, n ≥ 5).
 *
 * Requires a finite number, so a MISSING sample size fails closed. The guard this replaced was
 * `n < MIN_SAMPLE`, and `undefined < 5` is false — which let a record with no evidence at all past
 * a check that exists for exactly that case.
 */
export declare function quotable(n: number | null | undefined): boolean;

/**
 * A rate written with its denominator and its origin, or `null` when it may not be written at all.
 * Never returns a partial sentence.
 */
export declare function rateWithBasis(
  rate: number,
  n: number | null | undefined,
  source: string | null | undefined
): string | null;

/** Which band a filing deadline falls in, given days remaining (negative = already passed). */
export declare function horizonTone(days: number | null): HorizonTone;

export declare function mountRecover(stage: unknown, deps: { store: unknown; api: unknown }): unknown;
