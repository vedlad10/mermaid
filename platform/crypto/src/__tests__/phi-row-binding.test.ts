/**
 * A ciphertext cannot be moved between rows, patients or practices (NEW-25).
 *
 * ── AUTHENTICATION IS NOT BINDING ────────────────────────────────────────────────────────────────
 * GCM proves a ciphertext has not been ALTERED. It proves nothing about where it belongs. So a `v1:`
 * value could be copied from one row to another — one patient's raw insurance card into a second
 * patient's record, one practice's 835 into another practice's — and would decrypt perfectly, tag
 * check and all, because nothing about the value had changed. Only its location had, and the
 * envelope had no opinion about location.
 *
 * The threat is realistic exactly where it matters: anyone with UPDATE on the table and no access to
 * the key — a DBA, a compromised migration, a backup restored and merged wrongly — could move PHI
 * between patients and between tenants, and every application read would present it as that
 * patient's own record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptPhi, encryptPhi, isEncrypted, isRowBound } from "../phi.ts";
import type { PhiLocation } from "../phi.ts";

/** A throwaway 32-byte key. Its value is meaningless; only its length matters here. */
const KEY = "aozEFhM5/CuT5JtzCgoZZZb2xvpXD2bBHgfKDigFoSo=";

/** Run `fn` with a key configured, restoring the environment afterwards. */
function withKey<T>(fn: () => T): T {
  const saved = process.env.PHI_ENCRYPTION_KEY;
  process.env.PHI_ENCRYPTION_KEY = KEY;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PHI_ENCRYPTION_KEY;
    else process.env.PHI_ENCRYPTION_KEY = saved;
  }
}

const ADA: PhiLocation = {
  practiceId: "11111111-1111-4111-8111-111111111111",
  table: "verifications",
  column: "cardText",
  rowId: "aaaaaaaa-1111-4111-8111-111111111111",
};

const CARD = "DELTA DENTAL\nADA ALPHA\nMEMBER ABC12345";

test("a bound value decrypts in its own row", () => {
  withKey(() => {
    const stored = encryptPhi(CARD, ADA)!;
    assert.equal(decryptPhi(stored, ADA), CARD);
  });
});

test("the same value REFUSES to decrypt in another patient's row", () => {
  /**
   * The whole point. Same practice, same table, same column — a different patient. Before this, the
   * copy decrypted and the second patient's chart showed the first patient's insurance card.
   */
  withKey(() => {
    const stored = encryptPhi(CARD, ADA)!;
    const otherPatient: PhiLocation = { ...ADA, rowId: "bbbbbbbb-2222-4222-8222-222222222222" };

    assert.throws(
      () => decryptPhi(stored, otherPatient),
      /unable to authenticate|unsupported state|bad decrypt/i,
      "a value moved to another row must fail its tag check, not decrypt"
    );
  });
});

test("and refuses in another PRACTICE's row — the tenant boundary", () => {
  withKey(() => {
    const stored = encryptPhi(CARD, ADA)!;
    const otherTenant: PhiLocation = { ...ADA, practiceId: "99999999-9999-4999-8999-999999999999" };
    assert.throws(() => decryptPhi(stored, otherTenant), /unable to authenticate|unsupported state|bad decrypt/i);
  });
});

test("and refuses in another COLUMN of the same row", () => {
  /**
   * Not an afterthought. A verification holds the card text and the payer's 271 on one row; without
   * the column in the binding the two would be interchangeable, and a 271 presented as a card
   * reading is a smaller mistake than crossing a patient boundary but is still a value appearing
   * somewhere it was never put.
   */
  withKey(() => {
    const stored = encryptPhi(CARD, ADA)!;
    assert.throws(
      () => decryptPhi(stored, { ...ADA, column: "raw271" }),
      /unable to authenticate|unsupported state|bad decrypt/i
    );
  });
});

test("a bound value read with NO location is refused, never decrypted unverified", () => {
  /**
   * Falling back to an unverified decrypt would make the binding optional in practice: one forgotten
   * argument at one call site and the protection is gone for that column, with nothing to show for
   * it. The refusal names what is missing.
   */
  withKey(() => {
    const stored = encryptPhi(CARD, ADA)!;
    assert.throws(() => decryptPhi(stored), /bound to the row|PhiLocation/i);
  });
});

test("a LEGACY v1 value still reads — the deploy does not need a maintenance window", () => {
  /**
   * Existing rows were written before the binding existed and cannot be upgraded without decrypting
   * and re-encrypting them, which touches live PHI. Refusing to read them would make the deploy and
   * the backfill simultaneous and perfect, which is the trade this envelope has always declined.
   */
  withKey(() => {
    const legacy = encryptPhi(CARD)!;
    assert.ok(legacy.startsWith("v1:"));
    assert.equal(decryptPhi(legacy), CARD, "with no location");
    assert.equal(decryptPhi(legacy, ADA), CARD, "and with one — v1 carries no binding to check");
  });
});

test("the two envelopes are distinguishable, and both count as encrypted", () => {
  /**
   * `isEncrypted` gates the ERA readiness check (NEW-11) and the backfill's skip. Recognising only
   * v1 would report every newly-written credential as PLAINTEXT — the check would fire hardest on
   * exactly the rows that are most protected, which is how a control gets switched off.
   */
  withKey(() => {
    const legacy = encryptPhi(CARD)!;
    const bound = encryptPhi(CARD, ADA)!;

    assert.ok(bound.startsWith("v2:"));
    assert.equal(isRowBound(bound), true);
    assert.equal(isRowBound(legacy), false);
    assert.equal(isEncrypted(bound), true);
    assert.equal(isEncrypted(legacy), true);
    assert.equal(isEncrypted("DELTA DENTAL"), false);
  });
});

test("with no key configured, binding changes nothing — the value passes through", () => {
  /**
   * The DB-free demo and any deployment that has not configured a key. `assertPhiKeyInProduction`
   * is what makes that a boot failure in production; here it must simply be a no-op rather than a
   * new way to throw.
   */
  const saved = process.env.PHI_ENCRYPTION_KEY;
  delete process.env.PHI_ENCRYPTION_KEY;
  try {
    assert.equal(encryptPhi(CARD, ADA), CARD);
    assert.equal(decryptPhi(CARD, ADA), CARD);
  } finally {
    if (saved !== undefined) process.env.PHI_ENCRYPTION_KEY = saved;
  }
});
