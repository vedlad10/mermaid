/**
 * View-model builders for the API/UI.
 *
 * These never re-derive money — every figure is read from the posting, which read it from the
 * payer's advice. The job here is to answer the two questions a biller has when a payment lands:
 * *can I bank this?* and *is anyone still holding money that belongs to us?*
 */
import { addCents, formatUsd, type Cents } from "@mermaid/shared";
import { variancePriority } from "./engine/variance.ts";
import type { Posting, Remittance } from "./types.ts";
import {
  assignedOf,
  blockedReasonOf,
  crossoverCarrierOf,
  workStatusOf,
  type ConfirmationRequest,
  type CoordinationCase,
  type CoverageConfirmation,
  type CoverageStatus,
  type CrossoverCarrier,
  type SecondaryWorkStatus,
} from "./coordination.ts";

export interface RemittanceView {
  remittance: Remittance;
  /** Money the payer still owes across this whole advice — recoverable plus unexplained. */
  totalRecoverable: Cents;
  /**
   * Money this advice assigned to another plan's adjudication. Real, uncollected, and not this
   * payer's to argue about — see `buildRemittanceView` for why it is kept separate.
   */
  totalWithOtherPayers: Cents;
  /** Postings with something worth pursuing, most valuable first. */
  actionable: Posting[];
  /** Payments we could not tie to a claim we recorded submitting. */
  unmatched: Posting[];
  canPost: boolean;
  recommendedAction: string;
  priority: number;
  /**
   * Set when this advice is HELD and release would be refused outright — a duplicate of money
   * already on the books, or a test file on a live deployment. `null` otherwise.
   *
   * ── WHY THE VIEW HAS TO KNOW ──────────────────────────────────────────────────────────────────
   * Release re-checks these findings against the books as they stand, which is what makes it
   * safe. But the view was built from the findings stored at INGEST, so a copy ingested before its
   * twin posted still read "Review and release" with the release button live: the button was
   * guaranteed to fail, and the one action that works — reject — was a secondary form below it.
   * The same check release runs is now run to build the view, so the screen offers what will work.
   */
  releaseBlocked: ReleaseBlock | null;
  /**
   * The coordination-of-benefits case for each claim THIS advice signalled (forwarded to another
   * plan, or money assigned to one). Empty for an ordinary advice. When any is `unconfirmed` on a
   * held advice, release is refused and `canPost` is false until a person confirms coverage.
   */
  coordination: CoordinationBrief[];
}

/** What a screen needs to show about one coordination case, without reading the whole aggregate. */
export interface CoordinationBrief {
  caseId: string;
  patientControlNumber: string;
  primaryPayerName: string;
  coverageStatus: CoverageStatus;
  workStatus: SecondaryWorkStatus;
  /** Money assigned to another plan — tracked, never collected. */
  assignedCents: Cents;
  assignedPosted: boolean;
  forwarded: boolean;
  crossoverCarrier: CrossoverCarrier | null;
  blockedReason: string | null;
  request: ConfirmationRequest | null;
  confirmation: CoverageConfirmation | null;
}

export function coordinationBrief(c: CoordinationCase): CoordinationBrief {
  const assigned = assignedOf(c);
  return {
    caseId: c.id,
    patientControlNumber: c.patientControlNumber,
    primaryPayerName: c.primaryPayerName,
    coverageStatus: c.coverageStatus,
    workStatus: workStatusOf(c),
    assignedCents: assigned.cents,
    assignedPosted: assigned.posted,
    forwarded: c.evidence.some((e) => e.remittanceStatus !== "rejected" && e.forwarded),
    crossoverCarrier: crossoverCarrierOf(c),
    blockedReason: blockedReasonOf(c),
    request: c.request,
    confirmation: c.confirmation,
  };
}

/** Why release would be refused, and which rejection is the way out. */
export interface ReleaseBlock {
  code: string;
  message: string;
  rejectAs: "duplicate" | "test-file";
}

/** A finding release will refuse on, as `buildRemittanceView` needs it. */
export interface ReleaseBlocker {
  code: string;
  message: string;
}

/**
 * What is STILL owed on one posting: what the payer withheld, less what has since been recovered,
 * plus what was never explained.
 *
 * -- WHY THIS IS ONE FUNCTION AND NOT TWO --------------------------------------
 * F-5 taught `buildRecoveryQueue` to subtract `resolvedRecoverable`, and stopped there. This
 * builder, which feeds the Money screen, the Today board and the recommended-action sentence,
 * kept adding the payer's raw figure, so the same two recovered denials read as $0.00 on Recover
 * and $2,250.00 on Money, on screens a biller sees side by side. Both numbers came from the same
 * postings; only one had been taught the rule.
 *
 * So the rule lives here, once, and every consumer asks this function rather than reimplementing
 * it. `unexplainedAmount` is deliberately NOT netted: nothing resolves money nobody has accounted
 * for, and `resolvedRecoverable` is defined against the recoverable figure alone.
 */
export const outstandingOf = (posting: Posting): Cents =>
  (Math.max(0, (posting.variance?.recoverableAmount ?? 0) - (posting.resolvedRecoverable ?? 0)) +
    (posting.variance?.unexplainedAmount ?? 0)) as Cents;

function recommend(
  remittance: Remittance,
  totalRecoverable: Cents,
  actionable: Posting[],
  unmatched: Posting[],
  withOtherPayers: Cents
): string {
  if (remittance.status === "held") {
    return remittance.balanced
      ? `Review and release — ${remittance.holdReason ?? "this remittance needs a person before it posts."}`
      : `Do not post. ${remittance.holdReason ?? "The arithmetic does not agree with the payer's own totals."} Reconcile against the paper EOB first.`;
  }
  /**
   * ── COORDINATED MONEY IS NOT "NOTHING OUTSTANDING" ────────────────────────────────────────────
   * A posted advice that assigned money to a secondary has `recoverableAmount: 0` and
   * `patientResponsibility: 0`, both correctly — so every branch below it fell through to
   * "received and fully accounted for; nothing outstanding with this payer". True about THIS payer
   * and badly incomplete: $482.51 of Kira Demo's claim was sitting with a second plan that had not
   * been billed, and the sentence closed the case.
   *
   * Stated before the recoverable branch because the ACTION differs. Recoverable money is argued
   * for with the payer who withheld it; coordinated money is collected by filing a claim with
   * somebody else. Naming it "outstanding" without naming the instrument would send a biller to
   * appeal a claim nobody denied.
   */
  if (withOtherPayers > 0) {
    return (
      `Posted. ${formatUsd(remittance.paymentTotal)} received. ${formatUsd(withOtherPayers)} went to ` +
      `another plan's adjudication — file the secondary claim and post its remittance. Do not bill ` +
      `the patient for it, and do not appeal: this payer denied nothing.`
    );
  }
  if (totalRecoverable > 0) {
    return `Posted. ${formatUsd(totalRecoverable)} across ${actionable.length} claim${actionable.length === 1 ? "" : "s"} was withheld for reasons worth pursuing — work these before the appeal window closes.`;
  }
  if (unmatched.length > 0) {
    const n = unmatched.length;
    return `Posted. ${n} payment${n === 1 ? "" : "s"} could not be matched to a claim we filed — identify what they belong to.`;
  }

  /**
   * ── "SETTLED" IS A STATEMENT ABOUT THE PAYER, NOT ABOUT THE MONEY ──────────────────────────────
   * This used to end at the sentence below: payment received, nothing recoverable, therefore
   * "nothing outstanding". It was read — correctly — as "this claim is finished", on claims where a
   * four-figure balance had just moved to the patient.
   *
   * The payer being done and the money being collected are different events, and the second one is
   * the practice's actual problem. So the patient's half is stated before the all-clear, and the
   * all-clear is only issued when there is genuinely nothing left anywhere.
   */
  const overpaid = remittance.postings.filter((p) => p.variance?.adjudication === "overpaid");
  if (overpaid.length > 0) {
    const excess = addCents(...overpaid.map((p) => (p.variance?.variance ?? 0) as Cents));
    return (
      `Posted, but ${formatUsd(excess)} more arrived than expected across ${overpaid.length} ` +
      `claim${overpaid.length === 1 ? "" : "s"}. Verify before spending it — payers reclaim overpayments.`
    );
  }

  const patientOwed = addCents(...remittance.postings.map((p) => (p.variance?.patientResponsibility ?? 0) as Cents));
  if (patientOwed > 0) {
    return (
      `Posted. ${formatUsd(remittance.paymentTotal)} received and nothing further is owed by this payer — ` +
      `but ${formatUsd(patientOwed)} moved to the patients. Bill it before it ages.`
    );
  }
  return `Posted. ${formatUsd(remittance.paymentTotal)} received and fully accounted for; nothing outstanding with this payer.`;
}

export function buildRemittanceView(
  remittance: Remittance,
  _now: Date = new Date(),
  /**
   * The findings release would refuse on NOW — `RemittanceService` evaluates them against the
   * current books and passes them in. Empty means "none known", which keeps every existing caller
   * exactly as it was; only a held advice ever uses them.
   */
  releaseBlockers: readonly ReleaseBlocker[] = [],
  /** The coordination cases for claims this advice signalled. Empty keeps every caller unchanged. */
  cases: readonly CoordinationCase[] = []
): RemittanceView {
  const coordination = cases.map(coordinationBrief);
  /**
   * ── A REJECTED ADVICE CARRIES NO MONEY, WHATEVER ITS POSTINGS SAY ───────────────────────────
   * Its postings are kept as evidence of what the payer's file said, and read as-is they would
   * advertise money: R2 on staging would have offered "$482.51 is with another payer — file the
   * secondary" for a copy of a payment already on the books. Every figure a biller acts on is
   * therefore zero, nothing is actionable, and the recommendation states the decision instead.
   */
  if (remittance.status === "rejected") {
    const r = remittance.rejection;
    return {
      remittance,
      totalRecoverable: 0 as Cents,
      totalWithOtherPayers: 0 as Cents,
      actionable: [],
      unmatched: [],
      canPost: false,
      recommendedAction:
        `Rejected as ${r?.kind === "test-file" ? "a test file" : "a duplicate"}` +
        (r ? ` by ${r.rejectedBy}: ${r.reason}` : "") +
        (r?.duplicateOfTrace ? ` (duplicates ${r.duplicateOfTrace})` : "") +
        ". Nothing was posted; no action needed.",
      priority: 0,
      releaseBlocked: null,
      coordination,
    };
  }

  const coverageRequired = remittance.status === "held" && coordination.some((c) => c.coverageStatus === "unconfirmed");
  const first = remittance.status === "held" ? releaseBlockers[0] : undefined;
  const releaseBlocked: ReleaseBlock | null = first
    ? {
        code: first.code,
        message: first.message,
        rejectAs: first.code === "test-interchange" ? "test-file" : "duplicate",
      }
    : null;

  const actionable = remittance.postings
    /**
     * `actionable` is the payer's own flag, frozen at ingest; it stays true after the money comes
     * back. Pairing it with an outstanding balance is what keeps `actionableCount` from advertising
     * work that is already done.
     */
    .filter((p) => p.variance?.actionable && outstandingOf(p) > 0)
    .sort((a, b) => outstandingOf(b) - outstandingOf(a));
  const unmatched = remittance.postings.filter((p) => p.claimId === null);
  const totalRecoverable = addCents(...remittance.postings.map(outstandingOf));
  /**
   * Money this advice handed to ANOTHER payer (M8).
   *
   * Deliberately NOT folded into `totalRecoverable`. Both are money the practice has not collected,
   * and they call for opposite actions: recoverable money is argued for with THIS payer, coordinated
   * money is collected by filing a claim with a DIFFERENT one. A biller told to "pursue" $482.51
   * that is waiting on a secondary would appeal a claim nobody denied.
   */
  const totalWithOtherPayers = addCents(
    ...remittance.postings.map((p) => (p.variance?.coordinationAmount ?? 0) as Cents)
  );

  const priority = remittance.status === "held"
    ? remittance.balanced
      ? 75
      : 90
    : Math.max(5, ...remittance.postings.map((p) => (p.variance ? variancePriority(p.variance) : 5)));

  return {
    remittance,
    totalRecoverable,
    totalWithOtherPayers,
    actionable,
    unmatched,
    canPost: remittance.status === "held" && remittance.balanced && releaseBlocked === null && !coverageRequired,
    recommendedAction: releaseBlocked
      ? `Do not release — ${releaseBlocked.message} Reject it as ${
          releaseBlocked.rejectAs === "test-file" ? "a test file" : "a duplicate"
        }; nothing will be posted.`
      : coverageRequired
        ? coverageAction(coordination.filter((c) => c.coverageStatus === "unconfirmed"))
        : recommend(remittance, totalRecoverable, actionable, unmatched, totalWithOtherPayers),
    priority,
    releaseBlocked,
    coordination,
  };
}

/**
 * A held advice whose coverage question is unanswered: say whose word raised it, and exactly what a
 * person has to establish. "Review and release" was the old sentence, and it was released on reasons
 * that never answered the question.
 */
function coverageAction(pending: readonly CoordinationBrief[]): string {
  const claims = pending
    .map(
      (c) =>
        `${c.primaryPayerName} ${c.forwarded ? "forwarded" : "assigned money on"} claim ${c.patientControlNumber}` +
        (c.assignedCents > 0 ? ` (${formatUsd(c.assignedCents)} to another plan)` : "") +
        (c.crossoverCarrier ? `, naming ${c.crossoverCarrier.name}` : ", naming no other plan")
    )
    .join("; ");
  const waiting = pending.find((c) => c.request);
  return (
    `Confirm the patient's other coverage before release — ${claims}. Needed: whether another plan exists, ` +
    `where the answer came from, and the date it was obtained.` +
    (waiting?.request ? ` Asked the ${waiting.request.from} on ${waiting.request.requestedOn}; follow up by ${waiting.request.followUpBy}.` : "")
  );
}

/** A compact row for the remittance worklist. Money fields are integer cents. */
export interface RemittanceListItem {
  id: string;
  traceNumber: string;
  receivedAt: string;
  status: Remittance["status"];
  payerName: string;
  paymentDate: string;
  paymentTotal: number;
  claimCount: number;
  balanced: boolean;
  holdReason: string | null;
  totalRecoverable: number;
  totalWithOtherPayers: number;
  actionableCount: number;
  unmatchedCount: number;
  canPost: boolean;
  recommendedAction: string;
  priority: number;
  /** See `RemittanceView.releaseBlocked`. */
  releaseBlocked: ReleaseBlock | null;
  /** See `RemittanceView.coordination`. */
  coordination: CoordinationBrief[];
}

export function buildRemittanceListItem(
  remittance: Remittance,
  now: Date = new Date(),
  releaseBlockers: readonly ReleaseBlocker[] = [],
  cases: readonly CoordinationCase[] = []
): RemittanceListItem {
  const view = buildRemittanceView(remittance, now, releaseBlockers, cases);
  return {
    id: remittance.id,
    traceNumber: remittance.traceNumber,
    receivedAt: remittance.receivedAt,
    status: remittance.status,
    payerName: remittance.payerName,
    paymentDate: remittance.paymentDate,
    paymentTotal: remittance.paymentTotal,
    claimCount: remittance.postings.length,
    balanced: remittance.balanced,
    holdReason: remittance.holdReason,
    totalRecoverable: view.totalRecoverable,
    totalWithOtherPayers: view.totalWithOtherPayers,
    actionableCount: view.actionable.length,
    unmatchedCount: view.unmatched.length,
    canPost: view.canPost,
    recommendedAction: view.recommendedAction,
    priority: view.priority,
    releaseBlocked: view.releaseBlocked,
    coordination: view.coordination,
  };
}

/**
 * The recovery queue: every posting still holding money someone owes us, across all remittances,
 * ranked by what is actually retrievable.
 *
 * This is the view a practice manager lives in — it is the direct, computed answer to "where is our
 * missing revenue?", made possible by the claim having carried its estimate forward.
 */
export interface RecoveryItem {
  postingId: string;
  remittanceId: string;
  claimId: string | null;
  patientName: string;
  patientControlNumber: string;
  payerName: string;
  postedAt: string;
  chargedAmount: number;
  paidAmount: number;
  expectedInsurancePays: number;
  recoverableAmount: number;
  unexplainedAmount: number;
  outcome: string;
  reasons: { group: string; code: string; description: string; amount: number; procedureCode: string | null }[];
  explanation: string[];
  priority: number;
}

export function buildRecoveryQueue(remittances: Remittance[], _now: Date = new Date()): RecoveryItem[] {
  const items: RecoveryItem[] = [];
  for (const remittance of remittances) {
    if (remittance.status !== "posted") continue;
    for (const posting of remittance.postings) {
      const variance = posting.variance;
      if (!variance?.actionable) continue;
      /**
       * What the payer withheld, minus what has since been recovered or closed out (F-5).
       *
       * Without this the queue kept advertising money that had already come back: a won appeal paid
       * in full left its denial `recovered` and its posting still saying $1,125.00 was pursuable.
       * The posting is not rewritten — the payers figure stays exactly as it arrived — the
       * OUTSTANDING figure is derived, and an item with nothing left outstanding leaves the queue.
       */
      const resolved = posting.resolvedRecoverable ?? (0 as Cents);
      const stillRecoverable = Math.max(0, variance.recoverableAmount - resolved) as Cents;
      // Same rule as every other surface. `outstandingOf` is stillRecoverable + unexplained, so a
      // posting leaves this queue exactly when it stops counting toward the Money total.
      if (outstandingOf(posting) === 0) continue;
      items.push({
        postingId: posting.id,
        remittanceId: remittance.id,
        claimId: posting.claimId,
        patientName: posting.patientName,
        patientControlNumber: posting.patientControlNumber,
        payerName: remittance.payerName,
        postedAt: posting.postedAt,
        chargedAmount: posting.chargedAmount,
        paidAmount: posting.paidAmount,
        expectedInsurancePays: variance.expectedInsurancePays,
        recoverableAmount: stillRecoverable,
        unexplainedAmount: variance.unexplainedAmount,
        outcome: variance.outcome,
        reasons: variance.reasons,
        explanation: variance.explanation,
        priority: variancePriority(variance),
      });
    }
  }
  return items.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.recoverableAmount + b.unexplainedAmount - (a.recoverableAmount + a.unexplainedAmount) ||
      b.postedAt.localeCompare(a.postedAt)
  );
}
