/**
 * The coordination-of-benefits read model the screens and readiness use.
 *
 * ── WHY IT LIVES HERE, IN THE WEB LAYER ────────────────────────────────────────────────────────
 * A case belongs to the Remittance module, where the payer's signal arrives. Its DEADLINE belongs to
 * the Claims module's filing engine, and the payer's own 271 evidence lives on the claim's coverage
 * snapshot. Modules may not import each other; the composition layer may read both, so the join is
 * made here and nowhere else — one place that decides what a screen is told.
 *
 * ── THE DEADLINE IS THE EXISTING ENGINE'S, AND SAYS SO ─────────────────────────────────────────
 * `filingDeadline(serviceDate, payerKey)` is the same policy every claim's filing date uses: the
 * catalogued window for a known payer, the documented default otherwise. It is an ESTIMATE
 * (`FILING_WINDOWS_ARE_PAYER_SOURCED` is false) and every deadline here carries that note. Nothing
 * about secondary filing is invented: no secondary-specific window, no "90 days from the primary's
 * EOB" rule. When the claim predates Mermaid there is no service date, and the deadline is null —
 * reported as unknown rather than guessed.
 */
import { filingDeadline, filingStatus, type FilingStatus } from "@mermaid/claims";
import {
  assignedOf,
  blockedReasonOf,
  crossoverCarrierOf,
  workStatusOf,
  type CoordinationCase,
  type CoverageStatus,
  type SecondaryWorkStatus,
} from "@mermaid/remittance";
import type { Services } from "./wiring.ts";

/** The payer's other-payer statement from a 271, as carried on the claim's coverage snapshot. */
export interface EligibilityOtherPayer {
  role: "primary" | "secondary" | "tertiary" | "unspecified";
  name: string | null;
  idQualifier: string | null;
  id: string | null;
  insuranceType: string | null;
  planDescription: string | null;
}

export interface CoordinationWorkItem {
  caseId: string;
  patientControlNumber: string;
  claimId: string | null;
  primaryPayerName: string;
  serviceDate: string | null;
  coverageStatus: CoverageStatus;
  workStatus: SecondaryWorkStatus;
  /** Money assigned to another plan. Tracked and at risk — never collected. */
  assignedCents: number;
  assignedPosted: boolean;
  forwarded: boolean;
  crossoverCarrier: ReturnType<typeof crossoverCarrierOf>;
  /** The payer's 271 said the patient has another plan — evidence for a person, never a decision. */
  eligibilityOtherPayers: EligibilityOtherPayer[];
  blockedReason: string | null;
  /** When the secondary claim must be filed by — null when there is no secondary work or no service date. */
  deadline: FilingStatus | null;
  /** The remittance to open for this case — the most recent live advice that raised it. */
  remittanceId: string | null;
  case: CoordinationCase;
}

const OPEN_WORK: readonly SecondaryWorkStatus[] = ["awaiting-coverage", "ready-to-file", "return-to-primary", "filed"];

/** Whether this case still needs a person: coverage unanswered, or secondary work not finished. */
export function isOpen(item: Pick<CoordinationWorkItem, "coverageStatus" | "workStatus">): boolean {
  return item.coverageStatus === "unconfirmed" || OPEN_WORK.includes(item.workStatus);
}

export async function coordinationWorkItem(
  c: CoordinationCase,
  services: Services,
  now: Date = new Date()
): Promise<CoordinationWorkItem> {
  const work = workStatusOf(c);
  const assigned = assignedOf(c);
  const hasWork = work !== "not-needed";
  const secondaryKey = c.confirmation?.secondary?.payerId ?? null;
  const deadline =
    hasWork && c.serviceDate
      ? filingStatus(filingDeadline(c.serviceDate, secondaryKey), now, services.timeZone ?? "UTC")
      : null;

  let eligibilityOtherPayers: EligibilityOtherPayer[] = [];
  if (c.claimId) {
    const claim = await services.claims.get(c.claimId).catch(() => null);
    const benefits = (claim as { claim?: { coverageSnapshot?: { benefits?: { otherPayers?: EligibilityOtherPayer[] } } } } | null)
      ?.claim?.coverageSnapshot?.benefits;
    eligibilityOtherPayers = benefits?.otherPayers ?? [];
  }

  const live = [...c.evidence]
    .filter((e) => e.remittanceStatus !== "rejected")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  return {
    caseId: c.id,
    patientControlNumber: c.patientControlNumber,
    claimId: c.claimId,
    primaryPayerName: c.primaryPayerName,
    serviceDate: c.serviceDate,
    coverageStatus: c.coverageStatus,
    workStatus: work,
    assignedCents: assigned.cents,
    assignedPosted: assigned.posted,
    forwarded: live.some((e) => e.forwarded),
    crossoverCarrier: crossoverCarrierOf(c),
    eligibilityOtherPayers,
    blockedReason: blockedReasonOf(c),
    deadline,
    remittanceId: live[0]?.remittanceId ?? c.evidence[0]?.remittanceId ?? null,
    case: c,
  };
}

export async function listCoordinationWork(services: Services, now: Date = new Date()): Promise<CoordinationWorkItem[]> {
  const items: CoordinationWorkItem[] = [];
  for (const c of await services.remittance.listCoordinationCases()) {
    items.push(await coordinationWorkItem(c, services, now));
  }
  return items;
}
