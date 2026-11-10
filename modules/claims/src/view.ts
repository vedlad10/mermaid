/**
 * View-model builders — combine a persisted claim with the pure read-model engines (filing status,
 * scrub findings, status machine) into the shapes the API/UI consume.
 *
 * These NEVER re-derive money. Every figure shown is read from the claim, which read it from the
 * inherited snapshot. The job here is to answer the two questions a biller actually has: *can I
 * send this?* and *what do I do about it?*
 */
import { addCents, formatUsd, isMaterialVariance, materialityThreshold, subCents, type Cents } from "@mermaid/shared";
import {
  filingStatus,
  FILING_WINDOW_CONFIRM_NOTE,
  FILING_WINDOW_ESTIMATE_NOTE,
  type FilingStatus,
} from "./engine/deadline.ts";
import { preAuthExposure } from "./engine/preauth.ts";
import { ADJUDICATED_STATUSES, isTerminal } from "./engine/status.ts";
import type { Claim, ScrubFinding } from "./types.ts";

/** The full detail payload for one claim (the claim screen). */
export interface ClaimView {
  claim: Claim;
  filing: FilingStatus;
  /** Scrub errors — these block submission. */
  blockers: ScrubFinding[];
  /** Scrub warnings — surfaced at the gate, never blocking. */
  advisories: ScrubFinding[];
  /** Whether the human submit gate may be opened at all. */
  canSubmit: boolean;
  /** Why not, when `canSubmit` is false. */
  submitBlockedReason: string | null;
  /** What the payer has actually paid, across every posting. */
  paidAmount: Cents;
  /** What the payer still owes against the inherited estimate. Zero once settled. */
  outstanding: Cents;
  recommendedAction: string;
  /**
   * How the payment compared with the estimate the patient was quoted from (F-7). Null until a
   * payment arrives — an unanswered claim has no variance, and reporting zero would assert the
   * estimate had been confirmed.
   */
  variance: ClaimVariance | null;
  /**
   * What the patient owes now, and what the contract took off — the other two thirds of the charge.
   *
   * Present on the view because the claim screen's totals block stopped accounting for the whole
   * charge the moment a payment arrived: it swapped "Patient was quoted" out for "Received", so a
   * settled claim read $1,425.00 charged, $799.99 received, and said nothing about where the
   * remaining $625.01 went. Both figures were already on screen, in prose, inside the payments card
   * below — which is not where a biller reconciles.
   *
   * Zero before any payer has ruled. The screen shows the ESTIMATE's figures until then.
   */
  patientResponsibility: Cents;
  contractualAdjustment: Cents;
  /**
   * Money a secondary plan still has to rule on, and whether the patient's share above is therefore
   * provisional.
   *
   * `patientResponsibility` on a coordinated claim is the PRIMARY's view. It is frequently zero and
   * frequently not the final answer, and the screen has to be able to say which.
   */
  coordinationPending: Cents;
  patientShareIsPending: boolean;
  /** 0–100 work-ranking; higher = handle first. */
  priority: number;
}

/** Total the payer has actually paid on this claim, across every posting. */
export const totalPaid = (claim: Claim): Cents => addCents(...claim.payments.map((p) => p.paidAmount));

/**
 * Does this payment RESTATE what the patient owes, or is it silent on the question?
 *
 * A payment that adjudicated the claim carries CAS content — a patient share, a contractual
 * write-off, or both. A supplemental payment that merely settles an appeal award typically carries
 * neither: it moves money to the practice and says nothing about the patient.
 *
 * ── THE SIGNAL THIS *SHOULD* USE ───────────────────────────────────────────────────────────────
 * The correct discriminator is CLP02, the claim status code, which the 835 codec already maps
 * (`x12-835.ts` — 22 is a reversal, 19/20 forwarded, 1–4 adjudicated). `ClaimPayment` does not
 * carry it: the remittance→claims event was never given the field. Adding it is a wider change than
 * this phase, so the rule below reads the adjudication CONTENT instead, which is available and
 * agrees with CLP02 in every case the fixtures produce. That gap is stated rather than papered
 * over, and it is the reason the retraction guard in `patientResponsibilityRetracted` exists.
 */
const adjudicatesPatientResponsibility = (p: Claim["payments"][number]): boolean => {
  /**
   * The payer's own answer, when it travelled with the payment.
   *
   * Remittance derives this from CLP02 and the CAS groups, and the patient ledger has consumed it
   * since M6 — which is why the ledger was right about Pia Phase32's $149.52 and Jack Demo's
   * $136.01 while this function said the patient owed nothing.
   */
  if (p.restatesPatientResponsibility !== undefined) return p.restatesPatientResponsibility;

  /**
   * The legacy fallback, for payments recorded before the flag existed. Kept deliberately, and
   * deliberately narrowed: `contractualAdjustments > 0` used to be enough on its own, and that is
   * precisely what let an appeal-award settlement — which pays a line, so it carries that line's
   * write-off, while saying nothing about the patient — erase a real balance.
   */
  return p.patientResponsibility > 0;
};

/**
 * What the patient owes on this claim, now (L-2).
 *
 * ── WHY NEITHER OBVIOUS ANSWER IS RIGHT ────────────────────────────────────────────────────────
 * This was `payments.at(-1)?.patientResponsibility`, which is correct only while a claim has
 * exactly one posting — true of every claim in the system until appeals started producing corrected
 * remittances. A second posting that settles an award states `patientResponsibility: 0`, because it
 * is paying the practice and re-adjudicating nothing, and `.at(-1)` would report that the patient
 * owes nothing — silently erasing a real balance.
 *
 * Summing is worse: each remittance RESTATES the patient's share rather than adding to it, so two
 * advices each saying $482.51 would bill $965.02.
 *
 * So the figure is SELECTED — the most recent posting that actually adjudicated it — and a payment
 * that is silent leaves the previous answer standing. Erring toward "the patient still owes it" is
 * a mistake a person can find and reverse; erasing a balance is not.
 */
export const totalPatientResponsibility = (claim: Claim): Cents => {
  const adjudicating = claim.payments.filter(adjudicatesPatientResponsibility);
  if (adjudicating.length > 0) return adjudicating[adjudicating.length - 1]!.patientResponsibility;
  return (claim.payments.at(-1)?.patientResponsibility ?? 0) as Cents;
};

/**
 * What the payer's contract took off this claim, now.
 *
 * The same SELECTION rule as `totalPatientResponsibility`, and for the same reason: each advice
 * RESTATES how it split the charge rather than adding to it, so summing two postings that each
 * wrote off $142.50 would report $285.00 against a charge that only ever lost $142.50. Selecting
 * the most recent posting that actually adjudicated keeps the three figures on a settled claim
 * adding up to what was billed.
 */
export const totalContractualAdjustment = (claim: Claim): Cents => {
  const adjudicating = claim.payments.filter(adjudicatesPatientResponsibility);
  if (adjudicating.length > 0) return adjudicating[adjudicating.length - 1]!.contractualAdjustments;
  return (claim.payments.at(-1)?.contractualAdjustments ?? 0) as Cents;
};

/**
 * Money still with ANOTHER payer on this claim — assigned to a secondary's adjudication, or
 * forwarded outright.
 *
 * The same SELECTION rule as its two siblings, and for the same reason: each advice restates how it
 * split the charge rather than adding to it. Selecting keeps the four figures on a coordinated
 * claim adding up to what was billed, and means a later advice that resolves the coordination
 * (because the secondary finally paid) replaces the figure instead of stacking on it.
 */
export const totalCoordinationPending = (claim: Claim): Cents => {
  const adjudicating = claim.payments.filter(adjudicatesPatientResponsibility);
  const source = adjudicating.length > 0 ? adjudicating[adjudicating.length - 1] : claim.payments.at(-1);
  return (source?.coordinationAmount ?? 0) as Cents;
};

/**
 * True when the patient's share on this claim is NOT yet the final answer.
 *
 * ── WHY THIS IS ITS OWN FACT AND NOT AN INFERENCE FROM THE AMOUNT ─────────────────────────────
 * A coordinated claim states `patientResponsibility: 0` on the primary's advice, and zero is a
 * perfectly ordinary answer — a fully covered cleaning states it too. The two are indistinguishable
 * by amount and mean opposite things: one is "the patient owes nothing", the other is "nobody knows
 * yet what the patient owes, because a second plan has not ruled".
 *
 * Reading the first as the second is how a front desk tells a patient they owe nothing and then
 * bills them weeks later. So the screen is given the DISTINCTION rather than the number alone.
 */
export const patientShareIsPending = (claim: Claim): boolean => totalCoordinationPending(claim) > 0;

/**
 * True when the latest posting claims the patient owes nothing but an earlier one said otherwise.
 *
 * Not a silent correction either way: the balance is left standing (see above) and this says so, so
 * a human can confirm whether the payer genuinely re-adjudicated to zero or simply did not mention
 * it. Without CLP02 on the payment, that distinction is not decidable here.
 */
export const patientResponsibilityRetracted = (claim: Claim): boolean => {
  const last = claim.payments.at(-1);
  if (!last || last.patientResponsibility > 0) return false;
  return claim.payments.some((p) => p.patientResponsibility > 0);
};

/** What the payer still owes against the inherited estimate. Zero once settled. */
export const outstanding = (claim: Claim): Cents => {
  if (claim.payments.some((p) => p.settled)) return 0 as Cents;
  return Math.max(0, claim.expectedInsurancePays - totalPaid(claim)) as Cents;
};

function recommendAction(claim: Claim, filing: FilingStatus): string {
  if (claim.status === "void") return `No action needed — this claim was voided${claim.voidReason ? `: ${claim.voidReason}` : "."}`;
  /**
   * ── COORDINATION OUTRANKS EVERY OTHER READING OF THIS CLAIM (M8) ──────────────────────────────
   * Checked before the status branches because it changes what the claim IS, not merely how much of
   * it is outstanding. Kira Demo's coordinated advice lands as `partially_paid`, and that branch
   * said:
   *
   *   "The payer paid $799.99 of an expected $800.00. $0.01 is still outstanding — check the
   *    remittance for the reasons and decide whether to appeal."
   *
   * Three things wrong at once. It reports a penny while saying nothing about the $482.51 sitting
   * with a second plan; it calls that penny "outstanding" when the primary is in fact done; and it
   * proposes an APPEAL, which is the wrong instrument entirely — nothing has been denied, and the
   * money is recovered by filing the secondary claim, not by arguing with the primary.
   */
  const pending = totalCoordinationPending(claim);
  if (pending > 0) {
    return (
      `${formatUsd(pending)} of this claim went to another plan's adjudication — the primary paid ` +
      `${formatUsd(totalPaid(claim))} and is done. File the secondary claim and post its remittance. ` +
      `Nothing is billable to the patient until that plan has ruled, whatever the primary's advice ` +
      `says their share is.`
    );
  }
  if (claim.status === "paid") {
    /**
     * ── "SETTLED" IS ABOUT THE PAYER, AND THE SENTENCE HAS TO SAY SO ─────────────────────────────
     * `paid` means the remittance derived `settled` — "nothing further is expected FROM THIS PAYER
     * on this claim: everything the payer did not pay is explained by contract or by the patient's
     * own balance" (`remittance/service.ts`). It has never meant the claim is finished.
     *
     * Rendered without that qualifier it read as though the money was collected. On a claim where
     * the payer's own advice assigned $1,234.51 to the patient under PR-119 (benefit maximum
     * reached), "No action needed" told a billing team to close the one case where they still had
     * to send a statement — the whole balance, unbilled, on a claim marked done.
     *
     * The payer figure stays exactly as it was: $47.99 IS the correct final payer obligation, and
     * the estimate it fell short of was an estimate. Nothing here recomputes money; this reads a
     * figure the payer stated and declines to omit it.
     */
    const owed = totalPatientResponsibility(claim);
    /**
     * ── "IN FULL" MUST NOT CONTRADICT THE VARIANCE PANEL BELOW IT ────────────────────────────────
     * "Settled in full" is true of the payer's OBLIGATION and says nothing about the ESTIMATE. On
     * Gina Demo the two readings sat eight inches apart on one screen:
     *
     *   recommended action   "it settled its share in full ($47.99)... bill them"
     *   payer vs estimate    "paid $72.01 LESS than the estimate promised... check what they
     *                         were told before billing the difference"
     *
     * Both correct, flatly contradictory to read, and the top line — the one a biller acts on —
     * gave the instruction the panel below it warns against. A patient quoted from an estimate that
     * the payer then undercut is the exact case where billing the difference without checking
     * starts the dispute.
     *
     * The payer figure is untouched: $47.99 IS the correct final payer obligation. This states the
     * shortfall the screen already knew about, and carries the panel's own warning up to the line
     * that gets acted on.
     */
    /**
     * Judged NET of appeal recoveries, the same basis the variance panel uses — otherwise the two
     * disagree in the other direction. Jack Demo was estimated at $175.00 and paid $1,146.49, which
     * gross looks like a $971.49 overpayment and is in fact a $1,125.00 appeal win sitting on top of
     * a primary adjudication that came in $153.51 UNDER estimate. The recommendation must report the
     * same $153.51 the panel does, or the screen contradicts itself in a subtler way than before.
     */
    const netPaid = subCents(totalPaid(claim), appealRecovered(claim));
    const short = subCents(claim.expectedInsurancePays, netPaid);
    const underpaidVsEstimate = short > 0 && isMaterialVariance(short, claim.expectedInsurancePays);

    if (owed > 0) {
      const recovered = appealRecovered(claim);
      return underpaidVsEstimate
        ? `The payer is done: it paid ${formatUsd(totalPaid(claim))}` +
            `${recovered > 0 ? ` (including ${formatUsd(recovered)} won on appeal)` : ""}, which leaves the ` +
            `original adjudication ${formatUsd(short)} short of the ${formatUsd(claim.expectedInsurancePays)} ` +
            `estimated. ${formatUsd(owed)} was assigned to the patient — but they were quoted from that ` +
            `estimate, so check what they were told before billing the difference.`
        : `The payer is done — it settled its share in full (${formatUsd(totalPaid(claim))}). ` +
            `${formatUsd(owed)} was assigned to the patient: bill them, and check the ledger for what is still open.`;
    }
    return underpaidVsEstimate
      ? `The payer is done: it paid ${formatUsd(totalPaid(claim))}, leaving the adjudication ` +
          `${formatUsd(short)} short of the ${formatUsd(claim.expectedInsurancePays)} estimated, and assigned ` +
          `nothing to the patient. The shortfall was absorbed by contract — check the remittance if that is ` +
          `not what you expected.`
      : `No action needed — the payer settled this claim in full (${formatUsd(totalPaid(claim))}).`;
  }
  if (claim.status === "partially_paid") {
    return (
      `The payer paid ${formatUsd(totalPaid(claim))} of an expected ${formatUsd(claim.expectedInsurancePays)}. ` +
      `${formatUsd(outstanding(claim))} is still outstanding — check the remittance for the reasons and decide whether to appeal.`
    );
  }
  if (claim.status === "denied") {
    return `The payer adjudicated this claim and paid nothing. Review the denial reasons on the remittance, then correct and refile, appeal, or write it off.`;
  }
  if (claim.status === "submitted") {
    return `Awaiting the payer. Quote control number ${claim.submission?.controlNumber ?? "—"} on any follow-up.`;
  }
  if (claim.status === "rejected") {
    const first = claim.submission?.message ?? "the payer refused it at intake";
    return `Fix and resubmit — ${first}`;
  }
  if (filing.risk === "expired") {
    // "Write this off" on an unsourced window is the instruction M7 refused to let the scrub gate
    // give. It survived here, where a biller reads it as the recommended action.
    //
    // A sourced window (B-1) names the payer's limit but still stops short of "write this off": the
    // payer published a default, and the practice's contract can allow longer.
    if (filing.source) return `The filing deadline has passed. ${filing.estimateNote} ${FILING_WINDOW_CONFIRM_NOTE}`;
    return filing.estimated
      ? `Mermaid's estimate of the filing deadline has passed. ${FILING_WINDOW_ESTIMATE_NOTE} ${FILING_WINDOW_CONFIRM_NOTE}`
      : "The filing deadline has passed. Write this off, or appeal with proof of timely filing.";
  }
  const blocker = claim.scrub?.findings.find((f) => f.severity === "error");
  if (blocker) return blocker.remediation;
  if (claim.status === "ready") {
    return filing.risk === "urgent"
      ? `Submit today — only ${filing.daysRemaining} day${filing.daysRemaining === 1 ? "" : "s"} left to file.` +
        `${filing.estimateNote ? ` ${filing.estimateNote}` : ""}`
      : `Ready to submit — ${formatUsd(claim.expectedInsurancePays)} expected from the payer.`;
  }
  return "Run the scrubber to check this claim before filing.";
}

function submitBlocker(claim: Claim): string | null {
  if (isTerminal(claim.status)) return `A ${claim.status} claim cannot be submitted.`;
  if (claim.status === "submitted") return "This claim has already been submitted.";
  if (ADJUDICATED_STATUSES.includes(claim.status)) {
    return "The payer has already adjudicated this claim — correct and refile it rather than resubmitting as-is.";
  }
  if (!claim.scrub) return "The claim has not been scrubbed yet.";
  if (!claim.scrub.clean) {
    return `${claim.scrub.errors} blocking issue(s) must be fixed before filing.`;
  }
  return null;
}

/**
 * Work priority. Ranks by what it costs the clinic to leave the claim alone: an expiring deadline
 * outranks a large balance, because a missed deadline is money that can never be recovered while a
 * large claim merely waits.
 */
function priorityOf(claim: Claim, filing: FilingStatus): number {
  if (isTerminal(claim.status) || claim.status === "submitted") return 5;

  // A denial or a shortfall is money already earned and not received — it outranks unfiled work.
  if (claim.status === "denied") return 85;
  if (claim.status === "partially_paid") return outstanding(claim) >= 10_000 ? 75 : 60;

  let priority = claim.status === "rejected" ? 70 : claim.status === "ready" ? 45 : 30;
  if (filing.risk === "expired") priority += 30;
  else if (filing.risk === "urgent") priority += 25;
  else if (filing.risk === "approaching") priority += 10;
  if (claim.expectedInsurancePays >= 50_000) priority += 10; // $500+ at stake
  if (claim.scrub && claim.scrub.errors > 0) priority += 5;
  return Math.max(0, Math.min(100, priority));
}

export function buildClaimView(claim: Claim, now: Date = new Date(), timeZone = "UTC"): ClaimView {
  const filing = filingStatus(claim.filingDeadline, now, timeZone, claim.filingWindowSource ?? null);
  const findings = claim.scrub?.findings ?? [];
  const blocked = submitBlocker(claim);
  return {
    claim,
    filing,
    blockers: findings.filter((f) => f.severity === "error"),
    advisories: findings.filter((f) => f.severity === "warning"),
    canSubmit: blocked === null,
    submitBlockedReason: blocked,
    paidAmount: totalPaid(claim),
    outstanding: outstanding(claim),
    variance: claimVariance(claim, now),
    patientResponsibility: totalPatientResponsibility(claim),
    contractualAdjustment: totalContractualAdjustment(claim),
    coordinationPending: totalCoordinationPending(claim),
    patientShareIsPending: patientShareIsPending(claim),
    recommendedAction: recommendAction(claim, filing),
    priority: priorityOf(claim, filing),
  };
}

/**
 * Does a filing deadline still threaten this claim?
 *
 * Timely filing is about getting the claim TO the payer. Once the payer has it — and certainly once
 * it has ruled — the window is spent and the countdown is history, not risk. `filingStatus` knows
 * only the date, so every screen that read it directly kept counting down on finished work: a paid
 * claim carried a red `expired` badge in the worklist and an "expired" gauge on its own screen.
 *
 * `draft`, `ready` and `rejected` are the states where filing is still the practice's problem — a
 * rejected claim was refused at intake and must be corrected and refiled inside the same window.
 */
export const filingMatters = (claim: Claim): boolean =>
  claim.status === "draft" || claim.status === "ready" || claim.status === "rejected";

/** A compact row for the claims queue. Money fields are integer cents. */
export interface ClaimListItem {
  id: string;
  verificationId: string;
  createdAt: string;
  status: Claim["status"];
  patientName: string;
  payerName: string | null;
  memberId: string;
  serviceDate: string;
  totalFee: number;
  expectedInsurancePays: number;
  expectedPatientPays: number;
  /**
   * What the payer actually assigned this patient, once it has ruled. Zero on an unadjudicated
   * claim, where there is no answer yet rather than an answer of nothing.
   *
   * Selected by `totalPatientResponsibility`, never summed — each advice RESTATES the patient's
   * share rather than adding to it, and a caller re-deriving that would reintroduce the double-bill
   * L-2 fixed.
   */
  patientResponsibility: number;
  /**
   * Money a second plan still has to rule on. A coordinated claim shows no "owed" badge and no
   * denial, so without this the worklist row is silent about the largest number on the claim.
   */
  coordinationPending: Cents;
  /**
   * What a missing or unchecked pre-authorisation would cost on this claim — the sum of its lines'
   * exposure. Carried on the ROW so the Today board can total the practice's exposure without
   * opening every claim.
   */
  preAuthRiskAmount: Cents;
  /**
   * Whether a filing deadline is still a live risk on this claim.
   *
   * `filingStatus` is purely arithmetic on a date, so a claim FILED and PAID a year ago still
   * reports `expired` — and the row rendered a red "expired" badge on finished work. The deadline
   * stops mattering the moment the payer has the claim; saying otherwise trains people to ignore
   * the badge on the claims where it is real.
   */
  filingMatters: boolean;
  filingDeadline: string;
  filingRisk: FilingStatus["risk"];
  daysToFile: number;
  /** True while the deadline above is Mermaid's estimate rather than the payer's stated terms. */
  filingDeadlineEstimated: boolean;
  /** The sentence to show beside it when it is, or null when it is not. */
  filingDeadlineNote: string | null;
  scrubErrors: number;
  scrubWarnings: number;
  canSubmit: boolean;
  /**
   * ── THE THREE RECORDED MILESTONES, ON THE ROW ────────────────────────────────────────────────
   * When the claim went to the payer, what the payer's intake said about it, and when the first
   * dollar landed. All three are already on the claim; none was reachable without opening it.
   *
   * They are here because the Claims screen asks questions no single-status row can answer: how
   * long a claim has been sitting with the payer, what the median time to adjudication is, and how
   * many claims went in clean. A status alone cannot tell you any of that — `paid` says nothing
   * about whether it took four days or ninety, or whether it was rejected twice on the way.
   *
   * Null means the milestone has not happened, which is different from a duration of zero. A caller
   * that treats a missing `submittedAt` as "submitted at the epoch" gets a 20,000-day claim; every
   * consumer here is written to skip rather than substitute.
   */
  submittedAt: string | null;
  /** What the clearinghouse/payer intake said. `rejected` is a claim that came straight back. */
  submissionOutcome: "accepted" | "rejected" | null;
  /**
   * When the FIRST payment posted — the moment the payer stopped deliberating.
   *
   * First, not last: a claim paid once and topped up by an appeal six weeks later adjudicated on
   * the first date. Measuring to the last posting would report the appeal's duration as the
   * payer's, and inflate the practice's own median every time it wins one.
   */
  firstPaidAt: string | null;
  /**
   * When this claim last changed at all — the basis for "how long has it been sitting here".
   *
   * Deliberately NOT called "days in current state": `updatedAt` moves on any write, including ones
   * that do not change the status. It answers "when did this claim last move", which is the honest
   * question and the more useful one on a stuck-claims chart.
   */
  updatedAt: string;
  /** What the payer has actually paid so far. */
  paidAmount: number;
  /** What the payer still owes against the inherited estimate. */
  outstanding: number;
  /**
   * Estimate-vs-actual, for the worklist (F-7). Present on every paid claim so a row can report it
   * when asked; `material` is the gate for drawing attention, because most claims differ by a cent
   * of rounding and a badge that is always lit is one nobody reads.
   */
  variance: ClaimVariance | null;
  recommendedAction: string;
  priority: number;
}

/**
 * The first moment a payer's money landed on this claim, or null if none ever has.
 *
 * Compared as instants rather than as strings: string order is only equivalent to time order when
 * every value carries the same zone suffix, and a value that arrived with an offset (`+05:30`)
 * rather than `Z` would sort into the wrong place silently. An unparseable timestamp is skipped
 * instead of being ranked as NaN.
 */
function earliestPostedAt(claim: Claim): string | null {
  let earliest: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const p of claim.payments) {
    const ms = Date.parse(p.postedAt);
    if (!Number.isFinite(ms) || ms >= earliestMs) continue;
    earliestMs = ms;
    earliest = p.postedAt;
  }
  return earliest;
}

export function buildClaimListItem(claim: Claim, now: Date = new Date()): ClaimListItem {
  const view = buildClaimView(claim, now);
  return {
    id: claim.id,
    verificationId: claim.verificationId,
    createdAt: claim.createdAt,
    status: claim.status,
    patientName: `${claim.patient.firstName} ${claim.patient.lastName}`.trim() || "Unnamed patient",
    payerName: claim.payer.payerName,
    memberId: claim.patient.memberId,
    serviceDate: claim.serviceDate,
    coordinationPending: view.coordinationPending,
    /**
     * Summed over the lines rather than selected: each line carries its own exposure, and a claim
     * with two unauthorised procedures risks both.
     */
    /**
     * Zero once an approval or a waiver is on file. This used to sum the lines unconditionally, so
     * the Today board reported money "at risk · unauthorised" on a claim the submit gate had already
     * cleared with the payer's own authorisation number attached.
     */
    preAuthRiskAmount: preAuthExposure(claim) as Cents,
    filingMatters: filingMatters(claim),
    totalFee: claim.totalFee,
    expectedInsurancePays: claim.expectedInsurancePays,
    expectedPatientPays: claim.expectedPatientPays,
    patientResponsibility: totalPatientResponsibility(claim),
    filingDeadline: claim.filingDeadline,
    filingRisk: view.filing.risk,
    daysToFile: view.filing.daysRemaining,
    filingDeadlineEstimated: view.filing.estimated,
    filingDeadlineNote: view.filing.estimateNote,
    scrubErrors: claim.scrub?.errors ?? 0,
    scrubWarnings: claim.scrub?.warnings ?? 0,
    canSubmit: view.canSubmit,
    submittedAt: claim.submission?.submittedAt ?? null,
    submissionOutcome: claim.submission?.outcome ?? null,
    /*
     * The EARLIEST `postedAt`, not `payments[0]`.
     *
     * Payments are appended in the order remittances arrive, which is normally chronological and is
     * not guaranteed to be: a payer file processed late, or a corrected advice carrying an earlier
     * payment date, lands after a payment it precedes. `[0]` would then report the later date as
     * the moment of adjudication and stretch the practice's median for a claim the payer answered
     * on time. Taking the minimum cannot be wrong, and this figure is read as a payer's speed.
     */
    firstPaidAt: earliestPostedAt(claim),
    updatedAt: claim.updatedAt,
    paidAmount: totalPaid(claim),
    outstanding: outstanding(claim),
    variance: claimVariance(claim, now),
    recommendedAction: view.recommendedAction,
    priority: view.priority,
  };
}

/**
 * What the payer paid, against what the estimate promised (F-7).
 *
 * ── WHY THIS WAS INVISIBLE ─────────────────────────────────────────────────────────────────────
 * The figure has always been computed and stored — `variance_cents` on every posting since the
 * variance engine existed — and no screen read it. So a practice could see that a claim was paid and
 * never learn that the estimate it quoted the patient from was wrong. Gina Demo was quoted against a
 * $120.00 benefit, the payer paid $47.99, and the only surface that mentioned the $72.01 was a
 * column in the database.
 *
 * That is the feedback loop this product is supposed to close. An estimate nobody checks against the
 * payment is a guess repeated forever, and the practice finds out from the patient.
 *
 * ── WHY IT IS NOT SHOWN ON EVERY CLAIM ─────────────────────────────────────────────────────────
 * Because most claims differ by a cent of pro-rata rounding, and a badge that is always lit is one
 * staff stop reading — the same reasoning that produced the materiality band. `material` is the gate
 * a surface should use to decide whether to draw attention; the amount is reported either way, so a
 * detail screen can still answer "how close were we?" when somebody asks.
 */
/** Cash recovered on appeal across every denial on this claim. */
export const appealRecovered = (claim: Claim): Cents =>
  addCents(...(claim.appealRecoveries ?? []).map((r) => r.settledAmount));

export interface ClaimVariance {
  /** What the inherited estimate said insurance would pay. */
  expected: Cents;
  /** What the payer actually paid, across every posting. */
  paid: Cents;
  /** `paid − expected`. Negative means the payer paid less than the estimate promised. */
  variance: Cents;
  /**
   * How much of the variance is cash won on appeal — money with a known cause, so not a surprise.
   * Zero on the overwhelming majority of claims, which never had a denial in the first place.
   */
  appealRecovered: Cents;
  /** `variance − appealRecovered`: the part nobody has accounted for. Materiality judges THIS. */
  unexplained: Cents;
  /** Whether the unexplained part crossed the materiality band — the gate for showing a badge. */
  material: boolean;
  /** The band it was measured against, so a number on screen can explain itself. */
  threshold: Cents;
  /** Plain English, for the surfaces that show a sentence rather than a figure. */
  summary: string;
}

/**
 * Build the estimate-vs-actual block for a claim, or null when there is nothing to compare.
 *
 * Null until a payment arrives, deliberately: a variance against no payment is not zero, it is
 * unknown, and rendering "$0.00 difference" on an unpaid claim would assert the estimate had been
 * confirmed by a payer who has not yet answered.
 */
export function claimVariance(claim: Claim, now: Date = new Date()): ClaimVariance | null {
  if (claim.payments.length === 0) return null;

  const expected = claim.expectedInsurancePays;
  const paid = totalPaid(claim);
  const variance = subCents(paid, expected);

  /**
   * Money won on appeal is EXPLAINED, so it is removed before the variance is judged.
   *
   * The claim that forced this: estimated at $175.00, paid $1,146.49, because a $1,250.00 crown the
   * estimate had at zero coverage was denied, appealed, and won. Judged gross, that is a $971.49
   * overpayment and the system told the biller to check for a duplicate or a takeback — about money
   * the practice fought for. Judged net, the real signal appears: the primary adjudication came in
   * $153.51 UNDER estimate, which is an estimate error worth knowing about and was completely hidden
   * behind the recovery.
   *
   * Subtracted rather than added to `expected` on purpose. The estimate was what it was; rewriting it
   * after the fact to match what arrived would make every estimate look accurate in hindsight, which
   * is the one thing this metric exists to prevent.
   */
  const recovered = appealRecovered(claim);
  const unexplained = subCents(variance, recovered);

  const material = isMaterialVariance(unexplained, expected);
  const threshold = materialityThreshold(expected);

  const recoveryNote = recovered > 0 ? ` ${formatUsd(recovered)} of that was recovered on appeal.` : "";

  const summary = !material
    ? recovered > 0
      ? `The payer paid ${formatUsd(paid)} against an estimate of ${formatUsd(expected)}.` +
        `${recoveryNote} Net of the recovery, the adjudication matched the estimate.`
      : `The payer paid ${formatUsd(paid)} against an estimate of ${formatUsd(expected)} — as expected.`
    : unexplained < 0
      ? `The payer paid ${formatUsd(Math.abs(unexplained) as Cents)} LESS than the estimate promised` +
        `${recovered > 0 ? `, after allowing for ${formatUsd(recovered)} recovered on appeal` : ""}: ` +
        `${formatUsd(paid)} against ${formatUsd(expected)}. Whatever the reason, the patient was quoted ` +
        `from the estimate, so check what they were told before billing the difference.`
      : `The payer paid ${formatUsd(unexplained)} MORE than the estimate promised: ${formatUsd(paid)} ` +
        `against ${formatUsd(expected)}.${recoveryNote} Confirm the rest is not a duplicate or a ` +
        `takeback waiting to happen.`;

  void now;
  return { expected, paid, variance, appealRecovered: recovered, unexplained, material, threshold, summary };
}
