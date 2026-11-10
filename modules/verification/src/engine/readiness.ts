/**
 * Coverage readiness for one visit — the answer behind §8.1's schedule strip and §8.2's timeline.
 *
 * Pure, and derived on every read from the patient's verifications, never stored: a readiness column
 * would be wrong the moment a verification ran, a review landed, or a result aged out.
 *
 * ── JUDGED AT THE VISIT, NOT TODAY ────────────────────────────────────────────────────────────────
 * A verification that is fresh this morning but expires on January 1 is no use for a January 3
 * visit. So freshness is evaluated at `visitAt`. Only `expired` counts against the visit: "aging"
 * is the queue's early-warning band, and a result still valid on the day is ready for that day.
 *
 * ── REVIEWED IS NOT COVERED ──────────────────────────────────────────────────────────────────────
 * A person reviewing a verification settles the workflow, not the coverage (see
 * `reviewed-is-not-resolved.test.ts`): a reviewed record can carry a payer's INACTIVE answer, or a
 * plan that ends before the visit. So a verified-or-reviewed run is only green when the payer said
 * the plan is active AND the visit's day falls inside the plan's stated window — the same ISO-day
 * comparison `detectExceptions` makes against a date of service.
 *
 * ── WITHIN A PLAN, THE LATEST VERIFICATION IS THE CURRENT WORD ───────────────────────────────────
 * A newer failed run supersedes an older good one OF THE SAME PLAN: the payer's latest answer is what
 * the practice knows now. Choosing the best-looking run of one plan would show green for coverage
 * that lapsed.
 *
 * ── ACROSS PLANS, EACH PLAN ANSWERS FOR ITSELF ───────────────────────────────────────────────────
 * A patient can hold two plans at once (their own and a spouse's). Taking the newest run across ALL
 * of them let a secondary plan's failed check hide a verified primary: the visit read "failed" while
 * the plan that pays first was active and checked. So runs are grouped by plan (`planKey`: payer +
 * member ID), each plan is judged on its own latest run, and the visit takes the best of those
 * answers. It cannot turn lapsed coverage green: a lapsed plan's latest run says so, and "best" only
 * chooses between plans that each stand on their own evidence. When the chosen plan is ready and
 * another is not, the reason says so rather than hiding it.
 */
import { verificationFreshness } from "./freshness.ts";
import { foldMemberId } from "./identity.ts";
import type { VerificationRecord } from "../types.ts";

export type ReadinessState =
  | "verified"
  | "stale"
  | "unconfirmed"
  | "needs-review"
  | "unverified"
  | "inactive"
  | "failed"
  | "no-coverage";

/** The four states §8.2 draws. Finer states collapse into them; the finer one is still reported. */
export type ReadinessGroup = "verified" | "pending" | "failed" | "no-coverage";

export interface Readiness {
  state: ReadinessState;
  group: ReadinessGroup;
  /** The verification this answer rests on, so a screen can open it. Null when there is none. */
  verificationId: string | null;
  verifiedAt: string | null;
  /** When that verification stops being usable. Null when there is none. */
  expiresAt: string | null;
  reason: string;
  /** How many distinct plans have been verified for this patient. Set by `coverageReadiness`. */
  plans?: number;
}

const GROUP: Record<ReadinessState, ReadinessGroup> = {
  verified: "verified",
  stale: "pending",
  unconfirmed: "pending",
  "needs-review": "pending",
  unverified: "pending",
  inactive: "failed",
  failed: "failed",
  "no-coverage": "no-coverage",
};

/** The most recent verification, or null. Ties break on id so the answer is stable. */
export function latestVerification(records: readonly VerificationRecord[]): VerificationRecord | null {
  let latest: VerificationRecord | null = null;
  for (const r of records) {
    if (
      !latest ||
      r.createdAt > latest.createdAt ||
      (r.createdAt === latest.createdAt && r.id > latest.id)
    ) {
      latest = r;
    }
  }
  return latest;
}

export function appointmentReadiness(
  visitAt: Date,
  /** The visit's calendar day (`YYYY-MM-DD`) in the PRACTICE's time zone — what a plan window means. */
  visitDay: string,
  latest: VerificationRecord | null,
  /** Whether the practice holds any member ID for this patient. */
  hasCoverageOnFile: boolean
): Readiness {
  const answer = (state: ReadinessState, reason: string): Readiness => {
    const expiresAt = latest ? verificationFreshness(latest.createdAt, visitAt).expiresAt : null;
    return {
      state,
      group: GROUP[state],
      verificationId: latest?.id ?? null,
      verifiedAt: latest?.createdAt ?? null,
      expiresAt,
      reason,
    };
  };

  if (!latest) {
    return hasCoverageOnFile
      ? answer("unverified", "Coverage is on file but has not been verified.")
      : answer("no-coverage", "No insurance is on file for this patient.");
  }
  if (latest.status === "needs_review") {
    return answer("needs-review", "The latest verification is waiting for a person to review it.");
  }
  // A person's rejection lands as `failed` too (service.review), and an approval or override of a
  // failed run lands as `reviewed` — so status alone is the answer, and a human decision wins.
  if (latest.status === "failed") {
    return answer("failed", "The latest verification did not produce usable benefits.");
  }
  // Benefits are null only when a person approved or overrode a run the payer gave nothing for —
  // a human decision about coverage, which stands.
  const benefits = latest.benefits;
  if (benefits?.eligibility === "inactive") {
    return answer("inactive", "The payer reports this coverage is not active.");
  }
  const window = benefits?.coverage;
  if (window?.terminationDate && visitDay > window.terminationDate) {
    return answer("inactive", `Coverage ends ${window.terminationDate}, before the ${visitDay} visit.`);
  }
  if (window?.effectiveDate && visitDay < window.effectiveDate) {
    return answer("inactive", `Coverage starts ${window.effectiveDate}, after the ${visitDay} visit.`);
  }
  if (benefits?.eligibility === "unknown") {
    return answer("unconfirmed", "The payer did not confirm whether this coverage is active.");
  }
  const freshness = verificationFreshness(latest.createdAt, visitAt);
  if (freshness.status === "expired") {
    return answer("stale", `Verified, but out of date by the visit. ${freshness.reason}`);
  }
  return answer("verified", "Verified, and still valid on the day of the visit.");
}

/**
 * Which plan a verification was run against: the payer it resolved to and the member ID on the
 * card, folded for comparison the same way every other member-ID match in this module is. Two runs
 * with the same key are two answers about ONE plan; different keys are different plans.
 */
export function planKey(record: VerificationRecord): string {
  const memberId = (record.card?.memberId?.value ?? record.patient?.memberId ?? "").trim();
  return `${record.payerId ?? ""}|${foldMemberId(memberId)}`;
}

/** Best first. A plan in a better state is the one a visit can rely on. */
const RANK: Record<ReadinessState, number> = {
  verified: 0,
  stale: 1,
  unconfirmed: 2,
  "needs-review": 3,
  unverified: 4,
  inactive: 5,
  failed: 6,
  "no-coverage": 7,
};

/**
 * Readiness for a visit from ALL of a patient's verifications, one plan at a time — see the file
 * header. Each plan is judged on its own latest run; the visit takes the best plan's answer, ties
 * broken by the newer run. `plans` says how many plans were weighed.
 */
export function coverageReadiness(
  visitAt: Date,
  visitDay: string,
  records: readonly VerificationRecord[],
  hasCoverageOnFile: boolean
): Readiness {
  if (records.length === 0) return appointmentReadiness(visitAt, visitDay, null, hasCoverageOnFile);

  const byPlan = new Map<string, VerificationRecord[]>();
  for (const r of records) byPlan.set(planKey(r), [...(byPlan.get(planKey(r)) ?? []), r]);

  const answers = [...byPlan.values()].map((runs) => {
    const latest = latestVerification(runs)!;
    return { latest, readiness: appointmentReadiness(visitAt, visitDay, latest, true) };
  });
  answers.sort(
    (a, b) =>
      RANK[a.readiness.state] - RANK[b.readiness.state] ||
      (a.latest.createdAt < b.latest.createdAt ? 1 : a.latest.createdAt > b.latest.createdAt ? -1 : 0) ||
      (a.latest.id < b.latest.id ? 1 : -1)
  );

  const best = answers[0]!.readiness;
  const notReady = answers.slice(1).filter((a) => a.readiness.group !== "verified").length;
  const reason =
    answers.length > 1 && best.group === "verified" && notReady > 0
      ? `${best.reason} ${notReady === 1 ? "Another plan on file is" : `${notReady} other plans on file are`} not ready.`
      : best.reason;
  return { ...best, reason, plans: answers.length };
}
