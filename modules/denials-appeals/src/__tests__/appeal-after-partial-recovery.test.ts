/**
 * An appeal asks for what is still owed, not for what was originally denied.
 *
 * ── THE DEFECT, AND WHERE IT CAME FROM ─────────────────────────────────────────────────────────
 * The letter stated `deniedAmount` unconditionally. That was correct for as long as a denial was
 * either unrecovered or closed — but migration 0024 added `awaiting_payment` and
 * `partially_recovered` as OPEN statuses, and open statuses can be appealed again. So a denial the
 * payer had already partly paid could take a level-2 appeal demanding the whole original sum.
 *
 * The letter would tell a payer it still owed money it had already sent. This module's own header
 * calls an appeal "a factual assertion to a payer about a patient's care", and that is exactly what
 * makes this worse than a wrong number on a screen: the payer either rejects the appeal as a
 * duplicate — costing the practice a level it cannot re-file — or pays twice and recoups later.
 *
 * The original figure is still stated, because a payer reconciles against its own advice and cannot
 * process a demand it can't tie to a determination it recognises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { draftAppeal, FullyRecoveredAppealError } from "../engine/letter.ts";
import type { AppealContext } from "../engine/letter.ts";

const context = (over: Partial<AppealContext> = {}): AppealContext =>
  ({
    level: 2,
    payerName: "Delta Dental",
    patientName: "Ada Stagetest",
    memberId: "ABC12345",
    claimControlNumber: "MRM-000123",
    serviceDate: "2026-08-01",
    procedureCode: "D2750",
    carcCode: "197",
    carcDescription: "Pre-authorization absent",
    deniedAmount: cents(1125),
    providerName: "Mermaid Demo Dental",
    ...over,
  }) as AppealContext;

const bodyOf = (ctx: AppealContext) => draftAppeal(ctx).letter;

// ── The ordinary appeal is unchanged ──────────────────────────────────────────────────────────

test("a first appeal, with nothing recovered, asks for the full denied amount", () => {
  const letter = bodyOf(context({ level: 1 }));
  assert.match(letter, /in the amount of \$1,125\.00/);
  assert.doesNotMatch(letter, /has since been received/, "there is nothing to mention");
});

test("an explicit zero recovery reads exactly like no recovery at all", () => {
  assert.equal(bodyOf(context({ alreadyRecovered: cents(0) })), bodyOf(context()));
});

// ── The correction ────────────────────────────────────────────────────────────────────────────

test("after a partial recovery the appeal asks only for the remainder", () => {
  const letter = bodyOf(context({ alreadyRecovered: cents(500) }));

  assert.match(letter, /this appeal concerns the remaining \$625\.00/);
  assert.match(letter, /\$500\.00 has since been received/, "the payer must be able to reconcile");
  assert.match(letter, /in the amount of \$1,125\.00/, "the original determination is still named");
  assert.doesNotMatch(
    letter,
    /appealing the denial of D2750 \(Crown - porcelain fused to high noble metal\) in the amount of \$1,125\.00,/,
    "the flat demand for the whole sum must be gone"
  );
});

test("the remainder is stated to the cent", () => {
  const letter = bodyOf(context({ deniedAmount: cents(1125), alreadyRecovered: cents(1124.99) }));
  assert.match(letter, /remaining \$0\.01/);
});

// ── Readings that must not produce a letter ───────────────────────────────────────────────────

test("a denial recovered in full cannot be appealed at all", () => {
  /**
   * The view already refuses — a fully recovered denial is not an OPEN status — and this refuses
   * again, for the same reason the missing-identifier guard does: no bulk job, retry path or test
   * fixture may reach the template and produce a letter demanding $0.00 from a payer that has paid.
   */
  assert.throws(
    () => bodyOf(context({ alreadyRecovered: cents(1125) })),
    (e: unknown) => e instanceof FullyRecoveredAppealError && /already been recovered in full/.test((e as Error).message)
  );
});

test("a recovery larger than the denial is clamped rather than inverted", () => {
  /**
   * An overpayment against an award is real — it is what the takeback path exists for — and it must
   * not turn into a letter asking a payer for a negative sum.
   */
  assert.throws(() => bodyOf(context({ alreadyRecovered: cents(5000) })), FullyRecoveredAppealError);
});

test("a negative recovery is treated as none, not as an increase in the demand", () => {
  const letter = bodyOf(context({ alreadyRecovered: cents(-500) }));
  assert.match(letter, /in the amount of \$1,125\.00/);
  assert.doesNotMatch(letter, /\$1,625\.00/, "a bad figure must never inflate what is asked of a payer");
});

// ── Everything else about the letter is untouched ─────────────────────────────────────────────

test("the identifiers, checklist and closing request survive the change", () => {
  const letter = bodyOf(context({ alreadyRecovered: cents(500) }));
  assert.match(letter, /Claim MRM-000123/);
  assert.match(letter, /Member ID: ABC12345/);
  assert.match(letter, /Documentation to accompany this appeal:/);
  assert.match(letter, /respectfully request reprocessing/);
  assert.doesNotMatch(letter, /\[member ID\]|\[claim number\]/, "no placeholder ever reaches a payer");
});
