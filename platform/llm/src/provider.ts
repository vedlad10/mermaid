/**
 * What a vendor implementation has to do — and, more importantly, what it does NOT have to do.
 *
 * A provider takes a prompt and returns text. That is the whole job. Timeouts, retries, schema
 * validation, PHI enforcement, degradation, metrics and logging all live in the router, so that
 * they are identical for every vendor and cannot be forgotten by the next one added. A provider
 * that implemented its own retry policy would be a provider whose failure behaviour nobody has
 * tested.
 *
 * Adding a vendor: write `providers/<name>.ts`, register it in `index.ts`, set `LLM_PROVIDER=<name>`.
 * Nothing else in Mermaid changes — that is the point of the seam (blueprint doc 10).
 */

export interface ProviderRequest {
  system: string;
  prompt: string;
  images?: { mediaType: string; base64: string }[];
  /** Ask for JSON. Providers that support a structured-output mode should use it. */
  json: boolean;
  maxOutputTokens: number;
}

/**
 * Thrown by a provider to tell the router how to treat a failure.
 *
 * Providers should raise this rather than a bare `Error` whenever they can classify: a 429 is
 * retryable and a 400 is not, and the router cannot tell them apart from a message string.
 */
export class ProviderError extends Error {
  code: "unavailable" | "rate_limited" | "timeout" | "invalid_output";
  retryable: boolean;
  constructor(code: ProviderError["code"], message: string, retryable = code !== "invalid_output") {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LlmProvider {
  readonly name: string;
  /** The model identifier, for provenance. Null when the provider is not a model at all. */
  readonly model: string | null;
  /** Whether this provider can accept images. The router refuses image requests when false. */
  readonly supportsImages: boolean;
  /**
   * Run one completion. MUST honour `signal` — the router's timeout is only real if the provider
   * actually aborts, otherwise a hung socket holds a request open past its deadline.
   */
  complete(req: ProviderRequest, signal: AbortSignal): Promise<string>;
}
