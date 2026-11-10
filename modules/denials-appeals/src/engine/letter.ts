/**
 * Appeal drafting — a deterministic letter plus the evidence checklist that actually decides whether
 * the appeal wins.
 *
 * Ported from `dental-rcm-platform`'s `appealLetterTemplate` / `draftAppeal`.
 *
 * ── WHERE AI IS AND IS NOT ALLOWED ─────────────────────────────────────────────────────────────
 * This engine is pure and deterministic. The DISPOSITION (appeal vs. write off vs. bill the patient)
 * comes from the playbook; the letter's factual content comes from the denial record. An LLM may
 * later be handed this draft to improve its prose — that is the one place it adds value here — but
 * it must never choose whether to appeal, what to assert, or what the money is. A letter to a payer
 * is a factual claim about a patient's care; an invented sentence in one is a compliance problem,
 * not a typo (blueprint doc 10).
 *
 * The CHECKLIST is the more valuable half. A letter without its radiographs is a wasted appeal
 * window, and the checklist is derived from what the procedure and the reason code actually require
 * rather than from a generic list someone has to remember.
 */
import { findProcedure, formatUsd, type Cents } from "@mermaid/shared";

export interface AppealContext {
  level: number;
  payerName: string;
  patientName: string;
  memberId: string;
  claimControlNumber: string;
  serviceDate: string;
  procedureCode: string | null;
  carcCode: string;
  carcDescription: string;
  /** What the payer originally withheld. Stated for the payer's own reconciliation, never demanded. */
  deniedAmount: Cents;
  /**
   * How much of that has since been paid, on an earlier appeal (F-5/F-7 fallout).
   *
   * Zero on the ordinary appeal, which is the first one and follows no recovery. Above zero only
   * where a previous level was won and the payer has already sent part of the money — a state that
   * became reachable when `awaiting_payment` and `partially_recovered` were added as OPEN statuses,
   * because open statuses can be appealed again.
   */
  alreadyRecovered?: Cents;
  /** Playbook guidance — the argument that actually wins this code, when one is known. */
  guidance: string;
  providerName: string;
}

export interface AppealDraft {
  letter: string;
  checklist: string[];
}

/**
 * Refused because the letter could not be written truthfully.
 *
 * A deterministic engine has exactly one honest failure mode — it was asked to state something it
 * was not given — and this is it. Kept as a distinct error so the service can translate it into a
 * biller-actionable message rather than a 500.
 */
export class IncompleteAppealError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(`an appeal letter cannot be drafted without ${missing.join(" and ")}`);
    this.name = "IncompleteAppealError";
    this.missing = missing;
  }
}

/** Raised when an appeal is drafted for a denial the payer has already settled in full. */
export class FullyRecoveredAppealError extends Error {
  /** Declared, not a parameter property — node's strip-only TS rejects those. */
  readonly deniedAmount: Cents;

  constructor(deniedAmount: Cents) {
    super(
      `this denial has already been recovered in full (${formatUsd(deniedAmount)}), so there is nothing ` +
        `left to appeal — a letter demanding money the payer has already sent would be refused as a duplicate`
    );
    this.name = "FullyRecoveredAppealError";
    this.deniedAmount = deniedAmount;
  }
}

export function draftAppeal(
  ctx: AppealContext,
  /**
   * An AI-written argument paragraph, or null for the deterministic sentence.
   *
   * It replaces exactly one slot — the argument — and nothing else. The claim number, member ID,
   * date of service, denied amount, procedure code, reason code, enclosure list and closing request
   * are all still written by this function, from the denial record, and the model is never given the
   * chance to restate them. Null is not a failure mode; it is what this function did before AI
   * existed, and it produces a letter the practice has been sending all along.
   *
   * Already sanitized by `sanitizeNarrative` when it arrives here.
   */
  narrative: string | null = null
): AppealDraft {
  /**
   * The last line of defence, and deliberately duplicated in the service.
   *
   * The service refuses first, with a message a biller can act on; this refuses again, so that no
   * future caller — a bulk-appeal job, a retry path, a test fixture — can reach the template with an
   * identifier missing and produce a letter that says "[member ID]" to a payer. A placeholder in a
   * factual assertion about a patient's care is a compliance problem, not a typo, and the engine
   * that writes it is the right place for the guarantee to live.
   */
  const missing = [
    ctx.memberId?.trim() ? null : "the member ID",
    ctx.claimControlNumber?.trim() ? null : "the claim control number",
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) throw new IncompleteAppealError(missing);

  const checklist = checklistFor(ctx);
  const procedure = ctx.procedureCode ? findProcedure(ctx.procedureCode) : undefined;
  const procedureLabel = ctx.procedureCode
    ? `${ctx.procedureCode} (${procedure?.description ?? "dental procedure"})`
    : "the denied service";
  const heading = ctx.level > 1 ? `LEVEL-${ctx.level} APPEAL` : "APPEAL";

  /**
   * What this appeal is actually for. Clamped at both ends: a recovery larger than the denial would
   * otherwise produce a negative demand, and a negative one would produce a letter asking the payer
   * for less than nothing.
   */
  const recovered = Math.min(Math.max(0, ctx.alreadyRecovered ?? 0), ctx.deniedAmount) as Cents;
  const outstanding = (ctx.deniedAmount - recovered) as Cents;
  /**
   * Nothing left to ask for. The view already refuses — a fully recovered denial is not an OPEN
   * status, so `canDraft` is false — and this refuses again for the same reason the identifier guard
   * does: no future caller, bulk job or retry path may reach the template and produce a letter
   * demanding $0.00 from a payer that has paid in full.
   */
  if (ctx.deniedAmount > 0 && outstanding === 0) throw new FullyRecoveredAppealError(ctx.deniedAmount);

  const letter = [
    // No placeholder fallbacks: the guard above guarantees both identifiers are present, and a
    // fallback here would be a quiet way to reintroduce exactly what it exists to prevent.
    `RE: ${heading} — Claim ${ctx.claimControlNumber}`,
    `Patient: ${ctx.patientName} | Member ID: ${ctx.memberId} | Date of Service: ${ctx.serviceDate}`,
    "",
    `To the Dental Review Department of ${ctx.payerName}:`,
    "",
    /**
     * ── DEMAND WHAT IS STILL OWED, NOT WHAT WAS ORIGINALLY DENIED ────────────────────────────────
     * This asked for `deniedAmount` unconditionally. Once `awaiting_payment` and
     * `partially_recovered` became OPEN statuses, a denial the payer had already partly paid could
     * be appealed again — and the letter went on demanding the whole original sum, telling a payer
     * it still owed money it had already sent.
     *
     * That is a factual misstatement to a payer about a patient's claim, which is the one thing this
     * module says it exists to prevent. Its practical cost is worse than the wrong number: the payer
     * either rejects the appeal as a duplicate, and the practice loses a level it cannot re-file, or
     * pays twice and recoups later.
     *
     * The original figure is still stated, because the payer reconciles against its own advice and a
     * demand it cannot tie to a denial it recognises is a demand it cannot process.
     */
    outstanding < ctx.deniedAmount
      ? `We are formally appealing the denial of ${procedureLabel}, denied under reason code ` +
        `${ctx.carcCode} (${ctx.carcDescription}) in the amount of ${formatUsd(ctx.deniedAmount)}. ` +
        `${formatUsd(recovered)} has since been received against this determination; this appeal ` +
        `concerns the remaining ${formatUsd(outstanding)}.`
      : `We are formally appealing the denial of ${procedureLabel} in the amount of ` +
        `${formatUsd(ctx.deniedAmount)}, denied under reason code ${ctx.carcCode} (${ctx.carcDescription}).`,
    "",
    /**
     * The one slot AI may occupy. The deterministic sentence is not a fallback bolted on for the
     * AI's sake — it is what this letter carries whenever narration is off, degraded or refused,
     * which is the ordinary configuration.
     *
     * ── IT USED TO ASSERT A CLINICAL JUDGEMENT NOBODY MADE ────────────────────────────────────
     * It read: "This procedure was clinically necessary and appropriately documented." Mermaid
     * establishes neither. Nothing in this system assesses clinical necessity, and nothing knows
     * whether documentation exists — the checklist immediately below is the list a human must go
     * and GATHER, so the letter attested to documentation in the same breath as asking for it.
     *
     * This module's own header calls an appeal "a factual assertion to a payer about a patient's
     * care". That is exactly why the default may not make the assertion: a named human approves
     * before anything is sent, but they were approving a pre-written claim about care, not making
     * one. The sentence now states the request and what the request rests on, and leaves the
     * clinical judgement to the records and to the people qualified to make it.
     */
    narrative ?? `We are asking ${ctx.payerName} to reconsider this determination on the basis of the ` +
      `records listed below.${ctx.guidance ? ` ${ctx.guidance}` : ""}`,
    "",
    /**
     * "Enclosed with this appeal:" asserted completed enclosure of a list that, at draft time, is a
     * to-do. `recommendedAction` says so in as many words — "Gather the N evidence items, then
     * approve to send" — so the letter claimed attachment of things the workflow was still asking
     * for.
     *
     * "to accompany" is true at both moments: at draft it names what will accompany the appeal, and
     * at send it names what does. No new state is needed to make it honest, because the human
     * approval gate already stands between the two.
     */
    "Documentation to accompany this appeal:",
    ...checklist.map((item) => `  - ${item}`),
    "",
    "We respectfully request reprocessing of this claim for payment under the terms of the " +
      "member's plan. Please direct any questions to our billing office.",
    "",
    "Sincerely,",
    ctx.providerName || "[Provider]",
    "",
  ].join("\n");

  return { letter, checklist };
}

/**
 * What a human must physically gather. Derived from the procedure's own requirements — the CDT
 * catalog already records which need a radiograph or a narrative — and from the reason code.
 */
function checklistFor(ctx: AppealContext): string[] {
  const procedure = ctx.procedureCode ? findProcedure(ctx.procedureCode) : undefined;
  const checklist = ["Signed appeal letter", "Copy of the claim with corrections highlighted"];

  if (procedure?.requiresNarrative) checklist.push("Clinical narrative from the treating provider");
  if (procedure?.requiresToothNumber) checklist.push("Pre-operative diagnostic radiograph of the treated tooth");
  if ((ctx.procedureCode ?? "").startsWith("D4")) checklist.push("Full-mouth periodontal charting with pocket depths");
  if (ctx.carcCode === "29") checklist.push("Clearinghouse acceptance report (proof of timely filing)");
  if (ctx.carcCode === "197") checklist.push("Retro-authorization request and documentation of clinical urgency");
  if (ctx.carcCode === "16") checklist.push("The specific missing item named in the payer's remark code");
  if (ctx.carcCode === "18") checklist.push("Both claim numbers, showing the original was never paid");
  if (ctx.level > 1) checklist.push("The payer's prior appeal determination letter");

  return checklist;
}
