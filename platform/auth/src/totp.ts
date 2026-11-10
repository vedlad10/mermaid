/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), and the recovery codes beside them.
 *
 * Pure, `node:crypto` only — no dependency, because the algorithm is forty lines and every authenticator
 * app implements exactly this: HMAC-SHA1, a 30-second step, six digits, a base32 secret. The
 * published RFC 6238 test vectors pin it (`__tests__/totp.test.ts`).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./session.ts";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side: a phone clock 30 seconds out still signs in; 90 seconds out does not. */
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("not a base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: HMAC-SHA1 of the 8-byte counter, dynamically truncated to `digits` digits. */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/**
 * Check a six-digit code against a secret, refusing any step at or before `lastStep`.
 *
 * Returns the step that matched, so the caller can record it: a code is good for ONE sign-in. Without
 * that, a code read over a shoulder or out of a phishing page could be replayed for the rest of its
 * 90-second life. The comparison is constant-time per candidate.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastStep: number | null
): { ok: true; step: number } | { ok: false } {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return { ok: false };
  const current = totpStep(nowMs);
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(given))) return { ok: true, step };
  }
  return { ok: false };
}

/** A new secret: 160 bits, the size RFC 4226 recommends and every authenticator accepts. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/**
 * The `otpauth://` URI an authenticator app imports. The label names the practice's product and the
 * account, so a person with several entries can tell which is which; nothing in it is a secret but
 * the secret itself.
 */
export function otpauthUri(secretBase32: string, accountEmail: string, issuer = "Mermaid"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Ten single-use recovery codes, for the phone that is lost. Shown ONCE; only their hashes are kept,
 * like session tokens, so a leaked row cannot be replayed. Fifty bits each, grouped for reading aloud.
 */
export function newRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(recoveryCodeHash) };
}

/** Case and the hyphen do not matter to a person typing it, so they do not matter here. */
export const recoveryCodeHash = (code: string): string => sha256(code.toUpperCase().replace(/[\s-]/g, ""));
