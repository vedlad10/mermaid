/**
 * The statutory clock's store (F5).
 *
 * Two judgements live here and both are about not lying to a practice owner.
 *
 * The first is that CLAIMED and RECOVERED never merge. `claimedCents` is arithmetic this system
 * performed; `recoveredCents` is cash a person saw arrive. A savings report that added the first
 * into the second would report money nobody has sent, and a savings number only has to be caught
 * disagreeing with the bank once to be worthless forever after.
 *
 * The second is that a redelivered event must not undo a person's conclusion. Delivery is
 * at-least-once, findings are recomputed on replay, and a dispute somebody already closed must stay
 * closed — otherwise the worklist quietly refills with work that was already done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import {
  InMemoryStatutoryClockRepository,
  foldSavings,
  toStored,
  type StoredClockFinding,
} from "../statutory-clock-repository.ts";
import type { PromptPayFinding, RecoupmentFinding } from "../statutory-clock.ts";

const interest = (over: Partial<PromptPayFinding> = {}): PromptPayFinding => ({
  kind: "prompt-pay-interest",
  elapsedDays: 60,
  allowedDays: 30,
  lateDays: 30,
  principal: cents(650),
  interestCents: cents(6.41),
  rateBps: 1200,
  citation: "N.J.S.A. 17B:30-51",
  source: "https://example.invalid/nj",
  verifiedOn: "2026-09-15",
  defeasibleBy: ["ERISA preemption"],
  action: "Bill the payer.",
  ...over,
});

const outOfTime = (over: Partial<RecoupmentFinding> = {}): RecoupmentFinding => ({
  kind: "recoupment-out-of-time",
  referenceId: "MRM-000123",
  disputableCents: cents(420),
  daysSinceOriginalPayment: 239,
  windowDays: 180,
  windowStated: "180 days",
  citation: "Tex. Ins. Code § 1301.132",
  source: "https://example.invalid/tx",
  verifiedOn: "2026-09-15",
  defeasibleBy: ["ERISA preemption"],
  action: "Dispute it.",
  ...over,
});

const context = (over: Partial<Parameters<typeof toStored>[1]> = {}) => ({
  remittanceId: "11111111-2222-4333-8444-555555555555",
  subject: "MRM-000123",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  state: "NJ",
  detectedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

// ── What a stored finding keeps ─────────────────────────────────────────────────────────────────

test("a stored finding keeps the working, so its number can be re-derived", () => {
  /**
   * Statutes change and this row outlives the code that wrote it. "$6.41 is owed" would be unusable
   * the day the rule table is edited — nobody could tell which version computed it. The evidence is
   * the difference between a number in a letter to a payer and a number that survives being
   * questioned.
   */
  const stored = toStored(interest(), context());
  assert.equal(stored.claimedCents, cents(6.41));
  assert.equal(stored.recoveredCents, 0, "nothing is recovered at the moment of detection");
  assert.equal(stored.outcome, "open");
  assert.deepEqual(stored.evidence, {
    elapsedDays: 60,
    allowedDays: 30,
    lateDays: 30,
    principal: cents(650),
    rateBps: 1200,
  });
  assert.equal(stored.citation, "N.J.S.A. 17B:30-51");
  assert.equal(stored.state, "NJ", "the jurisdiction applied is an assumption, so it is recorded");
});

test("a recoupment stores the dispute amount and how far outside the window it was", () => {
  const stored = toStored(outOfTime(), context());
  assert.equal(stored.claimedCents, cents(420));
  assert.deepEqual(stored.evidence, {
    daysSinceOriginalPayment: 239,
    windowDays: 180,
    windowStated: "180 days",
  });
});

// ── The payment index the recoupment window is measured from ────────────────────────────────────

test("the FIRST payment for a claim is the one the window runs from", () => {
  /**
   * A supplemental cheque months later is not the date a recoupment window starts. Overwriting would
   * silently restart the clock and hand the payer months it is not entitled to — a bug discoverable
   * only by losing a dispute the practice should have won.
   */
  const repo = new InMemoryStatutoryClockRepository();
  const base = {
    patientControlNumber: "MRM-000123",
    payerId: "delta-dental",
    payerName: "Delta Dental",
    paidCents: cents(650),
    remittanceId: "r1",
  };

  return (async () => {
    await repo.recordPayment({ ...base, paidAt: "2026-01-05" });
    await repo.recordPayment({ ...base, paidAt: "2026-06-30", remittanceId: "r2", paidCents: cents(75) });

    const found = (await repo.paymentFor("MRM-000123"))!;
    assert.equal(found.paidAt, "2026-01-05");
    assert.equal(found.paidCents, cents(650));
  })();
});

test("a claim never paid has no date, and null is the answer", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  assert.equal(await repo.paymentFor("MRM-999999"), null);
});

// ── Idempotency, and the human's conclusion ─────────────────────────────────────────────────────

test("a redelivered finding is one finding, not a second demand", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  const stored = toStored(interest(), context());
  await repo.record(stored);
  await repo.record(stored);
  await repo.record(stored);

  const rows = await repo.findings();
  assert.equal(rows.length, 1, "a practice shown the same $6.41 twice will claim it twice");
});

test("the same advice recouping two different claims is two disputes", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  await repo.record(toStored(outOfTime(), context({ subject: "MRM-000123" })));
  await repo.record(toStored(outOfTime({ referenceId: "MRM-000124" }), context({ subject: "MRM-000124" })));

  assert.equal((await repo.findings()).length, 2, "the subject is in the key for exactly this reason");
});

test("a replay refreshes the arithmetic and never reopens a closed dispute", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  const key = { remittanceId: context().remittanceId, kind: "prompt-pay-interest" as const, subject: "MRM-000123" };

  await repo.record(toStored(interest(), context()));
  await repo.recordOutcome(key, { outcome: "recovered", recoveredCents: cents(6.41), note: "Paid on the Nov advice." });

  // The bus redelivers. The engine recomputes the same finding and records it again.
  await repo.record(toStored(interest(), context()));

  const row = (await repo.findings())[0]!;
  assert.equal(row.outcome, "recovered", "a redelivery must not refill the worklist with finished work");
  assert.equal(row.recoveredCents, cents(6.41));
  assert.equal(row.outcomeNote, "Paid on the Nov advice.");
});

test("an outcome for a finding nobody raised is refused, not created", async () => {
  // A savings figure with no evidence under it is the thing that makes the whole report unusable.
  const repo = new InMemoryStatutoryClockRepository();
  const result = await repo.recordOutcome(
    { remittanceId: "nope", kind: "prompt-pay-interest", subject: "MRM-000999" },
    { outcome: "recovered", recoveredCents: cents(100), note: null }
  );
  assert.equal(result, null);
  assert.deepEqual(await repo.findings(), []);
});

// ── Savings: two numbers that never merge ───────────────────────────────────────────────────────

test("claimed is not recovered, and the report says both", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  await repo.record(toStored(interest(), context({ subject: "A" })));
  await repo.record(toStored(interest({ interestCents: cents(20) }), context({ subject: "B" })));
  await repo.record(toStored(outOfTime(), context({ subject: "C" })));

  const before = await repo.savings();
  assert.equal(before.promptPay.findings, 2);
  assert.equal(before.promptPay.claimedCents, cents(26.41));
  assert.equal(before.promptPay.recoveredCents, 0, "nothing has been collected, and it must not read otherwise");
  assert.equal(before.recoupment.claimedCents, cents(420));

  await repo.recordOutcome(
    { remittanceId: context().remittanceId, kind: "prompt-pay-interest", subject: "A" },
    { outcome: "recovered", recoveredCents: cents(6.41), note: null }
  );

  const after = await repo.savings();
  assert.equal(after.promptPay.claimedCents, cents(26.41), "claiming is unchanged by collecting");
  assert.equal(after.promptPay.recoveredCents, cents(6.41));
});

test("a partial recovery is reported as the part that arrived", async () => {
  // Payers settle. $6.41 claimed and $4.00 accepted is a real outcome, and rounding it either way
  // is a lie in one direction or the other.
  const repo = new InMemoryStatutoryClockRepository();
  await repo.record(toStored(interest(), context()));
  await repo.recordOutcome(
    { remittanceId: context().remittanceId, kind: "prompt-pay-interest", subject: "MRM-000123" },
    { outcome: "recovered", recoveredCents: cents(4), note: "Settled." }
  );

  const savings = await repo.savings();
  assert.equal(savings.promptPay.claimedCents, cents(6.41));
  assert.equal(savings.promptPay.recoveredCents, cents(4));
});

test("written-off findings stay in the count, so the recovery rate stays honest", () => {
  /**
   * A report that silently dropped what was abandoned would show a 100% recovery rate forever. What
   * a practice needs to know is how much of what it was owed it actually got.
   */
  const rows: StoredClockFinding[] = [
    { ...toStored(interest(), context({ subject: "A" })), outcome: "written-off" },
    { ...toStored(interest(), context({ subject: "B" })), outcome: "recovered", recoveredCents: cents(6.41) },
  ];
  const savings = foldSavings(rows);
  assert.equal(savings.promptPay.findings, 2);
  assert.equal(savings.promptPay.claimedCents, cents(12.82));
  assert.equal(savings.promptPay.recoveredCents, cents(6.41));
});

test("nothing found is a report of zeroes, not an empty object", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  assert.deepEqual(await repo.savings(), {
    promptPay: { findings: 0, claimedCents: 0 as Cents, recoveredCents: 0 as Cents },
    recoupment: { findings: 0, claimedCents: 0 as Cents, recoveredCents: 0 as Cents },
    /**
     * A COUNT and no money. Interest accrues on the amount ultimately paid, which nobody knows
     * while a claim is unanswered — so there is no honest figure to total, and the absence of one
     * here is what stops an estimate being added to measured interest and reported as one number.
     */
    deadlinesPassed: { findings: 0 },
  });
});

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

test("the worklist shows only what is still open, newest first", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  await repo.record(toStored(interest(), context({ subject: "A", detectedAt: "2026-08-01T00:00:00.000Z" })));
  await repo.record(toStored(interest(), context({ subject: "B", detectedAt: "2026-09-01T00:00:00.000Z" })));
  await repo.recordOutcome(
    { remittanceId: context().remittanceId, kind: "prompt-pay-interest", subject: "A" },
    { outcome: "not-pursued", recoveredCents: 0 as Cents, note: "Self-funded plan." }
  );

  const open = await repo.findings({ openOnly: true });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.subject, "B");
  assert.equal((await repo.findings()).length, 2, "and the closed one is still there to be audited");
});

test("the two kinds can be read apart, because they are two different jobs", async () => {
  const repo = new InMemoryStatutoryClockRepository();
  await repo.record(toStored(interest(), context({ subject: "A" })));
  await repo.record(toStored(outOfTime(), context({ subject: "B" })));

  assert.equal((await repo.findings({ kind: "prompt-pay-interest" }))[0]!.subject, "A");
  assert.equal((await repo.findings({ kind: "recoupment-out-of-time" }))[0]!.subject, "B");
});
