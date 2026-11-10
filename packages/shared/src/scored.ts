/**
 * The universal AI/heuristic output contract (donor doctrine; blueprint doc 04): every value a
 * heuristic or AI component produces carries a confidence in [0,1] and a human-readable explanation,
 * so downstream code (and staff) can see how much to trust it and why.
 */
export interface Scored<T> {
  value: T;
  /** 0 = no confidence, 1 = certain. */
  confidence: number;
  explanation: string;
}
