/**
 * Verification bounded-context types. The estimate/benefit types are shared (the claim inherits the
 * estimate); the verification *record* and its provenance live here in the module. Ported from
 * Dental Verify's `types.ts`; money-bearing fields reference the shared cents-based domain types.
 *
 * Every AI/heuristic output carries a confidence + explanation (donor doctrine): see ExtractedField,
 * ConfidenceReport. Union types only (no enums) so the sources run under Node's type-stripping.
 */
import type {
  Benefits,
  CoverageCalculation,
  SubscriberIdentity,
  SubscriberRelationship,
  TreatmentPlanItem,
} from "@mermaid/shared";

/**
 * A single field extracted from an insurance card, with provenance.
 *
 * `source` distinguishes the three ways a value gets here, and the distinction is worth keeping
 * because they fail differently: `ocr` is a regex over typed or pasted card text, `vision` is a
 * model reading a photograph (cross-checked against the regex engine — see `engine/card-vision.ts`),
 * and `manual` is a person who typed it. Adding `vision` needs no record migration: it is a new
 * value for an existing field, so old records still read correctly and simply never carry it.
 */
export interface ExtractedField {
  value: string | null;
  confidence: number;
  source: "ocr" | "vision" | "manual";
  explanation: string;
}

export interface InsuranceCardData {
  payerName: ExtractedField;
  memberId: ExtractedField;
  groupNumber: ExtractedField;
  planName: ExtractedField;
  subscriberName: ExtractedField;
  effectiveDate: ExtractedField;
}

export interface PatientInfo {
  firstName: string;
  lastName: string;
  /** ISO date, e.g. "1990-04-12". */
  dateOfBirth: string;
  /** Member ID as typed by staff (cross-checked against OCR). */
  memberId: string;
  phone?: string;
  email?: string;
  /**
   * Where the patient lives — 837D loop 2010BA N3/N4, and DMG03 for gender.
   *
   * ── WHY THIS IS OPTIONAL AND WHY IT MATTERS ANYWAY ────────────────────────────────────────────
   * A dental claim cannot be filed without it: when the patient is the subscriber (SBR02 = 18),
   * which is the ordinary case, the payer requires the subscriber’s address to determine network
   * and jurisdiction. A real clearinghouse rejects the 837 outright without it.
   *
   * Optional in the TYPE because a verification is not a claim. Coverage can be checked, an estimate
   * produced and a patient quoted with nothing but a name, a date of birth and a member id — and
   * refusing to verify someone because their address is missing would stop the front desk doing the
   * one thing it needs to do at check-in. The address becomes mandatory at the SUBMIT gate, where a
   * scrubber rule blocks filing, which is the point at which it is actually required.
   *
   * Never invent one. An address on a claim is a statement to the payer about where a patient lives;
   * a plausible placeholder is a false statement that reaches an insurer under the practice’s NPI.
   */
  address?: PatientAddress;
  /** DMG03. `U` is a valid X12 answer and the honest default when nobody has asked. */
  gender?: "M" | "F" | "U";
  /**
   * What this patient is to the policy `memberId` names. Absent means `self` (NEW-01).
   *
   * ── WHY A VERIFICATION IS WHERE THIS IS LEARNED ───────────────────────────────────────────────
   * A dental plan issues ONE member ID to the subscriber and covers the spouse and children under
   * it. So `memberId` above does not identify this patient — it identifies their POLICY, and the
   * only moment the system can tell a child from the parent whose card was handed over is here, at
   * check-in, where a person reads the card and knows who is in the chair.
   *
   * Everything downstream depends on it: `coverages` keys on (member ID, patient) so a sibling
   * cannot steal the row, the patient ledger refuses to guess whose money it is, and the 837D emits
   * loop 2000C naming the dependent instead of filing them as the policy holder.
   *
   * Absent means `self` on purpose, so every verification recorded before dependents were modelled
   * reads as what it was: a patient treated as the subscriber.
   */
  relationship?: SubscriberRelationship;
  /**
   * Who holds the policy, when it is not this patient. Required in practice whenever
   * `relationship` is anything but `self` — an 837D for a dependent must name the subscriber in
   * loop 2010BA, and a claim cannot be built without it.
   *
   * Optional in the TYPE for the same reason the address is: a verification is not a claim, and a
   * front desk that has not yet keyed the policy holder's name must still be able to check
   * eligibility. The submit gate is where it becomes mandatory.
   */
  subscriber?: SubscriberIdentity;
}

export interface PatientAddress {
  /** N301 — street. A PO box is not acceptable to most payers as a service address. */
  street: string;
  city: string;
  /** Two-letter USPS code. */
  state: string;
  /** 5 or 9 digits, no hyphen — the shape an 837 carries. */
  zip: string;
}

export interface ExceptionFlag {
  severity: "info" | "warning" | "critical";
  code:
    | "inactive-coverage"
    /**
     * The payer stated nothing about eligibility. Deliberately NOT `inactive-coverage` (M18): both
     * route to a human, but one means "find other coverage or collect from the patient" and the
     * other means "ring the payer, this may be perfectly good". Reporting silence as a refusal
     * loses cases that would have been paid.
     */
    | "eligibility-unknown"
    | "waiting-period"
    | "exclusion"
    /**
     * The payer never stated a coverage percentage for this line's category, so whether the plan
     * covers it is UNKNOWN. Deliberately NOT `exclusion`, for the same reason `eligibility-unknown`
     * is not `inactive-coverage`: both send the line to a human, but one means "the plan says no"
     * and the other means "the payer did not say — ask them". Only the first may be repeated to a
     * patient as a reason their treatment is not covered.
     */
    | "coverage-unknown"
    /**
     * The CDT code is not in Mermaid's catalog, so no benefit rule was applied to the line.
     *
     * Deliberately NOT `exclusion`, which is where it used to land by falling off the end of the
     * classifier. An exclusion is the payer naming a code it will not pay for; this is Mermaid not
     * recognising the code at all. Only the first is a fact about the plan.
     */
    | "procedure-unrecognized"
    | "frequency-limit"
    | "annual-max-exhausted"
    /**
     * The payer stated no remaining annual maximum. Distinct from `annual-max-exhausted` (M4):
     * a `?? 0` used to collapse the two, so a payer that simply did not say produced "no benefits
     * remain this year" — a statement about the plan nobody made.
     */
    | "annual-max-unknown"
    | "annual-max-near-limit"
    /**
     * The payer stated no remaining deductible, so the estimate assumed the full annual amount is
     * unmet. Conservative in the patient's favour to be wrong about, but it IS an assumption and the
     * figure sits directly on what the patient is told they owe (M4).
     */
    | "deductible-unknown"
    /**
     * The payer stated no coverage percentage for one or more categories. Those lines are quoted as
     * fully the patient's, which is an unknown rather than the plan exclusion it used to be
     * reported as (M17).
     */
    | "coverage-percent-unknown"
    | "member-id-mismatch"
    /**
     * Nothing here could reach this payer at all: the card names a plan the registry has never heard
     * of, or holds no route to. The remedy is a person with a phone, and possibly an administrator
     * adding the payer to the catalog.
     */
    | "unknown-payer"
    /**
     * ── THE PAYER ANSWERED, AND THE ANSWER CARRIED NO BENEFITS (audit C-7) ─────────────────────
     *
     * Both of these used to be `unknown-payer`, because `detectExceptions` sees only `benefits ===
     * null` and cannot tell why. So a live 270 to Aetna that came back `AAA*72` — a real 271, from
     * the right payer, refusing the member ID — reached the front desk as "unknown payer: benefits
     * could not be retrieved", under an action reading "electronic verification isn't available for
     * this card".
     *
     * Every clause of that is false. The payer was identified. Electronic verification IS available.
     * The one thing wrong was the member ID, which is the single most fixable thing on the screen and
     * the one thing the message did not mention. A coordinator told "this payer cannot be checked
     * electronically" rings the payer; a coordinator told "Aetna says this member ID is not one of
     * theirs" looks at the card again, which is thirty seconds and usually the whole answer.
     *
     * The distinction is drawn here rather than in prose because two different people do two
     * different things with it — which is the only reason this codebase ever splits a code.
     */
    | "benefits-unavailable"
    | "low-ocr-confidence"
    /**
     * Two independent readings of the same printed field disagree (workflow S2's "low confidence →
     * confirm / correct"). Raised only for the fields a claim cannot survive being wrong about.
     *
     * It is CRITICAL rather than a warning, and that severity is the whole point of the code
     * existing. Lowering the field's confidence alone was not enough: the overall score is a
     * weighted average across four components, so one contested member ID against three healthy
     * signals still cleared the auto-verify threshold — the card would have been believed and the
     * wrong ID filed. A disagreement about which identifier is on the card is not a weak signal to
     * be averaged; it is a question only the person holding the card can answer.
     */
    | "card-reading-contested"
    /**
     * The payer's 271 echoed a subscriber that is not the one we asked about — a different member ID
     * or a different date of birth (M10).
     *
     * Critical, and it must be: a member ID wrong in a way that still RESOLVES returns a healthy
     * response describing somebody else's plan. Nothing else in the verification can tell, because
     * every number in it is internally consistent — it is just the wrong person's.
     */
    | "subscriber-mismatch"
    /**
     * This verification resolved to an EXISTING chart, and the same payer already has a DIFFERENT
     * member ID on file for that chart — so the two visits may not be the same person (M14).
     *
     * Critical, and for the same reason `subscriber-mismatch` is: nothing downstream can tell. The
     * verification is internally consistent, the claim files cleanly, and the money posts to a
     * ledger `unifiedStatement` has merged — one patient's statement carrying another's balance,
     * and a payment from one reducing the other's. A billing dispute and a PHI disclosure in the
     * same document, and the first person to notice is a patient.
     *
     * It is a QUESTION, not a verdict. Nothing is merged, unmerged, re-keyed or reassigned by this
     * flag; the chart resolution that already happened stands until a human says otherwise.
     */
    | "identity-collision"
    | "data-validation"
  /** The payer said active, but the policy was not in force on the DATE OF SERVICE. */
  | "coverage-terminated"
  | "coverage-not-yet-effective";
  message: string;
}

export interface ConfidenceComponent {
  name: string;
  confidence: number;
  explanation: string;
}

export interface ConfidenceReport {
  overall: number;
  components: ConfidenceComponent[];
  /** Threshold below which the case is routed to manual review. */
  reviewThreshold: number;
}

/**
 * What the shared brain knows about a payer's own reliability, as this module needs it.
 *
 * A narrow port rather than an import of the payer profile's own richer type: this module needs one
 * number and one sentence, and depending on the whole shape would couple verification to a service
 * it has no business knowing the internals of. The composition root adapts one to the other.
 *
 * `confidence` is null when there is not enough recorded evidence to say anything — in which case no
 * confidence component is added at all. Absence and neutrality are different: a neutral 1.0 would
 * raise the score of every verification for every payer we know nothing about.
 */
export interface PayerTrackRecord {
  confidence: number | null;
  explanation: string;
}

/**
 * Resolves a payer's track record at verification time.
 *
 * Injected exactly as the EDI adapter is, and for the same two reasons: the pipeline stays testable
 * with a stub, and the source stays swappable. A stub returning a fixed value is also what keeps the
 * pipeline's own tests deterministic once real outcomes start moving the number.
 */
export interface PayerAccuracyProvider {
  forPayer(payerId: string | null): Promise<PayerTrackRecord>;
}

/** The default: knows nothing, so contributes nothing. Used wherever no provider is wired. */
export const NoPayerHistory: PayerAccuracyProvider = {
  async forPayer(): Promise<PayerTrackRecord> {
    return { confidence: null, explanation: "No payer history is wired into this process." };
  },
};

export interface AuditEvent {
  timestamp: string;
  actor: "system" | "staff";
  message: string;
}

export type VerificationStatus = "verified" | "needs_review" | "reviewed" | "failed";

export interface ReviewDecision {
  decision: "approved" | "overridden" | "rejected";
  notes: string;
  reviewedAt: string;
}

/** The full record produced by the verification pipeline (persisted with the DB layer). */
export interface VerificationRecord {
  id: string;
  createdAt: string;
  status: VerificationStatus;
  patient: PatientInfo;
  card: InsuranceCardData;
  planItems: TreatmentPlanItem[];
  benefits: Benefits | null;
  calculation: CoverageCalculation | null;
  exceptions: ExceptionFlag[];
  confidence: ConfidenceReport;
  reportText: string;
  review: ReviewDecision | null;
  audit: AuditEvent[];
  /** Where the benefits came from (mock connector vs. live payer). */
  dataSource: "edi" | "portal" | "manual" | "mock";
  /**
   * Canonical payer id resolved during identification (null when no connector matched). Carried on
   * the record — not just logged — because the coverage snapshot and every downstream claim need a
   * stable payer key, and re-deriving it from a free-text card name later would be guesswork.
   */
  payerId: string | null;
  /** Raw X12 271 for provenance (stored encrypted when persisted). */
  raw271?: string | null;
  /**
   * Benefit segments the payer stated for a scope this quote did not use — family where the
   * individual was read, out-of-network where the practice is in network (M24, instance 4).
   *
   * Optional because records written before this existed do not carry it, and absent is not zero:
   * `null`/`undefined` means "never counted", `0` means "the payer offered nothing we discarded".
   * Nothing is gated on it; it exists so a coordinator can see it before quoting a patient.
   */
  supersededBenefits?: number | null;
  /** Original card text — lets a stale verification be re-run without re-entry. */
  cardText?: string;
  /**
   * Which patient master record this verification belongs to (M14 deliverable 4).
   *
   * OPTIONAL, and it has to be: migration 0006 created `verifications.patient_id` nullable with a
   * comment saying it "becomes NOT NULL when the verification flow writes `patients` rows (it reads
   * them today, it does not create them)". Since M14 part 1 the flow does write them, so this is
   * finally populated — but every record written before that carries no such field, and a document
   * read back from months ago must not be typed as though it did.
   *
   * The pipeline does not produce it; the service sets it when the patient master is wired, which is
   * why it is absent in the unit tests that drive the pipeline directly. That is correct: a
   * verification is a complete, valid aggregate without knowing its patient row's primary key.
   */
  patientId?: string | null;
}
