/**
 * The boot-time refusals.
 *
 * A configuration mistake that reaches a payer is not a configuration mistake any more — it is a
 * false statement about who rendered care, on a document that is a legal attestation. The only place
 * to catch that is before the process is serving, which is what these assert.
 *
 * `assertBillingProviderConfigured` is exercised directly rather than through `getConfig()`, because
 * `getConfig` memoizes and reads the ambient environment; driving it from a test would mean mutating
 * `process.env.NODE_ENV` inside a suite that runs other things concurrently.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  DEMO_BILLING_PROVIDER,
  assertBillingProviderConfigured,
  assertSecureCookiesConfigured,
  type Config,
} from "../env.ts";

const config = (over: Partial<Config> = {}): Config =>
  ({
    nodeEnv: "production",
    isProd: true,
    port: 3000,
    databaseUrl: "postgres://x",
    databaseAdminUrl: "postgres://x",
    /**
     * ── THE FIXTURE NOW SAYS IT CAN REACH A PAYER, BECAUSE THAT IS WHAT THE GUARD ASKS ──────────
     * `assertBillingProviderConfigured` used to trigger on `isProd`. It triggers on
     * `filesToRealPayers` now — the fact its own message is about ("a false attestation to a
     * PAYER") — which is strictly stronger: it also refuses a laptop wired to a live clearinghouse,
     * which the old condition let through.
     *
     * These cases are about a deployment that CAN file, so the fixture says so. The demo-on-mock
     * case, which must boot rather than refuse, is asserted at the bottom of this block.
     */
    ediAdapter: "stedi",
    stediTestMode: false,
    filesToRealPayers: true,
    isDemoDeployment: false,
    llmProvider: "off",
    sessionTtlHours: 12,
    secureCookies: true,
    resetTtlSeconds: 3600,
    billingProviderName: "FIXTURE FAMILY DENTAL",
    billingProviderNpi: "1333333338",
    billingProviderTaxId: "987654321",
    ...over,
  }) as Config;

test("a configured practice boots", () => {
  assert.doesNotThrow(() => assertBillingProviderConfigured(config()));
});

/**
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────────────────────────
 *
 * `env.ts` used to claim "the scrubber rejects them in production, so an unconfigured practice
 * cannot quietly file claims under a fake NPI". It did not. The scrubber had one placeholder rule,
 * it looked only at the tax ID, and it raised a WARNING, which by design does not block the submit
 * gate. The demo NPI passes its check digit and the demo name was never checked at all.
 */
test("a deployment that can reach no payer boots under the demo identity", () => {
  /**
   * ── THE CASE THE OLD CONDITION FORBADE, AND SHOULD NOT HAVE ──────────────────────────────────
   * Setting NODE_ENV=production on a demonstration deployment is the correct thing to do — it is
   * what turns on secure cookies, HSTS, the proxy declaration and the real-identity refusal itself.
   * Keying this guard on `isProd` meant that doing the correct thing made the process refuse to
   * boot, for want of a real dental practice's NPI that a demonstration deployment does not have and
   * must not invent.
   *
   * On the mock connector there is no payer to attest anything to, so there is nothing to prove.
   * `isProd` stays true throughout: nothing about the hardening is relaxed, only the question of
   * whose identity is on a claim that is never filed.
   */
  assert.doesNotThrow(() =>
    assertBillingProviderConfigured(
      config({
        ediAdapter: "mock",
        filesToRealPayers: false,
        isDemoDeployment: true,
        billingProviderName: DEMO_BILLING_PROVIDER.name,
        billingProviderNpi: DEMO_BILLING_PROVIDER.npi,
        billingProviderTaxId: DEMO_BILLING_PROVIDER.taxId,
      })
    )
  );
});

test("a deployment wired to a live clearinghouse refuses the demo identity even outside production", () => {
  /**
   * The half that got STRONGER, and the reason this change is not a relaxation. The old condition
   * returned early for anything that was not NODE_ENV=production, so a laptop or a staging box with
   * EDI_ADAPTER=stedi and STEDI_TEST_MODE=0 could file a claim naming a provider that does not
   * exist — exactly the false attestation the refusal describes, permitted by the check meant to
   * prevent it.
   */
  assert.throws(
    () =>
      assertBillingProviderConfigured(
        config({
          nodeEnv: "development",
          isProd: false,
          filesToRealPayers: true,
          billingProviderNpi: DEMO_BILLING_PROVIDER.npi,
        })
      ),
    /FATAL:.*demo billing identity/s
  );
});

test("a deployment that can reach a payer refuses to start under the demo billing identity", () => {
  for (const field of ["billingProviderName", "billingProviderNpi", "billingProviderTaxId"] as const) {
    const demo = {
      billingProviderName: DEMO_BILLING_PROVIDER.name,
      billingProviderNpi: DEMO_BILLING_PROVIDER.npi,
      billingProviderTaxId: DEMO_BILLING_PROVIDER.taxId,
    }[field];

    assert.throws(
      () => assertBillingProviderConfigured(config({ [field]: demo } as Partial<Config>)),
      /FATAL:.*demo billing identity/s,
      `${field} left on its demo default must refuse the boot`
    );
  }
});

test("the refusal names every unset variable at once, so it is fixed in one pass", () => {
  try {
    assertBillingProviderConfigured(
      config({
        billingProviderName: DEMO_BILLING_PROVIDER.name,
        billingProviderNpi: DEMO_BILLING_PROVIDER.npi,
        billingProviderTaxId: DEMO_BILLING_PROVIDER.taxId,
      })
    );
    assert.fail("should have refused");
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ["BILLING_PROVIDER_NAME", "BILLING_PROVIDER_NPI", "BILLING_PROVIDER_TAX_ID"]) {
      assert.match(message, new RegExp(name), `${name} was not named`);
    }
    assert.match(message, /false attestation/, "the message must say why it matters, not just that it failed");
  }
});

test("an empty value is as bad as the demo value", () => {
  assert.throws(() => assertBillingProviderConfigured(config({ billingProviderNpi: "" })), /FATAL/);
  assert.throws(() => assertBillingProviderConfigured(config({ billingProviderName: "   " })), /FATAL/);
});

/**
 * The laptop demo must keep working with no environment set at all — that is what makes it a demo.
 * Nothing outside production is enforced here; the scrubber's advisory covers those deployments,
 * which is the right severity for one that files nothing real.
 */
test("the laptop demo runs on no environment at all", () => {
  /**
   * Unchanged in intent, and the fixture now states the fact it always relied on: the laptop demo
   * is a demo BECAUSE it runs on the mock connector. That was implicit while the guard keyed on
   * `isProd` — "not production" stood in for "reaches nobody" — and the two came apart the moment a
   * laptop could be pointed at a live clearinghouse. The case directly above asserts that one is
   * now refused; this one asserts the demo it was standing in for still boots on nothing.
   */
  assert.doesNotThrow(() =>
    assertBillingProviderConfigured(
      config({
        nodeEnv: "development",
        isProd: false,
        ediAdapter: "mock",
        filesToRealPayers: false,
        isDemoDeployment: true,
        billingProviderName: DEMO_BILLING_PROVIDER.name,
        billingProviderNpi: DEMO_BILLING_PROVIDER.npi,
        billingProviderTaxId: DEMO_BILLING_PROVIDER.taxId,
      })
    )
  );
});

// ── SECURE_COOKIES (DEC-3) ─────────────────────────────────────────────────────────────────────
//
// `Secure` was added to the session cookie only when `SECURE_COOKIES=1`, with no boot assertion
// beside the three that already refuse production — DATABASE_URL, the demo billing identity, the
// practice timezone. A deployment that forgot the variable served a PHI system's session cookie
// over plain HTTP, where a network observer can read it and act as that user. HttpOnly and
// SameSite do not prevent that: they stop a script reading it and a cross-site request sending it,
// not somebody watching the wire.

test("DEC-3: production with a secure cookie boots", () => {
  assert.doesNotThrow(() => assertSecureCookiesConfigured(config({ secureCookies: true })));
});

test("DEC-3: production with an insecure cookie refuses to boot", () => {
  assert.throws(
    () => assertSecureCookiesConfigured(config({ secureCookies: false })),
    /SECURE_COOKIES is set to 0 in production/
  );
});

test("DEC-3: the refusal explains what an attacker gets, not just which flag is wrong", () => {
  // A boot error nobody understands gets worked around. This one has to say why it matters.
  assert.throws(
    () => assertSecureCookiesConfigured(config({ secureCookies: false })),
    (err: Error) =>
      /read it and act as that user/.test(err.message) &&
      /HttpOnly and SameSite do not prevent that/.test(err.message)
  );
});

test("DEC-3: outside production nothing is asserted, in either configuration", () => {
  /**
   * The laptop demo runs on http://localhost, where a `Secure` cookie is never sent back — login
   * would appear to succeed and then silently fail on the next request. Development keeps the old
   * behaviour exactly: off unless asked for.
   */
  for (const secureCookies of [true, false]) {
    assert.doesNotThrow(() =>
      assertSecureCookiesConfigured(config({ isProd: false, nodeEnv: "development", secureCookies }))
    );
  }
});

test("DEC-3: in production OR on a hosted deployment the flag defaults ON", () => {
  /**
   * The half the assertion alone would miss. Forgetting the variable is the normal failure, and a
   * guard that only fires on `SECURE_COOKIES=0` would let an unset one through. Read the resolution
   * rule directly — `getConfig` memoizes and reads the ambient environment, so it cannot be driven
   * from here without mutating NODE_ENV for a concurrently-running suite.
   *
   * ── THE CONDITION GREW A SECOND HALF, AND THIS TEST IS WHY THAT WAS DELIBERATE ────────────────
   * It used to read `nodeEnv === "production"` alone, which meant a deployment on a public URL with
   * NODE_ENV unset served its session cookie with no `Secure` flag. The
   * laptop exemption exists because a `Secure` cookie is never returned over `http://localhost`, and
   * that is a fact about a laptop rather than about production. So the condition is now "production
   * or hosted", and `hosted` is detected from the platform's own injected variables.
   *
   * This test failed when that change was made, which is exactly what it is for: the rule is pinned
   * to the SOURCE below, so it cannot be widened quietly.
   */
  const resolve = (nodeEnv: string, hosted: boolean, raw: string | undefined) =>
    nodeEnv === "production" || hosted ? raw !== "0" : raw === "1";

  /**
   * And the rule above is the one the source actually uses. Without this the test would pass while
   * `env.ts` quietly went back to `=== "1"` everywhere — mutation-verification caught exactly that,
   * because a reimplemented rule proves nothing about the implementation it mirrors.
   */
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "env.ts"), "utf8");
  /* Whitespace-collapsed before matching: the declaration is wrapped across four lines in the
     source, and a pattern that also had to describe the line breaks would fail on a reformat while
     the rule it is pinning was still correct. */
  const collapsed = source.replace(/\s+/g, " ");
  assert.ok(
    collapsed.includes(
      'secureCookies: nodeEnv === "production" || hosted ? process.env.SECURE_COOKIES !== "0" : process.env.SECURE_COOKIES === "1"'
    ),
    "production or a hosted deployment must default the Secure flag ON, with an explicit 0 as the only way off"
  );

  assert.equal(resolve("production", false, undefined), true, "unset in production is SECURE");
  assert.equal(resolve("production", false, "1"), true);
  assert.equal(resolve("production", false, "0"), false, "and only an explicit 0 turns it off");

  assert.equal(resolve("development", true, undefined), true, "unset on a HOSTED deployment is SECURE");
  assert.equal(resolve("development", true, "0"), false, "an explicit 0 still wins there too");

  assert.equal(resolve("development", false, undefined), false, "a laptop is unchanged: off unless asked");
  assert.equal(resolve("development", false, "1"), true);
});
