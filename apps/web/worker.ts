/**
 * Dedicated Background Worker Process for Mermaid.
 *
 * ── ARCHITECTURE ROLE (docs/architecture/12-deployment-architecture.md) ──────────────────────
 * In production, Mermaid follows a modular monolith architecture running three process roles
 * from a single codebase:
 *   1. 'web'    — HTTP server / BFF serving the UI and API endpoints
 *   2. 'worker' — Outbox polling, domain event dispatch, and clearinghouse ERA retrieval
 *   3. 'jobs'   — Scheduled cron jobs (daily reconciliation, monitors, queue sweeps)
 *
 * This file is the entrypoint for the 'worker' process role.
 */
import { buildServices, outboxIntervalMs, startOutboxWorker } from "./wiring.ts";
import { startEraWorker } from "./era-worker.ts";
import { logger } from "@mermaid/observability";

async function main(): Promise<void> {
  logger.info("Starting Mermaid Background Worker...", { channel: "app" });

  const services = buildServices();

  if (!services.persistent) {
    logger.warn("Worker running without persistent database connection (in-memory mode)", {
      channel: "app",
    });
  }

  // 1. Start Outbox Worker (processes domain events: claims, remittances, ledger updates)
  const intervalMs = outboxIntervalMs();
  logger.info(`Starting Outbox Worker (poll interval: ${intervalMs}ms)...`, { channel: "app" });
  const outboxHandle = startOutboxWorker(services, intervalMs);

  // 2. Start ERA Polling Worker (polls registered clearinghouse credentials for 835 ERAs)
  logger.info("Starting ERA Clearinghouse Worker...", { channel: "app" });
  const eraHandle = startEraWorker(services);

  logger.info("Mermaid Background Worker running and listening for events.", { channel: "app" });

  // Dedicated worker process keep-alive (ensures event loop remains active as a long-running daemon)
  const keepAlive = setInterval(() => {
    logger.debug("Background worker heartbeat", { channel: "app" });
  }, 30_000);

  // Graceful shutdown handling
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down Background Worker gracefully...`, { channel: "app" });
    clearInterval(keepAlive);
    outboxHandle.stop();
    eraHandle.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error("Fatal error in Background Worker process", {
    channel: "error",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
