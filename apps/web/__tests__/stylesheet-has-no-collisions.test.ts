/**
 * One class name means one thing, and one rule declares it.
 *
 * ── THE TWO COLLISIONS THAT PROMPTED THIS ──────────────────────────────────────────────────────
 * Building the Today board introduced both kinds in a single afternoon, and neither was visible in
 * a diff — each rule reads correctly on its own.
 *
 *   1. `.pos` already existed, meaning "positive money, render it green" (its twin is `.neg`). The
 *      board's money-position grid reused the name for a container. Every figure on the lead band
 *      then inherited green — including the one headed "At risk". A colour that means "this is
 *      fine" was applied to money that is not.
 *
 *   2. `.qrow__act` was declared twice: once as a one-line ellipsis with `white-space: nowrap`, and
 *      again forty lines later as a two-line `-webkit-line-clamp`. `nowrap` wins, so the clamp was
 *      dead CSS — the queue kept truncating a forty-word recommendation to "Review and release —
 *      Claim MRM-BDEDD701FE6B was FORWARDED by Cig…", which is all context and no instruction.
 *
 * Both belong to the failure mode this codebase is otherwise careful about: something that LOOKS
 * applied and silently is not. It is the same shape as the CSP dropping inline styles, and it wants
 * the same kind of guard.
 *
 * ── WHAT IS AND IS NOT A COLLISION ─────────────────────────────────────────────────────────────
 * A selector redeclared inside `@media` is a responsive override and entirely intended — the sheet
 * is full of them and they are why the board collapses cleanly on a phone. A selector declared
 * twice at the SAME cascade level is the accident, because which half wins depends on source order
 * that nobody is thinking about while editing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");
const CLIENT = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/**
 * Strip comments, then remove every `@media`/`@supports` block wholesale so only top-level rules
 * remain. Brace-counted rather than regexed, because these blocks nest.
 */
function topLevel(css: string): string {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  for (let i = 0; i < noComments.length; ) {
    const at = noComments.indexOf("@", i);
    if (at === -1) {
      out += noComments.slice(i);
      break;
    }
    const head = noComments.slice(at, noComments.indexOf("{", at) + 1);
    if (!/^@(media|supports|container)\b/.test(head)) {
      out += noComments.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    out += noComments.slice(i, at);
    let depth = 0;
    let j = noComments.indexOf("{", at);
    for (; j < noComments.length; j++) {
      if (noComments[j] === "{") depth++;
      else if (noComments[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/** Every selector declared at top level, in source order. */
function selectors(css: string): string[] {
  const found: string[] = [];
  for (const m of css.matchAll(/(?:^|\})\s*([^{}@][^{}]*?)\s*\{/g)) {
    for (const part of m[1]!.split(",")) {
      const s = part.trim().replace(/\s+/g, " ");
      /** Keyframe stops (`from`, `to`, `50%`) are not selectors. */
      if (s && !/^(from|to|\d+%)$/.test(s)) found.push(s);
    }
  }
  return found;
}

test("a selector is not written as its own rule twice", () => {
  /**
   * Declaring a selector twice is not itself the bug. This sheet deliberately groups a shared
   * property across many selectors — "all of these labels are uppercase, small and grey" — and then
   * specialises individual ones below, which is how `.ai-evidence__label` takes the AI accent. That
   * composes, it reads well, and forbidding it would make the sheet worse.
   *
   * The bug is a selector given its OWN rule twice, which is what `.qrow__act` and `.gcard__fig`
   * both were: two standalone blocks, tens of lines apart, each looking complete, with the winner
   * decided by source order nobody has in mind while editing. There is no reason to write that on
   * purpose — a second thought about one selector belongs in the rule that already exists.
   */
  const standalone = new Map<string, number>();
  /**
   * No leading `\}` anchor. An earlier version had one, and because `matchAll` does not overlap,
   * each match consumed the brace the NEXT rule needed — so it silently checked every other rule
   * and the mutation that reintroduced the original defect passed. The selector part cannot contain
   * a brace anyway, which is all the anchoring this needs.
   */
  for (const m of topLevel(CSS).matchAll(/([^{}@][^{}]*?)\s*\{[^}]*\}/g)) {
    const sel = m[1]!.trim().replace(/\s+/g, " ");
    /** `@font-face` is not a selector — several of them for one family is how a family is built. */
    if (!sel || sel.startsWith("@") || sel.includes(",") || /^(from|to|\d+%)$/.test(sel)) continue;
    standalone.set(sel, (standalone.get(sel) ?? 0) + 1);
  }
  const dupes = [...standalone].filter(([, n]) => n > 1).map(([sel, n]) => `${sel} (${n} rules)`);
  assert.deepEqual(
    dupes.sort(),
    [],
    `each of these has more than one rule of its own; merge them: ${dupes.join("; ")}`
  );
});

test("no class is both a container and a colour word", () => {
  /**
   * The `.pos` defect, generalised. A handful of classes in this sheet exist ONLY to colour text —
   * `.pos` green for money recovered, `.neg` red — and reusing one as a structural container hands
   * its colour to everything inside. The two uses are incompatible and the collision is silent, so
   * the names are reserved.
   *
   * Asserted against the CLIENT rather than the sheet, because the sheet cannot tell how a class is
   * being used; the markup can.
   */
  const RESERVED = ["pos", "neg"];
  for (const name of RESERVED) {
    assert.match(
      CSS,
      new RegExp(`\\.${name}\\s*\\{[^}]*color:`),
      `.${name} is reserved as a colour word; this test is only meaningful while it still is one`
    );
    /** Used on a leaf that carries a value — never on a wrapper with children. */
    for (const m of CLIENT.matchAll(new RegExp(`class="${name}"[^>]*>`, "g"))) {
      const after = CLIENT.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      assert.ok(
        !/^\s*(\$\{[\s\S]{0,40})?<div/.test(after),
        `.${name} is a colour, not a container — it is wrapping a <div> and will paint everything ` +
          `inside it. Give the container its own class.`
      );
    }
  }
});

test("a line clamp is never declared beside a nowrap that would defeat it", () => {
  /**
   * The `.qrow__act` defect, generalised. `-webkit-line-clamp` needs `display: -webkit-box` and it
   * needs the text to be allowed to wrap; `white-space: nowrap` in the same rule silently reduces
   * the clamp to one line, and the declaration reads as though it works.
   */
  for (const m of topLevel(CSS).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = m[2]!;
    if (!body.includes("line-clamp")) continue;
    assert.ok(
      !/white-space:\s*nowrap/.test(body),
      `${m[1]!.trim()} sets a line clamp beside white-space: nowrap — nowrap wins and the clamp is dead`
    );
    assert.match(
      body,
      /display:\s*-webkit-box/,
      `${m[1]!.trim()} sets a line clamp without display: -webkit-box, which does nothing`
    );
  }
});

test("every class the client renders has a rule in the stylesheet", () => {
  /**
   * The other half of the same failure: markup that carries a class nobody styled looks deliberate
   * in the source and renders as unstyled text. Only class names the client writes as literal
   * `class="…"` attributes are checked — interpolated ones are checked by the eye.
   */
  const used = new Set<string>();
  for (const m of CLIENT.matchAll(/class="([^"$]*)"/g)) {
    for (const c of m[1]!.split(/\s+/)) if (c) used.add(c);
  }
  const declared = new Set(
    [...CSS.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!)
  );
  /** Utility and state names that live in the shell's HTML rather than in a rule of their own. */
  const shell = new Set(["hidden", "active", "open"]);
  const orphans = [...used].filter((c) => !declared.has(c) && !shell.has(c)).sort();
  assert.deepEqual(orphans, [], `the client renders classes no rule styles: ${orphans.join(", ")}`);
});

test("every custom property referenced without a fallback is actually defined", () => {
  /**
   * ── HOW A BLACK BAND GOT ONTO THE DASHBOARD ───────────────────────────────────────────────────
   * The money flow bar coloured its segments through `fill: var(--t-400)`. The teal ramp runs 50,
   * 100, 200, 500, 600, 700, 800, 900 — there is no 400, and there never was. An SVG `fill` whose
   * custom property does not resolve falls back to BLACK, so the bar rendered a black band beside
   * its teal ones and looked entirely deliberate. The daily-collections chart had the same defect
   * with `--t-300`.
   *
   * Neither was visible in a diff, in the type checker, or in any test. It took looking at the
   * rendered page in a browser — and even then it reads as a design choice until you go looking for
   * the token and find nothing.
   *
   * `var(--x, fallback)` is exempt: a fallback is a deliberate answer to exactly this question.
   */
  const nc = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...nc.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));

  const dangling: string[] = [];
  for (const m of nc.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    const [, name, next] = m;
    if (next === ",") continue; // has a fallback
    if (!defined.has(name!)) dangling.push(name!);
  }

  assert.deepEqual(
    [...new Set(dangling)].sort(),
    [],
    "these resolve to nothing, and a colour that resolves to nothing renders black"
  );
});

test("the money flow bar spends at most two hues", () => {
  /**
   * The brief for this product is a restrained palette, and a stacked bar is where that discipline
   * is easiest to lose — every segment wants its own colour. The five states are payer money at
   * three depths of one hue, one amber for the state a person can act on today, and grey for the
   * patient's half.
   *
   * The coordination segment was `--ai`, the violet that means "AI wrote this" everywhere else in
   * the product. It has nothing to do with a second payer, and it put a third hue on the one chart
   * a practice reads first.
   */
  const segments = [...CSS.matchAll(/\.flow__seg--\w+\s*\{\s*fill:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]!);
  assert.equal(segments.length, 5, "five states, five segments");
  assert.ok(!segments.includes("--ai"), "the AI accent must not colour a coordination-of-benefits segment");

  const hues = new Set(segments.map((t) => (t.startsWith("--t-") ? "teal" : t.startsWith("--n-") ? "neutral" : t)));
  assert.ok(hues.size <= 3, `at most two hues and a neutral; found ${[...hues].join(", ")}`);
});

test("the legend swatch and the bar segment are the same colour", () => {
  /**
   * They are two renderings of one fact and they sat in different rules, which is the arrangement
   * that drifts — and a legend that disagrees with its chart is worse than no legend.
   */
  const seg = Object.fromEntries(
    [...CSS.matchAll(/\.flow__seg--(\w+)\s*\{\s*fill:\s*var\((--[\w-]+)\)/g)].map((m) => [m[1]!, m[2]!])
  );
  const sw = Object.fromEntries(
    [...CSS.matchAll(/\.fl__sw--(\w+)\s*\{\s*background:\s*var\((--[\w-]+)\)/g)].map((m) => [m[1]!, m[2]!])
  );
  assert.deepEqual(sw, seg, "every legend swatch must use its segment's token");
});
