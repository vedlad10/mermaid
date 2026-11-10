/**
 * PHI at rest — application-level envelope encryption.
 *
 * Four fields in this schema hold raw protected health information as the outside world sent it:
 * `verifications.record.cardText` (a photographed insurance card), `verifications.record.raw271`
 * (the payer's eligibility answer), `remittances.raw_835` and its copy inside the remittance
 * document (a payer's advice, naming patients and procedures), and the `raw837` inside a claim's
 * submission document. They are kept for provenance — an audit is worthless if the source can only
 * be paraphrased — and that makes them the highest-value target in the database.
 *
 * This previously named `patients.raw_card_text`, which does not exist. There IS a
 * `coverages.raw_card_text` column (migration 0005) and nothing reads or writes it; the card text
 * this module actually protects lives on the verification document. See the README for the full
 * table, and `assertPhiKeyInProduction` below for what happens when the key is missing.
 *
 * ── WHY NOT pgcrypto ───────────────────────────────────────────────────────────────────────────
 * `pgp_sym_encrypt(text, key)` is the obvious move and the wrong one: the key becomes a query
 * parameter, which puts it in `pg_stat_statements`, in slow-query logs, and in any DBA's session
 * history. Encrypting in the application keeps the key in one process's memory and out of the
 * database entirely, which also means a stolen backup is inert without the application's environment.
 *
 * ── FORMAT ─────────────────────────────────────────────────────────────────────────────────────
 *   v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>          — unbound (legacy)
 *   v2:<base64 iv>:<base64 auth tag>:<base64 ciphertext>          — BOUND to a row and a tenant
 *
 * Versioned so a second key or a second algorithm can be introduced without a big-bang rewrite: a
 * reader dispatches on the prefix, a writer always emits the current version. AES-256-GCM rather
 * than CBC because it is authenticated — a tampered ciphertext fails loudly instead of decrypting to
 * plausible garbage that then gets shown to a clinician.
 *
 * ── WHY v2 EXISTS: AUTHENTICATION IS NOT THE SAME AS BINDING (NEW-25) ──────────────────────────
 * GCM proves a ciphertext has not been ALTERED. It proves nothing about where it belongs, so a v1
 * value could be copied from one row to another — one patient's raw insurance card into a second
 * patient's record, one practice's 835 into another practice's — and would decrypt perfectly. The
 * authentication tag would verify, because nothing about the value was changed. Only its location
 * was, and the envelope had no opinion about location.
 *
 * That is a realistic threat precisely where it matters: anyone with UPDATE on the table but no
 * access to the key — a DBA, a compromised migration, a restored backup merged wrongly — can move
 * PHI between patients and between tenants, and every application read would present it as that
 * patient's own record.
 *
 * v2 binds the ciphertext to `practice|table|column|row` through GCM's additional authenticated
 * data. The AAD is not stored — it is RE-DERIVED from where the value was found — so a value read
 * from a row it was not written for fails its tag check and throws, rather than decrypting into
 * somebody else's chart.
 *
 * ── AND WHY v1 STILL READS ─────────────────────────────────────────────────────────────────────
 * Existing rows were written without AAD and cannot be upgraded without decrypting and re-encrypting
 * them, which touches live PHI and needs the key present. That is an operator's decision and a
 * scheduled maintenance action, not something a deploy does silently — so `v1:` keeps reading, every
 * new write is `v2:`, and `npm run db:encrypt-phi -- --rebind` upgrades the rest when it suits.
 *
 * The residual is stated rather than glossed: until that backfill runs, rows still carrying `v1:`
 * remain movable. `phiBindingStatus()` counts them so it is a number somebody can see, not a
 * footnote.
 *
 * ── DEPLOYING THIS TO A DATABASE THAT ALREADY HAS PLAINTEXT ────────────────────────────────────
 * `decryptPhi` passes through anything without a recognised prefix. That is what makes this shippable
 * without a maintenance window: existing rows keep reading, every new write is encrypted, and a
 * backfill can run whenever it suits. The alternative — refusing to read legacy rows — would mean the
 * deploy and the backfill had to be simultaneous and perfect.
 *
 * ── FAIL CLOSED IN PRODUCTION ──────────────────────────────────────────────────────────────────
 * With no key configured, this is a no-op and says so once, loudly. In production that is not a
 * degraded mode, it is a misconfiguration that would silently write PHI in the clear — so
 * `assertPhiKeyInProduction()` refuses to boot.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getSecret } from "@mermaid/config";

const VERSION = "v1";
/** The bound envelope: identical crypto, plus GCM additional authenticated data (NEW-25). */
const BOUND_VERSION = "v2";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits — the size GCM is specified for
const KEY_BYTES = 32; // AES-256

export class PhiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhiKeyError";
  }
}

/** Parse the configured key. Exported so a boot check can validate it before any request runs. */
export function readKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim() === "") return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new PhiKeyError(
      `PHI_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64 (got ${key.length}). ` +
        `Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return key;
}

let cached: { raw: string | undefined; key: Buffer | null } | null = null;

/**
 * The active key, or null when encryption is not configured. Re-read when it changes (tests).
 *
 * Through `getSecret` rather than `process.env` (NEW-09). The secrets seam existed with zero
 * production callers, which made it a description of a design rather than the design: this is the
 * most sensitive credential the system holds, and it was read the same ad-hoc way as a port number.
 * Routing it here is what lets a managed secrets manager supply it later without touching this file.
 */
function activeKey(): Buffer | null {
  const raw = getSecret("PHI_ENCRYPTION_KEY");
  if (!cached || cached.raw !== raw) cached = { raw, key: readKey(raw) };
  return cached.key;
}

/** True when writes will actually be encrypted. Reported by the ops health endpoint. */
export const phiEncryptionEnabled = (): boolean => activeKey() !== null;

/**
 * Refuse to boot a production process that would write PHI in the clear.
 *
 * Called from the composition root. This is deliberately a hard failure rather than a warning: a
 * warning in a log nobody reads is how a compliance control becomes a compliance finding.
 */
export function assertPhiKeyInProduction(nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv === "production" && !phiEncryptionEnabled()) {
    throw new PhiKeyError(
      "PHI_ENCRYPTION_KEY is not set. Refusing to start in production: raw insurance cards, 835s " +
        "and 837s would be written to the database in plaintext."
    );
  }
}

/**
 * Where a PHI value lives. Bound into the ciphertext so it cannot be read from anywhere else.
 *
 * Every field is part of the answer to "is this value in the place it was written to?": the tenant,
 * the table, the column and the row. `column` matters as much as the rest — without it, a raw 835
 * and a raw 837 on the same row would be interchangeable, which is a smaller mistake than crossing
 * a patient boundary but is still a value appearing somewhere it was never put.
 */
export interface PhiLocation {
  practiceId: string;
  table: string;
  column: string;
  rowId: string;
}

/**
 * The additional authenticated data for a location — NOT stored, always re-derived.
 *
 * That is the whole mechanism: a reader computes it from where the value was FOUND, so a value that
 * has been moved computes a different AAD and fails its tag check. Storing it alongside would move
 * with the ciphertext and prove nothing.
 *
 * NUL-separated because none of the four components may contain it, so no pair of different
 * locations can produce the same string by concatenation.
 */
const aadFor = (at: PhiLocation): Buffer =>
  Buffer.from([at.practiceId, at.table, at.column, at.rowId].join("\u0000"), "utf8");

/**
 * Encrypt a PHI string for storage. Returns the input unchanged when no key is configured.
 *
 * With `at`, the value is BOUND to that location and emitted as `v2:` — it will not decrypt
 * anywhere else. Without it, `v1:` as before; that path exists for the operational backfill, which
 * re-encrypts values whose location it is in the middle of establishing.
 */
export function encryptPhi(plaintext: string | null | undefined, at?: PhiLocation): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const key = activeKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (at) cipher.setAAD(aadFor(at));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    at ? BOUND_VERSION : VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a stored PHI string.
 *
 * Anything without a recognised version prefix is returned as-is: that is a row written before
 * encryption was enabled, and refusing to read it would break the deploy rather than protect it.
 */
export function decryptPhi(stored: string | null | undefined, at?: PhiLocation): string | null {
  if (stored === null || stored === undefined) return null;

  const bound = stored.startsWith(`${BOUND_VERSION}:`);
  if (!bound && !stored.startsWith(`${VERSION}:`)) return stored;

  /**
   * A `v2:` value read WITHOUT a location cannot be verified, so it is refused rather than
   * decrypted unverified. Silently falling back would make the binding optional in practice — one
   * forgotten argument at one call site and the protection is gone for that column, with nothing
   * to show for it.
   */
  if (bound && !at) {
    throw new PhiKeyError(
      "this value is bound to the row it was written to (v2) and was read without a location. " +
        "Pass the PhiLocation it came from — practice, table, column and row — so the binding can " +
        "be checked."
    );
  }

  const key = activeKey();
  if (!key) {
    throw new PhiKeyError(
      "an encrypted value was read but PHI_ENCRYPTION_KEY is not set — the key this data was " +
        "written with must be configured before it can be read"
    );
  }

  const parts = stored.split(":");
  const [, ivB64, tagB64, dataB64] = parts;
  // The ciphertext segment may legitimately be EMPTY — an empty string encrypts to zero bytes, and a
  // truthiness check here would reject it. The iv and tag never can be.
  if (parts.length !== 4 || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new PhiKeyError(
      `malformed encrypted PHI value — expected ${bound ? BOUND_VERSION : VERSION}:<iv>:<tag>:<ciphertext>`
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // Re-derived from where this value was FOUND, never read from the stored value. A ciphertext
  // moved to another row computes a different AAD here and fails `final()` below (NEW-25).
  if (bound && at) decipher.setAAD(aadFor(at));
  // Throws on a tampered ciphertext or the wrong key — authenticated encryption earning its keep.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString(
    "utf8"
  );
}

/** True when a stored value is already encrypted — used by the backfill to skip what is done. */
/** True when this value is BOUND to a row — a `v2:` envelope (NEW-25). */
export const isRowBound = (stored: string | null | undefined): boolean =>
  typeof stored === "string" && stored.startsWith(`${BOUND_VERSION}:`);

export const isEncrypted = (stored: string | null | undefined): boolean =>
  typeof stored === "string" &&
  // BOTH envelopes. Recognising only v1 would make every newly-written value read as plaintext —
  // and the ERA readiness check (NEW-11) would fail on exactly the rows that are most protected.
  (stored.startsWith(`${VERSION}:`) || stored.startsWith(`${BOUND_VERSION}:`));
