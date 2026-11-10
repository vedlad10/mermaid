/**
 * Eligibility → estimate use-case: the deterministic front-half flow. Given a payer + member +
 * planned procedures, fetch normalized benefits from the EDI adapter and compute the patient
 * estimate. The adapter is injected (not imported concretely) so this stays pure and testable and
 * the EDI vendor remains swappable.
 *
 * This is DB-free orchestration; persistence (the `verifications` row, confidence report, review
 * routing) lands in the module service layer with the database.
 */
import { calculateCoverage } from "./engine/estimate.ts";
import type { EdiAdapter, EligibilityRequest } from "@mermaid/edi";
import type { Benefits, CoverageCalculation, TreatmentPlanItem } from "@mermaid/shared";

export interface EligibilityEstimate {
  eligibility: "active" | "inactive" | "unknown";
  benefits: Benefits | null;
  estimate: CoverageCalculation | null;
  /** Raw 271 for provenance/audit (stored encrypted when persisted). */
  raw271: string | null;
  /** Overall confidence (mean of the adapter's per-field confidence), 0–1. */
  confidence: number;
  explanation: string;
}

export async function runEligibilityAndEstimate(
  adapter: EdiAdapter,
  req: EligibilityRequest,
  procedures: TreatmentPlanItem[],
  today: Date = new Date()
): Promise<EligibilityEstimate> {
  const result = await adapter.checkEligibility(req);

  if (!result.ok || !result.data) {
    return {
      eligibility: "unknown",
      benefits: null,
      estimate: null,
      raw271: result.raw ?? null,
      confidence: result.error ? 0.1 : 0,
      explanation: result.error?.message ?? "No eligibility information was returned by the payer.",
    };
  }

  const { benefits, eligibility, perFieldConfidence } = result.data;
  const estimate = calculateCoverage(procedures, benefits, today);

  const scores = Object.values(perFieldConfidence);
  const confidence = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : 0;

  return {
    eligibility,
    benefits,
    estimate,
    raw271: result.raw ?? null,
    confidence,
    explanation:
      `Eligibility ${eligibility} via ${result.source} transport (production 271 parser); ` +
      `estimate computed for ${procedures.length} procedure(s).`,
  };
}
