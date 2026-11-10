/**
 * Postgres playbook repository over the GLOBAL `payer_playbook_rules` table (migration 0004).
 *
 * Runs inside `withoutPractice` — deliberately. These rules have no tenant dimension: a rate learned
 * from one practice's appeal is exactly the knowledge the next practice should benefit from. Running
 * them under a practice context would be harmless but misleading, implying an isolation that the
 * table does not have and should not have.
 */
import { execute, many, one, withoutPractice, type Tx } from "@mermaid/db";
import type { Disposition } from "./knowledge.ts";
import { normalizePayerName } from "./knowledge.ts";
import type { PayerAlias, PayerRecord, PlaybookRepository, PlaybookRule } from "./repository.ts";

interface Row {
  id: string;
  payer_id: string | null;
  carc_code: string;
  cdt_code: string | null;
  disposition: string;
  recommended_action: string;
  guidance: string;
  overturn_rate: string | number;
  won_count: number;
  sample_size: number;
  trusted: boolean;
}

const toRule = (row: Row): PlaybookRule => ({
  id: row.id,
  payerId: row.payer_id,
  carcCode: row.carc_code,
  cdtPrefix: row.cdt_code ?? "",
  disposition: row.disposition as Disposition,
  recommendedAction: row.recommended_action,
  guidance: row.guidance,
  // NUMERIC comes back as a string by default; a rate is a ratio, never money, so Number is right.
  overturnRate: Number(row.overturn_rate),
  wonCount: row.won_count,
  sampleSize: row.sample_size,
  trusted: row.trusted,
});

interface PayerRow {
  edi_payer_id: string | null;
  name: string;
  filing_window_days: number;
  appeal_window_days: number;
  clearinghouse_id: string | null;
  /** From the LEFT JOIN in `listPayers`; absent on the single-row reads that do not need it. */
  aliases?: { alias: string; kind: PayerAlias["kind"] }[] | null;
}

const toPayer = (row: PayerRow): PayerRecord => ({
  slug: row.edi_payer_id ?? "",
  name: row.name,
  filingWindowDays: row.filing_window_days,
  appealWindowDays: row.appeal_window_days,
  ...(row.clearinghouse_id ? { clearinghouseId: row.clearinghouse_id } : {}),
  ...(row.aliases ? { aliases: row.aliases } : {}),
});

/**
 * One payer, with its aliases newest-longest-first. Shared by every read so `findPayer`,
 * `listPayers` and the row `upsertPayer` echoes back cannot come to disagree about a payer's shape
 * — which is precisely how the seeder ended up unable to tell a filled gap from an empty one.
 */
const PAYER_WITH_ALIASES = `
  SELECT p.*,
         COALESCE(
           (SELECT json_agg(json_build_object('alias', a.alias, 'kind', a.match_kind)
                            ORDER BY length(a.alias) DESC, a.alias)
              FROM payer_aliases a WHERE a.payer_id = p.id),
           '[]'::json
         ) AS aliases
    FROM payers p`;

export class PgPlaybookRepository implements PlaybookRepository {
  async findPayer(slug: string): Promise<PayerRecord | null> {
    return withoutPractice(async (tx: Tx) => {
      /**
       * The aliases come WITH the payer. Reading the row alone left `aliases` undefined, which the
       * seeder reads as "this payer has none" — so `ensurePayers` re-wrote all seven on every boot,
       * reported work it had not done, and could never converge. Caught by the idempotency test.
       */
      const row = await one<PayerRow>(tx, `${PAYER_WITH_ALIASES} WHERE p.edi_payer_id = $1`, [slug]);
      return row ? toPayer(row) : null;
    });
  }

  /**
   * Every catalogued payer with its aliases, in one read.
   *
   * `json_agg` rather than a second query: the matcher needs the whole table anyway, and two reads
   * would let the payers and their aliases come from different moments — which is exactly when a
   * newly-added payer appears with no way to recognise it.
   */
  async listPayers(): Promise<PayerRecord[]> {
    return withoutPractice(async (tx: Tx) =>
      (await many<PayerRow>(tx, `${PAYER_WITH_ALIASES} WHERE p.edi_payer_id IS NOT NULL ORDER BY p.name`)).map(
        toPayer
      )
    );
  }

  async upsertPayer(payer: PayerRecord): Promise<PayerRecord> {
    return withoutPractice(async (tx: Tx) => {
      const row = await one<PayerRow & { id: string }>(
        tx,
        `INSERT INTO payers (name, edi_payer_id, filing_window_days, appeal_window_days, clearinghouse_id)
         VALUES ($1,$2,$3,$4,$5)
         -- The index is PARTIAL (WHERE edi_payer_id IS NOT NULL), so the predicate has to be
         -- repeated here for Postgres to use it as the arbiter. Learned at M9, where an ON CONFLICT
         -- against a partial index failed on first contact with the database while the in-memory
         -- double accepted it happily.
         ON CONFLICT (edi_payer_id) WHERE edi_payer_id IS NOT NULL DO UPDATE
           SET name = EXCLUDED.name,
               filing_window_days = EXCLUDED.filing_window_days,
               appeal_window_days = EXCLUDED.appeal_window_days,
               -- Forward-only, like the payer on a coverage and the address on a patient: a caller
               -- that does not know the clearinghouse id must not erase the one already on file.
               clearinghouse_id = COALESCE(EXCLUDED.clearinghouse_id, payers.clearinghouse_id)
         RETURNING *`,
        [
          payer.name,
          payer.slug,
          payer.filingWindowDays,
          payer.appealWindowDays,
          payer.clearinghouseId ?? null,
        ]
      );

      /**
       * Aliases are replaced WHOLESALE when supplied and untouched when absent.
       *
       * Absent means "I am not talking about aliases", which is what `ensureDefaults` means on
       * every boot — so seeding cannot wipe what an administrator added. Supplied means "this is
       * the complete set", which is the only way an alias can ever be REMOVED from a screen.
       */
      if (payer.aliases) {
        await execute(tx, "DELETE FROM payer_aliases WHERE payer_id = $1", [row!.id]);
        for (const a of payer.aliases) {
          const alias = normalizePayerName(a.alias);
          if (!alias) continue;
          // A conflict means another payer already claims this alias. Skipped rather than failed:
          // the payer's own row is a fact worth keeping, and a routing collision is reported by
          // `payerCatalogConflicts` rather than by refusing to save.
          await execute(
            tx,
            `INSERT INTO payer_aliases (payer_id, alias, match_kind) VALUES ($1,$2,$3)
             ON CONFLICT (alias) DO NOTHING`,
            [row!.id, alias, a.kind]
          );
        }
      }

      const saved = await one<PayerRow>(tx, `${PAYER_WITH_ALIASES} WHERE p.id = $1`, [row!.id]);
      return toPayer(saved!);
    });
  }

  async retireClearinghouseId(slug: string, stale: string): Promise<boolean> {
    // The stale value is IN the predicate, so an administrator's own id can never be cleared — even
    // one written between the read that decided to retire and this statement.
    const changed = await withoutPractice((tx: Tx) =>
      execute(tx, "UPDATE payers SET clearinghouse_id = NULL WHERE edi_payer_id = $1 AND clearinghouse_id = $2", [
        slug,
        stale,
      ])
    );
    return changed > 0;
  }

  async findRules(carcCode: string): Promise<PlaybookRule[]> {
    return withoutPractice(async (tx: Tx) =>
      (await many<Row>(tx, "SELECT * FROM payer_playbook_rules WHERE carc_code = $1", [carcCode])).map(toRule)
    );
  }

  async listRules(payerId?: string | null): Promise<PlaybookRule[]> {
    return withoutPractice(async (tx: Tx) => {
      if (payerId === undefined) {
        return (await many<Row>(tx, "SELECT * FROM payer_playbook_rules ORDER BY carc_code, cdt_code NULLS FIRST")).map(toRule);
      }
      const rows = payerId === null
        ? await many<Row>(tx, "SELECT * FROM payer_playbook_rules WHERE payer_id IS NULL ORDER BY carc_code")
        : await many<Row>(tx, "SELECT * FROM payer_playbook_rules WHERE payer_id = $1 ORDER BY carc_code", [payerId]);
      return rows.map(toRule);
    });
  }

  async upsertRule(rule: PlaybookRule): Promise<PlaybookRule> {
    return withoutPractice(async (tx: Tx) => {
      const row = await one<Row>(
        tx,
        `INSERT INTO payer_playbook_rules
           (payer_id, carc_code, cdt_code, disposition, recommended_action, guidance,
            overturn_rate, won_count, sample_size, trusted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (COALESCE(payer_id, ''), carc_code, COALESCE(cdt_code, '')) DO UPDATE
           SET disposition = EXCLUDED.disposition,
               recommended_action = EXCLUDED.recommended_action,
               guidance = EXCLUDED.guidance,
               overturn_rate = EXCLUDED.overturn_rate,
               won_count = EXCLUDED.won_count,
               sample_size = EXCLUDED.sample_size,
               trusted = EXCLUDED.trusted
         RETURNING *`,
        [
          rule.payerId,
          rule.carcCode,
          rule.cdtPrefix || null,
          rule.disposition,
          rule.recommendedAction,
          rule.guidance,
          rule.overturnRate,
          rule.wonCount,
          rule.sampleSize,
          rule.trusted,
        ]
      );
      return toRule(row!);
    });
  }

  /**
   * The atomic learning write. The increment references the ROW'S OWN current counts
   * (`payer_playbook_rules.won_count + …`), never values the caller read earlier — which is what
   * lets two concurrent outcome events for one rule both land instead of the second erasing the
   * first. On first contact the INSERT seeds the identity fields from the caller and starts the
   * counts at this one observation.
   */
  async recordObservation(rule: PlaybookRule, won: boolean, trustThreshold: number): Promise<PlaybookRule> {
    return withoutPractice(async (tx: Tx) => {
      const row = await one<Row>(
        tx,
        `INSERT INTO payer_playbook_rules
           (payer_id, carc_code, cdt_code, disposition, recommended_action, guidance,
            overturn_rate, won_count, sample_size, trusted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1 >= $9)
         ON CONFLICT (COALESCE(payer_id, ''), carc_code, COALESCE(cdt_code, '')) DO UPDATE
           SET won_count   = payer_playbook_rules.won_count + $8,
               sample_size = payer_playbook_rules.sample_size + 1,
               trusted     = payer_playbook_rules.sample_size + 1 >= $9
         RETURNING *`,
        [
          rule.payerId,
          rule.carcCode,
          rule.cdtPrefix || null,
          rule.disposition,
          rule.recommendedAction,
          rule.guidance,
          rule.overturnRate,
          won ? 1 : 0,
          trustThreshold,
        ]
      );
      return toRule(row!);
    });
  }
}
