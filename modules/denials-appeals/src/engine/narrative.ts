/**
 * AI appeal drafting (workflow S14: deterministic evidence assembly → AI drafting → mandatory human
 * gate; Payer_Loop_Analysis §12: "a draft only, always human-approved").
 *
 * ── WHAT THE MODEL IS ACTUALLY ALLOWED TO WRITE ────────────────────────────────────────────────
 * One paragraph: the ARGUMENT. Why this procedure, denied under this reason code, by this payer,
 * should be reprocessed. That is the sentence a template cannot write well, because the persuasive
 * case for a D2740 denied under CARC 197 has nothing in common with a D4341 denied under CARC 18.
 *
 * Everything else in the letter stays deterministic and untouched: the claim number, the member ID,
 * the date of service, the denied amount, the procedure code, the reason code, the evidence
 * checklist, and the closing request. Those are factual assertions to a payer about a patient's
 * care, and they are already correct. The model is not given the chance to restate them.
 *
 * ── WHY THIS FEATURE NEEDS NO PHI, AND WHY THAT IS A DESIGN CHOICE ─────────────────────────────
 * `NarrativeInput` below carries no patient name, no member ID, no date of birth, no date of
 * service, no claim number and no amount — and it is a closed type, so a future caller cannot quietly
 * add one. What is left is a procedure code, a reason code, and a payer's name: an argument about a
 * CDT code and a CARC code, which is not information about an identifiable person.
 *
 * That is not an accident of the prompt, it is the point of it. It means the single most valuable AI
 * feature in the product runs on a deployment with no BAA in place, because it never had anything to
 * disclose. A design that had put the patient's name in the prompt "because it reads better" would
 * have made this feature wait on a legal process it never needed.
 *
 * ── AND IF THE MODEL IS UNAVAILABLE ────────────────────────────────────────────────────────────
 * The deterministic letter is sent instead, exactly as it was before this file existed. Not a
 * placeholder, not an error, not a blocked appeal — the letter the practice has been sending all
 * along. Degradation costs prose, never a filing window.
 */
import type { LlmAdapter } from "@mermaid/llm";

/**
 * Everything the model may see. **Deliberately closed and deliberately small.**
 *
 * If a field is not on this type, it cannot reach a provider. Keep it that way: the PHI-free
 * property of this feature is enforced by this interface, not by remembering it at the call site.
 */
export interface NarrativeInput {
  /** 1 = first-level, 2 = second-level, 3 = external review. Changes the register of the argument. */
  level: number;
  payerName: string;
  /** CDT code, e.g. "D2740". Not a person. */
  procedureCode: string | null;
  procedureDescription: string | null;
  carcCode: string;
  carcDescription: string;
  /** The playbook's argument for this code — deterministic domain knowledge, not a model's opinion. */
  guidance: string;
  /** What a human must physically enclose. The model may reference these; it may not invent them. */
  checklist: string[];
}

export interface AppealNarrative {
  /** The paragraph, exactly as it was placed in the letter. */
  text: string;
  provider: string;
  model: string | null;
  generatedAt: string;
  /**
   * The facts the model was given, in plain English, for the reviewer to check against.
   *
   * A human approving an AI-assisted letter needs to see what the AI knew, not just what it wrote —
   * otherwise "review" means reading prose for plausibility, which is the one thing prose is
   * designed to have.
   */
  evidence: string[];
}

/** The port the service depends on. `NoNarrator` is the default and always degrades. */
export interface AppealNarrator {
  narrate(input: NarrativeInput): Promise<AppealNarrative | null>;
}

export const NoNarrator: AppealNarrator = {
  async narrate(): Promise<AppealNarrative | null> {
    return null;
  },
};

const SYSTEM = [
  "You draft one paragraph of a formal appeal letter from a dental practice to a dental insurance payer.",
  "",
  "Write ONLY the argument for why the claim should be reprocessed. Do not write a salutation, a",
  "subject line, a signature, or a list of enclosures — those already exist in the letter.",
  "",
  "Absolute constraints:",
  "- Never state a dollar amount, a date, a claim number, a member ID, or a patient's name. The",
  "  letter states all of these already, and correctly.",
  "- Never invent a clinical finding, a radiographic finding, a chart note, a measurement, or a",
  "  treatment history. You have not seen the chart. Argue from the procedure and the reason code.",
  "- Never assert that documentation says something specific. You may say what is enclosed.",
  "- Never promise, threaten, or cite a statute, regulation, or contract clause by number.",
  "- Do not use square brackets or any placeholder text.",
  "",
  "Write 2–4 sentences. Professional, specific, and direct. No pleading, no filler, no adjectives",
  "that carry no information. A claims reviewer reads hundreds of these; earn the reprocessing.",
].join("\n");

/**
 * The LLM-backed narrator. Built in the composition root and handed to the service, so the module
 * depends on a one-method port rather than on a provider.
 */
export function createAppealNarrator(llm: LlmAdapter, now: () => Date = () => new Date()): AppealNarrator {
  return {
    async narrate(input: NarrativeInput): Promise<AppealNarrative | null> {
      const evidence = describeEvidence(input);
      const result = await llm.draft({
        operation: "appeal_narrative",
        system: SYSTEM,
        prompt: evidence.join("\n"),
        // See the header: this input carries no identifiable patient information by construction.
        containsPhi: false,
        maxChars: 1_200,
      });
      if (!result.ok || !result.data) return null;

      const text = sanitizeNarrative(result.data.text);
      if (text === null) return null;

      return {
        text,
        provider: result.provider,
        model: result.model,
        generatedAt: now().toISOString(),
        evidence,
      };
    },
  };
}

/** The prompt, and simultaneously the "evidence used" panel the reviewer reads. One source. */
export function describeEvidence(input: NarrativeInput): string[] {
  const lines = [
    `Payer: ${input.payerName}`,
    `Appeal level: ${input.level}${input.level > 1 ? " (a previous appeal on this denial was not successful)" : ""}`,
    `Denial reason code: CARC ${input.carcCode} — ${input.carcDescription}`,
  ];
  if (input.procedureCode) {
    lines.push(
      `Procedure: ${input.procedureCode}${input.procedureDescription ? ` — ${input.procedureDescription}` : ""}`
    );
  } else {
    lines.push("Procedure: not identified on the denial (argue at the claim level).");
  }
  if (input.guidance.trim()) lines.push(`Known argument that works with this payer and code: ${input.guidance}`);
  if (input.checklist.length > 0) lines.push(`Documentation enclosed with this appeal: ${input.checklist.join("; ")}`);
  return lines;
}

/**
 * The last gate before an AI sentence enters a letter to a payer.
 *
 * Returns null — degrade to the deterministic letter — rather than trying to clean the text up.
 * Each of these is a refusal for the same reason the deterministic engine refuses to emit
 * "[member ID]": a factual claim to a payer about a patient's care is not a place to accept
 * something almost right, and there is always a correct letter to fall back to.
 */
export function sanitizeNarrative(raw: string): string | null {
  const text = raw.trim().replace(/\s*\n\s*\n\s*/g, "\n\n");
  if (text.length < 40) return null;

  // A money figure. The letter states the denied amount deterministically, once; a second figure
  // written by a model is either a duplicate or a contradiction, and a contradiction about money in
  // a payer letter is the exact failure this whole architecture is arranged to prevent.
  if (/\$\s?\d|\b\d+\s?(?:dollars|USD)\b/i.test(text)) return null;

  // Placeholders. Same refusal the deterministic engine already makes, for the same reason.
  if (/\[[^\]]*\]|\{\{|\bTBD\b|\bXXXX?\b/i.test(text)) return null;

  // A model that narrated its own task ("Here is the paragraph:") rather than performing it.
  if (/^(here|sure|certainly|of course|i'?ve|i have)\b/i.test(text)) return null;

  return text;
}
