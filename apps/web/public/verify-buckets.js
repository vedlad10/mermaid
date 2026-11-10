/**
 * How a coverage check sorts into the figures across the top of Verify.
 *
 * ── WHY THIS IS A MODULE AND NOT THREE `filter` CALLS IN `drawSpine` ─────────────────────────────
 * It was three filter calls, and they overlapped. The spine is a row of equal siblings divided by
 * hairlines, so a reader takes the figures in it to be parallel slices of one population. Three of
 * the four were not: "Waiting on a person" was every unresolved check, "Could not be checked" was a
 * STRICT SUBSET of it, and "No benefits returned" counted any check the payer sent no benefits for
 * — which is mostly the blocked ones a second time. On the demo practice that printed
 *
 *     Could not be checked   $1,360        No benefits returned   $1,360
 *
 * one blocked check, twice, under two headings, with nothing on screen to say they were one check.
 * A reader who added the row got a number describing nothing.
 *
 * Inline filters made that invisible: each one is obviously correct on its own line, and the defect
 * only exists in the relationship BETWEEN them. Naming the relationship — and giving it a test that
 * fails when it breaks — is the whole reason this file exists. It has no imports and touches no DOM
 * so the invariant can be checked directly, without a browser or a stub of one.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────────────────────
 * The three exception buckets are PAIRWISE DISJOINT. A check appears in at most one, so the figures
 * can be read across without double-counting a dollar. Any fourth question that wants a slot on
 * that row has to partition too, or it belongs in a block below with words of its own.
 */

/**
 * What a verification put at stake, in cents.
 *
 * `amountAtStake` is the provenance's own record of the treatment money riding on the check;
 * `totalFee` is the fallback for records written before it existed.
 */
export const atStake = (v) => v.provenance?.amountAtStake ?? v.totalFee ?? 0;

/**
 * Sort checks into the three exception buckets the spine reports.
 *
 * @param {Array<object>} rows
 * @returns {{needsHuman: object[], blocked: object[], empty: object[]}}
 */
export function partition(rows) {
  return {
    /* The payer answered and a person has to choose what to do about the answer. */
    needsHuman: rows.filter((v) => v.outcome === "needs_human"),
    /* The check never reached the payer at all: a phone call or a portal, not a decision. */
    blocked: rows.filter((v) => v.outcome === "blocked"),
    /*
     * Answered, and the answer carried nothing.
     *
     * Scoped to `complete` ON PURPOSE, and this is the line the double-count turned on. A blocked
     * check obviously returned no benefits — saying so again here adds no fact and repeats the same
     * dollars under a second heading. What earns a place on this screen is the check that LOOKS
     * finished: the payer replied, the record closed, the queue moved on, and the practice still
     * knows nothing about the coverage. Nobody goes hunting for those, because every other surface
     * reports them as done.
     */
    empty: rows.filter((v) => v.outcome === "complete" && v.provenance?.benefitsRetrieved === false),
  };
}
