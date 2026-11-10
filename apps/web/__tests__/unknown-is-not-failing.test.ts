/**
 * A signal that has not been measured does not get to claim a failure.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `readiness.ready` is a boolean, so "no readiness check has ever reported" and "a readiness check
 * failed" both arrived as `false`, and both painted a red NOT READY at the top of the Ops console.
 *
 * Rendered against live staging that badge sat directly above:
 *
 *   0 pending · queue healthy
 *   OK — Nothing is firing. The outbox, the money and the ERA ledger all read normally.
 *   Nothing is dead-lettered. Every event published so far reached every subscriber that wanted it.
 *   READINESS — No checks reported.
 *
 * Five statements that the machine is fine, under one that says it is not. An operator either goes
 * hunting for a fault that does not exist, or learns to ignore the badge — and the second is worse,
 * because the badge is the thing that has to work on the day something really is broken.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 * Three states, not two: ready, not ready, and not checked. The third is the absence of evidence and
 * is never painted as failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/** The Ops console's masthead, where the readiness verdict is rendered. */
function opsBadge(): string {
  const i = CLIENT.indexOf("Is anything stuck?");
  assert.ok(i > -1, "the Ops console must still render its masthead");
  const region = CLIENT.slice(i, i + 1800);
  const j = region.indexOf("readiness.ready");
  assert.ok(j > -1, "the masthead must still carry a readiness verdict");
  return region;
}

test("no reported check is shown as unknown, not as a failure", () => {
  const region = opsBadge();
  assert.match(
    region,
    /\(readiness\.checks \?\? \[\]\)\.length === 0/,
    "the verdict must branch on whether any check REPORTED, before it branches on whether they passed"
  );
  assert.match(region, /not checked/, "and must have a word for the unmeasured state");
});

test("the unknown state never uses the failure treatment", () => {
  const region = opsBadge();
  /**
   * `status--failed` is the red one. It may appear in this masthead — a genuinely failing check
   * should be red — but never on the branch that fires when nothing has reported.
   */
  const unknownBranch = /length === 0\s*\?\s*`([^`]*)`/.exec(region)?.[1] ?? "";
  assert.ok(unknownBranch.length > 0, "the unknown branch must render something");
  assert.doesNotMatch(
    unknownBranch,
    /status--failed/,
    "an unmeasured signal must not be painted as a failed one"
  );
});

test("a real failure is still reported as one", () => {
  /* The fix must not have made the badge incapable of alarming. */
  const region = opsBadge();
  assert.match(
    region,
    /status--\$\{readiness\.ready \? "verified" : "failed"\}/,
    "once checks exist, the verdict is still ready-or-failed"
  );
});
