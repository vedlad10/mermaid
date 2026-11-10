/**
 * Webhook authentication — the gate on the platform's first untrusted inbound path (risk R7).
 *
 * Everything Mermaid has sent or received until now, it initiated: the 270 goes out, the 271 comes
 * back on the same socket. A webhook inverts that. An address on the public internet accepts a POST
 * from anyone who finds it, and what arrives claims to be a remittance — a statement about money
 * that a payer paid. Nothing downstream can tell a forged 835 from a real one, because a forged one
 * is a well-formed one. So the only place that distinction can be drawn is here, before a single
 * byte of the body is parsed.
 *
 * ── WHAT THE VENDOR ACTUALLY DOES, WHICH IS NOT WHAT WAS PLANNED ────────────────────────────────
 * M15 specifies "signature verification". Stedi does not sign its webhooks. Its destination
 * webhooks authenticate with a shared secret the *customer* chooses — an API key in a header the
 * customer names, HTTP basic auth, or OAuth 2.0 client credentials — and there is no HMAC of the
 * request body anywhere in the scheme.
 *
 * That difference is worth stating plainly rather than papering over, because it changes the threat
 * model:
 *
 *   A signature binds the secret TO THE BODY. Learn the secret and you can still only replay what
 *   you already have. A bearer token binds the secret to NOTHING. Learn the token and you can
 *   author any remittance you like, for any amount, and it authenticates perfectly.
 *
 * So under `bearer` the token is the entire perimeter, which is why this module refuses weak
 * secrets at construction (`MIN_SECRET_BYTES`) rather than warning about them, and why the steps
 * that follow in M15 — duplicate rejection at the edge, and ingest through the outbox so nothing
 * adjudicates in the request path — are load-bearing rather than tidy. The existing money-posting
 * safety gates are the last line and stay exactly where they are.
 *
 * `hmac` is implemented alongside it because the clearinghouse sits behind a seam by design, the
 * primitive is the one that is easy to get subtly wrong under time pressure, and getting it wrong
 * is silent. It is not reachable today; no vendor Mermaid talks to signs anything.
 *
 * Zero dependencies (`node:crypto` only), pure, and deliberately ignorant of HTTP frameworks — it
 * takes headers and bytes, and returns a verdict.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The shortest secret this module will accept, in bytes of the encoded string.
 *
 * 32 is not a round number chosen for looks. Under `bearer` the secret is not merely one factor,
 * it is the only one: possession of it is indistinguishable from being the payer's clearinghouse.
 * A value short enough to be guessed offline is therefore not "weaker security", it is none, and a
 * deployment that pastes `mermaid-webhook` into the console must not discover that at the point a
 * forged 835 posts.
 */
export const MIN_SECRET_BYTES = 32;

/** How far a signed timestamp may sit from now before the signature is refused. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookAuthScheme = "bearer" | "hmac";

/**
 * A shared secret presented verbatim in a header — Stedi's "API Key" credential type.
 *
 * `header` and `prefix` are configuration rather than constants because the sender chooses both:
 * Stedi's console lets an integrator name the header and decide whether the value carries a
 * `Bearer ` prefix. Guessing either produces a verifier that rejects every real delivery.
 */
export interface BearerAuthConfig {
  scheme: "bearer";
  secret: string;
  /** Case-insensitive. Defaults to `authorization`. */
  header?: string;
  /** Literal text the sender puts before the secret, e.g. `"Bearer "`. Defaults to none. */
  prefix?: string;
}

/**
 * A digest of the body, keyed by a shared secret — the scheme M15 anticipated.
 *
 * The signed payload is the RAW BODY BYTES, optionally prefixed by `<timestamp>.` when the sender
 * transmits a timestamp to bind the signature to a moment. Both conventions are in wide use
 * (GitHub signs the body alone; Stripe signs timestamp-dot-body), and neither can be inferred from
 * a request — a vendor's documentation decides it, so config records it.
 */
export interface HmacAuthConfig {
  scheme: "hmac";
  secret: string;
  /** Case-insensitive header carrying the digest. */
  signatureHeader: string;
  /** How the digest is encoded on the wire. */
  encoding: "hex" | "base64";
  /** Literal text before the digest, e.g. `"sha256="`. Defaults to none. */
  signaturePrefix?: string;
  /**
   * Header carrying a Unix timestamp in seconds. When set, the signature covers `<timestamp>.<body>`
   * and a timestamp outside `toleranceSeconds` is refused — which is signature freshness, not
   * duplicate detection. A replay inside the window still verifies; rejecting it is M15 step 3.
   */
  timestampHeader?: string;
  /** Only meaningful with `timestampHeader`. Defaults to `DEFAULT_TOLERANCE_SECONDS`. */
  toleranceSeconds?: number;
}

export type WebhookAuthConfig = BearerAuthConfig | HmacAuthConfig;

/** A configuration this module refuses to run under. Thrown at construction, never at request time. */
export class WebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigurationError";
  }
}

export type WebhookRejection =
  | "missing_credential"
  | "duplicate_header"
  | "malformed_credential"
  | "credential_mismatch"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "timestamp_outside_tolerance";

export type WebhookVerdict =
  | { ok: true; scheme: WebhookAuthScheme }
  | { ok: false; reason: WebhookRejection; detail: string };

/** Headers as Node hands them over: lowercased keys, repeated headers as arrays. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookRequest {
  headers: WebhookHeaders;
  /**
   * The body EXACTLY as it arrived on the socket.
   *
   * Not a parsed object, and not `Buffer.from(JSON.stringify(parsed))`. A JSON round trip is free
   * to reorder keys, restyle numbers and drop insignificant whitespace, all of which change the
   * bytes and none of which change the meaning — so a re-serialised body fails every honest
   * signature and passes none. Under `bearer` the body is unread here; the type still demands the
   * raw bytes so that switching schemes cannot quietly invalidate the route that feeds it.
   */
  body: Buffer;
}

/**
 * Validate a webhook credential configuration, or throw.
 *
 * Deliberately a boot-time failure, in the same spirit as `assertBillingProviderConfigured`: the
 * failures that must never reach production belong where one person sees them once, not at the
 * moment a payer's remittance is on the wire and the only options are accept-blind or drop.
 */
export function defineWebhookAuth(config: WebhookAuthConfig): WebhookAuthConfig {
  const secret = config.secret ?? "";
  if (secret.trim() === "") {
    throw new WebhookConfigurationError(
      "FATAL: the webhook secret is empty. An unauthenticated webhook accepts a remittance from " +
        "anyone who finds the URL. Configure a secret or do not mount the route."
    );
  }
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new WebhookConfigurationError(
      `FATAL: the webhook secret is shorter than ${MIN_SECRET_BYTES} bytes. It is the only thing ` +
        `separating a real remittance from a forged one. Generate one with generateWebhookSecret().`
    );
  }

  if (config.scheme === "bearer") {
    if ((config.header ?? "authorization").trim() === "") {
      throw new WebhookConfigurationError("FATAL: the webhook credential header name is empty.");
    }
    return config;
  }

  if (config.signatureHeader.trim() === "") {
    throw new WebhookConfigurationError("FATAL: the webhook signature header name is empty.");
  }
  if (config.encoding !== "hex" && config.encoding !== "base64") {
    throw new WebhookConfigurationError(
      `FATAL: unknown webhook signature encoding "${config.encoding}". Expected "hex" or "base64".`
    );
  }
  const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (config.timestampHeader !== undefined && (!Number.isFinite(tolerance) || tolerance <= 0)) {
    throw new WebhookConfigurationError(
      "FATAL: toleranceSeconds must be a positive number — a window of zero or less refuses every " +
        "signature, including the genuine ones."
    );
  }
  return config;
}

/** A secret strong enough for `defineWebhookAuth`, to paste into the sender's console. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Authenticate an inbound webhook. Never throws; a malformed request is a verdict, not an exception.
 *
 * `now` is injected because a clock is an input: a test that cannot move time can only assert that
 * a tolerance window exists, never that it closes.
 */
export function verifyWebhookRequest(
  config: WebhookAuthConfig,
  request: WebhookRequest,
  now: Date = new Date()
): WebhookVerdict {
  return config.scheme === "bearer"
    ? verifyBearer(config, request)
    : verifyHmac(config, request, now);
}

function verifyBearer(config: BearerAuthConfig, request: WebhookRequest): WebhookVerdict {
  const name = config.header ?? "authorization";
  const presented = readHeader(request.headers, name);
  if (presented.kind !== "one") return headerProblem(presented, name);

  const prefix = config.prefix ?? "";
  if (prefix !== "" && !presented.value.startsWith(prefix)) {
    /**
     * A mismatched prefix is reported as malformed rather than as a mismatch, and the distinction
     * is only ever for the operator reading a log: it separates "the sender is configured to send
     * `Bearer <token>` and we expect a bare token" — a configuration error that would otherwise look
     * exactly like an attack — from a credential that genuinely does not match.
     */
    return {
      ok: false,
      reason: "malformed_credential",
      detail: `The ${name} header did not begin with the configured prefix.`,
    };
  }

  const candidate = presented.value.slice(prefix.length);
  return secretEquals(candidate, config.secret)
    ? { ok: true, scheme: "bearer" }
    : { ok: false, reason: "credential_mismatch", detail: `The ${name} credential did not match.` };
}

function verifyHmac(config: HmacAuthConfig, request: WebhookRequest, now: Date): WebhookVerdict {
  const presented = readHeader(request.headers, config.signatureHeader);
  if (presented.kind !== "one") return headerProblem(presented, config.signatureHeader);

  const prefix = config.signaturePrefix ?? "";
  if (prefix !== "" && !presented.value.startsWith(prefix)) {
    return {
      ok: false,
      reason: "malformed_credential",
      detail: `The ${config.signatureHeader} header did not begin with the configured prefix.`,
    };
  }
  const signature = presented.value.slice(prefix.length).trim();
  if (signature === "") {
    return {
      ok: false,
      reason: "malformed_credential",
      detail: `The ${config.signatureHeader} header carried no digest.`,
    };
  }

  let signedPayload = request.body;
  if (config.timestampHeader !== undefined) {
    const stamp = readHeader(request.headers, config.timestampHeader);
    if (stamp.kind === "absent") {
      return {
        ok: false,
        reason: "missing_timestamp",
        detail: `The signature is timestamped but no ${config.timestampHeader} header was sent.`,
      };
    }
    if (stamp.kind !== "one") return headerProblem(stamp, config.timestampHeader);

    // Unix seconds, and nothing else. `Number()` would read "" as 0, " 12 " as 12 and "0x10" as 16,
    // each of which turns a malformed timestamp into a confidently wrong one.
    if (!/^\d{1,15}$/.test(stamp.value.trim())) {
      return {
        ok: false,
        reason: "malformed_timestamp",
        detail: `The ${config.timestampHeader} header was not a Unix timestamp in seconds.`,
      };
    }
    const sent = Number(stamp.value.trim());
    const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    // Absolute, so a timestamp from the future is as unacceptable as a stale one. A sender whose
    // clock runs ahead is a misconfiguration; a signature minted for later is how a captured
    // delivery is held and used.
    if (Math.abs(Math.floor(now.getTime() / 1000) - sent) > tolerance) {
      return {
        ok: false,
        reason: "timestamp_outside_tolerance",
        detail: `The signed timestamp was more than ${tolerance}s from now.`,
      };
    }
    signedPayload = Buffer.concat([Buffer.from(`${stamp.value.trim()}.`, "utf8"), request.body]);
  }

  const expected = createHmac("sha256", config.secret).update(signedPayload).digest(config.encoding);
  return secretEquals(signature, expected)
    ? { ok: true, scheme: "hmac" }
    : {
        ok: false,
        reason: "credential_mismatch",
        detail: `The ${config.signatureHeader} digest did not match the body.`,
      };
}

type HeaderRead =
  | { kind: "one"; value: string }
  | { kind: "absent" }
  | { kind: "duplicate" };

/**
 * Read exactly one header value, case-insensitively.
 *
 * A repeated header is refused rather than resolved. Node surfaces the repeat as an array and the
 * obvious move is to take `[0]` — but "which copy counts" is precisely the disagreement between an
 * intermediary and this process that request smuggling is built on, and a gate that picks a copy
 * has already conceded the argument. There is no legitimate delivery that sends its credential
 * twice.
 */
function readHeader(headers: WebhookHeaders, name: string): HeaderRead {
  const wanted = name.toLowerCase();
  let found: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = headers[key];
    if (Array.isArray(raw)) {
      if (raw.length > 1) return { kind: "duplicate" };
      if (raw.length === 0) continue;
      if (found !== undefined) return { kind: "duplicate" };
      found = raw[0];
      continue;
    }
    if (raw === undefined) continue;
    if (found !== undefined) return { kind: "duplicate" };
    found = raw;
  }
  if (found === undefined || found.trim() === "") return { kind: "absent" };
  return { kind: "one", value: found };
}

function headerProblem(read: HeaderRead, name: string): WebhookVerdict {
  return read.kind === "duplicate"
    ? { ok: false, reason: "duplicate_header", detail: `The ${name} header was sent more than once.` }
    : { ok: false, reason: "missing_credential", detail: `No ${name} header was sent.` };
}

/**
 * Constant-time string equality that leaks neither content nor length.
 *
 * `timingSafeEqual` throws when its arguments differ in length, so the usual shape is to guard with
 * `a.length === b.length` first — which answers "how long is the secret?" through a fast path, one
 * request at a time. Comparing SHA-256 digests instead makes every comparison 32 bytes against 32
 * bytes: an attacker measuring the compare learns the same thing for every input they can send,
 * which is nothing.
 */
function secretEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
