/**
 * Coverage-snapshot builder — freezes a completed verification into the immutable document a claim
 * inherits (blueprint doc 00 keystone: `claims.verification_id` + `coverage_snapshot`).
 *
 * Pure and total: it COPIES what the pipeline already computed and never recalculates benefit math.
 * That is the whole point — if the claim could re-derive the estimate, the two could drift, and
 * estimate-vs-actual reconciliation would compare Mermaid against Mermaid instead of against the
 * payer.
 *
 * Returns `null` when there is nothing to freeze (no benefits or no calculation). A verification
 * without benefits is not billable, and inventing an empty snapshot would let an unbacked claim
 * through — so the absence is explicit, not a default.
 */
import { COVERAGE_SNAPSHOT_VERSION, withVersion, type CoverageSnapshot } from "@mermaid/shared";
import type { VerificationRecord } from "../types.ts";

export function buildCoverageSnapshot(record: VerificationRecord): CoverageSnapshot | null {
  if (!record.benefits || !record.calculation) return null;

  return withVersion(
    {
      verificationId: record.id,
      verifiedAt: record.createdAt,
      payerId: record.payerId ?? null,
      payerName: record.benefits.payerName ?? record.card.payerName.value ?? null,
      planName: record.benefits.planName ?? record.card.planName.value ?? null,
      memberId: record.card.memberId.value ?? record.patient.memberId ?? null,
      groupNumber: record.card.groupNumber.value ?? null,
      // Deep-cloned so a later mutation of the record can never reach into a frozen snapshot.
      benefits: structuredClone(record.benefits),
      calculation: structuredClone(record.calculation),
      confidence: record.confidence.overall,
      source: record.dataSource,
    },
    COVERAGE_SNAPSHOT_VERSION
  );
}
