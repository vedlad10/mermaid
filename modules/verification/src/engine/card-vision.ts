/**
 * AI insurance-card reading (workflow S2: photograph card → AI VISION OCR → confidence + payer match
 * → low-confidence human confirm; journey n2: "reads: Delta Dental, ID ABC12345 (92% confidence)").
 *
 * ── WHAT THIS REPLACES, AND WHAT IT DOES NOT ───────────────────────────────────────────────────
 * `ocr.ts` interprets card TEXT with regexes. It stays exactly as it is, for two reasons: staff
 * typing or pasting card details is a first-class input path and always will be, and — more usefully
 * — it becomes the CROSS-CHECK for what the model claims to have read (see below).
 *
 * What this adds is the missing front end: a photograph. Until now a practice could not point a
 * camera at a card, which is the single most common way card data actually enters a dental office.
 *
 * ── NO SECOND PAYER-MATCHING ENGINE ────────────────────────────────────────────────────────────
 * The model reads the payer NAME off the card as a string, and that is all it does with it.
 * Resolving that string to a payer id, a connector and a confidence remains `identifyPayer` — the
 * one registry, unchanged, downstream in the pipeline. A model that "identified the payer" would be
 * a second registry that disagrees with the first about which connector to call, and the way that
 * failure presents is an eligibility request sent to the wrong payer.
 *
 * ── WHERE CONFIDENCE COMES FROM, AND WHY NOT FROM THE MODEL ────────────────────────────────────
 * The router deliberately never asks a model how confident it is: a self-reported 0.95 correlates
 * with how confident the sentence SOUNDS, not with how often it is right, and this number decides
 * whether a human looks at the card before a member ID goes to a payer. A miscalibrated one is a
 * wrong claim filed unreviewed.
 *
 * So confidence here is earned from evidence the model does not have:
 *
 *   • the model also returns a verbatim transcription of the card, and `interpretCardText` — the
 *     existing regex engine — is run over that transcript. Where the two agree, the model's
 *     structured answer matches its own reading of the card, and confidence is high. Where they
 *     disagree, it drops sharply and the case routes to a human through the gate that already
 *     exists.
 *
 *     This is a self-consistency check, NOT a second opinion, and the difference bounds what it can
 *     buy: both readings descend from one act of reading the image, so it catches a value assigned
 *     to the wrong FIELD — a common failure — and cannot catch a misread CHARACTER. It was described
 *     as "two unrelated methods", which overstated it in the one place a reviewer would rely on.
 *   • a payer name that matches the registry is worth more than one that does not.
 *   • a member ID is checked for structural plausibility, not just presence.
 *
 * Disagreement lowering confidence rather than picking a winner is the important half. Two readers
 * disagreeing about a member ID is precisely the case where a person should look, and silently
 * preferring either one would throw away the only signal that says so.
 *
 * ── PHI ────────────────────────────────────────────────────────────────────────────────────────
 * Unlike appeal drafting and denial explanation, this feature genuinely CANNOT be made PHI-free: an
 * insurance card carries a member ID and usually a name, and the image is the input. So it declares
 * `containsPhi: true` and is refused outright until `LLM_PHI_APPROVED=1` — which must not be set
 * until a BAA covers the configured endpoint. Until then, typed card text is the path, exactly as it
 * was before this file existed.
 */
import { schema, type LlmAdapter, type LlmImage, type ObjectSchema } from "@mermaid/llm";
import { cardConfidence, interpretCardText } from "./ocr.ts";
import { identifyPayer } from "./payer.ts";
import type { ExtractedField, InsuranceCardData } from "../types.ts";

/** What the model is asked to return. Flat, named exactly as the validator checks them. */
interface CardFields {
  payerName: string | null;
  memberId: string | null;
  groupNumber: string | null;
  planName: string | null;
  subscriberName: string | null;
  effectiveDate: string | null;
  /** Everything legible on the card, so the regex engine has a transcript to re-read. */
  transcription: string;
}

const CARD_SCHEMA: ObjectSchema<CardFields> = schema<CardFields>({
  payerName: { kind: "string", nullable: true, maxLength: 80 },
  memberId: { kind: "string", nullable: true, maxLength: 40 },
  groupNumber: { kind: "string", nullable: true, maxLength: 40 },
  planName: { kind: "string", nullable: true, maxLength: 80 },
  subscriberName: { kind: "string", nullable: true, maxLength: 80 },
  effectiveDate: { kind: "string", nullable: true, maxLength: 10 },
  transcription: { kind: "string", maxLength: 2_000 },
});

const SYSTEM = [
  "You read dental insurance cards from photographs and return what is printed on them.",
  "",
  "Rules:",
  "- Transcribe only. Never infer, complete, correct or normalise a value. If a member ID is partly",
  "  obscured, return what is legible; do not guess the rest.",
  "- Use null for any field that is not printed on the card or that you cannot read confidently.",
  "  A null is far more useful than a plausible guess: a null sends the card to a human, and a",
  "  wrong member ID is filed to a payer.",
  "- payerName: the insurance company's name as printed. Do not expand abbreviations, do not add",
  "  'Dental', and do not map it to a company you think it resembles.",
  "- effectiveDate: ISO YYYY-MM-DD, or null.",
  "- transcription: every line of text visible on the card, in reading order, newline-separated.",
  "",
  "If the image is not an insurance card, return null for every field and describe what it is in",
  "the transcription.",
].join("\n");

export interface CardReadResult {
  card: InsuranceCardData;
  /** The model's verbatim transcription — becomes the record's `cardText`, so provenance is intact. */
  transcription: string;
  provider: string;
  model: string | null;
  /** Each field's evidence, shown next to the value so a human can see WHY it scored what it did. */
  crossCheck: string[];
  /**
   * Critical fields the two readers disagreed about, in plain English.
   *
   * Surfaced separately from the confidence score because the score alone was not enough: it is
   * averaged with three other components, and one contested member ID against three healthy signals
   * still cleared the auto-verify threshold. The pipeline raises these as CRITICAL exceptions, which
   * route to a human regardless of any average. See `ExceptionFlag["card-reading-contested"]`.
   */
  contested: string[];
}

/** The port the pipeline depends on. `NoCardReader` always declines — the default everywhere. */
export interface CardReader {
  read(images: LlmImage[]): Promise<CardReadResult | null>;
  /**
   * Whether a reader is wired at all, as opposed to wired and unable to read this particular card.
   *
   * The two are the same `null` to the pipeline and must NOT be the same to a person at a front
   * desk. "This deployment cannot read photographs — type the card in" is a permanent fact they need
   * once; "I could not read THIS photograph — retake it or type it in" is about the photo in their
   * hand. Collapsing them produces the failure this whole change exists to fix: a card that uploads,
   * shows a thumbnail, and then silently does nothing at all.
   */
  available(): boolean;
}

export const NoCardReader: CardReader = {
  async read(): Promise<CardReadResult | null> {
    return null;
  },
  available(): boolean {
    return false;
  },
};

export function createCardReader(llm: LlmAdapter): CardReader {
  return {
    available(): boolean {
      return llm.available();
    },
    async read(images: LlmImage[]): Promise<CardReadResult | null> {
      if (images.length === 0) return null;

      const result = await llm.extract({
        operation: "card_extraction",
        system: SYSTEM,
        prompt: "Read this insurance card.",
        images,
        schema: CARD_SCHEMA,
        // An insurance card is PHI. This one really does wait for the BAA.
        containsPhi: true,
      });
      if (!result.ok || !result.data) return null;

      const fields = result.data.value;
      const transcription = fields.transcription.trim();
      /**
       * The second reader: the existing regex engine, over the model's own transcript.
       *
       * ── WHAT THIS CROSS-CHECK CAN AND CANNOT CATCH ────────────────────────────────────────────
       * It is NOT independent of the model, and describing it that way overstates it. Both readings
       * descend from one act of reading the image: the structured fields are the model's answer, and
       * the transcript the regex works on is also the model's answer.
       *
       * So it catches the model assigning a value to the wrong FIELD — reading the group number into
       * the member ID slot, or a payer's phone number as an identifier — which is a real and common
       * failure and worth catching. It cannot catch a misread CHARACTER: if the model transcribes a
       * digit wrongly, the regex faithfully extracts the same wrong digit and the two "agree".
       *
       * That distinction is load-bearing because agreement scores 0.96, above the auto-clear
       * threshold. Genuine independence would need a second reader over the IMAGE, which this
       * deliberately is not.
       */
      const byRegex = interpretCardText(transcription);

      return {
        card: scoreCard(fields, byRegex),
        transcription,
        provider: result.provider,
        model: result.model,
        crossCheck: explainCrossCheck(fields, byRegex),
        contested: contestedFields(fields, byRegex),
      };
    },
  };
}

/** Field names shared by the model's answer and the regex engine's, in the order a card reads. */
const FIELDS = ["payerName", "memberId", "groupNumber", "planName", "subscriberName", "effectiveDate"] as const;
type FieldName = (typeof FIELDS)[number];

function scoreCard(fields: CardFields, byRegex: InsuranceCardData): InsuranceCardData {
  const scored = {} as Record<FieldName, ExtractedField>;
  for (const name of FIELDS) scored[name] = scoreField(name, fields[name], byRegex[name]);
  return scored;
}

/**
 * Score one field from evidence.
 *
 * The numbers are deliberately conservative and deliberately below the auto-clear threshold whenever
 * anything is in doubt. Verification's review gate is the thing that decides whether a person looks
 * at this card, and the cost of the two mistakes is not symmetric: an unnecessary review costs a
 * biller ten seconds, and a wrong member ID costs a denied claim, a re-filing, and a patient who was
 * quoted the wrong number.
 */
function scoreField(name: FieldName, visionValue: string | null, regexField: ExtractedField): ExtractedField {
  const regexValue = regexField.value;

  if (visionValue === null && regexValue === null) {
    return { value: null, confidence: 0, source: "vision", explanation: `No ${label(name)} was legible on the card.` };
  }

  // Only the regex engine found it — the model declined. Trust it, but only as far as a regex over a
  // transcript deserves: the model looked at the actual card and chose not to answer.
  if (visionValue === null) {
    return {
      value: regexValue,
      confidence: Math.min(regexField.confidence, 0.5),
      source: "vision",
      explanation: `The card reader did not report a ${label(name)}; this was recovered from the card text it transcribed, by pattern match.`,
    };
  }

  // Only the model found it. Common and fine — it reads layout, and a regex over a flat transcript
  // cannot tell which of three numbers is the member ID.
  if (regexValue === null) {
    return {
      value: visionValue,
      confidence: soloConfidence(name, visionValue),
      source: "vision",
      // Same correction as the agreement branch: nothing here is independent of the model. The
      // regex simply found nothing to compare against in the transcript it was given.
      explanation: `Read from the card image. The card text carried no matching pattern to check it against.`,
    };
  }

  // Both readings agree.
  if (equivalent(visionValue, regexValue)) {
    /**
     * ── AGREEMENT IS NOT EVIDENCE THAT THE VALUE IS A VALUE ───────────────────────────────────
     * The plausibility check was consulted only on the solo path, so two readings agreeing on
     * something that is not an identifier at all — "N/A", a dash, a phone number the model dropped
     * into the member-ID slot — scored 0.96 and cleared without a person, while the SAME string
     * read by one reader scored 0.45 and got looked at. Agreement made a bad value harder to catch
     * than a lone one.
     *
     * That is not a hypothetical shape: the two readings share a source, so a model that writes
     * "N/A" into both its structured answer and its transcript produces exactly this. Agreement
     * still counts for everything it legitimately can — it just cannot promote a value that fails
     * the structural test the solo path already applies.
     */
    const solo = soloConfidence(name, visionValue);
    const agreed = name === "payerName" || name === "memberId" ? 0.96 : 0.92;
    const implausible = solo < 0.5;
    return {
      value: visionValue,
      confidence: implausible ? solo : agreed,
      source: "vision",
      explanation: implausible
        ? `Both the card image and the card text read "${visionValue}", but it does not look like a ` +
          `${label(name)}. Agreement between two readings of the same image is not evidence that the ` +
          `value is right — confirm it against the card.`
        : `Read from the card image and confirmed against the card text the reader transcribed. ` +
          `Both readings come from the same image, so this confirms the field was not misassigned, ` +
          `not that every character was read correctly.`,
    };
  }

  /**
   * Both found it, and they disagree.
   *
   * Neither is preferred, and the score is put deliberately below every review threshold. This is
   * the single most valuable outcome this function produces: two readers disagreeing about a member
   * ID is exactly when a person should look, and picking a winner here would discard the only signal
   * that says so.
   */
  return {
    value: visionValue,
    confidence: 0.25,
    source: "vision",
    explanation:
      `The card image reads "${visionValue}" but the card text reads "${regexValue}". ` +
      `They disagree, so this needs a person to confirm it against the card.`,
  };
}

/** Confidence for a value only one reader found. Structure is the only evidence left. */
function soloConfidence(name: FieldName, value: string): number {
  if (name === "payerName") {
    // Not a second payer registry — `identifyPayer` still does the matching downstream. This only
    // asks whether the string the model read is one the system can act on at all.
    return identifyPayer(value).value ? 0.9 : 0.5;
  }
  if (name === "memberId") return plausibleMemberId(value) ? 0.85 : 0.45;
  if (name === "effectiveDate") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? 0.8 : 0.4;
  return 0.75;
}

/**
 * Whether a string looks like a member ID at all.
 *
 * Structural only, and it must stay that way. Payers use wildly different formats and a strict
 * pattern would reject real cards — this rejects the things that are obviously not identifiers
 * (a phone number, a single letter, a sentence the model transcribed into the wrong field).
 */
function plausibleMemberId(value: string): boolean {
  const compact = value.replace(/[\s-]/g, "");
  return compact.length >= 5 && compact.length <= 20 && /^[A-Za-z0-9]+$/.test(compact) && /\d/.test(compact);
}

/** Two readings of the same printed field, ignoring how each chose to punctuate it. */
function equivalent(a: string, b: string): boolean {
  const normalize = (v: string): string => v.replace(/[\s.,#:-]/g, "").toUpperCase();
  return normalize(a) === normalize(b);
}

function label(name: FieldName): string {
  return name === "memberId" ? "member ID" : name.replace(/([A-Z])/g, " $1").toLowerCase();
}

/**
 * The fields a claim cannot survive being wrong about.
 *
 * Deliberately just these two. A contested plan name or subscriber name is worth showing a reviewer
 * and is not worth stopping a check-in for — it does not change which payer is billed or under which
 * identifier. Widening this list would make the exception routine, and a critical exception that
 * fires on most cards teaches staff to clear it without reading it, which is worse than not having
 * it at all.
 */
const CRITICAL_FIELDS: readonly FieldName[] = ["payerName", "memberId"];

function contestedFields(fields: CardFields, byRegex: InsuranceCardData): string[] {
  const contested: string[] = [];
  for (const name of CRITICAL_FIELDS) {
    const vision = fields[name];
    const regex = byRegex[name].value;
    if (vision !== null && regex !== null && !equivalent(vision, regex)) {
      contested.push(
        `The ${label(name)} read from the card image ("${vision}") does not match the one read from ` +
          `the card text ("${regex}"). Confirm it against the card before this is used.`
      );
    }
  }
  return contested;
}

/** The panel a human reads when the card lands in review: what each reader saw, side by side. */
function explainCrossCheck(fields: CardFields, byRegex: InsuranceCardData): string[] {
  return FIELDS.map((name) => {
    const vision = fields[name] ?? "—";
    const regex = byRegex[name].value ?? "—";
    const agreement =
      fields[name] !== null && byRegex[name].value !== null
        ? equivalent(fields[name]!, byRegex[name].value!)
          ? "agree"
          : "DISAGREE"
        : "one reader only";
    return `${label(name)}: image read "${vision}", text read "${regex}" — ${agreement}`;
  });
}

/** Re-exported so callers can score a card the same way without going through the LLM. */
export { cardConfidence };
