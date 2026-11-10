/**
 * A payment file the worker cannot prepare is SETTLED, never silently skipped.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The artifact loop read `if (!prepared) continue`. Dead-lettering lives inside `EraIngestService`,
 * which is constructed AFTER that line — so an artifact whose ERA source had been deleted, or whose
 * vendor had no adapter, was claimed and then dropped without ever being settled.
 *
 * `claim_era_artifacts` increments `attempts` on every claim, so the counter climbed forever while
 * `dead_lettered` stayed false. Two things followed, and both are worse than the wrong counter:
 *
 *   • It never reached `deadLetteredArtifacts()`, so it never appeared on the Today board or in the
 *     ERA monitor — the two surfaces built precisely to make an abandoned payment file visible. A
 *     payer's money sat uningested and nothing anywhere said so. That is the exact detectability
 *     gap the Today board's own comment describes for held remittances.
 *   • It was re-claimed every lease forever, consuming one of the ten slots in every batch. Ten
 *     such artifacts would stall ERA ingestion entirely, silently and permanently.
 *
 * The rule is tested here rather than through `runEraTick`, which needs a database to run at all —
 * a rule left inline is a rule no test can reach, which is how the skip survived in the first place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_MAX_ATTEMPTS } from "@mermaid/remittance";
import { unpreparableSettlement } from "../era-worker.ts";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const REASON = "its ERA source is no longer registered";

test("an early failure is rescheduled, not abandoned", () => {
  const s = unpreparableSettlement(1, REASON, NOW);
  assert.equal(s.deadLetter, false, "a deleted source may be restored; one attempt proves nothing");
  assert.ok(s.nextAttemptAt > NOW, "and it must come back round rather than sitting claimed");
});

test("it gives up at the same attempt count the ingest path does", () => {
  assert.equal(
    unpreparableSettlement(ARTIFACT_MAX_ATTEMPTS - 1, REASON, NOW).deadLetter,
    false,
    "one attempt short"
  );
  assert.equal(
    unpreparableSettlement(ARTIFACT_MAX_ATTEMPTS, REASON, NOW).deadLetter,
    true,
    "`>=`, because the claim already counted this attempt — the same arithmetic EraIngestService uses"
  );
  assert.equal(unpreparableSettlement(ARTIFACT_MAX_ATTEMPTS + 3, REASON, NOW).deadLetter, true);
});

test("the recorded error says what a person has to go and fix", () => {
  const s = unpreparableSettlement(2, REASON, NOW);
  assert.match(s.error, /could not be prepared for ingestion/);
  assert.match(s.error, /no longer registered/, "the reason travels, not just the fact of failure");
  assert.doesNotMatch(s.error, /undefined|null|\[object/, "an error a person reads is part of the fix");
});

test("the backoff is longer than a network retry, because the cause is configuration", () => {
  /**
   * A deleted source or an unknown vendor will not fix itself in thirty seconds, and retrying
   * quickly just burns slots in a batch of ten that real payment files are waiting for.
   */
  const minutes = (unpreparableSettlement(1, REASON, NOW).nextAttemptAt.getTime() - NOW.getTime()) / 60_000;
  assert.ok(minutes >= 10, `backoff was ${minutes} minutes`);
});

test("the settlement is a pure function of its inputs", () => {
  /** Two identical calls must agree, or a retry could dead-letter a file the previous tick spared. */
  assert.deepEqual(unpreparableSettlement(3, REASON, NOW), unpreparableSettlement(3, REASON, NOW));
});

test("every attempt count from one to well past the limit resolves one way or the other", () => {
  /**
   * The property that closes the original defect: there is no attempt count at which an artifact is
   * left unsettled. Before, EVERY count left it unsettled.
   */
  for (let attempts = 1; attempts <= ARTIFACT_MAX_ATTEMPTS + 5; attempts++) {
    const s = unpreparableSettlement(attempts, REASON, NOW);
    assert.equal(typeof s.deadLetter, "boolean", `attempts ${attempts}`);
    assert.ok(s.nextAttemptAt instanceof Date && !Number.isNaN(s.nextAttemptAt.getTime()));
    assert.ok(s.error.length > 0);
  }
});
