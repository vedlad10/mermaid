/**
 * The LLM seam (blueprint doc 10). Every AI feature in Mermaid depends on THIS interface, never on a
 * vendor SDK — exactly as every EDI consumer depends on `EdiAdapter` and never on a clearinghouse.
 * `LLM_PROVIDER` config selects the implementation; `off` is the default and uses no AI at all.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────────────────────
 * AI **proposes**; the deterministic core **disposes**. Every operation here is one of exactly
 * three kinds, and there is deliberately no fourth:
 *
 *   extraction  — untrusted text/image → schema-validated structured fields, each carrying a
 *                 confidence, routed through the SAME human-review gate everything else uses.
 *   drafting    — prose a human reads, edits and approves before it reaches anyone.
 *   narration   — sentences laid over numbers that were already computed deterministically.
 *
 * There is no `decide()`, no `score()`, no `classify()`. Denial disposition, coverage math, scrub
 * verdicts, posting gates and overturn rates are solved deterministically and stay that way
 * (Payer_Loop_Analysis §6: "None of this becomes AI").
 *
 * ── FAILURE IS A FIRST-CLASS OUTCOME ───────────────────────────────────────────────────────────
 * A single LLM provider is a hard dependency, and a hard dependency on a third party inside a
 * revenue cycle is unacceptable. So no operation here throws on provider failure: it DEGRADES.
 * `ok: false, degraded: true` means "carry on without the AI" — the caller falls back to its
 * deterministic path (a template letter, the manual-review queue, bare KPIs) and the practice's day
 * continues. Nothing in the revenue cycle may block on this layer being up.
 */

/** What went wrong. Every code is either retryable transport or a permanent refusal — never both. */
export type LlmErrorCode =
  /** The provider is `off`, or none is configured. Not an outage — the intended default state. */
  | "disabled"
  /**
   * The request carries PHI and this environment has not approved the configured provider for PHI.
   * A refusal, never a retry: retrying would send it anyway. See `phi.ts`.
   */
  | "phi_not_permitted"
  | "unavailable"
  | "rate_limited"
  | "timeout"
  /** The provider answered, but the answer did not satisfy the schema. Never passed on as a guess. */
  | "invalid_output";

export interface LlmError {
  code: LlmErrorCode;
  message: string;
  /** Whether another attempt could plausibly succeed. `disabled`/`phi_not_permitted` never are. */
  retryable: boolean;
}

/**
 * The outcome of an LLM operation.
 *
 * `degraded` is not the same as `!ok`. It is the signal that the AI layer was ASKED and did not
 * answer, which is what gets metered and alerted on — a provider that is `off` on purpose degrades
 * every call and that is fine; a provider that starts degrading at 3pm is an incident.
 */
export interface LlmResult<T> {
  ok: boolean;
  data?: T;
  error?: LlmError;
  degraded: boolean;
  /** Provenance, for the audit trail the CALLER writes. Never contains prompt or response content. */
  provider: string;
  model: string | null;
  latencyMs: number;
  attempts: number;
}

/** One extracted structured value plus the per-field confidence the review gate actually reads. */
export interface Extracted<T> {
  value: T;
  /**
   * 0–1 per field. **Per-field, not per-response** — a 271 or an insurance card is routinely partly
   * legible, and one unreadable group number must not drag a perfectly clear member ID below the
   * threshold (roadmap §7.2, and the same shape `EligibilityResponse.perFieldConfidence` already
   * uses).
   */
  perFieldConfidence: Record<string, number>;
}

/** An image the model may look at. Base64 — never a file path, never a URL the model must fetch. */
export interface LlmImage {
  /** "image/jpeg" | "image/png" | "image/webp" | "image/gif" */
  mediaType: string;
  /** Base64-encoded bytes, no data: prefix. */
  base64: string;
}

export interface LlmRequestBase {
  /**
   * What this call is for, in stable snake_case — `card_extraction`, `appeal_narrative`,
   * `denial_explanation`. Used for metrics, log correlation and per-feature flags. Not a prompt.
   */
  operation: string;
  /**
   * Whether the prompt contains protected health information.
   *
   * **The caller must answer this honestly and the router enforces it.** It is deliberately not
   * inferred: a heuristic that scans for names would be wrong in both directions, and being wrong
   * in one of those directions is a reportable breach. Default is `true` wherever it is unset,
   * because in a revenue-cycle platform the safe assumption about any patient-adjacent text is that
   * it is PHI.
   */
  containsPhi?: boolean;
  /** Overrides the configured default. Kept short: a human is usually waiting on the other end. */
  timeoutMs?: number;
}

export interface DraftRequest extends LlmRequestBase {
  /** Role/constraints. Should state plainly what the model may not do. */
  system: string;
  /** The material to work from. */
  prompt: string;
  /** Hard ceiling on the returned text. Output longer than this is truncated at a word boundary. */
  maxChars?: number;
}

export interface ExtractRequest<T> extends LlmRequestBase {
  system: string;
  prompt: string;
  images?: LlmImage[];
  /** The shape the answer must take. Output that fails it is an `invalid_output` degrade, never a guess. */
  schema: ObjectSchema<T>;
}

/**
 * The adapter every AI feature depends on.
 *
 * Two methods, on purpose. `draft` covers drafting and narration (both are "prose a human reads");
 * `extract` covers everything structured. A third method would be a decision, and decisions are not
 * this layer's to make.
 */
export interface LlmAdapter {
  extract<T>(req: ExtractRequest<T>): Promise<LlmResult<Extracted<T>>>;
  draft(req: DraftRequest): Promise<LlmResult<{ text: string }>>;
  /** True when a real provider is wired and permitted. UI uses it to decide whether to offer AI. */
  available(): boolean;
  readonly name: string;
}

// ── Schema (dependency-free) ──────────────────────────────────────────────────────────
//
// Blueprint doc 10 writes this as zod. This repository has exactly one runtime dependency (`pg`)
// and that is a property worth more than the ergonomics — an LLM output validator is a hundred
// lines, and it sits on the untrusted-input boundary where reading the whole implementation is a
// feature. So: the same contract, hand-rolled.

export type FieldSpec =
  | { kind: "string"; nullable?: boolean; maxLength?: number; pattern?: RegExp }
  | { kind: "number"; nullable?: boolean; min?: number; max?: number }
  | { kind: "boolean"; nullable?: boolean }
  | { kind: "enum"; values: readonly string[]; nullable?: boolean }
  | { kind: "stringArray"; maxItems?: number; maxLength?: number };

/**
 * A flat object schema. Flat on purpose: nested LLM output is harder to validate, harder to explain
 * in a prompt, and has never been needed by anything this layer serves.
 */
export interface ObjectSchema<T> {
  /** Names the prompt builder repeats back to the model, so field names are the contract. */
  fields: Record<string, FieldSpec>;
  /** Phantom marker so `ObjectSchema<T>` is not structurally identical for every `T`. */
  readonly __shape?: T;
}

export const schema = <T>(fields: Record<string, FieldSpec>): ObjectSchema<T> => ({ fields });
