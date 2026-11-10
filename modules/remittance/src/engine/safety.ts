/**
 * Money-safety gate — the checks a remittance must pass before a single cent posts.
 *
 * Blueprint P3 names money safety as the phase's defining concern, and the risk review (§2) names
 * remittance idempotency specifically. The reasoning is asymmetric: a remittance that fails to post
 * is an inconvenience someone notices within a day, while a remittance that posts *twice*, or posts
 * numbers that do not add up, corrupts the ledger the practice bills patients and reports revenue
 * from. Refusing to post is always the cheaper failure.
 *
 * Three gates, in order:
 *
 *   1. **Idempotency.** One trace number posts exactly once. The clearinghouse may hand us the same
 *      ERA repeatedly, the outbox delivers at least once, and a user may re-upload the same file —
 *      none of that may double-count money.
 *   2. **Balance.** `charged = paid + adjustments`, on every claim, and the payment total must equal
 *      the claims less provider adjustments. An 835 that does not balance is held for a human.
 *   3. **Reversal isolation.** A CLP-22 reversal retracts a prior payment; it is never auto-posted.
 *
 * Pure functions over data — no I/O, no clock of their own.
 */
import { addCents, formatUsd, isMaterialVariance, type Cents } from "@mermaid/shared";
import type { RemittanceAdvice, RemittanceClaim } from "@mermaid/edi";

export type SafetyCode =
  | "unbalanced"
  | "claim-unbalanced"
  | "patient-responsibility-mismatch"
  | "over-attributed"
  | "reversal-present"
  /**
   * Money on this claim belongs to another payer's adjudication, or the payer forwarded the claim
   * to another plan, and nobody has established what that plan paid (M8).
   */
  | "coordination-unresolved"
  /**
   * BPR16 names a funds-transfer date that has not arrived. Either a corrupt file, a misconfigured
   * sender, or a fixture that escaped — and in every case the money has not moved yet.
   */
  | "payment-date-in-the-future"
  /**
   * Another advice for this same claim, carrying the SAME payment, has already been posted. Paying
   * it again books cash the practice never received and hands the patient a credit that is not theirs.
   */
  | "duplicate-advice"
  /**
   * Another advice for this claim is HELD carrying the same payment. Nothing has moved yet, so this
   * is not yet a double-post — it is two loaded guns, and releasing both fires twice.
   */
  | "duplicate-advice-pending"
  /**
   * Same claim, same amount, but the payer adjudicated it differently. That is the shape of a
   * corrected advice or an appeal recovery, not a re-send — and it must not be posted ON TOP of
   * the original, because the payer is restating one payment, not making a second.
   */
  | "duplicate-advice-restated"
  /**
   * The payer's OWN claim control number (CLP07) says this is an adjudication already on the books:
   * same payer, same payer claim control number, same claim. A different EFT trace or payment date
   * does not make it a different adjudication — it makes it the same one delivered again.
   */
  | "duplicate-adjudication"
  /** The sender's envelope says this interchange is a TEST (ISA15 = T), on a live deployment. */
  | "test-interchange"
  /**
   * A CAS amount is negative. X12 permits it — a later adjustment can reverse an earlier one —
   * but on a claim that is not itself a reversal it silently rewrites who owes what.
   */
  | "negative-adjustment"
  | "missing-trace-number"
  | "no-payment"
  | "unmatched-payment"
  /**
   * The advice's own charge disagrees with what the practice billed. The file balances internally,
   * so nothing else catches it — but it is describing a claim the practice did not send.
   */
  | "charge-mismatch"
  | "provider-adjustment"
  /**
   * The 835 names a payee other than the one this practice's ERA source registered. Raised by the
   * ERA path (`withPayeeBlocker`), never by `checkRemittanceSafety` — the gate here evaluates a
   * remittance's own arithmetic and knows nothing about where the file came from.
   */
  | "payee-mismatch";

/**
 * How much provider-level money may move without a human looking at it, in cents (M12).
 *
 * ── WHY $25, AND WHY IT IS A DEFAULT RATHER THAN A FACT ────────────────────────────────────────
 * A PLB segment carries two populations of money that look identical in the data and could not be
 * less alike in what they mean:
 *
 *   • Noise. Interest on a late-paid claim (`L6`), small administrative fees, capitation rounding.
 *     A payer paying statutory interest on a $500 claim held 30 days owes cents, not dollars.
 *   • Recoupments. A payer taking back what it decided it overpaid (`WO`, `FB`, `72`). The floor
 *     here is roughly the cheapest dental procedure a payer would bother to reverse — an exam or a
 *     single restoration, tens of dollars.
 *
 * $25.00 sits in the empty band between them: comfortably above interest and fee noise, and below
 * the smallest realistic claim takeback. The asymmetry that decides ties is the same one the rest
 * of this file is built on — a hold that turns out to be routine costs a biller a minute, while a
 * recoupment that posts unseen costs the money and the window to dispute it. When in doubt, low.
 *
 * A threshold set too low has a real cost and it is not hypothetical: one PLB holds the WHOLE
 * advice, so on a batch ERA it delays unrelated claim payments until someone releases it. That is
 * the same limitation coordination holds already carry (M8).
 *
 * **This number is not payer-sourced and is not a citation.** It is a reasoned default, in the
 * spirit of `FILING_WINDOWS_ARE_PAYER_SOURCED` — it belongs to the practice, not to Mermaid, and
 * the right end state is per-practice configuration. Stated here rather than presented as fact.
 */
export const PLB_HOLD_THRESHOLD_CENTS = 2_500 as Cents;

/**
 * Name what a single provider-level adjustment is, and which claim it came out of.
 *
 * ── ATTRIBUTION NEVER GUESSES ──────────────────────────────────────────────────────────────────
 * A reference is quoted as a claim ONLY when it is one we recorded submitting. Anything else is
 * reported as the payer's own uninterpreted string. There is no prefix match, no normalisation, no
 * nearest-neighbour: naming the wrong claim as the source of a takeback would send a biller to
 * dispute a payment that was never touched, and "we do not know" is both true and actionable.
 */
function describeProviderAdjustment(
  adjustment: { reasonCode: string; referenceId: string | null; amount: Cents },
  knownControlNumbers: ReadonlySet<string>
): string {
  const what = `${formatUsd(adjustment.amount)}${adjustment.reasonCode ? ` under reason ${adjustment.reasonCode}` : ""}`;
  if (adjustment.referenceId === null) {
    return `${what}: the payer gave no claim reference, so this cannot be attributed to a claim.`;
  }
  if (knownControlNumbers.has(adjustment.referenceId)) {
    return `${what}: taken against claim ${adjustment.referenceId}.`;
  }
  return `${what}: references ${adjustment.referenceId}, which matches no claim we recorded submitting.`;
}

export interface SafetyFinding {
  /** `blocker` prevents posting entirely; `notice` posts but tells a human to look. */
  severity: "blocker" | "notice";
  code: SafetyCode;
  message: string;
  remediation: string;
  patientControlNumber?: string;
}

/**
 * The gate's verdict on one advice.
 *
 * ── IMMUTABLE BY TYPE, NOT BY CONVENTION ───────────────────────────────────────────────────────
 * `withPayeeBlocker` carries a comment explaining that it REBUILDS this rather than mutating it,
 * because "a caller that quietly edits it would make the gate's output depend on who had touched it
 * first". That is exactly right and it was only a comment: nothing stopped a caller doing
 * `result.blockers.push(...)` or flipping `safeToPost` to true, and the thing being edited decides
 * whether a payer's money posts without a human.
 *
 * `readonly` on the fields stops reassignment; `readonly T[]` stops `push`, `splice` and `sort`.
 * A caller that wants to add a finding must now build a new verdict, which is what the comment asked
 * for and what the one existing caller already does.
 */
export interface SafetyResult {
  /** True when the remittance may post automatically. */
  readonly safeToPost: boolean;
  readonly blockers: readonly SafetyFinding[];
  readonly notices: readonly SafetyFinding[];
  readonly findings: readonly SafetyFinding[];
}

/**
 * Evaluate an advice against the money-safety gates.
 *
 * `knownControlNumbers` is the set of claims we have an expectation for. A payment for a claim we
 * never recorded submitting is a NOTICE, not a blocker: the money is real and should be posted, but
 * someone needs to find out what it belongs to. Blocking it would leave real cash unrecorded, which
 * is its own reconciliation problem.
 */
/**
 * One payment already recorded against a claim, as the duplicate gate needs to see it.
 *
 * ── WHY THIS REPLACED A `Map<controlNumber, totalCents>` ─────────────────────────────────────────
 * The first version of this gate summed every posted payment per claim and compared the incoming
 * amount to that total. A sum answers the wrong question, and it was wrong in both directions:
 *
 *   two prior postings of $400 total $800, so a THIRD $400 duplicate passed (800 !== 400);
 *   the same history blocked a legitimate $800 payment, which matched the total by coincidence.
 *
 * A duplicate is a claim about ONE prior payment, so the gate has to see them individually.
 */
export interface PriorPayment {
  patientControlNumber: string;
  paid: Cents;
  /**
   * `posted` — the money has moved. `held` — it has not, but a person clicking release will move it.
   *
   * Both matter, and only the first used to be looked at. Two advices carrying the same payment can
   * sit held side by side: `dedupeKeyFor` keys on the payer plus the TRACE NUMBER, so a payer
   * re-sending the same payment under a new trace produces two distinct rows, each of which passes
   * every other gate. Release both and the money posts twice.
   */
  status: "posted" | "held";
  /** The advice it came from, so a finding can name the thing to go and look at. */
  traceNumber: string;
  /**
   * How the payer adjudicated it: the CAS triplets, normalised and ordered.
   *
   * This is the discriminator between a re-send and a correction. A payer re-transmitting a payment
   * sends the same adjudication; a payer CORRECTING one — or paying an appeal — changes at least one
   * reason code, because the change in reasoning is what the new advice exists to communicate.
   */
  adjudication: string;
  /**
   * The identity of the payer's adjudication: who paid, and the payer's own claim control number
   * (CLP07). Optional because a payer may omit CLP07, and because a prior payment described without
   * them is still a prior payment — it simply cannot take part in the identity match.
   */
  payerName?: string;
  payerControlNumber?: string;
  /**
   * A reversal (CLP02 = 22) legitimately repeats the claim control number of the payment it
   * retracts. That is the one sanctioned way a payer re-uses an identity, so a reversal is never
   * matched on identity, in either direction.
   */
  reversal?: boolean;
  /** Which remittance it came from — so a check can exclude an advice's own payments. */
  remittanceId?: string;
}

/**
 * Findings a person may NOT override by releasing, whatever reason they give.
 *
 * Every other blocker is a question a human can answer — "yes, I reconciled this against the paper
 * EOB". These are not questions: the money is either already on the books or was never real, and
 * releasing posts cash the practice did not receive. The exit for each is `reject`.
 */
export const UNRELEASABLE_SAFETY_CODES: ReadonlySet<SafetyCode> = new Set<SafetyCode>([
  "duplicate-adjudication",
  "duplicate-advice",
  "test-interchange",
]);

/** One claim payment, as `duplicateFindings` needs to see it — from an advice OR a stored posting. */
export interface DuplicateCandidate {
  patientControlNumber: string;
  payerControlNumber: string;
  paid: Cents;
  reversal: boolean;
  adjustments: readonly { category: string; group: string; code: string; amount: number }[];
}

const samePayer = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/** What the gate knows about a claim beyond the payments already recorded against it. */
export interface ClaimContext {
  /**
   * Money a payer has AGREED on appeal and not yet paid.
   *
   * The safety valve for recovery money. An appeal award of $400 on a claim that was already paid
   * $400 produces an incoming payment identical to the original in amount — and the practice has
   * been told, in writing, to expect exactly that. Blocking it would hold the money this system
   * exists to recover, on evidence the system itself already knows to be misleading.
   */
  awardOutstanding: Cents;
  /**
   * What the practice itself billed on this claim — `ClaimExpectation.totalFee`.
   *
   * The advice states its own charge in CLP02, and until now nothing compared the two. An advice is
   * checked thoroughly for agreeing with ITSELF — paid plus adjustments must equal its charge, no
   * bucket may exceed it — and every one of those checks passes on a file whose charge is simply
   * wrong. Probed against the deployed build: an advice claiming $999,999.99 charged and paid on a
   * claim the practice filed for $1,425.00 balanced perfectly, and posted.
   *
   * Absent when the claim is one this practice has no expectation for; that case has its own notice
   * and must not be turned into a charge mismatch as well.
   */
  filedCharge?: Cents;
}

/**
 * How a payer adjudicated one claim, as a comparable string.
 *
 * Sorted, because segment ORDER within an 835 is not a fact about the adjudication — the same
 * decision transmitted twice may list its CAS segments differently. Category is included as well as
 * the raw code so that a re-bucketed adjustment (a code that moved from `informational` to
 * `recoverable`) reads as the different adjudication it is.
 */
export function adjudicationOf(
  adjustments: readonly { category: string; group: string; code: string; amount: number }[]
): string {
  return adjustments
    .map((a) => `${a.category}:${a.group}:${a.code}:${a.amount}`)
    .sort()
    .join("|");
}

export function checkRemittanceSafety(
  advice: RemittanceAdvice,
  knownControlNumbers: ReadonlySet<string>,
  now: Date = new Date(),
  /**
   * What has ALREADY been posted against each claim, by control number, from other advices.
   *
   * ── WHY THE GATE COULD NOT SEE A DUPLICATE ────────────────────────────────────────────────────
   * Every other check reads one advice in isolation, which is right for all of them: an advice
   * either balances or it does not. A duplicate is the one hazard invisible from inside a single
   * file — the second copy is perfectly well-formed, balances exactly, and is indistinguishable
   * from the first except that the first already happened.
   *
   * Found on live staging. Claim MRM-BDEDD701FE6B carried THREE advices of $799.99: one posted on
   * 28 August, and two more held for coordination on the 30th and 31st. Both held ones told a
   * biller "Review and release", which would have posted $799.99 twice more against a claim that
   * expected $800.00 — phantom cash, and a $1,599.98 credit on a patient who owes money.
   *
   * Empty when the caller has nothing to say, which keeps every existing call site correct.
   */
  priorPayments: readonly PriorPayment[] = [],
  /**
   * Per-claim context, keyed by control number. Absent means "nothing else is known", which is the
   * conservative reading everywhere it is used.
   */
  claimContexts: ReadonlyMap<string, ClaimContext> = new Map(),
  /**
   * Deployment-level policy the gate cannot infer from a file.
   *
   * `testInterchanges` — whether an advice whose envelope says TEST (ISA15 = T) may post. `"accept"`
   * by default so every existing caller behaves exactly as before; the composition root passes
   * `"refuse"` whenever the deployment can reach real payers.
   */
  options: { testInterchanges?: "accept" | "refuse" } = {}
): SafetyResult {
  const findings: SafetyFinding[] = [];
  const blocker = (f: Omit<SafetyFinding, "severity">) => findings.push({ severity: "blocker", ...f });
  const notice = (f: Omit<SafetyFinding, "severity">) => findings.push({ severity: "notice", ...f });

  /**
   * ── A PAYMENT CANNOT HAVE BEEN MADE ON A DAY THAT HAS NOT ARRIVED (M8) ────────────────────────
   * BPR16 is the effective date of the funds transfer. An advice claiming one in the future is
   * either a corrupt file, a misconfigured sender, or a test fixture that escaped — and in every
   * case the money it describes has not moved yet, so posting it books cash the practice does not
   * have and dates it wrongly in every aged report that reads `paymentDate`.
   *
   * Found on live staging: an appeal-settlement advice carried `BPR*I*1125.00*C*ACH***20261005`
   * while its own interchange header said `260830` and it was ingested on 30 August. The Money
   * screen showed "Paid 2026-10-05" for money booked 36 days earlier, and nothing anywhere
   * objected.
   *
   * A NOTICE rather than a blocker, deliberately, and for the same reason an unmatched payment is:
   * the cash may well be real and refusing to record it creates a worse reconciliation problem than
   * recording it with a questionable date. It needs a person, not a wall.
   *
   * One day of slack absorbs the ordinary case — a payer in a later timezone stamping tomorrow's
   * date — without letting a genuinely impossible date through.
   */
  const paymentDay = advice.paymentDate?.slice(0, 10);
  if (paymentDay && /^\d{4}-\d{2}-\d{2}$/.test(paymentDay)) {
    const latestAcceptable = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (paymentDay > latestAcceptable) {
      notice({
        code: "payment-date-in-the-future",
        message:
          `The payer dates this payment ${paymentDay}, which has not happened yet. ` +
          `Money cannot have been transferred on a future date.`,
        remediation:
          "Check the advice against the payer's portal or the bank deposit before posting. If the " +
          "date is a sender error, note the real one — every aged report reads this field.",
      });
    }
  }

  /**
   * ── THE SAME PAYMENT, ON THE SAME CLAIM, TWICE ────────────────────────────────────────────────
   * Evaluated by `duplicateFindings`, which the RELEASE path runs as well — see its header. One
   * definition of "duplicate" for both, so a copy the gate holds cannot be released by a path that
   * understands duplicates differently.
   */
  findings.push(
    ...duplicateFindings(
      advice.payerName,
      advice.claims.map((c) => ({
        patientControlNumber: c.patientControlNumber,
        payerControlNumber: c.payerControlNumber,
        paid: c.paid,
        reversal: c.disposition === "reversal",
        adjustments: c.adjustments,
      })),
      priorPayments,
      claimContexts
    )
  );

  /**
   * ── A CLEARINGHOUSE TEST FILE IS NOT MONEY (ISA15 = T) ────────────────────────────────────────
   * The sender's own envelope says this interchange is a test. It balances, it names payers and
   * patients, and every other gate passes it — the usage indicator is the only field anywhere in the
   * file that says the cash is not real.
   *
   * Refused only where the deployment can reach real payers (`testInterchanges: "refuse"`). A
   * demonstration deployment runs on the mock clearinghouse or a vendor's test mode, and EVERY file
   * it receives is a test file by construction — refusing them there would stop the demo posting
   * anything at all, which protects nobody.
   *
   * A blocker the release path will not override: there is no reading of "the payer marked this as
   * not real" under which posting it is correct. The exit is `reject` with kind `test-file`.
   */
  if (advice.usageIndicator === "T" && options.testInterchanges === "refuse") {
    blocker({
      code: "test-interchange",
      message:
        "The sender marked this interchange as a TEST file (ISA15 = T). It is not a payment, and this " +
        "deployment posts to a real practice's books.",
      remediation:
        "Do not release it. Reject it as a test file, then find out why a test interchange reached a " +
        "live deployment — the clearinghouse connection is usually pointed at its sandbox.",
    });
  }
  /**
   * ── NO BUCKET MAY GO NEGATIVE (invariant I5) ──────────────────────────────────────────────────
   * `@mermaid/shared` states the laws a money partition obeys, and I5 is the simplest: every amount
   * is a non-negative whole number of cents, because a credit is a DIRECTION and direction lives in
   * which bucket money sits in, never in its sign.
   *
   * Those laws were enforced in `checkPartition`, in its unit tests, and in an offline script — and
   * nowhere on the path money actually travels. This is what that cost:
   *
   *   CLP*MRM-NEG1*1*1000.00*600.00*500.00      charged 1000, paid 600, patient 500
   *   CAS*CO*45*-100.00                          a contractual write-off, REVERSED
   *   CAS*PR*2*500.00
   *
   * 600 + (−100) + 500 = 1000, so the file balances. CLP05 agrees with the PR total, so the
   * patient-responsibility cross-check passes. It is not a CLP-22, so the reversal gate ignores it.
   * The advice POSTED automatically with no hold and no finding — and billed the patient $500 where
   * a well-formed advice would have said $300. The negative moved $200 onto a person.
   *
   * It also breaks I1: `allowed = charged − contractual` = $1,100 against a $1,000 charge, an
   * allowed amount larger than the bill.
   *
   * Checked on the RAW adjustments rather than on the built partition, because this is the earliest
   * point the sign exists and because bucketing a negative is already the damage. A claim that IS a
   * reversal is caught by its own gate; this one is for the negative nobody labelled.
   */
  for (const claim of advice.claims) {
    for (const adjustment of claim.adjustments) {
      if (adjustment.amount >= 0) continue;
      blocker({
        code: "negative-adjustment",
        patientControlNumber: claim.patientControlNumber,
        message:
          `Claim ${claim.patientControlNumber} carries a negative ${adjustment.group}-${adjustment.code} ` +
          `adjustment of ${formatUsd(Math.abs(adjustment.amount) as Cents)}. A negative reverses an earlier ` +
          `adjustment, which changes who owes what without saying so.`,
        remediation:
          "Read this advice against the one it corrects before posting. A reversed adjustment moves " +
          "money between the payer, the contract and the patient, and posting it unread can bill a " +
          "patient for a write-off the payer had already taken.",
      });
    }
  }

  if (!advice.traceNumber.trim()) {
    blocker({
      code: "missing-trace-number",
      message: "The remittance carries no trace (check or EFT) number.",
      remediation:
        "Without a trace number there is no way to guarantee this posts only once. Obtain the trace number from the payer or clearinghouse before posting.",
    });
  }

  if (!advice.balanced) {
    for (const issue of advice.issues) {
      blocker({
        code: "unbalanced",
        message: issue,
        remediation: "Reconcile against the payer's paper EOB. Do not post until the arithmetic agrees.",
      });
    }
  }

  for (const claim of advice.claims) {
    if (claim.unbalanced) {
      blocker({
        code: "claim-unbalanced",
        patientControlNumber: claim.patientControlNumber,
        message: `Claim ${claim.patientControlNumber} does not balance: ${formatUsd(claim.charged)} charged, ${formatUsd(claim.paid)} paid.`,
        remediation: "Reconcile this claim against the payer's EOB before posting the remittance.",
      });
    }
    /**
     * ── COORDINATION OF BENEFITS: HOLD, BECAUSE THE MONEY HAS NO OWNER YET (M8) ─────────────────
     *
     * Two independent signals, either of which means another plan is involved in this claim:
     *
     *   • an `OA`-group adjustment (CARC 23, "the impact of prior payer(s) adjudication") — money
     *     this payer explicitly assigned to another payer's decision;
     *   • CLP02 `19`/`20`, the payer stating it forwarded the claim to another plan.
     *
     * Both used to pass straight through. `OA` was categorised `informational`, which balanced the
     * arithmetic and reported nothing; `19`/`20` were collapsed into paid/partial/denied by amount.
     * The remittance then posted, and `chargeFromPosting` billed the patient the primary's `PR`
     * balance — money a secondary payer may owe. That is a refund when discovered and a
     * balance-billing exposure in several states.
     *
     * A BLOCKER rather than a notice, on the same reasoning as every other blocker here: the
     * asymmetry. Holding a remittance costs a day of someone's attention. Posting it bills a patient
     * for money that is not theirs and closes a claim whose secondary was never filed, so that
     * revenue is never pursued at all. Refusing to post is the cheaper failure.
     *
     * Held, not discarded: the raw 835 is retained, the amount is on the posting and named on the
     * variance as `coordinationAmount`, and releasing requires a person and a reason. Nothing is
     * lost — it is simply not acted on automatically.
     */
    const coordination = addCents(
      ...claim.adjustments.filter((a) => a.category === "coordination").map((a) => a.amount)
    );
    if (coordination !== 0 || claim.disposition === "forwarded") {
      blocker({
        code: "coordination-unresolved",
        patientControlNumber: claim.patientControlNumber,
        message:
          claim.disposition === "forwarded"
            ? `Claim ${claim.patientControlNumber} was FORWARDED by ${advice.payerName || "this payer"} to ` +
              `another plan (status ${claim.statusCode})${coordination !== 0 ? `, with ${formatUsd(coordination)} assigned to that plan's adjudication` : ""}. ` +
              `Another payer is involved and has not been accounted for.`
            : `Claim ${claim.patientControlNumber} assigns ${formatUsd(coordination)} to another payer's ` +
              `adjudication (coordination of benefits). That money is not a write-off and not the ` +
              `patient's until the other plan has ruled.`,
        remediation:
          "Establish the patient's other coverage, file the secondary claim, and post that payer's " +
          "remittance before deciding who owes the remainder. Do NOT bill the patient the balance on " +
          "this advice — a secondary payer may owe part or all of it.",
      });
    }

    if (claim.disposition === "reversal") {
      blocker({
        code: "reversal-present",
        patientControlNumber: claim.patientControlNumber,
        message: `Claim ${claim.patientControlNumber} is a reversal — the payer is retracting a previous payment.`,
        remediation:
          "Reversals are never posted automatically. Confirm which original payment is being taken back, then post the correction by hand.",
      });
    }
    /**
     * The payer may not account for more than it was billed.
     *
     * `computeVariance` derives unexplained money as `max(0, charged − accountedFor)`, so when the
     * adjustments and the payment together EXCEED the charge the excess is clamped away and the
     * claim reads as perfectly explained. Over-attribution is not a rounding artefact: it means a
     * duplicated CAS segment, a payer file error, or a parse that counted a line adjustment twice —
     * and every one of those inflates a number this system then bills someone for.
     */
    const attributed = addCents(claim.paid, ...claim.adjustments.map((a) => a.amount));
    if (attributed > claim.charged) {
      blocker({
        code: "over-attributed",
        patientControlNumber: claim.patientControlNumber,
        message:
          `Claim ${claim.patientControlNumber} accounts for ${formatUsd(attributed)} against ${formatUsd(claim.charged)} ` +
          `charged — ${formatUsd((attributed - claim.charged) as Cents)} more than was billed.`,
        remediation:
          "The payment plus its adjustments exceed the charge. Check for a duplicated adjustment on the payer's " +
          "file before posting; the excess would otherwise be written off or billed to someone.",
      });
    }

    /**
     * CLP05 must agree with the PR-group CAS segments.
     *
     * ── WHY THIS IS A BLOCKER AND NOT A NOTICE ─────────────────────────────────────────────────
     * An 835 states patient responsibility twice: once as a claim total (CLP05) and once itemised
     * as PR-group adjustments. Mermaid consumed both, in different places, and never compared them:
     * the ledger raises the patient's charge from CLP05, while the variance engine explains the
     * shortfall from the CAS segments. Two sources of truth for one number, and no invariant.
     *
     * A real remittance drifted them apart. A claim came back with $1,234.51 of CAS patient
     * responsibility and CLP05 of $0.00, so the screen advised "bill the patient $1,234.51" while
     * the ledger raised no charge at all. The money was not pursued from the payer, not billed to
     * the patient, and absent from A/R — and the recommendation on the screen said the claim was
     * settled in full.
     *
     * Money that two fields of the same file disagree about is not money to post on a guess. Held,
     * with both numbers named, for a person to reconcile against the paper EOB.
     */
    const casPatientShare = addCents(
      ...claim.adjustments.filter((a) => a.category === "patient").map((a) => a.amount)
    );
    if (casPatientShare !== claim.patientResponsibility) {
      blocker({
        code: "patient-responsibility-mismatch",
        patientControlNumber: claim.patientControlNumber,
        message:
          `Claim ${claim.patientControlNumber} states ${formatUsd(claim.patientResponsibility)} of patient ` +
          `responsibility on CLP05, but its PR adjustments total ${formatUsd(casPatientShare)}.`,
        remediation:
          "The payer's file contradicts itself about what the patient owes. Reconcile against the paper EOB " +
          "before posting — billing either figure risks charging the patient money they do not owe, or " +
          "writing off money they do.",
      });
    }

    /**
     * ── THE PAYER'S CHARGE AGAINST THE PRACTICE'S OWN ────────────────────────────────────────────
     * Every other balance check in this file asks whether the advice agrees with ITSELF. This is the
     * only one that asks whether it agrees with what the practice actually did, and it is the only
     * one that can catch a file describing the wrong claim: an extra digit, a payer's crossed wires,
     * a file meant for another provider that happens to carry a control number we recognise.
     *
     * Found by ingesting an advice claiming $999,999.99 charged and paid against a claim filed for
     * $1,425.00. It balanced — charge equals payment, no adjustments — so it posted, and the variance
     * machinery recorded a $999,934.99 overpayment AFTER the cash was already booked. A practice's
     * collections figure would have carried a million dollars it never received until somebody read
     * the flag.
     *
     * Material difference only, so a payer rounding a cent does not stop a real payment. A BLOCKER
     * rather than a notice, because the question "is this file even about our claim" has to be
     * answered before its money is believed — and blockers here are overridable by a person with a
     * reason, which is the right escape hatch for the rare legitimate case.
     */
    const filed = claimContexts.get(claim.patientControlNumber)?.filedCharge;
    /*
     * ── ONE DIRECTION ONLY, AND THE TESTS ARE WHY ────────────────────────────────────────────────
     * The first version of this check compared the two charges in both directions and broke eight
     * award-settlement tests. A CORRECTED advice legitimately covers a SUBSET of the claim's lines —
     * an appeal that re-adjudicates one crown states that crown's charge, not the whole claim's — so
     * a payer charge SMALLER than the filed total is ordinary and must stay ordinary.
     *
     * Larger is the direction that cannot be innocent: no adjudication of part of a claim charges
     * more than the practice billed for all of it. That is the shape of an extra digit or a file
     * about somebody else's claim, and it is the case that posted a million dollars.
     */
    if (filed !== undefined && filed > 0 && claim.charged > filed && isMaterialVariance((claim.charged - filed) as Cents, filed)) {
      blocker({
        code: "charge-mismatch",
        patientControlNumber: claim.patientControlNumber,
        message:
          `This advice says claim ${claim.patientControlNumber} was charged ${formatUsd(claim.charged)}, ` +
          `which is more than the ${formatUsd(filed)} the practice filed for the whole claim.`,
        remediation:
          "The file disagrees with the claim as sent, so it may belong to a different claim or carry a " +
          "keying error. Reconcile it against the payer's EOB before posting — the payment amount is " +
          "only trustworthy if the claim it names is the right one.",
      });
    }

    if (!knownControlNumbers.has(claim.patientControlNumber)) {
      notice({
        code: "unmatched-payment",
        patientControlNumber: claim.patientControlNumber,
        message: `Payment of ${formatUsd(claim.paid)} for ${claim.patientControlNumber} does not match any claim we recorded submitting.`,
        remediation:
          "The money is real and will be posted unmatched. Identify the claim it belongs to — it may have been filed outside Mermaid.",
      });
    }
  }

  if (advice.paymentTotal === 0 && advice.claims.every((c) => c.paid === 0)) {
    notice({
      code: "no-payment",
      message: "This remittance moves no money — every claim on it was denied or adjusted to zero.",
      remediation: "Nothing to deposit. Work the denials it reports.",
    });
  }

  /**
   * ── PROVIDER-LEVEL ADJUSTMENTS: A RECOUPMENT IS WORK, NOT A FOOTNOTE (M12) ────────────────────
   *
   * This used to be a notice at any size. A payer recouping $500 through PLB produced one sentence
   * on a screen nobody must clear, the advice auto-posted, and the remediation said to "reconcile
   * against the deposit total by hand".
   *
   * The arithmetic was never the problem — `reconcile()` accounts for provider adjustments, so
   * `drift` stays zero and the money monitor reports balanced. The problem is that the recoupment
   * is never tied to the claim it came from, never queued, and never chased. The claim it was
   * pulled back from still reads `paid`, so A/R is overstated by exactly the recouped amount, and
   * if the takeback was wrong the dispute window closes with nobody having seen it. A notice on a
   * screen nobody must clear is not a control.
   *
   * Above the threshold this HOLDs, which puts it in the Today queue with the review clock and
   * under the `money.held_remittance_age` monitor — the machinery a stopped remittance already
   * has. Below it, the notice stays, but it now names the reason code and the claim.
   *
   * NOTHING IS REVERSED, UNPOSTED OR RE-STATUSED HERE. Holding defers one financial decision to a
   * person; automatically backing a payment out would be a second automatic financial decision, and
   * it is precisely the thing this hold exists to avoid.
   */
  const exposure = addCents(...advice.providerAdjustments.map((p) => Math.abs(p.amount) as Cents));
  if (exposure !== 0) {
    const net = addCents(...advice.providerAdjustments.map((p) => p.amount));
    const attributions = advice.providerAdjustments.map((p) => describeProviderAdjustment(p, knownControlNumbers));
    /**
     * `net` is the cash effect; `exposure` is how much money moved at the provider level without
     * being tied to a claim, and it is the one the threshold reads. A $500 takeback offset by a
     * $500 credit nets to zero and is still two unattributed movements — under a net test it
     * produced no finding at all, not even the old notice.
     */
    const scale = exposure === Math.abs(net) ? formatUsd(net) : `${formatUsd(net)} net (${formatUsd(exposure)} moved)`;

    if (exposure > PLB_HOLD_THRESHOLD_CENTS) {
      blocker({
        code: "provider-adjustment",
        message:
          `The payer applied ${scale} in provider-level adjustments (takebacks, interest or fees) ` +
          `against this payment, above the ${formatUsd(PLB_HOLD_THRESHOLD_CENTS)} review threshold. ` +
          attributions.join(" "),
        remediation:
          "A provider-level adjustment is money moved outside any claim on this advice. Confirm against the " +
          "payer's remittance what is being recouped and whether it is correct, then release. Mermaid has NOT " +
          "changed the status of any claim named here — a recouped claim still reads as paid until a person " +
          "decides otherwise.",
      });
    } else {
      notice({
        code: "provider-adjustment",
        message:
          `The payer applied ${scale} in provider-level adjustments (takebacks, interest or fees) ` +
          `against this payment. ` + attributions.join(" "),
        remediation:
          "Below the review threshold, so this posts. These are not tied to any one claim — reconcile them " +
          "against the deposit total.",
      });
    }
  }

  const blockers = findings.filter((f) => f.severity === "blocker");
  return {
    safeToPost: blockers.length === 0,
    blockers,
    notices: findings.filter((f) => f.severity === "notice"),
    findings,
  };
}

/**
 * Daily money reconciliation (blueprint P3): every cent a payer said it sent must be accounted for
 * by a posting or an explicit provider-level adjustment.
 *
 * Run as a scheduled job. `drift` non-zero is a hard operational alert — it means the ledger and the
 * bank will disagree.
 */
export interface ReconciliationInput {
  /** BPR totals of the remittances posted in the period. */
  paymentTotals: Cents[];
  /** Amounts actually posted against claims in the period. */
  postedAmounts: Cents[];
  /** Provider-level adjustments applied in the period (takebacks, fees). */
  providerAdjustments: Cents[];
}

export interface ReconciliationReport {
  paymentsReceived: Cents;
  amountPosted: Cents;
  providerAdjustments: Cents;
  /** `paymentsReceived - (amountPosted - providerAdjustments)`. Must be zero. */
  drift: Cents;
  balanced: boolean;
  summary: string;
}

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const paymentsReceived = addCents(...input.paymentTotals);
  const amountPosted = addCents(...input.postedAmounts);
  const providerAdjustments = addCents(...input.providerAdjustments);
  const drift = (paymentsReceived - (amountPosted - providerAdjustments)) as Cents;

  return {
    paymentsReceived,
    amountPosted,
    providerAdjustments,
    drift,
    balanced: drift === 0,
    summary:
      drift === 0
        ? `Reconciled: ${formatUsd(paymentsReceived)} received, ${formatUsd(amountPosted)} posted, ${formatUsd(providerAdjustments)} in provider adjustments.`
        : `DRIFT of ${formatUsd(drift)} — ${formatUsd(paymentsReceived)} was received but ${formatUsd(amountPosted)} was posted against ${formatUsd(providerAdjustments)} in provider adjustments. The ledger and the bank will disagree until this is resolved.`,
  };
}

/** Claims on an advice that can be matched to something we expected. */
export const matchable = (advice: RemittanceAdvice, known: ReadonlySet<string>): RemittanceClaim[] =>
  advice.claims.filter((c) => known.has(c.patientControlNumber));

/**
 * Every duplicate finding for one advice, against the payments already recorded elsewhere.
 *
 * ── WHY THIS IS ITS OWN FUNCTION ───────────────────────────────────────────────────────────────
 * It ran inside `checkRemittanceSafety`, which runs once, at ingest. `release` never asked again —
 * so an advice held for a DIFFERENT reason before its twin was posted, or ingested before this
 * check existed, carried no duplicate finding and released cleanly. Found on staging: claim
 * MRM-BDEDD701FE6B had one advice posted and two more copies held for coordination, both
 * releasable. The service now runs this same function at release, over the stored postings, so the
 * two paths cannot disagree about what a duplicate is.
 *
 * ── TWO WAYS TO RECOGNISE THE SAME PAYMENT ─────────────────────────────────────────────────────
 *   • By IDENTITY: same payer, same payer claim control number (CLP07), same claim — AND the same
 *     adjudication content (the same amount, adjusted for the same reasons). The payer's own
 *     identifier on the payer's own decision, delivered again: whatever the EFT trace or payment date
 *     says, it is one payment. This is the staging case exactly.
 *   • By AMOUNT: same claim, same figure. The older net, kept for payers that omit CLP07, where a
 *     re-send is recognisable only by paying the identical sum again.
 *
 * ── WHY THE IDENTIFIER ALONE IS NOT ENOUGH ─────────────────────────────────────────────────────
 * The first version of this match used the claim control number on its own, and it hard-blocked a
 * real and tested flow: after an appeal is won, payers commonly send the additional money under the
 * SAME claim control number, as a supplemental payment with no reversal
 * (`tests/vertical-award-settlement.test.ts`, C and F-5/B). Same identifier, different content, and
 * genuinely new money. So a different amount under the same identifier is NOT a copy — it stays
 * subject to the amount checks and the appeal valve exactly as before, and only an identical
 * adjudication under the same identifier is treated as the same payment arriving again.
 *
 * A reversal is excluded from identity matching on both sides: retracting a payment is the one
 * legitimate reason a payer repeats a claim control number.
 */
export function duplicateFindings(
  payerName: string,
  claims: readonly DuplicateCandidate[],
  priorPayments: readonly PriorPayment[],
  claimContexts: ReadonlyMap<string, ClaimContext> = new Map()
): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const blocker = (f: Omit<SafetyFinding, "severity">) => findings.push({ severity: "blocker", ...f });
  const notice = (f: Omit<SafetyFinding, "severity">) => findings.push({ severity: "notice", ...f });

  for (const claim of claims) {
    if (claim.paid <= 0) continue;

    const byAmount = priorPayments.filter(
      (p) => p.patientControlNumber === claim.patientControlNumber && p.paid === claim.paid
    );
    const icn = claim.payerControlNumber.trim();
    const content = adjudicationOf(claim.adjustments);
    const byIdentity =
      icn && !claim.reversal
        ? priorPayments.filter(
            (p) =>
              !p.reversal &&
              p.patientControlNumber === claim.patientControlNumber &&
              (p.payerControlNumber ?? "").trim() === icn &&
              samePayer(p.payerName, payerName) &&
              p.paid === claim.paid &&
              p.adjudication === content
          )
        : [];
    const matches = [...new Set([...byIdentity, ...byAmount])];
    if (matches.length === 0) continue;

    /**
     * ── THE APPEAL VALVE ────────────────────────────────────────────────────────────────────────
     * A payer that has AGREED an award and not yet paid it will send a payment for that award, and
     * on a claim already paid the same figure that payment is indistinguishable from a re-send by
     * amount alone. The difference is that this one was promised: the award is recorded because a
     * denial was appealed and won. Matched to the cent: an award is a figure both parties agreed.
     */
    const award = claimContexts.get(claim.patientControlNumber)?.awardOutstanding ?? (0 as Cents);
    if (award > 0 && award === claim.paid) {
      notice({
        code: "duplicate-advice",
        patientControlNumber: claim.patientControlNumber,
        message:
          `${formatUsd(claim.paid)} matches a payment already recorded against claim ` +
          `${claim.patientControlNumber}, but it also matches the ${formatUsd(award)} this payer ` +
          "agreed to pay on appeal. Treated as the recovery, not as a duplicate.",
        remediation:
          "No action needed if the appeal was won. If this payer never agreed an award, the match is " +
          "a coincidence and the payment should be checked against their remittance portal.",
      });
      continue;
    }

    const posted = matches.filter((p) => p.status === "posted");
    const postedIdentity = posted.filter((p) => byIdentity.includes(p));

    /**
     * The payer's own identifier, on an identical decision, is already on the books. Reported ahead
     * of a merely-held twin because it is the certain case: the money has moved once, and this advice
     * is that same payment arriving again under another EFT trace or date.
     */
    if (postedIdentity.length > 0) {
      const twin = postedIdentity[0]!;
      blocker({
        code: "duplicate-adjudication",
        patientControlNumber: claim.patientControlNumber,
        message:
          `The payer's claim control number ${icn} on claim ${claim.patientControlNumber} was already ` +
          `posted from advice ${twin.traceNumber}, paying the same ${formatUsd(claim.paid)} for the same ` +
          "reasons. This advice is the same adjudication delivered again.",
        remediation:
          "Reject this advice as a duplicate — it carries no money of its own. If the bank deposit shows " +
          "the payer really paid twice, that is an overpayment to refund or expect back, recorded " +
          "against the original payment, never by posting this copy.",
      });
      continue;
    }

    /**
     * A pending twin is the more dangerous shape among what is left: a posted duplicate has already
     * happened and will be found in reconciliation, while two held advices look to a biller like
     * two separate payments waiting to be released.
     */
    const pending = matches.filter((p) => p.status === "held");
    if (pending.length > 0) {
      const twin = pending[0]!;
      const sameIdentity = byIdentity.includes(twin);
      blocker({
        code: "duplicate-advice-pending",
        patientControlNumber: claim.patientControlNumber,
        message:
          `Another advice (trace ${twin.traceNumber}) is already held carrying the same ` +
          (sameIdentity
            ? `adjudication (payer claim control number ${icn}) `
            : `${formatUsd(claim.paid)} `) +
          `on claim ${claim.patientControlNumber}. Releasing both would post the payment twice.`,
        remediation:
          "Compare the two advices against the payer's remittance portal or the bank deposit. Release " +
          "the one that matches the money actually received and reject the other — they are not two " +
          "payments unless the deposit shows two.",
      });
      continue;
    }

    const identical = posted.filter((p) => p.adjudication === adjudicationOf(claim.adjustments));
    if (identical.length > 0) {
      const twin = identical[0]!;
      blocker({
        code: "duplicate-advice",
        patientControlNumber: claim.patientControlNumber,
        message:
          `${formatUsd(claim.paid)} has already been posted against claim ` +
          `${claim.patientControlNumber} from advice ${twin.traceNumber}, adjudicated identically. ` +
          "This one pays the same amount again for the same stated reasons.",
        remediation:
          "Confirm with the payer whether they actually paid twice. If they did not, reject this " +
          "advice — posting it books cash that never arrived and puts the patient in credit. If they " +
          "did, the overpayment needs a refund or a takeback, not a second posting.",
      });
      continue;
    }

    /**
     * Same money, different reasoning, and no claim control number to settle it. That is what a
     * corrected adjudication looks like from a payer that omits CLP07: the payer has restated how
     * one payment divides, not made a second one. Still a blocker, and still one a person may
     * release when the deposit shows the money twice — the identity match above is what decides
     * the cases where the payer's own identifier settles it.
     */
    const twin = posted[0]!;
    blocker({
      code: "duplicate-advice-restated",
      patientControlNumber: claim.patientControlNumber,
      message:
        `${formatUsd(claim.paid)} was already posted against claim ${claim.patientControlNumber} ` +
        `from advice ${twin.traceNumber}, but this advice adjudicates it differently. It looks like ` +
        "a corrected adjudication rather than a second payment.",
      remediation:
        "Check whether the payer is correcting the earlier advice. A correction restates one payment " +
        "and must replace the original rather than post on top of it; only release this if the " +
        "deposit shows the money arriving twice.",
    });
  }
  return findings;
}
