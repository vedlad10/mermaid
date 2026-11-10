# 14 — Folder Structure (complete, file-level)

*Blueprint doc 14 of 16. The concrete tree implementation must match. Files marked `(P0 ✓)` exist;
the rest are created in the phase noted.*

```
mermaid/
├── package.json                                (P0 ✓)  workspace root, scripts
├── tsconfig.base.json                          (P0 ✓)
├── tsconfig.json                               (P0 ✓)  project references
├── .gitignore / .gitattributes / .env.example  (P0 ✓)
├── README.md                                   (P0 ✓)
├── .github/workflows/ci.yml                    (P0 ✓)
│
├── docs/
│   ├── ARCHITECTURE.md                          (P0 ✓)
│   ├── MODULE-BOUNDARIES.md                     (P0 ✓)
│   └── architecture/  01..16 + 00-index.md      (blueprint — this set)
│
├── packages/shared/
│   ├── package.json                             (P0 ✓)
│   ├── tsconfig.json                            (P0 ✓)
│   └── src/
│       ├── index.ts                             (P0 ✓)
│       ├── snapshot.ts                          (P0 ✓)  snapshot_version contract
│       ├── ids.ts                               (P1)    branded id types (PracticeId, ClaimId…)
│       ├── money.ts                             (P1)    integer-cents money type + helpers
│       ├── roles.ts                             (P1)    Role union + permission keys
│       ├── events.ts                            (P2)    DomainEvent<T> envelope + event-type union
│       ├── cdt.ts                               (P2)    CDT reference (from donor knowledge.js)
│       └── domain/                              (P2+)   Patient, Coverage, Verification, Claim, …
│
├── platform/
│   ├── db/
│   │   ├── package.json                         (P0 ✓)
│   │   ├── migrate.mjs                          (P0 ✓)  runner (immutable, checksummed)
│   │   ├── pool.ts                              (P1)    pg Pool + withPractice(tx) helper
│   │   ├── repository.ts                        (P1)    base repository (tx, RLS context)
│   │   └── migrations/
│   │       ├── 0001_conventions.sql             (P0 ✓)
│   │       ├── 0002_rls_foundation.sql          (P0 ✓)
│   │       ├── 0003_core_tenancy.sql            (P1)    practices, staff_users, sessions, audit
│   │       ├── 0004_payer_profile.sql           (P1)    payers, payer_playbook_rules
│   │       ├── 0005_patients_coverages.sql      (P1)    patients, coverages
│   │       ├── 0006_verifications.sql           (P2)
│   │       ├── 0007_domain_events.sql           (P2)    outbox
│   │       ├── 0008_remittances_postings.sql    (P3)
│   │       ├── 0009_claims.sql                  (P4)    claims, claim_lines
│   │       ├── 0010_denials_appeals.sql         (P4)
│   │       ├── 0011_timeline_events.sql         (P4)
│   │       ├── 0012_queue_items.sql             (P4)
│   │       └── 0013_inheritance_bridge.sql      (P5)    claims.verification_id + coverage_snapshot
│   ├── events/
│   │   ├── README.md                            (P0 ✓)
│   │   ├── publish.ts                           (P2)    write event in caller's tx
│   │   ├── worker.ts                            (P2)    SKIP LOCKED poller + dispatch
│   │   ├── registry.ts                          (P2)    subscriptions
│   │   └── __tests__/                           (P2)
│   ├── auth/
│   │   ├── README.md                            (P0 ✓)
│   │   ├── password.ts / session.ts / rbac.ts / guard.ts / service.ts   (P1)
│   │   └── __tests__/                           (P1)
│   ├── queue/
│   │   ├── engine.ts                            (P4)    scoreItem, rebuild
│   │   ├── producers.ts                         (P4)    event → queue-item mappers
│   │   └── __tests__/                           (P4)
│   ├── edi/
│   │   ├── README.md                            (P0 ✓)
│   │   ├── adapter.ts                           (P2)    EdiAdapter interface
│   │   ├── mock/{x12-271.ts,x12-835.ts,index.ts}(P2)    ported donor codecs
│   │   └── vendors/<vendor>.ts                  (P2+)   real clearinghouse
│   ├── llm/
│   │   ├── README.md                            (P0 ✓)
│   │   ├── adapter.ts / router.ts               (P2)    provider iface + degraded-mode
│   │   └── providers/<provider>.ts              (P2+)
│   ├── observability/
│   │   ├── README.md                            (P0 ✓)
│   │   ├── logger.ts / audit.ts / metrics.ts    (P1)
│   │   └── event-lag.ts                          (P6)
│   └── tools/
│       └── check-boundaries.mjs                 (P0 ✓)
│
├── modules/
│   ├── verification/   src/{index,types,service,repository,events,engine/*}  (P2)
│   ├── claims/         src/{...}                                            (P4/P5)
│   ├── remittance/     src/{...}                                            (P3)
│   ├── denials-appeals/src/{...}                                            (P4)
│   ├── payer-profile/  src/{...}                                            (P1/P6)
│   └── analytics/      src/{...}                                            (P4)
│         each: README.md (P0 ✓) + package.json + src/* + __tests__/*
│
├── apps/web/                                    (P2 shell → P7 full merge)
│   ├── README.md                                (P0 ✓)
│   ├── package.json / next.config.ts / tsconfig.json
│   └── src/
│       ├── app/                                 # Next App Router
│       │   ├── (dashboard)/page.tsx             # unified home / Today queue
│       │   ├── verifications/…  claims/…  remittances/…  denials/…  appeals/…  payers/…  admin/…
│       │   └── api/v1/…                         # BFF route handlers → module services
│       ├── components/                          # AppShell, ProvenancePanel, EstimateSummary, ui
│       └── lib/client/                          # typed fetch client
│
└── tests/
    ├── e2e/                                     (P2+)  full-lifecycle scenarios
    ├── shadow/                                  (P3/P5) old-vs-new diff harness
    └── hitl/                                    (P2+)  human-in-the-loop guardrail tests
```

## Conventions

- **Migrations are global and ordered** (`platform/db/migrations/NNNN_*.sql`), not per-module
  directories, so ordering across modules is explicit and the runner is trivial (doc 15). Each
  migration's header names the owning module.
- **Tests** co-locate as `__tests__/*.test.mjs` beside code (donor pattern, `node --test`), except
  cross-module e2e/shadow/hitl which live under top-level `tests/`.
- **One public entry per module** (`src/index.ts`); everything else is module-private by convention
  and by the boundary checker.
