/**
 * The Moda Health sample dental card, as a test fixture.
 *
 * Transcribed by hand from the published sample card (the one carrying a "sample" watermark and the
 * documentation ID `J01234567`). It is **not** a patient's card and contains no real person's
 * information — Moda publish it precisely so it can be used in examples.
 *
 * ── WHY THIS FIXTURE IS SHAPED LIKE THIS ───────────────────────────────────────────────────────
 * It is deliberately awkward in the four ways real cards are awkward, and each one broke something:
 *
 *  1. **The ID is labelled "ID number", not "Member ID".** Every payer words this differently, and
 *     a reader that only knows "Member ID" finds nothing on this card.
 *  2. **The subscriber is one of four names**, in a numbered dependent list. The patient being seen
 *     may be `(02) Kimberly N. Smith` while the card is issued to `(00) Mary J. Smith`.
 *  3. **There is no date of birth anywhere on it.** There is no date of birth on almost any
 *     insurance card. A DOB field that stays empty after a scan is the system being correct.
 *  4. **There are five other numbers on it** — BIN 610014, group 10101010, and three phone numbers —
 *     any of which a naive "find the longest digit run" heuristic will happily return as the ID.
 */

/** What the card actually says, in reading order — the shape a vision model returns. */
export const MODA_TRANSCRIPTION = [
  "moda HEALTH",
  "www.modahealth.com",
  "ID number",
  "J01234567",
  "Group number",
  "10101010",
  "Plan",
  "Dental PPO",
  "Subscriber/Dependent(s)",
  "(00) Mary J. Smith    Subscriber",
  "(01) John A. Smith    Dependent",
  "(02) Kimberly N. Smith    Dependent",
  "(03) Maxwell E. Smith    Dependent",
  "Networks",
  "Moda Dental PPO",
  "Premier Dental Network",
  "BIN: 610014",
  "PCN: MDADX",
  "Rx Group: RXMODA",
  "Dental Customer Service",
  "877-277-7280",
  "Claims Customer Service",
  "866-938-0356",
  "Send claims to:",
  "Moda Health",
  "P.O. Box 40384",
  "Portland, OR 97240",
  "This card does not certify or guarantee benefits.",
].join("\n");

/** The structured answer a correct read produces. Note `effectiveDate: null` — it is not on the card. */
export const MODA_FIELDS = {
  payerName: "Moda Health",
  memberId: "J01234567",
  groupNumber: "10101010",
  planName: "Dental PPO",
  subscriberName: "Mary J. Smith",
  effectiveDate: null,
  transcription: MODA_TRANSCRIPTION,
};

/** A provider reply carrying that answer, for driving the router end to end. */
export const MODA_REPLY = { kind: "text" as const, text: JSON.stringify(MODA_FIELDS) };

/**
 * A 1x1 PNG. The bytes are never decoded by anything under test — the provider seam is where the
 * image stops — so a real photograph would only make the suite slower and the fixture larger.
 */
export const MODA_IMAGE = [
  {
    mediaType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  },
];
