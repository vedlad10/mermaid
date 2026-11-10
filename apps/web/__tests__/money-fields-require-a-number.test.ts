/**
 * A money field accepts a number. Not a string that converts to one.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Both dollar inputs on this API read their amount with `Number(body.field)`, which coerces far more
 * than it looks like it does. Probed against the deployed build, each of these was a 200 and a real
 * ledger row:
 *
 *     {"amountDollars": "0x10"}  posted  $16.00
 *     {"amountDollars": "1e3"}   posted  $1,000.00
 *     {"amountDollars": true}    posted  $1.00
 *     {"amountDollars": [42]}    posted  $42.00
 *
 * `"0x10"` is the one worth staring at: a caller sends what looks like a string of digits and a
 * different dollar figure lands in the ledger, with no error anywhere. None of this is reachable
 * from Mermaid's own screens, which send numbers — but "our UI happens not to do that" is not what
 * makes a money boundary correct, and an integration written against this endpoint would be wrong
 * in a way nothing reports.
 *
 * ── WHY THE WHOLE-CENTS RULE IS NOT ENOUGH ───────────────────────────────────────────────────────
 * `isWholeCents` already refuses a fraction of a cent, and it passes every value above: 16, 1000, 1
 * and 42 are all whole cents. The two rules answer different questions — "is this amount storable"
 * and "is this even an amount" — and the second has to be asked first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

const app = createApp(testServices());
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => server.close());

/** Signed in, so a refusal here is about the FIELD and not about the session. */
async function client() {
  const s = await fetch(`${base}/api/v1/auth/session`);
  const jar = (s.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  const { csrf } = (await s.json()) as { csrf: string };
  return (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.join("; "), "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
}

const NOT_NUMBERS = [
  ["a decimal string", "50"],
  ["a hex string", "0x10"],
  ["exponent notation as text", "1e3"],
  ["a padded string", " 50 "],
  ["a boolean", true],
  ["a one-element array", [42]],
  ["an object", { valueOf: 50 }],
] as const;

test("a patient payment refuses anything that is not a number", async () => {
  const post = await client();
  for (const [label, value] of NOT_NUMBERS) {
    const r = await post("/api/v1/patients/ANY-KEY/payment", { amountDollars: value, note: "t" });
    assert.ok(
      r.status >= 400,
      `${label} (${JSON.stringify(value)}) was accepted with ${r.status} — Number() would have turned it into a dollar figure`
    );
    /**
     * And it must be refused for BEING the wrong type, not for the key being unknown — otherwise
     * this test would pass against a route that still coerced, simply because the patient is fake.
     */
    const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    assert.match(
      body.error?.message ?? "",
      /must be a number/i,
      `${label} was refused, but not for its type: ${body.error?.message}`
    );
  }
});

test("a real number is still accepted by the type check", async () => {
  const post = await client();
  const r = await post("/api/v1/patients/ANY-KEY/payment", { amountDollars: 25, note: "t" });
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  assert.doesNotMatch(
    body.error?.message ?? "",
    /must be a number/i,
    "25 is a number and must get past the type check — whatever happens to it afterwards"
  );
});

test("an appeal outcome refuses a non-number recovery, and still allows none at all", async () => {
  const post = await client();

  /**
   * A well-formed id, because the route checks the id's SHAPE before it reads the body — with
   * "any-id" the refusal is about the path and this test would pass without proving anything about
   * the money field. The denial need not exist: the type check runs before the lookup.
   */
  const ID = "11111111-2222-4333-8444-555555555555";
  const bad = await post(`/api/v1/denials/${ID}/outcome`, { won: true, recoveredAmountDollars: "0x10" });
  const badBody = (await bad.json().catch(() => ({}))) as { error?: { message?: string } };
  assert.ok(bad.status >= 400, "a hex string recovery must not be accepted");
  assert.match(badBody.error?.message ?? "", /must be a number/i);

  /**
   * Omitting it is how a win with no figure yet is recorded, and that has to keep working — the
   * type check must not turn an optional field into a required one.
   */
  const omitted = await post(`/api/v1/denials/${ID}/outcome`, { won: true });
  const omittedBody = (await omitted.json().catch(() => ({}))) as { error?: { message?: string } };
  assert.doesNotMatch(
    omittedBody.error?.message ?? "",
    /must be a number/i,
    "an absent recovery amount is legitimate and must not be refused as a type error"
  );
});
