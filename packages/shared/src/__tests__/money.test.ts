import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, asCents, addCents, subCents, scaleCents, toDollars, formatUsd, ZERO } from "../money.ts";

test("cents rounds dollars to whole cents", () => {
  assert.equal(cents(12.34), 1234);
  assert.equal(cents(0.1 + 0.2), 30); // float 0.30000000000000004 → 30
  assert.equal(cents(1250), 125000);
});

test("asCents rejects non-integers", () => {
  assert.equal(asCents(1234), 1234);
  assert.throws(() => asCents(12.5), /integer cents/);
});

test("addCents / subCents are exact integer math", () => {
  assert.equal(addCents(cents(0.1), cents(0.2)), 30);
  assert.equal(addCents(cents(10), cents(20), cents(30)), 6000);
  assert.equal(subCents(cents(100), cents(37.5)), 6250);
  assert.equal(addCents(), 0);
  assert.equal(ZERO, 0);
});

test("scaleCents applies a factor and rounds", () => {
  assert.equal(scaleCents(cents(100), 0.8), 8000); // 80% of $100
  assert.equal(scaleCents(cents(9.99), 0.5), 500); // 499.5 → 500
});

test("toDollars / formatUsd render for display", () => {
  assert.equal(toDollars(cents(1234.56)), 1234.56);
  assert.equal(formatUsd(cents(1234.56)), "$1,234.56");
  assert.equal(formatUsd(ZERO), "$0.00");
});
