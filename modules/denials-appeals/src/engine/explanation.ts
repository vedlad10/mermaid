/**
 * AI denial root-cause explanation (workflow S10 "AI ROOT-CAUSE ANALYSIS", S13 "AI DENIAL
 * INTELLIGENCE"; Payer_Loop_Analysis §11).
 *
 * ── THE HONEST SCOPE OF THIS FEATURE ───────────────────────────────────────────────────────────
 * §11 answers the question "can AI understand the denial and determine the reason?" with a precise
 * yes-and-no worth repeating here, because it is what keeps this file small:
 *
 *   "Yes, for NARRATION — the actual CARC/RARC code meaning is already fully solved deterministically
 *    (carc.ts); AI's honest value-add is synthesizing free-text remarks and multi-code context into
 *    one plain-English sentence, not decoding codes that are already decoded."
 *
 * So this does not classify, score, disposition, or rank anything. `carc.ts` already knows what CARC
 * 197 means. The playbook already decided whether to appeal it. The variance engine already split
 * the money four ways. All of that is deterministic, tested, and better than a model at its job.
 *
 * What none of them do is answer the question a biller actually asks when they open the screen:
 * *why did this happen, in a sentence, given everything else the payer said about this claim?* Three
 * codes on one claim have a story between them — a missing tooth number that caused a bundling
 * rejection that caused a partial payment — and stitching that into one sentence is a language job.
 *
 * ── WHAT IT MAY NOT DO ─────────────────────────────────────────────────────────────────────────
 * It may not state a number. Not one. Every amount on that screen is rendered deterministically in
 * integer cents a few pixels away, and a second figure written by a model is at best a duplicate and
 * at worst a contradiction about money. `sanitizeExplanation` refuses any output containing one.
 *
 * It may not recommend an action. The recommendation is the playbook's, is already on the screen,
 * and is frozen at triage time so the reasoning behind an old decision cannot silently change. A
 * model second-guessing it in prose would be a second, unauditable disposition engine.
 *
 * ── AND IT IS NOT PERSISTED ────────────────────────────────────────────────────────────────────
 * Unlike an appeal letter — which goes to a payer and must be reproducible years later — an
 * explanation is a reading aid over data that is already stored. It is generated on request, by an
 * explicit click, and thrown away. Persisting it would create a second copy of the denial's meaning
 * that drifts as the underlying record is corrected.
 */
import { describeCarc, findProcedure } from "@mermaid/shared";
import type { LlmAdapter } from "@mermaid/llm";

/**
 * One reason code on the claim, as the model sees it. **No patient identity, no dates, no money.**
 * Closed and small for the same reason `NarrativeInput` is: the PHI-free property of this feature is
 * enforced by the type, not by remembering it at the call site.
 */
export interface ExplanationReason {
  carcCode: string;
  carcDescription: string;
  /**
   * CAS01 adjustment group — CO, PI, OA, CR — or null when the denial predates it being recorded.
   *
   * Nullable rather than defaulted, because the group says whose decision the reduction was, and
   * "CO" is not a safe stand-in: a recoverable denial can arrive under PI just as easily. An
   * unknown group is simply left out of the prompt.
   */
  group: string | null;
  procedureCode: string | null;
  /** RARC remarks — the free text §11 identifies as the actual value-add here. */
  remarks: string[];
}

export interface ExplanationInput {
  payerName: string;
  /** The reason being explained. */
  focus: ExplanationReason;
  /** Every other reason the payer gave on the same claim — the "multi-code context" of §11. */
  siblings: ExplanationReason[];
  /** What the playbook decided. Given so the model does not contradict it, never so it may judge it. */
  disposition: string;
}

export interface DenialExplanation {
  text: string;
  provider: string;
  model: string | null;
  generatedAt: string;
  /** What the model was given, for a reader who wants to check the sentence against the facts. */
  evidence: string[];
}

export interface DenialExplainer {
  explain(input: ExplanationInput): Promise<DenialExplanation | null>;
}

export const NoExplainer: DenialExplainer = {
  async explain(): Promise<DenialExplanation | null> {
    return null;
  },
};

const SYSTEM = [
  "You explain, in plain English, why a dental insurance payer withheld money on a claim.",
  "You are writing for a dental billing clerk who can already see the reason codes and the amounts.",
  "",
  "Write 1–3 sentences saying what actually happened and why, connecting the reason codes to each",
  "other where they are related. If the codes are unrelated, say so plainly rather than inventing a",
  "connection between them.",
  "",
  "Absolute constraints:",
  "- Never state a dollar amount, a percentage, a date, or any number at all. Every figure is",
  "  already displayed next to your sentence, and a second one is either redundant or wrong.",
  "- Never recommend an action, and never say whether this should be appealed. That decision has",
  "  already been made and is shown separately.",
  "- Never invent a clinical detail, a policy provision, or a payer rule you were not given.",
  "- Do not restate the code descriptions verbatim; the reader can already read them.",
  "",
  "Plain language. No preamble, no 'this denial indicates that', no bullet points.",
].join("\n");

export function createDenialExplainer(llm: LlmAdapter, now: () => Date = () => new Date()): DenialExplainer {
  return {
    async explain(input: ExplanationInput): Promise<DenialExplanation | null> {
      const evidence = describeDenialContext(input);
      const result = await llm.draft({
        operation: "denial_explanation",
        system: SYSTEM,
        prompt: evidence.join("\n"),
        // Codes, a procedure and a payer. No identifiable person — see `ExplanationReason`.
        containsPhi: false,
        maxChars: 700,
      });
      if (!result.ok || !result.data) return null;

      const text = sanitizeExplanation(result.data.text);
      if (text === null) return null;

      return { text, provider: result.provider, model: result.model, generatedAt: now().toISOString(), evidence };
    },
  };
}

/** The prompt, and the "what this was based on" panel. One source, so they cannot disagree. */
export function describeDenialContext(input: ExplanationInput): string[] {
  const lines = [`Payer: ${input.payerName}`, `Reason being explained: ${describeReason(input.focus)}`];

  if (input.siblings.length > 0) {
    lines.push("Other reasons the payer gave on this same claim:");
    for (const sibling of input.siblings) lines.push(`  - ${describeReason(sibling)}`);
  } else {
    lines.push("This was the only reason the payer gave on this claim.");
  }

  // Supplied so the sentence does not contradict the disposition already on the screen — not so the
  // model may weigh in on whether the disposition was right.
  lines.push(`The practice has already decided how to handle this: ${input.disposition.replace(/_/g, " ")}.`);
  return lines;
}

function describeReason(reason: ExplanationReason): string {
  const procedure = reason.procedureCode ? findProcedure(reason.procedureCode) : undefined;
  const on = reason.procedureCode
    ? ` on ${reason.procedureCode}${procedure ? ` (${procedure.description})` : ""}`
    : " at the claim level";
  const description = reason.carcDescription || describeCarc(reason.carcCode);
  const remarks = reason.remarks.length > 0 ? ` Payer remarks: ${reason.remarks.join("; ")}.` : "";
  // An unknown group is omitted rather than guessed at — see `ExplanationReason.group`.
  const group = reason.group ? ` [group ${reason.group}]` : "";
  return `CARC ${reason.carcCode}${group} — ${description}${on}.${remarks}`;
}

/**
 * The gate before an explanation is shown to a human.
 *
 * Returns null — show no explanation — rather than cleaning anything up. There is nothing lost by
 * refusing: the deterministic reason code, its description, the amount and the recommended action
 * are all on the screen already. This paragraph is the only optional thing on it.
 */
export function sanitizeExplanation(raw: string): string | null {
  const text = raw.trim().replace(/\s*\n\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
  if (text.length < 25) return null;

  /**
   * Any number at all. Stricter than the appeal sanitizer on purpose: an appeal argues, while an
   * explanation sits directly beside the exact figures it would be duplicating.
   *
   * Codes are allowed through, because naming a code is not stating a figure — but the patterns
   * below are deliberately narrow, and an earlier, looser version of this line is why: it treated
   * any bare one-to-five-digit run as a possible code, so "withheld 1125 dollars" was stripped to
   * "withheld dollars" and passed the check. The entire guard was inert against the exact sentence
   * it exists to catch. A code reference must now be *identified as one* — by a D-prefix, by an
   * RARC letter prefix, or by the word "CARC"/"RARC"/"CDT"/"code" in front of it.
   */
  const withoutCodes = text
    .replace(/\bD\d{4}\b/g, " ")                                  // CDT, e.g. D2750
    .replace(/\b(?:N|M|MA|MB)\d{1,3}\b/g, " ")                    // RARC, e.g. N30
    .replace(/\b(?:CARC|RARC|CDT|codes?)\s+[A-Z]{0,2}\d{1,5}\b/gi, " "); // "CARC 197", "code 16"
  if (/\d/.test(withoutCodes) || /\$/.test(text)) return null;

  // A recommendation. The disposition is the playbook's, is frozen, and is already displayed.
  if (/\b(you should|we recommend|recommend(?:ed|ing)?|consider appealing|should be appealed|advis(?:e|able))\b/i.test(text)) {
    return null;
  }

  if (/\[[^\]]*\]|\{\{/.test(text)) return null;
  if (/^(here|sure|certainly|of course|this denial indicates)\b/i.test(text)) return null;

  return text;
}
