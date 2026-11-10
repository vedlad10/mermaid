# Mermaid — Technical Architecture Blueprint

**Status: PROPOSED — awaiting approval.** Once approved, this blueprint is the binding design;
implementation (Phase 3, P1 onward) follows it literally, and changes to the design go through these
documents first, not through code.

**Authority:** these documents implement the four source-of-truth design documents
(`unified-rcm-workflow.mermaid`, `ai-revenue-cycle-implementation-roadmap.md`,
`architecture-risk-review.md`, `human-in-the-loop-workflow.pdf`), which override everything here on
conflict. Discovery + merge rationale live in `../../../MERMAID-PHASE1-MERGE-ASSESSMENT.md`.

## The documents

| # | Document | Answers |
|---|---|---|
| 01 | [Repository Structure](01-repository-structure.md) | one repo, workspaces, dependency rules |
| 02 | [Final Module Architecture](02-module-architecture.md) | the six bounded contexts + port map |
| 03 | [Database ER Diagram](03-database-er-diagram.md) | tables, relationships, indexes |
| 04 | [Shared Data Model](04-shared-data-model.md) | the domain types every module agrees on |
| 05 | [Domain Event Architecture](05-domain-event-architecture.md) | the outbox seam + event catalog |
| 06 | [API Contracts](06-api-contracts.md) | `/api/v1/*` endpoints, conventions, errors |
| 07 | [Queue Architecture](07-queue-architecture.md) | one value-ranked Today queue |
| 08 | [Authentication & Authorization](08-authentication-authorization.md) | sessions, RLS, RBAC, HITL gates |
| 09 | [EDI Adapter Design](09-edi-adapter-design.md) | bought clearinghouse, swappable, mock fallback |
| 10 | [LLM Adapter Design](10-llm-adapter-design.md) | swappable provider + degraded-mode router |
| 11 | [Continuous Learning](11-continuous-learning-architecture.md) | the feedback loop (product thesis) |
| 12 | [Deployment Architecture](12-deployment-architecture.md) | processes, environments, releases |
| 13 | [Production Infrastructure](13-production-infrastructure.md) | infra inventory, scale, compliance |
| 14 | [Folder Structure](14-folder-structure.md) | complete file-level tree by phase |
| 15 | [Migration Strategy](15-migration-strategy.md) | DDL mechanism + strangler-fig program |
| 16 | [Risk Review](16-risk-review.md) | CTO self-critique of this blueprint |

## The design in one screen

- **One repo, modular monolith, one PostgreSQL database.** Six event-coupled modules
  (Verification · Claims · Remittance · Denials & Appeals · Payer Profile · Analytics) + a platform
  layer (db, events, auth, edi, llm, queue, observability) + one Next.js app shell.
- **Modules communicate only via a `domain_events` outbox** — never cross-module table reads
  (enforced in CI). This keeps the monolith modular and a future service split mechanical.
- **The product thesis is the feedback loop:** appeal outcomes → payer overturn rates → sharper
  verification confidence, through one shared "brain" (`payer_playbook_rules`) in one database.
- **The one line that encodes it:** `claims.verification_id` + immutable `coverage_snapshot` — a
  claim inherits the estimate's exact snapshot, making estimate-vs-actual a computed fact that drives
  reconciliation and the recovery queue.
- **EDI is bought** (clearinghouse adapter; donor X12 codecs are the mock/fallback). **The LLM
  augments, never decides** (deterministic engines are the baseline; degraded mode → manual queue).
- **Humans keep the judgment:** verification review, patient financial conversation (never
  automated), claim-submit gate, appeal approval, pursue/write-off, rule promotion — all first-class
  gates, not conventions.
- **Safety rails before real PHI/money:** Postgres RLS, remittance idempotency, daily money
  reconciliation, `snapshot_version` everywhere, durable/monitored outbox, BAAs + encryption.
- **Migration is strangler-fig:** the shared backend grows under both live donor apps; per-practice
  feature flags + shadow mode for the money-touching cutovers; both test suites stay green every
  phase.

## Phase alignment (implementation, post-approval)

P0 scaffold ✓ → P1 core+auth+RLS → P2 verification+adapters+outbox → P3 remittance+money-safety →
P4 claims/denials/queue/timeline → P5 inheritance bridge → P6 feedback loop → P7 one shell +
decommission + hardening. Full detail in doc 15.
