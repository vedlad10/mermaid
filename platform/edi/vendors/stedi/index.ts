/**
 * StediEdiAdapter — a real clearinghouse behind the existing `EdiAdapter` seam.
 *
 * ── WHAT THIS DOES AND DOES NOT REPLACE ────────────────────────────────────────────────────────
 * It replaces the TRANSPORT and nothing else. Stedi returns the payer's actual X12 271, and that
 * 271 goes through `parse271` — the same production parser the mock has always used, unchanged and
 * unforked. There is no second eligibility-processing engine: payer identification, the estimate
 * calculator, confidence aggregation, the review gate and the audit trail all sit downstream and
 * cannot tell where the 271 came from, which is the entire point of the seam.
 *
 * If Stedi returns a body with no `x12`, that is a **parse error**, not an opportunity to
 * reconstruct benefits from the JSON summary. Two readers of one payer response is exactly the
 * "second interpreter" this architecture exists to prevent, and the JSON summary is derived from
 * the 271 anyway — reading it instead would mean trusting Stedi's parse over our own.
 *
 * ── SCOPE, AS OF THE ERA WORK ──────────────────────────────────────────────────────────────────
 * Eligibility (270/271) is live and verified against Stedi TEST.
 *
 * Claim submission is implemented and reaches Stedi, but every well-formed 837D comes back
 * `INTERNAL_ERROR`; the differential in `stedi-support-request.md` shows the fault is on their
 * side, past every validation gate. Nothing here works around it.
 *
 * ERA retrieval — `listRemittanceArtifacts` + `fetchRemittanceArtifact` — is implemented against
 * the CORE host (`core.us.stedi.com`), which is a different service from the healthcare host the
 * rest of this file talks to. It has not been exercised against live Stedi, because a test ERA is
 * only produced for a claim that submitted successfully, and no claim has.
 *
 * `fetchRemittance` (the poll-by-claim shape) remains unimplemented and says why.
 */
import { X12_RELATIONSHIP_CODE } from "@mermaid/shared";
import { cents, toDollars, type Benefits, type Cents } from "@mermaid/shared";
import type {
  ClaimAcknowledgement,
  ClaimSubmissionRequest,
  EdiAdapter,
  EdiResult,
  EligibilityRequest,
  EligibilityResponse,
  RemittanceAdvice,
  RemittanceRequest,
  RemittanceArtifactPage,
  RemittanceArtifactQuery,
} from "../../adapter.ts";
import { parse271, parseSegments } from "../../mock/x12-271.ts";
import { ackForClaim, attributeLineStatuses, build837D, parse277CA } from "../../mock/x12-837.ts";
/**
 * The 835 normaliser, borrowed deliberately.
 *
 * `parseRemittance` is PURE — it turns X12 bytes into a RemittanceAdvice and touches no transport.
 * There is exactly one correct reading of an 835 in this codebase and it lives in the mock adapter
 * because that is where the codec landed; re-implementing it here would create a second one, and
 * two readings of a payer’s money file that can disagree is the defect, not the duplication.
 */
import { MockEdiAdapter } from "../../mock/index.ts";
import { StediClient, type StediClaimResponse, type StediEligibilityRequest } from "./client.ts";

/** Dental. Stedi accepts only `35` for dental eligibility, and only `30` for medical. */
const DENTAL_SERVICE_TYPE = "35";

/** Stedi prefixes test keys. The interlock below turns that convention into an enforced guarantee. */
const TEST_KEY_PREFIX = "test_";

/** AAA03 reasons meaning the payer could not answer NOW: try again; nothing about the patient is wrong. */
const PAYER_BUSY_REASONS: ReadonlySet<string> = new Set(["42", "80"]);
/** AAA03 reasons about the patient's or subscriber's identifying details (birth date, ID, name, …). */
const MEMBER_DATA_REASONS: ReadonlySet<string> = new Set([
  "58", "60", "64", "65", "66", "67", "68", "69", "70", "71", "72", "73", "74", "75", "76", "77", "78",
]);

/**
 * What kind of refusal this is, from the AAA03 reject reasons in the 271 (and Stedi's `errors`).
 *
 * Every payer refusal used to be `invalid_member_id`, not retryable. Against live Stedi, AAA `42`
 * ("Unable to Respond at Current Time", AAA04 `R` resubmission allowed) therefore told the front
 * desk the member ID was wrong when the payer's system was simply down, and marked a check that would
 * succeed in ten minutes as one that never could. Provider-side reasons (`43` provider not
 * recognised, `79` connection to the payer) are about the PRACTICE's setup and are no more the
 * patient's fault. Unknown reasons keep the old reading: the payer's own words still reach the screen.
 */
function classifyRefusal(
  x12: string | undefined,
  errors: { code?: string }[]
): { code: "invalid_member_id" | "unavailable"; retryable: boolean; next: string | null } {
  const reasons = new Set<string>(errors.map((e) => (e.code ?? "").trim()).filter(Boolean));
  if (x12) {
    for (const seg of parseSegments(x12)) if (seg.id === "AAA" && seg.elements[2]) reasons.add(seg.elements[2].trim());
  }
  if (reasons.size === 0) return { code: "invalid_member_id", retryable: false, next: null };
  const all = [...reasons];
  if (all.some((r) => MEMBER_DATA_REASONS.has(r))) return { code: "invalid_member_id", retryable: false, next: null };
  if (all.every((r) => PAYER_BUSY_REASONS.has(r))) {
    return {
      code: "unavailable",
      retryable: true,
      next: "The payer's system did not answer; nothing in the patient's details is known to be wrong. Try again later.",
    };
  }
  return {
    code: "unavailable",
    retryable: false,
    next: "This refusal is about the practice's setup with the payer or the request, not the patient's details.",
  };
}

export interface StediAdapterOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** True = mock benefits, no payer contact. False = a real payer answers a real patient's check. */
  testMode: boolean;
  /** Billing provider identity Stedi requires on every check. */
  provider: { organizationName: string; npi: string };
  /** Stedi's EDI-platform host, where ERA polling and artifact retrieval live. */
  coreBaseUrl?: string;
  /**
   * Extra hosts an ERA artifact may be downloaded from (NEW-24). Additive to the client's built-in
   * defaults; it cannot remove them.
   */
  artifactHosts?: readonly string[];
  /** Ceiling on one retrieved ERA, in bytes. */
  maxArtifactBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Refused before any request is built.
 *
 * Separate from `EdiError` on purpose: an `EdiError` is a thing that went wrong during a check, and
 * the outbox may retry some of them. This is a deployment that is configured wrongly, and no number
 * of retries will fix it — it should stop the process, not degrade a verification.
 */
export class StediConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StediConfigurationError";
  }
}

/** How this adapter names itself in every message a human reads. */
const VENDOR = "Stedi";

export class StediEdiAdapter implements EdiAdapter {
  #client: StediClient;
  #testMode: boolean;
  #provider: { organizationName: string; npi: string };

  constructor(options: StediAdapterOptions) {
    /**
     * ── THE TEST/PRODUCTION INTERLOCK ──────────────────────────────────────────────────────────
     * Stedi issues separate test and production keys, and a test key returns *mock benefits that
     * look exactly like real ones* — same shape, same 271, plausible numbers. So the failure mode
     * this guards is not a crash, it is a clinic quoting a patient from invented coverage and
     * believing it, or a "test" run reaching a real payer with a real member ID.
     *
     * Nothing downstream can detect either case, so it is caught here, at construction, where the
     * two facts that must agree are both in hand: what the deployment *says* its mode is, and what
     * the key actually is.
     */
    const looksLikeTestKey = options.apiKey.startsWith(TEST_KEY_PREFIX);
    if (options.testMode && !looksLikeTestKey) {
      throw new StediConfigurationError(
        "STEDI_TEST_MODE is on but STEDI_API_KEY is not a test key. A production key reaches real " +
          "payers with real member IDs. Use a test key, or set STEDI_TEST_MODE=0 deliberately."
      );
    }
    if (!options.testMode && looksLikeTestKey) {
      throw new StediConfigurationError(
        "STEDI_TEST_MODE=0 asks for real payer traffic but STEDI_API_KEY is a test key. Every " +
          "check would return mock benefits that look real — a clinic would quote patients from " +
          "invented coverage. Use a production key, or leave test mode on."
      );
    }

    this.#client = new StediClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      ...(options.coreBaseUrl ? { coreBaseUrl: options.coreBaseUrl } : {}),
      ...(options.artifactHosts?.length ? { artifactHosts: options.artifactHosts } : {}),
      ...(options.maxArtifactBytes ? { maxArtifactBytes: options.maxArtifactBytes } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.#testMode = options.testMode;
    this.#provider = options.provider;
  }

  /** Whether this adapter is returning Stedi's mock benefits rather than a payer's answer. */
  get testMode(): boolean {
    return this.#testMode;
  }

  async checkEligibility(req: EligibilityRequest): Promise<EdiResult<EligibilityResponse>> {
    /**
     * ── THE SLUG IS NOT A TRADING-PARTNER ID ───────────────────────────────────────────────────
     * Sending Mermaid's slug ("aetna-dental") to Stedi produces a 271 with no benefit segments,
     * which the parser refuses — safe, but permanently unsuccessful, and the resulting message
     * ("271 contained no EB benefit segments") describes a symptom rather than the cause. Refusing
     * up front names the actual problem: this payer has no clearinghouse id recorded.
     */
    const tradingPartnerId = req.clearinghouseId;
    if (!tradingPartnerId) {
      return {
        ok: false,
        error: {
          code: "unavailable",
          message:
            `No Stedi payer id is recorded for ${req.payerName} (${req.payerId}), so this check ` +
            `cannot be routed. Verify with the payer directly, and add the id to the payer registry.`,
          retryable: false,
        },
        source: "edi",
      };
    }

    const request: StediEligibilityRequest = {
      tradingPartnerServiceId: tradingPartnerId,
      encounter: {
        serviceTypeCodes: [DENTAL_SERVICE_TYPE],
        ...(req.serviceDate ? { dateOfService: yyyymmdd(req.serviceDate) } : {}),
      },
      provider: this.#provider,
      subscriber: {
        firstName: req.patient.firstName,
        lastName: req.patient.lastName,
        memberId: req.memberId,
        ...(req.patient.dateOfBirth ? { dateOfBirth: compactDate(req.patient.dateOfBirth) } : {}),
      },
    };

    const call = await this.#client.checkEligibility(request);

    if (!call.ok || !call.body) {
      return {
        ok: false,
        error: call.error ?? { code: "unavailable", message: "Stedi returned no body.", retryable: true },
        ...(call.rawBody ? { raw: call.rawBody } : {}),
        source: "edi",
      };
    }

    const body = call.body;

    /**
     * What the PAYER said about why it would not answer, in the payer's own words.
     *
     * Stedi surfaces a refusal twice: as an `errors` array on the JSON, and as an `AAA` segment
     * inside the 271 itself. Both name a specific, actionable cause — "Patient Birth Date Does Not
     * Match That for the Patient on the Database", followed by "Please Correct and Resubmit".
     */
    const payerRefusal = (body.errors ?? [])
      .map((e) => e.description ?? e.code)
      .filter((d): d is string => Boolean(d))
      .join("; ");

    /**
     * A 200 that carries only errors. Stedi answers payer-level refusals ("member not found",
     * "payer unavailable") with HTTP 200 and an `errors` array — a business outcome, not a
     * transport failure, exactly like a rejected 277CA. Treated as a failed check the biller must
     * see, never as an empty benefits set.
     */
    const refusal = classifyRefusal(body.x12, body.errors ?? []);
    const refusalMessage = `The payer could not answer this check: ${payerRefusal}${refusal.next ? `. ${refusal.next}` : ""}`;
    if (!body.x12) {
      return {
        ok: false,
        error: {
          code: payerRefusal ? refusal.code : "parse_error",
          message: payerRefusal ? refusalMessage : "Stedi returned no X12 271 to parse.",
          retryable: payerRefusal ? refusal.retryable : false,
        },
        ...(call.rawBody ? { raw: call.rawBody } : {}),
        source: "edi",
      };
    }

    /**
     * ── MODE VERIFIED AGAINST WHAT STEDI ITSELF REPORTS ────────────────────────────────────────
     * The constructor checked the key's prefix; this checks the answer. Stedi echoes the mode it
     * served the request in, and if that disagrees with what this deployment believes, the safe
     * move is to discard a response we cannot characterise — mock benefits presented as a payer's
     * answer are worse than no answer at all.
     */
    const reportedMode = body.meta?.applicationMode;
    if (reportedMode && this.#testMode && reportedMode !== "test") {
      return {
        ok: false,
        error: {
          code: "unavailable",
          message:
            `Stedi served this check in "${reportedMode}" mode while Mermaid is in test mode. ` +
            `Refusing the response rather than treating real payer data as a test.`,
          retryable: false,
        },
        raw: body.x12,
        source: "edi",
      };
    }

    let parsed;
    try {
      // THE production parser. Unchanged, unforked, and the same one the mock feeds.
      parsed = parse271(body.x12, req.networkParticipation);
    } catch (e) {
      /**
       * ── A REFUSAL ARRIVES WITH AN X12, NOT INSTEAD OF ONE ──────────────────────────────────────
       *
       * The branch above only consults `errors` when there is NO 271 to parse. That is the rare
       * shape. The ordinary one — and the one live Stedi returns — is a complete 271 whose subscriber
       * loop carries `AAA*N**71*C` and no EB segments at all, alongside the same `errors` array:
       *
       *   HL*3*2*22*0~TRN*1*...~NM1*IL*1*DOE*JORDAN****MI*AETNA9WCSU~AAA*N**71*C~DMG*D8*19900101~
       *
       * `parse271` correctly refuses that — benefits it cannot read must never become an empty
       * benefits set — and threw "271 contained no EB benefit segments". Which is true, and useless.
       * It reached the front desk as a critical `unknown-payer` exception reading "Benefits could not
       * be retrieved; verify manually with the payer", so somebody telephones Aetna about a payer
       * that was matched with 0.95 confidence, when the payer had already said precisely what was
       * wrong and how to fix it: the date of birth on file does not match theirs.
       *
       * The rule this module already states for the no-x12 case is the right one and simply was not
       * applied here: a payer-level refusal is a business outcome the biller must SEE. So when the
       * payer gave a reason, the payer's reason is what gets reported; the parser's symptom is kept
       * only when there is nothing better to say.
       */
      const symptom = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: {
          code: payerRefusal ? refusal.code : "parse_error",
          message: payerRefusal ? refusalMessage : symptom,
          retryable: payerRefusal ? refusal.retryable : false,
        },
        raw: body.x12,
        source: "edi",
      };
    }

    /**
     * Money crosses from dollars (wire) to integer cents (domain) HERE, at the adapter boundary —
     * the same single conversion point the mock uses. Nothing downstream ever sees a float.
     *
     * ── A FIGURE THE PAYER DID NOT STATE STAYS NULL (M4) ────────────────────────────────────────
     * These were `cents(parsed.x ?? 0)`. That coalesce is where "the payer did not say" became a
     * number, and for the deductible it became the most favourable number available: `remaining: 0`
     * reads as "already met", so no deductible was applied and the patient was quoted less than they
     * owe. A 271 that states an annual deductible and omits the remaining balance is ordinary, so
     * this was not an edge case.
     *
     * `Benefits` now carries the distinction and every consumer decides deliberately — the estimate
     * quotes conservatively, and `detectExceptions` says out loud that it did.
     */
    const toCents = (value: number | null): Cents | null => (value === null ? null : cents(value));
    const maxAmount = parsed.annualMaximum.amount;
    const maxRemaining = parsed.annualMaximum.remaining;

    const benefits: Benefits = {
      eligibility: parsed.eligibility,
      payerName: parsed.payerName ?? req.payerName,
      planName: parsed.planName ?? req.planName ?? "Dental",
      deductible: {
        individualAnnual: toCents(parsed.deductible.annual),
        remaining: toCents(parsed.deductible.remaining),
        appliesTo: ["basic", "major"],
      },
      annualMaximum: {
        amount: toCents(maxAmount),
        // Derived, so it is only knowable when BOTH halves were stated.
        used: maxAmount === null || maxRemaining === null ? null : cents(Math.max(0, maxAmount - maxRemaining)),
        remaining: toCents(maxRemaining),
      },
      /**
       * Not spread over a zero-filled record (M17): a category the payer did not mention must stay
       * ABSENT. Filling it with 0 turned silence into "this plan covers 0% of major services" — an
       * assertion about the plan that the payer never made, and one a patient declines treatment on.
       */
      coveragePercentages: { ...parsed.coveragePercentages },
      // Per-code rates, when the payer listed codes against them (Cigna). See `Benefits`.
      ...(Object.keys(parsed.procedureCoveragePercentages).length > 0
        ? { procedureCoveragePercentages: { ...parsed.procedureCoveragePercentages } }
        : {}),
      /**
       * ── TIER-2 FIELDS ARE EMPTY, AND THAT IS THE TRUTH ────────────────────────────────────────
       * Waiting periods, frequency limits and exclusions are payer-portal data. A 271 does not
       * carry them, so a real check cannot know them. The mock fills these from its profile because
       * it is standing in for the payer's whole system; this adapter must not, because inventing a
       * "no waiting periods" answer would let an estimate quote a patient for a crown that is
       * actually in a twelve-month wait. Empty here, and the confidence below says so.
       */
      waitingPeriods: [],
      frequencyLimits: [],
      exclusions: [],
      excludedCodes: [],
      // The payer’s own coverage window, when it stated one. Carried onto the benefits so the
      // verification can compare it against the DATE OF SERVICE — "active today" and "in force on
      // the day we treated them" are different questions.
      coverage: parsed.coverage,
      // Other plans the payer named (EB*R + 2120) — the same evidence the mock path carries.
      ...(parsed.otherPayers.length > 0 ? { otherPayers: parsed.otherPayers } : {}),
    };

    return {
      ok: true,
      data: {
        eligibility: parsed.eligibility,
        benefits,
        perFieldConfidence: {
          // Tier 1 — came off the payer's own 271.
          eligibility: 0.95,
          /**
           * Stated but disagreeing is its own case: the payer gave two rates for one category at the
           * same scope and the lower was quoted. Real, but chosen — so not the full 0.9.
           */
          coveragePercentages:
            Object.keys(parsed.coveragePercentages).length === 0
              ? 0.2
              : parsed.trace.coinsuranceConflicts.some((c) => c.scope === "category")
                ? 0.6
                : 0.9,
          /**
           * BOTH halves have to be stated for the figure to be usable (M4).
           *
           * This read `annual === null ? 0.2 : 0.9`, which is precisely backwards for the case that
           * matters: a payer stating the annual deductible and omitting the REMAINING balance scored
           * 0.9 — full confidence in a number that had been invented by a `?? 0`. The missing half
           * is the one the estimate actually spends.
           */
          deductible:
            parsed.deductible.annual === null || parsed.deductible.remaining === null ? 0.2 : 0.9,
          annualMaximum:
            parsed.annualMaximum.amount === null || parsed.annualMaximum.remaining === null ? 0.2 : 0.9,
          // Tier 2 — genuinely unknown from a 271. Zero, so the review gate can see it.
          waitingPeriods: 0,
          frequencyLimits: 0,
        },
        // What the payer echoed about WHOSE record it answered on (M10). Compared to the
        // request by the verification pipeline; reported, never judged, here.
        subscriber: { memberId: parsed.memberId, dateOfBirth: parsed.subscriberDateOfBirth },
        // Benefit segments the precedence rules discarded, reported so a human can see them (M24).
        supersededBenefits: parsed.trace.supersededBenefits,
      },
      raw: body.x12,
      source: "edi",
    };
  }

  // ── Money paths ─────────────────────────────────────────────────────────────────────

  /**
   * File an 837D through Stedi and return the payer's 277CA acknowledgement.
   *
   * The 837 is built by the SAME production codec the mock uses, and the 277CA that comes back is
   * read by the SAME production parser. Stedi is transport: swapping it changes where the bytes go,
   * not what they mean.
   *
   * Two refusals before anything leaves the process, both for the same reason the eligibility path
   * has them — a claim is a legal attestation about money, and a claim sent wrong is worse than a
   * claim not sent:
   *
   *   • No `clearinghouseId`. Stedi routes on loop 2010BB NM109 and requires an id from its own
   *     payer network. Mermaid's slug (`delta-dental`) is not one. Sending it means the claim is
   *     either rejected or routed somewhere nobody intended, and the practice learns weeks later.
   *   • Nothing to file. An empty claim is a malformed one.
   */
  async submitClaim(req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
    if (!req.clearinghouseId) {
      return {
        ok: false,
        error: {
          code: "unavailable",
          message:
            `No ${VENDOR} payer id is configured for "${req.payerId}". Stedi routes a claim on the payer ` +
            `id in loop 2010BB, and Mermaid's own slug is not one — filing with it would misroute the claim. ` +
            `Add the payer's ${VENDOR} id, or use EDI_ADAPTER=mock.`,
          retryable: false,
        },
        source: "edi",
      };
    }
    if (req.lines.length === 0) {
      return {
        ok: false,
        error: { code: "parse_error", message: "A claim must carry at least one service line.", retryable: false },
        source: "edi",
      };
    }

    const raw837 = build837D({
      claimId: req.claimId,
      patientControlNumber: req.patientControlNumber,
      // The wire carries the CLEARINGHOUSE's id; Mermaid's slug never leaves the process.
      payerId: req.clearinghouseId,
      payerName: req.payerName,
      subscriberFirstName: req.subscriber.firstName,
      subscriberLastName: req.subscriber.lastName,
      memberId: req.subscriber.memberId,
      dateOfBirth: req.subscriber.dateOfBirth,
      groupNumber: req.subscriber.groupNumber ?? null,
      ...(req.subscriber.address ? {
        subscriberStreet: req.subscriber.address.street,
        subscriberCity: req.subscriber.address.city,
        subscriberState: req.subscriber.address.state,
        subscriberZip: req.subscriber.address.zip,
      } : {}),
      ...(req.subscriber.gender ? { subscriberGender: req.subscriber.gender } : {}),
      // Loop 2310B, only for a group practice — see `renderingProvider` (NEW-22).
      ...(req.renderingProvider ? { renderingProvider: req.renderingProvider } : {}),
      /**
       * Loop 2000C, only when the patient is not the subscriber (NEW-01).
       *
       * The address falls back to the SUBSCRIBER's: a practice that holds one address for a family
       * is stating something it can support, whereas omitting 2010CA N3/N4 produces a claim the
       * payer rejects for a missing dependent address. Never invented — if neither is on file both
       * are empty and the scrubber has already blocked the claim.
       */
      ...(req.patient
        ? {
            dependent: {
              firstName: req.patient.firstName,
              lastName: req.patient.lastName,
              dateOfBirth: req.patient.dateOfBirth,
              relationshipCode: X12_RELATIONSHIP_CODE[req.patient.relationship],
              ...addressOf(req.patient.address ?? req.subscriber.address),
              ...(req.patient.gender ? { gender: req.patient.gender } : {}),
            },
          }
        : {}),
      billingProviderName: req.billingProvider.name,
      billingProviderNpi: req.billingProvider.npi,
      billingProviderTaxId: req.billingProvider.taxId,
      ...(req.billingProvider.phone ? { submitterContactPhone: req.billingProvider.phone } : {}),
      ...(req.billingProvider.street ? { billingProviderStreet: req.billingProvider.street } : {}),
      ...(req.billingProvider.city ? { billingProviderCity: req.billingProvider.city } : {}),
      ...(req.billingProvider.state ? { billingProviderState: req.billingProvider.state } : {}),
      ...(req.billingProvider.zip ? { billingProviderZip: req.billingProvider.zip } : {}),
      ...(req.billingProvider.taxonomy ? { billingProviderTaxonomy: req.billingProvider.taxonomy } : {}),
      serviceDate: req.serviceDate,
      totalCharge: toDollars(req.totalCharge),
      // The envelope must agree with the credential. `testMode` is already interlocked against the
      // key prefix at construction, so this cannot drift from what Stedi will accept.
      usageIndicator: this.#testMode ? "T" : "P",
      ...(req.claimFrequency ? { claimFrequency: req.claimFrequency } : {}),
      ...(req.originalClaimControlNumber ? { originalClaimControlNumber: req.originalClaimControlNumber } : {}),
      lines: req.lines.map((l) => ({
        lineNumber: l.lineNumber,
        procedureCode: l.procedureCode,
        ...(l.toothNumber ? { toothNumber: l.toothNumber } : {}),
        ...(l.surfaces ? { surfaces: l.surfaces } : {}),
        quantity: l.quantity,
        chargeAmount: toDollars(l.chargeAmount),
        serviceDate: l.serviceDate,
      })),
    });

    /**
     * The idempotency key is the CLAIM's own control number, not a random value.
     *
     * That is the whole point: the outbox delivers at least once and a biller may press submit
     * twice, and both must reach Stedi as the same submission. A fresh uuid per attempt would make
     * every retry a new claim, which is exactly the duplicate filing this header exists to prevent.
     */
    const result = await this.#client.submitDentalClaim(raw837, req.patientControlNumber);

    /**
     * ── A REJECTION ARRIVES AS AN HTTP 400, AND IT IS NOT A TRANSPORT FAILURE ────────────────────
     *
     * Stedi answers a claim it will not forward with `HTTP 400` and a body carrying the payer's own
     * 277CA plus a `claimReference.rhclaimNumber` — proof the claim reached the downstream network
     * and was ruled on. Observed live: an invalid billing NPI returns exactly that, with STC
     * `A7:562:85` and error code 33.
     *
     * This branch discarded it. `!result.ok` returned a transport error, `ClaimService.submit`
     * threw, and the claim stayed `ready` — so a biller saw "Stedi refused the request (HTTP 400)"
     * and never saw WHAT the payer said, had no control number to quote, and had a claim that
     * looked unfiled when it had in fact been rejected for a nameable reason.
     *
     * That contradicts this module's own contract, stated at the submit gate: "A payer rejection is
     * recorded as a business outcome (status `rejected`) and does NOT throw — the claim is still a
     * real claim that a biller must now fix. Only a transport failure throws."
     *
     * ── WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT ─────────────────────────────────────────────
     * The discriminator is a 277CA in the body that reports on THIS claim — which `ackForClaim`
     * already decides, and which no infrastructure error carries. So:
     *
     *   • `{"code":"BAD_REQUEST","message":"…not have a provisioned environment…"}` — no x12, stays
     *     a transport failure. It is an account problem, not a payer's opinion of the claim.
     *   • `MALFORMED_X12`, `PAYER_NOT_CONFIGURED`, a structural `expected_segment` — no x12, and
     *     all of them mean Mermaid built something wrong. Still transport failures; the claim must
     *     not be marked rejected by the payer when no payer ever saw it.
     *   • 401/403/429/5xx — never reach here with an x12.
     */
    const rejection = !result.ok ? this.#acknowledgementIn(result.rawBody) : null;
    if (rejection) {
      return this.#fromAcknowledgement(rejection, req);
    }

    if (!result.ok || !result.body) {
      return { ok: false, error: result.error, raw: result.rawBody ?? raw837, source: "edi" };
    }

    const body = result.body;

    /**
     * The payer's 277CA rides back inside the JSON. Parsing it with the production parser rather
     * than trusting Stedi's summary fields keeps one interpretation of an acknowledgement in the
     * codebase — the mock and the vendor cannot drift into disagreeing about what "accepted" means.
     */
    if (body.x12) {
      return this.#fromAcknowledgement({ x12: body.x12, controlNumber: body.controlNumber }, req);
    }
    return this.#withoutAcknowledgement(body, req, raw837);
  }

  /**
   * A 277CA in an error body, or null when there is none.
   *
   * Deliberately tolerant of the parse: a body that is not JSON, or is JSON without `x12`, is simply
   * "no acknowledgement" and the caller falls through to its transport-failure path. An error here
   * must never become an exception — the request already failed, and failing differently while
   * inspecting it would replace a diagnosable error with an opaque one.
   */
  #acknowledgementIn(rawBody: string | undefined): { x12: string; controlNumber?: string } | null {
    if (!rawBody) return null;
    try {
      const parsed = JSON.parse(rawBody) as StediClaimResponse;
      return parsed.x12 ? { x12: parsed.x12, controlNumber: parsed.controlNumber } : null;
    } catch {
      return null;
    }
  }

  /**
   * Turn a 277CA into this claim's outcome — the ONE interpretation of an acknowledgement.
   *
   * Shared by the accepted path and the rejected-with-400 path on purpose. Two copies would be two
   * places for "what does accepted mean" to drift, and the whole reason this parses the X12 rather
   * than trusting Stedi's summary fields is that there should be exactly one answer to that.
   */
  #fromAcknowledgement(
    ack: { x12: string; controlNumber?: string },
    req: ClaimSubmissionRequest
  ): EdiResult<ClaimAcknowledgement> {
    const body = { x12: ack.x12, controlNumber: ack.controlNumber } as StediClaimResponse;
    {
      try {
        const parsed = parse277CA(body.x12!);
        /**
         * Read for THIS claim by name (M19). A 277CA may report on many claims and carries STC
         * segments at several hierarchical levels; a single global status is only ever right by
         * luck. No match among several claims is an UNKNOWN outcome, never an acceptance.
         */
        const claimAck = ackForClaim(parsed, req.patientControlNumber);
        if (!claimAck) {
          return {
            ok: false,
            error: {
              code: "parse_error",
              message:
                `${VENDOR} returned an acknowledgement reporting on ${parsed.claims.length} claims, none of ` +
                `them "${req.patientControlNumber}". This claim's outcome is UNKNOWN — it has NOT been ` +
                `recorded as filed. Check the submission in the ${VENDOR} portal before refiling.`,
              retryable: false,
            },
            raw: body.x12,
            source: "edi",
          };
        }
        return {
          ok: true,
          data: {
            status: claimAck.accepted ? "accepted" : "rejected",
            controlNumber: claimAck.payerControlNumber ?? body.controlNumber ?? "",
            // Our own number as the payer echoed it (M10). ClaimService refuses an ack for a
            // different claim than the one it submitted.
            patientControlNumber: claimAck.patientControlNumber,
            statusCategory: claimAck.statusCategory,
            statusCode: claimAck.statusCode,
            message: claimAck.message,
            acknowledgedAt: new Date().toISOString(),
            /**
             * The real payer path, and the reason DEC-1 exists. Stedi hands back the payer's own
             * 277CA, whose SVC01 names a PROCEDURE — never one of our line numbers. Statuses are
             * attributed against the lines this request actually submitted, and anything that
             * cannot be tied to exactly one line is reported as unattributed rather than guessed.
             */
            ...(({ attributed, unattributed }) => ({
              lineErrors: attributed,
              unattributedLineErrors: unattributed,
            }))(attributeLineStatuses(claimAck.lineStatuses, req.lines)),
          },
          raw: body.x12,
          source: "edi",
        };
      } catch (e: unknown) {
        /**
         * A 277CA we cannot read is an outcome we do not know — never one we may assume.
         *
         * This used to fall through to the guess below, which meant an unparsable acknowledgement
         * became `accepted` whenever Stedi had also sent no `errors`. `parse277CA` was written with
         * the opposite doctrine — it throws rather than let an unrecognised status read as
         * "submitted" — and falling through defeated that from outside the parser.
         *
         * Not retryable: the same bytes will not parse differently next time. The claim stays
         * fileable and a person is told what came back.
         */
        return {
          ok: false,
          error: {
            code: "parse_error",
            message:
              `${VENDOR} returned an acknowledgement that could not be read as a 277CA ` +
              `(${e instanceof Error ? e.message : String(e)}). The claim's outcome is UNKNOWN — it ` +
              `has NOT been recorded as filed. Check the submission in the ${VENDOR} portal before refiling.`,
            retryable: false,
          },
          raw: body.x12,
          source: "edi",
        };
      }
    }
  }

  /**
   * ── NO 277CA CAME BACK ──────────────────────────────────────────────────────────────────────
     *
     * A 277CA is the ONLY thing that says a claim is in a payer's hands. Without one there are
     * exactly two honest readings, and neither of them is "accepted":
     *
     *   • Stedi reported errors, or said REJECTED → something refused the claim. That is a real
     *     business outcome a biller must work, so it is recorded as a rejection.
     *   • Stedi reported nothing either way → the outcome is UNKNOWN.
     *
     * The second case used to be read as acceptance: `errors.length === 0 && status !== "REJECTED"`
     * treated the ABSENCE of a refusal as a confirmation, so `PENDING`, `QUEUED`, `PROCESSING` and
     * an entirely missing status all became "the payer has it". The claim then moved to `submitted`,
     * `claim.submitted` was published, an expectation was recorded, and the claim left the working
     * queue — for a submission that may never have reached anybody. Nothing downstream could detect
     * it, because a 277CA that never arrives looks exactly like one that has not arrived YET.
     *
     * So an unknown outcome is `ok: false`. `ClaimService.submit` then throws rather than writing a
     * submission record, and the claim stays `ready` — visible, fileable, still inside its deadline.
     * Retrying is safe by construction: `submitDentalClaim` carries the claim's own control number
     * as the `Idempotency-Key`, and the payer's CLM01 duplicate detection is the second backstop.
     *
     * The asymmetry is the whole argument. A retry that turns out to be a duplicate produces a
     * CARC-18 denial a biller can see and work. A claim silently recorded as filed and never sent is
     * unrecoverable the moment its filing window closes.
     */
  #withoutAcknowledgement(
    body: StediClaimResponse,
    req: ClaimSubmissionRequest,
    rawBody: string
  ): EdiResult<ClaimAcknowledgement> {
    void req;
    const errors = body.errors ?? [];
    const refused = errors.length > 0 || body.status === "REJECTED";

    if (!refused) {
      return {
        ok: false,
        error: {
          code: "unavailable",
          message:
            `${VENDOR} accepted the request but returned no 277CA acknowledgement` +
            `${body.status ? ` (status "${body.status}")` : ""}. Only an acknowledgement shows a claim ` +
            `reached the payer, so this claim has NOT been recorded as filed. It remains ready to ` +
            `submit; retrying is safe — the submission carries an idempotency key.`,
          // Retryable: an acknowledgement may simply not have been ready yet.
          retryable: true,
        },
        raw: rawBody,
        source: "edi",
      };
    }

    // A refusal IS an outcome, and a real one. Recorded as the business fact it is.
    return {
      ok: true,
      data: {
        status: "rejected",
        controlNumber: body.controlNumber ?? body.claimReference?.correlationId ?? "",
        // Stedi's own JSON echo of the claim, when it named one. Null is honest: no 277CA came back.
        patientControlNumber: body.claimReference?.patientControlNumber ?? null,
        statusCategory: "A3",
        statusCode: errors[0]?.code ?? null,
        message:
          errors.map((e) => e.description ?? e.code).filter(Boolean).join("; ") ||
          `Rejected by ${VENDOR}${body.status ? ` (${body.status})` : ""}.`,
        acknowledgedAt: new Date().toISOString(),
        lineErrors: [],
        unattributedLineErrors: [],
      },
      raw: rawBody,
      source: "edi",
    };
  }

  /**
   * Parse an 835 this deployment already holds.
   *
   * Pure, and therefore implementable regardless of how the file arrived — the same production 835
   * codec the mock uses. This is what the ERA path calls once an artifact is retrieved.
   */
  parseRemittance(raw: string): EdiResult<RemittanceAdvice> {
    return new MockEdiAdapter().parseRemittance(raw);
  }

  /** Every 835 in an ERA file. Same production codec; a clearinghouse batches cheques routinely. */
  parseRemittanceAll(raw: string): EdiResult<RemittanceAdvice[]> {
    return new MockEdiAdapter().parseRemittanceAll(raw);
  }

  /**
   * Discover ERA artifacts Stedi has processed for THIS credential.
   *
   * The filter is applied here rather than in the query because Stedi's polling endpoint takes only
   * a cursor and a page size — `direction` and `transactionSetIdentifier` are fields on the
   * response. Sending them as query parameters yields a silently unfiltered page, not an error,
   * which would enqueue every 271 and 277 the account has ever seen as if it were money.
   */
  async listRemittanceArtifacts(req: RemittanceArtifactQuery): Promise<EdiResult<RemittanceArtifactPage>> {
    const call = await this.#client.pollTransactions(req.cursor, req.since, req.limit ?? 100);
    if (!call.ok || !call.body) {
      return {
        ok: false,
        error: call.error ?? { code: "unavailable", message: `${VENDOR} returned no polling body.`, retryable: true },
        ...(call.rawBody ? { raw: call.rawBody } : {}),
        source: "edi",
      };
    }

    const items = call.body.items ?? call.body.transactions ?? [];
    const artifacts = items
      .filter((t) => (t.direction ?? "").toUpperCase() === "INBOUND")
      .filter((t) => (t.x12?.transactionSetIdentifier ?? "") === "835")
      /**
       * An 835 with no `fileExecutionId` cannot be retrieved, so it is dropped from the page rather
       * than enqueued as work that can never succeed. It is not silently lost: `skipped` is reported
       * so the caller can record that Stedi described a remittance it gave us no way to fetch.
       */
      .filter((t) => Boolean(t.fileExecutionId))
      .map((t) => ({
        id: t.fileExecutionId!,
        transactionId: t.transactionId ?? null,
        processedAt: t.processedAt ?? null,
      }));

    return {
      ok: true,
      data: { artifacts, nextCursor: call.body.nextPageToken ?? null },
      source: "edi",
    };
  }

  /**
   * Retrieve one ERA's ORIGINAL X12 by its `fileExecutionId`.
   *
   * `GET /2023-08-01/executions/{id}/input` on the CORE host — the input document, i.e. the file as
   * the payer sent it, before Stedi's own translation. That distinction is the whole point: Stedi
   * also serves a JSON rendering of the same 835, and reading that instead would put a second
   * interpreter of a payer's money file into this codebase, free to disagree with Mermaid's.
   */
  async fetchRemittanceArtifact(id: string): Promise<EdiResult<string>> {
    const call = await this.#client.fetchExecutionInput(id);
    if (!call.ok || call.body === undefined) {
      return {
        ok: false,
        error: call.error ?? { code: "unavailable", message: `${VENDOR} returned no artifact body.`, retryable: true },
        source: "edi",
      };
    }
    return { ok: true, data: call.body, raw: call.body, source: "edi" };
  }

  /**
   * ── THIS SHAPE OF POLL DOES NOT EXIST; A DIFFERENT ONE DOES ───────────────────────────────────
   * An earlier note here claimed Stedi had no polling endpoint at all, on the evidence that every
   * candidate path 404'd. That conclusion was wrong, and instructively so: the probes were aimed at
   * `healthcare.us.stedi.com`, and polling lives on `core.us.stedi.com`. A 404 meant "not on this
   * host", not "not offered".
   *
   * What genuinely does not exist is THIS signature — "given these claims, return their
   * remittances". Stedi's polling is a time-ordered walk of everything processed for the account,
   * which is why ERA retrieval is `listRemittanceArtifacts` + `fetchRemittanceArtifact` above and
   * not a re-implementation of this method. Answering here would mean fetching every artifact and
   * filtering by claim, i.e. doing the ERA path badly and calling it a poll.
   */
  async fetchRemittance(_req: RemittanceRequest): Promise<EdiResult<RemittanceAdvice[]>> {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message:
          `${VENDOR} does not serve remittances on a pull endpoint — it delivers 835s to a destination ` +
          `webhook. There is nothing to poll. Ingest them at the webhook (see platform/webhook) and ` +
          `parse with parseRemittance, or use EDI_ADAPTER=mock for a self-contained cycle.`,
        retryable: false,
      },
      source: "edi",
    };
  }
}

/** X12/Stedi dates are YYYYMMDD with no separators. */
const yyyymmdd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "");
const compactDate = (iso: string): string => iso.replace(/-/g, "");

/**
 * An optional address, in the flat shape the codec's dependent loop takes. Absent stays absent —
 * `X12Dependent` treats a missing component as "not collected", and the scrubber is what refuses a
 * claim that reaches the wire without one.
 */
function addressOf(
  address: { street: string; city: string; state: string; zip: string } | undefined
): { street: string; city: string; state: string; zip: string } | Record<string, never> {
  return address ? { street: address.street, city: address.city, state: address.state, zip: address.zip } : {};
}
