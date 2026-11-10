/**
 * The variance engine — estimate versus actual.
 *
 * This is what the entire architecture was built to make possible. Because the claim carried the
 * verification's immutable coverage snapshot forward (blueprint doc 00's keystone), "what we were
 * promised" is a recorded fact rather than a reconstruction. Comparing it to what the payer actually
 * paid is therefore arithmetic, not guesswork — and every dollar of the difference can be attributed
 * to a named reason.
 *
 * The attribution is the product. A clinic does not need to be told "you were paid $100 less than
 * expected"; it needs to be told *which* $100 is normal, *which* is the patient's, and *which* is
 * money someone still owes. Those three have completely different next actions, and conflating them
 * is how practices quietly lose revenue:
 *
 *   contractual  → the payer's fee schedule sits below our fee. Expected. Never chase it.
 *   patient      → deductible, coinsurance, exhausted benefits. Bill the patient.
 *   recoverable  → missing information, bundling, absent pre-auth. Correct it or appeal it.
 *   coordination → another payer's adjudication (`OA`, CARC 23). Belongs to NOBODY yet: not a
 *                  write-off, not the patient's, not this payer's to chase. HOLD it (M8).
 *   unexplained  → money withheld with NO reason code. Nothing surfaces this except arithmetic,
 *                  which is exactly why it is dangerous.
 *
 * `coordination` is the newest and the one that was silently wrong for longest. It used to be
 * swept into `informational`, which counted toward the reconciliation and then reported nothing —
 * so a secondary payer's share balanced perfectly and appeared in no category and no queue, while
 * the primary's `PR` balance was billed straight to the patient.
 *
 * Pure and deterministic — no I/O, no clock, no AI. A number that decides whether a clinic chases a
 * payer must be reproducible and inspectable.
 */
import { addCents, buildPartition, formatUsd, isMaterialVariance, materialityThreshold, type Cents } from "@mermaid/shared";
import type { Adjudication, Variance, VarianceOutcome, VarianceReason } from "../types.ts";

/** What the payer's advice says happened to one claim. */
export interface PaidClaim {
  chargedAmount: Cents;
  paidAmount: Cents;
  patientResponsibility: Cents;
  adjustments: VarianceReason[];
}

const sum = (values: Cents[]): Cents => addCents(...values);
const byCategory = (adjustments: VarianceReason[], category: VarianceReason["category"]): Cents =>
  sum(adjustments.filter((a) => a.category === category).map((a) => a.amount));

/**
 * Compare what a payer paid against what the claim's inherited snapshot promised.
 *
 * `expectedInsurancePays` comes from the coverage snapshot, via `claim.submitted`.
 *
 * ── NULL MEANS UNKNOWN, AND IT IS A SEPARATE ANSWER FROM ZERO ──────────────────────────────────
 * This used to take `Cents` and carry a comment saying the caller MUST NOT call it when the
 * expectation is unknown. The single caller honoured that. Nothing enforced it, and the type could
 * not express it: `0` had to stand for both "this claim was expected to pay nothing" — a real
 * expectation a payer can be measured against — and "we have no idea", which nothing can.
 *
 * A caller that passed a defaulted zero would get a variance equal to the entire payment, reported
 * as an overpayment, and every such claim would land on the recovery worklist as a suspected
 * takeback. That is the shape of L-1, which reached production once already.
 *
 * So the precondition is now in the signature. Unknown is `null` and yields `null`; a genuine
 * expectation of zero is `0` and is compared honestly. A comment asking callers to be careful is
 * not a guarantee — it is a hope with good grammar.
 */
export function computeVariance(paid: PaidClaim, expectedInsurancePays: Cents | null): Variance | null {
  if (expectedInsurancePays === null) return null;

  /**
   * ── A RETRACTION IS NOT AN ADJUDICATION (M8) ────────────────────────────────────────────────────
   * Negative money means the payer is taking something back rather than deciding something: a CLP-22
   * reversal carries a negative CLP04 and negative CAS amounts, and an unlabelled negative CAS is the
   * same event without the label. Neither is a statement about what this claim is worth, and every
   * figure below assumes one.
   *
   * Run through the ordinary arithmetic, a $400 takeback on a $1,000 claim produces:
   *
   *     allowed      $1,600   — charged MINUS a negative write-off, larger than the bill itself
   *     unexplained  $2,000   — twice the charge, in money the payer is said to have mislaid
   *     outcome      underpaid by $800
   *
   * None of which happened. The gate holds every reversal as a blocker so this does not post on its
   * own — but blockers are overridable by a person with a reason, which is correct, because a
   * retraction is real and somebody has to record it. Overriding it used to buy a $2,000 phantom in
   * the recovery queue: a biller chasing a payer for money that was never withheld, on a claim whose
   * whole charge was half that.
   *
   * So this refuses to answer, exactly as it refuses when there is no expectation, and for the same
   * reason stated there: a variance against a baseline that does not exist is a fabricated number,
   * and fabricated shortfalls poison the recovery queue. `null` propagates cleanly — `Posting.variance`
   * is already nullable, and `buildRecoveryQueue` skips a posting with no actionable variance.
   *
   * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
   * It does not reverse anything. Undoing a takeback means identifying WHICH prior posting is being
   * retracted, and an 835 reversal carries no reliable pointer to the advice it retracts — payers
   * identify it by their own claim control number, out of band, or not at all. That correspondence
   * is the external dependency, and guessing at it would move real money on a guess. The safe
   * internal behaviour is to record the retraction faithfully, compute nothing from it, and leave
   * the correspondence to the person the hold exists to summon.
   */
  const retracting =
    paid.paidAmount < 0 || paid.adjustments.some((a) => a.amount < 0);
  if (retracting) return null;
  const contractual = byCategory(paid.adjustments, "contractual");
  const patient = byCategory(paid.adjustments, "patient");
  const recoverable = byCategory(paid.adjustments, "recoverable");
  const informational = byCategory(paid.adjustments, "informational");
  /**
   * Money assigned to another payer's adjudication — the `OA` group (M8).
   *
   * It counts toward `accountedFor` exactly as it did when it was lumped into `informational`, so
   * the reconciliation is unchanged and no COB claim starts reporting phantom `unexplained` money.
   * What changes is that it now leaves this function as its own named figure instead of being
   * summed into a local variable and forgotten.
   */
  const coordination = byCategory(paid.adjustments, "coordination");

  /**
   * Everything the payer took off the charge should be explained by a reason code; whatever is
   * left over is money that vanished silently.
   *
   * ── WHY THIS ARITHMETIC MOVED OUT ────────────────────────────────────────────────────────────
   * The sum and the clamp used to be written inline here, and they were the only place in the
   * system that knew how a claim's money divides. That was fine while only this module needed to
   * know — but the ESTIMATE half has to reach the same partition to quote a patient correctly, and
   * a second implementation of these lines is how the two halves drift apart.
   *
   * So the partition is now a shared value with stated laws (`@mermaid/shared`), and this function
   * reads its figures off it. The arithmetic is unchanged — `partition.unexplained` is the same
   * clamped residual this line always produced — and `buildPartition` additionally keeps the
   * SIGNED residual, so an overpayment is no longer discarded on its way through.
   */
  const partition = buildPartition({
    charged: paid.chargedAmount,
    payerPaid: paid.paidAmount,
    contractual,
    patientResponsibility: patient,
    coordination,
    recoverable,
    informational,
  });
  const unexplained = partition.unexplained;

  const variance = (paid.paidAmount - expectedInsurancePays) as Cents;
  const outcome = classify(paid, variance, expectedInsurancePays);
  const adjudication = adjudicate({ paid, variance, contractual, patient, recoverable, coordination, unexplained });

  const reasons = paid.adjustments
    .filter((a) => a.category === "recoverable" && a.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  return {
    expectedInsurancePays,
    actualPaid: paid.paidAmount,
    variance,
    outcome,
    /**
     * Whether the difference is worth a person reading. Reported beside the exact figure so a
     * surface can stay quiet about a cent of rounding without any amount being rounded, and so a
     * report can separate genuine shortfalls from drift instead of summing the two together.
     */
    varianceMaterial: isMaterialVariance(variance, expectedInsurancePays),
    varianceThreshold: materialityThreshold(expectedInsurancePays),
    adjudication,
    chargedAmount: paid.chargedAmount,
    contractualAdjustments: contractual,
    patientResponsibility: patient,
    recoverableAmount: recoverable,
    unexplainedAmount: unexplained,
    coordinationAmount: coordination,
    reasons,
    explanation: explain({ paid, expectedInsurancePays, variance, outcome, contractual, patient, recoverable, coordination, unexplained, reasons }),
    /**
     * Worth a human's time. Overpayments count: the money is not the practice's yet — payers
     * reclaim them, often months later and by deducting from an unrelated remittance — and a
     * queue that only surfaces shortfalls lets the practice spend it in the meantime.
     *
     * Coordination money counts for the same reason and a sharper one: it is the only figure here
     * that belongs to nobody yet, and if a person does not resolve it the secondary claim is never
     * filed and that revenue is never pursued at all.
     */
    actionable: recoverable > 0 || unexplained > 0 || coordination > 0 || adjudication === 'overpaid',
  };
}

/**
 * Did the number match the estimate — allowing for the cents no payer means anything by? (F-6)
 *
 * ── WHY EXACT EQUALITY WAS THE WRONG TEST ──────────────────────────────────────────────────────
 * This compared `variance === 0`, so a payment differing by a single cent was labelled `underpaid`
 * on a claim the payer had settled in full. Seven of nine postings on the audited staging set were
 * marked that way, and `SELECT DISTINCT outcome FROM postings` returned only `underpaid` — a column
 * with one value tells nobody anything, and a badge that is always lit is one staff stop reading.
 * That is how a real shortfall gets missed.
 *
 * The band is a LABELLING rule and nothing more. `variance` is still the exact figure, `unexplained`
 * is still computed to the cent, and no adjustment is ever posted for rounding. What changes is only
 * whether a difference is called a shortfall.
 *
 * `actionable` is deliberately untouched: it is derived from the money partition — recoverable,
 * unexplained, coordination, overpayment — not from this label. That separation already existed and
 * is why the 1¢ cases never reached a worklist even while they were misnamed.
 */
function classify(paid: PaidClaim, variance: Cents, expected: Cents): VarianceOutcome {
  if (paid.paidAmount === 0 && paid.chargedAmount > 0) return "denied";
  if (!isMaterialVariance(variance, expected)) return "as_expected";
  return variance < 0 ? "underpaid" : "overpaid";
}

interface AdjudicationInput {
  paid: PaidClaim;
  variance: Cents;
  contractual: Cents;
  patient: Cents;
  recoverable: Cents;
  coordination: Cents;
  unexplained: Cents;
}

/**
 * Decide what happened to the claim, from the money partition rather than from the estimate.
 *
 * Order matters, and it is the order of what a biller must not miss:
 *
 * 1. Money we did not receive and can still pursue outranks everything. Whether the payer paid
 *    nothing (a denial to work) or paid something (an underpayment to chase), a recoverable or
 *    unexplained dollar is the one fact that must never be softened by the fact that the rest of
 *    the claim behaved.
 * 2. Then overpayment, because a takeback is coming and the money is not the practice's yet.
 * 3. Only then the benign readings — and a $0 payment reaches them, which is the point. A claim
 *    whose entire allowed amount went to an unmet deductible pays nothing and was adjudicated
 *    perfectly; calling it a denial starts an appeal clock against a claim nobody denied.
 */
function adjudicate(input: AdjudicationInput): Adjudication {
  const { paid, variance, contractual, patient, recoverable, coordination, unexplained } = input;
  const pursuable = recoverable + unexplained;

  if (pursuable > 0) return paid.paidAmount === 0 ? "denied" : "underpaid";

  /**
   * ── COORDINATION OUTRANKS EVERY BENIGN READING (M8) ──────────────────────────────────────────
   *
   * Placed after the pursuable check — money we can still chase from THIS payer is more urgent and
   * more actionable — but before every reading that would let the claim look finished.
   *
   * The three below it are all statements that the claim is done: `overpaid` says the payer sent
   * too much, `patient_responsibility` says bill the patient, `contractual` says write it off, and
   * `paid_correctly` says nothing further is expected. Reaching any of them while an `OA` amount is
   * outstanding would settle a claim whose money has no owner — and `settled` on `remittance.posted`
   * is derived from this value, so it would close the claim in the Claims module too.
   *
   * The most dangerous of the four is `patient_responsibility`: a primary payer's advice carrying
   * both a `PR` balance and an `OA` amount would bill the patient while a secondary payer's share is
   * still unresolved. That is the exact failure this whole slice exists to prevent, and it is a
   * compliance exposure as well as a refund.
   */
  if (coordination > 0) return "coordination_pending";

  if (variance > 0) return "overpaid";

  // Everything the payer withheld is explained. Whose money is it?
  if (patient > 0 && patient >= contractual) return "patient_responsibility";
  if (contractual > 0) return "contractual";
  return "paid_correctly";
}

interface ExplainInput {
  paid: PaidClaim;
  expectedInsurancePays: Cents;
  variance: Cents;
  outcome: VarianceOutcome;
  contractual: Cents;
  patient: Cents;
  recoverable: Cents;
  coordination: Cents;
  unexplained: Cents;
  reasons: VarianceReason[];
}

/** Plain-English sentences, in the order a person needs them: what happened, then why, then what next. */
function explain(input: ExplainInput): string[] {
  const { paid, expectedInsurancePays, variance, outcome, contractual, patient, recoverable, coordination, unexplained, reasons } = input;
  const lines: string[] = [];

  if (outcome === "denied") {
    lines.push(`The payer paid nothing against ${formatUsd(paid.chargedAmount)} in charges. The estimate expected ${formatUsd(expectedInsurancePays)}.`);
  } else if (outcome === "as_expected") {
    lines.push(`The payer paid ${formatUsd(paid.paidAmount)} — exactly what the estimate promised.`);
  } else if (outcome === "underpaid") {
    lines.push(
      `The payer paid ${formatUsd(paid.paidAmount)} against an expected ${formatUsd(expectedInsurancePays)} — ` +
        `${formatUsd(Math.abs(variance) as Cents)} short.`
    );
  } else {
    lines.push(`The payer paid ${formatUsd(paid.paidAmount)}, which is ${formatUsd(variance)} MORE than expected. Verify before spending it — overpayments are frequently taken back.`);
  }

  if (contractual > 0) {
    lines.push(`${formatUsd(contractual)} is a contractual fee-schedule reduction. That is the cost of being in network, not a shortfall to chase.`);
  }
  if (patient > 0 && coordination === 0) {
    lines.push(`${formatUsd(patient)} is the patient's responsibility — bill the patient, not the payer.`);
  } else if (patient > 0) {
    /**
     * The `PR` amount is real, and it is NOT safe to act on yet (M8).
     *
     * A payer stating both a patient balance and an `OA` coordination amount is describing a claim
     * where another plan is in play. Telling staff to "bill the patient" here is how a practice
     * charges someone for money a secondary payer owes.
     */
    lines.push(
      `${formatUsd(patient)} is marked as the patient's — but do NOT bill it yet: this payer also ` +
        `assigned ${formatUsd(coordination)} to another payer's adjudication, so what the patient ` +
        `actually owes depends on what that payer pays.`
    );
  }
  if (coordination > 0) {
    lines.push(
      `${formatUsd(coordination)} was assigned to another payer's adjudication (coordination of ` +
        `benefits). This money is neither a write-off nor the patient's until the other plan has ` +
        `ruled. Establish the other coverage, file the secondary claim, and post its remittance ` +
        `before deciding who owes the remainder.`
    );
  }
  if (recoverable > 0) {
    const top = reasons
      .slice(0, 3)
      .map((r) => `${r.group}-${r.code} ${r.description} (${formatUsd(r.amount)}${r.procedureCode ? ` on ${r.procedureCode}` : ""})`)
      .join("; ");
    lines.push(`${formatUsd(recoverable)} was withheld for reasons that can be corrected or appealed: ${top}.`);
  }
  if (unexplained > 0) {
    lines.push(
      `${formatUsd(unexplained)} of the charge is unaccounted for — the payer neither paid it nor gave a reason code for it. ` +
        `Query the payer directly; nothing but this arithmetic will surface it.`
    );
  }
  if (recoverable === 0 && unexplained === 0 && coordination === 0 && outcome !== "as_expected" && outcome !== "overpaid") {
    lines.push("Every dollar of the difference is explained by contractual terms or patient responsibility — there is nothing to pursue with the payer.");
  }
  return lines;
}

/**
 * Work priority for a variance, 0–100. Ranks by what is actually retrievable: a large contractual
 * write-off scores nothing, while a small unexplained shortfall scores highly because it signals a
 * payer problem that is probably repeating across other claims.
 */
export function variancePriority(variance: Variance): number {
  if (!variance.actionable) return 5;
  let priority = 40;
  if (variance.unexplainedAmount > 0) priority += 25;
  if (variance.outcome === "denied") priority += 20;
  const atStake = variance.recoverableAmount + variance.unexplainedAmount;
  if (atStake >= 50_000) priority += 15; // $500+
  else if (atStake >= 10_000) priority += 8; // $100+
  return Math.max(0, Math.min(100, priority));
}

/**
 * Does this advice RESTATE what the patient owes, or is it silent about them? (L-2)
 *
 * ── WHY THIS IS NOT JUST CLP02 ─────────────────────────────────────────────────────────────────
 * A payer settling a won appeal sends an ordinary "processed" status — there is no CLP02 meaning
 * "supplemental payment, patient unchanged". The staging advice that forgave a real $136.01 arrived
 * as `partial`, so a status-only rule would have let it through.
 *
 * What actually separates the two is whether the advice says anything about the patient at all:
 *
 *   • a `PR`-group adjustment — the payer assigning, or reversing, the patient's share; or
 *   • a non-zero patient figure on the claim.
 *
 * The settlement had neither. It carried a contractual write-off and a payment, and mentioned the
 * patient nowhere. A genuine re-adjudication down to zero still qualifies, because a payer zeroes a
 * share with PR-group reversal adjustments rather than by omitting the subject.
 *
 * `forwarded` (CLP02 19/20) is excluded outright: the claim went to another plan, and the balance on
 * it is not safely the patient's (M8). `reversal` (CLP02 22) is excluded too — it retracts a prior
 * adjudication rather than making a new statement, and the replacement that follows is what speaks.
 */
export function restatesPatientResponsibility(posting: {
  disposition: string;
  patientResponsibility: Cents;
  adjustments: VarianceReason[];
}): boolean {
  const adjudicated =
    posting.disposition === "paid_full" ||
    posting.disposition === "partial" ||
    posting.disposition === "denied";
  if (!adjudicated) return false;
  return posting.patientResponsibility > 0 || posting.adjustments.some((a) => a.category === "patient");
}
