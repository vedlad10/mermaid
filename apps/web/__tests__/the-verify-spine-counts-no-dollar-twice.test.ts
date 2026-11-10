/**
 * The four figures across the top of Verify must not overlap.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The spine is one continuous strip divided by hairline rules — deliberately not four cards — and
 * that structure tells a reader the figures in it are parallel: different slices of one population,
 * side by side. Three of the four were not.
 *
 *   "Waiting on a person"   every check whose outcome was not complete
 *   "Could not be checked"  a STRICT SUBSET of that one
 *   "No benefits returned"  any check the payer sent no benefits for — mostly the blocked ones again
 *
 * On the demo practice the last two printed the same figure, $1,360, because they were the same
 * single blocked check counted under two headings. Nothing on screen said so. Either that practice
 * had $2,720 of trouble or it had $1,360, and the interface offered no way to tell — while a reader
 * who did the natural thing and added the row got $5,505, a number describing nothing at all.
 *
 * ── WHY THE ARITHMETIC IS THE TEST ─────────────────────────────────────────────────────────────
 * Each filter is obviously correct on its own line. The defect existed only in the relationship
 * between them, which is exactly the kind of thing that reads fine in review and cannot be seen in
 * a screenshot unless two buckets happen to collide on the same data — which is what made this one
 * visible, and is luck rather than a check.
 *
 * So the fixture gives every bucket a DISTINCT POWER OF TWO. Any overlap shows up as a sum, and the
 * sum names its own cause: a bucket reporting $600 is holding 200 and 400, and there is exactly one
 * pair that makes 600. A failure here tells you which two buckets merged, not merely that one did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { VerificationLike, VerifyBuckets } from "../public/verify-buckets.js";

type Check = VerificationLike;

/* The shipped module, typed by its sidecar `.d.ts` the way every importable `public/` module here
   is — these files ship to a browser unbuilt, so their declarations are written by hand. */
const { partition, atStake } = await import("../public/verify-buckets.js");

const part = (): VerifyBuckets => partition(ROWS);
const sum = (rows: Check[]): number => rows.reduce((t, v) => t + atStake(v), 0);

/* Powers of two, in cents, so every subset sums to a value only that subset can produce. */
const ANSWERED = 100_00;
const NEEDS_HUMAN = 200_00;
const BLOCKED = 400_00;
const EMPTY = 800_00;

const check = (
  id: string,
  outcome: string,
  amountAtStake: number,
  benefitsRetrieved: boolean
): Check => ({
  id,
  outcome,
  totalFee: amountAtStake,
  provenance: { kind: "mock", benefitsRetrieved, amountAtStake },
});

/** One check in every state the screen distinguishes, including the two that used to collide. */
const ROWS = [
  check("answered", "complete", ANSWERED, true),
  check("needs-a-person", "needs_human", NEEDS_HUMAN, true),
  /* Blocked AND carrying no benefits — the row that was counted twice. A blocked check never
     reaches the payer, so `benefitsRetrieved: false` is not an unusual case here, it is the norm,
     which is why "no benefits returned" collapsed onto "could not be checked". */
  check("could-not-be-checked", "blocked", BLOCKED, false),
  check("answered-but-empty", "complete", EMPTY, false),
];

test("each bucket reports only its own money", () => {
  const { needsHuman, blocked, empty } = part();

  assert.equal(sum(needsHuman), NEEDS_HUMAN, "Needs a person");
  assert.equal(
    sum(blocked),
    BLOCKED,
    "Could not be checked"
  );
  assert.equal(
    sum(empty),
    EMPTY,
    "Answered with no benefits — if this reads $1,200 it has swallowed the blocked check again, " +
      "which is the original defect: a check that never reached the payer trivially returned no " +
      "benefits, and saying so under a second heading repeats the same dollars"
  );
});

test("no check appears in two buckets", () => {
  /**
   * The invariant itself, stated over the records rather than the money, so it still holds on a
   * practice where two buckets happen to carry equal amounts.
   */
  const { needsHuman, blocked, empty } = part();
  const seen = new Map<string, string[]>();
  for (const [name, rows] of [
    ["needsHuman", needsHuman],
    ["blocked", blocked],
    ["empty", empty],
  ] as const) {
    for (const v of rows) {
      const id = String(v.id);
      seen.set(id, [...(seen.get(id) ?? []), name]);
    }
  }

  const doubled = [...seen.entries()].filter(([, buckets]) => buckets.length > 1);
  assert.deepEqual(
    doubled,
    [],
    "a check counted in more than one spine figure. The four figures sit in one strip divided by " +
      "hairlines, which reads as parallel slices of one population — so a check in two of them is " +
      "money reported twice on a screen about money"
  );
});

test("the buckets never contain one another", () => {
  /*
   * Subset is the shape the original defect actually had — "Could not be checked" was wholly inside
   * "Waiting on a person" — and it is worth asserting separately, because a superset metric passes
   * a disjointness check the moment it is the ONLY pair that overlaps and someone deletes the other.
   */
  const all = part();
  const buckets: Array<[string, Check[]]> = [
    ["needsHuman", all.needsHuman],
    ["blocked", all.blocked],
    ["empty", all.empty],
  ];
  for (const [aName, a] of buckets) {
    for (const [bName, bRows] of buckets) {
      if (aName === bName || a.length === 0) continue;
      const aIds = new Set(a.map((v) => String(v.id)));
      const bIds = new Set(bRows.map((v) => String(v.id)));
      const contained = [...aIds].every((id) => bIds.has(id));
      assert.equal(
        contained,
        false,
        `${bName} contains all of ${aName}, so the two figures are not independent readings`
      );
    }
  }
});

test("a check that is answered and carries benefits is in no exception bucket", () => {
  /* The failure mode of a partition is a bucket that catches everything, which would look like a
     screen reporting every check as a problem. The healthy case is asserted beside the broken ones. */
  const { needsHuman, blocked, empty } = part();
  const flagged = new Set([...needsHuman, ...blocked, ...empty].map((v) => String(v.id)));
  assert.equal(flagged.has("answered"), false, "a clean check was reported as an exception");
  assert.equal(flagged.size, 3, "three of the four fixtures are exceptions");
});

test("the exception buckets and the clean checks account for every dollar exactly once", () => {
  const { needsHuman, blocked, empty } = part();
  const exceptions = sum(needsHuman) + sum(blocked) + sum(empty);
  assert.equal(
    exceptions + ANSWERED,
    sum(ROWS),
    "the buckets plus the clean checks should be the whole population; a mismatch means money is " +
      "either counted twice or falling through every bucket"
  );
});
