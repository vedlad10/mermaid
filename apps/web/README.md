# apps/web

The clinic web app — one nav, one API surface under `/api/v1/*` (blueprint doc 06), acting as a BFF
over the module services. The two donor frontends converge here.

## What it is today (M9)

A **zero-dependency Node HTTP server** (`server.ts`, run directly under Node's TypeScript
type-stripping — no framework, no build step) plus a static vanilla-JS UI (`public/`). It serves
the **complete revenue cycle**: verify a patient's coverage → produce an estimate → have a human
settle anything uncertain → the claim appears in the billing worklist carrying that exact estimate →
a human releases it to the payer → the payer's remittance is pulled, gated on money safety, and
posted → the claim closes itself → whatever the payer withheld for a reason worth pursuing lands in
the recovery queue → whatever the payer left the *patient* lands on their account and ages → and all
of it is summarised on one ranked worklist and one practice report.

```bash
npm run web            # from the repo root → http://localhost:3000  (PORT overrides)
```

`server.ts` is also the **composition root** (`wiring.ts`) — the one place that knows all six bounded
contexts exist. It builds the outbox, hands each module service a publisher, and registers every
subscription. No module imports another; this wiring is the only thing connecting them.

### The seven screens

| Tab | Answers |
|---|---|
| **Today** | What needs a person, across every context, ranked by what it costs to leave alone. Composed at request time from each module's own worklist (`today.ts`) — never a projection, so it cannot show work that is already done. |
| Verify | Run a verification; settle anything the pipeline could not. |
| Claims | Release a scrubbed claim to the payer (the human submit gate). |
| Money | Payments in, and the recovery queue: where the missing revenue is. |
| Recover | Work a denial: triage, draft, approve, send, record the outcome. |
| **Patients** | Two questions on one tab, and the search box is which. Empty: what patients owe, how old it is, and every movement on each account. Typing: the **patient master** — every person the practice has seen, including anyone verified and never billed, who is on no A/R list by definition. Opening one gives the **Unified Patient Financial Record**: profile, every plan, every coverage check, every claim, every denial and appeal, the ledger, the balance, and one chronological spine across all five contexts (`patient-record.ts`). |
| **Insights** | Funnel, money (both halves), payer scorecard, costliest denial reasons, and deterministic insights over a 7/30/90-day window. |
| **Ops** | Is anything stuck? Outbox depth, lag, dead letters (with a retry), readiness checks, and the audit trail. The outbox is the one component whose failure is invisible from every other screen. |

### Endpoints (subset of doc 06 implemented so far)

**Verification**
- `POST /api/v1/verifications` — run + persist a verification (body: `{patient, cardText, planItems}`; fees in **dollars**, converted to cents at this boundary)
- `GET  /api/v1/verifications` — value-ranked queue (`?status=` filter)
- `GET  /api/v1/verifications/:id` — full detail view (record + decision + patient summary + freshness)
- `POST /api/v1/verifications/:id/review` — record a human review (`{decision, notes}`)

**Claims**
- `GET  /api/v1/claims` — value-ranked claims queue (`?status=`, `?open=1`)
- `GET  /api/v1/claims/:id` — claim + filing status + scrub findings + the submit gate
- `POST /api/v1/claims` — bill a verification on demand (`{verificationId}`); idempotent, and goes through the *same* payload and service method the event path uses
- `POST /api/v1/claims/:id/scrub` — re-run the scrubber
- `POST /api/v1/claims/:id/submit` — **the human submit gate** (`{submittedBy}`, required)
- `POST /api/v1/claims/:id/void` — withdraw a claim (`{reason}`, required)
- `POST /api/v1/claims/filing-sweep` — escalate timely-filing risk (normally a scheduled job)

**Remittance**
- `GET  /api/v1/remittances` — ranked worklist (`?status=`, `?attention=1`)
- `GET  /api/v1/remittances/:id` — the advice, its postings, and the estimate-vs-actual split
- `POST /api/v1/remittances` — ingest an 835 the clinic already holds (`{raw835}`); idempotent on trace number
- `POST /api/v1/remittances/fetch` — poll the clearinghouse for released remittances
- `POST /api/v1/remittances/:id/release` — release a held advice (`{releasedBy, reason}`, both required)
- `GET  /api/v1/remittances/recovery` — **the recovery queue**: every claim still holding money someone owes
- `GET  /api/v1/remittances/reconcile` — daily money reconciliation

**Denials & appeals**
- `GET  /api/v1/denials` — the recovery worklist plus the practice-wide recovery scoreboard (`?status=`, `?open=1`)
- `GET  /api/v1/denials/:id` — the denial, its frozen triage, and the appeal in play
- `POST /api/v1/denials/:id/draft` — draft the appeal letter and evidence checklist. Takes no required
  input: the denial already carries the member ID, claim number and service date (they arrive on
  `variance.detected`). Any field supplied is treated as a **correction**, not a source.
- `POST /api/v1/denials/:id/approve` — **the human approval gate**; the approver is the session user
- `POST /api/v1/denials/:id/submit` — send an approved appeal; refuses anything unapproved
- `POST /api/v1/denials/:id/outcome` — record what the payer decided (`{won, recoveredAmountDollars?, notes}`) — the only place real-world evidence enters the system
- `POST /api/v1/denials/:id/close` — write off or move to the patient (`{as, reason}`, both required) — **`denials.write`**, not `appeals.write`: deciding whose money a denied amount is, is a billing decision, and a dentist holding `appeals.write` so they can put a clinical name to an appeal must not thereby acquire the power to write revenue off

**Patient master and the unified record (M14)** — `patients.read`
- `GET  /api/v1/patients/directory` — every PERSON the practice has seen (`?q=` over name and chart id).
  Distinct from `/patients` below, which lists *accounts with balances*: someone verified and never
  billed is on this list and not on that one.
- `GET  /api/v1/patients/record/:patientId` — the **Unified Patient Financial Record**. One human,
  assembled from five contexts: profile, plans on file, verifications, claims, denials and appeals,
  the unified ledger across every member ID they hold, both halves of the money reported separately,
  and one chronological `timeline`. Composed at request time (`patient-record.ts`), never projected —
  a patient record that disagreed with the claim it describes would be worse than none, and this is
  the screen a practice quotes when a patient disputes a bill.

  Both routes are matched **before** `/patients/:memberId` below, which is greedy enough to swallow
  them; `server.test.ts` asserts that ordering rather than trusting it.

**Patient ledger (M9)**
- `GET  /api/v1/patients` — every account ranked by what it costs to leave alone, plus the practice's A/R aging (`?owing=1`)
- `GET  /api/v1/patients/:memberId` — the statement: account, aging, and every movement with its provenance
- `POST /api/v1/patients/:memberId/payment` — record a payment (`{amountDollars, note?}`) — **`patients.write`**
- `POST /api/v1/patients/:memberId/adjustment` — a courtesy adjustment (`{amountDollars, note}` — the note is **required**) — `remittances.write`
- `POST /api/v1/patients/:memberId/writeoff` — give up on collecting (`{amountDollars, note}` — required) — `remittances.write`

Charges are never created here; they arrive from `remittance.posted` and `denial.closed`. Money only
ever *leaves* a balance through these three, always attributed to the session user.

**Taking a payment and forgiving a balance are not the same act and do not belong to the same
people.** A payment is what the front desk does at checkout: money that actually arrived, attributed
to whoever took it, and the ledger refuses more than the balance. Gating it behind a billing
permission would push staff into recording payments somewhere else, which is how a ledger stops
being the truth. An adjustment or a write-off is revenue the practice is *choosing to lose* — a
billing decision, and it stays with the people who own the money.

**Queue & reporting**
- `GET  /api/v1/today` — the unified worklist across all six contexts (`?limit=`)
- `GET  /api/v1/analytics/report` — the practice report (`?from=`, `?to=`; default the last 30 days)
- `GET  /api/v1/payer-profile/playbook` — the shared brain, read-only (`?payerId=`)

**Operations (M10)** — `audit.read` to look, `org.manage` to act
- `GET  /api/v1/ops/outbox` — queue depth, lag, recent events and everything dead-lettered. Payloads
  are deliberately omitted: they carry patient names, procedures and money, and an operations console
  that leaks one into a screenshot is a breach with extra steps.
- `POST /api/v1/ops/outbox/:id/retry` — put a dead-lettered event back on the queue (RLS-scoped, audited)
- `GET  /api/v1/ops/audit` — the append-only audit trail
- `GET  /api/v1/ops/readiness` — deep readiness: database reachable, nothing dead-lettered, PHI
  encryption configured. Answers **503** when not ready, so a deploy or a load balancer can gate on it
  — unlike `/health`, which only proves the process is listening.

**Reference**
- `GET  /api/v1/reference/cdt` — CDT catalog for the treatment-plan picker
- `GET  /api/v1/health` — liveness only

### Auth (M6)
- `GET  /api/v1/auth/session` — public; reports `authenticated`, `persistent`, the user, and the CSRF token
- `POST /api/v1/auth/login` — `{email, password}`; sets an HttpOnly SameSite=Lax cookie, returns the CSRF token in the **body**
- `POST /api/v1/auth/logout` — deletes the session row and clears the cookie
- `POST /api/v1/auth/password-reset` — public, rate-limited on the SAME per-IP bucket as login (an
  attacker who can exhaust one and move to the other has been slowed by nothing). Always `202` with
  an identical body whether or not the address is on file — a reset endpoint that distinguishes them
  is a free account-enumeration oracle against a system holding PHI.
- `POST /api/v1/auth/password-reset/confirm` — `{email, token, password}`; revokes **every** session
  issued under the old credential

  > **Token delivery is an external dependency and is not faked.** Reaching the person who asked
  > needs an email provider this deployment cannot have until the hosting decision and its BAA are
  > made (an M13 gate item). Outside production the token is returned in the response so the flow
  > works end to end; in production it is neither returned nor logged — a credential in a log file is
  > a credential — and the response says delivery is unconfigured. The token is written to the user's
  > row either way, so wiring a provider completes the flow with no further change here.

Every other route requires a session, declares the permission it needs, and is **denied by default**
if it has no entry in `ROUTE_PERMISSIONS` — adding an endpoint and forgetting to authorize it fails
closed. Mutations additionally require the CSRF token echoed in `x-csrf-token`: the browser attaches
the cookie to cross-site requests automatically but cannot read this value, which is what makes
echoing it proof of same-origin.

**One transaction per request.** On Postgres every request touching tenant data runs inside
`withPractice(session.user.practiceId)` — RLS armed for every query, the business write and its
domain event committed atomically, and a throw rolling the whole request back. The practice comes
from the session and from nowhere else: no route, header or body field can select a tenant.

**Every mutation is audited (M10).** Non-GET requests write an `audit_events` row inside the same
transaction as the change they describe — an audit trail that can survive a rolled-back write, or be
lost while the write survives, is not an audit trail. A REFUSED request is audited too, in its own
transaction, because "this user tried to do this and was denied" is exactly what the log exists for.
Reads are not audited: burying the rows that record a change under the far larger number that record
someone looking at a screen would make the log unusable for its own question.

**PHI is encrypted at rest (M10).** Raw card text, 271s, 837s and 835s go through
`@mermaid/crypto` in the repository layer, so the domain never handles ciphertext and the database
never handles plaintext. With `NODE_ENV=production` and no `PHI_ENCRYPTION_KEY`, the process refuses
to start.

### Error codes worth distinguishing
`409 not_submittable` (fix something) and `502 clearinghouse_unavailable` (try again) must not look
alike to a client, or the UI cannot tell a refused gate from a transport blip. Likewise
`400 parse_error` (the file you uploaded is not an 835 — only you can fix that) versus
`409 unbalanced` (the payer's own arithmetic disagrees — reconcile it, and note that no amount of
human authority overrides this one).

The same distinction applies to every refused gate: `409 denial_action_refused` and
`409 ledger_action_refused` mean *change something* — a write-off with no reason, a payment larger
than the balance, an appeal nobody approved. A 500 there would tell a client to retry a request that
can never succeed, which is why each domain error is mapped explicitly rather than falling through.

## Deliberate deviations from the blueprint (see HANDOFF.md M3)
- **Not Next.js.** The whole codebase runs TypeScript directly under Node with near-zero deps and no
  build step; this server keeps the doc-06 `/api/v1` contract and "BFF over module services" shape and
  only changes the transport. Next.js can be dropped in later additively — the module service and API
  contract are untouched.
- ~~**In-memory persistence.**~~ **Resolved at M6.** `DATABASE_URL` selects the backend
  (`wiring.ts`): with it, Postgres + RLS + login + a durable outbox; without it, the in-memory stores
  exactly as before, which keeps the demo laptop-runnable and the business suite database-free.
- ~~**The human gates have no real identity behind them.**~~ **Resolved at M6.** `submittedBy` and
  `releasedBy` now come from the authenticated session; a client-supplied value is ignored outright.
  They fall back to the request body only in the DB-free demo, which has no accounts at all.
- **`POST /api/v1/remittances/fetch` tells the mock payer which claims to adjudicate.** A real
  clearinghouse adapter ignores that and returns whatever the payer released; the BFF supplies it
  only because the mock stands in for the payer's adjudication engine, not merely its transport.
