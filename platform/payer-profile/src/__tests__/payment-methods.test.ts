/**
 * The per-payer rollup of non-ACH payments.
 *
 * The fold is where the one judgement in this feature lives: what a fee TOTAL means when some of the
 * payments in it could not be priced. Summing the priced ones and presenting the result as the total
 * would read as complete — and it is the figure a biller quotes to a payer, so reading as complete
 * while covering four of seven payments is the expensive kind of wrong.
 *
 * Shared by both repositories deliberately, so the in-memory store and Postgres cannot answer the
 * same question differently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldPaymentMethods, InMemoryPaymentMethodRepository } from "../payment-methods.ts";
import { cents, type Cents } from "@mermaid/shared";

const obs = (over: Partial<Parameters<typeof foldPaymentMethods>[0][number]> = {}) => ({
  remittanceId: crypto.randomUUID(),
  dedupeKey: "DELTA DENTAL|CHK-1",
  payerName: "Delta Dental",
  method: "CHK",
  paymentTotal: cents(650),
  feeCents: cents(19.18) as Cents | null,
  reverted: false,
  priorMethod: null as string | null,
  observedAt: "2026-08-10T09:00:00.000Z",
  ...over,
});

test("nothing observed is an empty rollup, not a row saying zero", () => {
  assert.deepEqual(foldPaymentMethods([]), []);
});

test("payments from one payer fold into one row", () => {
  const rows = foldPaymentMethods([
    obs({ paymentTotal: cents(650), feeCents: cents(19.18) }),
    obs({ paymentTotal: cents(400), feeCents: cents(11.8), observedAt: "2026-09-10T09:00:00.000Z" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payments, 2);
  assert.equal(rows[0]!.paymentTotal, cents(1050));
  assert.equal(rows[0]!.feeCents, cents(30.98));
  assert.equal(rows[0]!.unpricedPayments, 0);
});

test("casing and padding do not split one payer into two rows", () => {
  // A payer that prints "Delta Dental" one month and "  DELTA DENTAL " the next has not become a
  // different payer, and showing it twice would halve both totals a practice reads.
  const rows = foldPaymentMethods([obs({ payerName: "Delta Dental" }), obs({ payerName: "  DELTA DENTAL " })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payments, 2);
});

test("the payer's own most recent spelling is what is displayed", () => {
  /**
   * Grouping folds case and padding, so these are one payer — but the row must show the payer's own
   * spelling rather than the upper-cased key the fold grouped on. A screen that shouted
   * "DELTA DENTAL" at a biller would be displaying an implementation detail.
   *
   * Only case and whitespace are folded. "Delta Dental of California" is a DIFFERENT name and stays
   * a different row, which is right: Delta's member companies are genuinely separate payers, and
   * merging them would tell a practice to enrol with one entity to fix another's payments.
   */
  const rows = foldPaymentMethods([
    obs({ payerName: "DELTA DENTAL", observedAt: "2026-08-01T00:00:00.000Z" }),
    obs({ payerName: " Delta Dental ", observedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payerName, "Delta Dental", "trimmed, and taken from the most recent observation");
});

test("payers whose names genuinely differ stay separate", () => {
  const rows = foldPaymentMethods([
    obs({ payerName: "Delta Dental" }),
    obs({ payerName: "Delta Dental of California" }),
  ]);
  assert.equal(rows.length, 2, "two Delta member companies are two payers, and two enrolments");
});

test("the latest method is what the payer is doing NOW, not what it did first", () => {
  const rows = foldPaymentMethods([
    obs({ method: "CHK", observedAt: "2026-08-01T00:00:00.000Z" }),
    obs({ method: "BOP", observedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.equal(rows[0]!.latestMethod, "BOP");
  assert.equal(rows[0]!.latestObservedAt, "2026-09-01T00:00:00.000Z");
});

// ── The judgement this file exists for ────────────────────────────────────────────────

test("a total over SOME priced payments reports how many it could not price", () => {
  const rows = foldPaymentMethods([
    obs({ feeCents: cents(19.18) }),
    obs({ feeCents: null, observedAt: "2026-09-01T00:00:00.000Z" }),
    obs({ feeCents: null, observedAt: "2026-09-02T00:00:00.000Z" }),
  ]);
  assert.equal(rows[0]!.payments, 3);
  assert.equal(rows[0]!.feeCents, cents(19.18), "the priced ones still total");
  assert.equal(rows[0]!.unpricedPayments, 2, "and the gap travels with the number, so it cannot read as complete");
});

test("when NOTHING could be priced the fee is null, never zero", () => {
  // Zero would mean "these payments cost nothing", which is a claim. Null means "we do not know what
  // they cost", which is the truth when no merchant rate has been recorded.
  const rows = foldPaymentMethods([obs({ feeCents: null }), obs({ feeCents: null })]);
  assert.equal(rows[0]!.feeCents, null);
  assert.equal(rows[0]!.unpricedPayments, 2);
});

// ── Ordering: what a practice should act on first ─────────────────────────────────────

test("a payer that REVERTED outranks a more expensive one that never paid by ACH", () => {
  const rows = foldPaymentMethods([
    obs({ payerName: "Always Cheque", feeCents: cents(500), reverted: false }),
    obs({ payerName: "Was ACH", feeCents: cents(10), reverted: true }),
  ]);
  assert.equal(
    rows[0]!.payerName,
    "Was ACH",
    "an opt-out that was undone can be redone — it is the cheapest thing on the list to fix"
  );
});

test("within the same standing, the costliest payer comes first", () => {
  const rows = foldPaymentMethods([
    obs({ payerName: "Small", feeCents: cents(10) }),
    obs({ payerName: "Large", feeCents: cents(500) }),
  ]);
  assert.deepEqual(rows.map((r) => r.payerName), ["Large", "Small"]);
});

test("reverted is sticky across the payer's history, not just its latest payment", () => {
  // The relapse happened, and a later ordinary card payment does not undo the fact that this payer
  // once paid by ACH and stopped.
  const rows = foldPaymentMethods([
    obs({ reverted: true, observedAt: "2026-08-01T00:00:00.000Z" }),
    obs({ reverted: false, observedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.equal(rows[0]!.reverted, true);
});

// ── The store ─────────────────────────────────────────────────────────────────────────

test("recording the same remittance twice is one payment, not two fees", async () => {
  const repo = new InMemoryPaymentMethodRepository();
  const one = obs({ remittanceId: "11111111-2222-4333-8444-555555555555" });
  await repo.record(one);
  await repo.record(one);

  const summary = await repo.summary();
  assert.equal(repo.size, 1);
  assert.equal(summary[0]!.payments, 1, "an at-least-once bus must not be able to double a fee");
  assert.equal(summary[0]!.feeCents, cents(19.18));
});
