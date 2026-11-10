/**
 * The eligibility refusal a REAL payer sent, through the real adapter.
 *
 * Captured from Stedi TEST on 2026-08-23 by `scripts/stedi-scenarios.mjs`: an eligibility check for
 * Stedi's own sandbox member with a date of birth their record does not carry. Aetna answered with a
 * complete 271 that contains `AAA*N**71*C` and no EB segments — which is what a payer refusal
 * ordinarily looks like, and is NOT the "no x12 at all" shape the adapter had a branch for.
 *
 * Kept as the vendor sent it. Synthetic throughout: Stedi's published sandbox member, the demo
 * billing identity, a deliberately mismatched date of birth. No PHI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StediEdiAdapter } from "../vendors/stedi/index.ts";

/** Verbatim, minus nothing. `errors[0]` and the AAA segment in `x12` say the same thing twice. */
const REAL_271_REFUSAL = "{\"meta\":{\"senderId\":\"STEDI\",\"submitterId\":\"117151744\",\"applicationMode\":\"test\",\"traceId\":\"01M0RCH7PNH9TATNBHP363MF4Z\",\"outboundTraceId\":\"01M0RCH7PNH9TATNBHP363MF4Z\"},\"controlNumber\":\"559066027\",\"reassociationKey\":\"559066027\",\"tradingPartnerServiceId\":\"60054\",\"provider\":{\"providerName\":\"MERMAID DEMO DENTAL\",\"entityIdentifier\":\"Provider\",\"entityType\":\"Non-Person Entity\",\"npi\":\"1234567893\"},\"subscriber\":{\"memberId\":\"AETNA9WCSU\",\"firstName\":\"JORDAN\",\"lastName\":\"DOE\",\"entityIdentifier\":\"Insured or Subscriber\",\"entityType\":\"Person\",\"dateOfBirth\":\"19900101\",\"aaaErrors\":[{\"field\":\"AAA\",\"code\":\"71\",\"description\":\"Patient Birth Date Does Not Match That for the Patient on the Database\",\"followupAction\":\"Please Correct and Resubmit\",\"location\":\"Loop 2100C\",\"possibleResolutions\":\"The subscriber's birth date doesn't match what's in the payer's database.\\n• Check that the `subscriber.dateOfBirth` is correct.\\n• If so, contact the payer to resolve this issue.\"}]},\"subscriberTraceNumbers\":[{\"traceTypeCode\":\"1\",\"traceType\":\"Current Transaction Trace Numbers\",\"referenceIdentification\":\"01M0RCH7PNH9TATNBHP363MF4Z\",\"originatingCompanyIdentifier\":\"3117151744\"}],\"payer\":{\"entityIdentifier\":\"Payer\",\"entityType\":\"Non-Person Entity\",\"name\":\"AETNA INC\",\"payorIdentification\":\"60054\"},\"errors\":[{\"field\":\"AAA\",\"code\":\"71\",\"description\":\"Patient Birth Date Does Not Match That for the Patient on the Database\",\"followupAction\":\"Please Correct and Resubmit\",\"location\":\"Loop 2100C\",\"possibleResolutions\":\"The subscriber's birth date doesn't match what's in the payer's database.\\n• Check that the `subscriber.dateOfBirth` is correct.\\n• If so, contact the payer to resolve this issue.\"}],\"x12\":\"ISA*00*          *00*          *ZZ*STEDI          *01*117151744      *260823*2240*^*00501*559066027*0*T*`~GS*HB*STEDI*117151744*20260823*224049*1*X*005010X279A1~ST*271*0001*005010X279A1~BHT*0022*11*01M0RCH7PNH9TATNBHP363MF4Z*20260823*224049~HL*1**20*1~NM1*PR*2*AETNA INC*****PI*60054~HL*2*1*21*1~NM1*1P*2*MERMAID DEMO DENTAL*****XX*1234567893~HL*3*2*22*0~TRN*1*01M0RCH7PNH9TATNBHP363MF4Z*3117151744~NM1*IL*1*DOE*JORDAN****MI*AETNA9WCSU~AAA*N**71*C~DMG*D8*19900101~SE*12*0001~GE*1*1~IEA*1*559066027~\",\"eligibilitySearchId\":\"01a030c8-9ed5-7402-8123-ab90031bb2a4\",\"id\":\"ec_01a030c8-9ed5-7402-8123-ab835555e216\"}";

const adapterWith = (responseBody: string, status = 200) =>
  new StediEdiAdapter({
    apiKey: "test_synthetic",
    baseUrl: "https://healthcare.example.invalid",
    coreBaseUrl: "https://core.example.invalid",
    timeoutMs: 5000,
    testMode: true,
    provider: { organizationName: "MERMAID DEMO DENTAL", npi: "1234567893" },
    fetchImpl: async () =>
      new Response(responseBody, { status, headers: { "content-type": "application/json" } }),
  });

const request = {
  payerId: "aetna-dental",
  payerName: "Aetna",
  clearinghouseId: "60054",
  memberId: "AETNA9wcSu",
  patient: { firstName: "Jordan", lastName: "Doe", dateOfBirth: "1990-01-01" },
};

test("a payer's refusal reason survives, instead of the parser's symptom", async () => {
  const result = await adapterWith(REAL_271_REFUSAL).checkEligibility(request);

  assert.equal(result.ok, false, "a 271 with no benefits must never read as a successful check");
  assert.ok(result.error, "a failed check must carry an error the biller can read");

  /**
   * THE LOAD-BEARING ASSERTION.
   *
   * The payer said: "Patient Birth Date Does Not Match That for the Patient on the Database …
   * Please Correct and Resubmit." The adapter used to report `parse_error` / "271 contained no EB
   * benefit segments", which reached the front desk as a critical `unknown-payer` exception reading
   * "Benefits could not be retrieved; verify manually with the payer".
   *
   * So somebody telephones Aetna about a payer that was matched with 0.95 confidence, and the one
   * fact that would have fixed it in ten seconds — the date of birth on file is wrong — was thrown
   * away by the code that received it.
   */
  assert.match(
    result.error.message,
    /Birth Date Does Not Match/i,
    `the payer's own reason must reach the biller — got: ${result.error.message}`
  );
  assert.equal(
    /no EB benefit segments/.test(result.error.message),
    false,
    "the parser's symptom must not stand in for the payer's reason when the payer gave one"
  );
  assert.equal(result.error.retryable, false, "resubmitting the same wrong date of birth cannot help");
});

test("with no reason from the payer, the parser's message is still reported", async () => {
  /**
   * The fallback has to keep working. A 271 that is unreadable for some reason the payer did not
   * name must still fail loud and say what went wrong — silence here would be a check that neither
   * succeeded nor explained itself.
   */
  const noErrors = JSON.stringify({
    ...JSON.parse(REAL_271_REFUSAL),
    errors: [],
    subscriber: { memberId: "AETNA9WCSU" },
  });
  const result = await adapterWith(noErrors).checkEligibility(request);

  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error.message, /EB benefit segments/);
});
