/**
 * Uploading an 835 the practice already holds (NEW-15).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * The route read a JSON body — `{"raw835": "ISA*..."}` — under the global 1 MB cap, and handed it to
 * a parser that refuses any file carrying more than one transaction set. Both halves were wrong for
 * the file a payer's portal actually produces:
 *
 *   • JSON-wrapping an EDI file means escaping every quote and newline in it, roughly doubling a
 *     payload that is already the largest thing this API accepts — and a practice does not have the
 *     file as JSON, it has it as a download.
 *   • A month-end ERA routinely holds a dozen cheques. `parse835` refuses those, correctly — there
 *     is no honest way to fold three payments into one advice, and taking the first would post one
 *     while two vanished. So the human upload path could not accept the most ordinary export there
 *     is, and the person split the file by hand in a text editor, around segment boundaries, in a
 *     document where a misplaced `~` changes what a payer is recorded as having paid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(testServices());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * One 835 transaction set — a single cheque, with its own trace number.
 *
 * Hand-built rather than taken from a fixture because the point of these tests is the FILE shape:
 * how many transaction sets an interchange holds, and how large it is. The money inside is
 * incidental and deliberately trivial.
 */
function advice(trace: string, cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return [
    `ST*835*${trace}`,
    `BPR*I*${dollars}*C*ACH*CCP*01*999999999*DA*1234567*1512345678**01*888888888*DA*7654321*20260901`,
    `TRN*1*${trace}*1512345678`,
    "DTM*405*20260901",
    "N1*PR*DELTA DENTAL",
    "N1*PE*MERMAID DEMO DENTAL*XX*1234567893",
    `LX*1`,
    `CLP*MRM-${trace}*1*${dollars}*${dollars}**12*PAYER-${trace}*11`,
    "NM1*QC*1*ALPHA*ADA****MI*ABC12345",
    `SVC*AD:D0120*${dollars}*${dollars}`,
    "DTM*472*20260901",
    "SE*12*" + trace,
  ].join("~");
}

/** A whole interchange around one or more transaction sets. */
function interchange(sets: string[]): string {
  return [
    "ISA*00*          *00*          *ZZ*DELTA          *ZZ*CLINIC         *260901*1200*^*00501*000000001*0*P*:",
    "GS*HP*DELTA*CLINIC*20260901*1200*1*X*005010X221A1",
    ...sets,
    "GE*" + sets.length + "*1",
    "IEA*1*000000001",
  ].join("~") + "~";
}

test("NEW-15: a raw EDI body is accepted — no JSON wrapping", async () => {
  /**
   * The shape a practice actually has: the bytes of the file, sent as they were downloaded.
   */
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/remittances`, {
      method: "POST",
      headers: { "content-type": "application/edi-x12" },
      body: interchange([advice("0000001", 10_000)]),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.remittance.paymentTotal, 10_000);
  });
});

test("NEW-15: the JSON envelope still works — existing clients are not broken", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/remittances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw835: interchange([advice("0000002", 12_500)]) }),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.remittance.paymentTotal, 12_500);
  });
});

test("NEW-15: a multi-cheque file is REFUSED unless the caller says it expects one", async () => {
  /**
   * The refusal is not a limitation to be worked around — it is the control. Somebody uploading
   * what they believe is one cheque must be told when it is three, because that belief being wrong
   * is exactly what needs surfacing before any money moves.
   */
  await withServer(async (base) => {
    const file = interchange([advice("0000010", 10_000), advice("0000011", 20_000), advice("0000012", 30_000)]);

    const refused = await fetch(`${base}/api/v1/remittances`, {
      method: "POST",
      headers: { "content-type": "application/edi-x12" },
      body: file,
    });
    /**
     * ── 409 AND A CODE OF ITS OWN (audit A-3) ──────────────────────────────────────────────────
     * This asserted 400 and `parse_error`, which is what a TRUNCATED file and a JPEG renamed to
     * `.835` also produce — so from the outside there was no way to tell "your file is corrupt" from
     * "your file is fine and holds three cheques, say whether you meant that". A screen offering
     * "post all of them" on the first is a screen that posts garbage; a screen refusing every
     * multi-payment file cannot accept a month-end ERA, which is most of them.
     *
     * 409 because nothing about the request is malformed: it conflicts with an assumption the caller
     * made, and `?multiple=1` is how they withdraw it.
     */
    const body = (await refused.json()) as { error: { code: string } };
    const message = JSON.stringify(body);
    assert.equal(refused.status, 409, message);
    assert.equal(
      body.error.code,
      "multiple_payments",
      `a confirmable file must be distinguishable from a broken one — got ${message}`
    );
    assert.match(message, /3 separate 835/, "and it must say HOW MANY payments the file holds");
  });
});

test("a corrupt file is NOT offered the same second chance a multi-cheque file gets", async () => {
  /**
   * The other half of the split, and the reason the code exists. Both refusals used to be
   * `parse_error`; if this one still were, the upload screen's "post every payment in this file?"
   * would be offered over bytes that are not an 835 at all.
   */
  await withServer(async (base) => {
    const refused = await fetch(`${base}/api/v1/remittances`, {
      method: "POST",
      headers: { "content-type": "application/edi-x12" },
      body: "THIS IS NOT AN X12 DOCUMENT, IT IS A SENTENCE",
    });
    const body = (await refused.json()) as { error: { code: string } };
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(body.error.code, "parse_error", "an unreadable file is still just unreadable");
    assert.notEqual(body.error.code, "multiple_payments");
  });
});

test("NEW-15: a 4 MB, three-cheque file uploads and produces three remittances", async () => {
  /**
   * The case the route could not serve at all: too large for the body cap AND refused by the
   * parser. Padded to 4 MB with a segment the parser ignores, so the size is real rather than
   * simulated — the old 1 MB cap rejects this before any handler runs.
   */
  await withServer(async (base) => {
    const sets = [advice("0000020", 10_000), advice("0000021", 20_000), advice("0000022", 30_000)];
    let file = interchange(sets);
    // `REF` with an unknown qualifier is traced and skipped by the parser, so this is bulk and not
    // meaning — exactly what a real file's line-level detail would be to this test.
    const padding = "~REF*ZZ*" + "P".repeat(900);
    while (file.length < 4_000_000) file += padding;

    const res = await fetch(`${base}/api/v1/remittances?multiple=1`, {
      method: "POST",
      headers: { "content-type": "application/edi-x12" },
      body: file,
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, JSON.stringify(body).slice(0, 500));
    assert.equal(body.count, 3, "one remittance per cheque, each with its own trace number");
    assert.deepEqual(
      body.remittances.map((r: { remittance: { paymentTotal: number } }) => r.remittance.paymentTotal).sort((a: number, b: number) => a - b),
      [10_000, 20_000, 30_000]
    );
  });
});

test("NEW-15: re-uploading the same multi-cheque file posts nothing twice", async () => {
  /**
   * Each transaction set keeps its own idempotency key, exactly as an ERA file's do. Without that,
   * "upload it again, I'm not sure it worked" — which is what a person does when a large upload is
   * slow — would double every payment in the file.
   */
  await withServer(async (base) => {
    const file = interchange([advice("0000030", 15_000), advice("0000031", 25_000)]);
    const send = () =>
      fetch(`${base}/api/v1/remittances?multiple=1`, {
        method: "POST",
        headers: { "content-type": "application/edi-x12" },
        body: file,
      }).then((r) => r.json());

    const first = (await send()) as any;
    const second = (await send()) as any;

    assert.equal(first.count, 2);
    assert.deepEqual(
      second.remittances.map((r: { remittance: { id: string } }) => r.remittance.id).sort(),
      first.remittances.map((r: { remittance: { id: string } }) => r.remittance.id).sort(),
      "the same two remittances come back, not two new ones"
    );
  });
});

test("NEW-15: an empty upload is refused with a reason, not a parse error", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/remittances`, {
      method: "POST",
      headers: { "content-type": "application/edi-x12" },
      body: "   ",
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /empty/i);
  });
});
