# Mermaid — AI Revenue Cycle Platform

One unified, AI-native Revenue Cycle Operating System for dental practices. Mermaid manages the
complete financial lifecycle:

```
Appointment → Insurance Verification → Estimate → Treatment → Claim → Submission →
Remittance → Payment Posting → Reconciliation → Denial Detection → Appeal Management →
Revenue Recovery → Continuous Learning
```

Mermaid is a **modular monolith on one PostgreSQL database** — the consolidation of two prior
products (**Dental Verify**, the front half; **AI Remit**, the back half) into a single repository,
architecture, domain model, auth system, API, and UI.

> **Trying it:** `npm run demo:journey` runs the whole revenue cycle on a laptop and leaves it up at
> http://127.0.0.1:3108; `npm run audit:synthetic` produces the retrospective leak audit's report.
> What each proves, what is mock, and what still blocks a real practice: `docs/MVP-TESTING.md`.

> **Source of truth:** the four design documents govern this build and override the code wherever
> they conflict — `unified-rcm-workflow.mermaid`, `ai-revenue-cycle-implementation-roadmap.md`,
> `architecture-risk-review.md`, `human-in-the-loop-workflow.pdf`. The merge assessment and phased
> plan live in `../MERMAID-PHASE1-MERGE-ASSESSMENT.md`.

## Architecture at a glance

- **One Postgres DB**, six event-coupled modules, outbox-driven async workers.
- **Modules** (each owns its tables; cross-module communication is *only* via `domain_events`):
  Verification · Claims · Remittance · Denials & Appeals · Patient Ledger · Analytics.
  (Payer Profile is deliberately platform, not a module — see `docs/MODULE-BOUNDARIES.md`.)
- **Adapters** behind swappable interfaces: EDI clearinghouse (X12 codecs as the mock/dev impl),
  LLM provider (with a degraded-mode router).
- **Safety rails** (mandated by `architecture-risk-review.md`, enforced before real PHI/money):
  Postgres **RLS** tenant isolation, **idempotency** on every consumer via a database constraint,
  daily **reconciliation** of auto-posted money, `snapshot_version` on every JSONB blob, a durable
  and now **monitored** outbox, **PHI encrypted at rest**, and an **append-only audit** of every
  mutation that the application role cannot rewrite.
- **Two enforced boundaries**, both checked in CI by `npm run boundaries`: no module imports a
  sibling, and dependencies never point up the stack (`shared ← platform ← modules ← apps`).

See `docs/ARCHITECTURE.md` and `docs/MODULE-BOUNDARIES.md`.

## Layout

```
apps/web/          clinic web app: /api/v1 server + static UI (zero-dep node:http)
modules/*          bounded contexts (own tables + services + repository)
platform/db        migrations, RLS policies, migration runner, PHI backfill
platform/events    domain_events outbox + worker + the ops admin surface
platform/auth      sessions, RBAC, practice scoping
platform/crypto    AES-256-GCM envelope encryption for raw PHI
platform/edi       clearinghouse adapter (+ x12 mock/fallback)
platform/llm       provider-independent LLM adapter + degraded-mode router. `LLM_PROVIDER=off` is
                   the default and a supported state: every AI feature falls back to the
                   deterministic engine it augments. This layer never throws and never hangs.
platform/payer-profile  the shared learning brain (global, not tenant-scoped)
platform/observability  structured logs, append-only audit, event-lag monitor
platform/tools     the boundary + layering checker
packages/shared    domain types, snapshot schemas + versions
tests/             cross-module vertical slices + live-database harnesses
```

## Status — the cycle is complete; the clearinghouse is not

The whole cycle runs, is durable, is tenant-isolated, and is measured — **against a mock
clearinghouse.** That distinction is the whole status, so it goes above the table rather than in a
footnote: every claim, payment, denial and recovery this product has ever processed came from
`MockEdiAdapter`. Eligibility is real (live 270/271 through Stedi, both the success and the refusal
path), and nothing downstream of a filed claim has completed once against a real payer, because the
Stedi account is a sandbox and sandbox accounts cannot submit claims at all.

This heading used to read "pilot-ready", which was a fair description of the engine and not of the
product a practice would receive. See `DEPLOYING.md` → *Standing up a deployment for a real
practice* for everything an environment needs before anybody signs into it.

| | |
|---|---|
| **Verify** | Card text → payer identification → 271 eligibility → deterministic estimate → confidence gate → human review where it cannot settle itself. The estimate is then **frozen** into a `CoverageSnapshot`. |
| **Bill** | The snapshot becomes a claim over an event — never recalculated. Scrubbed, then released to the payer by a **named person**. |
| **Collect** | The payer's 835 is posted against the frozen estimate, gated on money safety. Every shortfall is split three ways: contractual (do not chase), the patient's, and **recoverable**. |
| **Recover** | Each recoverable reason is triaged against a payer playbook, an appeal is drafted with its evidence checklist, a **human approves it**, and the outcome is recorded. |
| **Learn** | That outcome updates a Beta-Binomial posterior, so the next identical denial is triaged against evidence rather than a prior — **and, once a payer has enough recorded outcomes, the next _verification_ of that payer is scored against its track record too.** Both halves of the loop are closed: what happened to an appeal changes both how the next denial is worked and what the next estimate is worth. |
| **Bill the patient** | Whatever the payer left them becomes a balance that ages, with payments applied oldest-charge-first and every reduction attributable to a person. |
| **Know** | One ranked worklist across every context (**Today**), a practice report over both halves of the money (**Insights**), and queue/audit/readiness for whoever operates it (**Ops**). |
| **See one person** | Everything above, for one human: profile, every plan they hold, every coverage check and what it quoted them, every claim and what the payer did with it, every denial and appeal, the ledger and the balance — on **one chronological spine** (**Patients → a person's record**). A member-ID change no longer splits a patient's history in two. |

**2,349 unit tests, 199 live-database tests**, typecheck and both boundary rules clean. Migrations
0001–0028 applied against Postgres 18.4.

<sub>These numbers go stale between sessions and have done before — they read 873/105 and
"0001–0016" for several milestones after they stopped being true. If you are reading this and want
the current answer rather than the last recorded one: `npm test` and `npm run test:db` print it, and
`npm run migrate:status` lists what is applied.</sub>

## Where the AI is

**Deterministic core · AI at the edges · human release for anything that leaves the building.**

The revenue cycle above is deterministic end to end, and stays that way. Coverage math, the 18-rule
scrubber, the three money-safety gates, four-way variance attribution, CARC→disposition triage and
the Beta-Binomial posterior are solved problems, are tested, and are better than a model at their
jobs. **No AI feature can be switched on that changes any of them.** `LlmAdapter` offers exactly
three kinds of operation — extraction, drafting, narration — and deliberately has no `decide()`,
`score()` or `classify()`; a guardrail test asserts the absence.

Built today:

| | what the model does | what it cannot do |
|---|---|---|
| **Read a card** (Verification) | reads a photograph into structured fields *and* a verbatim transcription | it does not identify the payer — it transcribes a name, and the one existing registry resolves it. Confidence comes from agreeing with the regex engine over its own transcription, never from the model's self-report. Disagreement about the payer or member ID is a **critical** exception. |
| **Draft an appeal argument** (Denials) | writes one paragraph: why this procedure, denied under this code, by this payer, should be reprocessed | it does not decide to appeal (the playbook already did, before the prompt exists), and does not write the claim number, member ID, service date, amount, codes or evidence list. A human edits and approves; **editing revokes any approval**. |
| **Explain a denial** (Denials) | one plain-English sentence over already-decoded CARC data and the other codes on the same claim | it states no numbers and recommends nothing — both are on the screen, computed. Not persisted. |

Every one of these degrades to exactly what the product did before it existed. A provider that is
off, down, slow, rate-limited or answering nonsense costs a paragraph on a screen, never a claim.

**Two of the three need no PHI at all** — an argument about a CDT code and a CARC code is not
information about an identifiable person — so they run before any BAA exists. Card reading cannot be
made PHI-free (the image *is* the PHI) and is refused before it leaves the process until
`LLM_PHI_APPROVED=1`, which is a separate flag from `LLM_PROVIDER` on purpose.

**No vendor LLM API has been called from this repository.** `AnthropicProvider` is tested against a
fake `fetch` and against a real local HTTP server — proving request shape, status classification and
abort semantics, and proving nothing about whether the live API accepts it. See
`platform/llm/README.md` for the activation steps.

What remains is procurement rather than code: a real EDI clearinghouse vendor, a BAA-eligible LLM
provider, and a backup/PITR policy. See `docs/project-memory/SESSION_CHECKPOINT.md`.

## Getting started

Requires Node ≥ 22. There is **no build step** — the TypeScript runs directly under Node.

```bash
npm install
npm run web              # → http://localhost:3000, lands on Today
npm test                 # unit + business suite (no database)
npm run boundaries       # the two structural rules
```

Without `DATABASE_URL` the app runs entirely in memory, seeds a realistic day of work, and needs no
login — that is the laptop demo, and it is the same code path production uses.

With a database:

```bash
DATABASE_ADMIN_URL=... npm run db:provision-role   # creates the unprivileged app role, and revokes
                                                   # its write grant on the audit trail
npm run migrate && npm run db:verify               # apply schema, prove RLS by execution
npm run test:db                                    # live-database integration suite
```

Re-run `db:provision-role` after every migration. It is idempotent, and it is the only thing that
restores the append-only revoke on `audit_events` — which has drifted before, silently. Readiness
reports `audit_trail_append_only` for exactly this.

To fill a database with something worth looking at:

```bash
npm run demo:seed -- --patients 70 --days 90   # a plausible quarter, built by driving the REAL
                                               # services through the MOCK clearinghouse, so every
                                               # figure on every screen is still derived rather
                                               # than written, and every row is labelled DEMO DATA
npm run demo:scenarios                         # four named journeys over the real HTTP API;
                                               # exits non-zero if the harness could not read
                                               # the product, zero if the PRODUCT refused something
```

Set `PHI_ENCRYPTION_KEY` (see `.env.example`) to encrypt raw cards, 271s, 837s and 835s at rest —
required in production, where the app refuses to start without it.
