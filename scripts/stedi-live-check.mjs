/**
 * Live Stedi sandbox check — the repeatable proof that the clearinghouse integration is real.
 *
 *   npm run stedi:check
 *
 * Drives the REAL `StediEdiAdapter` against Stedi's TEST environment using Stedi's own published
 * mock subscriber, and prints what came back. Nothing here is simulated: if Stedi is unreachable or
 * the key is wrong, this fails and says so rather than producing a plausible-looking result.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────────────────────
 * • Reads `STEDI_API_KEY` from the environment. Never prints it, never puts it in a URL.
 * • Uses Stedi's published mock member (Aetna / "Jordan Doe" / AETNA9wcSu). **No real patient.**
 * • Refuses to run unless the adapter is in test mode, so this can never bill a real payer check
 *   or transmit a member ID to a live payer by accident.
 */
import { getEdiAdapter, resetEdiAdapter, StediEdiAdapter } from "@mermaid/edi";

/**
 * Stedi's published sandbox mock. These exact values are required — Stedi's test mode matches on
 * them and returns mock benefits; anything else comes back as an AAA error. They identify no real
 * person. Source: stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks
 */
const MOCK = {
  // Mermaid's slug and Stedi's trading-partner id — two namespaces, exactly as the pipeline passes
  // them after `identifyPayer` resolves a card.
  payerId: "aetna-dental",
  clearinghouseId: "60054",
  payerName: "Aetna",
  memberId: "AETNA9wcSu",
  patient: { firstName: "Jordan", lastName: "Doe", dateOfBirth: "" },
};

/**
 * The credential, checked HERE so a missing one reads as an instruction rather than a stack trace.
 *
 * Without this, `getEdiAdapter()` throws the right sentence from three frames down and Node prints
 * it under an `Error:` header with a stack — accurate, and the wrong shape for the first thing an
 * operator runs when wiring up a clearinghouse. The exit code was already 1; only the presentation
 * was hostile.
 */
if (!process.env.STEDI_API_KEY) {
  console.error("REFUSED: STEDI_API_KEY is not set, so there is nothing to check against.\n");
  console.error("  This script needs a Stedi TEST key. Test and production keys are separate, and");
  console.error("  a test key is the only kind that may run here — the adapter refuses to start if");
  console.error("  the key and STEDI_TEST_MODE disagree, in either direction.\n");
  console.error("  Get a test key from the Stedi console, then:");
  console.error("    STEDI_API_KEY=test_... npm run stedi:check");
  process.exit(1);
}
if (!process.env.STEDI_API_KEY.startsWith("test_")) {
  /**
   * Caught before construction as well as inside it. The adapter's own interlock would refuse this
   * anyway; saying so here means the operator is told WHY at the moment they typed the wrong key,
   * rather than reading it out of a thrown configuration error.
   */
  console.error("REFUSED: STEDI_API_KEY is not a test key (test keys begin `test_`).\n");
  console.error("  A production key reaches real payers with real member IDs. This script drives");
  console.error("  Stedi's published mock subscriber and must never do that.");
  process.exit(1);
}

process.env.EDI_ADAPTER = "stedi";
resetEdiAdapter();

const adapter = getEdiAdapter();

if (!(adapter instanceof StediEdiAdapter)) {
  console.error(`FAIL: expected the Stedi adapter, got ${adapter.constructor.name}.`);
  process.exit(1);
}
if (!adapter.testMode) {
  console.error("REFUSED: adapter is not in test mode. This script must never reach a real payer.");
  process.exit(1);
}

/**
 * `null` is "the payer did not say", and it must not print as "$0.00".
 *
 * The adapter is careful about this: a 271 that carries no deductible or annual maximum yields
 * `null` for those fields rather than a fabricated zero, and the per-field confidence drops to 0.2
 * to say so. This script then rendered `null / 100` as `$0.00` — so the very first thing an operator
 * runs when wiring up a clearinghouse reported that Aetna had stated a zero deductible and a zero
 * annual maximum, when Aetna had stated neither. A zero annual maximum and an unknown one are
 * opposite facts: one means the patient has no benefit left, the other means nobody knows yet.
 */
const usd = (c) => (c === null || c === undefined ? "not stated" : `$${(c / 100).toFixed(2)}`);
const started = Date.now();
const result = await adapter.checkEligibility(MOCK);
const elapsed = Date.now() - started;

console.log(`Stedi live check — ${adapter.constructor.name}, test mode, ${elapsed}ms\n`);

if (!result.ok) {
  console.log(`FAIL  ok=false  source=${result.source}`);
  console.log(`      code      : ${result.error?.code}`);
  console.log(`      retryable : ${result.error?.retryable}`);
  console.log(`      message   : ${result.error?.message}`);
  process.exit(1);
}

const b = result.data.benefits;
console.log(`PASS  ok=true  source=${result.source}`);
console.log(`      eligibility   : ${result.data.eligibility}`);
console.log(`      payer         : ${b.payerName}`);
console.log(`      plan          : ${b.planName}`);
console.log(`      deductible    : ${usd(b.deductible.individualAnnual)} annual, ${usd(b.deductible.remaining)} remaining`);
console.log(`      annual max    : ${usd(b.annualMaximum.amount)}, ${usd(b.annualMaximum.remaining)} remaining`);
console.log(`      coverage %    : ${JSON.stringify(b.coveragePercentages)}`);
console.log(`      tier-2 fields : ${b.waitingPeriods.length} waiting periods, ${b.frequencyLimits.length} frequency limits (a 271 cannot carry these)`);
console.log(`      confidence    : ${JSON.stringify(result.data.perFieldConfidence)}`);
console.log();
console.log(`      raw 271       : ${result.raw?.length ?? 0} bytes`);
console.log(`      is a real 271 : ${/ST\*271\*/.test(result.raw ?? "")}`);
console.log(`      ISA usage ind : ${(result.raw ?? "").match(/\*([TP])\*[^*~]*~GS/)?.[1] ?? "?"}  (T = test)`);
console.log(`      money in cents: ${Number.isInteger(b.annualMaximum.amount) && Number.isInteger(b.deductible.individualAnnual)}`);
