/**
 * The router's contract, which is mostly a contract about FAILURE.
 *
 * The property every one of these tests is really defending: **no call into this layer can throw,
 * hang, or return data that was not validated.** Every AI feature in Mermaid is written on the
 * assumption that a degrade is survivable and an exception is impossible, and that assumption is
 * only true if it is tested here rather than remembered at each call site.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "@mermaid/observability";
import { LlmRouter } from "../router.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import { schema, type ObjectSchema } from "../adapter.ts";

interface Fields {
  payer: string | null;
  memberId: string | null;
}

const FIELDS: ObjectSchema<Fields> = schema<Fields>({
  payer: { kind: "string", nullable: true },
  memberId: { kind: "string", nullable: true },
});

/** No sleeping in tests; retry timing is asserted by call count, not by wall clock. */
const noSleep = async (): Promise<void> => {};

function router(provider: ScriptedProvider | null, over: Partial<ConstructorParameters<typeof LlmRouter>[0]> = {}) {
  return new LlmRouter({
    provider,
    phiApproved: true,
    timeoutMs: 50,
    maxAttempts: 2,
    backoffMs: 1,
    sleep: noSleep,
    ...over,
  });
}

beforeEach(() => metrics.reset());

describe("the off state", () => {
  it("is a supported state, not a stub: it degrades and never throws", async () => {
    const result = await router(null).draft({ operation: "t", system: "s", prompt: "p", containsPhi: false });
    assert.equal(result.ok, false);
    assert.equal(result.degraded, true);
    assert.equal(result.error?.code, "disabled");
    assert.equal(result.error?.retryable, false);
    assert.equal(result.provider, "off");
  });

  it("reports itself unavailable, so the UI can decline to offer AI at all", () => {
    assert.equal(router(null).available(), false);
    assert.equal(router(new ScriptedProvider({ replies: [{ kind: "text", text: "x" }] })).available(), true);
  });

  it("degrades extraction too, with no data attached", async () => {
    const result = await router(null).extract({ operation: "t", system: "s", prompt: "p", schema: FIELDS });
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
  });
});

describe("the PHI gate", () => {
  it("refuses a PHI-bearing request when the environment has not approved a provider for PHI", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "should never be reached" }] });
    const result = await router(provider, { phiApproved: false }).draft({
      operation: "t",
      system: "s",
      prompt: "Maria A., member ABC12345",
      containsPhi: true,
    });
    assert.equal(result.error?.code, "phi_not_permitted");
    assert.equal(result.error?.retryable, false);
    // The point of the gate: the provider was never called.
    assert.equal(provider.calls.length, 0);
  });

  it("treats an UNSET containsPhi as PHI — the unsafe default must not be the quiet one", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "x" }] });
    const result = await router(provider, { phiApproved: false }).draft({ operation: "t", system: "s", prompt: "p" });
    assert.equal(result.error?.code, "phi_not_permitted");
    assert.equal(provider.calls.length, 0);
  });

  it("allows a non-PHI request through even when PHI is not approved", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "fine" }] });
    const result = await router(provider, { phiApproved: false }).draft({
      operation: "t",
      system: "s",
      prompt: "explain CARC 29",
      containsPhi: false,
    });
    assert.equal(result.ok, true);
    assert.equal(provider.calls.length, 1);
  });
});

describe("failure handling", () => {
  it("retries a rate limit and succeeds on the second attempt", async () => {
    const provider = new ScriptedProvider({
      replies: [{ kind: "error", code: "rate_limited" }, { kind: "text", text: "second time lucky" }],
    });
    const result = await router(provider).draft({ operation: "t", system: "s", prompt: "p", containsPhi: false });
    assert.equal(result.ok, true);
    assert.equal(result.data?.text, "second time lucky");
    assert.equal(result.attempts, 2);
  });

  it("stops at maxAttempts and degrades rather than retrying forever", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "error", code: "unavailable" }] });
    const result = await router(provider, { maxAttempts: 3 }).draft({
      operation: "t", system: "s", prompt: "p", containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.degraded, true);
    assert.equal(provider.calls.length, 3);
  });

  it("does NOT retry a non-retryable provider error, so a bad key is not hammered", async () => {
    const provider = new ScriptedProvider({
      replies: [{ kind: "error", code: "unavailable", message: "HTTP 401", retryable: false }],
    });
    const result = await router(provider, { maxAttempts: 3 }).draft({
      operation: "t", system: "s", prompt: "p", containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(provider.calls.length, 1);
  });

  it("aborts a hung provider at the deadline instead of holding the request open", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "hang" }] });
    const result = await router(provider, { timeoutMs: 20, maxAttempts: 1 }).draft({
      operation: "t", system: "s", prompt: "p", containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "timeout");
  });

  it("turns an arbitrary thrown value into a degrade, never an exception", async () => {
    const provider: ScriptedProvider = Object.assign(
      new ScriptedProvider({ replies: [{ kind: "text", text: "x" }] }),
      {
        complete: async (): Promise<string> => {
          throw "a string, not an Error";
        },
      }
    );
    const result = await router(provider).draft({ operation: "t", system: "s", prompt: "p", containsPhi: false });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "unavailable");
  });
});

describe("malformed vendor responses", () => {
  it("degrades on output that does not match the schema, and never returns a partial guess", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: '{"payer":"Delta"}' }] });
    const result = await router(provider).extract({
      operation: "t", system: "s", prompt: "p", schema: FIELDS, containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_output");
    assert.equal(result.data, undefined);
  });

  it("does not retry invalid output — the same prompt usually produces the same wrong shape", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "not json at all" }] });
    await router(provider, { maxAttempts: 3 }).extract({
      operation: "t", system: "s", prompt: "p", schema: FIELDS, containsPhi: false,
    });
    assert.equal(provider.calls.length, 1);
  });

  it("keeps the offending output OUT of the error message — it can contain anything the model read", async () => {
    const provider = new ScriptedProvider({
      replies: [{ kind: "text", text: '{"payer":"Delta","memberId":"ABC12345","dob":"1990-04-12"}' }],
    });
    const strict = schema<{ payer: string; memberId: string; extra: string }>({
      payer: { kind: "string" },
      memberId: { kind: "string" },
      extra: { kind: "string" },
    });
    const result = await router(provider).extract({
      operation: "t", system: "s", prompt: "p", schema: strict, containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error?.message ?? "", /ABC12345|1990-04-12/);
  });

  it("degrades on an empty draft rather than handing a human a blank letter", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "   \n  " }] });
    const result = await router(provider, { maxAttempts: 1 }).draft({
      operation: "t", system: "s", prompt: "p", containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "invalid_output");
  });
});

describe("extraction shape", () => {
  it("validates, then reports which fields were actually present", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: '{"payer":"Delta Dental","memberId":null}' }] });
    const result = await router(provider).extract({
      operation: "t", system: "s", prompt: "p", schema: FIELDS, containsPhi: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.data?.value.payer, "Delta Dental");
    assert.equal(result.data?.value.memberId, null);
    assert.equal(result.data?.perFieldConfidence.payer, 1);
    assert.equal(result.data?.perFieldConfidence.memberId, 0);
  });

  it("appends the schema description to the prompt, so field names are the contract", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: '{"payer":"D","memberId":"1"}' }] });
    await router(provider).extract({ operation: "t", system: "s", prompt: "read it", schema: FIELDS, containsPhi: false });
    assert.match(provider.calls[0]!.prompt, /read it/);
    assert.match(provider.calls[0]!.prompt, /"memberId"/);
    assert.equal(provider.calls[0]!.json, true);
  });

  it("refuses images to a text-only provider rather than answering from the text alone", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "{}" }], supportsImages: false });
    const result = await router(provider).extract({
      operation: "t",
      system: "s",
      prompt: "p",
      schema: FIELDS,
      images: [{ mediaType: "image/png", base64: "AAAA" }],
      containsPhi: false,
    });
    assert.equal(result.ok, false);
    assert.equal(provider.calls.length, 0);
  });

  it("passes images through to a provider that supports them", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: '{"payer":"D","memberId":"1"}' }] });
    await router(provider).extract({
      operation: "t",
      system: "s",
      prompt: "p",
      schema: FIELDS,
      images: [{ mediaType: "image/png", base64: "AAAA" }],
      containsPhi: false,
    });
    assert.equal(provider.calls[0]!.images?.length, 1);
  });
});

describe("drafting", () => {
  it("truncates at a word boundary — a letter that stops mid-word reads as broken software", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "alpha beta gamma delta epsilon" }] });
    const result = await router(provider).draft({
      operation: "t", system: "s", prompt: "p", maxChars: 14, containsPhi: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.data?.text, "alpha beta");
  });

  it("leaves text shorter than the ceiling untouched", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "short enough" }] });
    const result = await router(provider).draft({
      operation: "t", system: "s", prompt: "p", maxChars: 500, containsPhi: false,
    });
    assert.equal(result.data?.text, "short enough");
  });
});

describe("observability", () => {
  it("meters every degrade, and by cause — sustained degradation is the alertable condition", async () => {
    await router(null).draft({ operation: "digest", system: "s", prompt: "p", containsPhi: false });
    assert.equal(metrics.get("llm.degraded"), 1);
    assert.equal(metrics.get("llm.degraded.disabled"), 1);
    assert.equal(metrics.get("llm.request.digest"), 1);
  });

  it("meters success separately, so a degradation RATE is computable", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "ok" }] });
    await router(provider).draft({ operation: "digest", system: "s", prompt: "p", containsPhi: false });
    assert.equal(metrics.get("llm.ok.digest"), 1);
    assert.equal(metrics.get("llm.degraded"), 0);
  });

  it("carries provenance on every result, for the audit record the caller writes", async () => {
    const provider = new ScriptedProvider({ replies: [{ kind: "text", text: "ok" }], model: "test-model-1" });
    const result = await router(provider).draft({ operation: "t", system: "s", prompt: "p", containsPhi: false });
    assert.equal(result.provider, "scripted");
    assert.equal(result.model, "test-model-1");
    assert.equal(result.attempts, 1);
    assert.equal(typeof result.latencyMs, "number");
  });
});
