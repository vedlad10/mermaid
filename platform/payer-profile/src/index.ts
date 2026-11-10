/**
 * @mermaid/payer-profile — the shared brain: what a payer does about a given denial code, and how
 * often fighting it actually works.
 *
 * Lives in `platform/` rather than `modules/` because the blueprint requires cross-context reads of
 * it. The reasoning is set out in full at the top of `service.ts`.
 *
 * Most of what it holds is global — how often a payer overturns a CO-197 appeal is knowledge every
 * practice benefits from, with no tenant dimension and no RLS. Learned ALLOWED AMOUNTS are the
 * exception and are tenant-scoped under RLS (migration 0026): a contracted rate is the specific
 * commercial term one practice negotiated, so sharing it would quote patients from another
 * practice's contract and leak a commercial term between tenants.
 */
export {
  allowedFromLine,
  chargedPerUnit,
  contractualWriteOff,
  foldObservation,
  type AllowedAmount,
  type ObservedLine,
} from "./allowed-amounts.ts";
export {
  InMemoryAllowedAmountRepository,
  PgAllowedAmountRepository,
  type AllowedAmountRepository,
} from "./allowed-repository.pg.ts";
export {
  DEFAULT_CONFIRM_AFTER,
  DEFAULT_DOWNGRADE_PAIRS,
  confirmedEpoch,
  foldRateObservation,
  type EpochStatus,
  type FoldInput,
  type FoldOptions,
  type FoldResult,
  type RateEpoch,
  type VarianceClassification,
  type VarianceFinding,
} from "./allowed-variance.ts";
export {
  InMemoryAllowedVarianceRepository,
  PgAllowedVarianceRepository,
  changedEpochs,
  type AllowedVarianceRepository,
  type StoredVariance,
} from "./allowed-variance-repository.ts";
export {
  InMemoryPaymentMethodRepository,
  PgPaymentMethodRepository,
  foldPaymentMethods,
  type PaymentMethodObservation,
  type PaymentMethodRepository,
  type PayerPaymentMethodSummary,
} from "./payment-methods.ts";
export {
  PROMPT_PAY_RULES,
  RECOUPMENT_RULES,
  STATES_WITH_PROMPT_PAY_RULES,
  STATES_WITH_RECOUPMENT_RULES,
  governsOn,
  promptPayRuleFor,
  recoupmentRuleFor,
  type EffectiveDating,
  type PromptPayRule,
  type RecoupmentRule,
} from "./statutes.ts";
export {
  INTEREST_ALREADY_PAID_CARC,
  NOT_CLEAN_CARC,
  RECOUPMENT_PLB_REASON,
  addMonths,
  assessPromptPay,
  assessUnpaidDeadline,
  assessRecoupment,
  type Assessed,
  type ClockRefusal,
  type DeadlinePassedFinding,
  type PromptPayFinding,
  type UnpaidDeadlineInput,
  type PromptPayInput,
  type RecoupmentFinding,
  type RecoupmentInput,
} from "./statutory-clock.ts";
export {
  InMemoryStatutoryClockRepository,
  PgStatutoryClockRepository,
  foldSavings,
  toStored,
  type ClaimPaymentRecord,
  type ClockFindingKind,
  type ClockSavings,
  type StatutoryClockRepository,
  type StoredClockFinding,
} from "./statutory-clock-repository.ts";
export {
  PayerProfileService,
  TRUST_THRESHOLD,
  posteriorRate,
  type PayerAccuracy,
  type PayerConnector,
  type PayerInput,
  type ResolvedRule,
} from "./service.ts";
export {
  DEFAULT_PLAYBOOK,
  PAYER_CATALOG,
  PURSUABLE,
  normalizePayerName,
  sourcedWindow,
  type Disposition,
  type PayerSeed,
  type PlaybookSeed,
} from "./knowledge.ts";
export {
  InMemoryPlaybookRepository,
  type PayerAlias,
  type PayerRecord,
  type PlaybookRepository,
  type PlaybookRule,
} from "./repository.ts";
export { PgPlaybookRepository } from "./repository.pg.ts";
