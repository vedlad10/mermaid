/**
 * ERA ingestion for ONE practice.
 *
 * ── THE CONTRACT WITH THE CALLER, AND WHY IT IS THE WHOLE SAFETY STORY ──────────────────────────
 * Every method here runs inside a practice context the CALLER established, using an adapter built
 * from that same practice's own clearinghouse credential. This class never chooses a practice, and
 * it never reads one out of a payload. That is not a convention — it is the reason an ERA cannot be
 * posted to the wrong practice: there is no code path from the bytes of a file to the selection of
 * a tenant, because the tenant is fixed before this object is constructed.
 *
 * What this class DOES own is the part that must not lose money:
 *
 *  • **Discover before fetching.** An artifact id is written to a durable ledger the moment the
 *    clearinghouse mentions it, and the cursor only advances once the whole page is recorded. A
 *    crash between discovery and ingestion therefore leaves work, not a hole.
 *  • **Fetch, then ingest, then settle.** The ledger row is marked done only after the remittances
 *    exist. Anything that fails in between is rescheduled with backoff, so an ERA is retried rather
 *    than dropped.
 *  • **Exactly once, twice over.** The artifact ledger stops the same FILE being processed twice;
 *    the remittance dedupe key stops the same PAYMENT being posted twice even if it arrives in two
 *    different files. Neither alone is sufficient — a clearinghouse can re-serve one cheque under a
 *    new artifact id.
 */
import type { EdiAdapter } from "@mermaid/edi";
import type { Logger } from "@mermaid/observability";
import { RemittanceUnavailableError, type RemittanceService } from "../service.ts";
import type { RemittanceView } from "../view.ts";
import type { EraArtifactRepository, EraSourceRepository } from "./repository.ts";
import type { EraArtifact, EraSource } from "./types.ts";

/** How far back a source with no cursor looks on its very first poll. */
export const FIRST_POLL_LOOKBACK_DAYS = 30;
/** Retry backoff for a retryable artifact failure, and the point at which we stop. */
export const ARTIFACT_MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = 60;

export interface EraPollReport {
  /** Artifacts the clearinghouse offered that we had not seen before. */
  discovered: number;
  /** Artifacts already on the ledger — normal traffic when a page overlaps. */
  alreadyKnown: number;
  /** Artifacts the vendor described but gave no retrievable id for. Recorded, never silent. */
  unretrievable: number;
  cursor: string | null;
  error: string | null;
}

export interface EraIngestReport {
  ingested: number;
  held: number;
  failed: number;
  deadLettered: number;
  remittances: RemittanceView[];
}

export class EraIngestService {
  #adapter: EdiAdapter;
  #sources: EraSourceRepository;
  #artifacts: EraArtifactRepository;
  #remittance: RemittanceService;
  #logger: Logger;

  constructor(
    adapter: EdiAdapter,
    sources: EraSourceRepository,
    artifacts: EraArtifactRepository,
    remittance: RemittanceService,
    logger: Logger
  ) {
    this.#adapter = adapter;
    this.#sources = sources;
    this.#artifacts = artifacts;
    this.#remittance = remittance;
    this.#logger = logger;
  }

  /**
   * Ask the clearinghouse what it has, and write every id to the ledger.
   *
   * Fetches nothing and posts nothing — discovery only. Separating the two is what makes the whole
   * path recoverable: after this returns, every ERA the clearinghouse mentioned exists as durable
   * work, whatever happens next.
   */
  async poll(source: EraSource, now: Date = new Date()): Promise<EraPollReport> {
    /**
     * Kept as one call for every existing caller and test. The WORKER uses the two halves below
     * directly, so the clearinghouse request happens with no transaction open (NEW-10).
     */
    return this.recordPage(source, await this.fetchPage(source, now), now);
  }

  /**
   * The clearinghouse request, and NOTHING else (NEW-10).
   *
   * ── WHY THE HALVES ARE SEPARATE ────────────────────────────────────────────────────────────────
   * The ERA worker wrapped a whole poll in `withPractice`, so a transaction and one of the pool's
   * ten connections were held for the duration of an HTTP call to a clearinghouse. A tick that
   * polls several sources held one for each, in sequence, while the rest of the process — the web
   * requests, the outbox drain — competed for what was left.
   *
   * Nothing here touches the database, so the caller can make this call holding nothing.
   */
  async fetchPage(source: EraSource, now: Date = new Date()) {
    const since = new Date(now.getTime() - FIRST_POLL_LOOKBACK_DAYS * 86_400_000).toISOString();
    return this.#adapter.listRemittanceArtifacts({ cursor: source.cursor, since });
  }

  /** Everything the page implies for the ledger. All database, no network — safe to hold a transaction. */
  async recordPage(
    source: EraSource,
    page: Awaited<ReturnType<EraIngestService["fetchPage"]>>,
    now: Date = new Date()
  ): Promise<EraPollReport> {
    if (!page.ok || !page.data) {
      const error = page.error?.message ?? "the clearinghouse did not answer";
      await this.#sources.recordPollFailure(source.id, error, now);
      return { discovered: 0, alreadyKnown: 0, unretrievable: 0, cursor: source.cursor, error };
    }

    let discovered = 0;
    let alreadyKnown = 0;
    for (const artifact of page.data.artifacts) {
      const { created } = await this.#artifacts.discover({
        practiceId: source.practiceId,
        sourceId: source.id,
        fileExecutionId: artifact.id,
        transactionId: artifact.transactionId,
        processedAt: artifact.processedAt,
      });
      if (created) discovered += 1;
      else alreadyKnown += 1;
    }

    /**
     * The cursor advances only after EVERY id on the page is on the ledger. Advancing first would
     * mean a crash mid-page skipped the remainder forever — the one failure mode that loses an ERA
     * silently, because nothing would ever mention it again.
     */
    await this.#sources.recordPollSuccess(source.id, page.data.nextCursor, now);

    return {
      discovered,
      alreadyKnown,
      unretrievable: 0,
      cursor: page.data.nextCursor,
      error: null,
    };
  }

  /**
   * Retrieve and ingest ONE artifact the ledger already knows about.
   *
   * Returns the remittances it produced. A retryable failure leaves the artifact pending with
   * backoff; a permanent one dead-letters it. Either way the row survives, so nothing is lost and a
   * human can see what happened.
   */
  async ingestArtifact(source: EraSource, artifact: EraArtifact, now: Date = new Date()): Promise<EraIngestReport> {
    /**
     * Kept as one call for every existing caller and test. The WORKER uses the two halves so the
     * retrieval happens with no transaction open (NEW-10).
     */
    return this.recordArtifact(source, artifact, await this.fetchArtifact(artifact), now);
  }

  /**
   * Retrieve one artifact's bytes. No database (NEW-10) — see `fetchPage` for why that matters.
   *
   * An 835 can be megabytes and a clearinghouse can be slow; this is the longest single wait in the
   * ERA path, and it used to happen inside a practice transaction.
   *
   * `null` for an artifact with no clearinghouse id: there is nothing to ask for, and asking with an
   * empty id would send a meaningless request. `recordArtifact` turns that into the permanent
   * failure it is.
   */
  async fetchArtifact(artifact: EraArtifact) {
    if (!artifact.fileExecutionId.trim()) return null;
    return this.#adapter.fetchRemittanceArtifact(artifact.fileExecutionId);
  }

  /** Everything the retrieved bytes imply. All database, no network. */
  async recordArtifact(
    source: EraSource,
    artifact: EraArtifact,
    fetched: Awaited<ReturnType<EraIngestService["fetchArtifact"]>>,
    now: Date = new Date()
  ): Promise<EraIngestReport> {
    const empty: EraIngestReport = { ingested: 0, held: 0, failed: 0, deadLettered: 0, remittances: [] };

    if (fetched === null) {
      // Cannot happen through `poll` (which filters these out), but this is the money path and a
      // future caller does not inherit that guarantee. Settled rather than rescheduled: no number
      // of retries will give this artifact an id it never had.
      await this.#artifacts.settle(artifact.id, "failed", {
        error: "the artifact has no clearinghouse id, so it can never be retrieved",
        at: now,
      });
      return { ...empty, failed: 1, deadLettered: 1 };
    }

    if (!fetched.ok || !fetched.data) {
      return this.#failArtifact(artifact, fetched.error?.message ?? "retrieval failed", fetched.error?.retryable ?? true, now, empty);
    }

    /**
     * A payload that is not X12 is refused BEFORE the parser sees it.
     *
     * The parser would refuse it too, but the distinction matters for triage: "the clearinghouse
     * served us an HTML error page" and "this 835 is malformed" are different incidents with
     * different fixes, and collapsing them into one parse error hides the first behind the second.
     */
    if (!looksLikeX12(fetched.data)) {
      return this.#failArtifact(
        artifact,
        "the retrieved artifact is not X12 — the clearinghouse served something else (an error page, or a JSON body)",
        false,
        now,
        empty
      );
    }

    let views: RemittanceView[];
    try {
      views = await this.#remittance.ingestArtifact(
        fetched.data,
        {
          resolution: "source-credential",
          vendor: source.vendor,
          artifactId: artifact.fileExecutionId,
          expectedPayeeId: source.payeeNpi,
        },
        now
      );
    } catch (e) {
      /**
       * The thrown error's OWN retryable flag decides, when it carries one.
       *
       * This was a hard-coded `false`, on the reasoning that a parse failure is permanent — true of
       * parsing, and `RemittanceUnavailableError` says so itself (`retryable: false` on a parse
       * error). But the same class arrives with `retryable: true` for transient retrieval and
       * infrastructure failures, and ignoring its word dead-lettered the artifact on the FIRST such
       * failure: five retries' worth of machinery skipped, and a payer's money file pushed to the
       * hand-work queue for a condition that would have cleared itself. An error that does not say
       * (a driver error, an unexpected throw) stays permanent — dead-lettering is visible in the
       * Today queue, while optimistic retries of a genuinely broken file would only delay it there.
       */
      const retryable = e instanceof RemittanceUnavailableError ? e.retryable : false;
      return this.#failArtifact(artifact, e instanceof Error ? e.message : String(e), retryable, now, empty);
    }

    const held = views.filter((v) => v.remittance.status === "held").length;
    await this.#artifacts.settle(artifact.id, held === views.length && views.length > 0 ? "held" : "ingested", {
      remittanceCount: views.length,
      error: null,
      at: now,
    });

    return { ingested: views.length - held, held, failed: 0, deadLettered: 0, remittances: views };
  }

  async #failArtifact(
    artifact: EraArtifact,
    error: string,
    retryable: boolean,
    now: Date,
    empty: EraIngestReport
  ): Promise<EraIngestReport> {
    /**
     * How many attempts this artifact has had, INCLUDING the one that just failed (NEW-18).
     *
     * This was unconditionally `artifact.attempts + 1`, which is right only for a store that counts
     * on failure. Postgres counts on CLAIM — `claim_era_artifacts` increments as it leases the row,
     * so a crashed worker still burns an attempt — and adding one there counted the same attempt
     * twice. The effect: an artifact dead-lettered on its FOURTH attempt while the log said five,
     * so a payer's money file reached the hand-work queue a whole retry early, and the number that
     * would have explained it was itself wrong.
     */
    const attempts = this.#artifacts.countsAttemptsOnClaim ? artifact.attempts : artifact.attempts + 1;
    const deadLetter = !retryable || attempts >= ARTIFACT_MAX_ATTEMPTS;
    const backoff = BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1);

    await this.#artifacts.reschedule(artifact.id, error, new Date(now.getTime() + backoff * 1000), deadLetter);
    this.#logger.error("era: artifact could not be ingested", {
      channel: "error",
      artifactId: artifact.fileExecutionId,
      attempts,
      deadLettered: deadLetter,
      retryable,
      error,
    });
    return { ...empty, failed: 1, deadLettered: deadLetter ? 1 : 0 };
  }
}

/**
 * Is this plausibly an X12 interchange?
 *
 * Deliberately shallow — it separates "not EDI at all" from "EDI we could not read", and leaves
 * every judgement about the CONTENT to the parser. A cleverer check here would be a second opinion
 * about what a valid 835 is, and there is only ever one of those in this codebase.
 */
export function looksLikeX12(payload: string): boolean {
  const head = payload.trimStart().slice(0, 3).toUpperCase();
  return head === "ISA" || head === "ST*";
}
