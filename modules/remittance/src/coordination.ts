/**
 * Coordination of benefits — the case a payer opens when it says another plan is involved.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────────────
 * A payer signals another plan two ways: CLP02 19/20 ("forwarded to another payer") and OA-23
 * money ("the impact of another payer's adjudication"). The safety gate held such an advice — and
 * then let ANY free-text reason release it. On staging three advices held for exactly this were
 * released with "Reconciled against the payer's paper EOB", which answers a different question;
 * six more had $1,527.01 assigned to another plan with no secondary plan recorded anywhere and no
 * work item for anyone to file it; and nothing in Mermaid could say whether a second plan existed:
 * `coverages.cob_order` is never written (always 1), the 271 parser ignored the payer's
 * other-payer loop, and the 835 parser ignored the crossover carrier.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────────────────────────
 * One case per claim, opened by the payer's signal and carrying three things:
 *
 *   • EVIDENCE — every advice that carried the signal, with the payer's own words: forwarded or
 *     not, the amount assigned to the other plan, and the crossover carrier when the payer named
 *     one. Pointers to the retained 835, never a paraphrase that could drift from it.
 *   • COVERAGE — whether the patient has another plan, answered by a PERSON from a named source on
 *     a stated date. Never inferred: not from `cob_order`, not from the absence of a second
 *     coverage row, not from a payer's 271 suggestion on its own.
 *   • SECONDARY WORK — when money was assigned to another plan, the claim someone has to file for
 *     it, as explicit states with a deadline, not a sentence on a screen.
 *
 * Pure: every rule below is a function of its inputs. The service does the I/O; the web layer
 * computes the deadline with the claims module's existing filing engine.
 */
import { addCents, type Cents } from "@mermaid/shared";

export type CoverageStatus = "unconfirmed" | "no-other-coverage" | "other-coverage";

/**
 * Where the secondary claim stands. DERIVED from the case (see `workStatusOf`), never set
 * directly — a status that could be written independently of the facts it summarises is a status
 * that will one day disagree with them.
 *
 *   not-needed        no money was assigned to another plan (R1's shape: forwarded, $0)
 *   awaiting-coverage money is assigned, and nobody has established whether another plan exists
 *   ready-to-file     another plan is confirmed and recorded — file the secondary claim
 *   return-to-primary the patient has NO other plan, so the primary withheld money for a plan that
 *                     does not exist — ask the primary to correct its coordination record
 *   filed             the secondary claim was filed; waiting on that payer
 *   closed            finished, with a stated outcome
 */
export type SecondaryWorkStatus =
  | "not-needed"
  | "awaiting-coverage"
  | "ready-to-file"
  | "return-to-primary"
  | "filed"
  | "closed";

/** Where a person got the answer. `eligibility-response` = the payer's own 271, reviewed by a person. */
export type EvidenceSource = "payer-portal" | "payer-phone" | "patient" | "eligibility-response" | "other";
export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  "payer-portal",
  "payer-phone",
  "patient",
  "eligibility-response",
  "other",
];

export type CloseOutcome = "secondary-paid" | "secondary-denied" | "primary-reprocessed" | "written-off";

/** NM1*TT in the 835's claim loop — the plan the payer says it forwarded to. Only what was sent. */
export interface CrossoverCarrier {
  name: string;
  idQualifier: string | null;
  id: string | null;
}

/** One advice that carried the signal. A pointer to the payer's own file, not a summary of it. */
export interface CoordinationEvidence {
  remittanceId: string;
  traceNumber: string;
  payerName: string;
  receivedAt: string;
  /** The advice's current standing — a rejected copy stops counting, but stays on the record. */
  remittanceStatus: "held" | "posted" | "rejected";
  forwarded: boolean;
  assignedCents: Cents;
  crossoverCarrier: CrossoverCarrier | null;
}

export interface SecondaryPlan {
  payerName: string;
  /** Mermaid's payer key, when the plan is in the catalog. Null is honest; a guess is not. */
  payerId: string | null;
  memberId: string;
}

export interface CoverageConfirmation {
  outcome: "no-other-coverage" | "other-coverage";
  source: EvidenceSource;
  sourceNote: string | null;
  /** The calendar day the answer was obtained — YYYY-MM-DD, never in the future. */
  confirmedOn: string;
  confirmedBy: string;
  recordedAt: string;
  secondary: SecondaryPlan | null;
}

/** "I asked, and I am waiting" — the difference between a pending answer and a neglected one. */
export interface ConfirmationRequest {
  from: "patient" | "payer";
  requestedOn: string;
  followUpBy: string;
  requestedBy: string;
  recordedAt: string;
}

export interface SecondaryFiling {
  filedOn: string;
  reference: string | null;
  filedBy: string;
  recordedAt: string;
}

export interface SecondaryClosure {
  outcome: CloseOutcome;
  note: string;
  closedBy: string;
  closedAt: string;
}

export interface CoordinationHistoryEntry {
  at: string;
  actor: string;
  message: string;
}

export interface CoordinationCase {
  id: string;
  patientControlNumber: string;
  claimId: string | null;
  /** The payer that raised the signal. */
  primaryPayerName: string;
  /** From the claim the practice filed. Null when the claim predates Mermaid — then no deadline. */
  serviceDate: string | null;
  evidence: CoordinationEvidence[];
  coverageStatus: CoverageStatus;
  confirmation: CoverageConfirmation | null;
  request: ConfirmationRequest | null;
  filing: SecondaryFiling | null;
  closure: SecondaryClosure | null;
  createdAt: string;
  updatedAt: string;
  history: CoordinationHistoryEntry[];
}

/** A refusal of a coordination action — a decision with a reason, never an upstream failure. */
export class CoordinationRefusedError extends Error {
  code: string;
  /** What is missing, item by item — so the screen can say exactly what to supply. */
  missing: string[];
  constructor(code: string, message: string, missing: string[] = []) {
    super(message);
    this.name = "CoordinationRefusedError";
    this.code = code;
    this.missing = missing;
  }
}

// ── Derived facts ──────────────────────────────────────────────────────────────────────────────

/**
 * The money assigned to another plan, as the payer's CURRENT word on it.
 *
 * From the most recent POSTED advice when there is one — posted money is what is on the books —
 * otherwise from the most recent held advice, which is money announced but not yet accepted.
 * Rejected advices never count: a rejected duplicate that said "$482.51 to another plan" is a copy
 * of an advice that already said it, and counting both would double the work.
 */
export function assignedOf(c: Pick<CoordinationCase, "evidence">): { cents: Cents; posted: boolean } {
  const live = c.evidence.filter((e) => e.remittanceStatus !== "rejected");
  const latest = (status: "posted" | "held") =>
    live
      .filter((e) => e.remittanceStatus === status)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
  const posted = latest("posted");
  if (posted) return { cents: posted.assignedCents, posted: true };
  const held = latest("held");
  return { cents: held ? held.assignedCents : (0 as Cents), posted: false };
}

export function workStatusOf(c: CoordinationCase): SecondaryWorkStatus {
  if (c.closure) return "closed";
  if (assignedOf(c).cents <= 0) return "not-needed";
  if (c.filing) return "filed";
  if (c.coverageStatus === "unconfirmed") return "awaiting-coverage";
  return c.coverageStatus === "other-coverage" ? "ready-to-file" : "return-to-primary";
}

/** The crossover carrier the payer named most recently, or null when no advice named one. */
export function crossoverCarrierOf(c: Pick<CoordinationCase, "evidence">): CrossoverCarrier | null {
  return (
    [...c.evidence]
      .filter((e) => e.remittanceStatus !== "rejected" && e.crossoverCarrier)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]?.crossoverCarrier ?? null
  );
}

/** Why the secondary claim cannot move, in the words an operator acts on. Null when it can. */
export function blockedReasonOf(c: CoordinationCase): string | null {
  switch (workStatusOf(c)) {
    case "awaiting-coverage":
      return "Nobody has confirmed whether the patient has another plan. Confirm coverage before anything can be filed.";
    case "return-to-primary":
      return (
        "The patient has no other plan, so the primary withheld this money for a plan that does not exist. " +
        "Ask the primary to correct its coordination record and reprocess the claim."
      );
    default:
      return null;
  }
}

// ── Recording what a payer said ────────────────────────────────────────────────────────────────

export interface SignalInput {
  patientControlNumber: string;
  claimId: string | null;
  serviceDate: string | null;
  evidence: CoordinationEvidence;
}

/**
 * Open a case, or add one advice's evidence to it. Idempotent on `remittanceId`: re-recording the
 * same advice REPLACES its entry (its status may have moved held → posted → rejected), never
 * appends a second one — which is what makes a backfill safe to run twice.
 *
 * Never touches a person's decision. Coverage, the request, the filing and the closure are only
 * ever changed by the actions below.
 */
export function recordSignal(existing: CoordinationCase | null, input: SignalInput, id: string, now: Date): CoordinationCase {
  const at = now.toISOString();
  if (!existing) {
    return {
      id,
      patientControlNumber: input.patientControlNumber,
      claimId: input.claimId,
      primaryPayerName: input.evidence.payerName,
      serviceDate: input.serviceDate,
      evidence: [input.evidence],
      coverageStatus: "unconfirmed",
      confirmation: null,
      request: null,
      filing: null,
      closure: null,
      createdAt: at,
      updatedAt: at,
      history: [{ at, actor: "system", message: describeSignal(input.evidence, true) }],
    };
  }
  const prior = existing.evidence.find((e) => e.remittanceId === input.evidence.remittanceId);
  const unchanged = prior !== undefined && canonical(prior) === canonical(input.evidence);
  const filled = {
    claimId: existing.claimId ?? input.claimId,
    serviceDate: existing.serviceDate ?? input.serviceDate,
  };
  if (unchanged && filled.claimId === existing.claimId && filled.serviceDate === existing.serviceDate) {
    return existing;
  }
  return {
    ...existing,
    ...filled,
    evidence: prior
      ? existing.evidence.map((e) => (e.remittanceId === input.evidence.remittanceId ? input.evidence : e))
      : [...existing.evidence, input.evidence],
    updatedAt: at,
    history: unchanged
      ? existing.history
      : [...existing.history, { at, actor: "system", message: describeSignal(input.evidence, !prior) }],
  };
}

/**
 * A key-order-independent rendering, for "is this the same evidence?". Postgres JSONB does not keep
 * key order, so a case read back from the database stringifies differently from the one the service
 * just built — and a plain JSON.stringify comparison would report every re-sync as a change.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function describeSignal(e: CoordinationEvidence, first: boolean): string {
  if (!first) return `Advice ${e.traceNumber} is now ${e.remittanceStatus}.`;
  const parts = [
    e.forwarded ? `${e.payerName} said it forwarded the claim to another plan` : `${e.payerName} did not say it forwarded the claim`,
    e.assignedCents > 0 ? `and assigned $${(e.assignedCents / 100).toFixed(2)} to another plan's adjudication` : "and assigned no money to another plan",
  ];
  const carrier = e.crossoverCarrier ? ` It named the other plan: ${e.crossoverCarrier.name}.` : " It did not name the other plan.";
  return `Advice ${e.traceNumber}: ${parts.join(" ")}.${carrier}`;
}

// ── A person's decisions ───────────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && ISO_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** Today in UTC plus one day of slack, the same allowance the payment-date gate makes for time zones. */
const latestAcceptableDay = (now: Date) => new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export interface ConfirmCoverageInput {
  outcome?: unknown;
  source?: unknown;
  sourceNote?: unknown;
  confirmedOn?: unknown;
  secondary?: { payerName?: unknown; payerId?: unknown; memberId?: unknown } | null;
}

/**
 * Everything a coverage confirmation is missing, as sentences a person can act on. Empty = complete.
 *
 * Checked together rather than one at a time, so a person is told everything at once instead of
 * discovering the requirements one refusal at a time.
 */
export function missingForConfirmation(input: ConfirmCoverageInput, now: Date): string[] {
  const missing: string[] = [];
  const outcome = input.outcome;
  if (outcome !== "no-other-coverage" && outcome !== "other-coverage") {
    missing.push("Whether the patient has another plan: choose “No other coverage confirmed” or “Other coverage exists”.");
  }
  if (!EVIDENCE_SOURCES.includes(input.source as EvidenceSource)) {
    missing.push("Where the answer came from: payer portal, payer phone call, the patient, the payer's eligibility response, or other.");
  } else if (input.source === "other" && !text(input.sourceNote)) {
    missing.push("A description of the source — “other” needs to say what it was.");
  }
  if (!isDay(input.confirmedOn)) {
    missing.push("The date the answer was obtained.");
  } else if ((input.confirmedOn as string) > latestAcceptableDay(now)) {
    missing.push("A confirmation date that is not in the future.");
  }
  if (outcome === "other-coverage") {
    if (!text(input.secondary?.payerName)) missing.push("The other plan's payer name.");
    if (!text(input.secondary?.memberId)) missing.push("The patient's member ID on the other plan.");
  }
  return missing;
}

/**
 * Record a person's answer to "does this patient have another plan?".
 *
 * One-way from `unconfirmed`. A second confirmation over the first would silently rewrite the
 * evidence a secondary claim — or a release — was decided on; correcting a wrong answer is a
 * separate, deliberate act this system does not yet offer, and refusing is the safe default.
 *
 * Creates no coverage row and writes no `cob_order`. The confirmation is evidence on the case; a
 * new plan becomes a coverage record through the ordinary verification of its card.
 */
export function confirmCoverage(c: CoordinationCase, input: ConfirmCoverageInput, actor: string, now: Date): CoordinationCase {
  if (c.coverageStatus !== "unconfirmed") {
    throw new CoordinationRefusedError(
      "already-confirmed",
      `Coverage for claim ${c.patientControlNumber} was already confirmed as ${c.coverageStatus.replaceAll("-", " ")} on ` +
        `${c.confirmation?.confirmedOn}. A confirmation is not overwritten.`
    );
  }
  if (!actor.trim()) throw new CoordinationRefusedError("validation_error", "A confirming user is required.", ["Who confirmed it."]);
  const missing = missingForConfirmation(input, now);
  if (missing.length > 0) {
    throw new CoordinationRefusedError(
      "coverage-evidence-missing",
      `Coverage for claim ${c.patientControlNumber} cannot be confirmed yet. Missing: ${missing.join(" ")}`,
      missing
    );
  }
  const outcome = input.outcome as CoverageConfirmation["outcome"];
  const secondary: SecondaryPlan | null =
    outcome === "other-coverage"
      ? {
          payerName: text(input.secondary!.payerName),
          payerId: text(input.secondary!.payerId) || null,
          memberId: text(input.secondary!.memberId),
        }
      : null;
  const at = now.toISOString();
  const confirmation: CoverageConfirmation = {
    outcome,
    source: input.source as EvidenceSource,
    sourceNote: text(input.sourceNote) || null,
    confirmedOn: input.confirmedOn as string,
    confirmedBy: actor.trim(),
    recordedAt: at,
    secondary,
  };
  return {
    ...c,
    coverageStatus: outcome,
    confirmation,
    updatedAt: at,
    history: [
      ...c.history,
      {
        at,
        actor: confirmation.confirmedBy,
        message:
          (outcome === "other-coverage"
            ? `Other coverage confirmed: ${secondary!.payerName}.`
            : "No other coverage confirmed.") +
          ` Source: ${confirmation.source}${confirmation.sourceNote ? ` (${confirmation.sourceNote})` : ""}, obtained ${confirmation.confirmedOn}.`,
      },
    ],
  };
}

export interface RequestInput {
  from?: unknown;
  requestedOn?: unknown;
  followUpBy?: unknown;
}

/**
 * "I have asked the patient / the payer, and I am waiting until …". Only while unconfirmed.
 *
 * This is what separates a pending answer from a neglected one in readiness: a request with a
 * follow-up date in the future is somebody's work in progress; no request, or a follow-up date in
 * the past, is money nobody is chasing.
 */
export function requestConfirmation(c: CoordinationCase, input: RequestInput, actor: string, now: Date): CoordinationCase {
  if (c.coverageStatus !== "unconfirmed") {
    throw new CoordinationRefusedError("already-confirmed", "Coverage is already confirmed; there is nothing left to request.");
  }
  const missing: string[] = [];
  if (input.from !== "patient" && input.from !== "payer") missing.push("Who was asked: the patient or the payer.");
  if (!isDay(input.requestedOn)) missing.push("The date it was asked.");
  else if ((input.requestedOn as string) > latestAcceptableDay(now)) missing.push("A request date that is not in the future.");
  if (!isDay(input.followUpBy)) missing.push("The date to follow up by.");
  else if (isDay(input.requestedOn) && (input.followUpBy as string) < (input.requestedOn as string)) {
    missing.push("A follow-up date on or after the request date.");
  }
  if (!actor.trim()) missing.push("Who asked.");
  if (missing.length > 0) {
    throw new CoordinationRefusedError("request-incomplete", `The request cannot be recorded. Missing: ${missing.join(" ")}`, missing);
  }
  const at = now.toISOString();
  const request: ConfirmationRequest = {
    from: input.from as ConfirmationRequest["from"],
    requestedOn: input.requestedOn as string,
    followUpBy: input.followUpBy as string,
    requestedBy: actor.trim(),
    recordedAt: at,
  };
  return {
    ...c,
    request,
    updatedAt: at,
    history: [
      ...c.history,
      { at, actor: request.requestedBy, message: `Asked the ${request.from} about other coverage on ${request.requestedOn}; follow up by ${request.followUpBy}.` },
    ],
  };
}

export interface FilingInput {
  filedOn?: unknown;
  reference?: unknown;
}

/** The secondary claim was filed. Only from `ready-to-file` — there is nowhere to file it before. */
export function markSecondaryFiled(c: CoordinationCase, input: FilingInput, actor: string, now: Date): CoordinationCase {
  const status = workStatusOf(c);
  if (status !== "ready-to-file") {
    throw new CoordinationRefusedError(
      "invalid-transition",
      status === "awaiting-coverage"
        ? "The secondary claim cannot be filed until other coverage is confirmed and the plan recorded."
        : `There is no secondary claim to file: this work is ${status.replaceAll("-", " ")}.`
    );
  }
  const missing: string[] = [];
  if (!isDay(input.filedOn)) missing.push("The date the secondary claim was filed.");
  else if ((input.filedOn as string) > latestAcceptableDay(now)) missing.push("A filing date that is not in the future.");
  if (!actor.trim()) missing.push("Who filed it.");
  if (missing.length > 0) {
    throw new CoordinationRefusedError("filing-incomplete", `The filing cannot be recorded. Missing: ${missing.join(" ")}`, missing);
  }
  const at = now.toISOString();
  const filing: SecondaryFiling = {
    filedOn: input.filedOn as string,
    reference: text(input.reference) || null,
    filedBy: actor.trim(),
    recordedAt: at,
  };
  return {
    ...c,
    filing,
    updatedAt: at,
    history: [
      ...c.history,
      {
        at,
        actor: filing.filedBy,
        message: `Secondary claim filed with ${c.confirmation?.secondary?.payerName ?? "the other plan"} on ${filing.filedOn}${filing.reference ? ` (reference ${filing.reference})` : ""}.`,
      },
    ],
  };
}

/** Which outcomes can close work in which state. Anything else is refused. */
const CLOSE_FROM: Record<SecondaryWorkStatus, readonly CloseOutcome[]> = {
  "not-needed": [],
  "awaiting-coverage": [],
  "ready-to-file": [],
  "return-to-primary": ["primary-reprocessed", "written-off"],
  filed: ["secondary-paid", "secondary-denied", "written-off"],
  closed: [],
};

export interface CloseInput {
  outcome?: unknown;
  note?: unknown;
}

/**
 * Finish the secondary work with a stated outcome and a note.
 *
 * Moves no money. The money a secondary pays arrives on that payer's own remittance and posts
 * through the ordinary path; closing this records what happened to the work, and a "written-off"
 * closure does not write anything off in the ledger — it says a person decided not to pursue it.
 */
export function closeSecondaryWork(c: CoordinationCase, input: CloseInput, actor: string, now: Date): CoordinationCase {
  const status = workStatusOf(c);
  const allowed = CLOSE_FROM[status];
  if (allowed.length === 0) {
    throw new CoordinationRefusedError(
      "invalid-transition",
      status === "ready-to-file"
        ? "File the secondary claim before closing this work — or confirm that no other plan exists."
        : `This work cannot be closed from ${status.replaceAll("-", " ")}.`
    );
  }
  const missing: string[] = [];
  if (!allowed.includes(input.outcome as CloseOutcome)) {
    missing.push(`An outcome that fits this work: ${allowed.join(", ")}.`);
  }
  if (!text(input.note)) missing.push("A note saying what happened.");
  if (!actor.trim()) missing.push("Who closed it.");
  if (missing.length > 0) {
    throw new CoordinationRefusedError("close-incomplete", `The work cannot be closed. Missing: ${missing.join(" ")}`, missing);
  }
  const at = now.toISOString();
  const closure: SecondaryClosure = {
    outcome: input.outcome as CloseOutcome,
    note: text(input.note),
    closedBy: actor.trim(),
    closedAt: at,
  };
  return {
    ...c,
    closure,
    updatedAt: at,
    history: [...c.history, { at, actor: closure.closedBy, message: `Secondary work closed: ${closure.outcome} — ${closure.note}` }],
  };
}

// ── Reading the signal off an advice ──────────────────────────────────────────────────────────

/** The two signals on one posting: forwarded, and money assigned to another plan. */
export function signalOf(posting: {
  disposition: string;
  adjustments: readonly { category: string; amount: number }[];
  variance?: { coordinationAmount?: number } | null;
}): { forwarded: boolean; assignedCents: Cents } | null {
  const forwarded = posting.disposition === "forwarded";
  const fromAdjustments = addCents(
    ...posting.adjustments.filter((a) => a.category === "coordination").map((a) => a.amount as Cents)
  );
  const assignedCents = (posting.variance?.coordinationAmount ?? fromAdjustments) as Cents;
  if (!forwarded && assignedCents === 0) return null;
  return { forwarded, assignedCents: Math.max(0, assignedCents) as Cents };
}
