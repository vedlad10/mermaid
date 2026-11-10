/**
 * The two failures no business screen reveals, watched on a timer and announced when they persist.
 *
 * ── WHY THESE TWO ──────────────────────────────────────────────────────────────────────────────
 * `architecture-risk-review.md` §1.2 and §1.3 name them, and they share a property that makes them
 * uniquely dangerous: **everything keeps looking fine.**
 *
 *   • **A stalled outbox.** Verifications still verify, claims still file, the Insights dashboard
 *     still renders. What stops is the learning loop — and its symptom is a number that does not
 *     move, which nobody notices for weeks. The review's own words: "nobody notices until a
 *     practice owner asks why the confidence score hasn't moved in weeks."
 *   • **Money that does not reconcile.** A posting that disagrees with the payer's own 835 is not
 *     an exception anyone sees; it is a correct-looking number that is wrong. §1.3 asks for a daily
 *     job comparing auto-posted totals against raw-835 checksums, "alerting on drift."
 *
 * Both were *displayed* from M10 on the Ops screen and neither was *announced*. A screen is not
 * monitoring — and the Ops screen in particular is the one an operator opens only once they already
 * suspect something, which is exactly too late for a silent failure.
 *
 * ── WHY THIS LIVES IN apps/ AND NOT IN platform/ ───────────────────────────────────────────────
 * The reconciliation check needs a module service, and platform may not depend on modules
 * (`shared ← platform ← modules ← apps`, enforced by `npm run boundaries`). The gating state
 * machine that decides *when* to speak is pure and does live in platform
 * (`@mermaid/observability`); this file only knows which questions to ask. Same division, and same
 * reason, as `today.ts`.
 *
 * ── ON NOT CRYING WOLF ─────────────────────────────────────────────────────────────────────────
 * Every condition goes through `AlertGate`: sustained for several checks before it fires, then at
 * most one line per cooldown, plus one line when it clears. A monitor people mute is decorative,
 * and a decorative monitor is worse than none because it looks like coverage.
 */
import {
  AlertGate,
  logger as defaultLogger,
  type AlertNotification,
  type AlertPayload,
  type AlertPolicy,
  type Logger,
} from "@mermaid/observability";
import { formatUsd, type Cents } from "@mermaid/shared";
import { withPractice, withoutPractice } from "@mermaid/db";
import { ADJUDICATED_STATUSES } from "@mermaid/claims";
import { HELD_REMITTANCE_REVIEW_DAYS } from "./today.ts";
import type { Services } from "./server.ts";
import { listCoordinationWork, type CoordinationWorkItem } from "./coordination.ts";

export interface MonitorThresholds {
  /**
   * How long the oldest undelivered event may sit before the outbox is considered stalled.
   *
   * Five minutes is far above a healthy drain (the worker ticks every five seconds) and far below
   * the hours it would take anyone to notice by hand.
   */
  outboxLagMs: number;
  /**
   * Dead letters tolerated before alerting. Zero: an event that exhausted its retries is a business
   * fact that never happened — a claim not billed, an outcome never learned from.
   */
  deadLetters: number;
  /**
   * Reconciliation drift tolerated, in cents. Zero, and it is not a tuning knob: money either
   * reconciles against the payer's own advice or the practice has a problem worth a person.
   */
  driftCents: number;
  /**
   * How long a remittance may sit held before the pile itself is the problem.
   *
   * Held money reconciles perfectly — the remittance IS in the table, so `reconcileAll()` sums it
   * and reports zero drift while the payer's cash sits in the bank against no ledger entry and no
   * one is working it. Drift cannot see this, by construction. It is the second money reading, and
   * unlike drift it is a reading that goes stale rather than wrong.
   *
   * DERIVED from `HELD_REMITTANCE_REVIEW_DAYS` in `today.ts` rather than restated here.
   *
   * It was restated, as `3 * 86_400_000`, under a comment saying the two must not disagree — and
   * they already did. The board marks a hold urgent AT day three (`heldDays >= 3`); this alarmed
   * only after three full days had elapsed (`>`), so for up to a day the queue showed urgent work
   * while the watchdog reported "no remittance has been held longer than the review window". An
   * operator checking the alert would have been told the board was crying wolf.
   *
   * One constant and one comparison now, so the two can only flip together. Two numbers with a
   * comment promising they are equal is not an invariant, it is a wish.
   */
  heldRemittanceAgeMs: number;
  /**
   * Dead-lettered ERA artifacts tolerated. Zero, for the same reason already written above for the
   * outbox: an artifact that exhausted its retries is a payment that never happened. The
   * clearinghouse told us it had a payer's money file, five attempts failed, and nothing retries it
   * again — so it is not slow, it is abandoned.
   */
  eraDeadLetters: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  outboxLagMs: 5 * 60_000,
  deadLetters: 0,
  driftCents: 0,
  heldRemittanceAgeMs: HELD_REMITTANCE_REVIEW_DAYS * 86_400_000,
  eraDeadLetters: 0,
};

export const OUTBOX_LAG = "outbox.lag";
export const OUTBOX_DEAD_LETTERS = "outbox.dead_letters";
export const RECONCILIATION_DRIFT = "money.reconciliation_drift";
export const HELD_REMITTANCE_AGE = "money.held_remittance_age";
/**
 * A payer said another plan is involved and nobody is finding out whether it is (0034). Separate
 * from held cash on purpose: "asked the patient, following up Friday" is work in progress, and an
 * unanswered question with nobody asking is the failure — neither is an unattended pile of money.
 */
export const COVERAGE_UNCONFIRMED = "coordination.coverage_unconfirmed";
/** Money assigned to another plan whose secondary claim is near or past its filing deadline (0034). */
export const SECONDARY_CLAIMS = "coordination.secondary_claims";
export const PAYMENT_COPY_DIVERGENCE = "money.payment_copy_divergence";
export const UNSTABLE_CONTRACTED_RATE = "money.unstable_contracted_rate";
export const LAPSED_CONTRACTED_RATE = "money.lapsed_contracted_rate";

/**
 * How many times a payer may restate an allowance before the rate is not worth quoting from.
 *
 * Two is a renegotiation — contracts change, and the new rate is simply the current one. Three or
 * more means the figure has moved repeatedly, and a patient quoted from it is being given a number
 * the payer has already contradicted twice.
 */
export const RATE_RESTATEMENT_LIMIT = 3;

/**
 * How many consecutive full-price adjudications before a learned rate stops being quotable.
 *
 * One is ordinary — a service outside the agreement, a secondary payer, a plan that covers the code
 * differently. Three in a row on a code this payer used to discount is a contract that has lapsed,
 * and every estimate since the first of them has been quoting a discount the payer no longer gives.
 */
export const FULL_PRICE_RUN_LIMIT = 3;
export const ERA_DEAD_LETTERS = "era.dead_letters";

export interface MonitorOptions {
  thresholds?: MonitorThresholds;
  policy?: AlertPolicy;
  logger?: Logger;
  /**
   * Where an alert goes besides the log. Injected rather than read from config here so a test can
   * assert on what would be sent without a socket, and so the composition root stays the only place
   * that knows what this deployment is configured with.
   */
  notify?: (payload: AlertPayload) => void;
}

/**
 * One check's CURRENT state, before anything decides whether to announce it.
 *
 * ── WHY THIS IS SEPARATE FROM THE NOTIFICATION (M20) ───────────────────────────────────────────
 * `AlertGate` answers "should a human hear about this NOW" — sustained for several checks, then at
 * most one line per cooldown. That is exactly right for announcing and exactly wrong for a screen:
 * an operator opening Ops wants the current state, not whatever survived a cooldown window. Asking
 * the gate would also MUTATE it, so rendering a page would advance the alerting state machine.
 *
 * So the reading and the decision are now two steps. `takeReadings` computes what is true;
 * `runChecks` feeds those through the gate exactly as before. Nothing about what is measured, or
 * about when an alert fires, changed when this was split.
 */
export interface MonitorReading {
  key: string;
  breaching: boolean;
  message: string;
  detail: Record<string, unknown>;
  /**
   * Bypass the alert gate.
   *
   * Set only on a FAILED reading. A check that could not run must be announced on the first tick,
   * not after the gate's sustained-for-N rule — "the money is now unmonitored" is not a condition to
   * watch and see whether it persists. This preserves the pre-M20 behaviour exactly: those two
   * pushes never went through the gate.
   */
  immediate?: boolean;
}

/** Which practices' money to read. Queue mechanics span tenants; anything a user looks at never does. */
export type ReadingScope =
  /** Every active practice, aggregated — the operator watchdog. Never served to a user. */
  | "all-practices"
  /** Only the ambient practice, inside the caller's own transaction — what a screen may see. */
  | "this-practice";

/**
 * Take one reading of everything worth watching.
 *
 * Returns the notifications that should be emitted rather than emitting them, so a test can drive
 * the clock and assert on decisions instead of scraping a log. Exported for exactly that reason.
 */
export async function runChecks(
  services: Services,
  gate: AlertGate,
  thresholds: MonitorThresholds,
  now: Date = new Date()
): Promise<AlertNotification[]> {
  const out: AlertNotification[] = [];
  for (const reading of await takeReadings(services, thresholds, now)) {
    if (reading.immediate) {
      out.push({
        kind: "firing",
        key: reading.key,
        message: reading.message,
        detail: reading.detail,
        since: now.toISOString(),
      });
      continue;
    }
    const note = gate.evaluate(
      { key: reading.key, breaching: reading.breaching, message: reading.message, detail: reading.detail },
      now
    );
    if (note) out.push(note);
  }
  return out;
}

/**
 * What every watched condition currently says — ungated, and safe to call on a request.
 *
 * ── SCOPE IS A SAFETY PARAMETER, NOT A CONVENIENCE ─────────────────────────────────────────────
 * The money readings aggregate across practices for the watchdog: one operator, one process, no
 * user, and the whole point is to notice a tenant nobody is watching. Serving that same aggregate
 * to an authenticated practice user would put another practice's held money on their screen — a
 * tenant leak introduced in the act of closing a monitoring gap.
 *
 * So a caller must say which it wants, and the API says `this-practice`. The rule is the one
 * `PgOutbox.recentEvents` already states: queue mechanics span tenants; anything a user looks at
 * never does.
 */
export async function takeReadings(
  services: Services,
  thresholds: MonitorThresholds,
  now: Date = new Date(),
  scope: ReadingScope = "all-practices"
): Promise<MonitorReading[]> {
  const out: MonitorReading[] = [];

  // ── The outbox ───────────────────────────────────────────────────────────────────────────────
  //
  // ── THE SCOPE APPLIES HERE TOO (NEW-06) ────────────────────────────────────────────────────
  // The money readings below have honoured `scope` since they were written; the outbox readings did
  // not, and always read the GLOBAL backlog. So `/ops/monitors` and `/ops/readiness` — both called
  // with `this-practice` — told a clinic its queue was stalled because a different clinic's was,
  // and reported another tenant's dead letters as theirs to retry.
  try {
    const backlog =
      scope === "this-practice" ? await services.bus.practiceBacklog() : await services.bus.backlog();
    const lagMs = backlog.oldestPending ? now.getTime() - new Date(backlog.oldestPending).getTime() : 0;

    out.push({
      key: OUTBOX_LAG,
      breaching: lagMs > thresholds.outboxLagMs,
      message:
        lagMs > thresholds.outboxLagMs
          ? `The outbox is not draining: its oldest undelivered event is ${Math.round(lagMs / 1000)}s old. ` +
            `The learning loop is stalled and no business screen will show it.`
          : "The outbox is draining normally again.",
      detail: { lagMs, pending: backlog.pending, thresholdMs: thresholds.outboxLagMs },
    });

    out.push({
      key: OUTBOX_DEAD_LETTERS,
      breaching: backlog.dead > thresholds.deadLetters,
      message:
        backlog.dead > thresholds.deadLetters
          ? `${backlog.dead} event${backlog.dead === 1 ? "" : "s"} exhausted their retries and are dead-lettered. Each one is a ` +
            `business fact that never happened; they need a human and a retry from the Ops screen.`
          : "No dead-lettered events remain.",
      detail: { dead: backlog.dead },
    });
  } catch (err) {
    // A monitor that throws takes the timer down with it and then watches nothing at all — which is
    // the failure it exists to prevent, arrived at from the other direction.
    out.push({
      key: OUTBOX_LAG,
      breaching: true,
      immediate: true,
      message: "Could not read outbox health — the queue is now unmonitored.",
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // ── The money ────────────────────────────────────────────────────────────────────────────────
  //
  // ── WHY THIS RUNS PER PRACTICE, INSIDE A TRANSACTION ───────────────────────────────────────
  // `reconcileAll()` reads the remittance repository, and every repository here requires the ambient
  // practice-scoped transaction `withPractice` opens — `requireContext()` throws without one, by
  // design, so that a tenant query can never run with no practice context.
  //
  // The monitor runs on a bare `setInterval` with no request behind it and therefore no context. So
  // the check threw on every tick and was swallowed by the catch below, and the ONLY thing this
  // monitor ever reported under Postgres was "the money is now unmonitored" — a watchdog that had
  // never once looked at the money it was watching. Nothing failed loudly enough to notice: the
  // in-memory repositories the test suite uses need no transaction, so the tests passed, and the
  // alarm that did fire was itself an alarm, which reads as the system working.
  //
  // Reconciliation is per-tenant (each practice's payers, each practice's postings), so the fix is
  // to enumerate practices — `practices` is the tenant registry and deliberately carries no RLS —
  // and reconcile each inside its own scoped transaction. That is the same shape the outbox worker
  // already uses: queue mechanics span tenants, business reads never do.
  try {
    const readings = scope === "this-practice" ? [await readCurrentPractice(services, now)] : await readEveryPractice(services, now);

    // ── Drift: money that posted, against what the payer said ──────────────────────────────────
    const reports = readings.filter((r) => r.reconciliation !== null);
    const drift = reports.reduce((worst, r) => Math.max(worst, Math.abs(r.reconciliation!.drift)), 0);
    const breaching = reports.filter((r) => Math.abs(r.reconciliation!.drift) > thresholds.driftCents);
    out.push({
      key: RECONCILIATION_DRIFT,
      breaching: breaching.length > 0,
      message:
        breaching.length > 0
          ? `Auto-posted money does not reconcile against the payers' own advice in ` +
            `${breaching.length} practice(s): up to ${formatUsd(drift as Cents)} of drift. ${breaching[0]!.reconciliation!.summary}`
          : "Auto-posted money reconciles against the payers' advice.",
      detail: {
        driftCents: drift,
        practicesChecked: reports.length,
        practicesBreaching: breaching.length,
        /*
         * The `Cents` suffix is load-bearing, not decoration. Ops renders these readings generically
         * and formats by the units the KEY declares, so a money figure named without its unit gets
         * printed as a bare integer: `amount posted 151,297` for $1,512.97, on a screen in a product
         * whose first rule is that money is integer cents and is never shown without saying so.
         */
        paymentsReceivedCents: reports.reduce((total, r) => total + r.reconciliation!.paymentsReceived, 0),
        amountPostedCents: reports.reduce((total, r) => total + r.reconciliation!.amountPosted, 0),
      },
    });

    /**
     * ── Held money: the reading drift cannot take ────────────────────────────────────────────────
     *
     * A remittance the safety gate refused to post is a row in the table like any other, so the
     * check above sums it and reports the practice balanced — correctly. The money is nonetheless
     * in the bank against no ledger entry, its claims still read unpaid, and their appeal and
     * timely-filing windows are running down behind the hold. Nothing measured that, so a hold
     * could sit indefinitely while every screen and every monitor said the system was healthy.
     *
     * Alerts on the OLDEST hold rather than the count. Ten holds from this morning are a normal
     * Tuesday; one from three weeks ago is the failure this exists to catch, and a count-based
     * threshold reports those the same way round.
     */
    const helds = readings.filter((r) => r.held !== null);
    const oldestHeld = helds.reduce<string | null>(
      (oldest, r) =>
        r.held!.oldestReceivedAt !== null && (oldest === null || r.held!.oldestReceivedAt < oldest)
          ? r.held!.oldestReceivedAt
          : oldest,
      null
    );
    const oldestHeldMs = oldestHeld ? now.getTime() - new Date(oldestHeld).getTime() : 0;
    const heldCount = helds.reduce((total, r) => total + r.held!.count, 0);
    const heldCents = helds.reduce((total, r) => total + r.held!.totalCents, 0);
    /**
     * A reading that FAILED is not a reading that came back empty, and the difference has to reach
     * an operator rather than only a log file.
     *
     * With a threshold of zero — and an age threshold, where "nothing held" and "could not ask" both
     * compute to zero milliseconds — a swallowed failure is indistinguishable from good news. That
     * is the exact shape of every finding this body of work exists to close, and it would be
     * self-defeating to reintroduce it in the watchdog itself. So a check that could not take its
     * reading for ANY practice says so, in the same words and by the same mechanism the outbox and
     * drift checks already use.
     */
    const heldUnread = readings.length > 0 && helds.length === 0;
    out.push({
      key: HELD_REMITTANCE_AGE,
      // `>=`, matching the board's `heldDays >= HELD_REMITTANCE_REVIEW_DAYS`. Strictly-greater made
      // the two surfaces disagree for a day about whether the same hold was late.
      breaching: heldUnread || oldestHeldMs >= thresholds.heldRemittanceAgeMs,
      message: heldUnread
        ? "Could not read how much money is held — held money is now unmonitored."
        : oldestHeldMs >= thresholds.heldRemittanceAgeMs
          ? `${heldCount} remittance${heldCount === 1 ? "" : "s"} worth ${formatUsd(heldCents as Cents)} ${heldCount === 1 ? "is" : "are"} held ` +
            `and unposted; the oldest has waited ${Math.floor(oldestHeldMs / 86_400_000)} day(s). This money reconciles ` +
            `perfectly and is in the bank against nothing — it needs a person to release or reject it.`
          : "No remittance has been held longer than the review window without someone working it.",
      // The amount is written the way money is written everywhere else in this system. It said
      // "159998 cent(s)" on staging, in the one sentence whose entire purpose is to make an operator
      // act — and the comment below already argued that a figure without the money is not
      // actionable. A figure a person has to divide by 100 at six in the morning is the same
      // failure wearing a decimal point: $1,599.98 misread as $159,998 is a different decision.
      // The AMOUNT is in the detail deliberately. "3 held" is a number an operator can defer;
      // "3 held, $altogether" is a decision. An alert without the money is not actionable.
      // `practicesRead` is what makes a partial reading legible — the same field, for the same
      // reason, as `practicesChecked` on the drift alert above.
      detail: {
        heldCount,
        heldCents,
        oldestHeldMs,
        thresholdMs: thresholds.heldRemittanceAgeMs,
        practicesRead: helds.length,
        practicesSeen: readings.length,
      },
    });

    /**
     * ── A COVERAGE QUESTION NOBODY IS ASKING (0034) ──────────────────────────────────────────────
     * A payer said another plan is involved. Waiting for the patient or the payer to answer is
     * normal and has its own date — the person who asked recorded when to follow up. What breaches
     * is the question with NOBODY asking it past the review window, or a follow-up date that has
     * come and gone. Clearing a generic hold never answers it; only a confirmation does.
     */
    const coordinationReadings = readings.filter((r) => r.coordination !== null);
    const coordinationUnread = readings.length > 0 && coordinationReadings.length === 0;
    const items = coordinationReadings.flatMap((r) => r.coordination!);
    const today = now.toISOString().slice(0, 10);
    const unconfirmed = items.filter((i) => i.coverageStatus === "unconfirmed");
    const unasked = unconfirmed.filter(
      (i) => !i.case.request && now.getTime() - new Date(i.case.createdAt).getTime() >= thresholds.heldRemittanceAgeMs
    );
    const overdue = unconfirmed.filter((i) => i.case.request && i.case.request.followUpBy < today);
    const followingUp = unconfirmed.filter((i) => i.case.request && i.case.request.followUpBy >= today).length;
    const fresh = unconfirmed.length - unasked.length - overdue.length - followingUp;
    const coverageBreaching = coordinationUnread || unasked.length + overdue.length > 0;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    out.push({
      key: COVERAGE_UNCONFIRMED,
      breaching: coverageBreaching,
      message: coordinationUnread
        ? "Could not read the coordination cases — coverage questions are now unmonitored."
        : coverageBreaching
          ? [
              unasked.length > 0 ? `${plural(unasked.length, "coverage question")} with nobody asking, past the review window` : null,
              overdue.length > 0 ? `${plural(overdue.length, "coverage question")} past the follow-up date someone set` : null,
            ]
              .filter(Boolean)
              .join("; ") +
            ". A payer said another plan is involved; until someone confirms whether the patient has one, the claim cannot be finished."
          : unconfirmed.length > 0
            ? [
                followingUp > 0 ? `${plural(followingUp, "coverage question")} being followed up by a set date` : null,
                fresh > 0 ? `${plural(fresh, "coverage question")} raised within the review window, not yet asked` : null,
              ]
                .filter(Boolean)
                .join("; ") + "."
            : "Every coverage question a payer raised has been answered.",
      detail: {
        unconfirmed: unconfirmed.length,
        unasked: unasked.map((i) => i.patientControlNumber),
        overdue: overdue.map((i) => ({ claim: i.patientControlNumber, followUpBy: i.case.request!.followUpBy })),
        followingUp,
        fresh,
        reviewWindowMs: thresholds.heldRemittanceAgeMs,
      },
    });

    /**
     * ── SECONDARY CLAIMS AGAINST THEIR DEADLINE (0034) ──────────────────────────────────────────
     * Money a payer assigned to another plan is recovered only if someone files with that plan in
     * time. Breaches when any open secondary work is urgent or past its deadline — the same risk
     * bands every primary claim is ranked by. The amount is in the detail and the message, and it is
     * money AT RISK: nothing here is collected, and nothing here reads as recovered.
     */
    const openWork = items.filter((i) => ["awaiting-coverage", "ready-to-file", "return-to-primary", "filed"].includes(i.workStatus));
    const atRisk = openWork.filter(
      (i) => i.workStatus !== "filed" && i.deadline && (i.deadline.risk === "urgent" || i.deadline.risk === "expired")
    );
    const cents = (list: readonly CoordinationWorkItem[]) => list.reduce((t, i) => t + i.assignedCents, 0);
    out.push({
      key: SECONDARY_CLAIMS,
      breaching: coordinationUnread || atRisk.length > 0,
      message: coordinationUnread
        ? "Could not read the coordination cases — secondary claims are now unmonitored."
        : atRisk.length > 0
          ? `${plural(atRisk.length, "secondary claim")} worth ${formatUsd(cents(atRisk) as Cents)} ${atRisk.length === 1 ? "is" : "are"} ` +
            `urgent or past the filing deadline and not yet filed. That money was assigned to another plan and is lost if nobody files.`
          : openWork.length > 0
            ? `${plural(openWork.length, "secondary claim")} open, ${formatUsd(cents(openWork) as Cents)} assigned to other plans; none is near its deadline.`
            : "No money is waiting on another plan.",
      detail: {
        open: openWork.length,
        openCents: cents(openWork),
        atRisk: atRisk.map((i) => ({ claim: i.patientControlNumber, workStatus: i.workStatus, deadline: i.deadline!.deadline, risk: i.deadline!.risk })),
        deadlinesAreEstimates: true,
      },
    });

    /**
     * ── The three copies of a payment disagreeing ───────────────────────────────────────────────
     *
     * A posting lives in the postings projection, in `remittances.record`, and in
     * `claims.record.payments`. Every screen reads exactly one of them, and each copy is entirely
     * self-consistent on its own, so divergence is invisible everywhere by construction — a claim
     * can show one figure while the remittance behind it shows another and neither screen looks
     * wrong. It has happened twice, both times because a remediation updated some copies and not
     * all, and both times it was found by hand afterwards on a database small enough to eyeball.
     *
     * Alarms on the FIRST disagreement rather than on a count. There is no tolerable number of
     * places where this system says two different things about the same payment.
     */
    const copyReadings = readings.filter((r) => r.copies !== null);
    const mismatches = copyReadings.flatMap((r) => r.copies!.mismatches);
    const orphans = copyReadings.flatMap((r) => r.copies!.orphans);
    const compared = copyReadings.reduce((total, r) => total + r.copies!.compared, 0);
    const truncated = copyReadings.some((r) => r.copies!.truncated);
    /** Same rule as every other check here: a reading that FAILED is not a reading that came back clean. */
    const copiesUnread = readings.length > 0 && copyReadings.length === 0;
    const worst = mismatches[0];
    out.push({
      key: PAYMENT_COPY_DIVERGENCE,
      breaching: copiesUnread || mismatches.length > 0,
      message: copiesUnread
        ? "Could not compare the copies of any payment — divergence between them is now unmonitored."
        : mismatches.length > 0
          ? `${mismatches.length} payment figure(s) disagree between the remittance and the claim that ` +
            `received them — e.g. posting ${worst!.postingId.slice(0, 8)} ${worst!.field}: the remittance ` +
            `says ${worst!.remittance}, the claim says ${worst!.claim}. Every screen reads one copy, so ` +
            `both look correct and one of them is not.`
          : `${compared} payment(s) agree across the remittance and the claim.` +
            (truncated ? ` Scan stopped at ${COPY_SCAN_LIMIT} per practice — older payments were not compared.` : ""),
      detail: {
        mismatches: mismatches.length,
        orphans: orphans.length,
        compared,
        truncated,
        practicesRead: copyReadings.length,
        practicesSeen: readings.length,
        // Bounded so one bad migration cannot produce an unreadable alert.
        examples: mismatches.slice(0, 5),
      },
    });

    /**
     * ── A contracted rate the payer keeps changing ──────────────────────────────────────────────
     *
     * The estimate quotes patients from learned allowances, and L-3 now prices DENIED lines from
     * them too — so a rate that keeps moving is a patient told a number the payer has already
     * contradicted. `restatements` counted that from the day the store was built and nothing read
     * it: computed, stored, surfaced nowhere, which is precisely the defect F-7 existed to close,
     * reappearing in the feature that fixed it.
     *
     * Not an error. A renegotiated contract is ordinary, and the newest reading is the right one to
     * quote. What is worth a person's attention is a rate that will not settle.
     */
    const lapsed = readings.flatMap((r) => r.lapsedRates ?? []);
    const worstLapsed = lapsed[0];
    out.push({
      key: LAPSED_CONTRACTED_RATE,
      breaching: lapsed.length > 0,
      message:
        lapsed.length > 0
          ? `${lapsed.length} contracted rate(s) have not been applied by the payer for ` +
            `${FULL_PRICE_RUN_LIMIT} or more adjudications — e.g. ${worstLapsed!.payerId} ` +
            `${worstLapsed!.cdtCode}, last discounted at ${formatUsd(worstLapsed!.allowed)}. Estimates are ` +
            `still quoting that discount; if this practice has left the network, patients are being ` +
            `told they owe less than they do.`
          : "Every learned contracted rate is still being applied by its payer.",
      detail: {
        lapsed: lapsed.length,
        limit: FULL_PRICE_RUN_LIMIT,
        practicesRead: readings.filter((r) => r.lapsedRates !== null).length,
        practicesSeen: readings.length,
        examples: lapsed.slice(0, 5),
      },
    });

    const unstable = readings.flatMap((r) => r.unstableRates ?? []);
    const ratesUnread = readings.length > 0 && readings.every((r) => r.unstableRates === null);
    const worstRate = unstable[0];
    out.push({
      key: UNSTABLE_CONTRACTED_RATE,
      breaching: ratesUnread || unstable.length > 0,
      message: ratesUnread
        ? "Could not read the learned fee schedules — rate instability is now unmonitored."
        : unstable.length > 0
          ? `${unstable.length} contracted rate(s) have been restated ${RATE_RESTATEMENT_LIMIT} or more times — ` +
            `e.g. ${worstRate!.payerId} ${worstRate!.cdtCode} now ${formatUsd(worstRate!.allowed)} after ` +
            `${worstRate!.restatements} changes. Patients are being quoted from a figure this payer keeps ` +
            `contradicting; confirm the contracted rate before relying on it.`
          : "Every learned contracted rate is stable.",
      detail: {
        unstable: unstable.length,
        limit: RATE_RESTATEMENT_LIMIT,
        practicesRead: readings.filter((r) => r.unstableRates !== null).length,
        practicesSeen: readings.length,
        examples: unstable.slice(0, 5),
      },
    });

    /**
     * ── Abandoned ERA files ─────────────────────────────────────────────────────────────────────
     *
     * The mirror image of the hold: this money never became a remittance at all, so it contributes
     * to neither side of the reconciliation and the practice reports balanced for the opposite
     * reason. The clearinghouse said it had a payer's file, retrieval failed to exhaustion, and
     * nothing retries it again.
     */
    const ledgers = readings.filter((r) => r.deadLetters !== null);
    const deadLetters = ledgers.reduce((total, r) => total + r.deadLetters!.length, 0);
    const eraUnread = readings.length > 0 && ledgers.length === 0;
    out.push({
      key: ERA_DEAD_LETTERS,
      breaching: eraUnread || deadLetters > thresholds.eraDeadLetters,
      message: eraUnread
        ? "Could not read the ERA artifact ledger — abandoned payment files are now unmonitored."
        : deadLetters > thresholds.eraDeadLetters
          ? `${deadLetters} ERA file${deadLetters === 1 ? "" : "s"} exhausted every retry and ${deadLetters === 1 ? "was" : "were"} abandoned. ` +
            `Each one is a payer's payment file that never reached the ledger: its claims still read as unpaid ` +
            `and its money is on no screen. Retrieve them from the clearinghouse by hand.`
          : "No ERA file has been abandoned.",
      detail: { deadLetters, practicesChecked: ledgers.length, practicesSeen: readings.length },
    });
  } catch (err) {
    out.push({
      key: RECONCILIATION_DRIFT,
      breaching: true,
      immediate: true,
      message: "Could not reconcile auto-posted money — the money is now unmonitored.",
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  return out;
}

/**
 * One practice's money readings. A `null` field is a read that FAILED for this practice — never a
 * read that came back empty, which is `count: 0` / `[]`. The distinction is load-bearing: a
 * threshold of zero would otherwise treat a broken query as good news.
 */
interface PracticeReading {
  practiceId: string;
  reconciliation: Awaited<ReturnType<Services["remittance"]["reconcileAll"]>> | null;
  /**
   * Held money nobody is working — `unattendedHeldSummary`, which leaves out advices held ONLY on an
   * unanswered coverage question. Those are the coverage check's to report, not this one's twice.
   */
  held: Awaited<ReturnType<Services["remittance"]["unattendedHeldSummary"]>> | null;
  /** Every coordination case, with its deadline, read inside the practice's own transaction. */
  coordination: CoordinationWorkItem[] | null;
  deadLetters: Awaited<ReturnType<Services["remittance"]["deadLetteredArtifacts"]>> | null;
  copies: CopyDivergence | null;
  /** Learned rates this payer has restated too often to quote from. Null when the read failed. */
  unstableRates: { payerId: string; cdtCode: string; allowed: Cents; restatements: number }[] | null;
  /** Learned rates the payer has stopped applying. Null when the read failed. */
  lapsedRates: { payerId: string; cdtCode: string; allowed: Cents; fullPriceSince: number }[] | null;
}

/**
 * Whether the three copies of a payment still say the same thing.
 *
 * ── WHY THIS IS WATCHED ────────────────────────────────────────────────────────────────────────
 * One posting is recorded in three places: the `postings` projection, inside `remittances.record`,
 * and inside `claims.record.payments`. That is a deliberate design — each store answers a different
 * question and each is read on a different screen — but it means a correction has to be applied
 * three times, and twice now a remediation has updated some of them and not others.
 *
 * The first time, a recovery was resolved in the projection and not in the JSONB the Recover queue
 * reads, so a worklist kept advertising money that had already arrived. The second, a variance
 * outcome was relabelled in two stores and not the third, so the API served a different word than
 * the database held. Both were found by hand, after the fact, on a staging database small enough to
 * eyeball.
 *
 * Divergence is invisible on every screen by construction: each screen reads ONE copy and each copy
 * looks entirely self-consistent. Only comparing them can tell, and nothing was comparing them.
 */
export interface CopyDivergence {
  /** Postings whose claim copy disagrees with the remittance copy, with what differs. */
  mismatches: { postingId: string; field: string; remittance: string; claim: string }[];
  /** Postings present in a remittance but missing from the claim they name, and vice versa. */
  orphans: string[];
  /** How many postings were actually compared — see the cap in `readCopies`. */
  compared: number;
  /** True when the scan stopped at its bound, so "no mismatches" means "none in what was read". */
  truncated: boolean;
}

/** Postings compared per practice per tick. Bounded so a large practice cannot stall the watchdog. */
const COPY_SCAN_LIMIT = 500;

/**
 * Compare the claim's copy of each payment against the remittance's copy.
 *
 * Through the public views rather than SQL, deliberately: those views are what the SCREENS read, so
 * a divergence they cannot see is a divergence that does not matter, and one they can see is caught
 * here in the same shape a person would meet it. It also means this works identically against the
 * in-memory stores, so the whole business suite exercises it.
 *
 * The `postings` projection is not read separately. It is the source both JSONB copies are written
 * from, so a disagreement between the two derived copies is the signal; adding a third read would
 * triple the cost to catch nothing the comparison of two does not already surface.
 */
export async function readCopies(services: Services): Promise<CopyDivergence> {
  const byPosting = new Map<string, { paid: Cents; responsibility: Cents; outcome: string }>();
  for (const summary of await services.remittance.list({ status: "posted" })) {
    const full = await services.remittance.get(summary.id);
    for (const posting of full?.remittance.postings ?? []) {
      byPosting.set(posting.id, {
        paid: posting.paidAmount,
        responsibility: posting.patientResponsibility,
        outcome: posting.variance?.outcome ?? "",
      });
    }
  }

  const mismatches: CopyDivergence["mismatches"] = [];
  const orphans: string[] = [];
  const seen = new Set<string>();
  let compared = 0;
  let truncated = false;

  /**
   * ── ONLY CLAIMS THAT CAN CARRY A PAYMENT (audit follow-up) ────────────────────────────────────
   *
   * This iterated EVERY claim in the practice and opened one round trip per claim to read it. With
   * four claims that is free. Against a seeded quarter — 137 patients, 141 claims, 91 posted
   * advices — `readCopies` took 31 seconds and the whole monitors endpoint 71, on a watchdog that
   * ticks every 60. A monitor that cannot finish before its next tick has stopped being a monitor,
   * and the Ops screen an operator opens when something is already wrong was the screen that hung.
   *
   * A payment is written onto a claim only by `recordPayment`, from a `remittance.posted` event, and
   * that always moves the claim into an adjudicated status. So a claim that is still `draft`,
   * `ready`, `submitted`, `rejected` or `void` has nothing to compare, and fetching it costs a round
   * trip to learn that. Filtering by status is not a sampling shortcut — it is the same set, reached
   * without the reads that could only ever return nothing. Here it removes 51 of 141 reads.
   *
   * ── WHAT THIS DOES NOT FIX, MEASURED RATHER THAN GUESSED ─────────────────────────────────────
   * The remaining shape is still one read per posted advice plus one per adjudicated claim: 181
   * sequential round trips on that dataset. Most of the 31 seconds was never the query — it was the
   * WAN latency of a laptop talking to a managed Postgres, measured at 190-222ms per round trip, and
   * 181 × 200ms is 36 seconds almost exactly. Colocated with its database an application pays 1-5ms
   * for the same trip, so the same work is one to two seconds there.
   *
   * So this is a development-environment stall AND a genuine scaling limit, and it is worth being
   * precise about which: the endpoint is usable in a deployment and grows linearly with adjudicated
   * claims, so a practice with several thousand will meet it again. The fix when it matters is a
   * projection the repository can compare in SQL — deliberately not done here, because the current
   * shape is what lets this check run identically against the in-memory stores and so be exercised
   * by the whole business suite, and trading that away is a decision with evidence attached, not a
   * tidy-up.
   *
   * `COPY_SCAN_LIMIT` still bounds what remains, and still reports truncation.
   */
  const adjudicated = (await services.claims.list()).filter((c) => ADJUDICATED_STATUSES.includes(c.status));
  for (const item of adjudicated) {
    if (compared >= COPY_SCAN_LIMIT) {
      truncated = true;
      break;
    }
    const view = await services.claims.get(item.id);
    for (const payment of view?.claim.payments ?? []) {
      compared += 1;
      seen.add(payment.postingId);
      const source = byPosting.get(payment.postingId);
      if (!source) {
        // A payment on a claim whose remittance no longer records it. Not necessarily corruption —
        // a held remittance has no posted copy — but it is never nothing, so it is reported.
        orphans.push(payment.postingId);
        continue;
      }
      const differs = (field: string, a: Cents | string, b: Cents | string) => {
        if (String(a) !== String(b)) {
          mismatches.push({ postingId: payment.postingId, field, remittance: String(a), claim: String(b) });
        }
      };
      differs("paidAmount", source.paid, payment.paidAmount);
      differs("patientResponsibility", source.responsibility, payment.patientResponsibility);
      if (source.outcome) differs("outcome", source.outcome, payment.outcome);
    }
  }

  return { mismatches, orphans, compared, truncated };
}

/**
 * Take every money reading for every practice, each inside its own practice-scoped transaction.
 *
 * In memory there is one implicit practice and no transaction to open, so the calls go straight
 * through — which keeps the DB-free demo and the whole business suite exercising the same code path
 * as production rather than a simplified twin of it.
 *
 * ── THREE READINGS, ONE TRANSACTION PER PRACTICE ───────────────────────────────────────────────
 * Opening three scoped transactions per practice per tick would triple the monitor's cost against a
 * remote database for no gain — these are three questions about the same tenant at the same instant,
 * and taking them together also means the numbers cannot describe different moments.
 *
 * But each read is caught SEPARATELY inside that shared transaction. One tenant's broken data must
 * not blind the monitor to every other tenant's money, and one broken READING must not blind the
 * monitor to the other two: a repository that cannot answer "how much is held" says nothing about
 * whether the drift query works. That is the same property `runChecks` maintains between the outbox
 * and the money, applied one level down.
 */
async function readOnePractice(services: Services, practiceId: string, now: Date = new Date()): Promise<PracticeReading> {
  const reading: PracticeReading = {
    practiceId,
    reconciliation: null,
    held: null,
    coordination: null,
    deadLetters: null,
    copies: null,
    unstableRates: null,
    lapsedRates: null,
  };
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      defaultLogger.error(`${what} failed for one practice`, {
        channel: "error",
        practiceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  reading.reconciliation = await attempt("reconciliation", () => services.remittance.reconcileAll());
  reading.held = await attempt("held-remittance summary", () => services.remittance.unattendedHeldSummary());
  reading.coordination = await attempt("coordination cases", () => listCoordinationWork(services, now));
  reading.deadLetters = await attempt("ERA dead-letter scan", () => services.remittance.deadLetteredArtifacts());
  reading.copies = await attempt("payment-copy comparison", () => readCopies(services));
  reading.unstableRates = await attempt("contracted-rate stability", async () =>
    (await services.allowedAmounts.listAll())
      .filter((r) => r.restatements >= RATE_RESTATEMENT_LIMIT)
      .map((r) => ({ payerId: r.payerId, cdtCode: r.cdtCode, allowed: r.allowed, restatements: r.restatements }))
  );
  reading.lapsedRates = await attempt("contracted-rate currency", async () =>
    (await services.allowedAmounts.listAll())
      .filter((r) => r.fullPriceSince >= FULL_PRICE_RUN_LIMIT)
      .map((r) => ({ payerId: r.payerId, cdtCode: r.cdtCode, allowed: r.allowed, fullPriceSince: r.fullPriceSince }))
  );
  return reading;
}

/**
 * The AMBIENT practice's money readings, inside whatever transaction the caller already opened.
 *
 * No `withPractice` and no practice enumeration: a request is already scoped, and re-scoping inside
 * it is how a screen ends up reading a tenant its user is not. The reads themselves are the same
 * three, through the same failure-isolating helper, so a screen and the watchdog cannot come to
 * different conclusions about the same practice.
 */
async function readCurrentPractice(services: Services, now: Date = new Date()): Promise<PracticeReading> {
  return readOnePractice(services, services.persistent ? "current" : "in-memory", now);
}

async function readEveryPractice(services: Services, now: Date = new Date()): Promise<PracticeReading[]> {
  const read = (practiceId: string) => readOnePractice(services, practiceId, now);

  if (!services.persistent) return [await read("in-memory")];

  const { rows } = await withoutPractice((tx) =>
    tx.query("SELECT id FROM practices WHERE status = 'active' ORDER BY id")
  );

  const readings: PracticeReading[] = [];
  for (const row of rows as { id: string }[]) {
    try {
      readings.push(await withPractice(row.id, () => read(row.id)));
    } catch (err) {
      // The transaction itself could not be opened — nothing about this practice was read.
      defaultLogger.error("money readings failed for one practice", {
        channel: "error",
        practiceId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return readings;
}

/**
 * Write one notification to the alert channel, and send it wherever this deployment sends alerts.
 *
 * The log line stays exactly as it was and is written FIRST. It is the record — a webhook that is
 * misconfigured, rate-limited or simply not there must never be the reason an alert went unrecorded,
 * and `notify` is fire-and-forget by construction (see `createAlertNotifier`).
 */
export function emit(log: Logger, note: AlertNotification, notify?: (p: AlertPayload) => void): void {
  const write = note.kind === "firing" ? log.error.bind(log) : log.info.bind(log);
  write(note.message, { channel: "alert", alert: note.key, state: note.kind, since: note.since, ...note.detail });
  notify?.({ key: note.key, state: note.kind, message: note.message, since: note.since, detail: note.detail });
}

/**
 * Start the watch.
 *
 * Only under Postgres: the in-memory demo has no durable queue to stall and no persisted money to
 * reconcile, so a timer there would only ever produce noise. `unref()` so it never holds the
 * process open — a monitor must not be the reason a deploy will not exit.
 */
export function startMonitors(services: Services, options: MonitorOptions = {}, intervalMs = 60_000): { stop(): void } {
  if (!services.persistent) return { stop() {} };

  const log = options.logger ?? defaultLogger;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const gate = new AlertGate(options.policy);

  const tick = async (): Promise<void> => {
    try {
      for (const note of await runChecks(services, gate, thresholds)) emit(log, note, options.notify);
    } catch (err) {
      log.error("monitor tick failed", {
        channel: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
