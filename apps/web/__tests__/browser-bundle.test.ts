/**
 * The browser bundle parses.
 *
 * ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────────────────────────
 * `apps/web/public/app.js` is the entire user interface — every queue, every money figure, every
 * gate a biller clicks — and until this test nothing in the repository looked at it. It is not in
 * `tsconfig.json`'s include (that covers `.ts`), the module-boundary checker walks `src` trees, and
 * `npm test`'s globs match `*.test.ts` only.
 *
 * The consequence is not theoretical. While fixing the recovery card's money labels, a stray
 * backtick inside a template literal was introduced — a syntax error that serves a blank
 * application to every user — and typecheck, 1360 unit tests, the boundary checker and the entire
 * live-database suite all reported green. It was caught by running `node --check` by hand, which is
 * not a control.
 *
 * A syntax check is the floor, not the ceiling: it cannot tell whether the page RENDERS correctly,
 * only that it can be loaded at all. That is precisely the failure it exists to stop being silent,
 * because a bundle that does not parse takes the whole product down and every other gate is blind
 * to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

test("every script served to the browser is syntactically valid", () => {
  const scripts = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(scripts.length > 0, "the public directory must contain the bundle this test guards");

  // `node --check` infers script-vs-module from the extension, and the bundle is an ES module, so
  // it is checked through a temporary `.mjs` copy rather than by guessing at flags.
  const scratch = mkdtempSync(join(tmpdir(), "mermaid-bundle-"));
  try {
    for (const script of scripts) {
      const copy = join(scratch, `${script.replace(/\.js$/, "")}.mjs`);
      copyFileSync(join(PUBLIC_DIR, script), copy);
      try {
        execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
      } catch (err) {
        const detail = err instanceof Error && "stderr" in err ? String((err as { stderr: Buffer }).stderr) : String(err);
        assert.fail(`public/${script} does not parse:\n${detail}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
