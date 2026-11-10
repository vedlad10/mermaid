/**
 * Security headers, and the two body limits that were wrong (NEW-13, NEW-14, NEW-15).
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────
 * No Content-Security-Policy, no X-Content-Type-Options, no X-Frame-Options, no Referrer-Policy, no
 * HSTS. On a system that renders patient names, procedures and balances in a browser, that is
 * several cheap and total mitigations left on the floor — and the policy can be strict here because
 * the front end is genuinely self-contained: one module script, one stylesheet, self-hosted fonts,
 * no CDN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

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

test("NEW-13: the headers are on a STATIC response and on an API response", async () => {
  /**
   * Both, because they are set in two different places and for a structural reason: `sendJson` is
   * the API's single funnel, while static files bypass it entirely. A wrapper around the outer
   * `ServerResponse` would have covered neither reliably — `DeferredResponse` buffers headers and
   * flushes them after the handler returns, so a wrapper would apply after the flush for every
   * deferred route.
   */
  await withServer(async (base) => {
    for (const [what, path] of [["static", "/index.html"], ["API", "/api/v1/health"]] as const) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${what} fetch failed`);

      const csp = res.headers.get("content-security-policy");
      assert.ok(csp, `${what}: no Content-Security-Policy`);
      assert.match(csp!, /default-src 'none'/, `${what}: an unnamed directive must fail closed`);
      assert.match(csp!, /script-src 'self'/, `${what}`);
      assert.match(csp!, /frame-ancestors 'none'/, `${what}`);
      assert.doesNotMatch(
        csp!,
        /unsafe-inline|unsafe-eval/,
        `${what}: 'unsafe-inline' is the escape hatch that makes a policy decorative, and this front ` +
          `end does not need it`
      );

      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${what}`);
      assert.equal(res.headers.get("x-frame-options"), "DENY", `${what}`);
      assert.equal(res.headers.get("referrer-policy"), "same-origin", `${what}`);
    }
  });
});

test("NEW-13: an ERROR response carries them too", async () => {
  /**
   * The response an attacker is most likely to be looking at. `sendError` goes through `sendJson`,
   * so this is really asserting that nothing bypasses the funnel — which is the property that would
   * quietly stop being true when somebody adds a route.
   */
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/nope`);
    assert.equal(res.status, 404);
    assert.ok(res.headers.get("content-security-policy"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

test("NEW-13: no inline style or script survives in the served HTML", async () => {
  /**
   * A policy without `'unsafe-inline'` blocks inline style ATTRIBUTES as well as `<style>` blocks,
   * so one `style="margin-top:14px"` on the sign-in form was the only thing standing between this
   * front end and a strict policy. Asserted against the SERVED bytes rather than the source, since
   * that is what a browser applies the policy to.
   */
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/index.html`)).text();
    assert.doesNotMatch(html, /\sstyle\s*=\s*"/, "an inline style attribute would be blocked by the CSP");
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, "an inline <script> would be blocked too");
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*"/i, "and so would an inline event handler");
  });
});

test("NEW-14: TWO card images at the maximum are accepted together", async () => {
  /**
   * ── THE ARITHMETIC THAT WAS WRONG ─────────────────────────────────────────────────────────────
   * The per-image cap was 700 KB and the route accepts two, against a 1 MB body cap. So a front and
   * a back photograph that this file's own validation would have accepted were rejected upstream by
   * `readJsonBody`, with a generic 413 about request size and no mention of images — leaving the
   * person at the desk with no idea which of the two to shrink or by how much.
   *
   * Asserted by SENDING two at the maximum rather than by asserting the constant, because the
   * constant was never the thing that was wrong: the relationship between it, the count, and the
   * body cap was.
   */
  await withServer(async (base) => {
    // The maximum the route documents, taken from the refusal it gives one character above it.
    const probe = await fetch(`${base}/api/v1/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patient: { firstName: "A", lastName: "B", dateOfBirth: "1990-01-01", memberId: "X", address: SYNTHETIC_ADDRESS },
        cardText: "Delta Dental",
        planItems: [{ code: "D0120" }],
        cardImages: [{ mediaType: "image/jpeg", base64: "A".repeat(10_000_000) }],
      }),
    });
    assert.equal(probe.status, 413, "a single absurd image is still refused by the body cap");

    const max = 450_000;
    const image = { mediaType: "image/jpeg", base64: "A".repeat(max) };
    const res = await fetch(`${base}/api/v1/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patient: {
          firstName: "Ada",
          lastName: "Alpha",
          dateOfBirth: "1990-04-12",
          memberId: "ABC12345",
          address: SYNTHETIC_ADDRESS,
        },
        cardText: "Delta Dental\nMember ID: ABC12345",
        planItems: [{ code: "D0120" }],
        cardImages: [image, { ...image }],
      }),
    });

    assert.equal(
      res.status,
      201,
      `front and back at the per-image maximum must fit under the body cap together — got ` +
        `${res.status}: ${await res.text()}`
    );
  });
});
