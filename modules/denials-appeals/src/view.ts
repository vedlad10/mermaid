/**
 * View-model builders for the recovery worklist.
 *
 * The job here is to answer the question a biller opens this screen with: *what should I work next,
 * and what exactly do I do about it?* Everything is read from the denial — the triage was frozen at
 * decision time and is never recomputed for display, or the reasoning behind an old decision would
 * silently change.
 */
import { calendarDay, daysBetween, formatUsd, type Cents } from "@mermaid/shared";
import { AWARD_OPEN_STATUSES, awardAgeDays, awardOutstanding, awardUrgency } from "./engine/award.ts";
import {
  ASSUMED_APPEAL_WINDOW_LABEL,
  appealWindowNote,
  CLOSED_DENIAL_STATUSES,
  OPEN_DENIAL_STATUSES,
  type Appeal,
  type Denial,
  type Triage,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AppealWindow = "safe" | "approaching" | "urgent" | "closed";

/** Re-exported so display code can reach the label without importing the type module. */
export { ASSUMED_APPEAL_WINDOW_LABEL };

export interface DenialView {
  denial: Denial;
  /** The appeal currently in play, if any. */
  activeAppeal: Appeal | null;
  /** How close the appeal window is to closing. */
  appealWindow: AppealWindow;
  daysToAppeal: number | null;
  /**
   * True when `appealDeadline` came from the default window, not the payer's catalogued terms.
   * Absent on the denial (a record written before this was tracked) reads as `false` HERE only in
   * the sense that no claim is made — `deadlineNote` is null and no surface asserts provenance.
   */
  deadlineEstimated: boolean;
  /**
   * The biller-facing caveat for this deadline, or null when there is nothing to caveat.
   *
   * Non-null in BOTH cases while `APPEAL_WINDOWS_ARE_PAYER_SOURCED` is false — the wording differs
   * (a default nobody stated versus a typical per-payer figure) but neither is the payer's word.
   * Null only when there is no deadline at all, or once the windows are genuinely payer-sourced.
   */
  deadlineNote: string | null;
  /**
   * True when the payer's own document stands behind the deadline's window (B-1). The screen needs
   * it as a separate fact: `deadlineNote` is non-null for a sourced window too — it still carries
   * the contract caveat — so "has a note" can no longer be read as "is an estimate".
   */
  deadlineSourced: boolean;
  /** Whether an appeal may be drafted right now. */
  canDraft: boolean;
  /** Whether a human may approve the drafted appeal. */
  canApprove: boolean;
  /** Whether an approved appeal may be sent. */
  canSubmit: boolean;
  /** Why the next step is unavailable, when it is. */
  blockedReason: string | null;
  recommendedAction: string;
  open: boolean;
  /**
   * Cash actually recovered, or null until a posting settles the award.
   *
   * ── WHY THE VIEW CARRIES IT AND THE RAW DENIAL DOES NOT ─────────────────────────────────────
   * A win is recorded as an AWARD (`awardedAmount`), and the cash lands later as
   * `awardSettledAmount`; `recoveredAmount` on the record itself stays null for anything written
   * since awards existed, and survives only for rows that predate them. The list item already knew
   * to read `awardSettledAmount ?? recoveredAmount`. The detail view did not — it handed the client
   * the raw denial, so the recovery tile on a RECOVERED denial read `null` and rendered an em dash.
   *
   * On staging that meant Pia Phase32's screen showed "Denied $1,125.00 · Expected back $409.50 ·
   * Recovered —", above a recommendation reading "Recovered $1,125.00 — the money arrived and was
   * posted", above an audit trail saying the same. The tiles said the opposite of the sentences.
   *
   * One rule, on the view both surfaces are built from, so they cannot disagree again.
   */
  recoveredAmount: number | null;
  /** What the payer AGREED to pay on appeal. Workflow, not money in the bank. */
  awardedAmount: number | null;
}

function appealWindowOf(deadline: string | null, now: Date, timeZone = "UTC"): { window: AppealWindow; days: number | null } {
  if (!deadline) return { window: "safe", days: null };
  const days = daysBetween(calendarDay(now, timeZone), deadline);
  if (days < 0) return { window: "closed", days };
  if (days <= 7) return { window: "urgent", days };
  if (days <= 30) return { window: "approaching", days };
  return { window: "safe", days };
}

function recommend(
  denial: Denial,
  activeAppeal: Appeal | null,
  window: AppealWindow,
  days: number | null,
  /**
   * Appended wherever this sentence ASSERTS the deadline — the urgent countdown and the closed
   * window. Both otherwise read as the payer's own stated terms, which no window in this system
   * currently is: an uncatalogued payer gets Mermaid's default, and a catalogued one gets a seeded
   * typical figure. The same string the view carries, so the two cannot drift apart.
   */
  deadlineNote: string | null,
  /** Needed for award age — the awaiting-payment sentence quotes how long the wait has been. */
  now: Date
): string {
  const assumed = deadlineNote ? ` ${deadlineNote}` : "";
  if (denial.status === "recovered") {
    const cash = denial.awardSettledAmount ?? denial.recoveredAmount ?? (0 as Cents);
    return `Recovered ${formatUsd(cash)} — the money arrived and was posted. Nothing further to do.`;
  }
  /**
   * The two states that did not exist before F-2. Both are OPEN, and both say plainly that the
   * money has been AGREED and not RECEIVED — the distinction the old "Recovered $1,125.00" wording
   * erased on a claim where $21.49 had actually been collected.
   *
   * The age is quoted, never a due date: no payer publishes a corrected-remittance turnaround, so
   * the follow-up timing is the practice's policy and is worded as such.
   */
  if (denial.status === "awaiting_payment" || denial.status === "partially_recovered") {
    const outstanding = awardOutstanding(denial);
    const age = awardAgeDays(denial, now);
    const { band } = awardUrgency(age);
    const waited = denial.awardedAt ? ` Won ${age} day${age === 1 ? "" : "s"} ago.` : "";
    const settled = denial.awardSettledAmount ?? (0 as Cents);
    const part = settled > 0 ? ` ${formatUsd(settled)} of it has arrived.` : "";
    const chase =
      band === "escalate"
        ? ` Escalate or re-appeal with ${denial.payerName}.`
        : band === "overdue"
          ? ` Follow up with ${denial.payerName}.`
          : band === "chase"
            ? " Worth chasing."
            : "";
    return `${denial.payerName} agreed to pay ${formatUsd(denial.awardedAmount ?? (0 as Cents))} on appeal.${part} ${formatUsd(outstanding)} is still owed.${waited}${chase}`;
  }
  if (denial.status === "written_off") return `Written off${denial.closeReason ? `: ${denial.closeReason}` : "."}`;
  if (denial.status === "patient_billed") {
    return `Moved to the patient's balance${denial.closeReason ? `: ${denial.closeReason}` : "."}`;
  }
  if (activeAppeal?.status === "submitted") {
    return `Level-${activeAppeal.level} appeal is with ${denial.payerName}. Record the outcome when they respond — that is what teaches the next triage.`;
  }
  if (activeAppeal?.status === "draft") {
    return activeAppeal.approvedBy
      ? "Approved and ready to send."
      : `Gather the ${activeAppeal.checklist.length} evidence items, then approve to send. Nothing goes to the payer until a person signs off.`;
  }
  if (window === "closed") {
    return `The appeal window has closed. Write this off, or check whether the payer allows a late review.${assumed}`;
  }

  const triage = denial.triage;
  const urgency =
    window === "urgent" && days !== null
      ? ` Only ${days} day${days === 1 ? "" : "s"} left to appeal.${assumed}`
      : "";

  switch (triage.disposition) {
    case "correct_resubmit":
      return `${triage.recommendedAction}${urgency}`;
    case "appeal":
      return `${triage.recommendedAction} Expected recovery ${formatUsd(triage.expectedRecovery)} at ${Math.round(triage.overturnRate * 100)}% odds.${urgency}`;
    case "patient_resp":
      return `${triage.recommendedAction} The payer owes nothing here.`;
    case "verify_writeoff":
      return `${triage.recommendedAction}`;
    default:
      return "A contractual adjustment — post it and move on.";
  }
}

export function buildDenialView(denial: Denial, now: Date = new Date(), timeZone = "UTC"): DenialView {
  const activeAppeal =
    denial.appeals.find((a) => a.status === "draft" || a.status === "submitted") ?? null;
  const { window, days } = appealWindowOf(denial.appealDeadline, now, timeZone);
  const open = OPEN_DENIAL_STATUSES.includes(denial.status);

  const pursuable =
    denial.triage.disposition === "appeal" || denial.triage.disposition === "correct_resubmit";

  let blockedReason: string | null = null;
  if (!open) blockedReason = `This denial is already ${denial.status.replace(/_/g, " ")}.`;
  else if (activeAppeal) blockedReason = `A level-${activeAppeal.level} appeal is already open.`;
  else if (!pursuable) {
    blockedReason = `The playbook says to ${denial.triage.disposition.replace(/_/g, " ")} this, not to appeal.`;
  } else if (window === "closed") blockedReason = "The appeal window has closed.";

  // Only an explicit `true` claims the deadline was assumed. Absent means nobody recorded which
  // window produced it, and inventing an answer either way is the defect this flag exists to close.
  const deadlineEstimated = denial.appealDeadlineEstimated === true;
  /**
   * Both cases now carry a caveat. `deadlineEstimated` still means exactly what it meant — the date
   * came from Mermaid's default rather than a catalogued window — but a catalogued window is a
   * typical figure too, not this payer's stated terms, for as long as
   * `APPEAL_WINDOWS_ARE_PAYER_SOURCED` is false. The flag says WHICH kind; the note says neither is
   * the payer's word.
   */
  const deadlineNote = denial.appealDeadline
    ? appealWindowNote(deadlineEstimated, denial.appealWindowDays, denial.appealWindowSource ?? null)
    : null;

  return {
    denial,
    activeAppeal,
    appealWindow: window,
    daysToAppeal: days,
    deadlineEstimated,
    deadlineNote,
    deadlineSourced: Boolean(denial.appealDeadline && denial.appealWindowSource),
    canDraft: open && !activeAppeal && pursuable && window !== "closed",
    canApprove: activeAppeal?.status === "draft" && !activeAppeal.approvedBy,
    canSubmit: activeAppeal?.status === "draft" && Boolean(activeAppeal.approvedBy),
    blockedReason,
    recommendedAction: recommend(denial, activeAppeal, window, days, deadlineNote, now),
    open,
    /** Cash first, then the pre-award field for rows written before awards existed. */
    recoveredAmount: denial.awardSettledAmount ?? denial.recoveredAmount ?? null,
    awardedAmount: denial.awardedAmount ?? null,
  };
}

/** A compact row for the recovery worklist. Money fields are integer cents. */
export interface DenialListItem {
  id: string;
  claimId: string;
  detectedAt: string;
  status: Denial["status"];
  patientName: string;
  payerName: string;
  carcCode: string;
  carcDescription: string;
  procedureCode: string | null;
  deniedAmount: number;
  expectedRecovery: number;
  overturnRate: number;
  trusted: boolean;
  /**
   * How many prior appeals the overturn rate above was computed from, and where the rate came from.
   *
   * ── WHY A RATE WITHOUT THESE IS NOT SHOWABLE ─────────────────────────────────────────────────
   * "68%" and "68% — from 42 similar appeals with this payer" are different claims, and the second
   * is the only one a person can weigh. `trusted` already says whether the sample was big enough to
   * lean on, but a boolean cannot be written next to a percentage in the sentence §4.4 requires; it
   * can only decide whether to suppress. Both figures are on the triage snapshot already and
   * neither was reachable from a list row, so a screen ranking denials by winnability had to either
   * state the rate bare or open every record.
   */
  sampleSize: number;
  /** `payer-learned` is this payer's own history; the rest are progressively wider fallbacks. */
  triageSource: Triage["source"];
  disposition: string;
  appealDeadline: string | null;
  daysToAppeal: number | null;
  appealWindow: AppealWindow;
  /** True when the deadline above came from Mermaid's default, not the payer's catalogued window. */
  deadlineEstimated: boolean;
  /** The biller-facing sentence for that, or null when the payer's own terms were used. */
  deadlineNote: string | null;
  appealStatus: Appeal["status"] | null;
  /**
   * Cash recovered. Null until a posting settles the award — a person recording a win does not
   * move this, and that separation is the whole of F-2.
   */
  recoveredAmount: number | null;
  /** What the payer AGREED to pay on appeal. Workflow, not money in the bank. */
  awardedAmount: number | null;
  /** How much of that award has actually arrived and been posted. */
  awardSettledAmount: number | null;
  /** The receivable: awarded − settled. What the payer still owes on a won appeal. */
  awardOutstanding: number;
  /** Days since the win was recorded. There is no payer-stated due date, so age is what we have. */
  awardAgeDays: number | null;
  /**
   * When the payer AGREED to pay on appeal, or null if it has not.
   *
   * Exposed for the activity feed, which needs a real instant for the event it names. It had been
   * emitting "appeal won" stamped with the DENIAL's timestamp — the only one the row carried —
   * which put a fabricated time on a real event and sorted the win alongside the refusal it
   * reversed. A feed whose timestamps are wrong is worse than no feed.
   */
  awardedAt: string | null;
  recommendedAction: string;
  priority: number;
}

export function buildDenialListItem(denial: Denial, now: Date = new Date(), timeZone = "UTC"): DenialListItem {
  // The timezone MUST travel: this call dropped it, so every worklist row computed its appeal
  // window against the UTC day — and from late afternoon on, a US practice's "due today" read as
  // "closed", telling a biller to abandon an appeal that was still filable for hours.
  const view = buildDenialView(denial, now, timeZone);
  return {
    id: denial.id,
    claimId: denial.claimId,
    detectedAt: denial.detectedAt,
    status: denial.status,
    patientName: denial.patientName,
    payerName: denial.payerName,
    carcCode: denial.carcCode,
    carcDescription: denial.carcDescription,
    procedureCode: denial.procedureCode,
    deniedAmount: denial.deniedAmount,
    // Direct reads: `triage` is non-nullable (B3). These carried `?? 0` / `?? false` for a state
    // that has never existed, which rendered "0% odds" for a case that cannot occur.
    // Direct reads: `triage` is non-nullable (B3). These carried `?? 0` / `?? false` for a state
    // that has never existed, which rendered "0% odds" for a case that cannot occur.
    expectedRecovery: denial.triage.expectedRecovery,
    overturnRate: denial.triage.overturnRate,
    trusted: denial.triage.trusted,
    sampleSize: denial.triage.sampleSize,
    triageSource: denial.triage.source,
    disposition: denial.triage.disposition,
    appealDeadline: denial.appealDeadline,
    daysToAppeal: view.daysToAppeal,
    deadlineEstimated: view.deadlineEstimated,
    deadlineNote: view.deadlineNote,
    appealWindow: view.appealWindow,
    appealStatus: view.activeAppeal?.status ?? null,
    /**
     * Cash first, then the pre-award field for rows written before awards existed. Never
     * `awardedAmount` — a worklist row that reported the promise as recovered money is the exact
     * defect F-2 was raised for.
     */
    recoveredAmount: view.recoveredAmount,
    awardedAmount: view.awardedAmount,
    awardSettledAmount: denial.awardSettledAmount ?? null,
    awardOutstanding: awardOutstanding(denial),
    awardAgeDays: denial.awardedAt ? awardAgeDays(denial, now) : null,
    awardedAt: denial.awardedAt ?? null,
    recommendedAction: view.recommendedAction,
    priority: denial.priority,
  };
}

/**
 * Recovery scoreboard — what the queue is actually worth, and how the practice is doing at working
 * it. The `recoveryRate` is the number a practice owner cares about: of the money we chased, how
 * much came back?
 */
export interface RecoveryStats {
  openCount: number;
  openDenied: number;
  openExpectedRecovery: number;
  /** Denials whose CASH arrived and was posted. */
  recoveredCount: number;
  /**
   * Cash actually collected — never a figure a person recorded.
   *
   * ── WHY THIS NUMBER USED TO BE WRONG (F-2) ────────────────────────────────────────────────────
   * It summed `recoveredAmount` the moment a human recorded a win, so the scoreboard reported money
   * that had not arrived and might never. Cash and promises now have separate counters, and the
   * ratio between them — `awardedAwaitingPayment` against this — is the figure that would have made
   * the original defect obvious from the dashboard.
   */
  recoveredAmount: number;
  /** Denials the payer has agreed to pay and has not yet paid. OPEN work, not revenue. */
  awaitingPaymentCount: number;
  /** The receivable those awards represent: awarded minus whatever cash has settled against it. */
  awardedAwaitingPayment: number;
  writtenOffCount: number;
  writtenOffAmount: number;
  /** Recovered ÷ (recovered + written off), 0–1. Null until something has closed. */
  recoveryRate: number | null;
  urgentCount: number;
}

export function buildRecoveryStats(denials: Denial[], now: Date = new Date(), timeZone = "UTC"): RecoveryStats {
  const stats: RecoveryStats = {
    openCount: 0,
    openDenied: 0,
    openExpectedRecovery: 0,
    recoveredCount: 0,
    recoveredAmount: 0,
    awaitingPaymentCount: 0,
    awardedAwaitingPayment: 0,
    writtenOffCount: 0,
    writtenOffAmount: 0,
    recoveryRate: null,
    urgentCount: 0,
  };

  for (const denial of denials) {
    if (OPEN_DENIAL_STATUSES.includes(denial.status)) {
      stats.openCount += 1;
      stats.openDenied += denial.deniedAmount;
      stats.openExpectedRecovery += denial.triage?.expectedRecovery ?? 0;
      const { window } = appealWindowOf(denial.appealDeadline, now, timeZone);
      if (window === "urgent" || window === "closed") stats.urgentCount += 1;
      /**
       * An awaiting-payment award is open work AND a receivable, so it is counted in both places —
       * `openCount` because somebody still has to chase it, and here because the money has a named
       * amount attached that ordinary open denials do not have.
       */
      if (AWARD_OPEN_STATUSES.includes(denial.status)) {
        stats.awaitingPaymentCount += 1;
        stats.awardedAwaitingPayment += awardOutstanding(denial);
      }
    } else if (denial.status === "recovered") {
      stats.recoveredCount += 1;
      /**
       * Cash. `awardSettledAmount` is what a posting attributed; `recoveredAmount` is the same
       * figure on rows written before awards existed. Never `awardedAmount` — that is the promise.
       */
      stats.recoveredAmount += denial.awardSettledAmount ?? denial.recoveredAmount ?? 0;
    } else if (CLOSED_DENIAL_STATUSES.includes(denial.status)) {
      stats.writtenOffCount += 1;
      stats.writtenOffAmount += denial.deniedAmount;
    }
  }

  const settled = stats.recoveredAmount + stats.writtenOffAmount;
  stats.recoveryRate = settled > 0 ? Math.round((stats.recoveredAmount / settled) * 1000) / 1000 : null;
  return stats;
}
