/**
 * Types for the NEW-01 dependent backfill.
 *
 * The script is `.mjs` like every other operational script here; this declaration exists so the
 * live-database test can drive the SAME functions it runs rather than retyping their SQL.
 */

/** Anything that can run a parameterised query — a raw client, or an ambient transaction. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** One member id that was verified for more than one patient — a family the old index collapsed. */
export interface CollapsedFamily {
  practiceId: string;
  memberId: string;
  /** Every patient a verification recorded under this member id. */
  verified: string[];
  /** Those that still have a coverage row. */
  linked: string[];
  /** Those that do not — the links to re-create. */
  missing: string[];
}

export function findFamilies(client: Queryable): Promise<CollapsedFamily[]>;

/** Re-create one missing link. Returns rows written: 0 when it already existed. */
export function restore(
  client: Queryable,
  target: { practiceId: string; memberId: string; patientId: string }
): Promise<number>;

/** Ledger entries keyed on a member id that belongs to more than one person. Reported, never rewritten. */
export function ledgerInDoubt(
  client: Queryable,
  families: Pick<CollapsedFamily, "practiceId" | "memberId">[]
): Promise<{ practice_id: string; patient_key: string; patient_id: string | null; entries: number; cents: string }[]>;
