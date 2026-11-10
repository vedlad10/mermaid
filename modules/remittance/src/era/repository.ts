/**
 * ERA source and artifact stores.
 *
 * Both are TENANT-SCOPED: every method here runs inside an already-established practice context and
 * reads or writes only that practice's rows. Nothing in this file can see across practices, and
 * that is deliberate — the one narrow, audited cross-tenant read lives in `platform/db/era-queue`
 * with the other queue mechanics, where it is reviewable in one place.
 *
 * The in-memory implementations are not toys: `repository-contract`-style tests hold them to the
 * same behaviour as Postgres, so a rule that exists in only one of them is a bug in the other.
 */
import type { EraArtifact, EraArtifactStatus, EraSource } from "./types.ts";

/** How one source's credential sits in the database. Never the value — see `credentialStorage`. */
export interface EraCredentialStorage {
  id: string;
  vendor: string;
  /** False when the column is empty: a source that can never fetch a file. */
  configured: boolean;
  /**
   * Whether the stored value carries the `v1:` envelope `encryptPhi` produces.
   *
   * An EMPTY credential reports `true` — there is nothing to protect, and reporting it as plaintext
   * would make the readiness check fire on a merely unconfigured source, which is how a check
   * becomes something people dismiss.
   */
  encrypted: boolean;
}

export interface EraSourceRepository {
  /** This practice's source for a vendor, or null when it has not registered one. */
  get(vendor: string): Promise<EraSource | null>;
  /**
   * This practice's source by its own id, or null when no such row is visible.
   *
   * Exists because an ARTIFACT knows which source offered it, and resolving that source by vendor
   * guess instead is only correct while a practice has exactly one. The source decides which
   * credential fetches the file and which `payeeNpi` the tenancy cross-check compares against, so
   * picking the wrong one picks the wrong cross-check. Tenant-scoped like everything else here:
   * an id belonging to another practice simply does not resolve.
   */
  getById(id: string): Promise<EraSource | null>;
  /**
   * Every source this practice has registered (NEW-11).
   *
   * Tenant-scoped like `get`. Exists so an operator can be shown what is registered and whether its
   * credential is actually encrypted — a question nobody could answer without reading the table by
   * hand, which is how a plaintext credential sat there unnoticed in the first place.
   */
  list(): Promise<EraSource[]>;
  /**
   * How each credential is STORED, without decrypting anything (NEW-11).
   *
   * ── WHY THIS CANNOT BE ANSWERED FROM `EraSource` ───────────────────────────────────────────────
   * Every read here decrypts on the way out, so `EraSource.credential` is plaintext whether the
   * column held an encrypted value or not — the two are indistinguishable by the time a caller sees
   * one. That is correct for the poller, which wants the key, and useless for the question "is this
   * key protected at rest", which is the one an operator and a readiness check are asking.
   *
   * So this reads the raw column and reports on it, and is the ONLY method here that does.
   */
  credentialStorage(): Promise<EraCredentialStorage[]>;
  upsert(source: Omit<EraSource, "id" | "lastPolledAt" | "lastError"> & { id?: string }): Promise<EraSource>;
  /** Advance the durable cursor after a page has been fully enqueued — never before. */
  recordPollSuccess(sourceId: string, cursor: string | null, at: Date): Promise<void>;
  recordPollFailure(sourceId: string, error: string, at: Date): Promise<void>;
}

export interface EraArtifactRepository {
  /**
   * Whether this store counts an attempt when the artifact is HANDED OUT rather than when it fails
   * (NEW-18).
   *
   * ── WHY THIS DIFFERENCE IS REAL, AND HAS TO BE DECLARED ────────────────────────────────────────
   * Postgres counts on hand-out: `claim_era_artifacts` does `attempts = attempts + 1` as it leases
   * the row. That is deliberate and worth keeping — a worker that CRASHES mid-ingest has still used
   * an attempt, so a poisonous artifact cannot be retried forever by killing the process.
   *
   * The in-memory store has no claim step at all; it counts when a failure is recorded.
   *
   * `EraIngestService` has to know which, because "how many attempts has this had, including the
   * one in progress?" is `attempts` under the first rule and `attempts + 1` under the second.
   * Assuming the second for both — which it did — made Postgres dead-letter on the FOURTH attempt
   * while announcing five: an ERA carrying real money went to the hand-work queue a whole retry
   * early, and the log said `attempts: 5` about four.
   *
   * Declared rather than inferred, because the alternatives are both worse: guessing from whether
   * `attempts` is already non-zero is wrong on the first retry of a legitimately-retried artifact,
   * and making the two stores agree by removing the claim-time increment would give up the
   * crash-protection that is the reason it exists.
   */
  readonly countsAttemptsOnClaim: boolean;
  /**
   * Record that the clearinghouse has an ERA for us, if we did not already know.
   *
   * Idempotent by `(practice, fileExecutionId)` and returns whether the row was NEW, so a poller
   * can report what it actually discovered rather than what it re-saw. This is the write that makes
   * an ERA impossible to lose: it happens before the file is fetched, so a crash anywhere after it
   * leaves durable work rather than a payment nobody knows was offered.
   */
  discover(artifact: Omit<EraArtifact, "id" | "status" | "attempts" | "deadLettered" | "lastError" | "remittanceCount" | "ingestedAt">): Promise<{ artifact: EraArtifact; created: boolean }>;
  get(fileExecutionId: string): Promise<EraArtifact | null>;
  /** Terminal outcome for one artifact, with how many remittances it produced. */
  settle(id: string, status: EraArtifactStatus, detail: { remittanceCount?: number; error?: string | null; at: Date }): Promise<void>;
  /** Give an artifact back to the queue after a retryable failure. */
  reschedule(id: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void>;
  list(): Promise<EraArtifact[]>;
}

// ── In-memory ───────────────────────────────────────────────────────────────────────────

export class InMemoryEraSourceRepository implements EraSourceRepository {
  #byVendor = new Map<string, EraSource>();

  async get(vendor: string): Promise<EraSource | null> {
    const found = this.#byVendor.get(vendor);
    return found ? { ...found } : null;
  }

  async getById(id: string): Promise<EraSource | null> {
    for (const source of this.#byVendor.values()) {
      if (source.id === id) return { ...source };
    }
    return null;
  }

  async list(): Promise<EraSource[]> {
    return [...this.#byVendor.values()]
      .map((s) => ({ ...s }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor));
  }

  /**
   * The in-memory store does not encrypt, and says so rather than claiming otherwise.
   *
   * It is never the store behind the readiness check — a deployment without a database registers no
   * ERA sources at all — and a double that reported `encrypted: true` for a value it stores in the
   * clear would be lying about the one property this method exists to report.
   */
  async credentialStorage(): Promise<EraCredentialStorage[]> {
    return (await this.list()).map((s) => ({
      id: s.id,
      vendor: s.vendor,
      configured: s.credential.trim() !== "",
      encrypted: s.credential.trim() === "",
    }));
  }

  async upsert(source: Omit<EraSource, "id" | "lastPolledAt" | "lastError"> & { id?: string }): Promise<EraSource> {
    const existing = this.#byVendor.get(source.vendor);
    const saved: EraSource = {
      id: source.id ?? existing?.id ?? `era-source-${source.vendor}-${source.practiceId}`,
      practiceId: source.practiceId,
      vendor: source.vendor,
      credential: source.credential,
      payeeNpi: source.payeeNpi,
      cursor: source.cursor,
      enabled: source.enabled,
      lastPolledAt: existing?.lastPolledAt ?? null,
      lastError: existing?.lastError ?? null,
    };
    this.#byVendor.set(source.vendor, saved);
    return { ...saved };
  }

  async recordPollSuccess(sourceId: string, cursor: string | null, at: Date): Promise<void> {
    for (const source of this.#byVendor.values()) {
      if (source.id !== sourceId) continue;
      source.cursor = cursor;
      source.lastPolledAt = at.toISOString();
      source.lastError = null;
    }
  }

  async recordPollFailure(sourceId: string, error: string, at: Date): Promise<void> {
    for (const source of this.#byVendor.values()) {
      if (source.id !== sourceId) continue;
      source.lastPolledAt = at.toISOString();
      source.lastError = error;
    }
  }
}

export class InMemoryEraArtifactRepository implements EraArtifactRepository {
  /** No claim step here — this store counts when a failure is recorded. See the interface. */
  // `boolean`, not the literal — a test double declares the other convention (NEW-18).
  readonly countsAttemptsOnClaim: boolean = false;

  #byFileId = new Map<string, EraArtifact>();
  #seq = 0;

  async discover(
    input: Omit<EraArtifact, "id" | "status" | "attempts" | "deadLettered" | "lastError" | "remittanceCount" | "ingestedAt">
  ): Promise<{ artifact: EraArtifact; created: boolean }> {
    const existing = this.#byFileId.get(input.fileExecutionId);
    // The in-memory stand-in for `era_artifacts_one_per_file`. Re-discovery is a no-op, which is
    // what makes polling the same window twice harmless.
    if (existing) return { artifact: { ...existing }, created: false };

    const artifact: EraArtifact = {
      id: `era-artifact-${++this.#seq}`,
      practiceId: input.practiceId,
      sourceId: input.sourceId,
      fileExecutionId: input.fileExecutionId,
      transactionId: input.transactionId,
      processedAt: input.processedAt,
      status: "pending",
      attempts: 0,
      deadLettered: false,
      lastError: null,
      remittanceCount: 0,
      ingestedAt: null,
    };
    this.#byFileId.set(artifact.fileExecutionId, artifact);
    return { artifact: { ...artifact }, created: true };
  }

  async get(fileExecutionId: string): Promise<EraArtifact | null> {
    const found = this.#byFileId.get(fileExecutionId);
    return found ? { ...found } : null;
  }

  async settle(
    id: string,
    status: EraArtifactStatus,
    detail: { remittanceCount?: number; error?: string | null; at: Date }
  ): Promise<void> {
    for (const artifact of this.#byFileId.values()) {
      if (artifact.id !== id) continue;
      artifact.status = status;
      artifact.lastError = detail.error ?? null;
      if (detail.remittanceCount !== undefined) artifact.remittanceCount = detail.remittanceCount;
      artifact.ingestedAt = detail.at.toISOString();
    }
  }

  async reschedule(id: string, error: string, _nextAttemptAt: Date, deadLetter: boolean): Promise<void> {
    for (const artifact of this.#byFileId.values()) {
      if (artifact.id !== id) continue;
      artifact.attempts += 1;
      artifact.lastError = error;
      artifact.deadLettered = deadLetter;
      // Stays `pending` unless dead-lettered: an artifact that failed retryably is still work.
      artifact.status = deadLetter ? "failed" : "pending";
    }
  }

  async list(): Promise<EraArtifact[]> {
    return [...this.#byFileId.values()].map((a) => ({ ...a }));
  }
}
