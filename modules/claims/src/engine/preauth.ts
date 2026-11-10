/**
 * Whether a claim's pre-authorisation requirement has been satisfied.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT TWO PLACES THAT AGREE ─────────────────────────────────────
 * The submit gate knew this rule and the dashboard did not. On staging, Pia Preauth's claim carried
 * an approval — `status: "approved"`, reference `AUTH-STAGING-1`, valid to 2027-03-01 — and the gate
 * correctly cleared it: `canSubmit: true`, no blockers. The Today board meanwhile reported $625.00
 * under "At risk · unauthorised, not yet filed", because the list item summed every line's
 * `preAuthRiskAmount` without ever asking whether an authorisation existed.
 *
 * So one screen said the claim was clear to file and another said its money was at risk for exactly
 * the reason the first had cleared. Both read the same claim.
 *
 * The rule now lives here and both callers use it, which is the only arrangement in which they
 * cannot drift apart again.
 *
 * ── THE RULE ITSELF ────────────────────────────────────────────────────────────────────────────
 * An approval satisfies the requirement. So does the payer WAIVING it — a real outcome, recorded as
 * its own status rather than dressed up as an approval, because a waiver grants nothing to quote if
 * the claim is later refused.
 *
 * Everything else does not: a request still pending is not permission, a REFUSED authorisation is
 * the opposite of one, and an expired approval is not an approval. Expiry is judged against the DATE
 * OF SERVICE — the day the work was done is the day the authorisation had to cover, and judging
 * against today would fail a claim filed late for treatment that was properly authorised at the time.
 */
import type { Claim } from "../types.ts";

export function preAuthSatisfied(claim: Claim): boolean {
  const auth = claim.preAuthorization;
  if (!auth) return false;
  if (auth.status === "waived") return true;
  if (auth.status !== "approved") return false;
  return !auth.validUntil || claim.serviceDate.slice(0, 10) <= auth.validUntil.slice(0, 10);
}

/**
 * What a missing or unchecked authorisation would cost on this claim, right now.
 *
 * Zero once the requirement is satisfied: the exposure was the risk of filing WITHOUT permission,
 * and permission is on file. `unknown` lines still carry it, because nobody has established whether
 * they need approval and the money is exposed either way.
 */
export function preAuthExposure(claim: Claim): number {
  if (preAuthSatisfied(claim)) return 0;
  return claim.lines.reduce((total, line) => total + (line.preAuthRiskAmount ?? 0), 0);
}
