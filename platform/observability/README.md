# platform/observability

Structured JSON logs, an append-only audit channel, and the event-lag monitoring the outbox worker
reports (the feedback loop must never stall silently — risk review §1.2).

## Audit (wired at M10)

`recordAudit` writes through the `record_audit` SECURITY DEFINER function from migration 0003. That
indirection is the whole control: **the application role has no INSERT on `audit_events`**, so the
thing being audited cannot write — or rewrite — its own history. `tests/db/operations.test.ts` proves
it by issuing an `UPDATE` and asserting zero rows changed.

The HTTP layer (`apps/web/server.ts`) writes one row per mutating request, **inside the same
transaction as the change it describes** — a trail that can outlive a rolled-back write, or be lost
while the write survives, is not a trail. A refused request is audited too, in its own transaction,
because "this user tried to do this and was denied" is precisely what the log exists for.

**Reads are deliberately not audited.** Burying the ~2% of rows that record a change under the 98%
that record someone looking at a screen would make the log unusable for the one question it answers.
PHI *access* logging is a separate, coarser control and a separate decision.

Surfaced read-only at `GET /api/v1/ops/audit` and on the Ops tab, RLS-scoped to the practice.
