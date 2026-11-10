/**
 * The money partition — how one claim's charge divides, and the laws that division must obey.
 *
 * ── THIS IS A LIFT, NOT A NEW MODEL ────────────────────────────────────────────────────────────
 * The remittance engine has reasoned about money this way since it was written: every dollar a
 * payer withholds is attributed to a named bucket, and whatever cannot be attributed is
 * `unexplained` — the figure nothing but arithmetic surfaces, which is exactly why it is dangerous.
 * That reasoning is sound and stays the authority. What it lacked was a NAME and a place to live,
 * so the estimate half of the system never learned to speak it, and six competing representations
 * of "what the patient owes" grew up around it.
 *
 * So this file introduces no new arithmetic. It gives the existing partition a type, states its
 * laws as equations that can be checked, and recovers the two figures the engine computed and
 * then discarded.
 *
 * ── THE TWO RECOVERED FIGURES ──────────────────────────────────────────────────────────────────
 *
 *  1. `informational` was counted toward the reconciliation and then reported nowhere. That is the
 *     same defect `coordination` carried before M8 named it: an amount that balances perfectly,
 *     raises no `unexplained`, and appears on no screen. Balancing is not the same as being
 *     understood, and a bucket nobody can see is a bucket nobody can question.
 *
 *  2. `overpayment` did not survive at all. `unexplained` is clamped with `Math.max(0, …)`, so when
 *     a payer sends MORE than the charge could absorb, the negative residual is discarded. The
 *     clamp is right — a negative `unexplained` is meaningless — but throwing the sign away loses
 *     the fact. Overpayments are money the practice does not get to keep: payers reclaim them,
 *     often months later, by deducting from an unrelated remittance.
 *
 * ── WHY THE OBVIOUS EQUATION IS FALSE ──────────────────────────────────────────────────────────
 * It is tempting to write
 *
 *     allowed === payerPaid + patientResponsibility + coordination + recoverable + unexplained
 *
 * and assert it. It does not hold. The moment a payer overpays, the residual goes negative, the
 * clamp discards it, and the left side exceeds the right by exactly the overpaid amount. An
 * assertion written that way fails on real remittances, and — worse — a system that BELIEVES it
 * has silently mislaid the difference. The signed form in `I4` below is the true law.
 *
 * Pure and deterministic: no I/O, no clock, no logging. A value that decides whether a practice
 * chases a payer must be reproducible, and the caller decides what a violation means.
 */
import { addCents, subCents, ZERO, type Cents } from "../money.ts";

/**
 * How one claim's charge divides. Every field is a non-negative amount in integer cents.
 *
 * The five attribution buckets carry the meanings the remittance engine established, and those
 * meanings are the product — a practice does not need to be told it was paid less than expected,
 * it needs to be told WHICH part is normal, which is the patient's, and which someone still owes:
 *
 *   contractual   the payer's fee schedule sits below our fee. Expected. Never chase it.
 *   patient       deductible, coinsurance, exhausted benefits. Bill the patient.
 *   recoverable   missing information, bundling, absent pre-auth. Correct it or appeal it.
 *   coordination  another payer's adjudication (`OA`, CARC 23). Belongs to NOBODY yet — hold it.
 *   informational the payer said something that moved money without assigning responsibility.
 */
export interface MoneyPartition {
  /** What the practice billed. The whole that everything else divides. */
  charged: Cents;
  /**
   * The contracted maximum for this charge — `charged − contractual`.
   *
   * On the remittance side this is always derivable, because the payer states its write-off. It is
   * named here rather than left implicit because the ESTIMATE side has no way to state it at all
   * today, which is the defect that makes every in-network quote too high.
   */
  allowed: Cents;
  contractual: Cents;
  payerPaid: Cents;
  patientResponsibility: Cents;
  coordination: Cents;
  recoverable: Cents;
  informational: Cents;
  /**
   * Money withheld with NO reason code. Must be zero on a well-formed remittance; anything else is
   * revenue that vanished silently, and nothing surfaces it except this arithmetic.
   */
  unexplained: Cents;
  /** Money that arrived beyond what the charge could absorb. Not the practice's to spend. */
  overpayment: Cents;
}

/** What the payer's advice attributed, before the residual is worked out. */
export interface PartitionInput {
  charged: Cents;
  payerPaid: Cents;
  contractual: Cents;
  patientResponsibility: Cents;
  coordination?: Cents;
  recoverable?: Cents;
  informational?: Cents;
}

/**
 * Everything the payer accounted for: what it paid, plus every dollar it withheld under a reason.
 *
 * `informational` is included, exactly as the remittance engine has always included it. Leaving it
 * out would push those dollars into `unexplained` and put invented shortfalls into the recovery
 * queue — the opposite of the problem naming it was meant to solve.
 */
/**
 * Fields of a partition that are NOT withheld-money buckets.
 *
 * `charged` is the whole the buckets divide; `allowed` is a derived view of it (charged minus the
 * write-off) and would double-count; `unexplained` and `overpayment` are the two halves of what the
 * buckets FAILED to account for, so including them would make the reconciliation circular.
 *
 * Everything else is a bucket, by exclusion. That direction matters — see `bucketTotal`.
 */
const NON_BUCKET_FIELDS: ReadonlySet<string> = new Set(["charged", "allowed", "unexplained", "overpayment"]);

/**
 * Every bucket's money, summed from the partition's own shape rather than from a written-out list.
 *
 * ── WHY THIS IS NOT JUST `accountedFor` AGAIN ────────────────────────────────────────────────────
 * `accountedFor` names its members explicitly, which is right: it is the definition of what the
 * payer accounted for, and a reader should be able to see the list. But a check built on that same
 * list cannot detect anything wrong with the list itself.
 *
 * That was not a theoretical gap. The I4 note below used to claim "a bucket added later must be
 * added to `accountedFor`; the I4 check is what catches the omission" — and it did not. Dropping
 * `coordination` from `accountedFor` shifts those dollars into `unexplained`, which is exactly the
 * documented harm (a COB claim reporting an invented shortfall into the recovery queue), but the
 * I4 equation stays balanced because BOTH of its sides are computed from the same shortened list.
 * Two mutation tests confirmed it: both survived, silently.
 *
 * Deriving the total by exclusion instead breaks that symmetry. A bucket missing from
 * `accountedFor` is still counted here, the two disagree, and I4 fires. The stated property is now
 * the real one.
 */
function bucketTotal(p: MoneyPartition): Cents {
  let total = 0;
  for (const [field, value] of Object.entries(p)) {
    if (!NON_BUCKET_FIELDS.has(field) && typeof value === "number") total += value;
  }
  return total as Cents;
}

export function accountedFor(p: MoneyPartition): Cents {
  return addCents(
    p.payerPaid,
    p.contractual,
    p.patientResponsibility,
    p.coordination,
    p.recoverable,
    p.informational
  );
}

/**
 * The signed gap between the charge and what the payer accounted for.
 *
 * Positive means money went missing; negative means more arrived than the charge could absorb.
 * Both directions matter, and keeping the sign is the whole point — `unexplained` and
 * `overpayment` are the two halves of this one number, split so each can be acted on.
 */
export function residual(p: MoneyPartition): Cents {
  return subCents(p.charged, accountedFor(p));
}

/**
 * Raised when a partition breaks a law that its own construction is supposed to guarantee.
 *
 * Carries the violations rather than a formatted string, so a caller can group by invariant and a
 * log can carry the figures. `name` is set explicitly because a subclass of `Error` compiled by a
 * strip-only toolchain does not get one for free.
 */
export class PartitionLawViolated extends Error {
  readonly violations: readonly PartitionViolation[];

  constructor(violations: readonly PartitionViolation[]) {
    super(
      `money partition violates ${violations.length === 1 ? "its law" : "its laws"}: ` +
        violations.map((v) => `${v.invariant}: ${v.detail}`).join("; ")
    );
    this.name = "PartitionLawViolated";
    this.violations = violations;
  }
}

/**
 * The laws `buildPartition` guarantees by construction, and therefore enforces on its own output.
 *
 * I5 is deliberately absent. It is the only law a well-formed `buildPartition` can break, because
 * it is a statement about the INPUTS — a negative or fractional figure propagates through untouched.
 * That is a payer-data condition, not a code defect, and it already has a designed response: the
 * `negative-adjustment` blocker holds the advice and shows the person the reversed CAS that caused
 * it. Throwing here instead would be actively harmful, because the held advice's view is built by
 * the same path (`buildRemittanceView` runs for a held remittance precisely so the hold can be
 * explained) — so a throw would replace "here is why we stopped" with a 500, hiding the finding
 * behind an outage triggered by someone else's malformed file.
 */
const CONSTRUCTION_LAWS = new Set<PartitionViolation["invariant"]>(["I1", "I3", "I4"]);

/**
 * Build a partition from what a payer's advice attributed, deriving `allowed` and the residual.
 *
 * ── WHY THE CHECK RUNS HERE, IN PRODUCTION ───────────────────────────────────────────────────────
 * The laws below were stated in `checkPartition`, exercised in its unit tests, and re-run by an
 * offline script — and never once on the path money actually travels. `computeVariance` has always
 * called `buildPartition` and read `unexplained` off it without asking whether the partition it got
 * back obeyed its own rules. A law that only holds in a test suite is a description of intent, not
 * a control.
 *
 * ── WHAT THIS CAN AND CANNOT CATCH, STATED HONESTLY ──────────────────────────────────────────────
 * For a partition this function builds, I1, I3 and I4 are tautologies of the derivation:
 *   I1  reduces to (charged − contractual) + contractual === charged
 *   I3  splits one signed gap into two halves, so at most one can be non-zero
 *   I4  reduces to accountedFor + (charged − accountedFor) === charged
 * No input, however malformed, makes them fail. So this check cannot fire on today's code, and
 * saying otherwise would be the same false assurance the offline script already provided.
 *
 * Its value is that it makes the derivation FALSIFIABLE. Change how `allowed` is derived, clamp the
 * residual back to zero, or drop a bucket from `accountedFor`, and the check fires at the call site
 * instead of quietly shipping money that does not add up. That is a regression guard on the
 * arithmetic, and `scripts/mutation-partition.mjs` proves it is one: six mutants, one per plausible
 * break, each required to die on the production path. Two of them survived when first written —
 * which is how the I4 gap described above was found.
 *
 * It throws rather than reporting, because there is no sensible way to continue: every figure the
 * remittance engine reads off the partition — the shortfall it queues for recovery, the balance it
 * bills a patient — is derived from arithmetic that has just been shown to be wrong.
 */
export function buildPartition(input: PartitionInput): MoneyPartition {
  const coordination = input.coordination ?? ZERO;
  const recoverable = input.recoverable ?? ZERO;
  const informational = input.informational ?? ZERO;
  const base = {
    charged: input.charged,
    allowed: subCents(input.charged, input.contractual),
    contractual: input.contractual,
    payerPaid: input.payerPaid,
    patientResponsibility: input.patientResponsibility,
    coordination,
    recoverable,
    informational,
    unexplained: ZERO,
    overpayment: ZERO,
  };
  const gap = residual(base);
  const built: MoneyPartition = {
    ...base,
    unexplained: (gap > 0 ? gap : 0) as Cents,
    overpayment: (gap < 0 ? -gap : 0) as Cents,
  };

  const broken = checkPartition(built).filter((v) => CONSTRUCTION_LAWS.has(v.invariant));
  if (broken.length > 0) throw new PartitionLawViolated(broken);

  return built;
}

export interface PartitionViolation {
  /** The invariant's short name, so a report can group by law rather than by claim. */
  invariant: "I1" | "I3" | "I4" | "I5";
  detail: string;
}

/**
 * Check a partition against its laws. Returns every violation rather than throwing on the first,
 * because a caller reconciling a batch wants the whole picture, and because a thrown error inside
 * remittance ingestion would stop money being posted over a reporting fault.
 *
 * ── THE LAWS ───────────────────────────────────────────────────────────────────────────────────
 *
 *   I1  charged === allowed + contractual
 *       The contract splits the charge and nothing else does.
 *
 *       (There is no I2. `accountedFor` — payerPaid plus every withheld bucket — is a DEFINITION
 *       rather than a law. It is named in the numbering only because I4 is stated in terms of it.
 *
 *       This note used to end: "a bucket added later must be added to `accountedFor`; the I4 check
 *       is what catches the omission". That was false, and mutation testing is what showed it.
 *       Removing `coordination` from `accountedFor` does exactly the documented harm — those COB
 *       dollars resurface as `unexplained` and go to the recovery queue as an invented shortfall —
 *       but the I4 equation stayed balanced, because both of its sides were computed from the same
 *       shortened list. Two mutants survived, silently.
 *
 *       I4 now reconciles against `bucketTotal`, which derives the same sum from the partition's
 *       own fields by EXCLUDING the four that are not buckets. A bucket missing from `accountedFor`
 *       is still counted there, the two totals disagree, and I4 fires. The property the note
 *       claimed is now the property the code has.)
 *
 *   I3  unexplained and overpayment are the two halves of one signed residual, and at most one of
 *       them is ever non-zero.
 *
 *   I4  charged === accountedFor + unexplained − overpayment
 *       The signed reconciliation. Equivalently, and this is the form worth remembering:
 *
 *         allowed === payerPaid + patientResponsibility + coordination
 *                     + recoverable + informational + unexplained − overpayment
 *
 *       Note the trailing `− overpayment`. Without it the equation is false on every overpaid
 *       remittance, which is precisely the trap this file exists to document.
 *
 *   I5  every amount is a non-negative integer number of cents. A negative is a representation
 *       error, never a credit — a credit is a direction, and direction lives in which bucket the
 *       money is in, not in its sign.
 */
export function checkPartition(p: MoneyPartition): PartitionViolation[] {
  const violations: PartitionViolation[] = [];
  const money: [keyof MoneyPartition, Cents][] = [
    ["charged", p.charged],
    ["allowed", p.allowed],
    ["contractual", p.contractual],
    ["payerPaid", p.payerPaid],
    ["patientResponsibility", p.patientResponsibility],
    ["coordination", p.coordination],
    ["recoverable", p.recoverable],
    ["informational", p.informational],
    ["unexplained", p.unexplained],
    ["overpayment", p.overpayment],
  ];

  for (const [name, value] of money) {
    if (!Number.isInteger(value)) {
      violations.push({ invariant: "I5", detail: `${name} is ${value}, which is not whole cents` });
    } else if (value < 0) {
      violations.push({ invariant: "I5", detail: `${name} is negative (${value})` });
    }
  }

  const allowedPlusContractual = addCents(p.allowed, p.contractual);
  if (allowedPlusContractual !== p.charged) {
    violations.push({
      invariant: "I1",
      detail: `charged ${p.charged} ≠ allowed ${p.allowed} + contractual ${p.contractual}`,
    });
  }

  if (p.unexplained > 0 && p.overpayment > 0) {
    violations.push({
      invariant: "I3",
      detail: `unexplained ${p.unexplained} and overpayment ${p.overpayment} cannot both be non-zero`,
    });
  }

  const gap = residual(p);
  const expectedUnexplained = gap > 0 ? gap : 0;
  const expectedOverpayment = gap < 0 ? -gap : 0;
  if (p.unexplained !== expectedUnexplained || p.overpayment !== expectedOverpayment) {
    violations.push({
      invariant: "I3",
      detail:
        `residual ${gap} implies unexplained ${expectedUnexplained} / overpayment ${expectedOverpayment}, ` +
        `but the partition carries ${p.unexplained} / ${p.overpayment}`,
    });
  }

  /**
   * Reconciled against `bucketTotal`, not `accountedFor`. See `bucketTotal` for why: checking
   * `accountedFor` against itself is satisfied by any membership list, including a wrong one.
   */
  const buckets = bucketTotal(p);
  const reconciled = subCents(addCents(buckets, p.unexplained), p.overpayment);
  if (reconciled !== p.charged) {
    violations.push({
      invariant: "I4",
      detail: `charged ${p.charged} ≠ buckets + unexplained − overpayment (${reconciled})`,
    });
  }
  if (buckets !== accountedFor(p)) {
    violations.push({
      invariant: "I4",
      detail:
        `accountedFor ${accountedFor(p)} omits or double-counts a bucket: the partition's fields ` +
        `total ${buckets}`,
    });
  }

  return violations;
}

/** True when a partition satisfies every law. */
export const partitionBalances = (p: MoneyPartition): boolean => checkPartition(p).length === 0;

/**
 * Which figure an incoming payment should be measured against.
 *
 * ── THE DEFECT THIS EXISTS TO FIX (L-1) ────────────────────────────────────────────────────────
 * Variance was always computed against the ESTIMATE recorded when the claim was filed. That is the
 * right baseline for a first adjudication and the wrong one for a corrected remittance settling an
 * appeal: the estimate predates the appeal and answers a different question. On the audited claim,
 * $1,125.00 measured against a $175.00 estimate scored +$950.00 and was classified OVERPAID, so
 * every successful recovery would have landed on the worklist as a suspected takeback.
 *
 * Once a payer has agreed an award and not yet paid it, the AWARD is the expectation. An exact
 * corrected remittance then varies by zero.
 *
 * Lives in shared rather than in either module because both halves need it and neither may import
 * the other: Denials computes the award, Remittance measures the payment.
 */
export function expectationFor(input: { expectedInsurancePays: Cents; awardOutstanding: Cents }): Cents {
  return input.awardOutstanding > 0 ? input.awardOutstanding : input.expectedInsurancePays;
}
