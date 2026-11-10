# module: remittance

**Bounded context.** remittances, postings — 835 ingestion, money-safety gating, payment posting,
and **estimate-vs-actual variance detection**.

Owns its own tables, services, and repository. Communicates with other modules **only** via domain
events (see `../../docs/MODULE-BOUNDARIES.md`).

## The idea

This module answers the question a practice owner actually asks: **"the payment arrived — did we get
what we were promised, and if not, why?"**

That question is only *answerable* because of the architecture upstream. The claim carried the
verification's immutable coverage snapshot forward (blueprint doc 00's keystone), so "what we were
promised" is a recorded fact rather than a reconstruction. Comparing it to what the payer actually
paid is arithmetic — and every dollar of the difference can be attributed to a named reason.

## The attribution is the product

A clinic does not need to be told it was paid $100 less than expected. It needs to be told *which*
$100 is normal, *which* is the patient's, and *which* is money someone still owes — because those
three have completely different next actions:

| Bucket | Meaning | Next action |
|---|---|---|
| **contractual** | The payer's fee schedule sits below our fee (CO-45, CO-131) | Nothing. Cost of being in network. |
| **patient** | Deductible, coinsurance, exhausted benefits (PR-\*, CO-119, CO-27) | Bill the patient. |
| **recoverable** | Missing info, bundling, absent pre-auth (CO-16, CO-97, CO-197, …) | Correct it or appeal it. **This is the recovery queue.** |
| **unexplained** | Withheld with **no reason code at all** | Query the payer. Nothing but arithmetic surfaces this. |

`variance.detected` is published **only** for the last two. Publishing contractual write-offs or
patient balances would flood the recovery queue until staff stopped reading it.

## Money safety (blueprint P3)

Three gates stand between a payer's file and the practice's ledger. The reasoning is asymmetric: a
remittance that fails to post is an inconvenience someone notices within a day, while one that posts
*twice* — or posts numbers that do not add up — corrupts the ledger a practice bills patients and
reports revenue from. **Refusing to post is always the cheaper failure.**

1. **Idempotency.** One trace number posts exactly once. Guarded in the service *and* by the
   repository's unique key, because a clearinghouse re-serving an ERA, the outbox delivering at least
   once, and staff re-uploading a file are all normal traffic — not edge cases.
2. **Balance.** `charged = paid + adjustments` on every claim, and the payment total must equal the
   claims less provider adjustments. **Arithmetic is never overridable**, not even by a human with a
   reason — `release()` refuses an unbalanced advice.
3. **Reversal isolation.** A CLP-22 reversal retracts a prior payment and is never auto-posted.

Plus `reconcile()` — daily money reconciliation. Non-zero drift means the ledger and the bank will
disagree, and it is reported as a hard alert rather than a report line.

One deliberate asymmetry: an **unmatched payment** (money for a claim we have no record of filing)
is a *notice*, not a blocker. The cash is real and must reach the ledger; blocking it would create a
worse reconciliation problem than the one it prevents.

## What lives here

| File | Role |
|---|---|
| `src/engine/variance.ts` | Estimate vs. actual, and the four-way attribution. The payoff of the keystone. |
| `src/engine/safety.ts` | The money-safety gates + daily reconciliation. |
| `src/repository.ts` | Two seams: remittances (keyed on trace number) and the **expectation ledger**. |
| `src/service.ts` | Ingest → gate → post → publish. Idempotent throughout. |
| `src/subscriptions.ts` | The module's entire inbound coupling: one subscription to `claim.submitted`. |
| `src/view.ts` | Read-models, including `buildRecoveryQueue` — "where is our missing revenue?" |

### The expectation ledger

Remittance may not read Claims' tables, so it builds its own projection from `claim.submitted`
events. This is what makes cross-module variance possible: by the time an 835 lands weeks later, the
expectation is already recorded here, keyed on the **clinic's** control number (837 CLM01) — which is
what the payer echoes back in CLP01. Matching on the *payer's* control number instead would silently
tie no payment to any claim.

## AI

None. Every rule here is deterministic and inspectable. A number that decides whether a practice
chases a payer, or that lands in a revenue report, must be reproducible.

## Not yet built

- Postgres repositories (`remittances` / `postings` + RLS) — migration 0006.
- Patient-balance handoff: `PR` amounts are computed but nothing bills the patient yet.
- Secondary-payer coordination of benefits (a second 835 against the same claim works, but COB
  sequencing is not modelled).
- Reversal handling beyond refusing to auto-post one.
- Feeding recovery outcomes back into `payer_playbook_rules` — the learning loop (P6), which needs
  the Denials & Appeals module first.
