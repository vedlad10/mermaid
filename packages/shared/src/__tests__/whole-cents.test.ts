/**
 * Money is not rounded on a caller's behalf.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `POST /api/v1/patients/:id/payment` with `amountDollars: 10.005` returned 200 and stored $10.01.
 * The caller sent one figure and the ledger recorded another, with no error and nothing recording
 * that anything had been altered.
 *
 * The guard existed. `PatientLedgerService.#humanEntry` says "the amount must be a positive whole
 * number of cents" and checks `Number.isInteger(input.amount)` — but `input.amount` is already
 * `cents(dollars)`, and `cents` is `Math.round`. The check sat AFTER the conversion that guarantees
 * it passes, so on the HTTP path it could never fire. Same shape as the audit trail's "no direct
 * DML" and the partition laws that ran only in tests: a stated rule with nothing enforcing it.
 *
 * The question has to be asked before the rounding, which is what `isWholeCents` is for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, isWholeCents } from "../money.ts";

test("a whole number of cents is accepted", () => {
  for (const ok of [1, 0.01, 10.01, 0.1, 123.45, 999999.99, 0.99]) {
    assert.equal(isWholeCents(ok), true, `${ok} names a whole number of cents`);
  }
});

test("a fraction of a cent is refused", () => {
  for (const bad of [10.005, 0.001, 1.4999, 33.333, 0.005]) {
    assert.equal(isWholeCents(bad), false, `${bad} cannot be stored without changing it`);
  }
});

test("floating-point representation error is not mistaken for a fraction of a cent", () => {
  /**
   * The reason this is a tolerance and not `scaled === Math.round(scaled)`.
   *
   * Binary floating point cannot hold most decimal fractions, so `dollars * 100` lands just beside
   * the integer rather than on it — in EITHER direction, and for amounts a practice types every day:
   *
   *     1.1  * 100 = 110.00000000000001      $1.10
   *     4.35 * 100 = 434.99999999999994      $4.35
   *     0.07 * 100 =   7.000000000000001     $0.07
   *    16.08 * 100 = 1607.9999999999998      $16.08
   *
   * An exact test refuses all four. That is a worse bug than the one being fixed: a fractional cent
   * is a rare mistake, while $4.35 is a Tuesday. The tolerance is far below half a cent, so it
   * separates representation error from an amount that genuinely names a fraction of one.
   */
  for (const ordinary of [1.1, 4.35, 0.07, 16.08]) {
    assert.equal(
      Number.isInteger(ordinary * 100),
      false,
      `the premise: ${ordinary} * 100 is not exactly an integer, which is why exactness fails here`
    );
  }
  for (const ordinary of [1.1, 4.35, 0.07, 16.08]) {
    assert.equal(isWholeCents(ordinary), true, `$${ordinary} is an ordinary amount and must not be refused`);
  }
  assert.equal(isWholeCents(10.005), false, "while the genuinely fractional one still is refused");
});

test("nothing that is not a finite number passes", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(isWholeCents(bad), false);
  }
});

test("what the rule protects: cents() silently changes a figure it is given", () => {
  /**
   * Not a complaint about `cents` — rounding at a boundary is what it is for, and every figure
   * arriving from an 835 is already whole cents. The point is that it cannot refuse, so something
   * upstream has to, and this records what happens when nothing does.
   */
  assert.equal(cents(10.005), 1001, "the caller sent $10.005 and the ledger would record $10.01");
  assert.equal(Number.isInteger(cents(10.005)), true, "which is why a check placed after it always passes");
});
