/**
 * The persisted denial document's version, and both directions of casting.
 *
 * ── THE OUTAGE THIS EXISTS TO PREVENT ──────────────────────────────────────────────────────────
 * The 0024 backfill stamped `snapshot_version: 3` onto staging while this reader still declared
 * version 2 and had no upcaster for it. `readSnapshot` refused the document — correctly — and the
 * live Recover screen answered:
 *
 *     500  snapshot_version 3 is newer than this code understands (2)
 *
 * Nothing caught it before deployment because every unit test uses `InMemoryDenialRepository`,
 * which stores objects directly and never goes through `readSnapshot`. The Postgres path — the only
 * one that versions anything — had no coverage at all. These tests are that coverage.
 *
 * The rule the failure teaches: a migration or backfill that writes a new `snapshot_version` and
 * the reader that understands it must ship in the SAME commit, and a downcaster must ship with
 * them, or the bump is a one-way door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSnapshot } from "@mermaid/shared";
import { DENIAL_RECORD_VERSION, UPCASTERS, DOWNCASTERS } from "../repository.pg.ts";

/** A v2 denial exactly as it was persisted before awards existed: a win recorded as cash. */
const v2 = () => ({
  snapshot_version: 2,
  id: "den-1",
  status: "recovered",
  deniedAmount: 112500,
  recoveredAmount: 112500,
  carcGroup: "CO",
  appeals: [{ id: "a-1", status: "won", narrative: null }],
  audit: [],
});

/** A v3 denial as the backfill and the new code write one: award recorded, no cash. */
const v3 = () => ({
  snapshot_version: 3,
  id: "den-1",
  status: "awaiting_payment",
  deniedAmount: 112500,
  recoveredAmount: null,
  outcomeDecision: "won",
  awardedAmount: 112500,
  awardSettledAmount: 0,
  awardedAt: "2026-08-28T05:05:48.349Z",
  awardSettlements: [],
  carcGroup: "CO",
  appeals: [{ id: "a-1", status: "won", narrative: null }],
  audit: [],
});

test("the declared version is 3 — the version the 0024 backfill writes", () => {
  assert.equal(DENIAL_RECORD_VERSION, 3, "if these disagree, every backfilled denial 500s on read");
});

test("a v3 document is readable by this code", () => {
  const read = readSnapshot<Record<string, unknown>>(v3(), DENIAL_RECORD_VERSION, UPCASTERS, DOWNCASTERS);
  assert.equal(read.snapshot_version, 3);
  assert.equal(read.awardedAmount, 112500);
  assert.equal(read.awardSettledAmount, 0);
});

test("a v2 document upcasts, and does NOT invent an award from the old cash field", () => {
  const read = readSnapshot<Record<string, unknown>>(v2(), DENIAL_RECORD_VERSION, UPCASTERS, DOWNCASTERS);
  assert.equal(read.snapshot_version, 3);
  assert.equal(read.awardedAmount, null, "re-deriving an award here would reclassify history on every read");
  assert.equal(read.awardSettledAmount, null);
  assert.equal(read.recoveredAmount, 112500, "the v2 figure is left exactly as it was recorded");
  assert.equal(read.status, "recovered", "and the status is not silently rewritten either");
});

test("a v1 document still upcasts all the way to v3", () => {
  const v1 = { snapshot_version: 1, id: "den-1", status: "triaged", appeals: [{ id: "a-1" }], audit: [] };
  const read = readSnapshot<Record<string, unknown>>(v1, DENIAL_RECORD_VERSION, UPCASTERS, DOWNCASTERS);
  assert.equal(read.snapshot_version, 3);
  assert.equal(read.carcGroup, null, "v1 → v2 still applies");
  assert.equal((read.appeals as { narrative: unknown }[])[0]!.narrative, null);
  assert.equal(read.awardedAmount, null, "v2 → v3 applies on top");
});

// ── The rollback direction ────────────────────────────────────────────────────────────────────

test("a v3 document is readable by a v2 reader, so the bump is not a one-way door", () => {
  const read = readSnapshot<Record<string, unknown>>(v3(), 2, UPCASTERS, DOWNCASTERS);
  assert.equal(read.snapshot_version, 2);
  assert.equal(read.awardedAmount, undefined, "award fields are dropped");
  assert.equal(read.awardSettledAmount, undefined);
  assert.equal(read.status, "appealed", "a status v2 has no name for becomes one it does");
  assert.equal(read.recoveredAmount, 112500, "and the workflow figure returns to where v2 looks for it");
});

test("a settled v3 award downcasts to the cash a v2 reader would call recovered", () => {
  const settled = { ...v3(), status: "recovered", awardSettledAmount: 112500 };
  const read = readSnapshot<Record<string, unknown>>(settled, 2, UPCASTERS, DOWNCASTERS);
  assert.equal(read.status, "recovered");
  assert.equal(read.recoveredAmount, 112500, "cash, which is what v2 meant by the field");
});

test("a partially settled award downcasts to the cash actually received", () => {
  const partial = { ...v3(), status: "partially_recovered", awardSettledAmount: 80000 };
  const read = readSnapshot<Record<string, unknown>>(partial, 2, UPCASTERS, DOWNCASTERS);
  assert.equal(read.status, "appealed", "v2 has no partial state, so it reads as still appealed");
  assert.equal(read.recoveredAmount, 80000, "not the 112500 awarded — v2's field meant cash");
});
