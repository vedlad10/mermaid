/**
 * Card interpretation — turns raw insurance-card text into structured, scored fields. Ported
 * verbatim from Dental Verify's `ocr.ts`. MOCK integration: production supplies `rawText` from a
 * vision/OCR provider (behind an OCR adapter, later); this interpretation step is unchanged when
 * that swaps in. No money here.
 */
import type { ExtractedField, InsuranceCardData } from "../types.ts";

const KNOWN_PAYER_PATTERNS: { pattern: RegExp; canonical: string }[] = [
  { pattern: /delta\s*dental/i, canonical: "Delta Dental" },
  { pattern: /cigna/i, canonical: "Cigna Dental" },
  { pattern: /metlife/i, canonical: "MetLife Dental" },
  { pattern: /aetna/i, canonical: "Aetna Dental" },
  { pattern: /guardian/i, canonical: "Guardian" },
  { pattern: /united\s*health|uhc/i, canonical: "UnitedHealthcare Dental" },
  // Cards print this as "moda HEALTH" under a lowercase logo; the canonical form is what
  // `identifyPayer` and every downstream screen then agree on.
  { pattern: /\bmoda\b/i, canonical: "Moda Health" },
];

function field(value: string | null, confidence: number, explanation: string): ExtractedField {
  return { value, confidence, source: "ocr", explanation };
}

function missing(name: string): ExtractedField {
  return field(null, 0, `No ${name} found on the card text.`);
}

/**
 * Words that are part of a LABEL and can never be the value it labels.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ──────────────────────────────────────────────────────────────
 * Real cards print the label on one line and the value beneath it — "ID number" over "J01234567".
 * The labelled-value pattern was written for the inline form ("Member ID: ABC12345") and, on a
 * label-only line, matched "ID" as the label and then captured the remaining word — **"number"** —
 * as the value. It reported that as a *labelled* member ID, which carries 0.92 confidence, which
 * clears the 0.75 auto-verify threshold.
 *
 * So a pasted Moda card produced `memberId: "NUMBER"`, confidently, and nothing downstream had any
 * reason to doubt it. That is a made-up identifier on a claim to a payer, arrived at silently. It
 * predates the photograph feature entirely and affects the typed path everybody uses today.
 */
const LABEL_WORDS = new Set([
  "NUMBER", "NUMBERS", "NUMBER:", "MEMBER", "SUBSCRIBER", "IDENTIFICATION", "GROUP", "PLAN",
  "NAME", "DATE", "EFFECTIVE", "POLICY", "CARD", "HOLDER", "DENTAL", "HEALTH", "INSURANCE",
]);

const isLabelWord = (value: string): boolean => LABEL_WORDS.has(value.trim().toUpperCase());

/**
 * Find a labelled value, accepting both layouts real cards actually use.
 *
 * `Member ID: ABC12345`   — inline, which is what this always handled.
 * `ID number` / `J01234567` — label on one line, value on the next, which is how a printed card is
 *                             laid out and which used to yield the word "number".
 *
 * The next-line form only fires when the label line has no value of its own, so an inline match
 * always wins and nothing that parsed before parses differently.
 */
function matchLine(lines: string[], label: RegExp, valuePattern?: RegExp): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = line.match(label);
    if (!m) continue;

    /**
     * ── THE SHAPE CHECK APPLIES TO BOTH LAYOUTS (D4) ─────────────────────────────────────────
     * `valuePattern` used to guard only the next-line branch below, so an INLINE capture was
     * returned on the strength of the label alone. Tightening the pattern was therefore inert on
     * the path that most cards actually take.
     *
     * It also let a fragment through. The label alternation matches `id` unanchored, so a line
     * reading `IDENTIFIER` matched "ID" as the label and captured the rest of the same word —
     * `ENTIFIER` — returning it as a labelled member ID at 0.92 confidence, which clears the
     * auto-verify threshold. A made-up identifier on a real claim, arrived at silently.
     *
     * A capture that fails the shape check is not returned, and it does not stop the search: the
     * label line simply had no usable value of its own, which is exactly the case the next-line
     * branch exists for.
     */
    const inline = m[1]?.trim();
    if (inline && !isLabelWord(inline) && (!valuePattern || valuePattern.test(inline))) return inline;

    /**
     * The label matched but carried no usable value of its own. Look at the following line — but
     * only accept it if it LOOKS like the thing being labelled, so a bare "Group number" heading
     * does not swallow whatever section title happens to come after it.
     */
    const next = lines[i + 1]?.trim();
    if (next && !isLabelWord(next) && !label.test(next) && (!valuePattern || valuePattern.test(next))) {
      return next;
    }
  }
  return null;
}

export function interpretCardText(rawText: string): InsuranceCardData {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const joined = lines.join("\n");

  let payerName = missing("payer name");
  for (const { pattern, canonical } of KNOWN_PAYER_PATTERNS) {
    if (pattern.test(joined)) {
      payerName = field(canonical, 0.95, `Matched known payer pattern "${pattern.source}".`);
      break;
    }
  }
  if (!payerName.value && lines.length > 0) {
    payerName = field(lines[0] ?? null, 0.4, "No known payer matched; used the first card line as a guess.");
  }

  const labeledId = matchLine(
    lines,
    /(?:member|subscriber|id|identification)\s*(?:id|#|no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})?/i,
    /**
     * An identifier: at least six characters of letters, digits and hyphens, starting with a letter
     * or digit, and CONTAINING AT LEAST ONE DIGIT. Payers use wildly different formats, so this
     * still rejects prose rather than enforcing a shape.
     *
     * ── WHY THE DIGIT IS NOW REQUIRED (D4) ─────────────────────────────────────────────────────
     * It used to accept an all-letter run, so `MEMBERID` or `SUBSCRIBER` was a well-formed member
     * ID as far as this function was concerned — reported at 0.92 confidence, which clears the
     * 0.75 auto-verify threshold. `LABEL_WORDS` catches the single words this actually produced in
     * the wild, but it is an enumeration, and the next card that prints a label this list has
     * never seen gets the same silent promotion to "identifier".
     *
     * The question the earlier comment left open was whether real member IDs can be all-letter.
     * Every member ID in this repository has a digit — the fixtures, the payer catalog, the OCR
     * cases (`ABC12345`, `W123456789`, `U7654321`, `ZZ998877`, `J01234567`) and the live Stedi
     * sandbox member `AETNA9wcSu`. Nothing that passes today stops passing.
     *
     * The failure mode also improves. A rejected value yields a MISSING member ID, which the
     * appeal and claim gates already refuse to file on; an accepted prose word yields a made-up
     * identifier on a real claim, which nothing downstream has any reason to doubt.
     */
    /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}$/i
  );
  let memberId: ExtractedField;
  if (labeledId) {
    /**
     * ── MEMBER IDs KEEP THEIR CASE ───────────────────────────────────────────────────────────
     * This used to upper-case the value. Payer member IDs are case-sensitive — a live Stedi check
     * for `AETNA9wcSu` was sent as `AETNA9WCSU` and the payer did not recognise it. The
     * normalisation looked harmless because every card in this repository's fixtures was already
     * upper-case, so nothing ever disagreed with it until a real clearinghouse did.
     *
     * Comparisons elsewhere (the card-vs-typed cross-check, `detectExceptions`) already normalise
     * case at the point of comparison, which is where it belongs — the stored value must stay
     * exactly what is printed on the card, because that is what goes to the payer.
     */
    memberId = field(labeledId, 0.92, "Found a labeled member ID.");
  } else {
    const token = joined.match(/\b[A-Z]{0,3}\d{6,12}\b/);
    memberId = token
      ? field(token[0], 0.55, "No labeled member ID; used the most ID-like token on the card.")
      : missing("member ID");
  }

  /**
   * The group number.
   *
   * `(?!\s*rx)` keeps "Rx Group: RXMODA" out of it. That is the PHARMACY group, printed on the same
   * card as the dental group, and filing a claim under it means filing under a number the dental
   * payer has never seen.
   */
  const group = matchLine(lines, /(?<!rx\s)group\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9-]{3,})?/i, /^[A-Z0-9-]{3,}$/i);
  const groupNumber = group ? field(group.toUpperCase(), 0.9, "Found a labeled group number.") : missing("group number");

  const plan = matchLine(lines, /plan\s*(?:name)?\s*[:#]?\s*(.+)/i);
  const planName = plan ? field(plan, 0.85, "Found a labeled plan name.") : missing("plan name");

  const name = matchLine(lines, /(?:name|subscriber|member)\s*[:#]?\s*([A-Za-z][A-Za-z .,'-]{2,})$/i);
  const subscriberName = name ? field(name, 0.8, "Found a labeled subscriber name.") : missing("subscriber name");

  const date = matchLine(lines, /(?:effective|eff\.?)\s*(?:date)?\s*[:#]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const effectiveDate = date ? field(normalizeDate(date), 0.85, "Found a labeled effective date.") : missing("effective date");

  return { payerName, memberId, groupNumber, planName, subscriberName, effectiveDate };
}

function normalizeDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return raw;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** Weighted confidence across the card fields verification depends on. */
export function cardConfidence(card: InsuranceCardData): number {
  const critical = [card.payerName, card.memberId];
  const supporting = [card.groupNumber, card.effectiveDate];
  const criticalAvg = critical.reduce((s, f) => s + f.confidence, 0) / critical.length;
  const supportingAvg = supporting.reduce((s, f) => s + f.confidence, 0) / supporting.length;
  return criticalAvg * 0.8 + supportingAvg * 0.2;
}
