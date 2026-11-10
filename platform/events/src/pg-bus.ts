/**
 * The durable outbox — `domain_events` + a `FOR UPDATE SKIP LOCKED` worker.
 *
 * Drop-in behind the same `EventBus` interface the in-memory outbox implements, so no module
 * changed to gain durability. What changes is that the guarantees stop being aspirational:
 *
 *  • **Transactional enqueue.** `publish()` writes into the AMBIENT transaction (pool.ts), which is
 *    the one the business write is already using. An event therefore cannot be lost after a commit,
 *    nor emitted for a write that rolled back. This is the entire reason the outbox pattern exists,
 *    and it is the one property the in-memory implementation could only pretend to have.
 *
 *  • **At-least-once delivery, exactly-once effect.** A handler can be invoked twice, so most
 *    subscribers here are idempotent by construction (claims key on `verificationId`, remittances
 *    on `traceNumber`, payments on `postingId`).
 *
 *    Not all of them, and the difference matters. `payer-profile:learn` INCREMENTS counters and is
 *    not idempotent by itself; it is safe because `dispatch` runs the handler and its
 *    `markDelivered` checkpoint inside ONE `withPractice` transaction, and repositories reusing the
 *    ambient transaction through `withoutPractice` commit with it or not at all. That guarantee is
 *    the DISPATCHER'S, and it only covers writes that join the ambient transaction — a handler
 *    reaching outside it (its own pool, an HTTP call) has none of it.
 *
 *  • **Per-subscriber checkpointing.** `domain_event_deliveries` records who has taken what, so a
 *    retry re-delivers only to the subscriber that failed. Otherwise one flaky consumer would force
 *    duplicate work on a healthy one on every retry.
 *
 *  • **Horizontal scale without double-processing.** `claim_domain_events` uses
 *    `FOR UPDATE SKIP LOCKED`: N workers can poll the same table concurrently, each taking a
 *    disjoint batch, none blocking on a row another holds.
 *
 *  • **A failing subscriber cannot block the queue.** Failures reschedule with exponential backoff
 *    and dead-letter after `maxAttempts`, rather than being retried hot forever at the head of the
 *    queue.
 *
 * ── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 * `domain_events` is tenant-scoped under RLS like everything else, so a practice reads only its own
 * events. The WORKER, however, must see every practice's backlog — one poll per tenant per tick does
 * not scale to hundreds of clinics. It therefore uses the SECURITY DEFINER functions from migration
 * 0006 (the same narrow, audited pattern as `find_user_for_auth`), and then invokes each handler
 * inside `withPractice(event.practiceId)`. Queue mechanics span tenants; business code never does.
 */
import { withPractice, withoutPractice, requireContext, type Tx } from "@mermaid/db";
import { withVersion } from "@mermaid/shared";
import { logger as defaultLogger, metrics as defaultMetrics, type Logger, type Metrics } from "@mermaid/observability";
import {
  EVENT_PAYLOAD_VERSION,
  type DomainEventMap,
  type DomainEventType,
  type PayloadFor,
} from "./catalog.ts";
import type {
  DomainEvent,
  DrainReport,
  EventBus,
  EventHandler,
  OutboxBacklog,
  PublishOptions,
} from "./bus.ts";

interface Registration {
  name: string;
  handler: EventHandler<DomainEventType>;
}

export interface PgOutboxOptions {
  /** Events claimed per drain pass. */
  batchSize?: number;
  /** Attempts before an event is dead-lettered. */
  maxAttempts?: number;
  /** Base seconds for exponential backoff: delay = base * 2^(attempts-1), capped. */
  backoffSeconds?: number;
  maxBackoffSeconds?: number;
  /**
   * Visibility lease, in seconds. A claimed event is hidden from other workers for this long
   * (migration 0007). Must comfortably exceed the slowest handler: if it expires mid-handler the
   * event is redelivered, which is safe (handlers are idempotent) but wasteful.
   */
  leaseSeconds?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Raw `domain_events` row as returned by `claim_domain_events`. */
interface EventRow {
  id: string;
  practice_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  published_at: Date | string | null;
  last_error: string | null;
  dead_lettered: boolean;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

function toEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    type: row.event_type as DomainEventType,
    aggregateId: row.aggregate_id,
    practiceId: row.practice_id,
    occurredAt: iso(row.occurred_at)!,
    // The payload's shape is guaranteed by the catalog on the way IN and by the jsonb_has_version
    // CHECK in the database; on the way out it is an opaque JSONB document until a handler,
    // selected by event type, gives it meaning.
    payload: row.payload as unknown as PayloadFor<DomainEventType>,
    attempts: row.attempts,
    publishedAt: iso(row.published_at),
    lastError: row.last_error,
    deadLettered: row.dead_lettered,
  };
}

export class PostgresEventBus implements EventBus {
  #subscribers = new Map<DomainEventType, Registration[]>();
  #batchSize: number;
  #maxAttempts: number;
  #backoffSeconds: number;
  #maxBackoffSeconds: number;
  #leaseSeconds: number;
  #logger: Logger;
  #metrics: Metrics;

  constructor(options: PgOutboxOptions = {}) {
    this.#batchSize = options.batchSize ?? 50;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#backoffSeconds = options.backoffSeconds ?? 10;
    this.#maxBackoffSeconds = options.maxBackoffSeconds ?? 3600;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
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

  /**
   * Append an event to the outbox, in the caller's transaction.
   *
   * Deliberately does NOT dispatch: dispatching inline would run handlers before the business
   * transaction committed, so a handler could observe — or act on — a write that then rolled back.
   * The worker picks it up after commit.
   */
  async publish<T extends DomainEventType>(
    type: T,
    aggregateId: string,
    body: DomainEventMap[T],
    options: PublishOptions = {}
  ): Promise<DomainEvent<T>> {
    const ctx = requireContext();
    const practiceId = options.practiceId ?? ctx.practiceId;
    if (!practiceId) {
      throw new Error(
        `cannot publish ${type}: no practice context. Domain events are tenant-scoped; publish from ` +
          `inside withPractice(), or pass practiceId explicitly.`
      );
    }
    const payload = withVersion(body, EVENT_PAYLOAD_VERSION) as PayloadFor<T>;
    const occurredAt = options.occurredAt ?? new Date();

    const { rows } = await ctx.tx.query(
      `INSERT INTO domain_events (practice_id, event_type, aggregate_id, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, practice_id, event_type, aggregate_id, payload, occurred_at,
                 attempts, published_at, last_error, dead_lettered`,
      [practiceId, type, aggregateId, payload, occurredAt.toISOString()]
    );

    this.#metrics.inc("events.published");
    this.#metrics.inc(`events.published.${type}`);
    return toEvent(rows[0] as EventRow) as DomainEvent<T>;
  }

  /**
   * Claim and dispatch one batch. Never throws — the business transaction that produced these
   * events committed long ago, so a dispatch failure is a retry, not an error to propagate.
   *
   * Safe to run concurrently in multiple processes: the claim uses SKIP LOCKED.
   */
  async drain(now: Date = new Date()): Promise<DrainReport> {
    let claimed: DomainEvent[];
    try {
      // The claim runs in its own short transaction so the row locks are released immediately and
      // handlers (which may be slow) never hold them.
      const rows = await withoutPractice((tx) => claimBatch(tx, this.#batchSize, this.#leaseSeconds));
      claimed = rows.map(toEvent);
    } catch (e) {
      this.#logger.error("outbox: failed to claim a batch", {
        channel: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return this.#report(0, 0, 0, now);
    }

    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const event of claimed) {
      const registrations = this.#subscribers.get(event.type) ?? [];
      let allOk = true;
      let lastError: string | null = null;

      if (registrations.length > 0) {
        const done = await withoutPractice((tx) => deliveredSubscribers(tx, event.id));
        for (const reg of registrations) {
          if (done.has(reg.name)) continue; // per-subscriber checkpoint — do not re-deliver
          try {
            // Handlers run fully RLS-scoped to the event's own practice.
            await withPractice(event.practiceId!, async () => {
              await reg.handler(event);
              await markDelivered(requireContext().tx, event.id, reg.name, event.practiceId!);
            });
            this.#metrics.inc("events.dispatched");
          } catch (err) {
            allOk = false;
            const message = err instanceof Error ? err.message : String(err);
            lastError = `${reg.name}: ${message}`;
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
      }

      // The handler's work and its delivery checkpoint commit together (above), so a handler that
      // succeeded is never re-run because the checkpoint write failed afterwards.
      const backoff = Math.min(this.#maxBackoffSeconds, this.#backoffSeconds * 2 ** Math.max(0, event.attempts - 1));
      await withoutPractice((tx) => settle(tx, event.id, allOk, lastError, this.#maxAttempts, backoff));

      if (allOk) dispatched += 1;
      else if (event.attempts >= this.#maxAttempts) {
        deadLettered += 1;
        this.#metrics.inc("events.dead_lettered");
        this.#logger.error("event dead-lettered after max attempts", {
          channel: "error",
          eventId: event.id,
          eventType: event.type,
          attempts: event.attempts,
          error: lastError ?? "unknown",
        });
      } else failed += 1;
    }

    return this.#report(dispatched, failed, deadLettered, now);
  }

  /** Drain repeatedly until the backlog is empty (or `maxPasses` is reached). */
  async drainAll(maxPasses = 20, now: Date = new Date()): Promise<DrainReport> {
    let last = await this.drain(now);
    let passes = 1;
    while (last.pending > 0 && last.dispatched > 0 && passes < maxPasses) {
      last = await this.drain(now);
      passes += 1;
    }
    return last;
  }

  async #report(dispatched: number, failed: number, deadLettered: number, now: Date): Promise<DrainReport> {
    const backlog = await withoutPractice((tx) => readBacklog(tx)).catch(() => null);
    const oldest = backlog?.oldest_pending ? new Date(backlog.oldest_pending).getTime() : null;
    const oldestPendingMs = oldest === null ? 0 : Math.max(0, now.getTime() - oldest);

    this.#metrics.gauge("events.pending", backlog?.pending ?? 0);
    this.#metrics.gauge("events.dead_lettered_total", backlog?.dead ?? 0);
    this.#metrics.gauge("events.lag_ms", oldestPendingMs);

    return { dispatched, failed, deadLettered, pending: backlog?.pending ?? 0, oldestPendingMs };
  }

  /** Operational read: the mandated outbox-lag signal (blueprint doc 13). */
  async backlog(): Promise<OutboxBacklog> {
    const row = await withoutPractice((tx) => readBacklog(tx));
    return {
      pending: row?.pending ?? 0,
      dead: row?.dead ?? 0,
      oldestPending: row?.oldest_pending ? new Date(row.oldest_pending).toISOString() : null,
    };
  }

  /**
   * THIS practice's backlog (NEW-06).
   *
   * A PLAIN query, deliberately — no `domain_event_backlog()`, which is SECURITY DEFINER and
   * therefore blind to RLS by design. Running inside the request's practice context means the same
   * policy that scopes `recentEvents` scopes this, so the count on the screen and the list under it
   * describe the same set of events. Answering from the global function and listing from the
   * tenant-scoped one is how a screen shows "12 pending" above an empty table.
   */
  async practiceBacklog(): Promise<OutboxBacklog> {
    const { rows } = await requireContext().tx.query(
      `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered = false) AS pending,
              count(*) FILTER (WHERE dead_lettered)                                   AS dead,
              min(occurred_at) FILTER (WHERE published_at IS NULL AND dead_lettered = false) AS oldest_pending
         FROM domain_events`
    );
    const row = rows[0] as { pending: string; dead: string; oldest_pending: string | null } | undefined;
    return {
      pending: Number(row?.pending ?? 0),
      dead: Number(row?.dead ?? 0),
      oldestPending: row?.oldest_pending ? new Date(row.oldest_pending).toISOString() : null,
    };
  }

  /**
   * The PRACTICE's own recent events, newest first.
   *
   * Deliberately NOT `withoutPractice`, unlike the queue mechanics above: this is a tenant read
   * serving a screen, so it runs inside the request's practice context and RLS scopes it. Queue
   * mechanics span tenants; anything a user looks at never does.
   */
  async recentEvents(limit = 50, deadOnly = false): Promise<DomainEvent[]> {
    const { rows } = await requireContext().tx.query(
      `SELECT id, practice_id, event_type, aggregate_id, payload, occurred_at,
              attempts, published_at, last_error, dead_lettered
         FROM domain_events
        ${deadOnly ? "WHERE dead_lettered" : ""}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $1`,
      [Math.min(200, Math.max(1, limit))]
    );
    return (rows as EventRow[]).map(toEvent);
  }

  /**
   * Put a dead-lettered event back on the queue.
   *
   * Scoped by RLS to the caller's practice, so an operator can only revive their own. `attempts` is
   * reset because the backoff is a function of it — leaving it at the max would schedule the retry
   * an hour out, which is not what a person clicking "retry" means.
   */
  async revive(eventId: string): Promise<boolean> {
    const { rowCount } = await requireContext().tx.query(
      // `next_attempt_at` doubles as the visibility lease (migration 0007), so clearing it to `now()`
      // is what actually makes the event claimable again — there is no separate lock column.
      `UPDATE domain_events
          SET dead_lettered = false, attempts = 0, last_error = NULL, next_attempt_at = now()
        WHERE id = $1 AND dead_lettered`,
      [eventId]
    );
    return (rowCount ?? 0) > 0;
  }
}

// ── SQL (all via the SECURITY DEFINER functions from migration 0006) ────────────────────────────

async function claimBatch(tx: Tx, limit: number, leaseSeconds: number): Promise<EventRow[]> {
  const { rows } = await tx.query("SELECT * FROM claim_domain_events($1,$2)", [limit, leaseSeconds]);
  return rows as EventRow[];
}

async function deliveredSubscribers(tx: Tx, eventId: string): Promise<Set<string>> {
  const { rows } = await tx.query("SELECT event_delivered_subscribers($1) AS subscriber", [eventId]);
  return new Set((rows as { subscriber: string }[]).map((r) => r.subscriber));
}

async function markDelivered(tx: Tx, eventId: string, subscriber: string, practiceId: string): Promise<void> {
  await tx.query("SELECT mark_event_delivered($1,$2,$3)", [eventId, subscriber, practiceId]);
}

async function settle(
  tx: Tx,
  eventId: string,
  published: boolean,
  error: string | null,
  maxAttempts: number,
  backoffSeconds: number
): Promise<void> {
  await tx.query("SELECT settle_domain_event($1,$2,$3,$4,$5)", [
    eventId,
    published,
    error,
    maxAttempts,
    backoffSeconds,
  ]);
}

async function readBacklog(tx: Tx): Promise<{ pending: number; dead: number; oldest_pending: string | null } | undefined> {
  const { rows } = await tx.query("SELECT * FROM domain_event_backlog()");
  return rows[0] as { pending: number; dead: number; oldest_pending: string | null } | undefined;
}
