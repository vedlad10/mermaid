# Coordination of benefits and secondary claims

Migration `0034`. This covers what happens when a payer says another plan is involved, what the operator
does about it, and what the system will and won't decide on its own.

## The problem this closes

A primary payer can pay part of a claim and say the rest belongs to another plan:

- **CLP02 = 19 or 20.** The claim was processed as primary (19) or secondary (20) and forwarded to
  another payer.
- **CAS OA-23.** An amount was adjusted because of another payer's adjudication.
- **NM1\*TT** (loop 2100) optionally names the crossover carrier the claim was forwarded to.

Before 0034, the safety gate held a status-19 advice, and any release reason typed in free text
posted it. Nobody recorded whether the patient actually had another plan, and the money assigned to
that plan was never tracked. Staging's held R1 (status 19, OA-23, no NM1\*TT) is exactly this case.

## The model

One **coordination case** per claim (`coordination_cases`, unique on practice + patient control
number), owned by the Remittance module:

| Field | Meaning |
|---|---|
| `coverage_status` | `unconfirmed` → `no-other-coverage` / `other-coverage`. One-way. Set **only** by a person with evidence. |
| `work_status` | Derived, never set: `not-needed`, `awaiting-coverage`, `ready-to-file`, `return-to-primary`, `filed`, `closed`. |
| `assigned_cents` | Money the payer assigned to another plan: the latest posted advice, else the latest held one. Rejected advices don't count. |
| `record` | Versioned JSONB: evidence per remittance, the confirmation, any request, filing, closure, and history. |

The table's CHECKs refuse a coverage answer without its evidence, and a stored work status that
disagrees with the money. RLS is `enable_tenant_rls`.

**Never inferred:**

- Coverage is never read from `cob_order` or an eligibility response.
- No coverage row is created or edited.
- No secondary payer is invented. The crossover carrier (NM1\*TT) and a 271's other-payer loop
  (EB\*R / 2120) are shown as evidence for a person to weigh, never used as the answer.

## The operator workflow

Open the advice from **Money** (or its row on **Today** / **Recover**). The coordination panel
shows:

- what the payer said, including "names no other plan" when there is no NM1\*TT;
- the money breakdown. The assigned amount is labelled **not collected**;
- what is missing before the advice can be released.

1. **Find out.** If the answer isn't known yet, record the request: who was asked (patient / payer /
   other), when, and a follow-up date. This is work in progress and doesn't breach readiness until
   the follow-up date passes.
2. **Record the answer.** Choose an outcome and a source (payer portal / payer phone / patient /
   other, with a note for "other"), then enter the date the answer was obtained. For
   `other-coverage` the secondary plan's name is required, and its member id is optional. The
   answer is audited with outcome, source and date, and it can't be changed afterwards.
3. **Release.** Release is refused (`409 coverage-unconfirmed`) until step 2 is done. A reason is
   not an answer.
4. **Secondary work** (other coverage, money assigned):
   - The claim shows as *ready to file* with a deadline from the existing filing-deadline engine.
     That deadline is an **estimate**, labelled as such.
   - File it with the other plan, then record the filing (date, optional reference).
   - Close it when that plan answers: *secondary paid*, *secondary denied*, or *written off*.
5. **No other coverage, money assigned:** the work is *return to primary*. The primary payer has to
   reprocess. Close it as *primary reprocessed* or *written off*.

Assigned money is never counted as collected anywhere, at any status. A closure records the outcome.
The payment itself arrives as its own 835.

## Readiness

| Check | Breaches when |
|---|---|
| `money.held_remittance_age` | Held cash nobody is working. Advices held **only** on an unanswered coverage question are left out; they belong to the next check. |
| `coordination.coverage_unconfirmed` | A question nobody asked within the review window, or a follow-up date that has passed. |
| `coordination.secondary_claims` | Open, unfiled secondary work that is urgent or past its (estimated) deadline. |

Answering the coverage question doesn't clear anything by itself. The advice becomes ordinary held
cash again until someone releases it.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/coordination-cases[?open=1]` | `remittances.read` |
| GET | `/api/v1/coordination-cases/:id` | `remittances.read` |
| POST | `/api/v1/coordination-cases/:id/confirm-coverage` | `remittances.write` |
| POST | `/api/v1/coordination-cases/:id/request-confirmation` | `remittances.write` |
| POST | `/api/v1/coordination-cases/:id/mark-filed` | `remittances.write` |
| POST | `/api/v1/coordination-cases/:id/close` | `remittances.write` |

An incomplete answer returns `400` with a `missing` list. A wrong-state transition returns `409`.
Every POST is audited, including the refusals.

## Backfill

Cases open automatically on every ingest, release and reject from 0034 on. For advices that arrived
before 0034:

```bash
npm run db:sync-coordination -- --dry-run   # what it would open; rolled back
npm run db:sync-coordination                # the same service sync, one audit row per practice
```

It is idempotent, it refuses a production-looking host, and it never touches a remittance, posting,
ledger entry, claim or coverage row.
