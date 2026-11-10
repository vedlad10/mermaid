/**
 * Claim status machine. Explicit, total, and enforced — not a convention.
 *
 * A claim's status governs whether real money moves, so illegal transitions are refused at the
 * service layer rather than trusted not to happen. Re-submitting an already-submitted claim, or
 * editing one the payer has paid, are exactly the mistakes that produce duplicate payments and
 * takeback letters.
 *
 *   draft ──scrub clean──▶ ready ──human submit──▶ submitted ──remittance──▶ paid
 *     ▲                      │                        │                          ▲
 *     └──scrub finds errors──┘                        ├──▶ partially_paid ───────┘
 *     ▲                                               │         │
 *     │                                               ├──▶ denied│
 *     └───────────correct and refile──────────────────┴─────────┘
 *                                                     │
 *                                    payer refuses at intake ──▶ rejected ──fix──▶ draft
 *
 * Anything open may be voided. `paid` and `void` are terminal.
 *
 * The three post-adjudication states are reached ONLY from a `remittance.posted` event. This module
 * never decides on its own that money arrived — that would let a claim be marked paid without a
 * payer ever having said so.
 */
import { TERMINAL_STATUSES, type ClaimStatus } from "../types.ts";

const TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  // A re-scrub may promote a draft or demote a ready claim, so both directions are legal.
  draft: ["ready", "void"],
  ready: ["draft", "submitted", "rejected", "void"],
  submitted: ["paid", "partially_paid", "denied", "rejected", "void"],
  rejected: ["draft", "ready", "void"],
  // A later remittance (secondary payer, correction, won appeal) can complete or deny a claim that
  // was only partly paid; correcting and refiling sends it back through the scrubber.
  partially_paid: ["paid", "denied", "draft", "void"],
  // A denial is worked by correcting and refiling, or by an appeal that eventually pays.
  denied: ["draft", "ready", "paid", "partially_paid", "void"],
  paid: [],
  void: [],
};

export class InvalidClaimTransitionError extends Error {
  from: ClaimStatus;
  to: ClaimStatus;
  constructor(from: ClaimStatus, to: ClaimStatus) {
    super(`a claim cannot move from "${from}" to "${to}"`);
    this.name = "InvalidClaimTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!canTransition(from, to)) throw new InvalidClaimTransitionError(from, to);
}

/** True when no further work is expected on this claim. */
export const isTerminal = (status: ClaimStatus): boolean => TERMINAL_STATUSES.includes(status);

/**
 * Statuses whose claims are still the clinic's to act on — what the working queue shows.
 *
 * `partially_paid` and `denied` are open: money is outstanding and someone must decide whether to
 * pursue it. They are, however, NOT re-scrubbed automatically (see the service) — a claim that has
 * been adjudicated is worked deliberately, not swept.
 */
export const OPEN_STATUSES: readonly ClaimStatus[] = ["draft", "ready", "rejected", "partially_paid", "denied"];

/** Statuses a claim reaches only by a payer adjudicating it. */
export const ADJUDICATED_STATUSES: readonly ClaimStatus[] = ["paid", "partially_paid", "denied"];

/** Statuses whose claims the scrubber may still move between draft and ready. */
export const SCRUBBABLE_STATUSES: readonly ClaimStatus[] = ["draft", "ready", "rejected"];
