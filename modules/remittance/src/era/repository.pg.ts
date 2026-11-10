/**
 * Postgres ERA source and artifact stores.
 *
 * Every statement here is tenant-scoped by RLS: `era_sources` and `era_artifacts` both went through
 * `enable_tenant_rls`, so a query issued in practice A's transaction cannot see practice B's rows
 * even if this file were written carelessly. That is the point of putting the tenant boundary in
 * the database — a missing `WHERE practice_id = ?` here is a bug, not a breach.
 *
 * The credential is encrypted at rest with the same AES-GCM envelope as PHI. It is not PHI, but it
 * is the thing that DECIDES which practice an ERA belongs to, so a database backup that leaked it
 * would leak the ability to fetch another practice's money file.
 */
import { execute, many, one, practiceId, tx } from "@mermaid/db";
import { decryptPhi, encryptPhi, isEncrypted, type PhiLocation } from "@mermaid/crypto";
import type { EraArtifactRepository, EraCredentialStorage, EraSourceRepository } from "./repository.ts";
import type { EraArtifact, EraArtifactStatus, EraSource } from "./types.ts";

interface SourceRow {
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

interface ArtifactRow {
  id: string;
  practice_id: string;
  source_id: string;
  file_execution_id: string;
  transaction_id: string | null;
  processed_at: Date | null;
  status: EraArtifactStatus;
  attempts: number;
  dead_lettered: boolean;
  last_error: string | null;
  remittance_count: number;
  ingested_at: Date | null;
}

/**
 * Where this aggregate's PHI lives, for the encryption binding (NEW-25).
 *
 * GCM proves a ciphertext was not ALTERED; it says nothing about where it belongs. Binding the
 * location into the additional authenticated data is what stops a value being copied from one row —
 * one patient, one practice — into another and decrypting perfectly there.
 *
 * The location is re-derived on every read from the row the value was FOUND in, never stored, so a
 * moved value computes a different AAD and fails its tag check.
 */
const credentialAt = (practice: string, rowId: string): PhiLocation => ({
  practiceId: practice,
  table: "era_sources",
  column: "credential",
  rowId,
});

export const toEraSource = (row: SourceRow): EraSource => ({
  id: row.id,
  practiceId: row.practice_id,
  vendor: row.vendor,
  // Bound to this source's row and practice (NEW-25): a clearinghouse credential copied into
  // another practice's source row must not decrypt there.
  credential: decryptPhi(row.credential, credentialAt(row.practice_id, row.id)) ?? "",
  payeeNpi: row.payee_npi,
  cursor: row.cursor,
  enabled: row.enabled,
  lastPolledAt: row.last_polled_at ? row.last_polled_at.toISOString() : null,
  lastError: row.last_error,
});

const toArtifact = (row: ArtifactRow): EraArtifact => ({
  id: row.id,
  practiceId: row.practice_id,
  sourceId: row.source_id,
  fileExecutionId: row.file_execution_id,
  transactionId: row.transaction_id,
  processedAt: row.processed_at ? row.processed_at.toISOString() : null,
  status: row.status,
  attempts: row.attempts,
  deadLettered: row.dead_lettered,
  lastError: row.last_error,
  remittanceCount: row.remittance_count,
  ingestedAt: row.ingested_at ? row.ingested_at.toISOString() : null,
});

export class PgEraSourceRepository implements EraSourceRepository {
  async get(vendor: string): Promise<EraSource | null> {
    const row = await one<SourceRow>(tx(), "SELECT * FROM era_sources WHERE vendor = $1", [vendor]);
    return row ? toEraSource(row) : null;
  }

  /**
   * No `practice_id` predicate, exactly like `get` above: RLS supplies it. An id belonging to
   * another practice matches zero rows under the policy rather than being filtered in application
   * code, which is the whole point of the tenancy design — the boundary is one the database
   * enforces, not one this method could forget.
   */
  async getById(id: string): Promise<EraSource | null> {
    const row = await one<SourceRow>(tx(), "SELECT * FROM era_sources WHERE id = $1", [id]);
    return row ? toEraSource(row) : null;
  }

  /**
   * Every source this practice has registered. RLS scopes it, like every read here (NEW-11).
   *
   * Returns the row WHOLE, credential included — the caller is the one that decides what may leave
   * the process, and `apps/web/era-sources.ts` maps it to a shape that cannot carry one. Trimming
   * it here instead would leave `get`/`getById` as the un-trimmed reads, which is a distinction
   * nobody would remember at the next call site.
   */
  async list(): Promise<EraSource[]> {
    return (await many<SourceRow>(tx(), "SELECT * FROM era_sources ORDER BY vendor")).map(toEraSource);
  }

  /**
   * The RAW column, examined and not decrypted (NEW-11).
   *
   * `toEraSource` decrypts, so every other read here hands back plaintext regardless of what the
   * column held — which makes "is this credential protected at rest" unanswerable from anywhere
   * else. This is the one place that looks at the stored bytes.
   */
  async credentialStorage(): Promise<EraCredentialStorage[]> {
    const rows = await many<{ id: string; vendor: string; credential: string | null }>(
      tx(),
      "SELECT id, vendor, credential FROM era_sources ORDER BY vendor"
    );
    return rows.map((r) => {
      const stored = (r.credential ?? "").trim();
      return {
        id: r.id,
        vendor: r.vendor,
        configured: stored !== "",
        encrypted: stored === "" ? true : isEncrypted(stored),
      };
    });
  }

  async upsert(source: Omit<EraSource, "id" | "lastPolledAt" | "lastError"> & { id?: string }): Promise<EraSource> {
    const row = await one<SourceRow>(
      tx(),
      `INSERT INTO era_sources (practice_id, vendor, credential, payee_npi, cursor, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (practice_id, vendor) DO UPDATE
         SET credential = EXCLUDED.credential,
             payee_npi  = EXCLUDED.payee_npi,
             enabled    = EXCLUDED.enabled
       RETURNING *`,
      [practiceId(), source.vendor, source.credential, source.payeeNpi, source.cursor, source.enabled]
    );

    /**
     * ── THE CREDENTIAL IS BOUND IN A SECOND STATEMENT, BECAUSE THE ROW ID IS THE BINDING ─────────
     *
     * `era_sources.id` is generated by the database, so on an INSERT it does not exist until the
     * row does — and the binding is to that id. The value goes in as plaintext for the duration of
     * one statement inside one transaction, then is immediately replaced with the bound ciphertext;
     * nothing outside the transaction ever observes the intermediate state.
     *
     * The alternative — generating the id in the application — would work and is a bigger change to
     * a table three other things already key on. This is the narrow one.
     */
    await execute(tx(), "UPDATE era_sources SET credential = $2 WHERE id = $1", [
      row!.id,
      encryptPhi(source.credential, credentialAt(row!.practice_id, row!.id)),
    ]);
    /**
     * The cursor is NOT in the DO UPDATE list, deliberately. Re-registering a credential — rotating
     * a key, correcting an NPI — must not rewind polling to the beginning of time, which would
     * re-offer every artifact the practice has ever taken in. The cursor moves only through
     * `recordPollSuccess`, i.e. only when a page has actually been read.
     */
    /**
     * `row` holds the PLAINTEXT credential — it was captured by RETURNING before the binding update
     * above replaced it. `decryptPhi` passes an unenveloped value through unchanged, so this hands
     * back exactly what the caller supplied, which is what `EraSource.credential` means.
     */
    return toEraSource(row!);
  }

  async recordPollSuccess(sourceId: string, cursor: string | null, at: Date): Promise<void> {
    await execute(
      tx(),
      `UPDATE era_sources
          SET cursor = $2, last_polled_at = $3, last_error = NULL, poll_attempts = 0
        WHERE id = $1`,
      [sourceId, cursor, at]
    );
  }

  async recordPollFailure(sourceId: string, error: string, at: Date): Promise<void> {
    await execute(
      tx(),
      "UPDATE era_sources SET last_polled_at = $2, last_error = $3 WHERE id = $1",
      [sourceId, at, error.slice(0, 500)]
    );
  }
}

export class PgEraArtifactRepository implements EraArtifactRepository {
  /**
   * `claim_era_artifacts` does `attempts = attempts + 1` as it leases the row, so by the time an
   * artifact reaches the service the current attempt is already counted (NEW-18).
   */
  // `boolean`, not the literal — a test double declares the other convention (NEW-18).
  readonly countsAttemptsOnClaim: boolean = true;

  async discover(
    input: Omit<EraArtifact, "id" | "status" | "attempts" | "deadLettered" | "lastError" | "remittanceCount" | "ingestedAt">
  ): Promise<{ artifact: EraArtifact; created: boolean }> {
    /**
     * `ON CONFLICT DO NOTHING` plus a follow-up read, rather than `DO UPDATE`. Re-discovery must not
     * touch an existing row: that row may already be `ingested`, and rewriting it would resurrect
     * finished work as pending — the clearinghouse re-offering an artifact is not a reason to post
     * its money again.
     */
    const inserted = await one<ArtifactRow>(
      tx(),
      `INSERT INTO era_artifacts (practice_id, source_id, file_execution_id, transaction_id, processed_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (practice_id, file_execution_id) DO NOTHING
       RETURNING *`,
      [practiceId(), input.sourceId, input.fileExecutionId, input.transactionId, input.processedAt]
    );
    if (inserted) return { artifact: toArtifact(inserted), created: true };

    const existing = await one<ArtifactRow>(
      tx(),
      "SELECT * FROM era_artifacts WHERE file_execution_id = $1",
      [input.fileExecutionId]
    );
    return { artifact: toArtifact(existing!), created: false };
  }

  async get(fileExecutionId: string): Promise<EraArtifact | null> {
    const row = await one<ArtifactRow>(tx(), "SELECT * FROM era_artifacts WHERE file_execution_id = $1", [
      fileExecutionId,
    ]);
    return row ? toArtifact(row) : null;
  }

  async settle(
    id: string,
    status: EraArtifactStatus,
    detail: { remittanceCount?: number; error?: string | null; at: Date }
  ): Promise<void> {
    await execute(
      tx(),
      `UPDATE era_artifacts
          SET status = $2,
              remittance_count = COALESCE($3, remittance_count),
              last_error = $4,
              ingested_at = $5
        WHERE id = $1`,
      [id, status, detail.remittanceCount ?? null, detail.error ?? null, detail.at]
    );
  }

  async reschedule(id: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void> {
    await execute(
      tx(),
      `UPDATE era_artifacts
          SET last_error = $2,
              next_attempt_at = $3,
              dead_lettered = $4,
              -- Stays pending unless dead-lettered: a retryable failure is still work.
              status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END
        WHERE id = $1`,
      [id, error.slice(0, 500), nextAttemptAt, deadLetter]
    );
  }

  async list(): Promise<EraArtifact[]> {
    const rows = await many<ArtifactRow>(tx(), "SELECT * FROM era_artifacts ORDER BY created_at", []);
    return rows.map(toArtifact);
  }
}
