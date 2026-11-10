/**
 * Timely-filing policy. Pure functions over dates — nothing stored, so the policy can change
 * without a migration (the same doctrine as verification freshness).
 *
 * Why this is a first-class engine and not a report: a claim that quietly passes its filing deadline
 * is unrecoverable revenue. The payer does not owe it, there is no appeal, and nobody notices until
 * a month-end reconciliation. So the deadline is computed at claim creation, surfaced on every view,
 * and escalated as a domain event (`claim.filing_risk`) before it expires.
 *
 * The per-payer window table is a documented placeholder. Payer rules are the Payer Profile module's
 * bounded context (blueprint doc 02); once it lands, this reads the window from a payer-profile
 * projection instead of the constant below — a swap inside `filingWindowDays`, not a caller change.
 */
import { calendarDay, daysBetween, type PayerWindowSource } from "@mermaid/shared";
import type { FilingRisk } from "../types.ts";

export type { FilingRisk };

/** Fallback window when the payer is unknown. One year is the common commercial-dental default. */
export const DEFAULT_FILING_DAYS = 365;

/**
 * Whether ANY filing window in this system is sourced from a payer's own published terms.
 *
 * ── WHY THIS CONSTANT EXISTS (M7) ──────────────────────────────────────────────────────────────
 * It is `false`, and that is the honest answer. Every number in `PAYER_FILING_DAYS` below and in
 * `PAYER_CATALOG` is described in its own comment as a "common commercial-dental default" — which
 * is to say a plausible guess. Nobody has checked them against a provider manual.
 *
 * That was tolerable while the deadline only ranked work. It was not tolerable at the submit gate,
 * where `past-filing-deadline` was an ERROR: it BLOCKED filing and told the biller "the payer will
 * refuse this claim — write it off, or appeal with proof of timely filing." If a payer's real window
 * is 365 and this guesses 180, Mermaid instructed a practice to abandon revenue the payer would have
 * paid, on its own unverified constant, and generated no evidence of having done so. A written-off
 * claim produces nothing that contradicts the decision to write it off.
 *
 * So while this is false the finding is a WARNING: loud, on the gate, ranked in the queue, escalated
 * as `claim.filing_risk` — everything except the one thing it had no standing to do, which is refuse.
 * The biller still sees it and still decides; they simply are not overruled by a guess.
 *
 * Flip it to `true` only when the windows are actually cited to payer documentation, and expect that
 * to become per-payer rather than global when some are sourced and others are not.
 *
 * ── B-1: IT DID BECOME PER-PAYER, AND THIS STAYS FALSE ─────────────────────────────────────────
 * Aetna's window is now cited to Aetna's own guide, and that fact travels on the claim as
 * `filingWindowSource`; `filingStatus` reads it per claim. This constant now means only what its name
 * says — that not EVERY window is sourced — and it still decides the one thing a source does not: an
 * expired deadline WARNS rather than blocks. Even a sourced window is the payer's published default,
 * which Aetna itself qualifies "unless otherwise required by contract or state requirement". Refusing
 * to file on it would overrule a practice whose contract allows longer — M7's harm again.
 */
export const FILING_WINDOWS_ARE_PAYER_SOURCED = false;

/**
 * M7's caveat, in ONE place so every surface that shows a filing date says the same thing.
 *
 * `FILING_WINDOWS_ARE_PAYER_SOURCED` is false, which makes this true of EVERY filing deadline in the
 * system — the catalogued windows and the fallback alike. It was only ever said on the expired
 * finding in `scrub.ts`, so the countdown a biller actually works to ("Only 3 days left to file.
 * Submit today.") asserted a date with no caveat at all, and the queue, the timeline and the claim
 * header showed the bare date. Same sentence, every surface, or the quiet ones read as certainty.
 */
export const FILING_WINDOW_ESTIMATE_NOTE =
  "That window is an estimate, not this payer's stated terms.";

/**
 * What to say beside a date the payer's own document stands behind (B-1).
 *
 * Names the document, so the claim is checkable, and ends on the contract, because the payer did:
 * a published window is a default a participation agreement can lengthen. Dropping that clause
 * would trade the old overconfidence for a new one.
 */
export function sourcedFilingWindowNote(source: PayerWindowSource): string {
  return (
    `That window is ${source.publisher}'s published filing limit (${source.document}). ` +
    "Your practice's contract may allow longer."
  );
}

/** M7's remediation, reused wherever an expired deadline is reported rather than merely ranked. */
export const FILING_WINDOW_CONFIRM_NOTE =
  "Confirm the real filing window with the payer before writing anything off.";

const PAYER_FILING_DAYS: Record<string, number> = {
  "delta-dental": 365,
  // The named Delta Dental companies, each its own payer (see PAYER_CATALOG). Generic defaults.
  "delta-dental-ca": 365,
  "delta-dental-nj": 365,
  "delta-dental-ny": 365,
  "delta-dental-or": 365,
  "cigna-dental": 365,
  "metlife-dental": 365,
  // Sourced (B-1). The fallback copy of the catalog's figure — kept equal to it, as the two copies
  // must be, although a date from THIS table is still labelled an estimate: the citation travels
  // with the catalog's number, not with this one.
  "aetna-dental": 90,
  "guardian-dental": 180,
  "uhc-dental": 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days a payer allows between date of service and receipt of the claim.
 *
 * `catalogued` is the window the payer profile holds for this payer, or null when it has none.
 * Passing it in rather than looking it up keeps this engine pure — no I/O, deterministic, unit
 * testable — which is the property that lets the whole deadline policy be reasoned about without a
 * database. `ClaimService` does the lookup; this decides what to do with the answer.
 *
 * The local map survives as the fallback and is no longer the source of truth. A payer the catalog
 * has never heard of must still get a deadline: a claim with no deadline is a claim nobody chases.
 */
export function filingWindowDays(payerId: string | null, catalogued?: number | null): number {
  if (catalogued && catalogued > 0) return catalogued;
  if (!payerId) return DEFAULT_FILING_DAYS;
  return PAYER_FILING_DAYS[payerId] ?? DEFAULT_FILING_DAYS;
}

/** The last ISO date on which this payer will still accept a claim for this service date. */
export function filingDeadline(serviceDateIso: string, payerId: string | null, catalogued?: number | null): string {
  const service = new Date(`${serviceDateIso.slice(0, 10)}T00:00:00Z`);
  const deadline = new Date(service.getTime() + filingWindowDays(payerId, catalogued) * DAY_MS);
  return deadline.toISOString().slice(0, 10);
}

export interface FilingStatus {
  deadline: string;
  /** Negative once the deadline has passed. */
  daysRemaining: number;
  risk: FilingRisk;
  message: string;
  /**
   * Whether this deadline is Mermaid's estimate rather than the payer's published terms.
   *
   * Per claim since B-1: false exactly when the claim recorded the payer's own document behind its
   * date (`filingWindowSource`), true otherwise.
   */
  estimated: boolean;
  /**
   * The sentence to show beside the date: the estimate caveat when it is estimated, and the
   * citation-and-contract caveat when it is sourced (B-1). Null only if every window were sourced
   * AND this one had no citation to name — which the global flag rules out today.
   */
  estimateNote: string | null;
  /** The payer's document behind the date, or null when the date is Mermaid's estimate. */
  source: PayerWindowSource | null;
}

/** Escalation thresholds, in days remaining. */
export const URGENT_DAYS = 14;
export const APPROACHING_DAYS = 45;

/**
 * `timeZone` is the PRACTICE's, and it is load-bearing.
 *
 * "How many days until this deadline" compares a calendar day to today, and today is a fact about
 * where the clinic is, not about where the server is. This read `now.toISOString()` — the UTC day —
 * so for a US Pacific practice, from late afternoon onward, a claim on its final filing day reported
 * `expired`: "this payer will refuse the claim", four hours before that became true. Evening is when
 * end-of-day filing sweeps run, so that is the window in which staff were told to abandon claims the
 * payer would still have paid.
 *
 * Defaults to UTC so the behaviour is unchanged where no zone is configured, and `getConfig()`
 * refuses to boot a production deployment without one.
 */
export function filingStatus(
  deadlineIso: string,
  now: Date = new Date(),
  timeZone = "UTC",
  source: PayerWindowSource | null = null
): FilingStatus {
  const daysRemaining = daysBetween(calendarDay(now, timeZone), deadlineIso.slice(0, 10));

  // Every one of these sentences counts down to, or declares the end of, a date this system
  // computed. While no window is payer-sourced, each of them says so — including the calm ones,
  // because a caveat that only appears once the news is bad reads as certainty the rest of the time.
  //
  // A sourced date (B-1) keeps a caveat too — a different one. It is the payer's published default,
  // and the practice's contract can lengthen it, so it is never stated as the last word either.
  const estimated = !source && !FILING_WINDOWS_ARE_PAYER_SOURCED;
  const note = source ? sourcedFilingWindowNote(source) : estimated ? FILING_WINDOW_ESTIMATE_NOTE : null;
  const caveat = note ? ` ${note}` : "";

  let risk: FilingRisk;
  let message: string;
  if (daysRemaining < 0) {
    risk = "expired";
    const passed = `The filing deadline passed ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? "" : "s"} ago`;
    // The certainty this used to end on — "this payer will refuse the claim" — is the exact claim
    // M7 stripped from the scrub finding, for the exact reason: on an unsourced window it tells a
    // practice to abandon money the payer might have paid, and a write-off produces no evidence
    // against itself.
    //
    // A sourced window does not earn it back: the payer published a default, not this practice's
    // contract, so the instruction is still to confirm before anything is abandoned.
    message = note
      ? `${passed}. ${note} ${FILING_WINDOW_CONFIRM_NOTE}`
      : `${passed} — this payer will refuse the claim.`;
  } else if (daysRemaining <= URGENT_DAYS) {
    risk = "urgent";
    message = `Only ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left to file. Submit today.${caveat}`;
  } else if (daysRemaining <= APPROACHING_DAYS) {
    risk = "approaching";
    message = `${daysRemaining} days left to file.${caveat}`;
  } else {
    risk = "safe";
    message = `${daysRemaining} days left to file.${caveat}`;
  }
  return {
    deadline: deadlineIso,
    daysRemaining,
    risk,
    message,
    estimated,
    estimateNote: note,
    source,
  };
}

/** Risks worth raising a `claim.filing_risk` event for. "safe" is not news. */
export const ESCALATING_RISKS: readonly FilingRisk[] = ["approaching", "urgent", "expired"];
