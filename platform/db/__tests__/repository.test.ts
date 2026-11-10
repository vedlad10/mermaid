import { test } from "node:test";
import assert from "node:assert/strict";
import { one, many, execute, oneOrThrow, RepositoryNotFound } from "../repository.ts";

// A fake Tx captures calls and returns canned rows — lets us test the repository helpers with no DB.
function fakeTx(rows: unknown[], rowCount: number | null = rows.length) {
  const calls: { text: string; params?: unknown[] }[] = [];
  return {
    calls,
    query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return Promise.resolve({ rows, rowCount });
    },
  };
}

test("one returns the first row or undefined", async () => {
  assert.deepEqual(await one(fakeTx([{ id: 1 }, { id: 2 }]), "SELECT 1"), { id: 1 });
  assert.equal(await one(fakeTx([]), "SELECT 1"), undefined);
});

test("many returns all rows", async () => {
  assert.deepEqual(await many(fakeTx([{ id: 1 }, { id: 2 }]), "SELECT 1"), [{ id: 1 }, { id: 2 }]);
});

test("execute returns affected row count", async () => {
  assert.equal(await execute(fakeTx([], 3), "UPDATE t SET x=1"), 3);
  assert.equal(await execute(fakeTx([], null), "UPDATE t SET x=1"), 0);
});

test("oneOrThrow returns the row when present", async () => {
  assert.deepEqual(await oneOrThrow(fakeTx([{ id: 9 }]), "SELECT 1", [], "nope"), { id: 9 });
});

test("oneOrThrow throws RepositoryNotFound when absent", async () => {
  await assert.rejects(() => oneOrThrow(fakeTx([]), "SELECT 1", [], "claim 5 not found"), (e: unknown) => {
    assert.ok(e instanceof RepositoryNotFound);
    assert.equal((e as RepositoryNotFound).code, "not_found");
    assert.match((e as Error).message, /claim 5 not found/);
    return true;
  });
});

test("helpers forward parameters (parameterized statements only)", async () => {
  const tx = fakeTx([{ ok: true }]);
  await one(tx, "SELECT * FROM t WHERE id = $1", [42]);
  assert.deepEqual(tx.calls[0]?.params, [42]);
});
