/**
 * A screen may only draw what the server sent it.
 *
 * ── WHY THIS IS A TEST AND NOT A CODE REVIEW ───────────────────────────────────────────────────
 * §12's definition of done requires that "no hardcoded, sampled, or randomly generated data exists
 * in any code path", and §4.4 is the reason: a figure on this product's screen is a claim about a
 * practice's money. A fabricated series is not a placeholder that someone will notice and replace —
 * it is indistinguishable from a real one at a glance, it survives review because it looks like the
 * shape it is standing in for, and the moment it ships it is a false statement about revenue.
 *
 * The honest refusals this codebase already makes are the counterweight, and they cost something:
 * Money has no waterfall, Claims has no funnel, Verify has no latency histogram, and Insights has
 * no procedure economics, because the events those charts need are not recorded. Every one of those
 * gaps could be closed in an afternoon with a plausible-looking constant. This test is what makes
 * that the harder path rather than the easier one.
 *
 * ── WHAT IT LOOKS FOR ──────────────────────────────────────────────────────────────────────────
 * The two shapes fabricated data actually takes: a run of numbers (a series), and a list of objects
 * carrying a label and a figure (a table or a ranking). Both are cheap to write and both read as
 * real. Legitimate uses of either shape are listed below with their reasons rather than pattern-
 * matched around, because "is this data or is this geometry?" is a judgement, and the place for a
 * judgement is next to it where the next person can disagree with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../public/", import.meta.url));

/** Comments describe data; they do not render it. A worked example in prose is not a fabrication. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

/**
 * Numeric literals that are measurements of the SCREEN rather than claims about the practice.
 *
 * Geometry is the honest use of a constant: an axis needs tick positions, a skeleton needs bar
 * widths, and neither asserts anything about money. Each entry names the file and the reason.
 */
const GEOMETRY: { file: string; snippet: string; why: string }[] = [
  {
    file: "recover.js",
    snippet: "[0, 15, 30, 45, 60]",
    why: "Axis ticks on the recovery horizon — where to draw the marks, not what is at them.",
  },
  {
    file: "states.js",
    snippet: "[92, 76, 84, 64, 88]",
    why: "Skeleton bar widths. A skeleton is the explicit statement that there is no data yet.",
  },
];

/**
 * Canned INPUT, which is a different thing from canned output — but only where nothing persists.
 *
 * `SAMPLES` prefills the intake form with a fictional person and `DEFAULT_PLAN` prefills it with a
 * cleaning and a $1,250 crown. Neither is a figure the screen asserts; both are starting values a
 * person can overwrite. That makes them harmless in the in-memory demo and not harmless anywhere
 * else, because this form's submit creates a real verification against a real payer: on a
 * Postgres-backed deployment a fabricated patient lands in the practice's own Verify list in one
 * click, and a fee nobody chose lands on what a patient is told they owe.
 *
 * So they are allowed to exist and required to be gated, and the third test below checks the gate
 * rather than taking this exemption's word for it. `data-requires="audit.read"` is not the gate —
 * an owner of a real clinic passes that check.
 */
const DEMO_ONLY: { name: string; file: string; why: string }[] = [
  {
    name: "SAMPLES",
    file: "app.js",
    why: "Sample scenario chips on the intake form. Fictional people, offered as one-click prefill.",
  },
  {
    name: "DEFAULT_PLAN",
    file: "app.js",
    why: "Prefilled treatment-plan rows. Fees nobody chose, on the form that produces an estimate.",
  },
];

/** Four or more numbers in a row — the shape a fabricated series takes. */
const SERIES = /\[\s*-?[\d.]+\s*(?:,\s*-?[\d.]+\s*){3,},?\s*\]/g;

/** `{ label: "…", … 1234 }` — the shape a fabricated table or ranking takes. */
const ROW = /\{\s*(?:label|name|title|month|day|bucket|code|payer|carc)\s*:\s*["'][^"']+["'][^}]*\d{2,}[^}]*\}/g;

const screens = (): { file: string; text: string }[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".js"))
    .map((file) => ({ file, text: code(readFileSync(DIR + file, "utf8")) }));

test("no screen carries a series it did not receive", () => {
  const invented: string[] = [];

  for (const { file, text } of screens()) {
    for (const match of text.matchAll(SERIES)) {
      const literal = match[0].replace(/\s+/g, " ");
      const allowed = GEOMETRY.some(
        (g) => g.file === file && literal.replace(/\s/g, "") === g.snippet.replace(/\s/g, "")
      );
      if (!allowed) invented.push(`${file}: ${literal}`);
    }
  }

  assert.deepEqual(
    invented,
    [],
    "a run of numbers is written into a screen. If it is geometry — tick positions, skeleton " +
      "widths, anything that measures the screen rather than the practice — add it to GEOMETRY " +
      "with the reason. If it is data, it has to come from the server, and if the server cannot " +
      "produce it yet then the honest thing on the screen is the refusal, not the constant."
  );
});

test("no screen carries a table it did not receive", () => {
  const invented: string[] = [];
  const allowed = new Set(DEMO_ONLY.map((d) => `${d.file}:${d.name}`));

  for (const { file, text } of screens()) {
    for (const match of text.matchAll(ROW)) {
      /* Which declaration is this literal inside? The nearest `const NAME = [` above it. */
      const decl = [...text.slice(0, match.index!).matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[/g)].pop();
      if (decl && allowed.has(`${file}:${decl[1]}`)) continue;
      invented.push(`${file}: ${match[0].replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }

  assert.deepEqual(
    invented,
    [],
    "a labelled row with a figure in it is written into a screen. On this product a label beside a " +
      "number is a claim about a payer, a code, or a month, and it has to have come from the data. " +
      "If it is canned INPUT rather than displayed output, add it to DEMO_ONLY — which obliges it " +
      "to be gated on a deployment where nothing persists."
  );
});

test("canned input is reachable only where nothing persists", () => {
  /**
   * The half of the exemption that can actually be checked. `state.persistent` is false only for
   * the DB-free demo, so every USE of an allowed literal has to be guarded by a test of it. An
   * exemption that quietly stopped being true would otherwise read as reviewed while shipping
   * fabricated patients into a real practice's data.
   */
  for (const d of DEMO_ONLY) {
    const text = code(readFileSync(DIR + d.file, "utf8"));
    assert.ok(text.includes(`const ${d.name} =`), `${d.name} is gone — remove its exemption`);

    const uses = [...text.matchAll(new RegExp(`\\b${d.name}\\b`, "g"))]
      .map((m) => text.slice(text.lastIndexOf("\n", m.index!) + 1, text.indexOf("\n", m.index!)))
      .filter((line) => !line.trimStart().startsWith(`const ${d.name}`));

    assert.ok(uses.length > 0, `${d.name} is declared and never used`);
    for (const line of uses) {
      assert.match(
        line,
        /state\.persistent/,
        `${d.name} is used without asking whether this deployment persists: "${line.trim()}"`
      );
    }
  }
});

test("nothing on a screen is random", () => {
  /**
   * Separate from the others because it fails differently. A hardcoded series is at least stable
   * and eventually recognisable — the same wrong number every time. A random one changes between
   * two people looking at the same screen, and there is no way to notice that except by knowing.
   */
  const found: string[] = [];
  for (const { file, text } of screens()) {
    if (/Math\.random|crypto\.getRandomValues/.test(text)) found.push(file);
  }
  assert.deepEqual(found, [], "randomness in a client that renders a practice's money");
});

test("the allowlists describe something that is really there", () => {
  /**
   * An allowlist entry for code that has since been deleted is worse than no entry: it reads as a
   * reviewed exception when it is actually a stale note, and it silently widens what the next
   * fabrication can hide behind.
   */
  for (const g of GEOMETRY) {
    const text = readFileSync(DIR + g.file, "utf8").replace(/\s/g, "");
    assert.ok(
      text.includes(g.snippet.replace(/\s/g, "")),
      `${g.file} no longer contains ${g.snippet} — remove the exception rather than leaving it open`
    );
    assert.ok(g.why.length > 30, `${g.snippet} needs a real reason, not a label`);
  }
  for (const d of DEMO_ONLY) assert.ok(d.why.length > 30, `${d.name} needs a real reason`);
});
