/**
 * Verified statutory clocks: prompt-pay interest, and the window after which a payer may no longer
 * take money back (F5).
 *
 * ── WHY THIS IS A TABLE AND NOT A FUNCTION ─────────────────────────────────────────────────────
 * Two clocks run on every paid claim and nothing in this system was reading either:
 *
 *   PROMPT PAY   — a payer that takes too long to pay a clean claim owes SIMPLE INTEREST on it by
 *                  statute. Most never volunteer it. The practice is owed money that will never
 *                  appear on any remittance, any report or any aging bucket, because the only
 *                  record of the obligation is a date arithmetic nobody performs.
 *   RECOUPMENT   — a payer may only claw back a past payment for so long. After the window closes
 *                  the takeback is time-barred, and a PLB `WO` that arrives after it is money the
 *                  practice can demand back. Today it is simply deducted and reconciled.
 *
 * Both are pure arithmetic over dates the system already holds. What it does NOT hold is the law,
 * which is per state, changes, and is the one input that must never be guessed.
 *
 * ── THE RULE FOR THIS FILE: NOTHING UNVERIFIED GOES IN IT ──────────────────────────────────────
 * Every entry below carries the statute, the source it was read from, and the date it was read.
 * A state that is absent produces NO FINDING — never a default, never a "typical" 30 days at a
 * "typical" 12%. A fabricated interest demand sent to a payer is worse than silence: it is wrong in
 * front of the party you are trying to collect from, and it costs the practice the credibility it
 * needs on the claims where it IS right.
 *
 * California is deliberately absent, and it is the clearest illustration of the rule. Ins. Code
 * § 10123.13 has been amended recently and the sources consulted disagreed about whether the
 * current standard is 10% or 15%, and whether the count is working days or calendar days. Two of
 * those four combinations produce a demand letter with the wrong number on it. So California
 * produces nothing until someone reads the current text, and the gap is visible here rather than
 * papered over with the most common answer.
 *
 * ── WHAT THESE RULES CANNOT SEE, AND WHY EVERY FINDING SAYS SO ─────────────────────────────────
 * A self-funded ERISA plan is not bound by ANY of this — state insurance law is preempted as to the
 * plan itself, and roughly half of commercial dental lives sit in self-funded arrangements. An 835
 * does not state funding type. Nothing in this system can therefore conclude that interest is owed;
 * it can only conclude that interest is owed IF the plan is insured rather than self-funded, which
 * is a question for the plan document or the payer.
 *
 * That is why every rule carries `defeasibleBy` and why it travels on every finding. A worklist row
 * that says "$41.03 owed" is a lie by omission; one that says "$41.03 owed unless this plan is
 * self-funded — confirm before demanding" is the same arithmetic and an honest instruction.
 */
import type { Cents } from "@mermaid/shared";

/**
 * When a rule took effect, and when it stopped.
 *
 * `effectiveFrom: null` means something specific and is not the same as "always": it means the date
 * this version of the statute took effect has NOT been verified, only that it was in force on
 * `verifiedOn`. Selection treats it as open-ended backwards, which is the assumption a practice is
 * already making implicitly today — but the null is retained rather than backfilled with a
 * plausible enactment date, because a plausible date is exactly the kind of invented fact this file
 * exists to keep out. When someone verifies the enactment date, the null becomes a date and every
 * finding dated before it stops being raised, with no other change.
 */
export interface EffectiveDating {
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** The statute, as it would be cited in a letter to the payer. */
  citation: string;
  /** Where it was read. */
  source: string;
  /** When it was read. A rule nobody has re-read in two years is a rule to re-read. */
  verifiedOn: string;
  /**
   * What defeats this rule even when the arithmetic holds.
   *
   * Travels onto the finding verbatim. These are not caveats for a footnote — each one is a real
   * and common reason the money is not actually owed, and a biller who demands without checking
   * them spends credibility they will need on the next claim.
   */
  defeasibleBy: readonly string[];
}

export interface PromptPayRule extends EffectiveDating {
  state: string;
  /** Days the payer has to pay a clean claim submitted ELECTRONICALLY. */
  electronicDays: number;
  /** Days for a paper claim. Equal to `electronicDays` where the statute states one figure. */
  paperDays: number;
  /** Simple annual interest in basis points. 1200 = 12% per annum. */
  rateBps: number;
  /**
   * Below this the statute says nothing is owed. Null where it sets no floor.
   *
   * Not a presentation threshold — a legislated one. Oregon writes it explicitly, and an engine that
   * demanded $1.40 from an Oregon payer would be demanding money the statute says is not owed.
   */
  deMinimisCents: Cents | null;
}

export interface RecoupmentRule extends EffectiveDating {
  state: string;
  /** The window expressed as the statute expresses it. Exactly one of these is set. */
  windowMonths: number | null;
  windowDays: number | null;
}

/** What every prompt-pay demand in this system is subject to, whatever the state. */
const PROMPT_PAY_DEFEATERS = [
  "The plan is self-funded (ERISA), which preempts state prompt-pay law. An 835 does not state funding type — confirm with the plan document or the payer before demanding.",
  "The claim was not CLEAN: the payer asked for information it had not been given, which restarts the clock from the date the information arrived.",
  "The payer already paid interest on this claim outside this advice.",
] as const;

const RECOUPMENT_DEFEATERS = [
  "The payer alleges fraud or material misrepresentation, which every one of these statutes excepts from the window.",
  "The plan is self-funded (ERISA), or is Medicaid/Medicare, none of which a state recoupment window binds.",
  "The recoupment is of a payment the practice itself identified and reported, which several statutes treat differently.",
] as const;

/**
 * ── PROMPT PAY ─────────────────────────────────────────────────────────────────────────────────
 *
 * Read 2026-09-15. Three states, each read from its own statute rather than from a summary table,
 * because the summaries disagree with each other on exactly the two fields that matter.
 */
export const PROMPT_PAY_RULES: readonly PromptPayRule[] = [
  {
    state: "NJ",
    electronicDays: 30,
    paperDays: 40,
    rateBps: 1200,
    deMinimisCents: null,
    citation: "N.J.S.A. 17B:30-51; N.J.A.C. 11:22-1.5",
    source: "https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-11-22-1-5",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: PROMPT_PAY_DEFEATERS,
  },
  {
    state: "NY",
    electronicDays: 30,
    paperDays: 45,
    rateBps: 1200,
    deMinimisCents: null,
    citation: "N.Y. Ins. Law § 3224-a",
    source: "https://www.nysenate.gov/legislation/laws/ISC/3224-A",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: PROMPT_PAY_DEFEATERS,
  },
  {
    state: "OR",
    electronicDays: 30,
    paperDays: 30,
    rateBps: 1200,
    /**
     * ORS 743B.452: "An insurer is not required to pay interest that is in the amount of $2 or less
     * on any claim." The only explicit floor in the three, and the reason `deMinimisCents` exists
     * rather than being a display rule applied uniformly.
     */
    deMinimisCents: 200 as Cents,
    citation: "ORS 743B.450; ORS 743B.452",
    source: "https://oregon.public.law/statutes/ors_743b.452",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: PROMPT_PAY_DEFEATERS,
  },
];

/**
 * ── RECOUPMENT WINDOWS ─────────────────────────────────────────────────────────────────────────
 *
 * After these, a takeback is time-barred and the money is disputable. Read 2026-09-15.
 *
 * Texas is the shortest in the country and therefore the most valuable to run: 180 days from the
 * date the provider RECEIVED the payment, and § 1301.132 also bars recovery until the provider's
 * appeal rights are exhausted — so a Texas takeback that simply appears as a PLB deduction is
 * doubly irregular.
 */
export const RECOUPMENT_RULES: readonly RecoupmentRule[] = [
  {
    state: "NY",
    windowMonths: 24,
    windowDays: null,
    citation: "N.Y. Ins. Law § 3224-b(b)",
    source: "https://www.nysenate.gov/legislation/laws/ISC/3224-B",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: RECOUPMENT_DEFEATERS,
  },
  {
    state: "LA",
    windowMonths: 18,
    windowDays: null,
    citation: "La. R.S. 22:1838",
    source: "https://law.justia.com/codes/louisiana/2018/code-revisedstatutes/title-22/rs-22-1838/",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: RECOUPMENT_DEFEATERS,
  },
  {
    state: "TX",
    windowMonths: null,
    windowDays: 180,
    citation: "Tex. Ins. Code § 1301.132",
    source: "https://texas.public.law/statutes/tex._ins._code_section_1301.132",
    verifiedOn: "2026-09-15",
    effectiveFrom: null,
    effectiveTo: null,
    defeasibleBy: RECOUPMENT_DEFEATERS,
  },
];

const normalizeState = (state: string): string => state.trim().toUpperCase();

/**
 * Whether `day` falls inside a rule's effective period.
 *
 * Half-open at the end: a rule that stopped on 2026-01-01 does not govern a payment made that day,
 * because its successor did. Open at the start when `effectiveFrom` is null — see the note on
 * {@link EffectiveDating} for why that null is kept rather than filled in.
 */
export function governsOn(rule: EffectiveDating, day: string): boolean {
  const on = day.slice(0, 10);
  if (rule.effectiveFrom !== null && on < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && on >= rule.effectiveTo) return false;
  return true;
}

/**
 * The rule governing a state on a day, or null.
 *
 * Null is the answer for every state not in the tables above, and it must stay an answer rather than
 * becoming a fallback. A practice in a state with no verified rule is told nothing, which is
 * correct: this system does not know what that state's legislature decided.
 *
 * Refuses to answer when two rules overlap, rather than picking one. Overlapping effective periods
 * mean the table is wrong, and a silent `find()` would resolve it by array order — so the rule that
 * happened to be typed first would decide what a payer is told it owes.
 */
function select<T extends EffectiveDating & { state: string }>(
  rules: readonly T[],
  state: string,
  day: string
): T | null {
  const wanted = normalizeState(state);
  const matches = rules.filter((r) => normalizeState(r.state) === wanted && governsOn(r, day));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Statutory rules for ${wanted} overlap on ${day.slice(0, 10)} (${matches
        .map((m) => m.citation)
        .join(", ")}). Two rules cannot both govern one day; fix the effective dating.`
    );
  }
  return matches[0]!;
}

export const promptPayRuleFor = (state: string, day: string): PromptPayRule | null =>
  select(PROMPT_PAY_RULES, state, day);

export const recoupmentRuleFor = (state: string, day: string): RecoupmentRule | null =>
  select(RECOUPMENT_RULES, state, day);

/** Every state this system can say anything about, for a settings screen that must not overclaim. */
export const STATES_WITH_PROMPT_PAY_RULES: readonly string[] = [
  ...new Set(PROMPT_PAY_RULES.map((r) => r.state)),
].sort();

export const STATES_WITH_RECOUPMENT_RULES: readonly string[] = [
  ...new Set(RECOUPMENT_RULES.map((r) => r.state)),
].sort();
