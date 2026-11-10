/**
 * EDI adapter — the swappable clearinghouse seam (blueprint doc 09). Every module that needs EDI
 * depends on THIS interface, never on a vendor SDK or the X12 wire format. `EDI_ADAPTER` config
 * selects the implementation; the mock (ported X12 codecs) is the dev/test default, and a real
 * clearinghouse (Stedi/Availity/Change Healthcare) slots in behind the same contract at P2.
 *
 * Modules consume NORMALIZED shapes (Benefits in integer cents) — never raw X12.
 *
 * Scope note: `checkEligibility` (270/271), `submitClaim` (837D/277CA) and `fetchRemittance` /
 * `parseRemittance` (835) exist today — the front half, the billing handoff, and the money coming
 * back. That is the full round trip; further transactions (276/277 status, 278 authorization) are
 * added additively when a module needs them.
 */
import type { AdjustmentCategory, Benefits, Cents, SubscriberRelationship } from "@mermaid/shared";

/**
 * Whether THIS practice participates in THIS payer's network.
 *
 * ── WHY THIS HAS TO BE KNOWN RATHER THAN INFERRED ──────────────────────────────────────────────
 * A 271 routinely quotes both columns: EB12 `Y` segments carry the in-network benefit, EB12 `N` the
 * out-of-network one, and they are different numbers. Which one applies is not a property of the
 * patient or of the payer — it is a property of the CONTRACT between this practice and that payer,
 * and the 271 does not carry it because the payer is answering about the member, not about us.
 *
 * Reading the in-network column at an out-of-network practice under-quotes the patient: the payer
 * allows less, applies a higher coinsurance, and the balance the practice already told the patient
 * was theirs turns out to be bigger. The practice then eats the difference or re-bills someone it
 * has already quoted — the same failure mode as the family-vs-individual defect, one column over.
 *
 * `unknown` is a real, honest third state and the default. It preserves the previous behaviour
 * exactly (prefer in-network, accept anything when nothing better is offered), and it must not be
 * silently treated as `in-network` anywhere a quote depends on it.
 */
export type NetworkParticipation = "in-network" | "out-of-network" | "unknown";

/**
 * The hard ceiling on CLM01, the clinic's own claim control number.
 *
 * ── WHY 20, AND WHY THIS IS ENFORCED RATHER THAN ASSUMED ───────────────────────────────────────
 * X12 types CLM01 as AN 1/38, but the 005010X224A2 dental implementation guide and every payer
 * companion guide behind it cap the patient account number at 20 characters. This is not theory:
 * Stedi rejected a deliberately-probed 23-character control number outright.
 *
 * A rejection here is the expensive kind. The claim is syntactically fine, so it leaves the practice,
 * consumes a submission, and comes back as a payer rejection that a biller then has to read,
 * understand and refile — for a value the practice never chose and cannot see.
 *
 * Mermaid's generated numbers are `MRM-` plus twelve hex characters, so they are 16 today and fit
 * comfortably. That is exactly why this needs a guard rather than a comment: nothing about the
 * current derivation is load-bearing, and a future prefix, environment tag or resubmission suffix
 * would push it over the line silently.
 */
export const CLM01_MAX_LENGTH = 20;

/**
 * Whether a control number is safe to put on the wire as CLM01.
 *
 * Length is the documented limit. The character check is the quieter hazard: `*`, `~`, `:` and `^`
 * are the element, segment, component and repetition delimiters this codec renders with, so a
 * control number containing one would not be rejected — it would SPLIT THE SEGMENT and produce a
 * structurally different claim than the one intended. Whitespace is refused for the same family of
 * reason: leading or trailing spaces survive the wire and stop the payer's echo matching on return,
 * which is how a paid claim fails to reconcile.
 */
export function isValidClaimControlNumber(value: string): boolean {
  if (value.length === 0 || value.length > CLM01_MAX_LENGTH) return false;
  if (value !== value.trim()) return false;
  // Printable ASCII excluding the four X12 delimiters. A payer's own echo comes back through CLP01,
  // so anything that cannot survive a round trip unchanged is refused here.
  return /^[A-Za-z0-9\-]+$/.test(value);
}

export interface EligibilityRequest {
  /** Mermaid's own stable payer slug. Keys the playbook and every learned rate; never sent on the wire. */
  payerId: string;
  /**
   * Which column of the 271 this practice should be quoted from. Omitted means `unknown`.
   *
   * Carried on the REQUEST rather than configured inside a parser because participation is
   * per-practice AND per-payer: one clinic is in Delta's network and out of Cigna's, and a parser
   * that read a global setting would quote both from the same column.
   */
  networkParticipation?: NetworkParticipation;
  /**
   * The payer's id at the CLEARINGHOUSE, when this deployment knows it — a different namespace from
   * `payerId`, significant to the leading zero. Optional because the mock has no use for it and
   * because a deployment may not have an id for every payer; an adapter that needs one and does not
   * have it must say so rather than send the slug and get an empty 271 back.
   */
  clearinghouseId?: string;
  payerName: string;
  planName?: string;
  memberId: string;
  patient: { firstName: string; lastName: string; dateOfBirth: string };
  serviceDate?: Date;
}

export interface EligibilityResponse {
  eligibility: "active" | "inactive" | "unknown";
  /** Normalized benefits (money in cents), ready for the estimate engine. */
  benefits: Benefits;
  /** 271s are frequently partial — confidence per field, not just per response (roadmap §7.2). */
  perFieldConfidence: Record<string, number>;
  /**
   * WHO THE PAYER ACTUALLY ANSWERED ABOUT, echoed back in the 271 (NM1*IL and DMG).
   *
   * ── WHY THIS HAS TO TRAVEL (M10) ───────────────────────────────────────────────────────────────
   * Nothing compared the payer's answer to the question. A 271 carries the subscriber it resolved,
   * and Mermaid parsed the member ID, used it for nothing, and threw the date of birth away
   * entirely — DMG was in the parser's ignore list.
   *
   * A member ID that is wrong in a way that still resolves — a transposed digit that happens to
   * belong to somebody, an AI misreading of a card — comes back as a perfectly healthy 271 for the
   * WRONG PERSON. Their deductible, their remaining maximum, their plan. The patient in the chair is
   * quoted from it and the claim is filed under it, and the only field that could have contradicted
   * it was the one being discarded.
   *
   * Carried as data rather than decided here: the adapter reports what the payer said, and the
   * verification pipeline — where every other exception is raised — compares it to what was asked.
   * Null on either field means the payer did not echo it, which is legal and is not a mismatch.
   */
  subscriber: { memberId: string | null; dateOfBirth: string | null };
  /**
   * How many benefit segments the payer stated for a coverage scope this quote did NOT use — a
   * family benefit where the individual was read, or an out-of-network one where the practice is in
   * network (M24, instance 4).
   *
   * ── WHY A COMPUTED NUMBER HAD TO GET A READER ──────────────────────────────────────────────────
   * `parse271` has always counted these into `trace.supersededBenefits`, and until now nothing
   * outside a test ever read the count. That is the shape M24 records three other instances of: a
   * correct, load-bearing answer that is computed and then discarded, invisible to every gate
   * because the function is well tested in isolation and simply has no consumer.
   *
   * It matters here because the discarded segment is a benefit the payer really did state. A 271
   * where Mermaid chose one scope and threw another away is exactly the case a person should see
   * before quoting a patient — not because the chosen scope is wrong, but because "the payer also
   * described a different scope" is a fact a coordinator can act on and a number alone cannot.
   *
   * Reported, never judged, exactly like `subscriber` above: the adapter says what the payer sent,
   * and nothing downstream is gated on it. Zero means the payer offered nothing that was discarded.
   */
  supersededBenefits: number;
}

export interface EdiError {
  /**
   * `multiple_payments` is the odd one here and deliberately so: it is not a failure, it is a file
   * that holds several cheques when the caller asked for one. It gets its own code because a screen
   * has to offer "post all of them" for that and must never offer it for a corrupt file — see
   * `MultiplePaymentsError` in mock/x12-835.ts, and audit finding A-3.
   */
  code: "invalid_member_id" | "parse_error" | "multiple_payments" | "unavailable" | "rate_limited" | "timeout";
  message: string;
  /** Whether a retry (later, via the outbox worker) could succeed. */
  retryable: boolean;
}

export interface EdiResult<T> {
  ok: boolean;
  data?: T;
  error?: EdiError;
  /** Raw wire payload retained for provenance/audit; stored ENCRYPTED at rest, never logged. */
  raw?: string;
  source: "edi" | "portal" | "manual" | "mock";
}

// ── Claim submission (837D → 277CA) ───────────────────────────────────────────────────

/** One dental service line on an outbound claim. Money is integer CENTS (domain side). */
export interface ClaimSubmissionLine {
  lineNumber: number;
  procedureCode: string;
  /** Universal/National tooth number — required by the payer for tooth-specific procedures. */
  toothNumber?: string;
  surfaces?: string;
  quantity: number;
  chargeAmount: Cents;
  /** ISO service date. */
  serviceDate: string;
}

export interface ClaimSubmissionRequest {
  /** Mermaid's claim id — round-tripped through the 837 so an ack can be matched back. */
  claimId: string;
  /**
   * The clinic's control number for this claim. Deterministic per claim: resubmitting the same
   * claim must present the same number, which is how a payer recognizes a duplicate instead of
   * paying twice.
   */
  patientControlNumber: string;
  payerId: string;
  payerName: string;
  /**
   * CLM05-3 claim frequency. `1` original, `7` replacement of a claim the payer already has.
   *
   * A corrected claim filed as an ORIGINAL is a new claim to the payer, and payers deny those as
   * duplicates (CARC 18). This codebase supports correcting and refiling after a denial, so the
   * distinction has to reach the wire or the workflow generates the very denials it exists to work.
   */
  /**
   * The payer’s id AT THE CLEARINGHOUSE, in loop 2010BB NM109 — a different namespace from
   * `payerId`, exactly as on an eligibility request. Stedi routes a claim on this and requires an id
   * from its own payer network; Mermaid’s slug is not one, and filing with it misroutes the claim.
   */
  clearinghouseId?: string;
  claimFrequency?: "1" | "7";
  /** REF*F8 — the payer’s own control number for the claim being replaced. Required when frequency is 7. */
  originalClaimControlNumber?: string | null;
  /**
   * Loop 2010BA — the person who HOLDS the policy.
   *
   * When the patient is the subscriber (the ordinary dental case) this is the patient, and
   * `patient` below is absent. When the patient is a dependent this is the policy holder, and the
   * patient appears separately in loop 2010CA.
   */
  subscriber: {
    firstName: string;
    lastName: string;
    /** The subscriber's own, when known. Falls back to the patient's for a self claim. */
    dateOfBirth: string;
    memberId: string;
    groupNumber?: string | null;
    /** 837D loop 2010BA N3/N4 + DMG03. The scrubber blocks filing when absent. */
    address?: { street: string; city: string; state: string; zip: string };
    gender?: "M" | "F" | "U";
  };
  /**
   * Loop 2000C/2010CA — the PATIENT, when they are not the subscriber (NEW-01).
   *
   * ── WHY THIS IS A SEPARATE LOOP AND NOT A CODE ON THE SUBSCRIBER ─────────────────────────────
   * A dental plan issues one member ID to the subscriber and covers the family under it. 005010X224A2
   * models that with a second hierarchical level: the subscriber stays in 2000B/2010BA, an HL with
   * HL03 = "23" opens 2000C, `PAT01` carries the relationship, and the patient's own name, address
   * and demographics go in 2010CA.
   *
   * Absent means the patient IS the subscriber, which is what every claim built before this existed
   * meant — so nothing about an ordinary claim's wire format changes.
   */
  patient?: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    /** PAT01. Never `self` — a self claim has no 2000C loop at all. */
    relationship: Exclude<SubscriberRelationship, "self">;
    /** 837D loop 2010CA N3/N4 + DMG03 — the DEPENDENT's address, not the subscriber's. */
    address?: { street: string; city: string; state: string; zip: string };
    gender?: "M" | "F" | "U";
  };
  billingProvider: {
    name: string;
    npi: string;
    taxId: string;
    phone?: string;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    /** Loop 2000A PRV03. Payers reject a claim without it when no rendering provider is reported. */
    taxonomy?: string;
  };
  /**
   * Loop 2310B — the dentist who performed the treatment, when that is not the billing provider
   * (NEW-22).
   *
   * Absent in a solo practice, where they are the same person and the guide says to omit the loop.
   * Required in a group: the billing NPI is the practice's, and a payer checks credentialing and
   * network participation against the person who actually did the work.
   */
  renderingProvider?: {
    firstName: string;
    lastName: string;
    npi: string;
    /** PRV03 taxonomy code — required by 005010X224A2 whenever loop 2310B is present. */
    taxonomyCode: string;
  };
  /** ISO date of service for the claim. */
  serviceDate: string;
  totalCharge: Cents;
  lines: ClaimSubmissionLine[];
}

export interface ClaimAckLineError {
  lineNumber: number;
  /** The procedure the payer named in SVC01 — the evidence the attribution was made from. */
  procedureCode: string;
  code: string;
  message: string;
  /**
   * How this status was tied to that line (DEC-1). Recorded rather than assumed, so a reader can
   * weigh it: an echoed line control number is the payer telling us, a unique procedure code is
   * arithmetic, and a sequence alignment is the weakest of the three.
   */
  matchedBy: "line-control-number" | "unique-procedure-code" | "procedure-code-sequence";
}

/**
 * A line-level status the payer sent that could NOT be tied to exactly one submitted line.
 *
 * A 277CA names a procedure, and a dental claim may legitimately carry the same procedure twice.
 * When nothing distinguishes which one the payer meant, this system says so instead of guessing —
 * a biller who corrects the wrong line refiles and is rejected again for the line they never
 * touched. These need a person to read the payer's own message.
 */
export interface ClaimAckUnattributedError {
  procedureCode: string | null;
  /** Position of the service loop within the claim, as the payer ordered them. */
  sequence: number;
  code: string;
  message: string;
  reason: "no-procedure-code" | "unknown-procedure-code" | "ambiguous-duplicate-procedure";
}

/** Normalized acknowledgement — what the module sees. Never raw X12. */
export interface ClaimAcknowledgement {
  status: "accepted" | "rejected";
  /** The payer/clearinghouse control number to quote in any follow-up. */
  controlNumber: string;
  /**
   * OUR OWN control number as the payer echoed it back (277CA TRN02), or null when it sent none.
   *
   * ── WHY THIS TRAVELS (M10) ─────────────────────────────────────────────────────────────────────
   * `parse277CA` read this field and nothing ever compared it to the claim that was actually
   * submitted. An acknowledgement is the only evidence a claim reached a payer, and one that names a
   * DIFFERENT claim is evidence about a different claim — accepting it marks this claim filed on the
   * strength of somebody else's receipt.
   *
   * Reported here rather than judged, so the codec stays pure and the decision sits in the service
   * that knows what it sent.
   */
  patientControlNumber: string | null;
  /** X12 STC status category / code, when the payer returned one. */
  statusCategory: string | null;
  statusCode: string | null;
  message: string;
  acknowledgedAt: string;
  lineErrors: ClaimAckLineError[];
  /**
   * Line-level statuses that could not be attributed to one line. Never empty-by-default in the
   * sense that matters: an absent attribution is reported, not silently dropped.
   */
  unattributedLineErrors: ClaimAckUnattributedError[];
}

// ── Remittance (835 ERA) ──────────────────────────────────────────────────────────────

/** One adjustment the payer made — money it did not pay, and the reason code for it. */
export interface RemittanceAdjustment {
  /** CAS01 group: CO (contractual), PR (patient), PI (payer-initiated), OA, CR. */
  group: string;
  /** CARC reason code. */
  code: string;
  /** Human-readable meaning, resolved from the shared CARC reference. */
  description: string;
  /** What this adjustment means for the clinic: write it off, bill the patient, or chase it. */
  category: AdjustmentCategory;
  amount: Cents;
  /** CDT code when line-level; null when the adjustment applies to the whole claim. */
  procedureCode: string | null;
}

export interface RemittanceLine {
  procedureCode: string;
  charged: Cents;
  paid: Cents;
  quantity: number;
  adjustments: RemittanceAdjustment[];
  /** RARC remark codes with their meanings. */
  remarks: { code: string; description: string }[];
}

export interface RemittanceClaim {
  /** CLP01 — the clinic's control number from the 837. The key a claim is matched on. */
  patientControlNumber: string;
  /** The payer's own control number for this claim. */
  payerControlNumber: string;
  statusCode: string;
  /**
   * `forwarded` is CLP02 `19`/`20` — this payer passed the claim to another plan (M8). It is not an
   * adjudication outcome at all, which is why it cannot be collapsed into paid/partial/denied: a
   * forwarded claim can carry any payment amount, and every amount-based reading of it is wrong.
   */
  disposition: "paid_full" | "partial" | "denied" | "reversal" | "forwarded" | "unknown";
  charged: Cents;
  paid: Cents;
  patientResponsibility: Cents;
  patientName: string;
  memberId: string;
  lines: RemittanceLine[];
  /** Claim- and line-level adjustments flattened, each already categorized. */
  adjustments: RemittanceAdjustment[];
  remarks: { code: string; description: string }[];
  /** True when this claim's own arithmetic does not add up. */
  unbalanced: boolean;
  /** NM1*TT — the plan the payer says it forwarded this claim to. Absent when the payer named none. */
  crossoverCarrier?: { name: string; idQualifier: string | null; id: string | null };
}

/**
 * PLB — an adjustment against the payment as a whole rather than against any one claim: an
 * overpayment takeback, a forwarding balance, interest, a fee.
 *
 * `reasonCode` and `referenceId` are the two halves of the PLB03 composite. They are separated here
 * rather than left inside `reason` because the reference is normally the ORIGINAL claim's control
 * number — the only thing on the wire that says whose money is being pulled back — and a recoupment
 * nobody can attribute is a materially worse situation than one that can be.
 */
export interface ProviderAdjustment {
  providerId: string;
  /** PLB03 verbatim, composite separator included. What the payer actually wrote. */
  reason: string;
  /** PLB03-1. `WO` overpayment recovery, `FB` forwarding balance, `72` return, `L6` interest. */
  reasonCode: string;
  /** PLB03-2 — normally the original claim's control number. Null when the payer named nothing. */
  referenceId: string | null;
  /** Positive withholds from the payment; negative adds to it. */
  amount: Cents;
}

/** A normalized remittance advice. Money in integer cents; the module never sees raw X12. */
export interface RemittanceAdvice {
  /**
   * The check or EFT trace number. **This is the idempotency key for posting** — the same
   * remittance re-fetched must never post twice.
   */
  traceNumber: string;
  payerName: string;
  payeeName: string;
  /**
   * N1*PE identifier and qualifier (`XX` = NPI, `FI` = tax id) — WHO was paid, not just what they
   * are called. Empty when the payer sent a bare name.
   *
   * A name cannot resolve a tenant. When an 835 arrives unsolicited rather than in answer to a poll
   * this deployment made, this is the only field in the file that says whose money it is.
   */
  payeeId: string;
  payeeIdQualifier: string;
  /** BPR total — the money that actually moved. */
  paymentTotal: Cents;
  /** "ACH" (EFT), "CHK" (paper check), … */
  paymentMethod: string;
  /** ISO payment date. */
  paymentDate: string;
  claims: RemittanceClaim[];
  /** PLB — adjustments against the payment as a whole (takebacks, interest, fees). */
  providerAdjustments: ProviderAdjustment[];
  /**
   * Whether every balance assertion held. **Money must never post from an unbalanced advice** —
   * `issues` is what a human reconciles by hand.
   */
  balanced: boolean;
  issues: string[];
  /**
   * ISA15 of the interchange this advice arrived in: `T` test, `P` production, `null` unknown.
   *
   * Optional so an advice built without an envelope — a vendor's JSON, a hand-built fixture — is
   * still an advice. Absent and `null` both mean "the sender did not say", which is NOT the same as
   * "production": the remittance gate treats only an explicit `T` as a test file.
   */
  usageIndicator?: "T" | "P" | null;
}

/** One claim the mock payer should adjudicate. */
export interface RemittanceRequestClaim {
  patientControlNumber: string;
  payerControlNumber: string;
  patientFirstName: string;
  patientLastName: string;
  memberId: string;
  lines: { procedureCode: string; charged: Cents; quantity: number }[];
  /**
   * What the provider expected insurance to pay. **A real clearinghouse adapter ignores this
   * entirely** — it polls for whatever ERAs the payer has released. The mock needs it because it is
   * standing in for the payer's *adjudication engine*, not merely for the transport.
   */
  expectedInsurancePays: Cents;
}

export interface RemittanceRequest {
  payerId: string;
  payerName: string;
  payeeName: string;
  /** ISO payment date; defaults to today. */
  paymentDate?: string;
  /** Ignored by a real adapter — see `RemittanceRequestClaim.expectedInsurancePays`. */
  claims: RemittanceRequestClaim[];
}

export interface EdiAdapter {
  /** 270 → 271: real-time dental eligibility, normalized. */
  checkEligibility(req: EligibilityRequest): Promise<EdiResult<EligibilityResponse>>;
  /**
   * 837D → 277CA: submit a dental claim and return the payer's acknowledgement, normalized.
   *
   * A returned `ok: true` with `status: "rejected"` means the transport worked and the PAYER said
   * no — a business outcome the module must record, not an error. `ok: false` means the submission
   * never landed and may be retried. Conflating the two would let a rejected claim be silently
   * retried forever, or a transport blip be recorded as a payer denial.
   */
  submitClaim(req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>>;

  /**
   * 835: retrieve remittance advices the payer has released, normalized.
   *
   * An advice that parses but does not BALANCE still comes back `ok: true` with
   * `balanced: false` — it is a real file carrying real payment information that a human must
   * reconcile, not a transport failure. Refusing to post from it is the module's decision, not the
   * adapter's.
   */
  fetchRemittance(req: RemittanceRequest): Promise<EdiResult<RemittanceAdvice[]>>;

  /**
   * Normalize an 835 the clinic already holds (downloaded from a payer portal, emailed by a
   * clearinghouse). Same output shape as `fetchRemittance`, so the module has one code path for
   * money regardless of how the file arrived.
   */
  parseRemittance(raw: string): EdiResult<RemittanceAdvice>;

  /**
   * Normalize an ERA *file*, which may carry several 835 transaction sets — one per cheque.
   *
   * `parseRemittance` answers with a single advice and REFUSES a multi-set payload, which is right
   * for a human upload where one file is one payment and anything else deserves a human's eyes.
   * A clearinghouse artifact is the other case: batching is normal, and quietly reading only the
   * first cheque would lose the rest with no error anywhere.
   *
   * The same parser underneath, so there is exactly one reading of an 835 in this codebase.
   */
  parseRemittanceAll(raw: string): EdiResult<RemittanceAdvice[]>;

  /**
   * List ERA artifacts the clearinghouse has for this credential, newest work first.
   *
   * Deliberately returns IDENTIFIERS, not money. Discovery and retrieval are separate steps so the
   * id can be written to a durable ledger before anything is fetched — a crash between the two then
   * leaves a record that is retried, rather than a payment nobody knows was offered.
   */
  listRemittanceArtifacts(req: RemittanceArtifactQuery): Promise<EdiResult<RemittanceArtifactPage>>;

  /**
   * Retrieve ONE artifact's original X12, by the id `listRemittanceArtifacts` returned.
   *
   * Raw X12 and nothing else. A vendor's own JSON rendering of an 835 is not an acceptable
   * substitute: it would be a second interpreter of a payer's money file, able to disagree with
   * Mermaid's, and two readings that can disagree is the defect this seam exists to prevent.
   */
  fetchRemittanceArtifact(id: string): Promise<EdiResult<string>>;
}

/** Where to resume ERA discovery from. */
export interface RemittanceArtifactQuery {
  /** Opaque vendor cursor from the previous page. Null on a first poll. */
  cursor: string | null;
  /** ISO instant to start from when there is no cursor yet. */
  since: string;
  limit?: number;
}

/** One ERA file the clearinghouse is holding, before anything about it has been read. */
export interface RemittanceArtifact {
  /** The handle `fetchRemittanceArtifact` takes. Stedi calls this `fileExecutionId`. */
  id: string;
  /** The vendor's own transaction id, for provenance and support tickets. */
  transactionId: string | null;
  /** When the clearinghouse processed it, ISO. Null when the vendor did not say. */
  processedAt: string | null;
}

export interface RemittanceArtifactPage {
  artifacts: RemittanceArtifact[];
  /** Pass back as `cursor` to continue. Null when the vendor has nothing further. */
  nextCursor: string | null;
}
