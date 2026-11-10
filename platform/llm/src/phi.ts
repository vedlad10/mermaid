/**
 * The PHI gate — the one check in this package that is a compliance control rather than an
 * engineering one.
 *
 * ── WHY THIS IS A CONFIG FLAG AND NOT A CODE PATH ──────────────────────────────────────────────
 * Whether a given LLM endpoint may lawfully receive PHI is not a fact about the code. It is a fact
 * about a signed BAA between this practice's organisation and that vendor, for that specific
 * endpoint, in that specific deployment. Two deployments running byte-identical code can have
 * different answers, and the code cannot know which it is in. So it is asked, explicitly, per
 * environment: `LLM_PHI_APPROVED=1`.
 *
 * The default is off. That means a deployment that wires up a real provider and forgets this flag
 * gets **no AI on anything patient-bearing** — every such call degrades to the deterministic path
 * and the practice's day is unaffected. The failure mode of forgetting is a missing convenience.
 * The failure mode of defaulting the other way is an unreported disclosure of protected health
 * information to a third party, which is a breach whether or not anyone notices. Those are not
 * comparable, so the default is not a judgement call.
 *
 * ── WHY `containsPhi` IS DECLARED AND NOT DETECTED ─────────────────────────────────────────────
 * A scanner over the prompt would be wrong in both directions. It would flag a CARC description
 * containing the word "patient" (costing a feature that was always safe) and it would miss a member
 * ID, a date of birth, or a treatment history written in a phrasing it did not anticipate (costing a
 * disclosure). The caller building the prompt is the only party that actually knows what went into
 * it, so the caller declares it — and unset means `true`, because in a revenue-cycle platform
 * "I didn't think about it" must resolve to the safe answer.
 */
import type { LlmError } from "./adapter.ts";

export interface PhiPolicy {
  /** True when the configured provider/endpoint is BAA-covered for PHI in THIS environment. */
  phiApproved: boolean;
}

/**
 * Decide whether a request may be sent. Returns null when it may.
 *
 * Note this refuses rather than redacting. Redaction is a whole discipline with its own failure
 * modes, and a half-redacted prompt that still contains a rare surname is a disclosure that also
 * produced a worse answer. Refusing is honest and the caller has a deterministic path anyway.
 */
export function checkPhiPolicy(containsPhi: boolean, policy: PhiPolicy): LlmError | null {
  if (!containsPhi) return null;
  if (policy.phiApproved) return null;
  return {
    code: "phi_not_permitted",
    message:
      "this request carries PHI and no LLM provider is approved to receive PHI in this environment " +
      "(set LLM_PHI_APPROVED=1 only once a BAA covering the configured endpoint is signed)",
    retryable: false,
  };
}

/**
 * Whether a request should be treated as PHI-bearing.
 *
 * One line, but it is the line that makes "unset" mean "yes". Kept as a named function so the
 * default cannot be quietly changed by an `?? false` somewhere in a call site.
 */
export const treatAsPhi = (containsPhi: boolean | undefined): boolean => containsPhi !== false;
