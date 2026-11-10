/**
 * How the Denials context learns there is money to chase.
 *
 * One subscription, and it is the module's entire inbound coupling. There is no import of
 * `@mermaid/remittance` anywhere in `modules/denials-appeals` — CI enforces that — and this is what
 * replaces it.
 *
 * `variance.detected` is already selective: Remittance raises it only for genuinely recoverable or
 * unexplained shortfalls, never for contractual write-offs or patient balances. So this handler does
 * not need to filter, and deliberately does not: deciding what is worth pursuing is the producing
 * module's judgement plus the playbook's, and duplicating it here would give two places to change
 * the same rule.
 */
import type { EventBus } from "@mermaid/events";
import type { DenialService } from "./service.ts";

/** Stable subscriber name — the outbox's per-subscriber checkpoint key. */
export const DENIALS_SUBSCRIBER = "denials:create-from-variance";

export function registerDenialSubscriptions(bus: EventBus, service: DenialService): void {
  bus.subscribe("variance.detected", DENIALS_SUBSCRIBER, async (event) => {
    await service.createFromVariance(event.payload, new Date(event.occurredAt));
  });
}
