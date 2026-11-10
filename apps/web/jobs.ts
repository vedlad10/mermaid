/**
 * Dedicated Scheduled Jobs Process for Mermaid.
 *
 * ── ARCHITECTURE ROLE (docs/architecture/12-deployment-architecture.md) ──────────────────────
 * In production, Mermaid follows a modular monolith architecture running three process roles:
 *   1. 'web'    — HTTP server / BFF
 *   2. 'worker' — Outbox polling and ERA worker
 *   3. 'jobs'   — Scheduled maintenance, daily reconciliation, deadline notifications, monitors
 *
 * This file is the entrypoint for the 'jobs' process role.
 */
import { buildServices } from "./wiring.ts";
import { startMonitors } from "./monitors.ts";
import { getConfig } from "@mermaid/config";
import { createAlertNotifier, logger } from "@mermaid/observability";

async function main(): Promise<void> {
  logger.info("Starting Mermaid Scheduled Jobs Runner...", { channel: "app" });

  const services = buildServices();

  // 1. Initialize Alert Notifier (with strict PHI redaction)
  const notify = createAlertNotifier({
    url: getConfig().alertWebhookUrl,
    environment: getConfig().deploymentName,
    logger,
  });

  // 2. Start Operational Monitors (stalled outbox queue & money reconciliation drift)
  logger.info("Arming operational monitors and reconciliation sweeps...", { channel: "app" });
  startMonitors(services, { notify });

  // 3. Periodic Daily Reconciliation Job (Runs every 24 hours, or hourly check)
  const RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const runReconcile = async () => {
    try {
      logger.info("Executing scheduled daily ledger & remittance reconciliation...", { channel: "app" });
      const report = await services.remittance.reconcileAll();
      if (report.drift !== 0) {
        logger.error(`Reconciliation drift detected: ${report.drift} cents`, {
          channel: "alert",
          drift: report.drift,
        });
      } else {
        logger.info("Reconciliation complete: balanced with 0 drift.", { channel: "app" });
      }
    } catch (err) {
      logger.error("Error during scheduled reconciliation job", {
        channel: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Run initial check and arm timer (referenced so the process stays alive as a long-running daemon)
  void runReconcile();
  const timer = setInterval(() => void runReconcile(), RECONCILE_INTERVAL_MS);

  logger.info("Mermaid Scheduled Jobs Runner active.", { channel: "app" });

  // Graceful shutdown handling
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down Jobs Runner gracefully...`, { channel: "app" });
    clearInterval(timer);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error("Fatal error in Scheduled Jobs process", {
    channel: "error",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
