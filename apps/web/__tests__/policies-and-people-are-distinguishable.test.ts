/**
 * A screen that shows two different counts of the same money says which is which.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * The Patients screen shows a worklist whose count badge is the number of ROWS, and — once A/R aging
 * is open — a tile labelled "Accounts" whose value is `summary.accountsWithBalance`. On live staging
 * those read 11 and 9.
 *
 * Both are right. Eleven people owe money, spread across nine policies, because two policies are
 * family plans:
 *
 *   FAM-STG001   Ada Stagetest $507.51   Kit Stagetest $507.51
 *   DEMO0106     Nils Demo     $482.51   Nora Demo     $482.51
 *
 * Nothing on the screen said they count different things. An owner reading 11 in the rail and 9 in
 * the tile has no way to tell which one is wrong, and neither is — which is worse than a plain error,
 * because there is nothing to find.
 *
 * The product already draws this distinction elsewhere: `renderStatement` documents that "an account
 * keyed by member ID is a POLICY. On a family plan one policy covers several people", and splits the
 * statement per person. The tile was the one place that used the word without the distinction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/** The A/R aging panel — where the Accounts tile lives. */
function agingPanel(): string {
  const start = CLIENT.indexOf("function showAging(");
  assert.ok(start > -1, "showAging is the A/R aging panel");
  const end = CLIENT.indexOf("\nasync function openPatient(", start);
  assert.ok(end > start, "panel end");
  return CLIENT.slice(start, end);
}

test("the Accounts tile discloses that people and policies differ", () => {
  const panel = agingPanel();
  const tile = /<div class="sig__k">Accounts<\/div>([\s\S]*?)<\/div>\s*<\/div>/.exec(panel)?.[0];
  assert.ok(tile, "the Accounts tile must still exist");

  assert.match(
    tile,
    /items\.length\s*>\s*summary\.accountsWithBalance/,
    "the tile must compare the row count against the policy count — those are the two numbers a " +
      "reader sees side by side"
  );
  assert.match(tile, /people/, "and must name what the extra rows are: people, not accounts");
});

test("the disclosure only appears when there is something to disclose", () => {
  /**
   * A practice with no family plans has nine rows and nine accounts. Telling it "across 9 people"
   * would be noise on every screen for the sake of the rare one.
   */
  const panel = agingPanel();
  const tile = /<div class="sig__k">Accounts<\/div>([\s\S]*?)<\/div>\s*<\/div>/.exec(panel)?.[0] ?? "";

  /*
   * The rule is that the people/policy disclosure is CONDITIONAL — a practice with no family plans
   * has nine rows and nine accounts, and telling it "across 9 people" every time would be noise on
   * every screen for the sake of the rare one. What the alternate branch says is a copy decision
   * (it is no longer the empty string, because every other note in this row is populated and a
   * blank one leaves the row ragged); what matters is that it does NOT make the disclosure.
   */
  const ternary = /\?([\s\S]*?):([\s\S]*?)\}/.exec(tile);
  assert.ok(ternary, "the note must be a conditional, not an unconditional claim");
  assert.match(ternary[1]!, /people/, "the true branch is where the people count is disclosed");
  assert.doesNotMatch(
    ternary[2]!,
    /people/,
    "the false branch must not claim a people count — that is the case where there is nothing to disclose"
  );
});

test("the tile still shows the policy count as its value", () => {
  /* The fix is a disclosure, not a change of measure: the number itself must not quietly become 11. */
  const panel = agingPanel();
  assert.match(
    panel,
    /<div class="sig__v">\$\{summary\.accountsWithBalance\}<\/div>/,
    "the tile's value stays `accountsWithBalance` — the qualifier explains it, it does not replace it"
  );
});
