/**
 * @mermaid/denials-appeals — public surface of the Denials & Appeals bounded context.
 *
 * Turns a payer's refusal into recovered money, or into an informed decision not to chase it. The
 * engines are pure; the service wraps them with persistence, the shared payer brain, and the event
 * outbox — all injected. Nothing here sends anything to a payer without a named human approving it.
 */
export {
  DenialService,
  DenialNotFoundError,
  ContractualDenialNotBillableError,
  DenialActionError,
  DEFAULT_APPEAL_WINDOW_DAYS,
  type BillingIdentity,
} from "./service.ts";

export {
  type DenialRepository,
  type DenialFilter,
  InMemoryDenialRepository,
} from "./repository.ts";

export { PgDenialRepository, DENIAL_RECORD_VERSION } from "./repository.pg.ts";
export { registerDenialSubscriptions, DENIALS_SUBSCRIBER } from "./subscriptions.ts";

export {
  buildDenialView,
  buildDenialListItem,
  buildRecoveryStats,
  type DenialView,
  type DenialListItem,
  type RecoveryStats,
  type AppealWindow,
} from "./view.ts";

// Pure engines — usable by the transport layer without touching the service.
export { scoreDenial, type PriorityInput, type PriorityResult } from "./engine/priority.ts";
export { draftAppeal, IncompleteAppealError, type AppealContext, type AppealDraft } from "./engine/letter.ts";
export { denialHistory } from "./engine/history.ts";
export {
  createDenialExplainer,
  describeDenialContext,
  sanitizeExplanation,
  NoExplainer,
  type DenialExplainer,
  type DenialExplanation,
  type ExplanationInput,
  type ExplanationReason,
} from "./engine/explanation.ts";
export {
  createAppealNarrator,
  describeEvidence,
  sanitizeNarrative,
  NoNarrator,
  type AppealNarrator,
  type AppealNarrative,
  type NarrativeInput,
} from "./engine/narrative.ts";

export type {
  Denial,
  DenialStatus,
  DenialAuditEvent,
  Appeal,
  AppealStatus,
  Triage,
} from "./types.ts";
export {
  ASSUMED_APPEAL_WINDOW_LABEL,
  APPEAL_WINDOWS_ARE_PAYER_SOURCED,
  appealWindowNote,
  catalogedAppealWindowLabel,
} from "./types.ts";
export { OPEN_DENIAL_STATUSES, CLOSED_DENIAL_STATUSES, DISPUTED_DENIAL_STATUSES } from "./types.ts";
