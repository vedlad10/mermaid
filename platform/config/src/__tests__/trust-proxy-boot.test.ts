/**
 * Production refuses to start without an explicit answer about the proxy (NEW-16).
 *
 * ── WHY A MISSING VALUE IS NOT A SAFE DEFAULT HERE ───────────────────────────────────────────────
 * `TRUST_PROXY` decides where `clientIp` gets its answer: the socket's peer address, or the
 * `x-forwarded-for` header. It defaulted to OFF, which is the safe direction for exactly one of the
 * two ways a deployment can be wrong, and silently catastrophic for the other.
 *
 *   • Set to 1 with NO proxy in front: any client sends `x-forwarded-for: <anything>` and picks its
 *     own rate-limit bucket. The login throttle stops throttling. (Already tested elsewhere — the
 *     header is ignored when the flag is off.)
 *   • Left UNSET behind a proxy — the case the default produces: every request arrives from the
 *     proxy's address, so an entire practice shares ONE login bucket. Ten receptionists arriving at
 *     8am exhaust it between them and everybody is locked out of a system holding PHI, while the
 *     logs report a rate limit about an attack that is not happening. An attacker who knows this
 *     locks out a practice with ten wrong passwords.
 *
 * Neither is a default anybody can pick correctly on someone else's behalf: the answer is a fact
 * about the deployment's topology and nothing in this process can observe it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig, resetConfigCache } from "../env.ts";

/** Run `fn` with a production-shaped environment, restoring everything afterwards. */
function inProduction(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  const applied: Record<string, string | undefined> = {
    NODE_ENV: "production",
    // Everything the other boot assertions demand, so this test fails on the ONE thing it is about.
    DATABASE_URL: "postgres://u:p@db.example/mermaid",
    PHI_ENCRYPTION_KEY: "dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1mb3ItYWVzMjU2ISE=",
    SECURE_COOKIES: "1",
    PRACTICE_TIMEZONE: "America/Los_Angeles",
    BILLING_PROVIDER_NAME: "REAL DENTAL GROUP",
    BILLING_PROVIDER_NPI: "1548273975",
    BILLING_PROVIDER_TAX_ID: "123456789",
    BILLING_PROVIDER_PHONE: "5105550100",
    BILLING_PROVIDER_STREET: "1 Real St",
    BILLING_PROVIDER_CITY: "Oakland",
    BILLING_PROVIDER_STATE: "CA",
    BILLING_PROVIDER_ZIP: "94607",
    BILLING_PROVIDER_TAXONOMY: "1223G0001X",
    ...vars,
  };

  for (const [k, v] of Object.entries(applied)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
  }
}

test("NEW-16: production refuses to boot with TRUST_PROXY unset", () => {
  inProduction({ TRUST_PROXY: undefined }, () => {
    assert.throws(
      () => getConfig(),
      (err: Error) => {
        assert.match(err.message, /TRUST_PROXY/);
        assert.match(err.message, /not set/);
        // The message has to explain both directions, because the operator's next action depends on
        // which one they are in and nothing in the process can tell them.
        assert.match(err.message, /x-forwarded-for/);
        assert.match(err.message, /lock each other out/);
        return true;
      }
    );
  });
});

test("NEW-16: a value that is not one of the declared answers is refused too", () => {
  /**
   * `true`, `yes` and `on` are all the shape of somebody who believed they had turned it on. Silently
   * reading them as falsy is the same outage as leaving it unset, arrived at with more confidence.
   *
   * `2` is no longer here: it is now a hop count, which is the point of the change. `cloudflare-ish`
   * spellings that are not the exact word still are, because a near-miss on the edge's name would
   * fall back to the socket and look like the setting had been applied.
   */
  for (const value of ["true", "yes", "on", "TRUE", " ", "cloudfare", "cf", "-1", "1.5", "100"]) {
    inProduction({ TRUST_PROXY: value }, () => {
      assert.throws(() => getConfig(), /TRUST_PROXY/, `"${value}" must not be accepted`);
    });
  }
});

test("NEW-16: every explicit answer boots, and means what it says", () => {
  // The two original answers keep their exact meaning: a deployment that already answered this
  // question does not have to answer it again to keep booting.
  inProduction({ TRUST_PROXY: "1" }, () => {
    assert.deepEqual(getConfig().clientIpSource, { kind: "forwarded", hops: 1 });
  });
  inProduction({ TRUST_PROXY: "0" }, () => {
    assert.deepEqual(getConfig().clientIpSource, { kind: "socket" });
  });
  // And the two that exist because a boolean could not describe Cloudflare in front of Render.
  inProduction({ TRUST_PROXY: "2" }, () => {
    assert.deepEqual(getConfig().clientIpSource, { kind: "forwarded", hops: 2 });
  });
  inProduction({ TRUST_PROXY: "cloudflare" }, () => {
    assert.deepEqual(getConfig().clientIpSource, { kind: "cloudflare" });
  });
  // Case is an accident of whoever typed it into a dashboard, not a different answer.
  inProduction({ TRUST_PROXY: "Cloudflare" }, () => {
    assert.deepEqual(getConfig().clientIpSource, { kind: "cloudflare" });
  });
});

test("NEW-16: the refusal names cloudflare, because that is the answer staging needs", () => {
  /**
   * The message is the only place an operator meets this decision, and the previous one offered a
   * choice between two answers that were both wrong for a Cloudflare-fronted deployment: `0` made
   * every actor `::1` in the audit trail, and `1` gave every request its own rate-limit bucket.
   */
  inProduction({ TRUST_PROXY: undefined }, () => {
    assert.throws(
      () => getConfig(),
      (err: Error) => {
        assert.match(err.message, /TRUST_PROXY=cloudflare/);
        assert.match(err.message, /cf-connecting-ip/);
        assert.match(err.message, /from the RIGHT/);
        return true;
      }
    );
  });
});

test("NEW-16: outside production nothing is demanded — a laptop has no proxy", () => {
  /**
   * The demo must keep working with no environment at all. The assertion exists for the deployment
   * that has a topology, and a developer who has none should never meet it.
   */
  const savedEnv = process.env.NODE_ENV;
  const savedProxy = process.env.TRUST_PROXY;
  process.env.NODE_ENV = "development";
  delete process.env.TRUST_PROXY;
  resetConfigCache();
  try {
    assert.deepEqual(getConfig().clientIpSource, { kind: "socket" }, "and it defaults to the safe direction");
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedProxy;
    resetConfigCache();
  }
});
