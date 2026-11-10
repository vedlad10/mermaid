/**
 * Append-only audit writer. Writes go through the `record_audit` SECURITY DEFINER function
 * (migration 0003) — the app role has no direct INSERT on `audit_events`, so audit is append-only
 * by construction. Audit logging is a HIPAA compliance control (breach-notification readiness,
 * risk §4), not just observability.
 *
 * Depends only on a structural `Queryable` (not `pg`), so it is unit-testable with a fake tx.
 */

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface AuditEvent {
  practiceId: string | null;      // null for pre-auth events (e.g. failed login, unknown user)
  traceId: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;                 // e.g. "login", "create", "post_payment"
  resource: string;               // e.g. "session", "claim"
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome: "success" | "denied" | "error";
  ip?: string | null;
}

export async function recordAudit(tx: Queryable, e: AuditEvent): Promise<void> {
  await tx.query(
    "SELECT record_audit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      e.practiceId,
      e.traceId,
      e.actorId ?? null,
      e.actorRole ?? null,
      e.action,
      e.resource,
      e.resourceId ?? null,
      e.before !== undefined ? JSON.stringify(e.before) : null,
      e.after !== undefined ? JSON.stringify(e.after) : null,
      e.outcome,
      e.ip ?? null,
    ]
  );
}

/**
 * One read of patient-bearing data by a person at the screen (migration 0037, 45 CFR 164.312(b)).
 *
 * The twin of `recordAudit` for reads: written through the `record_phi_access` SECURITY DEFINER
 * function, in the request's own transaction, so the app role can add to the trail and never alter
 * it. `route` is the path WITHOUT its query string — a patient search term is itself PHI.
 */
export interface PhiAccessEvent {
  practiceId: string;
  traceId: string;
  actorId: string;
  actorRole: string;
  resource: string;
  resourceId: string | null;
  route: string;
  ip: string | null;
}

export async function recordPhiAccess(tx: Queryable, e: PhiAccessEvent): Promise<void> {
  await tx.query("SELECT record_phi_access($1,$2,$3,$4,$5,$6,$7,$8)", [
    e.practiceId,
    e.traceId,
    e.actorId,
    e.actorRole,
    e.resource,
    e.resourceId,
    e.route,
    e.ip,
  ]);
}

export interface PhiAccessRow {
  at: string;
  actorId: string;
  actorRole: string;
  resource: string;
  resourceId: string | null;
  route: string;
  ip: string | null;
}

/**
 * The practice's access trail, newest first. RLS scopes it to the practice in context; the filters
 * answer the two questions it exists for — who opened THIS record, and what did THIS person open.
 */
export async function listPhiAccess(
  tx: Queryable,
  filter: { resourceId?: string | null; actorId?: string | null; limit?: number } = {}
): Promise<PhiAccessRow[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000);
  const { rows } = await tx.query(
    `SELECT created_at, actor_id, actor_role, resource, resource_id, route, ip
       FROM phi_access_events
      WHERE ($1::text IS NULL OR resource_id = $1)
        AND ($2::uuid IS NULL OR actor_id = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [filter.resourceId ?? null, filter.actorId ?? null, limit]
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    actorId: String(r.actor_id),
    actorRole: String(r.actor_role),
    resource: String(r.resource),
    resourceId: r.resource_id === null ? null : String(r.resource_id),
    route: String(r.route),
    ip: r.ip === null ? null : String(r.ip),
  }));
}
