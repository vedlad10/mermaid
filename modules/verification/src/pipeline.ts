/**
 * End-to-end verification pipeline (pure orchestration — persistence happens in the service/API
 * layer with the DB). Ported from Dental Verify's `pipeline.ts`; the donor's connector layer is
 * replaced by payer identification + the injected EDI adapter (swappable vendor), and money is cents.
 *
 *   card text → interpret → validate patient → identify payer → EDI eligibility → coverage estimate
 *   → exception detection → confidence aggregation → review routing → report
 *
 * The EDI adapter is INJECTED (not imported concretely) so this stays testable and the vendor stays
 * swappable. Deterministic throughout — no AI decides here; AI (OCR/extraction) only proposes fields
 * that flow through the same confidence + human-review gate.
 */
import { randomUUID } from "node:crypto";
import { calculateCoverage } from "./engine/estimate.ts";
import { interpretCardText, cardConfidence } from "./engine/ocr.ts";
import { NoCardReader, type CardReader } from "./engine/card-vision.ts";
import {
  BUILTIN_PAYERS,
  identifyPayer,
  participationFor,
  type NetworkParticipation,
  type PayerDirectory,
} from "./engine/payer.ts";
import { aggregateConfidence, detectExceptions, routeForReview, statusFor, validatePatient } from "./engine/analysis.ts";
import { generateReport } from "./engine/report.ts";
import type { EdiAdapter } from "@mermaid/edi";
import type { LlmImage } from "@mermaid/llm";
import { calendarDay, formatUsd, type FeeSchedule, type TreatmentPlanItem } from "@mermaid/shared";
import {
  NoPayerHistory,
  type AuditEvent,
  type ConfidenceComponent,
  type PatientInfo,
  type PayerAccuracyProvider,
  type VerificationRecord,
} from "./types.ts";

export interface VerificationInput {
  patient: PatientInfo;
  /** Raw insurance-card text (typed or pasted). Always accepted; the fallback when there is no photo. */
  cardText: string;
  /**
   * Photographs of the card (workflow S2). When present AND a card reader is wired, the images are
   * read first and their transcription becomes `cardText`. Optional everywhere: text entry is a
   * first-class path, not a degraded one.
   */
  cardImages?: LlmImage[];
  planItems: TreatmentPlanItem[];
}

/**
 * Fold a member ID for COMPARISON only — never for what goes on the wire.
 *
 * Payers and cards print the same identifier with and without hyphens and in either case, and a
 * mismatch flag that fires on `ABC-123` versus `abc123` is a flag staff learn to ignore. The same
 * folding `detectExceptions` already uses for the card-versus-entered check.
 */
const normalizeMemberId = (value: string): string => value.replace(/[\s-]/g, "").toUpperCase();

export async function runVerification(
  input: VerificationInput,
  adapter: EdiAdapter,
  now: Date = new Date(),
  payerHistory: PayerAccuracyProvider = NoPayerHistory,
  /**
   * Optional AI card reader. `NoCardReader` — the default — means photographs are ignored and the
   * pipeline behaves exactly as it did before S2 existed.
   */
  cardReader: CardReader = NoCardReader,
  /**
   * V3 — this practice's participation in each payer's network, keyed by Mermaid's payer slug.
   *
   * Empty by default, which means every payer resolves to `unknown` and the 271 is read exactly as
   * it was before this parameter existed. Passed in rather than read from config here so the
   * pipeline stays a pure function of its inputs, and so a test can state a participation without
   * needing an environment.
   */
  participation: Map<string, NetworkParticipation> = new Map(),
  /**
   * The practice's IANA timezone — the zone "today" is computed in for the coverage-window check.
   *
   * A date of service is a calendar day in the room where the patient sits, not the UTC day
   * (packages/shared/src/calendar.ts). Deriving it from `now.toISOString()` meant a US Pacific
   * practice from late afternoon onward compared the payer's stated window against TOMORROW's date:
   * a plan whose termination date is today read as already ended, and the visit was flagged
   * `coverage-terminated` while the patient was still covered. East of UTC the error inverts and a
   * genuinely ended plan read as in force. Defaults to UTC so existing callers are unchanged.
   */
  timeZone = "UTC",
  /**
   * The payer catalog to match this card against (NEW-08).
   *
   * A PARAMETER, not a read: the pipeline is deterministic by design — the suite asserts that two
   * identical clinics produce identical claims — and a step that queried a database mid-run would
   * make that untestable without one and unreproducible whenever the catalog changed between runs.
   * The caller reads the catalog once, at the edge, and passes it.
   *
   * Defaults to the built-in seven, which is what the database-free demo has and what every test
   * that is about something else wants.
   */
  payers: PayerDirectory = BUILTIN_PAYERS,
  /**
   * What each payer has been observed to allow, per procedure code, per unit (F-1).
   *
   * A PARAMETER for the same reason `payers` is one: this pipeline is deterministic by contract —
   * the suite asserts two identical clinics produce identical claims — and a database read placed
   * mid-run would make that untestable without a database and unreproducible whenever a remittance
   * arrived between runs. The caller reads the practice's schedule once, at the edge.
   *
   * Keyed by payer because the schedule is only meaningful against the payer that stated it, and the
   * payer is not known until the card has been read a few steps below.
   *
   * Empty by default. An empty schedule prices every line off the billed fee, which is exactly what
   * happened before this parameter existed — so a practice with no remittance history yet is quoted
   * precisely as it always was.
   */
  feeSchedule: FeeSchedule = new Map()
): Promise<VerificationRecord> {
  const audit: AuditEvent[] = [];
  const log = (message: string) => audit.push({ timestamp: new Date().toISOString(), actor: "system", message });

  log("Verification started.");

  /**
   * 1. Card interpretation (workflow S2).
   *
   * The photograph path and the text path converge here on ONE `InsuranceCardData`, which is why
   * everything downstream — payer identification, exception detection, confidence aggregation,
   * review routing — is untouched by this feature. AI changed how the card is read; it changed
   * nothing about what happens to what was read.
   *
   * A failed or unavailable read is not an error. It falls through to the typed text, which is the
   * path a practice used before there was a camera, and the verification proceeds normally.
   */
  const vision = input.cardImages?.length ? await cardReader.read(input.cardImages).catch(() => null) : null;
  const cardText = vision ? vision.transcription : input.cardText;
  const card = vision ? vision.card : interpretCardText(cardText);
  const ocrScore = cardConfidence(card);

  if (vision) {
    log(`Card read from ${input.cardImages!.length} image(s) by ${vision.provider}${vision.model ? `/${vision.model}` : ""}, cross-checked against the transcribed text.`);
    // The side-by-side reading lands in the audit trail, so a reviewer opening this record later
    // sees why a field scored what it did without having to re-run anything.
    for (const line of vision.crossCheck) log(`  ${line}`);
  } else if (input.cardImages?.length) {
    log("Card images were supplied but no card reader is available; the typed card text was used instead.");
  }
  log(`Card interpreted (payer: ${card.payerName.value ?? "unknown"}, member ID: ${card.memberId.value ?? "unknown"}).`);

  // 2. Patient validation.
  const validationFlags = validatePatient(input.patient);
  if (validationFlags.length > 0) log(`Patient validation raised ${validationFlags.length} flag(s).`);

  // 3. Payer identification, against the catalog this deployment actually holds.
  const payer = identifyPayer(card.payerName.value, payers);
  log(payer.explanation);

  /**
   * 4. Eligibility via the EDI adapter (mock transport → production 271 parser).
   *
   * ── WHICH MEMBER ID GOES TO THE PAYER (M10) ──────────────────────────────────────────────────
   * This was `card.memberId.value ?? input.patient.memberId` — the card reading always won. In the
   * TEXT path that is fine: the card text was typed or pasted by staff, so both candidates are
   * human-entered and the card is simply the more specific field.
   *
   * The PHOTOGRAPH path is different. There the card reading is a model's transcription, and letting
   * it silently overrule a human's typing inverts the rule the whole AI layer is built on: a model
   * may PROPOSE a field, it may not DECIDE one. A single misread digit becomes the identifier the
   * eligibility check is made under, the estimate is built from, and the claim is filed with — and
   * the existing `member-id-mismatch` flag is a WARNING, which is averaged into a confidence score
   * and does not stop anything.
   *
   * So when a vision reading disagrees with what a person typed, the PERSON's value is used and the
   * disagreement is raised as critical below. Nobody's guess is discarded — both are on the record,
   * and a human decides — but the value that reaches the payer is the one someone is accountable for.
   */
  const visionContradictsTyped =
    vision !== null &&
    Boolean(card.memberId.value) &&
    Boolean(input.patient.memberId) &&
    normalizeMemberId(card.memberId.value!) !== normalizeMemberId(input.patient.memberId);

  if (visionContradictsTyped) {
    log(
      `The card photograph reads member ID ${card.memberId.value}, which disagrees with the ` +
        `${input.patient.memberId} that was typed. Using the typed value for the payer check — a card ` +
        `reading may propose an identifier, never replace one.`
    );
  }

  const memberId = visionContradictsTyped
    ? input.patient.memberId
    : (card.memberId.value ?? input.patient.memberId);
  const result = payer.value
    ? await adapter.checkEligibility({
        payerId: payer.value.payerId,
        // Carried so a real clearinghouse can address the payer in its own namespace. The mock
        // ignores it; Mermaid's slug stays the key for the playbook and the payer scorecard.
        ...(payer.value.clearinghouseId ? { clearinghouseId: payer.value.clearinghouseId } : {}),
        payerName: payer.value.payerName,
        // Which column of the 271 to read. `unknown` unless this practice has stated otherwise —
        // see `participationFor`. The payer's response cannot answer this; only the contract can.
        networkParticipation: participationFor(payer.value.payerId, participation),
        memberId,
        patient: { firstName: input.patient.firstName, lastName: input.patient.lastName, dateOfBirth: input.patient.dateOfBirth },
        serviceDate: now,
      })
    : null;
  const benefits = result?.ok ? result.data!.benefits : null;
  const perField = result?.ok ? result.data!.perFieldConfidence : null;
  const benefitsConfidence = perField
    ? Math.round((Object.values(perField).reduce((a, b) => a + b, 0) / Object.values(perField).length) * 100) / 100
    : result?.error
      ? 0.1
      : 0;
  const benefitsExplanation = result
    ? result.ok
      ? `Eligibility ${result.data!.eligibility} via ${result.source} transport (production 271 parser).`
      : (result.error?.message ?? "Eligibility check failed.")
    : "No connector available for this payer.";
  if (result) log(benefitsExplanation);

  // 5. Coverage estimate.
  /**
   * The contracted rates for THIS payer, or none. Resolved here rather than earlier because the
   * payer is only known once the card has been read, and a rate filed under one payer says nothing
   * about another.
   */
  const contracted = payer.value?.payerId ? (feeSchedule.get(payer.value.payerId) ?? null) : null;
  const calculation = benefits
    ? calculateCoverage(input.planItems, benefits, now, timeZone, (code) => contracted?.get(code) ?? null)
    : null;
  if (calculation) {
    log(
      `Coverage calculated: patient responsibility ${formatUsd(calculation.totalPatientPays)} of ${formatUsd(calculation.totalFee)} total.`
    );
    /**
     * Said out loud in the audit trail, because it is the difference between the old quote and the
     * new one and a patient may ask why the number changed. Silence here would make a corrected
     * estimate look like an arbitrary one.
     */
    if (calculation.totalContractualWriteOff > 0) {
      log(
        `${formatUsd(calculation.totalContractualWriteOff)} of the billed fees is written off by ` +
          `contract with this payer and is not billable to the patient — priced against the ` +
          `contracted allowance rather than the practice fee schedule.`
      );
    }
  }

  // 6. Exception detection.
  /**
   * `result` is non-null exactly when a request was ADDRESSED to a payer — the ternary above only
   * calls the adapter when `payer.value` resolved. So its presence is the honest answer to "was this
   * payer reached", and `benefitsExplanation` already holds either the payer's refusal or the
   * transport's, which is the sentence a coordinator needs. See `benefits-unavailable` in types.ts.
   */
  const exceptions = [
    ...validationFlags,
    ...detectExceptions(card, input.patient, benefits, calculation, calendarDay(now, timeZone), {
      reached: result !== null,
      ...(result !== null ? { reason: benefitsExplanation } : {}),
    }),
  ];
  /**
   * Two readers disagreeing about the payer or the member ID stops the card here, whatever the
   * arithmetic says.
   *
   * Raised as an exception rather than left to the confidence score because the score is averaged
   * across four components: one contested member ID against three healthy signals still cleared the
   * auto-verify threshold, and the wrong identifier would have gone to the payer unreviewed. A
   * question only the person holding the card can answer is not a weak signal to be averaged away.
   */
  for (const message of vision?.contested ?? []) {
    exceptions.push({ severity: "critical", code: "card-reading-contested", message });
  }

  /**
   * A model's reading of the card disagreeing with a human's typing is CRITICAL, not a warning.
   *
   * `detectExceptions` already raises `member-id-mismatch` for card-versus-entered, at warning
   * severity. That is right for the text path, where both values came from a person. It is not
   * enough when one of them came from a model: a warning is averaged into the confidence score, and
   * one contested identifier against three healthy signals still clears the auto-verify threshold —
   * exactly the reasoning `card-reading-contested` already exists for, applied to the case where the
   * two readers are the model and the front desk rather than two models.
   */
  if (visionContradictsTyped) {
    exceptions.push({
      severity: "critical",
      code: "card-reading-contested",
      message:
        `The card photograph was read as member ID ${card.memberId.value}, but ${input.patient.memberId} ` +
        `was typed. The typed value was used for the payer check. Confirm which is correct against the ` +
        `physical card before this estimate is quoted or a claim is filed.`,
    });
  }

  /**
   * ── DID THE PAYER ANSWER ABOUT THE PERSON WE ASKED ABOUT? (M10) ──────────────────────────────
   *
   * Nothing ever checked. A 271 echoes the subscriber it resolved, and a member ID that is wrong in
   * a way that still resolves — a transposed digit belonging to somebody else, a misread card —
   * comes back as a perfectly healthy response for the WRONG PERSON: their deductible, their
   * remaining maximum, their plan. The patient in the chair is quoted from it and the claim filed
   * under it.
   *
   * Both comparisons are skipped when the payer did not echo the field, which is legal and common.
   * Silence is not a mismatch — the same rule as everywhere else in this codebase.
   */
  const echoed = result?.ok ? result.data!.subscriber : null;
  if (echoed?.memberId && normalizeMemberId(echoed.memberId) !== normalizeMemberId(memberId)) {
    exceptions.push({
      severity: "critical",
      code: "subscriber-mismatch",
      message:
        `The payer answered about member ID ${echoed.memberId}, but ${memberId} was requested. These ` +
        `benefits may belong to a different person. Do not quote or file until the identifier is confirmed.`,
    });
  }
  if (echoed?.dateOfBirth && echoed.dateOfBirth !== input.patient.dateOfBirth) {
    exceptions.push({
      severity: "critical",
      code: "subscriber-mismatch",
      message:
        `The payer's record for this member has date of birth ${echoed.dateOfBirth}, but ` +
        `${input.patient.dateOfBirth} was entered. Either the identifier resolves to a different person ` +
        `or the date of birth is wrong; both are the practice's to resolve before filing.`,
    });
  }
  if (ocrScore < 0.6) {
    exceptions.push({ severity: "warning", code: "low-ocr-confidence", message: "Card fields were extracted with low confidence; double-check them." });
  }

  // 7. Confidence aggregation.
  const components: ConfidenceComponent[] = [
    { name: "Card extraction", confidence: ocrScore, explanation: "Weighted confidence of payer name and member ID extraction." },
    { name: "Payer identification", confidence: payer.confidence, explanation: payer.explanation },
    { name: "Benefits retrieval", confidence: benefitsConfidence, explanation: benefitsExplanation },
    {
      name: "Patient data",
      confidence: validationFlags.length === 0 ? 1 : 0.4,
      explanation: validationFlags.length === 0 ? "All patient fields passed validation." : validationFlags.map((f) => f.message).join(" "),
    },
  ];

  // The learning loop reaching the front half: what this payer's own appeal outcomes say about how
  // reliable its decisions are (unified RCM workflow `S -.sharpens.-> D`; roadmap §5, §7.3).
  //
  // Appended ONLY when the payer has enough recorded outcomes to mean something. Adding a neutral
  // component for an unknown payer would not be neutral at all: the overall score is an average, so
  // a 1.0 for "we know nothing" would lift every verification of every unfamiliar payer above where
  // it sits today. Ignorance must cost nothing and buy nothing.
  const trackRecord = await payerHistory.forPayer(payer.value?.payerId ?? null);
  if (trackRecord.confidence !== null) {
    components.push({
      name: "Payer track record",
      confidence: trackRecord.confidence,
      explanation: trackRecord.explanation,
    });
    log(`Payer track record applied: ${trackRecord.explanation}`);
  }

  const confidence = aggregateConfidence(components);

  // 8. Review routing → status.
  const routing = routeForReview(confidence, exceptions);
  log(`Review routing: ${routing.reason}`);
  const status: VerificationRecord["status"] = statusFor(Boolean(benefits), routing.needsReview);

  const record: Omit<VerificationRecord, "reportText"> = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    status,
    patient: input.patient,
    card,
    planItems: input.planItems,
    benefits,
    calculation,
    exceptions,
    confidence,
    review: null,
    audit,
    dataSource: result?.source ?? "mock",
    payerId: payer.value?.payerId ?? null,
    raw271: result?.raw ?? null,
    // Null rather than 0 when no adapter answered: "never counted" and "counted, found none" are
    // different facts, and the provenance read model distinguishes them (M24).
    supersededBenefits: result?.ok ? result.data!.supersededBenefits : null,
    // The text the card data was actually derived from — the model's transcription when a photo was
    // read, the typed text otherwise. It must be the one the record was built from, or the stored
    // provenance would describe a reading that never happened.
    cardText,
  };

  // 9. Report generation.
  const reportText = generateReport(record);
  log("Report generated.");

  return { ...record, reportText };
}
