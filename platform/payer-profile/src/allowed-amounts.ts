/**
 * What a payer actually allows for a procedure, learned from its own remittances (F-1).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────────
 * The estimate engine computes both shares from the practice's BILLED FEE. For an in-network
 * practice that is wrong twice, in opposite directions: the payer pays a percentage of its
 * contracted ALLOWED amount, so the insurance figure is overstated; and the gap between the billed
 * fee and the allowed amount is a contractual write-off nobody owes, so quoting it to the patient
 * bills them for money no one will ever collect.
 *
 * The over-quote is the expensive half and the invisible one. A patient who declines a crown
 * because they were told it costs $71.25 more than it does is revenue the practice never sees and
 * never learns it lost — there is no report of treatment not accepted.
 *
 * ── WHY LEARNED, AND WHY ONLY FROM CO ──────────────────────────────────────────────────────────
 * The payer states its allowed amount every time it pays. An 835 service line carries the charge
 * and its CAS adjustments, and group CO — "contractual obligation" — is by definition the portion a
 * contracted provider may not bill the patient. So `allowed = charge − CO`, which is the payer's
 * own arithmetic read back rather than an assumption about anyone's contract.
 *
 * Restricted to CO deliberately. An out-of-network payer reduces a charge under OA or PR, and that
 * money often IS the patient's; learning from those groups would teach the system that an
 * out-of-network patient owes less than they do — the same error pointed the other way.
 *
 * Nothing here decides anything. It records observations; the estimate falls back to the billed fee
 * for any code never observed, which is exactly today's behaviour.
 */
import type { Cents } from "@mermaid/shared";

/** One payer's stated allowance for one procedure code. */
export interface AllowedAmount {
  payerId: string;
  cdtCode: string;
  allowed: Cents;
  charged: Cents;
  observations: number;
  /**
   * How many times this payer has stated an allowance DIFFERENT from the one before it.
   *
   * Counts restatements, not distinct values — a payer alternating $1,000.00 / $1,050.00 / $1,000.00
   * records three, and there are two. That is the useful count: oscillation IS instability, and a
   * rate that keeps moving is what a practice needs to know about before quoting a patient from it.
   * It was named `distinctValues`, which described arithmetic it does not do.
   *
   * One means the rate has never moved. Above one, the figure above is the most recent rather than
   * the only one — surfaced rather than smoothed, because an average of a renegotiated rate and the
   * rate it replaced settles on a number that was never true.
   */
  restatements: number;
  /**
   * Consecutive adjudications of this code carrying NO contractual reduction, since the last one
   * that did (0028).
   *
   * A rate is learned only from a CO adjustment, which is right. What was missing is the other
   * direction: a practice that LEAVES a payer's network keeps being paid at full price, nothing is
   * learned from those lines, and nothing unlearns the rate either — so every estimate keeps
   * quoting a discount the payer no longer gives and the patient is told they owe less than they do.
   *
   * Zero means the contract is still being applied. Rising means it may have lapsed. Consecutive
   * rather than cumulative on purpose: one full-price line is ordinary, several in a row on a code
   * this payer used to discount is a contract that has ended.
   */
  fullPriceSince: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One service line as the payer adjudicated it, with its adjustments exactly as they arrived. */
export interface ObservedLine {
  cdtCode: string;
  /** SVC02 — what the practice billed for the WHOLE line, all units together. */
  charged: Cents;
  /**
   * SVC05 — how many units the line covered. Almost always 1 in dentistry, and load-bearing when it
   * is not: a rate is stored and quoted PER UNIT, so a two-unit line billed at $130.00 with $13.00
   * written off states a rate of $58.50, not $117.00. Reading the line total as the unit rate would
   * double the allowance on exactly the multi-unit procedures where the money is largest.
   */
  quantity: number;
  /**
   * Every CAS adjustment on the line, ALL groups, unfiltered.
   *
   * Taking them raw is deliberate. The rule "only CO is evidence of a contracted rate" is the single
   * most safety-critical thing this file knows, and it was originally applied by the caller — where
   * no test could reach it, and where a mutation that learned from every group passed the entire
   * suite. A rule that cannot be tested where it is written is a rule that will be quietly broken.
   */
  adjustments: { group: string; amount: Cents }[];
}

/**
 * The portion of a line the payer wrote off by contract.
 *
 * ONLY group CO. "Contractual obligation" is defined as the amount a contracted provider may not
 * bill the patient, which is exactly what makes `charge − CO` a contracted rate. The other groups
 * mean something different and dangerous to confuse with it:
 *
 *   PR — patient responsibility. This money IS the patient's. Subtracting it would produce an
 *        "allowed amount" below what the payer allows, and then quote the patient LESS than they
 *        owe, which is the failure that turns into an unexpected bill after treatment.
 *   OA — other adjustment, typically coordination of benefits. Another payer's share, not a discount.
 *   PI — payer initiated reduction. A decision about this claim, not a standing rate.
 */
export function contractualWriteOff(line: ObservedLine): Cents {
  return line.adjustments
    .filter((a) => a.group === "CO")
    .reduce((total, a) => total + a.amount, 0) as Cents;
}

/**
 * What one line tells us about the payer's allowance, or nothing.
 *
 * Returns null rather than a figure whenever the observation cannot mean what it would appear to
 * mean. Each refusal below is a case where recording the number would corrupt a rate that a patient
 * is later quoted from, so a missing observation is always the better failure.
 */
export function allowedFromLine(line: ObservedLine): Cents | null {
  const writeOff = contractualWriteOff(line);
  // A line the practice billed nothing for says nothing about a contracted rate.
  if (line.charged <= 0) return null;
  // A quantity that is missing, zero or fractional cannot divide a rate. Dividing by it would either
  // throw or invent one, and an absent observation is always the better failure.
  if (!Number.isInteger(line.quantity) || line.quantity < 1) return null;
  // No contractual reduction is not evidence of a rate equal to the fee: a payer that paid in full
  // may simply have no contract with this practice, and recording allowed = fee would then teach the
  // estimate that an out-of-network fee is a contracted one.
  if (writeOff <= 0) return null;
  // A write-off at or beyond the whole charge leaves an allowance of zero or less. That is not a
  // fee schedule, it is a denial or a reversal wearing a CO code.
  if (writeOff >= line.charged) return null;
  /**
   * PER UNIT, because that is what an estimate multiplies back out. Rounded to the cent: a rate that
   * does not divide evenly across units cannot be represented exactly in integer cents, and a
   * sub-cent difference on an estimate sits far inside the materiality band while being $142.50
   * closer to the truth than the billed fee it replaces.
   */
  return Math.round((line.charged - writeOff) / line.quantity) as Cents;
}

/**
 * Record that this payer adjudicated the code with NO contractual reduction.
 *
 * Not a rate observation — nothing is learned, and the stored allowance is deliberately untouched.
 * It counts evidence AGAINST the rate still being live, so that a lapsed contract stops silently
 * discounting quotes. Returns the prior unchanged when there is no prior: a full-price payment for
 * a code we never had a contract for says nothing worth storing.
 */
export function foldFullPrice(prior: AllowedAmount | null, observedAt: string): AllowedAmount | null {
  if (!prior) return null;
  return {
    ...prior,
    fullPriceSince: prior.fullPriceSince + 1,
    lastSeenAt: observedAt > prior.lastSeenAt ? observedAt : prior.lastSeenAt,
  };
}

/** The per-unit charge that goes on record beside the per-unit allowance, for the same reason. */
export function chargedPerUnit(line: ObservedLine): Cents {
  return Math.round(line.charged / Math.max(1, line.quantity)) as Cents;
}

/**
 * Fold a fresh observation into what was already known.
 *
 * The latest reading wins, because a contracted rate is a fact the payer restates on every advice
 * and the most recent statement is the current one. `distinctValues` is what stops that from hiding
 * a change: it counts how often the payer has said something different, so a rate that keeps moving
 * is visible as a rate that keeps moving.
 */
export function foldObservation(
  prior: AllowedAmount | null,
  next: { payerId: string; cdtCode: string; allowed: Cents; charged: Cents; observedAt: string }
): AllowedAmount {
  if (!prior) {
    return {
      payerId: next.payerId,
      cdtCode: next.cdtCode,
      allowed: next.allowed,
      charged: next.charged,
      observations: 1,
      restatements: 1,
      fullPriceSince: 0,
      firstSeenAt: next.observedAt,
      lastSeenAt: next.observedAt,
    };
  }
  const changed = prior.allowed !== next.allowed;
  return {
    ...prior,
    allowed: next.allowed,
    charged: next.charged,
    observations: prior.observations + 1,
    restatements: prior.restatements + (changed ? 1 : 0),
    // The payer applied the contract, so whatever full-price run was building is over.
    fullPriceSince: 0,
    // An out-of-order redelivery must not roll the timestamp backwards.
    lastSeenAt: next.observedAt > prior.lastSeenAt ? next.observedAt : prior.lastSeenAt,
    firstSeenAt: next.observedAt < prior.firstSeenAt ? next.observedAt : prior.firstSeenAt,
  };
}
