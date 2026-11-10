/**
 * Claim builder — turns a completed verification's coverage snapshot into a claim draft.
 *
 * The one rule that matters here: this function COPIES, it does not CALCULATE. Every line's fee,
 * expected insurance payment and expected patient payment is read straight out of the inherited
 * snapshot. There is deliberately no benefits logic in this module at all — if a number here could
 * disagree with the number the patient was quoted, the whole estimate-vs-actual thesis collapses
 * (blueprint doc 00, doc 11).
 *
 * Pure and deterministic: same snapshot + same clock → same claim, byte for byte apart from the id.
 */
import { randomUUID } from "node:crypto";
import { addCents, type Cents, type CoverageSnapshot, type PayerWindowSource } from "@mermaid/shared";
import { filingDeadline } from "./deadline.ts";
import type { Claim, ClaimAuditEvent, ClaimLine, ClaimPatient, SubscriberAddress } from "../types.ts";

export interface ClaimDraftInput {
  verificationId: string;
  patient: ClaimPatient;
  coverageSnapshot: CoverageSnapshot;
  /**
   * ISO date of service. Defaults to the verification date — in a dental clinic the estimate is
   * produced at or just before the visit, so that is the honest default rather than "today".
   */
  serviceDate?: string;
  /**
   * This payer's filing window from the payer catalog, when it has one.
   *
   * Supplied by the caller rather than looked up here, so this stays a pure function. Omitted or
   * null means "the catalog does not know", and the deadline engine falls back to its own documented
   * default — an unknown payer must still get a deadline.
   */
  filingWindowDays?: number | null;
  /**
   * The payer's own citation for `filingWindowDays`, or null when that window is an estimate (B-1).
   *
   * Only meaningful beside a catalogued window: when the engine falls back to its own table, the
   * date is Mermaid's, and it is recorded as unsourced whatever was passed here.
   */
  filingWindowSource?: PayerWindowSource | null;
}

/**
 * The clinic-side control number (CLM01) presented to the payer. Derived from the claim id so it is
 * stable across resubmissions: a payer recognizing a repeat control number is what stops the same
 * treatment being paid twice.
 */
export function patientControlNumber(claimId: string): string {
  return `MRM-${claimId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/**
 * Put a subscriber address into the shape an 837 carries, or refuse it.
 *
 * Returns undefined for anything incomplete, because a HALF address is not a smaller correction —
 * it satisfies the scrubber's presence check and is then rejected by the payer after filing, which
 * is the expensive way to discover it. Uppercases the state and strips ZIP hyphens so a form can
 * accept what staff actually type without the scrubber's format rules firing on it a moment later.
 *
 * Deliberately mirrors verification's `normalizeAddress` rather than importing it: modules do not
 * depend on each other. Both are held to the same behaviour by their own tests.
 */
export function normalizeClaimAddress(address: SubscriberAddress | undefined | null): SubscriberAddress | undefined {
  if (!address) return undefined;
  const street = address.street?.trim();
  const city = address.city?.trim();
  const state = address.state?.trim().toUpperCase();
  const zip = address.zip?.trim().replace(/-/g, "");
  if (!street || !city || !state || !zip) return undefined;
  return { street, city, state, zip };
}

export function buildClaimDraft(input: ClaimDraftInput, now: Date = new Date()): Claim {
  const snapshot = input.coverageSnapshot;
  const serviceDate = (input.serviceDate ?? snapshot.verifiedAt).slice(0, 10);
  const id = randomUUID();

  const lines: ClaimLine[] = snapshot.calculation.lines.map((line, index) => ({
    lineNumber: index + 1,
    code: line.code,
    description: line.description,
    category: line.category,
    ...(line.toothNumber ? { toothNumber: line.toothNumber } : {}),
    quantity: line.quantity,
    // Inherited verbatim — never recomputed.
    fee: line.fee,
    expectedInsurancePays: line.insurancePays,
    expectedPatientPays: line.patientPays,
    // Copied, never recomputed — the claim must not re-derive a contract it did not read.
    ...(line.contractualWriteOff ? { contractualWriteOff: line.contractualWriteOff } : {}),
    /**
     * The pre-authorisation requirement, inherited like every other figure on this line. The claim
     * never re-derives it: the answer belongs to the benefits snapshot that was read BEFORE
     * treatment, and re-asking now would silently substitute today's plan rules for the ones in
     * force when the patient was in the chair.
     */
    ...(line.preAuth ? { preAuthRequirement: line.preAuth.requirement } : {}),
    ...(line.preAuthRiskAmount ? { preAuthRiskAmount: line.preAuthRiskAmount } : {}),
    estimatedDenied: line.denied,
    serviceDate,
  }));

  const audit: ClaimAuditEvent[] = [
    {
      timestamp: now.toISOString(),
      actor: "system",
      message:
        `Claim drafted from verification ${input.verificationId} ` +
        `(coverage snapshot v${snapshot.snapshot_version}, verified ${snapshot.verifiedAt.slice(0, 10)}).`,
    },
  ];

  return {
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "draft",
    verificationId: input.verificationId,
    // Deep-cloned: the claim's copy of the estimate must be unreachable from anything else.
    coverageSnapshot: structuredClone(snapshot),
    patient: { ...input.patient },
    payer: {
      payerId: snapshot.payerId,
      payerName: snapshot.payerName,
      planName: snapshot.planName,
      groupNumber: snapshot.groupNumber,
    },
    serviceDate,
    filingDeadline: filingDeadline(serviceDate, snapshot.payerId, input.filingWindowDays),
    // Written only when the payer's own document stands behind the date above. Absent means an
    // estimate — which is also what every claim written before B-1 correctly reads as.
    ...(input.filingWindowSource && input.filingWindowDays && input.filingWindowDays > 0
      ? { filingWindowSource: input.filingWindowSource }
      : {}),
    lines,
    totalFee: sum(lines.map((l) => l.fee)),
    ...(sum(lines.map((l) => l.contractualWriteOff ?? (0 as Cents))) > 0
      ? { totalContractualWriteOff: sum(lines.map((l) => l.contractualWriteOff ?? (0 as Cents))) }
      : {}),
    expectedInsurancePays: sum(lines.map((l) => l.expectedInsurancePays)),
    expectedPatientPays: sum(lines.map((l) => l.expectedPatientPays)),
    scrub: null,
    submission: null,
    payments: [],
    voidReason: null,
    filingRiskRaised: null,
    audit,
  };
}

const sum = (values: Cents[]): Cents => addCents(...values);
