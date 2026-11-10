/**
 * How the command palette decides what you meant (spec §5.7).
 *
 * ── WHY ROUTING AND NOT RANKING ────────────────────────────────────────────────────────────────
 * §5.7 opens by saying what the palette is not: "not a search box — the fastest path to any entity
 * or action." In a revenue cycle the SHAPE of what someone types already says which thing they are
 * after, and throwing that away to re-derive it statistically is the worse design. A single ranked
 * list would put a patient called "Delta" above the payer Delta Dental on a good day and below it on
 * a bad one — and the person typing already knew which they wanted.
 *
 * These assertions are about that decision alone. Matching against records needs records; deciding
 * what kind of thing was typed does not, and it is the part that can be wrong in a way nobody
 * notices — a claim number silently searched as free text simply returns nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* The module builds elements only inside `createPalette`, which this file does not call. */
(globalThis as Record<string, unknown>).document = {
  createElement: () => ({
    className: "", textContent: "", type: "", style: {}, hidden: true,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {},
  }),
  addEventListener() {},
};

const { routeQuery } = await import("../public/palette.js");

/** Route a query and assert it is an amount, so the cents can be read without a cast. */
function amountOf(q: string): number {
  const r = routeQuery(q);
  assert.equal(r.kind, "amount", `${q} should route as an amount`);
  return (r as { kind: "amount"; cents: number }).cents;
}

test("an empty query asks for recents, not for everything", () => {
  /* §5.7: "Recent entities appear on open with no query." An empty palette that listed the whole
     database would be a slow way to show something nobody asked for. */
  for (const q of ["", "   ", null, undefined]) {
    assert.equal(routeQuery(q as unknown as string).kind, "recent");
  }
});

test("five or more digits is an identifier, four or fewer is text", () => {
  /**
   * The boundary matters. Claim and subscriber numbers are long; "2024" is a year someone is
   * typing as part of a phrase. Routing the short one as an identifier would search member IDs for
   * it and return nothing, which reads as "we have no record" rather than "you meant something
   * else".
   */
  assert.equal(routeQuery("84210").kind, "id");
  assert.equal(routeQuery("MOCKS4D99".replace(/\D/g, "")).kind, "text", "49 is too short to be an id");
  assert.equal(routeQuery("2024").kind, "text");
  assert.equal(routeQuery("123456789").kind, "id");
});

test("a D followed by digits is a procedure code, in either case", () => {
  /* Nobody holds shift for this. */
  assert.equal(routeQuery("D2750").kind, "code");
  assert.equal(routeQuery("d2750").kind, "code");
  assert.equal(routeQuery("D2750").term, "D2750", "and it is normalised, so the match is not case-dependent");
  assert.equal(routeQuery("d0120").term, "D0120");
});

test("a name beginning with D is not a procedure code", () => {
  /* The rule is a D followed by DIGITS. "Delta" and "Diaz" must stay free text. */
  assert.equal(routeQuery("Delta").kind, "text");
  assert.equal(routeQuery("Diaz").kind, "text");
  assert.equal(routeQuery("D").kind, "text");
});

test("a dollar prefix is an amount, and the separators a person types are stripped", () => {
  /**
   * Someone typing `$1,125.00` is quoting a figure off a remittance. Parsing it as text would
   * return nothing; failing to strip the comma would parse it as 1.
   */
  assert.equal(amountOf("$1,125.00"), 112500);
  assert.equal(amountOf("$799.99"), 79999);
  assert.equal(amountOf("$21.49"), 2149);
  assert.equal(amountOf("$ 1 425"), 142500, "spaces too — people type them");
});

test("cents survive the conversion exactly", () => {
  /**
   * The reason to type an amount is that it is exact. `0.1 + 0.2` arithmetic here would put the
   * search a cent away from the claim it is looking for, and the tolerance is one dollar — so a
   * rounding error would still match, silently, the wrong way.
   */
  for (const [typed, cents] of [["$0.01", 1], ["$0.07", 7], ["$1.10", 110], ["$142.50", 14250], ["$2,335.54", 233554]] as const) {
    assert.equal(amountOf(typed), cents, `${typed} must be exactly ${cents} cents`);
  }
});

test("a dollar sign with nothing parseable behind it falls back to text", () => {
  /* Better to search for the characters than to search for NaN dollars and find nothing. */
  assert.equal(routeQuery("$").kind, "text");
  assert.equal(routeQuery("$abc").kind, "text");
});

test("free text stays free text, including things that merely contain digits", () => {
  assert.equal(routeQuery("delta dental").kind, "text");
  assert.equal(routeQuery("Rowan Mockcase").kind, "text");
  assert.equal(routeQuery("pre-authorization").kind, "text");
  assert.equal(routeQuery("appeal").kind, "text");
  /* Not five leading digits, so not an id — an id must be digits and nothing else. */
  assert.equal(routeQuery("MOCK12345").kind, "text");
});

test("surrounding whitespace never changes the routing", () => {
  assert.equal(routeQuery("  D2750  ").kind, "code");
  assert.equal(routeQuery("  84210 ").kind, "id");
  assert.equal(routeQuery("  $1,125 ").kind, "amount");
});
