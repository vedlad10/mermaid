/**
 * Claims bounded-context types.
 *
 * A claim is not a new estimate — it is the BILLING FORM of one that already exists. Every money
 * figure in here traces to the inherited `coverageSnapshot` (blueprint doc 00 keystone), never to a
 * fresh calculation. That is what makes estimate-vs-actual reconciliation meaningful once the
 * remittance lands: the expectation on the claim is literally the number the patient was quoted.
 *
 * Union types only (no enums) so the sources run under Node's type-stripping.
 */
import type {
  Cents,
  CoverageSnapshot,
  LineCategory,
  PayerWindowSource,
  SubscriberIdentity,
  SubscriberRelationship,
} from "@mermaid/shared";
import type { SilenceEscalation } from "./engine/watchdog.ts";

/**
 * Claim lifecycle.
 *
 *   draft          → built from a verification, not yet scrubbed clean
 *   ready          → scrubbed with no blocking errors; awaiting the human submit gate
 *   submitted      → released to the clearinghouse, acknowledged as received
 *   rejected       → the payer refused it AT INTAKE, before adjudication; fix and resubmit
 *   partially_paid → adjudicated and paid, but recoverable money is still outstanding
 *   denied         → adjudicated and paid nothing; correct, appeal, or write off
 *   paid           → fully settled; nothing further is expected from this payer
 *   void           → withdrawn by the clinic; never resubmitted under this id
 *
 * `rejected` and `denied` look similar and are not: a rejection never reached adjudication (no
 * reason codes, no appeal rights, just fix the file and resend), while a denial is the payer's
 * considered decision (CARC codes, appeal rights, a deadline). Collapsing them would send staff
 * appealing typos and re-keying genuine denials.
 *
 * The three post-adjudication states are set by the Remittance module via `remittance.posted` —
 * this module never decides on its own that money arrived.
 */
export type ClaimStatus =
  | "draft"
  | "ready"
  | "submitted"
  | "rejected"
  | "partially_paid"
  | "denied"
  | "paid"
  | "void";

/**
 * Every status, at runtime, in lifecycle order.
 *
 * The union above is erased at runtime, so anything that needs to enumerate statuses — a filter
 * contract test, an admin screen, a migration check — otherwise hand-copies the list, and a
 * hand-copied list is precisely what drifted between the two claim repositories at M10.
 *
 * `_EveryStatusListed` is a compile-time proof that this array is COMPLETE: adding a member to
 * `ClaimStatus` without adding it here makes the type resolve to `never` and fails the typecheck.
 * `satisfies` alone would only prove every entry is valid, not that none is missing.
 */
export const CLAIM_STATUSES = [
  "draft",
  "ready",
  "submitted",
  "rejected",
  "partially_paid",
  "denied",
  "paid",
  "void",
] as const satisfies readonly ClaimStatus[];

type _EveryStatusListed = Exclude<ClaimStatus, (typeof CLAIM_STATUSES)[number]> extends never ? true : never;
const _everyStatusListed: _EveryStatusListed = true;
void _everyStatusListed;

/** Statuses from which no further work is expected. */
export const TERMINAL_STATUSES: readonly ClaimStatus[] = ["paid", "void"];

/** How close a claim is to its timely-filing deadline. Policy lives in `engine/deadline.ts`. */
export type FilingRisk = "safe" | "approaching" | "urgent" | "expired";

/**
 * What the watchdog has already said about a claim (F4). Defined in the engine beside the rule
 * that produces it; re-exported through the aggregate here because it is persisted on the claim.
 */
export type { SilenceEscalation } from "./engine/watchdog.ts";

export interface ClaimLine {
  lineNumber: number;
  code: string;
  description: string;
  /**
   * The benefit bucket the estimate priced this line against, inherited verbatim, or
   * `UNCATEGORIZED` where the code is not in Mermaid's catalog and none was ever assigned.
   *
   * Nothing on the claims side reads it today — the scrubber and both 837D builders work from the
   * code, the fee and the tooth number. It is carried because the claim inherits the estimate's
   * line as written, and because a future reader must find the absence rather than a fabricated
   * "basic".
   */
  category: LineCategory;
  toothNumber?: string;
  surfaces?: string;
  quantity: number;
  /** What the clinic bills the payer for this line. */
  fee: Cents;
  /** What the inherited snapshot says insurance should pay — the variance baseline. */
  expectedInsurancePays: Cents;
  /**
   * Whether this payer requires approval before this service, inherited from the estimate.
   *
   * Carried on the LINE rather than the claim because the requirement is per procedure: a plan that
   * needs approval for a crown does not need one for the exam beside it, and a claim-level flag
   * would either block a whole visit for one line or say nothing about which line is exposed.
   *
   * Optional: a claim built before this existed carries none, which the scrubber reads as "nothing
   * to say" rather than "no approval needed".
   */
  preAuthRequirement?: "required" | "not-required" | "unknown";
  /** What a pre-auth refusal would cost on this line — the insurance share, never the billed fee. */
  preAuthRiskAmount?: Cents;
  /**
   * Money the payer's contract says nobody owes on this line (F-1 / L-3).
   *
   * Inherited from the estimate like every other figure here, and carried for the same reason the
   * tooth number is: the claim is a screen a biller works from, and without it the row shows a fee,
   * an insurance share and a patient share that visibly do not add up. The claim's own totals have
   * the same gap.
   *
   * Optional because every claim written before this has no such key, and reading it as "nothing was
   * written off" is exactly right for a claim priced entirely off billed fees. `CLAIM_RECORD_VERSION`
   * is deliberately unchanged: an additive optional field needs no upcaster.
   */
  contractualWriteOff?: Cents;
  /** What the patient was quoted for this line. */
  expectedPatientPays: Cents;
  /** True when the estimate already flagged this line as not covered. */
  estimatedDenied: boolean;
  serviceDate: string;
}

export type ScrubSeverity = "error" | "warning";

export type ScrubCode =
  | "missing-member-id"
  | "missing-payer"
  | "inactive-coverage"
  /**
   * The payer never stated whether the policy is live — carried into the snapshot as
   * `eligibility: "unknown"` and `denialReason: "eligibility-unknown"` (D3).
   *
   * Deliberately NOT `inactive-coverage`, and deliberately a WARNING where that is an error. The
   * two are different facts and the asymmetry decides the severity, exactly as it did at M7: a
   * claim blocked on an unknown that was actually fine costs the whole claim, silently, while a
   * claim filed on an unknown that was not costs one submission and a CO-27 the biller can see and
   * work. A human has also already ruled on this record — a verification carrying the critical
   * `eligibility-unknown` flag reaches Claims only as `reviewed`.
   */
  | "eligibility-unknown"
  /**
   * The payer stated a coverage window and the DATE OF SERVICE falls outside it.
   *
   * Distinct from `inactive-coverage`, and the distinction is the whole point. `eligibility` is the
   * payer's answer to "is this policy live?" as of the instant it replied; these are about the day
   * the patient was actually treated. A plan that ended on the 5th answers ACTIVE on the 1st and
   * pays nothing for treatment on the 20th.
   */
  | "coverage-terminated"
  | "coverage-not-yet-effective"
  /**
   * A service the payer requires approval for, filed with no approval on record.
   *
   * An ERROR, because filing it is how the money is lost: the payer refuses under CARC 197 in the
   * `CO` group, which forbids billing the patient, so the whole allowed amount is written off
   * against the practice. Pia Phase32's crown lost $1,125.00 exactly this way. The block is
   * overridable by recording the approval, or by recording that the payer waived it — never by
   * ignoring it.
   */
  | "preauth-missing"
  /**
   * Nobody has established whether this service needs approval.
   *
   * A WARNING, not an error. `unknown` is the ordinary answer for a 271 and blocking on it would
   * stop most claims in the system on a question the payer never answered. It is still stated,
   * because "nobody checked" is a different thing from "no approval is needed" and only one of them
   * is safe.
   */
  | "preauth-unknown"
  /**
   * A group practice filed a claim naming nobody who performed the treatment (NEW-22).
   *
   * An ERROR only where `PRACTICE_IS_GROUP` is set: for a solo practice 2310B is correctly omitted,
   * and demanding it would block every claim on a field the guide says not to send.
   */
  | "missing-rendering-provider"
  | "missing-tooth-number"
  | "zero-charge-line"
  | "invalid-quantity"
  | "duplicate-line"
  /**
   * This patient already has a claim carrying this procedure, on this tooth, for this date of
   * service — on a DIFFERENT claim (NEW: duplicate-service).
   *
   * `duplicate-line` above catches the same procedure twice inside one claim. This catches the same
   * treatment filed twice across two, which is what a second coverage produces: one crown on tooth
   * 19 became a $1,425.00 claim to Delta and an identical $1,425.00 claim to MetLife, both filed as
   * primary, both paid in full — $2,850.00 of billing and $1,599.98 of payments against one crown.
   * The only guard that existed was `claims_one_per_verification`, and these came from two
   * verifications, so nothing was violated and nothing was said.
   *
   * A WARNING, deliberately. Two claims for one visit is sometimes exactly right — a secondary
   * payer is billed after the primary rules, and that is ordinary coordination of benefits. What is
   * never right is doing it WITHOUT knowing, so this makes a person look and decide rather than
   * blocking a filing that may be correct. Whether Mermaid should then sequence primary and
   * secondary and bill the residual is a larger question this does not answer.
   */
  | "duplicate-service"
  | "missing-patient-identity"
  /**
   * The claim is for a dependent, and nothing names the person whose policy it is (NEW-01).
   *
   * An ERROR. 005010X224A2 puts the POLICY HOLDER in loop 2010BA, so the alternatives are filing
   * the child as the subscriber — which is adjudicated against the wrong person's benefits — or
   * defaulting the name to the patient's, which states to an insurer that the patient holds a
   * policy they do not.
   */
  | "missing-subscriber-identity"
  /**
   * A dependent claim whose subscriber has no date of birth on file, so 2010BA's DMG carries the
   * patient's. A WARNING and not an error: payers match 2010BA on the member id, and blocking here
   * would refuse claims that file perfectly well.
   */
  | "subscriber-dob-unknown"
  /** 837D loop 2010BA N3/N4 — a payer will not adjudicate a claim without the subscriber's address. */
  | "subscriber-address-missing"
  | "subscriber-address-invalid"
  /**
   * CLM01 exceeds the payer's 20-character ceiling, or carries a character that cannot survive the
   * wire. Blocks, because the claim is otherwise perfect and the rejection costs a full round trip.
   */
  | "control-number-invalid"
  /**
   * A refiling that cannot name the claim it replaces. CLM05-3 `7` without `REF*F8` tells the payer
   * to supersede something and not which, so it is denied as a duplicate (CARC 18) — the correction
   * workflow producing the next denial. Blocks, matching the refusals already in `build837D` and
   * `ClaimService.submit`; this one is the only one a human meets BEFORE pressing Submit.
   */
  | "replacement-without-control-number"
  | "invalid-npi"
  | "placeholder-billing-provider"
  | "future-service-date"
  | "past-filing-deadline"
  | "stale-snapshot"
  | "estimated-denial"
  | "annual-max-exhausted"
  /**
   * The payer stated no remaining annual maximum, so the inherited estimate's expected insurance
   * payment is uncapped. Distinct from `annual-max-exhausted` (M4): silence is not a spent plan.
   */
  | "annual-max-unknown"
  | "total-mismatch";

/**
 * One scrubber finding. `severity: "error"` blocks submission; `"warning"` informs the human at the
 * submit gate but does not block — the clinic may have context the rules do not.
 */
/**
 * The payer's approval decision for the treatment on this claim, and how it was obtained.
 *
 * ── WHY THIS LIVES ON THE CLAIM ────────────────────────────────────────────────────────────────
 * A pre-authorisation is requested BEFORE treatment, so conceptually it precedes the claim. In
 * Mermaid a draft claim is created from the verification the moment coverage is checked — before
 * the patient is in the chair — so the draft IS the treatment plan's representation and is the
 * earliest durable place to hang the decision. The trade is stated rather than hidden: a practice
 * that wanted to seek approval without any intention of treating would still create a draft claim.
 *
 * ── STATUS IS NOT A GUESS ──────────────────────────────────────────────────────────────────────
 * Every value here is recorded by a person or returned by a payer. Nothing infers an approval, and
 * `not-requested` is the honest default — the absence of a decision, not a decision.
 */
export interface ClaimPreAuthorization {
  /**
   * `waived` is its own state, not a flavour of `approved`.
   *
   * A payer saying "this does not need authorisation" clears the gate exactly as an approval does,
   * and grants nothing to quote if the claim is later refused — there is no reference number
   * behind it. Collapsing the two would let a waiver be produced as evidence it can never be.
   */
  status: "not-requested" | "pending" | "approved" | "denied" | "expired" | "waived";
  /** When the practice asked. Drives the aging shown on the worklist. */
  requestedAt?: string;
  requestedBy?: string;
  /** When the payer answered. */
  decidedAt?: string;
  /**
   * The payer's own authorisation number. The single most valuable field here: it is what a payer
   * asks for when a claim is refused despite an approval, and without it an approval is a claim the
   * practice cannot evidence.
   */
  referenceNumber?: string;
  /**
   * The day the approval stops being valid, from the payer's own term. Absent when the payer did
   * not state one — which must NOT be read as "valid forever".
   */
  validUntil?: string;
  /** The payer's stated reason for refusing, verbatim where possible. */
  denialReason?: string;
  /**
   * How this decision reached Mermaid.
   *
   * `mock` exists so synthetic data can never be mistaken for a payer's word. Nothing in the
   * product sets it outside the demo path, and the UI labels it.
   */
  source: "payer-electronic" | "payer-portal" | "payer-phone" | "mock";
  /** Free text from whoever recorded it. */
  note?: string;
}

export interface ScrubFinding {
  severity: ScrubSeverity;
  code: ScrubCode;
  message: string;
  /** The claim field or line this points at, for UI highlighting. */
  field?: string;
  lineNumber?: number;
  /** What a human should actually do about it. */
  remediation: string;
}

export interface ScrubResult {
  clean: boolean;
  errors: number;
  warnings: number;
  findings: ScrubFinding[];
  scrubbedAt: string;
}

/** The outcome of releasing a claim to the clearinghouse. */
/**
 * A submission that has been AUTHORISED and not yet answered — the "intent" (NEW-10).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * `submit` used to do everything in one transaction: lock the claim, validate it, call the
 * clearinghouse, write the answer. The vendor call has a thirty-second timeout, and for all of it
 * the row lock and one of the pool's ten connections were held.
 *
 * Splitting it means there is now a moment where the claim has been released to a payer and this
 * system does not yet know the outcome — a real state, and one that has to be written down rather
 * than inferred. Without it, a crash mid-call leaves a claim that reads exactly like one nobody has
 * touched, and the next person presses Submit again.
 *
 * It is NOT a lock. `patientControlNumber` is deterministic per claim, so the payer recognises a
 * resubmission as the same claim and a retry is safe by construction. This is what lets a screen
 * say "this was sent at 14:02 and we are waiting", and what lets a second concurrent press be
 * refused with a reason rather than silently filing twice.
 */
export interface ClaimSubmissionAttempt {
  /** When the 837 was handed to the adapter. */
  startedAt: string;
  startedBy: string;
  /** The CLM01 this attempt used — the idempotency key the payer de-duplicates on. */
  patientControlNumber: string;
}

export interface ClaimSubmission {
  submittedAt: string;
  /** Who pressed the button — the submit gate is a human act, always attributable. */
  submittedBy: string;
  /** The clinic's control number (CLM01); stable across resubmissions of this claim. */
  patientControlNumber: string;
  /** The payer/clearinghouse control number to quote in follow-ups. */
  controlNumber: string;
  outcome: "accepted" | "rejected";
  statusCategory: string | null;
  statusCode: string | null;
  message: string;
  lineErrors: {
    lineNumber: number;
    procedureCode: string;
    code: string;
    message: string;
    matchedBy: "line-control-number" | "unique-procedure-code" | "procedure-code-sequence";
  }[];
  /**
   * Line-level statuses the payer sent that could not be tied to exactly one of our lines (DEC-1).
   *
   * A 277CA names a procedure, and a dental claim may carry the same procedure twice. When nothing
   * distinguishes which one the payer meant, the error is recorded here for a person to read rather
   * than assigned to the first match — a biller who corrects the wrong line refiles and is rejected
   * again for the line they never touched.
   *
   * Optional: a submission recorded before this existed carries no answer, and an empty array would
   * assert that nothing was ambiguous when nobody looked.
   */
  unattributedLineErrors?: {
    procedureCode: string | null;
    sequence: number;
    code: string;
    message: string;
    reason: "no-procedure-code" | "unknown-procedure-code" | "ambiguous-duplicate-procedure";
  }[];
  /** Raw 837 for provenance; stored encrypted at rest, never logged. */
  raw837?: string | null;
}

/**
 * One payment posted against this claim. A claim can receive several — a secondary payer, a
 * correction, a later appeal payment — so these accumulate rather than overwrite.
 *
 * Recorded from `remittance.posted`; every figure is the Remittance module's, copied verbatim. This
 * module never recomputes what a payer paid.
 */
export interface ClaimPayment {
  /** The posting this came from. **The idempotency key** — one posting records exactly once. */
  postingId: string;
  remittanceId: string;
  postedAt: string;
  traceNumber: string;
  paidAmount: Cents;
  patientResponsibility: Cents;
  contractualAdjustments: Cents;
  /**
   * Money this payer assigned to ANOTHER payer's adjudication — `OA` / CARC 23, or a claim it
   * forwarded outright (CLP02 `19`/`20`).
   *
   * ── WHY THE CLAIM HAS TO CARRY IT ─────────────────────────────────────────────────────────────
   * Without it a coordinated claim does not add up. Kira Demo's advice pays $799.99 on a $1,425.00
   * charge, writes off $142.50 under contract, and assigns $482.51 to a secondary plan. The claim
   * recorded the first two and dropped the third, so its own figures accounted for $942.49 of a
   * $1,425.00 charge and the totals block showed "Patient owes $0.00" beside the gap.
   *
   * That reads as "this claim is finished and the patient owes nothing". Both halves are wrong: the
   * claim is not finished, and what the patient owes is not knowable until the secondary rules. The
   * ledger already refuses to bill under coordination; the claim screen was the surface still
   * saying otherwise.
   *
   * Optional because it is additive — a payment recorded before this field existed carries none,
   * which reads as zero and is exactly what was true of every payment then.
   */
  coordinationAmount?: Cents;
  /**
   * Whether this advice RESTATES what the patient owes, or is silent about them.
   *
   * ── WHY THE CONTENT HEURISTIC WAS NOT ENOUGH ──────────────────────────────────────────────────
   * `totalPatientResponsibility` inferred this from the posting's own figures: a payment counted as
   * adjudicating the patient's share if it stated one OR carried a contractual adjustment. The
   * second clause is where it broke. An appeal-award settlement pays a line and therefore carries
   * that line's contractual write-off, while saying nothing whatever about the patient — so it
   * passed the test and its `patientResponsibility: 0` overwrote a real balance.
   *
   * On staging that put Pia Phase32's claim at "Patient owes $0.00" while the ledger held $149.52,
   * and Jack Demo's at $0.00 against $136.01. The ledger was right both times, because Remittance
   * computes this flag and the LEDGER already consumed it. Claims did not: one fact, two consumers,
   * only one of them taught the rule — the same shape as the Money/Recover divergence.
   *
   * Optional because it is additive. A payment recorded before this existed carries none, and the
   * selector then falls back to the old content heuristic, which is exactly what was true then.
   */
  restatesPatientResponsibility?: boolean;
  /** `paidAmount - expectedInsurancePays` for this posting. Negative means underpaid. */
  variance: Cents;
  outcome: "as_expected" | "underpaid" | "overpaid" | "denied";
  /** True when the payer owes nothing further on this claim. */
  settled: boolean;
}

/**
 * Cash that arrived on this claim because an appeal was WON, per denial (F-7).
 *
 * A claim estimated to pay $175 that receives $1,146.49 has a $971.49 positive variance, and
 * without this the only thing the system could say about it was "confirm it is not a duplicate or a
 * takeback waiting to happen" — about money the practice itself fought for and won. A badge that
 * cries duplicate on a recovered appeal is a badge staff learn to dismiss, which is precisely the
 * failure the materiality band was introduced to fix.
 *
 * Claims cannot read the Denials context, so this arrives as `denial.recovery.settled`. Keyed by
 * denial because the event publishes a running TOTAL for that denial rather than a delta: upserting
 * on `denialId` converges on redelivery instead of accumulating, and a reversal back to zero is
 * just another assignment.
 */
export interface ClaimAppealRecovery {
  denialId: string;
  /** Cash actually arrived on this denial's award. An assignment, never a delta. */
  settledAmount: Cents;
  /** What the payer agreed to on appeal, whether or not it has all landed. */
  awardedAmount: Cents;
  settledAt: string;
}

export interface ClaimAuditEvent {
  timestamp: string;
  actor: "system" | "staff";
  message: string;
}

/**
 * 837D loop 2010BA N3/N4. Named rather than inline because a claim's address is now EDITABLE before
 * filing (`correctSubscriberAddress`), so the shape is part of this module's public surface.
 *
 * Structurally identical to verification's `PatientAddress` and deliberately NOT imported from it —
 * modules do not depend on each other, only on `platform/*` and `packages/shared`. The duplication
 * is the boundary working as intended.
 */
export interface SubscriberAddress {
  street: string;
  city: string;
  /** Two-letter USPS code. */
  state: string;
  /** 5 or 9 digits, no hyphen — the shape an 837 carries. */
  zip: string;
}

export interface ClaimPatient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  /**
   * The POLICY this claim is filed under — not an identifier for this person.
   *
   * A dental family shares the subscriber’s member ID, which is why `relationship` exists below.
   */
  memberId: string;
  /**
   * 837D loop 2010BA when this patient IS the subscriber, loop 2010CA when they are a dependent.
   * Absent blocks the submit gate — see the scrubber’s subscriber-address rule.
   */
  address?: SubscriberAddress;
  gender?: "M" | "F" | "U";
  /** What this patient is to the policy. Absent means `self` — the ordinary dental case (NEW-01). */
  relationship?: SubscriberRelationship;
  /**
   * Who holds the policy, when it is not this patient.
   *
   * The scrubber blocks filing when a claim says `relationship` is anything but `self` and cannot
   * name the subscriber, because loop 2010BA has to carry a name and inventing one would be a false
   * statement to the payer under the practice’s NPI.
   */
  subscriber?: SubscriberIdentity;
}

/**
 * The dentist who performed the treatment — 837D loop 2310B (NEW-22).
 *
 * ── WHY A CLAIM NEEDS THIS AND A SOLO PRACTICE DOES NOT ────────────────────────────────────────
 * 2010AA names who gets PAID. In a solo practice that is also who did the work, and 005010X224A2
 * says to omit 2310B when the two are the same. In a group they are never the same: the billing NPI
 * is the practice's, and the rendering NPI is the individual whose credentialing and network status
 * the payer checks for the treatment being billed.
 *
 * Absent means "the billing provider rendered this", which is what every claim built before this
 * existed meant and what a solo practice's claims still mean. `PRACTICE_IS_GROUP` is what turns its
 * absence into a scrub error, because only the deployment knows which kind of practice it is.
 */
export interface RenderingProvider {
  firstName: string;
  lastName: string;
  /** The individual's OWN NPI — never the group's, which belongs in 2010AA. */
  npi: string;
  /**
   * The dentist's Health Care Provider Taxonomy code — PRV03 in loop 2310B, e.g. `1223G0001X` for
   * general practice dentistry.
   *
   * Required, because the loop is: 005010X224A2 makes PRV mandatory whenever 2310B is present, and
   * a real clearinghouse refuses the claim structurally without it. Not defaulted — a taxonomy is a
   * statement about which specialty performed the treatment, and the payer prices and credentials
   * against it, so guessing one is a false statement with money attached.
   */
  taxonomyCode: string;
}

export interface ClaimPayer {
  payerId: string | null;
  payerName: string | null;
  planName: string | null;
  groupNumber: string | null;
}

export interface Claim {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ClaimStatus;

  /** The keystone: which verification this claim was built from… */
  verificationId: string;
  /** …and the immutable estimate it inherited. Never rewritten after creation. */
  coverageSnapshot: CoverageSnapshot;

  patient: ClaimPatient;
  payer: ClaimPayer;
  /** ISO date of service. */
  serviceDate: string;
  /** ISO date after which the payer will refuse the claim for timely filing. */
  filingDeadline: string;
  /**
   * The payer's own document behind `filingDeadline`, or absent when the date is Mermaid's estimate
   * (B-1).
   *
   * Recorded at creation beside the date it describes, because it is a fact about how THAT date was
   * computed: a claim built on the old 180-day Aetna guess keeps its estimate label even after the
   * catalog is corrected, which is true of it. Optional, and `CLAIM_RECORD_VERSION` deliberately
   * unchanged: absent reads as "estimate", exactly right for every claim written before this.
   */
  filingWindowSource?: PayerWindowSource | null;

  lines: ClaimLine[];
  totalFee: Cents;
  /**
   * What the payer's contract writes off across this claim (F-1 / L-3). Zero on a claim priced
   * entirely off billed fees, which is every claim before a rate was observed.
   *
   * `totalFee === expectedInsurancePays + expectedPatientPays` no longer holds once a contract is
   * known, and it never should have: the write-off had nowhere to go but the patient. The identity
   * is now the same three-way split the remittance side has always used.
   */
  totalContractualWriteOff?: Cents;
  expectedInsurancePays: Cents;
  /**
   * Money the payer's contract says nobody owes on this line (F-1 / L-3).
   *
   * Inherited from the estimate like every other figure here, and carried for the same reason the
   * tooth number is: the claim is a screen a biller works from, and without it the row shows a fee,
   * an insurance share and a patient share that visibly do not add up. The claim's own totals have
   * the same gap.
   *
   * Optional because every claim written before this has no such key, and reading it as "nothing was
   * written off" is exactly right for a claim priced entirely off billed fees. `CLAIM_RECORD_VERSION`
   * is deliberately unchanged: an additive optional field needs no upcaster.
   */
  contractualWriteOff?: Cents;
  expectedPatientPays: Cents;

  /** 837D loop 2310B. Absent means the billing provider rendered the care — see `RenderingProvider`. */
  renderingProvider?: RenderingProvider | null;

  scrub: ScrubResult | null;
  submission: ClaimSubmission | null;
  /**
   * Set while an 837 is in flight and cleared when the payer answers (NEW-10). Null the rest of the
   * time, which is almost always.
   */
  submissionAttempt?: ClaimSubmissionAttempt | null;
  /** Payments posted against this claim, oldest first. Empty until a remittance arrives. */
  payments: ClaimPayment[];
  /**
   * Appeal money recovered on this claim, one entry per denial (F-7).
   *
   * Optional deliberately: every claim persisted before this existed has no such key, and reading it
   * as an empty list is exactly right — a claim that never had an appeal recovered nothing. That is
   * why `CLAIM_RECORD_VERSION` is unchanged; an additive optional field needs no upcaster, and
   * bumping the version without one is how a live read started failing once already.
   */
  appealRecoveries?: ClaimAppealRecovery[];
  /** Set when a claim is voided; the reason a human gave. */
  voidReason: string | null;
  /**
   * The payer's approval decision for this treatment, when one has been sought.
   *
   * Absent means nobody has asked, which is exactly what `not-requested` would say — the field is
   * optional so every claim written before this existed reads correctly as "no decision on record"
   * rather than acquiring a fabricated one.
   */
  preAuthorization?: ClaimPreAuthorization;
  /**
   * The highest filing-risk level already escalated as a `claim.filing_risk` event. Recorded so a
   * repeated sweep re-raises only when the risk actually worsens — an alert that fires every hour
   * is an alert staff learn to ignore.
   */
  filingRiskRaised: FilingRisk | null;
  /**
   * What the silent-claim watchdog has already escalated for this claim (F4).
   *
   * The twin of `filingRiskRaised` above, and for the same reason: a sweep that re-raised on every
   * pass would be an alert staff learn to scroll past, and the claims most likely to be scrolled
   * past are the oldest — exactly the ones the watchdog exists for. Both halves are recorded
   * because either can worsen alone: a claim can stay `unacknowledged` while its filing risk goes
   * from approaching to urgent, and an escalation keyed only on the category would fall silent
   * precisely as the deadline closed in.
   *
   * Optional, so every claim persisted before this existed reads correctly as "nothing has been
   * raised" rather than acquiring a fabricated escalation. `CLAIM_RECORD_VERSION` is deliberately
   * unchanged: an additive optional field needs no upcaster, and bumping the version without one
   * is how a live read started failing once already.
   */
  silenceRaised?: SilenceEscalation | null;
  audit: ClaimAuditEvent[];
}
