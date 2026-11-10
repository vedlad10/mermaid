# 08 — Authentication & Authorization Design

*Blueprint doc 8 of 16. One unified auth system merging the two donor stacks (both scrypt + CSRF +
RBAC), on the stronger foundations of each: DB-backed sessions (Remit) + timing-safe login & reset
(Verify) + multi-tenant practice scoping + Postgres RLS (mandated, `architecture-risk-review.md`
§1.1, §3).*

## Layers

```
1. Authentication   — who are you?            scrypt password, DB-backed session, CSRF
2. Tenancy context  — which practice?         practice_id from session → set_current_practice(tx)
3. Row-Level Security — DB-enforced isolation  Postgres RLS policy on every tenant table
4. Authorization    — may you do this?         RBAC permission matrix (resource.action)
```

Isolation is defense-in-depth: even if an app-level check is missed, **RLS makes cross-practice rows
invisible at the database.** This is the #1 risk in the design and it is closed at the DB, not hoped
for in application code.

## Authentication

- **Passwords:** `scrypt` (N=16384) + per-user salt, constant-time compare. Timing-uniform login
  (hash a dummy when the user doesn't exist → no user-enumeration).
- **Sessions:** 128-bit random token, stored **hashed** (`sha256`) in `sessions`, 12h idle expiry,
  rotation on privilege change. Cookie `sid`: HttpOnly, SameSite=Strict, Secure (behind TLS).
- **CSRF:** double-submit — a `csrf` twin issued at login, required in `x-csrf-token` on every
  mutation (login/logout exempt).
- **Password reset:** tokenized (sha256-stored, TTL), no enumeration, **revokes all sessions** on
  completion.
- **Rate limiting:** token-bucket per IP on auth endpoints (single-instance now; shared store before
  horizontal scale — doc 13).

```ts
// platform/auth — request guard used by every protected route handler.
export async function guard(req, permission: Permission): Promise<Ctx> {
  const session = await getSession(cookie(req).sid);        // hashed lookup, expiry, user active
  if (!session) throw http(401, "login required");
  if (isMutation(req) && req.headers["x-csrf-token"] !== session.csrf) throw http(403, "csrf");
  if (permission && !can(session.user.role, permission)) throw http(403, `role lacks ${permission}`);
  return { session, practiceId: session.user.practiceId, userId: session.user.id };
}
```

## Tenancy context + RLS (the core)

Every request runs inside a transaction that first sets the practice context; RLS policies
(migration `0002`) then scope all queries:

```ts
export async function withPractice<T>(practiceId, fn: (tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_current_practice($1)", [practiceId]);  // from session, never client
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
```

- **The app connects as a non-owner, non-superuser role** (`mermaid_app`) so RLS is never bypassed;
  `FORCE ROW LEVEL SECURITY` is set as belt-and-suspenders.
- **Fail-closed:** unset practice context matches no rows (`current_practice()` NULL → policy false).
- The migration runner uses a separate privileged role (`DATABASE_ADMIN_URL`) for DDL only.

## Authorization — unified RBAC

**Canonical role set** (superset of both donor apps, aligned to `human-in-the-loop-workflow.pdf`
role names and the roadmap's coordinator|biller|owner|admin):

| Role | Maps to (donor / roadmap) | Scope |
|---|---|---|
| `owner` | Remit owner / roadmap owner | everything incl. org settings, billing |
| `admin` | both admin / roadmap admin | manage users, config, audit |
| `office_manager` | Verify office_manager | manage work, escalations, larger-dollar decisions |
| `insurance_coordinator` | Verify insurance_coordinator / roadmap coordinator | verification review, eligibility |
| `front_desk` | Verify receptionist / Remit front_desk | patient/card capture, patient-facing (never auto-delivered) |
| `biller` | Remit biller / roadmap biller | claims, posting, denials, appeals (mechanical) |
| `dentist` | Verify dentist | clinical narrative for appeals (read + narrow write) |
| `auditor` | Remit auditor / Verify viewer | **read-only everywhere** by construction |

**Permissions are `resource.action` keys** (Remit's clean model):

```ts
// @mermaid/shared/roles.ts
const READ  = ["verifications.read","claims.read","remittances.read","denials.read",
               "appeals.read","payers.read","queue.read","analytics.read","patients.read"];
const WORK  = ["verifications.write","claims.write","remittances.write","denials.write",
               "appeals.write","patients.write","queue.write"];
const ADMIN = ["users.manage","org.manage","payers.write","audit.read"];

export const PERMISSIONS: Record<Role, Permission[]> = {
  owner:                 [...READ, ...WORK, ...ADMIN],
  admin:                 [...READ, ...WORK, ...ADMIN],
  office_manager:        [...READ, ...WORK, "audit.read"],
  insurance_coordinator: [...READ, "verifications.write","patients.write","queue.write"],
  front_desk:            ["verifications.read","patients.read","patients.write","queue.read","queue.write"],
  biller:                [...READ, "claims.write","remittances.write","denials.write","appeals.write","queue.write"],
  dentist:               ["verifications.read","claims.read","appeals.read","appeals.write"],
  auditor:               [...READ, "audit.read"],
};
```

## Human-in-the-loop authorization gates (enforced, not advisory)

Beyond RBAC, specific state transitions require a human actor and are recorded as audit events
(`human-in-the-loop-workflow.pdf`):

| Gate | Rule | Enforced where |
|---|---|---|
| Verification review | low-confidence → `needs_review`; only `insurance_coordinator+` can `approve/override` | Verification service |
| Patient financial delivery | **no endpoint auto-sends a patient balance**; delivery requires a human action | absence-by-design + HITL test |
| Claim submit | atypical/above-threshold claim → `202 needs_review`, requires human confirm | Claims service |
| Auto-post | only clean+balanced+matched auto-posts; exceptions → queue for `biller` | Remittance service |
| Pursue/write-off | above practice threshold requires `office_manager` | Denials service |
| Appeal submit | `appeal.submit` requires a human `submitted_by`; never automatic | Appeals service |
| Rule promotion | overturn-rate rule change under min sample size → sanity gate | Payer Profile (doc 11) |

## Audit

Every mutation and every auth event appends to `audit_events` (append-only; no UPDATE/DELETE granted
to `mermaid_app`) with `trace_id`, actor, role, resource, before/after, outcome, ip. This is a HIPAA
requirement (breach-notification readiness, `architecture-risk-review.md` §4), not just observability.
