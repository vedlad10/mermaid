/**
 * Playbook persistence seam.
 *
 * `payers` and `payer_playbook_rules` are GLOBAL — no `practice_id`, no RLS (migration 0004) —
 * because overturn rates are only meaningful when they accumulate across every practice on the
 * platform. One clinic appealing three CO-197s learns nothing; a thousand clinics appealing them
 * learns a great deal. That is the whole point of a shared brain, and it is why these queries run
 * WITHOUT a practice context.
 */
import type { Disposition } from "./knowledge.ts";
import { normalizePayerName } from "./knowledge.ts";

export interface PlaybookRule {
  id?: string;
  /** Null = a platform-wide default rule for this code. */
  payerId: string | null;
  carcCode: string;
  /** Applies only to CDT codes starting with this prefix; empty = any procedure. */
  cdtPrefix: string;
  disposition: Disposition;
  recommendedAction: string;
  guidance: string;
  /**
   * The PRIOR probability of recovery — a starting belief, not an observation. The rate shown to a
   * user is the posterior computed from this plus the evidence below (see `service.ts`).
   */
  overturnRate: number;
  /** Appeals won, out of `sampleSize` recorded outcomes. */
  wonCount: number;
  sampleSize: number;
  trusted: boolean;
}

/**
 * A payer's own rules of engagement — how long it allows for filing and for appealing.
 *
 * Keyed by the clearinghouse SLUG (`payers.edi_payer_id`), because that is the identifier every
 * module actually carries; `payers.id` is a UUID nothing holds. Migration 0009 already settled this
 * question for the playbook and the same answer applies here.
 */
export interface PayerRecord {
  /** The clearinghouse slug — `delta-dental`, `aetna-dental`. */
  slug: string;
  name: string;
  filingWindowDays: number;
  appealWindowDays: number;
  /**
   * The payer's id AT THE CLEARINGHOUSE. A different namespace from `slug`, significant to the
   * leading zero, and absent when this deployment has none (NEW-08).
   */
  clearinghouseId?: string;
  /**
   * What a card may say for this payer. Empty means the catalog holds the payer for reporting but
   * cannot RECOGNISE it — a legitimate state, and a different one from not holding it at all.
   */
  aliases?: readonly PayerAlias[];
}

/** One thing a card may say. Stored normalised; see `normalizePayerName`. */
export interface PayerAlias {
  alias: string;
  /**
   * `contains` — anywhere in the normalised name. `word` — as a whole word, for a short or
   * ambiguous alias that would otherwise capture cards belonging to somebody else.
   */
  kind: "contains" | "word";
}

export interface PlaybookRepository {
  /** Every rule for one CARC code, any payer. The caller filters and ranks by specificity. */
  findRules(carcCode: string): Promise<PlaybookRule[]>;
  listRules(payerId?: string | null): Promise<PlaybookRule[]>;
  /** Insert or update, keyed on (payerId, carcCode, cdtPrefix). */
  upsertRule(rule: PlaybookRule): Promise<PlaybookRule>;
  /**
   * Record ONE appeal outcome against a rule, atomically.
   *
   * ── WHY THIS IS NOT `upsertRule` WITH INCREMENTED FIELDS ──────────────────────────────────────
   * `upsertRule` writes ABSOLUTE counts, so the learning path was read-modify-write: read the rule,
   * add one, write the totals back. Two outcome events for the same rule handled concurrently — the
   * request drain and the background worker both run — each read the same starting counts and the
   * second commit erased the first observation. `sampleSize` is not bookkeeping: it gates `trusted`
   * and weights the posterior, so every lost observation keeps a rule provisional longer and
   * misweights every rate derived from it.
   *
   * `rule` supplies the identity and the SEED values used only if the row does not exist yet; the
   * increment itself happens in one statement, so concurrent observations commute instead of racing.
   * `trustThreshold` travels as a parameter because the store must derive `trusted` from the count
   * IT produces, not from a count the caller read earlier.
   */
  recordObservation(rule: PlaybookRule, won: boolean, trustThreshold: number): Promise<PlaybookRule>;
  /** One payer by slug, or null when the catalog has never heard of it. */
  findPayer(slug: string): Promise<PayerRecord | null>;
  /**
   * Every catalogued payer, with its aliases — the routing table verification matches a card
   * against (NEW-08).
   *
   * Read whole rather than queried per card on purpose: matching is a decision over the WHOLE
   * catalog (a longer alias must beat a shorter one, and two payers claiming one alias is a
   * conflict), and a catalog of this size is a single small read.
   */
  listPayers(): Promise<PayerRecord[]>;
  /**
   * Insert or update a payer, keyed on the slug.
   *
   * Aliases are replaced WHOLESALE when supplied and left alone when `aliases` is absent. That
   * asymmetry is deliberate and mirrors the patient address: an edit that names them is stating the
   * complete set (so one can be removed), while `ensureDefaults` re-running at boot must not wipe
   * the aliases an administrator added.
   */
  upsertPayer(payer: PayerRecord): Promise<PayerRecord>;
  /**
   * Clear a payer's clearinghouse id, but ONLY while it still holds `stale` — a value the catalog
   * itself once shipped and has since retracted. Returns whether anything changed.
   *
   * `upsertPayer` cannot do this: it is forward-only on the id, so a caller that does not know it
   * cannot erase it. Conditional on the exact stale value so an administrator's own entry survives.
   */
  retireClearinghouseId(slug: string, stale: string): Promise<boolean>;
}

/** Deep enough that a caller mutating an alias cannot rewrite the routing table for everyone. */
const clonePayer = (p: PayerRecord): PayerRecord => ({
  ...p,
  ...(p.aliases ? { aliases: p.aliases.map((a) => ({ ...a })) } : {}),
});

const key = (r: Pick<PlaybookRule, "payerId" | "carcCode" | "cdtPrefix">): string =>
  `${r.payerId ?? "*"}|${r.carcCode}|${r.cdtPrefix}`;

export class InMemoryPlaybookRepository implements PlaybookRepository {
  #rules = new Map<string, PlaybookRule>();
  #payers = new Map<string, PayerRecord>();

  async findPayer(slug: string): Promise<PayerRecord | null> {
    const found = this.#payers.get(slug);
    return found ? clonePayer(found) : null;
  }

  async listPayers(): Promise<PayerRecord[]> {
    return [...this.#payers.values()]
      .map(clonePayer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertPayer(payer: PayerRecord): Promise<PayerRecord> {
    // Aliases replaced wholesale when supplied, preserved when absent — the twin of the Postgres
    // rule, and the reason `ensureDefaults` at boot cannot wipe what an administrator added. Both
    // implementations are held to this by `repository-contract.test.ts`.
    const existing = this.#payers.get(payer.slug);
    const aliases = (payer.aliases ?? existing?.aliases ?? []).map((a) => ({
      alias: normalizePayerName(a.alias),
      kind: a.kind,
    }));
    /**
     * One alias means one payer, mirroring `uq_payer_aliases_alias`. The FIRST claimant keeps it —
     * Postgres's `ON CONFLICT (alias) DO NOTHING` does the same — because routing that depends on
     * which row was written last is how an eligibility request reaches the wrong company.
     */
    const taken = new Set(
      [...this.#payers.values()]
        .filter((p) => p.slug !== payer.slug)
        .flatMap((p) => (p.aliases ?? []).map((a) => a.alias))
    );
    const stored: PayerRecord = {
      ...payer,
      aliases: aliases.filter((a) => a.alias && !taken.has(a.alias)),
    };
    this.#payers.set(payer.slug, stored);
    return clonePayer(stored);
  }

  async retireClearinghouseId(slug: string, stale: string): Promise<boolean> {
    const existing = this.#payers.get(slug);
    if (!existing || existing.clearinghouseId !== stale) return false;
    const { clearinghouseId: _retired, ...rest } = existing;
    this.#payers.set(slug, rest);
    return true;
  }

  async findRules(carcCode: string): Promise<PlaybookRule[]> {
    return [...this.#rules.values()]
      .filter((r) => r.carcCode === carcCode)
      .map((r) => ({ ...r }));
  }

  async listRules(payerId?: string | null): Promise<PlaybookRule[]> {
    const all = [...this.#rules.values()].map((r) => ({ ...r }));
    if (payerId === undefined) return all;
    return all.filter((r) => r.payerId === payerId);
  }

  async upsertRule(rule: PlaybookRule): Promise<PlaybookRule> {
    const stored = { ...rule, id: rule.id ?? key(rule) };
    this.#rules.set(key(rule), stored);
    return { ...stored };
  }

  /** Single-threaded, so the increment is trivially atomic — the contract lives in Postgres. */
  async recordObservation(rule: PlaybookRule, won: boolean, trustThreshold: number): Promise<PlaybookRule> {
    const existing = this.#rules.get(key(rule));
    const base = existing ?? { ...rule, id: rule.id ?? key(rule), wonCount: 0, sampleSize: 0 };
    const sampleSize = base.sampleSize + 1;
    const updated: PlaybookRule = {
      ...base,
      wonCount: base.wonCount + (won ? 1 : 0),
      sampleSize,
      trusted: sampleSize >= trustThreshold,
    };
    this.#rules.set(key(rule), updated);
    return { ...updated };
  }

  get size(): number {
    return this.#rules.size;
  }
}
