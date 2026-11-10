/**
 * `npm run demo:journey` is how a person sees the whole revenue cycle work on a laptop. If it breaks,
 * the product's one end-to-end demonstration breaks with it, so it runs here, as CI runs it: no
 * `.env`, no database, no clearinghouse, a free port, and `--exit` so it ends by itself.
 *
 * It asserts only what the script itself asserts — the five journeys pass — because each journey's
 * behaviour is already pinned at the right level by the API suites under apps/web/__tests__.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("the five-journey laptop demo runs end to end and exits 0", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DATABASE_ADMIN_URL;
  const r = spawnSync(process.execPath, ["scripts/demo-journey.ts", "--exit", "--port", "0"], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5\/5 journeys passed\./);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
});

test("the demo refuses to start on anything but the mock clearinghouse", () => {
  // The pin happens inside the script, before any module reads config, so even an environment that
  // names a vendor ends up on the mock. This is the property that makes the demo safe to run.
  const r = spawnSync(process.execPath, ["scripts/demo-journey.ts", "--exit", "--port", "0"], {
    encoding: "utf8",
    env: { ...process.env, EDI_ADAPTER: "stedi", DATABASE_URL: "postgres://must-not-be-used.invalid/x" },
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5\/5 journeys passed\./);
});
