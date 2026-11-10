/**
 * The outbox — the only channel between bounded contexts.
 *
 * Doctrine (platform/events/README.md, risk review §5, §1.2): a domain event is appended in the SAME
 * transaction as the business write that caused it, so an event can never be lost, nor emitted for a
 * write that rolled back. A worker then dispatches unpublished rows to subscribers.
 *
 * This file provides the application-side contract plus the in-memory implementation used by the
 * demo and tests. The Postgres implementation (`domain_events` + `FOR UPDATE SKIP LOCKED` worker,
 * migration 0006) drops in behind the same `EventBus` interface — no module changes. That is the
 * same swappable-seam discipline used for the EDI adapter and the verification repository.
 *
 * Three production realities this models rather than papers over:
 *
 *  1. **At-least-once delivery.** A handler CAN be invoked twice for one event (dispatch succeeded,
 *     the mark-published write did not). Every subscriber must therefore be idempotent. The claims
 *     service keys on `verificationId` for exactly this reason.
 *  2. **Per-subscriber checkpointing.** If two subscribers take one event and only one throws, the
 *     retry re-delivers to the FAILED subscriber only. Otherwise a flaky consumer would force
 *     duplicate work on a healthy one on every retry.
 *  3. **Dispatch failure never fails the business write.** The business transaction already
 *     committed; `drain()` therefore never throws. Failures are counted, logged, retried, and
 *     eventually dead-lettered — visible, not swallowed.
 */
import { randomUUID } from "node:crypto";
import { withVersion } from "@mermaid/shared";
import { logger as defaultLogger, metrics as defaultMetrics, type Logger, type Metrics } from "@mermaid/observability";
import {
  EVENT_PAYLOAD_VERSION,
  type DomainEventMap,
  type DomainEventType,
  type PayloadFor,
} from "./catalog.ts";

/** One row of the outbox. Mirrors the `domain_events` table (blueprint doc 03). */
export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: string;
  type: T;
  /** The entity this event is about — `verification_id`, `claim_id`, … (used for FIFO ordering). */
  aggregateId: string;
  /** Tenant scope. Null only in single-practice demo scope; NOT NULL under RLS in production. */
  practiceId: string | null;
  occurredAt: string;
  payload: PayloadFor<T>;
  /** Dispatch attempts so far (across all subscribers). */
  attempts: number;
  /** Set once every subscriber has taken the event. */
  publishedAt: string | null;
  lastError: string | null;
  /** Exceeded `maxAttempts` — parked for human attention, never retried automatically. */
  deadLettered: boolean;
}

export interface PublishOptions {
  practiceId?: string | null;
  occurredAt?: Date;
}

/** What a producing module depends on. Narrow on purpose — producers cannot subscribe or drain. */
export interface EventPublisher {
  publish<T extends DomainEventType>(
    type: T,
    aggregateId: string,
    body: DomainEventMap[T],
    options?: PublishOptions
  ): Promise<DomainEvent<T>>;
}

export type EventHandler<T extends DomainEventType> = (event: DomainEvent<T>) => Promise<void> | void;

/** Result of one drain pass — the signal the outbox monitor watches. */
export interface DrainReport {
  /** Events fully delivered to every subscriber in this pass. */
  dispatched: number;
  /** Events that had at least one handler fail and remain pending. */
  failed: number;
  deadLettered: number;
  /** Events still awaiting delivery after this pass. */
  pending: number;
  /** Age of the oldest pending event in ms — the mandated event-lag signal (doc 13). */
  oldestPendingMs: number;
}

/** What the outbox is currently carrying. The mandated event-lag signal (blueprint doc 13). */
export interface OutboxBacklog {
  pending: number;
  dead: number;
  /** ISO timestamp of the oldest event still awaiting delivery, or null when the queue is empty. */
  oldestPending: string | null;
}

/**
 * The operational read/write surface (M10).
 *
 * Separate from `EventBus` because it answers a different question: not "deliver this" but "is the
 * queue healthy, and what is stuck". A dead-lettered event is money or work that silently stopped
 * moving — the outbox is the one component whose failure is invisible from every business screen —
 * so an operator needs to see it and be able to put it back, deliberately and attributably.
 */
export interface OutboxAdmin {
  /**
   * The GLOBAL backlog, across every tenant.
   *
   * ── FOR THE WATCHDOG, NOT FOR A USER (NEW-06) ────────────────────────────────────────────────
   * This reads through a SECURITY DEFINER function that bypasses RLS, because the outbox worker and
   * the internal watchdog genuinely have to see every practice's queue — a stalled tenant is
   * invisible from inside any other one.
   *
   * It was also what `/ops/outbox`, `/ops/monitors` and `/ops/readiness` served to signed-in users.
   * So a practice's operations screen reported pending counts, dead-letter counts and an oldest-
   * pending timestamp aggregated over every OTHER practice on the deployment: a busy neighbour made
   * one clinic's queue look stalled, a neighbour's dead letters showed as theirs to retry, and the
   * numbers were a low-grade disclosure of another tenant's volume in a system whose entire tenancy
   * story is that no practice learns anything about another.
   *
   * User-facing routes use `practiceBacklog`. This one keeps its name and its reach because the
   * watchdog is the caller it was written for.
   */
  backlog(): Promise<OutboxBacklog>;
  /**
   * THIS practice's backlog. RLS-scoped, like every other tenant read (NEW-06).
   *
   * The same three numbers, about the queue the caller actually owns. An operator asking "is my
   * queue stuck?" is asking about their own events, and this is the only answer to that question.
   */
  practiceBacklog(): Promise<OutboxBacklog>;
  /** The practice's own recent events, newest first. RLS-scoped like any other tenant read. */
  recentEvents(limit?: number, deadOnly?: boolean): Promise<DomainEvent[]>;
  /**
   * Put a dead-lettered event back on the queue. Returns false when the id is unknown, belongs to
   * another practice, or was not dead-lettered — never a silent success.
   *
   * A human act: automatic revival of an event that has already failed `maxAttempts` times is just a
   * slower hot loop.
   */
  revive(eventId: string): Promise<boolean>;
}

export interface EventBus extends EventPublisher, OutboxAdmin {
  /**
   * Register a handler. `subscriberName` is the checkpoint key — keep it stable across restarts,
   * because it is what "this subscriber already took this event" is recorded against.
   */
  subscribe<T extends DomainEventType>(type: T, subscriberName: string, handler: EventHandler<T>): void;
  /** Dispatch pending events to their subscribers. Never throws. */
  drain(now?: Date): Promise<DrainReport>;
}

interface Registration {
  name: string;
  handler: EventHandler<DomainEventType>;
}

export interface OutboxOptions {
  /**
   * Dispatch immediately at the end of `publish()` (default true). This stands in for the worker
   * polling loop, and keeps the demo's HTTP responses consistent — by the time a verification POST
   * returns, its claim exists. Set false in tests to inspect the outbox before dispatch.
   */
  autoDrain?: boolean;
  /** Attempts before an event is dead-lettered. */
  maxAttempts?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * In-memory outbox. Single-process, no durability — correct for the demo and tests, and explicitly
 * NOT the production path (that is Postgres + a polling worker behind this same interface).
 *
 * Events are dispatched in publish order (FIFO), which preserves per-aggregate ordering for free
 * since a single aggregate's events are appended in sequence.
 */
export class InMemoryOutbox implements EventBus {
  #events: DomainEvent[] = [];
  /** eventId → subscriber names that have already succeeded (per-subscriber checkpointing). */
  #delivered = new Map<string, Set<string>>();
  #subscribers = new Map<DomainEventType, Registration[]>();
  #autoDrain: boolean;
  #maxAttempts: number;
  #logger: Logger;
  #metrics: Metrics;
  /** Guards against a handler that publishes, re-entering drain() and interleaving dispatch. */
  #draining = false;

  constructor(options: OutboxOptions = {}) {
    this.#autoDrain = options.autoDrain ?? true;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#logger = options.logger ?? defaultLogger;
    this.#metrics = options.metrics ?? defaultMetrics;
  }

  subscribe<T extends DomainEventType>(type: T, subscriberName: string, handler: EventHandler<T>): void {
    const list = this.#subscribers.get(type) ?? [];
    if (list.some((r) => r.name === subscriberName)) {
      throw new Error(`subscriber "${subscriberName}" is already registered for ${type}`);
    }
    list.push({ name: subscriberName, handler: handler as EventHandler<DomainEventType> });
    this.#subscribers.set(type, list);
  }

  async publish<T extends DomainEventType>(
    type: T,
    aggregateId: string,
    body: DomainEventMap[T],
    options: PublishOptions = {}
  ): Promise<DomainEvent<T>> {
    const occurredAt = (options.occurredAt ?? new Date()).toISOString();
    const event: DomainEvent<T> = {
      id: randomUUID(),
      type,
      aggregateId,
      practiceId: options.practiceId ?? null,
      occurredAt,
      payload: withVersion(body, EVENT_PAYLOAD_VERSION) as PayloadFor<T>,
      attempts: 0,
      publishedAt: null,
      lastError: null,
      deadLettered: false,
    };
    // Appending here is the "same transaction as the business write" position.
    this.#events.push(event as DomainEvent);
    this.#metrics.inc("events.published");
    this.#metrics.inc(`events.published.${type}`);

    if (this.#autoDrain && !this.#draining) await this.drain(options.occurredAt);
    return event;
  }

  async drain(now: Date = new Date()): Promise<DrainReport> {
    if (this.#draining) {
      // Re-entrant call (a handler published an event): the outer loop will pick it up.
      return this.#report(0, 0, 0, now);
    }
    this.#draining = true;
    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;
    try {
      // Index-based walk: handlers may append new events, and those get dispatched in this pass.
      for (let i = 0; i < this.#events.length; i++) {
        const event = this.#events[i]!;
        if (event.publishedAt || event.deadLettered) continue;

        const registrations = this.#subscribers.get(event.type) ?? [];
        const done = this.#delivered.get(event.id) ?? new Set<string>();
        this.#delivered.set(event.id, done);
        event.attempts += 1;

        let allOk = true;
        for (const reg of registrations) {
          if (done.has(reg.name)) continue; // per-subscriber checkpoint — do not re-deliver
          try {
            await reg.handler(event);
            done.add(reg.name);
            this.#metrics.inc("events.dispatched");
          } catch (err) {
            allOk = false;
            const message = err instanceof Error ? err.message : String(err);
            event.lastError = `${reg.name}: ${message}`;
            this.#metrics.inc("events.handler_failed");
            this.#logger.error("event handler failed", {
              channel: "error",
              eventId: event.id,
              eventType: event.type,
              subscriber: reg.name,
              attempts: event.attempts,
              error: message,
            });
          }
        }

        if (allOk) {
          event.publishedAt = now.toISOString();
          event.lastError = null;
          dispatched += 1;
        } else if (event.attempts >= this.#maxAttempts) {
          event.deadLettered = true;
          deadLettered += 1;
          this.#metrics.inc("events.dead_lettered");
          this.#logger.error("event dead-lettered after max attempts", {
            channel: "error",
            eventId: event.id,
            eventType: event.type,
            attempts: event.attempts,
            error: event.lastError ?? "unknown",
          });
        } else {
          failed += 1;
        }
      }
    } finally {
      this.#draining = false;
    }
    return this.#report(dispatched, failed, deadLettered, now);
  }

  #report(dispatched: number, failed: number, deadLettered: number, now: Date): DrainReport {
    const pendingEvents = this.#events.filter((e) => !e.publishedAt && !e.deadLettered);
    const oldestPendingMs = pendingEvents.reduce((max, e) => {
      const age = now.getTime() - new Date(e.occurredAt).getTime();
      return age > max ? age : max;
    }, 0);
    this.#metrics.gauge("events.pending", pendingEvents.length);
    this.#metrics.gauge("events.lag_ms", oldestPendingMs);
    return { dispatched, failed, deadLettered, pending: pendingEvents.length, oldestPendingMs };
  }

  /** All events, newest last. Read-only copies — inspection must not mutate the outbox. */
  all(): DomainEvent[] {
    return this.#events.map((e) => structuredClone(e));
  }

  pending(): DomainEvent[] {
    return this.all().filter((e) => !e.publishedAt && !e.deadLettered);
  }

  deadLetters(): DomainEvent[] {
    return this.all().filter((e) => e.deadLettered);
  }

  /** Events of one type, in publish order — the read side of a module's own history. */
  ofType<T extends DomainEventType>(type: T): DomainEvent<T>[] {
    return this.all().filter((e): e is DomainEvent<T> => e.type === type);
  }

  // ── OutboxAdmin (M10) ───────────────────────────────────────────────────────────────
  //
  // Implemented here too, not only on the Postgres bus, so the operations screen works in the
  // DB-free demo. An ops console that only exists in production is one nobody has ever used before
  // the night they need it.

  async backlog(): Promise<OutboxBacklog> {
    const pending = this.pending();
    const oldest = pending.reduce<string | null>(
      (min, e) => (min === null || e.occurredAt < min ? e.occurredAt : min),
      null
    );
    return { pending: pending.length, dead: this.deadLetters().length, oldestPending: oldest };
  }

  /**
   * The in-memory bus holds ONE practice's events — the DB-free demo is single-tenant — so the
   * global and the scoped answer are necessarily the same. Implemented as a distinct method anyway,
   * rather than aliased, so that a caller reading either implementation sees the same two questions
   * and cannot conclude the distinction is a Postgres detail.
   */
  async practiceBacklog(): Promise<OutboxBacklog> {
    return this.backlog();
  }

  async recentEvents(limit = 50, deadOnly = false): Promise<DomainEvent[]> {
    const source = deadOnly ? this.deadLetters() : this.all();
    return source.slice(-limit).reverse();
  }

  async revive(eventId: string): Promise<boolean> {
    const event = this.#events.find((e) => e.id === eventId && e.deadLettered);
    if (!event) return false;
    event.deadLettered = false;
    event.attempts = 0;
    event.lastError = null;
    return true;
  }
}

/**
 * A publisher that discards events. For unit tests and for services constructed outside a wired
 * composition root — a module must never be forced to know whether anyone is listening.
 */
export class NullEventPublisher implements EventPublisher {
  async publish<T extends DomainEventType>(
    type: T,
    aggregateId: string,
    body: DomainEventMap[T],
    options: PublishOptions = {}
  ): Promise<DomainEvent<T>> {
    const occurredAt = (options.occurredAt ?? new Date()).toISOString();
    return {
      id: randomUUID(),
      type,
      aggregateId,
      practiceId: options.practiceId ?? null,
      occurredAt,
      payload: withVersion(body, EVENT_PAYLOAD_VERSION) as PayloadFor<T>,
      attempts: 1,
      publishedAt: occurredAt,
      lastError: null,
      deadLettered: false,
    };
  }
}
