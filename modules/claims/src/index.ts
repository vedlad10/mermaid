/**
 * @mermaid/claims — public surface of the Claims bounded context.
 *
 * A claim is the billing form of an estimate that already exists: it inherits the verification's
 * immutable coverage snapshot, is scrubbed by deterministic rules, and is released to the payer only
 * by a human. The engines are pure and DB-free; the service wraps them with persistence, the EDI
 * seam, and the event outbox — all injected, all swappable.
 */
export {
  ClaimService,
  InlineUnitOfWork,
  type UnitOfWork,
  NoPayerCatalog,
  type PayerWindowProvider,
  ClaimNotFoundError,
  ClaimNotSubmittableError,
  ClaimSubmissionFailedError,
  type SubmitInput,
  type BillingProviderIdentity,
  type SilentClaim,
} from "./service.ts";

export {
  type ClaimRepository,
  type ClaimFilter,
  InMemoryClaimRepository,
} from "./repository.ts";

export { PgClaimRepository, CLAIM_RECORD_VERSION } from "./repository.pg.ts";


export { registerClaimsSubscriptions, CLAIMS_SUBSCRIBER, CLAIMS_PAYMENT_SUBSCRIBER } from "./subscriptions.ts";

export {
  buildClaimView,
  buildClaimListItem,
  totalPaid,
  outstanding,
  type ClaimView,
  type ClaimListItem,
  claimVariance,
  type ClaimVariance,
} from "./view.ts";

// Pure engines & policy — usable by the transport layer without touching the service.
export { buildClaimDraft, patientControlNumber, type ClaimDraftInput } from "./engine/build.ts";
export {
  scrubClaim,
  isValidNpi,
  isPlaceholderBillingIdentity,
  SNAPSHOT_STALE_DAYS,
  type ScrubContext,
} from "./engine/scrub.ts";
export {
  filingDeadline,
  filingStatus,
  filingWindowDays,
  DEFAULT_FILING_DAYS,
  APPROACHING_DAYS,
  URGENT_DAYS,
  ESCALATING_RISKS,
  type FilingStatus,
} from "./engine/deadline.ts";
export {
  assessSilence,
  rankBySilenceUrgency,
  silenceWorsened,
  REJECTED_IDLE_DAYS,
  STALLED_DAYS,
  UNACKNOWLEDGED_DAYS,
  type Assessed,
  type SilenceCategory,
  type SilenceEscalation,
  type SilenceFinding,
  type SilenceInput,
  type SilenceRefusal,
} from "./engine/watchdog.ts";
export {
  canTransition,
  assertTransition,
  isTerminal,
  InvalidClaimTransitionError,
  OPEN_STATUSES,
  ADJUDICATED_STATUSES,
  SCRUBBABLE_STATUSES,
} from "./engine/status.ts";

export type {
  Claim,
  ClaimStatus,
  ClaimLine,
  ClaimPatient,
  ClaimPayer,
  ClaimSubmission,
  ClaimPayment,
  ClaimAuditEvent,
  FilingRisk,
  ScrubResult,
  ScrubFinding,
  ScrubCode,
  ScrubSeverity,
} from "./types.ts";
export { TERMINAL_STATUSES, CLAIM_STATUSES } from "./types.ts";

export { buildClaimTimeline, type TimelineEntry, type TimelinePhase } from "./engine/timeline.ts";
