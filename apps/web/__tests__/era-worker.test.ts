/**
 * The ERA worker's failure reporting.
 *
 * ── THE ONE FAILURE WITH NO OTHER WITNESS ──────────────────────────────────────────────────────
 * Per-source and per-artifact failures are caught and logged inside `runEraTick`. What the timer
 * swallowed with a bare `.catch(() => {})` was a failure of the TICK ITSELF — `claimEraSources`
 * throwing, which is what a missing SECURITY DEFINER function, a revoked grant or a database
 * outage looks like.
 *
 * That is the money-IN path, and it is invisible to every other control: if polling never runs, no
 * artifact is ever discovered, so there is nothing to dead-letter and nothing held — and both
 * `era.dead_letters` and `money.held_remittance_age` report healthy while the clearinghouse
 * accumulates a practice's payments. The outbox worker's equivalent path already logged; this one
 * did not, and it is the one that brings money in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEraWorker } from "../era-worker.ts";
import type { Services } from "../wiring.ts";

/** Only `persistent` is read before the tick runs. */
const persistent = (): Services => ({ persistent: true }) as unknown as Services;

/**
 * Capture what the SHIPPED logger writes.
 *
 * `defaultLogger` writes a JSON line to stdout, and the worker reaches for it directly. Injecting a
 * logger would prove nothing about the path that runs in production, so stdout is intercepted for
 * the duration instead.
 */
async function captureLogLines(during: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    try {
      const parsed = JSON.parse(String(chunk)) as Record<string, unknown>;
      if (typeof parsed.message === "string") {
        lines.push(parsed);
        return true; // captured — and swallowed, so the log line does not litter the report
      }
    } catch {
      /* not one of ours */
    }
    /**
     * EVERYTHING ELSE MUST PASS THROUGH. node:test writes its own TAP stream to this same stdout,
     * so an interceptor that returns `true` unconditionally eats the results of every test running
     * inside the capture window — which is exactly what happened here first: three tests ran and
     * two were reported.
     */
    return originalWrite(chunk as never);
  };
  try {
    await during();
  } finally {
    (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  return lines;
}

test("a tick that fails wholesale is reported, not swallowed", async () => {
  const lines = await captureLogLines(async () => {
    const worker = startEraWorker(persistent(), 5, async () => {
      throw new Error("claim_era_sources(integer,integer) does not exist");
    });
    // Long enough for the interval to fire and the rejection to settle; no I/O is involved.
    await new Promise((resolve) => setTimeout(resolve, 80));
    worker.stop();
  });

  const failure = lines.find((l) => String(l.message).includes("the polling tick failed entirely"));
  assert.ok(
    failure,
    `a wholesale tick failure must reach an operator; captured: ${JSON.stringify(lines.map((l) => l.message))}`
  );
  assert.equal(failure!.channel, "error", "it belongs on the error channel an operator watches");
  assert.match(
    String(failure!.error),
    /claim_era_sources/,
    "and it must carry the REASON — 'a tick failed' with no cause is not actionable"
  );
});

test("a tick that succeeds says nothing — a worker nobody can ignore is one nobody reads", async () => {
  const lines = await captureLogLines(async () => {
    const worker = startEraWorker(persistent(), 5, async () => ({ sourcesPolled: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    worker.stop();
  });

  assert.equal(
    lines.filter((l) => String(l.message).includes("the polling tick failed entirely")).length,
    0
  );
});

test("the worker does not start at all without a database", async () => {
  // No timer, so the DB-free demo polls no clearinghouse and reports nothing about one.
  let ticked = false;
  const worker = startEraWorker({ persistent: false } as unknown as Services, 5, async () => {
    ticked = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  worker.stop();
  assert.equal(ticked, false);
});
