/**
 * ERA queue mechanics — the ONE place that sees ERA work across practices.
 *
 * ── WHY THIS IS HERE AND NOT IN THE REMITTANCE MODULE ──────────────────────────────────────────
 * Exactly the reasoning the outbox already follows (`platform/events/src/pg-bus.ts`, migration
 * 0006): a worker must see every practice's due work, and a per-practice scan per tick does not
 * scale past a handful of clinics. So there is a narrow, reviewable hole through RLS — and it lives
 * in `platform/db` beside `withPractice`/`withoutPractice`, where every such hole in this codebase
 * can be read in one sitting, rather than scattered through modules where one could be added
 * without anyone noticing.
 *
 * ── WHAT THESE FUNCTIONS DELIBERATELY DO NOT DO ────────────────────────────────────────────────
 * They return WORK, not money. `claimEraSources` hands back credentials because the caller must
 * authenticate with them; `claimEraArtifacts` hands back file identifiers. Neither reads an 835,
 * neither posts anything, and — most importantly — there is no function here that maps a payee
 * identifier, a payer, or any other payload-supplied value to a practice. That mapping is precisely
 * what must not exist: it would let a file choose the ledger its money lands in.
 *
 * Everything downstream runs inside `withPractice(row.practice_id)`, so all module code stays fully
 * RLS-scoped and never learns that a cross-tenant read happened at all.
 */
import { many } from "./repository.ts";
import { withoutPractice } from "./pool.ts";

/** One practice's ERA credential and polling state, as the claim function returns it. */
export interface ClaimedEraSourceRow {
  id: string;
  practice_id: string;
  vendor: string;
  credential: string;
  payee_npi: string | null;
  cursor: string | null;
  enabled: boolean;
  last_polled_at: Date | null;
  last_error: string | null;
}

export interface ClaimedEraArtifactRow {
  id: string;
  practice_id: string;
  source_id: string;
  file_execution_id: string;
  transaction_id: string | null;
  processed_at: Date | null;
  status: string;
  attempts: number;
  dead_lettered: boolean;
  last_error: string | null;
  remittance_count: number;
  ingested_at: Date | null;
}

/**
 * Lease up to `limit` ERA sources that are due a poll.
 *
 * `FOR UPDATE SKIP LOCKED` inside the SQL function, so N workers can run concurrently without
 * double-polling a source and without blocking each other. The lease means a worker that dies
 * mid-poll releases its sources when the lease expires rather than holding them forever.
 */
export async function claimEraSources(limit: number, leaseSeconds = 300): Promise<ClaimedEraSourceRow[]> {
  return withoutPractice((t) =>
    many<ClaimedEraSourceRow>(t, "SELECT * FROM claim_era_sources($1,$2)", [limit, leaseSeconds])
  );
}

/**
 * Lease up to `limit` discovered artifacts that are due an attempt.
 *
 * Ordered by discovery, so the oldest offered money is retrieved first. A retryable failure pushes
 * `next_attempt_at` out with backoff and the row stays claimable; a permanent one dead-letters it.
 * Either way the row survives, which is what makes "an ERA is never silently lost" true.
 */
export async function claimEraArtifacts(limit: number, leaseSeconds = 300): Promise<ClaimedEraArtifactRow[]> {
  return withoutPractice((t) =>
    many<ClaimedEraArtifactRow>(t, "SELECT * FROM claim_era_artifacts($1,$2)", [limit, leaseSeconds])
  );
}
