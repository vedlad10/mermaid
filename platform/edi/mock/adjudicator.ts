/**
 * The mock payer's own adjudication — how much it decides to pay, worked out from the PLAN.
 *
 * ── WHY THIS EXISTS (F-0) ──────────────────────────────────────────────────────────────────────
 * The mock used to compute its payment as
 *
 *     share = round(claim.expectedInsurancePays × line.charged / totalCharged)
 *
 * — that is, it paid back whatever Mermaid had predicted it would pay. Every variance was therefore
 * ≈ 0 by construction, and the whole point of the variance engine is to detect the case where a
 * payer and an estimate disagree. A staging audit could not tell a correct estimator from a broken
 * one, because the fixture would agree with either.
 *
 * That makes it worse than a weak fixture: it manufactures confidence. Green staging runs were
 * evidence of nothing, and the largest open defect in the product — estimates that over-quote every
 * in-network patient by the full contractual write-off — sat underneath a suite that reported
 * everything reconciling to the cent.
 *
 * So this adjudicates the way a payer does: from the member's own benefits and the contracted fee
 * schedule, with no knowledge of what anyone expected. If Mermaid's estimate is wrong, the variance
 * is now non-zero and something fails.
 *
 * ── WHAT KEEPS IT INDEPENDENT ──────────────────────────────────────────────────────────────────
 * Nothing here may import the estimator. `modules/verification` computes what the practice EXPECTS;
 * this computes what the payer DECIDES, and a shared implementation would collapse the two back
 * into one number. The import boundary is enforced in CI (`check-boundaries.mjs`) rather than left
 * to memory, because this is exactly the kind of coupling that gets reintroduced by someone
 * de-duplicating what looks like repeated arithmetic.
 *
 * It is deliberately a SECOND implementation of the same domain rules, and that redundancy is the
 * feature. Two independent readings of a plan that agree are evidence; one reading quoted back at
 * itself is not.
 */
import { findProcedure, type ProcedureCategory } from "@mermaid/shared";
import type { MockProfile } from "./profile.ts";

/** The payer's fee schedule sits below the clinic's billed fee; the difference is a CO-45 write-off. */
export const CONTRACTUAL_RATE = 0.1;

export interface AdjudicatedLine {
  procedureCode: string;
  /** What the clinic billed, in cents. */
  charged: number;
  /** The contracted maximum — `charged` less the write-off. */
  allowed: number;
  /** The CO-45 write-off. */
  contractual: number;
  /** Deductible consumed by this line. */
  deductible: number;
  /** What the payer pays. */
  paid: number;
  /** Allowed less paid less deductible — the patient's coinsurance share. */
  patientShare: number;
  /** Why the payer paid nothing, when it paid nothing for a benefit reason. */
  reason: "annual-maximum" | null;
}

/**
 * Adjudicate a claim's lines against the member's plan.
 *
 * Applies, per line, in the order a payer does:
 *   1. the contracted allowed amount (the fee schedule);
 *   2. the remaining deductible, consumed once across the claim;
 *   3. the coverage percentage for the procedure's category;
 *   4. the remaining annual maximum, which caps what the plan pays.
 *
 * An uncategorised procedure is paid at zero and its allowed amount falls to the patient — the same
 * conservative reading the estimator takes, arrived at independently. Rounding is to whole cents at
 * the line, which is where a payer rounds.
 */
export function adjudicateLines(
  lines: { procedureCode: string; charged: number; quantity?: number }[],
  profile: MockProfile
): AdjudicatedLine[] {
  let deductibleLeft = Math.round(profile.deductibleRemaining * 100);
  let maxLeft = Math.round(profile.annualMaximumRemaining * 100);

  return lines.map((line) => {
    const contractual = Math.round(line.charged * CONTRACTUAL_RATE);
    const allowed = line.charged - contractual;

    const category = findProcedure(line.procedureCode)?.category as ProcedureCategory | undefined;
    const percent = category ? (profile.coveragePercentages[category] ?? 0) : 0;

    /**
     * The deductible applies to the categories the plan says it does. `basic` and `major` is the
     * ordinary dental arrangement and what this profile models; preventive and diagnostic are
     * exempt, which is why a cleaning is not what eats a patient's deductible.
     */
    const deductibleApplies = category === "basic" || category === "major";
    const deductible = deductibleApplies ? Math.min(deductibleLeft, allowed) : 0;
    deductibleLeft -= deductible;

    const afterDeductible = allowed - deductible;
    const beforeCap = Math.round((afterDeductible * percent) / 100);
    const paid = Math.max(0, Math.min(beforeCap, maxLeft));
    maxLeft -= paid;

    return {
      procedureCode: line.procedureCode,
      charged: line.charged,
      allowed,
      contractual,
      deductible,
      paid,
      patientShare: allowed - paid,
      reason: paid < beforeCap ? "annual-maximum" : null,
    };
  });
}
