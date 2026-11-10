/**
 * Central typed configuration — the single place environment is read (donor `config/env` doctrine:
 * fail-fast on missing prod secrets). Crucially, the *swappable implementation decisions* the
 * blueprint keeps behind seams — EDI vendor, LLM provider — are **config values here**, not code.
 * Changing an EDI vendor or LLM provider is an env change + an adapter registration, never an
 * architecture change (blueprint docs 09, 10).
 */

import { assertValidTimeZone } from "@mermaid/shared";
import { getSecret, type SecretName } from "./secrets.ts";

/**
 * Where a client's IP comes from on this deployment. See `Config.clientIpSource`.
 *
 * A union rather than a number with a magic zero: "trust nothing" and "trust two hops" are
 * different kinds of answer, and the reader of `clientIpFrom` should not have to know that 0 means
 * the first one.
 */
export type ClientIpSource =
  | { kind: "socket" }
  | { kind: "forwarded"; hops: number }
  | { kind: "cloudflare" };

/**
 * Parse the declared value of `TRUST_PROXY`. Returns null for anything unrecognised — including the
 * empty string — so the caller decides whether that is a refused boot or a laptop default.
 *
 * `0`/`1` keep meaning exactly what they meant before this became a union, so a deployment that
 * already answered the question does not have to answer it again.
 */
export function parseClientIpSource(raw: string | undefined): ClientIpSource | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  if (value === "cloudflare") return { kind: "cloudflare" };
  if (value === "0") return { kind: "socket" };
  if (/^[1-9][0-9]?$/.test(value)) return { kind: "forwarded", hops: Number(value) };
  return null;
}

export type EdiAdapterName = "mock" | (string & {});
export type LlmProviderName = "off" | (string & {});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  isProd: boolean;
  /**
   * Is this process running on a managed hosting platform, reachable by strangers?
   *
   * ── WHY THIS IS A SEPARATE QUESTION FROM `isProd` ──────────────────────────────────────────────
   * `NODE_ENV` is a statement of INTENT that somebody has to remember to make. "Is anyone on the
   * internet able to reach this" is a FACT about where the process is running, and the two come
   * apart in the one configuration that matters: a deployment nobody set `NODE_ENV` on.
   *
   * Such a deployment sits on a public URL with every default that
   * keys off `NODE_ENV` silently in its laptop setting — the session cookie without `Secure`, the
   * client IP taken from a socket that is really the platform's proxy, and the password-reset
   * endpoint handing a working token to any anonymous caller who asked for one. Each of those is
   * correct on a laptop and wrong on the open internet, and nothing in the process could tell the
   * difference because nothing had been told.
   *
   * Render injects its own variables into every container, which is how `/api/v1/health` reports the
   * commit it was built from. So the fact is already available; it just was not being asked.
   *
   * This deliberately does NOT make a hosted deployment production. The production refusals stay
   * keyed to `NODE_ENV` — flipping them here would take a running deployment down at boot for a
   * missing billing NPI, which is a worse outcome than the thing being fixed. What this changes is
   * the DEFAULTS that quietly assume a laptop.
   */
  hosted: boolean;
  /**
   * Can a claim filed from this deployment reach a REAL payer?
   *
   * ── THE QUESTION THE BILLING-IDENTITY GUARD WAS ACTUALLY ASKING ───────────────────────────────
   * `assertBillingProviderConfigured` refuses the demo identity, and its own message says why: "every
   * claim this deployment files would name a provider that does not exist, which is a false
   * attestation to a payer." That is a statement about reaching a PAYER. It keyed on `NODE_ENV`,
   * which is a different thing, and the gap ran both ways — a hardened demo could not boot, and a
   * laptop pointed at a live clearinghouse could.
   *
   * `assertBillingProviderContactConfigured` had already worked this out for the address and phone,
   * in this file, after Stedi rejected a real 837D: "the trigger is the ADAPTER — if this deployment
   * can put an 837D on a wire, it needs a billing identity that survives one." This brings the name,
   * NPI and tax ID in line with the conclusion its neighbour reached.
   *
   * Test mode is excluded deliberately, and the same comment says why: Stedi's own sandbox fixtures
   * are filed as MERMAID DEMO DENTAL, so demanding a real identity there would break the sandbox
   * that exists to exercise this path. A test key reaches Stedi; it does not reach a payer.
   */
  filesToRealPayers: boolean;
  /**
   * Is this a DEMONSTRATION deployment — one running under the demo billing identity?
   *
   * Derived rather than declared, because a declared flag can be forgotten by exactly the deployment
   * that most needs it. Deriving it cannot drift: a deployment is a demo precisely when it has no
   * real practice identity to file under.
   *
   * Safe to derive only because of the refusal it is paired with. A REAL deployment that forgets its
   * NPI also has a real clearinghouse configured, so `filesToRealPayers` is true and the boot is
   * refused — it cannot quietly become "a demo". The two together are what make this airtight rather
   * than convenient.
   */
  isDemoDeployment: boolean;
  port: number;

  /** Application DB connection (unprivileged, RLS-subject role). */
  databaseUrl: string;
  /** Privileged connection for DDL/migrations only; falls back to databaseUrl. */
  databaseAdminUrl: string;

  /** Swappable seams — the concrete implementation is chosen by these, wired at P2. */
  ediAdapter: EdiAdapterName;
  llmProvider: LlmProviderName;

  /**
   * Stedi clearinghouse credentials. Read here and nowhere else, like every other secret.
   *
   * `stediTestMode` is the safety interlock, not a convenience. Stedi issues *separate* test and
   * production API keys, and a test key silently returns mock benefits rather than contacting a
   * payer — so the mode a deployment believes it is in and the mode its key actually is in can
   * disagree, and the response looks plausible either way. The adapter therefore refuses to run
   * unless the flag and the key's own prefix agree, and every response carries the mode Stedi
   * reported back. Defaults to test: a deployment that has not thought about this must not be
   * able to reach a real payer.
   */
  stediApiKey: string;
  stediBaseUrl: string;
  /** Stedi's EDI-platform host, where ERA polling and artifact retrieval live. */
  stediCoreBaseUrl: string;
  /**
   * Extra hosts an ERA artifact may be downloaded from, beyond the adapter's built-in defaults
   * (NEW-24).
   *
   * The second hop of an ERA retrieval is an UNAUTHENTICATED GET of a URL the vendor's response
   * supplies, so the host is checked against an allowlist rather than trusted. Additive: a
   * deployment can name its clearinghouse's host, and cannot remove the defaults by accident.
   */
  stediArtifactHosts: string[];
  stediTestMode: boolean;
  stediTimeoutMs: number;

  /**
   * The model the configured LLM provider should use, and the key to reach it with.
   *
   * The key is read here and read nowhere else — it exists so `platform/llm` can be handed a
   * credential rather than reach for one, which keeps the provider testable and keeps exactly one
   * place in the repository that knows this secret's name.
   */
  llmModel: string;
  llmApiKey: string;
  /**
   * Whether the configured LLM endpoint is BAA-covered for PHI **in this deployment**.
   *
   * Defaults to false, everywhere, including production — the only compliance control in the
   * codebase that a production deployment must switch ON rather than configure correctly. See
   * `platform/llm/src/phi.ts` for why the safe default cannot be the convenient one.
   */
  llmPhiApproved: boolean;
  /** A human is usually waiting on an AI call, so the deadline is short and degrading is cheap. */
  llmTimeoutMs: number;
  llmMaxAttempts: number;

  /**
   * The practice's IANA timezone — the one filing and appeal deadlines are counted in.
   *
   * A deadline is a calendar day in a place. Counted in UTC, a US Pacific practice is told its
   * claims expired from late afternoon onward on the last day they were filable, and east of UTC the
   * error runs the other way: a claim reads filable after the payer has stopped accepting it.
   * Neither is a display bug — both change whether revenue is pursued.
   *
   * Defaults to UTC outside production so the laptop demo needs no environment at all; production
   * refuses to boot without it, for the same reason it refuses the demo billing identity.
   */
  practiceTimeZone: string;

  /**
   * V3 — which payers' networks this practice participates in, as `"delta-dental:in,cigna:out"`.
   *
   * A 271 quotes in-network and out-of-network benefits as different numbers, and nothing in the
   * payer's response says which applies to us: participation is a property of the CONTRACT between
   * this practice and that payer. Reading the wrong column under-quotes the patient and the practice
   * absorbs the difference.
   *
   * Empty is the default and means every payer is `unknown`, which reads the 271 exactly as it was
   * read before this setting existed. Unrecognised entries are ignored rather than guessed at — see
   * `parseParticipationMap`. Deliberately NOT required in production: an unset value is honest and
   * safe, whereas forcing a value at boot would make someone invent one.
   */
  payerNetworkParticipation: string;

  /** Auth. */
  sessionTtlHours: number;
  /**
   * Minutes without user activity after which a session ends — automatic logoff, 45 CFR
   * 164.312(a)(2)(iii). Default 30. The absolute `sessionTtlHours` still applies on top of it.
   * See `sessionIdleMinutes()` for why a bad value refuses to boot rather than falling back.
   */
  sessionIdleMinutes: number;
  /**
   * Whether every account must sign in with a second factor (TOTP, 0038). Default: ON wherever the
   * deployment carries a real practice's billing identity, OFF for the demonstration identity — the
   * same "is this real?" test the billing guards use. MFA_REQUIRED=1/0 states it explicitly.
   */
  mfaRequired: boolean;
  secureCookies: boolean;
  resetTtlSeconds: number;

  /**
   * WHERE this deployment gets a client's IP address, declared rather than guessed.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
   * The login rate limiter keys on the client's IP, and the audit trail records it. Reading
   * `x-forwarded-for` unconditionally hands both to the CLIENT: the header is attacker-supplied
   * unless a proxy this deployment controls sets it, so a credential-stuffing script that varies it
   * per request gets a fresh bucket every time and the throttle limits nothing — on the one endpoint
   * whose job is to slow password guessing against PHI. The audit rows record the forged address.
   *
   * ── WHY A BOOLEAN WAS NOT ENOUGH ──────────────────────────────────────────────────────────────
   * `TRUST_PROXY=1` meant "take the LAST `x-forwarded-for` entry", which is right for exactly ONE
   * trusted proxy appending the peer it saw. A Cloudflare-fronted platform has two, so
   * the last entry was whichever Cloudflare edge node took the request, and that rotates: twenty
   * parallel failed logins produced nineteen 401s and one 429 where a capacity-10 bucket should
   * give about ten of each. Every request had its own bucket and the throttle was off. Run with it
   * unset instead, every request arrives from Render's router over loopback, so the audit trail
   * recorded `::1` for every actor and one bucket covered the whole internet.
   *
   * Both failures are the same mistake: a yes/no answer to a question whose real answer is a fact
   * about one deployment's topology. So the setting now carries that fact.
   *
   *   • `socket`             — nothing trusted in front; the connection's peer address is the client.
   *   • `{ forwarded, hops }` — N trusted proxies append to `x-forwarded-for`; the Nth entry FROM THE
   *                            RIGHT is the client, and everything left of it is the client's own
   *                            claim. Correct for one balancer (hops 1) and for Cloudflare in front
   *                            of Render (hops 2), but it re-breaks the day a hop is added or removed.
   *   • `cloudflare`         — read `cf-connecting-ip`, which Cloudflare GENERATES at its edge from
   *                            the connection it terminated, and which its own documentation tells
   *                            origins to prefer over `x-forwarded-for`. Unlike the forwarded chain
   *                            there is no client-controlled portion to count past. The condition
   *                            that makes it trustworthy — every request truly reaches this process
   *                            through that edge, never around it — is a deployment fact, which is
   *                            why it is declared here rather than detected.
   */
  clientIpSource: ClientIpSource;
  /**
   * Whether this practice bills under a GROUP NPI rather than an individual one (NEW-22).
   *
   * Decides whether an 837D must carry loop 2310B, the dentist who performed the treatment.
   * 005010X224A2 says to send it only "when the rendering provider is different than the billing
   * provider" — always true for a group, never for a solo practice.
   *
   * Stated, never inferred: an NPI does not carry its own entity type in any form this system can
   * rely on. Guess "group" for a solo practice and every claim is blocked on a segment the guide
   * forbids; guess "solo" for a group and every claim tells the payer a corporation performed the
   * treatment.
   */
  practiceIsGroup: boolean;

  /**
   * The practice's merchant discount rate in BASIS POINTS (295 = 2.95%), or null when unstated (F1).
   *
   * Used to price what a non-ACH payer reimbursement cost to receive: a payer paying by virtual card
   * hands over a card number, and the processor's percentage comes out of money already earned and
   * already discounted to a contracted rate.
   *
   * ── WHY NULL IS THE DEFAULT AND NOT AN AVERAGE ─────────────────────────────────────────────────
   * The rate lives on a merchant statement this system has never seen. Industry commentary puts it
   * around 2.5–3.5%, and that range is exactly what makes a default dangerous: a figure in the right
   * neighbourhood is indistinguishable on a screen from a measured one, and a practice cannot
   * negotiate with a payer using a number we invented. Unset means the non-ACH payment is still
   * DETECTED and reported — only its cost is withheld.
   *
   * Zero is a statement, not an absence: a practice whose processor charges nothing for these says
   * `0`, and gets a computed fee of zero rather than "unknown".
   */
  merchantDiscountRateBps: number | null;

  /**
   * Billing-provider identity stamped onto every outbound claim (837D loop 2010AA). Pilot scope is
   * one practice, so it lives in config; in multi-practice production it is read from the
   * `practices` row for the authenticated session, never from config or client input.
   *
   * In production these must be set explicitly — `getConfig()` refuses to boot otherwise. See
   * `assertBillingProviderConfigured` for why a scrubber warning was not enough.
   */
  billingProviderName: string;
  billingProviderNpi: string;
  billingProviderTaxId: string;
  /**
   * The submitter contact and the provider SERVICE address — 837D loop 1000A PER and loop 2010AA
   * N3/N4, both mandatory.
   *
   * Not optional polish: a real clearinghouse rejects the claim outright without them
   * ("Segment PER has fewer than the minimum of 1 items"; "segment N3 is the next required
   * segment"). A payer uses the address to determine network and jurisdiction, and the phone is who
   * it rings when a claim is unreadable.
   *
   * Empty outside production so the laptop demo needs no environment; production refuses to boot.
   */
  billingProviderPhone: string;
  billingProviderStreet: string;
  billingProviderCity: string;
  billingProviderState: string;
  billingProviderZip: string;
  /**
   * The billing provider's Health Care Provider Taxonomy code — 837D loop 2000A `PRV*BI*PXC`.
   *
   * Found by Stedi's claim edits on 2026-10-15, the first time a test claim got past their NPI
   * check: "Missing Billing Provider taxonomy code. This code is required when no rendering provider
   * or assistant surgeon is reported" (277CA `A6:145:85`). A solo practice reports no rendering
   * provider, so every one of its claims was rejected for this. Same rules as the contact fields.
   */
  billingProviderTaxonomy: string;
  /**
   * Where an operational alert is sent, besides the log stream. Null means the log stream only.
   *
   * ── WHY THIS IS OPTIONAL AND WHY IT MATTERS ANYWAY (audit A-4) ────────────────────────────────
   * The two failures this platform is least able to notice are a stalled outbox and money that will
   * not reconcile: both are silent on every business screen, and the alert gate that detects them
   * wrote to stdout and nowhere else. On a container whose logs are discarded on restart, that is
   * the same as no alerting at all.
   *
   * Optional because a laptop needs no destination and a deployment should not fail to start over a
   * chat webhook. `https` only, and enforced — see `createAlertNotifier`.
   */
  alertWebhookUrl: string | null;
  /**
   * A name for this deployment, carried on every alert so two environments' notifications are
   * tellable apart in the same channel. Falls back to NODE_ENV, which is honest and usually enough.
   */
  deploymentName: string;
}

/**
 * The demo identity, named so both the config and the claim scrubber can recognise it.
 *
 * `1234567893` is a structurally VALID NPI — its check digit is correct, which is what makes it
 * usable as a demo value and exactly what made it dangerous: `isValidNpi` passes it, so the one
 * scrubber rule that looked at the NPI had nothing to say about it.
 */
export const DEMO_BILLING_PROVIDER = {
  name: "MERMAID DEMO DENTAL",
  npi: "1234567893",
  taxId: "000000000",
  /**
   * ── THE CONTACT HALF, WHICH THE DEMO IDENTITY WAS MISSING ─────────────────────────────────────
   * An 837D cannot be BUILT without loop 1000A PER and loop 2010AA N3/N4 — they are structurally
   * required, not merely validated — so a demonstration deployment with these empty produces claims
   * that are malformed even against the mock, and nothing notices because the mock validates
   * nothing. The identity had a demo name, NPI and tax ID and then stopped halfway.
   *
   * Deliberately and visibly NON-DELIVERABLE. `1 SYNTHETIC TEST WAY` is the address the seeder and
   * the vertical tests already put on every synthetic patient, for the same reason: on a screen it
   * reads as obviously fabricated, and on the one-in-a-thousand chance it ever reached a payer it
   * names nowhere. An address that looked plausible would be the dangerous choice here.
   *
   * These are used ONLY when the deployment is already a demonstration one — see `isDemoIdentity`
   * below. A deployment carrying a real practice's name and NPI gets no address defaults at all,
   * because a real claim with a made-up service address is exactly the false attestation the
   * neighbouring guard exists to prevent.
   */
  phone: "5105550100",
  street: "1 SYNTHETIC TEST WAY",
  city: "SPRINGFIELD",
  state: "CA",
  zip: "900010000",
  /** General practice dentistry. A specialty code, not an identity, so it names no one. */
  taxonomy: "1223G0001X",
} as const;

/**
 * A Health Care Provider Taxonomy code: ten characters, the last `X` (`1223G0001X` general practice
 * dentistry, `1223P0221X` pediatric, `1223X0400X` orthodontics).
 */
export const PROVIDER_TAXONOMY_PATTERN = /^[0-9]{3}[0-9A-Z]{6}X$/;

/**
 * Is the NAME/NPI/TAX ID trio the demonstration one?
 *
 * Read before the config object exists, because the contact defaults above depend on the answer and
 * are assembled with it. `Config.isDemoDeployment` is this same question answered afterwards, for
 * everyone else.
 */
function isDemoIdentity(name: string, npi: string, taxId: string): boolean {
  return (
    name.trim() === "" || name === DEMO_BILLING_PROVIDER.name ||
    npi.trim() === "" || npi === DEMO_BILLING_PROVIDER.npi ||
    taxId.trim() === "" || taxId === DEMO_BILLING_PROVIDER.taxId
  );
}

let cached: Config | null = null;

function req(name: string, whenProd = true): string {
  const v = process.env[name];
  if (!v) {
    const prod = process.env.NODE_ENV === "production";
    if (whenProd && prod) throw new Error(`FATAL: required environment variable ${name} is not set`);
    return "";
  }
  return v;
}

/**
 * A SECRET, read through the resolver rather than off `process.env` (NEW-09).
 *
 * `secrets.ts` established the seam a managed secrets manager slots into — `setSecretResolver()` in
 * the composition root, and nothing that consumes a credential changes. It had ZERO production
 * callers, so the seam described a design nothing implemented: every credential in this system was
 * still an ad-hoc `process.env` read, which is exactly what the risk review §3 names.
 *
 * Routing them here is what makes the seam real. `secretInventory()` becomes an answer about the
 * running process instead of a list somebody maintains by hand, and swapping in Vault or Secrets
 * Manager becomes one call rather than N edits across the codebase.
 */
function secret(name: SecretName): string {
  return getSecret(name) ?? "";
}

/**
 * SESSION_IDLE_MINUTES, parsed strictly: a whole number from 1 to 720, default 30.
 *
 * Not `num()`, which falls back to the default on garbage. A safeguard whose value was mistyped must
 * not quietly become a different safeguard, so anything else refuses to boot and names the variable.
 * There is no "off": an unattended signed-in screen is the case this exists for, and the absolute
 * 12-hour TTL is not a substitute.
 */
/**
 * MFA_REQUIRED: "1"/"true" or "0"/"false"; unset means "required unless this is the demo identity".
 * Anything else refuses to boot — a typo must not quietly switch a sign-in safeguard off.
 */
export function mfaRequired(raw: string | undefined, demoIdentity: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return !demoIdentity;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new Error(`FATAL: MFA_REQUIRED "${raw}" must be 1 or 0 (or unset: required unless this is the demo identity).`);
}

export function sessionIdleMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 720) {
    throw new Error(
      `FATAL: SESSION_IDLE_MINUTES "${raw}" must be a whole number of minutes from 1 to 720 — the time ` +
        `a signed-in screen may sit untouched before its session ends.`
    );
  }
  return n;
}

function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * The practice's merchant discount rate, in basis points, or null when it has not stated one (F1).
 *
 * Every rejection returns null rather than a fallback, because the only number that may be used here
 * is one the practice actually supplied. A malformed value is "unstated", not "probably about 3%":
 * the fee is reported to a biller who may quote it to a payer, so a typo must cost the FIGURE, never
 * the accuracy of the figure.
 *
 * Bounds are 0–10000 bps (0%–100%). Zero is accepted because it is a real statement — a processor
 * that charges nothing for these — while a negative rate would credit the practice for being paid by
 * card, and anything over 100% is a unit error (someone typed a percentage where basis points go).
 */
export function parseMerchantRateBps(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 10_000) return null;
  return n;
}

/** Read + validate config once. Fails fast in production if a required secret is missing. */
export function getConfig(): Config {
  if (cached) return cached;
  const nodeEnv = (process.env.NODE_ENV as Config["nodeEnv"]) || "development";

  /**
   * Detected, not declared — see `Config.hosted`.
   *
   * Render injects `RENDER=true` and a set of `RENDER_*` variables into every container it runs.
   * `RENDER_GIT_COMMIT` is the one this codebase already depends on (it is what `/api/v1/health`
   * reports, and what `npm run ship` reads back to prove a deploy landed), so its presence is an
   * established fact about the environment rather than a new assumption.
   *
   * `HOSTED=1` is the manual override for any platform not recognised here. Kept because the list
   * below is a list of platforms somebody thought of, and the deployment that gets this wrong will
   * be the one running somewhere nobody added.
   */
  const hosted =
    process.env.HOSTED === "1" ||
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_GIT_COMMIT) ||
    Boolean(process.env.FLY_APP_NAME) ||
    Boolean(process.env.K_SERVICE) ||
    Boolean(process.env.DYNO);

  /**
   * Through the resolver, but keeping `req`'s production hard-failure: a database URL missing in
   * production must still stop the boot, and the resolver only reports absence.
   */
  const databaseUrl = getSecret("DATABASE_URL") ?? req("DATABASE_URL", true);

  /* Needed while ASSEMBLING the object below, because the contact defaults depend on it. */
  const demoIdentity = isDemoIdentity(
    process.env.BILLING_PROVIDER_NAME || DEMO_BILLING_PROVIDER.name,
    process.env.BILLING_PROVIDER_NPI || DEMO_BILLING_PROVIDER.npi,
    process.env.BILLING_PROVIDER_TAX_ID || DEMO_BILLING_PROVIDER.taxId
  );
  cached = {
    nodeEnv,
    isProd: nodeEnv === "production",
    hosted,
    port: num("PORT", 3000),
    databaseUrl,
    databaseAdminUrl: secret("DATABASE_ADMIN_URL") || databaseUrl,
    ediAdapter: (process.env.EDI_ADAPTER || "mock") as EdiAdapterName,
    stediApiKey: secret("STEDI_API_KEY"),
    stediBaseUrl: process.env.STEDI_BASE_URL || "https://healthcare.us.stedi.com",
    // Stedi's EDI-platform host — a DIFFERENT service from the healthcare host above. ERA polling
    // and artifact retrieval live here. Probing the healthcare host for these paths is what once
    // produced the (wrong) conclusion that Stedi had no polling endpoint at all.
    stediCoreBaseUrl: process.env.STEDI_CORE_BASE_URL || "https://core.us.stedi.com",
    stediArtifactHosts: (process.env.STEDI_ARTIFACT_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    // Opt IN to production, never out of test. `STEDI_TEST_MODE=0` is the only way to reach a payer.
    stediTestMode: process.env.STEDI_TEST_MODE !== "0",
    stediTimeoutMs: num("STEDI_TIMEOUT_MS", 30_000),
    llmProvider: (process.env.LLM_PROVIDER || "off") as LlmProviderName,
    // Current-generation default. The previous default (`claude-sonnet-4-5`) is legacy: still
    // served, but it is not what a new deployment should be reading insurance cards with, and the
    // high-resolution vision this feature benefits from arrived after it.
    llmModel: process.env.LLM_MODEL || "claude-opus-5",
    llmApiKey: secret("LLM_API_KEY"),
    llmPhiApproved: process.env.LLM_PHI_APPROVED === "1",
    llmTimeoutMs: num("LLM_TIMEOUT_MS", 20_000),
    llmMaxAttempts: num("LLM_MAX_ATTEMPTS", 2),
    practiceTimeZone: process.env.PRACTICE_TIMEZONE || "UTC",
    /* Both replaced immediately below, once the object exists to read from. */
    filesToRealPayers: false,
    isDemoDeployment: false,
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || null,
    deploymentName: process.env.DEPLOYMENT_NAME?.trim() || nodeEnv,
    payerNetworkParticipation: process.env.PAYER_NETWORK_PARTICIPATION || "",
    sessionTtlHours: num("SESSION_TTL_HOURS", 12),
    sessionIdleMinutes: sessionIdleMinutes(process.env.SESSION_IDLE_MINUTES),
    mfaRequired: mfaRequired(process.env.MFA_REQUIRED, demoIdentity),
    /**
     * `Secure` on the session cookie (DEC-3).
     *
     * Secure BY DEFAULT in production: the variable now has to be set to "0" to turn it off, rather
     * than set to "1" to turn it on. A deployment that simply forgot it used to serve a PHI
     * system's session cookie over plain HTTP, where it is readable in transit — and forgetting is
     * the normal failure, not a deliberate choice.
     *
     * Outside production the old behaviour is kept exactly: off unless asked for. The laptop demo
     * runs on http://localhost, where a `Secure` cookie is never sent back and login would appear
     * to succeed and then silently fail on the next request.
     */
    /**
     * ── ON WHEREVER A STRANGER CAN REACH THIS, NOT ONLY IN PRODUCTION ────────────────────────────
     * This read `nodeEnv === "production" ? … : SECURE_COOKIES === "1"`, so a hosted deployment with
     * no NODE_ENV served its session cookie with no
     * `Secure` flag over a public URL. The laptop case that the opt-in exists for is `http://
     * localhost`, where a `Secure` cookie is never sent back and login silently fails on the next
     * request; that case is precisely "not hosted", so it is the condition to branch on.
     *
     * Still overridable with `SECURE_COOKIES=0`, and still a refused boot in production if somebody
     * does that — see `assertSecureCookiesInProduction`.
     */
    secureCookies:
      nodeEnv === "production" || hosted
        ? process.env.SECURE_COOKIES !== "0"
        : process.env.SECURE_COOKIES === "1",
    resetTtlSeconds: num("RESET_TTL_SECONDS", 3600),
    /**
     * Opt IN to trusting x-forwarded-for. Unset means the socket peer address is the client.
     *
     * ── THIS WAS BRIEFLY DEFAULTED ON FOR HOSTED DEPLOYMENTS, AND THAT WAS WRONG ────────────────
     * The reasoning was sound and the result was not. Unset behind a load balancer, the socket peer
     * is the balancer, so the login throttle counts the whole internet as one address and the audit
     * trail records one address for every actor — both genuinely wrong. Defaulting it on where a
     * proxy is known to exist looked like the fix.
     *
     * It made the throttle strictly worse, and measurably so. `clientIpFrom` takes the LAST entry of
     * `x-forwarded-for`, which is correct for exactly ONE trusted proxy appending the peer it saw.
     * A Cloudflare-fronted platform has two. So the last entry is not the client and not a
     * stable balancer — it is whichever Cloudflare edge node handled the request, and that rotates.
     * Twenty parallel failed logins produced nineteen 401s and a single 429, where a
     * capacity-10 bucket should have produced about ten of each: every request had landed in its own
     * bucket, and the throttle was effectively off.
     *
     * With it unset, the twenty share one bucket. That is too coarse — one attacker can lock out a
     * whole practice — and it is a throttle that works, which the alternative was not.
     *
     * Getting this actually right needs the number of trusted hops, which is a fact about a specific
     * deployment's topology that nothing in this process can observe and no default can guess. So
     * the variable now carries that fact instead of a yes/no: `cloudflare`, a hop count, or `0`.
     * `1` and `0` still mean what they always meant. Unrecognised or unset is still the socket —
     * the only honest answer when nothing has been declared — and production still refuses to boot
     * without one. See `parseClientIpSource` and `Config.clientIpSource`.
     */
    clientIpSource: parseClientIpSource(process.env.TRUST_PROXY) ?? { kind: "socket" },
    // Opt IN. False is what every claim built before 2310B existed meant, and it is the shape of a
    // solo practice — the deployment this system was built for first.
    practiceIsGroup: process.env.PRACTICE_IS_GROUP === "1",
    merchantDiscountRateBps: parseMerchantRateBps(process.env.MERCHANT_DISCOUNT_RATE_BPS),
    // Obvious placeholders on purpose, and refused outright wherever a payer is reachable — see below.
    billingProviderName: process.env.BILLING_PROVIDER_NAME || DEMO_BILLING_PROVIDER.name,
    billingProviderNpi: process.env.BILLING_PROVIDER_NPI || DEMO_BILLING_PROVIDER.npi,
    billingProviderTaxId: process.env.BILLING_PROVIDER_TAX_ID || DEMO_BILLING_PROVIDER.taxId,
    /**
     * The contact half falls back to the synthetic demo address ONLY for a deployment that is
     * already carrying the demo name and NPI. A deployment with a real practice's identity gets
     * empty strings and the refusal below, because a real claim with a made-up service address is
     * the same false attestation as a real claim with a made-up NPI.
     */
    billingProviderPhone: process.env.BILLING_PROVIDER_PHONE || (demoIdentity ? DEMO_BILLING_PROVIDER.phone : ""),
    billingProviderStreet: process.env.BILLING_PROVIDER_STREET || (demoIdentity ? DEMO_BILLING_PROVIDER.street : ""),
    billingProviderCity: process.env.BILLING_PROVIDER_CITY || (demoIdentity ? DEMO_BILLING_PROVIDER.city : ""),
    billingProviderState: (process.env.BILLING_PROVIDER_STATE || (demoIdentity ? DEMO_BILLING_PROVIDER.state : "")).toUpperCase(),
    billingProviderZip: (process.env.BILLING_PROVIDER_ZIP || (demoIdentity ? DEMO_BILLING_PROVIDER.zip : "")).replace(/-/g, ""),
    billingProviderTaxonomy: (
      process.env.BILLING_PROVIDER_TAXONOMY || (demoIdentity ? DEMO_BILLING_PROVIDER.taxonomy : "")
    )
      .trim()
      .toUpperCase(),
  };
  /**
   * Derived after the object is built, because both answers read fields it already holds. Assigned
   * rather than computed inline so the two facts are visible next to each other — they are a pair,
   * and the guarantee lives in their combination rather than in either one.
   */
  cached.filesToRealPayers = cached.ediAdapter !== "mock" && !cached.stediTestMode;
  cached.isDemoDeployment = demoIdentity;

  assertBillingProviderConfigured(cached);
  assertPracticeTimeZoneConfigured(cached);
  assertBillingProviderContactConfigured(cached);
  assertSecureCookiesConfigured(cached);
  assertTrustProxyDeclared(cached);
  warnIfHostedWithoutProduction(cached);
  return cached;
}

/**
 * Say it in the deploy log, once, every boot.
 *
 * ── WHY A WARNING AND NOT A REFUSAL ────────────────────────────────────────────────────────────
 * A refusal here would take a running deployment down the next time it restarts, for a variable
 * nobody can set without access to the hosting platform — turning a security gap into an outage,
 * and an outage into pressure to remove the check. That is the wrong trade for a condition whose
 * worst effects are already mitigated (see `Config.hosted`).
 *
 * So it is loud instead of fatal, and it is loud in the one place a deploy is actually looked at.
 * The Ops readiness check reports the same condition as a hard failure for anyone reading a screen;
 * this is for whoever is reading the log after a deploy, which is a different person on a different
 * day. The gap it names is real and only the platform's settings can close it.
 */
function warnIfHostedWithoutProduction(config: Config): void {
  if (!config.hosted || config.isProd) return;
  process.emitWarning(
    `This process is running on a hosting platform with NODE_ENV=${config.nodeEnv}. ` +
      `Secure cookies, HSTS and withholding password-reset tokens are all in force because the ` +
      `platform is detectable — but the demonstration billing identity is still accepted and the ` +
      `practice timezone is still unasserted. Those two are boot refusals, not defaults, so they ` +
      `need NODE_ENV=production in the platform's environment settings.`,
    "DeploymentModeWarning"
  );
}

/**
 * Refuse to boot in production under the demo billing identity.
 *
 * ── WHY THIS IS A BOOT FAILURE AND NOT A WARNING ───────────────────────────────────────────────
 * The comment this replaced claimed "the scrubber rejects them in production, so an unconfigured
 * practice cannot quietly file claims under a fake NPI". It did not. The scrubber had exactly one
 * placeholder rule, it looked only at the tax ID, and it raised a WARNING — which by design does not
 * block the submit gate. The demo NPI passed `isValidNpi` because its check digit is correct, and
 * the demo NAME was never checked at all. A production deployment that forgot to set these would
 * have filed real claims for real patients to real payers under "MERMAID DEMO DENTAL" and a fake
 * NPI, with nothing louder than an advisory nobody has to clear.
 *
 * That is a false statement to a payer about who rendered care, made at scale, on a document that is
 * a legal attestation. It is not a configuration nit, and it is not a thing to notice on a screen
 * after the fact. So the process refuses to start, in the same way it already refuses to start
 * without `PHI_ENCRYPTION_KEY`: the failures that must never reach a payer belong at boot, where one
 * person sees them once, and not at the submit gate, where a busy biller sees them every day and
 * learns to click past.
 *
 * Outside production nothing is enforced here — the laptop demo must keep working with no
 * environment at all — and the scrubber still raises its (now widened) advisory there, which is
 * exactly the right severity for a staging deployment that files nothing real.
 */
export function assertBillingProviderConfigured(config: Config): void {
  /**
   * ── THE TRIGGER IS REACHING A PAYER, NOT NODE_ENV (and this is STRICTLY STRONGER) ────────────
   *
   * This read `if (!config.isProd) return`, and that was wrong in both directions.
   *
   * It was too STRICT for a hardened demonstration deployment. Setting NODE_ENV=production on
   * staging — the correct thing to do, and what turns on every other protection — made it refuse to
   * boot for want of a real dental practice's NPI, which a demonstration deployment does not have
   * and should not invent. The deployment that most wants hardening was the one this forbade.
   *
   * It was also too LAX everywhere else, which matters more. A laptop or a staging box with
   * `EDI_ADAPTER=stedi` and `STEDI_TEST_MODE=0` — a live clearinghouse — sailed past this check
   * because NODE_ENV was not "production", and could file a claim naming a provider that does not
   * exist. That is precisely the false attestation the message below describes, and the old
   * condition permitted it.
   *
   * So the trigger is now the fact the message is about: can a claim from here reach a payer? That
   * is `filesToRealPayers`, and it refuses regardless of NODE_ENV. Nothing is weakened — a real
   * deployment that forgets its NPI still has a real clearinghouse configured and is still refused.
   * What changes is that a deployment which can reach nobody is no longer asked to prove who it is.
   */
  if (!config.filesToRealPayers) return;

  const wrong = [
    config.billingProviderName.trim() === "" || config.billingProviderName === DEMO_BILLING_PROVIDER.name
      ? "BILLING_PROVIDER_NAME"
      : null,
    config.billingProviderNpi.trim() === "" || config.billingProviderNpi === DEMO_BILLING_PROVIDER.npi
      ? "BILLING_PROVIDER_NPI"
      : null,
    config.billingProviderTaxId.trim() === "" || config.billingProviderTaxId === DEMO_BILLING_PROVIDER.taxId
      ? "BILLING_PROVIDER_TAX_ID"
      : null,
  ].filter((name): name is string => name !== null);

  if (wrong.length > 0) {
    throw new Error(
      `FATAL: ${wrong.join(", ")} still hold the demo billing identity, and this deployment is wired ` +
        `to a live clearinghouse (EDI_ADAPTER=${config.ediAdapter}, test mode off). Every claim it ` +
        `files would name a provider that does not exist, which is a false attestation to a payer. ` +
        `Set them to the practice's real registered name, NPI and tax ID — or, for a demonstration ` +
        `deployment, set EDI_ADAPTER=mock (or STEDI_TEST_MODE=1), which reaches no payer and needs ` +
        `no identity to prove.`
    );
  }
}

/**
 * Refuse to boot in production with the session cookie's `Secure` flag turned off.
 *
 * ── WHY A BOOT FAILURE, AND WHY A DEFAULT WAS NOT ENOUGH (DEC-3) ───────────────────────────────
 * `Secure` was added only when `SECURE_COOKIES=1`, with no assertion beside the three that already
 * refuse a production boot — `DATABASE_URL`, the demo billing identity, the practice timezone. A
 * deployment that forgot the variable served a PHI system's session cookie over plain HTTP, where
 * it can be read in transit and replayed. `HttpOnly` and `SameSite=Lax` do not help with that: they
 * stop a script reading the cookie and a cross-site request sending it, not a network observer
 * seeing it.
 *
 * The default above closes the forgetting case. This closes the DELIBERATE one: `SECURE_COOKIES=0`
 * in production is now a refusal rather than a quiet downgrade, because turning it off is a
 * decision somebody should have to defend rather than a line in an env file nobody reads.
 *
 * The same doctrine the billing-identity assertion states: the failures that must never happen
 * belong at boot, where one person sees them once, and not in a running system where nobody sees
 * them at all.
 */
export function assertSecureCookiesConfigured(config: Config): void {
  if (!config.isProd) return;
  if (config.secureCookies) return;

  throw new Error(
    "FATAL: SECURE_COOKIES is set to 0 in production. The session cookie would be sent without the " +
      "Secure flag, so any network observer between a browser and this deployment can read it and " +
      "act as that user — on a system holding PHI. HttpOnly and SameSite do not prevent that. " +
      "Terminate TLS in front of this process and unset SECURE_COOKIES, or set it to 1."
  );
}

/**
 * Refuse to boot in production without an explicit answer about the proxy (NEW-16).
 *
 * ── WHY A MISSING VALUE IS NOT A SAFE DEFAULT HERE ─────────────────────────────────────────────
 * `TRUST_PROXY` decides where `clientIp` gets its answer: the socket's peer address, or the
 * `x-forwarded-for` header. It defaulted to OFF, which is the safe direction for exactly one of the
 * two ways a deployment can be wrong, and silently catastrophic for the other.
 *
 *   • Set to 1 with NO proxy in front: any client can send `x-forwarded-for: <anything>` and choose
 *     its own rate-limit bucket. The login throttle stops throttling.
 *   • Left UNSET behind a proxy — the case the default produces: every request arrives from the
 *     proxy's address, so the whole practice shares ONE login bucket. Ten receptionists arriving at
 *     8am exhaust it between them, and everybody is locked out of a system holding PHI while the
 *     logs say "rate limit exceeded" about an attack that is not happening. Worse, an attacker who
 *     knows this can lock out a practice with ten wrong passwords.
 *
 * Neither is a default anyone can pick correctly on someone else's behalf, because the answer is a
 * fact about the deployment's topology and nothing in this process can observe it. So production
 * must say, in one of two characters, and a deployment that has not thought about it does not start.
 *
 * The same doctrine as the billing identity and the secure cookie: the failures that must never
 * happen belong at boot, where one person sees them once.
 *
 * Outside production nothing is enforced — a laptop has no proxy and needs no environment at all.
 */
export function assertTrustProxyDeclared(config: Config): void {
  if (!config.isProd) return;
  const raw = (process.env.TRUST_PROXY ?? "").trim();
  if (parseClientIpSource(raw)) return;

  throw new Error(
    `FATAL: TRUST_PROXY is ${raw === "" ? "not set" : `"${raw}"`}. Production needs an explicit ` +
      `answer, because it decides whether a client's IP address comes from the connection, from a ` +
      `header the client can write, or from the edge that terminated the connection.\n` +
      `  TRUST_PROXY=cloudflare — Cloudflare fronts this deployment (Render's *.onrender.com does, ` +
      `and so does any custom domain proxied through Cloudflare). \`cf-connecting-ip\` is generated ` +
      `at that edge from the connection it terminated, so there is no client-written portion to ` +
      `count past. Requires that nothing can reach this process around that edge.\n` +
      `  TRUST_PROXY=<n> — n trusted proxies append to x-forwarded-for; the nth entry from the RIGHT ` +
      `is the client. 1 for a single balancer; 2 for Cloudflare in front of Render. Count wrong and ` +
      `the throttle silently stops working, so prefer \`cloudflare\` where it applies.\n` +
      `  TRUST_PROXY=0 — this process is reached directly. Every request then appears to come from ` +
      `the socket's peer address.\n` +
      `Set to 0 behind a proxy, an entire practice shares one login bucket: ten staff signing in ` +
      `at 8am lock each other out, and an attacker can lock them out deliberately with ten wrong ` +
      `passwords.`
  );
}

/** Test helper — reset the memoized config so a test can vary the environment. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Refuse to boot a production deployment that has not said where the practice is.
 *
 * A filing deadline is a calendar day in a place. `PRACTICE_TIMEZONE` unset means the deadline
 * engines count in UTC, and for a US practice that reports claims expired from late afternoon on the
 * last day they were filable — the hours when end-of-day filing sweeps run. Staff are told to
 * abandon revenue the payer would still have paid, and nothing on the screen suggests the date is a
 * guess.
 *
 * The same class as the demo billing identity: configuration whose absence produces confidently
 * wrong financial behaviour rather than an obvious failure. Those belong at boot, where one person
 * sees them once.
 */
export function assertPracticeTimeZoneConfigured(config: Config): void {
  // Validated everywhere — a typo is a typo on a laptop too, and it would otherwise surface as a
  // RangeError from inside a deadline calculation rather than as a configuration error.
  assertValidTimeZone(config.practiceTimeZone);

  if (!config.isProd) return;
  /**
   * A demonstration deployment has no practice whose calendar days these are, so UTC is an honest
   * answer rather than a silently wrong one. The refusal exists so a REAL practice never has its
   * filing deadlines counted in the wrong zone; that is unchanged, because a deployment carrying a
   * real billing identity is not a demo. Readiness still reports the deployment as DEMO, so nobody
   * reads its deadlines as a practice's own.
   */
  if (config.isDemoDeployment) return;
  if (!process.env.PRACTICE_TIMEZONE) {
    throw new Error(
      "FATAL: PRACTICE_TIMEZONE is not set. Timely-filing and appeal deadlines are counted in the " +
        "practice's own calendar days; counting them in UTC moves every deadline by up to a day and " +
        'silently abandons filable claims. Set it to the practice\'s IANA zone, e.g. "America/Los_Angeles".'
    );
  }
}

/**
 * Refuse to boot a production deployment that cannot produce a fileable claim.
 *
 * ── WHY THIS IS A BOOT FAILURE ─────────────────────────────────────────────────────────────────
 * Loop 1000A PER and loop 2010AA N3/N4 are mandatory on an 837D. A clearinghouse rejects the claim
 * outright without them — found exactly that way, against a live sandbox. A deployment missing them
 * looks completely healthy: patients verify, estimates price, claims scrub clean, and every single
 * submission fails at the payer. That is a worse failure than not starting, because it is
 * discovered a week later by a practice wondering where its money is.
 *
 * The same doctrine as the demo billing identity: configuration whose absence produces confidently
 * wrong behaviour belongs at boot, where one person sees it once.
 */
export function assertBillingProviderContactConfigured(config: Config): void {
  /**
   * ── THE CONDITION IS "AM I WIRED TO A CLEARINGHOUSE", NOT "AM I PRODUCTION" ────────────────────
   * This read `if (!config.isProd) return`, and the gap it left showed up the first time the Stedi
   * scenarios ran against TEST from a staging deployment. `NODE_ENV=staging` skipped the check, the
   * 837D went out with an empty PER and no N3/N4, and Stedi answered:
   *
   *   Relational condition P0304 violated: If any one of the elements in positions 03, 04 is
   *   present, then all must be present | Element PER-04 is required | Element N3-01 is required |
   *   Element N4-01 is required
   *
   * which reached the biller as an opaque `502 clearinghouse_error`. The claim was structurally
   * invalid before it left the building, and nothing said so until a vendor 1,500 miles away did.
   *
   * A test key does not make the X12 less real: Stedi validates the envelope identically in both
   * modes, and so does every payer. So the trigger is the ADAPTER — if this deployment can put an
   * 837D on a wire, it needs a billing identity that survives one.
   *
   * The demo NAME and NPI are deliberately NOT escalated the same way (see
   * `assertBillingProviderConfigured`): Stedi's own sandbox fixtures are filed as MERMAID DEMO
   * DENTAL, so requiring a real identity in test mode would break the sandbox it exists to exercise.
   * The address and phone are different — they are structurally required, and an empty one is
   * rejected by the clearinghouse whatever the identity says.
   */
  /**
   * ── THIS CONDITION IS DELIBERATELY UNCHANGED ─────────────────────────────────────────────────
   * A hardened demonstration deployment used to fail here, and the tempting fix was to drop the
   * `isProd` half so the check fired only on the clearinghouse adapter. `clearinghouse-needs-a-
   * billing-address.test.ts` refuses that in as many words — "the new condition widens the check and
   * never narrows it" — and it is right: an address is needed to BUILD an 837D, not only to have one
   * accepted, so a production deployment with none is misconfigured whatever it is wired to.
   *
   * The demo case is solved where it belongs instead. `DEMO_BILLING_PROVIDER` now carries a
   * deliberately non-deliverable contact, applied only to a deployment already running the demo
   * name and NPI, so such a deployment satisfies this check honestly rather than being excused from
   * it — and its mock 837Ds are structurally well-formed rather than quietly malformed, which is
   * what empty PER and N3/N4 segments were producing before.
   */
  const filesToAClearinghouse = config.ediAdapter === "stedi";
  if (!config.isProd && !filesToAClearinghouse) return;

  const missing = [
    config.billingProviderPhone.trim() ? null : "BILLING_PROVIDER_PHONE",
    config.billingProviderStreet.trim() ? null : "BILLING_PROVIDER_STREET",
    config.billingProviderCity.trim() ? null : "BILLING_PROVIDER_CITY",
    config.billingProviderState.trim() ? null : "BILLING_PROVIDER_STATE",
    config.billingProviderZip.trim() ? null : "BILLING_PROVIDER_ZIP",
  ].filter((v): v is string => v !== null);

  if (missing.length > 0) {
    throw new Error(
      `FATAL: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. An 837D requires ` +
        `the submitter's contact (loop 1000A PER) and the billing provider's service address ` +
        `(loop 2010AA N3/N4); a clearinghouse rejects every claim without them. Set the practice's ` +
        `real contact and service address — a PO box is not acceptable to most payers.`
    );
  }

  if (!/^[A-Z]{2}$/.test(config.billingProviderState)) {
    throw new Error(
      `FATAL: BILLING_PROVIDER_STATE "${config.billingProviderState}" is not a two-letter USPS code, e.g. CA.`
    );
  }
  if (!/^[0-9]{5}([0-9]{4})?$/.test(config.billingProviderZip)) {
    throw new Error(
      `FATAL: BILLING_PROVIDER_ZIP "${config.billingProviderZip}" is not a 5- or 9-digit ZIP code.`
    );
  }
  // A phone a payer cannot dial is the same as no phone.
  if (config.billingProviderPhone.replace(/\D/g, "").length < 10) {
    throw new Error(
      `FATAL: BILLING_PROVIDER_PHONE must be a full 10-digit telephone number — it is who the payer ` +
        `rings about a claim it cannot read.`
    );
  }
  if (!PROVIDER_TAXONOMY_PATTERN.test(config.billingProviderTaxonomy)) {
    throw new Error(
      `FATAL: BILLING_PROVIDER_TAXONOMY ${config.billingProviderTaxonomy ? `"${config.billingProviderTaxonomy}" is not a provider taxonomy code` : "is not set"}. ` +
        `Payers reject a dental claim with no billing provider taxonomy when no rendering provider is ` +
        `reported (Stedi edit 33, 277CA A6:145). Set the practice's code from NPPES, e.g. 1223G0001X ` +
        `for general practice dentistry.`
    );
  }
}
