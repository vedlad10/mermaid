/**
 * Snapshot versioning — the guard against silent JSONB schema drift
 * (architecture-risk-review.md §1.5, §5).
 *
 * Every JSONB document Mermaid persists (benefit snapshots, coverage snapshots, verification
 * records, event payloads) carries an explicit integer `snapshot_version`. When an extraction
 * prompt or a type shape changes, we bump the version and add a migration/upcaster — old and new
 * records never silently disagree on shape. The database enforces presence via the
 * `jsonb_has_version()` CHECK (migration 0001); this module is the application-side contract.
 */

/** A persisted JSONB document always carries its schema version. */
export interface Versioned {
  snapshot_version: number;
}

export type Snapshot<T> = T & Versioned;

/** Stamp a payload with a version for persistence. */
export function withVersion<T extends object>(value: T, version: number): Snapshot<T> {
  return { ...value, snapshot_version: version };
}

/** Narrow an unknown JSONB blob to a versioned document. */
export function isVersioned(value: unknown): value is Versioned {
  return (
    typeof value === "object" &&
    value !== null &&
    "snapshot_version" in value &&
    typeof (value as Record<string, unknown>).snapshot_version === "number"
  );
}

/**
 * Read a versioned document, upcasting older versions to the current shape.
 *
 * `upcasters[n]` migrates a v(n) document to v(n+1). Throws on an unversioned blob rather than
 * guessing, and on a future-versioned one unless the caller has said how to read it — see below.
 *
 * ── WHY A FUTURE VERSION MAY NOW BE READABLE (ROLLBACK) ────────────────────────────────────────
 * Refusing a newer document is the right default: a shape this code has never seen cannot be
 * interpreted, and guessing at it is how a field silently changes meaning. But it also makes a
 * version bump a ONE-WAY DOOR. Deploy code that writes v(n+1), roll it back for any reason, and
 * every document written in between is unreadable — not degraded, unreadable — which turns an
 * ordinary rollback into an outage on exactly the records the failed release touched.
 *
 * `downcasters[n]` is the way back: it converts a v(n) document DOWN to v(n-1), so a reader that
 * predates a bump can still read what the newer code wrote. Registering one is a deliberate
 * statement that the newer shape is additive and that dropping its additions is safe — which is
 * true for a field the older code never knew about, and false for a change that reinterprets an
 * existing one. Nothing is inferred; with no downcaster registered the old refusal stands exactly
 * as before.
 *
 * A downcast LOSES the newer data by construction. That is the trade being made: an older reader
 * seeing less is recoverable, and an older reader seeing nothing is not.
 */
export function readSnapshot<T>(
  raw: unknown,
  current: number,
  upcasters: Record<number, (doc: Versioned) => Versioned> = {},
  downcasters: Record<number, (doc: Versioned) => Versioned> = {}
): Snapshot<T> {
  if (!isVersioned(raw)) {
    throw new Error("snapshot is missing snapshot_version — refusing to interpret an unversioned document");
  }
  let doc: Versioned = raw;
  // Walk DOWN first: a document from a newer writer is brought back to a shape this code knows,
  // one version at a time, and only as far as a registered downcaster is willing to take it.
  while (doc.snapshot_version > current) {
    const down = downcasters[doc.snapshot_version];
    if (!down) {
      throw new Error(
        `snapshot_version ${doc.snapshot_version} is newer than this code understands (${current})`
      );
    }
    const next = down(doc);
    if (next.snapshot_version >= doc.snapshot_version) {
      throw new Error(
        `downcaster for snapshot_version ${doc.snapshot_version} did not lower the version — refusing to loop`
      );
    }
    doc = next;
  }
  while (doc.snapshot_version < current) {
    const up = upcasters[doc.snapshot_version];
    if (!up) {
      throw new Error(`no upcaster registered for snapshot_version ${doc.snapshot_version}`);
    }
    doc = up(doc);
  }
  return doc as Snapshot<T>;
}
