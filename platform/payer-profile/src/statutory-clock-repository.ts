/**
 * The store behind the statutory clock (F5, migration 0031).
 *
 * Three responsibilities, and the first is the one that is easy to miss.
 *
 * ── 1. REMEMBERING WHEN EACH CLAIM WAS PAID ────────────────────────────────────────────────────
 * A recoupment window is measured from the day the practice was PAID, and a PLB `WO` arriving today
 * names a claim that may have been paid two years ago. Nothing in this system could answer "when
 * were we paid for control number MRM-000123?" without reading whole remittance aggregates — each
 * carrying postings and an encrypted raw 835 — so the clock keeps its own narrow index: control
 * number, payer, date, amount. One row per claim payment, and nothing else.
 *
 * It follows that the window can only be dated for claims paid since this was switched on. That is
 * a real limitation and it produces a REFUSAL rather than a guess: `original-payment-unknown`. A
 * takeback we cannot date is one we cannot say is late.
 *
 * ── 2. THE FINDINGS ────────────────────────────────────────────────────────────────────────────
 * Keyed so that an at-least-once bus cannot create a second demand for the same money. Prompt-pay
 * is keyed on `(remittance, claim)`; recoupment on `(remittance, reference)` — a payer can take
 * back several claims on one advice, and each is its own dispute.
 *
 * ── 3. CLAIMED IS NOT RECOVERED ────────────────────────────────────────────────────────────────
 * Two figures per finding and they never merge. `claimedCents` is arithmetic this system performed;
 * `recoveredCents` is cash that arrived, recorded by a person who saw it. A savings report that
 * added the first into the second would tell a practice owner it had collected money nobody has
 * sent — which is the specific failure that makes a savings number untrustworthy forever after the
 * first time someone checks it against the bank.
 *
 * ── SHADOW MODE ────────────────────────────────────────────────────────────────────────────────
 * Nothing here alters a posting, a balance or a ledger entry. It observes, records, and waits to be
 * read.
 */
import { execute, many, one, practiceId, tx } from "@mermaid/db";
import { addCents, type Cents } from "@mermaid/shared";
import type { DeadlinePassedFinding, PromptPayFinding, RecoupmentFinding } from "./statutory-clock.ts";

/** One claim payment, remembered only so a later takeback against it can be dated. */
export interface ClaimPaymentRecord {
  patientControlNumber: string;
  payerId: string | null;
  payerName: string;
  paidAt: string;
  paidCents: Cents;
  remittanceId: string;
}

export type ClockFindingKind =
  | "prompt-pay-interest"
  | "recoupment-out-of-time"
  /** The payer never answered at all, and the statutory deadline has passed. Carries NO amount. */
  | "prompt-pay-deadline-passed";

export interface StoredClockFinding {
  remittanceId: string;
  kind: ClockFindingKind;
  /** The claim control number for prompt-pay; the PLB reference for a recoupment. */
  subject: string;
  payerId: string | null;
  payerName: string;
  state: string;
  /** What this system says is owed or disputable. Arithmetic, not cash. */
  claimedCents: Cents;
  /** Cash that actually came back, recorded by a person. Starts at zero and only a person moves it. */
  recoveredCents: Cents;
  citation: string;
  source: string;
  verifiedOn: string;
  action: string;
  defeasibleBy: readonly string[];
  /** The engine's working, kept so the number in a demand letter can be re-derived. */
  evidence: Record<string, unknown>;
  detectedAt: string;
  /** Set when a person closes the finding out. */
  outcome: "open" | "recovered" | "written-off" | "not-pursued";
  outcomeNote: string | null;
}

export interface ClockSavings {
  promptPay: { findings: number; claimedCents: Cents; recoveredCents: Cents };
  recoupment: { findings: number; claimedCents: Cents; recoveredCents: Cents };
  /**
   * Claims the payer never answered, past their statutory deadline.
   *
   * A COUNT and no money, deliberately, and the shape is the point. Interest accrues on the
   * amount ultimately paid, which nobody knows while the claim is unanswered — so there is no
   * honest figure to total. `estimatedExposure` sits in each finding's evidence, labelled as this
   * system's own estimate, and it is kept out of here so it can never be added to measured
   * interest and reported as one number.
   */
  deadlinesPassed: { findings: number };
}

export interface StatutoryClockRepository {
  /** Remember a claim payment so a later takeback against it can be dated. Idempotent. */
  recordPayment(payment: ClaimPaymentRecord): Promise<void>;
  /** When were we paid for this control number? Null when this system never saw the payment. */
  paymentFor(patientControlNumber: string): Promise<ClaimPaymentRecord | null>;
  /** Record a finding. Idempotent on `(remittance, kind, subject)`. */
  record(finding: StoredClockFinding): Promise<void>;
  findings(options?: { kind?: ClockFindingKind; openOnly?: boolean; limit?: number }): Promise<StoredClockFinding[]>;
  /**
   * What a person concluded. The ONLY way `recoveredCents` ever moves off zero.
   *
   * Returns null when the finding is not there, rather than creating one — an outcome for a finding
   * nobody raised is a savings figure with no evidence under it.
   */
  recordOutcome(
    key: { remittanceId: string; kind: ClockFindingKind; subject: string },
    outcome: { outcome: StoredClockFinding["outcome"]; recoveredCents: Cents; note: string | null }
  ): Promise<StoredClockFinding | null>;
  savings(): Promise<ClockSavings>;
}

const ZERO = 0 as Cents;

/**
 * Fold findings into the savings report, shared by both stores so they cannot answer differently.
 *
 * Counts every finding including closed ones, deliberately. A savings report that silently dropped
 * the ones written off would report a recovery rate of 100% forever.
 */
export function foldSavings(findings: readonly StoredClockFinding[]): ClockSavings {
  const bucket = (kind: ClockFindingKind) => {
    const rows = findings.filter((f) => f.kind === kind);
    return {
      findings: rows.length,
      claimedCents: addCents(...rows.map((r) => r.claimedCents)),
      recoveredCents: addCents(...rows.map((r) => r.recoveredCents)),
    };
  };
  return {
    promptPay: bucket("prompt-pay-interest"),
    recoupment: bucket("recoupment-out-of-time"),
    deadlinesPassed: { findings: findings.filter((f) => f.kind === "prompt-pay-deadline-passed").length },
  };
}

/** Build a storable finding from what the engine returned. Shared so both callers agree on shape. */
export function toStored(
  finding: PromptPayFinding | RecoupmentFinding | DeadlinePassedFinding,
  context: {
    remittanceId: string;
    subject: string;
    payerId: string | null;
    payerName: string;
    state: string;
    detectedAt: string;
  }
): StoredClockFinding {
  const common = {
    remittanceId: context.remittanceId,
    kind: finding.kind,
    subject: context.subject,
    payerId: context.payerId,
    payerName: context.payerName,
    state: context.state,
    recoveredCents: ZERO,
    citation: finding.citation,
    source: finding.source,
    verifiedOn: finding.verifiedOn,
    action: finding.action,
    defeasibleBy: finding.defeasibleBy,
    detectedAt: context.detectedAt,
    outcome: "open" as const,
    outcomeNote: null,
  };

  /**
   * A deadline finding carries no amount, and the database refuses one
   * (`deadline_findings_claim_no_money`). What the practice is exposed to travels in the evidence,
   * under a name that says whose estimate it is.
   */
  if (finding.kind === "prompt-pay-deadline-passed") {
    return {
      ...common,
      claimedCents: ZERO,
      evidence: {
        elapsedDays: finding.elapsedDays,
        allowedDays: finding.allowedDays,
        daysPastDeadline: finding.daysPastDeadline,
        estimatedExposure: finding.estimatedExposure,
      },
    };
  }

  return finding.kind === "prompt-pay-interest"
    ? {
        ...common,
        claimedCents: finding.interestCents,
        evidence: {
          elapsedDays: finding.elapsedDays,
          allowedDays: finding.allowedDays,
          lateDays: finding.lateDays,
          principal: finding.principal,
          rateBps: finding.rateBps,
        },
      }
    : {
        ...common,
        claimedCents: finding.disputableCents,
        evidence: {
          daysSinceOriginalPayment: finding.daysSinceOriginalPayment,
          windowDays: finding.windowDays,
          windowStated: finding.windowStated,
        },
      };
}

const findingKey = (f: { remittanceId: string; kind: string; subject: string }): string =>
  `${f.remittanceId}${f.kind}${f.subject}`;

// ── In-memory ───────────────────────────────────────────────────────────────────────────────────

export class InMemoryStatutoryClockRepository implements StatutoryClockRepository {
  #payments = new Map<string, ClaimPaymentRecord>();
  #findings = new Map<string, StoredClockFinding>();

  async recordPayment(payment: ClaimPaymentRecord): Promise<void> {
    /**
     * First payment wins. The window runs from when the practice was paid, and a supplemental cheque
     * on the same claim months later is not that date — overwriting would silently RESTART the
     * window and hand the payer months it is not entitled to.
     */
    if (this.#payments.has(payment.patientControlNumber)) return;
    this.#payments.set(payment.patientControlNumber, { ...payment });
  }

  async paymentFor(patientControlNumber: string): Promise<ClaimPaymentRecord | null> {
    const row = this.#payments.get(patientControlNumber);
    return row ? { ...row } : null;
  }

  async record(finding: StoredClockFinding): Promise<void> {
    const key = findingKey(finding);
    const existing = this.#findings.get(key);
    /**
     * A redelivery must not reopen a finding a person has already closed, or reset the cash they
     * recorded against it. The arithmetic is refreshed; the human's conclusion is not.
     */
    this.#findings.set(key, {
      ...finding,
      recoveredCents: existing?.recoveredCents ?? ZERO,
      outcome: existing?.outcome ?? "open",
      outcomeNote: existing?.outcomeNote ?? null,
    });
  }

  async findings(
    options: { kind?: ClockFindingKind; openOnly?: boolean; limit?: number } = {}
  ): Promise<StoredClockFinding[]> {
    let rows = [...this.#findings.values()];
    if (options.kind) rows = rows.filter((f) => f.kind === options.kind);
    if (options.openOnly) rows = rows.filter((f) => f.outcome === "open");
    rows.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async recordOutcome(
    key: { remittanceId: string; kind: ClockFindingKind; subject: string },
    outcome: { outcome: StoredClockFinding["outcome"]; recoveredCents: Cents; note: string | null }
  ): Promise<StoredClockFinding | null> {
    const existing = this.#findings.get(findingKey(key));
    if (!existing) return null;
    const updated: StoredClockFinding = {
      ...existing,
      outcome: outcome.outcome,
      recoveredCents: outcome.recoveredCents,
      outcomeNote: outcome.note,
    };
    this.#findings.set(findingKey(key), updated);
    return updated;
  }

  async savings(): Promise<ClockSavings> {
    return foldSavings([...this.#findings.values()]);
  }
}

// ── Postgres ────────────────────────────────────────────────────────────────────────────────────

interface PaymentRow {
  patient_control_number: string;
  payer_id: string | null;
  payer_name: string;
  paid_at: Date | string;
  paid_cents: string | number;
  remittance_id: string;
}

interface FindingRow {
  remittance_id: string;
  kind: ClockFindingKind;
  subject: string;
  payer_id: string | null;
  payer_name: string;
  state: string;
  claimed_cents: string | number;
  recovered_cents: string | number;
  citation: string;
  source: string;
  verified_on: Date | string;
  action: string;
  defeasible_by: string[];
  evidence: Record<string, unknown>;
  detected_at: Date | string;
  outcome: StoredClockFinding["outcome"];
  outcome_note: string | null;
}

/** An instant. `toISOString` is right here: a TIMESTAMPTZ is a moment, and UTC is its canonical form. */
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * A CALENDAR DAY, which is not an instant, and must never be read back through one.
 *
 * `paid_at` and `verified_on` are `DATE` columns. `platform/db/pool.ts` pins OID 1082 to hand back
 * the plain `YYYY-MM-DD` string Postgres stores, precisely so this cannot go wrong — so the string
 * branch is the one that runs in this system, and slicing it is exact.
 *
 * The `Date` branch exists for the case that parser does not: node-postgres would otherwise build a
 * `Date` at LOCAL midnight, and `toISOString()` on that converts through UTC — which moves the day
 * backwards for every practice west of Greenwich. Reading 2026-01-05 as 2026-01-04 is a one-day
 * error in the figure a recoupment window is measured from, and the whole dispute turns on which
 * side of the window a takeback fell. So it reads the LOCAL parts, which is the calendar day
 * node-postgres actually encoded.
 */
const day = (v: Date | string): string =>
  typeof v === "string"
    ? v.slice(0, 10)
    : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;

const toPayment = (row: PaymentRow): ClaimPaymentRecord => ({
  patientControlNumber: row.patient_control_number,
  payerId: row.payer_id,
  payerName: row.payer_name,
  paidAt: day(row.paid_at),
  paidCents: Number(row.paid_cents) as Cents,
  remittanceId: row.remittance_id,
});

const toFinding = (row: FindingRow): StoredClockFinding => ({
  remittanceId: row.remittance_id,
  kind: row.kind,
  subject: row.subject,
  payerId: row.payer_id,
  payerName: row.payer_name,
  state: row.state,
  claimedCents: Number(row.claimed_cents) as Cents,
  recoveredCents: Number(row.recovered_cents) as Cents,
  citation: row.citation,
  source: row.source,
  verifiedOn: day(row.verified_on),
  action: row.action,
  defeasibleBy: row.defeasible_by,
  evidence: row.evidence,
  detectedAt: iso(row.detected_at),
  outcome: row.outcome,
  outcomeNote: row.outcome_note,
});

export class PgStatutoryClockRepository implements StatutoryClockRepository {
  async recordPayment(payment: ClaimPaymentRecord): Promise<void> {
    // `DO NOTHING`, not `DO UPDATE`. See the in-memory note: overwriting restarts the window.
    await execute(
      tx(),
      `INSERT INTO claim_payment_clock
         (practice_id, patient_control_number, payer_id, payer_name, paid_at, paid_cents, remittance_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (practice_id, patient_control_number) DO NOTHING`,
      [
        practiceId(),
        payment.patientControlNumber,
        payment.payerId,
        payment.payerName,
        payment.paidAt,
        payment.paidCents,
        payment.remittanceId,
      ]
    );
  }

  async paymentFor(patientControlNumber: string): Promise<ClaimPaymentRecord | null> {
    const row = await one<PaymentRow>(
      tx(),
      `SELECT * FROM claim_payment_clock WHERE patient_control_number = $1`,
      [patientControlNumber]
    );
    return row ? toPayment(row) : null;
  }

  async record(finding: StoredClockFinding): Promise<void> {
    /**
     * The conflict clause refreshes the arithmetic and the provenance, and deliberately does NOT
     * touch `recovered_cents`, `outcome` or `outcome_note` — those are a person's conclusion, and a
     * redelivered event must not reopen a dispute somebody already closed.
     */
    await execute(
      tx(),
      `INSERT INTO statutory_clock_findings
         (practice_id, remittance_id, kind, subject, payer_id, payer_name, state, claimed_cents,
          recovered_cents, citation, source, verified_on, action, defeasible_by, evidence,
          detected_at, outcome, outcome_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,'open',NULL)
       ON CONFLICT (practice_id, remittance_id, kind, subject) DO UPDATE SET
         payer_id      = EXCLUDED.payer_id,
         payer_name    = EXCLUDED.payer_name,
         state         = EXCLUDED.state,
         claimed_cents = EXCLUDED.claimed_cents,
         citation      = EXCLUDED.citation,
         source        = EXCLUDED.source,
         verified_on   = EXCLUDED.verified_on,
         action        = EXCLUDED.action,
         defeasible_by = EXCLUDED.defeasible_by,
         evidence      = EXCLUDED.evidence,
         detected_at   = EXCLUDED.detected_at`,
      [
        practiceId(),
        finding.remittanceId,
        finding.kind,
        finding.subject,
        finding.payerId,
        finding.payerName,
        finding.state,
        finding.claimedCents,
        finding.citation,
        finding.source,
        finding.verifiedOn,
        finding.action,
        [...finding.defeasibleBy],
        JSON.stringify(finding.evidence),
        finding.detectedAt,
      ]
    );
  }

  async findings(
    options: { kind?: ClockFindingKind; openOnly?: boolean; limit?: number } = {}
  ): Promise<StoredClockFinding[]> {
    const rows = await many<FindingRow>(
      tx(),
      `SELECT * FROM statutory_clock_findings
        WHERE ($1::text IS NULL OR kind = $1)
          AND ($2::boolean IS NOT TRUE OR outcome = 'open')
        ORDER BY detected_at DESC
        LIMIT $3`,
      [options.kind ?? null, options.openOnly ?? false, options.limit ?? 500]
    );
    return rows.map(toFinding);
  }

  async recordOutcome(
    key: { remittanceId: string; kind: ClockFindingKind; subject: string },
    outcome: { outcome: StoredClockFinding["outcome"]; recoveredCents: Cents; note: string | null }
  ): Promise<StoredClockFinding | null> {
    const row = await one<FindingRow>(
      tx(),
      `UPDATE statutory_clock_findings
          SET outcome = $4, recovered_cents = $5, outcome_note = $6
        WHERE remittance_id = $1 AND kind = $2 AND subject = $3
        RETURNING *`,
      [key.remittanceId, key.kind, key.subject, outcome.outcome, outcome.recoveredCents, outcome.note]
    );
    return row ? toFinding(row) : null;
  }

  async savings(): Promise<ClockSavings> {
    /**
     * Rows out, folded in TypeScript by the same function the in-memory store uses. Aggregating in
     * SQL would put the one judgement in this report — that claimed and recovered are different
     * numbers and neither absorbs the other — in a second place, written in a second language.
     */
    const rows = await many<FindingRow>(tx(), `SELECT * FROM statutory_clock_findings`, []);
    return foldSavings(rows.map(toFinding));
  }
}
