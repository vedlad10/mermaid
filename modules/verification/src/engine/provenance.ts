/**
 * Where a verification's benefits actually came from — a pure read of a completed record.
 *
 * ── THE DEFECT THIS EXISTS TO FIX ───────────────────────────────────────────────────────────────
 * The demo seeds a day of work so the queue is not empty on first load. Those patients are
 * invented. Once a real clearinghouse was wired, the seeded verifications began going out to it as
 * well — and came back as real 271s with no benefit segments, because Stedi's sandbox only answers
 * for its own published mock member. So every seeded row was stamped `dataSource: "edi"`, truthfully
 * and uselessly: it HAD been to a clearinghouse, it just had not learned anything there.
 *
 * Nothing on any screen distinguished the three states that matter, and they look identical:
 *
 *   • mock connector, benefits invented locally      → a demonstration
 *   • real clearinghouse, benefits returned          → evidence
 *   • real clearinghouse, nothing returned           → neither, and the most misleading of the three
 *
 * A screen that cannot tell them apart quietly invites the worst possible reading — that a payer has
 * confirmed coverage for a patient nobody has ever checked. Quoting a patient from that is the
 * failure mode, and it does not announce itself.
 *
 * ── EVERY FIELD IS EVIDENCE, NOT CONFIGURATION ─────────────────────────────────────────────────
 * This deliberately reads the RECORD and not `getConfig()`. Current configuration describes the
 * process answering the request, not the run that produced a record months ago — a deployment that
 * switched `EDI_ADAPTER` would silently relabel its entire history, which is precisely the class of
 * mistake this module exists to prevent. So:
 *
 *   `dataSource`        the pipeline stamped it from the adapter that answered
 *   test vs production  read from the 271's own ISA usage indicator
 *   clearinghouse id    looked up from the registry the pipeline routed on
 *   benefits            present or absent on the record; never inferred from status
 *
 * Nothing here re-derives benefit math, decides anything, or changes what a verification concluded.
 */
import { formatUsd, formatUsdOrUnknown } from "@mermaid/shared";
import { CLEARINGHOUSE_NAME, clearinghouseIdFor } from "./payer.ts";
import type { VerificationRecord } from "../types.ts";

/**
 * The one-line answer, in the order of decreasing trust a person should place in the record.
 *
 *   `live`      a real clearinghouse answered, in production, about a real member
 *   `test`      a real clearinghouse answered, in its sandbox, about its published mock member
 *   `mock`      no clearinghouse was contacted; the benefits were generated locally
 *   `none`      a clearinghouse was contacted and returned no benefits — or none was reachable
 */
export type SourceKind = "live" | "test" | "mock" | "none";

export interface VerificationProvenance {
  kind: SourceKind;
  /** The badge text. Short enough for a card, unambiguous enough to act on. */
  label: string;
  /**
   * The same answer at worklist width, where the full label does not fit.
   *
   * Derived from the same evidence rather than truncated from `label`, because the two labels that
   * shorten to the same prefix are exactly the two that must not be confused: a 271 that named its
   * environment and one that did not both begin "REAL STEDI", and clipping would turn the second
   * into a claim the record cannot support.
   */
  shortLabel: string;
  /** One sentence a person can read without knowing what a 271 is. */
  explanation: string;
  /** The record's own stamp, surfaced verbatim because the user asked to see this exact field. */
  dataSource: VerificationRecord["dataSource"];
  payerId: string | null;
  payerName: string | null;
  /** `null` when no clearinghouse was involved, so the UI can omit the row rather than print "—". */
  clearinghouseName: string | null;
  clearinghouseId: string | null;
  memberId: string | null;
  status: VerificationRecord["status"];
  eligibility: "active" | "inactive" | "unknown" | null;
  benefitsRetrieved: boolean;
  /** Why benefits are absent, when they are. Empty string when they are present. */
  benefitsNote: string;
  /** Deductible and annual maximum as "$X / $Y remaining", or null when no benefits came back. */
  deductible: string | null;
  annualMaximum: string | null;
  /**
   * What is financially exposed by this record, in cents.
   *
   * The patient's share once an estimate exists, because that is the number a person is quoted and
   * the number that is wrong if the benefits behind it are wrong. Before an estimate exists it is
   * the plan's total fee — the amount still entirely undetermined. Null when there is neither.
   */
  amountAtStake: number | null;
  amountAtStakeLabel: string;
  /** Bytes of retained 271, and whether it is a real one. Provenance for anyone who wants to look. */
  raw271Bytes: number | null;
  /**
   * Benefit segments the payer stated for a scope this quote did not use (M24, instance 4).
   *
   * Null means nothing ever counted them — an older record, or no adapter answered. Zero means the
   * payer offered nothing that was discarded. Both are surfaced rather than collapsed, for the same
   * reason V6 is in this file's sibling findings: a field that is always empty is indistinguishable
   * from a payer who never spoke unless the two are kept apart.
   */
  supersededBenefits: number | null;
  /**
   * One sentence for a coordinator, or empty when there is nothing to say.
   *
   * ── THIS IS A DISCLOSURE, NOT A GATE ───────────────────────────────────────────────────────────
   * It changes no status, no routing and no confidence score. The quoted scope is the correct one —
   * the practice's own network participation decides which column of the 271 is read, and that
   * decision is not in doubt here. What this says is only that the payer ALSO described another
   * scope, which is a fact worth a person's eyes before a patient is quoted a number.
   *
   * Whether it should ever escalate to a review-routing exception is a policy question about staff
   * workload, and it is deliberately not answered here.
   */
  supersededNote: string;
}

/** ISA13 element 15 carries `T` for test and `P` for production. */
const ISA_USAGE = /\*([TP])\*[^*~]*~\s*GS/;

export function verificationProvenance(record: VerificationRecord): VerificationProvenance {
  const benefits = record.benefits;
  const raw = record.raw271 ?? null;
  const clearinghouseId = clearinghouseIdFor(record.payerId);

  /**
   * A 271 was retained, so a clearinghouse answered — whatever it said.
   *
   * Checked by shape rather than by length: an adapter that stores an error envelope, or a
   * truncated response, must not be read as a payer transmission.
   */
  const has271 = Boolean(raw && /ST\*271\*/.test(raw));
  const usage = raw?.match(ISA_USAGE)?.[1] ?? null;
  const wentToClearinghouse = record.dataSource === "edi";

  const kind: SourceKind = !wentToClearinghouse
    ? record.dataSource === "mock"
      ? "mock"
      : "none"
    : benefits
      ? usage === "P"
        ? "live"
        : "test"
      : "none";

  const payerName = benefits?.payerName ?? record.card.payerName.value ?? null;

  return {
    kind,
    label: labelFor(kind, has271, usage),
    shortLabel: shortLabelFor(kind, has271, usage),
    explanation: explanationFor(kind, record, payerName, clearinghouseId, usage),
    dataSource: record.dataSource,
    payerId: record.payerId,
    payerName,
    clearinghouseName: wentToClearinghouse && clearinghouseId ? CLEARINGHOUSE_NAME : null,
    clearinghouseId: wentToClearinghouse ? clearinghouseId : null,
    memberId: record.card.memberId.value ?? record.patient.memberId ?? null,
    status: record.status,
    eligibility: benefits?.eligibility ?? null,
    benefitsRetrieved: benefits !== null,
    benefitsNote: benefits ? "" : missingBenefitsNote(record, wentToClearinghouse, has271),
    deductible: benefits
      ? `${formatUsdOrUnknown(benefits.deductible.individualAnnual)} / ${formatUsdOrUnknown(benefits.deductible.remaining)} remaining`
      : null,
    annualMaximum: benefits
      ? `${formatUsdOrUnknown(benefits.annualMaximum.amount)} / ${formatUsdOrUnknown(benefits.annualMaximum.remaining)} remaining`
      : null,
    amountAtStake: amountAtStake(record),
    amountAtStakeLabel: record.calculation ? "patient's share" : "unpriced treatment plan",
    raw271Bytes: raw ? raw.length : null,
    supersededBenefits: record.supersededBenefits ?? null,
    supersededNote: supersededNote(record.supersededBenefits ?? null),
  };
}

/**
 * What the payer said that this quote did not use. Empty when there is nothing to disclose.
 *
 * Says "another coverage scope" rather than naming family or out-of-network, because the count is
 * all `parse271` records — it does not keep which scope lost. Naming one would be a guess, and a
 * guess in a sentence a coordinator reads before quoting a patient is exactly the wrong place.
 */
function supersededNote(count: number | null): string {
  if (count === null || count === 0) return "";
  return (
    `The payer also stated ${count} benefit ${count === 1 ? "segment" : "segments"} for another ` +
    `coverage scope, which this quote did not use. The scope quoted here is the one this practice's ` +
    `network participation selects — check the patient's before quoting them.`
  );
}

function amountAtStake(record: VerificationRecord): number | null {
  if (record.calculation) return record.calculation.totalPatientPays;
  const fee = record.planItems.reduce((sum, item) => sum + (item.fee ?? 0) * item.quantity, 0);
  return fee > 0 ? fee : null;
}

function labelFor(kind: SourceKind, has271: boolean, usage: string | null): string {
  switch (kind) {
    case "live":
      return `REAL ${CLEARINGHOUSE_NAME.toUpperCase()} — LIVE PAYER`;
    case "test":
      // Only claim "TEST" when the 271 itself said so. A response with benefits but no readable ISA
      // is still a real clearinghouse answer, and calling it a test would be a guess in the
      // reassuring direction — the one direction a provenance label must never guess.
      return has271 && usage === "T"
        ? `REAL ${CLEARINGHOUSE_NAME.toUpperCase()} TEST`
        : `REAL ${CLEARINGHOUSE_NAME.toUpperCase()} — ENVIRONMENT UNCONFIRMED`;
    case "mock":
      return "DEMO DATA — MOCK CONNECTOR";
    case "none":
      return "NO BENEFITS RETRIEVED";
  }
}

function shortLabelFor(kind: SourceKind, has271: boolean, usage: string | null): string {
  switch (kind) {
    case "live":
      return "LIVE PAYER";
    case "test":
      // "ENV UNKNOWN" rather than a shortened "REAL STEDI": at eleven characters the honest answer
      // still fits, and there is no version of this badge worth shortening into an overstatement.
      return has271 && usage === "T" ? `${CLEARINGHOUSE_NAME.toUpperCase()} TEST` : "ENV UNKNOWN";
    case "mock":
      return "DEMO DATA";
    case "none":
      return "NO BENEFITS";
  }
}

function explanationFor(
  kind: SourceKind,
  record: VerificationRecord,
  payerName: string | null,
  clearinghouseId: string | null,
  usage: string | null
): string {
  const who = payerName ?? "the payer";
  switch (kind) {
    case "live":
      return `${who} answered a real eligibility request through ${CLEARINGHOUSE_NAME} (payer id ${clearinghouseId}) in production.`;
    case "test":
      return (
        `${CLEARINGHOUSE_NAME}'s ${usage === "T" ? "TEST environment" : "network"} answered for ${who}` +
        `${clearinghouseId ? ` (payer id ${clearinghouseId})` : ""}. ` +
        `Sandbox benefits for a published mock member — real transport, not a real person's coverage.`
      );
    case "mock":
      return `Seeded demonstration data. No clearinghouse was contacted and ${who} has confirmed nothing.`;
    case "none":
      return record.dataSource === "edi"
        ? `A request went to ${CLEARINGHOUSE_NAME} but no benefits came back. Nothing here is confirmed coverage.`
        : `No benefits were retrieved. Nothing here is confirmed coverage.`;
  }
}

function missingBenefitsNote(
  record: VerificationRecord,
  wentToClearinghouse: boolean,
  has271: boolean
): string {
  if (!record.payerId) return "No payer connector matched the card, so no eligibility request was sent.";
  if (!wentToClearinghouse) return "No eligibility response was received.";
  if (has271) return "The clearinghouse returned a 271 containing no benefit segments.";
  return "The clearinghouse did not return a usable eligibility response.";
}
