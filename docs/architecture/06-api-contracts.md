# 06 — API Contracts

*Blueprint doc 6 of 16. One versioned REST API under `/api/v1/*`, served by Next.js route handlers
in `apps/web` acting as a BFF over module services. "Keep it boring and predictable" (roadmap §6).*

## Conventions

- **Base:** `/api/v1`. JSON in/out. Resource-oriented, REST-ish.
- **Auth:** session cookie (`sid`, HttpOnly/SameSite=Strict/Secure) + CSRF double-submit header
  (`x-csrf-token`) on all mutations. See doc 08.
- **Tenancy:** `practice_id` is **always** taken from the session, never from the URL/body. Every
  handler opens a transaction with `set_current_practice(session.practiceId)` so RLS applies.
- **Errors:** `{ "error": { "code": string, "message": string } }` with correct HTTP status
  (400 validation, 401 unauth, 403 forbidden/CSRF, 404, 409 conflict, 413, 422 unprocessable, 429).
- **Pagination:** cursor-based (`?cursor=&limit=`), `{ items, nextCursor }`.
- **Every handler:** `authorize(permission) → validate → open tx (RLS) → module service → audit → respond`.
- **Idempotency:** unsafe external ingests (remittances) dedupe on a natural key (trace number).

## Endpoint catalog (by module)

### Auth (`platform/auth`)
```
POST   /api/v1/auth/login            {email,password} → {user, csrf}  (+Set-Cookie sid)
POST   /api/v1/auth/logout           → {ok}
GET    /api/v1/auth/me               → {user, csrf}
POST   /api/v1/auth/reset-request    {email} → {ok}          (no enumeration)
POST   /api/v1/auth/reset-confirm    {email,token,password} → {ok}
```

### Verification
```
POST   /api/v1/verifications                 {patient, coverage|cardText, plannedProcedures} → 201 Verification
GET    /api/v1/verifications?status=&cursor= → {items, nextCursor}
GET    /api/v1/verifications/:id             → Verification (full record + provenance + raw271 flag)
POST   /api/v1/verifications/:id/reverify    → 201 Verification (re-run, links prior)
POST   /api/v1/verifications/:id/review      {decision, notes} → Verification   (HITL: coordinator)
GET    /api/v1/appointments?due=             → {items}         (schedule / sweep source)
POST   /api/v1/appointments/verify           → {due, results}  (manual "verify all due")
```

### Claims
```
POST   /api/v1/claims                        {verificationId} → 201 Claim   (inherits snapshot)
GET    /api/v1/claims?state=&cursor=         → {items, nextCursor}
GET    /api/v1/claims/:id                    → {claim, lines, events, denials, postings}
POST   /api/v1/claims/:id/scrub              → {blockers, warnings, denialRisk, explain[]}
POST   /api/v1/claims/:id/submit             → Claim   (HITL gate: atypical/above-threshold → 202 needs_review)
GET    /api/v1/claims/:id/timeline           → estimate→treatment→submission→posting→resolution
```

### Remittance
```
POST   /api/v1/remittances/ingest            {era} | webhook → 201 {remitId, posted, exceptions}  (idempotent on trace)
POST   /api/v1/remittances/manual            {payerId, traceNo, entries[]} → 201 {remitId, posted}
GET    /api/v1/remittances?cursor=           → {items}
GET    /api/v1/remittances/:id               → {remittance, claims}
POST   /api/v1/remit-claims/:id/post         → Posting   (HITL: exceptions only reach a human)
POST   /api/v1/remit-claims/:id/link         {claimId} → {ok}
POST   /api/v1/postings/:id/reverse          {reason} → Posting
GET    /api/v1/reconciliation                → {runs}    (daily job results; drift alerts)
```

### Denials & Appeals
```
GET    /api/v1/denials?status=&sort=value    → {items}
POST   /api/v1/denials/:id/state             {state} → Denial
POST   /api/v1/denials/:id/appeal            {clinicalNote?} → 201 Appeal   (AI draft, NOT submitted)
GET    /api/v1/appeals?cursor=               → {items}
POST   /api/v1/appeals/:id/generate-letter   → {letterText}  (AI draft for human edit)
POST   /api/v1/appeals/:id/submit            → Appeal   (HITL: human-approved before payer send)
POST   /api/v1/appeals/:id/resolve           {outcome, recovered} → Appeal  (→ feeds learning loop)
```

### Payer Profile
```
GET    /api/v1/payers?cursor=                → {items}
GET    /api/v1/payers/:id/playbook           → {payer, rules}
POST   /api/v1/payers/:id/playbook           {carc, cdtPrefix?, disposition, action, guidance} → 201
```

### Queue & Analytics
```
GET    /api/v1/queue/today                   → {items, doneToday}   (unified value-ranked; doc 07)
POST   /api/v1/queue/:id/complete            → {ok}
POST   /api/v1/queue/:id/snooze              {days} → {until}
POST   /api/v1/queue/:id/escalate            → {ok}
GET    /api/v1/analytics/summary             → {ar, aging, denialRate, overturnRate, topPayers, topCarcs, narration}
```

### Admin
```
GET    /api/v1/admin/users                   → {users}          (users.manage)
POST   /api/v1/admin/users                   {email,name,role,password} → 201
GET    /api/v1/admin/audit?cursor=           → {items}          (audit.read)
GET    /api/v1/admin/flags                   → {flags}          (feature flags per practice)
```

## Async surface (clearinghouse webhooks)

```
POST   /api/v1/webhooks/edi/:vendor          # 271/835 arrival — SIGNATURE-VERIFIED (doc 09, risk §3)
```
Webhooks **never** process synchronously: verify signature → write to `domain_events` outbox → 200.
Workers do the processing. An unsigned/invalid webhook is rejected 401.

## Request/response example (the money-critical one)

```
POST /api/v1/remittances/ingest
Headers: x-csrf-token: <csrf>
Body:    { "era": "ISA*...~" }         # or clearinghouse-normalized JSON via webhook

201 { "remitId":"…","claims":7,"posted":5,"exceptions":2,"balanced":true,
      "idempotent":false }             # idempotent:true if trace already seen → no double-post
409 { "error": { "code":"duplicate_remittance", "message":"trace 12345 already ingested" } }
```

## Versioning

`/api/v1` is stable within a major. Breaking changes go to `/api/v2` with `v1` maintained through a
deprecation window. Payloads are additive within a version; consumers ignore unknown fields.
