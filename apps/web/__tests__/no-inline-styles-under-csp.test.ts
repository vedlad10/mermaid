/**
 * The client may not ship styles its own CSP forbids.
 *
 * ── THE DEFECT, AND WHY IT WAS INVISIBLE ───────────────────────────────────────────────────────
 * Every response carries `style-src 'self'` with no `'unsafe-inline'`. That drops inline `style=`
 * ATTRIBUTES: the browser parses them into the DOM and then refuses to apply them. Nothing throws,
 * nothing logs, and `getAttribute("style")` still returns the value you wrote — so the markup looks
 * correct in every inspection short of reading the computed style.
 *
 * Seventeen of them had accumulated in app.js. Most were spacing, which merely looked like
 * deliberate layout. Two were worse:
 *
 *   • the verification confidence meter's threshold marker carried `left: N%` and had therefore
 *     never moved — it sat at the meter's left edge on every screen while claiming to mark the
 *     auto-verify threshold;
 *   • the money chain's first implementation sized its segments with `width: N%`, so every bar
 *     collapsed to its 2px minimum and the chart was inert while looking intentional.
 *
 * ── WHAT REPLACED THEM ─────────────────────────────────────────────────────────────────────────
 * Data-driven geometry uses SVG presentation attributes (`<rect width>`), which are not CSS and are
 * unaffected by CSP, or the `data-w` + CSSOM idiom the meters already used — assigning through
 * `element.style` is permitted, because it is not the inline-attribute path. Static spacing became
 * real classes.
 *
 * Widening the CSP would have been the other way to make these work, and a bad trade: a charting
 * convenience is not worth `'unsafe-inline'` on a product that renders payer data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
const SHELL = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

/** `style="…"` in generated markup — the form the CSP drops. */
const INLINE_STYLE = /<[^>]*\sstyle=(["'])/g;

test("no inline style attribute is emitted by the client", () => {
  const found = [...CLIENT.matchAll(INLINE_STYLE)].map((m) => {
    const at = CLIENT.slice(Math.max(0, m.index! - 90), m.index! + 90).replace(/\s+/g, " ");
    return `…${at}…`;
  });
  assert.deepEqual(
    found,
    [],
    `app.js emits ${found.length} inline style attribute(s); the CSP drops them silently:\n${found.join("\n")}`
  );
});

test("nor by the shell", () => {
  assert.deepEqual([...SHELL.matchAll(INLINE_STYLE)].map((m) => m[0]), []);
});

test("the CSP that makes this a rule is still in force", () => {
  /**
   * The test above is only meaningful while the policy actually forbids inline styles. If someone
   * adds `'unsafe-inline'`, the rule should be reconsidered deliberately rather than left as a
   * lint nobody remembers the reason for — so the policy is asserted here beside it.
   */
  const server = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
  const csp = server.match(/"style-src[^"]*"/)?.[0] ?? "";
  assert.match(csp, /style-src 'self'/, "the policy must still be self-only");
  assert.doesNotMatch(csp, /unsafe-inline/, "widening the CSP for styling would undo the reason for this test");
});

test("data-driven geometry uses SVG or the CSSOM idiom, both of which survive the policy", () => {
  /**
   * Asserted so the replacement is not quietly reverted to something that looks simpler and does
   * nothing. Both mechanisms must still be present.
   */
  assert.match(CLIENT, /<rect[^>]*width="\$\{/, "proportional bars are SVG rects");
  assert.match(CLIENT, /el\.style\.transform = `scaleX/, "meter fills use the CSSOM");
  assert.match(CLIENT, /el\.style\.left = `\$\{Number\(el\.dataset\.left\)\}%`/, "and so does the threshold marker");
});

test("no money message is delivered through a native alert", () => {
  /**
   * ── WHY THIS IS A RULE AND NOT A PREFERENCE ────────────────────────────────────────────────────
   * There were seventeen `alert()` calls in this client and several carried financial errors: a
   * payer refusing to release a remittance, a claim that would not file, a write-off missing its
   * reason.
   *
   * A native alert is the least trustworthy surface a product can put a money message on. It is
   * unstyled, so it does not look like the system that produced it. It blocks the page. It cannot be
   * re-read once dismissed, or copied into a note, or shown to a colleague. And it arrives detached
   * from the control that caused it, so a person has to reconstruct what it was about.
   *
   * On a screen whose entire job is being believable about money, that is the wrong instrument, and
   * it is the kind of thing that creeps back in one call at a time.
   */
  /** Comments stripped first — the helper that replaced these explains itself by naming them. */
  const code = CLIENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = [...code.matchAll(/(?<![\w.])alert\s*\(/g)].map((m) => {
    const at = code.slice(Math.max(0, m.index! - 70), m.index! + 70).replace(/\s+/g, " ");
    return `…${at}…`;
  });
  assert.deepEqual(calls, [], "use notify(message, tone, anchor) instead: " + calls.join(" | "));
});

test("every money-moving control is held down while its request is in flight", () => {
  /**
   * `#release-remit` posts a held payer advice and was the one money action that did not disable
   * itself mid-request. The server is safe regardless — `release()` reads `FOR UPDATE` and returns
   * early when the advice is already posted — but a button that does nothing visible for a second
   * invites a second click, and on "post $1,599.98" that doubt is the damage.
   */
  assert.match(CLIENT, /withBusy\(releaseBtn/, "the release button runs inside withBusy");
  assert.match(CLIENT, /function withBusy/, "and the helper exists");

  /** It must restore the button whatever happens, or one failed release disables the control. */
  const body = CLIENT.slice(CLIENT.indexOf("async function withBusy"));
  assert.match(body.slice(0, 600), /finally\s*\{/, "withBusy restores in a finally block");
});
