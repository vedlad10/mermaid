/**
 * The statutory clock engine (F5) — interest a payer owes for paying late, and takebacks it is out
 * of time to make.
 *
 * Pure and deterministic: no I/O, no clock of its own, no AI. Every input is passed in, including
 * the governing rule, because these findings end up in a letter to a payer and a number in a letter
 * has to be re-derivable from what was recorded rather than from whatever the statute table holds
 * six months later.
 *
 * ── THE DISCIPLINE THAT SHAPES EVERY BRANCH BELOW ──────────────────────────────────────────────
 * This engine is unusual in the codebase: it produces a demand addressed to somebody else. That
 * makes a false positive expensive in a way a wrong internal figure is not — a practice that
 * invoices a payer for interest it is not owed loses the argument AND the standing to win the next
 * one. So every path that cannot fully establish the claim REFUSES rather than estimates, and says
 * why it refused.
 *
 * `refusedBecause` is returned alongside the finding for exactly that reason. It is not debug
 * output; it is the record of a decision not to demand money, and it is what someone reads when
 * they ask why a claim they believe is late is not on the list.
 */
import { daysBetween, scaleCents, type Cents } from "@mermaid/shared";
import type { PromptPayRule, RecoupmentRule } from "./statutes.ts";

/**
 * CARC codes that mean "the payer asked for something before it could adjudicate".
 *
 * Every prompt-pay statute runs its clock on a CLEAN claim, and restarts it when the payer requests
 * additional information. So a claim adjudicated with any of these is one this engine will not
 * compute interest on — not because interest is definitely not owed, but because the date it would
 * accrue from is the date the information arrived, and that date is not in an 835.
 *
 * Deliberately broad. Being wrong in this direction costs a finding that might have been valid;
 * being wrong in the other direction sends a demand whose own evidence contradicts it.
 */
export const NOT_CLEAN_CARC = new Set([
  "16", // Claim/service lacks information or has submission/billing error(s).
  "17", // Requested information was not provided or was insufficient/incomplete.
  "125", // Submission/billing error(s).
  "226", // Information requested from the Billing/Rendering Provider was not provided.
  "227", // Information requested from the patient/insured/responsible party was not provided.
  "251", // The attachment/other documentation that was received was incomplete.
  "252", // An attachment/other documentation is required to adjudicate this claim/service.
  "288", // Referral absent.
  "197", // Precertification/authorization/notification/pre-treatment absent.
]);

/**
 * CARC 85 is "Patient Interest Adjustment" and RARC N58-family remarks accompany interest payments.
 * A claim carrying one has already been paid interest, and demanding it again is the single most
 * embarrassing thing this feature could do.
 */
export const INTEREST_ALREADY_PAID_CARC = new Set(["85"]);

/** PLB03-1 reason codes. `WO` is the withholding of a prior overpayment — the recoupment. */
export const RECOUPMENT_PLB_REASON = "WO";

export type ClockRefusal =
  | "no-rule-for-state"
  | "claim-was-not-paid"
  | "claim-was-not-clean"
  | "interest-already-paid"
  | "paid-within-the-statutory-window"
  | "interest-rounds-to-nothing"
  | "below-the-statutory-minimum"
  | "not-a-recoupment"
  | "original-payment-unknown"
  | "within-the-recoupment-window";

export interface PromptPayInput {
  /** When the claim was filed. The clock starts here — see the note on `submissionChannel`. */
  submittedAt: string;
  /** The payer's own payment date (BPR16), not when the file arrived. */
  paidAt: string;
  /** What the payer actually paid on this claim. Interest accrues on the amount owed. */
  paidCents: Cents;
  /**
   * How the claim reached the payer.
   *
   * Two of the three verified statutes give a paper claim longer, so this changes the answer. It is
   * not read off the 835 — the advice does not say — but off whether THIS system filed the claim,
   * which it only did electronically. A claim with no recorded submission is not assessed at all,
   * so there is no path on which this is assumed.
   */
  submissionChannel: "electronic" | "paper";
  /** Group/code pairs exactly as the payer stated them, unfiltered. */
  adjustments: readonly { group: string; code: string }[];
  /** True when this advice carried interest for the claim at the provider level (PLB `L6`). */
  interestPaidAtProviderLevel: boolean;
  disposition: string;
}

export interface PromptPayFinding {
  kind: "prompt-pay-interest";
  /** Days from filing to payment. */
  elapsedDays: number;
  /** What the statute allowed. */
  allowedDays: number;
  /** `elapsedDays − allowedDays`, and the number interest accrues over. */
  lateDays: number;
  /** The principal interest was computed on. */
  principal: Cents;
  /** Simple interest: `principal × rate × lateDays / 365`. */
  interestCents: Cents;
  rateBps: number;
  citation: string;
  source: string;
  verifiedOn: string;
  defeasibleBy: readonly string[];
  /** What a person should actually do. */
  action: string;
}

export interface Assessed<T> {
  finding: T | null;
  /** Why no finding was raised. Null when one was. */
  refusedBecause: ClockRefusal | null;
}

const has = (adjustments: readonly { group: string; code: string }[], codes: ReadonlySet<string>): boolean =>
  adjustments.some((a) => codes.has(a.code.trim()));

/**
 * Simple annual interest over a part-year, which is what all three verified statutes specify.
 *
 * 365 rather than 360. The banking convention is 360 and the statutes say "per annum"; a year is
 * 365 days, and the difference on a $650 claim 40 days late is under a cent — but the choice is
 * stated here because it is the kind of thing a payer's auditor asks about, and "we used a
 * commercial convention the statute does not mention" is a worse answer than "we used a year".
 */
const simpleInterest = (principal: Cents, rateBps: number, days: number): Cents =>
  scaleCents(principal, (rateBps / 10_000) * (days / 365));

/**
 * Did this payer take longer than the law allows, and what does it owe for that?
 *
 * The order of the refusals is the order in which they make the question moot, cheapest first.
 */
export function assessPromptPay(input: PromptPayInput, rule: PromptPayRule | null): Assessed<PromptPayFinding> {
  if (rule === null) return { finding: null, refusedBecause: "no-rule-for-state" };

  /**
   * Interest accrues on money that was OWED and paid late. A denial is a different fight with a
   * different remedy, and a zero-dollar adjudication has no principal — interest on nothing is
   * nothing, and a row saying so is a row a biller has to dismiss.
   */
  if (input.paidCents <= 0 || input.disposition === "denied" || input.disposition === "reversal") {
    return { finding: null, refusedBecause: "claim-was-not-paid" };
  }

  if (input.interestPaidAtProviderLevel || has(input.adjustments, INTEREST_ALREADY_PAID_CARC)) {
    return { finding: null, refusedBecause: "interest-already-paid" };
  }

  if (has(input.adjustments, NOT_CLEAN_CARC)) {
    return { finding: null, refusedBecause: "claim-was-not-clean" };
  }

  const allowedDays = input.submissionChannel === "paper" ? rule.paperDays : rule.electronicDays;
  const elapsedDays = daysBetween(input.submittedAt, input.paidAt);
  const lateDays = elapsedDays - allowedDays;
  if (lateDays <= 0) return { finding: null, refusedBecause: "paid-within-the-statutory-window" };

  const interestCents = simpleInterest(input.paidCents, rule.rateBps, lateDays);

  /**
   * ── A DEMAND FOR NOTHING IS STILL A DEMAND ───────────────────────────────────────────────────
   * Simple interest on a small principal over a few days rounds to zero cents. A $5.00 claim paid
   * one day late earns 0.16 of a cent, and without this the engine raised a finding saying the
   * payer owes $0.00 — a worklist row instructing a biller to write to a payer about nothing, and a
   * savings report counting a recovery opportunity worth nothing.
   *
   * Distinct from the statutory floor below, and deliberately checked first. That floor is a
   * LEGISLATED threshold that only Oregon states; this is arithmetic that is true everywhere. A
   * state with no floor, which is most of them, had nothing stopping it.
   */
  if (interestCents <= 0) return { finding: null, refusedBecause: "interest-rounds-to-nothing" };

  if (rule.deMinimisCents !== null && interestCents <= rule.deMinimisCents) {
    return { finding: null, refusedBecause: "below-the-statutory-minimum" };
  }

  return {
    refusedBecause: null,
    finding: {
      kind: "prompt-pay-interest",
      elapsedDays,
      allowedDays,
      lateDays,
      principal: input.paidCents,
      interestCents,
      rateBps: rule.rateBps,
      citation: rule.citation,
      source: rule.source,
      verifiedOn: rule.verifiedOn,
      defeasibleBy: rule.defeasibleBy,
      action:
        `Confirm the plan is insured rather than self-funded, then bill this payer ${rule.citation} ` +
        `interest: the claim was filed ${elapsedDays} days before payment, the statute allows ` +
        `${allowedDays}, and simple interest at ${rule.rateBps / 100}% per annum over the ` +
        `${lateDays} late days is the amount claimed. Quote the trace number and the filing date — ` +
        `a prompt-pay demand is won or lost on whether the practice can date its own submission.`,
    },
  };
}

export interface RecoupmentInput {
  /** PLB03-1 verbatim. */
  reasonCode: string;
  /** PLB03-2 — the claim the payer says it is recovering from. Null when it named nothing. */
  referenceId: string | null;
  /** The amount withheld. Positive reduces the payment. */
  amountCents: Cents;
  /** The payment date of the advice making the recoupment. */
  recoupedAt: string;
  /**
   * When the practice was originally paid for the referenced claim, or null when this system has no
   * record of it.
   *
   * Null is common and not a defect: the window is measured from a payment that may predate this
   * system entirely. It produces a refusal rather than a guess, because the whole finding is a date
   * subtraction and a guessed minuend is a fabricated defence.
   */
  originalPaidAt: string | null;
}

export interface RecoupmentFinding {
  kind: "recoupment-out-of-time";
  referenceId: string;
  /** Money taken back after the window closed — disputable, and not yet recovered. */
  disputableCents: Cents;
  daysSinceOriginalPayment: number;
  /** The window, in days, as measured for this specific pair of dates. */
  windowDays: number;
  /** How the statute itself words it, since months are not a fixed number of days. */
  windowStated: string;
  citation: string;
  source: string;
  verifiedOn: string;
  defeasibleBy: readonly string[];
  action: string;
}

/**
 * Add whole calendar months to a `YYYY-MM-DD` day, clamping to the end of the target month.
 *
 * 18 months from 2025-08-31 is 2027-02-28, not 2027-03-03. `Date.setMonth` rolls over, and rolling
 * over lengthens the window — in the payer's favour, on exactly the claims at a month boundary.
 */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastOfTarget));
  return target.toISOString().slice(0, 10);
}

/** Is this takeback out of time, and how much of it is therefore disputable? */
export function assessRecoupment(
  input: RecoupmentInput,
  rule: RecoupmentRule | null
): Assessed<RecoupmentFinding> {
  /**
   * Only `WO` is a recovery of a prior overpayment. `FB` is a forwarding balance carried to the next
   * advice — the payer has not taken anything, it is paying it later — and treating one as the other
   * would put a dispute in front of a biller over money that is still coming.
   */
  if (input.reasonCode.trim().toUpperCase() !== RECOUPMENT_PLB_REASON || input.amountCents <= 0) {
    return { finding: null, refusedBecause: "not-a-recoupment" };
  }
  if (rule === null) return { finding: null, refusedBecause: "no-rule-for-state" };
  if (input.referenceId === null || input.originalPaidAt === null) {
    return { finding: null, refusedBecause: "original-payment-unknown" };
  }

  const recoupedOn = input.recoupedAt.slice(0, 10);
  const paidOn = input.originalPaidAt.slice(0, 10);
  const closesOn =
    rule.windowMonths !== null ? addMonths(paidOn, rule.windowMonths) : addDays(paidOn, rule.windowDays!);

  if (recoupedOn <= closesOn) return { finding: null, refusedBecause: "within-the-recoupment-window" };

  const windowStated = rule.windowMonths !== null ? `${rule.windowMonths} months` : `${rule.windowDays} days`;
  const daysSinceOriginalPayment = daysBetween(paidOn, recoupedOn);

  return {
    refusedBecause: null,
    finding: {
      kind: "recoupment-out-of-time",
      referenceId: input.referenceId,
      disputableCents: input.amountCents,
      daysSinceOriginalPayment,
      windowDays: daysBetween(paidOn, closesOn),
      windowStated,
      citation: rule.citation,
      source: rule.source,
      verifiedOn: rule.verifiedOn,
      defeasibleBy: rule.defeasibleBy,
      action:
        `Dispute this takeback in writing and ask for the money back. ${rule.citation} gives the ` +
        `payer ${windowStated} from the date the practice was paid; it was paid on ${paidOn} and ` +
        `this recovery was taken on ${recoupedOn}, ${daysSinceOriginalPayment} days later. Rule out ` +
        `an allegation of fraud and a self-funded plan first — both are excepted — then quote the ` +
        `statute, the original trace number and both dates.`,
    },
  };
}

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ── The claim the payer never answered at all ───────────────────────────────────────────────────

export interface UnpaidDeadlineInput {
  /**
   * Calendar days from filing to today, already counted on the PRACTICE's calendar.
   *
   * Passed in rather than recomputed from dates so there is exactly one place in the system that
   * decides how long a claim has been waiting. The silent-claim watchdog computes it, and its own
   * regression tests pin that it counts in the clinic's day rather than in UTC — a rule this
   * engine would otherwise have to restate, and restating it is how the two drift by a day.
   */
  elapsedDays: number;
  submissionChannel: "electronic" | "paper";
  /**
   * What the practice's own estimate says insurance will pay.
   *
   * Carried as EXPOSURE, never as a principal. See `estimatedExposure` on the finding.
   */
  expectedInsurancePays: Cents;
}

export interface DeadlinePassedFinding {
  kind: "prompt-pay-deadline-passed";
  elapsedDays: number;
  allowedDays: number;
  /** Days beyond the statutory pay-or-deny deadline with still no answer. */
  daysPastDeadline: number;
  /**
   * What the practice has at stake — ITS OWN ESTIMATE, not the payer's figure and not interest.
   *
   * Named to make misuse awkward. Interest accrues on the amount ultimately PAID, and on an unpaid
   * claim nobody knows that amount: the payer has not said what it will allow. A finding that put
   * this number where a principal goes would be inventing the one figure a demand rests on, which is
   * the error the whole feature is built to avoid. It is here so a practice can rank its exposure,
   * and it is why this finding's `claimedCents` is zero.
   */
  estimatedExposure: Cents;
  citation: string;
  source: string;
  verifiedOn: string;
  defeasibleBy: readonly string[];
  action: string;
}

/**
 * Has the statutory pay-or-deny deadline passed on a claim that is still unanswered?
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `assessPromptPay` ─────────────────────────────────────────
 * F5 was driven entirely by remittances, so it only ever assessed claims a payer PAID. Every one of
 * the verified statutes requires the payer to pay OR DENY within the window — so a claim still
 * unanswered at day 60 is already past its deadline, produces no remittance, and was therefore
 * invisible to the feature built to catch exactly this. The most expensive prompt-pay case was the
 * one nothing looked at.
 *
 * ── WHAT IT REFUSES TO SAY ────────────────────────────────────────────────────────────────────
 * That any specific amount is owed. It asserts only what is checkable from dates: the deadline has
 * passed and the claim is still unanswered. The money is `estimatedExposure`, labelled as the
 * practice's own estimate, and it never becomes a claimed amount.
 */
export function assessUnpaidDeadline(
  input: UnpaidDeadlineInput,
  rule: PromptPayRule | null
): Assessed<DeadlinePassedFinding> {
  if (rule === null) return { finding: null, refusedBecause: "no-rule-for-state" };

  const allowedDays = input.submissionChannel === "paper" ? rule.paperDays : rule.electronicDays;
  const daysPastDeadline = input.elapsedDays - allowedDays;
  if (daysPastDeadline <= 0) return { finding: null, refusedBecause: "paid-within-the-statutory-window" };

  return {
    refusedBecause: null,
    finding: {
      kind: "prompt-pay-deadline-passed",
      elapsedDays: input.elapsedDays,
      allowedDays,
      daysPastDeadline,
      estimatedExposure: input.expectedInsurancePays,
      citation: rule.citation,
      source: rule.source,
      verifiedOn: rule.verifiedOn,
      defeasibleBy: rule.defeasibleBy,
      action:
        `Filed ${input.elapsedDays} days ago and the payer has neither paid nor denied it. ${rule.citation} ` +
        `allows ${allowedDays}, so the deadline passed ${daysPastDeadline} days ago and interest has ` +
        `been accruing since — on whatever the payer eventually pays, which is why no amount is ` +
        `claimed here. Chase the claim first; the interest follows the payment. Confirm the plan is ` +
        `insured rather than self-funded before treating the deadline as binding.`,
    },
  };
}
