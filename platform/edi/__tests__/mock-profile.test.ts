/**
 * Mock payer-profile invariants.
 *
 * The mock exists so the rest of the system can be exercised against shapes a real payer produces.
 * A mock that emits states no payer can produce — a negative visit count, a plan with more money
 * remaining than its own maximum — teaches every downstream engine a shape it will never see, which
 * is the failure mode the mock/parser split exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockProfile } from "../mock/profile.ts";

const TODAY = new Date("2026-07-15T12:00:00Z");

/** Member IDs spread across the hash space, including the top half where the defect lived. */
function memberIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(`MX${i.toString(36).toUpperCase().padStart(6, "0")}`);
  return ids;
}

test("no profile reports a negative number of used visits", () => {
  /**
   * `hashId` returns a uint32 and `>>` is a SIGNED shift, so every member ID hashing at or above
   * 2^31 — about half of them — produced `used: -1`. `MX000000` was one.
   */
  for (const id of memberIds(5000)) {
    for (const limit of mockProfile(id, TODAY).frequencyLimits) {
      assert.ok(
        Number.isInteger(limit.used) && limit.used >= 0,
        `${id}: ${limit.description} reports used=${limit.used}`
      );
      assert.ok(limit.used <= limit.limit, `${id}: used=${limit.used} exceeds limit=${limit.limit}`);
    }
  }
});

test("no plan has more of its annual maximum remaining than the maximum itself", () => {
  // The same signed shift fed `used`, so `annualMax - used` came out ABOVE `annualMax`.
  for (const id of memberIds(5000)) {
    const p = mockProfile(id, TODAY);
    assert.ok(
      p.annualMaximumRemaining <= p.annualMaximum,
      `${id}: ${p.annualMaximumRemaining} remaining of a ${p.annualMaximum} maximum`
    );
    assert.ok(p.annualMaximumRemaining >= 0, `${id}: negative remaining`);
  }
});

test("the member-ID conventions the fixtures rely on still hold", () => {
  // The fix must not disturb what the suffixes mean — several test suites are keyed to them.
  assert.equal(mockProfile("MEM10000", TODAY).active, false, '"...00" is the inactive member');
  assert.equal(mockProfile("ABC12345", TODAY).active, true);
  /**
   * ── "77" AND "66" WERE ONE SUFFIX, AND THAT WAS THE INCOHERENCE ───────────────────────────────
   * The adjudicator has always refused the highest-charge line on a "...77" member under CO-197,
   * "pre-authorization absent". The BENEFITS for the same member said the service sat inside a
   * 12-month waiting period. Two different facts about one tooth, and only one of them is
   * appealable — obtaining an authorisation does not shorten a waiting period.
   *
   * Pia Phase32 was the live casualty: her snapshot said waiting period, both her ERAs said 197.
   * "77" now means pre-authorisation on BOTH sides, and the waiting-period behaviour moved to "66".
   */
  assert.ok(
    mockProfile("MEM10077", TODAY).preAuthorization,
    '"...77" publishes a pre-authorisation rule, matching the CO-197 its adjudicator emits'
  );
  assert.equal(
    mockProfile("MEM10077", TODAY).waitingPeriods.length,
    0,
    '"...77" is no longer ALSO a waiting period — that was the contradiction'
  );
  assert.equal(mockProfile("MEM10066", TODAY).waitingPeriods.length, 1, '"...66" carries the waiting period');
  assert.equal(mockProfile("ABC12345", TODAY).waitingPeriods.length, 0);
  assert.equal(
    mockProfile("ABC12345", TODAY).preAuthorization,
    undefined,
    "an ordinary plan publishes no rule, which reaches the estimate as UNKNOWN — what a 271 gives"
  );

  const nearMax = mockProfile("MEM10099", TODAY);
  assert.equal(nearMax.annualMaximumRemaining, 120, '"...99" is the nearly-exhausted member');

  // The bitewing allowance ABC12345 has already spent — the D2 frequency-limit fixture depends on it.
  const bitewing = mockProfile("ABC12345", TODAY).frequencyLimits.find((f) => f.codes.includes("D0274"))!;
  assert.equal(bitewing.used, 1);
  assert.equal(bitewing.limit, 1);
});

test("a profile is deterministic — the same member ID always yields the same plan", () => {
  for (const id of ["ABC12345", "MEM10077", "MX000000", "MX000001"]) {
    assert.deepEqual(mockProfile(id, TODAY), mockProfile(id, TODAY));
  }
});
