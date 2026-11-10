/**
 * A deployment wired to a clearinghouse needs a billing identity that survives one.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * `assertBillingProviderContactConfigured` began `if (!config.isProd) return`, which reads as
 * "production must be configured properly". The real condition is narrower and more useful: can
 * this deployment put an 837D on a wire?
 *
 * The first live run of the Stedi TEST scenarios, from a `NODE_ENV=staging` deployment, skipped the
 * check and Stedi answered:
 *
 *   Relational condition P0304 violated: If any one of the elements in positions 03, 04 is present,
 *   then all must be present | Element PER-04 is required | Element N3-01 is required |
 *   Element N4-01 is required
 *
 * — an empty submitter contact (loop 1000A PER) and no billing provider address (loop 2010AA
 * N3/N4). That reached the biller as an opaque `502 clearinghouse_error`. The claim was structurally
 * invalid before it left the building and nothing said so until a vendor did.
 *
 * A test key does not make the X12 less real: Stedi validates the envelope identically in both
 * modes, and so does every payer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBillingProviderContactConfigured } from "../env.ts";

/** Only the fields this assertion reads. */
const config = (over: Record<string, unknown> = {}) =>
  ({
    isProd: false,
    ediAdapter: "mock",
    billingProviderPhone: "",
    billingProviderStreet: "",
    billingProviderCity: "",
    billingProviderState: "",
    billingProviderZip: "",
    billingProviderTaxonomy: "",
    ...over,
  }) as never;

const COMPLETE = {
  billingProviderPhone: "5555550100",
  billingProviderStreet: "1 SYNTHETIC TEST WAY",
  billingProviderCity: "SPRINGFIELD",
  billingProviderState: "CA",
  billingProviderZip: "900010000",
  billingProviderTaxonomy: "1223G0001X",
};

test("the mock adapter outside production needs no address — the laptop demo is unaffected", () => {
  /**
   * The reason the check was scoped to production in the first place, and it still holds. A
   * developer running the seeded demo has no practice address and needs none, because nothing they
   * do can reach a clearinghouse.
   */
  assert.doesNotThrow(() => assertBillingProviderContactConfigured(config()));
});

test("the Stedi adapter without an address refuses to boot, whatever NODE_ENV says", () => {
  let err: Error | null = null;
  try {
    assertBillingProviderContactConfigured(config({ ediAdapter: "stedi" }));
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, "a Stedi-wired deployment with no address must refuse to boot");
  assert.match(err.message, /FATAL/);

  for (const name of [
    "BILLING_PROVIDER_PHONE",
    "BILLING_PROVIDER_STREET",
    "BILLING_PROVIDER_CITY",
    "BILLING_PROVIDER_STATE",
    "BILLING_PROVIDER_ZIP",
  ]) {
    assert.match(err.message, new RegExp(name), `the operator must be told ${name} is missing by name`);
  }
});

test("production still refuses without an address, on any adapter", () => {
  /** The original rule, unchanged: the new condition widens the check and never narrows it. */
  assert.throws(() => assertBillingProviderContactConfigured(config({ isProd: true })), /FATAL/);
});

test("a complete address satisfies the check on the clearinghouse adapter", () => {
  assert.doesNotThrow(() =>
    assertBillingProviderContactConfigured(config({ ediAdapter: "stedi", ...COMPLETE }))
  );
});

test("a partial address is refused — an 837D needs all of it or none of it parses", () => {
  /**
   * The failure Stedi actually reported was relational: PER-03 present without PER-04. A half-filled
   * address is not a lesser version of a complete one, it is a segment the clearinghouse rejects.
   */
  for (const field of Object.keys(COMPLETE)) {
    const partial = { ...COMPLETE, [field]: "" };
    assert.throws(
      () => assertBillingProviderContactConfigured(config({ ediAdapter: "stedi", ...partial })),
      /FATAL/,
      `missing ${field} must still refuse`
    );
  }
});

test("a malformed state or ZIP is refused on the clearinghouse adapter too", () => {
  /**
   * These validations already existed and were reachable only in production. They are worth as much
   * on the path that actually files a claim: a payer uses the address to decide network and
   * jurisdiction, so "California" instead of "CA" is not a typo a clearinghouse forgives.
   */
  assert.throws(
    () =>
      assertBillingProviderContactConfigured(
        config({ ediAdapter: "stedi", ...COMPLETE, billingProviderState: "California" })
      ),
    /USPS/
  );
  assert.throws(
    () =>
      assertBillingProviderContactConfigured(
        config({ ediAdapter: "stedi", ...COMPLETE, billingProviderZip: "9001" })
      ),
    /ZIP/
  );
});

test("a phone a payer cannot dial is the same as no phone", () => {
  assert.throws(
    () =>
      assertBillingProviderContactConfigured(
        config({ ediAdapter: "stedi", ...COMPLETE, billingProviderPhone: "555" })
      ),
    /10-digit/
  );
});

test("the billing provider taxonomy is required too, and a malformed one is refused", () => {
  /**
   * Stedi's payer edits rejected a test claim that had passed everything else: "Missing Billing
   * Provider taxonomy code. This code is required when no rendering provider or assistant surgeon is
   * reported" (277CA A6:145:85). A solo practice reports no rendering provider, so without this every
   * claim it files is rejected — the refusal belongs at boot, beside the address.
   */
  const stedi = (taxonomy: string) => config({ ediAdapter: "stedi", ...COMPLETE, billingProviderTaxonomy: taxonomy });
  assert.throws(() => assertBillingProviderContactConfigured(stedi("")), /BILLING_PROVIDER_TAXONOMY is not set/);
  assert.throws(() => assertBillingProviderContactConfigured(stedi("GENERAL")), /"GENERAL" is not a provider taxonomy code/);
  assert.throws(() => assertBillingProviderContactConfigured(stedi("1223G0001")), /not a provider taxonomy code/, "nine characters");
  assert.doesNotThrow(() => assertBillingProviderContactConfigured(stedi("1223G0001X")));
  assert.doesNotThrow(() => assertBillingProviderContactConfigured(stedi("1223P0221X")), "pediatric dentistry");
});
