/**
 * Verification freshness policy. Results rot: coverage lapses and deductibles/annual maximums reset
 * at the plan-year boundary. Ported verbatim from Dental Verify's `freshness.ts` — pure policy from
 * `createdAt`, nothing stored, so the policy can change without a migration.
 *
 *   expiresAt = min(createdAt + 30 days, Jan 1 of the following year, UTC)
 *   "aging" begins 7 days before expiry so the queue re-verifies early.
 *
 * Simplification (documented): assumes calendar-year plans; a payer-supplied plan-year would refine it.
 */

export const FRESH_DAYS = 30;
export const AGING_WINDOW_DAYS = 7;

export type FreshnessStatus = "fresh" | "aging" | "expired";

export interface Freshness {
  status: FreshnessStatus;
  expiresAt: string;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function verificationFreshness(createdAtIso: string, today: Date = new Date()): Freshness {
  const createdAt = new Date(createdAtIso);
  const ageExpiry = new Date(createdAt.getTime() + FRESH_DAYS * DAY_MS);
  const planYearExpiry = new Date(Date.UTC(createdAt.getUTCFullYear() + 1, 0, 1));
  const planYearBounded = planYearExpiry < ageExpiry;
  const expiresAt = planYearBounded ? planYearExpiry : ageExpiry;

  const reason = planYearBounded
    ? "Plan-year rollover: deductibles and annual maximums reset on January 1."
    : `Verifications older than ${FRESH_DAYS} days must be re-run.`;

  let status: FreshnessStatus;
  if (today >= expiresAt) status = "expired";
  else if (today.getTime() >= expiresAt.getTime() - AGING_WINDOW_DAYS * DAY_MS) status = "aging";
  else status = "fresh";

  return { status, expiresAt: expiresAt.toISOString(), reason };
}
