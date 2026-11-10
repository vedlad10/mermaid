/**
 * Snapshot versioning — and specifically the property that makes a version bump reversible.
 *
 * ── WHY THE DOWNCAST HALF IS TESTED AS HARD AS THE UPCAST HALF ─────────────────────────────────
 * Refusing a document from a newer writer is the correct default and stays the default: a shape
 * this code has never seen cannot be interpreted. What it also does is make every version bump a
 * one-way door — deploy code that writes v2, roll it back, and every record written in between is
 * unreadable rather than merely degraded. That turns an ordinary rollback into an outage on exactly
 * the records the failed release touched, which is the moment a rollback is most needed.
 *
 * So a caller may now register a downcaster, and these tests pin both halves of that bargain: it
 * works when registered, the refusal is untouched when it is not, and a downcaster that fails to
 * lower the version is caught rather than spun on forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSnapshot, withVersion, isVersioned, type Versioned } from "../snapshot.ts";

interface V1 extends Versioned {
  name: string;
}
interface V2 extends V1 {
  /** Added in v2 — the kind of purely additive field a downcast can safely drop. */
  submissions: string[];
}

const v1 = (): Versioned => withVersion({ name: "Ada" }, 1);
const v2 = (): Versioned => withVersion({ name: "Ada", submissions: ["primary"] }, 2);

const UP = { 1: (doc: Versioned) => ({ ...doc, submissions: [], snapshot_version: 2 }) };
const DOWN = {
  2: (doc: Versioned) => {
    const { submissions: _dropped, ...rest } = doc as V2;
    return { ...rest, snapshot_version: 1 };
  },
};

// ── The existing contract, unchanged ──────────────────────────────────────────────────────────

test("a document at the current version is returned as-is", () => {
  assert.deepEqual(readSnapshot<V1>(v1(), 1), { name: "Ada", snapshot_version: 1 });
});

test("an older document is upcast to the current shape", () => {
  const read = readSnapshot<V2>(v1(), 2, UP);
  assert.deepEqual(read, { name: "Ada", submissions: [], snapshot_version: 2 });
});

test("an unversioned blob is refused rather than guessed at", () => {
  assert.throws(() => readSnapshot({ name: "Ada" }, 1), /missing snapshot_version/);
});

test("an older document with no upcaster is refused", () => {
  assert.throws(() => readSnapshot(v1(), 2), /no upcaster registered for snapshot_version 1/);
});

/**
 * The default has NOT moved. A reader that has registered nothing still refuses a document it has
 * never seen the shape of — which is the whole reason the check exists, and the behaviour every
 * deployment has today.
 */
test("a newer document is still refused when no downcaster is registered", () => {
  assert.throws(
    () => readSnapshot(v2(), 1, UP),
    /snapshot_version 2 is newer than this code understands \(1\)/
  );
});

// ── The rollback path ─────────────────────────────────────────────────────────────────────────

test("a newer document is readable by an older reader that knows how to drop the additions", () => {
  const read = readSnapshot<V1>(v2(), 1, {}, DOWN);
  assert.deepEqual(read, { name: "Ada", snapshot_version: 1 }, "the v2-only field is gone, and that is the trade");
  assert.equal((read as Partial<V2>).submissions, undefined);
});

test("a downcast walks one version at a time, so a two-version rollback still lands", () => {
  const three = withVersion({ name: "Ada", submissions: ["primary"], extra: true }, 3);
  const down = {
    3: (doc: Versioned) => {
      const { extra: _e, ...rest } = doc as Versioned & { extra: boolean };
      return { ...rest, snapshot_version: 2 };
    },
    ...DOWN,
  };
  assert.deepEqual(readSnapshot<V1>(three, 1, {}, down), { name: "Ada", snapshot_version: 1 });
});

test("a downcaster that does not lower the version is caught, not spun on", () => {
  const broken = { 2: (doc: Versioned) => ({ ...doc, snapshot_version: 2 }) };
  assert.throws(
    () => readSnapshot(v2(), 1, {}, broken),
    /did not lower the version — refusing to loop/,
    "an infinite loop inside a repository read is the failure this guard exists for"
  );
});

test("a missing downcaster part-way down is refused rather than half-applied", () => {
  const three = withVersion({ name: "Ada", submissions: [], extra: true }, 3);
  assert.throws(() => readSnapshot(three, 1, {}, DOWN), /snapshot_version 3 is newer/);
});

// ── The narrowing helper ──────────────────────────────────────────────────────────────────────

test("isVersioned accepts only a document carrying a numeric version", () => {
  assert.equal(isVersioned(v1()), true);
  assert.equal(isVersioned({ name: "Ada" }), false);
  assert.equal(isVersioned({ snapshot_version: "1" }), false, "a string version is not a version");
  assert.equal(isVersioned(null), false);
});
