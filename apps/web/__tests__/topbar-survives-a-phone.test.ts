/**
 * The product's own name is not the thing that gives way when the header runs out of room.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Rendered at a true 393px viewport, "Mermaid" painted directly on top of the signed-in identity —
 * the wordmark and "Probe data owner · owner" occupying the same pixels, both unreadable.
 *
 * `.topbar` is a `space-between` flex row of `.brand` and `.topbar__right`. `.brand` carries
 * `min-width: 0`, so it may shrink to nothing. `.whoami`, inside the right-hand side, is
 * `white-space: nowrap` and so refuses to shrink at all. Flex resolved that by taking every pixel
 * from the brand — measured at EIGHT pixels wide — and its text simply overflowed the box it no
 * longer fitted inside.
 *
 * ── WHY NOTHING CAUGHT IT ────────────────────────────────────────────────────────────────────────
 * The bounding boxes did not intersect. `.brand` was 8px wide ending at x=20, and the identity began
 * at x=20 — so any check comparing rectangles reports no collision, correctly, while the rendered
 * text lies across both. It was visible only in a screenshot.
 *
 * This test cannot see pixels either. What it can do is pin the two rules that were added to fix it,
 * so a later edit that removes them has to argue with a test that says why they exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");

/** The block that governs a phone-width header. */
function mobileBlock(): string {
  const start = CSS.indexOf("@media (max-width: 640px)");
  assert.ok(start > -1, "the 640px block is where the phone header is decided");
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("unterminated media block");
}

test("the brand does not shrink at phone width", () => {
  const block = mobileBlock();
  assert.match(
    block,
    /\.brand\s*\{[^}]*flex:\s*none/,
    "without `flex: none` the brand absorbs every pixel the nowrap identity refuses to give up, " +
      "and its text overflows an 8px box across the rest of the header"
  );
});

test("the identity yields instead of the wordmark", () => {
  const block = mobileBlock();
  assert.match(
    block,
    /\.whoami\s*\{[^}]*display:\s*none/,
    "at 393px the header cannot hold mark, name, identity, Sign out AND New patient — the identity " +
      "is the least useful of them, because a person knows who they are and the controls are why " +
      "they came"
  );
});

test("the identity comes back when there is room for it", () => {
  /**
   * The hiding is scoped to the phone block and nowhere else. A rule that hid it globally would
   * remove the only place the signed-in user and their role are shown.
   */
  const outside = CSS.replace(mobileBlock(), "");
  assert.doesNotMatch(
    outside,
    /\.whoami\s*\{[^}]*display:\s*none/,
    "`.whoami` must only be hidden inside the phone block"
  );
  assert.match(outside, /\.whoami\s*\{/, "and must still be styled for every width above it");
});

test("nothing else in the header may shrink to nothing", () => {
  /**
   * `min-width: 0` on a flex child is what permits a crush like this. It is legitimate where the
   * child truncates — `.qitem__name` does — but the brand has no truncation, so the two must not
   * both be true of it again.
   */
  const brandRule = /\.brand\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  const shrinkable = /min-width:\s*0/.test(brandRule);
  const truncates = /text-overflow:\s*ellipsis/.test(brandRule);
  assert.ok(
    !shrinkable || truncates,
    "`.brand` may only carry `min-width: 0` if it also truncates; otherwise its text overflows " +
      "the box instead of being clipped by it"
  );
});
