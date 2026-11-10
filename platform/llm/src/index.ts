/**
 * @mermaid/llm — public surface. Consumers call `getLlmAdapter()` and depend only on the interface;
 * the concrete provider is selected by `LLM_PROVIDER` config, exactly as `EDI_ADAPTER` selects the
 * clearinghouse (blueprint docs 09, 10).
 *
 * The default is `off`, and `off` is a real, supported, tested state — not a stub. Every AI feature
 * degrades to its deterministic path, and the revenue cycle is unaffected. That is what makes it
 * safe to ship AI features before a BAA exists.
 */
import { getConfig } from "@mermaid/config";
import type { LlmAdapter } from "./adapter.ts";
import { LlmRouter } from "./router.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { LlmProvider } from "./provider.ts";

export * from "./adapter.ts";
export { LlmRouter, truncateAtWord, TRANSPORT_CODES, type RouterOptions } from "./router.ts";
export { ProviderError, type LlmProvider, type ProviderRequest } from "./provider.ts";
export { checkPhiPolicy, treatAsPhi, type PhiPolicy } from "./phi.ts";
export { describeSchema, parseJsonObject, validate, type ValidationResult } from "./schema.ts";
export { AnthropicProvider } from "./providers/anthropic.ts";
export { ScriptedProvider, type ScriptedReply } from "./providers/scripted.ts";

let cached: LlmAdapter | null = null;

/**
 * Resolve the configured LLM adapter (memoized).
 *
 * Unlike `getEdiAdapter()`, an unknown provider name here does NOT throw. The reasoning is the
 * difference between the two seams: an unrecognised EDI vendor means claims cannot be filed and the
 * process should refuse to start rather than pretend. An unrecognised LLM provider means the prose
 * on a screen is missing — degrading to `off` keeps every deterministic path working, and a boot
 * failure over a typo in an optional feature would take a practice's billing offline for the day.
 */
export function getLlmAdapter(): LlmAdapter {
  if (cached) return cached;
  const config = getConfig();
  cached = new LlmRouter({
    provider: buildProvider(config.llmProvider, config.llmApiKey, config.llmModel),
    phiApproved: config.llmPhiApproved,
    timeoutMs: config.llmTimeoutMs,
    maxAttempts: config.llmMaxAttempts,
    backoffMs: 250,
  });
  return cached;
}

function buildProvider(name: string, apiKey: string, model: string): LlmProvider | null {
  switch (name) {
    case "off":
      return null;
    case "anthropic":
      if (!apiKey) {
        // Configured but unusable. Degrading is right — see above — but silence is not: someone
        // set LLM_PROVIDER on purpose and is about to wonder why nothing happens.
        warn("LLM_PROVIDER=anthropic but LLM_API_KEY is not set — running with AI disabled");
        return null;
      }
      return new AnthropicProvider({ apiKey, model });
    default:
      warn(`LLM provider "${name}" is not registered — running with AI disabled`);
      return null;
  }
}

function warn(message: string): void {
  process.emitWarning(message, "LlmConfigWarning");
}

/** Test/seam helper — reset the memoized adapter (e.g. after changing LLM_PROVIDER). */
export function resetLlmAdapter(): void {
  cached = null;
}
