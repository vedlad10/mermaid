# 04 — Shared Data Model (domain view)

*Blueprint doc 4 of 16. The database schema (doc 03) made concrete as TypeScript. These types live
in `packages/shared/src/domain/` and are the contract every module agrees on. Storage-shape and
API-shape derive from these — one model, one source of truth.*

## Cross-cutting primitives (`@mermaid/shared`)

```ts
// ids.ts — branded ids prevent mixing a ClaimId where a PatientId belongs.
export type PracticeId = string & { readonly __b: "PracticeId" };
export type PatientId  = string & { readonly __b: "PatientId" };
export type ClaimId    = string & { readonly __b: "ClaimId" };
// … CoverageId, VerificationId, RemittanceId, DenialId, AppealId, PayerId, UserId

// money.ts — money is integer CENTS, never a float. All math in cents; format at the edge.
export type Cents = number & { readonly __b: "Cents" };
export const cents = (dollars: number): Cents => Math.round(dollars * 100) as Cents;

// snapshot.ts (P0 ✓) — every persisted JSONB doc carries snapshot_version.
export interface Versioned { snapshot_version: number; }

// The universal AI/heuristic output contract (donor doctrine, roadmap §7):
export interface Scored<T> { value: T; confidence: number; explanation: string; }
```

## Patient Financial Record — the spine

The **one** entity the whole workflow threads through (`unified-rcm-workflow.mermaid`). It is not a
single table but a *composition* keyed on `patient_id`: the patient, their coverages, and every
verification / claim / remittance / denial / appeal that references them, unified by a timeline.

```ts
export interface Patient {
  id: PatientId; practiceId: PracticeId;
  chartId: string; firstName: string; lastName: string; dob: string; // ISO
}

export interface Coverage {
  id: CoverageId; practiceId: PracticeId; patientId: PatientId; payerId: PayerId;
  memberId: string; groupNumber?: string; planType?: "PPO" | "HMO" | "indemnity";
  effectiveDate?: string; termDate?: string; cobOrder: 1 | 2 | 3;
  benefitSnapshot: BenefitSnapshot | null;   // versioned
  // rawCardText is stored encrypted, never in the domain object passed around.
}
```

## Verification & estimate (front half — from Dental Verify types)

```ts
export type VerificationStatus = "verified" | "needs_review" | "reviewed" | "failed";
export type ProcedureCategory = "diagnostic" | "preventive" | "basic" | "major" | "orthodontic";

export interface BenefitSnapshot extends Versioned {
  eligibility: "active" | "inactive" | "unknown";
  planName: string;
  deductible: { individualAnnual: Cents; remaining: Cents; appliesTo: ProcedureCategory[] };
  annualMaximum: { amount: Cents; used: Cents; remaining: Cents };
  coveragePercentages: Record<ProcedureCategory, number>;
  waitingPeriods: { category: ProcedureCategory; months: number; coverageEffectiveDate: string }[];
  frequencyLimits: { codes: string[]; limit: number; period: string; used: number }[];
  exclusions: string[]; excludedCodes: string[];
}

export interface CoverageLine {
  code: string; description: string; category: ProcedureCategory; quantity: number;
  fee: Cents; coveragePercent: number; deductibleApplied: Cents;
  insurancePays: Cents; patientPays: Cents; notes: string[]; denied: boolean;
}

export interface Verification {
  id: VerificationId; practiceId: PracticeId; patientId: PatientId; coverageId: CoverageId;
  status: VerificationStatus;
  confidence: Scored<null> & { components: { name: string; confidence: number; explanation: string }[]; reviewThreshold: number };
  benefits: BenefitSnapshot | null;
  plannedProcedures: { code: string; toothNumber?: string; quantity: number; fee: Cents }[];
  estimate: { lines: CoverageLine[]; insurancePays: Cents; patientOwes: Cents; totalFee: Cents } | null;
  exceptions: { severity: "info" | "warning" | "critical"; code: string; message: string }[];
  validUntil: string; dataSource: "edi" | "portal" | "manual" | "mock";
  review: { decision: "approved" | "overridden" | "rejected"; notes: string; reviewedAt: string } | null;
  createdAt: string;
}
```

## Claim lifecycle (back half — from AI Remit, with inheritance)

```ts
export type ClaimState =
  | "draft" | "scrubbed" | "submitted" | "acknowledged" | "in_adjudication"
  | "paid" | "partially_paid" | "denied" | "appealed" | "reprocessed" | "closed" | "void";

export interface Claim {
  id: ClaimId; practiceId: PracticeId; patientId: PatientId;
  verificationId: VerificationId | null;      // INHERITANCE, not re-derivation
  coverageSnapshot: CoverageSnapshot;         // immutable copy taken at claim creation (versioned)
  state: ClaimState; provider: string; dos: string;
  totalCharged: Cents; paid: Cents; adjusted: Cents; patientResp: Cents;
  submittedAt?: string; filingDeadline?: string; externalNo?: string; notes: string;
}

export interface ClaimLine {
  id: string; claimId: ClaimId; cdtCode: string; description: string;
  toothSurfQuad?: string; fee: Cents;
  estimatedInsurancePays: Cents;              // carried from verification → powers variance
  paid: Cents; patientResp: Cents; adjustments: CasAdjustment[]; status: string;
}
export interface CasAdjustment { group: "CO" | "PR" | "PI" | "OA"; carc: string; amount: Cents; cdt?: string; }
```

## Remittance, denial, appeal

```ts
export interface Remittance {
  id: RemittanceId; practiceId: PracticeId; payerId?: PayerId; traceNumber: string;
  method: string; checksum: string; totalAmount: Cents; receivedAt: string;
  status: "new" | "posted" | "partial" | "exception"; exceptionsCount: number;
}
export interface Posting {
  id: string; practiceId: PracticeId; remittanceId: RemittanceId; claimId: ClaimId;
  paid: Cents; adjusted: Cents; patientResp: Cents; autoPosted: boolean;
  reversedBy?: string; reversalReason?: string; postedAt: string;
}
export interface Denial {
  id: DenialId; practiceId: PracticeId; claimId: ClaimId; claimLineId?: string; remittanceId?: RemittanceId;
  carcCode: string; rarcCode?: string; groupCode: string; cdtCode?: string;
  amount: Cents; recoverableValue: Cents; category: string; disposition: string;
  overturnScore: number; deadline: string;
  status: "new" | "working" | "resubmitted" | "appealed" | "patient_resp" | "written_off" | "recovered" | "closed";
}
export interface Appeal {
  id: AppealId; practiceId: PracticeId; denialId: DenialId; level: number;
  status: "pending" | "submitted" | "won" | "lost";
  playbookRuleId?: string; letterText: string; checklist: string[];
  submittedAt?: string; outcome: "pending" | "overturned" | "partial" | "upheld" | "withdrawn";
  recovered: Cents; submittedBy?: UserId; outcomeRecordedAt?: string;
}
```

## Timeline & events

```ts
export interface TimelineEvent {
  id: string; practiceId: PracticeId; claimId?: ClaimId; patientId?: PatientId;
  eventType: "created" | "verification_completed" | "estimate_ready" | "submitted"
           | "posted" | "denied" | "appealed" | "resolved" | "reconciled";
  actor: "ai" | "system" | UserId; detail: Versioned & Record<string, unknown>; occurredAt: string;
}
```

## Two modeling rules that matter more than the rest (roadmap §3)

1. **Inheritance over reference.** `Claim.coverageSnapshot` is copied at creation and never mutates.
   Coverage can change (renewal, job change) without silently altering a claim already estimated
   against the old plan. `verification_id` links back for provenance; the snapshot is the truth used.
2. **The event is the seam, not the SQL join.** Modules never share these objects by reading each
   other's tables. A module emits a domain event whose payload carries exactly the shape the
   consumer needs (doc 05). That is why every payload is `Versioned`.
