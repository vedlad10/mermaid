/**
 * Verification's outbound event mapping — record → domain-event payload.
 *
 * This is the module's entire outward surface. Claims, Analytics and the Today queue learn about
 * verifications through these payloads and nothing else; they never import this module, never read
 * its tables, never call its service (docs/MODULE-BOUNDARIES.md). Anything a consumer needs must be
 * IN the payload, which is why `verification.completed` carries the full coverage snapshot.
 *
 * Pure functions, no I/O — the service decides when to publish, this decides what.
 */
import type { VerificationCompletedBody, VerificationNeedsReviewBody } from "@mermaid/events";
import { buildCoverageSnapshot } from "./engine/snapshot.ts";
import { decideVerification } from "./engine/decision.ts";
import { reviewReasons } from "./engine/summary.ts";
import type { VerificationRecord } from "./types.ts";

/**
 * Build the `verification.completed` payload, or `null` if this record is not billable.
 *
 * Not billable means: the record has not settled (`verified` / `reviewed`), or it has no coverage
 * snapshot to inherit. Both are hard gates — an unreviewed or unbacked estimate must never reach
 * billing, so this returns null rather than a partial payload.
 */
export function buildCompletedEvent(record: VerificationRecord): VerificationCompletedBody | null {
  if (record.status !== "verified" && record.status !== "reviewed") return null;
  const coverageSnapshot = buildCoverageSnapshot(record);
  if (!coverageSnapshot) return null;

  return {
    verificationId: record.id,
    completedAt: record.review?.reviewedAt ?? record.createdAt,
    settledAs: record.status,
    patient: {
      firstName: record.patient.firstName,
      lastName: record.patient.lastName,
      dateOfBirth: record.patient.dateOfBirth,
      memberId: coverageSnapshot.memberId ?? record.patient.memberId,
      // The claim inherits the address exactly as it inherits the coverage snapshot: recorded at
      // the moment of verification, never re-derived later from a record that may have moved on.
      ...(record.patient.address ? { address: { ...record.patient.address } } : {}),
      ...(record.patient.gender ? { gender: record.patient.gender } : {}),
      /**
       * The relationship travels with the money, exactly as the address does (NEW-01).
       *
       * `memberId` above is the POLICY's — a dental family shares the subscriber's — so without
       * these two fields billing receives a dependent's claim indistinguishable from the policy
       * holder's, and files them as the subscriber. Only emitted when the patient is NOT the
       * subscriber, so an ordinary verification's payload is byte-for-byte what it always was.
       */
      ...(record.patient.relationship && record.patient.relationship !== "self"
        ? {
            relationship: record.patient.relationship,
            ...(record.patient.subscriber ? { subscriber: { ...record.patient.subscriber } } : {}),
          }
        : {}),
    },
    coverageSnapshot,
    patientResponsibility: coverageSnapshot.calculation.totalPatientPays,
    totalFee: coverageSnapshot.calculation.totalFee,
  };
}

/** Build the `verification.needs_review` payload, or `null` if this record does not need a human. */
export function buildNeedsReviewEvent(
  record: VerificationRecord,
  now: Date = new Date()
): VerificationNeedsReviewBody | null {
  if (record.status !== "needs_review" && record.status !== "failed") return null;
  const decision = decideVerification(record, now);
  return {
    verificationId: record.id,
    raisedAt: now.toISOString(),
    patientName: `${record.patient.firstName} ${record.patient.lastName}`.trim() || "Unnamed patient",
    confidence: record.confidence.overall,
    reasons: reviewReasons(record),
    priority: decision.priority,
  };
}
