/**
 * Payment method — is the practice being PAID, or being charged a fee to collect its own money?
 *
 * ── THE LEAK ───────────────────────────────────────────────────────────────────────────────────
 * A payer that reimburses by virtual credit card hands the practice a 16-digit number to run through
 * a card terminal. The practice then pays its merchant processor a percentage — commonly 2.5–3.5% —
 * of money it had already earned, on a claim the payer had already discounted to a contracted rate.
 * Nothing on the remittance says this happened; the advice balances, the claim posts, and the fee is
 * taken somewhere else entirely, in a merchant statement nobody reconciles against an 835.
 *
 * ── WHY THE RULE IS `!== "ACH"` AND NOT `=== "VCC"` ────────────────────────────────────────────
 * There is no VCC payment method code. BPR04 in 835 v5010 carries ACH, CHK (check), FWT (wire), BOP
 * and NON — CMS states this plainly in the Guidance Letter 2022-04 FAQ, noting the standard includes
 * codes for ACH, check and wire "but not by VCC". A payer paying by card therefore has nowhere
 * honest to put it and files it under one of the others. So a virtual card cannot be detected by
 * looking for itself; it can only be detected as the absence of ACH.
 *
 * That makes this check deliberately broad. A paper cheque is also not ACH, and also not free — it
 * is opened, endorsed, walked to a bank and keyed by hand. Both belong in front of a person, and the
 * finding says which one arrived rather than asserting a card.
 *
 * ── WHY THIS IS NOT A SAFETY GATE ──────────────────────────────────────────────────────────────
 * `checkRemittanceSafety` holds a remittance when its arithmetic cannot be trusted. This is not
 * that. The money is real, the file balances, and the payment is exactly what the payer says it is —
 * holding it would delay good money over a fee the practice has already incurred. The leak is not in
 * the posting, it is in the PAYMENT CHANNEL, and the fix is an enrolment form, not a hold. So this
 * returns an observation and changes no posting decision.
 *
 * ── WHY THE FEE IS NULLABLE ────────────────────────────────────────────────────────────────────
 * The bleed is `payment × the practice's own merchant discount rate`, and that rate lives on a
 * merchant statement this system has never seen. Asked for a number it cannot know, this returns
 * `null` rather than a plausible default. A fabricated 3% would be indistinguishable on screen from
 * a measured one, and a practice cannot negotiate with a payer using a number we invented.
 *
 * ── THE RECURRENCE, WHICH IS THE REAL PRODUCT ──────────────────────────────────────────────────
 * Opting out once is a task. Staying opted out is not: the documented industry pattern is a fresh
 * card product arriving months after an opt-out, which re-enrols any practice whose staff simply
 * processes it. A practice cannot notice that by memory across hundreds of remittances. Comparing
 * each advice against what this payer did LAST time is the whole difference between a one-off
 * cleanup and a control, so `reverted` is reported separately and louder than a first sighting.
 *
 * Pure: no I/O, no clock, no AI. Same advice + same prior standing → same assessment, always.
 */
import { scaleCents, type Cents } from "@mermaid/shared";

/** What the payer did on this advice, as a settled fact about the payment channel. */
export type PaymentStanding =
  /** Paid over the ACH network — the only method HIPAA obliges a payer to provide on request. */
  | "ach"
  /** Paid by some method that is not ACH: card, cheque, wire. Carries a cost to receive. */
  | "non-ach"
  /**
   * No money moved. A denial-only advice, a zero-dollar adjudication, or a reversal. There is no
   * channel to have an opinion about, and no fee to have been charged.
   */
  | "no-payment";

export interface PaymentMethodAssessment {
  standing: PaymentStanding;
  /** BPR04 exactly as the payer printed it, for the evidence trail. Empty when absent. */
  method: string;
  /**
   * What receiving this payment cost the practice, or `null` when the merchant rate is unknown.
   * Never estimated — see the note above on why a plausible default is worse than nothing.
   */
  feeCents: Cents | null;
  /**
   * This payer paid by ACH before and has stopped. The re-enrolment pattern, caught in the act.
   * False on a first sighting, which is a different and less urgent fact.
   */
  reverted: boolean;
  /** Human-readable, or `null` when there is nothing a person needs to do. */
  finding: string | null;
}

/**
 * The only BPR04 value that costs the practice nothing to receive.
 *
 * `BOP` (financial institution option) is deliberately NOT treated as ACH. It means the payer let
 * its bank choose, which is precisely the ambiguity a card product hides behind.
 */
const ACH = "ACH";

const LABELS: Record<string, string> = {
  CHK: "a paper cheque",
  FWT: "a wire transfer",
  BOP: "a method its bank selected",
  NON: "no payment instrument",
};

const describe = (method: string): string => LABELS[method] ?? `method "${method || "unstated"}"`;

/**
 * Assess one remittance's payment channel.
 *
 * `priorStanding` is what this same payer did on its previous advice, or `null` when this is the
 * first one seen. The caller owns that lookup — this engine stays pure and is handed the answer,
 * the same way `scrubClaim` is handed `alreadyFiled` rather than reaching for a repository.
 *
 * `merchantRateBps` is the practice's own merchant discount rate in basis points (295 = 2.95%).
 * Absent means unknown, which produces a finding with no number rather than no finding.
 */
export function assessPaymentMethod(
  advice: { paymentMethod: string; paymentTotal: Cents; payerName: string },
  options: { priorStanding?: PaymentStanding | null; merchantRateBps?: number | null } = {}
): PaymentMethodAssessment {
  const method = (advice.paymentMethod ?? "").trim().toUpperCase();
  const rate = options.merchantRateBps ?? null;

  /**
   * Zero and negative first, before the method is consulted at all.
   *
   * A denial-only advice legitimately carries `NON`, and a reversal carries a negative total. Both
   * would otherwise read as "not ACH" and raise a fee alarm about money that never moved — which on
   * day one would bury the real findings under every denial the practice receives. The reversal case
   * is not hypothetical: `reversal-lifecycle.test.ts` posts an advice totalling −$400.
   */
  if (advice.paymentTotal <= 0) {
    return { standing: "no-payment", method, feeCents: null, reverted: false, finding: null };
  }

  if (method === ACH) {
    return { standing: "ach", method, feeCents: null, reverted: false, finding: null };
  }

  const feeCents = rate === null ? null : scaleCents(advice.paymentTotal, rate / 10_000);
  const reverted = options.priorStanding === "ach";

  /**
   * The finding names the payer and what it did, because the remediation is per-payer: an EFT
   * enrolment is filed with one payer at a time, and a message that says "a payer" sends a biller
   * back to the file to find out which.
   */
  const opening = reverted
    ? `${advice.payerName} paid by ACH previously and has now paid by ${describe(method)}.`
    : `${advice.payerName} paid by ${describe(method)} rather than ACH.`;

  const cost =
    feeCents === null
      ? "What that cost to receive is not known — the practice's merchant discount rate has not been recorded."
      : `Receiving it cost approximately ${(feeCents / 100).toFixed(2)} in merchant fees.`;

  /**
   * The citation is in the finding rather than in a help page, because the person reading it is
   * about to ask a payer to change something and the answer to "can they refuse?" is the whole
   * conversation. 45 CFR 162.925(a)(1) obliges the payer to comply with a request for ACH; CMS
   * confirmed it applies to payers using virtual cards in the GL 2022-04 FAQ.
   */
  const remedy =
    "A payer must honour a request to pay by ACH (45 CFR 162.925(a)(1); CMS Guidance Letter 2022-04). " +
    "Enrol this payer for EFT.";

  return { standing: "non-ach", method, feeCents, reverted, finding: `${opening} ${cost} ${remedy}` };
}
