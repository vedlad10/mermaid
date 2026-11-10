/**
 * Analytics bounded-context types.
 *
 * Analytics answers the two questions nobody else in this product answers: **is the practice
 * healthy, and where is it losing money?** Every other module reasons about one case at a time; this
 * one reasons about all of them at once.
 *
 * It owns no transactional data. Every number here is derived from `analytics_facts`, which is
 * populated purely from domain events — so a report can never contend with a clinic filing a claim,
 * and a metric can be added by replaying history rather than by migrating a live schema.
 *
 * Money is integer cents throughout. Union types only (no enums) so the sources run under
 * type-stripping.
 */
import type { Cents } from "@mermaid/shared";

/** The business moments worth recording. A small, closed vocabulary on purpose. */
export type FactType =
  | "verification_completed"
  | "verification_flagged"
  | "claim_submitted"
  | "payment_posted"
  | "denial_created"
  | "appeal_outcome"
  /** Money moved onto a patient's account — the half of every dollar the payer does not pay. */
  | "patient_charged"
  /** The patient paid it, or the practice forgave it. `won` distinguishes the two. */
  | "patient_collected";

export interface Fact {
  /** The source event's id. Kept for provenance: which delivery produced this row. */
  sourceEventId: string;
  /**
   * What makes this fact unique within a practice — the idempotency key (NEW-12).
   *
   * ── WHY THIS IS NOT JUST `sourceEventId` ANY MORE ──────────────────────────────────────────────
   * Keying on the source event makes redelivery idempotent, which is what the outbox needs, and it
   * does nothing about the SAME SUBJECT being announced twice by two different events. Re-reviewing
   * a settled verification republished `verification.completed` with a new event id, so one visit
   * counted twice — the denominator of `billingRate` grew and the rate fell, and a practice
   * appeared to be leaving money unbilled that it had in fact billed.
   *
   * "One fact per subject" is true of some fact types and false of others, and assuming it for all
   * of them would delete real money: a claim is legitimately paid by a primary AND a secondary
   * payer, and a denial can be appealed at two levels. So the recorder states the key, and a
   * recorder that says nothing gets `<factType>:<sourceEventId>` — exactly the old behaviour.
   */
  dedupeKey?: string;
  factType: FactType;
  occurredAt: string;
  payerId: string | null;
  payerName: string | null;
  procedureCode: string | null;
  carcCode: string | null;
  verificationId: string | null;
  claimId: string | null;
  denialId: string | null;
  /** Meaning varies by `factType` — see migration 0011. */
  amount: Cents;
  expected: Cents;
  won: boolean | null;
  meta: Record<string, unknown> | null;
}

/** A reporting window. Both bounds are ISO timestamps; `to` is exclusive. */
export interface Period {
  from: string;
  to: string;
}

/**
 * The revenue-cycle funnel — where work actually goes.
 *
 * Read top to bottom it answers "of everything we verified, how much got billed, and of that, how
 * much got paid?" The drop between any two rows is a leak, and naming which one is the whole point.
 */
export interface Funnel {
  verificationsCompleted: number;
  verificationsFlagged: number;
  claimsSubmitted: number;
  claimsPaid: number;
  /** Claims submitted ÷ verifications completed. Null when nothing was verified. */
  billingRate: number | null;
  /** Verifications that needed a human ÷ all verifications. High = the front desk is struggling. */
  reviewRate: number | null;
}

/**
 * The money summary. `expected` versus `collected` is the estimate-vs-actual thesis expressed at
 * practice scale rather than per claim.
 */
export interface MoneySummary {
  /**
   * What the practice FILED to payers in this period — claims actually sent, not every charge
   * raised (F-8).
   *
   * It was called `billed`, and so was a figure on the patient record that counts every live claim
   * whether or not it has been filed. Two screens showed different totals under one word: $13,000
   * here against $16,550 there, both correct, and no way for a reader to tell which question either
   * was answering. The $3,550 between them was a draft and six ready claims — real work, correctly
   * excluded from a figure about what went to payers, and invisible as an explanation.
   *
   * "Billed" is retired rather than qualified, because the ambiguity was the word itself.
   */
  filedToPayers: Cents;
  /** What the inherited estimates promised across everything submitted. */
  expected: Cents;
  /** What the PAYERS paid. */
  collected: Cents;
  /** Money withheld for reasons worth pursuing. */
  denied: Cents;
  recovered: Cents;
  /** `collected ÷ expected`, 0–1. The single number a practice owner would ask for first. */
  collectionRate: number | null;
  /** `denied ÷ filedToPayers`, 0–1. */
  denialRate: number | null;
  /** `recovered ÷ denied`, 0–1. Null until something has been worked. */
  recoveryRate: number | null;

  /**
   * The patient side of the same money (M9).
   *
   * Reported separately rather than folded into `collected`, because the two behave nothing alike:
   * a payer that has adjudicated will pay, while a patient balance decays with age. A single
   * "collected" number that mixed them would hide the half a practice can actually influence.
   */
  patientBilled: Cents;
  patientCollected: Cents;
  /** Balances the practice chose not to collect — courtesy adjustments and write-offs. */
  patientForgiven: Cents;
  /** `patientCollected ÷ patientBilled`, 0–1. */
  patientCollectionRate: number | null;
  /**
   * How far the practice's own estimates have been from what payers actually paid (F-7).
   *
   * Measured over the claims PAID in the period, each against its own estimate — not
   * `collected − expected`, which compares payments received to claims filed and so compares two
   * different sets of claims. The figure has always existed
   * per claim and was surfaced nowhere, so a practice could quote a patient from an estimate, be paid
   * something else, and never learn the estimate was wrong. An estimate nobody checks against the
   * payment is a guess repeated forever — and the practice finds out from the patient.
   *
   * Negative means payers paid LESS than promised, which is the direction that surprises a patient
   * with a bigger bill than they were quoted.
   */
  estimateVariance: Cents;
  /**
   * The same, as a share of what those claims were expected to pay. Null when nothing was paid.
   *
   * This is the number that would have made F-1 visible from the dashboard: an estimator that splits
   * the practice fee instead of the contracted allowed amount is wrong in the same direction on every
   * in-network claim, so the rate sits at a stable non-zero value rather than scattering around
   * zero. A ratio that never crosses zero is a systematic error, not noise.
   */
  estimateAccuracy: number | null;
  /** Payer + patient. What actually arrived, from every source. */
  totalCollected: Cents;
}

/** How one payer actually behaves — the evidence behind "this payer is difficult". */
export interface PayerScore {
  payerId: string | null;
  payerName: string;
  claimsSubmitted: number;
  /** What was FILED to this payer — see the note on `MoneySummary`. */
  filedToPayers: Cents;
  expected: Cents;
  collected: Cents;
  denied: Cents;
  recovered: Cents;
  collectionRate: number | null;
  denialRate: number | null;
  /** Mean days from claim submission to payment posting. Null until a payment has landed. */
  averageDaysToPay: number | null;
}

/** Which denial reasons cost the most — the list that tells a practice what to FIX, not just chase. */
export interface DenialReason {
  carcCode: string;
  description: string;
  count: number;
  denied: Cents;
  recovered: Cents;
  /** `recovered ÷ denied` for this code, 0–1. Null until one has been worked to an outcome. */
  recoveryRate: number | null;
}

/** Everything the dashboard needs, for one period. */
export interface PracticeReport {
  period: Period;
  funnel: Funnel;
  money: MoneySummary;
  payers: PayerScore[];
  topDenialReasons: DenialReason[];
  /**
   * Cash posted per day, oldest first, for the days that had any.
   *
   * Empty when nothing was collected in the window — which is a real answer and not a gap to fill
   * with zeroes. A surface drawing this must say how many days it covers, because four days of
   * activity and four months of activity make the same shape.
   */
  dailyCollections: DailyCollection[];
  /** Plain-English observations a human reads before looking at any number. */
  insights: string[];
}

export interface DailyCollection {
  /** `YYYY-MM-DD`. */
  day: string;
  collected: Cents;
  /** How many advices posted that day — the denominator behind the bar. */
  payments: number;
}
