/**
 * @mermaid/edi — public surface. Consumers call `getEdiAdapter()` and depend only on the interface;
 * the concrete implementation is selected by `EDI_ADAPTER` config (blueprint doc 09).
 */
import { getConfig } from "@mermaid/config";
import type { EdiAdapter } from "./adapter.ts";
import { MockEdiAdapter } from "./mock/index.ts";
import { StediEdiAdapter } from "./vendors/stedi/index.ts";

export * from "./adapter.ts";
export { MockEdiAdapter } from "./mock/index.ts";
export { StediEdiAdapter, StediConfigurationError, type StediAdapterOptions } from "./vendors/stedi/index.ts";
export { StediClient, type StediEligibilityRequest, type StediEligibilityResponse } from "./vendors/stedi/client.ts";

let cached: EdiAdapter | null = null;

/** Resolve the configured EDI adapter (memoized). Add a `case` here when a vendor adapter lands. */
export function getEdiAdapter(): EdiAdapter {
  if (cached) return cached;
  const config = getConfig();
  const name = config.ediAdapter;
  switch (name) {
    case "mock":
      cached = new MockEdiAdapter();
      return cached;
    case "stedi":
      if (!config.stediApiKey) {
        // Unlike a missing LLM key — which costs prose on a screen — a missing clearinghouse key
        // means no coverage can be verified at all. That is a boot failure, not a degrade.
        throw new Error(
          "EDI_ADAPTER=stedi but STEDI_API_KEY is not set. Eligibility cannot be checked without it."
        );
      }
      cached = new StediEdiAdapter({
        apiKey: config.stediApiKey,
        baseUrl: config.stediBaseUrl,
        /**
         * ── A SECOND HOST, AND IT WAS SILENTLY IGNORED HERE (NEW-17) ──────────────────────────
         *
         * Stedi has two: the healthcare host for eligibility and claims, and the EDI-platform host
         * where ERA polling and artifact retrieval live. `config.stediCoreBaseUrl` exists,
         * `STEDI_CORE_BASE_URL` is documented, and `StediEdiAdapter` accepts it — but this factory
         * never passed it, so the process-wide adapter always used the compiled-in default.
         *
         * The ERA worker builds its own adapter and DOES pass it, which is what made this
         * invisible: polling honoured the setting and everything reached through `getEdiAdapter()`
         * did not. A deployment pointing at a staging host, a regional endpoint or a proxy had one
         * of its two clients quietly talking to production, and nothing said which.
         */
        coreBaseUrl: config.stediCoreBaseUrl,
        // Additive to the adapter's built-in allowlist — see `artifactHosts` (NEW-24).
        ...(config.stediArtifactHosts.length > 0 ? { artifactHosts: config.stediArtifactHosts } : {}),
        timeoutMs: config.stediTimeoutMs,
        testMode: config.stediTestMode,
        // The billing identity Stedi requires on every check — the same one claims are filed under,
        // read from the one place that owns it rather than duplicated here.
        provider: { organizationName: config.billingProviderName, npi: config.billingProviderNpi },
      });
      return cached;
    default:
      throw new Error(
        `EDI adapter "${name}" is not registered. Set EDI_ADAPTER=mock, ` +
          `or add a vendor adapter (see docs/architecture/09-edi-adapter-design.md).`
      );
  }
}

/** Test/seam helper — reset the memoized adapter (e.g. after changing EDI_ADAPTER). */
export function resetEdiAdapter(): void {
  cached = null;
}

/**
 * The mock payer's contractual reduction, exported so a test can ask whether the rate the system
 * LEARNS matches the rate the payer actually applies. Without it a test would restate 10% and then
 * pass forever against a mock that had changed.
 */
export { CONTRACTUAL_RATE } from "./mock/adjudicator.ts";
