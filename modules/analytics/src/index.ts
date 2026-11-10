/**
 * @mermaid/analytics — the practice's own numbers.
 *
 * Answers the two questions no other module answers: is the practice healthy, and where is it losing
 * money? It owns no transactional data — every figure is derived from `analytics_facts`, populated
 * purely from domain events. That is the module-boundary rule producing a better design rather than
 * merely being obeyed: reporting never contends with a clinic filing a claim, and a fact records the
 * world as it was rather than as it has since been edited.
 */
export { AnalyticsService, DEFAULT_PERIOD_DAYS } from "./service.ts";
export { InMemoryFactRepository, type FactRepository } from "./repository.ts";
export { PgFactRepository } from "./repository.pg.ts";
export { registerAnalyticsSubscriptions, ANALYTICS_SUBSCRIBER } from "./subscriptions.ts";
export {
  buildReport,
  buildFunnel,
  buildMoney,
  buildPayerScores,
  buildDenialReasons,
  buildInsights,
} from "./engine/report.ts";
export type {
  Fact,
  FactType,
  Period,
  Funnel,
  MoneySummary,
  PayerScore,
  DenialReason,
  PracticeReport,
} from "./types.ts";
