/**
 * The ERA worker — the only place where "which practice does this money belong to" is answered.
 *
 * ── THE SHAPE, AND WHY IT IS THIS SHAPE ────────────────────────────────────────────────────────
 * Identical in structure to the outbox worker, for the same reasons: a narrow cross-tenant claim
 * followed by strictly tenant-scoped work.
 *
 *   claim sources (cross-tenant, SECURITY DEFINER, leased)
 *     └─ for each source: withPractice(source.practice_id)
 *          ├─ build a vendor client from THAT PRACTICE'S OWN credential
 *          ├─ poll → write every artifact id to the ledger → advance the cursor
 *          └─ claim + ingest that practice's due artifacts
 *
 * The tenant is decided by which row the claim returned, before any credential is decrypted and
 * long before any 835 is read. Nothing downstream can change it, because nothing downstream is
 * given the opportunity: `EraIngestService` receives an adapter and a practice context and has no
 * way to ask for a different one.
 *
 * ── WHY EACH PRACTICE GETS ITS OWN ADAPTER ─────────────────────────────────────────────────────
 * The process-wide `getEdiAdapter()` is built from the deployment's own `STEDI_API_KEY`, which is
 * the right credential for eligibility (one practice per deployment today) and the WRONG one here.
 * Polling every practice with one shared key would fetch one Stedi account's ERAs and attribute
 * them to whichever practice the loop happened to be on — the exact cross-practice posting this
 * design exists to make impossible. So the adapter is constructed per source, from that source's
 * own credential.
 */
import { claimEraArtifacts, claimEraSources, withPractice } from "@mermaid/db";
import { getConfig } from "@mermaid/config";
import { MockEdiAdapter, StediEdiAdapter, type EdiAdapter } from "@mermaid/edi";
import { logger as defaultLogger, type Logger } from "@mermaid/observability";
import {
  ARTIFACT_MAX_ATTEMPTS,
  EraIngestService,
  PgEraArtifactRepository,
  PgEraSourceRepository,
  type EraSource,
} from "@mermaid/remittance";
import type { Services } from "./wiring.ts";

export interface EraWorkerReport {
  sourcesPolled: number;
  discovered: number;
  artifactsProcessed: number;
  ingested: number;
  held: number;
  failed: number;
}

/** How many sources and artifacts one tick will take on. Small: this runs beside a web server. */
const SOURCE_BATCH = 5;
/**
 * Backoff for an artifact the worker could not even prepare. Deliberately longer than the ingest
 * path's: the causes here are configuration (a deleted source, an unknown vendor) rather than a
 * flaky network, and retrying those quickly just burns batch slots.
 */
const ARTIFACT_RETRY_SECONDS = 900;

/**
 * What to do with a claimed artifact the worker could not prepare.
 *
 * Extracted as a pure function because the rule is the whole point and `runEraTick` needs a database
 * to run at all — so a rule left inline is a rule no test can reach, which is exactly how the skip
 * this replaces survived. Takes the attempt count the CLAIM already incremented, so the arithmetic
 * matches `EraIngestService`, whose `countsAttemptsOnClaim` note documents the same subtlety.
 */
export function unpreparableSettlement(
  attempts: number,
  reason: string,
  now: Date
): { error: string; nextAttemptAt: Date; deadLetter: boolean } {
  return {
    error: `This payment file could not be prepared for ingestion: ${reason}.`,
    nextAttemptAt: new Date(now.getTime() + ARTIFACT_RETRY_SECONDS * 1000),
    // `>=`, matching the ingest path: the claim already counted this attempt.
    deadLetter: attempts >= ARTIFACT_MAX_ATTEMPTS,
  };
}
const ARTIFACT_BATCH = 10;

/**
 * Build the vendor client for ONE practice's source.
 *
 * `mock` is a real, supported vendor here rather than a test hook: it is what a deployment runs
 * against before its clearinghouse enrollment completes, and what the demo uses. It serves only
 * artifacts something has staged, so it cannot invent money.
 */
function adapterFor(source: EraSource, logger: Logger): EdiAdapter | null {
  if (source.vendor === "mock") return new MockEdiAdapter();
  if (source.vendor === "stedi") {
    const config = getConfig();
    try {
      return new StediEdiAdapter({
        // THE PRACTICE'S OWN credential — never the deployment-wide one.
        apiKey: source.credential,
        baseUrl: config.stediBaseUrl,
        coreBaseUrl: config.stediCoreBaseUrl,
        timeoutMs: config.stediTimeoutMs,
        testMode: source.credential.startsWith("test_"),
        provider: { organizationName: config.billingProviderName, npi: config.billingProviderNpi },
      });
    } catch (e) {
      // A credential that fails the adapter's own test/production interlock. Refusing to poll is
      // the correct outcome — the alternative is fetching real ERAs with a test key or vice versa.
      logger.error("era: refusing to poll a source whose credential is misconfigured", {
        channel: "error",
        practiceId: source.practiceId,
        vendor: source.vendor,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
  logger.error("era: unknown vendor on an ERA source", {
    channel: "error",
    practiceId: source.practiceId,
    vendor: source.vendor,
  });
  return null;
}

/**
 * One tick: poll every due source, then ingest every due artifact.
 *
 * Errors are contained per source and per artifact — one practice's broken credential must not stop
 * another practice's money being posted.
 */
export async function runEraTick(services: Services, now: Date = new Date()): Promise<EraWorkerReport> {
  const report: EraWorkerReport = {
    sourcesPolled: 0,
    discovered: 0,
    artifactsProcessed: 0,
    ingested: 0,
    held: 0,
    failed: 0,
  };
  if (!services.persistent) return report;

  const logger: Logger = defaultLogger;
  const claimedSources = await claimEraSources(SOURCE_BATCH);

  for (const row of claimedSources) {
    const source: EraSource = {
      id: row.id,
      practiceId: row.practice_id,
      vendor: row.vendor,
      // Decrypted inside the practice's own transaction, used to build one client, never logged.
      credential: "",
      payeeNpi: row.payee_npi,
      cursor: row.cursor,
      enabled: row.enabled,
      lastPolledAt: row.last_polled_at ? row.last_polled_at.toISOString() : null,
      lastError: row.last_error,
    };

    try {
      /**
       * ── THE CLEARINGHOUSE CALL HAPPENS BETWEEN THE TRANSACTIONS, NOT INSIDE ONE (NEW-10) ──────
       *
       * This whole block used to sit inside one `withPractice`, so a transaction and one of the
       * pool's ten connections were held for the duration of an HTTP request to a clearinghouse. A
       * tick polling several sources held one for each in turn, while the web requests and the
       * outbox drain competed for what was left — and a slow vendor turned a background job into a
       * process-wide stall.
       *
       * Read the source, let go, ask the vendor, take a transaction again to write what it said.
       */
      const prepared = await withPractice(row.practice_id, async () => {
        const sources = new PgEraSourceRepository();
        /**
         * Re-read the source INSIDE the practice transaction rather than trusting the claim row's
         * credential field. The claim is queue mechanics; this is the tenant read, and it goes
         * through RLS like everything else — so if the two ever disagreed, the RLS-scoped answer is
         * the one used.
         */
        const own = await sources.get(row.vendor);
        if (!own) return null;
        const adapter = adapterFor(own, logger);
        return adapter ? { own, adapter } : null;
      });
      /**
       * A source that cannot be prepared is a different case and stays a skip: nothing is stuck,
       * the source simply is not polled this tick. But it is now SAID. Silence here meant a
       * misconfigured source — deleted, or with no adapter for its vendor — looked exactly like a
       * source with nothing new to offer, for as long as anyone cared to look.
       */
      if (!prepared) {
        logger.error("era: a source could not be polled", {
          channel: "error",
          practiceId: row.practice_id,
          vendor: row.vendor,
          error: "the source is no longer registered, or no adapter could be built for its vendor",
        });
        continue;
      }

      const era = (): EraIngestService =>
        new EraIngestService(
          prepared.adapter,
          new PgEraSourceRepository(),
          new PgEraArtifactRepository(),
          services.remittance,
          logger
        );

      // No transaction, no lock, no pooled connection — just the wait.
      const page = await era().fetchPage(prepared.own, now);

      await withPractice(row.practice_id, async () => {
        const polled = await era().recordPage(prepared.own, page, now);
        report.sourcesPolled += 1;
        report.discovered += polled.discovered;
      });
    } catch (e) {
      logger.error("era: polling a source failed", {
        channel: "error",
        practiceId: source.practiceId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Artifacts are claimed separately from sources so a backlog drains even on a tick that
  // discovered nothing — and so a source whose poll failed still has its earlier work retried.
  const claimedArtifacts = await claimEraArtifacts(ARTIFACT_BATCH);
  for (const row of claimedArtifacts) {
    try {
      // Same shape as the poll above: read, let go, retrieve, write (NEW-10). Retrieving an 835 is
      // the longest single wait in this path — the files run to megabytes.
      const prepared = await withPractice(row.practice_id, async () => {
        const sources = new PgEraSourceRepository();
        const artifacts = new PgEraArtifactRepository();
        /**
         * The artifact names the source that offered it. Resolve THAT one.
         *
         * This used to be `get("stedi") ?? get("mock")` — a vendor guess in priority order, which
         * is right only while a practice has exactly one source. The source decides which
         * credential fetches the file and which `payeeNpi` the tenancy cross-check compares the
         * 835's payee against, so with two sources registered the guess could check a payment from
         * one clearinghouse against the other one's NPI.
         */
        const own = await sources.getById(row.source_id);
        if (!own) return null;

        const adapter = adapterFor(own, logger);
        if (!adapter) return null;

        const artifact = await artifacts.get(row.file_execution_id);
        if (!artifact) return { unpreparable: "the artifact row could not be read back" as string };
        return { own, adapter, artifact };
      });

      /**
       * ── AN ARTIFACT THAT CANNOT BE PREPARED MUST BE SETTLED, NOT SKIPPED ──────────────────────
       *
       * This was `if (!prepared) continue`. Dead-lettering lives inside `EraIngestService`, and that
       * service is constructed BELOW this line — so an artifact whose source has been deleted, or
       * whose adapter cannot be built, was claimed and then dropped without ever being settled.
       *
       * `claim_era_artifacts` increments `attempts` on every claim, so the counter climbed forever
       * while `dead_lettered` stayed false. The consequences compound:
       *
       *   • It never reaches `deadLetteredArtifacts()`, so it never appears on the Today board or
       *     in the ERA monitor — the two surfaces built precisely to make an abandoned payment file
       *     visible. A payer's money sat uningested and nothing anywhere said so.
       *   • It is re-claimed every lease, forever, consuming one of the ten slots in every batch.
       *     Ten such artifacts would stall ERA ingestion entirely, silently and permanently.
       *
       * Settling it instead lets the ordinary retry-then-dead-letter path do its job: transient
       * causes recover on a later tick, and a permanent one surfaces as an abandoned file a person
       * can act on. That is the same doctrine the outbox already follows — a handler that cannot run
       * settles the event rather than leaving it claimed.
       */
      if (!prepared || "unpreparable" in prepared) {
        const reason: string =
          prepared && "unpreparable" in prepared && typeof prepared.unpreparable === "string"
            ? prepared.unpreparable
            : "its ERA source is no longer registered, or no adapter could be built for it";
        const settlement = unpreparableSettlement(row.attempts, reason, now);
        await withPractice(row.practice_id, async () => {
          const artifacts = new PgEraArtifactRepository();
          await artifacts.reschedule(
            row.file_execution_id,
            settlement.error,
            settlement.nextAttemptAt,
            settlement.deadLetter
          );
          if (settlement.deadLetter) report.failed += 1;
        });
        logger.error("era: an artifact could not be prepared", {
          channel: "error",
          practiceId: row.practice_id,
          artifactId: row.file_execution_id,
          attempts: row.attempts,
          error: reason,
        });
        continue;
      }

      const era = (): EraIngestService =>
        new EraIngestService(
          prepared.adapter,
          new PgEraSourceRepository(),
          new PgEraArtifactRepository(),
          services.remittance,
          logger
        );

      const fetched = await era().fetchArtifact(prepared.artifact);

      await withPractice(row.practice_id, async () => {
        const outcome = await era().recordArtifact(prepared.own, prepared.artifact, fetched, now);
        report.artifactsProcessed += 1;
        report.ingested += outcome.ingested;
        report.held += outcome.held;
        report.failed += outcome.failed;
      });
    } catch (e) {
      logger.error("era: ingesting an artifact failed", {
        channel: "error",
        practiceId: row.practice_id,
        artifactId: row.file_execution_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}

/**
 * Start the background ERA poller.
 *
 * Five minutes, not five seconds: an ERA is a file a payer released hours ago, and polling a
 * clearinghouse aggressively earns a rate limit rather than faster money. `unref()` so it never
 * holds the process open.
 */
export function startEraWorker(
  services: Services,
  intervalMs = 300_000,
  /**
   * The tick to run. Injected for the same reason `openTransaction` takes its connector: the
   * behaviour worth pinning here is what happens when the tick FAILS, and there is no way to make
   * a real database fail on cue inside a unit test.
   */
  tick: (services: Services) => Promise<unknown> = runEraTick
): { stop(): void } {
  if (!services.persistent) return { stop() {} };
  const timer = setInterval(() => {
    /**
     * A tick that fails WHOLESALE has to say so.
     *
     * This was `.catch(() => {})`. Per-source and per-artifact failures are already caught and
     * logged inside `runEraTick`, so the only thing this swallowed was a failure of the tick
     * itself — `claimEraSources` throwing, which is what a missing SECURITY DEFINER function, a
     * revoked grant or a database outage looks like. That is the one failure mode with no other
     * witness: if polling never runs, no artifact is ever discovered, so there is nothing to
     * dead-letter and nothing held, and `era.dead_letters` and `money.held_remittance_age` both
     * report healthy while the clearinghouse quietly accumulates a practice's payments.
     *
     * The outbox worker's equivalent path already logs (`drainOutbox` catches and writes "outbox
     * drain failed"); this one did not, and it is the path that moves money in.
     */
    void tick(services).catch((err: unknown) => {
      defaultLogger.error("era: the polling tick failed entirely — no ERA was discovered or ingested", {
        channel: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
