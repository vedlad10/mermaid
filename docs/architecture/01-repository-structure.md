# 01 — Repository Structure

*Blueprint doc 1 of 16. Status: proposed, awaiting approval. Once approved, implementation follows this literally.*

## Decision

**One repository, one modular-monolith deployable, npm workspaces.** Not a polyrepo, not
microservices. The problem Mermaid solves is two systems not sharing truth; one repo + one database
+ enforced internal boundaries solves it without distributed-systems overhead
(`ai-revenue-cycle-implementation-roadmap.md` §0).

## Top-level layout

```
mermaid/
├── apps/
│   └── web/                    # the single Next.js app — one nav, one login (UI + BFF/API routes)
├── modules/                    # the six bounded contexts (business logic)
│   ├── verification/
│   ├── claims/
│   ├── remittance/
│   ├── denials-appeals/
│   ├── payer-profile/
│   └── analytics/
├── platform/                   # cross-cutting infrastructure (no business rules)
│   ├── db/                     # migrations, RLS, repository base, connection pool
│   ├── events/                 # domain_events outbox + durable worker
│   ├── auth/                   # sessions, RBAC, practice context for RLS
│   ├── edi/                    # clearinghouse adapter (+ x12 mock/fallback)
│   ├── llm/                    # provider adapter + degraded-mode router
│   ├── queue/                  # unified value-ranked "Today" queue engine
│   ├── observability/          # structured logs, audit, event-lag monitor
│   └── tools/                  # build/CI helpers (boundary checker, etc.)
├── packages/
│   └── shared/                 # domain types + conventions every module may import
├── tests/                      # cross-module + e2e + shadow-diff harnesses
├── docs/
│   └── architecture/           # THIS blueprint (01–16)
├── .github/workflows/ci.yml
├── package.json                # workspace root + scripts
├── tsconfig.base.json / tsconfig.json
├── .env.example
└── README.md
```

## Workspace dependency rules (the spine of the whole design)

```
apps/web ──▶ modules/*          (the BFF calls module public APIs)
modules/*  ──▶ platform/*, packages/shared
platform/* ──▶ packages/shared
modules/*  ─X─ modules/*         (FORBIDDEN — cross-module only via domain events)
```

- A **module** may import: itself, `@mermaid/shared`, any `platform/*`, Node stdlib + declared deps.
- A **module may NOT** import another module, read another module's tables, or call another
  module's services. It publishes/consumes domain events instead.
- **`apps/web`** is the only place allowed to compose multiple modules (as an API/BFF), and it does
  so through each module's published entry point (`modules/<name>/src/index.ts`), never their internals.
- **`packages/shared`** has zero dependencies on anything else in the repo — it is pure types/utils.

Enforced by `platform/tools/check-boundaries.mjs` in CI (already live from P0) and by ESLint
import-restriction config added in P2. See `docs/MODULE-BOUNDARIES.md`.

## Package identity & naming

| Path | Package name | Kind |
|---|---|---|
| `packages/shared` | `@mermaid/shared` | library (TS) |
| `platform/db` | `@mermaid/db` | library (TS + `.mjs` runner) |
| `platform/events` | `@mermaid/events` | library |
| `platform/auth` | `@mermaid/auth` | library |
| `platform/edi` | `@mermaid/edi` | library |
| `platform/llm` | `@mermaid/llm` | library |
| `platform/queue` | `@mermaid/queue` | library |
| `platform/observability` | `@mermaid/observability` | library |
| `modules/verification` | `@mermaid/verification` | module |
| `modules/claims` | `@mermaid/claims` | module |
| `modules/remittance` | `@mermaid/remittance` | module |
| `modules/denials-appeals` | `@mermaid/denials-appeals` | module |
| `modules/payer-profile` | `@mermaid/payer-profile` | module |
| `modules/analytics` | `@mermaid/analytics` | module |
| `apps/web` | `@mermaid/web` | app (Next.js) |

## Language & runtime conventions

- **TypeScript everywhere** in modules/app/shared (strict, `NodeNext`, native type-strip for tests).
- **Plain Node ESM (`.mjs`)** allowed for dependency-light platform scripts (migration runner,
  boundary checker) — the "runs on minimal hardware, no build step" doctrine both donor apps share.
- **Node ≥ 22**, **PostgreSQL ≥ 15** (16 in CI).
- Runtime dependencies kept minimal: `pg` (Postgres driver) + Next.js/React for the app; the EDI
  and LLM vendor SDKs enter only behind their adapters when a vendor is chosen (P2).

## What lives OUTSIDE this repo during migration

Per the strangler-fig plan (doc 15), the two donor apps (`healthcare-ai-assistant`,
`dental-rcm-platform`) keep running from their own repos until their phase's feature flag flips and
they are decommissioned in P7. Mermaid grows underneath them; it does not absorb their repos
wholesale.
