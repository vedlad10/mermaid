/**
 * Where a payer's filing or appeal window came from, when it came from the payer (B-1).
 *
 * ── WHY THIS IS A TYPE EVERY MODULE SHARES ─────────────────────────────────────────────────────
 * Every filing and appeal window in this system used to be a plausible default, so one global
 * boolean per kind (`FILING_WINDOWS_ARE_PAYER_SOURCED`, `APPEAL_WINDOWS_ARE_PAYER_SOURCED`) could
 * answer for all of them. Once ONE payer is sourced and the rest are not, a global flag cannot tell
 * the truth about either. The answer has to travel with the number: the payer profile states it, the
 * claim and the denial record which one their date was computed from, and every surface derives its
 * wording from the record rather than from a constant.
 *
 * A window WITHOUT one of these is an estimate. There is no third state and no "partially sourced".
 *
 * ── WHAT A SOURCE IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────────
 * Only the payer's OWN published document counts — never a billing blog or an aggregator, however
 * many of them agree (B1_PAYER_WINDOW_SOURCING.md §1). `quote` is the sentence the number was read
 * from, verbatim, so a reader can check the figure against the words without trusting us.
 *
 * And a sourced window is still a DEFAULT. Every payer that published a number also said the
 * participation agreement or state law can change it (§6.2). So a source makes a date the payer's
 * published term — never this practice's contract, and never grounds for refusing to file.
 */
export interface PayerWindowSource {
  /** Who published it, as a biller would name them: "Aetna Dental". */
  publisher: string;
  /** The document, with the revision it was read from. */
  document: string;
  url: string;
  /** The sentence the number was read from, verbatim. */
  quote: string;
  /** ISO date the document was last read and the quote confirmed against it. */
  verifiedOn: string;
}
