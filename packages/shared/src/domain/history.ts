/**
 * One entry in a chronology — the shape every bounded context uses when it is asked "what happened,
 * and when?".
 *
 * ── WHY THIS IS SHARED RATHER THAN PER-MODULE ──────────────────────────────────────────────────
 * The claim timeline (M13) proved the shape: a phase, the business moment it happened, a title, a
 * detail, and the person responsible. M14's patient record needs the same thing from five contexts
 * at once and has to interleave them into a single ordered spine. If each module invented its own
 * entry type, the composition root would spend its time translating between five near-identical
 * shapes — and the translations would drift.
 *
 * It lives in `shared` for the same reason `CoverageSnapshot` does: it crosses a boundary. Every
 * module produces it, `apps/web` merges it, and no module imports another to do so.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────────
 * This is not the security audit trail. `audit_events` records who touched what, is append-only,
 * and is read under `audit.read` by an auditor or an administrator. This is the BUSINESS history a
 * clinician or a biller reads on a patient's record, assembled from facts the aggregates already
 * carry. The two answer different questions for different people, and conflating them would either
 * bury the business story under access records or leak the access records to everyone who can open
 * a patient screen.
 *
 * ── AND NOT A TABLE ────────────────────────────────────────────────────────────────────────────
 * Nothing here is persisted. Every entry is projected from an aggregate that already holds the fact,
 * exactly as `buildClaimTimeline` is. A stored copy would be a second place for the same truth to
 * live and therefore a chance for the record and its history to disagree — on the one screen a
 * practice quotes during a dispute.
 */

/**
 * Which part of the revenue cycle an entry belongs to. The UI groups and colours by this, and the
 * order below is the order the cycle runs in — useful as a tiebreak when two entries share an
 * instant, which happens whenever one transaction produces several facts.
 */
export type HistoryPhase =
  | "verification"
  | "estimate"
  | "submission"
  | "posting"
  | "denial"
  | "appeal"
  | "ledger"
  | "resolution";

/** The cycle's own order, for tie-breaking entries that share a timestamp. */
export const HISTORY_PHASE_ORDER: readonly HistoryPhase[] = [
  "verification",
  "estimate",
  "submission",
  "posting",
  "denial",
  "appeal",
  "ledger",
  "resolution",
];

/** What an entry points at, so a screen can offer "open the thing this is about". */
export interface HistoryRef {
  /** The kind of record — "verification", "claim", "denial", "appeal", "remittance", "ledger". */
  kind: string;
  id: string;
}

export interface HistoryEntry {
  phase: HistoryPhase;
  /**
   * ISO instant the thing happened — the BUSINESS moment, never the write time.
   *
   * A redelivered event is written later than a fact that followed it; ordering by write time would
   * therefore show a payment arriving before the claim it paid.
   */
  at: string;
  title: string;
  detail: string;
  /** "system" for anything the cycle did on its own, or the named person who did it. */
  actor: string;
  /**
   * Money this entry moved or put at stake, in integer cents. Null when the entry is not about
   * money — most of them are, and a screen that shows "—" for the rest is more honest than one that
   * shows $0.00.
   */
  amount?: number | null;
  ref?: HistoryRef | null;
}

/**
 * Order a chronology: oldest first, ties broken by where the phase sits in the cycle.
 *
 * Ordered by `at` rather than by phase, because the phases are not strictly sequential in practice —
 * a claim can be corrected and refiled after a denial, producing a submission genuinely later than a
 * posting. Sorting by what the phases *ought* to be would rewrite history to look tidier than it was.
 * The phase only breaks a tie, which is the one case where `at` cannot decide.
 */
export function orderHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      HISTORY_PHASE_ORDER.indexOf(a.phase) - HISTORY_PHASE_ORDER.indexOf(b.phase)
  );
}
