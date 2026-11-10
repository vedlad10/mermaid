/**
 * Contrast, computed from the tokens rather than eyeballed (spec §10).
 *
 * ── WHY THIS IS A TEST AND NOT A REVIEW ────────────────────────────────────────────────────────
 * §10 states three thresholds and one of them as an instruction: "`--text-tertiary` on
 * `--surface-base` must clear 4.5:1 — verify and adjust the token if it does not." A token is a
 * number in a stylesheet; whether it clears a ratio is arithmetic, and arithmetic belongs in a test
 * rather than in somebody's judgement of a screenshot on a laptop at whatever brightness.
 *
 * It also fails in the right direction over time. Every future palette change runs through here, and
 * the ratio that quietly slips below the floor is caught the moment it is written rather than by the
 * first person who cannot read a timestamp.
 *
 * ── WHAT IS CHECKED AGAINST WHAT ───────────────────────────────────────────────────────────────
 * Ink is checked against every surface it is ACTUALLY rendered on, which is why the surfaces are
 * listed rather than assumed: `--text-tertiary` passing on the base plane means nothing if the same
 * label sits on `--surface-inset` inside a chart, which is darker.
 *
 * Semantic colours are checked at 4.5:1 when they carry text and 3:1 when they are only a mark,
 * which is the distinction §10 draws and the reason the ramp is allowed to be quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");

/** Read a custom property's literal hex value out of the `:root` block. */
function token(name: string): string {
  const m = CSS.match(new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, "m"));
  assert.ok(m, `${name} is not defined as a literal colour — this test cannot resolve indirection`);
  return m![1]!;
}

const srgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
};

/** WCAG relative luminance. */
const luminance = (hex: string): number => {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/** Every plane a screen actually paints ink on. */
/**
 * Every plane a token can be painted on — including `--surface-void`, which this list used to omit.
 *
 * On the dark theme void was the DARKEST surface, so it was the easiest for light ink and leaving it
 * out cost nothing. The light theme inverts that: void is the app ground behind everything and is
 * now the darkest of the five, which makes it the worst case for every text token rather than the
 * best. A list that skipped it would have been checking every surface except the one most likely to
 * fail.
 */
const SURFACES = [
  "--surface-base",
  "--surface-raised",
  "--surface-overlay",
  "--surface-inset",
  "--surface-void",
] as const;

test("the contrast maths agrees with known WCAG values", () => {
  /* A self-check: a formula that is wrong would let every assertion below pass. */
  assert.equal(Math.round(ratio("#ffffff", "#000000")), 21);
  assert.equal(Math.round(ratio("#000000", "#000000")), 1);
  /* #767676 on white is the textbook 4.54:1 boundary case. */
  assert.ok(Math.abs(ratio("#767676", "#ffffff") - 4.54) < 0.05);
});

test("body and figure ink clears 4.5:1 on every surface it is painted on", () => {
  for (const ink of ["--text-primary", "--text-secondary"] as const) {
    for (const surface of SURFACES) {
      const r = ratio(token(ink), token(surface));
      assert.ok(r >= 4.5, `${ink} on ${surface} is ${r.toFixed(2)}:1, below the 4.5:1 floor`);
    }
  }
});

test("--text-primary on --surface-base exceeds 12:1, as §10 states", () => {
  const r = ratio(token("--text-primary"), token("--surface-base"));
  assert.ok(r > 12, `the spec claims over 12:1; it is ${r.toFixed(2)}:1`);
});

test("--text-tertiary clears 4.5:1 — the check §10 asks for by name", () => {
  /**
   * §10: "`--text-tertiary` on `--surface-base` must clear 4.5:1 — verify and adjust the token if it
   * does not." This is that verification. Tertiary carries labels, units, axis ticks and timestamps
   * — the text a person reads while doing the actual work — so it failing is not a minor defect.
   */
  for (const surface of SURFACES) {
    const r = ratio(token("--text-tertiary"), token(surface));
    assert.ok(r >= 4.5, `--text-tertiary on ${surface} is ${r.toFixed(2)}:1, below 4.5:1`);
  }
});

test("semantic colours carrying text clear 4.5:1", () => {
  /* These are used as FIGURE colours — a spine figure, a struck amount — so they carry text. */
  for (const state of ["--state-critical", "--state-warning", "--state-positive"] as const) {
    for (const surface of SURFACES) {
      const r = ratio(token(state), token(surface));
      assert.ok(r >= 4.5, `${state} text on ${surface} is ${r.toFixed(2)}:1, below 4.5:1`);
    }
  }
});

test("the accent clears 4.5:1 wherever it is used as a link or a label", () => {
  for (const surface of SURFACES) {
    const r = ratio(token("--tide"), token(surface));
    assert.ok(r >= 4.5, `--tide on ${surface} is ${r.toFixed(2)}:1, below 4.5:1`);
  }
});

test("--text-quaternary is a graphical mark, not text, and is held to 3:1", () => {
  /**
   * Deliberately a lower bar, and deliberately asserted rather than left unchecked. Quaternary is
   * the em dash on a withheld figure, an unselected chart column, a disabled control — things whose
   * job is to be present without being read. §10 sets 3:1 for graphical elements.
   *
   * If it ever carries real prose, this test is the thing that should be changed first, on purpose.
   */
  const r = ratio(token("--text-quaternary"), token("--surface-base"));
  assert.ok(r >= 3, `--text-quaternary on --surface-base is ${r.toFixed(2)}:1, below the 3:1 graphical floor`);
});

test("adjacent steps of the composition ramp are distinguishable from each other", () => {
  /**
   * The ramp carries a stacked band's composition, so what matters is not its contrast with the
   * background but whether two NEIGHBOURING bands can be told apart — including in grayscale, which
   * is the whole reason the ramp exists instead of a palette of hues.
   */
  const steps = ["--ramp-1", "--ramp-2", "--ramp-3", "--ramp-4", "--ramp-5"] as const;
  for (let i = 1; i < steps.length; i++) {
    const r = ratio(token(steps[i]!), token(steps[i - 1]!));
    assert.ok(r >= 1.3, `${steps[i]} and ${steps[i - 1]} are ${r.toFixed(2)}:1 apart — too close to separate`);
  }
  /* And the ends of the ramp must be unmistakably different, or a five-band stack reads as one. */
  assert.ok(ratio(token("--ramp-5"), token("--ramp-1")) >= 7);
});
