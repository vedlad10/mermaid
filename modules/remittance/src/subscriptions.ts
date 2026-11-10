/**
 * How the Remittance context learns what the clinic is owed.
 *
 * One subscription, and it is the module's entire inbound coupling. Remittance never imports Claims
 * and never reads its tables (docs/MODULE-BOUNDARIES.md) — instead it builds its own expectation
 * ledger from `claim.submitted` events as they arrive.
 *
 * This is what makes estimate-vs-actual possible across a module boundary: by the time an 835 lands
 * weeks later, the claim's expectation is already recorded here, keyed on the control number the
 * payer will echo back. Nothing needs to be looked up in another context at posting time.
 */
import type { EventBus } from "@mermaid/events";
import type { RemittanceService } from "./service.ts";

/** Stable subscriber name — the outbox's per-subscriber checkpoint key. */
export const REMITTANCE_SUBSCRIBER = "remittance:record-expectation";

export function registerRemittanceSubscriptions(bus: EventBus, service: RemittanceService): void {
  bus.subscribe("claim.submitted", REMITTANCE_SUBSCRIBER, async (event) => {
    await service.recordExpectation(event.payload);
  });
}
