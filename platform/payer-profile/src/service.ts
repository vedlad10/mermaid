/**
 * The shared brain — what a payer does, and how often fighting it works.
 *
 * ── WHY THIS IS PLATFORM AND NOT A MODULE (a flagged deviation from blueprint doc 02) ──────────
 * Doc 02 lists Payer Profile among the six bounded contexts. It is implemented here in `platform/`
 * instead, for reasons that come from the blueprint's own design rather than from convenience:
 *
 *   • **The data is explicitly GLOBAL.** Migration 0004 creates `payers` and `payer_playbook_rules`
 *     with no `practice_id` and no RLS — deliberately, so overturn rates accumulate across every
 *     practice on the platform. It has no tenant dimension to isolate.
 *   • **The blueprint itself requires cross-context reads**: "written by Appeals, read by
 *     Verification". A peer module cannot be read by another module (docs/MODULE-BOUNDARIES.md,
 *     enforced in CI), so implementing it as one would mean either violating that rule or building
 *     event-projection machinery for data that has no tenant to project along.
 *   • **It is reference data plus learned statistics** — the same category as the CDT catalog and the
 *     CARC table, which already live in shared/platform and are imported freely.
 *
 * Platform is defined as the shared capabilities every module may depend on (db, events, auth, edi,
 * observability). A global payer knowledge base fits that definition exactly. Nothing else moves:
 * the tables are unchanged, Appeals is still the only writer, and the learning loop is unchanged.
 *
 * ── THE SMALL-SAMPLE GATE ──────────────────────────────────────────────────────────────────────
 * The single most dangerous thing a learning system can do here is swing a recommendation on one
 * practice's outlier. A rule earns `trusted` only after enough observations, and until then the
 * prior dominates. That gate is the reason a clinic can rely on the number at all (blueprint doc 11;
 * human-in-the-loop §9).
 */
import { categorizeAdjustment, describeCarc, type PayerWindowSource } from "@mermaid/shared";
import {
  DEFAULT_PLAYBOOK,
  PAYER_CATALOG,
  PURSUABLE,
  normalizePayerName,
  sourcedWindow,
  type Disposition,
} from "./knowledge.ts";
import type { PayerRecord, PlaybookRepository, PlaybookRule } from "./repository.ts";

/**
 * Observations required before a learned rate is trusted over its prior.
 *
 * Below this, the prior still dominates the blend; at or above it, the rule is marked `trusted` and
 * the UI may present the rate as evidence rather than as a guess.
 */
export const TRUST_THRESHOLD = 20;

/**
 * The prior's strength, in pseudo-observations.
 *
 * The rate presented to a user is the Beta-Binomial posterior mean:
 *
 *     rate = (prior × PRIOR_STRENGTH + wins) / (PRIOR_STRENGTH + observations)
 *
 * Which is to say: the prior counts as if it were `PRIOR_STRENGTH` outcomes we had already seen, and
 * real evidence progressively outweighs it.
 *
 * This replaced a FIXED 25/75 blend, which was wrong in a way only visible once the loop ran on real
 * data: with a single observation the "observed mean" is necessarily 0 or 1, so 75% of the answer
 * came from one coin flip — a won appeal moved a code from 30% to 83%. A queue that reprioritises a
 * practice's whole day on one data point is worse than one that never learns, because staff will
 * follow it for a week and then stop believing it.
 *
 * At half the trust threshold, the curve behaves the way a clinician would expect:
 *   0 outcomes → the prior exactly · 1 win → a nudge · 20 wins → evidence dominates ·
 *   50 wins → high, and still never certain.
 */
const PRIOR_STRENGTH = TRUST_THRESHOLD / 2;

/**
 * The posterior mean. Never reaches 0 or 1 for any finite evidence, which is the point: a rate of
 * exactly 0% would hide a recoverable code forever, and 100% would promise certain recovery.
 */
export function posteriorRate(prior: number, wonCount: number, sampleSize: number): number {
  return round3((prior * PRIOR_STRENGTH + wonCount) / (PRIOR_STRENGTH + sampleSize));
}

/**
 * How much a payer's own track record is allowed to move a verification's confidence.
 *
 * Bounded deliberately, and the bound was chosen by measurement rather than by feel.
 *
 * A representative verification scores its four existing components 0.75 (card extraction), 0.95
 * (payer identification), 0.76 (benefits retrieval) and 1.00 (patient data), for an overall of 0.82
 * against a 0.75 review threshold. Confidence is aggregated weakest-link — `avg × 0.6 + min × 0.4` —
 * so a fifth component below 0.75 becomes the new minimum and drags the result hard. An earlier
 * draft of this floored at 0.60 and sent every verification of a well-evidenced payer to a human,
 * which is not sharper estimating, it is a broken front desk.
 *
 * The floor is therefore set at the level where this term stops competing to be the weakest link.
 * A payer's general reliability is not a link in the extraction chain: "we could not read the card"
 * invalidates an estimate, whereas "this payer is often wrong" only contextualises it. At the worst
 * possible track record this term moves that representative verification from 0.82 to 0.80 — clear
 * of the threshold on its own, but enough to tip one that was already marginal. That is the intended
 * balance: evidence adjusts the answer, it never dictates it.
 *
 * The bound also guards the loop against itself. Confidence shifts review routing, routing shifts
 * which claims are filed, filing shifts which outcomes get recorded — a term with unbounded
 * authority over its own inputs is how a feedback loop drifts away from reality.
 */
const ACCURACY_INFLUENCE = 0.25;
const ACCURACY_FLOOR = 0.75;

/**
 * What this payer's own recorded history says about how reliable its first-pass decisions are.
 *
 * The signal is the overturn share: of the denials this payer issued that a human took to appeal,
 * how many were reversed. A payer whose refusals are frequently reversed is a payer whose stated
 * decisions are frequently wrong — which is precisely "this payer's historical accuracy" as roadmap
 * §7.3 and blueprint doc 11 §4 use the term, and it is the only such signal the shared brain
 * actually holds.
 *
 * `confidence` is null until there is enough evidence to say anything. That is not a neutral value
 * dressed up as an absence: a neutral 1.0 folded into the confidence average would RAISE the score
 * of every verification for every payer we know nothing about, which is the opposite of what
 * ignorance should do. The caller omits the component entirely instead.
 */
/** One payer as the verification matcher sees it: how to recognise it, and where to route it. */
export interface PayerConnector {
  payerId: string;
  payerName: string;
  clearinghouseId?: string;
  aliases: { alias: string; kind: "contains" | "word" }[];
}

/** What an administrator may state about a payer. Everything but the slug and name is optional. */
export interface PayerInput {
  slug: string;
  name: string;
  clearinghouseId?: string;
  filingWindowDays?: number;
  appealWindowDays?: number;
  aliases?: { alias: string; kind?: "contains" | "word" }[];
}

/**
 * The windows a payer gets when nobody has said. Deliberately the commercial-dental default rather
 * than something short: a deadline invented shorter than the real one makes staff chase claims that
 * were never at risk, and one invented longer loses money. 365/90 matches the table's own DEFAULT.
 */
const DEFAULT_FILING_WINDOW_DAYS = 365;
const DEFAULT_APPEAL_WINDOW_DAYS = 90;

export interface PayerAccuracy {
  payerId: string | null;
  /** Recorded appeal outcomes for this payer, across every rule. */
  observations: number;
  wins: number;
  /** Share of this payer's appealed denials that were reversed, 0–1. */
  overturnShare: number;
  /** 0–1 contribution to verification confidence, or null when the evidence is too thin to use. */
  confidence: number | null;
  /** True once `observations` clears TRUST_THRESHOLD — the same gate triage uses. */
  trusted: boolean;
  explanation: string;
}

export interface ResolvedRule {
  carcCode: string;
  carcDescription: string;
  disposition: Disposition;
  recommendedAction: string;
  guidance: string;
  /** Probability of recovery, 0–1: the prior, blended with observation once there is any. */
  overturnRate: number;
  /** How many outcomes this rate is based on. */
  sampleSize: number;
  /** True once `sampleSize` clears TRUST_THRESHOLD — the rate is evidence, not a guess. */
  trusted: boolean;
  /** Where the rule came from, so the UI can be honest about it. */
  source: "payer-learned" | "payer-rule" | "default-rule" | "carc-category";
  /** Whether this is worth a clinic's time. */
  pursuable: boolean;
  explain: string[];
}

/**
 * Specificity score — higher wins. A rule for THIS payer AND this procedure family beats a global
 * rule for the code, which beats the CARC's bare category.
 */
function specificity(rule: PlaybookRule): number {
  return (rule.payerId ? 2 : 0) + (rule.cdtPrefix ? 1 : 0);
}

export class PayerProfileService {
  #repo: PlaybookRepository;

  constructor(repo: PlaybookRepository) {
    this.#repo = repo;
  }

  /**
   * Resolve what to do about one denied line.
   *
   * Always returns something: an unrecognized CARC still gets a disposition derived from its
   * category in `@mermaid/shared`, because a denial with no recommendation is a denial nobody works.
   */
  async resolve(
    payerId: string | null,
    carcCode: string,
    cdtCode: string | null,
    /**
     * The CAS group the payer actually cited — `CO`, `PR`, `OA`, `PI`.
     *
     * Required, with no default, on purpose. `#fromCategory` used to hardcode `CO`, and the group
     * is not a detail: it is what decides whether the same CARC reads as a contract write-off, the
     * patient's balance, a coordination question or the payer's own reduction. A default would put
     * that guess back, silently, in the one place a caller is least likely to look.
     *
     * Nullable, not optional: `null` states "the group is not known here", which is the same
     * distinction `Denial.carcGroup` already draws for denials recorded before it was kept. An
     * unknown group is never read as `CO` — it falls to the recoverable default below.
     */
    group: string | null
  ): Promise<ResolvedRule> {
    const candidates = (await this.#repo.findRules(carcCode))
      .filter((r) => r.payerId === null || r.payerId === payerId)
      .filter((r) => !r.cdtPrefix || (cdtCode ?? "").toUpperCase().startsWith(r.cdtPrefix.toUpperCase()))
      .sort((a, b) => specificity(b) - specificity(a));

    const rule = candidates[0];
    const description = describeCarc(carcCode);

    if (!rule) return this.#fromCategory(carcCode, description, group);

    const explain: string[] = [`CARC ${carcCode}: ${description}`];
    const rate = posteriorRate(rule.overturnRate, rule.wonCount, rule.sampleSize);
    let source: ResolvedRule["source"] = rule.payerId ? "payer-rule" : "default-rule";

    if (rule.sampleSize >= TRUST_THRESHOLD) {
      source = rule.payerId ? "payer-learned" : "default-rule";
      explain.push(
        `Recovery odds ${pct(rate)} from ${rule.wonCount} win(s) in ${rule.sampleSize} recorded ` +
          `outcome(s) — trusted.`
      );
    } else if (rule.sampleSize > 0) {
      explain.push(
        `Recovery odds ${pct(rate)}, from only ${rule.wonCount} win(s) in ${rule.sampleSize} ` +
          `outcome(s) — provisional, below the ${TRUST_THRESHOLD}-sample threshold, so still ` +
          `weighted toward the ${pct(rule.overturnRate)} starting estimate.`
      );
    } else {
      explain.push(`Recovery odds ${pct(rate)} — a starting estimate; no outcomes recorded yet.`);
    }
    explain.push(rule.recommendedAction);
    if (rule.guidance) explain.push(rule.guidance);

    return {
      carcCode,
      carcDescription: description,
      disposition: rule.disposition,
      recommendedAction: rule.recommendedAction,
      guidance: rule.guidance,
      overturnRate: rate,
      sampleSize: rule.sampleSize,
      trusted: rule.trusted,
      source,
      pursuable: PURSUABLE.includes(rule.disposition),
      explain,
    };
  }

  /**
   * Record an appeal outcome.
   *
   * Stores the OBSERVATION, not a re-blended rate: a rate that has already been mixed with a prior
   * cannot be un-mixed, so the next update would compound its own output. Keeping `wonCount` and
   * `sampleSize` means the posterior is recomputed from first principles on every read, and the
   * prior stays visible as the separate number it is.
   */
  async recordOutcome(input: {
    payerId: string | null;
    carcCode: string;
    cdtCode: string | null;
    won: boolean;
  }): Promise<PlaybookRule> {
    // Match exactly as `resolve` does — global rules INCLUDED. A new payer-specific rule must
    // inherit the global rule's prior and disposition; filtering to the payer's own rules first
    // would leave a brand-new rule starting from an arbitrary default instead of from what the
    // platform already believes about that code.
    const best = (await this.#repo.findRules(input.carcCode))
      .filter((r) => r.payerId === null || r.payerId === input.payerId)
      .filter((r) => !r.cdtPrefix || (input.cdtCode ?? "").toUpperCase().startsWith(r.cdtPrefix.toUpperCase()))
      .sort((a, b) => specificity(b) - specificity(a))[0];
    const existing = best && best.payerId === input.payerId ? best : undefined;

    /**
     * Learning is recorded against a PAYER-specific rule — a global default is a starting belief
     * shared by every practice, and one payer's behaviour must never rewrite it for everyone.
     *
     * The write is a single ATOMIC observation (`recordObservation`), never a read-modify-write of
     * absolute counts. This used to read the rule, add one, and upsert the totals back — so two
     * outcome events for the same rule handled concurrently (the request drain and the background
     * worker both run) each read the same starting counts and the second commit erased the first
     * observation. A lost observation is a lost piece of the only real-world evidence this system
     * ever receives, and `sampleSize` gates `trusted`, so losses also keep a rule provisional past
     * the point it earned better.
     */
    const seed: PlaybookRule = existing ?? {
      payerId: input.payerId,
      carcCode: input.carcCode,
      cdtPrefix: best?.cdtPrefix ?? "",
      disposition:
        best?.disposition ??
        /**
         * No CAS group here, and none is invented. An appeal outcome arrives from the event
         * bus carrying the payer, the code, the procedure and the result — not the group the
         * original adjustment came under. Passing `null` says exactly that, and the seeded
         * disposition falls to the recoverable default, which is also the honest starting
         * belief for a code somebody thought worth appealing.
         */
        (await this.resolve(input.payerId, input.carcCode, input.cdtCode, null)).disposition,
      recommendedAction: best?.recommendedAction ?? "",
      guidance: best?.guidance ?? "",
      // Inherits the matched rule's PRIOR as its starting belief — what the platform already
      // believes about this code, before this payer has told us anything. Stays the PRIOR forever;
      // the posterior is derived on read.
      overturnRate: best?.overturnRate ?? 0.4,
      wonCount: 0,
      sampleSize: 0,
      trusted: false,
    };

    return this.#repo.recordObservation(seed, input.won, TRUST_THRESHOLD);
  }

  /**
   * ── WHERE THE LEARNING LOOP REACHES THE FRONT HALF ─────────────────────────────────────────────
   *
   * How reliable this payer's own decisions have proven to be, for use as a confidence component on
   * the NEXT verification. This is the read that closes `S -.sharpens.-> D` in the unified RCM
   * workflow — the edge that makes an appeal outcome improve an estimate rather than only improving
   * the triage of the next denial.
   *
   * Read directly rather than through a `payer_rule.updated` event and a Verification-side
   * projection (blueprint docs 05/11 describe the latter). A projection is how a MODULE would have
   * to consume this; the payer profile is platform precisely because its data is global, has no
   * tenant dimension, and is meant to be read across contexts. Copying it into a per-module cache
   * would add machinery whose only job is to go stale.
   *
   * Below the trust threshold this returns `confidence: null` and the caller adds no component at
   * all — human-in-the-loop §9's small-sample sanity gate, applied to the front half exactly as it
   * already is to triage.
   */
  async payerAccuracy(payerId: string | null): Promise<PayerAccuracy> {
    const unproven = (observations: number, wins: number, explanation: string): PayerAccuracy => ({
      payerId,
      observations,
      wins,
      overturnShare: 0,
      confidence: null,
      trusted: false,
      explanation,
    });

    if (!payerId) {
      return unproven(0, 0, "No payer was identified, so there is no track record to draw on.");
    }

    // Payer-specific rules only. A platform default carries what we believe about a CODE, not about
    // THIS payer — folding it in here would let every payer inherit an accuracy it never earned.
    const rules = await this.#repo.listRules(payerId);
    const observations = rules.reduce((sum, r) => sum + r.sampleSize, 0);
    const wins = rules.reduce((sum, r) => sum + r.wonCount, 0);

    if (observations < TRUST_THRESHOLD) {
      return unproven(
        observations,
        wins,
        observations === 0
          ? "No appeal outcomes recorded for this payer yet, so its track record cannot affect this estimate."
          : `Only ${observations} recorded appeal outcome(s) for this payer — below the ` +
              `${TRUST_THRESHOLD}-outcome threshold, so its track record does not affect this estimate yet.`
      );
    }

    const overturnShare = wins / observations;
    const confidence = round3(clamp(1 - overturnShare * ACCURACY_INFLUENCE, ACCURACY_FLOOR, 1));

    return {
      payerId,
      observations,
      wins,
      overturnShare: round3(overturnShare),
      confidence,
      trusted: true,
      explanation:
        `${pct(overturnShare)} of this payer's appealed denials were overturned ` +
        `(${wins} of ${observations} recorded outcomes). ` +
        (overturnShare >= 0.5
          ? "Its first-pass decisions are reversed more often than not, so treat what it reports with more caution."
          : "Its first-pass decisions have largely held up, which supports this estimate."),
    };
  }

  /** Every rule, for the payer-profile admin view. */
  async listRules(payerId?: string | null): Promise<PlaybookRule[]> {
    return this.#repo.listRules(payerId);
  }

  /**
   * How long this payer allows between date of service and receipt of the claim.
   *
   * Null when the payer is not in the catalog — the caller keeps its own documented default rather
   * than being handed a guess dressed as a fact. A claim whose deadline is silently wrong is
   * unrecoverable revenue, so "I do not know" has to be distinguishable from a number.
   */
  async filingWindowDays(payerId: string | null): Promise<number | null> {
    if (!payerId) return null;
    const payer = await this.#repo.findPayer(payerId);
    return payer?.filingWindowDays ?? null;
  }

  /**
   * How long this payer allows between its own determination and an appeal.
   *
   * ── WHY THIS EXISTS NOW AND NOT BEFORE (M5) ────────────────────────────────────────────────────
   * `payers.appeal_window_days` has been on the table since migration 0004, seeded per payer in
   * `PAYER_CATALOG` since 0014, and read into `Payer` by the repository the whole time — and nothing
   * ever called for it. Denials & Appeals stamped every deadline as `now + 90 days` from a local
   * constant, so a biller working an Aetna denial (catalogued at 60) was shown thirty days of runway
   * that did not exist. The data was already right; there was simply no reader.
   *
   * Null when the payer is not catalogued, exactly as `filingWindowDays` is null, and for the same
   * reason: the caller keeps its own documented default rather than being handed a guess dressed as
   * a fact. A deadline that is silently wrong is unrecoverable revenue, so "I do not know" has to be
   * distinguishable from a number.
   */
  async appealWindowDays(payerId: string | null): Promise<number | null> {
    if (!payerId) return null;
    const payer = await this.#repo.findPayer(payerId);
    return payer?.appealWindowDays ?? null;
  }

  /**
   * The payer's own citation for the window a caller actually USED, or null when it is an estimate
   * (B-1).
   *
   * Takes the days rather than reading the row again, so the answer describes exactly the number
   * that produced the caller's date — never a row edited in between. Pure: citations ship with the
   * catalog, and a figure the catalog cannot cite is an estimate whatever the database says.
   */
  sourceOfWindow(
    payerId: string | null,
    kind: "filing" | "appeal",
    days: number | null | undefined
  ): PayerWindowSource | null {
    return sourcedWindow(payerId, kind, days);
  }

  /**
   * Seed the payer catalog. Idempotent — safe on every boot, like the playbook below.
   *
   * An EXISTING payer is left entirely alone, including its aliases and its clearinghouse id. That
   * is what makes the catalog editable: an administrator who corrects Aetna's filing window, or
   * adds the spelling their cards actually use, must not have it reverted by the next deploy.
   *
   * The consequence, stated because it is easy to trip over: correcting a value in `PAYER_CATALOG`
   * does NOT propagate to a database that already has the row. That is a deliberate trade — a seed
   * that overwrote would make the table read-only in practice — and the way to change a catalogued
   * payer is the admin route, which is the whole point of NEW-08.
   *
   * One exception, and it is narrow (B-1): a window still holding exactly a guess the seed records in
   * `supersededGuesses` is replaced by the sourced value. See below.
   */
  async ensurePayers(): Promise<number> {
    let written = 0;
    for (const seed of PAYER_CATALOG) {
      const seedAliases = seed.aliases.map((a) => ({ alias: a.alias, kind: a.kind ?? ("contains" as const) }));
      const existing = await this.#repo.findPayer(seed.slug);

      if (!existing) {
        await this.#repo.upsertPayer({
          slug: seed.slug,
          name: seed.name,
          filingWindowDays: seed.filingWindowDays,
          appealWindowDays: seed.appealWindowDays,
          ...(seed.clearinghouseId ? { clearinghouseId: seed.clearinghouseId } : {}),
          aliases: seedAliases,
        });
        written += 1;
        continue;
      }

      /**
       * ── FILLING A GAP IS NOT OVERWRITING (NEW-08) ──────────────────────────────────────────────
       * A database seeded before aliases and clearinghouse ids existed holds these seven payers with
       * NEITHER. Skipping every existing row — which is what this did — would leave such a
       * deployment with a catalog that recognises no insurance card at all, because the matcher now
       * reads the table and the table would have nothing to match on. That is a worse outcome than
       * the hardcoded array it replaces.
       *
       * So a field that is EMPTY is filled from the seed, and a field that has a value is left
       * alone. An administrator's correction survives every boot; a gap left by an older schema
       * closes itself once.
       */
      const missingAliases = (existing.aliases ?? []).length === 0;
      const guesses = seed.supersededGuesses;
      /**
       * A routing id the catalog shipped and has since retracted is retired first — only while the
       * stored value is exactly that one; an id an administrator set is somebody's decision. Generic
       * "Delta Dental" once sent every card to 77777 (Delta Dental of California); MetLife was filed
       * under an alias (65978) where Stedi's primary is 10134. Retired BEFORE the gap check below, so
       * a seed that has a newer id fills it in the same boot rather than the next.
       */
      let current = existing;
      let retired = false;
      if (guesses?.clearinghouseId !== undefined && existing.clearinghouseId === guesses.clearinghouseId) {
        retired = await this.#repo.retireClearinghouseId(seed.slug, guesses.clearinghouseId);
        // Dropped from the record too, or the upsert below would write the retired id straight back.
        const { clearinghouseId: _retired, ...rest } = existing;
        current = rest;
      }
      /**
       * A gap only counts when the seed can actually close it. Moda has no clearinghouse id in the
       * catalog — that is a fact about this deployment, not an omission — so treating its absence
       * as a gap made `ensurePayers` rewrite that row on every single boot and report work it had
       * not done. Caught by the idempotency test, which is exactly what that test is for.
       */
      const missingClearinghouseId = !current.clearinghouseId && Boolean(seed.clearinghouseId);
      /**
       * ── REPLACING MERMAID'S OWN GUESS IS NOT OVERWRITING AN EDIT (B-1) ─────────────────────────
       * A window still holding EXACTLY the unsourced figure this catalog once shipped is not a
       * correction anybody made; it is the seed's old mistake, still standing in every database
       * seeded before the payer's own document was read. Leaving it would mean the sourced value
       * reached only fresh databases — staging would keep telling billers Aetna allows 180 days to
       * file. Any OTHER stored value is somebody's decision and survives, as it always has.
       *
       * The one case this cannot tell apart: an administrator who deliberately typed the old guess.
       * That is choosing a number the payer's own document contradicts, and the correction it gets
       * is the documented one — the new value can be edited back through the same admin route.
       */
      const staleFiling = guesses?.filingWindowDays !== undefined && existing.filingWindowDays === guesses.filingWindowDays;
      const staleAppeal = guesses?.appealWindowDays !== undefined && existing.appealWindowDays === guesses.appealWindowDays;
      if (!missingAliases && !missingClearinghouseId && !staleFiling && !staleAppeal) {
        // Counted per ROW, like every other path here: a retirement alone is one row changed.
        if (retired) written += 1;
        continue;
      }

      await this.#repo.upsertPayer({
        ...current,
        ...(staleFiling ? { filingWindowDays: seed.filingWindowDays } : {}),
        ...(staleAppeal ? { appealWindowDays: seed.appealWindowDays } : {}),
        ...(missingClearinghouseId ? { clearinghouseId: seed.clearinghouseId! } : {}),
        // Absent leaves the stored aliases untouched — the same asymmetry `upsertPayer` documents.
        ...(missingAliases ? { aliases: seedAliases } : {}),
      });
      written += 1;
    }
    return written;
  }

  /**
   * The routing table verification matches a card against (NEW-08).
   *
   * ── WHY THE CALLER GETS THE WHOLE CATALOG, NOT AN ANSWER ─────────────────────────────────────
   * `identifyPayer` stays a PURE function of a name and a directory. It runs inside the
   * verification pipeline, which is deterministic by design — two identical clinics must produce
   * identical claims — and a step that reached into a database mid-pipeline would make that
   * untestable without one, and unreproducible when the catalog changed between runs.
   *
   * So the catalog is read ONCE, at the edge of a verification, and passed in. The pipeline stays a
   * function of its inputs and the catalog stays data.
   */
  async connectors(): Promise<PayerConnector[]> {
    return (await this.#repo.listPayers()).map((p) => ({
      payerId: p.slug,
      payerName: p.name,
      ...(p.clearinghouseId ? { clearinghouseId: p.clearinghouseId } : {}),
      aliases: (p.aliases ?? []).map((a) => ({ alias: a.alias, kind: a.kind })),
    }));
  }

  /**
   * Add or correct one payer from an authenticated screen, without a deploy.
   *
   * The slug is normalised the same way an alias is, so `Delta Dental` and `delta-dental` cannot
   * become two payers keyed on one identity — the slug is what every module, coverage snapshot and
   * domain event carries, and two of them for one payer is a split ledger.
   */
  async savePayer(input: PayerInput): Promise<PayerRecord> {
    const slug = normalizePayerName(input.slug).replace(/ /g, "-");
    if (!slug) throw new Error("a payer needs a slug");
    if (!input.name.trim()) throw new Error("a payer needs a name");

    const existing = await this.#repo.findPayer(slug);
    return this.#repo.upsertPayer({
      slug,
      name: input.name.trim(),
      filingWindowDays: input.filingWindowDays ?? existing?.filingWindowDays ?? DEFAULT_FILING_WINDOW_DAYS,
      appealWindowDays: input.appealWindowDays ?? existing?.appealWindowDays ?? DEFAULT_APPEAL_WINDOW_DAYS,
      ...(input.clearinghouseId?.trim() ? { clearinghouseId: input.clearinghouseId.trim() } : {}),
      // Absent leaves the aliases alone; an empty array is a deliberate statement that this payer
      // should no longer be recognised from a card, which is a thing an administrator may mean.
      ...(input.aliases
        ? {
            aliases: input.aliases.map((a) => ({
              alias: normalizePayerName(a.alias),
              kind: a.kind ?? "contains",
            })),
          }
        : {}),
    });
  }

  /**
   * Aliases that more than one payer wants, and payers nothing can recognise.
   *
   * Surfaced rather than enforced at write time: refusing to save a payer because its alias is
   * taken loses the payer's windows and clearinghouse id too, which are useful on their own. The
   * database keeps routing unambiguous (`uq_payer_aliases_alias`); this is what tells a human that
   * their new alias did not take effect, instead of leaving them to wonder why cards still route
   * to the old payer.
   */
  async catalogWarnings(): Promise<string[]> {
    const payers = await this.#repo.listPayers();
    const warnings: string[] = [];
    for (const p of payers) {
      if ((p.aliases ?? []).length === 0) {
        warnings.push(
          `"${p.name}" (${p.slug}) has no card aliases, so no insurance card can be matched to it. ` +
            `It is catalogued for reporting only.`
        );
      }
      if (!p.clearinghouseId) {
        warnings.push(
          `"${p.name}" (${p.slug}) has no clearinghouse id, so an eligibility check for it cannot ` +
            `be routed. Verification will say so rather than guessing.`
        );
      }
    }
    return warnings;
  }

  /** Seed the default playbook. Idempotent — safe on every boot. */
  async ensureDefaults(): Promise<number> {
    let written = 0;
    await this.ensurePayers();
    for (const seed of DEFAULT_PLAYBOOK) {
      const already = (await this.#repo.findRules(seed.carcCode)).some(
        (r) => r.payerId === null && r.cdtPrefix === seed.cdtPrefix
      );
      if (already) continue;
      await this.#repo.upsertRule({
        payerId: null,
        carcCode: seed.carcCode,
        cdtPrefix: seed.cdtPrefix,
        disposition: seed.disposition,
        recommendedAction: seed.recommendedAction,
        guidance: seed.guidance,
        overturnRate: seed.overturnPrior,
        wonCount: 0,
        sampleSize: 0,
        trusted: false,
      });
      written += 1;
    }
    return written;
  }

  /**
   * Last resort: derive a disposition from the CARC's category alone.
   *
   * `@mermaid/shared` already knows whether a code means "contractual", "the patient's" or
   * "recoverable". An unknown code therefore still produces a safe recommendation rather than a
   * blank one — and defaults to *recoverable*, because the safe failure is making a human look at
   * money we did not receive.
   *
   * ── THE GROUP IS THE PAYER'S, NOT A CONSTANT ───────────────────────────────────────────────────
   * This passed a hardcoded `CO` to `categorizeAdjustment`, so every denial with no playbook rule
   * was triaged as though the payer had cited a contract term. It is not a cosmetic detail — the
   * group changes the answer outright:
   *
   *   `PR` → the patient's balance, never a write-off
   *   `OA` → a coordination question; another plan is involved and has not been accounted for
   *   `PI` → the payer's OWN reduction, so even a fee-schedule code is worth questioning rather
   *          than posting as a contractual adjustment
   *
   * `toReason` already documents why that distinction matters. Now the derivation uses it.
   */
  #fromCategory(carcCode: string, description: string, group: string | null): ResolvedRule {
    // An unknown group is passed through as unknown, never as `CO`. `categorizeAdjustment` then
    // recognises no group-specific rule and the code falls to the recoverable default — a human
    // looks at money we did not receive, which is this method's stated safe failure.
    const category = categorizeAdjustment(group ?? "", carcCode);
    const disposition: Disposition =
      category === "contractual" ? "post_normal" : category === "patient" ? "patient_resp" : "appeal";
    return {
      carcCode,
      carcDescription: description,
      disposition,
      recommendedAction:
        disposition === "appeal"
          ? "No playbook rule exists for this code yet. Review the payer's explanation and decide whether to appeal."
          : disposition === "patient_resp"
            ? "The payer owes nothing under this code. Transfer the balance to the patient."
            : "A contractual adjustment. Post it and move on.",
      guidance: "",
      overturnRate: disposition === "appeal" ? 0.4 : 0.05,
      sampleSize: 0,
      trusted: false,
      source: "carc-category",
      pursuable: PURSUABLE.includes(disposition),
      explain: [
        `CARC ${carcCode}: ${description}`,
        `No playbook rule matched, so the disposition comes from the code's category (${category}).`,
      ],
    };
  }
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
