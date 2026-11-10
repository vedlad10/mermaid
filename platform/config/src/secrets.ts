/**
 * Secret resolution — the seam a managed secrets manager slots into.
 *
 * ── WHAT THE RISK REVIEW ACTUALLY ASKS FOR ─────────────────────────────────────────────────────
 * §3: "Clearinghouse credentials and LLM API keys need a real secrets manager with rotation and
 * per-environment scoping — not environment variables sitting in a deploy config." Today every
 * secret in this system is an environment variable read straight out of `.env`, which is exactly
 * what that sentence names.
 *
 * ── WHY THIS IS A SEAM AND NOT AN IMPLEMENTATION ───────────────────────────────────────────────
 * Which manager is the right one is a HOSTING decision — AWS Secrets Manager, GCP Secret Manager,
 * Vault, Doppler — and hosting has not been chosen. Writing an adapter for a provider nobody has
 * picked would be inventing a requirement; leaving no seam at all means the change, when it comes,
 * touches every call site that reads a credential.
 *
 * So this establishes the interface and the discipline now, with the env-backed resolver as the
 * only implementation. Switching to a real manager becomes one `setSecretResolver()` call in the
 * composition root, and nothing that consumes a secret changes.
 *
 * ── THE DISCIPLINE, WHICH IS THE PART THAT MATTERS TODAY ───────────────────────────────────────
 * Even before a manager exists, routing secrets through one function buys three things env access
 * scattered across the codebase cannot:
 *
 *   1. **An inventory.** `KNOWN_SECRETS` is the list of everything this system treats as a secret —
 *      which is precisely what a Security Risk Assessment has to enumerate, and what nobody can
 *      produce by grepping for `process.env`.
 *   2. **A production guard.** A secret that is missing in production fails loudly at boot rather
 *      than at 2am on the first request that needed it.
 *   3. **One place to add rotation, caching and audit** when the manager arrives, instead of N.
 *
 * Secrets are never logged, never returned in an API response, and never compared non-constant-time
 * by anything reading them here — that last remains the caller's business (see `password.ts`).
 */

/**
 * Everything this system treats as a secret, and what it is for.
 *
 * Kept as data rather than as scattered `process.env` reads because a compliance assessment asks
 * "what secrets does this system hold, where do they come from, and who can read them?" — a question
 * a codebase full of ad-hoc env lookups cannot answer without a human reading all of it.
 */
export const KNOWN_SECRETS = {
  DATABASE_URL: "Application database connection (unprivileged, RLS-subject role).",
  DATABASE_ADMIN_URL: "Privileged connection for DDL and migrations only.",
  APP_DB_PASSWORD: "Password for the unprivileged application role, used at provisioning time.",
  PHI_ENCRYPTION_KEY: "AES-256-GCM key for PHI at rest. Production refuses to boot without it.",
  /**
   * ── THIS ENTRY REPLACES `EDI_API_KEY`, WHICH WAS FICTION (NEW-09) ────────────────────────────
   * `EDI_API_KEY` was listed as "unused until a vendor is selected (M15)". A vendor WAS selected —
   * the variable this deployment actually reads is `STEDI_API_KEY`, in `env.ts` and in the Stedi
   * adapter. So the inventory named a secret nothing reads and omitted the one credential that
   * reaches a third party carrying PHI.
   *
   * That is the precise failure an inventory exists to prevent: the point of this file is to answer
   * "what secrets does this system hold?" for a Security Risk Assessment, and an answer nobody
   * checks against reality is worse than no answer, because it is believed.
   */
  STEDI_API_KEY: "Clearinghouse credential (Stedi). Sends eligibility and claims — PHI leaves the system under it.",
  /**
   * Clearinghouse inbound webhook secret. Authenticates incoming 835 remittance deliveries.
   */
  STEDI_WEBHOOK_SECRET: "Clearinghouse inbound webhook bearer token / API key verification for Stedi 835 remittances.",
  /**
   * NOT unused. `AnthropicProvider` reads it on every card-vision and denial-explanation call, and
   * has since S2. The old description said "nothing calls an LLM today", which was true when it was
   * written and stopped being true without anybody revisiting the line.
   */
  LLM_API_KEY: "LLM provider credential. Read by AnthropicProvider for card vision and denial explanations.",
  /**
   * A webhook URL is a bearer credential: Slack, Discord and PagerDuty all authenticate the POST by
   * the secret path alone, so anyone holding the URL can post into that channel as this system. It
   * belongs on the inventory for the same reason as the others — a Security Risk Assessment asks
   * what this system holds, and "a URL" is not an answer that survives the follow-up question.
   */
  ALERT_WEBHOOK_URL: "Operational alert destination. A bearer credential: the secret is the path itself.",
} as const;

export type SecretName = keyof typeof KNOWN_SECRETS;

/**
 * Resolves a secret by name. Synchronous deliberately: every current consumer reads its secret at
 * boot, and an async read would push `await` into constructors for no benefit today. A managed
 * provider fetches at startup and populates this — the fetch is async, the lookup is not.
 */
export interface SecretResolver {
  get(name: SecretName): string | undefined;
}

/** The only implementation today: environment variables, as loaded from `.env` or the deploy config. */
export const envSecretResolver: SecretResolver = {
  get(name: SecretName): string | undefined {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  },
};

let resolver: SecretResolver = envSecretResolver;

/**
 * Swap the resolver. THE seam — a managed secrets manager is wired here, in the composition root,
 * before anything reads a secret.
 */
export function setSecretResolver(next: SecretResolver): void {
  resolver = next;
}

/** Reset to the environment-backed resolver. For tests. */
export function resetSecretResolver(): void {
  resolver = envSecretResolver;
}

/** A secret, or undefined when it is not configured. */
export const getSecret = (name: SecretName): string | undefined => resolver.get(name);

/**
 * A secret, or a thrown error naming what is missing and what it is for.
 *
 * The message deliberately contains the NAME and the PURPOSE and never a value or a fragment of one:
 * a "secret ABC… is invalid" message is how a secret reaches a log.
 */
export function requireSecret(name: SecretName): string {
  const value = resolver.get(name);
  if (value === undefined) {
    throw new Error(`Required secret ${name} is not configured. It provides: ${KNOWN_SECRETS[name]}`);
  }
  return value;
}

/**
 * Which secrets are configured — names and presence only, never values.
 *
 * This is what a readiness endpoint and a compliance review can both safely consume: "is everything
 * this deployment needs present?" is answerable without anything sensitive leaving the process.
 */
export function secretInventory(): { name: SecretName; purpose: string; configured: boolean }[] {
  return (Object.keys(KNOWN_SECRETS) as SecretName[]).map((name) => ({
    name,
    purpose: KNOWN_SECRETS[name],
    configured: resolver.get(name) !== undefined,
  }));
}
