/**
 * The domain-event catalog — the typed contract between bounded contexts.
 *
 * This file IS the module-boundary rule made checkable by the compiler. A module never imports a
 * sibling (docs/MODULE-BOUNDARIES.md); it publishes an event from this catalog, and a sibling
 * subscribes. Because the payload types live here (in platform, which every module may import) and
 * reference only `@mermaid/shared` types, two modules can agree on shape without ever coupling.
 *
 * Catalog source: platform/events/README.md, roadmap §5. Events land here as the producing module
 * ships — declaring an event with no producer would be fiction, so the union grows per milestone.
 *
 * Every payload is VERSIONED (`snapshot_version`). An event may be persisted in `domain_events` for
 * months before a replay reads it back; an unversioned payload is a silent schema-drift bug waiting
 * to happen (blueprint doc 16 R5, packages/shared/src/snapshot.ts).
 */
import type {
  Cents,
  CoverageSnapshot,
  Snapshot,
  SubscriberIdentity,
  SubscriberRelationship,
} from "@mermaid/shared";

/** Current payload schema version for events defined in this file. */
export const EVENT_PAYLOAD_VERSION = 1;

// ── Payload bodies ────────────────────────────────────────────────────────────────────

/** Patient identity as it crosses a module boundary — the minimum billing needs. */
export interface EventPatient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  memberId: string;
  /**
   * 837D loop 2010BA N3/N4 + DMG03. Absent when nobody has collected it — the claim scrubber blocks
   * filing rather than inventing an address, because an address on a claim is a statement to the
   * payer about where a patient lives.
   */
  address?: { street: string; city: string; state: string; zip: string };
  gender?: "M" | "F" | "U";
  /**
   * What this patient is to the policy `memberId` names — absent means `self` (NEW-01).
   *
   * A member ID identifies a POLICY, and a dental family shares the subscriber's. Without this
   * crossing the boundary, billing has no way to know the person it is filing for is a child rather
   * than the policy holder, and every dependent's claim names the wrong person in loop 2010BA.
   *
   * Absent means `self`, which is what makes every event persisted before dependents existed read
   * correctly on replay — they were subscribers, and that is what they will say.
   */
  relationship?: SubscriberRelationship;
  /** Who holds the policy, when it is not this patient. Present whenever `relationship` is not `self`. */
  subscriber?: SubscriberIdentity;
}

/**
 * `verification.completed` — a verification reached a trustworthy, settled state.
 *
 * Producer: Verification. Consumers: Claims (builds the claim), Analytics.
 * Carries the immutable coverage snapshot: this event is the ONLY way the estimate reaches billing.
 */
export interface VerificationCompletedBody {
  verificationId: string;
  completedAt: string;
  /** "verified" = cleared automatically; "reviewed" = a human settled it (HITL). */
  settledAs: "verified" | "reviewed";
  patient: EventPatient;
  /** The frozen estimate the claim inherits. */
  coverageSnapshot: CoverageSnapshot;
  /** Total the patient was quoted — denormalized so Analytics needn't unpack the snapshot. */
  patientResponsibility: Cents;
  totalFee: Cents;
}

/**
 * `verification.needs_review` — a verification could not clear the confidence/exception gate.
 *
 * Producer: Verification. Consumer: the Today queue. Deliberately carries NO snapshot: an
 * unreviewed estimate must never reach billing.
 */
export interface VerificationNeedsReviewBody {
  verificationId: string;
  raisedAt: string;
  patientName: string;
  confidence: number;
  reasons: string[];
  priority: number;
}

/**
 * `claim.submitted` — a human released a scrubbed claim to the clearinghouse.
 *
 * Producer: Claims. Consumers: Remittance (expects a matching 835), Analytics.
 */
export interface ClaimSubmittedBody {
  claimId: string;
  verificationId: string;
  submittedAt: string;
  submittedBy: string;
  /**
   * Who this claim is for.
   *
   * Patient identity travels WITH THE MONEY, from here all the way to the patient ledger. Without
   * it, every downstream context has to either re-derive identity from a control number or ask a
   * human to retype it — which is exactly what the appeal-draft screen was doing, sending the payer
   * letters with `[member ID]` where the member ID should be.
   */
  patient: EventPatient;
  payerId: string | null;
  payerName: string | null;
  /**
   * The CLINIC's control number (837 CLM01). **This is the key a payment is matched on** — it is
   * what the payer echoes back in the 835's CLP01. Distinct from `payerControlNumber`, and the two
   * must never be confused: matching on the payer's number would silently fail to tie any payment
   * to any claim.
   */
  patientControlNumber: string;
  /** The payer/clearinghouse control number, for quoting in follow-ups. */
  payerControlNumber: string;
  totalFee: Cents;
  /** What the inherited snapshot expects insurance to pay — the baseline for variance detection. */
  expectedInsurancePays: Cents;
  serviceDate: string;
}

/**
 * `claim.filing_risk` — a claim is approaching (or past) its timely-filing deadline.
 *
 * Producer: Claims. Consumer: the Today queue. Unfiled claims silently expiring is one of the
 * highest-value failure modes in the revenue cycle, so it is a first-class event, not a report.
 */
export interface ClaimFilingRiskBody {
  claimId: string;
  verificationId: string;
  raisedAt: string;
  filingDeadline: string;
  daysRemaining: number;
  risk: "approaching" | "urgent" | "expired";
  amountAtRisk: Cents;
  payerName: string | null;
}

/**
 * `claim.went_silent` — a filed claim got no answer, and is therefore in nobody's queue (F4).
 *
 * Producer: Claims. Consumer: the Today queue.
 *
 * ── WHY THIS IS NOT `claim.filing_risk` ──────────────────────────────────────────────────────
 * `claim.filing_risk` is raised by a sweep over `OPEN_STATUSES`, and `submitted` is not one of
 * them — a filed claim is with the payer, and there is nothing for the clinic to do. That holds
 * for exactly as long as the payer answers. When it does not, `submitted` becomes the one status
 * where doing nothing costs the whole claim and the one status no sweep looks at.
 *
 * So this carries what that event cannot: how long the silence has lasted, and WHICH KIND it is.
 *
 * ── WHY THE CATEGORY TRAVELS ─────────────────────────────────────────────────────────────────
 * Because the three remedies are mutually destructive. Refiling an `unacknowledged` claim is
 * correct and refiling a `stalled` one manufactures the duplicate denial the replacement gate
 * exists to prevent. A consumer handed only "this claim is silent" has a coin flip between them.
 *
 * `rejected-not-refiled` is the one most easily mistaken for a denial, and it is not one: the
 * payer refused at intake, the claim never reached adjudication, there is nothing to appeal, and
 * the timely-filing clock never stopped because the payer does not count the filing as having
 * happened.
 */
export interface ClaimWentSilentBody {
  claimId: string;
  verificationId: string;
  raisedAt: string;
  category: "unacknowledged" | "stalled" | "rejected-not-refiled";
  /** Calendar days since filing, or since the rejection was recorded. */
  daysSilent: number;
  /**
   * The timely-filing picture at the moment of escalation — the reason this is urgent rather than
   * merely true. A silent claim with eight months left is a phone call; the same claim with nine
   * days left is money about to stop existing.
   */
  filingDeadline: string;
  daysRemaining: number;
  risk: "safe" | "approaching" | "urgent" | "expired";
  amountAtRisk: Cents;
  payerName: string | null;
  /**
   * The control number the payer acknowledged, when one exists.
   *
   * Empty for an `unacknowledged` claim, and that emptiness IS the finding — an acknowledgement
   * that names nothing is not evidence the claim reached anybody. For a `stalled` claim it is the
   * single most useful thing on this payload, because it is what a biller quotes on the phone.
   */
  controlNumber: string;
  /** What to do, and why it differs per category. Written by the engine that made the judgement. */
  action: string;
}

/**
 * `remittance.posted` — a payer's payment was posted against a claim.
 *
 * Producer: Remittance. Consumers: Claims (closes the claim), Analytics.
 * Carries the variance because the comparison is only meaningful where both halves are known, and
 * that is inside Remittance — Claims knows what was promised, the 835 knows what arrived.
 */
export interface RemittancePostedBody {
  remittanceId: string;
  postingId: string;
  claimId: string;
  /** The clinic control number the payer echoed back (CLP01) — how the claim was matched. */
  patientControlNumber: string;
  postedAt: string;
  traceNumber: string;
  /**
   * The clearinghouse payer SLUG, from the expectation the claim recorded when it was filed.
   *
   * Present because payer identity is a slug everywhere in this system, and a consumer that has to
   * fall back to `payerName` will not group this event with `claim.submitted` — which is exactly the
   * bug that split every row of the payer scorecard in two and made days-to-pay permanently null.
   * Null only when the payment could not be tied to a claim we recorded filing.
   */
  payerId: string | null;
  payerName: string;
  /** Who the payment was for — the patient ledger charges `patientResponsibility` to this account. */
  patientName: string;
  /** The member ID the claim was filed under. Null for a payment we cannot tie to a filed claim. */
  memberId: string | null;
  paymentDate: string;
  chargedAmount: Cents;
  paidAmount: Cents;
  /** What the payer says the patient owes. Becomes a charge on the patient's account. */
  patientResponsibility: Cents;
  /** Contractual write-offs — expected, not a leak. */
  contractualAdjustments: Cents;
  /**
   * Money this payer assigned to ANOTHER payer's adjudication — `OA` / CARC 23 (M8).
   *
   * Carried so the patient ledger can refuse to bill a balance that is under coordination. The
   * remittance safety gate already HOLDS such an advice, so this only ever travels on one a human
   * released — and releasing the remittance is not the same decision as deciding the patient owes
   * the money. Optional because it is additive: an event published before this field existed
   * carries none, and the ledger reads its absence as zero, i.e. exactly the old behaviour.
   */
  coordinationAmount?: Cents;
  /**
   * True when the payer FORWARDED this claim to another plan (CLP02 `19`/`20`) — it is not an
   * adjudication outcome, and the balance on it is not safely the patient's.
   */
  forwardedToOtherPayer?: boolean;
  /**
   * CLP02, normalised — what the payer said this advice DOES to the claim.
   *
   * Carried because a consumer cannot otherwise tell a payment that RE-ADJUDICATED the claim from
   * one that merely sent money. A supplemental cheque settling an appeal states
   * `patientResponsibility: 0` while re-adjudicating nothing, and a ledger that reads it as "the
   * payer lowered the patient's share to zero" credits away a balance still genuinely owed. That is
   * not hypothetical: it happened on staging, for $136.01, the first time an appeal settled.
   *
   * Optional and additive — an event published before this existed carries none, and a consumer
   * reading its absence must take the conservative branch rather than assume adjudication.
   */
  disposition?: "paid_full" | "partial" | "denied" | "reversal" | "forwarded" | "unknown";
  /**
   * Whether this advice RESTATES what the patient owes, as opposed to being silent about them.
   *
   * True when the payer adjudicated the claim AND said something about the patient's share — a
   * `PR`-group CAS adjustment, or a non-zero patient figure. False for a supplemental payment that
   * moves money to the practice and mentions the patient nowhere.
   *
   * Stated here rather than left for each consumer to infer, because the adjustments this is
   * derived from live in Remittance and do not travel on the event. CLP02 alone cannot answer it:
   * the settlement that forgave a real $136.01 on staging arrived as an ordinary `partial`.
   *
   * Absent on events published before this existed. A consumer must then treat a DECREASE as
   * un-inferable and leave the balance standing.
   */
  restatesPatientResponsibility?: boolean;
  /**
   * The procedure codes this advice referenced, when it carried service-line detail.
   *
   * Present so a corrected remittance can be attributed to the APPEAL AWARD it settles: a denial is
   * identified by its procedure code within a claim, and an 835 has no field for an appeal
   * reference. Optional and additive — an advice with no line detail carries none, and the consumer
   * then falls back to "the only open award on this claim" or refuses to guess.
   */
  procedureCodes?: string[];
  /** What the claim's inherited coverage snapshot said insurance would pay. */
  expectedInsurancePays: Cents;
  /** `paidAmount - expectedInsurancePays`. Negative means underpaid. */
  variance: Cents;
  outcome: "as_expected" | "underpaid" | "overpaid" | "denied";
  /** True when the claim is fully settled (nothing further expected from this payer). */
  settled: boolean;
}

/**
 * `variance.detected` — the payer withheld money for a reason that can be pursued.
 *
 * Producer: Remittance. Consumers: Denials & Appeals, the Today queue, Analytics.
 *
 * Raised ONLY for genuinely recoverable shortfalls. A contractual write-off is not news, and a
 * balance the patient owes is not a denial — flooding the recovery queue with either would teach
 * staff to ignore it.
 */
export interface VarianceDetectedBody {
  claimId: string;
  remittanceId: string;
  postingId: string;
  detectedAt: string;
  payerId: string | null;
  payerName: string;
  /** Carried because an appeal letter names the patient, and Denials cannot read another context. */
  patientName: string;
  /**
   * The three facts an appeal letter to a payer is worthless without, carried for the same reason as
   * the name. Before these existed the UI passed empty strings and letters went out reading
   * "Claim [claim number] … Member ID: [member ID]".
   */
  memberId: string | null;
  claimControlNumber: string;
  serviceDate: string;
  /**
   * The payer's own determination date — BPR16 on the 835 that carried this decision.
   *
   * ── WHY AN APPEAL WINDOW CANNOT BE COUNTED FROM `detectedAt` ─────────────────────────────────
   * `detectedAt` is when Mermaid noticed, and that is a fact about this software rather than about
   * the payer. An appeal window runs from the payer's determination, so anchoring it to detection
   * makes every deadline exactly as generous as the ingest was late — a batch polled a fortnight
   * after the cheque, an ERA a practice uploads at month end, or a backlog after an outage each
   * silently extend a deadline a biller then works to.
   *
   * Optional because it is additive: an event published before this field existed carries none, and
   * `DenialService` falls back to `detectedAt` while saying in the audit trail that it did.
   */
  paymentDate?: string;
  /** What could actually be recovered by correcting or appealing. */
  recoverableAmount: Cents;
  /** Money the payer withheld with no reason code at all — the most serious kind. */
  unexplainedAmount: Cents;
  /** The reason codes behind the recoverable amount, for triage. */
  reasons: { group: string; code: string; description: string; amount: Cents; procedureCode: string | null }[];
  /** Plain-English summary a human reads first. */
  summary: string;
}

/**
 * `denial.created` — a payer's refusal has been triaged into a piece of recoverable work.
 *
 * Producer: Denials & Appeals. Consumers: the Today queue, Analytics.
 * One event per denied REASON, not per claim: two codes on one claim are two different jobs.
 */
export interface DenialCreatedBody {
  denialId: string;
  claimId: string;
  remittanceId: string;
  detectedAt: string;
  payerId: string | null;
  payerName: string;
  carcCode: string;
  carcDescription: string;
  procedureCode: string | null;
  deniedAmount: Cents;
  /** What the playbook says to do: appeal, correct and resubmit, write off, bill the patient. */
  disposition: string;
  /** Probability of recovery at triage time, frozen. */
  overturnRate: number;
  /** `deniedAmount × overturnRate` — what ranking is actually based on. */
  expectedRecovery: Cents;
  priority: number;
  appealDeadline: string | null;
}

/**
 * `appeal.outcome.recorded` — **the event the whole product thesis turns on.**
 *
 * Producer: Denials & Appeals. Consumers: Payer Profile (updates the overturn rate), Analytics,
 * and — through the sharpened rate — Verification's confidence.
 *
 * This is the only place real-world evidence enters the system. Everything upstream is deterministic
 * calculation; this is the feedback that makes the next triage better than the last (blueprint
 * doc 11).
 */
export interface AppealOutcomeRecordedBody {
  /**
   * The clinic control number of the claim this denial sits on.
   *
   * Carried so a consumer can reach the claim's EXPECTATION, which is keyed by control number and
   * not by claim id. Optional and additive: an event published before awards existed has none, and
   * a consumer reading its absence simply has nothing to sync.
   */
  claimControlNumber?: string;
  denialId: string;
  appealId: string;
  claimId: string;
  recordedAt: string;
  recordedBy: string;
  payerId: string | null;
  payerName: string;
  carcCode: string;
  procedureCode: string | null;
  level: number;
  won: boolean;
  deniedAmount: Cents;
  recoveredAmount: Cents;
}

/**
 * `denial.closed` — a human decided this money will not be pursued from the payer.
 *
 * Producer: Denials & Appeals. Consumers: the patient ledger (when the decision was "the patient
 * owes this"), Analytics.
 *
 * This event exists because closing a denial as `patient_billed` used to be the end of the money's
 * story: the denial went grey and the amount was never charged to anyone. A disposition that names a
 * payer is only half a decision — the other half is where the money went instead.
 */
export interface DenialClosedBody {
  denialId: string;
  claimId: string;
  closedAt: string;
  closedBy: string;
  /** `written_off` = the practice absorbed it; `patient_billed` = it moves to the patient. */
  closedAs: "written_off" | "patient_billed";
  reason: string;
  payerId: string | null;
  payerName: string;
  carcCode: string;
  patientName: string;
  memberId: string | null;
  deniedAmount: Cents;
}

/**
 * `patient.charged` — money moved onto a patient's account.
 *
 * Producer: Patient Ledger. Consumer: Analytics.
 *
 * Deliberately published even though the ledger could report on itself: a practice's collection rate
 * is only honest when it counts BOTH halves of every dollar, and Analytics must not read another
 * module's tables to get the patient half.
 */
/**
 * `denial.recovery.settled` — how much of a denial has stopped being pursuable (F-5).
 *
 * Producer: Denials & Appeals. Consumer: Remittance.
 *
 * Published whenever an award settlement changes, including back to zero on a reversal. Carries the
 * POSTING the denial was raised from, because that is the row still advertising the money, and the
 * TOTAL resolved rather than a delta, so a redelivery converges instead of accumulating.
 *
 * Exists because the two modules may not read each other. Denials knows an award settled; only
 * Remittance can act on the posting; the composition root joins them.
 */
export interface DenialRecoverySettledBody {
  denialId: string;
  claimId: string;
  /** The posting whose recoverable amount this denial was raised from. */
  postingId: string;
  /** Total no longer pursuable on that posting. An assignment, never a delta. */
  resolvedAmount: Cents;
  /** What the payer agreed to on appeal, for the audit trail. */
  awardedAmount: Cents;
  /** How much of it has actually arrived as cash. */
  settledAmount: Cents;
  status: string;
  settledAt: string;
}

/**
 * `remittance.allowed_amounts_observed` — what a payer said its contracted rate is (F-1).
 *
 * Producer: Remittance. Consumer: the payer profile.
 *
 * An 835 service line carries the charge and its CAS adjustments, and group CO — "contractual
 * obligation" — is by definition the portion a contracted provider may not bill the patient. So
 * `allowed = charge − CO` is the payer's own arithmetic read back, not an assumption about anyone's
 * contract, and it is the figure the estimate should be quoting from instead of the billed fee.
 *
 * Only CO-derived observations are published. An out-of-network payer reduces a charge under OA or
 * PR and that money is often the patient's; learning a "contracted rate" from those groups would
 * teach the estimate that an out-of-network patient owes less than they do.
 *
 * A separate event rather than a field on `remittance.posted`: this is an observation about a
 * PAYER, not about the money on a claim, and it is consumed by something that does not care about
 * either. Carrying it on the posting event would put fee-schedule learning inside the payload every
 * claim, ledger and analytics subscriber already reads.
 */
export interface AllowedAmountsObservedBody {
  remittanceId: string;
  payerId: string;
  payerName: string | null;
  observedAt: string;
  /** One entry per service line that stated a contracted reduction. May be empty — see below. */
  lines: {
    cdtCode: string;
    /** What the practice billed for this line. */
    charged: Cents;
    /** `charged − CO`, strictly between zero and `charged`. */
    allowed: Cents;
  }[];
  /**
   * Codes this advice adjudicated with NO contractual reduction at all (0028).
   *
   * Evidence AGAINST a rate still being live, and it has to travel because its absence is what went
   * wrong: a practice that leaves a payer's network keeps being paid at full price, nothing is
   * learned from those lines, and nothing unlearns the stale rate either — so estimates go on
   * quoting a discount the payer no longer gives.
   *
   * Carried separately from `lines` because it is the opposite kind of fact. A consumer that treated
   * them alike would try to learn a rate of "the full fee", which is precisely the reading
   * `allowedFromLine` refuses.
   */
  fullPriceCodes: string[];
}

/**
 * `remittance.statutory_clock_observed` — the dates two statutes run on (F5).
 *
 * Producer: Remittance. Consumer: the statutory clock, which is the only thing that cares.
 *
 * ── WHY A NEW EVENT RATHER THAN FIELDS ON `remittance.posted` ─────────────────────────────────
 * `remittance.posted` is taken by Claims, the patient ledger and Analytics, and it is per POSTING.
 * The clock needs two things that payload structurally cannot carry: the date the claim was FILED
 * (which lives on the expectation, not the posting) and the advice's PROVIDER-LEVEL adjustments,
 * which belong to the whole file rather than to any one claim. Widening a payload three consumers
 * already depend on, to carry a fourth consumer's inputs, is how an event becomes a shared mutable
 * record. This follows the precedent set by `remittance.allowed_amounts_observed`: an observation
 * about a different question gets its own event.
 *
 * ── WHAT THE TWO CLOCKS ARE ────────────────────────────────────────────────────────────────────
 * PROMPT PAY: a payer that takes longer than its state allows to pay a CLEAN claim owes simple
 * interest. Nothing in a remittance says so — the obligation exists only as the difference between
 * two dates, one of which is not on the advice.
 *
 * RECOUPMENT: a payer may only claw a payment back for so long. A PLB `WO` after the window has
 * closed is money the practice can demand back, and today it is deducted and reconciled in silence.
 *
 * ── WHY THE RAW CODES TRAVEL ───────────────────────────────────────────────────────────────────
 * `adjustments` carries group and code UNFILTERED, for the same reason `allowedFromLine` takes
 * them raw: which codes mean a claim was never clean is the clock's rule to apply, and a rule
 * applied in the producer is a rule no test of the consumer can reach.
 */
export interface StatutoryClockObservedBody {
  remittanceId: string;
  /** The remittance's idempotency key, carried as provenance — one payment posts once. */
  dedupeKey: string;
  payerName: string;
  observedAt: string;
  /** BPR16 — the payer's own payment date, which is the date both statutes count to. */
  paymentDate: string;
  /** One entry per claim on the advice that this practice recorded filing. */
  claims: {
    patientControlNumber: string;
    claimId: string | null;
    /** The payer SLUG from the claim's own expectation. */
    payerId: string | null;
    /**
     * When the claim was FILED — the fact that makes a prompt-pay clock computable and that exists
     * nowhere on an 835. Read from the expectation this practice recorded when it submitted.
     */
    submittedAt: string;
    chargedAmount: Cents;
    paidAmount: Cents;
    disposition: string;
    /** CAS group/code pairs verbatim, all groups, unfiltered. */
    adjustments: { group: string; code: string }[];
  }[];
  /**
   * PLB provider-level adjustments, verbatim.
   *
   * Carried whole rather than filtered to `WO` because the distinction between a recoupment and a
   * forwarding balance decides whether a biller is sent to dispute money that is simply arriving
   * later, and that judgement belongs where it can be tested.
   */
  providerAdjustments: { reasonCode: string; referenceId: string | null; amount: Cents }[];
  /**
   * True when the advice paid interest at the provider level (PLB `L6`).
   *
   * The suppressor. Demanding interest a payer has already paid is the single most embarrassing
   * thing this feature could do, and the evidence that it did sits in a segment the claim loop
   * never sees.
   */
  interestPaidAtProviderLevel: boolean;
}

/**
 * `remittance.payment_method_observed` — a payer paid by something other than ACH (F1).
 *
 * Producer: Remittance. Consumer: none yet — this is the record that makes the leak countable
 * before anything acts on it.
 *
 * ── WHAT THE OBSERVATION IS ABOUT ──────────────────────────────────────────────────────────────
 * Not the money on the claims. A payer reimbursing by virtual credit card hands the practice a card
 * number to run through a terminal, and the merchant fee — commonly 2.5–3.5% — is taken from money
 * already earned and already discounted to a contracted rate. The remittance balances, the claims
 * post, and the cost appears only in a merchant statement nobody reconciles against an 835. So this
 * is an observation about the PAYMENT CHANNEL, which is why it is its own event rather than a field
 * on `remittance.posted`: the subscribers to that payload care about claims, and none of them care
 * about this.
 *
 * ── WHY ONLY NON-ACH IS PUBLISHED ──────────────────────────────────────────────────────────────
 * An event per ACH remittance would be an event on almost every remittance, saying that nothing
 * happened. `remittance.allowed_amounts_observed` already set this precedent — it "publishes nothing
 * when there is nothing to say" — and the reversion case does not need it: the previous method is
 * read from the remittances table, which records one for every payment whether or not it was worth
 * an event.
 *
 * ── NO PAYMENT, NO OBSERVATION ─────────────────────────────────────────────────────────────────
 * A zero-dollar advice (a denial-only file) and a negative one (a reversal) never appear here. Both
 * legitimately carry a non-ACH method code while moving no money there was a fee to receive, and
 * publishing them would bury the real findings under every denial a practice gets.
 */
export interface PaymentMethodObservedBody {
  remittanceId: string;
  /**
   * The remittance's idempotency key, carried as PROVENANCE.
   *
   * One payment posts once (`remittances_one_per_dedupe_key`), so one payment produces at most one
   * of these. A consumer that sees the same key twice is looking at a redelivery, not a second fee.
   */
  dedupeKey: string;
  /** The payer as it named itself on the advice — who an EFT enrolment would be filed with. */
  payerName: string;
  observedAt: string;
  /** BPR04 exactly as printed, normalised to upper case. Empty when the payer stated none. */
  method: string;
  paymentTotal: Cents;
  /**
   * What receiving this cost, or `null` when the practice's merchant discount rate is unknown.
   *
   * Never estimated. A plausible 3% is indistinguishable on a screen from a measured one, and a
   * practice cannot negotiate with a payer using a figure this system invented.
   */
  feeCents: Cents | null;
  /**
   * This payer paid by ACH before and has stopped — the documented re-enrolment pattern, where a
   * fresh card product months after an opt-out re-enrols anyone who simply processes it.
   */
  reverted: boolean;
  /** What this payer used last time, or null when this is the first payment seen from them. */
  priorMethod: string | null;
}

export interface PatientChargedBody {
  entryId: string;
  patientKey: string;
  patientName: string;
  claimId: string | null;
  denialId: string | null;
  occurredAt: string;
  amount: Cents;
  reason: string;
}

/**
 * `patient.payment.recorded` — a patient paid, or a balance was forgiven.
 *
 * Producer: Patient Ledger. Consumer: Analytics. Always attributable to a named person: money
 * leaving a patient's balance without one is how a practice loses money quietly.
 */
export interface PatientPaymentRecordedBody {
  entryId: string;
  patientKey: string;
  patientName: string;
  occurredAt: string;
  recordedBy: string;
  /** `payment` = the patient paid; `adjustment`/`writeoff` = the practice gave it up. */
  kind: "payment" | "adjustment" | "writeoff";
  /** Positive cents — the amount by which the balance fell. */
  amount: Cents;
  /** What the patient still owes after this. */
  balanceAfter: Cents;
}

// ── The typed union ───────────────────────────────────────────────────────────────────

/** Map of event type → payload body. Adding an event = adding one line here. */
export interface DomainEventMap {
  "verification.completed": VerificationCompletedBody;
  "verification.needs_review": VerificationNeedsReviewBody;
  "claim.submitted": ClaimSubmittedBody;
  "claim.filing_risk": ClaimFilingRiskBody;
  "claim.went_silent": ClaimWentSilentBody;
  "remittance.posted": RemittancePostedBody;
  "variance.detected": VarianceDetectedBody;
  "denial.created": DenialCreatedBody;
  "denial.closed": DenialClosedBody;
  "denial.recovery.settled": DenialRecoverySettledBody;
  "appeal.outcome.recorded": AppealOutcomeRecordedBody;
  "remittance.allowed_amounts_observed": AllowedAmountsObservedBody;
  "remittance.payment_method_observed": PaymentMethodObservedBody;
  "remittance.statutory_clock_observed": StatutoryClockObservedBody;
  "patient.charged": PatientChargedBody;
  "patient.payment.recorded": PatientPaymentRecordedBody;
}

export type DomainEventType = keyof DomainEventMap;

/** The persisted payload for an event type — always versioned. */
export type PayloadFor<T extends DomainEventType> = Snapshot<DomainEventMap[T]>;

/** Runtime list of known event types (for validation at the edge and for the outbox's metrics). */
/**
 * Every event type, derived from the map rather than restated beside it.
 *
 * This was a hand-maintained array, and it had already drifted: `denial.recovery.settled` was
 * published in production and absent from the list, so `isDomainEventType` — a guard whose own test
 * says it "guards the catalog at the edge" — would have REFUSED a legitimate event the moment
 * anyone wired it to an actual edge. A list that must be remembered is a list that will be wrong,
 * and the failure mode is silent until the day it is load-bearing.
 *
 * `Record<DomainEventType, true>` makes omission a COMPILE error instead. Adding a member to
 * `DomainEventMap` without adding it here now fails the build, which is the only kind of
 * exhaustiveness that survives contact with a growing system.
 */
const ALL_DOMAIN_EVENT_TYPES: Record<DomainEventType, true> = {
  "verification.completed": true,
  "verification.needs_review": true,
  "claim.submitted": true,
  "claim.filing_risk": true,
  "claim.went_silent": true,
  "remittance.posted": true,
  "remittance.allowed_amounts_observed": true,
  "remittance.payment_method_observed": true,
  "remittance.statutory_clock_observed": true,
  "variance.detected": true,
  "denial.created": true,
  "denial.closed": true,
  "denial.recovery.settled": true,
  "appeal.outcome.recorded": true,
  "patient.charged": true,
  "patient.payment.recorded": true,
};

export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] =
  Object.keys(ALL_DOMAIN_EVENT_TYPES) as DomainEventType[];

export const isDomainEventType = (value: unknown): value is DomainEventType =>
  typeof value === "string" && (DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
