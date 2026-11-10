/**
 * Configuration that belongs to a PRACTICE rather than to a deployment (migration 0032).
 *
 * This package already owns per-practice feature flags; these are the same idea for values that are
 * not booleans. Two of them, and both were being read from the environment while being facts about
 * a practice:
 *
 *   jurisdictionState        which prompt-pay and recoupment statutes apply (F5)
 *   merchantDiscountRateBps  what a non-ACH payment cost to receive (F1)
 *
 * One deployment serving two practices gave both the same answer. A group with an Oregon office and
 * a Texas one got one state's law for both; two practices that do not share a merchant agreement got
 * one processor rate. Neither is a rounding error — the first decides whether a takeback is
 * disputable, the second multiplies real money on a screen.
 *
 * ── NULL IS AN ANSWER, NOT AN ABSENCE ──────────────────────────────────────────────────────────
 * Null means the practice has not stated it. Both features already know what to do with that: F5
 * raises nothing for a state it has no verified rule for, and F1 detects the payment but reports its
 * cost as unknown rather than as zero. Nothing here substitutes a plausible figure, which is the
 * whole reason these are nullable rather than defaulted.
 *
 * ── THE ENVIRONMENT IS THE FALLBACK, NOT THE OVERRIDE ──────────────────────────────────────────
 * A practice row wins where it states a value; the deployment's own configuration answers where it
 * does not. That ordering is what lets this be applied to a running single-practice deployment
 * without backfilling anything, and it is the direction that cannot silently change an answer: a
 * practice that has said nothing keeps exactly the answer it had yesterday.
 */
import { execute, one, practiceId, tx } from "@mermaid/db";

export interface PracticeSettings {
  /** Two-letter state code, upper-cased. Null when the practice has not stated one. */
  jurisdictionState: string | null;
  /** Basis points — 295 is 2.95%. Null when the practice has not stated a rate. */
  merchantDiscountRateBps: number | null;
}

export const NO_PRACTICE_SETTINGS: PracticeSettings = {
  jurisdictionState: null,
  merchantDiscountRateBps: null,
};

export interface PracticeSettingsRepository {
  /** This practice's stated settings. Never throws for a practice that has stated nothing. */
  get(): Promise<PracticeSettings>;
  /** Write the settings a practice has stated. Fields left undefined are not touched. */
  save(settings: Partial<PracticeSettings>): Promise<PracticeSettings>;
}

/** Validate a state code the way the column does, so a bad value is refused before it is stored. */
export function normalizeJurisdiction(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === "") return null;
  if (!/^[A-Z]{2}$/.test(trimmed)) {
    throw new Error(`"${value}" is not a two-letter state code`);
  }
  return trimmed;
}

/**
 * Validate a merchant rate the way `parseMerchantRateBps` validates the environment one.
 *
 * Bounded at 100%, and integral: a processor taking more than the payment is a typo, and a
 * fractional basis point is a unit error. Both would otherwise reach a screen as money.
 */
export function normalizeMerchantRate(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${value} is not a merchant discount rate in basis points (0–10000, whole numbers)`);
  }
  return value;
}

// ── In-memory ───────────────────────────────────────────────────────────────────────────────────

export class InMemoryPracticeSettingsRepository implements PracticeSettingsRepository {
  #settings: PracticeSettings = { ...NO_PRACTICE_SETTINGS };

  async get(): Promise<PracticeSettings> {
    return { ...this.#settings };
  }

  async save(settings: Partial<PracticeSettings>): Promise<PracticeSettings> {
    this.#settings = {
      jurisdictionState:
        settings.jurisdictionState === undefined
          ? this.#settings.jurisdictionState
          : normalizeJurisdiction(settings.jurisdictionState),
      merchantDiscountRateBps:
        settings.merchantDiscountRateBps === undefined
          ? this.#settings.merchantDiscountRateBps
          : normalizeMerchantRate(settings.merchantDiscountRateBps),
    };
    return { ...this.#settings };
  }
}

// ── Postgres ────────────────────────────────────────────────────────────────────────────────────

interface Row {
  jurisdiction_state: string | null;
  merchant_discount_rate_bps: number | null;
}

export class PgPracticeSettingsRepository implements PracticeSettingsRepository {
  async get(): Promise<PracticeSettings> {
    const row = await one<Row>(tx(), `SELECT * FROM practice_settings WHERE practice_id = $1`, [practiceId()]);
    /**
     * A practice with no row has stated nothing, which is exactly `NO_PRACTICE_SETTINGS`. Returned
     * rather than thrown so that applying this migration to a running deployment changes no
     * behaviour until somebody actually fills something in.
     */
    if (!row) return { ...NO_PRACTICE_SETTINGS };
    return {
      jurisdictionState: row.jurisdiction_state,
      merchantDiscountRateBps: row.merchant_discount_rate_bps === null ? null : Number(row.merchant_discount_rate_bps),
    };
  }

  async save(settings: Partial<PracticeSettings>): Promise<PracticeSettings> {
    const current = await this.get();
    const next: PracticeSettings = {
      jurisdictionState:
        settings.jurisdictionState === undefined
          ? current.jurisdictionState
          : normalizeJurisdiction(settings.jurisdictionState),
      merchantDiscountRateBps:
        settings.merchantDiscountRateBps === undefined
          ? current.merchantDiscountRateBps
          : normalizeMerchantRate(settings.merchantDiscountRateBps),
    };

    await execute(
      tx(),
      `INSERT INTO practice_settings (practice_id, jurisdiction_state, merchant_discount_rate_bps)
       VALUES ($1, $2, $3)
       ON CONFLICT (practice_id) DO UPDATE SET
         jurisdiction_state         = EXCLUDED.jurisdiction_state,
         merchant_discount_rate_bps = EXCLUDED.merchant_discount_rate_bps`,
      [practiceId(), next.jurisdictionState, next.merchantDiscountRateBps]
    );
    return next;
  }
}
