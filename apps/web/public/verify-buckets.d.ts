/**
 * Types for the Verify spine's buckets.
 *
 * The three arrays are declared as one object rather than three exported functions on purpose: the
 * guarantee this module exists to make is about the RELATIONSHIP between them — no check appears in
 * two — and a caller that can only obtain them together is a caller that cannot quietly re-derive
 * one of them from a different predicate and reintroduce the overlap.
 */

/**
 * A verification as the Verify screen reads it. Deliberately loose: this module only touches the
 * three fields it sorts on, and narrowing the rest here would put the API's whole shape in a second
 * place to keep current.
 */
export interface VerificationLike {
  outcome?: string;
  totalFee?: number | null;
  provenance?:
    | ({ benefitsRetrieved?: boolean; amountAtStake?: number | null } & Record<string, unknown>)
    | null;
  [key: string]: unknown;
}

/** The three exception buckets, pairwise disjoint. */
export interface VerifyBuckets {
  /** The payer answered; a person has to choose what to do about the answer. */
  needsHuman: VerificationLike[];
  /** The check never reached the payer: a phone call or a portal, not a decision. */
  blocked: VerificationLike[];
  /** Answered, and the answer carried no coverage. Excludes `blocked`, which is the whole point. */
  empty: VerificationLike[];
}

/** What a verification put at stake, in cents. */
export declare function atStake(v: VerificationLike): number;

/**
 * Sort checks into the three exception buckets the spine reports.
 *
 * A check falls into at most one of them, so the figures can be read across without double-counting
 * a dollar. `the-verify-spine-counts-no-dollar-twice.test.ts` enforces that.
 */
export declare function partition(rows: VerificationLike[]): VerifyBuckets;
