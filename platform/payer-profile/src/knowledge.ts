/**
 * The default playbook — what to DO about a denial, before this platform has learned anything.
 *
 * Ported from `dental-rcm-platform`'s `DEFAULT_PLAYBOOK`, with one deliberate change: the donor's
 * `overturn_prior` values are kept here explicitly labelled as PRIORS, not as facts. They are the
 * starting belief a brand-new deployment reasons from, and every one of them is meant to be
 * displaced by observed outcomes for a specific payer (see `service.ts`). Freezing them as constants
 * — which is what M5 declined to do when it ported the CARC table — would fossilize the exact
 * numbers the feedback loop exists to learn.
 *
 * Rule specificity, most specific first:
 *   payer + CDT prefix  →  payer  →  default + CDT prefix  →  default  →  the CARC's own category
 *
 * That last fallback matters: `@mermaid/shared`'s CARC table already knows whether a code is
 * contractual, the patient's, or recoverable. An unrecognized code therefore still gets a safe,
 * sensible disposition instead of nothing.
 */
import type { PayerWindowSource } from "@mermaid/shared";

/**
 * What a clinic should do about a denied line.
 *
 *   correct_resubmit — a fixable defect (missing tooth number, wrong payer). Fastest recovery.
 *   appeal           — the payer's judgement is contestable with documentation.
 *   patient_resp     — the payer owes nothing; bill the patient.
 *   verify_writeoff  — probably a genuine exclusion; confirm, then write off.
 *   post_normal      — a contractual adjustment. Not a denial at all.
 */
export type Disposition =
  | "correct_resubmit"
  | "appeal"
  | "patient_resp"
  | "verify_writeoff"
  | "post_normal";

/** Whether a disposition is worth a clinic's time to pursue. */
/**
 * The payer catalog seed — filing and appeal windows per payer.
 *
 * These values lived as a hardcoded map inside `modules/claims/src/engine/deadline.ts` from M4,
 * under a comment saying it was a placeholder until the payer profile owned them. This is that
 * owner. The `payers` table has carried `filing_window_days` since migration 0004 and stood empty
 * the whole time, so the system had two sources of truth for one fact and the authoritative one was
 * the inert one.
 *
 * Kept as seed data rather than migration DDL because these are policy, not schema: a payer that
 * changes its filing window should not require a migration, and a practice that negotiates a
 * different one should be able to edit a row.
 *
 * Windows are the common commercial-dental defaults; 365 days is the usual, and the shorter ones are
 * the payers that genuinely differ. `DEFAULT_FILING_DAYS` in the claims engine remains the fallback
 * for any payer not catalogued here — an unknown payer must not lose its deadline entirely.
 *
 * EXCEPT where a window carries a `filingSource` / `appealSource` (B-1): that number was read from
 * the payer's own published document, and the citation says which one. Everything without a source
 * is still a default, and every surface still says so.
 */
export interface PayerSeed {
  slug: string;
  name: string;
  filingWindowDays: number;
  appealWindowDays: number;
  /**
   * The payer's own document for `filingWindowDays`, when there is one (B-1).
   *
   * The citation belongs to the NUMBER, not to the payer: it is only honoured while the window in
   * effect is still exactly this figure — see `sourcedWindow`. An administrator who edits the row
   * to their practice's negotiated terms has replaced the payer's published default with something
   * this citation does not describe.
   */
  filingSource?: PayerWindowSource;
  /** As `filingSource`, for `appealWindowDays`. */
  appealSource?: PayerWindowSource;
  /**
   * Values this catalog SHIPPED as unsourced defaults and has since replaced with sourced ones (B-1).
   *
   * `ensurePayers` never overwrites a stored window — an administrator's correction must survive
   * every boot — so a corrected seed alone would reach no database that was already seeded. This is
   * the narrow exception: a stored window still holding EXACTLY the guess Mermaid itself shipped is
   * not somebody's correction, it is Mermaid's own mistake still standing, and it is replaced. Any
   * other stored value is left alone.
   */
  supersededGuesses?: { filingWindowDays?: number; appealWindowDays?: number; clearinghouseId?: string };
  /**
   * The payer's id AT THE CLEARINGHOUSE — a different namespace from `slug`, and significant to the
   * leading zero (NEW-08).
   *
   * Absent means this deployment has no id for the payer. A verification then says so plainly
   * rather than sending Mermaid's slug, which produces a 271 with no benefit segments: the parser
   * correctly refuses it, so nothing unsafe happens, but no check can ever succeed.
   */
  clearinghouseId?: string;
  /**
   * What a card may SAY for this payer.
   *
   * These lived as hand-written regular expressions in `modules/verification/src/engine/payer.ts`,
   * whose own comment called itself a mock "until the Payer Profile module is live on the database".
   * They are here now because they are the same kind of fact as the filing window: policy, edited by
   * a person, changing without a deploy.
   *
   * `word` rather than `contains` for a short or ambiguous alias — the array these replace bounded
   * `\bmoda\b` for exactly this reason, so "Modality Benefits" is not routed to Moda Health.
   * Sending an eligibility request to a company that has never heard of the patient surfaces as
   * "not covered", which reads like an answer rather than a mistake.
   */
  aliases: readonly PayerAliasSeed[];
}

export interface PayerAliasSeed {
  alias: string;
  kind?: "contains" | "word";
}

/**
 * Every clearinghouse id below was checked against Stedi's own payer network (`GET /payers/search`)
 * on 2026-10-15. Cigna 62308, Aetna 60054, Guardian 64246, UHC Dental 52133 and MetLife Dental
 * Family 10134 are the payers' PRIMARY ids there.
 */
export const PAYER_CATALOG: readonly PayerSeed[] = [
  {
    /**
     * ── "DELTA DENTAL" IS NOT ONE PAYER ──────────────────────────────────────────────────────────
     * It is some thirty-nine separate companies, each with its own payer id. This row used to route
     * every Delta card to `77777`, which Stedi's network lists as Delta Dental of CALIFORNIA,
     * operating in CA only. A New Jersey practice's Delta patient would have been checked against the
     * California company and come back "subscriber not found" — an answer that reads like a fact
     * about the patient. The pilot's prospects are in NJ, NY and OR.
     *
     * So a card that NAMES its company routes to that company (the rows below; the longest alias
     * wins), and a card that says only "Delta Dental" carries no id: the check refuses and says
     * none is recorded, rather than guessing a company. A practice that knows its local company can
     * set this row's id from the payer catalog screen. `77777` is retired from databases still
     * holding exactly it (`supersededGuesses`); an id somebody chose survives.
     */
    slug: "delta-dental",
    name: "Delta Dental",
    filingWindowDays: 365,
    appealWindowDays: 180,
    supersededGuesses: { clearinghouseId: "77777" },
    aliases: [{ alias: "delta dental" }, { alias: "deltadental" }],
  },
  /**
   * Named Delta Dental companies, ids as Stedi's network lists them (2026-10-15). Through Stedi,
   * 837D claims are NOT supported for New Jersey or New York (eligibility only): those claims need
   * the payer's portal or another route. Filing and appeal windows are the generic Delta defaults,
   * unsourced, exactly as the row above.
   */
  {
    slug: "delta-dental-ca",
    name: "Delta Dental of California",
    filingWindowDays: 365,
    appealWindowDays: 180,
    clearinghouseId: "77777",
    aliases: [{ alias: "delta dental of california" }, { alias: "delta dental of ca", kind: "word" }],
  },
  {
    slug: "delta-dental-nj",
    name: "Delta Dental of New Jersey",
    filingWindowDays: 365,
    appealWindowDays: 180,
    clearinghouseId: "22189",
    aliases: [{ alias: "delta dental of new jersey" }, { alias: "delta dental of nj", kind: "word" }],
  },
  {
    slug: "delta-dental-ny",
    name: "Delta Dental of New York",
    filingWindowDays: 365,
    appealWindowDays: 180,
    clearinghouseId: "11198",
    aliases: [{ alias: "delta dental of new york" }, { alias: "delta dental of ny", kind: "word" }],
  },
  {
    slug: "delta-dental-or",
    name: "Delta Dental of Oregon",
    filingWindowDays: 365,
    appealWindowDays: 180,
    clearinghouseId: "CDOR1",
    aliases: [{ alias: "delta dental of oregon" }],
  },
  {
    slug: "cigna-dental",
    name: "Cigna Dental",
    filingWindowDays: 365,
    appealWindowDays: 180,
    clearinghouseId: "62308",
    aliases: [{ alias: "cigna" }],
  },
  {
    slug: "metlife-dental",
    name: "MetLife Dental",
    filingWindowDays: 365,
    appealWindowDays: 180,
    /**
     * Stedi's PRIMARY id for MetLife Dental Family. 65978 is an alias of it and should route the
     * same, but only the primary is answered by Stedi's test-mode mock, so with 65978 the end-to-end
     * check could not be proven at all (AAA 79, 2026-10-15). Replaced where a database still holds
     * exactly 65978.
     */
    clearinghouseId: "10134",
    supersededGuesses: { clearinghouseId: "65978" },
    aliases: [{ alias: "metlife" }],
  },
  {
    /**
     * Both windows are SOURCED (B-1), from Aetna's own dental documents, and both replaced guesses
     * that cost money in opposite directions: 180 filing granted twice the runway Aetna states, and
     * 60 appeal showed a third of it — so appealable denials were written off early.
     *
     * The appeal window runs "from the receipt of the adverse decision". The denials module counts
     * from the payer's determination date on the 835, which is never later than receipt, so the
     * date it computes is at worst a few days EARLY — the safe direction for a deadline.
     */
    slug: "aetna-dental",
    name: "Aetna Dental",
    filingWindowDays: 90,
    appealWindowDays: 180,
    filingSource: {
      publisher: "Aetna Dental",
      document: "Dental Office Guide, 23.05.803.1B, revised 09/25/2026",
      url: "https://app-iaem.aetna.com/content/dam/aetna/pdfs/aetna-dental/ppo-office-guide.pdf",
      quote:
        "Claims should be submitted to the address listed on the member's ID card (or as noted below) " +
        "no later than 90 days after the date of service.",
      verifiedOn: "2026-09-30",
    },
    appealSource: {
      publisher: "Aetna Dental",
      document: "Dispute & Appeal Process Overview, \"Deadline to file appeals\"",
      url: "https://www.aetnadental.com/professionals/dispute-appeal-process/overview.html",
      quote:
        "Providers must appeal within 180 days from the receipt of the adverse decision, unless " +
        "otherwise required by contract or state requirement.",
      verifiedOn: "2026-09-30",
    },
    supersededGuesses: { filingWindowDays: 180, appealWindowDays: 60 },
    clearinghouseId: "60054",
    aliases: [{ alias: "aetna" }],
  },
  {
    slug: "guardian-dental",
    name: "Guardian",
    filingWindowDays: 180,
    appealWindowDays: 90,
    clearinghouseId: "64246",
    aliases: [{ alias: "guardian" }],
  },
  {
    slug: "uhc-dental",
    name: "UnitedHealthcare Dental",
    filingWindowDays: 90,
    appealWindowDays: 60,
    clearinghouseId: "52133",
    // Three spellings of one payer, which is precisely what a single regex was hiding. `uhc` is
    // word-bounded: three letters that appear inside ordinary words would otherwise capture cards
    // belonging to somebody else.
    // "united health" (not "united healthcare") on purpose: it also matches "United Health Care" and
    // "UnitedHealthcare", which the single regex this replaces did and a longer alias would not. The
    // squashed spelling needs its own row because normalisation keeps word boundaries. `uhc` is
    // word-bounded: three letters that appear inside ordinary words would capture other payers.
    aliases: [{ alias: "united health" }, { alias: "unitedhealthcare" }, { alias: "uhc", kind: "word" }],
  },
  {
    slug: "moda-dental",
    name: "Moda Health",
    filingWindowDays: 365,
    appealWindowDays: 180,
    // No clearinghouse id recorded yet — a check for this payer reports that plainly rather than
    // guessing. It was the one row in the old array without one, and that is a fact about this
    // deployment, not about Moda.
    aliases: [{ alias: "moda", kind: "word" }],
  },
];

/**
 * The payer's own citation for a window IN EFFECT, or null when that window is an estimate (B-1).
 *
 * Keyed on the number as well as the payer, deliberately. The catalog row is editable, and a
 * citation describes one figure in one document: Aetna's guide says 90, so a row an administrator has
 * set to 120 is no longer Aetna's published term, whatever the reason for the edit. Returning the
 * citation anyway would label the practice's number with Aetna's name — the overstatement B-1
 * exists to prevent, in the other direction.
 *
 * Derived rather than stored, so no schema holds a copy that can drift from the number beside it.
 */
export function sourcedWindow(
  slug: string | null,
  kind: "filing" | "appeal",
  days: number | null | undefined
): PayerWindowSource | null {
  if (!slug || !days) return null;
  const seed = PAYER_CATALOG.find((p) => p.slug === slug);
  if (!seed) return null;
  const [cited, source] =
    kind === "filing" ? [seed.filingWindowDays, seed.filingSource] : [seed.appealWindowDays, seed.appealSource];
  return source && cited === days ? source : null;
}

/**
 * Fold a payer name into the form aliases are stored and matched in: lower case, every run of
 * non-alphanumerics collapsed to one space, trimmed.
 *
 * Shared by the seed, the write path and the matcher, so "Delta-Dental", "DELTA  DENTAL" and
 * "delta dental" cannot become three different rows or three different answers.
 */
export function normalizePayerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const PURSUABLE: readonly Disposition[] = ["correct_resubmit", "appeal"];

export interface PlaybookSeed {
  carcCode: string;
  /** Applies only to CDT codes starting with this prefix; empty = any procedure. */
  cdtPrefix: string;
  disposition: Disposition;
  recommendedAction: string;
  guidance: string;
  /** Starting belief in the probability of recovery. Displaced by observed outcomes. */
  overturnPrior: number;
}

export const DEFAULT_PLAYBOOK: readonly PlaybookSeed[] = [
  {
    carcCode: "16",
    cdtPrefix: "",
    disposition: "correct_resubmit",
    recommendedAction: "Identify the missing field or attachment from the RARC, correct it, and resubmit as a corrected claim.",
    guidance: "The fastest recovery in the taxonomy. Check N37 (tooth number) and N29 (radiographs) first.",
    overturnPrior: 0.75,
  },
  {
    carcCode: "50",
    cdtPrefix: "D2",
    disposition: "appeal",
    recommendedAction: "Appeal with the pre-operative radiograph, a clinical narrative, and intraoral photographs if available.",
    guidance: "Crowns and buildups: document the extent of decay or the fracture. Argue the tooth's condition, never convenience.",
    overturnPrior: 0.55,
  },
  {
    carcCode: "50",
    cdtPrefix: "D4",
    disposition: "appeal",
    recommendedAction: "Appeal with periodontal charting (pocket depths) and radiographic evidence of bone loss.",
    guidance: "Scaling and root planing appeals win on 5mm+ pockets and demonstrable bone loss. Include full-mouth charting.",
    overturnPrior: 0.6,
  },
  {
    carcCode: "97",
    cdtPrefix: "D2950",
    disposition: "appeal",
    recommendedAction: "Appeal the buildup-bundled-into-crown with documentation of separate clinical necessity.",
    guidance: "Show insufficient remaining tooth structure. A distinct procedure date strengthens the argument.",
    overturnPrior: 0.45,
  },
  {
    carcCode: "29",
    cdtPrefix: "",
    disposition: "appeal",
    recommendedAction: "Appeal with proof of timely original submission (the clearinghouse acceptance report).",
    guidance: "Only fight this with evidence. Otherwise write it off and fix the intake workflow that caused it.",
    overturnPrior: 0.35,
  },
  {
    carcCode: "151",
    cdtPrefix: "",
    disposition: "appeal",
    recommendedAction: "Verify the service history, then appeal with a narrative if clinical necessity overrides the frequency limit.",
    guidance: "Replacement clauses: confirm the prior placement date before appealing.",
    overturnPrior: 0.4,
  },
  {
    carcCode: "109",
    cdtPrefix: "",
    disposition: "correct_resubmit",
    recommendedAction: "Re-verify the coordination-of-benefits order and submit to the correct primary payer.",
    guidance: "Birthday rule for dependents. Get an updated COB statement from the subscriber.",
    overturnPrior: 0.7,
  },
  {
    carcCode: "197",
    cdtPrefix: "",
    disposition: "appeal",
    recommendedAction: "Appeal with a retro-authorization request and documentation of clinical urgency.",
    guidance: "Some payers allow retro-authorization within 30 days — check the payer notes before writing it off.",
    overturnPrior: 0.3,
  },
  {
    carcCode: "119",
    cdtPrefix: "",
    disposition: "patient_resp",
    recommendedAction: "Confirm the maximum is used, then transfer the balance to the patient with a benefits-exhausted letter.",
    guidance: "Check whether any portion of the treatment falls into a new benefit year.",
    overturnPrior: 0.05,
  },
  {
    carcCode: "96",
    cdtPrefix: "",
    disposition: "verify_writeoff",
    recommendedAction: "Verify the exclusion in the plan document. Bill the patient if it was disclosed before treatment; otherwise review.",
    guidance: "Missing-tooth clauses and cosmetic exclusions live here.",
    overturnPrior: 0.2,
  },
  {
    carcCode: "18",
    cdtPrefix: "",
    disposition: "verify_writeoff",
    recommendedAction: "Confirm whether this is a true duplicate. If the original was never paid, appeal with both claim numbers.",
    guidance: "A payer's duplicate flag is often a mis-keyed date of service, not an actual duplicate.",
    overturnPrior: 0.15,
  },
  {
    carcCode: "4",
    cdtPrefix: "",
    disposition: "correct_resubmit",
    recommendedAction: "Correct the tooth number, surface or modifier, and resubmit as a corrected claim.",
    guidance: "A data defect, not a clinical dispute. Fix it at the source so it stops recurring.",
    overturnPrior: 0.65,
  },
  {
    carcCode: "204",
    cdtPrefix: "",
    disposition: "verify_writeoff",
    recommendedAction: "Confirm the service is genuinely outside the plan, then bill the patient if it was disclosed in advance.",
    guidance: "If the estimate promised coverage, this is a verification accuracy problem worth investigating.",
    overturnPrior: 0.2,
  },
  {
    carcCode: "227",
    cdtPrefix: "",
    disposition: "correct_resubmit",
    recommendedAction: "Contact the patient for the information the payer requested, then resubmit.",
    guidance: "The clock is the payer's, not the patient's — chase this quickly or it becomes a timely-filing loss.",
    overturnPrior: 0.6,
  },
];
