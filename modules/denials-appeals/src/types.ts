/**
 * Denials & Appeals bounded-context types.
 *
 * The unit of work is a DENIED REASON, not a denied claim. A payer can withhold money on one claim
 * for two unrelated codes — a missing tooth number and a bundling dispute — and those are two
 * different jobs, with different evidence, different odds and possibly different outcomes.
 * Collapsing them is how a practice ends up appealing a bundling denial with radiographs.
 *
 * Money is integer cents. Union types only (no enums) so the sources run under type-stripping.
 */
import type { Cents, PayerWindowSource } from "@mermaid/shared";
import type { Disposition } from "@mermaid/payer-profile";
import type { AppealNarrative } from "./engine/narrative.ts";

export type { AppealNarrative, AppealNarrator, NarrativeInput } from "./engine/narrative.ts";

/**
 * Denial lifecycle.
 *
 *   triaged        → detected from a remittance variance AND given a disposition and recovery odds
 *                    by the playbook, in one step — see `Denial.triage`
 *   appealing      → an appeal is drafted, awaiting the human approval gate
 *   appealed       → submitted to the payer, awaiting their decision
 *   recovered      → money came back (fully or partly)
 *   written_off    → the practice decided not to pursue it
 *   patient_billed → not the payer's to pay; the balance moved to the patient
 */
export type DenialStatus =
  | "triaged"
  | "appealing"
  | "appealed"
  /**
   * The payer agreed on appeal and has sent nothing yet. OPEN, deliberately: this is the state that
   * did not exist, and its absence is why a won appeal used to vanish from every worklist the
   * moment it became collectable (F-2).
   */
  | "awaiting_payment"
  /** Some of the award arrived; the remainder is still owed. Also OPEN. */
  | "partially_recovered"
  /**
   * Cash arrived and was posted. NO LONGER means "a human said we won" — that is
   * `awaiting_payment` now. This is the only status in the machine that money, rather than a
   * person, is allowed to produce.
   */
  | "recovered"
  | "written_off"
  | "patient_billed";

/** Statuses where the money is still in play. */
export const OPEN_DENIAL_STATUSES: readonly DenialStatus[] = [
  "triaged",
  "appealing",
  "appealed",
  "awaiting_payment",
  "partially_recovered",
];

/**
 * Statuses where the money is still being ARGUED ABOUT — a strict subset of the open set.
 *
 * Narrower than `OPEN_DENIAL_STATUSES` on purpose, and the difference is the whole point. Once a
 * payer has agreed to pay on appeal, the money is OWED rather than disputed: it belongs in a
 * receivable, not in "how much is this payer withholding from us". Counting the two together would
 * double-count a won appeal — once as still-contested and again as awarded — and overstate what is
 * actually in dispute.
 *
 * Named rather than written out at the call site, because it read as a bare
 * `["triaged", "appealing", "appealed"]` in the patient record: identical to the pre-Phase-3 copies
 * that DID drift, so nothing distinguished a deliberate narrowing from a list somebody forgot to
 * update. A subset with a reason is a decision; the same literal without one is a bug waiting to be
 * mistaken for a decision.
 */
export const DISPUTED_DENIAL_STATUSES: readonly DenialStatus[] = ["triaged", "appealing", "appealed"];

/** Statuses where the outcome is known and nothing further is expected. */
export const CLOSED_DENIAL_STATUSES: readonly DenialStatus[] = ["recovered", "written_off", "patient_billed"];

export type AppealStatus = "draft" | "submitted" | "won" | "lost" | "withdrawn";

/**
 * The appeal window used when the payer's own terms are not catalogued (M5 — see `service.ts`, which
 * re-exports this as the module's public name).
 *
 * It lives here, next to `ASSUMED_APPEAL_WINDOW_LABEL`, so the number a biller is TOLD and the
 * number actually USED cannot drift apart. Previously the only place to say "90" in a sentence was
 * to type it a second time.
 */
export const DEFAULT_APPEAL_WINDOW_DAYS = 90;

/**
 * What a biller is told when the deadline came from that default rather than from the payer.
 *
 * Deliberately not an `AppealWindow` member and deliberately not a priority input: the countdown is
 * real either way — a date exists, it runs out, and it deserves the same urgency — so folding "we
 * assumed this" into the urgency scale would confuse *how soon* with *how sure*. This says how sure,
 * beside the date, and leaves the ranking alone.
 */
export const ASSUMED_APPEAL_WINDOW_LABEL =
  `Assumed ${DEFAULT_APPEAL_WINDOW_DAYS}-day window (payer not on file) — confirm with payer.`;

/**
 * Whether ANY appeal window in this system is sourced from a payer's own published terms.
 *
 * ── WHY THIS CONSTANT EXISTS, AND WHY IT MIRRORS M7 ────────────────────────────────────────────
 * It is `false`, and that is the honest answer — the same answer `FILING_WINDOWS_ARE_PAYER_SOURCED`
 * already gives on the claims side, about the same seed data.
 *
 * `c7af7ff` marked an UNCATALOGUED payer's deadline as assumed, which was right as far as it went.
 * What it left standing was the implied contrast: that a catalogued window is therefore the payer's
 * own stated terms. It is not. Every catalogued window comes from `PAYER_CATALOG`, whose own comment
 * calls its values "the common commercial-dental defaults", and nothing has edited them —
 * `ensurePayers` SKIPS rows that already exist, `upsertPayer` has no other production caller, and
 * the payer-profile API is GET-only. There is no path by which a practice can put its own
 * negotiated terms into that row today, so "catalogued" means "we hold a per-payer guess", not "the
 * payer told us".
 *
 * Which is why the caveat is applied unconditionally rather than to the fallback alone. The two
 * cases still read differently — one names a default the payer had no part in, the other a
 * plausible per-payer figure — but neither claims an authority it does not have.
 *
 * Flip it to `true` only when the windows are actually cited to payer documentation, and expect it
 * to become per-payer at that point: an edit path would make SOME rows real and leave others seeded,
 * and this constant would no longer be able to answer for all of them.
 *
 * ── B-1: IT BECAME PER-PAYER, AND THIS STAYS FALSE ─────────────────────────────────────────────
 * Aetna's appeal window is now cited to Aetna's own page, and the denial records that as
 * `appealWindowSource`; `appealWindowNote` reads it per denial. This constant now means only that
 * not every window is sourced.
 */
export const APPEAL_WINDOWS_ARE_PAYER_SOURCED = false;

/**
 * What a biller is told when the payer's own document stands behind the window (B-1).
 *
 * Still a caveat: the payer published a default, and its own words say the contract or state law
 * can change it. The trailing clause is the point and should survive any rewording.
 */
export function sourcedAppealWindowLabel(windowDays: number | null | undefined, source: PayerWindowSource): string {
  return windowDays && windowDays > 0
    ? `A ${windowDays}-day window published by ${source.publisher} — confirm against your participation agreement, which may differ.`
    : `A window published by ${source.publisher} — confirm against your participation agreement, which may differ.`;
}

/**
 * What a biller is told when the deadline came from a CATALOGUED window — which is still a typical
 * figure rather than this payer's stated terms, for as long as the constant above is false.
 */
export function catalogedAppealWindowLabel(windowDays: number | null | undefined): string {
  return windowDays && windowDays > 0
    ? `Estimated ${windowDays}-day window based on typical terms — confirm with payer.`
    : // A denial written before the window was recorded cannot quote it. The claim being made —
      // that the figure is typical rather than stated — is true without the number.
      "Estimated window based on typical terms — confirm with payer.";
}

/**
 * The sentence to show beside an appeal deadline, or null when there is nothing to caveat.
 *
 * One function so that every surface — the view, the worklist row, the priority explanation, the
 * web UI — quotes the same words for the same case, which is the property `ASSUMED_APPEAL_WINDOW_LABEL`
 * was introduced to guarantee for the fallback and this now extends to both.
 */
export function appealWindowNote(
  estimated: boolean,
  windowDays: number | null | undefined,
  source: PayerWindowSource | null = null
): string | null {
  if (estimated) return ASSUMED_APPEAL_WINDOW_LABEL;
  if (source) return sourcedAppealWindowLabel(windowDays, source);
  return APPEAL_WINDOWS_ARE_PAYER_SOURCED ? null : catalogedAppealWindowLabel(windowDays);
}

export interface DenialAuditEvent {
  timestamp: string;
  actor: "system" | "staff";
  message: string;
}

/** The playbook's verdict, snapshotted at triage time. */
export interface Triage {
  disposition: Disposition;
  /** Probability of recovery when this was triaged. Frozen deliberately — see below. */
  overturnRate: number;
  sampleSize: number;
  trusted: boolean;
  source: "payer-learned" | "payer-rule" | "default-rule" | "carc-category";
  recommendedAction: string;
  guidance: string;
  explain: string[];
  /** Expected recovery: deniedAmount × overturnRate. What ranking is actually based on. */
  expectedRecovery: Cents;
  triagedAt: string;
}

export interface Appeal {
  id: string;
  denialId: string;
  /** 1 = first-level, 2 = second-level, 3 = external review. */
  level: number;
  status: AppealStatus;
  /** The drafted letter. Deterministically generated; an LLM may polish, never decide. */
  letter: string;
  /** Evidence a human must actually gather before this is worth sending. */
  checklist: string[];
  /**
   * Set when an LLM wrote the letter's argument paragraph; null when the deterministic sentence was
   * used (because AI is off, degraded, or its output was refused).
   *
   * Persisted rather than derived, for two reasons that both matter after the fact. A reviewer needs
   * to know a paragraph was machine-written *before* they put their name to it — "was this AI?" is
   * not a question a letter should leave to the reader. And when a payer disputes what was asserted
   * six months later, the record has to say which model wrote it and what it was told, or the
   * practice is reconstructing its own correspondence from memory.
   */
  narrative: AppealNarrative | null;
  /** The human gate — null until a person approves. Nothing is sent without both of these. */
  approvedBy: string | null;
  approvedAt: string | null;
  submittedAt: string | null;
  outcomeRecordedAt: string | null;
  recoveredAmount: Cents | null;
  outcomeNotes: string | null;
  createdAt: string;
}

export interface Denial {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: DenialStatus;

  /** Provenance: which claim, which remittance, which posting this came from. */
  claimId: string;
  remittanceId: string;
  postingId: string;

  carcCode: string;
  carcDescription: string;
  /**
   * The CAS01 adjustment group the reason arrived under: CO, PI, OA, CR (never PR — a patient
   * responsibility is not a denial).
   *
   * Carried because a recoverable denial is **not always group CO**. `categorizeAdjustment` returns
   * `recoverable` for CO *and* PI, and for any group where the CARC's own category says so — so a
   * payer-initiated reduction reaches this module exactly like a contractual one. Anything that
   * assumed CO would be stating the wrong thing about a PI adjustment, which matters because the
   * group is what says whose decision it was.
   *
   * Null on denials created before this was recorded — the group was genuinely not kept then, and a
   * default would be a guess about a payer's own coding.
   */
  carcGroup: string | null;
  procedureCode: string | null;
  deniedAmount: Cents;

  payerId: string | null;
  payerName: string;
  patientName: string;
  /**
   * The three facts an appeal letter is worthless without, carried on `variance.detected`.
   *
   * Before these existed the UI supplied them, and — unable to know them — supplied empty strings,
   * so appeals went to payers reading "Claim [claim number] … Member ID: [member ID]". A payer
   * cannot act on that, which means the appeal window closed on money the practice had already
   * decided to fight for.
   */
  memberId: string | null;
  claimControlNumber: string;
  serviceDate: string;

  /**
   * The playbook's verdict, FROZEN at triage. The brain keeps learning, but the number a human saw
   * when they decided to appeal must not silently change underneath them afterwards — an audit
   * trail whose reasoning mutates is not an audit trail.
   *
   * ── NON-NULLABLE, BECAUSE A DENIAL IS NEVER UNTRIAGED ──────────────────────────────────────────
   * This was `Triage | null`, and the `new` status above described a denial awaiting triage. Neither
   * state has ever existed: `createFromVariance` is the only constructor, it always resolves a rule
   * (`PayerProfileService.resolve` always returns something — an unrecognised CARC still yields a
   * category-derived disposition) and it always writes `status: "triaged"`. A repository-wide search
   * for `triage: null` and `status: "new"` finds nothing, and neither string has existed anywhere in
   * this module's git history since it was introduced.
   *
   * The nullable type was therefore not modelling a real state; it was requiring every reader to
   * handle one that could not occur, and those `?? 0` fallbacks rendered "0% odds" for a case that
   * never happens. Narrowing it makes the compiler the guard: if detect-then-triage-later is ever
   * wanted, it will fail to typecheck here rather than silently produce a zero.
   */
  triage: Triage;

  /** The last day this payer accepts an appeal. Missing it is unrecoverable revenue. */
  appealDeadline: string | null;
  /**
   * Whether `appealDeadline` was computed from Mermaid's default window rather than the payer's own
   * catalogued terms.
   *
   * ── WHY THE DEADLINE IS STILL COMPUTED, AND WHY THIS FLAG EXISTS ───────────────────────────────
   * An uncatalogued payer gets `DEFAULT_APPEAL_WINDOW_DAYS` (M5): an appeal with no deadline is one
   * nobody chases, so a date is better than a blank. That decision stands. What was missing is that
   * the resulting date reached a biller looking exactly like a date the payer had stated — a
   * countdown to a day no payer ever named.
   *
   * Both are real countdowns and both deserve the same urgency, so `AppealWindow` is unchanged and
   * ranking is untouched. The difference is one of PROVENANCE, and it is carried here so every
   * surface can say which kind of date it is showing.
   *
   * Optional, not defaulted to `false`: a denial written before this existed carries no answer, and
   * `false` would assert the payer's terms were used when nobody recorded whether they were. Absent
   * means "not recorded" — the same distinction `carcGroup` and `denialReason` already draw.
   */
  appealDeadlineEstimated?: boolean;
  /**
   * The window, in days, that produced `appealDeadline` — the payer's catalogued figure, or
   * `DEFAULT_APPEAL_WINDOW_DAYS` where there was none.
   *
   * Carried so a biller-facing sentence can quote the number it is caveating without recomputing it
   * from a date whose anchor (the payer's determination date) this record does not keep. Optional
   * for the same reason `appealDeadlineEstimated` is: a denial written before this existed does not
   * know, and a default would be inventing the figure the sentence exists to be honest about.
   */
  appealWindowDays?: number;
  /**
   * The payer's own document behind `appealWindowDays`, or absent when that window is a catalogued
   * default or Mermaid's fallback (B-1).
   *
   * Recorded with the date it describes, for the same reason the window is: it is a fact about how
   * THIS deadline was computed. A denial triaged on the old 60-day Aetna guess keeps that date and
   * its "typical terms" label, which stay true of it. Optional; absent reads as unsourced.
   */
  appealWindowSource?: PayerWindowSource | null;
  /** 0–100 work ranking: expected value × urgency × actionability. */
  priority: number;

  appeals: Appeal[];
  /**
   * What the payer AGREED to pay on appeal. A decision, not a payment.
   *
   * Optional because a denial written before F-2 does not carry one; absent means "no appeal has
   * been decided", which is different from an award of zero (a lost appeal).
   */
  awardedAmount?: Cents | null;
  /**
   * How much of `awardedAmount` has arrived AND been posted. Only a posting moves this.
   *
   * The pair is the whole point: `awardedAmount` is workflow, this is cash, and nothing may read
   * one where it means the other. `awardedAmount - awardSettledAmount` is the receivable.
   */
  awardSettledAmount?: Cents | null;
  /** When the win was recorded. The anchor for award age — there is no payer-stated due date. */
  awardedAt?: string | null;
  /**
   * Which postings have settled this award, and for how much.
   *
   * The set — not a running total — is what makes settlement idempotent. Delivery is at-least-once,
   * so the same `remittance.posted` can legitimately reach the handler twice; a posting already in
   * here is ignored rather than added again. It also lets the settled figure be RECOMPUTED from
   * authoritative state rather than trusted from an event payload.
   */
  awardSettlements?: { postingId: string; amount: Cents }[];
  /** What the payer decided, kept apart from the status so a reversal can be told from a loss. */
  outcomeDecision?: "won" | "lost" | null;
  /** Set by the 0024 backfill on a denial that was `recovered` with no cash behind it. */
  awardBackfilled?: boolean;
  /**
   * Cash actually recovered.
   *
   * ── REDEFINED (F-2) ────────────────────────────────────────────────────────────────────────────
   * This used to be set the moment a human recorded a win, which is what made "recovered" mean two
   * incompatible things at once. It now tracks CASH and is written only from a posting; the figure
   * a person records goes to `awardedAmount`. Historical rows migrated by 0024 carry null here and
   * their old value in `awardedAmount`, so nothing reads a promise as a payment.
   */
  recoveredAmount: Cents | null;
  /** Why a human closed it without recovering. */
  closeReason: string | null;

  detectedAt: string;
  audit: DenialAuditEvent[];
}
