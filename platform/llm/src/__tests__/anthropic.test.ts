/**
 * The Anthropic provider, exercised against a fake `fetch`.
 *
 * ── WHAT THIS DOES AND DOES NOT PROVE ──────────────────────────────────────────────────────────
 * It proves the request is SHAPED correctly, that every HTTP status is classified into the right
 * retry behaviour, and that a malformed body degrades instead of crashing. It proves **nothing**
 * about whether the real API accepts this request, because no real API has ever seen it. Passing
 * these tests is not evidence of a working integration and must never be reported as one; that
 * evidence can only come from a run against the live endpoint with a real key and a signed BAA.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../providers/anthropic.ts";
import { ProviderError } from "../provider.ts";

const REQUEST = { system: "you are a tool", prompt: "hello", json: false, maxOutputTokens: 100 };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function provider(handler: (url: string, init: RequestInit) => Response | Promise<Response>): AnthropicProvider {
  return new AnthropicProvider({ apiKey: "test-key", model: "test-model", fetchImpl: fakeFetch(handler) });
}

describe("AnthropicProvider request shape", () => {
  it("sends the key, the version header and the model, and returns the text content", async () => {
    let seen: RequestInit | null = null;
    const p = provider((_url, init) => {
      seen = init;
      return ok({ content: [{ type: "text", text: "the answer" }] });
    });

    const text = await p.complete(REQUEST, new AbortController().signal);
    assert.equal(text, "the answer");

    const init = seen as unknown as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(body.system, "you are a tool");
    /**
     * ── REGRESSION: no sampling parameters ──────────────────────────────────────────────────────
     * `temperature`, `top_p` and `top_k` return a 400 on every current model. This assertion used
     * to read `temperature === 0` — it pinned the defect rather than catching it, and the request
     * would have failed on the first real call as a non-retryable error the router degrades
     * silently, so the feature would appear to be switched off. Determinism comes from the prompt
     * and the schema validator, which is a stronger guarantee than a sampling parameter anyway.
     */
    for (const param of ["temperature", "top_p", "top_k"]) {
      assert.equal(param in body, false, `${param} 400s on current models`);
    }
  });

  it("puts images before the text, which is where a vision model expects them", async () => {
    let body: Record<string, unknown> = {};
    const p = provider((_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return ok({ content: [{ type: "text", text: "{}" }] });
    });

    await p.complete(
      { ...REQUEST, images: [{ mediaType: "image/jpeg", base64: "QUJD" }] },
      new AbortController().signal
    );

    const messages = body.messages as { content: { type: string }[] }[];
    const content = messages[0]!.content;
    assert.equal(content[0]!.type, "image");
    assert.equal(content[1]!.type, "text");
  });

  it("concatenates multiple text blocks, which the API may return", async () => {
    const p = provider(() => ok({ content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }));
    assert.equal(await p.complete(REQUEST, new AbortController().signal), "part one part two");
  });

  it("refuses to be constructed without a key rather than failing later on every call", () => {
    assert.throws(() => new AnthropicProvider({ apiKey: "", model: "m" }), /API key/);
  });
});

describe("AnthropicProvider failure classification", () => {
  const cases: { status: number; code: ProviderError["code"]; retryable: boolean }[] = [
    { status: 429, code: "rate_limited", retryable: true },
    { status: 408, code: "timeout", retryable: true },
    { status: 504, code: "timeout", retryable: true },
    { status: 500, code: "unavailable", retryable: true },
    { status: 503, code: "unavailable", retryable: true },
    // Configuration faults. Retrying an unauthorized call on every screen load is how a key gets banned.
    { status: 401, code: "unavailable", retryable: false },
    { status: 400, code: "unavailable", retryable: false },
    { status: 403, code: "unavailable", retryable: false },
  ];

  for (const { status, code, retryable } of cases) {
    it(`classifies HTTP ${status} as ${code} (retryable: ${retryable})`, async () => {
      const p = provider(() => new Response("{}", { status }));
      await assert.rejects(
        () => p.complete(REQUEST, new AbortController().signal),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.code, code);
          assert.equal(err.retryable, retryable);
          return true;
        }
      );
    });
  }

  it("never puts the error body in the exception — it can echo the prompt back", async () => {
    const p = provider(() => new Response(JSON.stringify({ error: { message: "invalid input: Maria A. ABC12345" } }), { status: 400 }));
    await assert.rejects(
      () => p.complete(REQUEST, new AbortController().signal),
      (err: unknown) => {
        assert.doesNotMatch((err as Error).message, /Maria|ABC12345/);
        return true;
      }
    );
  });

  it("degrades on a body that is not JSON", async () => {
    const p = provider(() => new Response("<html>gateway error</html>", { status: 200 }));
    await assert.rejects(() => p.complete(REQUEST, new AbortController().signal), /not JSON/);
  });

  it("degrades on a well-formed body carrying no text", async () => {
    const p = provider(() => ok({ content: [{ type: "tool_use", id: "x" }] }));
    await assert.rejects(() => p.complete(REQUEST, new AbortController().signal), /no text content/);
  });

  it("treats a transport throw as unavailable and retryable", async () => {
    const p = provider(() => {
      throw new Error("ECONNRESET");
    });
    await assert.rejects(
      () => p.complete(REQUEST, new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, "unavailable");
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  it("lets an abort propagate unchanged, so the router can call it a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = provider(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    await assert.rejects(
      () => p.complete(REQUEST, controller.signal),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        assert.ok(!(err instanceof ProviderError));
        return true;
      }
    );
  });
});
