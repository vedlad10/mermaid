/**
 * The coverage snapshot — the single most important data structure in Mermaid.
 *
 * Blueprint doc 00, "the one line that encodes it": `claims.verification_id` + an immutable
 * `coverage_snapshot`. A claim does not *re-derive* what insurance was expected to pay; it INHERITS
 * the exact estimate the verification produced, frozen at the moment of verification. That is what
 * turns estimate-vs-actual into a computed fact once the remittance arrives (doc 03, doc 11) rather
 * than an argument between two engines that drifted apart.
 *
 * It lives in `@mermaid/shared` because it crosses a module boundary: Verification PRODUCES it,
 * Claims CONSUMES it (via a domain event — never a cross-module import, see docs/MODULE-BOUNDARIES.md).
 * Shared types are how two bounded contexts agree on shape without coupling.
 *
 * Immutability is a doctrine, not a type-system trick: once a claim stores a snapshot, nothing
 * rewrites it. If benefits change, you run a NEW verification and build a NEW claim — the old
 * snapshot remains the truthful record of what was promised to the patient on that day.
 */
import type { Cents } from "../money.ts";
import type { Snapshot } from "../snapshot.ts";
import type { Benefits, CoverageCalculation } from "./estimate.ts";

/** Current schema version for a persisted coverage snapshot. Bump + add an upcaster on any change. */
export const COVERAGE_SNAPSHOT_VERSION = 1;

/** Where the underlying benefit data came from — carried so provenance survives into billing. */
export type BenefitsSource = "edi" | "portal" | "manual" | "mock";

/**
 * The frozen estimate a claim inherits. Money is integer cents throughout.
 *
 * `benefits` and `calculation` are the verification's outputs verbatim — copied, never recomputed.
 */
export interface CoverageSnapshotBody {
  /** The verification this snapshot was frozen from. */
  verificationId: string;
  /** ISO timestamp the verification ran — the "as of" date for every promise in here. */
  verifiedAt: string;
  payerId: string | null;
  payerName: string | null;
  planName: string | null;
  memberId: string | null;
  groupNumber: string | null;
  /** Full benefit picture at verification time. */
  benefits: Benefits;
  /** The per-line estimate the patient was quoted. */
  calculation: CoverageCalculation;
  /** Verification's overall confidence (0–1) — carried so billing can see how solid the estimate was. */
  confidence: number;
  source: BenefitsSource;
}

/** The persisted, versioned form (what lands in `claims.coverage_snapshot` JSONB). */
export type CoverageSnapshot = Snapshot<CoverageSnapshotBody>;

/** Total the snapshot expects insurance to pay across all lines. */
export const snapshotInsuranceExpected = (s: CoverageSnapshotBody): Cents =>
  s.calculation.totalInsurancePays;

/** Total the snapshot quoted the patient. */
export const snapshotPatientExpected = (s: CoverageSnapshotBody): Cents =>
  s.calculation.totalPatientPays;
