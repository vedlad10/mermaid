/**
 * The silent-claim watchdog (F4) — claims that got no answer, and are therefore in nobody's queue.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────────
 * `OPEN_STATUSES` — what the working queue shows, and what `sweepFilingRisk` sweeps — is
 * `draft, ready, rejected, partially_paid, denied`. `submitted` is deliberately absent, on the
 * reasoning that a filed claim is with the payer and there is nothing for the clinic to do.
 *
 * That reasoning holds for exactly as long as the payer answers. When it does not, `submitted` is
 * the one status where doing nothing costs the whole claim, and it is the one status no sweep in
 * this system looks at. A claim that was filed and simply never came back is invisible: it is not
 * in the queue, it raises no filing-risk escalation (the sweep skips it), it appears in no denial
 * worklist because nobody denied it, and it ages quietly past its filing deadline. The first
 * evidence a practice gets is a payer refusing it as untimely, months later, by which point the
 * defence — proof of timely filing — is the only thing left and usually was never kept.
 *
 * ── SILENCE IS NOT DENIAL, AND THE DIFFERENCE IS THE REMEDY ────────────────────────────────────
 * A DENIAL is an adjudication: the payer looked at the claim and said no. It has a reason code, it
 * belongs to the denials module, and it is worked by appeal or correction.
 *
 * Silence is the absence of adjudication, and this engine splits it three ways because the three
 * have completely different next actions and doing the wrong one costs money:
 *
 *   unacknowledged      Filed, and nothing ever acknowledged receiving it. The likeliest truth is
 *                       that the payer does not have it. REFILE — and because nothing was ever
 *                       received, there is no duplicate to create.
 *   stalled             Acknowledged by the clearinghouse or payer, then nothing. It IS in the
 *                       payer's system and sitting somewhere. CALL, quoting the control number.
 *                       Refiling this one manufactures the CO-18 duplicate denial that the
 *                       replacement gate exists to prevent.
 *   rejected-not-refiled  The payer refused it AT INTAKE — it never reached adjudication, so it is
 *                       not a denial and there is nothing to appeal. It has to be corrected and
 *                       refiled, and the timely-filing clock never stopped running, because from
 *                       the payer's point of view the claim was never filed at all.
 *
 * The last is the quietest and the most expensive. `rejected` IS in `OPEN_STATUSES`, so such a
 * claim is technically in the queue — but it looks like an ordinary piece of work rather than a
 * claim whose deadline is running against a filing that does not count.
 *
 * ── WHAT THIS ENGINE IS NOT ALLOWED TO CLAIM ───────────────────────────────────────────────────
 * It does not assert that a payer is LATE. Lateness against a statutory deadline is F5's, computed
 * from verified law, and a practice that confuses "our operational threshold elapsed" with "the
 * statute was breached" writes a demand letter it cannot support. The thresholds below are answers
 * to "how long before a human should look at this", nothing more, and they are stated as that.
 *
 * Pure and deterministic: no I/O, no clock of its own. `now` and the practice timezone are passed
 * in, because "how many days has this been silent" compares calendar days and today is a fact about
 * where the clinic is.
 */
import { daysBetween, calendarDay, type Cents, type TimeZone } from "@mermaid/shared";
import { filingStatus, type FilingStatus } from "./deadline.ts";
import type { ClaimStatus, FilingRisk } from "../types.ts";

/**
 * Days after filing with NO acknowledgement before a claim is treated as possibly never received.
 *
 * A clearinghouse returns a 999 within minutes and a payer's 277CA normally within one to three
 * business days. Seven calendar days covers a filing that straddles a weekend and a holiday and
 * still leaves the great majority of a 90-day filing window to refile in — which is the number that
 * actually matters, since the whole point is to act while refiling is still possible.
 */
export const UNACKNOWLEDGED_DAYS = 7;

/**
 * Days after ACKNOWLEDGED receipt with no adjudication before a claim is treated as stuck.
 *
 * Thirty is the ordinary outer edge of dental adjudication and the figure most prompt-pay statutes
 * are written around — which is why it is a sensible moment for a human to look, and emphatically
 * NOT an assertion that anything unlawful has happened. F5 makes that assertion, from verified law,
 * per state. This one just says the claim has been quiet long enough to be worth a phone call.
 */
export const STALLED_DAYS = 30;

/**
 * Days a claim may sit REJECTED before the silence is the practice's own.
 *
 * Shorter than the others deliberately. The payer has already answered and the ball is here; every
 * day counts against a filing window that, from the payer's side, has never been stopped.
 */
export const REJECTED_IDLE_DAYS = 5;

export type SilenceCategory = "unacknowledged" | "stalled" | "rejected-not-refiled";

/** Why no finding was raised. Recorded rather than returned as a bare null — see `assessSilence`. */
export type SilenceRefusal =
  | "not-a-silent-status"
  | "the-payer-already-answered"
  | "never-filed"
  | "too-soon-to-chase";

/**
 * What the sweep has already escalated for a claim.
 *
 * Both halves, because either can worsen independently: a claim can stay `unacknowledged` while its
 * filing risk goes from approaching to urgent, and an alert that only fired on the category would
 * go quiet exactly as the deadline closed in.
 */
export interface SilenceEscalation {
  category: SilenceCategory;
  risk: FilingRisk;
}

export interface SilenceInput {
  status: ClaimStatus;
  /** Null when the claim was never filed — a draft has nothing to be silent about. */
  submission: {
    /** When it was filed, or for a rejected claim, when the refusal was recorded. */
    submittedAt: string;
    outcome: "accepted" | "rejected";
    /**
     * The payer's or clearinghouse's own control number.
     *
     * Empty is the case that matters: `submit` records a submission even when the acknowledgement
     * carried no identifier, and an acknowledgement that names nothing is not evidence the claim
     * reached anybody. Treating it as receipt is what turns an unacknowledged claim — refile it —
     * into a stalled one — do not refile it.
     */
    controlNumber: string;
  } | null;
  filingDeadline: string;
  expectedInsurancePays: Cents;
  /**
   * Whether any money has posted against this claim.
   *
   * A belt-and-braces guard rather than a rule: a claim with a payment should not be in `submitted`
   * at all. If it is, the answer arrived and the status is what is wrong — and telling a biller to
   * chase a payer that has already paid is how a watchdog teaches people to ignore it.
   */
  hasPayment: boolean;
}

export interface SilenceFinding {
  category: SilenceCategory;
  /** Calendar days since the claim was filed, or since the rejection was recorded. */
  daysSilent: number;
  /** The timely-filing picture, computed by the same engine every other surface uses. */
  filing: FilingStatus;
  /** What is at stake — the inherited estimate, not a figure this engine invents. */
  amountAtRisk: Cents;
  /** What a person should actually do, and why it differs per category. */
  action: string;
}

export interface Assessed {
  finding: SilenceFinding | null;
  refusedBecause: SilenceRefusal | null;
}

const acknowledged = (submission: NonNullable<SilenceInput["submission"]>): boolean =>
  submission.outcome === "accepted" && submission.controlNumber.trim() !== "";

/**
 * The calendar day the claim was FILED, in the practice's own timezone.
 *
 * ── WHY THIS IS NOT `submittedAt.slice(0, 10)` ────────────────────────────────────────────────
 * `ClaimSubmission.submittedAt` is an INSTANT (`now.toISOString()`), so slicing it takes the day in
 * UTC — while the other half of the same finding, `filingStatus`, counts in the PRACTICE's zone.
 * One finding, two calendars.
 *
 * For every US practice the UTC instant of an afternoon filing lands on the following UTC day, so
 * the silence was being understated by one: a Los Angeles claim filed 19:00 on the 31st was dated
 * the 1st, and a claim genuinely silent for seven days reported six. The watchdog chased every
 * claim a day late, and at the thresholds that is the difference between acting and not acting.
 *
 * This is the same defect `filingStatus` carries a long comment about having already been fixed
 * for, arrived at from the other direction — there the END of the count was wrong, here it was the
 * START.
 *
 * A date-only string is already a calendar day and is passed through untouched: reading "2026-08-01"
 * as an instant would place it at UTC midnight and then shift it backwards into July for every
 * practice west of Greenwich, which is this same bug with the sign flipped.
 */
const filedOn = (submittedAt: string, timeZone: TimeZone): string =>
  submittedAt.length <= 10 ? submittedAt : calendarDay(new Date(submittedAt), timeZone);

/**
 * Has this claim gone quiet, and in which of the three ways?
 *
 * The order of the refusals is the order in which they make the question moot.
 */
export function assessSilence(input: SilenceInput, now: Date, timeZone: TimeZone = "UTC"): Assessed {
  /**
   * Only two statuses can be silent, and the exclusions are the point of the feature.
   *
   * `denied`, `paid` and `partially_paid` are ANSWERS — the payer adjudicated, and a denial in
   * particular belongs to the denials module with a reason code and an appeal path. Reporting one
   * here would put the same claim in two worklists under two different remedies, which is worse
   * than reporting neither. `draft` and `ready` were never filed, and `void` was withdrawn.
   */
  if (input.status !== "submitted" && input.status !== "rejected") {
    return { finding: null, refusedBecause: "not-a-silent-status" };
  }
  if (input.hasPayment) return { finding: null, refusedBecause: "the-payer-already-answered" };
  if (!input.submission) return { finding: null, refusedBecause: "never-filed" };

  const daysSilent = daysBetween(filedOn(input.submission.submittedAt, timeZone), calendarDay(now, timeZone));
  const filing = filingStatus(input.filingDeadline, now, timeZone);

  const category = categorize(input, daysSilent);
  if (category === null) return { finding: null, refusedBecause: "too-soon-to-chase" };

  return {
    refusedBecause: null,
    finding: {
      category,
      daysSilent,
      filing,
      amountAtRisk: input.expectedInsurancePays,
      action: ACTIONS[category](daysSilent, input.submission.controlNumber, filing),
    },
  };
}

function categorize(input: SilenceInput, daysSilent: number): SilenceCategory | null {
  if (input.status === "rejected") {
    return daysSilent >= REJECTED_IDLE_DAYS ? "rejected-not-refiled" : null;
  }
  if (!acknowledged(input.submission!)) {
    return daysSilent >= UNACKNOWLEDGED_DAYS ? "unacknowledged" : null;
  }
  return daysSilent >= STALLED_DAYS ? "stalled" : null;
}

const deadlineClause = (filing: FilingStatus): string =>
  filing.risk === "expired"
    ? ` ${filing.message}`
    : ` ${filing.daysRemaining} days remain to refile.${filing.estimateNote ? ` ${filing.estimateNote}` : ""}`;

const ACTIONS: Record<SilenceCategory, (days: number, controlNumber: string, filing: FilingStatus) => string> = {
  unacknowledged: (days, _control, filing) =>
    `Filed ${days} days ago and nothing has acknowledged receiving it, so the likeliest truth is that ` +
    `the payer does not have it. Confirm with the clearinghouse, then refile — there is no ` +
    `acknowledged claim for a refiling to duplicate.${deadlineClause(filing)}`,

  stalled: (days, control, filing) =>
    `Acknowledged as received${control.trim() ? ` under ${control.trim()}` : ""} and then silent for ` +
    `${days} days, so it IS in the payer's system. Call the payer and quote that number. Do not ` +
    `refile: this claim was received, and a second copy of a received claim comes back as a ` +
    `duplicate denial.${deadlineClause(filing)}`,

  /**
   * The wording here carries the whole distinction the category exists for. A biller who reads
   * "rejected" as "denied" looks for an appeal path, finds none, and the claim sits — while the
   * filing clock runs against a submission the payer does not count as having happened.
   */
  "rejected-not-refiled": (days, _control, filing) =>
    `Refused at intake ${days} days ago, which is NOT a denial — it never reached adjudication, so ` +
    `there is nothing to appeal. Correct what the rejection named and refile. The payer does not ` +
    `count the original filing, so the timely-filing clock never stopped.${deadlineClause(filing)}`,
};

/** Ordering for "which of these is worst", worst first. */
const RISK_ORDER: Record<FilingRisk, number> = { safe: 0, approaching: 1, urgent: 2, expired: 3 };

/**
 * Should the sweep speak again about a claim it has already raised?
 *
 * Only when something got worse. An alert that fires on every sweep is an alert staff learn to
 * scroll past, and the claims most likely to be scrolled past are the oldest — which are exactly
 * the ones this feature exists for. The same reasoning, and the same shape, as `filingRiskRaised`.
 */
export function silenceWorsened(raised: SilenceEscalation | null | undefined, next: SilenceEscalation): boolean {
  if (!raised) return true;
  if (raised.category !== next.category) return true;
  return RISK_ORDER[next.risk] > RISK_ORDER[raised.risk];
}

/**
 * Rank silent claims the way a biller should work them.
 *
 * Timely-filing risk first, and by a distance: a stalled claim worth $2,000 with eight months left
 * is a phone call, while an unacknowledged claim worth $200 with nine days left is money about to
 * stop existing. Sorting by amount — the instinct — inverts exactly that.
 *
 * Then longest silent, then largest. Amount is the LAST key rather than the first, and ties break
 * on the claim id so the order is total and a queue does not reshuffle between reads.
 */
export function rankBySilenceUrgency<T extends { id: string; finding: SilenceFinding }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const risk = RISK_ORDER[b.finding.filing.risk] - RISK_ORDER[a.finding.filing.risk];
    if (risk !== 0) return risk;
    const days = b.finding.daysSilent - a.finding.daysSilent;
    if (days !== 0) return days;
    const amount = b.finding.amountAtRisk - a.finding.amountAtRisk;
    if (amount !== 0) return amount;
    return a.id.localeCompare(b.id);
  });
}
