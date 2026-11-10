/**
 * Remittance bounded-context types.
 *
 * This module answers one question a clinic owner actually asks: **"the payment arrived — did we get
 * what we were promised, and if not, why?"** Everything here exists to make that answer precise
 * enough to act on.
 *
 * Money is integer cents. Union types only (no enums) so the sources run under Node's type-stripping.
 */
import type { AdjustmentCategory, Cents } from "@mermaid/shared";

/**
 * What a claim's payment turned out to be, relative to what the estimate promised.
 *
 *   as_expected — the payer paid what the inherited coverage snapshot said it would
 *   underpaid   — less arrived than expected
 *   overpaid    — more arrived than expected (rarer, and often a precursor to a takeback)
 *   denied      — nothing arrived
 */
export type VarianceOutcome = "as_expected" | "underpaid" | "overpaid" | "denied";

/**
 * What actually HAPPENED to the claim — as distinct from the arithmetic above.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `VarianceOutcome` ──────────────────────────────────────────
 * `outcome` answers "did the number match the estimate?". That is not the question a biller has.
 * Theirs is "was this claim paid correctly, and if not, whose problem is it?" — and the two answers
 * routinely disagree:
 *
 *   • A claim paying $0 because the whole allowed amount went to an unmet deductible has `outcome`
 *     "denied" and was in fact adjudicated perfectly. Treating it as a denial starts an appeal
 *     clock against a claim nobody denied.
 *   • A claim paying $47.99 against a $120.00 estimate has `outcome` "underpaid" and may owe the
 *     practice nothing at all, because the difference is the patient's exhausted benefit maximum.
 *
 * Conflating the two is what produced "the payer settled this claim in full" on a claim that was
 * $72.01 short of its estimate. The estimate was wrong; the payer was right; and neither fact is
 * expressible in a single field.
 *
 *   paid_correctly         — the payer paid what was expected. Nothing to do.
 *   patient_responsibility — the shortfall is legitimately the patient's. Bill them, not the payer.
 *   contractual            — the shortfall is a contracted write-off. Do nothing; it is not a leak.
 *   underpaid              — the payer withheld money that is recoverable or unexplained. Pursue it.
 *   denied                 — the payer paid nothing AND withheld for reasons that can be worked.
 *   overpaid               — more arrived than expected. Verify before spending; takebacks are common.
 */
export type Adjudication =
  | "paid_correctly"
  | "patient_responsibility"
  | "contractual"
  | "underpaid"
  | "denied"
  | "overpaid"
  /**
   * Part of this charge is another payer's question, and nobody has answered it yet (M8).
   *
   * Deliberately NOT any of the others. `paid_correctly` would settle the claim and stop anyone
   * looking; `patient_responsibility` would bill a person for money a secondary payer may owe;
   * `underpaid` would send staff to chase a payer that made no mistake. The honest answer is that
   * the claim is not finished, and the money is not yet anybody's.
   */
  | "coordination_pending";

/** One reason the payer gave for not paying part of a charge. */
export interface VarianceReason {
  group: string;
  code: string;
  description: string;
  category: AdjustmentCategory;
  amount: Cents;
  procedureCode: string | null;
}

/**
 * The estimate-vs-actual result. **This is the payoff of the whole architecture** — it is only
 * computable because the claim carried the verification's immutable coverage snapshot forward
 * (blueprint doc 00, doc 11).
 *
 * The three-way split of the shortfall is the product's core insight:
 *   • `contractualAdjustments` — the cost of doing business. Do not chase it.
 *   • `patientResponsibility`  — bill the patient, not the payer.
 *   • `recoverableAmount`      — money someone still owes us. THIS is the recovery queue.
 *   • `unexplainedAmount`      — money withheld with no reason code at all. The worst kind, because
 *                                nothing surfaces it except arithmetic.
 */
export interface Variance {
  expectedInsurancePays: Cents;
  actualPaid: Cents;
  /** `actualPaid - expectedInsurancePays`. Negative means underpaid. */
  variance: Cents;
  /** The arithmetic: did the number match the estimate? */
  outcome: VarianceOutcome;
  /**
   * Whether `variance` is large enough to mean anything (F-6).
   *
   * The exact figure is always kept; this says whether it crossed the materiality band. A surface
   * can then stay silent about a cent of rounding without any amount being rounded, and a report can
   * separate real shortfalls from drift rather than adding them together.
   */
  varianceMaterial: boolean;
  /** The band that decision used, so a number on a screen can explain itself. */
  varianceThreshold: Cents;
  /** The decision: was the claim paid correctly, and if not, whose problem is it? */
  adjudication: Adjudication;
  chargedAmount: Cents;
  contractualAdjustments: Cents;
  patientResponsibility: Cents;
  recoverableAmount: Cents;
  unexplainedAmount: Cents;
  /**
   * Money this payer assigned to ANOTHER payer's adjudication — the `OA` group, CARC 23 (M8).
   *
   * Reported as its own figure because it is the one amount on a remittance that belongs to nobody
   * yet. It is not a shortfall to chase, not a write-off, and above all not the patient's until a
   * human establishes what the other payer paid. It counts toward `accountedFor`, so it does not
   * inflate `unexplainedAmount` — the arithmetic still reconciles — but it is no longer invisible
   * while doing so, which is exactly what it used to be.
   */
  coordinationAmount: Cents;
  reasons: VarianceReason[];
  /** Plain-English sentences a human reads before deciding anything. */
  explanation: string[];
  /** True when there is genuinely something to pursue. */
  actionable: boolean;
}

/**
 * What the clinic was promised for one claim, recorded when `claim.submitted` arrived.
 *
 * A projection, not a copy of the claim: Remittance may not read Claims' tables
 * (docs/MODULE-BOUNDARIES.md), so it keeps its own ledger of expectations built purely from events.
 * Everything needed to compute variance later must be in here, because nothing else will be
 * available when the 835 lands weeks afterwards.
 */
export interface ClaimExpectation {
  claimId: string;
  verificationId: string;
  /** The clinic control number the payer will echo back in CLP01 — the match key. */
  patientControlNumber: string;
  payerId: string | null;
  payerName: string | null;
  /**
   * Who the claim was for. Carried so a payment can be attributed to a patient without asking
   * another module — the patient ledger charges this account for whatever the payer left them.
   */
  memberId: string;
  patientName: string;
  submittedAt: string;
  serviceDate: string;
  totalFee: Cents;
  expectedInsurancePays: Cents;
  /**
   * Money a payer AGREED to pay on appeal and has not yet sent (F-2 / L-1).
   *
   * A projection: Denials owns the awards, and a subscriber at the composition root pushes the
   * recomputed total here because this module may not read that one's tables. Held apart from
   * `expectedInsurancePays` and never added into it — the estimate is a historical record of what
   * was quoted and has to stay readable as that.
   *
   * When non-zero it becomes the expectation a posting is measured against. Comparing a corrected
   * remittance to the PRE-APPEAL estimate is what reported a $1,125.00 recovery against a $175.00
   * expectation as a $950.00 overpayment.
   */
  awardOutstanding: Cents;
}

/** The posting of one claim's payment. Immutable once written — corrections arrive as new postings. */
export interface Posting {
  id: string;
  remittanceId: string;
  postedAt: string;
  /** Null when the payer paid a claim we have no record of submitting (an unmatched payment). */
  claimId: string | null;
  patientControlNumber: string;
  payerControlNumber: string;
  patientName: string;
  chargedAmount: Cents;
  paidAmount: Cents;
  patientResponsibility: Cents;
  /** `forwarded` is CLP02 `19`/`20` — the payer passed this claim to another plan (M8). */
  disposition: "paid_full" | "partial" | "denied" | "reversal" | "forwarded" | "unknown";
  /** Null when the payment could not be matched to an expectation — there is nothing to compare to. */
  variance: Variance | null;
  adjustments: VarianceReason[];
  remarks: { code: string; description: string }[];
  /**
   * How much of this postings recoverable amount has since been RESOLVED — recovered in cash, or
   * otherwise closed out by the denial raised from it (F-5).
   *
   * Separate from the payers own figure, deliberately. `variance.recoverableAmount` records what
   * the payer withheld and must stay a faithful copy of the advice; this records what WE did about
   * it afterwards. The difference is what is still worth chasing:
   *
   *     still recoverable = variance.recoverableAmount - resolvedRecoverable
   *
   * Overwriting the payers figure instead would make the posting stop being the record it exists to
   * be, and would erase the evidence a human needs to understand a recovery months later.
   *
   * Optional: a posting written before this existed carries none, which reads as zero — exactly
   * what was true of every posting then.
   */
  resolvedRecoverable?: Cents;
  /**
   * NM1*TT on this claim in the payer's 835 — the plan it says it forwarded the claim to. Absent
   * when the payer named none (or the advice predates reading it): never inferred.
   */
  crossoverCarrier?: { name: string; idQualifier: string | null; id: string | null } | null;
}

export type RemittanceStatus =
  /** Received and parsed, but not posted — it did not balance, or a human has not released it. */
  | "held"
  /** Every claim payment posted. */
  | "posted"
  /**
   * A person decided this advice must never post, and said why — see `RemittanceRejection`.
   *
   * ── WHY A THIRD STATE, AND NOT DELETION ────────────────────────────────────────────────────────
   * A held advice had exactly one exit, release, which posts it. So a duplicate or a clearinghouse
   * test file — both of which the gate correctly holds — could only leave the held pile by being
   * posted, which is the one thing that must not happen to either. Found on staging: two copies of an
   * already-posted $799.99 sat held for weeks, the gate's own remediation text said "reject the
   * other", and there was no reject.
   *
   * Deleting the row would clear the pile and destroy the evidence: the payer DID send this file, and
   * a practice asked "did Cigna pay this claim twice?" must be able to see both advices and what was
   * decided about each. So the record, its raw 835 and its trace stay; only its standing changes.
   * Nothing downstream counts it — every money reading selects `posted`, and the held pile selects
   * `held`.
   */
  | "rejected";

/**
 * What a person decided about an advice that must not post.
 *
 * `kind` is what the advice turned out to BE, because the two have different follow-ups:
 *
 *   • `duplicate` — the payer's adjudication is already on the books (or on another advice), so this
 *     copy carries no money of its own. If the deposit shows the payer really did pay twice, that is
 *     an overpayment the payer will recoup — recorded against the ORIGINAL, never by posting this.
 *   • `test-file` — the sender marked the interchange as a test (ISA15 = T), or the practice has
 *     established it was not a real payment. There is no money behind it at all.
 */
export interface RemittanceRejection {
  kind: "duplicate" | "test-file";
  reason: string;
  rejectedBy: string;
  rejectedAt: string;
  /**
   * The trace of the advice this one duplicates, when the gate identified one. Absent when a person
   * established the duplicate by other means (the payer's portal, the bank deposit) — the reason
   * then carries the evidence, and inventing a twin here would be a claim nobody made.
   */
  duplicateOfTrace?: string;
}

/** A received remittance advice, with its postings. */
export interface Remittance {
  id: string;
  /**
   * The check or EFT trace number, exactly as the payer stated it — including empty, which the
   * safety gate BLOCKS on. This is what a human reads and quotes back to the payer.
   */
  traceNumber: string;
  /**
   * **The idempotency key** — one dedupe key posts exactly once, enforced by a unique constraint.
   *
   * Equal to `traceNumber` whenever the payer gave one. When they did not, the service derives one
   * from the raw 835 and the advice's own money (`dedupeKeyFor`): two trace-less remittances are
   * different payments and must not collide — even when they arrived in the SAME file — while that
   * same file redelivered is one payment and must not post twice.
   * Kept separate from `traceNumber` so that deriving a key can never make a trace-less advice look
   * like it has a trace number and slip past the gate that holds it.
   */
  dedupeKey: string;
  receivedAt: string;
  status: RemittanceStatus;
  payerName: string;
  payeeName: string;
  paymentTotal: Cents;
  paymentMethod: string;
  paymentDate: string;
  balanced: boolean;
  /** Balance failures a human must reconcile before this can post. */
  issues: string[];
  /** Why a balanced remittance is nonetheless being held, when applicable. */
  holdReason: string | null;
  postings: Posting[];
  /**
   * PLB provider-level adjustments, carried verbatim from the advice.
   *
   * Structurally identical to `ProviderAdjustment` in `@mermaid/edi` and deliberately restated
   * rather than imported: this is the persisted aggregate's shape, and it must be free to stop
   * matching the wire type without a compile error somewhere else forcing the wire type to follow.
   * `REMITTANCE_RECORD_VERSION` 2 upcasts documents written before `reasonCode`/`referenceId`.
   */
  providerAdjustments: {
    providerId: string;
    /** PLB03 verbatim. */
    reason: string;
    /** PLB03-1 — the adjustment reason code. */
    reasonCode: string;
    /** PLB03-2 — normally the recouped claim's control number. Null when the payer named nothing. */
    referenceId: string | null;
    amount: Cents;
  }[];
  /** Raw 835 for provenance; stored encrypted at rest, never logged. */
  raw835?: string | null;
  /**
   * ISA15 of the interchange this advice arrived in (record v3). `T` test, `P` production, `null`
   * when the envelope did not say, or the advice predates the field. Only an explicit `T` is ever
   * treated as a test file — an unknown is not evidence either way.
   */
  usageIndicator?: "T" | "P" | null;
  /** Present exactly when `status` is `rejected` (record v3). */
  rejection?: RemittanceRejection;
  audit: RemittanceAuditEvent[];
}

export interface RemittanceAuditEvent {
  timestamp: string;
  actor: "system" | "staff";
  message: string;
}
