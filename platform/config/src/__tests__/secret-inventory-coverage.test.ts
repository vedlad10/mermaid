/**
 * The secret inventory says what is true about this codebase — in BOTH directions (NEW-09).
 *
 * ── WHY THIS TEST EXISTS ─────────────────────────────────────────────────────────────────────────
 * `secrets.ts` exists to answer one question for a Security Risk Assessment: what secrets does this
 * system hold? It answered wrongly in both directions at once, and had done for two milestones:
 *
 *   • It listed `EDI_API_KEY` as "unused until a vendor is selected (M15)". A vendor WAS selected.
 *     Nothing reads that variable. It was fiction.
 *   • It omitted `STEDI_API_KEY` — the credential eligibility requests and claims go out under, so
 *     the one credential under which PHI actually leaves this system.
 *   • It described `LLM_API_KEY` as "unused — nothing calls an LLM today", while `AnthropicProvider`
 *     had been reading it on every card-vision call since S2.
 *
 * None of that was catchable by reading `secrets.ts`, because a hand-maintained list is consistent
 * with itself by construction. It is catchable only by comparing the list to the code, which is
 * what this does — and it is why the fix is a test rather than a corrected list: a corrected list
 * drifts again the next time a credential is added.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SECRETS, type SecretName } from "../secrets.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Where production code lives. Tests are excluded: a test may name a secret it does not consume. */
const ROOTS = ["apps", "modules", "packages", "platform", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".git", "migrations"]);

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (![".ts", ".mts", ".mjs", ".js"].includes(extname(entry))) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.mjs")) continue;
      out.push({ path: full.slice(REPO.length + 1).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  };
  for (const root of ROOTS) walk(join(REPO, root));
  return out;
}

/** Source with comments stripped — a secret NAMED in prose is not a secret READ. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

test("every secret in the inventory is actually read by something", () => {
  const files = sources().filter((f) => !f.path.endsWith("platform/config/src/secrets.ts"));
  const unread: string[] = [];

  for (const name of Object.keys(KNOWN_SECRETS) as SecretName[]) {
    const read = files.some((f) => {
      const c = code(f.text);
      // Through the seam, or — for the plain-JavaScript operational scripts that cannot import it —
      // directly off the environment. Both count as "something reads this".
      return (
        c.includes(`getSecret("${name}")`) ||
        c.includes(`requireSecret("${name}")`) ||
        // `secret("X")` is env.ts's one-line wrapper around getSecret — a read through the seam,
        // and the shape every credential in `getConfig` takes.
        c.includes(`secret("${name}")`) ||
        c.includes(`process.env.${name}`) ||
        c.includes(`process.env["${name}"]`) ||
        c.includes(`env.${name}`)
      );
    });
    if (!read) unread.push(name);
  }

  assert.deepEqual(
    unread,
    [],
    "these are listed as secrets this system holds, and nothing reads them. A Security Risk " +
      "Assessment built on this list would enumerate a credential that does not exist — which is " +
      "exactly what `EDI_API_KEY` was."
  );
});

/**
 * Environment variables whose NAME looks like a credential. Any read of one of these has to be
 * either in the inventory or on the list below, deliberately.
 */
const SECRET_SHAPED = /\b(?:process\.env\.|env\.)([A-Z][A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|_URL))\b/g;

/**
 * Secret-SHAPED names that are not secrets, each with the reason.
 *
 * An allowlist rather than a cleverer pattern: "is this a credential?" is a judgement, and the right
 * place to record a judgement is next to it, where the next person can disagree with it.
 */
const NOT_SECRETS: Record<string, string> = {
  STEDI_BASE_URL: "A published API hostname. Public, and wrong to rotate.",
  STEDI_CORE_BASE_URL: "The same, for Stedi's EDI-platform host.",
  ANTHROPIC_BASE_URL: "A published API hostname.",
  LLM_BASE_URL: "A published API hostname.",
  STAGING_URL: "The staging application's public address. Published, and wrong to rotate.",
};

/**
 * Credentials a PERSON supplies at a command line, which the running deployment must never hold.
 *
 * ── WHY THIS IS A THIRD CATEGORY AND NOT ONE OF THE OTHER TWO ──────────────────────────────────
 * `KNOWN_SECRETS` answers "what does this DEPLOYMENT need?" — it is what the readiness endpoint
 * reports, so anything listed there and absent reads as something missing that ought to be present.
 * A Render deploy key is the opposite: the server must never have it, and reporting it as "not
 * configured" on every readiness check would be a permanent false alarm.
 *
 * `NOT_SECRETS` is equally wrong, because these ARE secrets. A Render API key grants control of the
 * deployment; calling it "not a secret" to silence a test would put a falsehood in the one file a
 * Security Risk Assessment reads.
 *
 * So: a real credential, genuinely out of the deployment's scope, recorded as such. It is held by
 * whoever deploys, it lives in their shell or a secret store, and `scripts/` is the only place in
 * this repository allowed to read one.
 */
const OPERATOR_CREDENTIALS: Record<string, string> = {
  RENDER_API_KEY: "Triggers a staging deploy from an operator's shell. scripts/deploy-staging.mjs only.",
};

test("nothing reads a secret-shaped variable that the inventory has never heard of", () => {
  const known = new Set<string>(Object.keys(KNOWN_SECRETS));
  const strays = new Map<string, string[]>();

  const misplaced = new Map<string, string[]>();

  for (const file of sources()) {
    if (file.path.endsWith("platform/config/src/secrets.ts")) continue;
    for (const match of code(file.text).matchAll(SECRET_SHAPED)) {
      const name = match[1]!;
      if (known.has(name) || name in NOT_SECRETS) continue;
      if (name in OPERATOR_CREDENTIALS) {
        /*
         * Allowed, but only in operator tooling. An operator credential read by the SERVER would be
         * a credential the deployment holds and the inventory does not know about — which is the
         * exact hole this test exists to close, wearing an exemption.
         */
        if (!file.path.startsWith("scripts/")) misplaced.set(name, [...(misplaced.get(name) ?? []), file.path]);
        continue;
      }
      strays.set(name, [...(strays.get(name) ?? []), file.path]);
    }
  }

  assert.deepEqual(
    Object.fromEntries(strays),
    {},
    "a credential this system reads is missing from KNOWN_SECRETS. Add it there (so the inventory " +
      "stays a true answer and the readiness endpoint reports it); or, if it is a credential an " +
      "OPERATOR supplies and the deployment must never hold, add it to OPERATOR_CREDENTIALS; or — " +
      "if it is not a credential at all — add it to NOT_SECRETS with the reason."
  );

  assert.deepEqual(
    Object.fromEntries(misplaced),
    {},
    "an operator credential is read outside scripts/. If the running application needs it, it is " +
      "not an operator credential — move it to KNOWN_SECRETS so the inventory and the readiness " +
      "endpoint report it."
  );
});

test("the inventory describes what each secret is FOR, not merely that it exists", () => {
  /**
   * `LLM_API_KEY: "unused — nothing calls an LLM today"` passed every mechanical check for two
   * milestones while being false. A description cannot be verified automatically, but the shapes
   * that are always wrong can be refused: an empty one, and one that claims to be unused (which is
   * a claim about the code, and the code is what the test above reads).
   */
  for (const [name, purpose] of Object.entries(KNOWN_SECRETS)) {
    assert.ok(purpose.trim().length > 20, `${name} needs a real description`);
    assert.doesNotMatch(
      purpose,
      /\bunused\b/i,
      `${name} is described as unused, but the coverage test above proves something reads it. ` +
        `A description that contradicts the code is how EDI_API_KEY survived.`
    );
  }
});
