/**
 * Pre-authorization: the payer's answer to "may I do this?", asked BEFORE treatment.
 *
 * ── THE THREE THINGS THIS IS NOT ───────────────────────────────────────────────────────────────
 * It is not ELIGIBILITY. Eligibility says the policy is live and what it covers in general; a
 * patient can be perfectly eligible for a crown and still have the claim refused because nobody
 * asked first.
 *
 * It is not ADJUDICATION. The claim is still adjudicated on its own merits afterwards, against the
 * annual maximum, the deductible, frequency limits and everything else. An approval removes ONE
 * reason to refuse.
 *
 * And it is not a GUARANTEE OF PAYMENT. Every payer says so in the letter itself. Treating an
 * approval as a promise is how a practice books revenue that never arrives, so nothing in this
 * module may describe an approval as money secured — only as a refusal averted.
 *
 * ── WHY THE ANSWER IS THREE-VALUED ─────────────────────────────────────────────────────────────
 * `unknown` is the important one and the reason a boolean would not do. A 271 that says nothing
 * about pre-authorization has not said "no": most payers publish their rules in a portal rather
 * than on the wire, so silence is the ORDINARY case and it means nobody has established the answer.
 *
 * Collapsing that into "not required" invents permission the payer never gave — which is precisely
 * the failure this feature exists to prevent, and it fails silently: the estimate looks confident,
 * the claim files clean, and the money is lost months later under CARC 197. Collapsing it into
 * "required" is the opposite mistake, and it would put a blocking task on every routine filling
 * until staff learned to dismiss the whole feature.
 *
 * So `unknown` is carried as itself, all the way to the screen, where it reads as a question for a
 * person rather than an answer from a payer.
 */
import type { Cents } from "../money.ts";
import type { Benefits, ProcedureCategory } from "./estimate.ts";

export type PreAuthRequirement = "required" | "not-required" | "unknown";

/**
 * What a payer said about which services need approval first.
 *
 * Every field is the PAYER'S statement, never Mermaid's inference. A plan with no rule at all is
 * represented by the whole object being absent — which is `unknown`, not "nothing needs approval".
 */
export interface PreAuthorizationPolicy {
  /** Benefit categories the payer requires approval for. */
  categories: ProcedureCategory[];
  /** Specific CDT codes, whatever their category. */
  codes: string[];
  /**
   * Charges at or above this need approval regardless of category. Null when the payer stated no
   * threshold — which does NOT mean zero.
   */
  thresholdCents: Cents | null;
  /** How long an approval remains valid once granted. Null when the payer did not say. */
  validityDays: number | null;
  /** Where this rule came from, in the words a person can check. */
  source: string;
}

/** The requirement for one line, and the reason, in words a person can act on. */
export interface PreAuthVerdict {
  requirement: PreAuthRequirement;
  /** Why — quoting the payer's own rule where there is one. */
  reason: string;
}

/**
 * Does this procedure need the payer's approval before it is done?
 *
 * ── ORDER MATTERS, AND IT IS DELIBERATE ────────────────────────────────────────────────────────
 * A specific code beats a category, and a category beats a money threshold. A payer that lists
 * D2750 explicitly has said something more precise than "major services", and reporting the
 * general rule when a specific one exists would quote the payer inaccurately in the one place a
 * person goes to check what the payer actually said.
 */
export function preAuthRequirementFor(
  procedure: { code: string; category: ProcedureCategory | null },
  fee: Cents,
  benefits: Pick<Benefits, "preAuthorization">
): PreAuthVerdict {
  const policy = benefits.preAuthorization;

  /**
   * No rule on file. The payer has not answered, and Mermaid must not answer for it — see the
   * header. This is the ordinary case for a 271, and it is a task for a person, not a default.
   */
  if (!policy) {
    return {
      requirement: "unknown",
      reason:
        "This payer has not told us which services need approval before treatment. Check the plan " +
        "documents or the payer portal before scheduling — a 271 does not carry these rules.",
    };
  }

  if (policy.codes.includes(procedure.code)) {
    return {
      requirement: "required",
      reason: `${procedure.code} is named by this plan as needing approval before treatment (${policy.source}).`,
    };
  }

  if (procedure.category && policy.categories.includes(procedure.category)) {
    return {
      requirement: "required",
      reason: `This plan requires approval before any ${procedure.category} service (${policy.source}).`,
    };
  }

  if (policy.thresholdCents !== null && fee >= policy.thresholdCents) {
    return {
      requirement: "required",
      reason: `This plan requires approval for any charge at or above the amount it set (${policy.source}).`,
    };
  }

  /**
   * A category Mermaid could not determine, under a plan whose rule IS category-based, cannot be
   * answered. Saying "not required" here would be the silent-permission failure in miniature: the
   * rule might well cover this service and nobody has established which bucket it falls in.
   */
  if (!procedure.category && policy.categories.length > 0) {
    return {
      requirement: "unknown",
      reason:
        `This plan requires approval for ${policy.categories.join(", ")} services, and ${procedure.code} ` +
        `is not in Mermaid's catalog — so which bucket it falls in is not established. Confirm with the payer.`,
    };
  }

  return {
    requirement: "not-required",
    reason: `This plan's rule (${policy.source}) does not cover ${procedure.code}.`,
  };
}

/**
 * Money exposed by treating without an approval the payer requires.
 *
 * ── WHY THIS IS THE ALLOWED AMOUNT AND NOT THE BILLED FEE ──────────────────────────────────────
 * A pre-auth refusal arrives as `CO`-group CARC 197, and `CO` means the practice may not bill the
 * patient for it. So the money genuinely at risk is what the PAYER would otherwise have paid, not
 * what the practice charged: the contractual write-off was never collectable from anybody, and
 * including it would overstate the exposure by exactly the discount the practice already agreed to.
 *
 * Pia Phase32's crown is the worked example: $1,250.00 billed, $125.00 contractual, $1,125.00
 * allowed — and $1,125.00 is what CARC 197 took, to the cent.
 *
 * `unknown` carries risk too, and the same amount of it. The distinction between "we know approval
 * is needed and have none" and "nobody has checked" is a difference in what to DO, not in what is
 * exposed, and a screen that showed zero risk for the unchecked case would make not checking look
 * safe.
 */
export function revenueAtRisk(line: {
  requirement: PreAuthRequirement;
  fee: Cents;
  allowedAmount?: Cents;
  insurancePays: Cents;
}): Cents {
  if (line.requirement === "not-required") return 0 as Cents;
  /**
   * What the payer was going to pay on this line, which is what a refusal removes. Never the fee:
   * see above.
   */
  return Math.max(0, line.insurancePays) as Cents;
}
