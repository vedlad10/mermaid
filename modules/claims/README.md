# module: claims

**Bounded context.** claims, claim_lines — claim creation inheriting the verification snapshot,
scrubbing, submission, filing-deadline risk.

Owns its own tables, services, and repository. Communicates with other modules **only** via domain
events (see `../../docs/MODULE-BOUNDARIES.md`).

## The idea

A claim is not a new estimate — it is the **billing form of one that already exists**. It inherits
the verification's immutable `coverage_snapshot` and never recalculates a benefit. This is the
blueprint's keystone (`docs/architecture/00-index.md`): `claims.verification_id` +
`coverage_snapshot` is what makes estimate-vs-actual a *computed fact* once the remittance arrives,
rather than an argument between two engines that drifted apart.

## The flow

```
verification.completed  ──▶  buildClaimDraft   (copies the snapshot; calculates nothing)
                              │
                              ▼
                          scrubClaim           (deterministic rules; errors block, warnings inform)
                              │
                    ┌─────────┴─────────┐
                  draft                ready
                                         │
                                         ▼
                              submit()  ← A HUMAN. Always.
                                         │
                              837D ──▶ payer ──▶ 277CA
                                         │
                            ┌────────────┴────────────┐
                        submitted                 rejected
                            │
                     claim.submitted ──▶ Remittance, Analytics
```

## What lives here

| File | Role |
|---|---|
| `src/engine/build.ts` | Snapshot → claim draft. Copies; never calculates. |
| `src/engine/scrub.ts` | The deterministic pre-submission gate (18 rules, each with a remediation). |
| `src/engine/deadline.ts` | Timely-filing policy: per-payer windows, risk escalation thresholds. |
| `src/engine/status.ts` | The claim status machine — illegal transitions are refused, not trusted. |
| `src/repository.ts` | Persistence seam (in-memory today, Postgres+RLS in production). |
| `src/service.ts` | Orchestration: idempotent creation, re-scrub, **the submit gate**, void, filing sweep. |
| `src/subscriptions.ts` | The module's entire inbound coupling: two subscriptions (`verification.completed`, `remittance.posted`). |
| `src/view.ts` | Read-models for the API/UI. Never re-derives money. |

## Two invariants worth protecting

1. **Creation is idempotent on `verification_id`.** The outbox delivers *at least once*; a
   redelivered event must not produce a second claim for one visit. Two claims for one treatment is a
   duplicate-billing incident, not a cosmetic bug. In Postgres this is a UNIQUE index; in the
   in-memory repository it is an explicit map.

2. **Nothing here files a claim on its own.** `submit()` requires a named human and a clean scrub.
   There is no timer, no auto-submit, no event handler that releases a bill
   (`human-in-the-loop-workflow` §; blueprint doc 08). The scrubber can only ever *block* — it can
   never *send*.

## AI

None. Every rule in this module is deterministic and inspectable. A rule that decides whether a claim
may be billed, or what a payer will reject, must be reproducible — so the scrubber is plain code, and
AI's role in the platform stays where it adds measurable value (extraction and drafting, upstream,
behind the same confidence + human-review gates).

## Payment (M5)

A claim never decides on its own that money arrived. `remittance.posted` carries the Remittance
module's figures, copied verbatim, and the claim decides only the resulting STATE — a genuine
three-way distinction a biller acts on differently:

| Outcome | Status | What a biller does |
|---|---|---|
| Settled | `paid` | Nothing. |
| Paid some, money still owed | `partially_paid` | Check the remittance's reasons; correct, appeal, or accept. |
| Paid nothing | `denied` | Correct and refile, appeal, or write off. |

`rejected` and `denied` look similar and are not: a **rejection** never reached adjudication (no
reason codes, no appeal rights — fix the file and resend), while a **denial** is the payer's
considered decision (CARC codes, appeal rights, a deadline). Collapsing them would send staff
appealing typos and re-keying genuine denials.

Recording a payment is idempotent on `postingId` — the outbox delivers at least once, and counting
one payment twice would overstate revenue.

## Not yet built

- Postgres repository (`claims` / `claim_lines` + RLS) — lands with migration 0006.
- Attachments/narratives for procedures flagged `requiresNarrative` in the CDT catalog.
- Payer-specific filing windows sourced from the Payer Profile module rather than the local table.
