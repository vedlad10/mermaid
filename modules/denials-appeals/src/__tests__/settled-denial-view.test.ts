/**
 * A settled denial must report its OUTCOME, not its forecast.
 *
 * ── WHAT THE LIVE SCREEN SAID ──────────────────────────────────────────────────────────────────
 * Pia Phase32's denial, status `recovered`, appeal won in full and the cash posted:
 *
 *   tiles         "Denied $1,125.00 · Expected back $409.50 · Recovered —"
 *   gauge         "178 Days to appeal · Recovery odds 36% · provisional"
 *   recommendation "Recovered $1,125.00 — the money arrived and was posted. Nothing further to do."
 *   audit trail   "Award settled in full — $1,125.00 received and posted. Recovered."
 *
 * The sentences were right and every number above them was wrong: a stale pre-appeal forecast shown
 * as the headline, an em dash where the recovered cash belonged, and a countdown to a deadline for
 * work that was finished. A biller reading the tiles takes away the opposite of what happened.
 *
 * ── THE CAUSE ──────────────────────────────────────────────────────────────────────────────────
 * A win is recorded as an AWARD and the cash lands later as `awardSettledAmount`; `recoveredAmount`
 * on the record stays null for everything written since awards existed. The LIST item knew to read
 * `awardSettledAmount ?? recoveredAmount`. The detail view handed the client the raw denial, so the
 * same record reported $1,125.00 recovered in the worklist and null on its own screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildDenialListItem, buildDenialView } from "../view.ts";
import type { Denial } from "../types.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

const denial = (over: Partial<Denial>): Denial =>
  ({
    id: "d1",
    claimId: "c1",
    detectedAt: "2026-08-30T15:40:11.033Z",
    status: "recovered",
    patientName: "Pia Phase32",
    payerName: "MetLife Dental",
    payerId: "metlife-dental",
    carcCode: "197",
    carcDescription: "Pre-authorization absent",
    procedureCode: "D2750",
    deniedAmount: cents(1125),
    recoveredAmount: null,
    awardedAmount: cents(1125),
    awardSettledAmount: cents(1125),
    awardedAt: "2026-08-30T15:40:51.424Z",
    appealDeadline: "2027-02-26",
    appealDeadlineEstimated: true,
    appealWindowDays: 180,
    appeals: [],
    priority: 10,
    triage: {
      disposition: "appeal",
      source: "payer-rule",
      trusted: false,
      overturnRate: 0.36,
      expectedRecovery: cents(409.5),
      explain: ["Appeal with a retro-authorization request."],
    },
    ...over,
  }) as unknown as Denial;

test("a settled denial reports the cash that arrived, not null", () => {
  const view = buildDenialView(denial({}), NOW);
  assert.equal(view.recoveredAmount, cents(1125));
  assert.equal(view.awardedAmount, cents(1125));
  assert.equal(view.open, false);
});

test("the detail view and the worklist row agree on every denial", () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR. The two disagreed on the same record: $1,125.00 in the
   * worklist, null on the screen the worklist links to.
   */
  const cases = [
    denial({}),
    denial({ status: "triaged", awardedAmount: null, awardSettledAmount: null }),
    denial({ status: "appealed", awardedAmount: cents(1125), awardSettledAmount: null }),
    /** A row written before awards existed, which is the only reason the old field survives. */
    denial({ status: "recovered", awardedAmount: null, awardSettledAmount: null, recoveredAmount: cents(900) }),
    denial({ status: "written_off", awardedAmount: null, awardSettledAmount: null }),
  ];
  for (const d of cases) {
    const view = buildDenialView(d, NOW);
    const row = buildDenialListItem(d, NOW);
    assert.equal(view.recoveredAmount, row.recoveredAmount, `recovered disagrees on ${d.status}`);
    assert.equal(view.awardedAmount, row.awardedAmount, `awarded disagrees on ${d.status}`);
  }
});

test("an award the payer has not yet paid is not reported as recovered", () => {
  /**
   * The separation F-2 exists for: a person recording a win does not move money. The award is a
   * promise; the recovery is cash.
   */
  const view = buildDenialView(denial({ status: "appealed", awardSettledAmount: null }), NOW);
  assert.equal(view.awardedAmount, cents(1125), "the payer agreed to pay it");
  assert.equal(view.recoveredAmount, null, "and nothing has arrived");
});

test("a legacy row without an award still reports its recovery", () => {
  const view = buildDenialView(
    denial({ awardedAmount: null, awardSettledAmount: null, recoveredAmount: cents(900) }),
    NOW
  );
  assert.equal(view.recoveredAmount, cents(900));
});

test("a denial still in play keeps its forecast and its countdown", () => {
  const view = buildDenialView(denial({ status: "triaged", awardedAmount: null, awardSettledAmount: null }), NOW);
  assert.equal(view.open, true);
  assert.ok(view.daysToAppeal !== null, "the countdown is real while the window is open");
});
