/**
 * @mermaid/verification — public surface of the Verification bounded context.
 *
 * The deterministic pipeline (runVerification and its engines) is DB-free. The service +
 * repository layer wraps it with persistence and human-review routing; the repository is a
 * swappable seam (in-memory demo store today, Postgres+RLS in production — see repository.ts).
 */
export { runVerification, type VerificationInput } from "./pipeline.ts";
export { runEligibilityAndEstimate, type EligibilityEstimate } from "./eligibility.ts";
export { calculateCoverage } from "./engine/estimate.ts";

// Service + persistence seam (turns the pipeline into a usable product feature).
export {
  VerificationService,
  VerificationNotFoundError,
  type ReviewInput,
} from "./service.ts";
export {
  type VerificationRepository,
  type VerificationFilter,
  type PatientScope,
  InMemoryVerificationRepository,
} from "./repository.ts";

export { PgVerificationRepository, VERIFICATION_RECORD_VERSION } from "./repository.pg.ts";

export {
  buildVerificationView,
  buildListItem,
  type VerificationView,
  type VerificationListItem,
} from "./view.ts";

// Read-models & policy (pure functions over a record) for the API/UI layer.
export { decideVerification, type Decision, type DecisionEvidence } from "./engine/decision.ts";
export { reviewReasons, plainEnglishEstimate } from "./engine/summary.ts";
export { verificationFreshness, type Freshness, type FreshnessStatus } from "./engine/freshness.ts";
export {
  verificationProvenance,
  type SourceKind,
  type VerificationProvenance,
} from "./engine/provenance.ts";
export {
  BUILTIN_PAYERS,
  CLEARINGHOUSE_NAME,
  clearinghouseIdFor,
  identifyPayer,
  type PayerConnector,
  type PayerDirectory,
} from "./engine/payer.ts";
export { buildCoverageSnapshot } from "./engine/snapshot.ts";
export { verificationHistory } from "./engine/history.ts";
export { buildCompletedEvent, buildNeedsReviewEvent } from "./events.ts";
export { generateReport } from "./engine/report.ts";
export {
  createCardReader,
  NoCardReader,
  type CardReader,
  type CardReadResult,
} from "./engine/card-vision.ts";
export { REVIEW_THRESHOLD } from "./engine/analysis.ts";

export { NoPayerHistory } from "./types.ts";
export {
  InMemoryPatientDirectory,
  normalizeAddress,
  type PatientCoverageLink,
  type PatientDemographics,
  type PatientDirectory,
  type PatientRecord,
} from "./patients.ts";
export { PgPatientDirectory } from "./patients.pg.ts";

// The schedule (migration 0035): appointments, and each visit's coverage readiness.
export {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  InMemoryAppointmentRepository,
  type Appointment,
  type AppointmentRepository,
  type AppointmentSource,
  type AppointmentStatus,
  type PlannedProcedure,
  type ScheduledVisit,
} from "./appointments.ts";
export { PgAppointmentRepository, APPOINTMENT_RECORD_VERSION } from "./appointments.pg.ts";
export {
  AppointmentService,
  InvalidAppointmentWindowError,
  MAX_PATIENTS_PER_RUN,
  MAX_WINDOW_DAYS,
  RECHECK_COOLDOWN_MS,
  VERIFY_HORIZON_DAYS,
  type AppointmentUnitOfWork,
  type DuePreview,
  type DueRunResult,
  type DueVisit,
  type DueVisitResult,
  type VerifyFn,
  MAX_LISTED_PROBLEMS,
  type ImportPreview,
  type ImportResult,
  plannedProduction,
  visitProblem,
  type AppointmentListItem,
  type SyncResult,
} from "./appointment-service.ts";
export {
  IMPORT_FIELDS,
  MAX_IMPORT_ROWS,
  detectMapping,
  parseCsv,
  parseDate,
  parseMoney,
  parseProcedures,
  parseStatus,
  parseTime,
  planScheduleImport,
  type ColumnMapping,
  type ImportField,
  type ImportPlan,
} from "./engine/schedule-csv.ts";
export {
  appointmentReadiness,
  coverageReadiness,
  latestVerification,
  planKey,
  type Readiness,
  type ReadinessGroup,
  type ReadinessState,
} from "./engine/readiness.ts";
export {
  deriveChartId,
  detectIdentityCollision,
  sameIdentity,
  type CoverageOnFile,
  type PatientIdentity,
} from "./engine/identity.ts";
export {
  parseParticipationMap,
  participationFor,
  type NetworkParticipation,
} from "./engine/payer.ts";

export type {
  PatientAddress,
  VerificationRecord,
  VerificationStatus,
  PatientInfo,
  InsuranceCardData,
  ExceptionFlag,
  ConfidenceReport,
  ReviewDecision,
  PayerAccuracyProvider,
  PayerTrackRecord,
} from "./types.ts";
