/**
 * Unified RBAC — the canonical role set and the resource.action permission matrix
 * (blueprint doc 08). Superset of both donor apps, aligned to the human-in-the-loop role names.
 * Union types only (no enums) so this stays runnable under Node's native type-stripping.
 */

export type Role =
  | "owner"
  | "admin"
  | "office_manager"
  | "insurance_coordinator"
  | "front_desk"
  | "biller"
  | "dentist"
  | "auditor";

export const ROLES: readonly Role[] = [
  "owner",
  "admin",
  "office_manager",
  "insurance_coordinator",
  "front_desk",
  "biller",
  "dentist",
  "auditor",
] as const;

export type Permission =
  // reads
  | "verifications.read" | "claims.read" | "remittances.read" | "denials.read"
  | "appeals.read" | "payers.read" | "queue.read" | "analytics.read" | "patients.read"
  // writes
  | "verifications.write" | "claims.write" | "remittances.write" | "denials.write"
  | "appeals.write" | "patients.write" | "queue.write"
  // admin
  | "users.manage" | "org.manage" | "payers.write" | "audit.read"
  /**
   * Bill a patient for money the PAYER's own adjustment says is not theirs (NEW-07).
   *
   * ── WHY THIS IS ITS OWN PERMISSION AND NOT PART OF `denials.write` ───────────────────────────
   * A `CO` adjustment is the payer citing the practice's own contract: the practice agreed, in
   * writing, that this amount would not be charged to the patient. Billing it anyway is a
   * contractual breach and, on a government or many commercial plans, balance-billing — a
   * regulatory matter, not a workflow preference.
   *
   * The automatic path has always refused it (`categorizeAdjustment` sends `contractual` to
   * `post_normal`, never to the patient). The MANUAL close was the hole: `denials.write` — which a
   * biller holds for ordinary day-to-day work — let anyone move any denial to the patient's
   * balance, including one the payer had explicitly labelled contractual.
   *
   * There are real cases where a human knows better than the code (a mis-coded adjustment, a
   * patient who genuinely elected a non-covered service), so this is an override rather than a
   * wall. Separating it means the decision is made by someone who owns the payer contracts, and
   * that every use of it is one audit query away.
   */
  | "denials.bill_patient_override";

const READ: Permission[] = [
  "verifications.read", "claims.read", "remittances.read", "denials.read",
  "appeals.read", "payers.read", "queue.read", "analytics.read", "patients.read",
];
const WORK: Permission[] = [
  "verifications.write", "claims.write", "remittances.write", "denials.write",
  "appeals.write", "patients.write", "queue.write",
];
const ADMIN: Permission[] = ["users.manage", "org.manage", "payers.write", "audit.read"];

/**
 * Overriding the contractual bar belongs to whoever owns the payer contracts, which is what makes
 * it a different set from `denials.write`. The office manager holds it; the biller — who closes
 * denials all day — does not, deliberately: the point of the separation is that this decision is
 * made by somebody for whom it is not routine.
 */
const CONTRACT_OVERRIDE: Permission[] = ["denials.bill_patient_override"];

export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [...READ, ...WORK, ...ADMIN, ...CONTRACT_OVERRIDE],
  admin: [...READ, ...WORK, ...ADMIN, ...CONTRACT_OVERRIDE],
  office_manager: [...READ, ...WORK, "audit.read", ...CONTRACT_OVERRIDE],
  insurance_coordinator: [...READ, "verifications.write", "patients.write", "queue.write"],
  front_desk: ["verifications.read", "patients.read", "patients.write", "queue.read", "queue.write"],
  biller: [
    ...READ,
    "claims.write", "remittances.write", "denials.write", "appeals.write", "queue.write",
  ],
  /**
   * The clinical voice on an appeal, and nothing else (blueprint doc 08: "clinical narrative for
   * appeals — read + narrow write").
   *
   * `denials.read` is here because without it the role was incoherent: a dentist held `appeals.write`
   * and could therefore approve and send an appeal, while `GET /api/v1/denials` requires
   * `denials.read` — so they could act on a payer decision they were not allowed to look at. A denial
   * and its appeal are one screen and one piece of work; splitting the permission between them
   * granted the dangerous half and withheld the harmless one.
   *
   * `denials.write` is deliberately NOT here. That permission gates closing a denial — writing it off
   * or moving it to the patient's balance — which is a decision about whose money this is, not a
   * clinical one. It belongs to the biller and the office manager. `patients.read` is likewise
   * withheld: a dentist writing a narrative needs the treatment and the payer's reason, not the
   * patient's account balance.
   */
  dentist: ["verifications.read", "claims.read", "denials.read", "appeals.read", "appeals.write"],
  auditor: [...READ, "audit.read"],
};

/** Server-side authorization check. The auditor role is read-only everywhere by construction. */
export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value);
