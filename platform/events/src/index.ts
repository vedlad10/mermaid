/**
 * @mermaid/events — the domain-event outbox. The only channel between bounded contexts.
 *
 * Producers depend on `EventPublisher`; the composition root owns the concrete `EventBus` and wires
 * subscriptions. See platform/events/README.md for the pattern and the catalog.
 */
export * from "./catalog.ts";
export * from "./bus.ts";
export { PostgresEventBus, type PgOutboxOptions } from "./pg-bus.ts";
