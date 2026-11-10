/**
 * How Analytics learns what happened — and its entire inbound coupling.
 *
 * This module subscribes to almost every event in the catalog and imports no other module. That is
 * the boundary rule paying off rather than merely being obeyed: a reporting layer that JOINed across
 * four transactional schemas would become the reason none of them could change. Instead each fact is
 * recorded from the event that announced it, in the shape reporting actually needs.
 *
 * Two properties every handler here shares:
 *
 *  • **Idempotent by the source event's id.** The outbox delivers at least once, and a
 *    double-counted fact silently corrupts every number on the dashboard while leaving it looking
 *    entirely plausible. The database's UNIQUE constraint is the real guarantee.
 *
 *  • **The fact records the world as it was.** `occurredAt` is the business moment, not the write
 *    time, and payer names are denormalised onto the row — so a payer renamed next year does not
 *    silently rewrite last year's scorecard, and replaying the log reproduces the same report.
 */
import type { EventBus } from "@mermaid/events";
import type { AnalyticsService } from "./service.ts";

/** Stable subscriber names — these are the outbox's per-subscriber checkpoint keys. */
export const ANALYTICS_SUBSCRIBER = "analytics:record-fact";

/**
 * ── WHICH FACTS ARE ONE-PER-SUBJECT, AND WHICH ARE NOT (NEW-12) ─────────────────────────────────
 *
 * Three of these carry an explicit `dedupeKey`, because their subject produces exactly one fact
 * however many events describe it. The rest deliberately do not:
 *
 *   • `payment_posted`     — a primary and a secondary payer both pay one claim.
 *   • `appeal_outcome`     — a denial can be appealed at two levels, and both outcomes are real.
 *   • `patient_charged`    — a patient is charged many times.
 *   • `patient_collected`  — and pays many times.
 *   • `claim_submitted`    — left as-is deliberately, and it is the arguable one: a REPLACEMENT
 *     (frequency 7) is the same claim refiled, so counting it twice inflates `billed`. Changing it
 *     would move numbers a practice is already reading, and it is a different decision from the one
 *     this fixes — worth making, separately, with the reporting change stated.
 *
 * Those four fall back to `<factType>:<sourceEventId>`, which is exactly what the table enforced
 * before this existed, so nothing about them changes.
 */
export function registerAnalyticsSubscriptions(bus: EventBus, service: AnalyticsService): void {
  bus.subscribe("verification.completed", ANALYTICS_SUBSCRIBER, async (event) => {
    const snapshot = event.payload.coverageSnapshot;
    await service.record({
      sourceEventId: event.id,
      factType: "verification_completed",
      // One completed verification is one visit, however many times it is announced. Re-reviewing a settled record used to publish a second event and count the visit twice.
      dedupeKey: `verification_completed:${event.payload.verificationId}`,
      occurredAt: event.payload.completedAt,
      payerId: snapshot.payerId,
      payerName: snapshot.payerName,
      procedureCode: null,
      carcCode: null,
      verificationId: event.payload.verificationId,
      claimId: null,
      denialId: null,
      amount: event.payload.totalFee,
      expected: snapshot.calculation.totalInsurancePays,
      won: null,
      meta: { settledAs: event.payload.settledAs },
    });
  });

  bus.subscribe("verification.needs_review", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "verification_flagged",
      // The same, from the other side of the ratio: a verification flagged twice is still one visit sent to a human.
      dedupeKey: `verification_flagged:${event.payload.verificationId}`,
      occurredAt: event.payload.raisedAt,
      payerId: null,
      payerName: null,
      procedureCode: null,
      carcCode: null,
      verificationId: event.payload.verificationId,
      claimId: null,
      denialId: null,
      amount: 0 as never,
      expected: 0 as never,
      won: null,
      meta: { confidence: event.payload.confidence, reasons: event.payload.reasons },
    });
  });

  bus.subscribe("claim.submitted", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "claim_submitted",
      occurredAt: event.payload.submittedAt,
      payerId: event.payload.payerId,
      payerName: event.payload.payerName,
      procedureCode: null,
      carcCode: null,
      verificationId: event.payload.verificationId,
      claimId: event.payload.claimId,
      denialId: null,
      amount: event.payload.totalFee,
      expected: event.payload.expectedInsurancePays,
      won: null,
      meta: { serviceDate: event.payload.serviceDate },
    });
  });

  bus.subscribe("remittance.posted", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "payment_posted",
      occurredAt: event.payload.postedAt,
      payerId: event.payload.payerId,
      payerName: event.payload.payerName,
      procedureCode: null,
      carcCode: null,
      verificationId: null,
      claimId: event.payload.claimId,
      denialId: null,
      amount: event.payload.paidAmount,
      expected: event.payload.expectedInsurancePays,
      won: null,
      meta: {
        outcome: event.payload.outcome,
        settled: event.payload.settled,
        contractual: event.payload.contractualAdjustments,
      },
    });
  });

  bus.subscribe("denial.created", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "denial_created",
      // One denial is one denial. A redelivered or re-derived variance must not inflate the denial rate, which is what a biller is measured on.
      dedupeKey: `denial_created:${event.payload.denialId}`,
      occurredAt: event.payload.detectedAt,
      payerId: event.payload.payerId,
      payerName: event.payload.payerName,
      procedureCode: event.payload.procedureCode,
      carcCode: event.payload.carcCode,
      verificationId: null,
      claimId: event.payload.claimId,
      denialId: event.payload.denialId,
      amount: event.payload.deniedAmount,
      expected: event.payload.expectedRecovery,
      won: null,
      meta: { disposition: event.payload.disposition, overturnRate: event.payload.overturnRate },
    });
  });

  /**
   * The patient side of the money (M9).
   *
   * Analytics counts BOTH halves of every dollar, or its collection figures are a half-truth — and
   * it counts them through events rather than by reading the ledger's tables, exactly as it does for
   * every other context.
   */
  bus.subscribe("patient.charged", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "patient_charged",
      occurredAt: event.payload.occurredAt,
      payerId: null,
      payerName: null,
      procedureCode: null,
      carcCode: null,
      verificationId: null,
      claimId: event.payload.claimId,
      denialId: event.payload.denialId,
      amount: event.payload.amount,
      expected: event.payload.amount,
      won: null,
      meta: { patientKey: event.payload.patientKey },
    });
  });

  bus.subscribe("patient.payment.recorded", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "patient_collected",
      occurredAt: event.payload.occurredAt,
      payerId: null,
      payerName: null,
      procedureCode: null,
      carcCode: null,
      verificationId: null,
      claimId: null,
      denialId: null,
      amount: event.payload.amount,
      expected: event.payload.amount,
      // Money that ARRIVED, versus money the practice forgave. Both reduce a balance; only one is
      // revenue, and a report that conflated them would flatter every clinic that writes debt off.
      won: event.payload.kind === "payment",
      meta: { patientKey: event.payload.patientKey, kind: event.payload.kind },
    });
  });

  bus.subscribe("appeal.outcome.recorded", ANALYTICS_SUBSCRIBER, async (event) => {
    await service.record({
      sourceEventId: event.id,
      factType: "appeal_outcome",
      occurredAt: event.payload.recordedAt,
      payerId: event.payload.payerId,
      payerName: event.payload.payerName,
      procedureCode: event.payload.procedureCode,
      carcCode: event.payload.carcCode,
      verificationId: null,
      claimId: event.payload.claimId,
      denialId: event.payload.denialId,
      // `amount` is what actually came back; `expected` is what was at stake. Both are needed to
      // report a recovery rate honestly.
      amount: event.payload.recoveredAmount,
      expected: event.payload.deniedAmount,
      won: event.payload.won,
      meta: { level: event.payload.level },
    });
  });
}
