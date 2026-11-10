/**
 * The full stack over a REAL socket: `LlmRouter` → `AnthropicProvider` → `fetch` → `node:http`.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE FAKE-FETCH TESTS ─────────────────────────────────────────────
 * A stubbed `fetch` proves the request is shaped correctly and that statuses are classified. It
 * cannot prove the things that only exist on a network: that `AbortSignal` actually tears down an
 * in-flight connection, that a server which accepts and then never responds is cut off at the
 * deadline rather than held open, that a connection refused outright is classified as retryable
 * transport, and that a truncated body surfaces as a degrade instead of an unhandled rejection.
 *
 * Those are the failure modes a clinic will actually meet at 4pm on a Friday, and they are exactly
 * the ones a fake cannot reach.
 *
 * ── WHAT THIS STILL DOES NOT PROVE ─────────────────────────────────────────────────────────────
 * That the real Anthropic API accepts this request. The server below speaks the response *shape*,
 * because that is what the client parses; it is not the vendor and cannot stand in for them.
 * Passing this file is not evidence of a working vendor integration and must never be reported as
 * one. See `platform/llm/README.md` — that evidence needs a real key and a signed BAA.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LlmRouter } from "../router.ts";
import { AnthropicProvider } from "../providers/anthropic.ts";

/** How the next request should be answered. Set per test. */
type Behaviour =
  | { kind: "ok"; text: string }
  | { kind: "status"; code: number }
  | { kind: "silent" }
  | { kind: "truncated" };

let behaviour: Behaviour = { kind: "ok", text: "{}" };
let server: Server;
let endpoint: string;
/** Set by the server when the client hangs up on it — the observable proof that abort reached the wire. */
let clientAborted = false;
/**
 * Resolved by the server the instant it observes that hang-up.
 *
 * Tests await THIS rather than sleeping. How long the OS takes to deliver a socket-close event to a
 * listener is a property of the machine's load, not of the code under test, so any fixed duration is
 * either a flake on a busy machine or dead time on an idle one. Re-armed at the start of every
 * request so a test never observes the previous test's abort.
 */
let abortObserved: Promise<void> = new Promise<void>(() => {});
let observeAbort: () => void = () => {};
let lastBody = "";

before(async () => {
  server = createServer((req, res) => {
    clientAborted = false;
    abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastBody = Buffer.concat(chunks).toString("utf8");
      const current = behaviour;

      if (current.kind === "status") {
        res.writeHead(current.code, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no" } }));
        return;
      }
      if (current.kind === "truncated") {
        // Headers and a partial body, then the socket dies mid-response.
        res.writeHead(200, { "content-type": "application/json", "content-length": "200" });
        res.write('{"content":[{"type":"text","tex');
        res.destroy();
        return;
      }
      if (current.kind === "silent") {
        // Accept the request and never answer. The router's deadline is the only thing that ends it.
        res.on("close", () => {
          clientAborted = true;
          observeAbort();
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: current.text }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function router(over: { timeoutMs?: number; maxAttempts?: number; endpoint?: string } = {}) {
  return new LlmRouter({
    provider: new AnthropicProvider({
      apiKey: "test-key",
      model: "test-model",
      endpoint: over.endpoint ?? endpoint,
    }),
    phiApproved: true,
    timeoutMs: over.timeoutMs ?? 3_000,
    maxAttempts: over.maxAttempts ?? 1,
    backoffMs: 1,
    sleep: async () => {},
  });
}

/**
 * Wait for the server to observe the hang-up, instead of guessing how long it will take.
 *
 * The ceiling exists so that a genuine leak — an abort that never reaches the wire — FAILS with a
 * sentence naming the problem, rather than hanging the suite until the runner gives up. It is not a
 * timing assumption: when abort works the wait ends in single-digit milliseconds and the ceiling is
 * never approached, so raising it costs nothing. A sleep pays its cost on every run and still
 * guesses wrong under load.
 */
async function waitForAbortObserved(timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      abortObserved,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the server never observed the hang-up within ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const DRAFT = { operation: "transport_test", system: "s", prompt: "p", containsPhi: false } as const;

describe("over a real socket", () => {
  it("completes a drafting round trip end to end", async () => {
    behaviour = { kind: "ok", text: "a paragraph that came back over TCP" };
    const result = await router().draft(DRAFT);

    assert.equal(result.ok, true);
    assert.equal(result.data?.text, "a paragraph that came back over TCP");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "test-model");

    // And the server really received the request this client claims to build.
    const body = JSON.parse(lastBody) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    // No sampling parameters — they 400 on every current model. This assertion previously read
    // `temperature === 0`, which pinned exactly the bug it should have caught.
    assert.equal("temperature" in body, false);
  });

  it("completes an extraction round trip, schema-validated", async () => {
    behaviour = { kind: "ok", text: '{"payer":"Delta Dental","memberId":"ABC12345"}' };
    const result = await router().extract({
      operation: "transport_test",
      system: "s",
      prompt: "p",
      containsPhi: false,
      schema: {
        fields: {
          payer: { kind: "string", nullable: true },
          memberId: { kind: "string", nullable: true },
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal((result.data?.value as { payer: string }).payer, "Delta Dental");
  });

  it("puts the actual image bytes on the wire, in the shape the vision API expects", async () => {
    // ── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────────────────────
    // It proves the uploaded image survives the whole client path — card-vision → router →
    // provider → HTTP body — base64 intact, correct media type, image block before the text block,
    // and reaches a server as a real request. It does NOT prove Anthropic accepts it: the server
    // below speaks the response shape, not the vendor's semantics. See this file's header.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    behaviour = { kind: "ok", text: '{"payer":"Moda Health","memberId":"J01234567"}' };

    const result = await router().extract({
      operation: "card_extraction",
      system: "read the card",
      prompt: "Read this insurance card.",
      images: [{ mediaType: "image/png", base64: png }],
      containsPhi: false,
      schema: {
        fields: { payer: { kind: "string", nullable: true }, memberId: { kind: "string", nullable: true } },
      },
    });
    assert.equal(result.ok, true);

    const body = JSON.parse(lastBody) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: { type: string; source?: { type: string; media_type: string; data: string } }[] }[];
      temperature?: unknown;
    };
    const content = body.messages[0]!.content;

    // The image goes first — where a vision model expects it — and the bytes are unaltered.
    assert.equal(content[0]!.type, "image");
    assert.equal(content[0]!.source!.type, "base64");
    assert.equal(content[0]!.source!.media_type, "image/png");
    assert.equal(content[0]!.source!.data, png, "the uploaded bytes must reach the wire unmodified");
    assert.equal(content[1]!.type, "text");

    // ── REGRESSION: no sampling parameters ────────────────────────────────────────────────────
    // `temperature` is rejected with a 400 on every current model. An earlier version sent
    // `temperature: 0`; it would have failed on the first real call, as a non-retryable error the
    // router degrades silently — so card reading would never work and the log would blame the API.
    assert.equal("temperature" in body, false, "temperature 400s on current models");
    assert.equal("top_p" in body, false);
    assert.equal("top_k" in body, false);

    // ── REGRESSION: room for reasoning ────────────────────────────────────────────────────────
    // Thinking is on by default and shares `max_tokens` with the response. A budget sized for the
    // JSON alone truncates it, which fails the schema validator as `invalid_output` — a degrade
    // that is deliberately never retried, so the feature silently produces nothing.
    assert.ok(body.max_tokens >= 6_000, `max_tokens must leave room for thinking (got ${body.max_tokens})`);
  });

  it("ABORTS a connection the server never answers, instead of holding it open", async () => {
    behaviour = { kind: "silent" };
    const started = Date.now();
    const result = await router({ timeoutMs: 300 }).draft(DRAFT);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "timeout");
    assert.ok(elapsed < 2_500, `the deadline must end it, not the server (took ${elapsed}ms)`);

    // The load-bearing assertion: the SERVER observed the hang-up. A timeout that only rejects the
    // promise while the socket stays open leaks a connection per call, and under a slow provider
    // that is how a process runs out of sockets rather than merely running slowly.
    await waitForAbortObserved();
    assert.equal(clientAborted, true, "the abort must reach the wire, not just the caller");
  });

  it("classifies a connection refused as retryable transport, and retries", async () => {
    // Port 1 on loopback: nothing listens, and the OS refuses immediately.
    const result = await router({ endpoint: "http://127.0.0.1:1/v1/messages", maxAttempts: 2 }).draft(DRAFT);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "unavailable");
    assert.equal(result.attempts, 2, "a refused connection is worth one more try");
    assert.equal(result.degraded, true);
  });

  it("degrades on a response truncated mid-body rather than throwing", async () => {
    behaviour = { kind: "truncated" };
    const result = await router().draft(DRAFT);
    assert.equal(result.ok, false);
    assert.equal(result.degraded, true);
    // Never an unhandled rejection, and never partial JSON treated as an answer.
    assert.equal(result.data, undefined);
  });

  it("retries a real 429 and succeeds on the second attempt", async () => {
    let served = 0;
    behaviour = { kind: "status", code: 429 };
    const flipping = new LlmRouter({
      provider: new AnthropicProvider({
        apiKey: "k",
        model: "m",
        endpoint,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          served += 1;
          if (served > 1) behaviour = { kind: "ok", text: "recovered" };
          return fetch(url as string, init);
        }) as typeof fetch,
      }),
      phiApproved: true,
      timeoutMs: 3_000,
      maxAttempts: 3,
      backoffMs: 1,
      sleep: async () => {},
    });

    const result = await flipping.draft(DRAFT);
    assert.equal(result.ok, true);
    assert.equal(result.data?.text, "recovered");
    assert.equal(result.attempts, 2);
  });

  it("does not retry a real 401 — a bad key must not be hammered on every screen load", async () => {
    behaviour = { kind: "status", code: 401 };
    const result = await router({ maxAttempts: 3 }).draft(DRAFT);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
  });

  it("refuses a PHI-bearing request before opening a socket at all", async () => {
    behaviour = { kind: "ok", text: "should never be reached" };
    const strict = new LlmRouter({
      provider: new AnthropicProvider({ apiKey: "k", model: "m", endpoint }),
      phiApproved: false,
      timeoutMs: 3_000,
      maxAttempts: 1,
      backoffMs: 1,
      sleep: async () => {},
    });

    lastBody = "";
    const result = await strict.draft({ ...DRAFT, containsPhi: true, prompt: "Maria A., member ABC12345" });
    assert.equal(result.error?.code, "phi_not_permitted");
    assert.equal(lastBody, "", "no PHI-bearing request may reach the network");
  });
});
