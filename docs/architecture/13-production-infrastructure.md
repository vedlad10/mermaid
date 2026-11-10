# 13 — Production Infrastructure

*Blueprint doc 13 of 16. What must be true of the infrastructure before real PHI/money, and how it
scales by milestone. Grounded in `architecture-risk-review.md` §2–4.*

## Infrastructure inventory

| Component | Choice | Why |
|---|---|---|
| Compute | Managed container/PaaS (web · worker · jobs) | stateless web scales horizontally; monolith keeps ops small |
| Database | Managed PostgreSQL 15+, HA, encryption at rest, PITR | single source of truth; RLS; FKs > eventual consistency |
| Read replica | Postgres replica (added ~1k practices) | analytics off the OLTP path |
| Connection pooling | PgBouncer (transaction mode) | many stateless web instances; note: `SET LOCAL` for practice context is transaction-safe |
| Secrets | Managed secrets manager, rotation, per-env scope | no secrets in env/deploy config (risk §3) |
| Object/log storage | Encrypted; PHI-tiered access | raw 271/835 tighter tier than derived fields |
| Email/SMS | BAA-covered provider | estimate delivery is human-triggered (HITL §3), never auto |
| EDI | Clearinghouse (one now, second later) | bought; swappable adapter (doc 09) |
| LLM | BAA-eligible provider | degraded-mode router (doc 10) |
| CI/CD | GitHub Actions (live from P0) | boundaries→typecheck→migrate→test |
| Monitoring | Metrics + logs + alerts | incl. event-lag + reconciliation drift |

## Scale by milestone (risk §2)

| Milestone | What strains | What changes |
|---|---|---|
| **~100 practices** | Nothing under load. The real risks are the correctness/security gaps — as present at 100 as at 10,000, cheaper to fix now. | Ship RLS, idempotency, snapshot versioning, worker durability **before** this milestone. |
| **~1,000 practices** | Analytics contends with live traffic; outbox queue depth grows. | Analytics → read replica; scale workers (partitioned `SKIP LOCKED`); PgBouncer; test whether Verification (LLM latency) needs its own scaling. |
| **~10,000 practices** | Single primary write ceiling; single clearinghouse coverage/uptime ceiling; higher uptime expectations. | Read replicas on read-heavy paths; consider extracting the highest-load module (likely Verification) into its own service — mechanical because coupling is events-only; **second clearinghouse**; multi-region/HA. |

The events-only discipline (doc 05) is what makes the eventual service split mechanical rather than a
rewrite — that is the payoff of paying the boundary cost from day one.

## Observability (must-haves, not nice-to-haves)

- **Structured JSON logs** with `trace_id`, channels (app/security/error), **no PHI in logs**.
- **Audit log** (`audit_events`) — a compliance control (breach-notification readiness, risk §4).
- **Event-lag metric** — oldest unpublished `domain_events` age, alarmed. The feedback loop must
  never stall silently (risk §1.2).
- **Reconciliation drift** — daily auto-posted total vs. raw-835 checksum; alert on any drift (risk
  §1.3). This is the independent check on auto-posted money.
- **LLM degradation rate**, **EDI error/latency**, **auth failure rate/rate-limit hits**.
- **Dead-letter events** surfaced and alarmed.

## Security & compliance program (before practice #1 — risk §3–4, §6–7)

**The three to fix before any more feature code (risk §7):**
1. **Postgres RLS** for tenant isolation (foundation live from P0; policies per table in P1).
2. **Reconciliation + idempotency** around money (P3).
3. **Durable, monitored event pipeline** (P2 outbox; P6 monitoring).

**Full pre-PHI checklist:**
- [ ] RLS on every tenant table; app role unprivileged.
- [ ] Idempotency key on remittance ingest.
- [ ] `snapshot_version` on every JSONB (+ `jsonb_has_version` CHECK).
- [ ] BAAs signed with **every** subprocessor touching PHI (LLM, clearinghouse, cloud, email/SMS) —
      verified, not assumed; LLM endpoint HIPAA-eligibility explicitly confirmed.
- [ ] Encryption at rest + in transit, explicitly verified (not "the cloud probably does it").
- [ ] Secrets manager with rotation; no secrets in env/deploy config.
- [ ] Webhook signature verification on the EDI endpoint.
- [ ] Formal HIPAA Security Risk Assessment completed.
- [ ] Data retention + deletion policy per data type; patient access/amendment process defined.
- [ ] Minimum-necessary pass on every patient-facing export/print/API response.
- [ ] Incident-response / breach-notification runbook written and tested.

## Cost/team posture

Modular monolith on one managed DB keeps infra small and cheap at the 10–100-practice stage where
Mermaid actually lives now. Scale spend is deferred to the milestones that demand it, with nothing in
the design locking those changes out.
