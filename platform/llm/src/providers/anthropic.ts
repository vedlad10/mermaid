/**
 * Anthropic Messages API provider.
 *
 * ── EXTERNALLY GATED ───────────────────────────────────────────────────────────────────────────
 * This code is complete and unit-tested against a fake `fetch`, but it has **never been exercised
 * against the real API** in this repository, and it must not be described as a working integration
 * until someone does that with a real key. Activating it requires, in order:
 *
 *   1. A signed BAA with Anthropic covering the exact endpoint used here. Not every endpoint is
 *      HIPAA-eligible, and "the vendor offers BAAs" is not the same as "this deployment has one"
 *      (risk §4, blocker #1 in SESSION_CHECKPOINT).
 *   2. `LLM_API_KEY` provisioned through the deployment's secret store — never a `.env` on a laptop
 *      that has touched real patient data.
 *   3. `LLM_PROVIDER=anthropic`.
 *   4. `LLM_PHI_APPROVED=1` — separately, deliberately, and only after (1). Without it every
 *      patient-bearing call degrades and the deterministic paths carry the day's work, which is the
 *      correct behaviour for a deployment whose paperwork is not finished.
 *
 * Written with `fetch` and no SDK, consistent with this repository's single-runtime-dependency
 * posture: an SDK here would be a transitive dependency tree sitting on the PHI boundary.
 */
import { ProviderError, type LlmProvider, type ProviderRequest } from "../provider.ts";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly supportsImages = true;
  #apiKey: string;
  #fetch: typeof fetch;
  #endpoint: string;

  constructor(options: AnthropicOptions) {
    if (!options.apiKey) throw new Error("AnthropicProvider requires an API key (LLM_API_KEY)");
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#endpoint = options.endpoint ?? ENDPOINT;
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<string> {
    const content: unknown[] = [];
    for (const image of req.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
    }
    content.push({ type: "text", text: req.prompt });

    /**
     * ── NO `temperature` ────────────────────────────────────────────────────────────────────────
     * This request deliberately carries no sampling parameters.
     *
     * An earlier version sent `temperature: 0`, reasoning that extraction and drafting are jobs
     * where two runs should agree. That reasoning was fine and the parameter is now **rejected**:
     * `temperature`, `top_p` and `top_k` return a 400 on every current model (Opus 5, Sonnet 5,
     * Opus 4.8, 4.7). It would have failed on the first real call — and failed as a non-retryable
     * `unavailable`, which the router degrades silently, so card reading would simply never work
     * and the logs would say "the API rejected the request (HTTP 400)".
     *
     * Determinism now comes from the prompt and from the schema validator, which is where it
     * belonged anyway: a validator that refuses a wrong-shaped answer is a stronger guarantee than
     * a sampling parameter ever was.
     */
    const body = {
      model: this.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [{ role: "user", content }],
    };

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Let the router classify aborts; anything else is transport.
      if (signal.aborted) throw err;
      throw new ProviderError("unavailable", err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) throw await httpError(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("invalid_output", "the API returned a body that was not JSON");
    }

    const text = textOf(payload);
    if (text === null) throw new ProviderError("invalid_output", "the API response carried no text content");
    return text;
  }
}

async function httpError(response: Response): Promise<ProviderError> {
  // The body may echo the prompt back in an error message, so it is never read into an exception
  // that will be logged. The status is the whole diagnosis we are allowed to keep.
  const status = response.status;
  if (status === 429) return new ProviderError("rate_limited", "the API rate-limited this request");
  if (status === 408 || status === 504) return new ProviderError("timeout", `the API timed out (HTTP ${status})`);
  if (status >= 500) return new ProviderError("unavailable", `the API is unavailable (HTTP ${status})`);
  // 400/401/403 are configuration faults — a bad key or a malformed request. Retrying an
  // unauthorized call every time a biller opens a screen is how a key gets rate-limited into a ban.
  return new ProviderError("unavailable", `the API rejected the request (HTTP ${status})`, false);
}

function textOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b): b is ContentBlock => typeof b === "object" && b !== null && (b as ContentBlock).type === "text")
    .map((b) => b.text ?? "");
  const joined = parts.join("").trim();
  return joined === "" ? null : joined;
}
