/**
 * MockEdiAdapter — the dev/test EDI implementation. It synthesizes the payer's 271 with `build271`
 * and then runs it through the PRODUCTION parser `parse271`, so the exact code path a live
 * clearinghouse integration uses is exercised on every mock call. Going live means swapping the
 * synthesis step for the vendor transport — the normalized output shape does not change.
 *
 * Money crosses from dollars (wire) to integer cents (domain) HERE, at the adapter boundary.
 */
import { X12_RELATIONSHIP_CODE } from "@mermaid/shared";
import {
  categorizeAdjustment,
  cents,
  describeCarc,
  describeRarc,
  toDollars,
  type Benefits,
  type Cents,
} from "@mermaid/shared";
import type {
  ClaimAcknowledgement,
  ClaimSubmissionRequest,
  EdiAdapter,
  EligibilityRequest,
  EligibilityResponse,
  EdiResult,
  RemittanceAdjustment,
  RemittanceAdvice,
  RemittanceRequest,
  RemittanceRequestClaim,
  RemittanceArtifactPage,
  RemittanceArtifactQuery,
  EdiError,
} from "../adapter.ts";
import { build271, parse271 } from "./x12-271.ts";
import {
  ackForClaim,
  attributeLineStatuses,
  build277CA,
  build837D,
  controlNumber,
  parse277CA,
  type X12AckLineError,
} from "./x12-837.ts";
import {
  allAdjustments,
  build835,
  claimDisposition,
  MultiplePaymentsError,
  parse835,
  parse835All,
  type Build835Adjustment,
  type Build835Claim,
  type Parsed835,
} from "./x12-835.ts";
import { mockProfile } from "./profile.ts";
import { adjudicateLines, CONTRACTUAL_RATE } from "./adjudicator.ts";

/**
 * ── THE COORDINATION SCENARIO, DEFINED ONCE ────────────────────────────────────────────────────
 * A member ID ending "23" (named for CARC 23) holds a second plan. Every file the mock produces for
 * that member says so CONSISTENTLY: the 271 names the other plan under EB*R, and the 835 forwards
 * the claim (CLP02 19) to that same plan as its crossover carrier (NM1*TT), assigning any balance to
 * it under OA-23.
 *
 * It used to be one line in the 835 adjudicator: status 19 with no carrier, no 271 evidence, and on
 * fully-covered procedures no money either — so staging's R1 said "forwarded to another plan" with
 * nothing anywhere to say which, and nothing Mermaid could ever learn could explain it. A synthetic
 * signal must carry its own source data, or a demo teaches operators to ignore the real one.
 *
 * The plan is plainly synthetic by name and id, so it cannot be mistaken for a real payer.
 */
export const MOCK_OTHER_PLAN = { name: "MOCK SECONDARY DENTAL", idQualifier: "PI", id: "MOCKSEC23" } as const;
export const holdsOtherCoverage = (memberId: string): boolean => memberId.endsWith("23");

/**
 * Whether the mock adjudicates from the PLAN, or pays back what Mermaid predicted (F-0).
 *
 * ── WHY THIS IS OFF BY DEFAULT, AND WHAT TURNING IT ON COSTS ───────────────────────────────────
 * The independent adjudicator is the correct fixture and the circular one is not. But switching it
 * on does not merely change some numbers — it makes F-1 visible, because the estimator splits the
 * practice's FEE while a real payer splits the contracted ALLOWED amount. On the standard visit the
 * estimator expects $175.00 where a payer pays $157.50, and roughly a dozen assertions written
 * against the circular fixture begin reporting that gap.
 *
 * Those assertions are not wrong to fail. The gap is real and surfacing it is the entire purpose of
 * this work. But editing each one to accept the discrepancy would bake the defect into the suite,
 * and fixing it properly needs the fee-schedule model F-1 introduces — plus a contract decision
 * nobody has made yet, namely whether a denied covered service is capped at the allowed amount.
 *
 * So the oracle ships proven and unflipped. `adjudicator.test.ts` checks it against figures worked
 * out on paper, independent of anything here, and this switch is one line when F-1 is ready.
 */
const INDEPENDENT_ADJUDICATION = process.env.MOCK_INDEPENDENT_ADJUDICATION === "1";

export class MockEdiAdapter implements EdiAdapter {
  /** ERA artifacts a test or the demo has staged. Empty unless something put one here. */
  #artifacts = new Map<string, { raw: string; transactionId: string | null; processedAt: string | null; failure?: EdiError }>();

  async checkEligibility(req: EligibilityRequest): Promise<EdiResult<EligibilityResponse>> {
    if (!/^[A-Z0-9-]{6,}$/i.test(req.memberId)) {
      return {
        ok: false,
        error: { code: "invalid_member_id", message: `Member ID "${req.memberId}" is not a valid format.`, retryable: false },
        source: "mock",
      };
    }

    const today = req.serviceDate ?? new Date();
    const planName = req.planName ?? "Dental PPO";
    const profile = mockProfile(req.memberId, today);

    // Tier 1 — EDI 271 (mock transport → production parser).
    const raw = build271(
      {
        payerName: req.payerName,
        planName,
        memberId: req.memberId,
        active: profile.active,
        coveragePercentages: profile.coveragePercentages,
        deductibleAnnual: profile.deductibleAnnual,
        deductibleRemaining: profile.deductibleRemaining,
        annualMaximum: profile.annualMaximum,
        annualMaximumRemaining: profile.annualMaximumRemaining,
        // The payer echoing back whose record it answered on, so the identity cross-check (M10) has
        // real input to read rather than a field that is null by construction.
        subscriberDateOfBirth: req.patient.dateOfBirth,
        // The coordination scenario: the payer's 271 names the other plan it knows about.
        ...(holdsOtherCoverage(req.memberId) ? { otherCoverage: MOCK_OTHER_PLAN } : {}),
      },
      today
    );

    let parsed;
    try {
      // The practice's own network participation decides WHICH column of the 271 is read. It is not
      // in the 271 and cannot be inferred from it — see `NetworkParticipation`.
      parsed = parse271(raw, req.networkParticipation);
    } catch (e) {
      return {
        ok: false,
        error: { code: "parse_error", message: e instanceof Error ? e.message : String(e), retryable: false },
        raw,
        source: "mock",
      };
    }

    /**
     * Normalize to domain Benefits (money → cents). Tier 2 (portal) fields come from the profile.
     *
     * A figure the payer did not state stays NULL (M4) — see the Stedi adapter for the full note.
     * Both adapters must agree here or the mock would teach the rest of the system a shape a real
     * payer never produces, which is the failure mode the whole mock/parser split exists to avoid.
     */
    const toCents = (value: number | null): Cents | null => (value === null ? null : cents(value));
    const maxAmount = parsed.annualMaximum.amount;
    const maxRemaining = parsed.annualMaximum.remaining;
    const benefits: Benefits = {
      eligibility: parsed.eligibility,
      payerName: parsed.payerName ?? req.payerName,
      planName: parsed.planName ?? planName,
      deductible: {
        individualAnnual: toCents(parsed.deductible.annual),
        remaining: toCents(parsed.deductible.remaining),
        appliesTo: ["basic", "major"],
      },
      annualMaximum: {
        amount: toCents(maxAmount),
        // Only knowable when both halves were stated. It was `maxAmount - maxRemaining` over two
        // coalesced zeros, which could also go NEGATIVE where the Stedi adapter clamped it.
        used: maxAmount === null || maxRemaining === null ? null : cents(Math.max(0, maxAmount - maxRemaining)),
        remaining: toCents(maxRemaining),
      },
      // Absent stays absent (M17) — silence about a category is not an exclusion of it.
      coveragePercentages: { ...parsed.coveragePercentages },
      ...(Object.keys(parsed.procedureCoveragePercentages).length > 0
        ? { procedureCoveragePercentages: { ...parsed.procedureCoveragePercentages } }
        : {}),
      waitingPeriods: profile.waitingPeriods,
      frequencyLimits: profile.frequencyLimits,
      exclusions: profile.exclusions,
      excludedCodes: profile.excludedCodes,
      /**
       * Carried only when this mock plan publishes one. Absent reaches the estimate as `unknown`,
       * which is what a real 271 produces — payers state these rules in portals, not on the wire.
       */
      ...(profile.preAuthorization ? { preAuthorization: profile.preAuthorization } : {}),
      // The payer’s own coverage window, when it stated one. Carried onto the benefits so the
      // verification can compare it against the DATE OF SERVICE — "active today" and "in force on
      // the day we treated them" are different questions.
      coverage: parsed.coverage,
      // Other plans the payer named (EB*R + 2120). Evidence for a person; absent when none was sent.
      ...(parsed.otherPayers.length > 0 ? { otherPayers: parsed.otherPayers } : {}),
    };

    return {
      ok: true,
      data: {
        eligibility: parsed.eligibility,
        benefits,
        // Tier 1 (EDI) fields high-confidence; Tier 2 (portal) lower — real 271s rarely carry them.
        perFieldConfidence: {
          eligibility: 0.95,
          coveragePercentages: 0.9,
          deductible: 0.9,
          annualMaximum: 0.9,
          waitingPeriods: 0.6,
          frequencyLimits: 0.6,
          exclusions: 0.5,
        },
        // What the payer echoed about WHOSE record it answered on (M10). Compared to the
        // request by the verification pipeline; reported, never judged, here.
        subscriber: { memberId: parsed.memberId, dateOfBirth: parsed.subscriberDateOfBirth },
        // Benefit segments the precedence rules discarded, reported so a human can see them (M24).
        supersededBenefits: parsed.trace.supersededBenefits,
      },
      raw,
      source: "mock",
    };
  }

  /**
   * Submit an 837D and return the payer's 277CA acknowledgement.
   *
   * Mock adjudication is deterministic and keyed on the same member-ID conventions the eligibility
   * mock uses (see `profile.ts`), so a demo behaves consistently end to end — a member whose
   * coverage reads inactive at verification also gets rejected at submission:
   *
   *   • member ID ending "00"  → rejected, A3/33 "subscriber not found"
   *   • a line with a zero charge → rejected, A3/400 with that line itemized
   *   • otherwise               → accepted, A1/19
   *
   * As with eligibility, the payload is synthesized and then run through the PRODUCTION parser, so
   * the live code path is exercised on every mock call.
   */
  async submitClaim(req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
    if (!req.payerId) {
      return {
        ok: false,
        error: { code: "unavailable", message: "No payer id — the claim has no destination.", retryable: false },
        source: "mock",
      };
    }
    if (req.lines.length === 0) {
      return {
        ok: false,
        error: { code: "parse_error", message: "A claim must carry at least one service line.", retryable: false },
        source: "mock",
      };
    }

    const now = new Date();
    // Money crosses cents → dollars HERE, at the adapter boundary.
    const raw837 = build837D(
      {
        claimId: req.claimId,
        patientControlNumber: req.patientControlNumber,
        payerId: req.payerId,
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
        ...(req.billingProvider.phone ? { submitterContactPhone: req.billingProvider.phone } : {}),
        serviceDate: req.serviceDate,
        totalCharge: toDollars(req.totalCharge),
        lines: req.lines.map((l) => ({
          lineNumber: l.lineNumber,
          procedureCode: l.procedureCode,
          ...(l.toothNumber ? { toothNumber: l.toothNumber } : {}),
          ...(l.surfaces ? { surfaces: l.surfaces } : {}),
          quantity: l.quantity,
          chargeAmount: toDollars(l.chargeAmount),
          serviceDate: l.serviceDate,
        })),
      },
      now
    );

    // ── Deterministic mock adjudication ──
    const zeroChargeLines: X12AckLineError[] = req.lines
      .filter((l) => l.chargeAmount <= 0)
      .map((l) => ({
        lineNumber: l.lineNumber,
        procedureCode: l.procedureCode,
        code: "400",
        message: `Line ${l.lineNumber} carries no charge.`,
      }));

    let accepted = true;
    let statusCategory = "A1";
    let statusCode = "19";
    let message = "Claim received and accepted for processing.";
    let lineErrors: X12AckLineError[] = [];

    if (req.subscriber.memberId.endsWith("00")) {
      accepted = false;
      statusCategory = "A3";
      statusCode = "33";
      message = "Subscriber and subscriber id not found.";
    } else if (zeroChargeLines.length > 0) {
      accepted = false;
      statusCategory = "A3";
      statusCode = "400";
      message = "One or more service lines were returned as unprocessable.";
      lineErrors = zeroChargeLines;
    }

    const payerControlNumber = controlNumber(req.claimId + req.payerId);
    const rawAck = build277CA(
      {
        patientControlNumber: req.patientControlNumber,
        payerControlNumber,
        payerName: req.payerName,
        accepted,
        statusCategory,
        statusCode,
        message,
        totalCharge: toDollars(req.totalCharge),
        lineErrors,
      },
      now
    );

    let parsed;
    try {
      parsed = parse277CA(rawAck);
    } catch (e) {
      return {
        ok: false,
        error: { code: "parse_error", message: e instanceof Error ? e.message : String(e), retryable: false },
        raw: raw837,
        source: "mock",
      };
    }

    // The ack is read for THIS claim by name (M19), never as a single global status.
    const claimAck = ackForClaim(parsed, req.patientControlNumber);
    if (!claimAck) {
      return {
        ok: false,
        error: {
          code: "parse_error",
          message:
            `The acknowledgement reports on ${parsed.claims.length} claims and none of them is ` +
            `"${req.patientControlNumber}". This claim's outcome is UNKNOWN — it has NOT been recorded as filed.`,
          retryable: false,
        },
        raw: raw837,
        source: "mock",
      };
    }

    const { attributed, unattributed } = attributeLineStatuses(claimAck.lineStatuses, req.lines);
    const ack: ClaimAcknowledgement = {
      status: claimAck.accepted ? "accepted" : "rejected",
      controlNumber: claimAck.payerControlNumber ?? payerControlNumber,
      // Our own number as the payer echoed it. Compared to the submitted claim by ClaimService (M10).
      patientControlNumber: claimAck.patientControlNumber,
      statusCategory: claimAck.statusCategory,
      statusCode: claimAck.statusCode,
      message: claimAck.message || message,
      acknowledgedAt: now.toISOString(),
      // The payer names a procedure, not one of our line numbers, so the statuses are attributed
      // against the lines we actually submitted — and anything ambiguous is reported as such.
      lineErrors: attributed,
      unattributedLineErrors: unattributed,
    };

    // The 837 is the provenance-bearing artifact — retained (encrypted at rest), never logged.
    return { ok: true, data: ack, raw: raw837, source: "mock" };
  }

  /**
   * Synthesize the payer's 835 for the given claims, then run it through the PRODUCTION parser.
   *
   * The mock is standing in for the payer's **adjudication engine**, not just its transport, so it
   * adjudicates deterministically on the same member-ID conventions the rest of the mock uses
   * (`profile.ts`) — a demo therefore behaves consistently from eligibility all the way to payment:
   *
   *   • ends "00" → whole claim denied, CO-27 coverage terminated (matches "inactive" at eligibility)
   *   • ends "77" → the highest-charge line denied, CO-197 pre-authorization absent (RECOVERABLE)
   *   • ends "99" → benefit maximum reached, CO-119 (patient's to pay, not the payer's)
   *   • otherwise → paid as expected, less a CO-45 fee-schedule reduction; the remainder becomes
   *     PR-2 coinsurance
   *
   * Every synthesized claim balances exactly by construction (`charged = paid + adjustments`), which
   * is what lets the parser's balance assertions be a genuine test of the parser rather than of the
   * builder.
   */
  async fetchRemittance(req: RemittanceRequest): Promise<EdiResult<RemittanceAdvice[]>> {
    if (req.claims.length === 0) {
      return { ok: true, data: [], source: "mock" };
    }
    const paymentDate = req.paymentDate ?? new Date().toISOString().slice(0, 10);
    /**
     * The payment date drives the benefit profile, so an advice adjudicates against the plan as it
     * stood when the payer ruled — not as it stands whenever this happens to run.
     */
    const adjudicatedOn = new Date(`${paymentDate}T00:00:00Z`);
    const adjudicated = req.claims.map((claim) => adjudicate(claim, adjudicatedOn));
    const paymentTotal = adjudicated.reduce((sum, c) => sum + c.paid, 0);
    const traceNumber = `EFT${controlNumber(req.payerId + paymentDate + req.claims.map((c) => c.patientControlNumber).join(""))}`;

    const raw = build835({
      payerName: req.payerName,
      payeeName: req.payeeName,
      traceNumber,
      paymentTotal,
      paymentDate,
      paymentMethod: "ACH",
      claims: adjudicated,
    });

    const result = this.parseRemittance(raw);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error, raw, source: "mock" };
    }
    return { ok: true, data: [result.data], raw, source: "mock" };
  }

  /** Normalize an 835 the clinic already holds. Money is already cents from the parser. */
  parseRemittance(raw: string): EdiResult<RemittanceAdvice> {
    let parsed: Parsed835;
    try {
      parsed = parse835(raw);
    } catch (e) {
      return {
        ok: false,
        error: {
          /*
           * A file holding several payments is not a broken file, and a caller has to be able to
           * act on the difference — see `MultiplePaymentsError`. Everything else stays `parse_error`.
           */
          code: e instanceof MultiplePaymentsError ? e.code : "parse_error",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        },
        raw,
        source: "mock",
      };
    }
    return { ok: true, data: normalize(parsed), raw, source: "mock" };
  }

  /** Every 835 in the file, one advice per transaction set. Same parser, batch shape. */
  parseRemittanceAll(raw: string): EdiResult<RemittanceAdvice[]> {
    let parsed: Parsed835[];
    try {
      parsed = parse835All(raw);
    } catch (e) {
      return {
        ok: false,
        error: { code: "parse_error", message: e instanceof Error ? e.message : String(e), retryable: false },
        raw,
        source: "mock",
      };
    }
    return { ok: true, data: parsed.map(normalize), raw, source: "mock" };
  }

  /**
   * ERA artifacts the mock clearinghouse is holding.
   *
   * Seeded by `stageRemittanceArtifact`, so a test can drive the whole discovery → retrieve →
   * parse → post path with no vendor and no network. Empty by default: a mock that invented ERAs
   * nobody staged would manufacture money, which is the one thing this codebase never does.
   */
  async listRemittanceArtifacts(req: RemittanceArtifactQuery): Promise<EdiResult<RemittanceArtifactPage>> {
    const all = [...this.#artifacts.entries()].map(([id, a]) => ({
      id,
      transactionId: a.transactionId,
      processedAt: a.processedAt,
    }));
    /**
     * The cursor is an offset here — opaque to the caller, exactly as a real vendor's token is.
     *
     * An unreadable cursor is an ERROR, not an empty page. `Number("page-1")` is NaN and
     * `slice(NaN, NaN)` is `[]`, so the sloppy version of this reports "no ERAs waiting" when it
     * means "I could not understand where to resume" — and a poller would sit quietly forever
     * while money accumulated at the clearinghouse.
     */
    const from = req.cursor ? Number(req.cursor) : 0;
    if (!Number.isInteger(from) || from < 0) {
      return {
        ok: false,
        error: {
          code: "parse_error",
          message: `Unreadable ERA cursor "${req.cursor}". Refusing to report an empty page for a cursor this adapter cannot resume from.`,
          retryable: false,
        },
        source: "mock",
      };
    }
    const limit = req.limit ?? 100;
    const page = all.slice(from, from + limit);
    const next = from + page.length;
    return {
      ok: true,
      data: { artifacts: page, nextCursor: next < all.length ? String(next) : null },
      source: "mock",
    };
  }

  async fetchRemittanceArtifact(id: string): Promise<EdiResult<string>> {
    const staged = this.#artifacts.get(id);
    if (!staged) {
      return {
        ok: false,
        error: {
          code: "parse_error",
          message: `No ERA artifact with id "${id}".`,
          // Not retryable: an id the clearinghouse does not recognise will not start existing.
          retryable: false,
        },
        source: "mock",
      };
    }
    if (staged.failure) return { ok: false, error: staged.failure, source: "mock" };
    return { ok: true, data: staged.raw, raw: staged.raw, source: "mock" };
  }

  /**
   * Put an ERA where `listRemittanceArtifacts` will find it. Test/demo affordance only.
   *
   * `failure` stages a RETRIEVAL failure for that id — the 4xx/5xx/timeout cases, which cannot be
   * provoked any other way without a live vendor.
   */
  stageRemittanceArtifact(
    id: string,
    raw: string,
    meta: { transactionId?: string | null; processedAt?: string | null; failure?: EdiError } = {}
  ): void {
    this.#artifacts.set(id, {
      raw,
      transactionId: meta.transactionId ?? null,
      processedAt: meta.processedAt ?? null,
      ...(meta.failure ? { failure: meta.failure } : {}),
    });
  }
}

// ── 835 normalization (parsed X12 → the shape modules consume) ────────────────────────

const describeAdjustment = (a: { group: string; code: string; amount: Cents; procedureCode: string | null }): RemittanceAdjustment => ({
  group: a.group,
  code: a.code,
  description: describeCarc(a.code),
  category: categorizeAdjustment(a.group, a.code),
  amount: a.amount,
  procedureCode: a.procedureCode,
});

const describeRemarks = (codes: string[]) => codes.map((code) => ({ code, description: describeRarc(code) }));

function normalize(parsed: Parsed835): RemittanceAdvice {
  return {
    traceNumber: parsed.trace?.number ?? "",
    payerName: parsed.payerName,
    payeeName: parsed.payeeName,
    payeeId: parsed.payeeId,
    payeeIdQualifier: parsed.payeeIdQualifier,
    paymentTotal: parsed.payment?.total ?? (0 as Cents),
    paymentMethod: parsed.payment?.method ?? "",
    paymentDate: formatD8(parsed.payment?.date ?? ""),
    providerAdjustments: parsed.providerAdjustments,
    balanced: parsed.balanced,
    issues: parsed.issues,
    usageIndicator: parsed.usageIndicator,
    claims: parsed.claims.map((claim) => ({
      patientControlNumber: claim.patientControlNumber,
      payerControlNumber: claim.payerControlNumber,
      statusCode: claim.statusCode,
      disposition: claimDisposition(claim),
      charged: claim.charged,
      paid: claim.paid,
      patientResponsibility: claim.patientResponsibility,
      patientName: claim.patientName,
      memberId: claim.memberId,
      unbalanced: claim.unbalanced,
      remarks: describeRemarks(claim.remarks),
      ...(claim.crossoverCarrier ? { crossoverCarrier: claim.crossoverCarrier } : {}),
      adjustments: allAdjustments(claim).map(describeAdjustment),
      lines: claim.lines.map((line) => ({
        procedureCode: line.procedureCode,
        charged: line.charged,
        paid: line.paid,
        quantity: line.quantity,
        adjustments: line.adjustments.map(describeAdjustment),
        remarks: describeRemarks(line.remarks),
      })),
    })),
  };
}

/**
 * X12 D8 ("20260727") → ISO ("2026-07-27"), or "" when it is not a real calendar day.
 *
 * It passed anything else through. `remittances.payment_date` is a DATE column, so a payer's
 * impossible BPR16 (a public sample carries `20002316`, month 23) or a non-D8 value would have failed
 * the INSERT and taken the whole ERA's ingest with it. Undated is stored as NULL instead — the money
 * is still read and the advice still held for a person, who sees no date. Deliberately NOT an `issue`:
 * issues mean the arithmetic failed, and the safety gate refuses to release that at all.
 */
const formatD8 = (d8Value: string): string => {
  if (!/^\d{8}$/.test(d8Value)) return "";
  const [y, m, d] = [Number(d8Value.slice(0, 4)), Number(d8Value.slice(4, 6)), Number(d8Value.slice(6, 8))];
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) return "";
  return `${d8Value.slice(0, 4)}-${d8Value.slice(4, 6)}-${d8Value.slice(6, 8)}`;
};

// ── Deterministic mock adjudication ───────────────────────────────────────────────────

function adjudicate(claim: RemittanceRequestClaim, today: Date): Build835Claim {
  const totalCharged = claim.lines.reduce((sum, l) => sum + l.charged, 0);

  /**
   * ── WHAT THE PAYER DECIDES, WORKED OUT FROM THE PLAN (F-0) ───────────────────────────────────
   *
   * This used to be `round(claim.expectedInsurancePays × line.charged / totalCharged)` — the mock
   * paid back whatever Mermaid predicted. Variance was therefore ≈0 by construction, and the one
   * thing the variance engine exists to detect could never occur in a fixture. A green staging run
   * was evidence of nothing.
   *
   * It now adjudicates from the member's own benefits and the contracted fee schedule, knowing
   * nothing about anyone's expectation. If the estimator is wrong, the variance is real.
   */
  const adjudicated = adjudicateLines(claim.lines, mockProfile(claim.memberId, today));
  const terminated = claim.memberId.endsWith("00");
  const preAuthMissing = claim.memberId.endsWith("77");
  const maxReached = claim.memberId.endsWith("99");
  /**
   * ── ends "23" → COORDINATION OF BENEFITS (M8) ────────────────────────────────────────────────
   *
   * Named for the CARC it emits. The payer pays its share, writes off its contractual reduction, and
   * assigns the remainder to ANOTHER plan's adjudication under `OA-23` — the ordinary shape of a
   * primary's advice when the patient holds two policies. CLP02 is `19` (forwarded to another
   * payer), which is the payer stating the same fact a second way.
   *
   * The mock has to be able to produce this or `coordination` is a category no test can prove comes
   * off real parsed input: the same trap the coverage-date defect sat in for a whole milestone, where
   * a field that was always empty and a payer that never said it were indistinguishable.
   */
  const coordinated = holdsOtherCoverage(claim.memberId);

  // The single highest-charge line is the one a payer picks a fight over.
  const majorLineIndex = claim.lines.reduce(
    (best, line, i) => (line.charged > (claim.lines[best]?.charged ?? 0) ? i : best),
    0
  );

  const lines = claim.lines.map((line, index) => {
    const adjustments: Build835Adjustment[] = [];
    const push = (group: string, code: string, amountCents: number) => {
      if (amountCents > 0) {
        adjustments.push({ group, code, amount: toDollars(amountCents as Cents), procedureCode: line.procedureCode });
      }
    };

    if (terminated) {
      /**
       * Nothing is payable: the entire charge comes back as a coverage-termination adjustment,
       * under **PR** because the patient is the one who owes it.
       *
       * This emitted CO-27. Under a contractual obligation the PROVIDER absorbs the amount and may
       * not bill the patient — which is what a payer means when it decides the practice should have
       * checked eligibility. That is a real scenario, but it is the opposite of the one this fixture
       * is named for, and it left the generated claim reporting $0.00 on CLP05 while its CAS
       * segments described the entire charge as the patient's.
       */
      push("PR", "27", line.charged);
      return { procedureCode: line.procedureCode, charged: toDollars(line.charged), paid: 0, quantity: line.quantity, adjustments };
    }

    const decision = adjudicated[index]!;
    const contractual = decision.contractual;
    const allowed = decision.allowed;

    if (preAuthMissing && index === majorLineIndex) {
      push("CO", "45", contractual);
      push("CO", "197", allowed);
      return { procedureCode: line.procedureCode, charged: toDollars(line.charged), paid: 0, quantity: line.quantity, adjustments };
    }

    /**
     * The payer's own decision when the independent adjudicator is on; otherwise the legacy
     * proportional share of what the practice expected — which is the circularity F-0 removes.
     */
    const legacyShare =
      totalCharged > 0 ? Math.round((claim.expectedInsurancePays * line.charged) / totalCharged) : 0;
    const legacyTarget = maxReached ? Math.round(legacyShare * 0.4) : legacyShare;
    const paid = INDEPENDENT_ADJUDICATION ? decision.paid : Math.max(0, Math.min(legacyTarget, allowed));
    const shortfall = allowed - paid;

    if (coordinated) {
      /**
       * The primary pays its share, writes off its contractual reduction, and hands the remainder
       * to the OTHER plan under `OA-23` rather than to the patient. That distinction is the whole
       * point of the fixture: an ordinary claim would emit `PR-2` here, and a system that cannot
       * tell the two apart bills the patient a secondary payer's share.
       *
       * Balances exactly by construction — charged = paid + CO-45 + OA-23 — so the parser's balance
       * assertions remain a genuine test of the parser rather than of this builder.
       */
      push("CO", "45", contractual);
      push("OA", "23", shortfall);
      return {
        procedureCode: line.procedureCode,
        charged: toDollars(line.charged),
        paid: toDollars(paid as Cents),
        quantity: line.quantity,
        adjustments,
      };
    }

    push("CO", "45", contractual);
    /**
     * An exhausted annual maximum is the PATIENT's money, and a payer says so with **PR**-119.
     *
     * This emitted CO-119, which is a materially different statement: under a contractual
     * obligation the provider absorbs the amount and may not bill the patient. The fixture was
     * therefore teaching the rest of the system a scenario that does not occur — and because
     * CLP05 sums only PR adjustments, the generated claim also reported $0.00 of patient
     * responsibility while its own CAS segments described $1,234.51 of it. Every consumer
     * downstream inherited that contradiction from here.
     */
    /**
     * Driven by what the adjudication actually did, not by the member-id lever. A line the annual
     * maximum truncated is PR-119; an ordinary coinsurance balance is PR-2. Reading the lever
     * instead would label every line on a near-max member as benefit-exhausted, including ones the
     * cap never touched.
     */
    const cappedByMaximum = INDEPENDENT_ADJUDICATION ? decision.reason === "annual-maximum" : maxReached;
    if (cappedByMaximum) push("PR", "119", shortfall);
    else push("PR", "2", shortfall);

    return { procedureCode: line.procedureCode, charged: toDollars(line.charged), paid: toDollars(paid as Cents), quantity: line.quantity, adjustments };
  });

  const paidTotal = lines.reduce((sum, l) => sum + Math.round(l.paid * 100), 0);
  const patientResponsibility = lines
    .flatMap((l) => l.adjustments ?? [])
    .filter((a) => a.group === "PR")
    .reduce((sum, a) => sum + Math.round(a.amount * 100), 0);

  return {
    patientControlNumber: claim.patientControlNumber,
    payerControlNumber: claim.payerControlNumber,
    // CLP02: 4 = denied, 1 = processed as primary, 19 = forwarded to another payer (M8).
    statusCode: coordinated ? "19" : paidTotal === 0 ? "4" : "1",
    // A payer that forwards a claim says to WHOM — the same plan its 271 named. Never a bare 19.
    ...(coordinated ? { crossoverCarrier: MOCK_OTHER_PLAN } : {}),
    charged: toDollars(totalCharged as Cents),
    paid: toDollars(paidTotal as Cents),
    patientResponsibility: toDollars(patientResponsibility as Cents),
    patientFirstName: claim.patientFirstName,
    patientLastName: claim.patientLastName,
    memberId: claim.memberId,
    lines,
    remarks: preAuthMissing ? ["N54"] : terminated ? ["N130"] : [],
  };
}

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
