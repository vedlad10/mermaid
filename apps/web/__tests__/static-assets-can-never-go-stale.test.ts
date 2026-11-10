/**
 * A browser must never run yesterday's JavaScript against today's API.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `serveStatic` sent `app.js` with no `Cache-Control`, no `ETag` and no `Last-Modified` — no
 * freshness information of any kind. RFC 9111 permits a cache to apply its own heuristic in that
 * case, and browsers do. Chrome held the bundle in its disk cache and, with no validator, had no
 * cheap way to ask whether it had changed.
 *
 * The consequence is the nastiest shape a deploy can take: the server updates and answers with the
 * new behaviour, the browser keeps executing the old client against it, and the two halves disagree
 * in ways neither can detect. After the UI audit the deployed bundle was byte-for-byte correct —
 * 4,127 lines, every fix present — and the screens showed none of it.
 *
 * `no-cache` does not mean "do not store". It means "store, but revalidate before reuse", so an
 * unchanged asset costs a 304 with no body and a changed one can never be served stale.
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

/** Everything the browser loads and then executes. A stale one of these is a broken application. */
/* `/charts.js` is a real client asset, imported by app.js. A new static file that nobody added
   here would get none of the caching guarantees the others are held to. */
const ASSETS = ["/", "/app.js", "/charts.js"];

test("every static asset ships a validator and an instruction to revalidate", async () => {
  await withServer(async (base) => {
    for (const path of ASSETS) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${path} must serve`);

      const cacheControl = res.headers.get("cache-control");
      assert.ok(
        cacheControl,
        `${path} sent NO cache-control — a cache is then free to invent its own freshness`
      );
      assert.match(
        cacheControl,
        /no-cache|max-age=0|must-revalidate/,
        `${path} must be revalidated before reuse, got "${cacheControl}"`
      );

      const etag = res.headers.get("etag");
      assert.ok(etag, `${path} sent no ETag — the browser cannot ask whether it changed`);
      assert.match(etag, /^"[^"]+"$/, `${path} must send a strong ETag, got ${etag}`);
    }
  });
});

test("an unchanged asset revalidates to 304 with no body", async () => {
  /**
   * The other half of the trade. Revalidating on every load is only acceptable because the answer
   * is usually a bodiless 304 — if this regressed to a full 200 each time, someone would reasonably
   * "fix" it by caching harder and reintroduce the original defect.
   */
  await withServer(async (base) => {
    const first = await fetch(base + "/app.js");
    const etag = first.headers.get("etag")!;
    await first.text();

    const second = await fetch(base + "/app.js", { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304, "an unchanged bundle must revalidate cheaply");
    assert.equal(await second.text(), "", "a 304 carries no body");
  });
});

test("a CDN-weakened validator still revalidates", async () => {
  /**
   * The case that broke in production and in no test. Cloudflare compresses the response and
   * downgrades the strong ETag to `W/"..."`, so the browser returns a weak tag against the strong
   * one that was issued. Exact equality never matched, every load refetched the full 194 KB, and
   * the revalidation this whole strategy rests on did nothing at all.
   *
   * RFC 9110 §8.8.3.2 specifies WEAK comparison for If-None-Match precisely so a re-encoded but
   * semantically identical body still counts as unchanged.
   */
  await withServer(async (base) => {
    const first = await fetch(base + "/app.js");
    const strong = first.headers.get("etag")!;
    await first.text();

    const res = await fetch(base + "/app.js", { headers: { "if-none-match": `W/${strong}` } });
    assert.equal(res.status, 304, `a weak form of the same tag must revalidate (sent W/${strong})`);
  });
});

test("a stale validator is refused and the real asset is sent", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/app.js", { headers: { "if-none-match": '"not-the-current-build"' } });
    assert.equal(res.status, 200, "a mismatched ETag must produce the current bytes");
    assert.ok((await res.text()).length > 0);
  });
});

test("the ETag is derived from the bytes, so two different assets never share one", async () => {
  /**
   * A validator that is not a function of the content is worse than none: it would confirm
   * freshness for something that had changed.
   */
  await withServer(async (base) => {
    const shell = await fetch(base + "/");
    const bundle = await fetch(base + "/app.js");
    await Promise.all([shell.text(), bundle.text()]);
    assert.notEqual(
      shell.headers.get("etag"),
      bundle.headers.get("etag"),
      "different files must have different ETags"
    );
  });
});

test("health reports the build, so what is running can be checked without a deploy log", async () => {
  /**
   * `/health` answered `{ ok: true }` and nothing else, so the only way to tell whether a browser
   * was talking to new code was to grep the served bundle for a string from it.
   */
  await withServer(async (base) => {
    const h = (await (await fetch(base + "/api/v1/health")).json()) as {
      ok: boolean;
      commit?: string;
      startedAt?: string;
    };
    assert.equal(h.ok, true);
    assert.ok("commit" in h, "the running build must be reportable");
    assert.ok(typeof h.startedAt === "string", "and when this process started");
  });
});
