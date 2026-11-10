/**
 * View-model builders — combine a persisted VerificationRecord with the pure read-model engines
 * (decision, plain-English summary, freshness) into the shapes the API/UI consume. Kept out of the
 * service so the shaping is independently testable and the transport layer stays thin. These NEVER
 * re-derive benefit math — they read the record the deterministic pipeline already produced.
 */
import { decideVerification, type Decision } from "./engine/decision.ts";
import { plainEnglishEstimate } from "./engine/summary.ts";
import { verificationFreshness, type Freshness } from "./engine/freshness.ts";
import { verificationProvenance, type VerificationProvenance } from "./engine/provenance.ts";
import type { VerificationRecord } from "./types.ts";

/** The full detail payload for one verification (the result screen). */
export interface VerificationView {
  record: VerificationRecord;
  decision: Decision;
  /** Plain-language sentences a human reads to the patient (never auto-delivered). */
  patientSummary: string[];
  freshness: Freshness;
  /**
   * Where these benefits came from. A first-class part of the view rather than something a screen
   * assembles from `record.dataSource`, because every screen would have to assemble it the same way
   * and the first one to get it wrong is the one that tells someone a payer confirmed coverage it
   * never saw.
   */
  provenance: VerificationProvenance;
}

export function buildVerificationView(record: VerificationRecord, now: Date = new Date()): VerificationView {
  return {
    record,
    decision: decideVerification(record, now),
    patientSummary: plainEnglishEstimate(record),
    freshness: verificationFreshness(record.createdAt, now),
    provenance: verificationProvenance(record),
  };
}

/** A compact row for the value-ranked queue/list. Money fields are integer cents. */
export interface VerificationListItem {
  id: string;
  createdAt: string;
  status: VerificationRecord["status"];
  patientName: string;
  payerName: string | null;
  memberId: string | null;
  patientPays: number | null;
  totalFee: number | null;
  outcome: Decision["outcome"];
  recommendedAction: string;
  /** 0–100 work-ranking (blueprint doc 07 unified queue idea); higher = handle first. */
  priority: number;
  criticalFlags: number;
  reviewed: boolean;
  /**
   * Where the benefits came from, carried on the ROW and not only on the detail screen.
   *
   * A queue is where the misreading happens: eight names with payers beside them read as eight
   * verified patients, and nobody opens a record to find out otherwise. Putting this on the row
   * costs one lookup per item and removes the only place the confusion could survive.
   */
  provenance: VerificationProvenance;
}

export function buildListItem(record: VerificationRecord, now: Date = new Date()): VerificationListItem {
  const decision = decideVerification(record, now);
  return {
    provenance: verificationProvenance(record),
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    patientName: `${record.patient.firstName} ${record.patient.lastName}`.trim() || "Unnamed patient",
    payerName: record.benefits?.payerName ?? record.card.payerName.value ?? null,
    memberId: record.card.memberId.value ?? record.patient.memberId ?? null,
    patientPays: record.calculation?.totalPatientPays ?? null,
    totalFee: record.calculation?.totalFee ?? null,
    outcome: decision.outcome,
    recommendedAction: decision.recommendedAction,
    priority: decision.priority,
    criticalFlags: record.exceptions.filter((e) => e.severity === "critical").length,
    reviewed: record.review !== null,
  };
}
