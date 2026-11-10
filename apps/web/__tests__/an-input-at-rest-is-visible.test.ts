/**
 * A field you have not clicked yet must still look like a field.
 *
 * ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * `.input` shipped as `border: 1px solid transparent; background: var(--n-50)`, with a comment
 * explaining that a filled field reads better than a hollow box and the border appears on focus.
 * That reasoning was correct on the dark ground, where `--n-50` resolved to a plane LIGHTER than the
 * card behind it: the fill was the edge.
 *
 * The light inversion remapped `--n-50 → --surface-overlay → #ffffff`, which is the same white a
 * card is painted with. Every unfocused input in the product became a white box with a transparent
 * border on white. On the sign-in screen both fields vanished. On "Verify a patient's coverage" —
 * the first thing anyone does with this product — twelve of seventeen controls were labels floating
 * over blank space, and the five that survived did so by accident: `.plan__row .input` sets a
 * border-colour of its own for an unrelated reason.
 *
 * ── WHY NOTHING CAUGHT IT ──────────────────────────────────────────────────────────────────────
 * The whole test surface passed. `the-tokens-hold-their-contrast` checks INK against SURFACES and a
 * field edge is neither. `stylesheet-has-no-collisions` checks that one rule declares one thing, and
 * one rule did. `scripts/shoot.mjs` photographs screens, and it photographed white rectangles that
 * looked like empty space — a screenshot cannot report a control it cannot see. The resting state of
 * a form control was simply not in anyone's field of view.
 *
 * So this checks the property directly, and it checks it as ARITHMETIC on the tokens rather than as
 * a look: an unfocused control is separable from the plane behind it, by a real edge or by a fill
 * that differs, and the value of that separation clears the 3:1 that WCAG 1.4.11 asks of a control
 * boundary.
 *
 * ── WHY IT ALSO SCANS FOR THE PATTERN ──────────────────────────────────────────────────────────
 * Fixing `.input` fixes today. The second test refuses `border: …px solid transparent` on any
 * control-shaped selector, because the next person to write one will write it the same way — the
 * pattern is idiomatic wherever a fill is doing the edge's job, and it is a trap on this ground.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");

/** The stylesheet with every comment removed, so prose can never satisfy a selector match. */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Resolve a custom property to a literal colour, following `var(--other)` indirection.
 *
 * The indirection is the whole point: `--n-50` is three hops from a hex, and it was the REMAPPING of
 * one of those hops that caused the defect. A test that only read literals would have been looking
 * at the wrong end of the chain.
 */
function resolve(name: string, depth = 0): string {
  assert.ok(depth < 8, `${name} does not resolve to a colour within 8 hops — circular alias?`);
  const m = BARE.match(new RegExp(`(?:^|;|\\{)\\s*${name}:\\s*([^;}]+)[;}]`, "m"));
  assert.ok(m, `${name} is not defined anywhere in styles.css`);
  const value = m![1]!.trim();
  const indirect = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (indirect) return resolve(indirect[1]!, depth + 1);
  return value;
}

/** Read one declaration out of one rule block. Returns null when the rule does not set it. */
function declaration(selector: string, property: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = BARE.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(block, `${selector} has no rule in styles.css`);
  const m = block![1]!.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m"));
  return m ? m[1]!.trim() : null;
}

const srgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
};

const luminance = (hex: string): number => {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/**
 * Flatten `rgba(r, g, b, a)` over an opaque backdrop, so an ink-alpha hairline can be compared to
 * the plane it is drawn on. Every line token in this sheet is ink-alpha rather than a grey, which is
 * deliberate (§1.1) and means none of them can be read as a literal.
 */
function flatten(colour: string, over: string): string {
  const m = colour.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/);
  if (!m) return colour;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map(Number) as [number, number, number];
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const base = srgb(over).map((c) => c * 255) as [number, number, number];
  const mix = [r, g, b].map((c, i) => Math.round(c * a + base[i]! * (1 - a)));
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * Every plane a form is actually drawn on. `.card`, `.panel` and `.login__panel` all paint `--n-0`,
 * and a drill panel paints `--surface-overlay`; a field inside any of them has to survive.
 */
const FORM_PLANES = ["--n-0", "--surface-base", "--surface-overlay"] as const;

/** WCAG 1.4.11 — a control's boundary against its adjacent colour. */
const CONTROL_BOUNDARY_MIN = 3;

/**
 * Every rule that draws an editable field, and the rule it inherits from when it only overrides.
 *
 * `.plan__row .input` is listed separately rather than assumed to be covered by `.input`, because it
 * overrides both the fill and the edge — and it was the ONLY thing on the intake form that stayed
 * visible through the defect, purely by accident. A rule that got it right by luck is exactly the
 * one to pin down.
 */
const CONTROLS: { selector: string; inherits?: string }[] = [
  { selector: ".input" },
  { selector: ".plan__row .input", inherits: ".input" },
  { selector: ".letter-edit" },
  { selector: ".address-fix input" },
];

/** The resting edge colour and fill colour of one control rule, following any `var()` chain. */
function restingPaint(selector: string, inherits?: string): { edge: string; fill: string } {
  const own = (property: string): string | null => {
    const direct = declaration(selector, property);
    if (direct) return direct;
    return inherits ? declaration(inherits, property) : null;
  };

  const border = own("border-color") ?? own("border");
  assert.ok(border, `${selector} declares no border and inherits none`);
  const fill = own("background") ?? own("background-color");
  assert.ok(fill, `${selector} declares no background and inherits none`);

  const edgeColour = border!.replace(/^\s*[\d.]+px\s+\w+\s+/, "").trim();
  assert.notEqual(
    edgeColour,
    "transparent",
    `${selector} has a transparent resting border — the fill is then the only edge, and on this ` +
      `ground the fill is the same white as the card behind it. This is audit finding A-1, exactly.`
  );

  const deref = (value: string): string => {
    const v = value.match(/var\(\s*(--[\w-]+)\s*\)/);
    return v ? resolve(v[1]!) : value;
  };
  return { edge: deref(edgeColour), fill: deref(fill!) };
}

test("an unfocused control is separable from the plane it is drawn on", () => {
  for (const { selector, inherits } of CONTROLS) {
    const { edge, fill } = restingPaint(selector, inherits);

    for (const plane of FORM_PLANES) {
      const planeHex = resolve(plane);
      const edgeHex = flatten(edge, planeHex);
      const fillHex = flatten(fill, planeHex);
      const separation = Math.max(ratio(edgeHex, planeHex), ratio(fillHex, planeHex));
      assert.ok(
        separation >= CONTROL_BOUNDARY_MIN,
        `a resting ${selector} is invisible on ${plane} (${planeHex}): its edge flattens to ` +
          `${edgeHex} and its fill to ${fillHex}, the best separation being ` +
          `${separation.toFixed(2)}:1 against the ${CONTROL_BOUNDARY_MIN}:1 a control boundary needs.`
      );
    }
  }
});

test("no control class hides its edge behind a transparent border", () => {
  /**
   * Deliberately narrow: only selectors that name a control. A transparent border is a legitimate
   * layout device elsewhere in this sheet — it reserves the space a border will occupy so a row does
   * not shift by a pixel when it becomes selected — and refusing it everywhere would be wrong.
   */
  const CONTROL = /(^|[,\s])\.(input|textarea|letter-edit|select|field)\b[^{]*$/;
  const offenders: string[] = [];

  for (const match of BARE.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1]!.trim().split("\n").pop()!.trim();
    const body = match[2]!;
    if (!CONTROL.test(selector)) continue;
    if (/:focus|:hover|:active|::/.test(selector)) continue;
    if (/border(?:-color)?\s*:\s*(?:[\d.]+px\s+\w+\s+)?transparent/.test(body)) {
      offenders.push(selector);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these control rules paint a transparent resting edge: ${offenders.join(", ")}`
  );
});

test("the focus ring is the accent token, not a colour copied from an older palette", () => {
  /**
   * `.input:focus` and `.letter-edit:focus` both carried `rgba(63, 184, 160, 0.20)` — the accent
   * from before Tide. The border beside it was already `--t-500`, so the ring and the edge it
   * surrounded were two different greens, and nothing said so. Anything hardcoded here drifts again
   * the next time the palette moves, which is the failure this whole file is about.
   */
  const focusRings = [...BARE.matchAll(/\.(?:input|letter-edit)[^{]*:focus[^{]*\{([^}]*)\}/g)].map(
    (m) => m[1]!
  );
  assert.ok(focusRings.length >= 2, "expected focus rules for both .input and .letter-edit");

  for (const body of focusRings) {
    const shadow = body.match(/box-shadow\s*:\s*([^;]+)/);
    if (!shadow) continue;
    assert.ok(
      !/rgba?\(/.test(shadow[1]!),
      `a focus ring hardcodes a colour instead of using a token: ${shadow[1]!.trim()}`
    );
  }
});
