/**
 * Presentation mode (§8.6), and the three things it must get exactly right.
 *
 * ── THE SCENE THIS IS FOR ──────────────────────────────────────────────────────────────────────
 * A laptop turned around in an operatory, or a screen shared in a morning huddle. The manager does
 * not get to promise they will only look at the one screen that honours the setting, which is why
 * the state lives on the document and every screen reads it through the same two functions.
 *
 * A mask that covers six screens out of eight is worse than no mask at all, because it is trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The module reads `document.body`, so it needs one. This is the whole DOM surface it touches —
 * an attribute bag and an event target — which is itself the point: masking is not a rendering
 * concern, it is a decision about a string.
 */
const attrs = new Set<string>();
const listeners: Array<(e: unknown) => void> = [];
(globalThis as Record<string, unknown>).document = {
  body: {
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string) => attrs.add(n),
    removeAttribute: (n: string) => attrs.delete(n),
  },
  createElement: () => ({
    type: "", className: "", textContent: "", title: "",
    classList: { toggle() {} },
    setAttribute() {}, addEventListener() {},
  }),
  addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.push(fn),
  dispatchEvent: (e: unknown) => { for (const fn of [...listeners]) fn(e); return true; },
};
(globalThis as Record<string, unknown>).CustomEvent = class {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; }
};

const { isPresenting, maskId, maskName, setPresenting } = await import("../public/privacy.js");

test("off by default, and masking is inert until it is turned on", () => {
  assert.equal(isPresenting(), false);
  assert.equal(maskName("Sasha Mockfile"), "Sasha Mockfile");
  assert.equal(maskId("MOCKS4D99"), "MOCKS4D99");
});

test("a name becomes initials — enough to tell two rows apart, not enough to read one off", () => {
  setPresenting(true);
  assert.equal(maskName("Sasha Mockfile"), "S.M.");
  assert.equal(maskName("Quinn Mocktest"), "Q.M.");
  assert.equal(maskName("Ada"), "A.");
  /* Extra whitespace and middle names must not produce empty initials or double dots. */
  assert.equal(maskName("  Mary  Jane  Watson "), "M.J.W.");
  setPresenting(false);
});

test("an identifier keeps its last two characters, because a family shares the rest", () => {
  /**
   * A member ID is shared across a policy, so blanking it entirely would render two rows for the
   * same family indistinguishable — a queue nobody could work from. Two characters is enough to
   * separate them and not enough to quote to a payer.
   */
  setPresenting(true);
  assert.equal(maskId("MOCKS4D99"), "••••99");
  assert.equal(maskId("AB"), "••", "a short id is masked entirely rather than mostly shown");
  assert.equal(maskId("X"), "••");
  setPresenting(false);
});

test("an absent name stays absent rather than becoming a mask", () => {
  /**
   * "We do not know who this is" and "we are not telling you" are different facts, and a screen
   * that renders both as the same string has lost one of them.
   */
  setPresenting(true);
  assert.equal(maskName(null), null);
  assert.equal(maskName(undefined), undefined);
  assert.equal(maskName(""), "");
  setPresenting(false);
});

test("money is never masked", () => {
  /**
   * Deliberate, and worth asserting because the instinct is to hide everything. Money is the
   * subject of every screen in this product; masking it would make Mermaid useless in exactly the
   * room this mode exists for, and a dollar figure identifies nobody on its own.
   *
   * Asserted as an absence: the module exposes no money masker to call by mistake.
   */
  const api = { isPresenting, maskId, maskName, setPresenting };
  assert.ok(!Object.keys(api).some((k) => /money|amount|cents|usd|balance/i.test(k)));
});

test("turning it on announces the change, so every mounted screen can redraw", () => {
  /**
   * The announcement is the whole mechanism for "across the entire product". Without it, masking
   * would take effect only on the next render a screen happened to do for another reason — which,
   * on a screen nobody is touching, is never.
   */
  const seen: boolean[] = [];
  const doc = (globalThis as Record<string, unknown>).document as {
    addEventListener(t: string, fn: (e: unknown) => void): void;
  };
  doc.addEventListener("mermaid:presenting", (e: unknown) => {
    seen.push((e as { detail: { on: boolean } }).detail.on);
  });
  setPresenting(true);
  setPresenting(false);
  assert.deepEqual(seen, [true, false]);
});

// ── The identifier a queue row carries to tell itself from its twin ───────────────────────────

test("a Today row's distinguisher is masked, because for a coverage check it is a member id", async () => {
  /**
   * ── THE LEAK THIS ALMOST WAS ─────────────────────────────────────────────────────────────────
   * The Today board prints a disambiguating clause on any two rows that would otherwise read
   * identically, and for a coverage check that clause is the MEMBER ID — because an account keyed by
   * a member id is a policy, and which policy the practice is quoting from is the whole question.
   *
   * The first version composed that clause into `subtitle` on the server. `today.js` masks `title`
   * through `maskName` and renders `subtitle` verbatim, correctly, because a subtitle is a payer and
   * a status. So a member id would have printed in full on a laptop turned around in an operatory —
   * in the one mode whose entire purpose is stopping exactly that.
   *
   * The fix is the division this module already rests on: the server says what the fact IS, the
   * client decides how to show it. This asserts the client half.
   */

  /** The composition `today.js` performs, kept here so a change to it fails a test rather than a demo. */
  const shown = (d: { memberId: string } | { text: string } | null) =>
    !d ? "" : "memberId" in d ? ` · member ${maskId(d.memberId)}` : ` · ${d.text}`;

  setPresenting(false);
  assert.equal(shown({ memberId: "MET90100" }), " · member MET90100", "unmasked, it is the whole id");

  setPresenting(true);
  const masked = shown({ memberId: "MET90100" });
  assert.equal(masked.includes("MET90100"), false, "the member id must not survive presentation mode");
  assert.match(masked, /00$/, "and enough of it must survive to tell two rows apart");

  /* A trace number, a service date and a procedure code identify no person and stay legible — the
     same rule that leaves money alone. */
  assert.equal(shown({ text: "service 2026-08-14" }), " · service 2026-08-14");
  setPresenting(false);
});
