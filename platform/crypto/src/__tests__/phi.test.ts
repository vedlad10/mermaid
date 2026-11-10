/**
 * PHI encryption tests.
 *
 * The properties worth asserting are the ones that decide whether this is deployable and whether it
 * is actually protective: a round trip, a tampered ciphertext failing loudly rather than decrypting
 * to garbage, legacy plaintext still readable, and a production process refusing to start without a
 * key rather than quietly writing cards in the clear.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  PhiKeyError,
  assertPhiKeyInProduction,
  decryptPhi,
  encryptPhi,
  isEncrypted,
  phiEncryptionEnabled,
  readKey,
} from "../index.ts";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const CARD = "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100\nAda Alpha  DOB 1990-04-12";

const original = process.env.PHI_ENCRYPTION_KEY;
const withKey = (key: string | undefined) => {
  if (key === undefined) delete process.env.PHI_ENCRYPTION_KEY;
  else process.env.PHI_ENCRYPTION_KEY = key;
};

afterEach(() => withKey(original));
after(() => withKey(original));

/**
 * Corrupt one byte of a base64 segment by flipping its lowest bit.
 *
 * This mutates the DECODED BYTES and re-encodes, rather than editing a base64 character in place.
 * The two are not the same operation. When a payload's length is not a multiple of three, base64
 * pads, and the final significant character carries "don't care" low bits that decoding discards —
 * `A` (000000) and `B` (000001) differ only in such a bit. An earlier version of this test flipped
 * `A`/`B` at a fixed character offset and so, whenever the random IV produced a ciphertext whose
 * last significant character was `A`, re-encoded to a byte-identical payload: it tampered with
 * nothing, GCM correctly did not throw, and the test failed. That was a real 1-in-16 flake, not a
 * platform quirk. XOR against a byte always changes that byte, whatever its value and wherever it
 * sits, so every mutation below is genuine tampering on every run.
 */
const tamperByte = (b64: string, index: number): string => {
  const bytes = Buffer.from(b64, "base64");
  bytes[index] = bytes[index]! ^ 0x01;
  return bytes.toString("base64");
};

/** Every message Node's OpenSSL bindings use to report a failed GCM authentication. */
const AUTHENTICATION_FAILED = /unable to authenticate|bad decrypt|Unsupported state/i;

test("a round trip returns exactly what went in", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  assert.notEqual(stored, CARD, "the stored value must not be the plaintext");
  assert.ok(!stored.includes("ABC12345"), "no fragment of the card may survive in the clear");
  assert.equal(decryptPhi(stored), CARD);
});

test("every encryption of the same value differs — a random IV, not a deterministic one", () => {
  withKey(KEY);
  const a = encryptPhi(CARD)!;
  const b = encryptPhi(CARD)!;
  assert.notEqual(a, b, "identical ciphertexts would leak which patients share a payer");
  assert.equal(decryptPhi(a), decryptPhi(b));
});

test("the stored format is versioned, so a second key or algorithm can be introduced later", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  assert.match(stored, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(isEncrypted(stored), true);
  assert.equal(isEncrypted(CARD), false);
});

test("a tampered ciphertext fails loudly instead of decrypting to plausible garbage", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  const [v, iv, tag, data] = stored.split(":");

  // Exhaustive over every byte rather than one sampled offset. A single position that could be
  // altered undetected is the entire vulnerability this test exists to rule out, and sampling one
  // offset is exactly how the previous version concealed a flake for as long as it did.
  const length = Buffer.from(data!, "base64").length;
  assert.ok(length > 0, "the fixture must actually produce ciphertext to tamper with");

  for (let index = 0; index < length; index++) {
    assert.throws(
      () => decryptPhi([v, iv, tag, tamperByte(data!, index)].join(":")),
      AUTHENTICATION_FAILED,
      `GCM is authenticated encryption precisely so tampering at ciphertext byte ${index} cannot silently succeed`
    );
  }
});

test("moving the IV or forging the auth tag is caught too — GCM authenticates every segment", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  const [v, iv, tag, data] = stored.split(":");

  assert.throws(
    () => decryptPhi([v, tamperByte(iv!, 0), tag, data].join(":")),
    AUTHENTICATION_FAILED,
    "a ciphertext replayed under a different IV must not decrypt"
  );
  assert.throws(
    () => decryptPhi([v, iv, tamperByte(tag!, 0), data].join(":")),
    AUTHENTICATION_FAILED,
    "an attacker who can edit the tag must not be able to make a payload authenticate"
  );
});

test("the wrong key cannot read the data", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  withKey(OTHER_KEY);
  assert.throws(() => decryptPhi(stored));
});

test("legacy plaintext still reads — this ships without a maintenance window", () => {
  withKey(KEY);
  assert.equal(
    decryptPhi(CARD),
    CARD,
    "a row written before encryption was enabled must keep reading, or the deploy and the backfill " +
      "would have to be simultaneous and perfect"
  );
});

test("with no key configured, encryption is a no-op rather than a crash", () => {
  withKey(undefined);
  assert.equal(phiEncryptionEnabled(), false);
  assert.equal(encryptPhi(CARD), CARD, "the DB-free laptop demo must still run");
  assert.equal(decryptPhi(CARD), CARD);
});

test("but encrypted data cannot be read once the key is taken away", () => {
  withKey(KEY);
  const stored = encryptPhi(CARD)!;
  withKey(undefined);
  assert.throws(() => decryptPhi(stored), PhiKeyError, "silently returning ciphertext would be worse");
});

test("null and undefined pass through — every one of these columns is nullable", () => {
  withKey(KEY);
  assert.equal(encryptPhi(null), null);
  assert.equal(encryptPhi(undefined), null);
  assert.equal(decryptPhi(null), null);
  assert.equal(decryptPhi(undefined), null);
});

test("an empty string round-trips as an empty string, not as null", () => {
  withKey(KEY);
  assert.equal(decryptPhi(encryptPhi("")), "");
});

test("a key of the wrong length is rejected at parse time, not at first use", () => {
  assert.throws(() => readKey(randomBytes(16).toString("base64")), /must be 32 bytes/);
  assert.equal(readKey(undefined), null);
  assert.equal(readKey("   "), null);
});

test("production refuses to start without a key", () => {
  withKey(undefined);
  assert.throws(
    () => assertPhiKeyInProduction("production"),
    /Refusing to start in production/,
    "a warning in a log nobody reads is how a compliance control becomes a compliance finding"
  );

  withKey(KEY);
  assert.doesNotThrow(() => assertPhiKeyInProduction("production"));
});

test("development without a key is allowed — that is the laptop demo", () => {
  withKey(undefined);
  assert.doesNotThrow(() => assertPhiKeyInProduction("development"));
});

test("a large document encrypts and decrypts intact", () => {
  withKey(KEY);
  const era = "ISA*00*...~".repeat(5000);
  assert.equal(decryptPhi(encryptPhi(era)), era);
});
