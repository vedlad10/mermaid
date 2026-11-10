# 16 — Risk Review (CTO self-critique of THIS blueprint)

*Blueprint doc 16 of 16. Reviewing the Mermaid architecture before committing engineering time —
organized by risk, not module. Inherits and extends `architecture-risk-review.md` (which reviewed the
roadmap); this doc re-checks those risks against the concrete design in docs 01–15 and adds risks the
merge itself introduces.*

## A. Risks carried from the design docs — how this blueprint addresses each

| # | Risk (from architecture-risk-review.md) | Addressed in blueprint | Residual |
|---|---|---|---|
| 1 | App-enforced tenant isolation | **Postgres RLS** (doc 08, migration 0002 live at P0); app role unprivileged; fail-closed | Must keep app off the owner/superuser role in prod — a deploy-config check |
| 2 | Outbox worker single point of failure | Durable worker, `SKIP LOCKED`, retries/backoff, **event-lag alarm** (docs 05,13) | Monitoring lands P6 — until then the loop is at low volume; acceptable, tracked |
| 3 | Auto-posted money unchecked | **Daily reconciliation** vs raw-835 checksum + drift alert (docs 12,13); reversible ledger | Reconciliation is daily, not real-time — a bad post can exist for <24h; shadow mode (P3) covers cutover |
| 4 | No remittance idempotency | Unique `(practice_id, trace_number)` + ingest guard (docs 03,09) | Requires the clearinghouse to supply a stable trace; paper EOB uses a synthesized key |
| 5 | Unversioned JSONB drift | `snapshot_version` + `jsonb_has_version` CHECK + upcasters (docs 03,04; P0 live) | Discipline: every new JSONB column must add the CHECK — enforced in migration review |
| 6 | Single-LLM hard dependency | Swappable adapter + **degraded-mode router** → manual queue (doc 10) | Degraded mode adds manual load during outages — acceptable, visible |

## B. New risks introduced by the merge itself

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| M1 | **Estimate→claim inheritance is new money-touching code** (no donor has it) | 🔴 High | P5 in shadow mode + per-practice flag; golden money-math tests; immutable `coverage_snapshot` |
| M2 | **SQLite→Postgres dialect creep** — donor analytics/services use `julianday`, `datetime('now')`, `COLLATE NOCASE` | 🟠 Med | port behind the repository layer; parity tests old-vs-new; no SQLite-isms leak past `repository.ts` |
| M3 | **Losing test coverage in the JS→TS port** (donor suites are the safety net) | 🟠 Med | port 100% of both suites into CI at P0-onward; keep green every phase before adding features |
| M4 | **Tenancy retrofit on single-tenant Dental Verify** touches auth + every query | 🟠 Med | done as an isolated early phase (P1); RLS makes a missed scope fail-closed, not leak |
| M5 | **Two live apps during strangler-fig** — data can diverge mid-migration | 🟠 Med | one source of truth per entity per phase; per-practice flags; shadow-diff before cutover |
| M6 | **Boundary discipline erodes under deadline** (a "just this once" cross-module query) | 🟠 Med | `check-boundaries.mjs` in CI (live P0) fails the build — enforced, not remembered |
| M7 | **Next.js 16 volatility** — donor `AGENTS.md`: "not the Next.js you know" | 🟠 Med | keep domain logic framework-free in `modules/*`; read vendored Next docs before route/runtime code; app shell is thin |
| M8 | **Managed remote dev DB** — connectivity/latency dependence for local dev | 🟡 Low | connection-string agnostic; local Docker Postgres remains an option; CI uses its own PG |
| M9 | **HITL gates are policy, easy to bypass in code** | 🟠 Med | gates are first-class states + audit events + dedicated `tests/hitl/` asserting no auto-path exists |
| M10 | **Money as float** anywhere | 🔴 High | `Cents` (integer) type across the domain (doc 04); no float math on money; property tests |

## C. The three things to get right before any more feature code (inherited + reaffirmed)

1. **Postgres RLS for tenant isolation.** A bad decade if it goes wrong; foundation is live at P0,
   per-table policies at P1.
2. **Reconciliation + idempotency around money.** Auto-posting is the "boringly reliable" feature and
   the fastest way to lose a practice owner's trust if quietly wrong. P3, before live money.
3. **A durable, monitored event pipeline.** The feedback loop is the entire product thesis; it must
   not be a silent-failure poller. P2 outbox, P6 monitoring.

## D. Scalability honesty

Not built for 10,000 practices on day one — and that's correct. The design locks nothing out: events-
only coupling enables per-module extraction, analytics moves to a replica, workers partition, a second
clearinghouse is additive. The gaps at 100 practices are correctness/security (Section A/B), not load —
and those are cheaper to fix now than later.

## E. What I'd change if forced to pick three, before writing feature code

1. Make `Cents` + RLS + the boundary checker non-negotiable gates in CI **now** (two of three live).
2. Build the outbox + reconciliation + idempotency as the *first* real domain work (P2–P3), before
   the flashier UI merge — the money and the loop are the trust surface.
3. Write the `tests/hitl/` guardrail suite early, so "no path auto-delivers a patient bill / auto-
   submits an appeal / auto-posts an exception" is proven continuously, not assumed.

## F. Open items requiring a human decision (tracked, not blocking the blueprint)

- EDI vendor selection (adapter is ready; vendor at P2).
- LLM provider + BAA eligibility confirmation (adapter/`off` baseline ready; provider at P2).
- Hosting/secrets-manager choice (doc 12/13).
- Final `N` for the small-sample rule-promotion gate (doc 11).
- Practice-configurable thresholds: claim-submit gate dollar amount, pursue/write-off amount (doc 08).
