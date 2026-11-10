/**
 * The degraded-mode router (blueprint doc 10, risk §1.6).
 *
 * Every AI call in Mermaid goes through here, and here is where the guarantee lives: **this layer
 * never throws and never hangs.** A provider that is down, slow, rate-limited, disabled, forbidden
 * from seeing PHI, or answering in the wrong shape all produce the same thing — a result with
 * `degraded: true` and no data — and every caller has a deterministic path for that case. The AI
 * layer being unavailable must be, at worst, a missing paragraph on a screen.
 *
 * ── RETRY, AND WHY IT IS SAFE HERE SPECIFICALLY ────────────────────────────────────────────────
 * This repository has a standing rule that retries cover the connection and never the caller's
 * work, because re-running a unit of work repeats effects outside the transaction — an EDI call
 * already made, an event already published, a claim submitted twice.
 *
 * That rule is about EFFECTS, and an LLM completion has none. It reads a prompt and returns text;
 * nothing is created, nothing moves, nobody is billed twice. Re-running it is exactly as safe as
 * re-running a `SELECT`. So retrying the whole operation is correct here and would be wrong three
 * files over, and the difference is not the transport — it is whether the far side changed.
 *
 * Retries are bounded, backed off, and only ever attempted for transport-class errors. An
 * `invalid_output` is not retried by default: a model that answered in the wrong shape usually
 * answers in the wrong shape again, and a human waiting on a screen would rather have the
 * deterministic answer now than the same failure three times slower.
 */
import { logger, metrics } from "@mermaid/observability";
import type {
  DraftRequest,
  Extracted,
  ExtractRequest,
  LlmAdapter,
  LlmError,
  LlmErrorCode,
  LlmResult,
} from "./adapter.ts";
import { checkPhiPolicy, treatAsPhi, type PhiPolicy } from "./phi.ts";
import { describeSchema, parseJsonObject, validate } from "./schema.ts";
import { ProviderError, type LlmProvider, type ProviderRequest } from "./provider.ts";

export interface RouterOptions extends PhiPolicy {
  /** Null = no provider configured; every call degrades with `disabled`. The default state. */
  provider: LlmProvider | null;
  timeoutMs: number;
  /** Total attempts including the first. 1 disables retry. */
  maxAttempts: number;
  /** Backoff base; attempt n waits `backoffMs * 2^(n-1)`. Injected so tests do not sleep. */
  backoffMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Headroom added to every output budget for the model's own reasoning.
 *
 * ── WHY A BUDGET SIZED FOR THE ANSWER IS TOO SMALL ─────────────────────────────────────────────
 * On current models thinking is ON by default, and `max_tokens` is a single cap over thinking AND
 * response text together — not a cap on the answer with reasoning billed separately. A budget
 * computed from the expected answer length therefore truncates: the model spends the allowance
 * reasoning and the JSON or the paragraph is cut off mid-token.
 *
 * That failure is silent in the worst way. Truncated JSON fails the schema validator, which is an
 * `invalid_output` degrade — deliberately not retried — so the feature simply never produces
 * anything, and the log line says the answer "did not match the expected shape" rather than "we
 * asked for too few tokens". Two entirely different bugs with the same symptom.
 *
 * Nothing is billed for headroom that goes unused, so this is generous on purpose.
 */
const THINKING_HEADROOM_TOKENS = 6_000;

export class LlmRouter implements LlmAdapter {
  #options: RouterOptions;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;

  constructor(options: RouterOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => Date.now());
  }

  get name(): string {
    return this.#options.provider?.name ?? "off";
  }

  available(): boolean {
    return this.#options.provider !== null;
  }

  async draft(req: DraftRequest): Promise<LlmResult<{ text: string }>> {
    const maxChars = req.maxChars ?? 4_000;
    return this.#run(
      req.operation,
      treatAsPhi(req.containsPhi),
      req.timeoutMs,
      {
        system: req.system,
        prompt: req.prompt,
        json: false,
        // ~3 chars per token for the prose itself, so the model finishes its sentence rather than
        // being cut off mid-word and handed to a human as a "draft" — plus reasoning headroom,
        // which shares this same cap on current models. See THINKING_HEADROOM_TOKENS.
        maxOutputTokens: Math.min(4_096, Math.ceil(maxChars / 3)) + THINKING_HEADROOM_TOKENS,
      },
      (raw) => {
        const text = truncateAtWord(raw.trim(), maxChars);
        if (text === "") return { ok: false, errors: ["the provider returned no text"] };
        return { ok: true, value: { text } };
      }
    );
  }

  async extract<T>(req: ExtractRequest<T>): Promise<LlmResult<Extracted<T>>> {
    const provider = this.#options.provider;
    if (req.images && req.images.length > 0 && provider !== null && !provider.supportsImages) {
      // Refused rather than silently dropping the images and answering from the text alone — an
      // "extraction" from an image the model never saw is a confident answer about nothing.
      return this.#degrade(req.operation, {
        code: "unavailable",
        message: `the configured LLM provider (${provider.name}) cannot accept images`,
        retryable: false,
      }, 0, 0);
    }

    return this.#run(
      req.operation,
      treatAsPhi(req.containsPhi),
      req.timeoutMs,
      {
        system: req.system,
        prompt: `${req.prompt}\n\n${describeSchema(req.schema)}`,
        ...(req.images ? { images: req.images } : {}),
        json: true,
        // A transcribed insurance card plus its structured fields runs to a few hundred tokens;
        // the rest is reasoning headroom, which shares this cap. See THINKING_HEADROOM_TOKENS.
        maxOutputTokens: 2_000 + THINKING_HEADROOM_TOKENS,
      },
      (raw) => {
        const parsed = parseJsonObject(raw);
        if (!parsed.ok) return parsed;
        const checked = validate(req.schema, parsed.value);
        if (!checked.ok) return checked;
        return {
          ok: true,
          value: {
            value: checked.value,
            /**
             * Confidence is NOT asked of the model.
             *
             * A model asked "how confident are you?" answers with a number that correlates with how
             * confident it SOUNDS, not with how often it is right, and that number would then flow
             * into the verification review gate where it decides whether a human looks at a card.
             * A miscalibrated 0.95 there means a wrong member ID going to a payer unreviewed.
             *
             * So the router reports what it actually knows — the field was present and valid — and
             * leaves calibration to the caller, which has domain evidence the model does not (a
             * payer-name match against the catalog, a member ID that matches what staff typed).
             * `modules/verification/src/engine/card-vision.ts` is where that judgement happens.
             */
            perFieldConfidence: Object.fromEntries(
              Object.keys(req.schema.fields).map((field) => [
                field,
                (checked.value as Record<string, unknown>)[field] === null ? 0 : 1,
              ])
            ),
          },
        };
      }
    );
  }

  // ── the one path everything takes ───────────────────────────────────────────────────

  async #run<T>(
    operation: string,
    containsPhi: boolean,
    timeoutOverride: number | undefined,
    request: ProviderRequest,
    interpret: (raw: string) => { ok: true; value: T } | { ok: false; errors: string[] }
  ): Promise<LlmResult<T>> {
    const started = this.#now();
    metrics.inc(`llm.request.${operation}`);

    const provider = this.#options.provider;
    if (provider === null) {
      return this.#degrade(operation, {
        code: "disabled",
        message: "no LLM provider is configured (LLM_PROVIDER=off)",
        retryable: false,
      }, 0, 0);
    }

    const refusal = checkPhiPolicy(containsPhi, { phiApproved: this.#options.phiApproved });
    if (refusal) {
      // Deliberately WARN, not error: a correctly-configured deployment without a BAA hits this on
      // every patient-bearing call, and it is working as designed. It is loud enough to notice and
      // quiet enough not to bury real failures.
      logger.warn("LLM request refused by the PHI policy", { channel: "security", operation });
      return this.#degrade(operation, refusal, 0, this.#now() - started);
    }

    const timeoutMs = timeoutOverride ?? this.#options.timeoutMs;
    let attempts = 0;
    let last: LlmError = { code: "unavailable", message: "no attempt was made", retryable: false };

    while (attempts < Math.max(1, this.#options.maxAttempts)) {
      attempts += 1;
      const outcome = await this.#attempt(provider, request, timeoutMs, interpret);

      if (outcome.ok) {
        const latencyMs = this.#now() - started;
        metrics.inc(`llm.ok.${operation}`);
        logger.info("LLM request completed", {
          // No prompt, no response, no field values — ids and shape only (logger PHI rule).
          operation,
          provider: provider.name,
          model: provider.model,
          attempts,
          latencyMs,
        });
        return {
          ok: true,
          data: outcome.value,
          degraded: false,
          provider: provider.name,
          model: provider.model,
          latencyMs,
          attempts,
        };
      }

      last = outcome.error;
      if (!outcome.error.retryable || attempts >= this.#options.maxAttempts) break;
      await this.#sleep(this.#options.backoffMs * 2 ** (attempts - 1));
    }

    return this.#degrade(operation, last, attempts, this.#now() - started);
  }

  async #attempt<T>(
    provider: LlmProvider,
    request: ProviderRequest,
    timeoutMs: number,
    interpret: (raw: string) => { ok: true; value: T } | { ok: false; errors: string[] }
  ): Promise<{ ok: true; value: T } | { ok: false; error: LlmError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await provider.complete(request, controller.signal);
      const interpreted = interpret(raw);
      if (interpreted.ok) return interpreted;
      return {
        ok: false,
        error: {
          code: "invalid_output",
          // The reasons, never the output itself — the output can contain anything the model read.
          message: `the provider's answer did not match the expected shape: ${interpreted.errors.join("; ")}`,
          retryable: false,
        },
      };
    } catch (err) {
      return { ok: false, error: classify(err, controller.signal.aborted) };
    } finally {
      clearTimeout(timer);
    }
  }

  #degrade<T>(operation: string, error: LlmError, attempts: number, latencyMs: number): LlmResult<T> {
    metrics.inc("llm.degraded");
    metrics.inc(`llm.degraded.${error.code}`);
    // `disabled` is the intended resting state of an un-provisioned deployment; alerting on it
    // would page someone about a decision they made on purpose.
    if (error.code !== "disabled" && error.code !== "phi_not_permitted") {
      logger.warn("LLM degraded", {
        channel: "error",
        operation,
        code: error.code,
        attempts,
        provider: this.name,
      });
    }
    return {
      ok: false,
      error,
      degraded: true,
      provider: this.name,
      model: this.#options.provider?.model ?? null,
      latencyMs,
      attempts,
    };
  }
}

function classify(err: unknown, aborted: boolean): LlmError {
  if (err instanceof ProviderError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  // An abort is our own deadline firing, not the provider misbehaving.
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return { code: "timeout", message: "the LLM provider did not answer in time", retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "unavailable", message: `the LLM provider failed: ${message}`, retryable: true };
}

/**
 * Cut to a length without cutting a word in half.
 *
 * Matters more than it looks: the output of `draft` is prose a human is about to put their name to
 * and send to a payer. A letter that stops mid-word reads as broken software, and a biller who has
 * seen that once stops trusting the whole screen.
 */
export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

/** Codes that mean "the AI layer is not there right now", as opposed to "it answered badly". */
export const TRANSPORT_CODES: readonly LlmErrorCode[] = ["unavailable", "rate_limited", "timeout"];
