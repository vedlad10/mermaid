/**
 * A rule inside a breakpoint must actually win at that breakpoint.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The shell collapses to one column on a phone:
 *
 *     @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } }
 *
 * and it never happened, because seventy lines earlier the stylesheet says
 *
 *     body[data-stage-titled] .layout { grid-template-columns: 76px minmax(0, 1fr); }
 *
 * A media query adds NO specificity. `.layout` scores (0,1,0); `body[data-stage-titled] .layout`
 * scores (0,2,1) and wins at every width. Every one of the eight screens sets `data-stage-titled`
 * when it mounts, so at 375px the rail kept its 76px desktop column and clipped its own label to
 * "Toda" — eight of the nine screens unreachable on a phone — while the content region was squeezed
 * into the 275px left over beside it.
 *
 * ── WHY A TEST AND NOT A FIX ───────────────────────────────────────────────────────────────────
 * Nothing detected this. There was no horizontal overflow to find, because the rail scrolls inside
 * its own box: the document measured exactly 375px wide, no element exceeded the viewport, and the
 * responsive report came back clean at all four widths while one of them was unusable. It took a
 * screenshot and a person looking at it.
 *
 * That is not a repeatable check, and this is the same stylesheet where a specificity accident is
 * one careless `body[...]` prefix away at all times. The arithmetic, at least, is mechanical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");

/** (ids, classes+attributes+pseudo-classes, elements+pseudo-elements) — the CSS cascade's tuple. */
function specificity(selector: string): [number, number, number] {
  const s = selector
    .replace(/::[a-z-]+/g, " ELEMENT ")
    .replace(/:(?:not|is|where)\([^)]*\)/g, " ")
    .trim();
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (s.match(/\.[\w-]+/g) ?? []).length +
    (s.match(/\[[^\]]+\]/g) ?? []).length +
    (s.match(/:[a-z-]+(?:\([^)]*\))?/g) ?? []).length;
  const elements =
    (s.replace(/[#.][\w-]+|\[[^\]]+\]|:[a-z-]+(?:\([^)]*\))?/g, " ").match(/\b[a-z][\w-]*\b/g) ?? []).length +
    (s.match(/ELEMENT/g) ?? []).length;
  return [ids, classes, elements];
}

const beats = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

type Rule = { selector: string; props: Set<string>; inMedia: boolean; at: number; mediaId: number };

/**
 * Every rule in the sheet, flagged by whether a `max-width` query encloses it.
 *
 * Brace-counting rather than a parser: the sheet has no nested rules beyond one level of at-rule,
 * and a dependency to read a file this test already reads as text would be the larger cost.
 */
function rules(): Rule[] {
  const out: Rule[] = [];
  let depth = 0;
  let mediaDepth = -1;
  let mediaId = -1;
  let i = 0;

  while (i < CSS.length) {
    const open = CSS.indexOf("{", i);
    if (open === -1) break;
    const close = CSS.indexOf("}", i);

    if (close !== -1 && close < open) {
      depth--;
      if (depth <= mediaDepth) { mediaDepth = -1; mediaId = -1; }
      i = close + 1;
      continue;
    }

    const head = CSS.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (head.startsWith("@")) {
      if (/^@media[^{]*max-width/.test(head) && mediaDepth === -1) { mediaDepth = depth; mediaId = i; }
      depth++;
      i = open + 1;
      continue;
    }

    const end = CSS.indexOf("}", open);
    const body = CSS.slice(open + 1, end === -1 ? undefined : end);
    const props = new Set(
      [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[1]!).filter((p) => !p.startsWith("--"))
    );
    for (const selector of head.split(",").map((x) => x.trim()).filter(Boolean)) {
      out.push({ selector, props, inMedia: mediaDepth !== -1, at: i, mediaId });
    }
    i = (end === -1 ? open : end) + 1;
  }
  return out;
}

const parts = (s: string): string[] => s.split(/[\s>+~]+/).filter(Boolean);
const key = (s: string): string => parts(s).pop() ?? s;

/**
 * The one shape worth failing on: SAME element, defeated by ANCESTOR context.
 *
 * The first version of this test flagged any more-specific rule and produced five false positives
 * out of six findings — `.rail__label` against `.address-fix label` (substring, not the same
 * element), `.src` against `.src::before` (a different box entirely), and variants like
 * `.panel.stage-empty` and `.sp__m:last-child`, which are more specific ON PURPOSE and still leave
 * the breakpoint governing every element that is not that variant.
 *
 * A variant is visible to whoever writes it. What is not visible is a MODE — `body[data-mode] .x`
 * — because the qualifier lives on an ancestor the author of the breakpoint rule never looks at,
 * and a mode that happens to be always-on defeats the breakpoint everywhere rather than for a
 * subset. That is the defect this test exists for, and narrowing to it is what makes its output
 * worth reading.
 */
function defeatedByAncestorContext(base: string, media: string): boolean {
  if (key(base).includes("::") || key(media).includes("::")) return false;
  if (key(base) !== key(media)) return false;
  return parts(base).length > parts(media).length;
}

test("no rule inside a max-width breakpoint is outranked by one outside it", () => {
  const all = rules();
  const base = all.filter((r) => !r.inMedia);

  /*
   * Grouped by BREAKPOINT and key compound, not by rule.
   *
   * The fix for a defeated selector is usually a second rule beside it carrying the winning prefix,
   * not another entry in the same comma list — so grouping per comma list reported a breakpoint as
   * broken while the rule that repaired it sat two lines below. What matters is whether anything
   * inside this @media block can stand up to the outside rule. Per block rather than across the
   * whole sheet, because a fix at 980px is still no help at 1280px.
   */
  const byBreakpoint = new Map<string, Rule[]>();
  for (const r of all.filter((x) => x.inMedia)) {
    const k = r.mediaId + "|" + key(r.selector);
    byBreakpoint.set(k, [...(byBreakpoint.get(k) ?? []), r]);
  }

  const defeated: string[] = [];

  for (const group of byBreakpoint.values()) {
    for (const b of base) {
      const bSpec = specificity(b.selector);
      const losers = group.filter(
        (r) => defeatedByAncestorContext(b.selector, r.selector) && beats(bSpec, specificity(r.selector))
      );
      if (!losers.length) continue;
      /* Already handled if anything at this breakpoint can stand up to it. */
      if (group.some((r) => !beats(bSpec, specificity(r.selector)))) continue;

      const shared = [...losers[0]!.props].filter((p) => b.props.has(p));
      if (!shared.length) continue;
      defeated.push(
        `"${group.map((r) => r.selector).join(", ")}" inside a breakpoint sets ${shared.join(", ")}, ` +
          `but "${b.selector}" outside one sets the same and is more specific — the breakpoint has no effect`
      );
    }
  }

  assert.deepEqual(
    [...new Set(defeated)],
    [],
    "a responsive rule that cannot win. Raise the breakpoint rule's specificity to match the one " +
      "that beats it — repeating the same prefix in the media query is the honest fix, because it " +
      "keeps both rules describing the same element. Do NOT reach for !important: the next person " +
      "reading the desktop rule would have no way to see that a breakpoint disagrees with it."
  );
});

test("the specificity arithmetic is right", () => {
  /* A wrong calculator would make the test above pass over everything, which is the failure mode
     that matters here — it would report a clean sheet forever. */
  assert.deepEqual(specificity(".layout"), [0, 1, 0]);
  assert.deepEqual(specificity("body[data-stage-titled] .layout"), [0, 2, 1]);
  assert.deepEqual(specificity("#id .a b"), [1, 1, 1]);
  assert.deepEqual(specificity(".a:hover"), [0, 2, 0]);
  assert.equal(beats([0, 2, 1], [0, 1, 0]), true);
  assert.equal(beats([0, 1, 0], [0, 2, 1]), false);
  assert.equal(beats([0, 1, 0], [0, 1, 0]), false, "a tie is not a defeat — source order decides");
  assert.equal(defeatedByAncestorContext("body[data-stage-titled] .layout", ".layout"), true);
  assert.equal(defeatedByAncestorContext(".rail", ".totals"), false, "different elements");
  assert.equal(defeatedByAncestorContext(".panel.stage-empty", ".panel"), false, "a variant, not a mode");
  assert.equal(defeatedByAncestorContext(".src::before", ".src"), false, "a pseudo-element is another box");
  assert.equal(defeatedByAncestorContext(".address-fix label", ".rail__label"), false, "substring, not sameness");
});
