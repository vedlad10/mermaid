# Module Boundaries — the one rule that must not erode

> A Claims-module function must never directly query the `verifications` table. Cross-module
> interaction happens **only** through domain events. This is what keeps a future service split
> mechanical instead of a rewrite — and it's the rule most likely to erode under deadline pressure,
> so it is **enforced in CI, not left to memory** (`architecture-risk-review.md` §5).

## What a module may import

- **Itself** — anything under its own `modules/<name>/` directory.
- **`@mermaid/shared`** — shared domain types and conventions (e.g. `snapshot_version`).
- **`platform/*`** — db, events, auth, edi, llm, observability, payer-profile.
- **Node stdlib and declared npm dependencies.**

### Note: payer-profile lives in `platform/`, not `modules/` (M7)

Blueprint doc 02 lists Payer Profile among the six bounded contexts, and it was originally scaffolded
as `modules/payer-profile/`. It now lives in `platform/payer-profile/`, so every module may read it
directly. The full reasoning is in that package's README; the short version is that its data is
explicitly GLOBAL — migration 0004 gives `payers` and `payer_playbook_rules` no `practice_id` and no
RLS, so that overturn rates accumulate across every practice — and the blueprint itself describes it
as "written by Appeals, read by Verification", which is a cross-context read this very rule forbids
between peer modules.

It is reference data plus learned statistics: the same category as the CDT catalog and the CARC
table, which already live in shared/platform. Writes still come from exactly one place (Denials &
Appeals, via `appeal.outcome.recorded`), so the single-writer discipline is intact.

### Note: the event catalog is where two modules agree on a shape (M9)

When a module needs a fact another module holds — the member ID a claim was filed under, say — the
answer is never "read their table" and never "ask a human to retype it". It is to add the field to
the event that already crosses between them, in `platform/events/src/catalog.ts`, which both may
import because it lives in platform and depends only on `@mermaid/shared`.

M9 is the worked example. The Patient Ledger has to know *whose* balance a payer's decision creates,
and Denials has to name the member and the claim on an appeal letter. Neither may query Claims. So
patient identity now travels with the money: `claim.submitted` carries the patient, the expectation
Remittance records from it carries the member ID forward, and `remittance.posted`,
`variance.detected` and `denial.closed` all carry it onward. Before that, the appeal-draft screen was
asking the browser for values it could not know, and sending empty strings.

## What a module may NOT do

- Import from a sibling module (`@mermaid/claims`, `../claims/...`, etc.).
- Read or write another module's tables (repository scoping + RLS make this fail).
- Call another module's service functions directly.

To make something happen in another module, **publish a domain event**; the other module subscribes.

## Layering — the other direction (M10)

The rule above stops modules coupling **sideways**. A second rule stops the stack **inverting**:

```
packages/shared  ←  platform/*  ←  modules/*  ←  apps/*
```

Dependencies point left; nothing pointing right is legitimate. Each inversion is expensive in its own
way — `platform/db` importing a module would make the persistence layer un-reusable and a future
service split circular; `@mermaid/shared` importing platform would drag a Postgres pool into every
pure-function test in the repository.

## Enforcement

`platform/tools/check-boundaries.mjs` scans every file under `modules/**` for import specifiers that
reference another module, and every file under `packages/`, `platform/` and `modules/` for imports
that point the wrong way up the stack. Either fails CI. Run locally with:

```bash
npm run boundaries
```

## Tenant isolation is also a boundary

Every tenant table is under Postgres RLS keyed on `current_practice()` (migration `0002`). The app
sets the practice context per transaction from the authenticated session — never from client input:

```
BEGIN;
SELECT set_current_practice($practiceIdFromSession);
-- ... all queries here see only this practice's rows ...
COMMIT;
```

The application connects as a non-owner, non-superuser role so RLS is never bypassed.
