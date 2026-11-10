/**
 * `OUTBOX_INTERVAL_MS` is how often every process wakes the database. A value `setInterval` cannot
 * honour is not a slower poll, it is a one-millisecond one — so the reader refuses it instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OUTBOX_INTERVAL_MS, outboxIntervalMs } from "../wiring.ts";

test("unset or blank keeps the 5s default", () => {
  assert.equal(DEFAULT_OUTBOX_INTERVAL_MS, 5_000);
  assert.equal(outboxIntervalMs(undefined), 5_000);
  assert.equal(outboxIntervalMs(""), 5_000);
  assert.equal(outboxIntervalMs("  "), 5_000);
});

test("a whole number of milliseconds is used as given", () => {
  assert.equal(outboxIntervalMs("1000"), 1_000);
  assert.equal(outboxIntervalMs("360000"), 360_000);
  assert.equal(outboxIntervalMs("2147483647"), 2_147_483_647);
});

test("every value setInterval would turn into 1ms is refused, not coerced", () => {
  for (const raw of ["abc", "5s", "0", "-5000", "999", "1500.5", "2147483648", "Infinity"]) {
    assert.throws(() => outboxIntervalMs(raw), /OUTBOX_INTERVAL_MS/, raw);
  }
});
