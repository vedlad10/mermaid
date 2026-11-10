# platform/events — Domain Events (Outbox)

The **only** way modules communicate. A module never reads another module's tables; it reacts to
events. This is what keeps the monolith modular and makes a future service split mechanical
(`ai-revenue-cycle-implementation-roadmap.md` §3–5; `architecture-risk-review.md` §5, §1.2).

## The outbox pattern

A domain event is written to the `domain_events` table **in the same transaction** as the business
write that caused it — so an event can never be lost or emitted for a write that rolled back. A
durable worker then polls unpublished rows and dispatches them to subscribers.

```
BEGIN;
  -- business write (e.g. insert into postings)
  INSERT INTO domain_events (event_type, aggregate_id, payload) VALUES ('remittance.posted', $claimId, $json);
COMMIT;
-- worker: SELECT ... WHERE NOT published ... FOR UPDATE SKIP LOCKED  → dispatch → mark published
```

The worker uses `FOR UPDATE SKIP LOCKED`, partitioned by `practice_id` hash, so it scales
horizontally without double-processing (risk review §2). Event-processing lag is monitored — the
feedback loop (`appeal.outcome.recorded → overturn_rate → confidence`) is the product thesis and
must never stall silently (risk review §1.2, §7).

## Event catalog (roadmap §5)

| Event | Producer | Consumers |
|---|---|---|
| `verification.completed` | Verification | Claims, Analytics |
| `verification.needs_review` | Verification | Today Queue |
| `claim.submitted` | Claims | Remittance, Analytics |
| `claim.filing_risk` | Claims | Today Queue |
| `remittance.posted` | Remittance | Claims, Analytics |
| `variance.detected` | Remittance | Denials, Today Queue |
| `denial.created` | Denials | Today Queue, Analytics |
| `denial.closed` | Denials | Patient Ledger, Analytics |
| `appeal.outcome.recorded` | Appeals | Payer Profile, Analytics |
| `patient.charged` | Patient Ledger | Analytics |
| `patient.payment.recorded` | Patient Ledger | Analytics |

## Status

**Complete as of M9.** Every row above has a real producer and at least one real consumer —
declaring an event with no producer would be fiction, so the union grew one milestone at a time.

The chain runs end to end across six bounded contexts with zero imports between them:
`verification.completed` → `claim.submitted` → `remittance.posted` / `variance.detected` →
`denial.created` → `appeal.outcome.recorded` (the learning loop closing) and `denial.closed` →
`patient.charged` (the money's other exit).

**Patient identity travels with the money.** `claim.submitted` carries the patient; the expectation
Remittance records from it carries the member id forward; `remittance.posted`, `variance.detected`
and `denial.closed` carry it onward. That is how the Patient Ledger knows whose balance a payer's
decision creates, and how an appeal letter names the member and the claim, without any module reading
another's tables — the boundary rule producing a better design rather than merely being obeyed.

**Durable since M6.** `domain_events` + `domain_event_deliveries` (migration 0006) and
`PostgresEventBus` (`src/pg-bus.ts`) — transactional enqueue into the caller's transaction, a
`FOR UPDATE SKIP LOCKED` worker, per-subscriber checkpoints, exponential backoff and dead-lettering.
It drops in behind the same `EventBus` interface, so no module changed to gain any of it;
`InMemoryOutbox` remains the DB-free path for tests and the laptop demo.

**Two things migration 0007 and the tenancy design settle, both non-obvious:**

- **`SKIP LOCKED` alone does not prevent double-processing.** The worker commits its claim
  immediately so it never holds row locks while running slow handlers — but that unlocks the row
  while the event is still unpublished, letting a second worker run every handler again in parallel.
  Claiming therefore takes a **visibility lease** (`next_attempt_at` pushed forward). A crashed
  worker's lease simply expires.
- **The worker spans tenants; handlers never do.** `domain_events` is RLS-scoped like everything
  else, but one poll per practice per tick does not scale to hundreds of clinics. The queue mechanics
  use SECURITY DEFINER functions (the same narrow, audited pattern as `find_user_for_auth`), and each
  handler is then invoked inside `withPractice(event.practiceId)`.

**Observable since M10.** `OutboxAdmin` (`backlog`, `recentEvents`, `revive`) is implemented by both
bus implementations and surfaced at `/api/v1/ops/outbox` and the Ops tab: depth, lag, and everything
dead-lettered, with a human retry. This queue is the one component whose failure is invisible from
every business screen — claims stop appearing, denials stop being triaged, and no worklist says why.
Reviving is deliberately a human act: automatic revival of an event that has already exhausted every
retry is just a slower hot loop. `recentEvents` and `revive` run inside the request's practice
context and are RLS-scoped; only the queue *mechanics* span tenants.

**Not yet:** the worker runs in-process (`startOutboxWorker`), which is correct for a single node and
is already isolated so it can become its own process (blueprint doc 12).

### Guarantees the implementation provides

| Guarantee | Why it matters |
|---|---|
| **At-least-once delivery** | A handler can be invoked twice for one event. Every subscriber must be idempotent — this is why claim creation keys on `verification_id`. |
| **Per-subscriber checkpointing** | If one of two subscribers throws, the retry re-delivers to the *failed* one only. Otherwise a flaky consumer forces duplicate work on a healthy one forever. |
| **Dispatch never fails the business write** | The business transaction already committed, so `drain()` never throws. Failures are counted, logged, retried, and dead-lettered after `maxAttempts`. |
| **Versioned payloads** | Every payload carries `snapshot_version`. An event may sit in `domain_events` for months before a replay reads it. |
| **Lag is measured** | `DrainReport.oldestPendingMs` + the `events.lag_ms` gauge — the mandated outbox-lag signal (doc 13). The feedback loop must never stall silently. |
