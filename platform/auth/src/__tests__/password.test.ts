import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../password.ts";

test("hashPassword produces a self-describing scrypt encoding", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
});

test("verifyPassword accepts the right password, rejects the wrong one", async () => {
  const h = await hashPassword("s3cret-passphrase");
  assert.equal(await verifyPassword("s3cret-passphrase", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
});

test("each hash uses a fresh salt (same password → different encodings)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("verifyPassword returns false on malformed encodings instead of throwing", async () => {
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$16384$8$1$only-four-parts"), false);
  assert.equal(await verifyPassword("x", ""), false);
});
