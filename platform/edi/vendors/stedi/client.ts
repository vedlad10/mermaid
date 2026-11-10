/**
 * The Stedi HTTP transport. Nothing here knows what a benefit is — it moves bytes and classifies
 * failures, and that is deliberately the whole job (same split as `platform/llm`'s provider seam:
 * one file that talks to a vendor, one file that decides what the answer means).
 *
 * ── THE SECRET NEVER LEAVES THIS PROCESS ───────────────────────────────────────────────────────
 * The API key is read from config by the composition root, handed to this client, and put on an
 * `Authorization` header. It is never logged, never placed in a URL, never included in an error
 * message, and never serialized into anything a module or the browser can see. `EdiResult.raw`
 * carries the X12 payload for the audit trail, never the request headers.
 */
import type { EdiError } from "../../adapter.ts";

/** What Stedi's real-time eligibility endpoint accepts. Only the fields Mermaid actually sends. */
export interface StediEligibilityRequest {
  /** Payer id, leading zeros significant (`00540`, not `540`). */
  tradingPartnerServiceId: string;
  encounter: { serviceTypeCodes: string[]; dateOfService?: string };
  provider: { organizationName: string; npi: string };
  subscriber: {
    firstName?: string;
    lastName?: string;
    memberId?: string;
    dateOfBirth?: string;
  };
}

/**
 * What comes back. Narrow on purpose — Stedi returns a large document and this names only what is
 * read, so an unexpected extra field is ignored rather than being a type error, and a *missing*
 * field is a mapping decision rather than a crash.
 */
export interface StediEligibilityResponse {
  meta?: { traceId?: string; applicationMode?: string };
  /** The complete 271, which is what Mermaid's production parser actually consumes. */
  x12?: string;
  errors?: { code?: string; description?: string; field?: string }[];
  subscriber?: Record<string, unknown>;
  benefitsInformation?: unknown[];
  [key: string]: unknown;
}

export interface StediClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /**
   * Stedi's EDI-platform host, which is NOT the healthcare host.
   *
   * Polling and artifact retrieval live on `core.us.stedi.com`; eligibility and claims live on
   * `healthcare.us.stedi.com`. Two hosts, one credential. Recording this as configuration rather
   * than deriving it from `baseUrl` is deliberate — an earlier probe concluded Stedi had no polling
   * endpoint at all, and that conclusion came from asking the healthcare host for a core path.
   */
  coreBaseUrl?: string;
  /**
   * Extra hosts an ERA artifact may be downloaded from, beyond `DEFAULT_ARTIFACT_HOSTS` (NEW-24).
   *
   * Additive to the defaults, not a replacement.
   */
  artifactHosts?: readonly string[];
  /** Ceiling on a retrieved artifact, in bytes. An ERA larger than this is refused, not truncated. */
  maxArtifactBytes?: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface StediCallResult<T = StediEligibilityResponse> {
  ok: boolean;
  status: number;
  body?: T;
  error?: EdiError;
  /** The response body as received, for the audit trail. Never the request. */
  rawBody?: string;
  /** Selected response headers — `location` only, for following a redirect by hand. */
  headers?: Record<string, string>;
}

/** The redirect target, when the pointer came back as a bare 3xx rather than a JSON body. */
const locationOf = (result: StediCallResult<unknown>): string | undefined => result.headers?.location;

/**
 * What Stedi returns from a raw-X12 dental claim submission. `x12` is the payer’s 277CA
 * acknowledgement, which means the existing production `parse277CA` reads it unchanged.
 */
export interface StediClaimResponse {
  status?: string;
  controlNumber?: string;
  claimReference?: { correlationId?: string; patientControlNumber?: string; payerId?: string };
  payer?: { payerId?: string; payerName?: string };
  /** The 277CA, in X12. */
  x12?: string;
  errors?: { code?: string; description?: string; followupAction?: string; location?: string; value?: string }[];
}

/** One inbound transaction Stedi has processed for this account. Only the fields Mermaid reads. */
export interface StediPolledTransaction {
  transactionId?: string;
  /** The handle the raw X12 is fetched by. Without it there is nothing to retrieve. */
  fileExecutionId?: string;
  /** `INBOUND` = it came from the payer. Filtered client-side; the API takes no such parameter. */
  direction?: string;
  status?: string;
  mode?: string;
  processedAt?: string;
  x12?: { transactionSetIdentifier?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface StediPollResponse {
  items?: StediPolledTransaction[];
  transactions?: StediPolledTransaction[];
  nextPageToken?: string;
  [k: string]: unknown;
}

/** The 270/271 real-time path. Documented at stedi.com/docs/healthcare/send-eligibility-checks. */
const ELIGIBILITY_PATH = "/2024-04-01/change/medicalnetwork/eligibility/v3";
/**
 * Verified against the live sandbox, not inferred: this path answers by naming the missing `x12`
 * field, while the `change/medicalnetwork/dentalclaims/v3` shape that eligibility uses answers 404.
 * The two endpoints belong to different generations of Stedi’s API and do not share a prefix.
 */
const DENTAL_CLAIM_PATH = "/dental-claims/raw-x12-submission";

/**
 * Hosts an ERA artifact may actually be fetched from (NEW-24).
 *
 * Suffix-matched on the registrable domain rather than exact-matched, because a pre-signed URL is
 * issued against a bucket-specific or region-specific hostname that this code cannot enumerate:
 * `mermaid-era.s3.us-east-2.amazonaws.com` is legitimate and unpredictable. The suffix is what is
 * knowable, and matching it as a suffix WITH the leading dot is what stops
 * `evil-amazonaws.com` and `amazonaws.com.attacker.net` from passing.
 *
 * `STEDI_ARTIFACT_HOSTS` extends it for a deployment whose vendor serves from somewhere else. An
 * allowlist that cannot be extended is one somebody works around by deleting the check.
 */
const DEFAULT_ARTIFACT_HOSTS: readonly string[] = [
  "stedi.com",
  "amazonaws.com",
  "cloudfront.net",
];

/** Where ERA polling and artifact retrieval live. Not the healthcare host — see `coreBaseUrl`. */
export const STEDI_CORE_BASE_URL = "https://core.us.stedi.com";
const POLL_PATH = "/2023-08-01/polling/transactions";
/** `GET /2023-08-01/executions/{id}/input` — the file BEFORE any translation, i.e. the real X12. */
const EXECUTION_INPUT_PATH = (executionId: string) =>
  `/2023-08-01/executions/${encodeURIComponent(executionId)}/input`;

/**
 * Default ceiling on one retrieved ERA, in bytes.
 *
 * A cap is not optional here. The download URL points at object storage, so the body size is
 * whatever the payer sent, and an unbounded read is a memory-exhaustion vector on a box this
 * software is expected to run on. 8 MB is far above a real dental ERA and far below trouble.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export class StediClient {
  #apiKey: string;
  #baseUrl: string;
  #coreBaseUrl: string;
  /** Hosts this deployment will fetch an ERA artifact from. See `DEFAULT_ARTIFACT_HOSTS`. */
  #artifactHosts: readonly string[];
  #maxArtifactBytes: number;
  #timeoutMs: number;
  #fetch: typeof fetch;

  constructor(options: StediClientOptions) {
    if (!options.apiKey) throw new Error("StediClient requires an API key (STEDI_API_KEY)");
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#coreBaseUrl = (options.coreBaseUrl ?? STEDI_CORE_BASE_URL).replace(/\/+$/, "");
    // Extended, never replaced: a deployment adding its vendor's host must not be able to remove
    // the defaults by accident and discover it months later, when nothing fetches.
    this.#artifactHosts = [...DEFAULT_ARTIFACT_HOSTS, ...(options.artifactHosts ?? [])];
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Ask Stedi what it has processed since `cursor`.
   *
   * `direction` and `transactionSetIdentifier` are RESPONSE fields, not query parameters — the API
   * takes only a cursor and a page size — so the 835/INBOUND filter is applied by the caller. That
   * is documented here because writing them as query parameters produces a silently unfiltered
   * page rather than an error.
   */
  async pollTransactions(
    cursor: string | null,
    startDateTime: string,
    pageSize = 100
  ): Promise<StediCallResult<StediPollResponse>> {
    // One of pageToken / startDateTime is required. The cursor wins once we have one, so a restart
    // resumes exactly where it stopped instead of re-walking (or skipping) a window.
    const query = cursor
      ? `pageToken=${encodeURIComponent(cursor)}`
      : `startDateTime=${encodeURIComponent(startDateTime)}`;
    return this.#request<StediPollResponse>(
      `${this.#coreBaseUrl}${POLL_PATH}?${query}&pageSize=${pageSize}`,
      { method: "GET" }
    );
  }

  /**
   * Retrieve one artifact's ORIGINAL X12, by `fileExecutionId`.
   *
   * Two hops, because that is what the endpoint does: it answers with a short-lived
   * `documentDownloadUrl` rather than the bytes. The redirect is followed explicitly rather than by
   * `fetch`'s automatic handling, for one security reason that matters:
   *
   *   **THE API KEY MUST NOT TRAVEL TO THE DOWNLOAD HOST.** That URL is pre-signed and points at
   *   object storage on a different origin. Letting the client carry the `Authorization` header
   *   through the redirect would hand Mermaid's clearinghouse credential to a third-party host on
   *   every ERA fetch. So the second hop is a bare request with no credential of ours on it.
   *
   * Returns the raw X12 as text. Never JSON, never a summary — the raw file is the authoritative
   * input to Mermaid's own parser, and a vendor's parsed representation is explicitly not a
   * substitute for it.
   */
  async fetchExecutionInput(executionId: string): Promise<StediCallResult<string>> {
    if (!executionId.trim()) {
      return {
        ok: false,
        status: 0,
        error: {
          code: "parse_error",
          message: "Cannot retrieve an ERA without a fileExecutionId.",
          retryable: false,
        },
      };
    }

    const pointer = await this.#request<{ documentDownloadUrl?: string }>(
      `${this.#coreBaseUrl}${EXECUTION_INPUT_PATH(executionId)}`,
      { method: "GET", redirect: "manual" }
    );
    if (!pointer.ok) return { ok: false, status: pointer.status, error: pointer.error, ...(pointer.rawBody ? { rawBody: pointer.rawBody } : {}) };

    /**
     * The body may already BE the document when a client or proxy followed the redirect for us.
     * Distinguished by shape rather than by status code: a JSON object carrying
     * `documentDownloadUrl` is a pointer, anything else is treated as the artifact itself.
     */
    const downloadUrl = pointer.body?.documentDownloadUrl ?? locationOf(pointer);
    if (!downloadUrl) {
      const alreadyTheDocument = (pointer.rawBody ?? "").trim();
      if (alreadyTheDocument) return { ok: true, status: pointer.status, body: alreadyTheDocument, rawBody: alreadyTheDocument };
      return {
        ok: false,
        status: pointer.status,
        error: {
          code: "parse_error",
          message: `Stedi returned no documentDownloadUrl for execution ${executionId}.`,
          retryable: false,
        },
      };
    }

    return this.#downloadArtifact(downloadUrl);
  }

  /**
   * Refuse an artifact URL this deployment has not agreed to fetch from — or `null` to proceed.
   *
   * `retryable: false`, deliberately. A URL pointing somewhere unexpected will point there again on
   * every retry, and retrying an SSRF attempt on a schedule is worse than not retrying it. The
   * artifact dead-letters and a human reads the host that was refused, which is the information
   * that matters.
   */
  #refuseUntrustedArtifactUrl(url: string): StediCallResult<string> | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        ok: false,
        status: 0,
        error: {
          code: "parse_error",
          message: `The clearinghouse returned an ERA download URL that is not a URL: ${url.slice(0, 120)}`,
          retryable: false,
        },
      };
    }

    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        status: 0,
        error: {
          code: "parse_error",
          // An 835 names every patient on the advice and what they were paid for. Over plain HTTP
          // it is readable by anything on the path, and this hop carries no credential that would
          // make an attacker's substitute obviously wrong.
          message: `Refusing to fetch an ERA over ${parsed.protocol}// — a remittance is PHI and this hop is unauthenticated.`,
          retryable: false,
        },
      };
    }

    const host = parsed.hostname.toLowerCase();
    const allowed = this.#artifactHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (!allowed) {
      return {
        ok: false,
        status: 0,
        error: {
          code: "parse_error",
          message:
            `Refusing to fetch an ERA from "${host}": it is not an allowed artifact host. This hop ` +
            `is unauthenticated and its response is parsed as a payment file, so the host is checked ` +
            `rather than trusted. Allowed: ${this.#artifactHosts.join(", ")}. Set ` +
            `STEDI_ARTIFACT_HOSTS if this deployment's clearinghouse genuinely serves from elsewhere.`,
          retryable: false,
        },
      };
    }
    return null;
  }

  /** The second hop: a bare, unauthenticated GET of a pre-signed URL, size-capped. */
  async #downloadArtifact(url: string): Promise<StediCallResult<string>> {
    /**
     * ── THE URL COMES FROM A VENDOR RESPONSE, SO IT IS CHECKED BEFORE IT IS FETCHED (NEW-24) ────
     *
     * `documentDownloadUrl` is whatever the previous response said, and this hop is deliberately
     * UNAUTHENTICATED — it carries no API key, which is what makes a pre-signed URL work. That
     * combination is a server-side request forgery primitive: anything that can influence that
     * field gets this process to issue a GET from inside the deployment's network, and whatever
     * comes back is handed to the 835 parser as a payer's payment file.
     *
     * The realistic route in is not "Stedi is malicious". It is a compromised or misconfigured
     * vendor account, a response served through something in the middle, or a future adapter
     * pointed at a staging host that returns a URL nobody audited. A pre-signed URL is exactly the
     * shape of thing nobody looks at twice.
     *
     * So the host is checked against a list, and `http://169.254.169.254/latest/meta-data/` —
     * cloud instance credentials, the classic SSRF target — is refused with the same code path as
     * a typo.
     */
    const refusal = this.#refuseUntrustedArtifactUrl(url);
    if (refusal) return refusal;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        // NO Authorization header. See the note on `fetchExecutionInput`.
        response = await this.#fetch(url, { method: "GET", signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return { ok: false, status: 0, error: timeoutError(this.#timeoutMs) };
        return {
          ok: false,
          status: 0,
          error: {
            code: "unavailable",
            message: `Could not download the ERA artifact: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }

      if (!response.ok) {
        return { ok: false, status: response.status, error: httpError(response.status, "") };
      }

      /**
       * Refuse an oversized artifact on the ADVERTISED length before reading it, then again on the
       * length actually read — a missing or lying `content-length` must not be the only guard, or
       * the cap is advisory.
       */
      const advertised = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(advertised) && advertised > this.#maxArtifactBytes) {
        return { ok: false, status: response.status, error: tooLarge(advertised, this.#maxArtifactBytes) };
      }

      const text = await response.text().catch(() => "");
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > this.#maxArtifactBytes) {
        return { ok: false, status: response.status, error: tooLarge(bytes, this.#maxArtifactBytes) };
      }

      return { ok: true, status: response.status, body: text, rawBody: text };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkEligibility(request: StediEligibilityRequest): Promise<StediCallResult<StediEligibilityResponse>> {
    return this.#post<StediEligibilityResponse>(ELIGIBILITY_PATH, request);
  }

  /**
   * Submit a dental claim as raw X12 837D.
   *
   * `POST /dental-claims/raw-x12-submission`, body `{ x12 }` — confirmed against the live sandbox
   * rather than taken from documentation alone: the older `change/medicalnetwork/dentalclaims/v3`
   * shape that eligibility uses answers 404 here, and this one answers by naming the missing `x12`
   * field. Stedi writes its own ISA/GS envelope, so ours is replaced in flight; ST03 must still be
   * `005010X224A2` and the payer id in loop 2010BB must be one Stedi’s network recognises.
   *
   * `Idempotency-Key` is the whole reason a retry is safe. The outbox delivers at least once and a
   * biller may press submit twice; without it either would file the claim again. Stedi honours the
   * key for 24 hours, which is longer than any retry window here.
   */
  async submitDentalClaim(x12: string, idempotencyKey: string): Promise<StediCallResult<StediClaimResponse>> {
    return this.#post<StediClaimResponse>(DENTAL_CLAIM_PATH, { x12 }, { "idempotency-key": idempotencyKey });
  }

  /**
   * A GET against a full URL on either host, carrying the credential.
   *
   * Separate from `#post` because the ERA paths are on a different host and take no body. A 3xx is
   * NOT an error here: `redirect: "manual"` makes the pointer response observable so the caller can
   * decide what to do with the location, which is the whole reason this exists.
   */
  async #request<T>(url: string, init: RequestInit): Promise<StediCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          ...init,
          headers: { authorization: this.#apiKey, accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return { ok: false, status: 0, error: timeoutError(this.#timeoutMs) };
        return {
          ok: false,
          status: 0,
          error: {
            code: "unavailable",
            message: `Could not reach Stedi: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }

      const rawBody = await response.text().catch(() => "");
      const location = response.headers.get("location");
      const headers = location ? { location } : undefined;

      const redirected = response.status >= 300 && response.status < 400;
      if (!response.ok && !redirected) {
        return { ok: false, status: response.status, rawBody, error: httpError(response.status, rawBody), ...(headers ? { headers } : {}) };
      }

      let body: T | undefined;
      try {
        body = rawBody ? (JSON.parse(rawBody) as T) : undefined;
      } catch {
        // Not JSON. Legitimate for an artifact body, so the raw text is returned rather than an error.
        body = undefined;
      }
      return { ok: true, status: response.status, ...(body !== undefined ? { body } : {}), rawBody, ...(headers ? { headers } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  async #post<T>(path: string, request: unknown, extraHeaders: Record<string, string> = {}): Promise<StediCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: "POST",
          headers: {
            // Stedi takes the key bare on Authorization — no "Bearer" prefix.
            authorization: this.#apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return { ok: false, status: 0, error: timeoutError(this.#timeoutMs) };
        }
        return {
          ok: false,
          status: 0,
          error: {
            code: "unavailable",
            // The message, not the exception object: a thrown error can carry request context.
            message: `Could not reach Stedi: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }

      const rawBody = await response.text().catch(() => "");

      if (!response.ok) {
        return { ok: false, status: response.status, rawBody, error: httpError(response.status, rawBody) };
      }

      let body: T;
      try {
        body = JSON.parse(rawBody) as T;
      } catch {
        return {
          ok: false,
          status: response.status,
          rawBody,
          error: {
            code: "parse_error",
            message: "Stedi returned a body that was not JSON.",
            retryable: false,
          },
        };
      }

      return { ok: true, status: response.status, body, rawBody };
    } finally {
      clearTimeout(timer);
    }
  }
}

const timeoutError = (ms: number): EdiError => ({
  code: "timeout",
  message: `Stedi did not respond within ${ms}ms.`,
  retryable: true,
});

/**
 * An artifact past the ceiling. **Not retryable** — the file will be the same size next time, and
 * retrying it forever would occupy a worker slot that real ERAs need. It stays on the ledger as a
 * failure a human is told about, which is the only honest outcome: money was offered and Mermaid
 * declined to read it.
 */
const tooLarge = (bytes: number, limit: number): EdiError => ({
  code: "parse_error",
  message:
    `The ERA artifact is ${bytes} bytes, over the ${limit}-byte ceiling. It was NOT read. ` +
    `Retrieve it from the clearinghouse portal and ingest it by hand, or raise the ceiling.`,
  retryable: false,
});

/**
 * Map an HTTP status onto Mermaid's error vocabulary.
 *
 * The retryable/not split is the load-bearing part, because the outbox acts on it. A 401 retried
 * on every screen load is how a key gets rate-limited into a lockout; a 503 *not* retried is a
 * verification a clinic has to redo by hand.
 *
 * Stedi's own error text is folded in only for the 4xx cases a biller can act on ("payer not
 * found", "member id required") — never for 401/403, whose bodies can echo request context.
 */
function httpError(status: number, rawBody: string): EdiError {
  if (status === 401 || status === 403) {
    return {
      code: "unavailable",
      message: `Stedi rejected the credentials (HTTP ${status}). Check STEDI_API_KEY and its mode.`,
      retryable: false,
    };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Stedi rate-limited this eligibility check.", retryable: true };
  }
  if (status === 408 || status === 504) {
    return { code: "timeout", message: `Stedi timed out (HTTP ${status}).`, retryable: true };
  }
  if (status >= 500) {
    return { code: "unavailable", message: `Stedi is unavailable (HTTP ${status}).`, retryable: true };
  }
  const detail = describeErrors(rawBody);
  return {
    code: status === 400 && /member|subscriber|patient/i.test(detail) ? "invalid_member_id" : "unavailable",
    message: `Stedi refused the request (HTTP ${status})${detail ? `: ${detail}` : ""}.`,
    retryable: false,
  };
}

/**
 * Stedi's account-level refusal codes, explained in Mermaid's own words. Only the CODE is taken from
 * the body — it is an identifier — so nothing Stedi echoes from the request can reach a log.
 */
const ACCOUNT_REFUSALS: Readonly<Record<string, string>> = {
  /**
   * Seen on 2026-10-15 for a test claim that had cleared every payer edit. Stedi's docs: "Sandbox
   * accounts can't submit test claims" — a production Stedi account is required, even for test mode.
   * In August the same submissions came back as a bare `500 INTERNAL_ERROR`.
   */
  ACCOUNT_NOT_PROVISIONED:
    "ACCOUNT_NOT_PROVISIONED — this Stedi account is not provisioned for this operation. Claim " +
    "submission (test or live) needs a production Stedi account; a sandbox account cannot submit claims",
};

/** Pull the human-readable part out of a Stedi error body, bounded so a huge body cannot be logged. */
function describeErrors(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as StediEligibilityResponse & { code?: unknown };
    const messages = (parsed.errors ?? [])
      .map((e) => [e.field, e.description ?? e.code].filter(Boolean).join(" "))
      .filter((m) => m.length > 0);
    if (messages.length === 0 && typeof parsed.code === "string" && /^[A-Z_]{3,64}$/.test(parsed.code)) {
      // A top-level `{code, message}` is how Stedi refuses at the account level. Without this the
      // operator read only "HTTP 400" and the reason was discarded.
      messages.push(ACCOUNT_REFUSALS[parsed.code] ?? parsed.code);
    }
    return messages.join("; ").slice(0, 300);
  } catch {
    return "";
  }
}
