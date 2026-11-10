/**
 * The unified Today queue (blueprint doc 07) — one value-ranked worklist across every module.
 *
 * ── WHY THIS IS COMPOSED HERE, NOT PROJECTED ───────────────────────────────────────────────────
 * The obvious alternative is a materialized queue table fed by domain events, like Analytics. It was
 * not chosen, for a reason that only shows up in operation: a queue projection must be told when an
 * item is RESOLVED as reliably as when it is created. Every module already publishes "this needs
 * attention" events, but resolution is diffuse — a verification stops needing review when a human
 * reviews it, a claim stops being at filing risk when it is filed OR voided OR written off — and a
 * Today queue that shows work which is already done is worse than no Today queue at all, because
 * staff learn to distrust it and then stop opening it.
 *
 * Composing from each module's own ranked list is therefore both simpler and strictly more correct:
 * each module is the authority on what it still needs a human for, and the answer cannot go stale.
 * The cost is four indexed, practice-scoped queries per load, which is not a scaling concern at the
 * size this serves.
 *
 * This lives in the composition root because it is the one place permitted to know every module
 * exists. No module imports another to make it work.
 *
 * ── RANKING ACROSS DIFFERENT KINDS OF WORK ─────────────────────────────────────────────────────
 * Every module already scores its own items 0–100 on the same "what does it cost the practice to
 * leave this alone" basis, so the scores are directly comparable. Ties break toward money at stake,
 * because between two equally urgent tasks the larger one is the better use of the next ten minutes.
 *
 * ── WHAT EACH MODULE IS ASKED FOR, AND WHY ─────────────────────────────────────────────────────
 * Each query is the module's own "still open" filter, never a status list assembled here — the
 * module is the authority on what it still needs a human for, and duplicating that judgement in the
 * composition root is how the two drift apart.
 *
 * The one case worth stating outright: **an adjudicated claim (denied, partially paid) is NOT
 * claims work here.** The Claims module ranks those highly, and rightly — but by the time a payer
 * has ruled, the actionable unit is the payer's REASON, and Denials & Appeals owns that with a
 * specific disposition attached. Listing both would put the same money on the board twice under two
 * different recommended actions, which is worse than listing it once.
 *
 * That exclusion is applied HERE, visibly, rather than by narrowing what the Claims module calls
 * "open". It is this screen's editorial judgement about overlap, not a fact about a claim — and for
 * a while it was accidentally true instead, because the in-memory and Postgres claim repositories
 * had drifted to different definitions of `openOnly`.
 */
import { calendarDay, can, type Permission, type Role } from "@mermaid/shared";
import { ADJUDICATED_STATUSES } from "@mermaid/claims";
import type { SourceKind } from "@mermaid/verification";
import type { Services } from "./wiring.ts";
import { isOpen, listCoordinationWork } from "./coordination.ts";

/**
 * Where the practice's money is, right now.
 *
 * Every field is read from the module that owns it, never re-derived from another figure on this
 * board. The buckets are deliberately NOT a partition of one total — held cash, money a payer owes,
 * money a patient owes and money at risk are four different questions, and adding them together
 * would produce a number that describes nothing.
 */
/**
 * ── WHY EVERY FIGURE HERE IS NULLABLE ──────────────────────────────────────────────────────────
 * `null` means "this viewer may not see it". It is emphatically NOT zero, and the two must never be
 * conflated: telling a front-desk user that patients owe $0.00 is a false statement about the
 * practice's money, where telling them the figure is not theirs to see is a true one.
 *
 * The route is gated on `queue.read` alone, which every role holds — that is correct for a worklist
 * and wrong for a financial position. A front-desk role deliberately excludes claims, remittances,
 * denials and analytics; before this, adding the money position to the board handed all four to it.
 */
export interface TodayMoney {
  /** Received and not yet posted: in the bank, against nothing. */
  heldInBank: number | null;
  heldCount: number | null;
  oldestHeldAt: string | null;
  /** Withheld on POSTED advices for reasons worth pursuing with that payer. */
  owedByPayers: number | null;
  /** Assigned to a second plan that has not ruled. Neither a write-off nor the patient's. */
  withOtherPlans: number | null;
  /** Still expected on claims no payer has finished adjudicating. */
  expectedFromPayers: number | null;
  owedByPatients: number | null;
  aging: Record<string, number> | null;
  /** Share of patient money older than 90 days, 0–1, or null when nothing is outstanding. */
  overNinetyShare: number | null;
  /** Refused by a payer and not yet won back. */
  deniedUnrecovered: number | null;
  /** Cash that came back because an appeal was won. */
  recoveredByAppeal: number | null;
  /** What a missing or unchecked pre-authorisation would cost on claims not yet filed. */
  preAuthAtRisk: number | null;
  /**
   * The held advices themselves, not just their total.
   *
   * The board lists them one by one, because "$1,599.98 held" is a number a person can do nothing
   * with — releasing money requires knowing WHICH advice, from whom, and how long it has sat. The
   * alternative was for the client to re-derive this by pattern-matching the age out of the
   * human-readable subtitle the module writes, which would break silently the first time somebody
   * improved that sentence.
   */
  heldAdvices: TodayHeldAdvice[] | null;
}

export interface TodayHeldAdvice {
  id: string;
  payerName: string;
  traceNumber: string;
  amount: number;
  receivedAt: string;
  /** Whole days on hold. Three is the review threshold the recommendation engine uses. */
  ageDays: number;
  holdReason: string | null;
}

/**
 * A queue item plus the CANDIDATE fact that could tell it apart from an identical twin.
 *
 * `telling` never leaves this file: `disambiguate` promotes it to `distinguisher` on the rows that
 * actually have a twin and deletes it everywhere else, so a row with no ambiguity carries nothing
 * extra. Carried per-row rather than derived in the pass because only the producer knows what makes
 * two of ITS rows different — a member ID for a coverage check, a trace number for an advice, a
 * procedure code for a denial. A generic rule here would have to guess, and would guess wrong.
 */
type Draft = TodayItem & { telling?: TodayItem["distinguisher"] };

/** Which part of the cycle an item came from — the UI colours and groups by this. */
export type TodayKind = "verification" | "claim" | "remittance" | "denial" | "patient" | "era";

export interface TodayItem {
  kind: TodayKind;
  id: string;
  /** Who or what this is about, in the words a human would use. */
  title: string;
  subtitle: string;
  /**
   * The one fact that tells this row apart from an identical twin ON THIS BOARD — present only when
   * there is a twin, absent otherwise.
   *
   * ── WHY IT TRAVELS STRUCTURED AND NOT FOLDED INTO `subtitle` ──────────────────────────────────
   * The first version of this appended the clause to the subtitle server-side, and for a coverage
   * check the clause is a MEMBER ID. `today.js` masks `title` through `maskName` and renders
   * `subtitle` verbatim — correctly, since a subtitle is a payer and a status — so a member id
   * folded into it would have printed in full in **presentation mode**, which exists precisely to
   * stop an identifier being read off a screen turned around in an operatory.
   *
   * So the server says what the fact IS and the client decides how to show it, which is the same
   * division `maskName` already rests on. `maskId` keeps the last two characters, which is exactly
   * enough to keep two rows apart without being an identifier — the case it was written for.
   */
  distinguisher?: { memberId: string } | { text: string } | null;
  /** What to actually do. Always the module's own recommendation — never re-derived here. */
  action: string;
  /** Money at stake, integer cents. Zero when the item is not about money. */
  amount: number;
  /** 0–100, comparable across kinds. */
  priority: number;
  /** Set when there is a deadline that loses money if missed. */
  dueDate: string | null;
  /**
   * True when `dueDate` was computed from a Mermaid default rather than the payer's own terms.
   *
   * The countdown is real either way and ranks the same — this says how SURE the date is, not how
   * soon. A board that shows an assumed date identically to a stated one invites a biller to plan
   * around a day no payer ever named.
   */
  dueDateEstimated?: boolean;
  /** The biller-facing sentence explaining an assumed `dueDate`, or null. */
  dueDateNote?: string | null;
  /** True when that deadline is close or gone. */
  urgent: boolean;
  /**
   * Where this item's coverage information came from — present on verifications, null elsewhere.
   *
   * Deliberately NOT synthesised for claims, remittances and denials. Those descend from a
   * verification, so it is tempting to inherit its badge, and the inheritance would be wrong often
   * enough to matter: a claim can be filed after a coverage was re-verified against a different
   * source, and a remittance is the payer's own statement about money regardless of how eligibility
   * was checked. A badge that is right most of the time is worse here than no badge, because this
   * whole feature exists to stop a screen implying confirmation it cannot support. `sources` below
   * carries the queue-level answer instead.
   */
  source: TodayItemSource | null;
}

/** The provenance facts a queue row needs — a narrow projection of `VerificationProvenance`. */
export interface TodayItemSource {
  kind: SourceKind;
  label: string;
  shortLabel: string;
  dataSource: string;
  clearinghouseName: string | null;
  clearinghouseId: string | null;
  benefitsRetrieved: boolean;
}

/**
 * How long a patient balance is left alone before it counts as work.
 *
 * One statement cycle. It matches the first aging bucket's boundary deliberately: a queue and an
 * aging report that disagreed about when a balance becomes overdue would be two answers to one
 * question.
 */
const STATEMENT_CYCLE_DAYS = 30;

/**
 * How long a held remittance may sit before it counts as overdue work.
 *
 * ── WHY THREE DAYS, AND WHY THERE IS A NUMBER AT ALL ───────────────────────────────────────────
 * A held remittance is cash the payer has ALREADY SENT, sitting in the practice's bank against no
 * ledger entry, because the safety gate refused to post it. The refusal is right — it is the whole
 * design, and nothing here changes it. What was missing is that the refusal had no clock: this
 * queue set `dueDate: null` on every held remittance and marked it urgent only when it failed to
 * balance, so the two holds the money-safety work most recently ADDED — a coordination hold (M8)
 * and a payee mismatch (G1), both of which balance perfectly — could never become urgent at all.
 * The newest safety work was the least visible work on the board.
 *
 * Three days rather than a statement cycle because the failure modes differ in kind. An aging
 * patient balance is money someone has not paid yet; a held remittance is money already received
 * that nobody has been able to attribute, and every day it sits is a day the underlying claim's
 * appeal and timely-filing windows run down behind it. Short enough that a hold is worked in the
 * week it lands, long enough to survive a weekend and a public holiday without crying wolf.
 *
 * This is a REVIEW deadline, not a release deadline. Nothing anywhere posts because a hold got old
 * — that would invert the entire safety model, turning "when uncertain, hold" into "when uncertain,
 * wait three days and then post anyway". Ageing raises a person's attention; only a person releases.
 */
export const HELD_REMITTANCE_REVIEW_DAYS = 3;

const DAY_MS = 86_400_000;

/** Whole days between two instants, floored — "how many days has this been sitting". */
const daysBetween = (from: string, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS));

/** Integer cents → a plain dollar string for a queue subtitle. */
const usd = (amountCents: number): string =>
  `$${(amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface TodayQueue {
  items: TodayItem[];
  /** Totals by kind, so the UI can show where the day's work actually is. */
  counts: Record<TodayKind, number>;
  /** Money attached to everything in the queue. */
  atStake: number;
  urgentCount: number;
  /** Where the practice's money is — the question an owner opens the app with. */
  money: TodayMoney;
  /**
   * How many verifications in this queue came from where — the queue-level answer to "has a payer
   * actually confirmed any of this?".
   *
   * Counted over the verifications ON THE BOARD, not over the practice's history, because the
   * question this answers is about what the person is looking at right now.
   */
  sources: Record<SourceKind, number>;
  /**
   * The instant this board describes.
   *
   * A dashboard that says nothing about its own freshness invites a reader to assume it is live when
   * it may be a tab left open since this morning. Stamped by the composition root, from the same
   * `now` every other figure on the board was computed against, so "updated 3 minutes ago" refers to
   * exactly the moment the money was read and not to when the browser happened to render it.
   */
  generatedAt: string;
  /** What has actually happened lately, newest first. */
  recentActivity: TodayActivity[];
}

/**
 * One thing that happened, for the activity feed.
 *
 * ── WHY A DASHBOARD NEEDS THIS AT ALL ──────────────────────────────────────────────────────────
 * Every other figure on the board is a POSITION — what is true now. A position cannot distinguish a
 * practice where nothing needs doing from one where the integration silently stopped three days ago,
 * and those two look identical and mean opposite things. The feed is the only element that answers
 * "is this thing still working", which is the question a person actually has when a board is calm.
 *
 * Read from the same lists the queue is built from. Nothing here is a new query and nothing is
 * invented — every row is an event a module recorded, with the timestamp it recorded.
 */
export interface TodayActivity {
  kind: TodayKind;
  at: string;
  /** What happened, in the past tense, as a person would say it. */
  text: string;
  /** The money involved, or null where the event is not about an amount. */
  amount: number | null;
  /** Where clicking goes, when there is somewhere to go. */
  id: string | null;
}

/**
 * Build the queue. Each module answers only for its own work; this merges and ranks.
 *
 * Runs inside the caller's practice-scoped transaction, so every underlying query is RLS-scoped.
 */
export async function buildTodayQueue(
  services: Services,
  limit = 50,
  now: Date = new Date(),
  /**
   * Who is asking. `null` means nobody is — the DB-free demo has no accounts at all, and in-process
   * callers compose the whole board deliberately. A real HTTP request always carries a role.
   */
  viewer: { role: Role } | null = null
): Promise<TodayQueue> {
  const timeZone = services.timeZone ?? "UTC";
  /**
   * The route is gated on `queue.read`, which every role holds, because a worklist is everybody's
   * screen. What a worklist may CONTAIN is a different question, and it is answered per module here
   * — the alternative being a second permission on the route, which would take the board away from
   * the front desk entirely rather than showing them their half of it.
   */
  const may = (p: Permission): boolean => viewer === null || can(viewer.role, p);
  const mayVerifications = may("verifications.read");
  const mayClaims = may("claims.read");
  const mayRemittances = may("remittances.read");
  const mayDenials = may("denials.read");
  const mayPatients = may("patients.read");
  /**
   * Awaited in sequence, not as a `Promise.all`.
   *
   * A request holds ONE pooled client — that is what makes the tenant context and the outbox's
   * atomicity work — and node-postgres serialises anything queued on it. So these six reads never
   * ran concurrently; the driver simply queued them while warning that *"Calling client.query() when
   * the client is already executing a query is deprecated and will be removed in pg@9.0."* Same cost,
   * no deprecated call, and the code no longer implies a parallelism the architecture cannot give.
   *
   * `now` is threaded rather than defaulted so the whole board describes ONE instant. A queue that
   * reads the clock separately per module can render a hold as 2 days old beside a due date computed
   * from a different millisecond, which is the sort of inconsistency that costs a screen its
   * credibility long before it costs anyone money.
   */
  const verifications = mayVerifications ? await services.verification.list({ openOnly: true }) : [];
  const claims = mayClaims ? await services.claims.list({ openOnly: true }) : [];
  const remittances = mayRemittances ? await services.remittance.list({ needsAttention: true }, now) : [];
  const denials = mayDenials ? await services.denials.list({ openOnly: true }) : [];
  const accounts = mayPatients ? await services.ledger.list({ withBalanceOnly: true }) : [];
  const eraDeadLetters = mayRemittances ? await services.remittance.deadLetteredArtifacts() : [];
  const coordination = mayRemittances ? (await listCoordinationWork(services, now)).filter(isOpen) : [];

  /**
   * ── THE PRACTICE'S MONEY POSITION ─────────────────────────────────────────────────────────────
   * The queue answers "what needs a person". It has never answered the question an owner actually
   * opens the app with — "where is my money" — and that answer was scattered across four other
   * screens. Composed here for the same reason the queue is: this is the one place permitted to
   * know every module exists, and asking each of them once is cheaper and more consistent than a
   * dashboard making five round trips and rendering five different instants.
   *
   * Every figure below is read from a module's own aggregate. Nothing on this board is derived from
   * another board's derived number.
   */
  const ledger = mayPatients ? await services.ledger.summary(now) : null;
  const held = mayRemittances ? await services.remittance.heldSummary() : null;
  const allRemittances = mayRemittances ? await services.remittance.list(undefined, now) : null;
  const allDenials = mayDenials ? await services.denials.list(undefined, now) : null;
  const openClaims = claims.filter((c) => !ADJUDICATED_STATUSES.includes(c.status));

  const money: TodayMoney = {
    /** Cash in the bank against nothing — the only figure here the practice already HAS. */
    heldInBank: held ? held.totalCents : null,
    heldCount: held ? held.count : null,
    oldestHeldAt: held ? held.oldestReceivedAt : null,
    /**
     * Posted advices only, matching the Money screen. A held advice has not been accepted, so
     * nothing on it is yet a fact about what a payer owes.
     */
    owedByPayers:
      allRemittances?.filter((r) => r.status === "posted").reduce((t, r) => t + r.totalRecoverable, 0) ?? null,
    withOtherPlans:
      allRemittances?.filter((r) => r.status === "posted").reduce((t, r) => t + r.totalWithOtherPayers, 0) ?? null,
    /** What the practice still expects on claims no payer has finished. */
    expectedFromPayers: mayClaims ? openClaims.reduce((t, c) => t + c.outstanding, 0) : null,
    owedByPatients: ledger ? ledger.totalOutstanding : null,
    aging: ledger ? ledger.aging : null,
    overNinetyShare: ledger ? ledger.overNinetyShare : null,
    /** Denied and still disputed — money a payer refused that nobody has won back. */
    deniedUnrecovered:
      allDenials
        ?.filter((d) => d.status !== "recovered" && d.status !== "written_off")
        .reduce((t, d) => t + d.deniedAmount, 0) ?? null,
    recoveredByAppeal: allDenials?.reduce((t, d) => t + (d.recoveredAmount ?? 0), 0) ?? null,
    /**
     * Pre-authorisation exposure on claims NOT YET FILED. Deliberately scoped to those: once a claim
     * is filed the exposure has either been realised or avoided, and counting it afterwards would
     * report money at risk that is no longer at stake either way.
     */
    preAuthAtRisk: mayClaims
      ? claims.filter((c) => c.status === "draft" || c.status === "ready").reduce((t, c) => t + (c.preAuthRiskAmount ?? 0), 0)
      : null,
    heldAdvices:
      allRemittances
        ?.filter((r) => r.status === "held")
      .map((r) => ({
        id: r.id,
        payerName: r.payerName,
        traceNumber: r.traceNumber,
        amount: r.paymentTotal,
        receivedAt: r.receivedAt,
        ageDays: Math.max(0, Math.floor((now.getTime() - new Date(r.receivedAt).getTime()) / 86_400_000)),
        holdReason: r.holdReason,
      }))
        .sort((a, b) => b.ageDays - a.ageDays || b.amount - a.amount) ?? null,
  };

  const items: Draft[] = [];

  for (const v of verifications) {
    items.push({
      kind: "verification",
      id: v.id,
      title: v.patientName,
      subtitle: `${v.payerName ?? "Unknown payer"} · verification needs a person`,
      /**
       * The member ID, because an account keyed by a member ID is a POLICY (PRODUCT.md). Two checks
       * for one person under two member IDs are two policies, and which one the practice is quoting
       * from is the whole question. Falling back to the day it was checked covers the re-verify
       * case, where the same policy was checked twice.
       */
      telling: v.memberId
        ? { memberId: v.memberId }
        : { text: `checked ${calendarDay(new Date(v.createdAt), timeZone)}` },
      action: v.recommendedAction,
      amount: v.patientPays ?? 0,
      priority: v.priority,
      dueDate: null,
      urgent: v.outcome === "blocked",
      source: {
        kind: v.provenance.kind,
        label: v.provenance.label,
        shortLabel: v.provenance.shortLabel,
        dataSource: v.provenance.dataSource,
        clearinghouseName: v.provenance.clearinghouseName,
        clearinghouseId: v.provenance.clearinghouseId,
        benefitsRetrieved: v.provenance.benefitsRetrieved,
      },
    });
  }

  for (const c of claims) {
    // Once a payer has ruled, the denial owns this money. See the header comment.
    if (ADJUDICATED_STATUSES.includes(c.status)) continue;
    items.push({
      kind: "claim",
      id: c.id,
      title: c.patientName,
      subtitle: `${c.payerName ?? "Unknown payer"} · claim ${c.status.replace(/_/g, " ")}`,
      // Two claims for one patient with one payer are two visits. The date of service is what the
      // practice's own chart is filed under, and what a payer quotes back.
      telling: { text: `service ${c.serviceDate}` },
      action: c.recommendedAction,
      /**
       * What this row is WORTH, which is not always what a payer will pay.
       *
       * Once a payer has ruled, the outstanding balance is the number that matters; before that, it
       * is what we expect them to pay. Both were already right. What was missing is the case where
       * the payer will pay NOTHING: Ben Demo's coverage is inactive, his claim expects $0.00 from
       * the payer and $175.00 from him, and the board listed him at $0.00 beside the instruction
       * "Do not file. Re-verify coverage, or collect from the patient directly."
       *
       * A row telling a biller to collect $175.00 from a patient, valued at nothing, sorts to the
       * bottom of a board ranked by what it costs to leave alone — and $175.00 nobody collects is
       * exactly as lost as $175.00 a payer never pays.
       */
      amount:
        c.outstanding > 0
          ? c.outstanding
          : c.expectedInsurancePays > 0
            ? c.expectedInsurancePays
            : c.expectedPatientPays,
      priority: c.priority,
      dueDate: c.filingDeadline,
      dueDateEstimated: c.filingDeadlineEstimated,
      dueDateNote: c.filingDeadlineNote,
      urgent: c.filingRisk === "urgent" || c.filingRisk === "expired",
      source: null,
    });
  }

  for (const r of remittances) {
    const held = r.status === "held";
    /**
     * The review clock. Held money is the only item on this board whose deadline is measured from
     * when it ARRIVED rather than from a date some other party set, because the practice already
     * has the cash — the countdown is on us, not on the payer.
     */
    const heldDays = held ? daysBetween(r.receivedAt, now) : 0;
    /**
     * A calendar day in the practice's zone, not an instant.
     *
     * The two other producers on this board — a claim's filing deadline and a denial's appeal
     * deadline — are already `YYYY-MM-DD`, and the client renders `dueDate` verbatim because it has
     * no timezone of its own. Emitting `.toISOString()` here put `by 2026-08-31T04:40:14.825Z` on
     * screen next to rows showing plain dates. The deadline is a day a human works to, so the day
     * is what this reports.
     */
    const reviewBy = held
      ? calendarDay(
          new Date(new Date(r.receivedAt).getTime() + HELD_REMITTANCE_REVIEW_DAYS * DAY_MS),
          timeZone
        )
      : null;

    items.push({
      kind: "remittance",
      id: r.id,
      title: r.payerName || "Unknown payer",
      /**
       * The payment DATE is on the row because the age is not an identifier.
       *
       * Staging carries two Cigna advices that are identical on this board -- same payer, same
       * $799.99, same claim, same "FORWARDED to another plan" reason -- differing only in that one
       * read "held 0 days" and the other "held 3 days". Neither carries a trace or check number
       * (which is precisely why both are held), so a biller looking at the queue had no way to tell
       * whether Cigna had sent $799.99 once or twice, and releasing both posts $1,599.98 against one
       * payment. The Money screen already leads with this date; the queue that ranks the work did
       * not.
       */
      /**
       * ── THE SUBTITLE IDENTIFIES; THE ACTION EXPLAINS. NEITHER REPEATS THE OTHER ────────────────
       * This used to end with `r.holdReason`, and `recommendedAction` for a held advice is
       * "Review and release — {the same hold reason}". So the reason was printed twice, in full,
       * one line under the other. On staging that is 243 characters followed by 211 characters
       * saying the same thing, and the two Cigna rows rendered two and a half times the height of
       * every other item on the board — on the one screen whose stated job is to be answerable in
       * five seconds without scrolling.
       *
       * The subtitle now carries only what tells two advices APART — the payment date, how long it
       * has been held, and the amount — which is the whole reason the date was put here. The reason
       * itself travels with the instruction, where it is one sentence instead of two.
       */
      subtitle: held
        ? `Paid ${r.paymentDate} · held ${heldDays} day${heldDays === 1 ? "" : "s"} · ${usd(r.paymentTotal)} not posted`
        : `${r.claimCount} claim${r.claimCount === 1 ? "" : "s"} · money still owed`,
      /**
       * A POSTED advice's row carries no date at all, so two Cigna advices with one claim each read
       * identically — which is exactly what the board showed with real data (audit B-7). The trace
       * number is the payer's own handle for the payment and the thing a biller would quote back to
       * them; the payment date is the fallback for an advice that arrived without one, which is the
       * same condition that puts an advice on hold in the first place.
       */
      telling: { text: r.traceNumber ? `trace ${r.traceNumber}` : `paid ${r.paymentDate}` },
      action: r.recommendedAction,
      amount: r.totalRecoverable > 0 ? r.totalRecoverable : r.paymentTotal,
      priority: r.priority,
      dueDate: reviewBy,
      /**
       * ── THE `!balanced` CONJUNCT IS DELIBERATELY GONE ──────────────────────────────────────────
       * It used to read `held && !balanced`, which made "does the arithmetic add up" the test for
       * "does this need someone today". Those are different questions, and the gap between them is
       * precisely where the newest safety work landed: a coordination hold and a payee mismatch both
       * balance to the cent — the money is entirely accounted for, and its OWNER is unknown. Under
       * the old condition they were never urgent however long they sat.
       *
       * Age is the test now, for every hold whatever its blocker. An unbalanced advice is still
       * ranked above a balanced one, by the priority the module already assigns (90 vs 75).
       */
      urgent: held && heldDays >= HELD_REMITTANCE_REVIEW_DAYS,
      source: null,
    });
  }

  /**
   * ── COORDINATION WORK NOT ALREADY ON THE BOARD (0034) ─────────────────────────────────────────
   * A held advice with a coverage question is already a row above, and its action already states
   * the question — so it is not listed twice. What this adds is the work a HELD row cannot show:
   * posted advices whose money was assigned to another plan, where a secondary claim has to be
   * filed or the coverage question is still open. Before this, that money appeared as a sentence on
   * an advice nobody opened; on staging, $1,527.01 across six claims.
   *
   * Opens the advice (kind `remittance`), because that is where the actions live. The amount is the
   * money assigned to the other plan — at risk, never collected — and the due date is the secondary
   * claim's filing deadline from the existing engine, marked as an estimate like every other.
   */
  const onBoard = new Set(items.filter((i) => i.kind === "remittance").map((i) => i.id));
  for (const c of coordination) {
    if (!c.remittanceId || onBoard.has(c.remittanceId)) continue;
    const coverage = c.coverageStatus === "unconfirmed";
    const deadline = c.deadline;
    items.push({
      kind: "remittance",
      id: c.remittanceId,
      title: c.primaryPayerName,
      subtitle:
        `Claim ${c.patientControlNumber} · ${usd(c.assignedCents)} assigned to another plan · ` +
        (coverage ? "coverage unconfirmed" : c.workStatus.replaceAll("-", " ")),
      telling: { text: `claim ${c.patientControlNumber}` },
      action: coverage
        ? `Confirm whether the patient has another plan — ${c.primaryPayerName} assigned ${usd(c.assignedCents)} to one.`
        : (c.blockedReason ??
          (c.workStatus === "ready-to-file"
            ? `File the secondary claim with ${c.case.confirmation?.secondary?.payerName ?? "the other plan"}.`
            : c.workStatus === "filed"
              ? "Secondary claim filed — record the other plan's answer when it comes."
              : "Finish the secondary claim.")),
      amount: c.assignedCents,
      priority: coverage ? 72 : c.workStatus === "ready-to-file" ? 70 : 60,
      dueDate: deadline?.deadline ?? c.case.request?.followUpBy ?? null,
      dueDateEstimated: deadline ? deadline.estimated : false,
      dueDateNote: deadline?.estimateNote ?? null,
      urgent: Boolean(deadline && c.workStatus !== "filed" && (deadline.risk === "urgent" || deadline.risk === "expired")),
      source: null,
    });
  }

  /**
   * ERA files that were abandoned (M13's other half).
   *
   * ── WHY THIS IS ON THE BOARD AT ALL ────────────────────────────────────────────────────────────
   * A dead-lettered artifact is a payer's payment file that Mermaid was told about, failed to ingest
   * five times, and then stopped retrying. Until now `EraArtifactRepository.list()` had no caller
   * outside its own tests: no route, no queue, no monitor. The file simply stopped being mentioned.
   *
   * It is invisible to `reconcileAll()` for the opposite reason a held remittance is: a held
   * remittance IS a row, so its money reconciles while nobody works it; a dead-lettered artifact
   * never became a remittance at all, so it contributes nothing to either side of the sum. Both
   * report "balanced". That is the same detectability gap as the swallowed second payment (M1) —
   * money the payer has sent, and no screen anywhere that says so.
   *
   * `amount: 0` is honest rather than lazy: the file was never parsed, so its value is genuinely
   * unknown. Inventing a figure would put a number on the board that nothing in the system supports,
   * and the ranking below breaks ties toward money — a guess here would reorder real amounts.
   */
  for (const artifact of eraDeadLetters) {
    items.push({
      kind: "era",
      id: artifact.id,
      title: `ERA file ${artifact.fileExecutionId}`,
      subtitle:
        `Abandoned after ${artifact.attempts} attempt${artifact.attempts === 1 ? "" : "s"} · ` +
        `${artifact.lastError ?? "no reason recorded"}`,
      action:
        "Retrieve this file from the clearinghouse by hand and upload it. Until then its payments " +
        "are not on the ledger and the claims it settles still read as unpaid.",
      amount: 0,
      // Above every routine item and below nothing: a payment file nobody can see is the most
      // expensive thing on this board precisely because its amount is unknown.
      priority: 95,
      // No clock: retries are already exhausted, so there is nothing left to wait for. It is late
      // the moment it appears.
      dueDate: null,
      urgent: true,
      source: null,
    });
  }

  for (const d of denials) {
    items.push({
      kind: "denial",
      id: d.id,
      title: d.patientName,
      subtitle: `${d.payerName} · ${d.carcCode} ${d.carcDescription}`,
      // One payer refusing one patient twice under the same CARC is two procedures, or the same
      // procedure on two dates. Both are on the denial; the code is the shorter of the two.
      telling: { text: d.procedureCode ? `on ${d.procedureCode}` : `found ${d.detectedAt.slice(0, 10)}` },
      action: d.recommendedAction,
      // Expected recovery, not the denied amount: the queue ranks by what is retrievable.
      amount: d.expectedRecovery,
      priority: d.priority,
      dueDate: d.appealDeadline,
      // Ranking is deliberately unchanged: an assumed deadline is as urgent as a stated one. Only
      // the provenance travels, so the board can show which kind of date it is counting down to.
      dueDateEstimated: d.deadlineEstimated,
      dueDateNote: d.deadlineNote,
      urgent: d.appealWindow === "urgent" || d.appealWindow === "closed",
      source: null,
    });
  }

  /**
   * Patient balances (M9).
   *
   * A balance is only WORK once it has aged past the first statement cycle. Before that, "call this
   * patient" is advice to chase money the post has not yet delivered a bill for, and a queue that
   * says so is a queue people learn to skip. The ledger still ranks fresh balances on its own screen
   * — they are visible there, just not yet actionable here, and that difference is the point.
   */
  for (const account of accounts) {
    if (account.balance <= 0) continue;
    if ((account.daysOutstanding ?? 0) <= STATEMENT_CYCLE_DAYS) continue;
    items.push({
      kind: "patient",
      id: account.patientKey,
      title: account.patientName,
      subtitle: `Patient balance · ${account.daysOutstanding} days outstanding`,
      action: account.recommendedAction,
      amount: account.balance,
      priority: account.priority,
      dueDate: null,
      // Past 90 days a balance is far more likely to be written off than collected. That is the
      // deadline here, and it is as real as a filing deadline even though nothing enforces it.
      urgent: (account.daysOutstanding ?? 0) > 90,
      source: null,
    });
  }

  const ranked = items
    .sort((a, b) => b.priority - a.priority || b.amount - a.amount)
    .slice(0, limit);

  disambiguate(ranked);

  const counts: Record<TodayKind, number> = {
    verification: 0,
    claim: 0,
    remittance: 0,
    denial: 0,
    patient: 0,
    era: 0,
  };
  for (const item of ranked) counts[item.kind] += 1;

  const sources: Record<SourceKind, number> = { live: 0, test: 0, mock: 0, none: 0 };
  for (const item of ranked) if (item.source) sources[item.source.kind] += 1;

  /**
   * ── WHAT HAS HAPPENED, AS OPPOSED TO WHAT NEEDS DOING ─────────────────────────────────────────
   * Built from the lists already read above — no extra query, no invented row. Each entry is an
   * event a module recorded, carrying the timestamp that module wrote.
   *
   * A calm board and a broken integration look identical until something says when the last payer
   * file arrived.
   */
  const activity: TodayActivity[] = [];

  for (const r of allRemittances ?? []) {
    activity.push({
      kind: "remittance",
      at: r.receivedAt,
      text:
        r.status === "posted"
          ? `${r.payerName} paid ${formatCents(r.paymentTotal)} — posted`
          : r.status === "held"
            ? `${r.payerName} sent ${formatCents(r.paymentTotal)} — held for review`
            : `${r.payerName} sent ${formatCents(r.paymentTotal)} — ${r.status}`,
      amount: r.paymentTotal,
      id: r.id,
    });
  }
  for (const d of allDenials ?? []) {
    activity.push({
      kind: "denial",
      at: d.detectedAt,
      text: `${d.payerName} refused ${formatCents(d.deniedAmount)} on ${d.patientName}'s claim — ${d.carcCode}`,
      amount: d.deniedAmount,
      id: d.id,
    });
    /**
     * The win is a second, later event on the same denial, and it needs its OWN instant.
     *
     * This used to be stamped with `detectedAt` — the only timestamp the row carried — which put a
     * fabricated time on a real event and sorted the win alongside the refusal it reversed. It now
     * uses `awardedAt`, which is exactly what it claims: the moment the payer agreed. Skipped
     * entirely when that is absent, because a feed with an invented time is worse than a short one.
     *
     * Deliberately says AWARDED, not recovered. The cash arriving is a separate event with its own
     * entry — the remittance that posted it — and telling the same money twice under two verbs is
     * how a feed starts overstating what a practice has.
     */
    if (d.awardedAt && d.awardedAmount && d.awardedAmount > 0) {
      activity.push({
        kind: "denial",
        at: d.awardedAt,
        text: `Appeal won — ${d.payerName} agreed to pay ${formatCents(d.awardedAmount)} for ${d.patientName}`,
        amount: d.awardedAmount,
        id: d.id,
      });
    }
  }
  /**
   * `createdAt`, not a filing date — a claim list item does not carry one, and inventing "filed"
   * from the moment a draft was written would put a false verb on a screen that exists to be
   * trusted. Only open claims are loaded here, so these are genuinely new work rather than history.
   */
  for (const c of claims) {
    activity.push({
      kind: "claim",
      at: c.createdAt,
      text: `Claim drafted for ${c.patientName} — ${formatCents(c.expectedInsurancePays)} expected from ${c.payerName ?? "the payer"}`,
      amount: c.expectedInsurancePays,
      id: c.id,
    });
  }

  /**
   * Verifications, which are the front desk's whole day.
   *
   * Without these a front-desk board had an EMPTY feed: every other source is gated on a permission
   * that role does not hold, so the one element that answers "is this thing still working" answered
   * nothing for the role most likely to notice when it is not.
   */
  for (const v of verifications) {
    activity.push({
      kind: "verification",
      at: v.createdAt,
      text: `${v.patientName} verified against ${v.payerName ?? "an unknown payer"}${
        v.outcome === "blocked" ? " — needs a person" : ""
      }`,
      amount: v.patientPays ?? null,
      id: v.id,
    });
  }

  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    items: ranked,
    counts,
    atStake: ranked.reduce((sum, i) => sum + i.amount, 0),
    urgentCount: ranked.filter((i) => i.urgent).length,
    money,
    sources,
    generatedAt: now.toISOString(),
    /*
     * Eight was a reading list; this is a signal. The board now plots these events at their real
     * times on a lane per kind, and eight marks cannot show the shape of a week — in particular
     * they cannot show a GAP, which is the one thing this feed exists to reveal: a calm board and a
     * dead payer feed look identical until something says when the last file arrived.
     *
     * Still a truncation, not a window: these are the most recent real events, and nothing is
     * back-filled to make the line look busier.
     */
    recentActivity: activity.slice(0, 60),
  };
}

/**
 * Two rows that would read identically get told apart — and only those two.
 *
 * ── THE DEFECT (audit B-7) ─────────────────────────────────────────────────────────────────────
 * With real data the board printed, one under the other:
 *
 *   $1,425   Quinn Mocktest      MetLife Dental · verification needs a person
 *   $1,425   Quinn Mocktest      MetLife Dental · verification needs a person
 *   $1,125   Cigna Dental        1 claim · money still owed
 *   $1,125   Cigna Dental        1 claim · money still owed
 *
 * Four rows, byte-identical in pairs, and four DIFFERENT records underneath: two coverage checks
 * under two different member IDs, and two advices for two different claims. A biller reading that
 * cannot tell whether they are looking at one thing rendered twice — a refresh bug, which is what
 * everybody assumes first — or two things that both need doing. Clearing one and assuming the other
 * went with it is the failure this costs money on.
 *
 * The held-remittance branch already solved this for its own case, by putting the payment date in
 * the subtitle. That fix was specific to the two Cigna advices somebody had looked at; every other
 * producer on the board kept the collision.
 *
 * ── WHY IT IS APPLIED HERE AND CONDITIONALLY ───────────────────────────────────────────────────
 * Nothing is appended unless a row genuinely has a twin ON SCREEN. A member ID printed beside every
 * name would be six words of noise on the ninety-five per cent of boards that have no duplicate at
 * all, and this screen's whole claim is that it is answerable in five seconds — spending that
 * budget pre-emptively, on a problem the reader does not have, is the same mistake in the other
 * direction. So the pass runs after ranking and truncation, over exactly what will be rendered.
 *
 * A row that cannot say what makes it different is left alone. That is honest: appending "2 of 2"
 * would tell the reader there are two without telling them which is which, and this product does
 * not print a number to fill a space.
 */
function disambiguate(rows: Draft[]): void {
  const seen = new Map<string, Draft[]>();
  for (const row of rows) {
    // Joined on a separator no payer name or patient name can contain, so two rows collide only
    // when they genuinely read the same. On a space, "A B" + "C" would collide with "A" + "B C".
    const key = [row.kind, row.title, row.subtitle].join("␟");
    const group = seen.get(key);
    if (group) group.push(row);
    else seen.set(key, [row]);
  }

  for (const group of seen.values()) {
    if (group.length < 2) continue;
    /**
     * The distinguishers themselves have to distinguish. Two checks made the same minute under the
     * same member ID would put the same clause on both rows and leave the reader exactly where they
     * started, having spent a line saying so.
     */
    const keys = group.map((r) => (r.telling ? JSON.stringify(r.telling) : null));
    if (keys.some((k) => k === null)) continue;
    if (new Set(keys).size !== group.length) continue;
    for (const row of group) row.distinguisher = row.telling ?? null;
  }

  for (const row of rows) delete row.telling;
}

/** Display-only. The client formats its own money; this exists for the sentences composed here. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
