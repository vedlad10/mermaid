/**
 * Deterministic mock member profile — ported from Dental Verify's connector mock. Stable per member
 * ID so demos and tests are reproducible. Money is in dollars here (the 271 wire format); the adapter
 * converts to cents. Tier-2 fields (waiting periods, frequency limits, exclusions) model the payer
 * portal that real 271s don't carry (blueprint doc 09).
 *
 * Demo behaviors staff can rely on:
 *   • member IDs ending "00" → inactive coverage
 *   • member IDs ending "99" → annual maximum nearly exhausted
 *   • member IDs ending "77" → major services need PRE-AUTHORIZATION before treatment
 *   • member IDs ending "66" → 12-month waiting period on major services
 */
import type {
  FrequencyLimit,
  PreAuthorizationPolicy,
  ProcedureCategory,
  WaitingPeriod,
} from "@mermaid/shared";

export interface MockProfile {
  active: boolean;
  coveragePercentages: Record<ProcedureCategory, number>;
  deductibleAnnual: number;
  deductibleRemaining: number;
  annualMaximum: number;
  annualMaximumRemaining: number;
  waitingPeriods: WaitingPeriod[];
  frequencyLimits: FrequencyLimit[];
  exclusions: string[];
  excludedCodes: string[];
  /**
   * The plan's pre-authorization rule, or `undefined` when this mock plan does not publish one.
   *
   * Undefined is the DEFAULT and is meaningful: it reaches the estimate as `unknown`, which is what
   * a real 271 produces, because payers publish these rules in portals rather than on the wire.
   * A mock that answered "not required" for every ordinary plan would teach the rest of the system
   * a confidence no payer ever provides.
   */
  preAuthorization?: PreAuthorizationPolicy;
}

/**
 * Bit-slice a hash into a small non-negative range.
 *
 * ── WHY THIS EXISTS RATHER THAN `>>` INLINE ────────────────────────────────────────────────────
 * `hashId` returns a uint32, and JavaScript's `>>` is a SIGNED shift: for any hash at or above
 * 2^31 — about half of them — `h >> n` is negative, and `negative % k` is negative in JavaScript.
 * So member IDs hashing into the top half of the range produced `FrequencyLimit.used: -1`, and
 * `annualMaximumRemaining` GREATER than `annualMaximum` (a plan reporting more money left than it
 * has). `>>>` is the unsigned shift, which is what every one of these callers meant.
 *
 * Mock-only — no production path reaches this file — but a mock that emits states no payer can
 * produce teaches the rest of the system a shape it will never see, which is the failure mode the
 * mock/parser split exists to avoid.
 */
const slice = (h: number, shift: number, modulo: number): number => (h >>> shift) % modulo;

function hashId(memberId: string): number {
  let h = 0;
  for (const ch of memberId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function mockProfile(memberId: string, today: Date): MockProfile {
  const h = hashId(memberId);
  const inactive = memberId.endsWith("00");
  const nearMax = memberId.endsWith("99");
  /**
   * `77` now models a plan that requires PRE-AUTHORIZATION for major work, and `66` keeps the
   * waiting-period behaviour it used to carry.
   *
   * They were the same suffix, and that is what made Pia Phase32's scenario incoherent: her
   * benefits said the crown sat inside a 12-month waiting period while both of her ERAs refused and
   * then paid it under CARC 197, "pre-authorization absent". Two different facts about one tooth,
   * and only one of them was ever appealable — a waiting period is not overturned by obtaining an
   * authorisation.
   */
  const preAuth = memberId.endsWith("77");
  const waiting = memberId.endsWith("66");

  const annualMax = 1500 + (h % 3) * 250; // 1500 / 1750 / 2000
  const used = nearMax ? annualMax - 120 : slice(h, 4, Math.floor(annualMax * 0.5));
  const deductible = 50;
  const deductibleMet = slice(h, 8, 2) === 0;
  /**
   * Built in UTC, not host-local time.
   *
   * `new Date(y, m, 1)` is midnight LOCAL, and `.toISOString()` then renders it in UTC — so on a
   * host east of Greenwich the first of the month came back as the last day of the PREVIOUS month.
   * The fixture's own waiting-period start therefore moved with the developer's clock, which is
   * exactly the kind of test-data drift that makes a boundary assertion mean different things on
   * different machines.
   */
  const effectiveDate = waiting
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 4, 1))
    : new Date(Date.UTC(today.getUTCFullYear() - 2, 0, 1));

  return {
    active: !inactive,
    coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
    deductibleAnnual: deductible,
    deductibleRemaining: deductibleMet ? 0 : deductible,
    annualMaximum: annualMax,
    annualMaximumRemaining: Math.max(0, annualMax - used),
    waitingPeriods: waiting
      ? [{ category: "major", months: 12, coverageEffectiveDate: effectiveDate.toISOString().slice(0, 10) }]
      : [],
    frequencyLimits: [
      { codes: ["D1110", "D1120"], limit: 2, period: "calendar-year", used: slice(h, 12, 3), description: "Prophylaxis limited to 2 per calendar year." },
      { codes: ["D0274"], limit: 1, period: "calendar-year", used: slice(h, 14, 2), description: "Bitewing X-rays limited to 1 set per calendar year." },
    ],
    exclusions: ["Cosmetic procedures", "Orthodontics for adults over 19"],
    excludedCodes: ["D8080"],
    /**
     * Only the plans that publish a rule carry one. Everything else is left undefined so the
     * estimate reports `unknown` — the honest answer, and the one a 271 actually produces.
     */
    ...(preAuth
      ? {
          preAuthorization: {
            categories: ["major"] as ProcedureCategory[],
            codes: [],
            thresholdCents: null,
            /** Six months is the common dental term; stated so the expiry has a stated basis. */
            validityDays: 180,
            source: "MOCK PLAN RULE — synthetic test data, not a real payer policy",
          },
        }
      : {}),
  };
}
