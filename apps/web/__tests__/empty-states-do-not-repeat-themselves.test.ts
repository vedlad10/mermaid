/**
 * An empty screen says its piece once.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Rendered at 393px, an empty Recover screen said the same thing three times: the hint under the
 * title ("Denials appear here once a payer withholds money for a reason worth pursuing"), the
 * worklist's own empty row, and the stage beside it — and the last two were the same sentence apart
 * from two words:
 *
 *   worklist  "Nothing to pursue WITH A PAYER. Every shortfall so far is accounted for — by
 *              contract, by the patient's share, or by another plan that has yet to rule."
 *   stage     "Nothing to pursue. Every shortfall so far is accounted for — by contract, by the
 *              patient's share, or by another plan that has yet to rule."
 *
 * At desktop widths the two sit side by side and the repetition is merely untidy. Where they stack
 * it reads as a page that has lost its place.
 *
 * Half of it was self-inflicted: the stage copy was written to replace "Select a denial from the
 * worklist", which used to contradict an empty list. Fixing the contradiction introduced the echo.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 * The worklist's empty row states the absence; the stage explains it. Every other worklist in this
 * file already followed that — "No verifications yet.", "No claims yet. Verify a patient first." —
 * and Recover was the one that did not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/** The raw body of every `<li class="empty">…</li>` the client can render into a worklist. */
function worklistEmptyRows(): string[] {
  return [...CLIENT.matchAll(/<li class="empty">([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
}

const readable = (html: string) =>
  html
    .replace(/\$\{[\s\S]*?\}/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What the row ASSERTS, with any `empty__hint` removed.
 *
 * Three of these rows legitimately carry a hint after the statement — a failed load offers "Try
 * again", and a search that matches nothing says how to search differently. That is a different
 * component from a list that is simply empty, and the hint is not the thing being measured. What
 * must stay short is the sentence that states the absence.
 */
function worklistStatements(): string[] {
  return worklistEmptyRows()
    .map((html) => readable(html.replace(/<span class="empty__hint">[\s\S]*?<\/span>/g, " ")))
    .filter(Boolean);
}

test("a worklist's empty row is one short line", () => {
  for (const message of worklistStatements()) {
    assert.ok(
      message.length <= 90,
      `an empty worklist row should state the absence, not explain it — the stage does that:\n  "${message}"`
    );
  }
});

test("no worklist empty row repeats the stage's explanation", () => {
  /**
   * The stage's copy lives in `stageEmpty` call sites. A worklist row that opens with the same words
   * is the echo this test exists to stop, so the comparison is on the opening clause rather than on
   * the whole string — "Nothing to pursue with a payer" and "Nothing to pursue" are the same
   * sentence for a reader.
   */
  const stageCopy = [...CLIENT.matchAll(/stageEmpty\(\s*"[^"]*",\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(stageCopy.length > 0, "stageEmpty must still be how the stage says a screen is empty");

  const opener = (s: string) => s.split(/[.—]/)[0]!.trim().toLowerCase();
  const stageOpeners = new Set(stageCopy.map(opener));

  for (const message of worklistEmptyRows().map(readable).filter(Boolean)) {
    const first = opener(message);
    for (const stage of stageOpeners) {
      const overlaps = first.startsWith(stage) || stage.startsWith(first);
      assert.ok(
        !overlaps || first.length < 12,
        `the worklist and the stage open with the same sentence:\n  worklist "${message}"\n  stage    "${stage}"`
      );
    }
  }
});

test("the stage still carries the explanation", () => {
  /**
   * The other half of the rule. Shortening the worklist row would be a regression if the reasoning
   * disappeared with it — a person who sees an empty Recover screen should still be told WHY there
   * is nothing to chase.
   */
  const stageCopy = [...CLIENT.matchAll(/stageEmpty\(\s*"[^"]*",\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(
    stageCopy.some((c) => c.length > 60),
    "at least one stage empty state must actually explain itself, not just announce emptiness"
  );
});
