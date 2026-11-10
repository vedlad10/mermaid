/**
 * Mermaid clinic web app — a zero-dependency Node HTTP server over the module services.
 *
 * WHY node:http and not Next.js (a deliberate, flagged deviation from blueprint doc 06/14):
 * the whole codebase runs TypeScript directly under Node with near-zero dependencies and no build
 * step (a foundational project doctrine), and the dev hardware can't comfortably run a Next.js
 * toolchain. This server preserves what actually matters in the blueprint — the versioned
 * `/api/v1/*` contract (doc 06) and the "BFF over module services" shape — and only changes the
 * transport. Dropping Next.js in later is additive.
 *
 * ── WHAT M6 CHANGED HERE ───────────────────────────────────────────────────────────────────────
 * Two things, both structural:
 *
 *  1. **One transaction per request.** On Postgres, every API request touching tenant data runs
 *     inside `withPractice(session.user.practiceId)`. That single decision buys three properties at
 *     once: RLS is armed for every query the request makes, the business write and its domain event
 *     commit atomically (the outbox's core promise), and a handler that throws rolls the entire
 *     request back. No module service changed to gain any of it.
 *
 *  2. **The practice comes from the SESSION, never from the request.** No route, header or body
 *     field anywhere can select a tenant. That is the difference between multi-tenancy enforced by
 *     the database and multi-tenancy enforced by hope.
 *
 * Money still crosses dollars→cents exactly once, at this boundary (design decision §12.1).
 * Composition — which repositories, which outbox — lives in wiring.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { CLEARINGHOUSE_NAME, IMPORT_FIELDS, InvalidAppointmentWindowError, VerificationNotFoundError } from "@mermaid/verification";
import type { PatientAddress, ScheduledVisit, VerificationInput } from "@mermaid/verification";
import { MockEdiAdapter, StediEdiAdapter, getEdiAdapter } from "@mermaid/edi";
import {
  ClaimNotFoundError,
  ClaimNotSubmittableError,
  ClaimSubmissionFailedError,
  InvalidClaimTransitionError,
  buildClaimTimeline,
  isPlaceholderBillingIdentity,
} from "@mermaid/claims";
import {
  CoordinationCaseNotFoundError,
  CoordinationRefusedError,
  RemittanceNotFoundError,
  RemittanceUnavailableError,
} from "@mermaid/remittance";
import { coordinationWorkItem, isOpen, listCoordinationWork } from "./coordination.ts";
import {
  ContractualDenialNotBillableError,
  DenialActionError,
  DenialNotFoundError,
  buildRecoveryStats,
} from "@mermaid/denials-appeals";
import { LedgerActionError, PatientAccountNotFoundError } from "@mermaid/patient-ledger";
import {
  AuthError,
  RateLimiter,
  confirmPasswordReset,
  ensureSeeded,
  guard,
  inviteUser,
  listUsers,
  login,
  logout,
  beginMfaEnrollment,
  completeMfaEnrollment,
  disableMfa,
  mfaEnabledFor,
  resetUserMfa,
  verifyMfa,
  reportedIdleMs,
  requestPasswordReset,
  setUserAccess,
  setUserRole,
  type LoginResult,
  type ResolvedSession,
} from "@mermaid/auth";
import { requireContext, withPractice, withPracticeScope, withoutPractice } from "@mermaid/db";
import { createAlertNotifier, listPhiAccess, logger, recordAudit, recordPhiAccess } from "@mermaid/observability";
import { assertPhiKeyInProduction, phiEncryptionEnabled } from "@mermaid/crypto";
import { getConfig, secretInventory } from "@mermaid/config";
import type { ClientIpSource } from "@mermaid/config";
import { defineWebhookAuth, verifyWebhookRequest } from "@mermaid/webhook";
import {
  CDT_CATALOG,
  calendarDay,
  can,
  cents,
  formatUsd,
  isUuid,
  isWholeCents,
  type Permission,
  PERMISSIONS,
  type Role,
  type SubscriberIdentity,
  type SubscriberRelationship,
  type TreatmentPlanItem,
  zonedInstant,
} from "@mermaid/shared";
import { buildServices, outboxIntervalMs, startOutboxWorker, type Services } from "./wiring.ts";
import { startEraWorker } from "./era-worker.ts";
import {
  DEFAULT_THRESHOLDS,
  FULL_PRICE_RUN_LIMIT,
  RATE_RESTATEMENT_LIMIT,
  startMonitors,
  takeReadings,
  type MonitorReading,
} from "./monitors.ts";
import { buildTodayQueue } from "./today.ts";
import { buildPatientRecord } from "./patient-record.ts";
import { INTEGRATION_REPORT } from "./integration-scenarios.ts";

export { buildServices };
export type { Services };

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────────────

/**
 * What a handler needs from a response. `ServerResponse` satisfies it structurally, and so does
 * `DeferredResponse` below — which is what lets a request finish its work, dispatch its domain
 * events, and only THEN send a reply.
 */
interface ResponseSink {
  headersSent: boolean;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: unknown): unknown;
}

/**
 * A response held in memory until the request is truly finished.
 *
 * WHY: the outbox is asynchronous by design — `publish()` only enqueues, and the worker dispatches
 * after the business transaction commits. Writing the reply the moment the handler returns would
 * unblock the client BEFORE its own events had been dispatched, so an immediate follow-up read could
 * miss the claim its verification just created. That is not a hypothetical: it showed up the first
 * time the full cycle was driven over HTTP.
 *
 * Buffering lets a request be read-your-writes consistent without making the outbox synchronous:
 * handlers still never dispatch inside their transaction, and the guarantee that an event cannot be
 * emitted for a rolled-back write is untouched. Only the reply waits.
 */
class DeferredResponse implements ResponseSink {
  status = 200;
  headers = new Map<string, string | number | readonly string[]>();
  body: unknown = undefined;
  headersSent = false;

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name.toLowerCase(), value);
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers.set(k.toLowerCase(), v);
    this.headersSent = true;
  }

  end(chunk?: unknown): void {
    this.body = chunk;
    this.headersSent = true;
  }

  /** Copy the buffered reply onto the real socket. */
  flushTo(res: ServerResponse): void {
    if (res.headersSent) return;
    for (const [name, value] of this.headers) res.setHeader(name, value as string);
    res.writeHead(this.status);
    res.end(this.body as never);
  }
}
function sendJson(res: ResponseSink, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // The single funnel for every API response, including `sendError` and `sendDomainError` — so the
  // security headers are attached here rather than at each of the ~60 call sites (NEW-13).
  applySecurityHeaders(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** The blueprint error envelope (doc 06): { error: { code, message } }. */
function sendError(res: ResponseSink, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
}

/**
 * Parse an address correction body — V5, shared by BOTH the patient-record and claim routes.
 *
 * One function on purpose. Two routes accepting "an address" with independently written validation
 * is how they drift, and the drift would be silent: the claim route would accept something the
 * patient route rejects, and the practice's own record would stop agreeing with what it filed.
 *
 * `null` is a legal value on the PATIENT route and means "remove this, it is wrong". It is refused
 * on the CLAIM route, because a claim with no address cannot be filed and clearing one there would
 * only re-block the claim the caller is trying to unblock — see the handlers.
 *
 * Every component is required together. A partial address passes the scrubber's presence check and
 * is then rejected by the payer, which costs a submission to discover.
 */
function parseAddressBody(body: unknown): { street: string; city: string; state: string; zip: string } | null {
  const raw = body as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") {
    throw new ApiError(400, "validation_error", "An address object is required.");
  }
  if (raw.address === null) return null;
  const a = (raw.address ?? raw) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const street = str(a.street);
  const city = str(a.city);
  const state = str(a.state).toUpperCase();
  // Accept what staff actually type; the 837 carries digits only.
  const zip = str(a.zip).replace(/-/g, "");

  if (!street || !city || !state || !zip) {
    throw new ApiError(
      400,
      "validation_error",
      "street, city, state and zip are all required — a partial address cannot go on a claim."
    );
  }
  // Checked here as well as in the scrubber so the person typing gets the error at the moment they
  // type it, rather than as a blocking finding after they have saved and moved on.
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new ApiError(400, "validation_error", `"${state}" is not a two-letter USPS state code.`);
  }
  if (!/^[0-9]{5}([0-9]{4})?$/.test(zip)) {
    throw new ApiError(400, "validation_error", `"${zip}" is not a 5- or 9-digit ZIP.`);
  }
  return { street, city, state, zip };
}

/**
 * How large an uploaded 835 may be (NEW-15).
 *
 * The global `MAX_BODY_BYTES` is 1 MB, sized for a JSON form post carrying a treatment plan and at
 * most two card photographs. An ERA is a different kind of object: a month-end file from a large
 * payer routinely runs to several megabytes of plain ASCII, and there is nothing a practice can do
 * to make theirs smaller.
 *
 * 8 MB, and stated as its own constant rather than by raising the global one — the reason the global
 * cap is small is that every other route accepts a form, and widening it for all of them to fit one
 * would remove a real protection everywhere to solve a problem in one place.
 */
const MAX_REMITTANCE_BYTES = 8_000_000;

/**
 * Read an uploaded 835, as raw bytes or as the JSON envelope the existing clients send.
 *
 * Content type decides, and an unrecognised one is treated as raw: an EDI file arrives with all
 * sorts of types (`application/edi-x12`, `text/plain`, `application/octet-stream`, or nothing at
 * all from a `curl`), and refusing on that basis would reject a perfectly good payment file over a
 * header nobody chose deliberately.
 */
async function readRemittanceBody(req: IncomingMessage, services?: Services): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    /* Same reason as `readJsonBody`: decided here, raised after the stream ends, so the practice
       uploading a too-large file receives the sentence explaining what to do about it. */
    if (total > MAX_REMITTANCE_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    throw new ApiError(
      413,
      "payload_too_large",
      `This remittance is larger than ${Math.round(MAX_REMITTANCE_BYTES / 1_000_000)} MB. Upload ` +
        `the payer's file as it was downloaded — if it is genuinely this large, it needs splitting ` +
        `by the payer, not by hand.`
    );
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim() === "") throw new ApiError(400, "validation_error", "The uploaded remittance is empty.");

  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // Stedi Destination console ping / health probe
      if (obj.type === "ping" || obj.test === true || obj.ping === true || obj.event === "test") {
        return "__PING__";
      }

      if (typeof obj.raw835 === "string" && obj.raw835.trim()) return obj.raw835;
      if (typeof obj.x12 === "string" && obj.x12.trim()) return obj.x12;
      if (typeof obj.era === "string" && obj.era.trim()) return obj.era;
      if (typeof obj.raw === "string" && obj.raw.trim()) return obj.raw;
      if (typeof obj.body === "string" && obj.body.trim()) return obj.body;
      if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
      if (typeof obj.data === "string" && obj.data.trim()) return obj.data;
      if (obj.output && typeof obj.output === "object") {
        const out = obj.output as Record<string, unknown>;
        if (typeof out.body === "string" && out.body.trim()) return out.body;
      }
      if (obj.detail && typeof obj.detail === "object") {
        const detail = obj.detail as Record<string, unknown>;
        if (detail.type === "ping" || detail.test === true) return "__PING__";
        if (typeof detail.x12 === "string" && detail.x12.trim()) return detail.x12;
        if (typeof detail.raw835 === "string" && detail.raw835.trim()) return detail.raw835;
        if (typeof detail.body === "string" && detail.body.trim()) return detail.body;
        if (typeof detail.content === "string" && detail.content.trim()) return detail.content;
        if (detail.output && typeof detail.output === "object") {
          const detailOut = detail.output as Record<string, unknown>;
          if (typeof detailOut.body === "string" && detailOut.body.trim()) return detailOut.body;
        }
      }

      // Check for Stedi execution notification
      const executionId = (obj.fileExecutionId || (obj.detail && typeof obj.detail === "object" ? (obj.detail as Record<string, unknown>).fileExecutionId : undefined)) as string | undefined;
      if (executionId && typeof executionId === "string") {
        try {
          const adapter = getEdiAdapter();
          if (adapter && typeof adapter.fetchRemittanceArtifact === "function") {
            const fetched = await adapter.fetchRemittanceArtifact(executionId);
            if (fetched.ok && fetched.data) return fetched.data;
          }
        } catch {
          // fallback to requireString below
        }
      }
    }
    return requireString(parsed, "raw835");
  }
  return body;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.length;
    /**
     * ── OVER THE CAP: STOP BUFFERING, KEEP READING, REFUSE AT THE END ──────────────────────────
     *
     * This used to `throw` from inside the loop. Throwing out of a `for await` calls the iterator's
     * `return()`, which DESTROYS the request stream — and the client is still uploading at that
     * moment, by definition, because that is how we learned the body was too big. The connection is
     * torn down underneath a half-sent request, and whether the client ever reads the 413 comes down
     * to whether the response flushed before the socket died.
     *
     * Usually it does. Under load it does not: `security-headers.test.ts` posts a 10 MB body to
     * prove the cap refuses it, and in CI — where the suite runs everything at once — that `fetch`
     * neither resolved nor rejected, so the test was CANCELLED rather than failed. Node's runner
     * then exits non-zero with `# fail 0`, which is how this went unnoticed while looking green.
     *
     * So the refusal is now decided here and raised after the stream ends. Nothing further is
     * buffered, so memory stays capped at MAX_BODY_BYTES no matter how much is sent; the remaining
     * bytes are read and discarded, which lets the client finish its request and read the answer it
     * asked for. A refusal the caller cannot receive is not a refusal, it is a hang.
     */
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) throw new ApiError(413, "payload_too_large", "Request body is too large.");
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

// ── Input mapping / validation (the dollars→cents boundary lives here) ─────────────────
/**
 * A path segment that names a record by id, or a clean 404.
 *
 * ── WHY THE SHAPE IS CHECKED BEFORE THE QUERY ─────────────────────────────────────────────────
 * Every one of these ids is a `uuid` column, so Postgres raises `invalid input syntax for type
 * uuid` on anything else. That is an unhandled driver error, and it surfaced as a 500 for what is
 * really "no such record" — `GET /api/v1/claims/not-a-uuid` and five sibling routes all answered
 * 500 to a request that should simply not have found anything.
 *
 * Three things follow from that, and only the first is cosmetic: the caller is told the server
 * broke when it did not; every probe writes an `error` row to the audit trail and a stack to the
 * logs, so a scanner walking URLs looks like an outage; and a 500 is the one status a client is
 * entitled to retry.
 *
 * A malformed id is answered exactly as a missing one. Distinguishing them would confirm which id
 * SHAPES are real, which is a fact these routes have no reason to give away.
 */
function idFromPath(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!isUuid(id)) throw new ApiError(404, "not_found", "No such record.");
  return id;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseCreateInput(body: unknown): VerificationInput {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "validation_error", "Expected a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const p = b.patient;
  if (typeof p !== "object" || p === null) {
    throw new ApiError(400, "validation_error", "A `patient` object is required.");
  }
  const cardImages = parseCardImages(b.cardImages);
  /**
   * Card text stays required even when photographs are supplied.
   *
   * That looks redundant and is not. The card reader can be off, unapproved for PHI, degraded, or
   * simply unable to read a blurred photo, and in every one of those cases the verification must
   * still be able to run — so there has to be something to fall back to, and it has to have been
   * collected at the same moment as the photo rather than asked for afterwards. Requiring both is
   * what makes "the AI is down" a non-event at the front desk instead of a blocked check-in.
   */
  if (typeof b.cardText !== "string" || b.cardText.trim() === "") {
    throw new ApiError(400, "validation_error", "`cardText` (the insurance card text) is required.");
  }
  if (!Array.isArray(b.planItems) || b.planItems.length === 0) {
    throw new ApiError(400, "validation_error", "`planItems` must be a non-empty array of procedures.");
  }

  const patient = p as Record<string, unknown>;
  const planItems: TreatmentPlanItem[] = b.planItems.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError(400, "validation_error", `planItems[${i}] must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    const code = asString(item.code).trim().toUpperCase();
    if (!code) throw new ApiError(400, "validation_error", `planItems[${i}].code is required.`);
    const quantity = Number(item.quantity);
    const line: TreatmentPlanItem = {
      code,
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1,
    };
    if (item.toothNumber != null && asString(item.toothNumber).trim() !== "") {
      line.toothNumber = asString(item.toothNumber).trim();
    }
    // Fees arrive from the UI in DOLLARS; convert to integer cents here, the single money boundary.
    if (item.feeDollars != null && item.feeDollars !== "") {
      const dollars = Number(item.feeDollars);
      if (!Number.isFinite(dollars) || dollars < 0) {
        throw new ApiError(400, "validation_error", `planItems[${i}].feeDollars must be a non-negative number.`);
      }
      line.fee = cents(dollars);
    }
    return line;
  });

  return {
    patient: {
      firstName: asString(patient.firstName).trim(),
      lastName: asString(patient.lastName).trim(),
      dateOfBirth: asString(patient.dateOfBirth).trim(),
      memberId: asString(patient.memberId).trim(),
      phone: patient.phone != null ? asString(patient.phone).trim() : undefined,
      email: patient.email != null ? asString(patient.email).trim() : undefined,
      ...parsePatientAddress(patient.address),
      ...parseGender(patient.gender),
      ...parseSubscriber(patient.relationship, patient.subscriber),
    },
    cardText: b.cardText,
    ...(cardImages.length > 0 ? { cardImages } : {}),
    planItems,
  };
}


/**
 * Parse and VALIDATE the patient's address at the edge.
 *
 * ── WHY THIS VALIDATES RATHER THAN COERCES ─────────────────────────────────────────────────────
 * The address ends up in loop 2010BA of an 837D, which is a statement to an insurer about where a
 * patient lives. A half-filled or malformed one is worse than none: absent, the scrubber blocks
 * filing and somebody supplies it; present-but-wrong, the claim files and the payer rejects it
 * weeks later, or worse, adjudicates it against the wrong jurisdiction.
 *
 * So the rules are strict and the failure is loud:
 *   • all four parts, or none — a street with no ZIP is not an address
 *   • two-letter USPS state, upper-cased
 *   • 5 or 9 digits of ZIP, hyphen tolerated on input and stripped for the wire
 *
 * Absent is legal, and stays legal all the way to the submit gate. Verification does not need an
 * address; filing does. Refusing to verify a patient for want of a ZIP would stop the front desk
 * doing the one thing it must do at check-in.
 */
function parsePatientAddress(raw: unknown): { address?: PatientAddress } {
  if (raw == null) return {};
  if (typeof raw !== "object") {
    throw new ApiError(400, "validation_error", "`patient.address` must be an object.");
  }
  const a = raw as Record<string, unknown>;
  const street = asString(a.street).trim();
  const city = asString(a.city).trim();
  const state = asString(a.state).trim().toUpperCase();
  const zipRaw = asString(a.zip).trim().replace(/-/g, "");

  // Entirely empty is the same as absent: a form that submits blank inputs must not become an
  // address made of empty strings, which would satisfy "present" and fail every payer.
  if (!street && !city && !state && !zipRaw) return {};

  const missing = [
    street ? null : "street",
    city ? null : "city",
    state ? null : "state",
    zipRaw ? null : "zip",
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      "validation_error",
      `A patient address needs all of street, city, state and zip — missing: ${missing.join(", ")}. ` +
        `Leave the address out entirely if it has not been collected yet.`
    );
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new ApiError(400, "validation_error", `"${state}" is not a two-letter state code, e.g. CA.`);
  }
  if (!/^[0-9]{5}([0-9]{4})?$/.test(zipRaw)) {
    throw new ApiError(400, "validation_error", `"${zipRaw}" is not a 5- or 9-digit ZIP code.`);
  }
  return { address: { street, city, state, zip: zipRaw } };
}

/** DMG03. `U` is a valid X12 answer and the honest one when nobody has asked. */
function parseGender(raw: unknown): { gender?: "M" | "F" | "U" } {
  if (raw == null) return {};
  const g = asString(raw).trim().toUpperCase();
  if (g === "") return {};
  if (g !== "M" && g !== "F" && g !== "U") {
    throw new ApiError(400, "validation_error", '`patient.gender` must be "M", "F" or "U".');
  }
  return { gender: g };
}

/**
 * Parse the patient's relationship to the policy holder, and who that is (NEW-01).
 *
 * ── WHY BOTH ARE VALIDATED TOGETHER ──────────────────────────────────────────────────────────────
 * A dental plan issues one member id to the subscriber and covers the family under it, so a
 * relationship of anything but `self` means `patient.memberId` is somebody ELSE's policy. Loop
 * 2010BA of the resulting 837D has to name that person, and there is no honest way to derive their
 * name from the patient's — so a relationship supplied without a subscriber is refused HERE rather
 * than accepted and blocked at the submit gate weeks later, when the person who could have typed
 * the name has gone home.
 *
 * The reverse — a subscriber named with no relationship — is refused for the same reason in the
 * opposite direction: the claim would file as `self`, asserting the patient holds the policy, while
 * the request plainly said otherwise.
 *
 * A verification with NEITHER is the ordinary case and passes untouched.
 */
function parseSubscriber(
  rawRelationship: unknown,
  rawSubscriber: unknown
): { relationship?: SubscriberRelationship; subscriber?: SubscriberIdentity } {
  const relationship = rawRelationship == null ? "" : asString(rawRelationship).trim().toLowerCase();
  const raw = rawSubscriber == null ? null : (rawSubscriber as Record<string, unknown>);

  if (relationship === "" && !raw) return {};

  if (!RELATIONSHIPS.includes(relationship as SubscriberRelationship)) {
    throw new ApiError(
      400,
      "validation_error",
      `\`patient.relationship\` must be one of ${RELATIONSHIPS.join(", ")}.`
    );
  }
  const value = relationship as SubscriberRelationship;
  if (value === "self") {
    // Naming a subscriber while saying the patient IS the subscriber is a contradiction, not a
    // harmless extra. Dropping it silently would leave the request meaning something the caller
    // did not write.
    if (raw) {
      throw new ApiError(
        400,
        "validation_error",
        "`patient.subscriber` must be omitted when the relationship is `self` — the patient is the " +
          "policy holder."
      );
    }
    return { relationship: value };
  }

  const firstName = raw ? asString(raw.firstName).trim() : "";
  const lastName = raw ? asString(raw.lastName).trim() : "";
  if (!firstName || !lastName) {
    throw new ApiError(
      400,
      "validation_error",
      `A patient whose relationship to the policy is "${value}" is covered under someone else's ` +
        "plan, so `patient.subscriber.firstName` and `patient.subscriber.lastName` are required — " +
        "the claim has to name the policy holder, and it must never be guessed from the patient."
    );
  }
  const dateOfBirth = raw?.dateOfBirth != null ? asString(raw.dateOfBirth).trim() : "";
  if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    throw new ApiError(400, "validation_error", "`patient.subscriber.dateOfBirth` must be YYYY-MM-DD.");
  }

  return {
    relationship: value,
    subscriber: { firstName, lastName, ...(dateOfBirth ? { dateOfBirth } : {}) },
  };
}

/** The relationships a front desk can distinguish. Mirrors `SubscriberRelationship`. */
const RELATIONSHIPS: readonly SubscriberRelationship[] = ["self", "spouse", "child", "other"];

/** Image formats a vision model can be sent. Anything else is refused at the edge. */
const CARD_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/**
 * Per-image base64 ceiling, chosen to fit UNDER the global `MAX_BODY_BYTES` (1 MB), not independently
 * of it.
 *
 * This coupling is worth stating because getting it wrong fails in a way nobody would debug quickly:
 * a per-image cap above the body cap means `readJsonBody` rejects the request with a generic 413
 * before this validation ever runs, so a photo that this file believes it accepts is refused
 * upstream with a message about request size. The limits must be read together, and they are wrong
 * separately.
 *
 * ── AND IT WAS 700_000, WHICH TWO IMAGES CANNOT BOTH FIT UNDER (NEW-14) ────────────────────────
 * The comment above was written as though the per-image cap were the binding one. It is not: the
 * route accepts TWO images, front and back, and 2 × 700 KB is 1.4 MB against a 1 MB body cap. So a
 * pair of photographs that this file's own validation would have accepted was rejected upstream by
 * `readJsonBody`, with a generic 413 about request size and no mention of images at all.
 *
 * The failure mode is the one the comment predicted and the number contradicted: a person at a desk
 * photographs both sides of a card, gets "Request body is too large", and has no idea which of the
 * two to shrink or by how much. Meanwhile the front-desk path that matters — one card, two sides —
 * is precisely the one that could not work.
 *
 * 450 KB each leaves 100 KB of headroom under the 1 MB cap for the JSON envelope, the patient
 * fields and the treatment plan that travel in the same body. 450 KB of base64 ≈ a 337 KB JPEG,
 * still a full-resolution phone photograph of a card; the client downscales before upload (see
 * `app.js`), so the realistic payload is a fraction of this and the ceiling stays a backstop.
 *
 * The two constants are wrong SEPARATELY and right only together, which is why the arithmetic is
 * written out rather than left implicit — and why a test asserts two images at the maximum are
 * actually accepted, rather than asserting the number.
 */
const MAX_CARD_IMAGE_CHARS = 450_000;
/** Front and back. A third would not fit under the body limit alongside them anyway. */
const MAX_CARD_IMAGES = 2;

/**
 * Validate uploaded card photographs.
 *
 * These are untrusted bytes headed for a third-party API, so the checks are at the edge and they
 * refuse rather than repair: an unrecognised media type is rejected, not guessed at from the
 * payload, because a media type the provider disagrees with produces an opaque vendor error at the
 * far end of a PHI-bearing call.
 */
function parseCardImages(raw: unknown): { mediaType: string; base64: string }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "validation_error", "`cardImages` must be an array.");
  if (raw.length > MAX_CARD_IMAGES) {
    throw new ApiError(400, "validation_error", `At most ${MAX_CARD_IMAGES} card images may be supplied.`);
  }

  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ApiError(400, "validation_error", `cardImages[${i}] must be an object.`);
    }
    const image = entry as Record<string, unknown>;
    const mediaType = asString(image.mediaType).trim().toLowerCase();
    if (!CARD_IMAGE_TYPES.has(mediaType)) {
      throw new ApiError(
        400,
        "validation_error",
        `cardImages[${i}].mediaType must be one of: ${[...CARD_IMAGE_TYPES].join(", ")}.`
      );
    }
    // Accepts a data: URI as well as bare base64, because that is what a canvas or a file input
    // hands a browser and stripping it here is cheaper than getting it wrong in three call sites.
    const base64 = asString(image.base64).trim().replace(/^data:[^;]+;base64,/, "");
    if (base64 === "") throw new ApiError(400, "validation_error", `cardImages[${i}].base64 is required.`);
    if (base64.length > MAX_CARD_IMAGE_CHARS) {
      throw new ApiError(400, "validation_error", `cardImages[${i}] is too large; send a compressed photo.`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new ApiError(400, "validation_error", `cardImages[${i}].base64 is not valid base64.`);
    }
    return { mediaType, base64 };
  });
}

/** Read a required, non-empty string field from a JSON body. */
function requireString(body: unknown, field: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  const text = asString(value).trim();
  if (!text) throw new ApiError(400, "validation_error", `\`${field}\` is required.`);
  return text;
}

/**
 * A dollar amount from a JSON body — a NUMBER, and nothing that merely converts to one.
 *
 * ── WHY `Number(value)` IS NOT ENOUGH ON A MONEY FIELD ───────────────────────────────────────────
 * Both money inputs on this API read their amount with `Number(body.field)`, which coerces far more
 * than it looks like it does. Probing the deployed build with each in turn:
 *
 *     {"amountDollars": "0x10"}  posts  $16.00
 *     {"amountDollars": "1e3"}   posts  $1,000.00
 *     {"amountDollars": true}    posts  $1.00
 *     {"amountDollars": [42]}    posts  $42.00
 *
 * Every one of those is a 200 and a ledger row. None is reachable from Mermaid's own screens, which
 * send numbers — but a money endpoint that silently reinterprets a hex string as a different dollar
 * figure is a bad boundary regardless of who is calling it today, and an integration written against
 * it would be wrong in a way nothing reports.
 *
 * A JSON number is unambiguous. Anything else is refused and the caller is told which field.
 */
function requireDollars(body: unknown, field: string): number {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "number") {
    throw new ApiError(400, "validation_error", `\`${field}\` must be a number.`);
  }
  return value;
}

/** The same rule where the field is optional: absent stays absent, present must be a number. */
function optionalDollars(body: unknown, field: string): number | null {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number") {
    throw new ApiError(400, "validation_error", `\`${field}\` must be a number when provided.`);
  }
  return value;
}

const REVIEW_DECISIONS = new Set(["approved", "overridden", "rejected"]);

function parseReviewInput(body: unknown): { decision: "approved" | "overridden" | "rejected"; notes: string } {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "validation_error", "Expected a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const decision = asString(b.decision);
  if (!REVIEW_DECISIONS.has(decision)) {
    throw new ApiError(400, "validation_error", "`decision` must be one of: approved, overridden, rejected.");
  }
  return { decision: decision as "approved" | "overridden" | "rejected", notes: asString(b.notes) };
}

// ── Static file serving ────────────────────────────────────────────────────────────────
/**
 * ── SECURITY HEADERS, ON EVERY RESPONSE (NEW-13) ─────────────────────────────────────────────────
 *
 * None of these existed. On a system that renders patient names, procedures and balances in a
 * browser, that leaves several cheap and total mitigations on the floor.
 *
 * ── THE CONTENT SECURITY POLICY IS STRICT BECAUSE IT CAN BE ──────────────────────────────────────
 * This front end is entirely self-contained: one module script, one stylesheet, self-hosted fonts,
 * no CDN, no analytics, no framework loader. So `'self'` is not a compromise here, it is a
 * description — and `'unsafe-inline'`, the escape hatch that makes most policies decorative, is
 * simply not needed. `default-src 'none'` means anything the policy has not named is refused, so a
 * directive nobody remembered to add fails closed rather than open.
 *
 *   • `script-src 'self'`      — an injected `<script>` or inline handler cannot execute, which is
 *                                what turns an XSS hole from a session compromise into nothing.
 *   • `connect-src 'self'`     — an injected script that DID run could not exfiltrate a patient
 *                                list to another origin.
 *   • `frame-ancestors 'none'` — with X-Frame-Options, this is clickjacking: a page that framed the
 *                                submit gate could get a claim released by someone who thought they
 *                                were clicking something else.
 *   • `form-action 'self'`     — a form cannot be re-pointed at somebody else's server.
 *   • `object-src 'none'`, `base-uri 'self'` — plugin execution, and rewriting every relative URL
 *                                on the page from a single injected `<base>` tag.
 *
 * ── AND THE ONES THAT ARE NOT CSP ────────────────────────────────────────────────────────────────
 *   • `X-Content-Type-Options: nosniff` — stops a browser deciding a JSON response is really HTML,
 *     which is how a reflected value in an API body becomes script execution.
 *   • `Referrer-Policy: same-origin` — a URL here carries record ids. Sending them to whatever a
 *     user clicks through to is a small, permanent PHI leak into somebody else's logs.
 *   • `Strict-Transport-Security` — production only, and deliberately: HSTS on a laptop pins
 *     `localhost` to HTTPS in the developer's browser for a year, which is a genuinely painful
 *     thing to undo. `includeSubDomains` without `preload`, because preloading is a decision about
 *     a domain and not about a process.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/**
 * Apply them, without overwriting anything a handler has already set.
 *
 * Called at the top of every response path — the API's `sendJson`/`sendError` and the static
 * server — rather than in one wrapper, because `DeferredResponse` buffers headers and flushes them
 * later, and a wrapper around the outer `ServerResponse` would be applied after the flush for every
 * deferred route. Where the guarantee has to hold, the guarantee is written.
 */
function applySecurityHeaders(res: ResponseSink): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  /**
   * HSTS wherever a stranger can reach this, which is not the same as production.
   *
   * ── THE REASON IT WAS PRODUCTION-ONLY IS A REASON ABOUT A LAPTOP ───────────────────────────────
   * On `http://localhost` this header pins the developer's own browser to HTTPS for a year, and
   * undoing that means clearing a browser-internal setting most people do not know exists. That is a
   * real hazard and it is the whole hazard — it says nothing about production, only about where the
   * process is running. `hosted` is the question that was actually being asked, the same one that
   * now decides the `Secure` cookie flag and whether a password-reset token may leave the process.
   *
   * The practical consequence: a hosted deployment without NODE_ENV sent no HSTS, so a
   * first request to `http://` was downgradeable before the platform's redirect could run. A hosting
   * platform serves over HTTPS by definition, so there is no configuration in which sending it there
   * is wrong.
   *
   * `includeSubDomains` applies to subdomains of the host that SENT it — `<staging-host>.onrender.com`
   * — and not to `onrender.com` or to any sibling service on it. `preload` is still deliberately
   * absent: submitting a domain to the browsers' preload list is a decision about a domain, and a
   * one-way one, not a decision a process makes about itself.
   */
  if (getConfig().isProd || getConfig().hosted) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

/**
 * ── WHY STATIC ASSETS CARRY A VALIDATOR AND A REVALIDATE INSTRUCTION ────────────────────────────
 * This served `app.js` with no `Cache-Control`, no `ETag` and no `Last-Modified` — no freshness
 * information of any kind. RFC 9111 lets a cache apply its own HEURISTIC in that case, and browsers
 * do: Chrome held the bundle in its disk cache and, with no validator, had no cheap way to ask
 * whether it had changed.
 *
 * The failure mode is the worst kind. The API deploys and answers with the new shape; the browser
 * keeps running yesterday's JavaScript against it. Every fix looks un-deployed, and the two halves
 * of the application disagree in ways neither side can detect. That is exactly what happened after
 * the UI audit: the server was byte-for-byte correct and the screens were stale.
 *
 * `no-cache` does NOT mean "do not store" — it means "store, but revalidate before reuse". Paired
 * with a strong ETag over the file's own bytes, an unchanged asset costs a 304 and no body, and a
 * changed one can never be served stale. That is the right trade for an app whose HTML and JS are
 * a matched pair: correctness first, and revalidation is one cheap round trip.
 *
 * Content-hashed filenames would allow `immutable` and skip even that, but they need a build step
 * this project deliberately does not have — the client is plain JavaScript served as written.
 */
/** When this process started. Distinguishes a restart from a redeploy when reading /health. */
const BOOTED_AT = new Date().toISOString();

async function serveStatic(res: ResponseSink, pathname: string, ifNoneMatch?: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Contain within PUBLIC_DIR (defeat path traversal).
  const resolved = normalize(join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "forbidden", "Path is outside the public directory.");
    return;
  }
  try {
    const data = await readFile(resolved);
    const type = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
    /** Strong, because it is a hash of the exact bytes about to be sent — not a timestamp. */
    const etag = `"${createHash("sha256").update(data).digest("base64url").slice(0, 27)}"`;

    applySecurityHeaders(res);
    res.setHeader("cache-control", "no-cache");
    res.setHeader("etag", etag);

    /**
     * WEAK comparison, as RFC 9110 §8.8.3.2 requires for `If-None-Match`.
     *
     * Exact string equality looked right and produced a 304 in every local test — and never once in
     * production. Cloudflare sits in front of this service, compresses the response, and downgrades
     * the strong validator to a weak one, so the browser sends back `W/"abc"` against the `"abc"`
     * that was issued. Under `===` those never match, every load refetched the whole bundle, and the
     * revalidation this cache strategy is built on quietly did nothing.
     *
     * The `W/` prefix means "semantically equivalent, possibly not byte-identical", which is exactly
     * what a compressed copy is. Stripping it on both sides is the comparison the spec defines.
     */
    const weak = (tag: string) => tag.trim().replace(/^W\//, "");
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => weak(t) === weak(etag))) {
      res.writeHead(304, {});
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    sendError(res, 404, "not_found", `No such resource: ${pathname}`);
  }
}

// ── Authentication, tenancy, and route authorization ─────────────────────────────────
//
// Every API route declares the permission it needs. A route with no entry here is denied by
// default: adding an endpoint and forgetting to authorize it should fail closed, not silently
// expose data. `null` means "any authenticated user"; `PUBLIC` means "no session required" and is
// deliberately a tiny, explicit list.

const SESSION_COOKIE = "mermaid_sid";
const CSRF_HEADER = "x-csrf-token";
/** Milliseconds since the person's last key or pointer input, reported by the browser (automatic logoff). */
const IDLE_HEADER = "x-mermaid-idle-ms";

/**
 * Routes reachable without a session. Everything else requires one.
 *
 * The password-reset pair has to be here for the obvious reason — someone who cannot sign in is
 * exactly who needs it — which is also why both are throttled on the same per-IP bucket as login and
 * why neither reveals whether an address is on file.
 */
const PUBLIC_ROUTES = new Set([
  "/api/v1/health",
  "/api/v1/auth/login",
  "/api/v1/auth/session",
  "/api/v1/auth/password-reset",
  "/api/v1/auth/password-reset/confirm",
  "/api/v1/webhooks/edi/stedi",
]);

/**
 * Per-IP throttle on the sign-in door (blueprint doc 08).
 *
 * Module-scoped so it survives across requests — a limiter rebuilt per request limits nothing.
 * Per-process and in memory, which is right for the single web node this deployment runs; two web
 * instances would each hold their own and the effective limit would double. Recorded in
 * `platform/auth/src/rate-limit.ts` along with the seam for fixing it.
 */
const authRateLimiter = new RateLimiter();

/**
 * Permission required per route, matched most-specific-first. Reads and writes are separated so an
 * auditor (read-only by construction) or a front-desk user cannot move money.
 */
const ROUTE_PERMISSIONS: { test: RegExp; methods: string[]; permission: Permission | null }[] = [
  /**
   * Logging out needs a session and no resource permission — every role must be able to do it,
   * whatever they are otherwise allowed to touch.
   *
   * It is listed with an explicit `null` rather than left out, and that distinction is the whole
   * point of this table: "declared, and requires nothing further" is a decision somebody made,
   * whereas an absent route is one nobody thought about. Collapsing the two into the same `null` is
   * exactly the bug the guardrail suite found.
   */
  { test: /^\/api\/v1\/auth(\/|$)/, methods: ["POST", "GET"], permission: null },
  /**
   * Staff administration (G-2).
   *
   * `users.manage` belongs to `owner` and `admin` alone -- an office manager holds every working
   * permission and the contractual override and still cannot administer accounts, which is the
   * separation roles.ts intends. Reading the roster is gated the same as changing it: a staff list
   * is who has access to a practice's PHI, and that is not a general read.
   */
  { test: /^\/api\/v1\/users(\/|$)/, methods: ["GET", "POST"], permission: "users.manage" },
  { test: /^\/api\/v1\/verifications(\/|$)/, methods: ["GET"], permission: "verifications.read" },
  { test: /^\/api\/v1\/verifications(\/|$)/, methods: ["POST"], permission: "verifications.write" },
  /**
   * The schedule (0035). Gated like the verification queue, not like the patient directory: what
   * it answers is whether each visit's COVERAGE is ready, and a dentist — who holds
   * `verifications.read` but not `patients.read` — is exactly who asks that about tomorrow.
   */
  { test: /^\/api\/v1\/appointments$/, methods: ["GET"], permission: "verifications.read" },
  /**
   * "Verify all due" (stage 3). Seeing what WOULD be checked is a read; sending the checks is the
   * same act as creating a verification by hand, so it takes the same permission — a role that may
   * not verify one patient may not verify twenty with one click.
   */
  { test: /^\/api\/v1\/appointments\/due$/, methods: ["GET"], permission: "verifications.read" },
  { test: /^\/api\/v1\/appointments\/verify$/, methods: ["POST"], permission: "verifications.write" },
  /**
   * Schedule import (stage 4). An import creates PATIENT records for people the practice has not
   * verified yet, so it takes the permission that creates patients. The preview writes nothing but
   * is gated the same: it echoes the file's own patient names back, and a role that may not add
   * those people has no use for a preview of adding them.
   */
  { test: /^\/api\/v1\/appointments\/import(\/preview)?$/, methods: ["POST"], permission: "patients.write" },
  { test: /^\/api\/v1\/claims(\/|$)/, methods: ["GET"], permission: "claims.read" },
  { test: /^\/api\/v1\/claims(\/|$)/, methods: ["POST"], permission: "claims.write" },
  { test: /^\/api\/v1\/remittances(\/|$)/, methods: ["GET"], permission: "remittances.read" },
  /**
   * What payers charged to pay this practice (F1). The same money the remittances list covers, read
   * for its cost of receipt — so it is gated on the same permission, not a narrower or wider one.
   */
  { test: /^\/api\/v1\/payment-methods$/, methods: ["GET"], permission: "remittances.read" },
  /**
   * The three shadow-mode findings surfaces (F2, F4, F5).
   *
   * Read-only, and permissioned by whose money the finding is about rather than by which feature
   * produced it: an allowed-amount variance and a statutory-clock finding are both statements
   * about a REMITTANCE, while a silent claim is a statement about a CLAIM. A reader who may not
   * see one should not reach it through the other.
   */
  { test: /^\/api\/v1\/allowed-variances$/, methods: ["GET"], permission: "remittances.read" },
  { test: /^\/api\/v1\/statutory-clock$/, methods: ["GET"], permission: "remittances.read" },
  { test: /^\/api\/v1\/silent-claims$/, methods: ["GET"], permission: "claims.read" },
  // Coordination of benefits (0034): reading is seeing incoming money; deciding is moving it.
  { test: /^\/api\/v1\/coordination-cases(\/[^/]+)?$/, methods: ["GET"], permission: "remittances.read" },
  { test: /^\/api\/v1\/coordination-cases\/[^/]+\/(confirm-coverage|request-confirmation|mark-filed|close)$/, methods: ["POST"], permission: "remittances.write" },
  { test: /^\/api\/v1\/remittances(\/|$)/, methods: ["POST"], permission: "remittances.write" },
  { test: /^\/api\/v1\/denials(\/|$)/, methods: ["GET"], permission: "denials.read" },
  /**
   * Closing a denial is NOT the same act as working an appeal, and it does not belong to the same
   * people. Matched most-specific-first, so this rule must precede the catch-all below.
   *
   * `close` decides whose money a denied amount is: written off (the practice absorbs it) or billed
   * to the patient. That is a disposition decision about revenue, in the same family as a write-off
   * on the ledger, and it stays with the roles that own the money — `denials.write`.
   *
   * Drafting, approving and sending an appeal, and recording what the payer said back, are the
   * recovery work itself. A dentist holds `appeals.write` precisely so they can put their clinical
   * name to an appeal; they must not thereby acquire the power to write revenue off.
   */
  { test: /^\/api\/v1\/denials\/[^/]+\/close$/, methods: ["POST"], permission: "denials.write" },
  /**
   * Asking the AI layer to explain a denial changes nothing and decides nothing — it is a reading
   * aid over data the caller can already see. So it is gated on `denials.read`, the permission to
   * look at the denial in the first place, and not on `appeals.write`.
   *
   * It is a POST because it makes an outbound call, not because it mutates anything. Matched
   * before the catch-all below, which would otherwise demand write access to read a sentence.
   */
  { test: /^\/api\/v1\/denials\/[^/]+\/explain$/, methods: ["POST"], permission: "denials.read" },
  { test: /^\/api\/v1\/denials(\/|$)/, methods: ["POST"], permission: "appeals.write" },
  /**
   * Adding or correcting a payer — NEW-08.
   *
   * `payers.write`, which is the admin set (owner, admin, office manager, biller-manager) and has
   * existed in `roles.ts` since P1 with nothing to grant. It is a genuinely powerful act: an alias
   * decides which company a patient's eligibility request is sent to, and a clearinghouse id
   * decides where a claim is routed. Declared BEFORE the read rule so the more specific method
   * match wins.
   */
  /**
   * Registering a clearinghouse ERA source — NEW-11.
   *
   * `remittances.write`, which is the set that already owns incoming money: owner, admin, office
   * manager and biller. Registering a source decides which credential fetches a practice's
   * payments and which payee NPI the tenancy cross-check compares an 835 against, so it belongs
   * with the people who work remittances rather than behind a general admin gate.
   */
  /**
   * Naming the treating dentist on a claim — NEW-22. `claims.write`, the same permission that
   * corrects an address on one: both are statements to a payer about a claim already in hand.
   */
  { test: /^\/api\/v1\/claims\/[^/]+\/rendering-provider$/, methods: ["POST"], permission: "claims.write" },
  { test: /^\/api\/v1\/ops\/era-sources(\/|$)/, methods: ["POST"], permission: "remittances.write" },
  { test: /^\/api\/v1\/ops\/era-sources(\/|$)/, methods: ["GET"], permission: "remittances.read" },
  { test: /^\/api\/v1\/payer-profile\/payers(\/|$)/, methods: ["POST"], permission: "payers.write" },
  { test: /^\/api\/v1\/payer-profile(\/|$)/, methods: ["GET"], permission: "payers.read" },
  // The CDT catalog the treatment-plan picker reads. Every role that can look at a verification can
  // read it, so this grants nothing new — but it must be DECLARED, because an undeclared route is
  // now refused outright (see `dispatch`).
  { test: /^\/api\/v1\/reference(\/|$)/, methods: ["GET"], permission: "verifications.read" },
  { test: /^\/api\/v1\/patients(\/|$)/, methods: ["GET"], permission: "patients.read" },
  /**
   * Taking a payment and forgiving a balance are NOT the same act, and they do not belong to the
   * same people.
   *
   * A payment is what the front desk does at checkout — it records money that actually arrived, it
   * is attributed to whoever took it, and the ledger refuses more than the balance. That is the most
   * common money interaction in a dental practice and gating it behind a billing permission would
   * push staff into recording payments somewhere else, which is how a ledger stops being the truth.
   *
   * An adjustment or a write-off is revenue the practice is choosing to lose. That is a billing
   * decision, it needs a reason, and it stays with the people who own the money.
   *
   * Matched most-specific-first, so the payment rule must precede the catch-all.
   */
  { test: /^\/api\/v1\/patients\/[^/]+\/payment$/, methods: ["POST"], permission: "patients.write" },
  /**
   * Correcting the address on a patient record — V5.
   *
   * `patients.write`, which is exactly the set that already owns the patient master: owner, admin,
   * office manager, insurance coordinator and front desk. A biller holds `claims.write` and NOT
   * this, deliberately: a biller can correct the address on the claim in front of them (the rule
   * below), but changing the practice's record of where a person lives stays with the desk.
   *
   * A PUT and not a POST because it replaces one field with a complete value and is idempotent.
   * Declared explicitly — an undeclared method is refused outright, which is the fail-closed
   * behaviour the guardrail suite pins.
   */
  { test: /^\/api\/v1\/patients\/record\/[^/]+\/address$/, methods: ["PUT"], permission: "patients.write" },
  /**
   * Correcting the subscriber address ON A CLAIM that has not been filed — V5.
   *
   * `claims.write`, because this edits a claim: it changes what will be sent to a payer and it
   * re-scrubs, which can move the claim from `draft` to `ready`. The biller who is looking at the
   * blocked claim is the person who needs it, and they hold this permission.
   *
   * Matched before the `claims` catch-all below, which declares POST only and would otherwise let
   * this fall through to "undeclared" and be refused.
   */
  { test: /^\/api\/v1\/claims\/[^/]+\/subscriber-address$/, methods: ["PUT"], permission: "claims.write" },
  { test: /^\/api\/v1\/patients(\/|$)/, methods: ["POST"], permission: "remittances.write" },
  { test: /^\/api\/v1\/today(\/|$)/, methods: ["GET"], permission: "queue.read" },
  { test: /^\/api\/v1\/analytics(\/|$)/, methods: ["GET"], permission: "analytics.read" },
  // Operations. Reading queue health and the audit trail is the auditor's job as much as the
  // owner's; reviving a stuck event moves real work and is an administrator's.
  { test: /^\/api\/v1\/ops(\/|$)/, methods: ["GET"], permission: "audit.read" },
  { test: /^\/api\/v1\/ops(\/|$)/, methods: ["POST"], permission: "org.manage" },
];

/**
 * What a route requires — and, separately, whether anyone ever said.
 *
 * The two must not be the same value. `authorizeRequest` skips its permission check when the
 * permission is null (`if (meta.permission && !can(...))`), so returning a bare null for an
 * undeclared route silently served it to any authenticated user, `auditor` included.
 */
type RoutePolicy = { declared: true; permission: Permission | null } | { declared: false };

function permissionFor(method: string, path: string): RoutePolicy {
  for (const route of ROUTE_PERMISSIONS) {
    if (route.methods.includes(method) && route.test.test(path)) {
      return { declared: true, permission: route.permission };
    }
  }
  return { declared: false };
}

/** Parse a cookie header without a dependency. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(res: ResponseSink, token: string, expiresAt: number): void {
  const config = getConfig();
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: the session must survive a top-level navigation back into the app,
    // and every mutating route is separately CSRF-protected by a header the browser will not
    // attach cross-site.
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (config.secureCookies) attrs.push("Secure");
  res.setHeader("set-cookie", attrs.join("; "));
}

function clearSessionCookie(res: ResponseSink): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * The client's IP, as this deployment is entitled to know it.
 *
 * ── WHY `x-forwarded-for` IS NOT READ BY DEFAULT ───────────────────────────────────────────────
 * This used to prefer the FIRST `x-forwarded-for` entry unconditionally. That header is written by
 * whoever sent the request unless a proxy this deployment controls overwrites it — and the first
 * entry is the one a client controls even WHEN a proxy appends its own. Two consumers made that
 * dangerous rather than cosmetic: the login rate limiter keys on this value, so a script that
 * varied the header per request got a fresh allowance every time and the throttle on password
 * guessing limited nothing; and the audit trail recorded the forged address as fact.
 *
 * So the socket's peer address is the answer unless the deployment DECLARES what stands in front of
 * it (`TRUST_PROXY`, read into `Config.clientIpSource`), and each declaration names a value that the
 * infrastructure wrote rather than one the client did:
 *
 *   • `cloudflare` → `cf-connecting-ip`, generated at Cloudflare's edge from the connection it
 *     terminated. Cloudflare's own guidance is to prefer it over `x-forwarded-for`, and the reason
 *     is this exact hazard: it APPENDS to that chain, so the left of the chain stays the client's.
 *   • `<n>` → the nth `x-forwarded-for` entry from the right, one per trusted proxy that appended
 *     the peer it saw.
 *
 * ── WHY EVERY PATH FALLS BACK TO THE SOCKET AND NEVER TO A GUESS ───────────────────────────────
 * A header that is absent, malformed, or shorter than the declared chain means the request did not
 * arrive the way this deployment says it does. The socket address is then wrong-but-honest (it is
 * some real peer, usually the platform's own router); the leftmost forwarded entry would be
 * precisely the attacker-controlled value this function exists to refuse. `::1` in an audit row
 * says "this deployment cannot see client addresses", which is a fixable operational fact. A forged
 * address in an audit row says something false about a person.
 *
 * Pure and exported for tests: the spoofing scenario cannot be built from a real socket easily,
 * and this is the code that exists for the moment someone sends a forged header.
 */
export function clientIpFrom(
  headers: { forwardedFor?: string | undefined; cfConnectingIp?: string | undefined },
  remoteAddress: string | undefined,
  source: ClientIpSource
): string | null {
  const socket = remoteAddress ?? null;

  if (source.kind === "cloudflare") {
    /**
     * One header, one value, generated by the edge — there is no chain to count past and nothing
     * the client wrote to skip. Anything that is not a single IP literal did not come from that
     * edge, so it is discarded rather than reasoned about.
     */
    return validIp(headers.cfConnectingIp) ?? socket;
  }

  if (source.kind === "forwarded") {
    const entries = (headers.forwardedFor ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    /**
     * The nth entry FROM THE RIGHT, because each trusted proxy APPENDS the peer it saw: the
     * rightmost was written by the nearest proxy, and the client's own claim — if it sent one —
     * stays on the left where it belongs. A chain SHORTER than the declared hop count means the
     * request did not arrive the way this deployment says it does, so there is no entry to trust
     * and the socket is the answer. Never `entries[0]`, which is whatever the client sent.
     */
    const candidate = entries[entries.length - source.hops];
    return validIp(candidate) ?? socket;
  }

  return socket;
}

/**
 * A header value is usable only if it is one IP literal.
 *
 * Both consumers treat this as an identity — the throttle keys buckets on it, the audit trail
 * records it as fact — so a value that is not an address has no honest interpretation. `x.y.z`,
 * `unknown` (a real proxy convention), an empty entry or a list smuggled into one entry are all
 * refused rather than half-parsed, and the caller falls back to the socket.
 *
 * A port is stripped when it is unambiguous: `1.2.3.4:5678` and `[2001:db8::1]:5678` are shapes
 * real proxies emit. A bare IPv6 address is full of colons and is left exactly alone.
 */
function validIp(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  const candidate = bracketed
    ? bracketed[1]!
    : value.split(":").length === 2
      ? value.split(":")[0]!
      : value;

  return isIP(candidate) === 0 ? null : candidate;
}

const clientIp = (req: IncomingMessage): string | null =>
  clientIpFrom(
    {
      forwardedFor: req.headers["x-forwarded-for"] as string | undefined,
      cfConnectingIp: req.headers["cf-connecting-ip"] as string | undefined,
    },
    req.socket.remoteAddress ?? undefined,
    getConfig().clientIpSource
  );

// ── API router ───────────────────────────────────────────────────────────────────────
async function handleApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  session: ResolvedSession | null
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  const service = services.verification;

  // Reference data for the treatment-plan picker.
  if (method === "GET" && path === "/api/v1/reference/cdt") {
    sendJson(res, 200, {
      items: CDT_CATALOG.map((p) => ({
        code: p.code,
        description: p.description,
        category: p.category,
        typicalFee: p.typicalFee,
        typicalFeeUsd: formatUsd(p.typicalFee),
      })),
    });
    return;
  }

  if (method === "GET" && path === "/api/v1/health") {
    /**
     * The build actually running, so "is my fix deployed?" has an answer that does not require
     * trusting a deploy log.
     *
     * This existed as `{ ok: true }` and nothing else, which meant the only way to tell whether a
     * browser was talking to new code was to grep the served bundle for a string from it. When a
     * stale cached `app.js` made every UI fix look un-deployed, that was the difference between a
     * five-minute check and an hour of guessing.
     *
     * `RENDER_GIT_COMMIT` is set by the platform; `unknown` locally is honest rather than a lie
     * about a commit nobody built.
     */
    sendJson(res, 200, {
      ok: true,
      commit: process.env.RENDER_GIT_COMMIT ?? "unknown",
      startedAt: BOOTED_AT,
      /**
       * Which KIND of deployment this is, on the one endpoint that answers without a session.
       *
       * A demonstration deployment and a real practice's deployment are the same code on the same
       * URL shape, and telling them apart mattered the moment both existed. `demo` means the
       * deployment carries no real billing identity and can reach no payer; `live` means it does and
       * can. Unauthenticated on purpose: "is this the demo?" is the question somebody asks BEFORE
       * they sign in, and it is not a secret.
       */
      deployment: getConfig().isDemoDeployment ? "demo" : "live",
      filesToRealPayers: getConfig().filesToRealPayers,
    });
    return;
  }

  // Collection: POST create, GET list.
  if (path === "/api/v1/verifications") {
    if (method === "POST") {
      const view = await service.create(parseCreateInput(await readJsonBody(req)));
      sendJson(res, 201, view);
      return;
    }
    if (method === "GET") {
      const statusParam = url.searchParams.get("status");
      const filter = statusParam
        ? { status: statusParam as "verified" | "needs_review" | "reviewed" | "failed" }
        : undefined;
      const items = await service.list(filter);
      sendJson(res, 200, { items, doneToday: items.filter((i) => i.outcome === "complete").length });
      return;
    }
    throw new ApiError(405, "method_not_allowed", `${method} not allowed on ${path}.`);
  }

  /**
   * Read a card photograph and return what it says — **without** verifying or storing anything.
   *
   * This is the step the upload flow was missing. Extraction already happened inside `create`, but
   * only there, so the fields never reached the form the person was looking at. Now the form asks
   * first, shows what was read, and the person corrects it before pressing Verify.
   *
   * POST because it ships PHI to a processor, not because it mutates: nothing here writes a row,
   * publishes an event, or creates a patient. It is covered by the existing
   * `/api/v1/verifications` POST → `verifications.write` rule, which is the right permission —
   * sending a patient's card to a processor is not a read-only act even though nothing is stored.
   *
   * `available: false` is a 200, not an error. "This deployment cannot read photographs" is a
   * configuration fact the UI must render as guidance, and a 5xx would make it look like an outage.
   */
  if (path === "/api/v1/verifications/read-card" && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const images = parseCardImages(body.cardImages);
    if (images.length === 0) {
      throw new ApiError(400, "validation_error", "`cardImages` must contain at least one image.");
    }

    const { available, read } = await service.readCard(images);
    sendJson(res, 200, {
      available,
      read: read
        ? {
            transcription: read.transcription,
            fields: read.card,
            crossCheck: read.crossCheck,
            contested: read.contested,
            provider: read.provider,
            model: read.model,
          }
        : null,
    });
    return;
  }

  // Item: GET detail, POST :id/review.
  const detail = path.match(/^\/api\/v1\/verifications\/([^/]+)$/);
  if (detail && method === "GET") {
    const view = await service.get(idFromPath(detail[1]!));
    if (!view) throw new ApiError(404, "not_found", "Verification not found.");
    sendJson(res, 200, view);
    return;
  }

  const review = path.match(/^\/api\/v1\/verifications\/([^/]+)\/review$/);
  if (review && method === "POST") {
    const view = await service.review(idFromPath(review[1]!), parseReviewInput(await readJsonBody(req)));
    sendJson(res, 200, view);
    return;
  }

  await handleClaimsApi(req, res, services, url, method, path, session);
}

// ── Claims routes ────────────────────────────────────────────────────────────────────
/**
 * What a payer withheld on one claim, attached to the claim view that reports it.
 *
 * Named and exported as a type rather than left inline so the two call sites, the browser bundle and
 * any future consumer describe the same shape. `withRecovery` returned `unknown[]` before this,
 * which is honest about being a decorated value and useless for catching a shape change — a field
 * renamed here would have reached the UI before anything complained.
 */
export interface ClaimRecoveryBlock {
  /** Everything this payer withheld for a workable reason, settled or not. */
  deniedAmount: number;
  /** The part still worth pursuing — see the note on the "still in play" filter below. */
  openAmount: number;
  reasons: {
    denialId: string;
    carcCode: string;
    carcDescription: string;
    procedureCode: string | null;
    deniedAmount: number;
    status: string;
  }[];
}

async function handleClaimsApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<void> {
  const claims = services.claims;

  /**
   * ── WHAT THE PAYER WITHHELD, ATTACHED TO THE CLAIM IT WAS WITHHELD FROM ────────────────────────
   *
   * `outstanding` on a claim view is the estimate minus what arrived. That is a real number and it
   * is not the recovery number: the estimate is what the practice EXPECTED before the payer ruled,
   * so a claim whose estimate already assumed a procedure would not be covered shows a small
   * shortfall even when the payer then denied that procedure outright for a workable reason.
   *
   * That is exactly what a $1,425.00 crown claim did. The estimate expected $175.00, the payer paid
   * $21.49, and the claims screen reported $153.51 outstanding — while the remittance had recorded
   * $1,125.00 withheld under CO-197 (pre-authorisation absent), appealable, and sitting in the
   * recovery queue. A biller working the claims list would have chased the smaller number and never
   * seen the larger one.
   *
   * ── WHY THIS IS COMPOSED HERE AND NOT INSIDE CLAIMS ────────────────────────────────────────────
   * Claims cannot answer it. A denial belongs to the Denials context and the two modules do not
   * import each other — that boundary is the architecture and CI enforces it. `apps/web` is the
   * composition root and already joins these two by claim id for the patient record, so this is the
   * same join, in the same place, for the screen that needs it most.
   *
   * Both figures are returned, separately labelled. Collapsing them into one number would trade a
   * screen that understates recovery for one that cannot explain either figure.
   *
   * The claim id is supplied by the caller rather than read off the value, because the two shapes
   * this decorates keep it in different places: a list row is flat (`id`) and a detail view nests
   * the aggregate (`claim.id`). Guessing between them is how the list quietly 500s while the detail
   * keeps working.
   */
  const withRecovery = async <T>(
    views: T[],
    idOf: (view: T) => string
  ): Promise<(T | (T & { recovery: ClaimRecoveryBlock }))[]> => {
    if (views.length === 0) return views;
    const denials = await services.denials.list({ claimIds: views.map(idOf) });
    const byClaim = new Map<string, typeof denials>();
    for (const d of denials) byClaim.set(d.claimId, [...(byClaim.get(d.claimId) ?? []), d]);

    return views.map((view) => {
      const mine = byClaim.get(idOf(view)) ?? [];
      if (mine.length === 0) return view;
      /**
       * "Still in play" is the same set the patient record treats as open. A denial that was
       * recovered, written off, or moved to the patient is settled work and must not be re-offered
       * as money to chase — but it is still reported, because the reason a payer withheld money is
       * part of this claim's story even after someone has dealt with it.
       */
      const open = mine.filter((d) => !["recovered", "written_off", "patient_billed"].includes(d.status));
      return {
        ...view,
        recovery: {
          deniedAmount: mine.reduce((sum, d) => sum + d.deniedAmount, 0),
          openAmount: open.reduce((sum, d) => sum + d.deniedAmount, 0),
          reasons: mine.map((d) => ({
            denialId: d.id,
            carcCode: d.carcCode,
            carcDescription: d.carcDescription,
            procedureCode: d.procedureCode,
            deniedAmount: d.deniedAmount,
            status: d.status,
          })),
        },
      };
    });
  };

  if (path === "/api/v1/claims") {
    if (method === "GET") {
      const statusParam = url.searchParams.get("status");
      const filter = {
        ...(statusParam ? { status: statusParam as "draft" | "ready" | "submitted" | "rejected" | "paid" | "void" } : {}),
        ...(url.searchParams.get("open") === "1" ? { openOnly: true } : {}),
      };
      const items = await claims.list(Object.keys(filter).length ? filter : undefined);
      sendJson(res, 200, {
        // The counts are taken from the claim views themselves, BEFORE the denial join — they are
        // claim facts, and reading them off the composed shape would make them depend on it.
        items: await withRecovery(items, (i) => i.id),
        readyToSubmit: items.filter((i) => i.canSubmit).length,
        atRisk: items.filter((i) => i.filingRisk === "urgent" || i.filingRisk === "expired").length,
      });
      return;
    }
    if (method === "POST") {
      // Manual "bill this now". Goes through the SAME payload and the SAME idempotent service
      // method the event path uses, so the two can never diverge.
      const verificationId = requireString(await readJsonBody(req), "verificationId");
      const payload = await services.verification.completionEvent(verificationId);
      if (!payload) {
        throw new ApiError(
          409,
          "not_billable",
          "That verification is not billable: it is unsettled, or it has no coverage snapshot to inherit."
        );
      }
      const view = await claims.createFromVerification(payload);
      sendJson(res, 201, view);
      return;
    }
    throw new ApiError(405, "method_not_allowed", `${method} not allowed on ${path}.`);
  }

  // Operational sweep — escalates timely-filing risk. Normally a scheduled job; exposed so the
  // demo can trigger it on demand.
  if (path === "/api/v1/claims/filing-sweep" && method === "POST") {
    sendJson(res, 200, { escalated: await claims.sweepFilingRisk() });
    return;
  }

  const detail = path.match(/^\/api\/v1\/claims\/([^/]+)$/);
  if (detail && method === "GET") {
    const view = await claims.get(idFromPath(detail[1]!));
    if (!view) throw new ApiError(404, "not_found", "Claim not found.");
    // Same join as the list: a claim opened on its own must not tell a different story about what
    // the payer withheld than the row it was opened from.
    sendJson(res, 200, (await withRecovery([view], (v) => v.claim.id))[0]);
    return;
  }

  /**
   * The claim's own history: estimate → submission → posting → resolution (roadmap §6).
   *
   * A projection over the claim rather than a stored `timeline_events` table, so it cannot disagree
   * with the claim it describes — which matters because this is the screen a practice quotes to a
   * payer or a patient during a dispute, and the same question a breach review asks of the record.
   */
  const timeline = path.match(/^\/api\/v1\/claims\/([^/]+)\/timeline$/);
  if (timeline && method === "GET") {
    const view = await claims.get(idFromPath(timeline[1]!));
    if (!view) throw new ApiError(404, "not_found", "Claim not found.");
    sendJson(res, 200, {
      claimId: view.claim.id,
      status: view.claim.status,
      entries: buildClaimTimeline(view.claim),
    });
    return;
  }

    /**
     * V5 — correct the subscriber address on a claim that has not been filed.
     *
     * This is the half of V5 that unblocks MONEY. A claim missing loop 2010BA N3/N4 is held by the
     * scrubber, and until now the only way to supply it was to verify the patient again — a wasted
     * eligibility call, a second verification record, a second claim, and the original stranded.
     *
     * The actor is the authenticated user, never a client-supplied string, for the same reason the
     * submit gate works that way: this edits what goes to a payer, and an audit trail naming a
     * value the client chose is not an audit trail.
     *
     * `correctSubscriberAddress` re-scrubs in the same act, so a claim blocked solely on this comes
     * back `ready` and the person who fixed it can see that it worked. It refuses on a claim the
     * payer already holds — that case is a corrected claim (CLM05-3 frequency 7), a separate and
     * deliberate decision.
     *
     * Clearing is NOT offered here. `parseAddressBody` accepts null for the patient master, where
     * removing a wrong address is a real need; doing it on a claim would only re-block the claim the
     * caller is trying to release.
     */
    const claimAddress = path.match(/^\/api\/v1\/claims\/([^/]+)\/subscriber-address$/);
    if (claimAddress && method === "PUT") {
      const body = await readJsonBody(req);
      const address = parseAddressBody(body);
      if (!address) {
        throw new ApiError(400, "validation_error", "A claim's subscriber address cannot be cleared.");
      }
      const view = await claims.correctSubscriberAddress(
        idFromPath(claimAddress[1]!),
        address,
        // The authenticated user when there is one, exactly as the submit gate resolves it. The
        // body fallback exists only for the DB-free demo, which has no sessions; a logged-in
        // deployment can never be attributed to a client-supplied name.
        actorName(session, body, "correctedBy")
      );
      sendJson(res, 200, view);
      return;
    }


  /**
   * NEW-22 — name the dentist who performed the treatment, on a claim not yet filed.
   *
   * The other half of what unblocks a group practice's money, shaped exactly like the address
   * correction above: the actor is the authenticated user rather than a client-supplied string,
   * because this edits what goes to a payer; and the service re-scrubs in the same act, so a claim
   * blocked solely on this comes back `ready` and the person who fixed it can see that it worked.
   *
   * A solo practice never needs this. Its billing provider IS the rendering provider, and
   * 005010X224A2 says to omit the loop — so nothing calls this and nothing is blocked on it.
   */
  /**
   * Record what the payer said about authorising this treatment (pre-auth).
   *
   * `claims.write`, via the existing rule — it changes what may be filed. The actor is the
   * authenticated user, never a client-supplied string, for the same reason the submit gate is:
   * an authorisation record is evidence, and evidence nobody is accountable for is not evidence.
   */
  const preauth = path.match(/^\/api\/v1\/claims\/([^/]+)\/preauth$/);
  if (preauth && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const view = await claims.recordPreAuthorization(idFromPath(preauth[1]!), {
      status: asString(body.status ?? "").trim() as never,
      recordedBy: actorName(session, body, "recordedBy"),
      source: (asString(body.source ?? "").trim() || "payer-portal") as never,
      ...(body.referenceNumber ? { referenceNumber: asString(body.referenceNumber) } : {}),
      ...(body.validUntil ? { validUntil: asString(body.validUntil) } : {}),
      ...(body.denialReason ? { denialReason: asString(body.denialReason) } : {}),
      ...(body.note ? { note: asString(body.note) } : {}),
    });
    sendJson(res, 200, view);
    return;
  }

  const rendering = path.match(/^\/api\/v1\/claims\/([^/]+)\/rendering-provider$/);
  if (rendering && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const view = await claims.setRenderingProvider(idFromPath(rendering[1]!), {
      provider: {
        firstName: requireString(body, "firstName"),
        lastName: requireString(body, "lastName"),
        npi: requireString(body, "npi"),
        // PRV03. Required by 005010X224A2 whenever loop 2310B is present — a clearinghouse refuses
        // the whole claim structurally without it.
        taxonomyCode: requireString(body, "taxonomyCode"),
      },
      setBy: actorName(session, body, "setBy"),
    });
    sendJson(res, 200, view);
    return;
  }

  const action = path.match(/^\/api\/v1\/claims\/([^/]+)\/(scrub|submit|void)$/);
  if (action && method === "POST") {
    const id = idFromPath(action[1]!);
    if (action[2] === "scrub") {
      sendJson(res, 200, await claims.rescrub(id));
      return;
    }
    const body = await readJsonBody(req);
    if (action[2] === "submit") {
      // THE HUMAN SUBMIT GATE. The actor is the authenticated user — never a client-supplied
      // string. Before M6 this was typed into a text field because there was no session; letting
      // it stay that way would make every audit trail unfalsifiable.
      sendJson(res, 200, await claims.submit(id, { submittedBy: actorName(session, body, "submittedBy") }));
      return;
    }
    sendJson(res, 200, await claims.voidClaim(id, requireString(body, "reason")));
    return;
  }

  await handleRemittanceApi(req, res, services, url, method, path, session);
}

// ── Remittance routes ────────────────────────────────────────────────────────────────
async function handleRemittanceApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<void> {
  const remittance = services.remittance;

  /**
   * What payers charged this practice to pay it (F1).
   *
   * A per-payer rollup of every reimbursement that did not arrive over ACH. Gated on
   * `remittances.read` — the permission that already means "may see incoming money" — because that
   * is exactly what this is: the same payments, read for what they cost to receive rather than for
   * what they settled.
   *
   * Its own path rather than a field on the remittances list, because it answers a question about
   * PAYERS across time, and folding it into a per-advice list would make every consumer of that list
   * carry a rollup none of them asked for.
   */
  if (path === "/api/v1/payment-methods" && method === "GET") {
    sendJson(res, 200, { items: await services.paymentMethods.summary() });
    return;
  }

  /**
   * ── THE SHADOW-MODE FINDINGS (F2, F4, F5) ────────────────────────────────────────────────────
   *
   * Reads, and nothing else. None of these endpoints can change a claim, a posting or a balance —
   * the features behind them are still observation-only, and exposing a way to act on a finding
   * here would be the moment that stopped being true.
   *
   * They exist because a finding nobody can see does no work. Everything below was already being
   * computed and stored on real traffic; none of it was reachable outside a test.
   */
  if (path === "/api/v1/allowed-variances" && method === "GET") {
    sendJson(res, 200, {
      items: await services.allowedVariances.findings({
        recoverableOnly: url.searchParams.get("recoverable") === "1",
      }),
    });
    return;
  }

  if (path === "/api/v1/statutory-clock" && method === "GET") {
    /**
     * `savings` travels beside the findings because the two are read together and must agree.
     * `claimed` and `recovered` are separate figures there and stay separate here — the first is
     * arithmetic this system did, the second is cash a person confirmed — and `deadlinesPassed` is
     * a COUNT with no money, because interest on an unanswered claim has no principal yet.
     */
    const [items, savings] = await Promise.all([
      services.statutoryClock.findings({ openOnly: url.searchParams.get("open") === "1" }),
      services.statutoryClock.savings(),
    ]);
    sendJson(res, 200, { items, savings });
    return;
  }

  if (path === "/api/v1/silent-claims" && method === "GET") {
    // Derived on read, never stored — see `silenceWatchlist`. Already ranked worst-first.
    sendJson(res, 200, { items: await services.claims.silenceWatchlist() });
    return;
  }

  if (path === "/api/v1/remittances") {
    if (method === "GET") {
      const statusParam = url.searchParams.get("status");
      const filter = {
        ...(statusParam ? { status: statusParam as "held" | "posted" } : {}),
        ...(url.searchParams.get("attention") === "1" ? { needsAttention: true } : {}),
      };
      const items = await remittance.list(Object.keys(filter).length ? filter : undefined);
      sendJson(res, 200, {
        items,
        held: items.filter((i) => i.status === "held").length,
        /**
         * How much money is sitting in the held pile, as well as how many advices it is spread over.
         *
         * The screen's header pairs the held COUNT with `totalRecoverable`, which is a different
         * fact about different claims -- what payers still owe on money already posted. Once the
         * recovered denials stopped being counted as outstanding, that header read "2 held · $0.00
         * still owed to the practice", which says nothing is outstanding while $1,599.98 sits
         * unposted in the bank. The count needed its own amount.
         */
        heldTotal: items.filter((i) => i.status === "held").reduce((sum, i) => sum + i.paymentTotal, 0),
        /**
         * ── BOTH TOTALS COUNT POSTED ADVICES ONLY ─────────────────────────────────────────────
         * `buildRecoveryQueue` has always skipped anything not posted, and these headers summed
         * every status — so a held advice carrying recoverable money would appear in the Money
         * total and not in the Recover queue, which is precisely the divergence between those two
         * screens that was fixed once already.
         *
         * It is also the honest reading. A held advice has not been accepted: nothing on it is yet
         * a fact about this practice's money, and the held pile is reported on its own above. Under
         * the old rule staging showed $1,447.53 "awaiting another plan" — the same $482.51 counted
         * once for the posted advice and twice more for two held copies of it.
         */
        totalRecoverable: items
          .filter((i) => i.status === "posted")
          .reduce((sum, i) => sum + i.totalRecoverable, 0),
        /**
         * Money handed to a secondary plan, summed separately from `totalRecoverable` because the
         * two call for opposite actions — see `buildRemittanceView`.
         */
        totalWithOtherPayers: items
          .filter((i) => i.status === "posted")
          .reduce((sum, i) => sum + i.totalWithOtherPayers, 0),
      });
      return;
    }
    if (method === "POST") {
      /**
       * ── UPLOADING AN 835 THE CLINIC ALREADY HOLDS (NEW-15) ──────────────────────────────────
       *
       * This read a JSON body — `{"raw835": "ISA*..."}` — under the global 1 MB cap, and passed it
       * to a parser that refuses any file carrying more than one transaction set. Both halves were
       * wrong for the file a payer's portal actually produces:
       *
       *   • JSON-wrapping an EDI file means escaping every `"` and newline in it, roughly doubling
       *     a payload that is already the largest thing this API accepts — and a practice does not
       *     have the file as JSON, it has it as a download.
       *   • A month-end ERA routinely holds a dozen cheques. `parse835` refuses those, correctly
       *     (see `ingestRawAll`), so the human path could not accept the most ordinary export
       *     there is. The person then split the file by hand in a text editor, around segment
       *     boundaries, in a document where a misplaced `~` changes what a payer is recorded as
       *     having paid.
       *
       * So: the raw bytes are accepted directly, under a cap sized for a real ERA rather than for a
       * JSON form post, and a multi-payment file is ingested only when the caller says it expects
       * one. JSON is still accepted, because the existing clients send it.
       */
      const raw = await readRemittanceBody(req);
      const confirmMultiple = url.searchParams.get("multiple") === "1";

      if (!confirmMultiple) {
        const view = await remittance.ingestRaw(raw);
        sendJson(res, 201, view);
        return;
      }

      /**
       * Explicit, and a different response shape, because it is a different act. Somebody uploading
       * what they believe is one cheque must still be refused if it is three — that belief being
       * wrong is exactly what needs surfacing, and `ingestRaw`'s refusal names the count.
       */
      const views = await remittance.ingestRawAll(raw);
      sendJson(res, 201, { remittances: views, count: views.length });
      return;
    }
    throw new ApiError(405, "method_not_allowed", `${method} not allowed on ${path}.`);
  }

  /**
   * Clearinghouse inbound destination webhook (blueprint doc 06, doc 09, risk R7).
   *
   * Authenticates the clearinghouse delivery using `platform/webhook`.
   * For Stedi, authenticates using bearer API key header configured via STEDI_WEBHOOK_SECRET
   * or STEDI_API_KEY.
   */
  if (path === "/api/v1/webhooks/edi/stedi" || path.startsWith("/api/v1/webhooks/edi/")) {
    // Health probe / reachability check from Stedi destination dashboard
    if (method === "GET" || method === "HEAD") {
      sendJson(res, 200, {
        ok: true,
        service: "stedi-edi-webhook",
        status: "active",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method !== "POST") {
      throw new ApiError(405, "method_not_allowed", `${method} not allowed on ${path}.`);
    }

    // Strictly require dedicated STEDI_WEBHOOK_SECRET (never fall back to clearinghouse API key)
    const secret = process.env.STEDI_WEBHOOK_SECRET;
    if (!secret || secret.trim().length < 32) {
      throw new ApiError(503, "webhook_unconfigured", "Stedi webhook authentication is not configured on this server: STEDI_WEBHOOK_SECRET must be set with at least 32 characters.");
    }

    // Step 1: Authenticate BEFORE reading payload (DoS prevention & security perimeter)
    const rawAuthHeader = (req.headers["authorization"] || req.headers["x-api-key"]) as string | undefined;
    if (!rawAuthHeader || typeof rawAuthHeader !== "string") {
      logger.warn("Inbound EDI webhook rejected: missing authorization header", {
        channel: "security",
        ip: clientIp(req),
      });
      throw new ApiError(401, "unauthorized", "Missing webhook authorization header.");
    }

    // Support case-insensitive Bearer prefix, x-api-key, and direct token candidate
    const authHeaderTrimmed = rawAuthHeader.trim();
    const isBearer = /^bearer\s+/i.test(authHeaderTrimmed);
    const tokenCandidate = isBearer ? authHeaderTrimmed.replace(/^bearer\s+/i, "").trim() : authHeaderTrimmed;

    const secretBuf = Buffer.from(secret.trim(), "utf8");
    const candidateBuf = Buffer.from(tokenCandidate, "utf8");
    const matches = secretBuf.length === candidateBuf.length && timingSafeEqual(secretBuf, candidateBuf);

    if (!matches) {
      logger.warn("Inbound Stedi EDI webhook rejected: unauthorized", {
        channel: "security",
        ip: clientIp(req),
      });
      throw new ApiError(401, "unauthorized", "Webhook authentication failed: credential mismatch.");
    }

    // Step 2: Safely read incoming remittance body
    const raw = await readRemittanceBody(req, services);

    // Step 3: Handle destination ping probe
    if (raw === "__PING__") {
      sendJson(res, 200, {
        ok: true,
        status: "pong",
        message: "Stedi webhook endpoint active",
        traceId: randomUUID(),
      });
      return;
    }

    // Step 4: Ingest the raw 835 payload idempotently
    const views = await remittance.ingestRawAll(raw);

    // Step 5: PHI PROTECTION - NEVER return patient health information to external webhook caller!
    // Return only an opaque delivery confirmation receipt:
    sendJson(res, 200, {
      ok: true,
      status: "accepted",
      received: true,
      count: views.length,
      traceId: randomUUID(),
    });
    return;
  }

  /**
   * Poll the clearinghouse. The mock stands in for the payer's adjudication engine, so it needs to
   * be told which claims to rule on — the BFF supplies them from the submitted claims it can see.
   * A real adapter ignores that and returns whatever the payer released.
   */
  if (path === "/api/v1/remittances/fetch" && method === "POST") {
    const submitted = await services.claims.list({ status: "submitted" });
    if (submitted.length === 0) {
      sendJson(res, 200, { items: [], note: "No claims are awaiting payment." });
      return;
    }
    // Sequential: a request holds ONE pooled client, so `Promise.all` here never ran these
    // concurrently — node-postgres queued them and warned that overlapping `client.query()` calls
    // are deprecated and removed in pg@9.0. See `today.ts` for the full note.
    const detailed: NonNullable<Awaited<ReturnType<typeof services.claims.get>>>[] = [];
    for (const item of submitted) {
      const view = await services.claims.get(item.id);
      if (view && view.claim.submission !== null && view.claim.payer.payerId !== null) detailed.push(view);
    }

    // One advice per payer, as a payer actually sends them.
    const byPayer = new Map<string, typeof detailed>();
    for (const v of detailed) {
      const key = v.claim.payer.payerId!;
      byPayer.set(key, [...(byPayer.get(key) ?? []), v]);
    }

    const views = [];
    for (const [payerId, group] of byPayer) {
      views.push(
        ...(await remittance.fetchAndIngest({
          payerId,
          payerName: group[0]!.claim.payer.payerName ?? payerId,
          payeeName: getConfig().billingProviderName,
          claims: group.map((v) => ({
            patientControlNumber: v.claim.submission!.patientControlNumber,
            payerControlNumber: v.claim.submission!.controlNumber,
            patientFirstName: v.claim.patient.firstName,
            patientLastName: v.claim.patient.lastName,
            memberId: v.claim.patient.memberId,
            lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
            expectedInsurancePays: v.claim.expectedInsurancePays,
          })),
        }))
      );
    }
    sendJson(res, 200, { items: views });
    return;
  }

  /** The recovery queue — every posting still holding money someone owes the practice. */
  if (path === "/api/v1/remittances/recovery" && method === "GET") {
    const items = await remittance.recoveryQueue();
    sendJson(res, 200, {
      items,
      totalRecoverable: items.reduce((sum, i) => sum + i.recoverableAmount + i.unexplainedAmount, 0),
    });
    return;
  }

  /** Daily money reconciliation (blueprint P3). Normally a scheduled job. */
  if (path === "/api/v1/remittances/reconcile" && method === "GET") {
    sendJson(res, 200, await remittance.reconcileAll());
    return;
  }

  const detail = path.match(/^\/api\/v1\/remittances\/([^/]+)$/);
  if (detail && method === "GET") {
    const view = await remittance.get(idFromPath(detail[1]!));
    if (!view) throw new ApiError(404, "not_found", "Remittance not found.");
    sendJson(res, 200, view);
    return;
  }

  /**
   * Reject a held remittance: it will never post (see `RemittanceService.reject`).
   *
   * `kind` is required rather than defaulted: "duplicate" and "test-file" have different
   * follow-ups, and a default would record a decision the person did not make. The kind and the
   * reason ride into the request's own append-only audit row, which commits in the same
   * transaction as the rejection.
   */
  const reject = path.match(/^\/api\/v1\/remittances\/([^/]+)\/reject$/);
  if (reject && method === "POST") {
    const body = await readJsonBody(req);
    const kind = requireString(body, "kind");
    if (kind !== "duplicate" && kind !== "test-file") {
      throw new ApiError(400, "validation_error", "`kind` must be one of: duplicate, test-file.");
    }
    const reason = requireString(body, "reason");
    const view = await remittance.reject(
      idFromPath(reject[1]!),
      // Rejecting a payer's money is a human act, attributed to the authenticated user.
      actorName(session, body, "rejectedBy"),
      reason,
      kind
    );
    auditDetail.set(req, {
      kind,
      reason,
      traceNumber: view.remittance.traceNumber,
      paymentTotalCents: view.remittance.paymentTotal,
      ...(view.remittance.rejection?.duplicateOfTrace
        ? { duplicateOfTrace: view.remittance.rejection.duplicateOfTrace }
        : {}),
    });
    sendJson(res, 200, view);
    return;
  }

  const release = path.match(/^\/api\/v1\/remittances\/([^/]+)\/release$/);
  if (release && method === "POST") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      await remittance.release(
        idFromPath(release[1]!),
        // Releasing held money is a human act, attributed to the authenticated user.
        actorName(session, body, "releasedBy"),
        requireString(body, "reason")
      )
    );
    return;
  }

  /**
   * ── COORDINATION OF BENEFITS (0034) ────────────────────────────────────────────────────────────
   * The cases a payer opens when it says another plan is involved, and the four structured things a
   * person may do with one. Each POST's decision rides into the request's own append-only audit row
   * (`auditDetail`), so "who confirmed this patient had no other plan, from what, on which day" is
   * answerable from the trail, not only from a document that could be rewritten.
   */
  if (path === "/api/v1/coordination-cases" && method === "GET") {
    const items = await listCoordinationWork(services);
    const open = url.searchParams.get("open") === "1";
    sendJson(res, 200, { items: open ? items.filter(isOpen) : items });
    return;
  }
  const coordination = path.match(/^\/api\/v1\/coordination-cases\/([^/]+)(?:\/(confirm-coverage|request-confirmation|mark-filed|close))?$/);
  if (coordination) {
    const id = idFromPath(coordination[1]!);
    const action = coordination[2];
    if (!action && method === "GET") {
      const c = await remittance.getCoordinationCase(id);
      if (!c) throw new CoordinationCaseNotFoundError(id);
      sendJson(res, 200, await coordinationWorkItem(c, services));
      return;
    }
    if (action && method === "POST") {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const actor = actorName(session, body, "actor");
      const updated =
        action === "confirm-coverage"
          ? await remittance.confirmCoverage(id, body as never, actor)
          : action === "request-confirmation"
            ? await remittance.requestCoverageConfirmation(id, body as never, actor)
            : action === "mark-filed"
              ? await remittance.markSecondaryFiled(id, body as never, actor)
              : await remittance.closeSecondaryWork(id, body as never, actor);
      const item = await coordinationWorkItem(updated, services);
      auditDetail.set(req, {
        patientControlNumber: updated.patientControlNumber,
        coverageStatus: updated.coverageStatus,
        workStatus: item.workStatus,
        ...(action === "confirm-coverage" && updated.confirmation
          ? {
              outcome: updated.confirmation.outcome,
              source: updated.confirmation.source,
              sourceNote: updated.confirmation.sourceNote,
              confirmedOn: updated.confirmation.confirmedOn,
              secondaryPayer: updated.confirmation.secondary?.payerName ?? null,
            }
          : {}),
        ...(action === "request-confirmation" && updated.request
          ? { requestedFrom: updated.request.from, requestedOn: updated.request.requestedOn, followUpBy: updated.request.followUpBy }
          : {}),
        ...(action === "mark-filed" && updated.filing ? { filedOn: updated.filing.filedOn, reference: updated.filing.reference } : {}),
        ...(action === "close" && updated.closure ? { closeOutcome: updated.closure.outcome, note: updated.closure.note } : {}),
      });
      sendJson(res, 200, item);
      return;
    }
  }

  await handleDenialsApi(req, res, services, url, method, path, session);
}

// ── Denials, appeals, and the shared payer brain ─────────────────────────────────────
async function handleDenialsApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<void> {
  const denials = services.denials;

  if (path === "/api/v1/denials" && method === "GET") {
    const statusParam = url.searchParams.get("status");
    const filter = {
      ...(statusParam ? { status: statusParam as never } : {}),
      ...(url.searchParams.get("open") === "1" ? { openOnly: true } : {}),
    };
    const items = await denials.list(Object.keys(filter).length ? filter : undefined);
    // The scoreboard covers EVERYTHING, not the filtered page: "how are we doing at recovery" is a
    // question about the practice, not about whatever the UI happens to be showing.
    sendJson(res, 200, { items, stats: await denials.recoveryStats() });
    return;
  }

  const detail = path.match(/^\/api\/v1\/denials\/([^/]+)$/);
  if (detail && method === "GET") {
    const view = await denials.get(idFromPath(detail[1]!));
    if (!view) throw new ApiError(404, "not_found", "Denial not found.");
    sendJson(res, 200, view);
    return;
  }

  /**
   * The AI root-cause explanation. Separate from the action router below because it is not an
   * action: nothing is written, and `null` — the AI layer being off or degraded — is a perfectly
   * good 200. The client renders the deterministic reason code either way.
   */
  const explain = path.match(/^\/api\/v1\/denials\/([^/]+)\/explain$/);
  if (explain && method === "POST") {
    const explanation = await denials.explain(idFromPath(explain[1]!));
    sendJson(res, 200, { explanation });
    return;
  }

  const action = path.match(/^\/api\/v1\/denials\/([^/]+)\/(draft|revise|approve|submit|outcome|close)$/);
  if (action && method === "POST") {
    const id = idFromPath(action[1]!);
    const body = (await readJsonBody(req)) as Record<string, unknown>;

    if (action[2] === "draft") {
      sendJson(
        res,
        200,
        await denials.draftAppeal(id, {
          memberId: asString(body.memberId),
          claimControlNumber: asString(body.claimControlNumber),
          serviceDate: asString(body.serviceDate),
        })
      );
      return;
    }
    if (action[2] === "revise") {
      // Editing the drafted letter, which also clears any approval on it — an approval signs off
      // specific words, so words that change need a fresh signature. See `reviseAppeal`.
      sendJson(
        res,
        200,
        await denials.reviseAppeal(id, requireString(body, "letter"), actorName(session, body, "revisedBy"))
      );
      return;
    }
    if (action[2] === "approve") {
      // THE HUMAN GATE. The approver is the authenticated user — an appeal is a factual assertion
      // to a payer about a patient's care, and it must be attributable to a real person.
      sendJson(res, 200, await denials.approveAppeal(id, actorName(session, body, "approvedBy")));
      return;
    }
    if (action[2] === "submit") {
      sendJson(res, 200, await denials.submitAppeal(id));
      return;
    }
    if (action[2] === "outcome") {
      /**
       * The one money input this API accepted unvalidated. `Number("abc")` is NaN and
       * `cents(NaN)` is NaN — which JSON.stringify then persists as null on a record whose
       * `recoveredAmount` feeds the recovery scoreboard and the learning loop; a negative value
       * would subtract recovered revenue nobody lost. Every other dollar field on this API
       * already refuses both.
       */
      const recoveredDollars = optionalDollars(body, "recoveredAmountDollars");
      if (recoveredDollars !== null && (!Number.isFinite(recoveredDollars) || recoveredDollars < 0)) {
        throw new ApiError(400, "validation_error", "`recoveredAmountDollars` must be a non-negative number.");
      }
      sendJson(
        res,
        200,
        await denials.recordOutcome(id, {
          won: body.won === true,
          // Dollars in, cents at the boundary — the single money-conversion point (§12.1).
          ...(recoveredDollars !== null ? { recoveredAmount: cents(recoveredDollars) } : {}),
          notes: asString(body.notes),
          recordedBy: actorName(session, body, "recordedBy"),
        })
      );
      return;
    }
    /**
     * ── THE CONTRACTUAL OVERRIDE IS AUTHORIZED HERE, AND REFUSED HERE (NEW-07) ─────────────────
     *
     * `denials.write` is what a biller holds to close denials all day, and it used to be enough to
     * move ANY denial to a patient's balance — including one the payer had labelled `CO`, which is
     * the payer citing the practice's own contract. The service now refuses that outright; this is
     * the one door through it, and it needs a permission a biller does not have.
     *
     * Checked BEFORE the flag reaches the service, so a caller without the permission is refused
     * for the honest reason ("you may not override this") rather than being told the denial is not
     * billable — two different problems with two different remedies.
     */
    const wantsOverride = body.overrideContractualBar === true;
    if (wantsOverride) {
      /**
       * ── THE ABSENT SESSION IS ASSERTED, NOT PERMITTED ─────────────────────────────────────────
       *
       * This read `wantsOverride && session && !can(...)`, which SKIPS the check entirely when there
       * is no session. That is correct today only because `ROUTE_PERMISSIONS` gates this route on
       * `denials.write`, so a persistent deployment cannot reach here unauthenticated — an invariant
       * enforced nine hundred lines away, in a different table, that this line silently depended on.
       *
       * It is also the only inline `can()` check in this file, guarding the one action that bills a
       * patient money their payer's contract says is not theirs. A guard written in a shape
       * indistinguishable from an oversight is one somebody eventually "tidies" the wrong way, or
       * one that quietly stops holding when a route moves. So the invariant is asserted here.
       *
       * The database-free demo genuinely has no authorization model — no route enforces
       * `ROUTE_PERMISSIONS` there either — so refusing on a null session would single this action out
       * for a rule the rest of the app is not playing by. `persistent` is the honest condition: it
       * asks whether there IS an auth model rather than whether this one request happens to carry a
       * session.
       */
      if (services.persistent && !session) {
        throw new AuthError(401, "unauthenticated", "login required");
      }
      if (session && !can(session.user.role as Role, "denials.bill_patient_override")) {
        throw new AuthError(
          403,
          "forbidden",
          "billing a patient for an adjustment the payer did not assign to them needs the " +
            "contractual-override permission, which belongs to whoever owns the payer contracts"
        );
      }
    }

    sendJson(
      res,
      200,
      await denials.close(id, {
        as: asString(body.as) === "patient_billed" ? "patient_billed" : "written_off",
        reason: requireString(body, "reason"),
        closedBy: actorName(session, body, "closedBy"),
        ...(wantsOverride ? { overrideContractualBar: true } : {}),
      })
    );
    return;
  }

  await handlePatientLedgerApi(req, res, services, url, method, path, session);
}

// ── The patient ledger, the Today queue, and the practice report ─────────────────────
async function handlePatientLedgerApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<void> {
  const ledger = services.ledger;

  /** Every patient account, ranked by what it costs to leave alone, plus the practice's A/R totals. */
  if (path === "/api/v1/patients" && method === "GET") {
    const filter = url.searchParams.get("owing") === "1" ? { withBalanceOnly: true } : undefined;
    sendJson(res, 200, { items: await ledger.list(filter), summary: await ledger.summary() });
    return;
  }

  /**
   * The patient master (M14) — every PERSON the practice has seen, not every account with money on
   * it. Distinct from `/patients` above, and deliberately so: a patient verified last week and never
   * billed has a record here and no ledger account, and a directory that hid them would tell the
   * front desk this practice has never met them.
   *
   * Matched before the `:key` statement route below, which would otherwise swallow it.
   */
  /**
   * The schedule, with each visit's coverage readiness (0035; blueprint doc 06). Defaults to the
   * next 14 days — the horizon §8.2's readiness timeline draws.
   */
  if (path === "/api/v1/appointments" && method === "GET") {
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const from = fromParam ? new Date(fromParam) : new Date();
    const to = toParam ? new Date(toParam) : new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
    try {
      const items = await services.appointments.list(from, to);
      /*
       * `today` and `timeZone` travel with the items so a screen can ask "which of these are
       * today" and write "9:30" in the practice's clock without doing time-zone arithmetic of its own.
       */
      sendJson(res, 200, { items, from: from.toISOString(), to: to.toISOString(), ...services.appointments.calendar() });
    } catch (e) {
      if (e instanceof InvalidAppointmentWindowError) throw new ApiError(400, "invalid-window", e.message);
      throw e;
    }
    return;
  }

  /**
   * Schedule import (stage 4): `preview` reads the export and writes nothing; `import` reads it
   * again on the server and syncs it. Both take `{ csv, mapping? }` — the CSV as text, and any
   * column the person re-mapped.
   */
  if ((path === "/api/v1/appointments/import/preview" || path === "/api/v1/appointments/import") && method === "POST") {
    const body = (await readJsonBody(req)) as { csv?: unknown; mapping?: unknown };
    if (typeof body?.csv !== "string" || body.csv.trim() === "") {
      throw new ApiError(400, "invalid-body", "csv must be the text of a schedule export.");
    }
    const mapping: Record<string, string | null> = {};
    if (body.mapping !== undefined) {
      if (typeof body.mapping !== "object" || body.mapping === null || Array.isArray(body.mapping)) {
        throw new ApiError(400, "invalid-body", "mapping must be an object of field → column name.");
      }
      for (const [k, v] of Object.entries(body.mapping as Record<string, unknown>)) {
        if (!IMPORT_FIELDS.some((f) => f.key === k)) throw new ApiError(400, "invalid-body", `"${k}" is not an import field.`);
        if (v !== null && typeof v !== "string") throw new ApiError(400, "invalid-body", `mapping.${k} must be a column name or null.`);
        mapping[k] = v as string | null;
      }
    }
    let result;
    try {
      result =
        path.endsWith("/preview")
          ? services.appointments.previewImport(body.csv, mapping)
          : await services.appointments.importCsv(body.csv, mapping);
    } catch (e) {
      // `parseCsv` throws only on text that is not CSV at all — an unclosed quote.
      if (e instanceof Error && /quoted field/.test(e.message)) throw new ApiError(400, "invalid-csv", e.message);
      throw e;
    }
    if (!path.endsWith("/preview")) {
      const r = result as { created: number; updated: number; unchanged: number; rejected: unknown[]; fileProblems: string[] };
      auditDetail.set(req, { created: r.created, updated: r.updated, unchanged: r.unchanged, rejected: r.rejected.length, refused: r.fileProblems.length > 0 });
    }
    sendJson(res, 200, result);
    return;
  }

  /** What "Verify all due" would check, and what it would skip and why. Calls no payer. */
  if (path === "/api/v1/appointments/due" && method === "GET") {
    sendJson(res, 200, await services.appointments.due());
    return;
  }

  /**
   * Run the checks — a person's single click, never a schedule (stage 3).
   *
   * The body names the visits the person SAW; the service re-derives what is due now and checks
   * only the intersection, so a stale screen cannot send a request for a visit already fixed.
   */
  if (path === "/api/v1/appointments/verify" && method === "POST") {
    const body = (await readJsonBody(req)) as { appointmentIds?: unknown };
    const ids = body?.appointmentIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) {
      throw new ApiError(400, "invalid-body", "appointmentIds must be a non-empty list of appointment ids.");
    }
    const key = session?.user.practiceId ?? "local";
    if (verifyRunsInFlight.has(key)) {
      throw new ApiError(409, "run-in-progress", "A check of due visits is already running for this practice. Wait for it to finish.");
    }
    verifyRunsInFlight.add(key);
    try {
      const result = await services.appointments.runDue(ids as string[], (input, now) => services.verification.create(input, now));
      auditDetail.set(req, {
        requested: ids.length,
        checked: result.checked,
        errors: result.results.filter((r) => r.outcome === "error").length,
        notRun: result.results.filter((r) => r.outcome === "not-run").length,
      });
      sendJson(res, 200, result);
    } finally {
      verifyRunsInFlight.delete(key);
    }
    return;
  }

  if (path === "/api/v1/patients/directory" && method === "GET") {
    const query = url.searchParams.get("q") ?? undefined;
    const patients = await services.patients.list(query?.trim() ? query : undefined);
    sendJson(res, 200, { items: patients, count: patients.length, query: query ?? null });
    return;
  }

  /**
   * The Unified Patient Financial Record — node B of the workflow diagram, assembled (M14
   * deliverable 4). Composed at request time from five contexts; see `patient-record.ts` for why it
   * is not a projection.
   */
    /**
     * V5 — correct the address on the patient master.
     *
     * The half of V5 that stops the same question being asked twice. V2 made a stored address
     * REUSED by the next verification, so correcting it here is what makes every future claim for
     * this person filable without anyone re-keying anything.
     *
     * `null` clears it, and that is a deliberate capability rather than an oversight: an address
     * entered against the wrong patient has to be removable, and `ensure`'s forward-only merge can
     * never do it. Clearing returns the record to "not collected", which the scrubber correctly
     * blocks on — honest, and visibly so on the screen.
     */
    const patientAddress = path.match(/^\/api\/v1\/patients\/record\/([^/]+)\/address$/);
    if (patientAddress && method === "PUT") {
      const address = parseAddressBody(await readJsonBody(req));
      const updated = await services.patients.updateAddress(decodeURIComponent(patientAddress[1]!), address);
      // Indistinguishable from "belongs to another practice" — a caller must never learn that a
      // patient exists in a tenant they cannot see.
      if (!updated) throw new ApiError(404, "not_found", "No patient record with that id.");
      sendJson(res, 200, { patient: updated });
      return;
    }


  const record = path.match(/^\/api\/v1\/patients\/record\/([^/]+)$/);
  if (record && method === "GET") {
    const view = await buildPatientRecord(services, idFromPath(record[1]!));
    // Indistinguishable from "belongs to another practice", which is the point: a caller must never
    // be able to learn that a patient exists in a tenant they cannot see.
    if (!view) throw new ApiError(404, "not_found", "No patient record with that id.");
    sendJson(res, 200, view);
    return;
  }

  const statement = path.match(/^\/api\/v1\/patients\/([^/]+)$/);
  if (statement && method === "GET") {
    const view = await ledger.statement(decodeURIComponent(statement[1]!));
    if (!view) throw new ApiError(404, "not_found", "No ledger account for that patient.");
    sendJson(res, 200, view);
    return;
  }

  /**
   * Money leaving a patient's balance. All three are HUMAN acts, attributed to the authenticated
   * user — reducing what a patient owes is exactly how a practice loses money quietly, so none of
   * these may ever be driven by a client-supplied actor.
   */
  const movement = path.match(/^\/api\/v1\/patients\/([^/]+)\/(payment|adjustment|writeoff)$/);
  if (movement && method === "POST") {
    const patientKey = decodeURIComponent(movement[1]!);
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const dollars = requireDollars(body, "amountDollars");
    if (!Number.isFinite(dollars) || dollars <= 0) {
      throw new ApiError(400, "validation_error", "`amountDollars` must be a positive number.");
    }
    /**
     * Refused here rather than rounded, because this is the conversion point and rounding money a
     * caller did not ask to have rounded is a change nothing records.
     *
     * `PatientLedgerService` already states this rule — "the amount must be a positive whole number
     * of cents" — but checks it AFTER `cents()` has rounded, so it always passes. $10.005 posted a
     * $10.01 payment and returned 200. A ledger that quietly disagrees with the system it was
     * reconciled from is one nobody can reconcile again.
     */
    if (!isWholeCents(dollars)) {
      throw new ApiError(
        400,
        "validation_error",
        "`amountDollars` must be a whole number of cents — this amount would have to be rounded, " +
          "and money is not rounded on your behalf."
      );
    }
    // Dollars in, cents at the boundary — the single money-conversion point (§12.1).
    const input = {
      amount: cents(dollars),
      recordedBy: actorName(session, body, "recordedBy"),
      note: asString(body.note),
    };
    const kind = movement[2];
    sendJson(
      res,
      200,
      kind === "payment"
        ? await ledger.recordPayment(patientKey, input)
        : kind === "adjustment"
          ? await ledger.recordAdjustment(patientKey, input)
          : await ledger.writeOff(patientKey, input)
    );
    return;
  }

  /**
   * Staff administration (G-2).
   *
   * ── WHY THIS EXISTED AS A PERMISSION AND NOT AS A SCREEN ──────────────────────────────────────
   * `users.manage` and `org.manage` have been in roles.ts since P1 with nothing to grant. The
   * service layer was already there too — `createUser` and `listUsers` — reachable only by the
   * bootstrap seeder. So a practice could not onboard a hygienist or revoke a departed biller's
   * access without an engineer holding a psql session, which is both an operational dead end and a
   * security one: the accounts most needing revocation are the ones nobody can revoke.
   */
  /**
   * What the system has LEARNED each payer allows (G-1).
   *
   * ── WHY THIS NEEDED A SCREEN AND NOT ONLY A MONITOR ───────────────────────────────────────────
   * `allowedAmounts` is described in wiring.ts as "exposed so what the system learned is
   * observable, not implied". It was read by exactly two things: the wiring that builds the fee
   * schedule, and two health checks. No endpoint, no screen.
   *
   * So the contracted rate that decides every patient's quote and every "written off by contract"
   * figure could not be inspected by the people accountable for it. An insurance coordinator could
   * not answer "where did this discount come from?" and an office manager could not audit a rate
   * BEFORE it was used to quote somebody. A monitor could see it; a human could not.
   *
   * `payers.read` rather than an admin permission: this is reference data about contracts, and the
   * roles that quote patients from it are exactly the roles that need to check it.
   */
  if (path === "/api/v1/payer-profile/contracted-rates" && method === "GET") {
    const rates = await services.allowedAmounts.listAll();
    /**
     * Names, not slugs. A rate is stored against `payerId` because that is what an 835 carries;
     * a coordinator checking a contract is looking for "Delta Dental", not "delta-dental".
     * Falls back to the slug so a rate learned from a payer missing from the catalog is still
     * listed rather than silently dropped.
     */
    const payerNames = new Map<string, string>(
      (await services.payerProfile.connectors()).map((p) => [p.payerId, p.payerName])
    );

    const items = rates
      .map((r) => {
        const writeOff = Math.max(0, r.charged - r.allowed);
        return {
          payerId: r.payerId,
          payerName: payerNames.get(r.payerId) ?? r.payerId,
          cdtCode: r.cdtCode,
          allowed: r.allowed,
          /** The billed fee this rate was learned against — the discount only means something beside it. */
          charged: r.charged,
          writeOff,
          /** Shown as a percentage because that is how a practice talks about a contract. */
          discountRate: r.charged > 0 ? writeOff / r.charged : 0,
          observations: r.observations,
          restatements: r.restatements,
          fullPriceSince: r.fullPriceSince,
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt,
          /**
           * The same two thresholds the monitors alert on, attached per row.
           *
           * A practice told "a rate is unstable" by an alert then had nowhere to go and see WHICH.
           * Deriving the flags here from the identical constants keeps one definition of unstable
           * rather than a dashboard that disagrees with its own alert.
           */
          unstable: r.restatements >= RATE_RESTATEMENT_LIMIT,
          possiblyLapsed: r.fullPriceSince >= FULL_PRICE_RUN_LIMIT,
        };
      })
      .sort(
        (a, b) =>
          a.payerName.localeCompare(b.payerName) || a.cdtCode.localeCompare(b.cdtCode)
      );

    sendJson(res, 200, {
      items,
      /**
       * Stated so an empty list is not read as "this practice has no contracts". A rate is learned
       * only from a payer's own CO adjustment, so a practice that has posted no remittances yet has
       * nothing here and is quoting from billed fees — which is correct, and worth saying.
       */
      learnedFrom: "contractual (CO) adjustments on posted remittances",
      unstableCount: items.filter((i) => i.unstable).length,
      lapsedCount: items.filter((i) => i.possiblyLapsed).length,
    });
    return;
  }

  if (path.startsWith("/api/v1/users")) {
    /**
     * Unreachable: `ROUTE_PERMISSIONS` gates every `/api/v1/users` path on `users.manage`, and a
     * non-null permission means `authorizeRequest` already threw 401 without a session. Stated as a
     * check rather than a `!` so that a future route added above the guard fails loudly here rather
     * than dereferencing null.
     */
    if (!session) throw new ApiError(401, "unauthenticated", "login required");
    const actor = session.user;

    if (path === "/api/v1/users" && method === "GET") {
      const users = await listUsers(actor.practiceId);
    sendJson(res, 200, {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        disabled: u.disabled,
        // Whether this person has a second factor enrolled (0038) — what an administrator resets.
        mfaEnabled: u.mfa_enabled === true,
        /**
         * So the screen can grey out the controls that would fail anyway. The SERVER still refuses
         * both — see `setUserAccess` and `setUserRole` — this only stops the UI offering an action
         * it knows will be rejected.
         */
        isSelf: u.id === actor.id,
      })),
    });
    return;
  }

  if (path === "/api/v1/users" && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const email = asString(body.email ?? "").trim().toLowerCase();
    const name = asString(body.name ?? "").trim();
    const role = asString(body.role ?? "").trim();
    if (!name) throw new ApiError(400, "validation_error", "`name` is required.");

    /**
     * No password crosses this boundary, in either direction. See `inviteUser`: the account is
     * created with a random credential nobody ever sees and the person sets their own through the
     * reset flow. An administrator who could type a colleague's password would be creating a shared
     * secret, and every later action by that account would be deniable.
     */
    const created = await inviteUser(actor.practiceId, { email, name, role }, clientIp(req));
    sendJson(res, 201, {
      id: created.id,
      email,
      name,
      role,
      /**
       * Returned because no mail provider is configured — that needs a hosting decision and a BAA
       * (the M13 gate). The administrator hands this over, which is the documented manual process
       * `auth:issue-reset` already exists for. When mail is configured, this stops being returned.
       */
      resetToken: created.resetToken,
      delivery: created.resetToken
        ? "No email provider is configured. Give this one-time link to the new user yourself; it expires."
        : "A reset was issued but cannot be shown here.",
    });
    return;
  }

  const userRole = path.match(/^\/api\/v1\/users\/([^/]+)\/role$/);
  if (userRole && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    await setUserRole(
      actor.practiceId,
      actor.id,
      idFromPath(userRole[1]!),
      asString(body.role ?? "").trim(),
      clientIp(req)
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  /**
   * The lost-phone path (0038): an administrator clears another person's second factor and ends
   * their sessions. Gated by `users.manage` with the rest of this block; never one's own.
   */
  const userMfaReset = path.match(/^\/api\/v1\/users\/([^/]+)\/mfa\/reset$/);
  if (userMfaReset && method === "POST") {
    await resetUserMfa(session, idFromPath(userMfaReset[1]!), clientIp(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  const userAccess = path.match(/^\/api\/v1\/users\/([^/]+)\/access$/);
  if (userAccess && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    await setUserAccess(
      actor.practiceId,
      actor.id,
      idFromPath(userAccess[1]!),
      body.disabled === true,
      clientIp(req)
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  }

  /**
   * The unified Today queue (blueprint doc 07): one ranked worklist across every module. Composed
   * here rather than projected — see apps/web/today.ts for why.
   */
  if (path === "/api/v1/today" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    /**
     * The viewer is passed so the board can withhold what this role may not see.
     *
     * `ROUTE_PERMISSIONS` gates this path on `queue.read` alone, and that is right for a worklist —
     * every role holds it, because every role has work. It is wrong for the money position the
     * board now carries: a front-desk role deliberately excludes claims, remittances, denials and
     * analytics, and gating the route harder would take the worklist away from them rather than
     * showing them their half of it. So the filtering happens per module, inside.
     *
     * A null session reaches here only in the DB-free demo, which has no accounts at all.
     */
    sendJson(
      res,
      200,
      await buildTodayQueue(
        services,
        Number.isFinite(limit) ? Math.min(200, limit) : 50,
        new Date(),
        session ? { role: session.user.role } : null
      )
    );
    return;
  }

  /** The practice report. `from`/`to` are ISO timestamps; the default window is the last 30 days. */
  if (path === "/api/v1/analytics/report" && method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    sendJson(res, 200, await services.analytics.report({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }));
    return;
  }

  await handleOpsApi(req, res, services, url, method, path, session);
}

// ── Operations: the outbox, the audit trail, and deep readiness ──────────────────────
//
// The outbox is the one component whose failure is invisible from every business screen: claims stop
// being created, denials stop being triaged, and nothing on any queue says why. These routes exist
// so that is observable and fixable by a person, without a psql session.
async function handleOpsApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  url: URL,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<void> {
  /**
   * What the watchdog currently sees — the money checks included (M20).
   *
   * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────────────────────
   * `runChecks` computes reconciliation drift, held-remittance age and abandoned ERA files, and
   * until now its only non-test caller wrote a log line. In a single-practice deployment with no log
   * aggregation, the human fallback for every silent money failure in this system was *somebody
   * reads the logs*. Meanwhile `/readiness` below hand-rolled a different, smaller set of checks, so
   * the two disagreed about what "healthy" meant and the money half was the invisible one.
   *
   * ── SCOPED TO THE CALLER'S PRACTICE, DELIBERATELY ────────────────────────────────────────────
   * `this-practice`, never the watchdog's cross-tenant aggregate. The monitor sums held money across
   * every practice because that is its job; serving that sum to a logged-in user would put another
   * practice's money on their screen. Queue mechanics span tenants; anything a user looks at never
   * does.
   *
   * Ungated on purpose: the alert gate decides when to ANNOUNCE, and asking it here would both
   * suppress current state behind a cooldown and mutate the alerting state machine from a page load.
   */
  if (path === "/api/v1/ops/monitors" && method === "GET") {
    const readings = await takeReadings(services, DEFAULT_THRESHOLDS, new Date(), "this-practice");
    sendJson(res, 200, monitorPayload(readings));
    return;
  }

  /** Queue health: depth, dead letters, and the mandated event-lag signal (blueprint doc 13). */
  /**
   * Who opened what (0037). Behind `audit.read`, like every ops route. `?resourceId=` answers "who
   * looked at this record"; `?actorId=` answers "what did this person look at".
   */
  if (path === "/api/v1/ops/access-log" && method === "GET") {
    const actorId = url.searchParams.get("actorId");
    if (actorId !== null && !/^[0-9a-f-]{36}$/i.test(actorId)) {
      sendError(res, 400, "invalid_request", "actorId must be a user id.");
      return;
    }
    const items = await listPhiAccess(requireContext().tx, {
      resourceId: url.searchParams.get("resourceId"),
      actorId,
      limit: Number(url.searchParams.get("limit") ?? 200),
    });
    sendJson(res, 200, { items });
    return;
  }

  if (path === "/api/v1/ops/outbox" && method === "GET") {
    // THIS practice's queue (NEW-06). It read the global backlog, so the counts above the list
    // described every tenant on the deployment while the list below described one — and a busy
    // neighbour made a healthy queue look stalled.
    const backlog = await services.bus.practiceBacklog();
    // Sequential — one client per request; see `today.ts`. These two reads never overlapped.
    const recent = await services.bus.recentEvents(Number(url.searchParams.get("limit") ?? 25));
    const dead = await services.bus.recentEvents(50, true);
    sendJson(res, 200, {
      backlog,
      lagMs: backlog.oldestPending ? Date.now() - new Date(backlog.oldestPending).getTime() : 0,
      recent: recent.map(summariseEvent),
      dead: dead.map(summariseEvent),
    });
    return;
  }

  /**
   * Put a dead-lettered event back on the queue. A human act, and audited like any other mutation:
   * automatic revival of something that already failed every retry is just a slower hot loop.
   */
  const revive = path.match(/^\/api\/v1\/ops\/outbox\/([^/]+)\/retry$/);
  if (revive && method === "POST") {
    const revived = await services.bus.revive(idFromPath(revive[1]!));
    if (!revived) {
      throw new ApiError(409, "not_dead_lettered", "That event is not dead-lettered, or is not yours.");
    }
    sendJson(res, 200, { ok: true, backlog: await services.bus.practiceBacklog() });
    return;
  }

  /**
   * ── REGISTERING AN ERA SOURCE, THROUGH THE REPOSITORY THAT ENCRYPTS (NEW-11) ────────────────
   *
   * `era_sources.credential` is a clearinghouse API key that fetches a practice's payment files.
   * `PgEraSourceRepository.upsert` runs it through `encryptPhi` — and nothing reached that method
   * from outside a test. The only way to register a source was hand-written SQL, and hand-written
   * SQL writes exactly what it is given: a credential in the clear, in a column whose whole design
   * assumes it is not.
   *
   * A route is not a convenience here. It is the difference between "the encryption exists" and
   * "the encryption is used", and those are the same distinction as between a control and a claim.
   *
   * The credential is NEVER echoed back — not the value, not a prefix, not a length. A registration
   * response that confirmed the key by showing part of it would put it in a browser history, a
   * proxy log and a screenshot.
   */
  if (path === "/api/v1/ops/era-sources" && method === "GET") {
    const sources = await services.eraSources.list();
    sendJson(res, 200, {
      sources: sources.map((s) => ({
        id: s.id,
        vendor: s.vendor,
        payeeNpi: s.payeeNpi,
        enabled: s.enabled,
        cursor: s.cursor,
        lastPolledAt: s.lastPolledAt,
        lastError: s.lastError,
        // Presence and PROTECTION, never the value — the same rule the secret inventory follows.
        credentialConfigured: s.credentialConfigured,
        credentialEncrypted: s.credentialEncrypted,
      })),
    });
    return;
  }

  if (path === "/api/v1/ops/era-sources" && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const vendor = requireString(body, "vendor").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(vendor)) {
      throw new ApiError(400, "validation_error", "`vendor` must be a short slug, e.g. \"stedi\".");
    }
    const credential = requireString(body, "credential");
    if (!credential.trim()) {
      throw new ApiError(400, "validation_error", "`credential` must not be empty.");
    }
    const payeeNpi = body.payeeNpi == null ? null : asString(body.payeeNpi).trim().replace(/\D/g, "");
    if (payeeNpi !== null && payeeNpi.length !== 10) {
      /**
       * The payee NPI is what the ingest cross-checks an 835's payee against before a cent is
       * posted — it is the control that stops one practice's payment landing in another's ledger.
       * A malformed one would make that check compare against something no payer will ever send,
       * which fails safe but silently: every file held, for a reason nobody would look for here.
       */
      throw new ApiError(400, "validation_error", "`payeeNpi` must be 10 digits, or null.");
    }

    const saved = await services.eraSources.register({
      vendor,
      credential,
      payeeNpi,
      enabled: body.enabled !== false,
    });

    sendJson(res, 200, {
      source: {
        id: saved.id,
        vendor: saved.vendor,
        payeeNpi: saved.payeeNpi,
        enabled: saved.enabled,
        credentialConfigured: saved.credentialConfigured,
        credentialEncrypted: saved.credentialEncrypted,
      },
    });
    return;
  }

  /** The append-only audit trail — who changed what, and when. */
  if (path === "/api/v1/ops/audit" && method === "GET") {
    if (!services.persistent) {
      sendJson(res, 200, { items: [], note: "The audit trail is a database control; this deployment has no database." });
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const { rows } = await requireContext().tx.query(
      `SELECT id, trace_id, actor_role, action, resource, resource_id, outcome, ip, created_at
         FROM audit_events ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    sendJson(res, 200, { items: rows });
    return;
  }

  /**
   * The recorded result of the ten live Stedi TEST-mode scenarios.
   *
   * ── WHY THIS SERVES A TRANSCRIPT AND DOES NOT RE-RUN ANYTHING ──────────────────────────────────
   * The obvious design is a button that runs the scenarios and shows what happened. It is the wrong
   * one. Those scenarios make real calls to a real clearinghouse — including live 270/271 eligibility
   * checks against Aetna — and create a throwaway practice per scenario. A GET that fires them
   * because somebody opened a tab would bill the practice for curiosity and litter the database.
   *
   * Seven of the ten are also blocked by an account-provisioning gate that no re-run will move, so
   * the answer would not change; and a page that computes its own result can disagree with the report
   * it claims to display, which is two sources of truth for whether the integration works.
   *
   * So the harness is the instrument and this is the reading. It is dated and carries the commit it
   * was taken at, because a screen asserting "the integration works", present tense and undated, is
   * the thing this page exists to not be.
   *
   * No practice data is involved — this is a static artefact — but it stays behind `audit.read` with
   * every other `/ops` route, because it names internal endpoints, vendor account state and open
   * defects.
   */
  if (path === "/api/v1/ops/integration-tests" && method === "GET") {
    sendJson(res, 200, INTEGRATION_REPORT);
    return;
  }

  /**
   * Deep readiness — the check a load balancer or a deploy should gate on, as opposed to `/health`,
   * which only proves the process is listening. Reports 503 when something is actually wrong, so a
   * bad deploy fails rather than quietly serving a broken app.
   */
  if (path === "/api/v1/ops/readiness" && method === "GET") {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    if (services.persistent) {
      try {
        await requireContext().tx.query("SELECT 1");
        checks.push({ name: "database", ok: true, detail: "reachable, and RLS armed for this practice" });
      } catch (err) {
        checks.push({ name: "database", ok: false, detail: err instanceof Error ? err.message : "unreachable" });
      }

      /**
       * ── THE APPEND-ONLY TRAIL, ASSERTED RATHER THAN ASSUMED (audit B-3) ─────────────────────
       *
       * `provision-app-role.mjs` revokes INSERT/UPDATE/DELETE/TRUNCATE on `audit_events` and
       * refuses to report success if the revoke did not take. That is the right guard and it runs
       * exactly once, by hand, at provisioning time — and the development database was found
       * holding all three grants again. Nothing in the deploy path re-runs provisioning, so the
       * drift is silent by construction: the trail keeps being written, keeps being readable, and
       * has quietly stopped being tamper-evident at the grant layer.
       *
       * RLS is the second layer and it held — the policies admit only SELECT, so a forged row is
       * still refused. That is exactly why this needs to be a check rather than an incident: the
       * failure is invisible from the application, costs nothing until the day it matters, and the
       * only signal it can ever produce is somebody asking the catalog.
       *
       * A hard failure, because the remedy is one command (`npm run db:provision-role`) and because
       * "the audit trail is append-only" is a claim this product makes to a dental practice about
       * their patients' records.
       */
      try {
        const grants = await requireContext().tx.query(
          `SELECT privilege_type
             FROM information_schema.role_table_grants
            WHERE grantee = current_user
              AND table_schema = 'public'
              AND table_name = 'audit_events'
              AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
            ORDER BY privilege_type`
        );
        const held = (grants.rows as { privilege_type: string }[]).map((r) => r.privilege_type);
        checks.push({
          name: "audit_trail_append_only",
          ok: held.length === 0,
          detail:
            held.length === 0
              ? "the application role holds no write grant on audit_events — the trail is append-only"
              : `the application role holds ${held.join(", ")} on audit_events, so the trail is no ` +
                `longer append-only at the grant layer. RLS still refuses a forged row, so nothing ` +
                `is known to have been tampered with — but run \`npm run db:provision-role\` against ` +
                `this database to restore the revoke.`,
        });
      } catch (err) {
        // The catalog read failing is not the same as the grant being held, and reporting it as
        // such would send an operator to fix something that is not broken.
        checks.push({
          name: "audit_trail_append_only",
          ok: false,
          detail: `could not read the grants on audit_events: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      checks.push({ name: "database", ok: true, detail: "not configured — in-memory demo mode" });
    }

    /**
     * ── ONE DEFINITION OF HEALTHY (M20) ────────────────────────────────────────────────────────
     *
     * This used to compute its own outbox check from `services.bus.backlog()` while the watchdog
     * computed a different one from the same data, and the money checks — drift, held-remittance
     * age, abandoned ERA files — appeared in neither. Two health mechanisms, disagreeing, with the
     * money one invisible.
     *
     * Readiness now READS the watchdog's own conclusions rather than restating a subset of them. A
     * check that stops firing here is one that stopped firing there, which is the only way the two
     * can be trusted to mean the same thing.
     *
     * `database` and `phi_encryption` stay local: they are infrastructure and configuration, not
     * conditions the money watchdog measures, and there is nothing for it to say about them.
     */
    for (const reading of await takeReadings(services, DEFAULT_THRESHOLDS, new Date(), "this-practice")) {
      checks.push({ name: reading.key, ok: !reading.breaching, detail: reading.message });
    }

    /**
     * ── THE DEPLOYMENT'S OWN MODE, WHICH NOTHING REPORTED (audit A-5) ──────────────────────────
     *
     * `getConfig().isProd` decides five separate refusals — the demo billing identity, the insecure
     * session cookie, the missing proxy declaration, the unset practice timezone, and HSTS — and the
     * only way to know from outside whether a deployment has it set was to notice that its responses
     * carry no `Strict-Transport-Security` header — an audit by deduction from an absent header,
     * which is not a thing anybody should have to do.
     *
     * ── WHY THE FAILURE CONDITION IS THE COMBINATION, NOT THE MODE ────────────────────────────────
     * A laptop is not production and must not be red. A demonstration deployment filing mock claims
     * under the demo identity is coherent and must not be red either.
     *
     * The state that IS wrong is the middle one: a real practice NPI configured while the process is
     * not in production mode. Claims then go out under a number a payer will recognise, while every
     * guard that exists to protect a real deployment is switched off — the session cookie loses
     * `Secure`, the client IP is taken from whichever header a proxy happens to send, and HSTS is not
     * emitted. That is precisely the state a pilot arrives in when somebody sets the NPI and forgets
     * the mode, and it is invisible until it matters.
     */
    const identity = {
      name: getConfig().billingProviderName,
      npi: getConfig().billingProviderNpi,
      taxId: getConfig().billingProviderTaxId,
    };
    const { placeholder, fields } = isPlaceholderBillingIdentity(identity);
    const prod = getConfig().isProd;
    const hosted = getConfig().hosted;
    const demo = getConfig().isDemoDeployment;
    const reaches = getConfig().filesToRealPayers;

    /**
     * What KIND of deployment this is, reported separately from whether it is configured correctly.
     *
     * A demonstration deployment is not a misconfigured production one, and conflating the two is
     * what made the previous version of this check unhelpful: it went red on staging for carrying
     * the demo identity, which was the whole intent of staging. The identity question is now
     * answered by `demo_deployment`, and `deployment_mode` below answers only the hardening one.
     */
    checks.push({
      name: "demo_deployment",
      ok: true,
      detail: demo
        ? `DEMONSTRATION deployment — the billing identity is the demo one (${fields.join(", ") || "unset"}), ` +
          `and EDI_ADAPTER=${getConfig().ediAdapter}${getConfig().ediAdapter === "mock" ? "" : getConfig().stediTestMode ? " in test mode" : ""} ` +
          `reaches no payer. Nothing filed from here can be honoured, which is why no real identity ` +
          `is required and why every figure on every screen is labelled DEMO DATA.`
        : `LIVE deployment — a real billing identity is configured and claims filed from here ` +
          `${reaches ? "reach real payers" : "would reach real payers once a live clearinghouse is configured"}.`,
    });

    /**
     * ── A HOSTED DEPLOYMENT THAT IS NOT IN PRODUCTION MODE IS ALWAYS WRONG ─────────────────────
     *
     * The first version of this check went red only when a REAL billing NPI was configured without
     * NODE_ENV, on the reasoning that a demo deployment filing mock claims under the demo identity
     * is coherent. On a laptop that is still true. On a PUBLIC URL it is not: a hosted demo
     * deployment with no NODE_ENV would show a green check while issuing its session cookie
     * without `Secure`, recording one IP for every actor, and returning live password-reset
     * tokens to anonymous callers.
     *
     * The defaults for the first three are fixed now (see `Config.hosted`), and this stays red
     * anyway, because they are mitigations and not the fix: HSTS is still not sent, the demo billing
     * identity is still accepted, and the practice timezone is still unasserted. Only NODE_ENV turns
     * those on, and only a person with access to the platform can set it — so the check's job is to
     * keep saying so until they do.
     */
    checks.push({
      name: "deployment_mode",
      ok: prod || !hosted,
      detail: prod
        ? "NODE_ENV=production — secure cookies, HSTS, the proxy declaration and the real-identity " +
          "refusal are all in force"
        : hosted
          ? `NODE_ENV=${getConfig().nodeEnv} on a HOSTED deployment. Secure cookies, HSTS and ` +
            `withholding password-reset tokens are all in force because the platform is detectable, ` +
            `but the demo billing identity is still accepted and the practice timezone is still ` +
            `unasserted. Both of those are boot REFUSALS rather than defaults — deriving them from ` +
            `detection would take a running deployment down over a missing NPI — so they need ` +
            `NODE_ENV=production, which only the platform's own settings can provide.` +
            (placeholder
              ? ` The billing identity is still the demonstration one (${fields.join(", ")}), so ` +
                `nothing here can file a claim a payer would honour.`
              : ` The billing identity is a REAL one, so claims from here carry a practice's own NPI ` +
                `with the production guards off. Set NODE_ENV=production before filing anything.`)
          : placeholder
            ? `NODE_ENV=${getConfig().nodeEnv}, not hosted, and the billing identity is still the ` +
              `demonstration one (${fields.join(", ")}). Coherent: this is a developer's machine.`
            : `NODE_ENV=${getConfig().nodeEnv}, but the billing identity is a REAL one. Claims filed ` +
              `from this deployment carry a practice's own NPI while the production guards are off: ` +
              `the session cookie has no Secure flag unless SECURE_COOKIES=1, no HSTS is sent, and ` +
              `the client IP the audit trail records is whatever a proxy claims. Set NODE_ENV=production.`,
    });

    checks.push({
      name: "phi_encryption",
      ok: phiEncryptionEnabled() || getConfig().nodeEnv !== "production",
      detail: phiEncryptionEnabled()
        ? "PHI_ENCRYPTION_KEY configured — raw cards, 835s and 837s are encrypted at rest"
        : "no key configured; raw payloads are stored in the clear (acceptable outside production only)",
    });

    /**
     * ── A CREDENTIAL SITTING IN THE CLEAR IS A READINESS FAILURE (NEW-11) ──────────────────────
     *
     * `era_sources.credential` is a clearinghouse API key. The repository encrypts it; hand-written
     * SQL — the only registration path there was — does not. A row without the `v1:` envelope is a
     * live credential stored in plaintext, in every backup of that database, and nothing anywhere
     * said so.
     *
     * A hard FAILURE rather than a warning, and only when a plaintext row actually exists. It is
     * one row and one re-registration to fix, the fix is entirely within the operator's control,
     * and the alternative — a warning on a screen — is how it stayed unnoticed. An empty credential
     * is NOT flagged: there is nothing to protect, and firing on an unconfigured source would train
     * people to dismiss the check.
     */
    const eraSources = await services.eraSources.list().catch(() => []);
    const plaintext = eraSources.filter((s) => !s.credentialEncrypted);
    if (eraSources.length > 0) {
      checks.push({
        name: "era_credentials_encrypted",
        ok: plaintext.length === 0,
        detail:
          plaintext.length === 0
            ? `${eraSources.length} ERA source${eraSources.length === 1 ? "" : "s"} registered; every ` +
              `credential is encrypted at rest`
            : `${plaintext.length} ERA credential${plaintext.length === 1 ? " is" : "s are"} stored in ` +
              `PLAINTEXT (${plaintext.map((s) => s.vendor).join(", ")}). Re-register the source — ` +
              `POST /api/v1/ops/era-sources — which stores it through the encrypting repository. ` +
              `Rotate the key at the clearinghouse too: it has been readable in every backup taken ` +
              `since it was written.`,
      });
    }

    /**
     * ── THE SECRET INVENTORY, ON THE READINESS ENDPOINT (NEW-09) ───────────────────────────────
     *
     * `secretInventory()` existed and nothing called it, which made it a list somebody would have
     * had to maintain by hand — the exact failure it was written to prevent, and the reason the
     * inventory named `EDI_API_KEY` (read by nothing) while omitting `STEDI_API_KEY` (the credential
     * PHI leaves the system under).
     *
     * Reported here because it answers the question an operator and a compliance reviewer both ask:
     * "is everything this deployment needs actually present?" Names and PRESENCE only — never a
     * value, never a fragment, never a length. A readiness endpoint that leaked a credential
     * prefix would be a worse problem than the one it reports on.
     *
     * A missing secret does NOT fail readiness. Several are legitimately absent: DATABASE_ADMIN_URL
     * is for migrations, APP_DB_PASSWORD for provisioning, and a deployment with no LLM has no
     * business having an LLM key. Readiness is about whether this process can serve a request, and
     * the checks above already answer that; the inventory is context, and dressing it up as a
     * failure would train operators to ignore a red readiness page.
     */
    const secrets = secretInventory();

    const ready = checks.every((c) => c.ok);
    sendJson(res, ready ? 200 : 503, {
      ready,
      checks,
      persistent: services.persistent,
      secrets,
    });
    return;
  }

  /**
   * The shared brain, read-only over HTTP. Rules are learned from recorded outcomes and are never
   * edited by hand — a hand-set overturn rate is a number nobody can account for.
   */
  if (path === "/api/v1/payer-profile/playbook" && method === "GET") {
    const payerParam = url.searchParams.get("payerId");
    const rules = await services.payerProfile.listRules(
      payerParam === null ? undefined : payerParam || null
    );
    sendJson(res, 200, {
      rules: rules.sort(
        (a, b) => a.carcCode.localeCompare(b.carcCode) || (a.payerId ?? "").localeCompare(b.payerId ?? "")
      ),
      learned: rules.filter((r) => r.sampleSize > 0).length,
      trusted: rules.filter((r) => r.trusted).length,
    });
    return;
  }

  /**
   * ── THE PAYER CATALOG, READABLE AND WRITABLE (NEW-08) ────────────────────────────────────────
   *
   * The seven payers this system could verify were a hardcoded array in
   * `modules/verification/src/engine/payer.ts`, whose own comment called itself a mock. A practice
   * whose card said "Ameritas" could not verify that patient, could not file that claim, and could
   * not be helped by anyone without a code change, a review and a deploy.
   *
   * `warnings` is returned with the list rather than left for the client to derive: a payer with no
   * aliases cannot be matched to a card and a payer with no clearinghouse id cannot be routed, and
   * both are silent failures that look like "the payer is set up" on a screen that only lists rows.
   */
  if (path === "/api/v1/payer-profile/payers" && method === "GET") {
    sendJson(res, 200, {
      payers: await services.payerProfile.connectors(),
      warnings: await services.payerProfile.catalogWarnings(),
      clearinghouse: CLEARINGHOUSE_NAME,
    });
    return;
  }

  if (path === "/api/v1/payer-profile/payers" && method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const saved = await services.payerProfile.savePayer({
      slug: requireString(body, "slug"),
      name: requireString(body, "name"),
      ...(body.clearinghouseId != null ? { clearinghouseId: asString(body.clearinghouseId) } : {}),
      ...(body.filingWindowDays != null ? { filingWindowDays: positiveDays(body.filingWindowDays, "filingWindowDays") } : {}),
      ...(body.appealWindowDays != null ? { appealWindowDays: positiveDays(body.appealWindowDays, "appealWindowDays") } : {}),
      ...(body.aliases != null ? { aliases: parseAliases(body.aliases) } : {}),
    });

    /**
     * The saved row is echoed back rather than the input, and that is the point of the response: an
     * alias whose text another payer already claims is DROPPED by the database's uniqueness rule,
     * and an administrator who was shown their own input would believe a routing change took effect
     * that did not. `warnings` says which payers still cannot match or route.
     *
     * In the SAME shape the list route returns, deliberately. A create that answered in the storage
     * vocabulary (`slug`) while the list answered in the routing one (`payerId`) would make a client
     * hold two mappings for one thing, and the two would drift.
     */
    sendJson(res, 200, {
      payer: {
        payerId: saved.slug,
        payerName: saved.name,
        ...(saved.clearinghouseId ? { clearinghouseId: saved.clearinghouseId } : {}),
        aliases: saved.aliases ?? [],
        filingWindowDays: saved.filingWindowDays,
        appealWindowDays: saved.appealWindowDays,
      },
      warnings: await services.payerProfile.catalogWarnings(),
    });
    return;
  }

  throw new ApiError(404, "not_found", `No API route: ${method} ${path}`);
}

/**
 * A filing or appeal window, in days.
 *
 * Validated rather than coerced: a window that silently became `NaN` would put a claim's deadline
 * beyond every check that compares against it, and the claim would sit past its filing window with
 * nothing raising a hand.
 */
function positiveDays(raw: unknown, field: string): number {
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    throw new ApiError(400, "validation_error", `\`${field}\` must be a whole number of days between 1 and 3650.`);
  }
  return days;
}

/**
 * The spellings a card may use for a payer.
 *
 * `word` bounds an alias to whole words, which is what a short or ambiguous one needs: three
 * letters that appear inside ordinary words would otherwise capture cards belonging to another
 * payer, and sending an eligibility request to a company that has never heard of the patient
 * surfaces as "not covered" — an answer, not a mistake.
 */
function parseAliases(raw: unknown): { alias: string; kind?: "contains" | "word" }[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "validation_error", "`aliases` must be an array.");
  }
  return raw.map((entry, i) => {
    const item = (typeof entry === "string" ? { alias: entry } : entry) as Record<string, unknown>;
    const alias = asString(item.alias).trim();
    if (!alias) throw new ApiError(400, "validation_error", `aliases[${i}].alias must not be empty.`);
    const kind = item.kind == null ? undefined : asString(item.kind).trim().toLowerCase();
    if (kind !== undefined && kind !== "contains" && kind !== "word") {
      throw new ApiError(400, "validation_error", `aliases[${i}].kind must be "contains" or "word".`);
    }
    return { alias, ...(kind ? { kind } : {}) };
  });
}

/**
 * An event, minus its payload.
 *
 * The payload is PHI — patient names, procedures, money. An operations screen needs to know that an
 * event is stuck and why, never what it says about a patient, and a console that leaks a payload
 * into a screenshot is a breach with extra steps.
 */
/**
 * Shape the watchdog's readings for a screen.
 *
 * `firing` is what an operator needs to see first, so it is separated rather than left for the
 * client to filter — a client that forgets the filter renders "all clear" over a firing check, and
 * the whole point of this route is that a silent failure stops being silent.
 *
 * `detail` carries the money figures the notifications already compute (held cents, drift, counts).
 * It is operational arithmetic about a single practice, never PHI — no patient, procedure or payer
 * name reaches it, for the same reason `summariseEvent` below drops event payloads.
 */
function monitorPayload(readings: MonitorReading[]) {
  const firing = readings.filter((r) => r.breaching);
  return {
    healthy: firing.length === 0,
    firing: firing.map((r) => ({ key: r.key, message: r.message, detail: r.detail })),
    checks: readings.map((r) => ({ key: r.key, ok: !r.breaching, message: r.message, detail: r.detail })),
  };
}

function summariseEvent(event: {
  id: string;
  type: string;
  aggregateId: string;
  occurredAt: string;
  attempts: number;
  publishedAt: string | null;
  lastError: string | null;
  deadLettered: boolean;
}) {
  return {
    id: event.id,
    type: event.type,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    attempts: event.attempts,
    publishedAt: event.publishedAt,
    lastError: event.lastError,
    deadLettered: event.deadLettered,
    status: event.deadLettered ? "dead" : event.publishedAt ? "delivered" : "pending",
  };
}

/**
 * Map a thrown domain error onto the blueprint's HTTP envelope. The distinctions are the ones the
 * modules were careful to make: a refused gate is a 409 (the caller must change something), while a
 * clearinghouse failure is a 502 (nothing was wrong with the request — try again).
 */
function sendDomainError(res: ResponseSink, err: unknown, traceId?: string): void {
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message);
  } else if (err instanceof AuthError) {
    // 401 unauthenticated / 403 csrf / 403 forbidden — each already carries its own status and
    // machine code. Falling through to 500 here would tell a client to retry a request that will
    // never succeed until they log in.
    sendError(res, err.status, err.code, err.message);
  } else if (err instanceof CoordinationRefusedError) {
    /*
     * A coverage or secondary-claim action the case's state or its evidence forbids. Missing
     * evidence is the caller's to supply (400) and the message lists every item at once; a state
     * conflict — already confirmed, nothing to file yet — is a 409. Neither is ever a 5xx.
     */
    const incomplete = err.code.endsWith("-missing") || err.code.endsWith("-incomplete") || err.code === "validation_error";
    sendJson(res, incomplete ? 400 : 409, { error: { code: err.code, message: err.message, missing: err.missing } });
  } else if (
    err instanceof VerificationNotFoundError ||
    err instanceof ClaimNotFoundError ||
    err instanceof CoordinationCaseNotFoundError ||
    err instanceof RemittanceNotFoundError ||
    err instanceof DenialNotFoundError ||
    err instanceof PatientAccountNotFoundError
  ) {
    sendError(res, 404, "not_found", err.message);
  } else if (err instanceof LedgerActionError) {
    // A refused ledger movement — no reason given, more than the balance, no actor. The caller must
    // change something, so a retry will never help. 409, never 500.
    sendError(res, 409, "ledger_action_refused", err.message);
  } else if (err instanceof ContractualDenialNotBillableError) {
    /**
     * 409 with the payer's own group and code in the message (NEW-07). A retry cannot help — the
     * caller has to write it off, appeal it, or find somebody who holds the override — so the
     * message names all three, and names the adjustment the refusal is about.
     */
    sendError(res, 409, "not_patient_responsibility", err.message);
  } else if (err instanceof DenialActionError) {
    // The denial is not in a state that permits this step — the caller must change something, so a
    // retry will never help. 409, never 500.
    sendError(res, 409, "denial_action_refused", err.message);
  } else if (err instanceof ClaimNotSubmittableError) {
    sendError(res, 409, "not_submittable", err.message);
  } else if (err instanceof InvalidClaimTransitionError) {
    sendError(res, 409, "invalid_transition", err.message);
  } else if (err instanceof ClaimSubmissionFailedError) {
    sendError(res, 502, err.retryable ? "clearinghouse_unavailable" : "clearinghouse_error", err.message);
  } else if (err instanceof RemittanceUnavailableError) {
    // A validation refusal is the caller's to fix (400); an unreadable or unreachable remittance is
    // upstream (502). Collapsing them would tell a user to retry something only they can correct.
    if (err.code === "validation_error" || err.code === "unbalanced") {
      sendError(res, 409, err.code, err.message);
    } else if (REMITTANCE_DECISION_REFUSALS.has(err.code)) {
      /*
       * A release or reject the remittance's own state forbids — a duplicate of money already on
       * the books, a test file, an advice already decided. Nothing upstream failed and retrying
       * cannot help; the message names the action that can. These fell through to 502
       * "clearinghouse_error", which sent an operator to check a clearinghouse that was never
       * involved.
       */
      sendError(res, 409, err.code, err.message);
    } else if (err.code === "multiple_payments") {
      /*
       * Not an error the practice caused, and not a file to fix: it is a question. The uploader
       * believed this was one payment and it is several, and the endpoint takes `?multiple=1` from
       * whoever confirms they meant it. 409 rather than 400 because nothing about the request is
       * malformed — it conflicts with an assumption the caller made, which is what 409 is for.
       */
      sendError(res, 409, err.code, err.message);
    } else if (err.code === "parse_error" || err.code === "empty_advice") {
      /*
       * `empty_advice` is the caller's file, not the payer's system. It fell through to the 502
       * branch when the gate was added, which told an operator the clearinghouse had failed and
       * invited a retry that can never succeed — the file is truncated and retrying sends the same
       * bytes. Same category as an unreadable file: 400, and the message says what to do.
       */
      sendError(res, 400, err.code, err.message);
    } else {
      sendError(res, 502, err.retryable ? "clearinghouse_unavailable" : "clearinghouse_error", err.message);
    }
  } else {
    /**
     * ── AN UNEXPECTED ERROR'S MESSAGE IS NOT THE CLIENT'S TO READ ────────────────────────────────
     *
     * This sent `err.message` straight to the caller. Every branch above returns a message written
     * DELIBERATELY for whoever made the request — a scrub refusal, a filing block, a payer's own
     * wording — and those are exactly right. This branch is the opposite: it is reached only when
     * nothing anticipated the failure, so nobody has decided what the message says.
     *
     * What ends up there is whatever threw: a Postgres constraint name, a driver's description of
     * the schema, a JSON parse error quoting the fragment it choked on. And it is reachable
     * UNAUTHENTICATED — `dispatch` runs public routes through `handleApi` with a null session, so a
     * failure on the login or password-reset path answered a stranger with the internals.
     *
     * That contradicts the care taken a few functions away, where password reset is written so it
     * "never reveals whether an address is on file". A 500 that volunteers a table name gives up
     * more than that endpoint withholds.
     *
     * The real error is logged with the trace id the request already carries for its audit row, so
     * nothing is lost to whoever has to diagnose it — and the caller gets that id, which is the one
     * thing that actually helps them: it is what support asks for.
     */
    const reference = traceId ?? randomUUID();
    logger.error("unhandled request failure", {
      channel: "error",
      traceId: reference,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    sendError(
      res,
      500,
      "internal_error",
      `Something went wrong handling this request. Quote reference ${reference} if you report it.`
    );
  }
}

/**
 * The actor for a human gate.
 *
 * Under Postgres there is a real session, and the authenticated user's name IS the actor — a
 * client-supplied string is ignored outright, because an audit trail an attacker can write is worse
 * than none. Without a database there is no session, so the demo falls back to the request body;
 * that fallback is why `persistent` is reported on `/api/v1/auth/session`.
 */
function actorName(session: ResolvedSession | null, body: unknown, field: string): string {
  if (session) return session.user.email;
  return requireString(body, field);
}

// ── Auth routes ──────────────────────────────────────────────────────────────────────
/**
 * The body of a completed sign-in, whichever way it completed — password alone, a code, or an
 * enrolment finished at the sign-in step. One shape, so the client has one thing to handle.
 */
function signedInBody(result: Omit<LoginResult, "mfa">) {
  return {
    mfa: null,
    csrf: result.csrf,
    user: {
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      permissions: PERMISSIONS[result.user.role],
    },
    idleTimeoutMs: getConfig().sessionIdleMinutes * 60_000,
  };
}

/**
 * Routes a session still owed its second factor may reach (0038) — the MFA step, and signing out.
 * Everything else refuses it in `authorizeRequest`, before CSRF and before RBAC.
 */
const MFA_STEP_ROUTES = new Set([
  "/api/v1/auth/mfa/verify",
  "/api/v1/auth/mfa/setup",
  "/api/v1/auth/mfa/enable",
  "/api/v1/auth/logout",
]);

async function handleAuthApi(
  req: IncomingMessage,
  res: ResponseSink,
  services: Services,
  method: string,
  path: string,
  session: ResolvedSession | null
): Promise<boolean> {
  if (path === "/api/v1/auth/session" && method === "GET") {
    sendJson(res, 200, {
      authenticated: session !== null,
      // The UI needs to know whether it is talking to a durable, login-gated deployment or the
      // DB-free demo, because the two have genuinely different guarantees.
      persistent: services.persistent,
      user: session
        ? {
            email: session.user.email,
            name: session.user.name,
            role: session.user.role,
            /**
             * What this person may actually do, sent to the client so the NAVIGATION can be built
             * from it (NEW-33).
             *
             * The client had no idea what a role meant: it rendered all nine tabs for everyone and
             * printed the role name in the corner. A dentist — who holds neither `queue.read` nor
             * `remittances.read` nor `patients.read` — landed on Today, the default tab, and was
             * shown "role dentist lacks queue.read", then found five of the nine tabs failing the
             * same way. The permissions were enforced correctly and communicated atrociously.
             *
             * Sent rather than duplicated in JavaScript because `PERMISSIONS` is the server's
             * authority on this and a second copy in the client would drift from it — and drift
             * here means either a tab that 403s or a tab hidden from someone entitled to it.
             */
            permissions: PERMISSIONS[session.user.role],
            // Two-step sign-in (0038): whether this person has it, and whether it is optional here.
            mfa: { enabled: await mfaEnabledFor(session), required: getConfig().mfaRequired },
          }
        : null,
      csrf: session?.csrf ?? null,
      // The automatic-logoff window, so the browser can clear the screen on its own clock — it
      // must not wait for a request it may never make (polling stops while a drill panel is open).
      idleTimeoutMs: getConfig().sessionIdleMinutes * 60_000,
    });
    return true;
  }

  if (path === "/api/v1/auth/login" && method === "POST") {
    /**
     * The one endpoint an unauthenticated stranger may call freely, and every call is a guess at a
     * password protecting PHI (blueprint doc 08). Throttled per IP BEFORE the password is checked —
     * `scrypt` at N=16384 is deliberately expensive, so verifying first would make the flood a
     * denial of service against the practice as well as a guessing attack.
     */
    const ip = clientIp(req) ?? "unknown";
    const decision = authRateLimiter.take(ip);
    if (!decision.allowed) {
      logger.warn("Login rate limit exceeded.", { channel: "security", ip, retryAfterSeconds: decision.retryAfterSeconds });
      res.setHeader("retry-after", String(decision.retryAfterSeconds));
      sendJson(res, 429, {
        error: {
          code: "rate_limited",
          // Deliberately says nothing about whether the account exists, or how many attempts
          // remain — a throttle that reports its own state is a throttle you can calibrate against.
          message: "Too many sign-in attempts. Please wait a moment and try again.",
        },
      });
      return true;
    }

    const body = await readJsonBody(req);
    const result = await login(requireString(body, "email"), requireString(body, "password"), clientIp(req));

    // Succeeding gives the allowance back: the limit exists to slow guessing, and someone who just
    // proved they know the password is not guessing. Without this, a receptionist who mistyped four
    // times stays throttled after getting it right.
    authRateLimiter.reset(ip);

    setSessionCookie(res, result.token, result.expiresAt);
    /**
     * The password was right and a second factor is owed (0038). The cookie carries a PENDING
     * session the guard confines to the MFA step; nothing about the account or its permissions is
     * sent until the factor is given, because the person is not signed in yet.
     */
    if (result.mfa) {
      sendJson(res, 200, { mfa: result.mfa, csrf: result.csrf });
      return true;
    }
    // The CSRF token is returned in the BODY, not a cookie: the browser attaches cookies
    // automatically to cross-site requests but cannot read this value, which is what makes echoing
    // it back in a header proof of same-origin.
    sendJson(res, 200, {
      mfa: null,
      csrf: result.csrf,
      user: {
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        permissions: PERMISSIONS[result.user.role],
      },
      idleTimeoutMs: getConfig().sessionIdleMinutes * 60_000,
    });
    return true;
  }

  /**
   * ── THE SECOND FACTOR (0038) ───────────────────────────────────────────────────────────────
   * Reachable by a PENDING session (the guard's `allowMfaPending`, see MFA_STEP_ROUTES) as well as a
   * signed-in one. Verifying spends the same per-IP allowance as the password, because a code is
   * also a guess; the service counts wrong codes against the session and ends it at the fifth.
   */
  if (path === "/api/v1/auth/mfa/verify" && method === "POST") {
    if (!session) throw new ApiError(401, "unauthenticated", "login required");
    const ip = clientIp(req) ?? "unknown";
    const decision = authRateLimiter.take(ip);
    if (!decision.allowed) {
      res.setHeader("retry-after", String(decision.retryAfterSeconds));
      sendJson(res, 429, { error: { code: "rate_limited", message: "Too many attempts. Please wait a moment and try again." } });
      return true;
    }
    const body = await readJsonBody(req);
    const result = await verifyMfa(session, requireString(body, "code"), clientIp(req));
    authRateLimiter.reset(ip);
    setSessionCookie(res, result.token, result.expiresAt);
    sendJson(res, 200, signedInBody(result));
    return true;
  }

  if (path === "/api/v1/auth/mfa/setup" && method === "POST") {
    if (!session) throw new ApiError(401, "unauthenticated", "login required");
    // The secret is shown to the person enrolling, once, to type or import into their app.
    sendJson(res, 200, await beginMfaEnrollment(session));
    return true;
  }

  if (path === "/api/v1/auth/mfa/enable" && method === "POST") {
    if (!session) throw new ApiError(401, "unauthenticated", "login required");
    const body = await readJsonBody(req);
    const done = await completeMfaEnrollment(session, requireString(body, "code"), clientIp(req));
    if (done.signedIn) setSessionCookie(res, done.signedIn.token, done.signedIn.expiresAt);
    sendJson(res, 200, {
      // Shown once. Only their hashes are kept, so a person who does not write them down loses them.
      recoveryCodes: done.recoveryCodes,
      ...(done.signedIn ? signedInBody(done.signedIn) : {}),
    });
    return true;
  }

  if (path === "/api/v1/auth/mfa/disable" && method === "POST") {
    if (!session) throw new ApiError(401, "unauthenticated", "login required");
    const body = await readJsonBody(req);
    await disableMfa(session, requireString(body, "password"), requireString(body, "code"), clientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/v1/auth/logout" && method === "POST") {
    // The IP travels so the sign-out row can be correlated with the sign-in that opened the
    // session — a session ended from a different address is the interesting case (NEW-05).
    await logout(readCookie(req.headers.cookie, SESSION_COOKIE), clientIp(req));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  /**
   * ── PASSWORD RESET ─────────────────────────────────────────────────────────────────────────
   *
   * `requestPasswordReset` and `confirmPasswordReset` have existed and been tested since P1, and
   * nothing reached them: no route, no link, no screen. A staff member locked out of a practice's
   * PHI had no way back in short of an engineer with a psql session — while `ensureSeeded` told
   * production operators to "use the reset flow to log in", of a flow that was not reachable.
   *
   * ── THE DELIVERY PROBLEM, STATED RATHER THAN FAKED ─────────────────────────────────────────
   * A reset token has to reach the person who asked for it, and that needs an email provider this
   * deployment does not have and cannot have until the hosting decision and its BAA are made (the
   * M13 gate). There is no honest way to close that here, so it is not closed:
   *
   *   • Outside production the token is RETURNED in the response, so the flow works end to end on a
   *     laptop and in tests, and the reset screen shows it.
   *   • In production it is NOT returned and NOT logged — a credential in a log file is a credential
   *     — and the response says plainly that delivery is not configured. The token is written to the
   *     user's row regardless, so the moment a mail provider is wired the flow is complete without
   *     another change to this endpoint.
   *
   * Both paths return 202 with the same shape whether or not the email exists. Reset is otherwise a
   * free account-enumeration oracle against a system holding PHI.
   *
   * Rate-limited on the same per-IP bucket as login, and deliberately the SAME bucket rather than a
   * second one: an attacker who can exhaust one and move to the other has been slowed by nothing.
   */
  if (path === "/api/v1/auth/password-reset" && method === "POST") {
    // The DB-free demo has no accounts to reset — it has no login at all. Saying so is better than
    // a 500 from a repository that has no database to reach.
    if (!services.persistent) {
      sendJson(res, 409, {
        error: {
          code: "no_accounts",
          message: "This deployment runs without a database and has no sign-in, so there is nothing to reset.",
        },
      });
      return true;
    }

    const ip = clientIp(req) ?? "unknown";
    const decision = authRateLimiter.take(ip);
    if (!decision.allowed) {
      logger.warn("Password-reset rate limit exceeded.", { channel: "security", ip });
      res.setHeader("retry-after", String(decision.retryAfterSeconds));
      sendJson(res, 429, {
        error: { code: "rate_limited", message: "Too many attempts. Please wait a moment and try again." },
      });
      return true;
    }

    const body = await readJsonBody(req);
    const { token } = await requestPasswordReset(requireString(body, "email"), clientIp(req));

    /**
     * ── WHO MAY BE HANDED A WORKING RESET TOKEN, AND WHY THE OLD ANSWER WAS WRONG ───────────────
     *
     * This branched on `nodeEnv === "production"` alone, so a deployment with no NODE_ENV returned a
     * live, single-use password-reset token for any address a caller named — from a PUBLIC route,
     * with no session, over the open internet. Anyone who could reach such a deployment could take
     * over any seeded account.
     *
     * The intent behind returning it was sound and is kept: the laptop demo has no mail provider, so
     * the token has to come back in the response or the flow cannot be shown at all. But that is a
     * statement about a laptop, not about production — and "not production" is not the same as "not
     * reachable by strangers". The condition is now the fact rather than the intent: a process that
     * a hosting platform is running does not hand out credentials, whatever NODE_ENV says.
     *
     * The operator path is unchanged and documented: `npm run auth:issue-reset -- <email>` mints the
     * same token through the same function, printed to stdout on the machine and nowhere else.
     */
    const config = getConfig();
    const withhold = config.isProd || config.hosted;

    sendJson(res, 202, {
      // Identical whether the address is on file or not.
      message: "If that email is registered, a reset has been prepared for it.",
      // Only on a machine no stranger can reach, and only when the account actually exists.
      token: withhold ? null : token,
      delivery: withhold ? "unconfigured" : "in-response",
      note: withhold
        ? "No email provider is configured for this deployment, so the token cannot be delivered. " +
          "An administrator must issue the reset directly until one is wired — see the M13 gate."
        : "This deployment is not hosted, so the token is returned here for the demo flow.",
    });
    return true;
  }

  if (path === "/api/v1/auth/password-reset/confirm" && method === "POST") {
    if (!services.persistent) {
      sendJson(res, 409, {
        error: {
          code: "no_accounts",
          message: "This deployment runs without a database and has no sign-in, so there is nothing to reset.",
        },
      });
      return true;
    }

    const ip = clientIp(req) ?? "unknown";
    const decision = authRateLimiter.take(ip);
    if (!decision.allowed) {
      res.setHeader("retry-after", String(decision.retryAfterSeconds));
      sendJson(res, 429, {
        error: { code: "rate_limited", message: "Too many attempts. Please wait a moment and try again." },
      });
      return true;
    }

    const body = await readJsonBody(req);
    // Throws AuthError(400 invalid_token / 422 weak_password), mapped by the caller's handler. A
    // successful reset revokes every session issued under the old credential.
    await confirmPasswordReset(
      requireString(body, "email"),
      requireString(body, "token"),
      requireString(body, "password"),
      clientIp(req)
    );
    authRateLimiter.reset(ip);
    sendJson(res, 200, { ok: true, message: "Password changed. Every existing session has been signed out." });
    return true;
  }

  return false;
}

/** Refusal codes from `RemittanceService.release`/`reject` — decisions, never upstream failures. */
const REMITTANCE_DECISION_REFUSALS = new Set([
  "coverage-unconfirmed",
  "rejected",
  "already-posted",
  "missing-trace-number",
  "duplicate-adjudication",
  "duplicate-advice",
  "test-interchange",
]);

/**
 * What a handler wants recorded in its request's audit row, beyond who / what / when.
 *
 * ── WHY A SIDE CHANNEL, AND NOT A SECOND ROW ───────────────────────────────────────────────────
 * The request auditor writes exactly one append-only row per mutating request, in the request's own
 * transaction — so the row commits or rolls back with the change it describes. A few decisions are
 * worthless in that row without their REASON: "remittance X was rejected" is not an audit record
 * of a money decision until it says as what, and why. Writing a second row from the handler would
 * record one act twice, and an auditor counting decisions would count two.
 *
 * Keyed on the request object, so it cannot leak between requests and is collected with the
 * request. Only handlers that make a human money decision set it.
 */
const auditDetail = new WeakMap<IncomingMessage, Record<string, unknown>>();

/**
 * Practices with a "Verify all due" run executing right now. A second click — a double click, a
 * second tab — is refused with 409 rather than queued, because the first run is already sending
 * those patients' checks and a second would pay for each of them again.
 *
 * In-process, and that is the stated limit: it guards one server process, which is what every
 * deployment of this runs today. Two instances behind a balancer could each run once; each would
 * still re-derive what is due and skip a patient checked in the last `RECHECK_COOLDOWN_MS`, which
 * bounds the damage to a patient caught mid-flight by both.
 */
const verifyRunsInFlight = new Set<string>();

/**
 * Write the audit row for one API request (M10).
 *
 * GETs are deliberately NOT audited. Auditing every read would bury the ~2% of rows that record a
 * change under the 98% that record someone looking at a screen, and the log's whole purpose is to
 * answer "who changed this, and when". PHI *access* logging is a separate, coarser control and a
 * separate decision.
 *
 * `resource` is the path with ids stripped, so the log can be grouped by what was done rather than
 * fragmenting into one bucket per record; the id goes in `resource_id` where it belongs.
 */
async function auditRequest(
  traceId: string,
  session: ResolvedSession,
  method: string,
  path: string,
  outcome: "success" | "error",
  ip: string | null,
  error?: unknown,
  detail?: Record<string, unknown>
): Promise<void> {
  if (method === "GET") return;

  const parts = path.replace(/^\/api\/v1\//, "").split("/");
  const resource = parts[0] ?? "unknown";
  // /claims/<id>/submit → resource "claims", id "<id>", action "submit".
  const resourceId = parts.length > 1 ? decodeURIComponent(parts[1]!) : null;
  const action = parts.length > 2 ? parts[2]! : method.toLowerCase();

  await recordAudit(requireContext().tx, {
    practiceId: session.user.practiceId,
    traceId,
    actorId: session.user.id,
    actorRole: session.user.role,
    action,
    resource,
    resourceId,
    outcome,
    ip,
    ...(error !== undefined || detail !== undefined
      ? {
          after: {
            ...(detail ?? {}),
            ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
          },
        }
      : {}),
  });
}

/**
 * Reads that carry no patient data: reference tables and the payer catalog. Everything else an
 * authenticated person can GET is treated as patient-bearing — a list of claims is a list of names —
 * so the default is to record, and a route has to be named here to be left out.
 */
const READS_WITHOUT_PHI: readonly RegExp[] = [/^\/api\/v1\/reference(\/|$)/, /^\/api\/v1\/payer-profile(\/|$)/];

/** A screen untouched this long is refreshing for nobody; its polls are not a person viewing data. */
const BACKGROUND_AFTER_MS = 2 * 60_000;

/**
 * Record one read of patient-bearing data (migration 0037, 45 CFR 164.312(b)).
 *
 * `audit_events` records changes and deliberately skips GETs; this is the coarser, separate control
 * that comment pointed at. One row per read by a person at the screen: a poll from a browser that has
 * reported two minutes without input is skipped (0036 supplies that report), and the query string is
 * never recorded because a search term is itself PHI. `resource`/`resourceId` follow
 * `auditRequest`'s reading of the path, so the two trails can be joined on the same keys.
 */
async function recordRead(
  traceId: string,
  session: ResolvedSession,
  path: string,
  ip: string | null,
  reportedIdle: number | null
): Promise<void> {
  if (READS_WITHOUT_PHI.some((re) => re.test(path))) return;
  if (reportedIdle !== null && reportedIdle >= BACKGROUND_AFTER_MS) return;
  const parts = path.replace(/^\/api\/v1\//, "").split("/");
  await recordPhiAccess(requireContext().tx, {
    practiceId: session.user.practiceId,
    traceId,
    actorId: session.user.id,
    actorRole: session.user.role,
    resource: parts[0] ?? "unknown",
    resourceId: parts.length > 1 ? decodeURIComponent(parts[1]!) : null,
    route: path,
    ip,
  });
}

/**
 * Routes that wait on a third party, and therefore must not hold a transaction while they do.
 *
 * ── WHY THIS IS A LIST AND NOT A FLAG ON THE HANDLER (NEW-10) ────────────────────────────────────
 * Deliberately small, explicit and here, next to the dispatcher that acts on it. Every entry gives
 * up per-request atomicity between the business write and its audit row, which is a real cost — so
 * adding one should be a visible decision in the file that makes it, not a property somebody sets
 * on a handler three directories away.
 *
 * The bar for membership: the route makes a network call to somebody else's server, on the request
 * path, with a timeout measured in seconds.
 */
const SELF_TRANSACTING: { test: RegExp; methods: string[] }[] = [
  // Sends the 837 to the clearinghouse. `stediTimeoutMs` defaults to 30 seconds.
  { test: /^\/api\/v1\/claims\/[^/]+\/submit$/, methods: ["POST"] },
  // "Verify all due": up to MAX_PATIENTS_PER_RUN eligibility requests in a row. Each check commits
  // in its own short transaction, so one payer's timeout neither holds the pool nor undoes the rest.
  { test: /^\/api\/v1\/appointments\/verify$/, methods: ["POST"] },
];

const isSelfTransacting = (method: string, path: string): boolean =>
  SELF_TRANSACTING.some((r) => r.methods.includes(method) && r.test.test(path));

/**
 * Resolve the session and authorize the request, then run the handler inside ONE transaction
 * scoped to that session's practice.
 *
 * The ordering matters: authenticate → authorize → open the tenant transaction. Opening the
 * transaction first would mean an unauthenticated request had already picked a tenant.
 */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
  url: URL
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;

  // Without a database there are no sessions to resolve; the demo runs single-practice and open,
  // and the in-memory outbox dispatches on publish, so nothing needs deferring.
  if (!services.persistent) {
    if (await handleAuthApi(req, res, services, method, path, null)) return;
    await handleApi(req, res, services, url, null);
    return;
  }

  const sidToken = readCookie(req.headers.cookie, SESSION_COOKIE);

  if (path.startsWith("/api/v1/webhooks/edi/")) {
    const session = await guard(
      sidToken,
      null,
      { method: "GET", permission: null, csrfExempt: true },
      { reportedIdleMs: reportedIdleMs(req.headers[IDLE_HEADER]) }
    ).catch(() => null);

    // In persistent mode, inbound EDI webhooks must run within an active tenant practice context for RLS
    if (services.persistent) {
      let practiceId: string | null = null;
      try {
        const { rows: eraRows } = await withoutPractice(async (tx) =>
          tx.query("SELECT practice_id FROM era_sources WHERE vendor = 'stedi' AND enabled = true LIMIT 1")
        );
        if (eraRows.length > 0 && (eraRows[0] as { practice_id?: string }).practice_id) {
          practiceId = (eraRows[0] as { practice_id: string }).practice_id;
        }
      } catch {
        // era_sources query fallback
      }

      if (!practiceId) {
        try {
          const { rows: pRows } = await withoutPractice(async (tx) =>
            tx.query("SELECT id FROM practices WHERE status = 'active' ORDER BY created_at ASC LIMIT 1")
          );
          if (pRows.length > 0 && (pRows[0] as { id?: string }).id) {
            practiceId = (pRows[0] as { id: string }).id;
          }
        } catch {
          // practices query fallback
        }
      }

      if (practiceId) {
        await withPractice(practiceId, async () => {
          await handleApi(req, res, services, url, session);
        });
        return;
      }
    }

    await handleApi(req, res, services, url, session);
    return;
  }

  if (PUBLIC_ROUTES.has(path)) {
    // A public route may still carry a session (the UI polls /auth/session) but never requires one.
    const session = await guard(
      sidToken,
      null,
      { method: "GET", permission: null, csrfExempt: true },
      { reportedIdleMs: reportedIdleMs(req.headers[IDLE_HEADER]) }
    ).catch(() => null);
    if (await handleAuthApi(req, res, services, method, path, session)) return;
    await handleApi(req, res, services, url, session);
    return;
  }

  /**
   * DENY BY DEFAULT — a route that never declared what it needs is a route nobody authorized.
   *
   * This used to be a claim rather than a mechanism. `permissionFor` returns null for an unlisted
   * route, and `authorizeRequest` skips the permission check when the permission is null (`if
   * (meta.permission && !can(...))`) — so an undeclared endpoint was served to ANY authenticated
   * user, including `auditor`, whose whole definition is read-only-everywhere. Nothing was exposed,
   * because every route happened to be covered by a prefix rule, but "happened to be" is not a
   * control. Found by the `tests/hitl/` guardrail suite the day it was written.
   *
   * Public routes are already handled above, so anything reaching here must name its permission.
   */
  const policy = permissionFor(method, path);
  if (!policy.declared) {
    throw new AuthError(403, "forbidden", "this route declares no required permission and is refused");
  }

  const session = await guard(
    sidToken,
    (req.headers[CSRF_HEADER] as string | undefined) ?? null,
    { method, permission: policy.permission, allowMfaPending: MFA_STEP_ROUTES.has(path) },
    { reportedIdleMs: reportedIdleMs(req.headers[IDLE_HEADER]) }
  );

  if (await handleAuthApi(req, res, services, method, path, session)) return;

  // Hold the reply until this request's events have been dispatched (see DeferredResponse).
  const deferred = new DeferredResponse();
  const traceId = randomUUID();
  const selfTransacting = isSelfTransacting(method, path);
  try {
    if (selfTransacting) {
      /**
       * ── A ROUTE THAT CALLS A THIRD PARTY OWNS ITS OWN TRANSACTIONS (NEW-10) ─────────────────
       *
       * One transaction per request is right for almost everything here, and wrong for the handful
       * that wait on somebody else's server. Submitting a claim sends an 837 to a clearinghouse
       * with a thirty-second timeout; under the rule below it held one of the pool's ten
       * connections, and a `SELECT … FOR UPDATE` on the claim row, for all of it. Ten concurrent
       * submissions to a slow vendor is the whole pool, and every other request in the process
       * queues behind a network call.
       *
       * So these run inside a practice SCOPE — which carries the tenant and opens nothing — and the
       * handler brackets its vendor call in two short transactions of its own. The audit row is
       * written in its own transaction afterwards for the same reason.
       *
       * The trade this makes, stated plainly: the handler's writes and its audit row are no longer
       * one atomic unit. For a submission that is the right trade, because the writes are already
       * two units by necessity — a payer either received the 837 or did not, and no amount of local
       * transaction scoping changes what happened at the other end.
       */
      await withPracticeScope(session.user.practiceId, () =>
        handleApi(req, deferred, services, url, session)
      );
      await withPractice(session.user.practiceId, () =>
        auditRequest(traceId, session, method, path, "success", clientIp(req), undefined, auditDetail.get(req))
      );
    } else {
      // ONE TRANSACTION PER REQUEST. RLS is armed here, and the business write plus its domain event
      // commit together or not at all.
      await withPractice(session.user.practiceId, async () => {
        await handleApi(req, deferred, services, url, session);
        // The audit row commits WITH the change it describes. Written inside the transaction on
        // purpose: an audit trail that can survive a rolled-back write, or be lost while the write
        // survives, is not an audit trail (HIPAA breach-notification readiness, risk §4).
        await auditRequest(traceId, session, method, path, "success", clientIp(req), undefined, auditDetail.get(req));
        // And a READ is recorded with the read, in the same transaction, for the same reason (0037).
        if (method === "GET" && deferred.status < 400) {
          await recordRead(traceId, session, path, clientIp(req), reportedIdleMs(req.headers[IDLE_HEADER]));
        }
      });
    }
  } catch (err) {
    // The transaction rolled back — including its audit row. Record the REFUSAL separately, in its
    // own transaction: "this user tried to do this and was refused" is exactly the event an audit
    // log exists for, and it must not vanish with the thing that was refused.
    await withPractice(session.user.practiceId, () =>
      auditRequest(traceId, session, method, path, "error", clientIp(req), err, auditDetail.get(req))
    ).catch(() => {});
    sendDomainError(deferred, err, traceId);
    deferred.flushTo(res);
    return;
  }

  // Dispatch AFTER the commit — never inside it, or a subscriber could act on a write that then
  // rolled back. Failures here are logged, never surfaced as a request error.
  if (method !== "GET") await services.drainOutbox();
  deferred.flushTo(res);
}

/** Build the HTTP server around injected services (exported for tests). */
export function createApp(services: Services) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handle = url.pathname.startsWith("/api/")
      ? dispatch(req, res, services, url)
      : serveStatic(res, url.pathname, req.headers["if-none-match"]);

    Promise.resolve(handle).catch((err: unknown) => {
      if (res.headersSent) return;
      sendDomainError(res, err);
    });
  });
}

/**
 * Seed a realistic queue so the demo isn't empty on first load. Each seed exercises a different
 * outcome across BOTH halves of the cycle — claims appear automatically via the outbox, so the
 * claims queue is seeded as a side effect of seeding verifications, exactly as in production.
 *
 *   Ada    → clean verification → clean claim, ready for the submit gate
 *   Ben    → inactive coverage  → held for review; if approved, the claim is still scrub-blocked
 *   Cora   → near annual max    → clean claim with an advisory
 *   Dev    → waiting period     → crown denied on the estimate; claim carries the advisory
 *   Osei   → unknown payer      → no benefits, so no claim at all
 *   Frank  → clean coverage but no tooth number on the crown → the scrubber blocks the claim
 *
 * The second half (`seedDemoCycle`) then files what is filable and pulls the payers' remittances,
 * because M8 added two screens — the unified Today queue and the practice report — that are
 * meaningless with no money in the system. A demo that opens on an empty dashboard demonstrates
 * nothing.
 *
 * ── THESE PATIENTS GO TO THE MOCK CONNECTOR, ALWAYS ────────────────────────────────────────────
 * The caller pins this to `MockEdiAdapter` rather than passing the configured one. Every name below
 * is invented, so with `EDI_ADAPTER=stedi` every seed became a real eligibility request about a
 * member no payer has ever issued: seven live API calls at boot, seven real 271s with no benefit
 * segments, and seven rows stamped `dataSource: "edi"` — indistinguishable on screen from a payer
 * confirming coverage. Demonstration data belongs to the demonstration connector, and the
 * provenance badge these rows now carry is only honest because that is enforced here.
 */
async function seedDemo(service: Services["verification"]): Promise<void> {
  const now = new Date();
  const plan = (toothNumber?: string) => [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, fee: cents(1250), ...(toothNumber ? { toothNumber } : {}) },
  ];
  /**
   * A deliberately obvious NON-DELIVERABLE address for the invented demo patients.
   *
   * The 837D requires the subscriber address, so a seeded patient needs one or their claim cannot be
   * filed and the demo stops halfway through the cycle. Named to be unmistakable: this string must
   * never appear on a real claim, and no production path falls back to it — a real patient without
   * an address is blocked at the submit gate, which is the correct outcome.
   */
  const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

  const seeds = [
    { first: "Ada", last: "Alpha", dob: "1990-04-12", memberId: "ABC12345", card: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100", tooth: "19" },
    { first: "Ben", last: "Booker", dob: "1978-11-03", memberId: "MEM10000", card: "Delta Dental\nMember ID: MEM10000", tooth: "14" },
    { first: "Cora", last: "Chen", dob: "1985-06-21", memberId: "CIG20099", card: "Cigna Dental\nMember ID: CIG20099", tooth: "30" },
    { first: "Dev", last: "Diaz", dob: "2001-02-15", memberId: "MET30077", card: "MetLife Dental\nMember ID: MET30077", tooth: "3" },
    { first: "E.", last: "Osei", dob: "1969-09-30", memberId: "XYZ99999", card: "Obscure Plan Co\nMember ID: XYZ99999", tooth: "12" },
    { first: "Frank", last: "Ford", dob: "1994-08-08", memberId: "AET40123", card: "Aetna Dental\nMember ID: AET40123\nGroup #: GRP204", tooth: undefined },
    /**
     * Ada again — same person, new employer, new payer, new member ID (M14).
     *
     * The demo's whole point on the Patients tab is that this is ONE record and ONE balance. Without
     * a second coverage the unified view looks identical to the per-account statement it replaced,
     * and the capability the milestone exists for is invisible to anyone being shown the product.
     * The identity resolves on surname, given name and date of birth, so these must match the row
     * above exactly — that is the assertion, not a coincidence.
     */
    { first: "Ada", last: "Alpha", dob: "1990-04-12", memberId: "MET30001", card: "MetLife Dental\nMember ID: MET30001\nGroup #: GRP882", tooth: "30" },
  ];
  for (const s of seeds) {
    await service.create(
      {
        patient: { firstName: s.first, lastName: s.last, dateOfBirth: s.dob, memberId: s.memberId, address: SYNTHETIC_ADDRESS },
        cardText: s.card,
        planItems: plan(s.tooth),
      },
      now
    );
  }
}

/**
 * The demo's appointment book: the next fourteen days, through the same `sync` door a CSV import
 * will use, labelled `mock` so no screen can mistake it for a practice's real schedule.
 *
 * The patients are the ones `seedDemo` verified, so readiness comes out of their REAL records rather
 * than being written here: Ada, Cora, Dev and Frank read verified; Ben and E. Osei read "needs
 * review", because both of their checks are waiting on a person. Two people appear who were never
 * checked at all — Grace and Hal, with no insurance on file — because a schedule is mostly people
 * nobody has verified yet, and a demo in which every visit is green demonstrates nothing.
 *
 * Deterministic and relative to today, so the demo always shows a live fortnight. Weekdays only;
 * every planned fee is stated, so the timeline can weigh days by production.
 */
async function seedDemoSchedule(services: Pick<Services, "appointments" | "timeZone" | "via">): Promise<void> {
  const tz = services.timeZone ?? "UTC";
  const today = calendarDay(new Date(), tz);
  const addDays = (day: string, n: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const PEOPLE = [
    { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
    { firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03" },
    { firstName: "Cora", lastName: "Chen", dateOfBirth: "1985-06-21" },
    { firstName: "Dev", lastName: "Diaz", dateOfBirth: "2001-02-15" },
    { firstName: "E.", lastName: "Osei", dateOfBirth: "1969-09-30" },
    { firstName: "Frank", lastName: "Ford", dateOfBirth: "1994-08-08" },
    { firstName: "Grace", lastName: "Green", dateOfBirth: "1988-03-14" },
    { firstName: "Hal", lastName: "Hughes", dateOfBirth: "1959-12-01" },
  ];
  const PLANS = {
    hygiene: [{ code: "D0120", feeCents: 6_500 }, { code: "D1110", feeCents: 12_000 }],
    newPatient: [{ code: "D0150", feeCents: 9_500 }, { code: "D0210", feeCents: 15_000 }],
    filling: [{ code: "D2391", feeCents: 22_000 }],
    crown: [{ code: "D2750", feeCents: 125_000 }],
    rootCanal: [{ code: "D3330", feeCents: 110_000 }],
  };
  // [person, local time, plan, minutes, provider] — a rotation, not a calendar anyone kept.
  const ROTATION: [number, string, keyof typeof PLANS, number, string][] = [
    [0, "08:00", "hygiene", 60, "Hygienist Park"],
    [1, "09:30", "crown", 90, "Dr. Reyes"],
    [6, "11:00", "newPatient", 60, "Dr. Reyes"],
    [2, "13:30", "filling", 45, "Dr. Reyes"],
    [4, "15:00", "rootCanal", 90, "Dr. Okafor"],
    [3, "08:30", "hygiene", 60, "Hygienist Park"],
    [5, "10:00", "crown", 90, "Dr. Okafor"],
    [7, "14:00", "newPatient", 60, "Dr. Reyes"],
  ];

  const visits: ScheduledVisit[] = [];
  let slot = 0;
  for (let k = 0; k < 14; k++) {
    const day = addDays(today, k);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    // Two to four visits a day, from the rotation, so the stacks differ in height.
    const count = 2 + (k % 3);
    for (let v = 0; v < count; v++) {
      const [person, time, plan, minutes, provider] = ROTATION[slot % ROTATION.length]!;
      slot += 1;
      const at = zonedInstant(day, time, tz);
      if (!at) continue;
      visits.push({
        externalId: `DEMO-${day}-${v}`,
        scheduledFor: at,
        durationMinutes: minutes,
        provider,
        // One cancellation, so the screens show a visit that was booked and is no longer coming.
        status: k === 2 && v === 0 ? "cancelled" : "scheduled",
        patient: PEOPLE[person]!,
        plannedProcedures: PLANS[plan],
      });
    }
  }
  /*
   * Iris: the one visit "Verify all due" can act on. Her card was checked forty days ago — against
   * the MOCK connector, like every invented patient here — so by her visit in two days the check has
   * expired. Without her the demo shows only visits a re-check cannot help, and the button that is
   * the point of stage 3 never appears.
   */
  const iris = { firstName: "Iris", lastName: "Ito", dateOfBirth: "1992-07-19" };
  await services.via(new MockEdiAdapter()).verification.create(
    {
      patient: { ...iris, memberId: "DDX55501" },
      cardText: "Delta Dental\nMember ID: DDX55501\nGroup #: GRP100",
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new Date(Date.now() - 40 * 86_400_000)
  );
  const irisDay = addDays(today, 2);
  const irisAt = zonedInstant(irisDay, "10:30", tz);
  if (irisAt) {
    visits.push({
      externalId: `DEMO-${irisDay}-iris`,
      scheduledFor: irisAt,
      durationMinutes: 60,
      provider: "Dr. Okafor",
      status: "scheduled",
      patient: iris,
      plannedProcedures: PLANS.filling,
    });
  }
  const result = await services.appointments.sync("mock", visits);
  if (result.rejected.length) throw new Error(`demo schedule rejected: ${JSON.stringify(result.rejected)}`);
}

/**
 * File everything the scrubber will pass, then pull the payers' advice — the same two operations a
 * clinic performs, through the same service methods the API calls. Nothing here bypasses a gate:
 * the submit gate is opened by an explicit actor, exactly as a person would.
 */
async function seedDemoCycle(services: Pick<Services, "claims" | "remittance">): Promise<void> {
  const ready = await services.claims.list({ status: "ready" });
  for (const item of ready) {
    if (!item.canSubmit) continue;
    await services.claims.submit(item.id, { submittedBy: "demo.seed@clinic" });
  }

  const submitted = await services.claims.list({ status: "submitted" });
  // Sequential — one client per request; see `today.ts`. These reads never overlapped.
  const detailed: NonNullable<Awaited<ReturnType<typeof services.claims.get>>>[] = [];
  for (const item of submitted) {
    const view = await services.claims.get(item.id);
    if (view && view.claim.submission !== null && view.claim.payer.payerId !== null) detailed.push(view);
  }

  // One advice per payer, as a payer actually sends them.
  const byPayer = new Map<string, typeof detailed>();
  for (const v of detailed) byPayer.set(v.claim.payer.payerId!, [...(byPayer.get(v.claim.payer.payerId!) ?? []), v]);

  for (const [payerId, group] of byPayer) {
    await services.remittance.fetchAndIngest({
      payerId,
      payerName: group[0]!.claim.payer.payerName ?? payerId,
      payeeName: getConfig().billingProviderName,
      claims: group.map((v) => ({
        patientControlNumber: v.claim.submission!.patientControlNumber,
        payerControlNumber: v.claim.submission!.controlNumber,
        patientFirstName: v.claim.patient.firstName,
        patientLastName: v.claim.patient.lastName,
        memberId: v.claim.patient.memberId,
        lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
        expectedInsurancePays: v.claim.expectedInsurancePays,
      })),
    });
  }
}

/**
 * Stedi's published sandbox subscriber. These exact values are required — Stedi's test environment
 * matches on them and returns its mock benefits; anything else comes back as an AAA rejection.
 *
 * They identify NO REAL PERSON. Source: Stedi's mock-requests documentation, and the same constants
 * `npm run stedi:check` has been driving since the integration landed.
 */
const STEDI_SANDBOX_SUBSCRIBER = {
  firstName: "Jordan",
  lastName: "Doe",
  dateOfBirth: "",
  memberId: "AETNA9wcSu",
  cardText: "Aetna Dental\nMember ID: AETNA9wcSu",
  /**
   * SYNTHETIC, and deliberately unmistakable.
   *
   * Stedi publishes a mock MEMBER for eligibility (`AETNA9wcSu`) but no mock ADDRESS for claims, and
   * a sandbox has no real patient — so this is invented. It exists only for test-mode traffic and
   * must never appear on a production claim. A real patient with no address is blocked at the
   * submit gate, which is the correct outcome and the reason no production path falls back here.
   */
  address: { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" },
} as const;

/**
 * Run ONE real eligibility check against Stedi's TEST environment, so the board has a row whose
 * benefits a clearinghouse actually returned.
 *
 * ── WHY THIS IS ATTEMPTED RATHER THAN SEEDED ───────────────────────────────────────────────────
 * Everything else in the demo is constructed locally and cannot fail. This cannot be, and must not
 * pretend otherwise: the numbers on this row — eligibility, deductible, annual maximum — are only
 * worth putting on a screen because they came back over the wire. If the key is missing, the
 * adapter is not Stedi, or the network is down, this logs why and the demo comes up without the
 * row. It never substitutes a plausible one; a fabricated "REAL STEDI TEST" record would be a
 * strictly worse lie than the ambiguity this whole change exists to remove.
 *
 * Refuses outright unless the adapter reports test mode, so a demo boot can never bill a live payer
 * check or put a member ID on a production network.
 */
async function seedStediTestVerification(services: Services): Promise<void> {
  let adapter;
  try {
    adapter = getEdiAdapter();
  } catch (err) {
    console.log(`  · no Stedi TEST row: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!(adapter instanceof StediEdiAdapter)) {
    console.log("  · no Stedi TEST row: EDI_ADAPTER is not 'stedi' (set it, with STEDI_API_KEY, to get one).");
    return;
  }
  if (!adapter.testMode) {
    console.log("  · no Stedi TEST row: adapter is in PRODUCTION mode — refusing to seed against a live payer.");
    return;
  }

  const started = Date.now();
  const view = await services
    .via(adapter).verification
    .create({
      patient: {
        firstName: STEDI_SANDBOX_SUBSCRIBER.firstName,
        lastName: STEDI_SANDBOX_SUBSCRIBER.lastName,
        dateOfBirth: STEDI_SANDBOX_SUBSCRIBER.dateOfBirth,
        memberId: STEDI_SANDBOX_SUBSCRIBER.memberId,
      },
      cardText: STEDI_SANDBOX_SUBSCRIBER.cardText,
      // A real plan, so the row carries a real estimate computed from the benefits Stedi returned
      // rather than sitting on the board as an eligibility result with no money attached.
      planItems: [
        { code: "D0120", quantity: 1 },
        { code: "D1110", quantity: 1, fee: cents(110) },
        { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
      ],
    })
    .catch((err: unknown) => {
      console.log(`  · Stedi TEST row FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

  if (!view) return;

  const p = view.provenance;
  console.log(`  · Stedi TEST row: ${p.label} (${Date.now() - started}ms)`);
  if (!p.benefitsRetrieved) {
    console.log(`    NO BENEFITS — ${p.benefitsNote}`);
    console.log("    The row is on the board and labelled as such. Nothing was fabricated.");
    return;
  }
  console.log(`    ${p.payerName} · ${p.clearinghouseName} payer id ${p.clearinghouseId} · member [PROTECTED]`);
  console.log(`    eligibility ${p.eligibility} · deductible ${p.deductible} · annual max ${p.annualMaximum}`);
}

async function main(): Promise<void> {
  // Before anything opens a socket: a production process that would write raw insurance cards, 835s
  // and 837s in the clear must not start. A warning in a log nobody reads is how a compliance
  // control becomes a compliance finding.
  assertPhiKeyInProduction();

  const services = buildServices();
  const port = Number(process.env.PORT ?? 3000);

  if (services.persistent) {
    // Creates the demo practice and one account per role on an empty database; a no-op afterwards.
    await ensureSeeded();
    // The default playbook is what a brand-new deployment reasons from until it has learned
    // anything of its own. Idempotent, so this is a no-op on every boot after the first.
    const seeded = await services.payerProfile.ensureDefaults();
    if (seeded > 0) console.log(`  seeded ${seeded} default payer-playbook rule(s)`);
    startOutboxWorker(services, outboxIntervalMs());
    /**
     * The ERA poller. A no-op until a practice registers a clearinghouse credential — it polls
     * per-source, and a deployment with no `era_sources` rows has nothing to poll. That is why
     * starting it unconditionally is safe: it cannot reach a vendor nobody configured.
     */
    startEraWorker(services);
    /**
     * The two failures no business screen reveals: a stalled queue and money that will not
     * reconcile. Displayed on Ops since M10; announced on the `alert` channel since M12 — and, since
     * audit A-4, sent somewhere a person will actually see them when `ALERT_WEBHOOK_URL` is set.
     * Unset, this is precisely the previous behaviour: the log line and nothing else.
     */
    startMonitors(services, {
      notify: createAlertNotifier({
        url: getConfig().alertWebhookUrl,
        environment: getConfig().deploymentName,
        logger,
      }),
    });
    createApp(services).listen(port, () => {
      console.log(`\n  Mermaid → http://localhost:${port}`);
      console.log(
        "  Postgres-backed · RLS tenant isolation · login required · durable outbox · monitored · " +
          `PHI at rest ${phiEncryptionEnabled() ? "ENCRYPTED" : "in the clear (set PHI_ENCRYPTION_KEY)"}\n`
      );
    });
    return;
  }

  // DB-free demo: no auth, single practice, everything resets on restart.
  await services.payerProfile.ensureDefaults();
  /**
   * The whole seeded day of work runs on the mock connector — see seedDemo's header.
   *
   * The cycle half matters as much as the verifications: a vendor adapter that implements
   * eligibility but not `submitClaim` refuses to file, correctly and non-retryably, and the demo
   * boot then dies on a seed. Demonstration data must not depend on a clearinghouse contract that
   * a deployment may not have.
   */
  const demo = services.via(new MockEdiAdapter());
  await seedDemo(demo.verification);
  await seedDemoCycle(demo);
  await seedDemoSchedule(services);
  // ...and then, if a Stedi TEST key is configured, exactly one row that is not invented.
  await seedStediTestVerification(services);
  createApp(services).listen(port, () => {
    console.log(`\n  Mermaid clinic demo → http://localhost:${port}`);
    console.log("  In-memory store (data resets on restart), no login. Set DATABASE_URL for the real thing.\n");
  });
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
