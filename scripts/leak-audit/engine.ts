/**
 * Retrospective revenue-leak audit — the pure engine.
 *
 * Takes already-parsed 835 advices and an A/R aging list and returns claim-level findings. It does
 * no I/O, has no clock (the as-of day is an input) and touches no database, so the same files in
 * always produce the same report out.
 *
 * ── WHAT IT REUSES, AND WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * Every rule that decides whether money is owed already exists in the platform and is tested there:
 *   · contracted-rate learning and variance classification  → @mermaid/payer-profile (allowed-variance)
 *   · prompt-pay interest, with the state's cited statute    → @mermaid/payer-profile (statutory-clock)
 *   · non-ACH payment channel                                → remittance engine (payment-method)
 *   · CARC meaning                                           → @mermaid/shared (carc)
 * This file only sequences those engines over a batch of history and attaches evidence. It invents
 * no rate, no success probability and no statute.
 *
 * ── THE THREE NUMBERS, AND WHY THEY ARE NEVER ADDED TOGETHER ───────────────────────────────────
 *   estimated recoverable  money a payer's own paperwork shows it short-paid, at HIGH or MEDIUM
 *                          confidence. An estimate. Not collected, not promised.
 *   at stake               money that is in dispute or unaccounted for, where the data does not say
 *                          how much of it is owed. An upper bound, never an expectation.
 *   avoidable cost         money the practice is losing going forward, which cannot be claimed back.
 *
 * Nothing here is "recovered". Recovery is a payment arriving, and this tool has no way to see one.
 */
import { claimDisposition, allAdjustments, type Parsed835, type Parsed835Claim } from "../../platform/edi/mock/x12-835.ts";
import {
  allowedFromLine,
  assessPromptPay,
  chargedPerUnit,
  confirmedEpoch,
  foldRateObservation,
  normalizePayerName,
  promptPayRuleFor,
  type RateEpoch,
} from "@mermaid/payer-profile";
import { assessPaymentMethod, type PaymentStanding } from "../../modules/remittance/src/engine/payment-method.ts";
import { findCarc, formatUsd, type Cents } from "@mermaid/shared";

export type Confidence = "high" | "medium" | "low";

export type FindingCategory =
  | "underpayment-vs-learned-rate"
  | "alternate-benefit-downgrade"
  | "rate-drift"
  | "prompt-pay-interest"
  | "denial-administrative"
  | "denial-judgment"
  | "silent-claim"
  | "non-ach-payment";

/** Which of the three non-additive totals a finding belongs to. */
export type Bucket = "estimated-recoverable" | "at-stake" | "avoidable-cost";

export interface Finding {
  id: string;
  category: FindingCategory;
  bucket: Bucket;
  /** The practice's own claim reference (CLM01). Never a patient name or member id. */
  claim: string | null;
  payer: string;
  cdtCode: string | null;
  /** Date money was (or should have been) paid, ISO. */
  date: string | null;
  /** The best-evidenced number, in cents, or null when the data does not support one. */
  estimatedCents: number | null;
  confidence: Confidence;
  confidenceReason: string;
  /** One sentence each, citing the file and trace number the practice can open and check. */
  evidence: string[];
  /** What is being assumed, and what would make the finding wrong. */
  caveats: string[];
  action: string;
  /** Always true in this build; carried so a downstream view cannot drop the label. */
  synthetic: boolean;
}

export interface AdviceSource {
  /** File name the advice came from, shown in evidence. */
  source: string;
  parsed: Parsed835;
}

export interface AgingRow {
  claim: string;
  payer: string;
  /** YYYY-MM-DD */
  serviceDate: string;
  /** YYYY-MM-DD, or null when the export did not carry it. */
  submittedOn: string | null;
  /** null when not stated. Never assumed: two of three verified statutes give paper longer. */
  channel: "electronic" | "paper" | null;
  billedCents: number;
  balanceCents: number;
}

export interface AuditContext {
  practiceLabel: string;
  /** Two-letter state, or null. Prompt-pay is assessed only where a verified rule exists. */
  state: string | null;
  /** The as-of day (YYYY-MM-DD). Ages are measured to this, not to the wall clock. */
  asOf: string;
  /** Practice's merchant discount rate, basis points, or null when unknown. */
  merchantRateBps: number | null;
  synthetic: boolean;
}

export interface Exclusion {
  area: string;
  reason: string;
  count: number | null;
}

/**
 * One file the audit was handed, as received. The hash is what lets a report say exactly what it
 * read (PILOT-PREREQUISITES B4): a practice that re-exports a file can check it is the same one.
 */
export interface IntakeFile {
  name: string;
  /** SHA-256 of the file's bytes, hex. */
  sha256: string;
  bytes: number;
  /** Advices parsed from it; 0 when it failed. */
  advices: number;
  /** Why the file could not be read, or null. A failed file is reported, never skipped silently. */
  error: string | null;
  /** How a file that WAS read was read, when there is something to say (a header below line 1, a total row left out). */
  note?: string;
}

export interface Intake {
  files: IntakeFile[];
  aging: IntakeFile | null;
}

/**
 * A property of the INPUT, not of any claim, that decides whether the findings can be trusted.
 * `fail` means: resolve this before the report is shown to anyone.
 */
export interface DataCheck {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface AuditReport {
  context: AuditContext;
  window: { from: string | null; to: string | null };
  inputs: { advices: number; uniqueAdvices: number; claimsOnAdvices: number; lines: number; agingRows: number };
  intake: Intake | null;
  dataChecks: DataCheck[];
  findings: Finding[];
  totals: {
    estimatedRecoverableCents: number;
    estimatedRecoverableHighCents: number;
    estimatedRecoverableMediumCents: number;
    atStakeCents: number;
    avoidableCostCents: number;
    findingsByCategory: Record<string, number>;
  };
  exclusions: Exclusion[];
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/**
 * X12 D8 → ISO day, or "" when it is not a real calendar day.
 *
 * Shape alone was checked. A public 835 sample carries BPR16 `20002316` (month 23); it became
 * "2000-23-16", passed the `\d{4}-\d{2}-\d{2}` test, set the report's window, and would have aged a
 * claim by `Date.parse` → NaN. An impossible date is now "no readable payment date", which the report
 * already counts and states, rather than a number nobody can check.
 */
const d8ToIso = (d: string): string => {
  if (!/^\d{8}$/.test(d)) return d;
  const [y, m, day] = [Number(d.slice(0, 4)), Number(d.slice(4, 6)), Number(d.slice(6, 8))];
  const asDate = new Date(Date.UTC(y, m - 1, day));
  const real = asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === day;
  return real ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
};
const dayMs = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / dayMs);

const usd = (c: number): string => formatUsd(c as Cents);

/** Codes whose usual cause is something the practice can fix and resubmit. A deliberately short list. */
const ADMINISTRATIVE_CARC: ReadonlySet<string> = new Set(["4", "16", "109", "227"]);
/** Codes that are lost by definition: nothing to correct, nothing to appeal. */
const NOT_RECOVERABLE_CARC: ReadonlySet<string> = new Set(["26", "27", "29", "119"]);

const SILENT_AFTER_DAYS = 45;

interface Observed {
  source: string;
  trace: string;
  payer: string;
  paidOn: string;
  claim: Parsed835Claim;
}

function confidenceFromObservations(n: number): { confidence: Confidence; reason: string } {
  if (n >= 5) return { confidence: "high", reason: `the rate it is measured against was observed ${n} times with no contradiction` };
  if (n >= 3) return { confidence: "medium", reason: `the rate it is measured against was observed ${n} times; five or more would be high` };
  return { confidence: "low", reason: `the rate it is measured against rests on ${n} observation${n === 1 ? "" : "s"}, which could itself be a short-pay` };
}

/**
 * The learned rate that was standing on a given day, not the one standing at the end of the file.
 * A denial in July is measured against July's rate; a payer that moved its rate in September has not
 * made the July claim worth less. Candidates are ignored: an uncorroborated figure is not a rate.
 */
function rateInForceOn(list: readonly RateEpoch[], day: string): RateEpoch | null {
  let best: RateEpoch | null = null;
  for (const e of list) {
    if (e.status === "candidate") continue;
    if (e.openedAt > day) continue;
    if (e.closedAt !== null && e.closedAt <= day) continue;
    if (best === null || e.openedAt > best.openedAt) best = e;
  }
  return best;
}

/**
 * What two copies of the same payment must agree on. The interchange envelope (ISA/GS control
 * numbers) is regenerated on every portal download, so it is deliberately not part of it.
 */
const adviceContent = (p: Parsed835): string =>
  JSON.stringify([p.payerName, p.payeeId, p.payment, p.trace, p.claims, p.providerAdjustments]);

interface Deduplicated<T> {
  kept: T[];
  /** Exact copies of an advice already kept: the same ERA downloaded twice. */
  duplicates: { copy: T; of: T }[];
  /** Same payer and trace number, different content: which copy is true cannot be read from the files. */
  conflicts: T[];
}

/**
 * One payment, counted once. A practice that downloads the same ERA twice must not see its denials
 * twice, nor have a rate "observed" twice, which would also inflate the confidence of every finding
 * measured against it. Advices with no trace number cannot be matched and are all kept.
 */
function deduplicate<T extends AdviceSource>(ordered: readonly T[]): Deduplicated<T> {
  const groups = new Map<string, T[]>();
  const kept: T[] = [];
  for (const a of ordered) {
    const trace = a.parsed.trace?.number;
    if (!trace) {
      kept.push(a);
      continue;
    }
    const key = `${normalizePayerName(a.parsed.payerName)}|${trace}`;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  const duplicates: { copy: T; of: T }[] = [];
  const conflicts: T[] = [];
  for (const list of groups.values()) {
    const contents = new Set(list.map((a) => adviceContent(a.parsed)));
    if (contents.size > 1) {
      conflicts.push(...list);
      continue;
    }
    // The copies are identical, so which one is kept changes no figure, only the file name the
    // evidence cites. Cite the plainest: `ERA.835` rather than the browser's `ERA (1).835`.
    const byName = [...list].sort((a, b) => a.source.length - b.source.length || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    const keeper = byName[0]!;
    kept.push(keeper);
    for (const copy of byName.slice(1)) duplicates.push({ copy, of: keeper });
  }
  // Restore the caller's order: grouping above must not change which advice is seen first.
  const position = new Map(ordered.map((a, i) => [a, i]));
  kept.sort((a, b) => position.get(a)! - position.get(b)!);
  return { kept, duplicates, conflicts };
}

// ── the audit ───────────────────────────────────────────────────────────────────────────────────

export function auditLeaks(
  advices: readonly AdviceSource[],
  aging: readonly AgingRow[],
  context: AuditContext,
  intake: Intake | null = null
): AuditReport {
  const findings: Finding[] = [];
  const exclusions: Exclusion[] = [];
  const synthetic = context.synthetic;
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${String((seq += 1)).padStart(4, "0")}`;

  // Chronological, deterministic order: payment date, then trace, then file name.
  const sorted = advices
    .map((a) => ({ ...a, paidOn: d8ToIso(a.parsed.payment?.date ?? "") }))
    .sort((a, b) => (a.paidOn + (a.parsed.trace?.number ?? "") + a.source).localeCompare(b.paidOn + (b.parsed.trace?.number ?? "") + b.source));
  const { kept: ordered, duplicates, conflicts } = deduplicate(sorted);

  let unbalancedSkipped = 0;
  let noPaymentDate = 0;
  const observed: Observed[] = [];
  for (const a of ordered) {
    if (!a.parsed.balanced || a.parsed.claims.some((c) => c.unbalanced)) {
      unbalancedSkipped += 1;
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.paidOn)) {
      noPaymentDate += 1;
      continue;
    }
    for (const claim of a.parsed.claims) {
      observed.push({
        source: a.source,
        trace: a.parsed.trace?.number ?? "(no trace)",
        payer: a.parsed.payerName,
        paidOn: a.paidOn,
        claim,
      });
    }
  }

  const agingByClaim = new Map(aging.map((r) => [r.claim, r]));

  // ── 1. Contracted-rate underpayments, alternate-benefit downgrades, drift ─────────────────────
  const epochs = new Map<string, RateEpoch[]>(); // payerKey|cdt
  const payerRates = (payerKey: string): Map<string, Cents> => {
    const out = new Map<string, Cents>();
    for (const [k, list] of epochs) {
      if (!k.startsWith(`${payerKey}|`)) continue;
      const c = confirmedEpoch(list);
      if (c) out.set(k.slice(payerKey.length + 1), c.allowed);
    }
    return out;
  };
  let linesWithNoRate = 0;
  let lineCount = 0;

  for (const o of observed) {
    const payerKey = normalizePayerName(o.payer);
    for (const line of o.claim.lines) {
      lineCount += 1;
      const observedLine = {
        cdtCode: line.procedureCode,
        charged: line.charged,
        quantity: line.quantity,
        adjustments: line.adjustments.map((a) => ({ group: a.group, amount: a.amount })),
      };
      const allowed = allowedFromLine(observedLine);
      if (allowed === null) {
        linesWithNoRate += 1;
        continue;
      }
      const key = `${payerKey}|${line.procedureCode}`;
      const before = epochs.get(key) ?? [];
      const result = foldRateObservation(
        before,
        {
          payerId: payerKey,
          cdtCode: line.procedureCode,
          allowed,
          charged: chargedPerUnit(observedLine),
          observedAt: o.paidOn,
          observedPayerName: o.payer,
        },
        { peerRates: payerRates(payerKey) }
      );
      epochs.set(key, result.epochs);
      const f = result.finding;
      if (!f) continue;
      const baseline = confirmedEpoch(before);
      const obsCount = baseline?.observations ?? 0;
      const shortfall = Math.max(0, f.expected - f.observed) * line.quantity;
      if (shortfall === 0) continue; // paid more than the baseline: a drift to watch, not a leak
      const conf = confidenceFromObservations(obsCount);
      const common = {
        claim: o.claim.patientControlNumber,
        payer: o.payer,
        cdtCode: line.procedureCode,
        date: o.paidOn,
        synthetic,
      };
      const evidence = [
        `${o.source}, trace ${o.trace}: ${line.procedureCode} adjudicated with an allowed amount of ${usd(f.observed)} per unit (billed ${usd(line.charged)}, contractual write-off ${usd(line.charged - allowed * line.quantity)}).`,
        `The same payer's earlier advices for ${line.procedureCode} established ${usd(f.expected)} per unit, seen ${obsCount} time${obsCount === 1 ? "" : "s"} before this one.`,
      ];

      if ((f.classification === "line-underpayment" || f.classification === "leased-network") && f.recoverable) {
        findings.push({
          id: nextId("UND"),
          category: "underpayment-vs-learned-rate",
          bucket: "estimated-recoverable",
          ...common,
          estimatedCents: shortfall,
          confidence: conf.confidence,
          confidenceReason: conf.reason,
          evidence,
          caveats: [
            "The 'contracted' rate is learned from this payer's own earlier advices, not read from a contract. If the fee schedule changed, this is not a short-pay.",
            ...(f.classification === "leased-network" ? ["A different entity from the one that paid earlier adjudicated this claim; the letter goes to the contracting payer."] : []),
            "Part of the shortfall is the patient's share; only the insurance portion is claimed from the payer.",
          ],
          action: "Compare against the practice's copy of the payer's fee schedule. If it matches the learned rate, request reprocessing and quote the earlier advices as precedent.",
        });
      } else if (f.classification === "abp-downgrade") {
        findings.push({
          id: nextId("ABP"),
          category: "alternate-benefit-downgrade",
          bucket: "at-stake",
          ...common,
          estimatedCents: shortfall,
          confidence: obsCount >= 3 ? "medium" : "low",
          confidenceReason: `the paid amount equals this payer's own rate for ${f.downgradedTo ?? "a lesser code"}; an alternate-benefit clause may legitimately apply`,
          evidence: [
            ...evidence,
            `The paid amount matches the payer's allowance for ${f.downgradedTo ?? "a lesser procedure"}, which is the signature of an alternate-benefit downgrade.`,
          ],
          caveats: [
            "Under an alternate-benefit clause the payer's lower payment is contractual and the difference is the PATIENT's to pay; the platform therefore does not count it as recoverable from the payer.",
            "It is a payer short-pay only if the member's plan has no such clause, which this audit cannot see.",
          ],
          action: `Check the member's benefit booklet for an alternate-benefit clause on ${line.procedureCode}. If one applies, the balance is billable to the patient; if none does, request reprocessing at the ${line.procedureCode} rate.`,
        });
      } else {
        // schedule-drift or leased-network: real, but not a per-claim recovery.
        findings.push({
          id: nextId("DRF"),
          category: "rate-drift",
          bucket: "at-stake",
          ...common,
          estimatedCents: shortfall,
          confidence: conf.confidence === "high" ? "medium" : conf.confidence,
          confidenceReason: `${f.classification}: the payer now consistently pays a different amount, so this is a contract conversation rather than a claim correction`,
          evidence,
          caveats: [
            f.classification === "leased-network"
              ? "A different entity adjudicated under its own fee schedule; the remedy is a letter to the contracting payer."
              : "The payer paid the same lower figure on repeated claims. It may have amended the fee schedule with notice the practice did not log.",
          ],
          action: "Ask the payer for its current fee schedule and effective date for this code.",
        });
      }
    }
  }
  if (linesWithNoRate > 0) {
    exclusions.push({
      area: "Contracted-rate comparison",
      reason: "Service lines from which no allowed amount can be derived (no contractual write-off, or a fully denied line) were not compared.",
      count: linesWithNoRate,
    });
  }

  // ── 2. Denials ───────────────────────────────────────────────────────────────────────────────
  for (const o of observed) {
    if (claimDisposition(o.claim) !== "denied") continue;
    const adj = allAdjustments(o.claim).filter((a) => a.group === "CO" || a.group === "PI");
    const reason = adj[0]?.code ?? null;
    const carc = reason ? findCarc(reason) : undefined;
    const billed = o.claim.charged;
    const evidence = [
      `${o.source}, trace ${o.trace}: claim paid ${usd(0)} of ${usd(billed)} billed${reason ? ` with reason code ${adj[0]!.group}-${reason}${carc ? ` (${carc.description})` : ""}` : ""}.`,
    ];
    if (reason && NOT_RECOVERABLE_CARC.has(reason)) {
      exclusions.push({ area: "Denials", reason: `CARC ${reason} (${carc?.description ?? "not recoverable by correction"}) is not treated as recoverable.`, count: 1 });
      continue;
    }
    // Upper bound from a learned rate when every line has one; otherwise unknown.
    let bound = 0;
    let known = true;
    const payerKey = normalizePayerName(o.payer);
    for (const l of o.claim.lines) {
      const c = rateInForceOn(epochs.get(`${payerKey}|${l.procedureCode}`) ?? [], o.paidOn);
      if (!c) { known = false; break; }
      bound += c.allowed * l.quantity;
    }
    const administrative = reason !== null && ADMINISTRATIVE_CARC.has(reason);
    findings.push({
      id: nextId("DEN"),
      category: administrative ? "denial-administrative" : "denial-judgment",
      bucket: "at-stake",
      claim: o.claim.patientControlNumber,
      payer: o.payer,
      cdtCode: o.claim.lines[0]?.procedureCode ?? null,
      date: o.paidOn,
      estimatedCents: known && o.claim.lines.length > 0 ? bound : null,
      confidence: administrative && known ? "medium" : "low",
      confidenceReason: administrative
        ? "the reason code is usually an administrative defect the practice can correct and resubmit; success is not assumed"
        : "the reason code needs a clinical or contractual argument; the outcome of an appeal is not predictable from the advice",
      evidence,
      caveats: [
        known
          ? "The figure is the contracted allowed amount for the billed lines (insurance plus patient share): an upper bound, not an expected recovery."
          : "No contracted rate has been learned for these codes, so no amount is estimated.",
        "No overturn rate is applied. Appeal success depends on the payer, the documentation and the reason.",
      ],
      action: administrative
        ? "Correct the missing or invalid information and resubmit within the payer's filing window."
        : "Review the clinical documentation and the plan's terms before deciding to appeal or write off.",
      synthetic,
    });
  }

  // ── 3. Prompt-pay interest ───────────────────────────────────────────────────────────────────
  let noSubmission = 0;
  let noRule = 0;
  const l6Traces = new Set<string>();
  for (const a of ordered) {
    if (a.parsed.providerAdjustments.some((p) => p.reasonCode === "L6")) l6Traces.add(a.parsed.trace?.number ?? "");
  }
  for (const o of observed) {
    const disposition = claimDisposition(o.claim);
    if (o.claim.paid <= 0 || disposition === "denied" || disposition === "reversal") continue;
    if (!context.state) {
      noRule += 1;
      continue;
    }
    const row = agingByClaim.get(o.claim.patientControlNumber);
    if (!row || !row.submittedOn || !row.channel) {
      noSubmission += 1;
      continue;
    }
    const rule = promptPayRuleFor(context.state, o.paidOn);
    const r = assessPromptPay(
      {
        submittedAt: row.submittedOn,
        paidAt: o.paidOn,
        paidCents: o.claim.paid,
        submissionChannel: row.channel,
        adjustments: allAdjustments(o.claim).map((x) => ({ group: x.group, code: x.code })),
        interestPaidAtProviderLevel: l6Traces.has(o.trace),
        disposition,
      },
      rule
    );
    if (!r.finding) {
      if (r.refusedBecause === "no-rule-for-state") noRule += 1;
      continue;
    }
    const p = r.finding;
    findings.push({
      id: nextId("PPI"),
      category: "prompt-pay-interest",
      bucket: "estimated-recoverable",
      claim: o.claim.patientControlNumber,
      payer: o.payer,
      cdtCode: o.claim.lines[0]?.procedureCode ?? null,
      date: o.paidOn,
      estimatedCents: p.interestCents,
      confidence: "medium",
      confidenceReason: "the statute is verified for this state, but the advice does not say whether the plan is insured or self-funded, and a clean-claim defence may apply; see the caveats",
      evidence: [
        `${o.source}, trace ${o.trace}: filed ${row.submittedOn} (${row.channel}), paid ${o.paidOn}: ${p.elapsedDays} days against ${p.allowedDays} allowed, ${p.lateDays} late.`,
        `${p.citation}, verified ${p.verifiedOn}: simple interest at ${p.rateBps / 100}% on ${usd(p.principal)} = ${usd(p.interestCents)}.`,
      ],
      caveats: [
        "Applies to insured plans only. The filing date comes from the practice's own aging export and must be provable.",
        ...p.defeasibleBy.map((d) => `Could defeat this: ${d}`),
        `Source: ${p.source}`,
      ],
      action: p.action,
      synthetic,
    });
  }
  if (noSubmission > 0) {
    exclusions.push({
      area: "Prompt-pay interest",
      reason: "Paid claims with no filing date or submission channel in the aging export cannot be assessed. Neither is assumed.",
      count: noSubmission,
    });
  }
  if (noRule > 0) {
    exclusions.push({
      area: "Prompt-pay interest",
      reason: context.state
        ? `No verified prompt-pay statute for ${context.state}; the practice is told nothing rather than a guess.`
        : "No practice state supplied; prompt-pay was not assessed.",
      count: noRule,
    });
  }

  // ── 4. Non-ACH payments ──────────────────────────────────────────────────────────────────────
  const priorByPayer = new Map<string, PaymentStanding>();
  for (const a of ordered) {
    if (!a.parsed.payment) continue;
    const payerKey = normalizePayerName(a.parsed.payerName);
    const assessed = assessPaymentMethod(
      { paymentMethod: a.parsed.payment.method, paymentTotal: a.parsed.payment.total, payerName: a.parsed.payerName },
      { priorStanding: priorByPayer.get(payerKey) ?? null, merchantRateBps: context.merchantRateBps }
    );
    priorByPayer.set(payerKey, assessed.standing);
    if (assessed.standing !== "non-ach" || !assessed.finding) continue;
    findings.push({
      id: nextId("PAY"),
      category: "non-ach-payment",
      bucket: "avoidable-cost",
      claim: null,
      payer: a.parsed.payerName,
      cdtCode: null,
      date: a.paidOn,
      estimatedCents: assessed.feeCents,
      confidence: assessed.feeCents === null ? "low" : "medium",
      confidenceReason:
        assessed.feeCents === null
          ? "the payment channel is certain, the cost to receive it is not: the practice's merchant rate was not supplied"
          : "channel is stated by the payer; the fee uses the merchant rate the practice supplied",
      evidence: [`${a.source}, trace ${a.parsed.trace?.number ?? "(none)"}: ${assessed.finding}`],
      caveats: ["A cost going forward, not money owed. It cannot be claimed back from the payer."],
      action: "Enrol the payer for ACH/EFT.",
      synthetic,
    });
  }

  // ── the join between the two exports ─────────────────────────────────────────────────────────
  // The aging export and the 835s are matched on the practice's claim number (CLP01). If the
  // practice-management system numbers claims differently, nothing joins, every open claim looks
  // "silent", and prompt-pay can assess nothing. That must be visible before any finding is read.
  const claimsSeen = new Set(observed.map((o) => o.claim.patientControlNumber));
  const remittedOnAging = [...claimsSeen].filter((c) => agingByClaim.has(c)).length;
  const noJoin = claimsSeen.size > 0 && aging.length > 0 && remittedOnAging === 0;

  // ── 5. Silent claims ─────────────────────────────────────────────────────────────────────────
  let agingNoDate = 0;
  for (const row of aging) {
    if (row.balanceCents <= 0 || claimsSeen.has(row.claim)) continue;
    const basis = row.submittedOn ?? null;
    if (!basis) {
      agingNoDate += 1;
      continue;
    }
    const age = daysBetween(basis, context.asOf);
    if (age < SILENT_AFTER_DAYS) continue;
    findings.push({
      id: nextId("SIL"),
      category: "silent-claim",
      bucket: "at-stake",
      claim: row.claim,
      payer: row.payer,
      cdtCode: null,
      date: basis,
      estimatedCents: row.balanceCents,
      confidence: "low",
      confidenceReason: "the claim is open on the aging report and appears on no remittance in the files supplied; it may have been paid in a period or file not provided",
      evidence: [
        `Aging report: ${row.claim} filed ${basis}, ${age} days before ${context.asOf}, open balance ${usd(row.balanceCents)}.`,
        "No advice in the supplied 835 files carries this claim.",
      ],
      caveats: [
        ...(noJoin
          ? ["No claim number on the aging report matches any remittance supplied. The two exports may number claims differently, in which case this finding is an artifact; see the data checks."]
          : []),
        "Absence from the supplied files is not proof of non-payment. The upper bound is the open balance.",
        "The payer's timely-filing and appeal windows were not assessed here.",
      ],
      action: "Check claim status with the payer (277/276 or portal) before anything else.",
      synthetic,
    });
  }
  if (agingNoDate > 0) {
    exclusions.push({
      area: "Silent claims",
      reason: "Open balances with no filing date in the aging export cannot be aged and were not assessed.",
      count: agingNoDate,
    });
  }

  // ── standing exclusions ──────────────────────────────────────────────────────────────────────
  if (unbalancedSkipped > 0) {
    exclusions.push({
      area: "Advices",
      reason: "Advices whose amounts do not balance were not used as evidence: arithmetic that does not close cannot support a claim against a payer.",
      count: unbalancedSkipped,
    });
  }
  if (noPaymentDate > 0) {
    exclusions.push({ area: "Advices", reason: "Advices with no readable payment date were not used.", count: noPaymentDate });
  }
  if (conflicts.length > 0) {
    exclusions.push({
      area: "Advices",
      reason: "Copies of one payment (same payer and trace number) that disagree with each other were all set aside: which copy is true cannot be read from the files.",
      count: conflicts.length,
    });
  }
  exclusions.push(
    { area: "Coordination of benefits", reason: "Secondary-payer money and OA-23 shortfalls are not assessed; whether another plan exists must be answered by a person.", count: null },
    { area: "Provider-level adjustments (PLB)", reason: "Recoupment windows are not assessed in this version. Provider-level interest (L6) is read only to avoid double-counting interest.", count: null },
    { area: "Timely filing and appeal windows", reason: "Only payers with a published, cited window have one in the platform; none is applied to the findings above.", count: null },
    { area: "Fee-schedule truth", reason: "No contract or fee schedule was supplied. Rates are inferred from payer advices, which is evidence of what was paid, not of what was owed.", count: null },
    { area: "Clinical documentation", reason: "No chart, narrative or radiograph was seen. Medical-necessity denials are not assessed.", count: null },
    { area: "Patient balances", reason: "Patient-responsibility collection and write-offs are out of scope.", count: null }
  );

  // ── totals ───────────────────────────────────────────────────────────────────────────────────
  const sum = (pred: (f: Finding) => boolean): number => findings.filter(pred).reduce((t, f) => t + (f.estimatedCents ?? 0), 0);
  const byCategory: Record<string, number> = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  const reliable = (f: Finding): boolean => f.bucket === "estimated-recoverable" && (f.confidence === "high" || f.confidence === "medium");
  const dates = observed.map((o) => o.paidOn).sort();

  // ── data checks: properties of the input that decide whether the findings can be trusted ─────
  const dataChecks: DataCheck[] = [];
  if (intake) {
    const failed = intake.files.filter((f) => f.error !== null);
    dataChecks.push({
      check: "Remittance files read",
      status: intake.files.length === 0 ? "fail" : failed.length > 0 ? "warn" : "ok",
      detail:
        intake.files.length === 0
          ? "No remittance file was supplied."
          : `${intake.files.length - failed.length} of ${intake.files.length} files read` +
            (failed.length > 0 ? `; could not read: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}.` : "."),
    });
  }
  const traceless = ordered.filter((a) => !a.parsed.trace?.number).length;
  dataChecks.push({
    check: "Each payment counted once",
    status: conflicts.length > 0 ? "warn" : "ok",
    detail:
      `${advices.length} advices supplied, ${ordered.length} distinct.` +
      (duplicates.length > 0
        ? ` ${duplicates.length} exact duplicate${duplicates.length === 1 ? "" : "s"} (the same ERA supplied twice) counted once: ` +
          `${duplicates.map((d) => `${d.copy.source} is a copy of ${d.of.source}`).join("; ")}.`
        : "") +
      (conflicts.length > 0 ? ` ${conflicts.length} copies of the same payment disagree and were set aside: ${conflicts.map((d) => d.source).join(", ")}.` : "") +
      (traceless > 0 ? ` ${traceless} advice${traceless === 1 ? " has" : "s have"} no trace number and could not be checked for duplicates.` : ""),
  });
  dataChecks.push({
    check: "Advice arithmetic balances",
    status: unbalancedSkipped > 0 ? "warn" : "ok",
    detail:
      unbalancedSkipped > 0
        ? `${unbalancedSkipped} advice${unbalancedSkipped === 1 ? "" : "s"} did not balance and were not used as evidence.`
        : "Every advice used balances.",
  });
  dataChecks.push(
    claimsSeen.size === 0 || aging.length === 0
      ? {
          check: "Claim numbers join between the aging export and the remittances",
          status: "warn",
          detail: aging.length === 0 ? "The aging export has no rows; nothing could be joined." : "No claim was read from the remittances; nothing could be joined.",
        }
      : {
          check: "Claim numbers join between the aging export and the remittances",
          status: noJoin ? "fail" : remittedOnAging * 2 < claimsSeen.size ? "warn" : "ok",
          detail:
            `${remittedOnAging} of ${claimsSeen.size} remitted claims appear on the aging export. ` +
            (noJoin
              ? (aging.every((r) => r.balanceCents > 0)
                  ? "None do, and every row on the aging export has an open balance: it is probably an outstanding-claims report, which holds no paid claims to match. Export every claim sent in the period, paid or not (docs/pilot/README.md). If it already is that, the two exports number claims differently. "
                  : "None do: the two exports probably number claims differently. ") +
                "Confirm that one known paid claim carries the same number in both before reading any finding; silent-claim findings are unreliable until then and prompt-pay could assess nothing."
              : "Prompt-pay is assessed only for claims found in both, because the filing date comes from the aging export."),
        }
  );
  const paidOnAging = aging.filter((r) => claimsSeen.has(r.claim));
  const missingFiling = paidOnAging.filter((r) => !r.submittedOn || !r.channel).length;
  if (paidOnAging.length > 0) {
    dataChecks.push({
      check: "Filing date and channel present for remitted claims",
      status: missingFiling === paidOnAging.length ? "warn" : "ok",
      detail:
        missingFiling === 0
          ? "Every remitted claim on the aging export carries a filing date and channel."
          : `${missingFiling} of ${paidOnAging.length} remitted claims on the aging export lack a filing date or channel; prompt-pay was not assessed for them.`,
    });
  }

  return {
    context,
    window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    inputs: { advices: advices.length, uniqueAdvices: ordered.length, claimsOnAdvices: observed.length, lines: lineCount, agingRows: aging.length },
    intake,
    dataChecks,
    findings,
    totals: {
      estimatedRecoverableCents: sum(reliable),
      estimatedRecoverableHighCents: sum((f) => reliable(f) && f.confidence === "high"),
      estimatedRecoverableMediumCents: sum((f) => reliable(f) && f.confidence === "medium"),
      atStakeCents: sum((f) => f.bucket === "at-stake") + sum((f) => f.bucket === "estimated-recoverable" && !reliable(f)),
      avoidableCostCents: sum((f) => f.bucket === "avoidable-cost"),
      findingsByCategory: byCategory,
    },
    exclusions,
  };
}
