/**
 * Every route to a language model passes the PHI gate.
 *
 * ── WHY A SOURCE-LEVEL GUARD AND NOT A UNIT TEST ───────────────────────────────────────────────
 * `LlmRouter.draft` and `LlmRouter.extract` both funnel through `#run`, which calls
 * `checkPhiPolicy` — that much is covered by `router.test.ts` and holds. The gap those tests cannot
 * see is a caller that never reaches the router at all.
 *
 * `AnthropicProvider` is exported from the package's public surface, and a provider's `complete()`
 * talks to the vendor directly. Nothing constructs one outside the router today, which is exactly
 * why this is worth pinning: the check is cheap now and the disclosure it prevents is not
 * recoverable. An unreported disclosure of protected health information to a third party is a
 * breach whether or not anyone notices, and unlike every other defect in this repository it cannot
 * be fixed after the fact — the data has left.
 *
 * `phi.ts` states the same asymmetry as its own reason for defaulting `containsPhi` to true. This
 * applies it one level up: the policy is only worth what its narrowest bypass allows.
 *
 * ── WHAT WOULD MAKE THIS FAIL LEGITIMATELY ─────────────────────────────────────────────────────
 * Adding a second gated entry point to the router — fine, add it to ENTRY_POINTS below. Constructing
 * a provider inside a module or app — not fine, and the point of the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/** Every public method on the router that can reach a provider. */
const ENTRY_POINTS = ["draft", "extract"];

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "__tests__") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test("every router entry point that reaches a provider runs the PHI check", () => {
  const router = readFileSync(join(REPO, "platform", "llm", "src", "router.ts"), "utf8");

  for (const method of ENTRY_POINTS) {
    assert.match(
      router,
      new RegExp(`async ${method}\\b`),
      `${method} is listed as an entry point but no longer exists — update ENTRY_POINTS deliberately`
    );
  }

  /**
   * Both entry points hand the request to `#run`, and `#run` is the only place the policy is
   * consulted. If a third entry point is ever added that talks to a provider without going through
   * it, the count below stops matching and someone has to look.
   */
  const runCalls = (router.match(/this\.#run\(/g) ?? []).length;
  assert.equal(
    runCalls,
    ENTRY_POINTS.length,
    "an entry point reaches a provider without going through #run, where checkPhiPolicy is applied"
  );
  assert.equal(
    (router.match(/checkPhiPolicy\(/g) ?? []).length,
    1,
    "the policy is applied in exactly one place — a second copy is a second thing to forget"
  );
});

test("the refusal happens before anything is sent to a vendor", () => {
  /**
   * Ordering is the property. A gate consulted after the request is dispatched refuses a disclosure
   * that has already happened.
   */
  const router = readFileSync(join(REPO, "platform", "llm", "src", "router.ts"), "utf8");
  const gate = router.indexOf("checkPhiPolicy(");
  const attempt = router.indexOf("#attempt(");
  assert.ok(gate > 0 && attempt > 0, "both the gate and the dispatch are present");
  assert.ok(gate < attempt, "the PHI check must be reached before the provider is called");
});

test("no module or app constructs a provider directly", () => {
  /**
   * The bypass this file exists for. A provider's `complete()` talks to the vendor with no policy
   * between it and the wire, so the only safe way to hold one is behind the router.
   */
  const offenders = [];
  for (const dir of ["modules", "apps"]) {
    for (const file of sourceFiles(join(REPO, dir))) {
      const src = readFileSync(file, "utf8");
      if (/\bnew\s+\w*Provider\s*\(/.test(src) && /@mermaid\/llm/.test(src)) {
        offenders.push(relative(REPO, file));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these construct an LLM provider outside the router, bypassing the PHI gate: ${offenders.join(", ")}`
  );
});

test("unset containsPhi still resolves to PHI at the one place that decides it", () => {
  /**
   * Restated here as source, not behaviour, because `router.test.ts` already covers the behaviour and
   * this is about the DEFAULT surviving a refactor. An `?? false` anywhere in this expression flips
   * "I didn't think about it" from the safe answer to the unrecoverable one.
   */
  const phi = readFileSync(join(REPO, "platform", "llm", "src", "phi.ts"), "utf8");
  assert.match(phi, /containsPhi !== false/, "unset must mean PHI");
  assert.doesNotMatch(phi, /containsPhi\s*\?\?\s*false/, "a nullish default to false inverts the policy");
});
