/**
 * StediEdiAdapter — the real clearinghouse behind the existing seam.
 *
 * **No test here touches the network.** `fetch` is injected, and the success path is driven by a
 * REAL 271 captured from Stedi's TEST environment, so the parse being asserted is the parse that
 * actually happens in production rather than one Mermaid built for itself. The live check lives in
 * `npm run stedi:check`, deliberately outside the suite: a test that needs a vendor and a
 * credential is a test that fails for reasons unrelated to the code.
 *
 * The properties under test, in order of what they cost if broken:
 *   1. The test/production interlock — a mode mix-up either invents coverage or hits a real payer.
 *   2. The API key never escapes, in any result, error or raw payload.
 *   3. Every failure mode classifies to the right retryability, because the outbox acts on it.
 *   4. A real payer 271 maps into Mermaid's model with money as integer cents.
 *   5. The money paths refuse rather than half-working.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StediConfigurationError, StediEdiAdapter } from "../vendors/stedi/index.ts";
import { STEDI_SANDBOX_271 } from "./fixtures/stedi-271.ts";

/** A test key by Stedi's own convention. Not a credential — this string reaches nothing. */
const TEST_KEY = "test_notarealkey";
const PROD_KEY = "prod_notarealkey";

const REQUEST = {
  // Mermaid's own slug — the playbook key, never sent on the wire...
  payerId: "aetna-dental",
  // ...and the id Stedi actually addresses the payer by. Two namespaces, deliberately.
  clearinghouseId: "60054",
  payerName: "Aetna",
  memberId: "AETNA9wcSu",
  patient: { firstName: "Jordan", lastName: "Doe", dateOfBirth: "" },
};

interface Capture {
  url?: string;
  init?: RequestInit;
}

function adapterWith(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  over: Partial<{ testMode: boolean; apiKey: string; timeoutMs: number }> = {},
  capture: Capture = {}
): StediEdiAdapter {
  return new StediEdiAdapter({
    apiKey: over.apiKey ?? TEST_KEY,
    baseUrl: "https://healthcare.us.stedi.example",
    timeoutMs: over.timeoutMs ?? 5_000,
    testMode: over.testMode ?? true,
    provider: { organizationName: "MERMAID DEMO DENTAL", npi: "1234567893" },
    fetchImpl: (async (url: unknown, init: unknown) => {
      capture.url = String(url);
      capture.init = (init ?? {}) as RequestInit;
      return handler(String(url), (init ?? {}) as RequestInit);
    }) as unknown as typeof fetch,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A successful Stedi body: the real 271, plus the meta Stedi actually returns. */
const okBody = (over: Record<string, unknown> = {}) => ({
  meta: { traceId: "trace-1", applicationMode: "test" },
  x12: STEDI_SANDBOX_271,
  ...over,
});

// ── 1. The test/production interlock ──────────────────────────────────────────────────

test("a production key in test mode is refused at construction — it would reach a real payer", () => {
  assert.throws(
    () => adapterWith(() => json(okBody()), { apiKey: PROD_KEY, testMode: true }),
    (e: unknown) => {
      assert.ok(e instanceof StediConfigurationError);
      assert.match(e.message, /reaches real payers/);
      return true;
    }
  );
});

test("a test key in production mode is refused — a clinic would quote invented coverage", () => {
  // The more dangerous direction of the two, and the quieter one: mock benefits look real, so
  // nothing downstream would notice that every estimate was fiction.
  assert.throws(
    () => adapterWith(() => json(okBody()), { apiKey: TEST_KEY, testMode: false }),
    (e: unknown) => {
      assert.ok(e instanceof StediConfigurationError);
      assert.match(e.message, /invented coverage/);
      return true;
    }
  );
});

test("a response Stedi says it served in production is refused while we believe we are in test", async () => {
  // The constructor checks the key; this checks the answer. If they disagree, the response cannot
  // be characterised, and an uncharacterised response is worse than no response.
  const adapter = adapterWith(() => json(okBody({ meta: { applicationMode: "production" } })));
  const result = await adapter.checkEligibility(REQUEST);

  assert.equal(result.ok, false);
  assert.equal(result.error?.retryable, false);
  assert.match(result.error?.message ?? "", /production.*test mode/i);
});

test("test mode is visible on the adapter, so a live script can refuse to run in production", () => {
  assert.equal(adapterWith(() => json(okBody())).testMode, true);
});

// ── 2. The key never escapes ──────────────────────────────────────────────────────────

test("the API key goes on the Authorization header and nowhere else", async () => {
  const capture: Capture = {};
  const adapter = adapterWith(() => json(okBody()), {}, capture);
  await adapter.checkEligibility(REQUEST);

  const headers = capture.init!.headers as Record<string, string>;
  assert.equal(headers.authorization, TEST_KEY, "Stedi takes the key bare, with no Bearer prefix");
  assert.doesNotMatch(capture.url ?? "", /test_/, "never in the URL — URLs land in logs and proxies");
  assert.doesNotMatch(String(capture.init!.body), /test_/, "never in the body");
});

test("no failure path leaks the key into a result a module or a log can see", async () => {
  // Each of these produces an error message built from vendor output; none may carry the credential.
  const cases: (() => Response)[] = [
    () => json({ errors: [{ code: "AUTH", description: "bad key" }] }, 401),
    () => json({ errors: [{ code: "X", description: "boom" }] }, 500),
    () => new Response("<html>gateway</html>", { status: 502 }),
    () => new Response("not json", { status: 200 }),
  ];

  for (const handler of cases) {
    const adapter = adapterWith(handler);
    const result = await adapter.checkEligibility(REQUEST);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /test_notarealkey/, "the key must never appear in a result");
  }
});

// ── 3. Failure classification, because the outbox acts on `retryable` ─────────────────

const failures: { label: string; response: () => Response; code: string; retryable: boolean }[] = [
  {
    label: "401 — a bad or wrong-mode key",
    response: () => json({ errors: [{ description: "unauthorized" }] }, 401),
    code: "unavailable",
    // Retrying an unauthorized call on every screen load is how a key gets locked out.
    retryable: false,
  },
  { label: "403", response: () => json({}, 403), code: "unavailable", retryable: false },
  { label: "429", response: () => json({}, 429), code: "rate_limited", retryable: true },
  { label: "504", response: () => json({}, 504), code: "timeout", retryable: true },
  { label: "500", response: () => json({}, 500), code: "unavailable", retryable: true },
  { label: "503", response: () => json({}, 503), code: "unavailable", retryable: true },
];

for (const { label, response, code, retryable } of failures) {
  test(`${label} classifies as ${code} (retryable: ${retryable})`, async () => {
    const result = await adapterWith(response).checkEligibility(REQUEST);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, retryable);
    assert.equal(result.source, "edi");
  });
}

test("a 400 naming the member is an invalid_member_id a biller can act on", async () => {
  const result = await adapterWith(() =>
    json({ errors: [{ field: "subscriber.memberId", description: "member id is required" }] }, 400)
  ).checkEligibility(REQUEST);

  assert.equal(result.error?.code, "invalid_member_id");
  assert.equal(result.error?.retryable, false);
  assert.match(result.error?.message ?? "", /member id is required/);
});

test("a hung Stedi is cut off at the deadline rather than holding the check open", async () => {
  const adapter = adapterWith(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const fail = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      }),
    { timeoutMs: 40 }
  );

  const result = await adapter.checkEligibility(REQUEST);
  assert.equal(result.error?.code, "timeout");
  assert.equal(result.error?.retryable, true);
});

test("an unreachable Stedi is retryable transport, not a parse problem", async () => {
  const result = await adapterWith(() => {
    throw new Error("ECONNREFUSED");
  }).checkEligibility(REQUEST);

  assert.equal(result.error?.code, "unavailable");
  assert.equal(result.error?.retryable, true);
});

test("a non-JSON body is a parse error, never an empty benefits set", async () => {
  const result = await adapterWith(() => new Response("<html>oops</html>", { status: 200 }))
    .checkEligibility(REQUEST);
  assert.equal(result.error?.code, "parse_error");
  assert.equal(result.error?.retryable, false);
});

test("a 200 carrying only AAA errors is a failed check, not zero coverage", async () => {
  // Stedi answers payer refusals with HTTP 200 and an errors array — a business outcome, exactly
  // like a rejected 277CA. Reading it as "no benefits" would quote a patient full price.
  const result = await adapterWith(() =>
    json({
      meta: { applicationMode: "test" },
      errors: [{ code: "75", description: "Subscriber/Insured Not Found" }],
    })
  ).checkEligibility(REQUEST);

  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.match(result.error?.message ?? "", /Subscriber\/Insured Not Found/);
});

test("an x12 payload that is not a 271 fails loudly rather than producing a silent zero-benefit plan", async () => {
  const result = await adapterWith(() => json(okBody({ x12: "ISA*00*~ST*835*0001~SE*2*0001~" })))
    .checkEligibility(REQUEST);
  assert.equal(result.error?.code, "parse_error");
  assert.match(result.error?.message ?? "", /not an X12 271/);
});

// ── 4. Mapping a REAL payer 271 into Mermaid's model ─────────────────────────────────

test("a payer with no clearinghouse id is refused by name, before any request is built", async () => {
  // ── REGRESSION ───────────────────────────────────────────────────────────────────────────────
  // A live run sent Mermaid's slug ("aetna-dental") as the trading-partner id. Stedi answered with
  // a 271 carrying no benefit segments, the parser correctly refused it, and the biller was told
  // "271 contained no EB benefit segments" — a symptom, not the cause. No check for that payer
  // could ever have succeeded. The refusal now names the real problem and the fix.
  const capture: Capture = {};
  const adapter = adapterWith(() => json(okBody()), {}, capture);

  const { clearinghouseId: _omitted, ...noClearinghouseId } = REQUEST;
  const result = await adapter.checkEligibility(noClearinghouseId);

  assert.equal(result.ok, false);
  assert.equal(result.error?.retryable, false);
  assert.match(result.error?.message ?? "", /No Stedi payer id is recorded for Aetna/);
  assert.match(result.error?.message ?? "", /payer registry/);
  assert.equal(capture.url, undefined, "nothing may be sent when the payer cannot be addressed");
});

test("the clearinghouse id is what goes on the wire — never Mermaid's slug", async () => {
  const capture: Capture = {};
  await adapterWith(() => json(okBody()), {}, capture).checkEligibility(REQUEST);

  const body = JSON.parse(String(capture.init!.body)) as Record<string, unknown>;
  assert.equal(body.tradingPartnerServiceId, "60054");
  assert.doesNotMatch(String(capture.init!.body), /aetna-dental/, "the slug must not reach Stedi");
});

test("the request Stedi receives is a dental eligibility check with the billing provider on it", async () => {
  const capture: Capture = {};
  await adapterWith(() => json(okBody()), {}, capture).checkEligibility({
    ...REQUEST,
    serviceDate: new Date("2026-09-15T10:00:00Z"),
  });

  const body = JSON.parse(String(capture.init!.body)) as Record<string, any>;
  assert.equal(body.tradingPartnerServiceId, "60054");
  assert.deepEqual(body.encounter.serviceTypeCodes, ["35"], "35 is dental; 30 would be medical");
  assert.equal(body.encounter.dateOfService, "20260915");
  assert.equal(body.provider.npi, "1234567893");
  assert.equal(body.subscriber.memberId, "AETNA9wcSu");
  // An empty DOB is omitted rather than sent as "", which a payer reads as a malformed date.
  assert.equal("dateOfBirth" in body.subscriber, false);
});

test("a real Stedi 271 parses through the EXISTING production parser into Benefits", async () => {
  const result = await adapterWith(() => json(okBody())).checkEligibility(REQUEST);

  assert.equal(result.ok, true);
  assert.equal(result.source, "edi");

  const b = result.data!.benefits;
  assert.equal(result.data!.eligibility, "active");
  /**
   * The information source's own name (loop 2100A `NM1*PR*2*AETNA INC`). This asserted "Aetna",
   * which came from the `NM1*PR` INSIDE `LS*2120`…`LE*2120` under `EB*W` — a benefit-related entity
   * (a claims mailing address), not the payer. The parser read every `NM1*PR` as the payer, last one
   * winning; it is loop-aware now, and this real 271 is the proof the defect was live.
   */
  assert.equal(b.payerName, "AETNA INC");
  assert.equal(b.planName, "Aetna Choice POS II");
  /**
   * ── THIS NUMBER CHANGED, AND THE OLD ONE WAS WRONG ───────────────────────────────────────────
   * This asserted a $100 deductible and called it "as the payer stated them". Aetna states three,
   * and the parser used to take whichever came last in the file:
   *
   *     EB*C*FAM*30*…*23*0*…*Y      family,     in-network       $0
   *     EB*C*IND*30*…*23*0*…*Y      individual, in-network       $0    ← the patient's
   *     EB*C*IND*30*…*23*100*…*N    individual, OUT-of-network   $100  ← what we were reading
   *
   * $100 is the out-of-network deductible. A practice taking CO-45 fee-schedule write-offs is
   * in-network by definition, so quoting it charged the patient $100 they did not owe and understated
   * what insurance would pay. The figure was never the payer's answer — it was one of three answers,
   * chosen by segment order.
   */
  /**
   * ── THESE ASSERTIONS REVERSED AT B1, AND THE PREVIOUS ONES WERE WRONG ────────────────────────
   *
   * They read `deductible.individualAnnual === 0` and `annualMaximum === $240 / $190`, with a note
   * calling the family-scoped maximum "the fallback working as intended: a lower-precedence scope
   * is used when nothing better arrives, rather than leaving the estimate with no maximum at all."
   *
   * The scope reasoning was right and the SERVICE TYPE was never checked. Those segments are
   * `EB*C*IND*30` and `EB*F*FAM*48` — service type 30 is health-plan coverage and 48 is hospital
   * inpatient. Neither is dental. This whole sandbox 271 answers a dental inquiry with a medical
   * benefit set and names no dental service type anywhere in 60 EB segments.
   *
   * So the old figures were not a lower-precedence DENTAL scope. They were a different benefit
   * entirely: a hospital family limitation quoted to a patient as their dental annual maximum, and
   * a medical deductible quoted as their dental one — both then scored 0.9 confidence, because
   * confidence tests non-nullness and not provenance.
   *
   * Absent is the honest answer, and it costs nothing that was real: `perFieldConfidence` already
   * drops to 0.2 on a null half (asserted below), so the screen says "not stated" instead of
   * printing a dollar figure the payer never gave for this benefit.
   */
  assert.equal(b.deductible.individualAnnual, null, "a MEDICAL deductible is not this patient's dental one");
  assert.equal(b.deductible.remaining, null);
  assert.equal(b.annualMaximum.amount, null, "a hospital-inpatient family limitation is not a dental maximum");
  assert.equal(b.annualMaximum.remaining, null);
  assert.equal(b.annualMaximum.used, null, "used is only knowable when both halves were stated");

  // And the confidence follows automatically, with no new scoring logic.
  assert.equal(result.data!.perFieldConfidence.deductible, 0.2);
  assert.equal(result.data!.perFieldConfidence.annualMaximum, 0.2);
});

test("money crosses to integer cents at the adapter boundary — nothing downstream sees a float", async () => {
  const result = await adapterWith(() => json(okBody())).checkEligibility(REQUEST);
  const b = result.data!.benefits;
  /**
   * Null is a legitimate value here and is NOT a float — see the B1 note above: this sandbox 271
   * states no dental figure, so every money field is absent. The property under test is that
   * anything PRESENT is integer cents, never a float; asserting `Number.isInteger(null)` would only
   * be re-asserting that the payer was silent, which the test above already does.
   */
  for (const value of [
    b.deductible.individualAnnual,
    b.deductible.remaining,
    b.annualMaximum.amount,
    b.annualMaximum.used,
    b.annualMaximum.remaining,
  ]) {
    if (value === null) continue;
    assert.ok(Number.isInteger(value), `${value} must be integer cents`);
  }
});

test("the raw 271 is carried for the audit trail, and it is the payer's own bytes", async () => {
  const result = await adapterWith(() => json(okBody())).checkEligibility(REQUEST);
  assert.equal(result.raw, STEDI_SANDBOX_271);
  assert.match(result.raw!, /ST\*271\*/);
});

test("tier-2 fields are EMPTY, because a 271 cannot carry them — and confidence says so", async () => {
  // The mock adapter fills these from its profile because it stands in for the payer's whole
  // system. A real check must not: inventing "no waiting periods" would let an estimate quote a
  // patient for a crown that is actually inside a twelve-month wait.
  const result = await adapterWith(() => json(okBody())).checkEligibility(REQUEST);
  const b = result.data!.benefits;

  assert.deepEqual(b.waitingPeriods, []);
  assert.deepEqual(b.frequencyLimits, []);
  assert.deepEqual(b.exclusions, []);
  assert.equal(result.data!.perFieldConfidence.waitingPeriods, 0);
  assert.equal(result.data!.perFieldConfidence.frequencyLimits, 0);
});

test("confidence drops for fields the payer did not actually state", async () => {
  // The real Aetna sandbox 271 carries no dental coinsurance, so coveragePercentages is empty —
  // and must be reported as low-confidence rather than as a confident set of zeroes.
  const result = await adapterWith(() => json(okBody())).checkEligibility(REQUEST);
  assert.equal(result.data!.perFieldConfidence.coveragePercentages, 0.2);
  assert.equal(result.data!.perFieldConfidence.eligibility, 0.95);
});

// ── 5. The money paths ──────────────────────────────────────────────────────────────

test("fetchRemittance refuses, and names the ARCHITECTURE rather than claiming to be unfinished", async () => {
  /**
   * Stedi has no ERA poll endpoint. 835s are PUSHED to a destination webhook, which is why M15 puts
   * the signed webhook ahead of ERA ingest rather than beside it. Every candidate report path was
   * probed against the live API and answered 404.
   *
   * So this refusal is permanent by nature, not by schedule, and the message has to say so — an
   * operator reading "not implemented" waits for a release that is never coming.
   */
  const result = await adapterWith(() => json(okBody())).fetchRemittance({} as never);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unavailable");
  // Non-retryable is load-bearing: the outbox must never queue a poll against a path that does not
  // exist and retry it forever.
  assert.equal(result.error?.retryable, false);
  assert.match(result.error?.message ?? "", /webhook/i);
  assert.match(result.error?.message ?? "", /EDI_ADAPTER=mock/);
});

test("submitClaim REFUSES without a clearinghouse payer id, rather than misrouting the claim", async () => {
  /**
   * Stedi routes on loop 2010BB NM109 and requires an id from its own payer network. Mermaid’s slug
   * ("delta-dental") is not one. Filing with it means the claim is rejected or routed somewhere
   * nobody intended, and the practice finds out weeks later — the same reason the eligibility path
   * refuses rather than sending the slug.
   */
  const result = await adapterWith(() => json(okBody())).submitClaim({
    payerId: "delta-dental", payerName: "Delta Dental", lines: [{}],
  } as never);
  assert.equal(result.ok, false);
  assert.equal(result.error?.retryable, false);
  assert.match(result.error?.message ?? "", /payer id/i);
  assert.match(result.error?.message ?? "", /EDI_ADAPTER=mock/);
});

test("submitClaim refuses a claim with no service lines", async () => {
  const result = await adapterWith(() => json(okBody())).submitClaim({
    payerId: "delta-dental", clearinghouseId: "77777", payerName: "Delta Dental", lines: [],
  } as never);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "parse_error");
});

// ── 6. M2 — an unacknowledged submission is NEVER an accepted one ─────────────────────
//
// A 277CA is the only thing that says a claim reached a payer. These pin the property that the
// ABSENCE of a rejection is not a confirmation — the reading that used to turn `PENDING`, `QUEUED`
// and a missing status alike into "the payer has it", moving the claim to `submitted`, publishing
// `claim.submitted`, and retiring it from the working queue for a filing that may never have
// happened. Nothing downstream could detect that: a 277CA that never arrives is indistinguishable
// from one that has not arrived yet.

/** A complete, fileable claim — the Stedi path builds a real 837D, so every mandatory field is set. */
const fileableClaim = (over: Record<string, unknown> = {}) =>
  ({
    claimId: "11111111-2222-3333-4444-555555555555",
    patientControlNumber: "MRM-000123",
    payerId: "delta-dental",
    clearinghouseId: "77777",
    payerName: "Delta Dental",
    subscriber: {
      firstName: "Ada",
      lastName: "Alpha",
      dateOfBirth: "1990-04-12",
      memberId: "ABC12345",
      address: { street: "1 SYNTHETIC TEST WAY", city: "PORTLAND", state: "OR", zip: "97001" },
    },
    billingProvider: { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" },
    serviceDate: "2026-07-27",
    totalCharge: 6500,
    lines: [{ lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 6500, serviceDate: "2026-07-27" }],
    ...over,
  }) as never;

test("M2: no 277CA and no errors is an UNKNOWN outcome, never an accepted claim", async () => {
  // The exact body that used to read as acceptance: 200, no x12, no errors, a non-REJECTED status.
  const result = await adapterWith(() => json({ status: "PENDING", controlNumber: "CH-1" })).submitClaim(
    fileableClaim()
  );

  assert.equal(result.ok, false, "an unknown outcome must not be reported as a business outcome");
  assert.notEqual(result.data?.status, "accepted");
  assert.equal(result.error?.code, "unavailable");
  assert.equal(result.error?.retryable, true, "an ack may simply not be ready yet; retrying is safe");
  assert.match(result.error?.message ?? "", /has NOT been recorded as filed/);
  assert.match(result.error?.message ?? "", /idempotency key/i);
});

test("M2: a body with no status at all is still not an acceptance", async () => {
  const result = await adapterWith(() => json({})).submitClaim(fileableClaim());
  assert.equal(result.ok, false);
  assert.notEqual(result.data?.status, "accepted");
});

test("M2: a 277CA that cannot be parsed is an unknown outcome, not a fallback guess", async () => {
  /**
   * The `catch` around `parse277CA` used to fall through to the guess below it, so an
   * unreadable acknowledgement became "accepted" whenever Stedi had also sent no errors. That
   * defeated the parser's own doctrine — it throws rather than let an unrecognised status read as
   * submitted — from outside the parser.
   */
  const result = await adapterWith(() =>
    json({ x12: "ISA*00*~ST*271*0001~SE*2*0001~", status: "ACCEPTED" })
  ).submitClaim(fileableClaim());

  assert.equal(result.ok, false);
  assert.notEqual(result.data?.status, "accepted");
  assert.equal(result.error?.code, "parse_error");
  assert.equal(result.error?.retryable, false, "the same bytes will not parse differently next time");
  assert.match(result.error?.message ?? "", /UNKNOWN/);
});

test("M2: a genuine refusal IS an outcome and is still recorded as a rejection", async () => {
  // The other half of the asymmetry: refusing to guess must not swallow a real refusal, which a
  // biller has to work.
  const withErrors = await adapterWith(() =>
    json({ errors: [{ code: "E42", description: "Subscriber not found" }] })
  ).submitClaim(fileableClaim());

  assert.equal(withErrors.ok, true, "a refusal is a business outcome, not a transport failure");
  assert.equal(withErrors.data!.status, "rejected");
  assert.equal(withErrors.data!.statusCategory, "A3");
  assert.match(withErrors.data!.message, /Subscriber not found/);

  const rejectedStatus = await adapterWith(() => json({ status: "REJECTED" })).submitClaim(fileableClaim());
  assert.equal(rejectedStatus.ok, true);
  assert.equal(rejectedStatus.data!.status, "rejected");
});

test("M2: a real 277CA still decides the outcome — accepted and rejected both", async () => {
  // The parser remains the authority when there IS something to parse; this fix changed only what
  // happens in its absence.
  const accepted = await adapterWith(() =>
    json({ x12: "ST*277*0001*005010X214~TRN*2*MRM-000123~STC*A1:19*20260727*WQ*65.00~REF*1K*PAYER-9~SE*5*0001~" })
  ).submitClaim(fileableClaim());
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data!.status, "accepted");
  assert.equal(accepted.data!.controlNumber, "PAYER-9");

  const rejected = await adapterWith(() =>
    json({ x12: "ST*277*0001*005010X214~TRN*2*MRM-000123~STC*A3:33*20260727*U*65.00~REF*1K*PAYER-9~SE*5*0001~" })
  ).submitClaim(fileableClaim());
  assert.equal(rejected.ok, true);
  assert.equal(rejected.data!.status, "rejected");
});

test("parseRemittance is implemented — it is pure, and needs no transport at all", () => {
  // An 835 the clinic already holds parses regardless of how it arrived. This is what the webhook
  // path calls once an ERA lands.
  const empty = adapterWith(() => json(okBody())).parseRemittance("");
  assert.equal(empty.ok, false);
  assert.equal(empty.error?.code, "parse_error", "garbage fails loudly, not as an unavailable vendor");
  assert.doesNotMatch(empty.error?.message ?? "", /not implemented/);
});



// ── 7. What a refused claim tells the operator ────────────────────────────────────────

test("an account-level refusal names its cause, not just its HTTP status", async () => {
  /**
   * Live, 2026-10-15: a test claim that had cleared every payer edit came back
   * `400 {"code":"ACCOUNT_NOT_PROVISIONED","message":"This Stedi account does not have a provisioned
   * environment for this operation…"}`. The adapter read only `errors[]`, so the operator saw
   * "Stedi refused the request (HTTP 400)." — and the cause, which is an account change and not a
   * code change, was thrown away.
   */
  const result = await adapterWith(() =>
    json({ code: "ACCOUNT_NOT_PROVISIONED", message: "This Stedi account does not have a provisioned environment for this operation. Contact Stedi support." }, 400)
  ).submitClaim(fileableClaim());
  assert.equal(result.ok, false);
  assert.equal(result.error!.retryable, false, "nothing changes until the account does");
  assert.match(result.error!.message, /ACCOUNT_NOT_PROVISIONED/);
  assert.match(result.error!.message, /production Stedi account/);
});

test("an unrecognised top-level code is passed through as the code alone — never Stedi's free text", async () => {
  const result = await adapterWith(() => json({ code: "SOME_NEW_REFUSAL", message: "echoes Ada Alpha 1990-04-12" }, 400)).submitClaim(fileableClaim());
  assert.match(result.error!.message, /SOME_NEW_REFUSAL/);
  assert.doesNotMatch(result.error!.message, /Ada|1990/, "a body that echoes the request must not reach a log");
});

test("the billing provider's taxonomy goes on the wire when the practice has one", async () => {
  const capture: Capture = {};
  await adapterWith(() => json({}, 200), {}, capture).submitClaim(
    fileableClaim({ billingProvider: { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321", taxonomy: "1223G0001X" } })
  );
  const x12 = (JSON.parse(String(capture.init!.body)) as { x12: string }).x12;
  assert.match(x12, /~HL\*1\*\*20\*1~PRV\*BI\*PXC\*1223G0001X~NM1\*85\*/);
});
