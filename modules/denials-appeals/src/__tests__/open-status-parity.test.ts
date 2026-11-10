/**
 * "Open" means the same thing everywhere, and closing can reach every open state.
 *
 * ── TWO DEFECTS, ONE CAUSE ─────────────────────────────────────────────────────────────────────
 * `["triaged", "appealing", "appealed"]` was written out by hand in three places. Phase 3 added
 * `awaiting_payment` and `partially_recovered` to `OPEN_DENIAL_STATUSES`, and F-2 corrected the
 * Postgres repository — which carries a note saying the constant is derived "so the two cannot
 * drift". Two other copies were left on the pre-Phase-3 three:
 *
 *   1. The IN-MEMORY repository, which the whole business suite and the database-free demo run
 *      against. A test double that defines "open" differently from production is worse than a wrong
 *      constant: it means the suite cannot reproduce the behaviour it exists to protect. A
 *      won-but-unpaid award vanished from the Recover worklist in SQL, and a test written to catch
 *      that would have passed here anyway, because the double dropped it too.
 *
 *   2. `closeDenial`, so an appeal won and never paid could not be written off or billed at all.
 *      The refusal read "it is already awaiting_payment" — telling a biller the denial is finished
 *      when the truth is that nothing will ever finish it.
 *
 * Every assertion below is written against `OPEN_DENIAL_STATUSES` rather than a list of its own. A
 * test that restated the statuses would be a fourth copy to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { InMemoryDenialRepository } from "../repository.ts";
import { OPEN_DENIAL_STATUSES, CLOSED_DENIAL_STATUSES, DISPUTED_DENIAL_STATUSES } from "../types.ts";
import type { Denial, DenialStatus } from "../types.ts";

/** Each denial gets its own posting: the store dedupes on posting + reason. */
const denial = (id: string, status: DenialStatus): Denial =>
  ({
    id,
    status,
    claimId: "claim-1",
    postingId: `post-${id}`,
    payerId: "delta-dental",
    payerName: "Delta Dental",
    patientName: "Ada Stagetest",
    carcCode: "197",
    carcDescription: "Pre-authorization absent",
    procedureCode: "D2750",
    deniedAmount: cents(1125),
    detectedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    appeals: [],
    audit: [],
    triage: { disposition: "appeal", recommendedAction: "Appeal", guidance: "" },
  }) as unknown as Denial;

// ── The double must agree with production about what is still in play ─────────────────────────

test("every open status survives an openOnly query", async () => {
  const repo = new InMemoryDenialRepository();
  for (const [i, status] of OPEN_DENIAL_STATUSES.entries()) await repo.save(denial(`open-${i}`, status));

  const open = await repo.list({ openOnly: true });
  assert.deepEqual(
    open.map((d) => d.status).sort(),
    [...OPEN_DENIAL_STATUSES].sort(),
    "a status the constant calls open must not be filtered out by the store"
  );
});

test("awaiting_payment and partially_recovered specifically are not dropped", async () => {
  /**
   * Named outright because these are the two Phase 3 added and the two that went missing. A won
   * appeal the payer has not yet honoured is the single most important thing on the Recover
   * worklist — it is money someone has already agreed to send.
   */
  const repo = new InMemoryDenialRepository();
  await repo.save(denial("awaiting", "awaiting_payment"));
  await repo.save(denial("partial", "partially_recovered"));

  const ids = (await repo.list({ openOnly: true })).map((d) => d.id).sort();
  assert.deepEqual(ids, ["awaiting", "partial"]);
});

test("closed statuses are still excluded — the filter did not simply stop filtering", async () => {
  const repo = new InMemoryDenialRepository();
  for (const [i, status] of CLOSED_DENIAL_STATUSES.entries()) await repo.save(denial(`closed-${i}`, status));
  await repo.save(denial("live", "triaged"));

  const open = await repo.list({ openOnly: true });
  assert.deepEqual(open.map((d) => d.id), ["live"], "widening the set must not have emptied it");
});

test("open and closed together account for every status, with no overlap", async () => {
  /**
   * The property that makes "open" a partition rather than a preference. A status in neither set is
   * one no worklist shows and no report counts; a status in both is money counted twice.
   */
  const open = new Set(OPEN_DENIAL_STATUSES);
  const closed = new Set(CLOSED_DENIAL_STATUSES);
  for (const s of open) assert.equal(closed.has(s), false, `${s} is in both sets`);

  const repo = new InMemoryDenialRepository();
  for (const [i, status] of [...OPEN_DENIAL_STATUSES, ...CLOSED_DENIAL_STATUSES].entries()) {
    await repo.save(denial(`all-${i}`, status));
  }
  const all = await repo.list();
  const openOnly = await repo.list({ openOnly: true });
  assert.equal(
    all.length,
    openOnly.length + CLOSED_DENIAL_STATUSES.length,
    "every stored denial is either open or closed, never neither and never both"
  );
});

// ── The one narrowing that IS deliberate ──────────────────────────────────────────────────────

/**
 * `DISPUTED_DENIAL_STATUSES` is a strict subset of the open set, and that is a decision rather than
 * a stale copy — which is exactly why it needed a name. It read as a bare
 * `["triaged", "appealing", "appealed"]` in the patient record: character-for-character the
 * pre-Phase-3 literal that DID drift, so nothing distinguished the two.
 */
test("disputed is a strict subset of open, and excludes the award states", () => {
  for (const s of DISPUTED_DENIAL_STATUSES) {
    assert.ok(OPEN_DENIAL_STATUSES.includes(s), `${s} must be open to be disputed`);
  }
  assert.ok(DISPUTED_DENIAL_STATUSES.length < OPEN_DENIAL_STATUSES.length, "it is a strict subset");

  for (const settled of ["awaiting_payment", "partially_recovered"] as const) {
    assert.equal(
      DISPUTED_DENIAL_STATUSES.includes(settled),
      false,
      `${settled} is money the payer has AGREED to pay — owed, not disputed, and counting it as both double-counts a won appeal`
    );
  }
});

test("nothing closed is ever counted as disputed", () => {
  for (const s of CLOSED_DENIAL_STATUSES) {
    assert.equal(DISPUTED_DENIAL_STATUSES.includes(s), false, `${s} has an owner already`);
  }
});
