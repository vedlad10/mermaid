import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryCodeHash,
  totpStep,
  verifyTotp,
} from "../totp.ts";

/** The RFC 4226 / RFC 6238 test secret: the ASCII bytes "12345678901234567890". */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

test("HOTP matches the RFC 4226 Appendix D vectors", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code, `counter ${counter}`));
});

test("TOTP matches the RFC 6238 Appendix B SHA-1 vectors", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, code] of vectors) assert.equal(hotp(RFC_SECRET, totpStep(seconds * 1000), 8), code, `T=${seconds}`);
});

test("base32 round-trips, ignores case, spaces and hyphens, and refuses anything else", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  const text = base32Encode(secret);
  assert.equal(text, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode(text.toLowerCase().replace(/(.{4})/g, "$1 ")), secret);
  assert.throws(() => base32Decode("GEZD1"), /base32/);
});

test("a code is accepted one step either side of now, and no further", () => {
  const secret = base32Decode(newTotpSecret());
  const now = 1_800_000_000_000;
  const step = totpStep(now);
  for (const offset of [-1, 0, 1]) {
    const r = verifyTotp(secret, hotp(secret, step + offset), now, null);
    assert.deepEqual(r, { ok: true, step: step + offset }, `offset ${offset}`);
  }
  for (const offset of [-2, 2]) assert.deepEqual(verifyTotp(secret, hotp(secret, step + offset), now, null), { ok: false });
});

test("a code is good for ONE sign-in: its step, and every earlier one, is refused afterwards", () => {
  const secret = base32Decode(newTotpSecret());
  const now = 1_800_000_000_000;
  const step = totpStep(now);
  const code = hotp(secret, step);
  assert.deepEqual(verifyTotp(secret, code, now, step), { ok: false }, "a replay of the code just used");
  assert.deepEqual(verifyTotp(secret, hotp(secret, step - 1), now, step), { ok: false }, "an older one");
  assert.deepEqual(verifyTotp(secret, hotp(secret, step + 1), now, step), { ok: true, step: step + 1 }, "the next step still works");
});

test("anything that is not six digits is refused before any comparison", () => {
  const secret = base32Decode(newTotpSecret());
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5a"]) assert.deepEqual(verifyTotp(secret, bad, Date.now(), null), { ok: false }, bad);
  // Spaces a person types between groups are fine.
  const now = Date.now();
  const code = hotp(secret, totpStep(now));
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now, null).ok, true);
});

test("the otpauth URI is what an authenticator app imports", () => {
  const uri = otpauthUri("GEZDGNBVGY3TQOJQ", "owner@clinic.test");
  assert.match(uri, /^otpauth:\/\/totp\/Mermaid%3Aowner%40clinic\.test\?/);
  const params = new URL(uri).searchParams;
  assert.equal(params.get("secret"), "GEZDGNBVGY3TQOJQ");
  assert.equal(params.get("issuer"), "Mermaid");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
});

test("recovery codes are ten, distinct, and only their hashes are kept — however they are typed", () => {
  const { codes, hashes } = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  assert.equal(recoveryCodeHash(codes[0]!.toLowerCase().replace("-", " ")), hashes[0]);
  assert.ok(!hashes.includes(codes[0]!), "the code itself is never stored");
});
