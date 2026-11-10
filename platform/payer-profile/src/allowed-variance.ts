/**
 * The allowed-amount variance engine (F2) — did the payer honour the rate it itself stated?
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────────
 * `foldObservation` beside this file learns a payer's contracted rate from its own advice, and it
 * does one thing that quietly destroys the evidence of the most expensive failure in the building:
 *
 *     allowed: next.allowed    // the prior value is discarded
 *
 * It keeps a `restatements` COUNT and throws the prior VALUE away. So when a payer silently cuts
 * D2750 from $1,125.00 to $980.00, the first advice at the lower figure overwrites the higher one,
 * and from the second advice onward the payer is paying exactly what the system believes it owes.
 * The variance converges to zero the instant there is something to see. A fee cut erases its own
 * evidence, and the practice never learns that the rate moved — only that nothing is wrong.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────────────────────────
 * Rates are kept as EFFECTIVE-DATED EPOCHS. An epoch is a period over which the payer said the same
 * number. A new figure never overwrites the old one; it opens a CANDIDATE epoch beside the
 * CONFIRMED one, and the confirmed epoch remains the baseline every later observation is measured
 * against until the candidate has been corroborated enough times to supersede it. The superseded
 * epoch is closed, never deleted — "you allowed $1,125.00 from March to September" stays provable
 * after the rate moves, which is the whole point, because that sentence is the appeal.
 *
 * ── WHY THE FIRST SIGHTING IS CONFIRMED AND THE SECOND IS NOT ──────────────────────────────────
 * A rate we have never seen has nothing to contradict, so the first observation is the baseline —
 * which is also exactly today's behaviour, so nothing regresses. Every DISAGREEMENT after that is
 * treated as a claim about the contract that has to earn its place, because the two things a single
 * differing advice can mean are very far apart: a renegotiated fee schedule (real, and the baseline
 * should move) or a one-off underpayment (real, and the baseline must NOT move, or the underpayment
 * becomes the new normal and the money is unrecoverable). Corroboration is what separates them, and
 * corroboration takes more than one advice.
 *
 * ── SHADOW MODE ─────────────────────────────────────────────────────────────────────────────────
 * Nothing here decides anything. It returns findings; the caller records them. No estimate reads an
 * epoch, no appeal is filed, no money moves. The existing `payer_allowed_amounts` fold is left
 * running exactly as it is and this observes alongside it — which is why turning F2 on cannot
 * change a single quote.
 *
 * Pure and deterministic: no I/O, no clock, no AI. Every input is passed in, including the rates of
 * the payer's other codes, because a number that will one day tell a practice to challenge a payer
 * must be reproducible from its inputs alone.
 */
import { isMaterialVariance, subCents, type Cents } from "@mermaid/shared";

/** How many corroborating advices a differing rate needs before it supersedes the baseline. */
export const DEFAULT_CONFIRM_AFTER = 3;

export type EpochStatus = "confirmed" | "candidate" | "superseded";

/** One period over which a payer stated one allowance for one code. */
export interface RateEpoch {
  /** Monotonic within (payer, code). Epoch 1 is the first rate ever seen. */
  seq: number;
  status: EpochStatus;
  allowed: Cents;
  /** What the practice billed when this epoch opened — the other half of an auditable pair. */
  charged: Cents;
  /** Advices that stated THIS figure. A candidate supersedes when it reaches `confirmAfter`. */
  observations: number;
  openedAt: string;
  /** The most recent advice that stated this epoch's figure. Never moves backwards. */
  lastSeenAt: string;
  /** Set when superseded. Null while the epoch is still the current claim about the contract. */
  closedAt: string | null;
  /**
   * The payer NAME printed on the advice that opened this epoch — not the contracted payer's slug.
   *
   * These are two different facts and the gap between them is the leased-network finding. The slug
   * comes from the claim's own expectation, so it is who the practice contracted with; the name is
   * whoever actually adjudicated. When a claim contracted with one payer comes back repriced under
   * another entity's name at a different rate, a rental network sat in between and applied ITS fee
   * schedule instead of the one the practice signed.
   */
  observedPayerName: string | null;
}

export type VarianceClassification =
  /** Paid below the payer's own confirmed rate, with no other explanation. */
  | "line-underpayment"
  /** Repriced by an entity other than the one the practice contracted with. */
  | "leased-network"
  /** The confirmed rate itself moved and stayed moved — the fee schedule was renegotiated. */
  | "schedule-drift"
  /** Paid at the confirmed rate of a LESSER procedure — an alternate-benefit downgrade. */
  | "abp-downgrade";

export interface VarianceFinding {
  classification: VarianceClassification;
  payerId: string;
  cdtCode: string;
  /** What this advice allowed. */
  observed: Cents;
  /** What the confirmed epoch said it would allow. */
  expected: Cents;
  /** `observed − expected`. Negative is money short; positive is the payer paying more than known. */
  delta: Cents;
  /** The epoch the comparison was made against, so a finding can be re-derived from the history. */
  againstEpoch: number;
  observedPayerName: string | null;
  /**
   * Whether this is money to pursue.
   *
   * Separate from the classification on purpose. A rate that moved UP is drift and worth knowing
   * and is not a shortfall; a leased-network reprice is both a classification and a shortfall. A
   * consumer that inferred "recoverable" from the class name would eventually chase a raise.
   */
  recoverable: boolean;
  /** The lesser code whose rate the payment matched. Only ever set for `abp-downgrade`. */
  downgradedTo?: string;
}

export interface FoldInput {
  payerId: string;
  cdtCode: string;
  allowed: Cents;
  charged: Cents;
  observedAt: string;
  /** The payer name the advice printed, when it printed one. */
  observedPayerName: string | null;
}

export interface FoldOptions {
  confirmAfter?: number;
  /**
   * This payer's other CONFIRMED rates, by code — the input the alternate-benefit test needs.
   *
   * Passed in rather than looked up, because a pure engine that reaches for a repository is no
   * longer reproducible from its inputs, and this is the figure that would justify an appeal.
   */
  peerRates?: ReadonlyMap<string, Cents>;
  /**
   * Codes a payer may substitute a lesser benefit for, as `code → the lesser codes`.
   *
   * Reference data, not a guess. These are the standard dental alternate-benefit substitutions: a
   * crown paid at the lesser crown's rate, a posterior composite paid at the amalgam rate, scaling
   * and root planing paid at the prophylaxis rate. Defaults to {@link DEFAULT_DOWNGRADE_PAIRS};
   * pass an empty map to disable the test entirely, and it will fall through to an underpayment,
   * which is the honest reading when we cannot name what the payment was substituted for.
   */
  downgradePairs?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Documented alternate-benefit substitutions in dentistry.
 *
 * An ABP clause lets a plan pay for the least expensive professionally acceptable treatment and
 * leave the difference to the patient. That is legitimate and contractual — the leak is not the
 * downgrade, it is that a downgrade paid without being IDENTIFIED as one looks exactly like an
 * underpayment, so the practice either chases the payer for money it is owed nothing of, or, far
 * more often, writes off a balance it was entitled to bill the patient.
 *
 * Deliberately short and deliberately conservative. Every pair here is a substitution payers state
 * in their own processing policies; nothing is inferred from clinical similarity. A pair that is
 * not listed produces an underpayment finding rather than a downgrade finding, which errs toward
 * "we do not know why this is short" instead of toward an explanation nobody can source.
 */
export const DEFAULT_DOWNGRADE_PAIRS: ReadonlyMap<string, readonly string[]> = new Map([
  // Porcelain/ceramic crowns paid at the base-metal crown rate.
  ["D2740", ["D2751", "D2752", "D2790", "D2791", "D2792"]],
  ["D2750", ["D2751", "D2752", "D2790", "D2791", "D2792"]],
  // Posterior composites paid at the amalgam rate, by surface count.
  ["D2391", ["D2140"]],
  ["D2392", ["D2150"]],
  ["D2393", ["D2160"]],
  ["D2394", ["D2161"]],
  // Periodontal therapy paid at the prophylaxis or debridement rate.
  ["D4341", ["D4346", "D1110"]],
  ["D4342", ["D4346", "D1110"]],
  ["D4910", ["D1110"]],
]);

const key = (name: string | null): string | null => (name === null ? null : name.trim().toUpperCase());
const sameEntity = (a: string | null, b: string | null): boolean => key(a) === key(b);

/** The epoch every comparison is made against: the confirmed one. */
export const confirmedEpoch = (epochs: readonly RateEpoch[]): RateEpoch | null =>
  epochs.find((e) => e.status === "confirmed") ?? null;

const openCandidate = (epochs: readonly RateEpoch[]): RateEpoch | null =>
  epochs.find((e) => e.status === "candidate") ?? null;

const nextSeq = (epochs: readonly RateEpoch[]): number =>
  epochs.reduce((max, e) => Math.max(max, e.seq), 0) + 1;

const later = (a: string, b: string): string => (a > b ? a : b);

/**
 * Which lesser code, if any, this payment was paid at the rate of.
 *
 * Exact equality on purpose. "Approximately the amalgam rate" is an underpayment that happens to
 * land near another number; an alternate-benefit payment IS the other code's allowance, to the
 * cent, because the payer computed it from that code's own fee schedule.
 */
function downgradedTo(
  cdtCode: string,
  observed: Cents,
  peerRates: ReadonlyMap<string, Cents>,
  pairs: ReadonlyMap<string, readonly string[]>
): string | null {
  for (const lesser of pairs.get(cdtCode) ?? []) {
    if (peerRates.get(lesser) === observed) return lesser;
  }
  return null;
}

export interface FoldResult {
  /** The full history after this observation. Never shorter than what went in. */
  epochs: RateEpoch[];
  /** What a person should be told, if anything. Null when the payer paid what it said it would. */
  finding: VarianceFinding | null;
}

/**
 * Fold one observed allowance into a code's rate history.
 *
 * The one invariant worth stating separately, because it is the requirement this feature exists
 * for: this function NEVER shortens `epochs` and never rewrites an epoch's `allowed`. A rate that
 * was once observed stays observable. Everything else here is a judgement that can be revisited;
 * that one cannot, because once the evidence is gone the money is gone with it.
 */
export function foldRateObservation(
  epochs: readonly RateEpoch[],
  next: FoldInput,
  options: FoldOptions = {}
): FoldResult {
  const confirmAfter = options.confirmAfter ?? DEFAULT_CONFIRM_AFTER;
  const peerRates = options.peerRates ?? new Map<string, Cents>();
  const pairs = options.downgradePairs ?? DEFAULT_DOWNGRADE_PAIRS;

  const history = epochs.map((e) => ({ ...e }));
  const confirmed = confirmedEpoch(history);

  // ── Nothing to contradict ────────────────────────────────────────────────────────────────────
  if (!confirmed) {
    history.push({
      seq: nextSeq(history),
      status: "confirmed",
      allowed: next.allowed,
      charged: next.charged,
      observations: 1,
      openedAt: next.observedAt,
      lastSeenAt: next.observedAt,
      closedAt: null,
      observedPayerName: next.observedPayerName,
    });
    return { epochs: history, finding: null };
  }

  // ── The payer paid what it said it would ─────────────────────────────────────────────────────
  if (next.allowed === confirmed.allowed) {
    confirmed.observations += 1;
    confirmed.lastSeenAt = later(confirmed.lastSeenAt, next.observedAt);
    /**
     * A repeat of the confirmed figure is evidence AGAINST an open candidate, so the candidate is
     * abandoned rather than left waiting for a third sighting it may never get. Abandoned by
     * closing it, not by deleting it: a one-off short payment that the payer then went back to
     * paying correctly is exactly the row a biller wants to find later.
     */
    const candidate = openCandidate(history);
    if (candidate) {
      candidate.status = "superseded";
      candidate.closedAt = next.observedAt;
    }
    return { epochs: history, finding: null };
  }

  const delta = subCents(next.allowed, confirmed.allowed);

  /**
   * ── PENNIES ARE NOT A FINDING ────────────────────────────────────────────────────────────────
   * A cent or two apart is rounding inside the payer's own adjudicator, and a queue that reports it
   * is a queue nobody reads. Immaterial differences are absorbed into the confirmed epoch as an
   * ordinary sighting rather than opening a candidate, because otherwise a payer that rounds
   * differently on alternate Tuesdays would hold a permanently open candidate that never confirms.
   */
  if (!isMaterialVariance(delta, confirmed.allowed)) {
    confirmed.observations += 1;
    confirmed.lastSeenAt = later(confirmed.lastSeenAt, next.observedAt);
    return { epochs: history, finding: null };
  }

  // ── A figure that disagrees, materially ──────────────────────────────────────────────────────
  const candidate = openCandidate(history);
  const corroborating = candidate !== null && candidate.allowed === next.allowed;

  if (corroborating) {
    candidate.observations += 1;
    candidate.lastSeenAt = later(candidate.lastSeenAt, next.observedAt);
    candidate.observedPayerName = candidate.observedPayerName ?? next.observedPayerName;

    if (candidate.observations < confirmAfter) {
      return { epochs: history, finding: classify(confirmed, next, delta, peerRates, pairs) };
    }

    /**
     * Corroborated. The baseline moves — and the old one is CLOSED, not replaced: `allowed` is
     * untouched, `closedAt` is stamped, and the row stays queryable forever. This is the line the
     * whole feature turns on, and the regression test beside it asserts the old figure survives.
     */
    confirmed.status = "superseded";
    confirmed.closedAt = next.observedAt;
    confirmed.lastSeenAt = later(confirmed.lastSeenAt, next.observedAt);
    candidate.status = "confirmed";
    candidate.lastSeenAt = next.observedAt;

    return {
      epochs: history,
      finding: {
        classification: "schedule-drift",
        payerId: next.payerId,
        cdtCode: next.cdtCode,
        observed: next.allowed,
        expected: confirmed.allowed,
        delta,
        againstEpoch: confirmed.seq,
        observedPayerName: next.observedPayerName,
        /**
         * Drift downward is a real reduction in what this practice will be paid, and the practice
         * may never have been notified of it — which is the finding. It is not a per-claim recovery
         * though: the payer is now consistently paying its new rate, and the remedy is a contract
         * conversation, not an appeal on one claim.
         */
        recoverable: false,
      },
    };
  }

  /**
   * A new disagreement — either the first one, or one that disagrees with the standing candidate
   * too. Either way it opens its own candidate; a candidate that has been contradicted has failed
   * to corroborate and is closed.
   */
  if (candidate) {
    candidate.status = "superseded";
    candidate.closedAt = next.observedAt;
  }
  history.push({
    seq: nextSeq(history),
    status: "candidate",
    allowed: next.allowed,
    charged: next.charged,
    observations: 1,
    openedAt: next.observedAt,
    lastSeenAt: next.observedAt,
    closedAt: null,
    observedPayerName: next.observedPayerName,
  });

  return { epochs: history, finding: classify(confirmed, next, delta, peerRates, pairs) };
}

/**
 * Name what happened, in the order a biller would rule it out.
 *
 * Order matters and it is the order of what is PROVABLE. A payment short of the confirmed rate
 * always supports "underpayment", so that reading has to come last — anything more specific is a
 * better answer for the same money, and reaching it first would mean a leased-network reprice and
 * an alternate-benefit downgrade both arrived on the worklist as generic shortfalls, where the
 * remedy for each is a completely different letter to a different party.
 */
function classify(
  confirmed: RateEpoch,
  next: FoldInput,
  delta: Cents,
  peerRates: ReadonlyMap<string, Cents>,
  pairs: ReadonlyMap<string, readonly string[]>
): VarianceFinding {
  const base = {
    payerId: next.payerId,
    cdtCode: next.cdtCode,
    observed: next.allowed,
    expected: confirmed.allowed,
    delta,
    againstEpoch: confirmed.seq,
    observedPayerName: next.observedPayerName,
  };

  /**
   * Paid MORE than the confirmed rate. Not a leak, and it must not be filed as one — but it is not
   * nothing either: it is the first sighting of a rate that may be about to move, and reporting it
   * as drift is what lets a practice notice a raise it was never told about.
   */
  if (delta > 0) return { ...base, classification: "schedule-drift", recoverable: false };

  /**
   * ── LEASED NETWORK ───────────────────────────────────────────────────────────────────────────
   * The practice contracted with one payer; a different entity adjudicated and applied its own fee
   * schedule. Both names must be present — an advice that printed no payer name is silence, and
   * silence is not evidence of a third party. The claim is qualified by the rate ALSO being short,
   * which is already true by the time we are here.
   */
  if (
    confirmed.observedPayerName !== null &&
    next.observedPayerName !== null &&
    !sameEntity(confirmed.observedPayerName, next.observedPayerName)
  ) {
    return { ...base, classification: "leased-network", recoverable: true };
  }

  const lesser = downgradedTo(next.cdtCode, next.allowed, peerRates, pairs);
  if (lesser !== null) {
    /**
     * Not recoverable FROM THE PAYER, and that is the finding's value. An alternate-benefit payment
     * is contractual, so appealing it loses — but the difference is billable to the PATIENT under
     * the same clause, and a practice that mistakes it for an underpayment writes off a balance it
     * was entitled to collect. Naming it is what converts a write-off into a statement.
     */
    return { ...base, classification: "abp-downgrade", recoverable: false, downgradedTo: lesser };
  }

  return { ...base, classification: "line-underpayment", recoverable: true };
}
