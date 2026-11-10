/**
 * Password hashing — scrypt with a per-hash salt, encoded self-describing so parameters can evolve.
 * Constant-time comparison. Pure (node:crypto only) → unit-testable without a DB.
 * Format: `scrypt$N$r$p$<saltB64>$<hashB64>`.
 */
import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from "node:crypto";

// promisify(scrypt) drops the options overload, so wrap it by hand to keep N/r/p configurable.
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr), r = Number(rStr), p = Number(pStr);
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, expected.length, { N: n, r, p })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
