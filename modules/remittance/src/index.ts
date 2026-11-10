/**
 * @mermaid/remittance — public surface of the Remittance bounded context.
 *
 * Receives payers' 835 remittance advices, gates them on money safety (idempotency, exact balancing,
 * reversal isolation), posts them against claims, and computes ESTIMATE VS ACTUAL — the comparison
 * the whole architecture exists to make possible. Engines are pure and DB-free; the service wraps
 * them with persistence, the EDI seam, and the event outbox, all injected and swappable.
 */
export {
  RemittanceService,
  RemittanceNotFoundError,
  RemittanceUnavailableError,
  RemittanceActionRefusedError,
  CoordinationCaseNotFoundError,
} from "./service.ts";

export {
  assignedOf,
  blockedReasonOf,
  closeSecondaryWork,
  confirmCoverage,
  CoordinationRefusedError,
  crossoverCarrierOf,
  EVIDENCE_SOURCES,
  markSecondaryFiled,
  missingForConfirmation,
  recordSignal,
  requestConfirmation,
  signalOf,
  workStatusOf,
  type CloseOutcome,
  type ConfirmationRequest,
  type CoordinationCase,
  type CoordinationEvidence,
  type CoverageConfirmation,
  type CoverageStatus,
  type CrossoverCarrier,
  type EvidenceSource,
  type SecondaryPlan,
  type SecondaryWorkStatus,
} from "./coordination.ts";

export {
  type RemittanceRepository,
  type ExpectationRepository,
  type RemittanceFilter,
  type HeldRemittanceSummary,
  DuplicateRemittanceError,
  InMemoryRemittanceRepository,
  InMemoryExpectationRepository,
  type CoordinationRepository,
  InMemoryCoordinationRepository,
} from "./repository.ts";

export {
  PgRemittanceRepository,
  PgExpectationRepository,
  PgCoordinationRepository,
  REMITTANCE_RECORD_VERSION,
  COORDINATION_RECORD_VERSION,
} from "./repository.pg.ts";


export { registerRemittanceSubscriptions, REMITTANCE_SUBSCRIBER } from "./subscriptions.ts";

export {
  buildRemittanceView,
  buildRemittanceListItem,
  buildRecoveryQueue,
  type RemittanceView,
  type RemittanceListItem,
  type RecoveryItem,
  coordinationBrief,
  type CoordinationBrief,
  type ReleaseBlock,
} from "./view.ts";

// Pure engines & policy — usable by the transport layer without touching the service.
export { computeVariance, variancePriority, type PaidClaim } from "./engine/variance.ts";
export {
  checkRemittanceSafety,
  reconcile,
  matchable,
  PLB_HOLD_THRESHOLD_CENTS,
  type SafetyResult,
  type SafetyFinding,
  type SafetyCode,
  type DuplicateCandidate,
  duplicateFindings,
  UNRELEASABLE_SAFETY_CODES,
  type ReconciliationInput,
  type ReconciliationReport,
} from "./engine/safety.ts";

export type {
  Remittance,
  RemittanceStatus,
  RemittanceRejection,
  RemittanceAuditEvent,
  Posting,
  ClaimExpectation,
  Variance,
  VarianceOutcome,
  VarianceReason,
} from "./types.ts";

// ── ERA ingestion (G1 tenant resolution + G2 artifact retrieval) ──────────────────────
export { EraIngestService, looksLikeX12, ARTIFACT_MAX_ATTEMPTS, FIRST_POLL_LOOKBACK_DAYS } from "./era/service.ts";
export type { EraIngestReport, EraPollReport } from "./era/service.ts";
export { checkPayee, payeeMismatchMessage } from "./era/payee.ts";
export {
  InMemoryEraArtifactRepository,
  InMemoryEraSourceRepository,
  type EraArtifactRepository,
  type EraSourceRepository,
} from "./era/repository.ts";
export type { EraArtifact, EraArtifactStatus, EraProvenance, EraSource, PayeeCheck, TenantResolution } from "./era/types.ts";
export { PgEraArtifactRepository, PgEraSourceRepository } from "./era/repository.pg.ts";
