/**
 * CARC / RARC reference — the industry code sets a payer uses to explain why it paid what it paid.
 *
 * Ported from `dental-rcm-platform`'s `data/knowledge.js` (blueprint doc 02 port map: donor
 * `knowledge.js` → shared reference), with a deliberate split the donor did not make:
 *
 *   • **Here (static, shared):** what a code MEANS and which bucket it falls in. "CO-45 is a
 *     contractual write-off" is an industry fact, true for every payer, and both Remittance and
 *     Denials & Appeals need it. It belongs with the CDT catalog, not inside a bounded context.
 *
 *   • **NOT here (learned, per-payer):** dispositions and overturn rates — "how often does THIS
 *     payer reverse a CO-97 when we appeal it?" That is `payer_playbook_rules`, owned by the Payer
 *     Profile module and written by appeal outcomes (blueprint doc 02, doc 11). Freezing an overturn
 *     rate into a shared constant would fossilize the exact number the feedback loop exists to
 *     learn. The donor's `overturn` priors move there when that module lands.
 *
 * Why the categories matter more than the descriptions: they are what separates "the cost of doing
 * business" from "money someone owes us". A shortfall explained by CO-45 is normal; the same
 * shortfall explained by CO-16 is recoverable revenue sitting in a queue.
 */

/**
 * X12 claim adjustment group codes (CAS01).
 *   CO — Contractual Obligation: the provider eats it (fee-schedule reductions, bundling).
 *   PR — Patient Responsibility: bill the patient (deductible, coinsurance, copay).
 *   PI — Payer Initiated Reduction: the payer's own decision, not a contract term.
 *   OA — Other Adjustment; CR — Correction/Reversal.
 */
export type AdjustmentGroup = "CO" | "PR" | "PI" | "OA" | "CR";

/**
 * What a clinic should actually DO about an adjustment.
 *
 *   contractual  — expected write-off. Not a leak; do not chase it.
 *   patient      — bill the patient.
 *   recoverable  — the payer withheld money for a reason that can be fixed or appealed. THIS is
 *                  the category the recovery queue is built from.
 *   informational— carries no money decision on its own.
 */
export type AdjustmentCategory =
  | "contractual"
  | "patient"
  | "recoverable"
  /**
   * ── COORDINATION OF BENEFITS: MONEY THIS PAYER SAYS IS ANOTHER PAYER'S QUESTION (M8) ──────────
   *
   * The `OA` — Other Adjustment — group. It is what a payer uses for CARC 23, *"the impact of prior
   * payer(s) adjudication"*, which is the standard coordination-of-benefits code, and for anything
   * else that is genuinely neither a contract term nor the patient's charge.
   *
   * It used to fall through to `informational`, and that was the defect. `computeVariance` counted
   * `informational` toward `accountedFor` — so the arithmetic balanced and no `unexplained` was
   * raised — and then reported nothing about it: the four money fields on `Variance` are
   * contractual, patient, recoverable and unexplained. The amount reconciled perfectly and appeared
   * in NO category and NO queue.
   *
   * A separate category, rather than folding it into an existing one, because every existing one
   * would be a false statement:
   *   • `patient` bills a person for money a secondary payer may owe — the compliance exposure;
   *   • `contractual` writes off money nobody agreed to write off;
   *   • `recoverable` sends staff to chase THIS payer for a decision it did not make;
   *   • `informational` is what let it disappear.
   *
   * What it MEANS is "we do not yet know whose money this is", and the only safe handling of that is
   * to hold it in front of a person. `checkRemittanceSafety` blocks on it.
   */
  | "coordination"
  | "informational";

/**
 * What a reason code is ABOUT, independent of who ends up paying.
 *
 * Deliberately not `AdjustmentCategory`. A category is a decision about money and cannot be read off
 * the code alone — CARC 119 "benefit maximum reached" describes the same fact whether the payer
 * assigns it to the patient (PR-119) or absorbs it contractually (CO-119), and those two have
 * opposite next actions. The code tells you the subject; the GROUP tells you whose money it is.
 */
export type CarcNature = "patient_share" | "contractual" | "correctable" | "informational";

export interface CarcCode {
  code: string;
  description: string;
  /** The group this code normally arrives under (a payer may still send it under another). */
  typicalGroup: AdjustmentGroup;
  nature: CarcNature;
}

const CARC_LIST: readonly CarcCode[] = [
  { code: "1", description: "Deductible amount", typicalGroup: "PR", nature: "patient_share" },
  { code: "2", description: "Coinsurance amount", typicalGroup: "PR", nature: "patient_share" },
  { code: "3", description: "Copayment amount", typicalGroup: "PR", nature: "patient_share" },
  { code: "4", description: "Procedure code inconsistent with modifier or tooth", typicalGroup: "CO", nature: "correctable" },
  { code: "16", description: "Missing or invalid information", typicalGroup: "CO", nature: "correctable" },
  { code: "18", description: "Duplicate claim or service", typicalGroup: "CO", nature: "correctable" },
  /**
   * The coordination-of-benefits code. A secondary payer states what the PRIMARY already did with
   * this charge, under group `OA`, and that amount is neither ours to write off nor the patient's to
   * be billed until somebody establishes what the other payer actually paid.
   */
  { code: "23", description: "Impact of prior payer(s) adjudication (coordination of benefits)", typicalGroup: "OA", nature: "informational" },
  { code: "26", description: "Expenses incurred prior to coverage", typicalGroup: "CO", nature: "patient_share" },
  { code: "27", description: "Expenses incurred after coverage terminated", typicalGroup: "CO", nature: "patient_share" },
  { code: "29", description: "Timely filing limit expired", typicalGroup: "CO", nature: "correctable" },
  { code: "45", description: "Charge exceeds fee schedule (contractual)", typicalGroup: "CO", nature: "contractual" },
  { code: "50", description: "Not deemed medically necessary", typicalGroup: "CO", nature: "correctable" },
  { code: "96", description: "Non-covered charge (plan exclusion)", typicalGroup: "CO", nature: "correctable" },
  { code: "97", description: "Bundled — included in another service", typicalGroup: "CO", nature: "correctable" },
  { code: "109", description: "Claim not covered by this payer (wrong payer or COB)", typicalGroup: "CO", nature: "correctable" },
  { code: "119", description: "Benefit maximum reached", typicalGroup: "CO", nature: "patient_share" },
  { code: "131", description: "Claim-specific negotiated discount", typicalGroup: "CO", nature: "contractual" },
  { code: "151", description: "Frequency limitation — payment adjusted", typicalGroup: "CO", nature: "correctable" },
  { code: "197", description: "Pre-authorization absent", typicalGroup: "CO", nature: "correctable" },
  { code: "204", description: "Service not covered under the current benefit plan", typicalGroup: "CO", nature: "correctable" },
  { code: "227", description: "Information requested from the patient was not received", typicalGroup: "CO", nature: "correctable" },
  { code: "A1", description: "Claim or service denied — see remark codes", typicalGroup: "CO", nature: "correctable" },
];

const CARC_BY_CODE = new Map(CARC_LIST.map((c) => [c.code, c]));

export const CARC_CODES: readonly CarcCode[] = CARC_LIST;

/** Look up a CARC code. Unknown codes are common — payers use hundreds — so this returns undefined. */
export const findCarc = (code: string): CarcCode | undefined => CARC_BY_CODE.get(code.trim().toUpperCase());

/**
 * Categorize an adjustment from its group and reason code.
 *
 * ── THE GROUP DECIDES WHOSE MONEY IT IS. THE CODE ONLY SAYS WHY. ───────────────────────────────
 * This used to run the other way: `PR` was honoured, and every other group deferred to a `category`
 * stored against the CODE. The reasoning written here was that "CO-119 (benefit maximum reached)
 * and CO-27 (coverage terminated) arrive under a provider-side group but are genuinely the
 * patient's to pay". That is true of the SITUATIONS those codes describe and false of the
 * adjustments themselves, and the difference is not academic:
 *
 *   CAS01 is contractual language, not a hint. **CO — Contractual Obligation** is the payer stating
 *   that under the participating-provider agreement the PROVIDER absorbs this amount. Billing the
 *   patient for it is balance billing: a breach of the payer contract, prohibited outright in many
 *   states, and the clinic carries the liability, not us.
 *
 * When a payer means the patient to pay a benefit maximum, it sends **PR-119** — and it usually
 * does. A payer that sends **CO-119** is saying something different and unusual, and the honest
 * response is to put it in front of a person, not to overrule the group and send a bill.
 *
 * So: `patient` requires `PR`, always, with no exceptions available to any code. A `patient_share`
 * code arriving under CO/PI is an ANOMALY — money we did not receive and may not bill onward — and
 * lands in `recoverable`, which is the queue that means "a human should look at this".
 *
 * An UNRECOGNIZED code under CO/PI is treated as recoverable for the same reason. Payers use
 * hundreds of codes; the safe default is to make a human look at money we did not receive rather
 * than silently absorb it.
 */
export function categorizeAdjustment(group: string, code: string): AdjustmentCategory {
  const normalizedGroup = group.trim().toUpperCase();

  // The patient can only ever owe what the payer assigned to them.
  if (normalizedGroup === "PR") return "patient";

  /**
   * ── `OA` IS A COORDINATION QUESTION, NOT AN INFORMATIONAL FOOTNOTE (M8) ──────────────────────
   *
   * `OA` — Other Adjustment — is the group a payer uses when the amount is, by its own account,
   * neither a contract term (`CO`) nor the patient's (`PR`) nor its own reduction (`PI`). In
   * practice that is overwhelmingly coordination of benefits: CARC 23, "the impact of prior
   * payer(s) adjudication", arrives here on a secondary payer's advice.
   *
   * It used to fall into `informational` along with every other unrecognised group, where
   * `computeVariance` counted it toward `accountedFor` — balancing the arithmetic — and then
   * reported it in none of the money fields. The amount reconciled and vanished.
   *
   * Every OA is treated this way, not only CARC 23, and that is deliberate. The group is defined by
   * what it is NOT, so an `OA` we do not recognise is precisely a sum whose owner we cannot name —
   * and the rule for that is the same as everywhere else in this codebase: it goes in front of a
   * person rather than being quietly assigned to one.
   */
  if (normalizedGroup === "OA") return "coordination";

  // Neither a contract term nor a patient charge — carries no money decision of its own. `CR`
  // (correction/reversal) lands here; a reversal is separately blocked by the safety gate, which is
  // a stronger control than a category.
  if (normalizedGroup !== "CO" && normalizedGroup !== "PI") return "informational";

  const nature = findCarc(code)?.nature;
  // Only a contract-based reduction under a contract-based group is a write-off. A PI group is the
  // payer's own decision rather than a contract term, so even a fee-schedule code under PI is worth
  // questioning.
  if (nature === "contractual" && normalizedGroup === "CO") return "contractual";
  if (nature === "informational") return "informational";
  return "recoverable";
}

/** Human-readable description for a CARC, falling back to the raw code. */
export const describeCarc = (code: string): string => findCarc(code)?.description ?? `Reason code ${code}`;

/** RARC remark codes — supplementary detail a payer attaches to an adjustment (LQ*HE segments). */
export const RARC_CODES: Readonly<Record<string, string>> = {
  N4: "Missing, incomplete or invalid prior insurance carrier EOB",
  N29: "Missing documentation or radiographs",
  N37: "Missing, incomplete or invalid tooth number or letter",
  N39: "Procedure code is not compatible with the tooth surface code",
  N54: "Claim information is inconsistent with pre-certified or authorized services",
  N130: "Consult plan benefit documents for information about restrictions",
  N179: "Additional information has been requested from the member",
  M127: "Missing patient medical record for this service",
};

export const describeRarc = (code: string): string =>
  RARC_CODES[code.trim().toUpperCase()] ?? `Remark code ${code}`;
