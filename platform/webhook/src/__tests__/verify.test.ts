import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TOLERANCE_SECONDS,
  MIN_SECRET_BYTES,
  WebhookConfigurationError,
  defineWebhookAuth,
  generateWebhookSecret,
  verifyWebhookRequest,
  type HmacAuthConfig,
  type WebhookRequest,
} from "../verify.ts";

const SECRET = "kQ8vN2xR7pL4mT9wZ1cB5nH3jF6dS0aY";           // exactly 32 bytes
const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BODY = Buffer.from('{"transactionId":"tx_1","amountCents":125000}', "utf8");

const req = (headers: Record<string, string | string[] | undefined>, body = BODY): WebhookRequest => ({
  headers,
  body,
});

// ── Configuration is refused at construction, not at request time ────────────────────────────────

test("an empty secret is refused, with a reason an operator can act on", () => {
  assert.throws(
    () => defineWebhookAuth({ scheme: "bearer", secret: "" }),
    (e: unknown) => e instanceof WebhookConfigurationError && /empty/.test((e as Error).message)
  );
  assert.throws(() => defineWebhookAuth({ scheme: "bearer", secret: "   " }), WebhookConfigurationError);
});

test("a secret shorter than the floor is refused — under bearer it is the whole perimeter", () => {
  const short = "a".repeat(MIN_SECRET_BYTES - 1);
  assert.throws(() => defineWebhookAuth({ scheme: "bearer", secret: short }), WebhookConfigurationError);
  // The floor is a floor, not a fence: exactly MIN_SECRET_BYTES is acceptable.
  assert.doesNotThrow(() => defineWebhookAuth({ scheme: "bearer", secret: "a".repeat(MIN_SECRET_BYTES) }));
});

test("the secret floor counts BYTES, not characters", () => {
  // 31 emoji are 31 characters and 124 bytes; 8 of them are 8 characters and 32 bytes. Measuring
  // `.length` would reject the strong one and accept nothing weaker — but a future change to
  // measure characters would let a 32-character-but-low-entropy value through unchanged, so pin
  // the unit that is actually being counted.
  assert.equal(Buffer.byteLength("🔐".repeat(8), "utf8"), 32);
  assert.doesNotThrow(() => defineWebhookAuth({ scheme: "bearer", secret: "🔐".repeat(8) }));
  assert.throws(() => defineWebhookAuth({ scheme: "bearer", secret: "🔐".repeat(7) }), WebhookConfigurationError);
});

test("generateWebhookSecret produces something defineWebhookAuth accepts, and never repeats", () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert.notEqual(a, b);
  assert.ok(Buffer.byteLength(a, "utf8") >= MIN_SECRET_BYTES);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url — safe to paste into any console or header
  assert.doesNotThrow(() => defineWebhookAuth({ scheme: "bearer", secret: a }));
});

test("empty header names and unknown encodings are refused", () => {
  assert.throws(
    () => defineWebhookAuth({ scheme: "bearer", secret: SECRET, header: "  " }),
    WebhookConfigurationError
  );
  assert.throws(
    () => defineWebhookAuth({ scheme: "hmac", secret: SECRET, signatureHeader: "", encoding: "hex" }),
    WebhookConfigurationError
  );
  assert.throws(
    () =>
      defineWebhookAuth({
        scheme: "hmac",
        secret: SECRET,
        signatureHeader: "x-sig",
        encoding: "base32" as HmacAuthConfig["encoding"],
      }),
    WebhookConfigurationError
  );
});

test("a non-positive tolerance is refused — it would reject every genuine signature", () => {
  assert.throws(
    () =>
      defineWebhookAuth({
        scheme: "hmac",
        secret: SECRET,
        signatureHeader: "x-sig",
        encoding: "hex",
        timestampHeader: "x-ts",
        toleranceSeconds: 0,
      }),
    WebhookConfigurationError
  );
});

// ── Bearer: Stedi's actual scheme ────────────────────────────────────────────────────────────────

const bearer = defineWebhookAuth({ scheme: "bearer", secret: SECRET });

test("the configured secret authenticates; anything else does not", () => {
  assert.deepEqual(verifyWebhookRequest(bearer, req({ authorization: SECRET })), {
    ok: true,
    scheme: "bearer",
  });
  const bad = verifyWebhookRequest(bearer, req({ authorization: OTHER }));
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.reason, "credential_mismatch");
});

test("a credential that is a PREFIX of the secret does not authenticate", () => {
  // The failure mode a length-guarded comparison invites: truncate and probe.
  const truncated = verifyWebhookRequest(bearer, req({ authorization: SECRET.slice(0, 31) }));
  assert.equal(truncated.ok, false);
  const extended = verifyWebhookRequest(bearer, req({ authorization: `${SECRET}x` }));
  assert.equal(extended.ok, false);
});

test("a missing or blank credential is refused", () => {
  assert.equal(verifyWebhookRequest(bearer, req({})).ok, false);
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: "" })).ok, false);
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: "   " })).ok, false);
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: undefined })).ok, false);
  const verdict = verifyWebhookRequest(bearer, req({}));
  assert.equal(verdict.ok === false && verdict.reason, "missing_credential");
});

test("header matching is case-insensitive in both directions", () => {
  assert.equal(verifyWebhookRequest(bearer, req({ Authorization: SECRET })).ok, true);
  assert.equal(verifyWebhookRequest(bearer, req({ AUTHORIZATION: SECRET })).ok, true);
  const named = defineWebhookAuth({ scheme: "bearer", secret: SECRET, header: "X-Stedi-Key" });
  assert.equal(verifyWebhookRequest(named, req({ "x-stedi-key": SECRET })).ok, true);
});

test("a repeated credential header is refused rather than resolved", () => {
  // Taking [0] — or [last] — is the concession that request smuggling is built on. No genuine
  // delivery sends its credential twice, so there is nothing to lose by refusing outright.
  const doubled = verifyWebhookRequest(bearer, req({ authorization: [SECRET, OTHER] }));
  assert.equal(doubled.ok, false);
  assert.equal(doubled.ok === false && doubled.reason, "duplicate_header");
  // Even when BOTH copies are correct: the disagreement itself is the signal.
  const bothValid = verifyWebhookRequest(bearer, req({ authorization: [SECRET, SECRET] }));
  assert.equal(bothValid.ok, false);
  // And when the repeat arrives under different casing, which an array does not capture.
  const mixedCase = verifyWebhookRequest(bearer, req({ authorization: SECRET, Authorization: OTHER }));
  assert.equal(mixedCase.ok, false);
  assert.equal(mixedCase.ok === false && mixedCase.reason, "duplicate_header");
});

test("a configured prefix is required, and is not counted as part of the secret", () => {
  const prefixed = defineWebhookAuth({ scheme: "bearer", secret: SECRET, prefix: "Bearer " });
  assert.equal(verifyWebhookRequest(prefixed, req({ authorization: `Bearer ${SECRET}` })).ok, true);
  // The bare token, without the prefix the sender is configured to send, is a config mismatch —
  // reported distinctly so an operator is not hunting an attacker that is actually a checkbox.
  const bare = verifyWebhookRequest(prefixed, req({ authorization: SECRET }));
  assert.equal(bare.ok, false);
  assert.equal(bare.ok === false && bare.reason, "malformed_credential");
  // And the converse: a prefix nobody asked for is not silently tolerated.
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: `Bearer ${SECRET}` })).ok, false);
});

test("bearer does not read the body — that is the scheme's weakness, stated as a test", () => {
  // Documenting the property that makes M15 steps 3 and 4 mandatory rather than tidy: with a
  // correct token, ANY body authenticates. If a future change starts binding the body under
  // `bearer`, this test failing is the intended way to find out.
  const forged = Buffer.from('{"transactionId":"tx_1","amountCents":999999999}', "utf8");
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: SECRET }, forged)).ok, true);
  assert.equal(verifyWebhookRequest(bearer, req({ authorization: SECRET }, Buffer.alloc(0))).ok, true);
});

// ── HMAC: not reachable today, built because the primitive is easy to get subtly wrong ───────────

const hmacHex = defineWebhookAuth({
  scheme: "hmac",
  secret: SECRET,
  signatureHeader: "x-signature",
  encoding: "hex",
});

const sign = (body: Buffer, encoding: "hex" | "base64" = "hex", secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest(encoding);

test("a correct digest over the raw body authenticates", () => {
  const verdict = verifyWebhookRequest(hmacHex, req({ "x-signature": sign(BODY) }));
  assert.deepEqual(verdict, { ok: true, scheme: "hmac" });
});

test("a digest signed with a different secret does not authenticate", () => {
  const wrong = sign(BODY, "hex", `${OTHER}!!`);
  assert.equal(verifyWebhookRequest(hmacHex, req({ "x-signature": wrong })).ok, false);
});

test("one flipped byte in the body invalidates the signature", () => {
  const tampered = Buffer.from('{"transactionId":"tx_1","amountCents":125001}', "utf8");
  const verdict = verifyWebhookRequest(hmacHex, req({ "x-signature": sign(BODY) }, tampered));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "credential_mismatch");
});

test("a re-serialised body fails — the raw bytes are the signed payload", () => {
  // The single most likely integration bug: the route parses JSON, then hands the verifier
  // `Buffer.from(JSON.stringify(parsed))`. Semantically identical, byte-wise different, and the
  // resulting 401 looks like a wrong secret rather than a wrong buffer.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString("utf8"))) + " ", "utf8");
  assert.notEqual(reserialised.toString("utf8"), BODY.toString("utf8"));
  assert.equal(verifyWebhookRequest(hmacHex, req({ "x-signature": sign(BODY) }, reserialised)).ok, false);
});

test("base64 encoding is honoured, and is not interchangeable with hex", () => {
  const b64 = defineWebhookAuth({
    scheme: "hmac",
    secret: SECRET,
    signatureHeader: "x-signature",
    encoding: "base64",
  });
  assert.equal(verifyWebhookRequest(b64, req({ "x-signature": sign(BODY, "base64") })).ok, true);
  assert.equal(verifyWebhookRequest(b64, req({ "x-signature": sign(BODY, "hex") })).ok, false);
  assert.equal(verifyWebhookRequest(hmacHex, req({ "x-signature": sign(BODY, "base64") })).ok, false);
});

test("a signature prefix such as GitHub's sha256= is stripped before comparison", () => {
  const prefixed = defineWebhookAuth({
    scheme: "hmac",
    secret: SECRET,
    signatureHeader: "x-signature",
    encoding: "hex",
    signaturePrefix: "sha256=",
  });
  assert.equal(verifyWebhookRequest(prefixed, req({ "x-signature": `sha256=${sign(BODY)}` })).ok, true);
  const bare = verifyWebhookRequest(prefixed, req({ "x-signature": sign(BODY) }));
  assert.equal(bare.ok === false && bare.reason, "malformed_credential");
  const empty = verifyWebhookRequest(prefixed, req({ "x-signature": "sha256=" }));
  assert.equal(empty.ok, false);
});

// ── Timestamped signatures ───────────────────────────────────────────────────────────────────────

const stamped = defineWebhookAuth({
  scheme: "hmac",
  secret: SECRET,
  signatureHeader: "x-signature",
  encoding: "hex",
  timestampHeader: "x-timestamp",
  toleranceSeconds: 300,
});

const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const signStamped = (ts: number, body = BODY) =>
  createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${ts}.`, "utf8"), body])).digest("hex");

test("a fresh timestamped signature authenticates", () => {
  const headers = { "x-timestamp": String(NOW_S), "x-signature": signStamped(NOW_S) };
  assert.deepEqual(verifyWebhookRequest(stamped, req(headers), NOW), { ok: true, scheme: "hmac" });
});

test("the timestamp is part of the signed payload, not decoration", () => {
  // Signed over the body alone, then presented with a timestamp: must fail, or the timestamp
  // header could be rewritten at will while the signature still verified.
  const headers = { "x-timestamp": String(NOW_S), "x-signature": sign(BODY) };
  assert.equal(verifyWebhookRequest(stamped, req(headers), NOW).ok, false);
});

test("a signature cannot be moved to a different timestamp", () => {
  const headers = { "x-timestamp": String(NOW_S + 60), "x-signature": signStamped(NOW_S) };
  const verdict = verifyWebhookRequest(stamped, req(headers), NOW);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "credential_mismatch");
});

test("the tolerance window closes on both sides", () => {
  const at = (offset: number) => {
    const ts = NOW_S + offset;
    return verifyWebhookRequest(
      stamped,
      req({ "x-timestamp": String(ts), "x-signature": signStamped(ts) }),
      NOW
    );
  };
  assert.equal(at(300).ok, true, "exactly at the boundary is still inside");
  assert.equal(at(-300).ok, true);
  const stale = at(-301);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "timestamp_outside_tolerance");
  // The future is refused too. A signature minted for later is how a captured delivery is held.
  const ahead = at(301);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.ok === false && ahead.reason, "timestamp_outside_tolerance");
});

test("the default tolerance applies when none is configured", () => {
  const dflt = defineWebhookAuth({
    scheme: "hmac",
    secret: SECRET,
    signatureHeader: "x-signature",
    encoding: "hex",
    timestampHeader: "x-timestamp",
  });
  const ts = NOW_S - DEFAULT_TOLERANCE_SECONDS;
  const inside = { "x-timestamp": String(ts), "x-signature": signStamped(ts) };
  assert.equal(verifyWebhookRequest(dflt, req(inside), NOW).ok, true);
  const out = NOW_S - DEFAULT_TOLERANCE_SECONDS - 1;
  const outside = { "x-timestamp": String(out), "x-signature": signStamped(out) };
  assert.equal(verifyWebhookRequest(dflt, req(outside), NOW).ok, false);
});

test("a malformed timestamp is refused rather than coerced", () => {
  // Number("") is 0, Number(" 12 ") is 12 and Number("0x10") is 16 — each turns an unparseable
  // timestamp into a confident one, and 0 sits far outside every tolerance, so the coercion would
  // read as "stale" and hide the real fault.
  for (const value of ["", "   ", "abc", "0x10", " 1770000000 ", "1770000000.5", "-1770000000", "1e9"]) {
    const verdict = verifyWebhookRequest(
      stamped,
      req({ "x-timestamp": value, "x-signature": signStamped(NOW_S) }),
      NOW
    );
    assert.equal(verdict.ok, false, `"${value}" must not authenticate`);
  }
  const nonNumeric = verifyWebhookRequest(
    stamped,
    req({ "x-timestamp": "abc", "x-signature": signStamped(NOW_S) }),
    NOW
  );
  assert.equal(nonNumeric.ok === false && nonNumeric.reason, "malformed_timestamp");
});

test("a missing timestamp is refused when the scheme signs one", () => {
  const verdict = verifyWebhookRequest(stamped, req({ "x-signature": signStamped(NOW_S) }), NOW);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "missing_timestamp");
});

test("a repeated timestamp header is refused", () => {
  const headers = {
    "x-timestamp": [String(NOW_S), String(NOW_S - 400)],
    "x-signature": signStamped(NOW_S),
  };
  const verdict = verifyWebhookRequest(stamped, req(headers), NOW);
  assert.equal(verdict.ok === false && verdict.reason, "duplicate_header");
});

test("replay INSIDE the window still verifies — freshness is not duplicate detection", () => {
  // Pinning the boundary of what this module does, so M15 step 3 is not skipped on the belief
  // that the tolerance window already covers it.
  const headers = { "x-timestamp": String(NOW_S), "x-signature": signStamped(NOW_S) };
  assert.equal(verifyWebhookRequest(stamped, req(headers), NOW).ok, true);
  assert.equal(verifyWebhookRequest(stamped, req(headers), NOW).ok, true);
  const later = new Date(NOW.getTime() + 299_000);
  assert.equal(verifyWebhookRequest(stamped, req(headers), later).ok, true);
});

// ── Nothing leaks, and nothing throws ────────────────────────────────────────────────────────────

test("no rejection detail ever contains the secret or the presented credential", () => {
  const attempts: WebhookRequest[] = [
    req({}),
    req({ authorization: OTHER }),
    req({ authorization: [SECRET, OTHER] }),
    req({ authorization: `Bearer ${SECRET}` }),
  ];
  const prefixed = defineWebhookAuth({ scheme: "bearer", secret: SECRET, prefix: "Bearer " });
  for (const config of [bearer, prefixed]) {
    for (const attempt of attempts) {
      const verdict = verifyWebhookRequest(config, attempt);
      if (verdict.ok) continue;
      assert.ok(!verdict.detail.includes(SECRET), "a rejection must not echo the secret");
      assert.ok(!verdict.detail.includes(OTHER), "a rejection must not echo what was presented");
    }
  }
  const hmacFail = verifyWebhookRequest(hmacHex, req({ "x-signature": sign(BODY, "hex", OTHER) }));
  assert.ok(hmacFail.ok === false && !hmacFail.detail.includes(SECRET));
});

test("hostile input produces a verdict, never an exception", () => {
  const nasty: WebhookRequest[] = [
    req({ authorization: "  " }),
    req({ authorization: "%s%s%n" }),
    req({ authorization: "a".repeat(100_000) }),
    req({ authorization: [] }),
    req({ "x-signature": "!!!!not-hex!!!!" }),
    req({ "x-signature": "".padEnd(64, "z") }),
    req({ "x-timestamp": "9".repeat(400), "x-signature": "deadbeef" }),
    req({ authorization: SECRET }, Buffer.from([0xff, 0xfe, 0x00, 0x01])),
  ];
  for (const config of [bearer, hmacHex, stamped]) {
    for (const attempt of nasty) {
      assert.doesNotThrow(() => verifyWebhookRequest(config, attempt, NOW));
    }
  }
});

test("the credential comparison is structurally constant-time", () => {
  /**
   * ── WHY THIS TEST READS SOURCE INSTEAD OF CALLING SOMETHING ──────────────────────────────────
   * Every other test here was written first and then checked by mutating the implementation to see
   * which ones failed. All of them bit except one: replacing the digest comparison with a plain
   * `presented === expected` passed the entire suite. It would — the two are functionally
   * identical, and the difference is only in how long the wrong answer takes to arrive. `===`
   * returns at the first differing byte, which turns a 32-byte secret into 32 independent
   * one-byte guesses.
   *
   * A statistical timing assertion is the obvious alternative and the wrong one: it is slow, it is
   * flaky on shared CI hardware, and a flaky security test gets muted. So the property is pinned
   * structurally, scoped to this one function so unrelated edits cannot break it.
   */
  const source = readFileSync(new URL("../verify.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function secretEquals"));
  const fn = body.slice(0, body.indexOf("\n}") + 2);
  assert.ok(fn.includes("function secretEquals"), "secretEquals must still exist under that name");

  assert.ok(fn.includes("timingSafeEqual("), "secretEquals must compare with timingSafeEqual");
  assert.equal(
    (fn.match(/createHash\("sha256"\)/g) ?? []).length,
    2,
    "both sides must be hashed to a fixed 32 bytes, or the comparison leaks the secret's length"
  );
  for (const forbidden of ["===", "!==", "==", "!=", ".length", ".startsWith", ".indexOf", ".localeCompare"]) {
    assert.ok(
      !fn.includes(forbidden),
      `secretEquals must not use ${forbidden} — every short-circuit is a timing oracle`
    );
  }
});

test("no configuration authenticates a request that carries no credential at all", () => {
  // The property that must survive every future refactor: there is no path to `ok: true` without
  // a secret being presented. An unauthenticated webhook accepts a remittance from anyone.
  for (const config of [bearer, hmacHex, stamped]) {
    assert.equal(verifyWebhookRequest(config, req({}), NOW).ok, false);
    assert.equal(verifyWebhookRequest(config, req({ "content-type": "application/json" }), NOW).ok, false);
  }
});
