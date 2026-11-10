/**
 * §6's one authored moment, and the rule that decides when it is allowed to happen.
 *
 * ── THE RULE, WHICH IS SUBTLER THAN "ANIMATE ON CHANGE" ────────────────────────────────────────
 * §6.2: "Numbers count only when they changed for a reason the user caused or should notice. A
 * metric updating from a live payment posting animates over 320ms… A metric changing because the
 * user switched timeframe SNAPS instantly — the old value was about a different thing entirely and
 * counting between them implies a false relationship."
 *
 * That distinction is the whole feature. $1,669 becoming $2,468 because a payment posted is a
 * movement, and watching it move is the information. The same two numbers appearing because someone
 * switched from 30 days to 90 days is not a movement at all — nothing travelled between them, and
 * animating it draws a line through a relationship that does not exist.
 *
 * The spine cannot work that out on its own, so the caller states what its figures are ABOUT and
 * the spine counts only when that is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── Enough DOM for the spine, and a controllable clock for the animation ────────────────────── */

type El = Record<string, unknown>;
const made: El[] = [];

function makeEl(): El {
  const children: El[] = [];
  const attrs = new Map<string, string>();
  const el: El = {
    children, dataset: {}, style: {}, textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: "",
    append: (...k: unknown[]) => { for (const x of k) if (x && typeof x === "object") children.push(x as El); },
    replaceChildren: (...k: unknown[]) => { children.length = 0; for (const x of k) if (x && typeof x === "object") children.push(x as El); },
    setAttribute: (n: string, v: string) => attrs.set(n, String(v)),
    getAttribute: (n: string) => attrs.get(n) ?? null,
    addEventListener() {}, removeEventListener() {},
    /* The spine finds a figure with `[data-metric="key"] .sp__fig`; this resolves that by walking. */
    querySelector(this: El, sel: string) {
      const m = /\[data-metric="([^"]+)"\]/.exec(sel);
      if (!m) return null;
      const found = (node: El): El | null => {
        for (const kid of (node.children as El[])) {
          if ((kid.dataset as Record<string, string>)?.metric === m[1]) {
            /* The figure is the child carrying the `sp__fig` class. */
            for (const g of (kid.children as El[])) if (String(g.className).includes("sp__fig")) return g;
          }
          const deep = found(kid);
          if (deep) return deep;
        }
        return null;
      };
      return found(this);
    },
    querySelectorAll: () => [] as El[],
  };
  made.push(el);
  return el;
}

/** Frames are driven by hand so the count can be observed mid-flight rather than raced. */
const frames: Array<(t: number) => void> = [];
const g = globalThis as Record<string, unknown>;
g.document = { createElement: () => makeEl(), createElementNS: () => makeEl(), addEventListener() {} };
g.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
g.requestAnimationFrame = (fn: (t: number) => void) => { frames.push(fn); return frames.length; };
g.cancelAnimationFrame = () => {};

const { createSpine } = await import("../public/spine.js");
const { createStore } = await import("../public/store.js");

const metric = (value: number) => [{
  key: "collected",
  label: "Collected",
  value,
  display: `$${value}`,
  format: (v: number) => `$${Math.round(v)}`,
  delta: null,
  series: [],
  basis: "",
  tone: null,
}];

/** Run the animation to a given progress and report what the figure reads. */
function advance(ms: number): void {
  const pending = frames.splice(0, frames.length);
  for (const f of pending) f(performance.now() + ms);
}
const figure = (host: El): string =>
  String((host.querySelector as (s: string) => El | null)('[data-metric="collected"] .sp__fig')?.textContent ?? "");

test("the same question with a new answer counts, because the movement is the information", () => {
  const host = makeEl();
  const spine = createSpine(host, { store: createStore(), metrics: [] });

  spine.update(metric(1669), { basis: "today" });
  assert.equal(figure(host), "$1669", "the first draw never animates — there is nothing to move from");
  assert.equal(frames.length, 0);

  spine.update(metric(2468), { basis: "today" });
  assert.ok(frames.length > 0, "a change on the same basis starts a count");

  /* Mid-flight it is between the two, which is the whole point of counting. */
  advance(160);
  const mid = Number(figure(host).replace(/\D/g, ""));
  assert.ok(mid > 1669 && mid < 2468, `mid-count should be between the two values; read ${mid}`);

  advance(400);
  assert.equal(figure(host), "$2468", "and it lands exactly on the new value");
  spine.destroy();
});

test("a different question snaps, because nothing travelled between those two numbers", () => {
  /**
   * The rule that makes this worth having. Switching timeframe produces two figures that were never
   * points on one path — animating between them draws a relationship that does not exist.
   */
  const host = makeEl();
  const spine = createSpine(host, { store: createStore(), metrics: [] });

  spine.update(metric(1669), { basis: "30d" });
  frames.length = 0;
  spine.update(metric(9000), { basis: "90d" });

  assert.equal(frames.length, 0, "no animation was scheduled");
  assert.equal(figure(host), "$9000", "the new figure is simply there");
  spine.destroy();
});

test("an unchanged figure does not animate, even on the same basis", () => {
  /* A reload that found nothing new must not twitch. Motion means something changed. */
  const host = makeEl();
  const spine = createSpine(host, { store: createStore(), metrics: [] });
  spine.update(metric(1669), { basis: "today" });
  frames.length = 0;
  spine.update(metric(1669), { basis: "today" });
  assert.equal(frames.length, 0);
  spine.destroy();
});

test("without a basis nothing counts, so a caller that has not thought about it gets no motion", () => {
  /**
   * Failing toward stillness is deliberate. A screen that forgot to say what its figures are about
   * cannot have the question answered for it, and animating on every change would eventually
   * animate a timeframe switch — the one case §6.2 explicitly forbids.
   */
  const host = makeEl();
  const spine = createSpine(host, { store: createStore(), metrics: [] });
  spine.update(metric(1669));
  frames.length = 0;
  spine.update(metric(2468));
  assert.equal(frames.length, 0);
  assert.equal(figure(host), "$2468");
  spine.destroy();
});
