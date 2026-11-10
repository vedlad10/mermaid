/**
 * X12 EDI 835 codec — electronic remittance advice (ERA).
 *
 * Ported logic-for-logic from `dental-rcm-platform`'s proven `engines/era835.js`, including its
 * balancing validation, which is the money-safety mechanism blueprint P3 requires. Same doctrine as
 * the 271 and 837 codecs: the mock synthesizes the payload, the PARSER is production code exercised
 * on every call.
 *
 * ONE DELIBERATE IMPROVEMENT OVER THE DONOR: the donor balances in floating-point dollars with a
 * `Math.abs(a - b) > 0.01` tolerance. Here money is integer cents, so every balance check is an
 * EXACT integer comparison. That tolerance was not a style choice in the donor — it was load-bearing,
 * because `0.1 + 0.2 !== 0.3` in binary floating point. In cents the problem does not exist, so the
 * tolerance is removed rather than translated. A one-cent discrepancy now fails the balance check
 * instead of hiding inside the epsilon, which is the correct behaviour for money (blueprint doc 16,
 * M10; design decision §12.1).
 *
 * Money on the wire is decimal dollars (X12 carries dollars); conversion to cents happens HERE, in
 * the parser, because every downstream balance assertion depends on it. `parseAmount` is the single
 * conversion point.
 *
 * Subset (deliberate, documented — same honesty as the sibling codecs):
 *   835 (005010X221A1): ISA/GS/ST, BPR (payment), TRN (trace), N1 (payer/payee), CLP (claim),
 *                       NM1 (patient), SVC (service line), CAS (adjustment triplets, claim- and
 *                       line-level), LQ (RARC remarks), PLB (provider-level adjustments).
 * Unknown segments are traced, never fatal.
 */
import { asCents, cents, type Cents } from "@mermaid/shared";
import {
  COMP,
  componentSeparatorOf,
  controlNumber,
  d8,
  isoToD8,
  parseSegments,
  render,
  type X12Segment,
} from "./x12.ts";

export { parseSegments, type X12Segment };

/** X12 CLP02 claim status codes → semantics. Ported from the donor's `CLP_STATUS`. */
export const CLP_STATUS: Readonly<Record<string, string>> = {
  "1": "primary_paid",
  "2": "secondary_paid",
  "3": "tertiary_paid",
  "4": "denied",
  "19": "primary_forwarded",
  "20": "secondary_forwarded",
  "22": "reversal",
};

/** Wire dollars → integer cents. The single money-conversion point in this codec. */
function parseAmount(raw: string | undefined): Cents {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) ? cents(value) : (0 as Cents);
}

const sumCents = (values: Cents[]): Cents => values.reduce<number>((a, b) => a + b, 0) as Cents;

// ── Parsed shapes (money in CENTS) ────────────────────────────────────────────────────

export interface Parsed835Adjustment {
  /** CAS01 group code: CO, PR, PI, OA, CR. */
  group: string;
  /** CARC reason code. */
  code: string;
  amount: Cents;
  /** CDT code when the adjustment is line-level; null when claim-level. */
  procedureCode: string | null;
}

export interface Parsed835Line {
  procedureCode: string;
  charged: Cents;
  paid: Cents;
  quantity: number;
  adjustments: Parsed835Adjustment[];
  remarks: string[];
}

export interface Parsed835Claim {
  /** CLP01 — the clinic's own control number from the 837's CLM01. The match key. */
  patientControlNumber: string;
  /** CLP02 status code. */
  statusCode: string;
  charged: Cents;
  paid: Cents;
  patientResponsibility: Cents;
  /** CLP07 — the payer's control number for this claim. */
  payerControlNumber: string;
  patientName: string;
  memberId: string;
  adjustments: Parsed835Adjustment[];
  lines: Parsed835Line[];
  remarks: string[];
  /**
   * NM1*TT in the claim loop (2100) — the "crossover carrier": the plan this payer says it forwarded
   * the claim to. Read because a CLP02 19/20 on its own says ANOTHER plan exists without saying
   * which, and an operator confirming coverage needs the payer's own words. Absent when the segment
   * was not sent: never inferred from anything else in the file.
   */
  crossoverCarrier?: { name: string; idQualifier: string | null; id: string | null };
  /** True when this claim's own arithmetic does not balance. */
  unbalanced: boolean;
}

/** Provider-level adjustment (PLB) — applies to the payment as a whole, not to one claim. */
export interface Parsed835ProviderAdjustment {
  providerId: string;
  /**
   * PLB03 verbatim, composite separator and all (`WO>MRM-000000000123`).
   *
   * Kept alongside the split halves rather than replaced by them: this is what the payer actually
   * wrote, and a reference we could not interpret has to remain readable by a human.
   */
  reason: string;
  /**
   * PLB03-1 — the adjustment reason code. `WO` overpayment recovery, `FB` forwarding balance,
   * `72` authorized return, `L6` interest, `CS` adjustment. Empty when the payer sent no code.
   */
  reasonCode: string;
  /**
   * PLB03-2 — the payer's reference for this adjustment. On a takeback it is normally the ORIGINAL
   * claim's control number, which is the only thing in the segment that says which claim's money is
   * being pulled back.
   *
   * `null` when the payer sent a bare reason code with no reference — a real and common case, and
   * one that must stay distinguishable from "we did not parse it". An unattributable recoupment is
   * a different (and worse) situation than an attributable one, and the two must not look alike.
   */
  referenceId: string | null;
  amount: Cents;
}

/**
 * Split an X12 composite element into its components.
 *
 * Every separator X12 permits is accepted — `:`, `>` and `^`. The component separator is declared
 * per-interchange in ISA16 and real payers use all three; a PLB reference that arrived under a
 * convention this did not accept would silently read as "no reference", which is the difference
 * between an attributable recoupment and an unattributable one.
 */
/**
 * Split an X12 composite on the separator the payload DECLARES.
 *
 * The separator is a parameter rather than a constant because X12 lets a trading partner choose it
 * and declare it in ISA16, and a real one chose a backtick — outside the set this used to guess
 * from. An unsplit composite turns `AD:D2750` into a procedure code no catalog holds and a PLB
 * reference into "the payer named no claim", which is money attributed to nobody.
 */
const splitComposite = (value: string, comp: RegExp): string[] => value.split(comp);

export interface Parsed835 {
  /** BPR — the actual money movement. */
  payment: { total: Cents; method: string; date: string } | null;
  /** TRN — the check or EFT trace number. THE idempotency key for posting. */
  trace: { number: string; originator: string } | null;
  payerName: string;
  payeeName: string;
  /**
   * N1*PE elements 3 and 4 — the payee's identifier and its qualifier (`XX` = NPI, `FI` = tax id).
   *
   * Read because a NAME does not identify anybody. When an 835 arrives unsolicited — pushed to a
   * webhook, or pulled from a clearinghouse that serves more than one practice — the payee is the
   * only thing in the file that says WHOSE money this is, and "SPRINGFIELD DENTAL" is not an answer
   * a tenant can be resolved from. Empty when the payer sent a bare name, which is legal.
   */
  payeeId: string;
  payeeIdQualifier: string;
  claims: Parsed835Claim[];
  providerAdjustments: Parsed835ProviderAdjustment[];
  /** True only when every balance assertion held. Money must never post from an unbalanced file. */
  balanced: boolean;
  /** Human-readable balance failures — what a person needs to reconcile by hand. */
  issues: string[];
  trace_: { segmentsTotal: number; skipped: string[] };
  /**
   * ISA15, the interchange usage indicator: `T` test, `P` production, `null` when the payload
   * carried no ISA envelope or an unrecognised value.
   *
   * ── WHY AN ENVELOPE FIELD IS READ AT ALL ───────────────────────────────────────────────────────
   * Everything else in the envelope is transport and is rightly dropped. This one is not: it is the
   * sender's own statement of whether the money in the file is real, and it is the ONLY field in an
   * 835 that says so. A clearinghouse test file balances, names real-looking payers and patients,
   * and passes every arithmetic gate — nothing inside the transaction set distinguishes it from a
   * payment. Posting one to a live practice's books records cash that was never sent.
   *
   * Reported rather than enforced here: whether a test file may post depends on whether the
   * DEPLOYMENT is itself a test, which is not the parser's to know.
   */
  usageIndicator: "T" | "P" | null;
}

/**
 * Split an interchange into its 835 transaction sets — the segments of each ST…SE, in order.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * One X12 file routinely carries SEVERAL 835s: a clearinghouse batches a day's remittances, and a
 * payer sends one transaction set per check. Each has its own BPR (the money), its own TRN (the
 * trace number that IS the idempotency key), and its own claims.
 *
 * The parser used to find the FIRST `ST` and then read every segment in the payload, so a
 * multi-cheque file collapsed into one result: `payment` and `trace` were overwritten by each
 * successive BPR/TRN — last one wins — and every CLP from every set piled into a single claims
 * array. The second `ST` was not even recorded as skipped. That silently attributes one cheque's
 * claims to another cheque's trace number, which is the ledger corruption the whole module exists
 * to prevent.
 *
 * Segments before the first `ST` (ISA/GS) and after the last `SE` (GE/IEA) belong to the envelope,
 * not to any transaction set, and are dropped here deliberately — nothing in an 835 reads them.
 */
function splitTransactionSets(segments: X12Segment[]): X12Segment[][] {
  const sets: X12Segment[][] = [];
  let current: X12Segment[] | null = null;
  for (const seg of segments) {
    if (seg.id === "ST") {
      current = [seg];
      sets.push(current);
      continue;
    }
    if (seg.id === "SE") {
      current = null;
      continue;
    }
    if (current) current.push(seg);
  }
  return sets;
}

/**
 * "This file holds twelve payments" is a QUESTION for the uploader, not a broken file.
 *
 * ── WHY IT NEEDS ITS OWN TYPE (audit A-3) ──────────────────────────────────────────────────────
 * Both refusals used to arrive at the caller as a bare `Error`, which `parseRemittance` turned into
 * `code: "parse_error"` — the same code a truncated download and a JPEG renamed to `.835` produce.
 * From outside there was then no way to tell "your file is corrupt, nothing can be done with it"
 * from "your file is fine and holds a dozen cheques, say whether you meant that", and those are the
 * two ends of a decision about posting real money.
 *
 * A screen that cannot tell them apart has to either refuse every multi-payment file — which is most
 * month-end ERAs — or offer "post them all anyway" on a genuinely malformed one. The count travels
 * on the error for the same reason: the confirmation has to name it.
 */
export class MultiplePaymentsError extends Error {
  readonly code = "multiple_payments";
  /** How many cheques the file actually holds. The confirmation has to name it. */
  readonly count: number;

  // Written out rather than as a parameter property: Node runs this repository's TypeScript by
  // STRIPPING types, and `constructor(readonly count: number)` is syntax rather than a type, so it
  // is not strippable. `tsc` accepts it happily and every test importing this file dies at runtime.
  constructor(count: number) {
    super(
      `This payload carries ${count} separate 835 transaction sets (${count} payments). ` +
        `Each has its own trace number and must be ingested as its own remittance — parse it with ` +
        `parse835All, or split the file before ingesting.`
    );
    this.name = "MultiplePaymentsError";
    this.count = count;
  }
}

/**
 * Parse an X12 835 into normalized, balanced remittance data.
 *
 * Throws when the payload is not an 835, is empty, or carries MORE THAN ONE 835 transaction set —
 * structurally wrong input must fail loud, like the 271/277 parsers. Use `parse835All` for a file
 * that legitimately holds several; this function returns one advice and there is no honest way to
 * fold three cheques into it.
 *
 * Balance FAILURES, by contrast, are returned as data (`balanced: false` + `issues`): an 835 that
 * parses but does not add up is a real file a human must reconcile, not a malformed one, and
 * throwing it away would lose the payment information it carries.
 */
export function parse835(raw: string): Parsed835 {
  const sets = parse835All(raw);
  if (sets.length > 1) {
    /**
     * Refused rather than merged, and rather than silently taking the first.
     *
     * Taking `sets[0]` would be worse than throwing: the caller would post one cheque and never
     * learn that the file held four, so three payments would vanish with no error anywhere.
     */
    throw new MultiplePaymentsError(sets.length);
  }
  return sets[0]!;
}

/**
 * Parse every 835 transaction set in an interchange, in file order.
 *
 * This is what an ERA *file* needs: a clearinghouse hands over a batch, and each transaction set
 * becomes its own remittance with its own trace number and its own idempotency guarantee.
 */
export function parse835All(raw: string): Parsed835[] {
  if (!raw || typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Empty EDI payload.");
  }
  const segments = parseSegments(raw);
  if (segments.length === 0) throw new Error("Empty EDI payload.");
  // The separator this payload declares in ISA16 — see `splitComposite`.
  const comp = componentSeparatorOf(raw);

  const sets = splitTransactionSets(segments);
  const remittanceSets = sets.filter((s) => s[0]?.elements[0] === "835");
  if (remittanceSets.length === 0) {
    throw new Error("Payload is not an X12 835 transaction.");
  }
  /**
   * A mixed interchange is refused, not filtered. If a file carries an 835 and something else, the
   * safe reading is that we do not understand the file — quietly discarding the part we did not
   * recognise is how a 277CA acknowledgement rides along unnoticed.
   */
  if (remittanceSets.length !== sets.length) {
    const others = sets.filter((s) => s[0]?.elements[0] !== "835").map((s) => s[0]?.elements[0] ?? "?");
    throw new Error(
      `Payload mixes 835 remittances with other transaction sets (${[...new Set(others)].join(", ")}). ` +
        `Split the interchange before parsing.`
    );
  }
  /**
   * One interchange, one usage indicator: ISA15 describes every transaction set inside the envelope,
   * so each advice carries the same value. ISA15 is the fifteenth element, index 14 here.
   */
  const isa = segments.find((seg) => seg.id === "ISA");
  const rawUsage = (isa?.elements[14] ?? "").trim().toUpperCase();
  const usageIndicator = rawUsage === "T" || rawUsage === "P" ? rawUsage : null;
  return remittanceSets.map((setSegments) => ({
    ...parseOne835(setSegments, segments.length, comp),
    usageIndicator,
  }));
}

/** Parse ONE 835 transaction set. `segmentsTotal` is the whole payload's count, for the trace. */
function parseOne835(segments: X12Segment[], segmentsTotal: number, comp: RegExp): Parsed835 {
  const issues: string[] = [];
  const out: Parsed835 = {
    payment: null,
    trace: null,
    payerName: "",
    payeeName: "",
    payeeId: "",
    payeeIdQualifier: "",
    claims: [],
    providerAdjustments: [],
    balanced: true,
    issues,
    trace_: { segmentsTotal, skipped: [] },
    usageIndicator: null,
  };

  let claim: Parsed835Claim | null = null;
  let line: Parsed835Line | null = null;

  for (const seg of segments) {
    const e = seg.elements;
    switch (seg.id) {
      case "BPR":
        // BPR02 total, BPR04 payment method, BPR16 effective date.
        out.payment = { total: parseAmount(e[1]), method: e[3] ?? "", date: e[15] ?? "" };
        break;
      case "TRN":
        out.trace = { number: e[1] ?? "", originator: e[2] ?? "" };
        break;
      case "N1":
        if (e[0] === "PR") out.payerName = e[1] ?? "";
        if (e[0] === "PE") {
          out.payeeName = e[1] ?? "";
          // N1*PE*NAME*XX*1234567893 — the qualifier and the id are a pair; neither is useful alone.
          out.payeeIdQualifier = e[2] ?? "";
          out.payeeId = e[3] ?? "";
        }
        break;
      case "CLP":
        claim = {
          patientControlNumber: e[0] ?? "",
          statusCode: e[1] ?? "",
          charged: parseAmount(e[2]),
          paid: parseAmount(e[3]),
          patientResponsibility: parseAmount(e[4]),
          payerControlNumber: e[6] ?? "",
          patientName: "",
          memberId: "",
          adjustments: [],
          lines: [],
          remarks: [],
          unbalanced: false,
        };
        line = null;
        out.claims.push(claim);
        break;
      case "NM1":
        if (claim && (e[0] === "QC" || e[0] === "IL")) {
          claim.patientName = [e[3], e[2]].filter(Boolean).join(" ");
          claim.memberId = e[8] ?? "";
        } else if (claim && e[0] === "TT" && (e[2] ?? "").trim()) {
          // NM1*TT*2*<name>*****<qualifier>*<id> — only a NAMED carrier is recorded.
          claim.crossoverCarrier = {
            name: (e[2] ?? "").trim(),
            idQualifier: (e[7] ?? "").trim() || null,
            id: (e[8] ?? "").trim() || null,
          };
        }
        break;
      case "SVC": {
        if (!claim) {
          issues.push("SVC service line appeared before any CLP claim.");
          break;
        }
        /**
         * SVC01 composite: `AD:D2750` (dental) or `HC:xxxxx` (medical) — split on the separator the
         * payload declared, not a guessed set. Getting this wrong leaves the qualifier fused to the
         * code (`AD\`D0120`), which matches no entry in any procedure catalog, so a paid line lands
         * against a procedure the practice never performed.
         */
        const quantity = Number.parseFloat(e[4] ?? "");
        line = {
          procedureCode: (e[0] ?? "").replace(new RegExp(`^(AD|HC)${comp.source}`), ""),
          charged: parseAmount(e[1]),
          paid: parseAmount(e[2]),
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          adjustments: [],
          remarks: [],
        };
        claim.lines.push(line);
        break;
      }
      case "CAS": {
        // CAS*group*carc*amount[*qty]*carc*amount... — reason/amount/quantity triplets after the group.
        const target = line ?? claim;
        if (!target) {
          issues.push("CAS adjustment appeared with no claim or line context.");
          break;
        }
        const group = e[0] ?? "";
        /**
         * ── A GAP IS REPORTED, NOT SILENTLY OBEYED (NEW-26) ─────────────────────────────────────
         *
         * This was `if (!code) break`, on the reasoning — stated in the PLB loop below — that a CAS
         * segment's triplets are contiguous by construction. That is what 005010X221A1 requires, and
         * it is not a guarantee about what arrives: a payer that emits `CAS*CO*45*100***253*25` is
         * non-conformant, and `break` responded by DISCARDING every adjustment after the gap.
         *
         * Discarding an adjustment silently is the same money-loss the PLB loop was fixed for, and
         * it fails in the more confusing direction here: the dropped amount breaks the BPR balance
         * check, so the advice holds as `unbalanced` and a human is told the payer's file does not
         * add up — when in fact Mermaid stopped reading it early.
         *
         * So the loop continues past a gap, like PLB's, and the gap itself becomes an ISSUE. The
         * money is read, and the fact that the segment was malformed is on the record rather than
         * inferred from an arithmetic failure three steps later.
         */
        let sawGap = false;
        for (let i = 1; i + 1 < e.length; i += 3) {
          const code = e[i];
          if (!code) {
            // An amount with no reason code is money the payer has not explained. Counting it
            // toward the balance without a code would make the file reconcile while nobody could
            // say why the deduction happened.
            if (parseAmount(e[i + 1]) !== 0) {
              issues.push(
                `CAS ${group} carries an adjustment amount with no reason code at element ${i + 1}; ` +
                  `it is not counted, so this advice will not balance until the payer restates it.`
              );
            }
            sawGap = true;
            continue;
          }
          if (sawGap) {
            issues.push(
              `CAS ${group} has a gap before reason code ${code} — 005010X221A1 requires contiguous ` +
                `triplets. The adjustment is read; the segment is malformed.`
            );
            sawGap = false;
          }
          target.adjustments.push({
            group,
            code,
            amount: parseAmount(e[i + 1]),
            procedureCode: line ? line.procedureCode : null,
          });
        }
        break;
      }
      case "LQ": {
        const target = line ?? claim;
        if (target && e[0] === "HE" && e[1]) target.remarks.push(e[1]);
        break;
      }
      case "PLB": {
        /**
         * PLB*provider*fiscalPeriod*reason>reference*amount[*reason>reference*amount]…
         *
         * ── WHY THIS IS A LOOP AND NOT `e[2]`/`e[3]` ───────────────────────────────────────────
         * One PLB segment carries up to SIX adjustment pairs (PLB03/04 through PLB13/14). This read
         * only the first, so a payer recouping two overpayments in one segment had the second
         * silently discarded — and the discarded amount is real money. It failed closed rather than
         * silently, because the missing amount then broke the BPR balance check and the advice held
         * as `unbalanced`. That is the right OUTCOME reached for the wrong REASON: a human was told
         * the file did not add up, when in fact Mermaid had not finished reading it.
         *
         * `continue` rather than `break` on an empty pair. A payer that omits one pair still fills
         * the elements after it, and stopping at the first gap would drop money that is on the wire.
         * The CAS loop above now does the same thing for the same reason (NEW-26) — it used to
         * `break`, on the argument that CAS triplets are contiguous BY CONSTRUCTION. They are
         * required to be; that is not a guarantee about what arrives.
         */
        const providerId = e[0] ?? "";
        for (let i = 2; i + 1 < e.length; i += 2) {
          const raw = e[i] ?? "";
          const amount = parseAmount(e[i + 1]);
          if (!raw && amount === 0) continue;
          const [code, reference] = splitComposite(raw, comp);
          out.providerAdjustments.push({
            providerId,
            reason: raw,
            reasonCode: code ?? "",
            // Empty string is not a reference. Both mean "the payer named no claim", and collapsing
            // them to `null` keeps every downstream attribution check asking one question.
            referenceId: reference ? reference : null,
            amount,
          });
        }
        break;
      }
      default:
        if (!["ISA", "GS", "ST", "SE", "GE", "IEA", "DTM", "REF", "AMT", "QTY", "PER", "N3", "N4", "LX", "TS3"].includes(seg.id)) {
          out.trace_.skipped.push(seg.id);
        }
    }
  }

  // ── Balancing (exact integer arithmetic — see the header note on the donor's float epsilon) ──
  for (const c of out.claims) {
    const claimAdjustments = sumCents(c.adjustments.map((a) => a.amount));
    const lineAdjustments = sumCents(c.lines.flatMap((l) => l.adjustments.map((a) => a.amount)));
    const linePaid = sumCents(c.lines.map((l) => l.paid));

    /**
     * CLP04 = Σ SVC03 − Σ claim-level CAS (005010X221A1 balancing).
     *
     * This compared CLP04 with the line payments alone. A payer may take an adjustment at the CLAIM
     * level while still itemising the lines — a managed-care withhold (`CAS*CO*A2`), a contractual
     * reduction applied to the claim — and then the claim pays less than its lines by exactly that
     * amount. The X12 guide's own managed-care example is built that way, and so is a public sample
     * read on 2026-10-15; both are balanced, and both were held as unbalanced, which the safety gate
     * refuses to release at all. The practice could never have posted that payer's money.
     *
     * The other shape stays accepted: a payer that denies at the claim level (`CAS*CO*27` for the
     * whole charge) and echoes $0 lines carrying no CAS of their own, where CLP04 equals the lines.
     * Either reading is safe because the identity below (charged = paid + every adjustment) still
     * runs on both — a claim that pays its full lines AND takes a claim-level adjustment fails it.
     */
    const expectedFromLines = (linePaid - claimAdjustments) as Cents;
    if (c.lines.length > 0 && c.paid !== linePaid && c.paid !== expectedFromLines) {
      c.unbalanced = true;
      issues.push(
        claimAdjustments === 0
          ? `Claim ${c.patientControlNumber}: service lines total ${fmt(linePaid)} but CLP reports ${fmt(c.paid)} paid.`
          : `Claim ${c.patientControlNumber}: service lines total ${fmt(linePaid)}, less ${fmt(claimAdjustments)} adjusted at the claim level, is ${fmt(expectedFromLines)}, but CLP reports ${fmt(c.paid)} paid.`
      );
    }
    // The core identity: what we charged = what they paid + everything they took off.
    const accountedFor = (c.paid + claimAdjustments + lineAdjustments) as Cents;
    if (accountedFor !== c.charged) {
      c.unbalanced = true;
      issues.push(
        `Claim ${c.patientControlNumber}: charged ${fmt(c.charged)} but paid + adjustments = ${fmt(accountedFor)}.`
      );
    }
  }

  if (out.payment) {
    const claimsTotal = sumCents(out.claims.map((c) => c.paid));
    const providerTotal = sumCents(out.providerAdjustments.map((p) => p.amount));
    const expected = (claimsTotal - providerTotal) as Cents;
    if (expected !== out.payment.total) {
      issues.push(
        `Remittance total ${fmt(out.payment.total)} does not equal claim payments less provider adjustments (${fmt(expected)}).`
      );
    }
  } else {
    issues.push("The 835 carries no BPR payment segment — there is no money movement to post.");
  }

  out.balanced = issues.length === 0;
  return out;
}

const fmt = (value: Cents): string => `$${(value / 100).toFixed(2)}`;

/**
 * Claim disposition from CLP status + amounts. Ported from the donor's `claimDisposition`,
 * including the comment that earned it: a reversal (CLP-22) must be recognised BEFORE the
 * zero-payment heuristic, because a $0 reversal is a retraction needing manual review, not a denial.
 */
export type ClaimDisposition = "paid_full" | "partial" | "denied" | "reversal" | "forwarded" | "unknown";

export function claimDisposition(claim: Parsed835Claim): ClaimDisposition {
  const status = CLP_STATUS[claim.statusCode] ?? "unknown";
  if (status === "reversal") return "reversal";
  /**
   * ── CLP02 19 / 20: THE PAYER IS TELLING US ANOTHER PLAN IS INVOLVED (M8) ─────────────────────
   *
   * `19` primary-forwarded and `20` secondary-forwarded mean this payer has passed the claim on to
   * another payer. `CLP_STATUS` has mapped both since the codec was written and `claimDisposition`
   * then ignored them: they fell through to the amount-based branches below and were reported as
   * `paid_full`, `partial` or `denied` like any ordinary adjudication.
   *
   * That discarded the single clearest signal in the whole file that coordination of benefits is in
   * play — stated by the payer, in a field we already parse. A claim reported `partial` looks
   * finished from this payer's side, so the remaining balance goes to the patient and no secondary
   * claim is ever filed.
   *
   * Checked BEFORE the amount branches, because a forwarded claim can carry any payment amount
   * including zero, and every one of those readings would be a different wrong answer.
   */
  if (status === "primary_forwarded" || status === "secondary_forwarded") return "forwarded";
  if (status === "denied" || (claim.paid === 0 && claim.charged > 0)) return "denied";
  if (claim.paid > 0 && claim.paid < claim.charged) return "partial";
  if (claim.paid >= claim.charged && claim.charged > 0) return "paid_full";
  return "unknown";
}

/** Every adjustment on a claim, claim-level and line-level, in one flat list. */
export const allAdjustments = (claim: Parsed835Claim): Parsed835Adjustment[] => [
  ...claim.adjustments,
  ...claim.lines.flatMap((l) => l.adjustments),
];

// ── Mock builder (dev/test transport) ─────────────────────────────────────────────────

export interface Build835Adjustment {
  group: string;
  code: string;
  /** Dollars, as they appear on the wire. */
  amount: number;
  procedureCode?: string;
}

export interface Build835Line {
  procedureCode: string;
  charged: number;
  paid: number;
  quantity?: number;
  adjustments?: Build835Adjustment[];
  remarks?: string[];
}

export interface Build835Claim {
  patientControlNumber: string;
  statusCode: string;
  charged: number;
  paid: number;
  patientResponsibility: number;
  payerControlNumber: string;
  patientFirstName: string;
  patientLastName: string;
  memberId: string;
  lines: Build835Line[];
  claimAdjustments?: Build835Adjustment[];
  remarks?: string[];
  /** NM1*TT — the plan this payer forwarded the claim to. Emitted only when given. */
  crossoverCarrier?: { name: string; idQualifier: string | null; id: string | null };
}

export interface Build835Input {
  payerName: string;
  payeeName: string;
  /**
   * The payee's NPI, emitted as N1*PE*NAME*XX*<id>.
   *
   * Optional because a payer may legally send a bare name, and the parser must keep reading those.
   * But the mock has to be ABLE to emit it, or `payeeId` is a field no test can prove comes off real
   * input — the exact shape of the coverage-date defect, where a permanently-empty value and "the
   * payer did not say" were indistinguishable.
   */
  payeeNpi?: string;
  traceNumber: string;
  /** Total payment in DOLLARS. */
  paymentTotal: number;
  /** ISO payment date. */
  paymentDate: string;
  /** "ACH" (EFT) or "CHK" (paper check). */
  paymentMethod?: string;
  claims: Build835Claim[];
  /**
   * PLB provider-level adjustments, in DOLLARS. Positive withholds from the payment (a takeback);
   * negative adds to it.
   *
   * The mock has to be able to emit these for the same reason it has to be able to emit `payeeNpi`
   * (see above): a field only ever produced by a hand-built fixture is a field no test can prove
   * comes off real input. The recoupment hold is decided from `reasonCode` and `referenceId`, and
   * both are parsed out of a composite — so both have to make the round trip through the wire.
   */
  providerAdjustments?: Build835ProviderAdjustment[];
}

export interface Build835ProviderAdjustment {
  /** PLB01 — the provider the adjustment is against. Pairs sharing one id share one segment. */
  providerId: string;
  /** PLB03-1 — `WO`, `FB`, `72`, `L6`, `CS`. */
  reasonCode: string;
  /** PLB03-2 — normally the original claim's control number on a takeback. Omitted when absent. */
  referenceId?: string;
  /** DOLLARS. Positive = withheld from the payment. */
  amount: number;
}

/**
 * One PLB segment per provider, carrying every pair for that provider.
 *
 * Grouped rather than one segment per adjustment because that is the shape a payer actually sends,
 * and because a multi-pair segment is the only thing that exercises the parser's pair loop.
 */
function plbSegments(adjustments: Build835ProviderAdjustment[], date: string): string[][] {
  const byProvider = new Map<string, Build835ProviderAdjustment[]>();
  for (const adjustment of adjustments) {
    const existing = byProvider.get(adjustment.providerId);
    if (existing) existing.push(adjustment);
    else byProvider.set(adjustment.providerId, [adjustment]);
  }
  return [...byProvider].map(([providerId, group]) => {
    const elements = ["PLB", providerId, date];
    for (const a of group) {
      elements.push(a.referenceId ? [a.reasonCode, a.referenceId].join(COMP) : a.reasonCode, a.amount.toFixed(2));
    }
    return elements;
  });
}

function casSegments(group: string, adjustments: Build835Adjustment[]): string[][] {
  // One CAS per group, carrying reason/amount/quantity triplets.
  const inGroup = adjustments.filter((a) => a.group === group);
  if (inGroup.length === 0) return [];
  const elements: string[] = ["CAS", group];
  for (const adjustment of inGroup) {
    elements.push(adjustment.code, adjustment.amount.toFixed(2), "");
  }
  return [elements];
}

const GROUPS = ["CO", "PR", "PI", "OA", "CR"];

/** Build an X12 835 remittance advice (mock transport). */
export function build835(input: Build835Input, now: Date = new Date()): string {
  const ctrl = controlNumber(input.traceNumber);
  const date = d8(now);
  const segs: string[][] = [
    /**
     * ISA15 is `T`, because this file is not real and must never claim otherwise.
     *
     * ── WHY A HARDCODED "P" WAS A DEFECT AND NOT A DETAIL ────────────────────────────────────────
     * The usage indicator is the one field in an 835 that states whether the interchange is
     * production or test data. This generator — whose entire purpose is to produce synthetic
     * advices — stamped every one of them `P`.
     *
     * That matters because Mermaid RETAINS the raw 835, encrypted, as the evidence for money it
     * posted, and `reconcileAll` re-derives the payer's own total from it. So the artefact kept to
     * prove what a payer said was itself asserting it came from a real payer. Anyone auditing a
     * balance months later — or any tool sorting real advices from fixtures — would have been
     * reading a file that lied about its own provenance.
     *
     * The Stedi adapter already holds exactly this line (`usageIndicator: testMode ? "T" : "P"`)
     * and refuses to start when the flag and the credential disagree. The mock had no such
     * discipline while producing far more of this system's stored 835s.
     */
    ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", input.payerName.slice(0, 15).padEnd(15), "ZZ", "CLINIC         ", date.slice(2), "0000", "^", "00501", ctrl, "0", "T", COMP],
    ["GS", "HP", input.payerName.slice(0, 15), "CLINIC", date, "0000", ctrl, "X", "005010X221A1"],
    ["ST", "835", "0001"],
    // BPR01 "I" = remittance information with payment; BPR02 amount; BPR03 "C" credit;
    // BPR04 method; BPR05–BPR15 are payer/payee banking detail (unused here); BPR16 effective date.
    ["BPR", "I", input.paymentTotal.toFixed(2), "C", input.paymentMethod ?? "ACH",
      "", "", "", "", "", "", "", "", "", "", "", isoToD8(input.paymentDate)],
    ["TRN", "1", input.traceNumber, input.payerName.slice(0, 10)],
    ["N1", "PR", input.payerName],
    // `XX` is the NPI qualifier. Omitted entirely when no id is supplied — an N1 carrying a
    // qualifier with no value behind it is malformed, not merely empty.
    input.payeeNpi ? ["N1", "PE", input.payeeName, "XX", input.payeeNpi] : ["N1", "PE", input.payeeName],
  ];

  for (const claim of input.claims) {
    segs.push([
      "CLP",
      claim.patientControlNumber,
      claim.statusCode,
      claim.charged.toFixed(2),
      claim.paid.toFixed(2),
      claim.patientResponsibility.toFixed(2),
      "CI",
      claim.payerControlNumber,
    ]);
    segs.push(["NM1", "QC", "1", claim.patientLastName, claim.patientFirstName, "", "", "", "MI", claim.memberId]);
    if (claim.crossoverCarrier) {
      const x = claim.crossoverCarrier;
      segs.push(["NM1", "TT", "2", x.name, "", "", "", "", x.idQualifier ?? "", x.id ?? ""]);
    }
    for (const group of GROUPS) segs.push(...casSegments(group, claim.claimAdjustments ?? []));
    for (const remark of claim.remarks ?? []) segs.push(["LQ", "HE", remark]);

    for (const line of claim.lines) {
      segs.push([
        "SVC",
        ["AD", line.procedureCode].join(COMP),
        line.charged.toFixed(2),
        line.paid.toFixed(2),
        "",
        String(line.quantity ?? 1),
      ]);
      for (const group of GROUPS) segs.push(...casSegments(group, line.adjustments ?? []));
      for (const remark of line.remarks ?? []) segs.push(["LQ", "HE", remark]);
    }
  }

  // PLB sits after the last claim and before SE — 005010X221A1 table 3, the summary table.
  if (input.providerAdjustments?.length) segs.push(...plbSegments(input.providerAdjustments, date));

  const stIndex = segs.findIndex((s) => s[0] === "ST");
  segs.push(["SE", String(segs.length - stIndex + 1), "0001"]);
  segs.push(["GE", "1", ctrl]);
  segs.push(["IEA", "1", ctrl]);
  return render(segs);
}

/** Assert an already-integer cents value coming back from the parser (used by the adapter layer). */
export const asPostedCents = asCents;
