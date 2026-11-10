# 10 — LLM Adapter Design

> **BUILT.** `platform/llm/` implements this document. Three deviations from the design below, each
> deliberate and each explained where it lives:
>
> 1. **No zod.** This repository has exactly one runtime dependency (`pg`), and that is worth more
>    than the ergonomics. `src/schema.ts` is the same contract, hand-rolled, and it sits on the
>    untrusted-input boundary where reading the whole implementation is a feature. It refuses rather
>    than coerces — a model that answered `"1,250.00"` where a number was asked for has not answered.
> 2. **Confidence is not asked of the model.** The design's `Extracted<T>.perFieldConfidence` is
>    populated by the router with what it actually knows (field present and valid), and *calibrated*
>    by the caller from domain evidence. A self-reported 0.95 correlates with how confident a
>    sentence sounds, not with how often it is right, and that number decides whether a human looks
>    at an insurance card. See `modules/verification/src/engine/card-vision.ts`.
> 3. **`LLM_PHI_APPROVED` is a separate flag from `LLM_PROVIDER`.** Configuring a provider and
>    being permitted to send it PHI are different facts, and only one of them is about the code.
>
> Two error codes were added to the design's four: `disabled` (the provider is `off` — the intended
> resting state, not an outage) and `phi_not_permitted`. Both are non-retryable, and neither alerts.
>
> **Externally gated:** `AnthropicProvider` has never been exercised against the real API from this
> repository. See `platform/llm/README.md` for the activation steps.

*Blueprint doc 10 of 16. The LLM is a swappable adapter with a **degraded-mode router** and strict
output gating. Deterministic engines are always the baseline; the LLM augments, it never decides
(`ai-revenue-cycle-implementation-roadmap.md` §7; `architecture-risk-review.md` §1.6, §3).*

## Principle: AI proposes, deterministic core disposes

Every LLM use in Mermaid is one of: **extraction** (text → structured fields), **drafting** (text a
human approves), or **narration** (prose over computed numbers). No LLM output reaches a financial
decision without schema validation and, where money/payers are involved, a human gate.

**Approved:** build the adapter + degraded router now; `LLM_PROVIDER=off` uses deterministic engines
only; the BAA-eligible provider is chosen at P2 (risk §4 — not every endpoint is HIPAA-eligible).

## The adapter interface

```ts
// platform/llm/adapter.ts
export interface LlmAdapter {
  /** Structured extraction with schema-validated output + per-field confidence. */
  extract<T>(req: ExtractRequest<T>): Promise<Result<Extracted<T>>>;
  /** Free-text drafting (appeal letters, narration) — returns text for HUMAN review. */
  draft(req: DraftRequest): Promise<Result<{ text: string }>>;
}
export interface Extracted<T> { value: T; perFieldConfidence: Record<keyof T, number>; }
export interface Result<T> {
  ok: boolean; data?: T;
  error?: { code: "unavailable" | "rate_limited" | "invalid_output" | "timeout"; retryable: boolean };
  degraded: boolean;        // true when the router fell back
}
```

## Uses (honest maturity, roadmap §7)

| Use | Module | LLM role | Guardrail |
|---|---|---|---|
| Card/document extraction (OCR) | Verification | vision→fields (payer, member id, group) | **BUILT** — schema-validated; cross-checked against the regex engine over the model's own transcription; a contested payer name or member ID is a CRITICAL exception, because lowering one field's score was not enough to survive the four-component average |
| Benefit-detail parsing | Verification | portal/PDF text → frequencies, waiting periods, exclusions | **per-field** confidence; strict schema **gates** what reaches the estimate |
| Confidence scoring | Verification | **NOT the LLM** — transparent heuristic (doc 11) | LLM may augment later, once labeled outcomes exist |
| Denial classification | Denials | **NOT the LLM** — rules/lookup vs playbook | auditable by design |
| Appeal letter drafting | Appeals | draft in payer-specific language | **BUILT** — one paragraph (the argument) only; identifiers, money and the evidence checklist stay deterministic. **Human-approved before payer send** (HITL §8), and editing the letter revokes an existing approval. Needs **no PHI**: the prompt carries a CDT code, a CARC code and a payer name, so it runs before any BAA |
| Denial root-cause narration | Denials | multi-code context → one plain-English sentence | **BUILT** — narration only; refuses any output containing a number or a recommendation. Not persisted: it is a reading aid over stored data, generated on an explicit click |
| Executive narration | Analytics | prose over computed KPIs | numbers are computed; LLM only phrases them |

## Degraded-mode router (the reliability core)

```ts
// platform/llm/router.ts
// A single LLM provider is a hard dependency; an outage must DEGRADE, not hang or fail silently.
export async function route<T>(op: LlmOp<T>): Promise<Result<T>> {
  if (provider === "off") return degrade(op, "provider disabled");
  try {
    const out = await withTimeout(provider.run(op), TIMEOUT_MS);
    const valid = op.schema.safeParse(out);
    if (!valid.ok) return degrade(op, "invalid_output");   // never pass unvalidated output on
    return { ok: true, data: valid.data, degraded: false };
  } catch (e) {
    return degrade(op, classify(e));                       // unavailable | rate_limited | timeout
  }
}
// degrade():
//   • extraction  → return { ok:false, degraded:true }; caller routes the case to the
//                    manual-review queue (a human keys the fields). Verification never blocks.
//   • drafting    → return a deterministic template draft (donor appealLetterTemplate) for the human.
//   • narration   → omit the prose; show the raw KPIs.
```

Degradation is **observable**: `degraded:true` is logged + metered; sustained degradation alerts.
The product keeps working (manual paths) during a provider outage — the risk review's explicit
requirement.

## Output gating (risk §3 — untrusted input, strict output)

- LLM **input** (payer text, card images, claim data) is treated as untrusted.
- LLM **output** is schema-validated (zod) before use; invalid output is a degrade, not a guess.
- For any output feeding money or a payer communication, a **human approves** before it takes effect.
- Prompts and outputs that contain PHI go only to a **BAA-eligible endpoint** (config-gated;
  `LLM_PROVIDER=off` until confirmed).

## Swapping providers

Add `providers/<name>.ts` implementing `LlmAdapter`; set `LLM_PROVIDER=<name>` + key. The router,
schemas, gates, and degraded paths are provider-independent.
