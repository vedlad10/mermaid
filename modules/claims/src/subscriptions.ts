/**
 * How the Claims context learns about the world.
 *
 * These three subscriptions are the module's entire inbound coupling. There is no import of
 * `@mermaid/verification` or `@mermaid/remittance` anywhere in `modules/claims` — CI enforces that
 * (docs/MODULE-BOUNDARIES.md), and this file is what replaces it.
 *
 *   verification.completed → build the claim (it inherits the estimate)
 *   remittance.posted      → record the payment and settle the claim
 *   denial.recovery.settled → mark how much of that payment was won on appeal
 *
 * Both handlers are deliberately thin, and both underlying service methods are idempotent, so a
 * redelivery after a partial failure is safe. Every business rule about *whether* something should
 * happen lives on the producing side — a completed event is only emitted for a settled verification
 * carrying a snapshot, and a posted event only for a balanced, matched payment.
 */
import type { EventBus } from "@mermaid/events";
import type { ClaimService } from "./service.ts";

/** Stable subscriber names — these are the outbox's per-subscriber checkpoint keys. */
export const CLAIMS_SUBSCRIBER = "claims:create-from-verification";
export const CLAIMS_PAYMENT_SUBSCRIBER = "claims:record-payment";
export const CLAIMS_APPEAL_RECOVERY_SUBSCRIBER = "claims:record-appeal-recovery";

export function registerClaimsSubscriptions(bus: EventBus, service: ClaimService): void {
  bus.subscribe("verification.completed", CLAIMS_SUBSCRIBER, async (event) => {
    await service.createFromVerification(event.payload, new Date(event.occurredAt));
  });

  bus.subscribe("remittance.posted", CLAIMS_PAYMENT_SUBSCRIBER, async (event) => {
    await service.recordPayment(event.payload, new Date(event.occurredAt));
  });

  /**
   * Why Claims listens to a DENIALS event (F-7): cash won on appeal is real money on this claim, and
   * a claim that cannot tell it apart from an overpayment reports the practice's own recovery as a
   * possible duplicate. Denials knows an award settled; only Claims can explain the payment it
   * already recorded. The event is the seam — Remittance subscribes to this same event for its own
   * unrelated reason (F-5), which is the outbox working as designed.
   */
  bus.subscribe("denial.recovery.settled", CLAIMS_APPEAL_RECOVERY_SUBSCRIBER, async (event) => {
    await service.recordAppealRecovery(event.payload, new Date(event.occurredAt));
  });
}
