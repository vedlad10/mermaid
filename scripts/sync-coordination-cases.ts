/**
 * Open the coordination-of-benefits cases (migration 0034) for remittances that arrived before it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * From 0034 on, every ingest, release and reject keeps its claims' coordination cases current. An
 * advice that arrived BEFORE 0034 — a status-19 forward sitting in `held`, a posted CAS OA-23 — has
 * no case yet, so nobody is asked the coverage question it raises. This walks every practice and runs
 * the SAME `syncCoordinationCases` the service runs on its own: it is not a hand-written SQL
 * backfill, and it cannot decide anything the application would not.
 *
 * ── WHAT IT WRITES, AND WHAT IT NEVER TOUCHES ──────────────────────────────────────────────────
 * It writes `coordination_cases` rows and one audit row per practice. It does not release, reject,
 * post or edit a remittance, a posting, a ledger entry, a claim or a coverage row — the sync reads
 * remittances and derives cases from them. A case is opened `unconfirmed`: coverage is never
 * inferred, and no secondary payer is invented.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────────────────────────
 * Each signal is keyed by the remittance that raised it, so a second run finds every case current
 * and reports it unchanged. `--dry-run` runs the sync inside each practice's transaction and rolls
 * it back, printing what it would have opened.
 *
 *   node --env-file=.env scripts/sync-coordination-cases.ts [--dry-run]
 *
 * Refuses a production-looking database, the same shape as every operational script here.
 */
import { randomUUID } from "node:crypto";
import { closePool, withPractice, withoutPractice } from "@mermaid/db";
import { recordAudit } from "@mermaid/observability";
import { buildServices } from "../apps/web/wiring.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL is not set.");
  process.exit(1);
}
if (/prod/i.test(new URL(url).hostname)) {
  console.error("REFUSED: DATABASE_URL looks like production. Run the sync there through a reviewed release.");
  process.exit(2);
}

const dryRun = process.argv.includes("--dry-run");
class DryRun extends Error {}

const services = buildServices();
if (!services.persistent) {
  console.error("REFUSED: services are not persistent — nothing to sync.");
  process.exit(1);
}

const now = new Date();
const traceId = randomUUID();
const { rows } = await withoutPractice((tx) => tx.query("SELECT id, name FROM practices WHERE status = 'active' ORDER BY name"));

console.log(`\ncoordination-case sync${dryRun ? " — DRY RUN, nothing is kept" : ""}`);
console.log("=".repeat(72));

let failed = 0;
const grand = { opened: 0, updated: 0, unchanged: 0 };
for (const practice of rows as { id: string; name: string }[]) {
  let totals = { opened: 0, updated: 0, unchanged: 0 };
  try {
    await withPractice(practice.id, async (tx) => {
      totals = await services.remittance.syncCoordinationCases(now);
      if (dryRun) throw new DryRun();
      await recordAudit(tx, {
        practiceId: practice.id,
        traceId,
        actorId: null,
        actorRole: "system",
        action: "sync",
        resource: "coordination_cases",
        after: totals,
        outcome: "success",
      });
    });
  } catch (err) {
    if (!(err instanceof DryRun)) {
      failed++;
      console.log(`   FAIL  ${practice.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  grand.opened += totals.opened;
  grand.updated += totals.updated;
  grand.unchanged += totals.unchanged;
  console.log(`   ok    ${practice.name}: ${totals.opened} opened, ${totals.updated} updated, ${totals.unchanged} unchanged`);
}

console.log("=".repeat(72));
console.log(
  `${rows.length} practice(s): ${grand.opened} opened, ${grand.updated} updated, ${grand.unchanged} unchanged` +
    (dryRun ? " — rolled back." : ".") +
    (failed ? ` ${failed} practice(s) FAILED.` : "")
);

await closePool();
process.exit(failed === 0 ? 0 : 1);
