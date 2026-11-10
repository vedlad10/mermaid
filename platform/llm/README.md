# platform/llm

Provider-independent LLM adapter with a degraded-mode router (blueprint doc 10, risk review §1.6).
Every AI feature in Mermaid depends on `LlmAdapter`; nothing depends on a vendor SDK.

## The rule

**AI proposes; the deterministic core disposes.** There are exactly three operation kinds and
deliberately no fourth:

| kind | what it does | guardrail |
|---|---|---|
| extraction | untrusted text/image → schema-validated fields | per-field confidence, then the *existing* human-review gate |
| drafting | prose a human reads, edits and approves | the existing human release gate; degrades to a deterministic template |
| narration | sentences over already-computed numbers | numbers are never authored by the model |

There is no `decide()`, no `score()`, no `classify()`. Denial disposition, coverage math, scrub
verdicts, posting gates and overturn rates are solved deterministically and stay that way
(`Mermaid_Payer_Loop_Analysis.md` §6).

## Failure is a first-class outcome

**This layer never throws and never hangs.** Provider down, slow, rate-limited, disabled, forbidden
from seeing PHI, or answering in the wrong shape all produce one thing: `ok: false, degraded: true`.
Every caller has a deterministic path for that case. AI being unavailable is, at worst, a missing
paragraph on a screen — never a blocked revenue cycle.

Degradation is metered (`llm.degraded`, `llm.degraded.<code>`) and logged. Sustained degradation is
the alertable condition; `disabled` is not, because that is a deliberate resting state.

## Configuration

| variable | default | meaning |
|---|---|---|
| `LLM_PROVIDER` | `off` | `off` \| `anthropic`. Unknown names degrade to `off` with a process warning — they do not crash the app, because an optional feature must not take billing offline. |
| `LLM_MODEL` | `claude-sonnet-4-5` | Model id for the configured provider. |
| `LLM_API_KEY` | — | Read in exactly one place (`platform/config`). Provision through the deployment's secret store. |
| `LLM_PHI_APPROVED` | `0` | **Compliance control.** See below. |
| `LLM_TIMEOUT_MS` | `20000` | A human is usually waiting; degrading is cheap. |
| `LLM_MAX_ATTEMPTS` | `2` | Retries are safe here specifically because a completion has no effects — see `router.ts`. |

### `LLM_PHI_APPROVED` — why it defaults to off in production too

Whether an endpoint may lawfully receive PHI is a fact about a signed BAA, not about the code. Two
deployments running identical code can have different answers. So it is asked explicitly, and the
default is off.

A deployment that wires a real provider and forgets this flag gets **no AI on anything
patient-bearing** — those calls degrade and the deterministic paths carry the day. The cost of
forgetting is a missing convenience. The cost of defaulting the other way is an unreported
disclosure of PHI to a third party. Those are not comparable.

`containsPhi` is **declared by the caller, not detected.** A scanner would flag a CARC description
containing the word "patient" and miss a member ID in an unanticipated phrasing. Unset means `true`.

## Status — externally gated

`AnthropicProvider` is complete and unit-tested against a fake `fetch`. It has **never been
exercised against the real API from this repository.** Those tests prove the request is shaped
correctly and every HTTP status is classified into the right retry behaviour; they prove nothing
about whether the live API accepts it. Do not describe this as a working integration until someone
runs it with a real key.

To activate, in order:

1. Signed BAA covering the exact endpoint. ("The vendor offers BAAs" ≠ "this deployment has one.")
2. `LLM_API_KEY` in the deployment's secret store.
3. `LLM_PROVIDER=anthropic`.
4. `LLM_PHI_APPROVED=1` — separately, and only after (1).

`ScriptedProvider` is for tests and the laptop demo. It is deliberately **not** selectable by
`LLM_PROVIDER`: a fake reachable from production config eventually runs in production.

## Adding a provider

Write `src/providers/<name>.ts` implementing `LlmProvider` (one method: prompt in, text out), add a
`case` in `index.ts`, set `LLM_PROVIDER=<name>`. Timeouts, retries, validation, PHI enforcement,
degradation and metrics live in the router, so they are identical for every vendor and cannot be
forgotten by the next one added.
