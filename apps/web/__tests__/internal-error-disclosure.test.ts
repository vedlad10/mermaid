/**
 * An unexpected error tells the caller that it failed, and nothing else.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The catch-all sent `err.message` straight to the client. Every other branch of `sendDomainError`
 * returns a message written DELIBERATELY for whoever made the request — a scrub refusal, a filing
 * block, a payer's own wording — and those are exactly right. This branch is the opposite: it is
 * reached only when nothing anticipated the failure, so nobody has decided what the message says.
 *
 * What lands there is whatever threw: a Postgres constraint name, a driver's description of the
 * schema, a JSON parse error quoting the fragment it choked on. And it is reachable UNAUTHENTICATED,
 * because `dispatch` runs public routes through `handleApi` with a null session — so a failure on
 * the login or password-reset path answered a stranger with the internals.
 *
 * That contradicts the care taken a few functions away, where password reset is written so it never
 * reveals whether an address is on file. A 500 that volunteers a table name gives up more than that
 * endpoint withholds.
 *
 * ── WHAT THESE TESTS PIN ───────────────────────────────────────────────────────────────────────
 * That the internals stay in, and the trace id comes out. The reference is the half that makes the
 * refusal usable rather than merely silent: it is what support asks for, and it ties the caller's
 * complaint to the log line and the audit row that already carry it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.ts";
import { buildServices } from "../wiring.ts";

/** A secret an unexpected failure might carry: a schema detail no caller should learn. */
const INTERNAL = 'duplicate key value violates unique constraint "patients_member_id_practice_key"';

async function requestAgainst(services: unknown, path: string): Promise<{ status: number; body: string }> {
  const app = createApp(services as never);
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

/** Services whose every read throws the way an unanticipated infrastructure failure would. */
function exploding() {
  const services = buildServices({ inMemory: true });
  return new Proxy(services as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "persistent") return false;
      const value = target[prop as string];
      if (value && typeof value === "object") {
        return new Proxy(value, {
          get() {
            return () => {
              throw new Error(INTERNAL);
            };
          },
        });
      }
      return value;
    },
  });
}

test("an unexpected failure does not hand the caller the internals", async () => {
  const { status, body } = await requestAgainst(exploding(), "/api/v1/claims");

  assert.equal(status >= 400, true, `expected a failure status, got ${status}`);
  assert.doesNotMatch(body, /duplicate key value/, "the driver's own words must not travel");
  assert.doesNotMatch(body, /patients_member_id_practice_key/, "nor a constraint naming a column");
  assert.doesNotMatch(body, /unique constraint/i);
});

test("it hands back a reference instead, so the failure is still traceable", async () => {
  const { body } = await requestAgainst(exploding(), "/api/v1/claims");

  /**
   * Silence alone would be worse than the leak in one respect: a caller who cannot quote anything
   * cannot get the failure looked at. The id is already generated per request for the audit row, so
   * returning it costs nothing and ties the complaint to the log line.
   */
  assert.match(body, /reference [0-9a-f-]{36}/i, `no traceable reference in: ${body.slice(0, 200)}`);
});

test("the envelope stays the documented shape", async () => {
  /** Doc 06: `{ error: { code, message } }`. A client parsing failures must not have to special-case. */
  const { body } = await requestAgainst(exploding(), "/api/v1/claims");
  const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
  assert.equal(parsed.error?.code, "internal_error");
  assert.ok((parsed.error?.message ?? "").length > 0);
});

test("a deliberate, caller-facing error still says what it says", async () => {
  /**
   * The change must not have flattened every failure into the generic one. Asking for a claim that
   * does not exist is ANTICIPATED — the message is written for the caller, and a reference number
   * in place of "no such claim" would be a worse answer, not a safer one.
   */
  const { status, body } = await requestAgainst(buildServices({ inMemory: true }), "/api/v1/claims/no-such-claim");
  assert.equal(status, 404, body);
  assert.doesNotMatch(body, /reference [0-9a-f-]{36}/i, "a known refusal needs no incident id");
  assert.match(body, /not_found|not found/i);
});
