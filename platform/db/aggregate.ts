/**
 * Aggregate persistence helpers — the shared mechanics behind every module's Postgres repository.
 *
 * The storage shape (see migration 0006) is one versioned JSONB document per aggregate plus plain
 * columns extracted from it for querying. These helpers own the two halves of that contract:
 *
 *   • `toDocument` stamps `snapshot_version` on the way in, so the anti-drift CHECK in 0001 can
 *     never be violated by a repository that forgot.
 *   • `fromDocument` reads it back through `readSnapshot`, so an aggregate written before a shape
 *     change is upcast rather than silently misread as the new shape.
 *
 * Every module repository is built from these, which is why none of them contains version handling
 * of its own — one place to get it right, one place to change it.
 */
import { readSnapshot, withVersion, type Versioned } from "@mermaid/shared";
import { requireContext, requirePracticeId, type Tx } from "./pool.ts";

/** Upcasters keyed by the version they migrate FROM. `upcasters[n]` turns a v(n) doc into v(n+1). */
export type Upcasters = Record<number, (doc: Versioned) => Versioned>;
/**
 * The way back from a version bump — `Downcasters[n]` reads a v(n) document as v(n-1).
 *
 * Registering one says the newer shape is ADDITIVE and that dropping its additions is safe, which
 * is what makes a rollback survivable: without it, every document the newer code wrote becomes
 * unreadable the moment it is rolled back. See `readSnapshot` for why that trade is worth making
 * and where it is not.
 */
export type Downcasters = Record<number, (doc: Versioned) => Versioned>;

/** Stamp an aggregate for storage. */
export function toDocument<T extends object>(aggregate: T, version: number): Record<string, unknown> {
  return withVersion(aggregate, version) as unknown as Record<string, unknown>;
}

/**
 * Read a stored document back into its aggregate, upcasting older versions.
 *
 * `snapshot_version` is stripped: it is a storage concern, and leaving it on the domain object
 * would let it leak into API payloads and equality comparisons.
 */
export function fromDocument<T>(
  raw: unknown,
  version: number,
  upcasters: Upcasters = {},
  downcasters: Downcasters = {}
): T {
  const doc = readSnapshot<T>(raw, version, upcasters, downcasters) as Record<string, unknown>;
  const { snapshot_version: _stored, ...aggregate } = doc;
  return aggregate as T;
}

/** The ambient transaction — repositories never open their own (see pool.ts). */
export const tx = (): Tx => requireContext().tx;

/** The practice this unit of work is scoped to. Written into every row's `practice_id`. */
export const practiceId = (): string => requirePracticeId();

/**
 * Postgres unique-violation. Repositories translate this into their own domain error rather than
 * letting a raw driver error escape — and, crucially, they rely on it: the UNIQUE constraints on
 * `claims.verification_id` and `remittances.dedupe_key` are the last line of defence against
 * duplicate billing and double-posted money, and they must be caught, not merely hoped for.
 */
export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: string; constraint?: string };
  if (err.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || err.constraint === constraint;
}

/** ISO timestamp for a `TIMESTAMPTZ` column read back by the driver as a Date. */
export const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/**
 * `DATE` column → ISO day string.
 *
 * pool.ts configures the driver to hand back date columns as plain `YYYY-MM-DD` strings precisely so
 * a calendar day never round-trips through a timestamp (which shifts it by a day depending on the
 * reader's timezone). This is therefore a pass-through, kept as a named function so the intent is
 * documented at every call site rather than looking like an accidental `String(...)`.
 */
export const isoDate = (value: unknown): string => String(value).slice(0, 10);
