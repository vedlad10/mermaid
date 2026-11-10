/**
 * Money is integer CENTS — never a float (architecture-risk-review blueprint doc 16, M10).
 * All arithmetic happens in cents; formatting to dollars happens only at the edge (UI/API).
 * A dedicated type makes "I accidentally added dollars to cents" a compile error.
 */

export type Cents = number & { readonly __brand: "Cents" };

/** Convert a dollar amount (possibly fractional) to whole cents, rounded to the nearest cent. */
export const cents = (dollars: number): Cents => Math.round(dollars * 100) as Cents;

/**
 * True when a dollar figure names a whole number of cents.
 *
 * ── WHY THIS IS NOT `Number.isInteger(cents(dollars))` ───────────────────────────────────────────
 * Because that is always true. `cents` ROUNDS, so every check placed after it passes by
 * construction. `PatientLedgerService.#humanEntry` guards exactly that way — "the amount must be a
 * positive whole number of cents" — and the guard cannot fire on anything arriving over HTTP,
 * because the route converts first and the service checks second. `POST /patients/:id/payment` with
 * `amountDollars: 10.005` returned 200 and stored $10.01: a figure the caller never sent, with no
 * error and no record that anything was altered.
 *
 * Money is the one place rounding must be asked for rather than assumed, so the question has to be
 * put BEFORE the conversion — which is what this is for.
 *
 * ── WHY THE TOLERANCE ────────────────────────────────────────────────────────────────────────────
 * Binary floating point cannot hold most decimal fractions, so the exact test is wrong in both
 * directions: `10.01 * 100` is 1001.0000000000001 and would be REFUSED as fractional, while the
 * genuinely fractional `10.005 * 100` is 1000.4999999999999. A tolerance far below half a cent
 * separates representation error from an amount that really does name a fraction of a cent.
 */
export const isWholeCents = (dollars: number): boolean => {
  const scaled = dollars * 100;
  return Number.isFinite(scaled) && Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

/** Assert an already-integer cents value (e.g. read from the DB). Throws on non-integers. */
export function asCents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`money value must be integer cents, got ${value}`);
  }
  return value as Cents;
}

export const ZERO: Cents = 0 as Cents;

export const addCents = (...values: Cents[]): Cents =>
  values.reduce<number>((a, b) => a + b, 0) as Cents;

export const subCents = (a: Cents, b: Cents): Cents => (a - b) as Cents;

/** Multiply cents by a unitless factor (e.g. a coverage percentage), rounding to whole cents. */
export const scaleCents = (amount: Cents, factor: number): Cents =>
  Math.round(amount * factor) as Cents;

export const toDollars = (value: Cents): number => value / 100;

/** Format for display, e.g. 123456 → "$1,234.56". */
export const formatUsd = (value: Cents): string =>
  toDollars(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

/**
 * Format an amount the payer may not have stated.
 *
 * ── WHY THIS IS NOT `formatUsd(value ?? 0)` ────────────────────────────────────────────────────
 * That coalesce is the M4 defect in its display form. `$0.00` is a claim about the plan — "the
 * deductible is met", "no benefit remains" — and rendering an absent figure that way puts a
 * statement on a patient's estimate that the payer never made. Every screen and report that shows
 * one of these amounts has to be able to say "not stated", so there is one function that does.
 */
export const formatUsdOrUnknown = (value: Cents | null, absent = "not stated"): string =>
  value === null ? absent : formatUsd(value);

/**
 * How far a payment may differ from what was expected before the difference means anything (F-6).
 *
 * ── WHY A BAND AT ALL ──────────────────────────────────────────────────────────────────────────
 * The variance classifier compared against exact zero, so a payment that differed by one cent was
 * labelled `underpaid` — permanently, on a claim the payer had settled in full. On the audited
 * staging set that was 7 of 9 postings, and `SELECT DISTINCT outcome FROM postings` returned only
 * `underpaid`: a column with one value carries no information, and staff learn to ignore a badge
 * that is always lit. That is how a real underpayment gets missed.
 *
 * ── WHY THIS SHAPE ─────────────────────────────────────────────────────────────────────────────
 *   • a 5¢ FLOOR, because a claim's per-line pro-rata rounding can drift a few cents on its own and
 *     no payer intends that as a shortfall;
 *   • 25 BASIS POINTS, so the band scales with the claim rather than being generous on small ones
 *     and meaningless on large ones;
 *   • a $1.00 CAP, because a pure percentage would tolerate $4.00 on a $1,600 claim, and a dollar
 *     of dental revenue is worth chasing.
 *
 * ── WHERE IT MAY AND MAY NOT BE APPLIED ────────────────────────────────────────────────────────
 * This decides a LABEL and nothing else. It must never touch `unexplained`, a ledger amount, or any
 * stored figure: money is recorded to the cent and reported to the cent. A variance inside the band
 * is still stored exactly — it is simply not called a shortfall. Nothing here is a write-off, and no
 * adjustment is ever posted for rounding.
 */
export function materialityThreshold(expected: Cents): Cents {
  const relative = Math.round(Math.abs(expected) * 0.0025);
  return Math.min(100, Math.max(5, relative)) as Cents;
}

/** True when a variance is large enough to be worth a person's attention. */
export const isMaterialVariance = (variance: Cents, expected: Cents): boolean =>
  Math.abs(variance) > materialityThreshold(expected);
