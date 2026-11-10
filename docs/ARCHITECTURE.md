# Mermaid Architecture

The authoritative rationale lives in the four design documents and the merge assessment
(`../../MERMAID-PHASE1-MERGE-ASSESSMENT.md`, Part II). This is the in-repo summary.

## The core call

**Modular monolith on one PostgreSQL database — not microservices, yet.** The real problem is two
systems not sharing truth; one database with enforced foreign keys and clean internal module
boundaries solves it without distributed-systems overhead. Boundaries are drawn so any module *can*
be peeled into its own service later, but that cost isn't paid now.

## Modules (bounded contexts)

Each is a workspace package that owns its tables, services, and repository. The **only** cross-module
communication is a `domain_events` row (outbox). No module reads another's tables — enforced by
`platform/tools/check-boundaries.mjs` in CI.

| Module | Owns | Publishes | Consumes |
|---|---|---|---|
| Verification | patients, coverages, verifications | `verification.completed`, `verification.needs_review` | — (reads the payer track record from `platform/payer-profile` — see below) |
| Claims | claims | `claim.submitted`, `claim.filing_risk` | `verification.completed`, `remittance.posted` |
| Remittance | remittances, postings, claim_expectations | `remittance.posted`, `variance.detected` | `claim.submitted` |
| Denials & Appeals | denials, appeals | `denial.created`, `denial.closed`, `appeal.outcome.recorded` | `variance.detected` |
| Patient Ledger | ledger_entries | `patient.charged`, `patient.payment.recorded` | `remittance.posted`, `denial.closed` |
| Analytics | analytics_facts (projections) | — | all events |
| Payer Profile *(platform, not a module — see MODULE-BOUNDARIES.md)* | payers, payer_playbook_rules | — | `appeal.outcome.recorded` |

**Patient identity travels with the money.** `claim.submitted` carries the patient; the expectation
Remittance records from it carries the member ID forward; `remittance.posted`, `variance.detected`
and `denial.closed` all carry it onward. That is what lets the Patient Ledger know *whose* balance a
payer's decision creates, and what lets an appeal letter name the member and the claim without a
human retyping either.

## Platform (cross-cutting)

- **db** — migrations, RLS, repository base. One Postgres; every tenant table under RLS.
- **events** — outbox `domain_events` + durable worker (`FOR UPDATE SKIP LOCKED`, leased), plus the
  operational read/write surface (backlog, dead letters, revive) the Ops screen is built on.
- **auth** — DB-backed sessions, superset RBAC, per-transaction practice context for RLS.
- **crypto** — AES-256-GCM envelope encryption for the four raw-PHI payloads. Application-level, not
  pgcrypto, so the key never becomes a query parameter and never reaches a query log.
- **edi** — clearinghouse adapter (bought); ported X12 codecs are the mock/dev + paper fallback.
- **llm** — provider adapter + degraded-mode router (outage → manual-review queue, never hang).
- **observability** — structured logs, append-only audit, event-lag monitoring.
- **payer-profile** — the shared learning brain: global reference data plus learned overturn rates.
  Platform, not a module, deliberately — see `MODULE-BOUNDARIES.md`.

## The learning loop, both halves (M11)

An appeal outcome is the only place real-world evidence enters this system, and it now travels in
both directions:

- **Back half.** `appeal.outcome.recorded` → the Beta-Binomial posterior in `platform/payer-profile`
  → the next identical denial is triaged against evidence rather than a prior.
- **Front half.** The same accumulated evidence becomes a **"Payer track record"** confidence
  component on the *next verification of that payer* — the `S -.sharpens.-> D` edge of the unified
  RCM workflow, and roadmap §5's "sharpens future confidence scoring".

Three properties make the front half safe to switch on, and each is covered by a test:

1. **Below the trust threshold the component is not added at all.** Absence, not a neutral 1.0 —
   because confidence is an average, a neutral value for an unknown payer would *raise* the score of
   every verification of every unfamiliar payer. Ignorance costs nothing and buys nothing.
   (Human-in-the-loop §9's sanity gate, applied to the front half.)
2. **Its influence is bounded and the bound was measured, not guessed.** Aggregation is weakest-link,
   so a floor set too low makes this term the new minimum and sends a whole payer's work to review.
   At worst it moves a representative verification from 0.82 to 0.80 — never enough alone to force a
   review, enough to tip one that was already marginal.
3. **It is read directly, not projected.** Blueprint docs 05/11 route this through a
   `payer_rule.updated` event into a Verification-side cache. That is how a *module* would have to
   consume it; the payer profile is platform precisely because its data is global and meant to be
   read across contexts. A per-module copy would add machinery whose only job is to go stale.

## Non-negotiable safety rails (before real PHI / money)

From `architecture-risk-review.md` — enforced, not aspirational:

1. **Postgres RLS** tenant isolation (§0002 migration) — DB-enforced, app scoping is backup only. ✅
2. **Idempotency** on remittance ingest — a redelivered 835 must not double-post. ✅ And on every
   other consumer: claims on `verification_id`, analytics facts on `source_event_id`, patient charges
   on `source_ref` — each a database UNIQUE constraint, never a service-layer check.
3. **Daily reconciliation** of auto-posted totals vs. raw-835 checksums, alerting on drift. ✅
4. **`snapshot_version`** on every JSONB document (§0001 `jsonb_has_version`). ✅
5. **Durable, monitored outbox** — the feedback loop must never stall silently. ✅ Monitored at M10:
   `GET /api/v1/ops/outbox` and the Ops screen surface depth, lag and dead letters, with a human
   retry. A stalled queue is the one failure no business screen reveals.
6. **Encryption at rest** for raw PHI. ✅ at M10 (`platform/crypto`). BAAs with every PHI
   subprocessor and LLM degraded mode remain open — both are procurement/vendor decisions, not code.
7. **Append-only audit** of every mutation, written in the same transaction as the change. ✅ at M10.
   The application role has no INSERT on `audit_events` — writes go through a `SECURITY DEFINER`
   function, so history cannot be rewritten by the thing being audited.

## Human-in-the-loop boundaries (enforced as first-class gates)

From `human-in-the-loop-workflow.pdf`. The system automates the data work and **never** the
relationship/judgment work:

- Low-confidence verification → coordinator review.
- **Patient financial conversation is never delivered by software** — the estimate is generated; a
  human communicates it. The same holds for a statement: the Patient Ledger produces the plain-English
  lines and a person reads them out. Nothing is emailed or texted to a patient.
- **Money never leaves a patient balance without a named person.** Payments, courtesy adjustments and
  write-offs all require an actor from the session, and the last two additionally require a reason —
  revenue a practice chooses to lose should never be untraceable.
- Claim submission keeps a human gate for atypical / above-threshold claims.
- Auto-post clean remits only; exceptions route to a biller.
- Pursue-or-write-off stays human above a practice-set threshold.
- Appeals are AI-drafted but **human-approved before they reach a payer**.
- Feedback-loop rule changes get a small-sample sanity check before they're trusted broadly.
- Clinical treatment is out of scope — the platform is bounded at the financial layer.
