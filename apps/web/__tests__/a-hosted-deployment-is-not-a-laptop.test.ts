/**
 * The defaults that assumed nobody else could reach this process.
 *
 * ── WHAT A HOSTED DEPLOYMENT WITHOUT NODE_ENV GOT WRONG ───────────────────────────────────────
 * A public URL with `NODE_ENV` unset — and three separate defaults that key
 * off `NODE_ENV` therefore sitting in their laptop setting:
 *
 *   · the session cookie was issued without `Secure`;
 *   · `trustProxy` was off behind a platform load balancer, so the login throttle bucketed the whole
 *     internet into one counter and the audit trail recorded the balancer's address for every actor
 *     — and this one turned out NOT to be safely derivable from `hosted`, for a reason measured
 *     behind a real Cloudflare edge and recorded on the test below;
 *   · `POST /api/v1/auth/password-reset` — a PUBLIC route, no session — returned a live, single-use
 *     reset token for any address a caller named, and the response explained that it was doing so.
 *
 * The last one is account takeover for anyone who can reach the URL, and it was reachable.
 *
 * ── WHY `NODE_ENV` WAS THE WRONG THING TO ASK ──────────────────────────────────────────────────
 * Each of those three defaults exists for a real reason, and each reason is about a LAPTOP:
 * `Secure` cookies are never returned over `http://localhost`, a developer's machine has no proxy,
 * and a demo with no mail provider has to put the reset token somewhere. None of that is a statement
 * about production — it is a statement about who can reach the process, and "not production" is not
 * the same as "not reachable by strangers".
 *
 * `NODE_ENV` is intent somebody has to remember to declare. Being hosted is a FACT the platform
 * announces: Render injects `RENDER_GIT_COMMIT`, which this codebase already reads on the health
 * endpoint. The fact was available all along and nothing was asking it.
 *
 * ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
 * That the three defaults follow the fact. It does NOT pin that hosted implies production — the
 * production refusals stay keyed to `NODE_ENV` on purpose, because flipping them would take a
 * running deployment down at boot over a missing billing NPI, which is a worse failure than the one
 * being fixed and would get the check removed rather than the variable set.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getConfig, resetConfigCache } from "@mermaid/config";

/** Every variable these tests touch, restored between cases so one cannot leak into the next. */
const KEYS = [
  "NODE_ENV",
  /* A real topology question with no safe default — see the proxy-trust test. Production refuses to
     boot without an explicit answer, so every production case here has to give one. */
  "EDI_ADAPTER",
  "STEDI_TEST_MODE",
  "STEDI_API_KEY",
  "BILLING_PROVIDER_NAME",
  "BILLING_PROVIDER_NPI",
  "BILLING_PROVIDER_TAX_ID",
  "PRACTICE_TIMEZONE",
  "BILLING_PROVIDER_PHONE",
  "BILLING_PROVIDER_STREET",
  "BILLING_PROVIDER_CITY",
  "BILLING_PROVIDER_STATE",
  "BILLING_PROVIDER_ZIP",
  "BILLING_PROVIDER_TAXONOMY",
  "HOSTED",
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_GIT_COMMIT",
  "FLY_APP_NAME",
  "SECURE_COOKIES",
  "TRUST_PROXY",
  "DATABASE_URL",
] as const;

const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));

function env(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const k of KEYS) delete process.env[k];
  /* A database URL so `getConfig` does not take its own "no database" path; the value is never
     connected to by anything here. */
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/none";
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
});

// ── Detection ─────────────────────────────────────────────────────────────────────────────────

test("a laptop is not hosted", () => {
  env({ NODE_ENV: "development" });
  assert.equal(getConfig().hosted, false);
});

test("each platform signal is enough on its own", () => {
  /**
   * Listed one at a time rather than together, because the failure this guards against is a
   * platform that sets only ONE of them — and a test that sets all four would pass while three of
   * the branches were broken.
   */
  for (const key of ["RENDER_GIT_COMMIT", "RENDER_SERVICE_ID", "FLY_APP_NAME"] as const) {
    env({ NODE_ENV: "development", [key]: "present" });
    assert.equal(getConfig().hosted, true, `${key} alone must be enough`);
  }
  env({ NODE_ENV: "development", RENDER: "true" });
  assert.equal(getConfig().hosted, true, "RENDER=true alone must be enough");
});

test("HOSTED=1 exists because the platform list is a list of platforms somebody thought of", () => {
  env({ NODE_ENV: "development", HOSTED: "1" });
  assert.equal(getConfig().hosted, true);
});

// ── The three defaults that were wrong ────────────────────────────────────────────────────────

test("a hosted deployment gets Secure cookies without being told", () => {
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123" });
  assert.equal(getConfig().secureCookies, true);
});

test("a laptop still does NOT, because a Secure cookie never comes back over http://localhost", () => {
  env({ NODE_ENV: "development" });
  assert.equal(
    getConfig().secureCookies,
    false,
    "flipping this on for a laptop makes login appear to succeed and then silently fail"
  );
});

test("an explicit SECURE_COOKIES=0 still wins, hosted or not", () => {
  /* Overridable on purpose: the production boot refuses it outright, which is where that argument
     is had. A setting nobody can turn off is a setting people work around. */
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123", SECURE_COOKIES: "0" });
  assert.equal(getConfig().secureCookies, false);
});

test("being hosted does NOT turn on proxy trust, and the reason is measured", () => {
  /**
   * ── THE ONE DEFAULT THAT WAS NOT SAFE TO DERIVE FROM `hosted` ────────────────────────────────
   * This was briefly `hosted`, on the reasoning that a platform load balancer is definitionally in
   * front of the process — so unset, the throttle counts the whole internet as one address. True,
   * and the fix was worse than the fault.
   *
   * `clientIpFrom` takes the LAST entry of `x-forwarded-for`, which is right for exactly ONE trusted
   * proxy appending the peer it saw. A Cloudflare-fronted platform has two, so the last
   * entry is whichever Cloudflare edge node took the request — and that rotates. Twenty parallel
   * failed logins returned nineteen 401s and one 429, where a capacity-10 bucket
   * should give about ten of each: every request had its own bucket and the throttle was off.
   *
   * Unset, all twenty share one bucket. Too coarse, and working. Getting it right needs the number
   * of trusted hops, which is a fact about one deployment's topology that no default can guess.
   */
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123" });
  assert.deepEqual(
    getConfig().clientIpSource,
    { kind: "socket" },
    "a guessed hop count disables the login throttle on the deployment most likely to be attacked"
  );
});

test("a laptop does not either, because x-forwarded-for is whatever the client sent", () => {
  env({ NODE_ENV: "development" });
  assert.deepEqual(getConfig().clientIpSource, { kind: "socket" });
});

test("an explicit declaration is still the way to turn it on", () => {
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123", TRUST_PROXY: "1" });
  assert.deepEqual(
    getConfig().clientIpSource,
    { kind: "forwarded", hops: 1 },
    "a declared answer is always the answer"
  );
  /**
   * And the declaration a Cloudflare-fronted host needs. `hosted` still does not imply it: Cloudflare is in
   * front of *.onrender.com, but nothing in this process can tell whether something can also reach
   * it AROUND that edge, and that is the condition that makes the header trustworthy.
   */
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123", TRUST_PROXY: "cloudflare" });
  assert.deepEqual(getConfig().clientIpSource, { kind: "cloudflare" });
});

// ── HSTS on a hosted deployment ───────────────────────────────────────────────────────────────

test("a hosted deployment sends HSTS; a laptop must not", async () => {
  /**
   * ── WHY THIS IS THE THIRD DERIVATION AND NOT A FOURTH REFUSAL ────────────────────────────────
   * HSTS was production-only for a reason entirely about laptops: on `http://localhost` it pins the
   * developer's own browser to HTTPS for a year, and undoing that means clearing a browser-internal
   * setting most people cannot find. That hazard is real, and it is the only one — so `hosted` is
   * the question that was actually being asked.
   *
   * A hosting platform serves over HTTPS by definition, so there is no configuration in which
   * sending it there is wrong. The two remaining production gaps — the demo billing identity and the
   * practice timezone — are deliberately NOT derived the same way, because they are boot REFUSALS:
   * deriving them from detection would take a running deployment down over a missing NPI, which
   * turns a security gap into an outage.
   */
  /**
   * Services built here rather than imported from `server.test.ts`. Importing a test MODULE runs its
   * `test()` registrations as subtests of this one — which they duly did, against an environment
   * this file had deliberately rewritten, and eight of them failed for reasons that had nothing to
   * do with HSTS.
   */
  const { createApp } = await import("../server.ts");
  const { buildServices } = await import("../wiring.ts");

  const headerFor = async () => {
    /* In-memory: this is about a response header, and a database would only add a way to fail. */
    delete process.env.DATABASE_URL;
    resetConfigCache();
    const server = createApp(buildServices({ inMemory: true }));
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      await res.text();
      return res.headers.get("strict-transport-security");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };

  env({ NODE_ENV: "development" });
  assert.equal(
    await headerFor(),
    null,
    "on a laptop this pins localhost to HTTPS for a year in the developer's own browser"
  );

  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123" });
  const hosted = await headerFor();
  assert.ok(hosted, "a public URL serving PHI must not leave the first request downgradeable");
  assert.match(hosted!, /max-age=31536000/);
  assert.match(hosted!, /includeSubDomains/);
  assert.equal(/preload/.test(hosted!), false, "preloading a domain is a one-way decision about a domain");
});

// ── The billing identity, and what actually makes it required ────────────────────────────────

test("a demonstration deployment boots hardened, because it can reach no payer", () => {
  /**
   * ── THE CASE THAT WAS FORBIDDEN, AND SHOULD NOT HAVE BEEN ────────────────────────────────────
   * Setting NODE_ENV=production on staging is the correct thing to do — it is what turns on the
   * remaining protections. It also made the process refuse to boot, for want of a real dental
   * practice's NPI that a demonstration deployment does not have and must not invent.
   *
   * The guard's own message says what it protects: "every claim this deployment files would name a
   * provider that does not exist, which is a false attestation to a payer." That is a fact about
   * reaching a PAYER. On the mock adapter nothing is reachable, so there is no attestation to be
   * false and nothing to prove.
   */
  env({ NODE_ENV: "production", RENDER_GIT_COMMIT: "abc123", EDI_ADAPTER: "mock", TRUST_PROXY: "0" });
  assert.doesNotThrow(() => getConfig(), "a hardened demonstration deployment must boot");
  const config = getConfig();

  assert.equal(config.isProd, true, "hardened");
  assert.equal(config.hosted, true);
  assert.equal(config.isDemoDeployment, true, "the demo identity makes this a demo deployment");
  assert.equal(config.filesToRealPayers, false, "and the mock adapter is why that is safe");

  /* And the demo identity is COMPLETE, not half-configured: an 837D cannot be built without loop
     1000A PER and loop 2010AA N3/N4, so empty contact fields produce claims that are malformed even
     against the mock. Deliberately non-deliverable — see DEMO_BILLING_PROVIDER. */
  assert.match(config.billingProviderStreet, /SYNTHETIC/, "the demo address must read as fabricated");
  assert.ok(config.billingProviderZip.length >= 5);
  assert.ok(config.billingProviderPhone.replace(/\D/g, "").length >= 10);
});

test("a live clearinghouse under the demo identity is refused, whatever NODE_ENV says", () => {
  /**
   * The half that got STRONGER. This used to return early for anything that was not
   * NODE_ENV=production, so a laptop or a staging box pointed at a live clearinghouse could file a
   * claim naming a provider that does not exist — exactly the false attestation the guard describes,
   * permitted by the condition meant to prevent it.
   */
  for (const nodeEnv of ["development", "production"] as const) {
    env({ NODE_ENV: nodeEnv, EDI_ADAPTER: "stedi", STEDI_TEST_MODE: "0", STEDI_API_KEY: "live_synthetic", TRUST_PROXY: "0" });
    /* Asserted on `getConfig` rather than on the assertion function, because the refusal IS the boot:
       the process never reaches a state where a caller could ask it for its billing identity. */
    assert.throws(
      () => getConfig(),
      /demo billing identity/,
      `${nodeEnv}: a claim naming a provider that does not exist must never reach a payer`
    );
  }
});

test("Stedi TEST mode keeps the demo identity, because its own fixtures are filed under it", () => {
  /**
   * Not an oversight — `assertBillingProviderContactConfigured` recorded this when the Stedi
   * scenarios first ran: "Stedi's own sandbox fixtures are filed as MERMAID DEMO DENTAL, so
   * requiring a real identity in test mode would break the sandbox it exists to exercise." A test
   * key reaches Stedi. It does not reach a payer.
   */
  env({ NODE_ENV: "production", EDI_ADAPTER: "stedi", STEDI_TEST_MODE: "1", STEDI_API_KEY: "test_synthetic", TRUST_PROXY: "0" });
  assert.doesNotThrow(() => getConfig());
  assert.equal(getConfig().filesToRealPayers, false);
});

test("a REAL identity is still required the moment a live clearinghouse appears", () => {
  /* The guarantee, stated from the other side: configuring a real practice is what lets a live
     adapter boot, and nothing about demo mode offers a way around it. */
  env({
    NODE_ENV: "production",
    EDI_ADAPTER: "stedi",
    STEDI_TEST_MODE: "0",
    STEDI_API_KEY: "live_synthetic",
    TRUST_PROXY: "0",
    PRACTICE_TIMEZONE: "America/Los_Angeles",
    BILLING_PROVIDER_NAME: "Fictional Family Dental",
    BILLING_PROVIDER_NPI: "1999999992",
    BILLING_PROVIDER_TAX_ID: "874523901",
    /* A real identity gets NO contact defaults — that is the point of the fallback being conditional
       — so the shipping case has to supply them, and this asserts that it must. */
    BILLING_PROVIDER_PHONE: "5105550142",
    BILLING_PROVIDER_STREET: "500 EXAMPLE STREET",
    BILLING_PROVIDER_CITY: "OAKLAND",
    BILLING_PROVIDER_STATE: "CA",
    BILLING_PROVIDER_ZIP: "946120000",
    BILLING_PROVIDER_TAXONOMY: "1223G0001X",
  });
  assert.doesNotThrow(() => getConfig(), "a real identity plus a live clearinghouse is the shipping case");
  const config = getConfig();
  assert.equal(config.isDemoDeployment, false, "a configured identity is not a demo");
  assert.equal(config.filesToRealPayers, true);
  assert.equal(
    config.billingProviderStreet,
    "500 EXAMPLE STREET",
    "and it keeps its own address — the synthetic fallback must never reach a real claim"
  );
});

test("being hosted is not the same as being in production", () => {
  /**
   * The load-bearing negative. If `hosted` implied `isProd`, every production refusal would fire at
   * boot on a deployment missing a billing NPI, a timezone or a proxy declaration — turning a
   * security gap into an outage, which is how a check gets deleted instead of a variable set.
   */
  env({ NODE_ENV: "development", RENDER_GIT_COMMIT: "abc123" });
  const config = getConfig();
  assert.equal(config.hosted, true);
  assert.equal(config.isProd, false);
  assert.equal(config.nodeEnv, "development");
});
