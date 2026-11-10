/**
 * Ledger service tests — the gates and the idempotency.
 *
 * Two properties carry the weight here. A patient must never be charged twice for one event, because
 * that failure leaves the building as a demand for money they do not owe. And money must never leave
 * a balance without a named person, because that is exactly how a practice loses revenue quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { InMemoryOutbox } from "@mermaid/events";
import type { DenialClosedBody, RemittancePostedBody } from "@mermaid/events";
import {
  InMemoryLedgerRepository,
  LedgerActionError,
  PatientAccountNotFoundError,
  PatientLedgerService,
} from "../index.ts";

const NOW = new Date("2026-10-01T12:00:00Z");

function wired() {
  const bus = new InMemoryOutbox();
  const repo = new InMemoryLedgerRepository();
  return { bus, repo, service: new PatientLedgerService(repo, bus) };
}

const posted = (overrides: Partial<RemittancePostedBody> = {}): RemittancePostedBody => ({
  remittanceId: "rem-1",
  postingId: "post-1",
  claimId: "claim-1",
  patientControlNumber: "MRM-000123",
  postedAt: "2026-09-01T09:00:00.000Z",
  traceNumber: "EFT100200300",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  paymentDate: "2026-09-01",
  chargedAmount: cents(1425),
  paidAmount: cents(800),
  patientResponsibility: cents(200),
  contractualAdjustments: cents(425),
  expectedInsurancePays: cents(800),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
  /**
   * Every advice in this file is a payer ADJUDICATING the claim and stating the patient's share —
   * which is what these tests are about, and why the balance follows the payer's latest word both
   * up and down.
   *
   * The flag has to be explicit now because a second posting on a claim is no longer always such a
   * statement. A supplemental cheque settling an appeal reports `patientResponsibility: 0` while
   * re-adjudicating nothing, and reading that as "the payer lowered the share to zero" forgave a
   * real $136.01 on staging. `patient-responsibility-restatement.test.ts` covers that case; these
   * keep pinning the genuine one, unchanged.
   */
  disposition: "partial",
  restatesPatientResponsibility: true,
  ...overrides,
});

const closed = (overrides: Partial<DenialClosedBody> = {}): DenialClosedBody => ({
  denialId: "den-1",
  claimId: "claim-1",
  closedAt: "2026-09-05T09:00:00.000Z",
  closedBy: "biller@clinic",
  closedAs: "patient_billed",
  reason: "Plan excludes this procedure; the patient agreed to self-pay.",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  carcCode: "204",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  deniedAmount: cents(125),
  ...overrides,
});

// ── Charges from the cycle ────────────────────────────────────────────────────────────

test("a posting's patient responsibility becomes a charge nobody had to type", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);

  const statement = (await service.statement("ABC12345", NOW))!;
  assert.equal(statement.account.balance, cents(200));
  assert.equal(statement.account.patientName, "Ada Alpha");
  assert.equal(statement.entries[0]!.recordedBy, "system");
  assert.match(statement.entries[0]!.description, /Delta Dental processed the claim/);
  assert.equal(statement.entries[0]!.claimId, "claim-1");
});

test("a redelivered posting charges the patient exactly once", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted(), NOW);
  const second = await service.chargeFromPosting(posted(), NOW);

  assert.equal(second, null, "the second delivery must report that it changed nothing");
  assert.equal(repo.size, 1);
  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(200));
});

test("a posting that left the patient nothing creates no entry", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({ patientResponsibility: cents(0) }), NOW);
  assert.equal(repo.size, 0, "a $0.00 line is noise on the one document a patient reads closely");
});

// ── M6 — one claim, one patient balance, whatever the payer does next ─────────────────────────
//
// `chargeFromPosting` charged `patientResponsibility` outright and was idempotent only on the
// POSTING id. That guards a redelivery of one posting and nothing else. A payer that re-adjudicates
// a claim — a COB correction, an appeal it paid, a fee-schedule correction — issues a SECOND posting
// under a new trace number, and the patient was charged their share a second time.
//
// The reversal gate does not cover it: `checkRemittanceSafety` blocks CLP-22 reversals, but a payer
// that simply re-adjudicates sends no reversal at all. Claims already handled its own side (an
// audit note, no state change), so the claim knew it was settled while the ledger did not.

test("M6: a reprocessed claim does not charge the patient a second time", async () => {
  const { service, repo } = wired();

  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(200) }), NOW);
  // The payer reprocesses and restates the SAME patient share, under a new posting.
  const second = await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(200) }),
    NOW
  );

  assert.equal(second, null, "the payer said nothing new about the patient's share");
  assert.equal(repo.size, 1);
  assert.equal(
    (await service.statement("ABC12345", NOW))!.account.balance,
    cents(200),
    "$400 here would be a demand for money the patient does not owe"
  );
});

test("M6: a reprocessing that RAISES the patient's share charges only the difference", async () => {
  const { service } = wired();

  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(200) }), NOW);
  const entry = await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(350) }),
    NOW
  );

  assert.ok(entry);
  assert.equal(Math.abs(entry!.amount), cents(150), "the increase, not the whole restated figure");
  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(350));
  assert.match(entry!.description, /reprocessed the claim and raised/);
});

test("M6: a reprocessing that LOWERS the patient's share reduces the balance automatically", async () => {
  /**
   * The downward direction is as automatic as the upward one, deliberately. Raising a balance on the
   * payer's say-so while requiring a human to lower it would bias the ledger toward over-billing —
   * and both are the same kind of statement, from the same source, sourced to the same posting.
   *
   * It is NOT the courtesy adjustment `recordAdjustment` gates behind a person: nobody is choosing
   * to forgive anything, the payer has restated what is owed.
   */
  const { service } = wired();

  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(500) }), NOW);
  const entry = await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(120) }),
    NOW
  );

  assert.ok(entry);
  assert.equal(entry!.kind, "adjustment", "a reduction, not a negative charge");
  assert.equal(
    (await service.statement("ABC12345", NOW))!.account.balance,
    cents(120),
    "the balance is the payer's LATEST word, not the sum of every word"
  );
  assert.match(entry!.description, /lowered patient responsibility/);
});

test("M6: a claim the payer later left at zero clears the patient's balance for it", async () => {
  // The extreme of the downward case — an appeal the payer paid in full. The patient must not be
  // left owing money the payer has since covered.
  const { service } = wired();

  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(500) }), NOW);
  await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(0) }),
    NOW
  );

  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(0));
});

test("M6: two DIFFERENT claims each charge in full — the rule is per claim, not per patient", async () => {
  // The control. Netting across claims would swallow a genuine second balance for the same person.
  const { service } = wired();

  await service.chargeFromPosting(posted({ claimId: "claim-1", postingId: "post-1", patientResponsibility: cents(200) }), NOW);
  await service.chargeFromPosting(posted({ claimId: "claim-2", postingId: "post-2", patientResponsibility: cents(300) }), NOW);

  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(500));
});

test("M6: a human payment is not mistaken for a prior posting when the delta is computed", async () => {
  /**
   * The delta reads only entries SOURCED TO A POSTING. If it counted a patient's own payment as
   * "already charged", a reprocessing would re-add the money they had just paid — the double charge
   * this fix exists to stop, arriving through the fix itself.
   */
  const { service } = wired();

  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(200) }), NOW);
  await service.recordPayment("ABC12345", { amount: cents(200), recordedBy: "front.desk" }, NOW);
  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(0));

  // The payer now restates the same $200. Nothing further is owed.
  const again = await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(200) }),
    NOW
  );

  assert.equal(again, null);
  assert.equal(
    (await service.statement("ABC12345", NOW))!.account.balance,
    cents(0),
    "the patient already paid; a restatement must not resurrect the balance"
  );
});

test("a payment that cannot be tied to a patient is not somebody's debt", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({ memberId: null }), NOW);
  assert.equal(repo.size, 0);
});

test("a denial closed as the patient's becomes a charge — the money used to vanish here", async () => {
  const { service } = wired();
  await service.chargeFromDenial(closed(), NOW);

  const statement = (await service.statement("ABC12345", NOW))!;
  assert.equal(statement.account.balance, cents(125));
  assert.equal(statement.entries[0]!.denialId, "den-1");
  assert.equal(statement.entries[0]!.recordedBy, "biller@clinic");
  assert.match(statement.entries[0]!.description, /reason 204/);
  assert.match(statement.entries[0]!.description, /agreed to self-pay/);
});

test("a denial written off charges nobody — that is what writing it off MEANS", async () => {
  const { service, repo } = wired();
  await service.chargeFromDenial(closed({ closedAs: "written_off" }), NOW);
  assert.equal(repo.size, 0);
});

test("a redelivered close charges once", async () => {
  const { service, repo } = wired();
  await service.chargeFromDenial(closed(), NOW);
  await service.chargeFromDenial(closed(), NOW);
  assert.equal(repo.size, 1);
});

// ── Human gates ───────────────────────────────────────────────────────────────────────

test("a payment reduces the balance and is attributed", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);

  const statement = await service.recordPayment(
    "ABC12345",
    { amount: cents(50), recordedBy: "front.desk@clinic", note: "Card, in person" },
    NOW
  );

  assert.equal(statement.account.balance, cents(150));
  assert.equal(statement.account.paid, cents(50));
  assert.equal(statement.entries[0]!.recordedBy, "front.desk@clinic");
  assert.match(statement.entries[0]!.description, /Payment received by front\.desk@clinic/);
});

test("money never leaves a balance anonymously", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await assert.rejects(
    () => service.recordPayment("ABC12345", { amount: cents(10), recordedBy: "  " }, NOW),
    LedgerActionError
  );
});

test("an adjustment and a write-off both require a reason", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);

  await assert.rejects(
    () => service.recordAdjustment("ABC12345", { amount: cents(10), recordedBy: "owner" }, NOW),
    /needs a reason/
  );
  await assert.rejects(
    () => service.writeOff("ABC12345", { amount: cents(10), recordedBy: "owner" }, NOW),
    /needs a reason/
  );
});

test("a write-off is recorded as revenue the practice chose to lose, not as a payment", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);

  const statement = await service.writeOff(
    "ABC12345",
    { amount: cents(200), recordedBy: "owner@clinic", note: "Uncollectable after four statements." },
    NOW
  );

  assert.equal(statement.account.balance, 0);
  assert.equal(statement.account.paid, 0, "writing off is not collecting");
  assert.equal(statement.account.forgiven, cents(200));
});

test("the ledger refuses to go negative by accident", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await assert.rejects(
    () => service.recordPayment("ABC12345", { amount: cents(500), recordedBy: "front.desk" }, NOW),
    /more than the \$200\.00 outstanding/
  );
});

test("a payment against an account that does not exist is refused, not silently created", async () => {
  const { service } = wired();
  await assert.rejects(
    () => service.recordPayment("NOBODY", { amount: cents(10), recordedBy: "front.desk" }, NOW),
    PatientAccountNotFoundError
  );
});

test("two payments from the same patient are two payments, not a redelivery", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await service.recordPayment("ABC12345", { amount: cents(50), recordedBy: "front.desk" }, NOW);
  await service.recordPayment("ABC12345", { amount: cents(50), recordedBy: "front.desk" }, NOW);

  assert.equal(repo.size, 3);
  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(100));
});

test("a fractional amount is refused — money is integer cents, everywhere", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await assert.rejects(
    () => service.recordPayment("ABC12345", { amount: 10.5 as never, recordedBy: "front.desk" }, NOW),
    /whole number of cents/
  );
});

// ── Events out ────────────────────────────────────────────────────────────────────────

test("a charge is announced so Analytics can count both halves of every dollar", async () => {
  const { service, bus } = wired();
  await service.chargeFromPosting(posted(), NOW);

  const [event] = bus.ofType("patient.charged");
  assert.ok(event);
  assert.equal(event.payload.patientKey, "ABC12345");
  assert.equal(event.payload.amount, cents(200));
  assert.equal(event.payload.claimId, "claim-1");
});

test("a payment is announced with the balance it left behind", async () => {
  const { service, bus } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await service.recordPayment("ABC12345", { amount: cents(75), recordedBy: "front.desk" }, NOW);

  const [event] = bus.ofType("patient.payment.recorded");
  assert.ok(event);
  assert.equal(event.payload.kind, "payment");
  assert.equal(event.payload.amount, cents(75));
  assert.equal(event.payload.balanceAfter, cents(125));
  assert.equal(event.payload.recordedBy, "front.desk");
});

test("a write-off announces itself as a write-off — a report must not read it as revenue", async () => {
  const { service, bus } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await service.writeOff("ABC12345", { amount: cents(200), recordedBy: "owner", note: "Uncollectable." }, NOW);

  assert.equal(bus.ofType("patient.payment.recorded")[0]!.payload.kind, "writeoff");
});

test("a redelivered charge is not re-announced", async () => {
  const { service, bus } = wired();
  await service.chargeFromPosting(posted(), NOW);
  await service.chargeFromPosting(posted(), NOW);
  assert.equal(bus.ofType("patient.charged").length, 1);
});

// ── Lists ─────────────────────────────────────────────────────────────────────────────

test("the worklist ranks by what it costs to leave alone, and hides settled accounts", async () => {
  const { service } = wired();
  const old = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();

  await service.chargeFromPosting(
    posted({ postingId: "p1", memberId: "OLD", patientName: "Old Balance", postedAt: old, patientResponsibility: cents(60) }),
    NOW
  );
  await service.chargeFromPosting(
    posted({ postingId: "p2", memberId: "NEW", patientName: "New Balance", patientResponsibility: cents(600) }),
    NOW
  );
  await service.chargeFromPosting(
    posted({ postingId: "p3", memberId: "PAID", patientName: "Paid Up", patientResponsibility: cents(90) }),
    NOW
  );
  await service.recordPayment("PAID", { amount: cents(90), recordedBy: "front.desk" }, NOW);

  const all = await service.list(undefined, NOW);
  assert.equal(all[0]!.patientKey, "OLD", "a 120-day $60 balance outranks a fresh $600 one");

  const owing = await service.list({ withBalanceOnly: true }, NOW);
  assert.deepEqual(
    owing.map((a) => a.patientKey).sort(),
    ["NEW", "OLD"],
    "a settled account is not outstanding work"
  );
});

test("the practice summary is the answer to 'what do our patients owe us?'", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({ postingId: "p1", memberId: "A", patientResponsibility: cents(100) }), NOW);
  await service.chargeFromPosting(posted({ postingId: "p2", memberId: "B", patientResponsibility: cents(250) }), NOW);
  await service.recordPayment("B", { amount: cents(50), recordedBy: "front.desk" }, NOW);

  const summary = await service.summary(NOW);
  assert.equal(summary.accountsWithBalance, 2);
  assert.equal(summary.totalOutstanding, cents(300));
  assert.equal(summary.totalCharged, cents(350));
  assert.equal(summary.totalPaid, cents(50));
  assert.equal(summary.collectionRate, 0.143);
});

// ── M8 — a balance under COORDINATION OF BENEFITS is never the patient's to be billed ─────────
//
// When the payer assigned money to another plan's adjudication (`OA` / CARC 23) or forwarded the
// claim outright (CLP02 `19`/`20`), what the patient actually owes depends on what that other plan
// pays. The `PR` figure on THIS advice is the primary's view, not the final answer.
//
// The remittance safety gate already holds such an advice, so this only runs on one a person
// released — and that is exactly why the second layer is needed. Releasing a remittance means "I
// reconciled this file"; it does not mean "I established the patient owes this". Treating those as
// the same decision is how the money gets billed anyway: a refund when discovered, and a
// balance-billing exposure in several states.

test("M8: a balance under coordination is NEVER charged to the patient", async () => {
  const { service, repo } = wired();
  const entry = await service.chargeFromPosting(posted({ coordinationAmount: cents(250) }), NOW);

  assert.equal(entry, null, "UNKNOWN goes to a human, never to the patient");
  assert.equal(repo.size, 0, "and nothing is written that a statement could later print");
});

test("M8: a FORWARDED claim is not billed either, even when no coordination amount is stated", async () => {
  // The two signals are independent: a payer may forward without itemising an OA amount, and one
  // being absent must not make the other safe.
  const { service, repo } = wired();
  const entry = await service.chargeFromPosting(posted({ forwardedToOtherPayer: true }), NOW);

  assert.equal(entry, null);
  assert.equal(repo.size, 0);
});

test("M8: an ordinary posting still charges the patient — the guard must not stop normal billing", async () => {
  // The control. A ledger that quietly stopped billing everyone would be a worse failure than the
  // one this fixes, and it would be found slowly.
  const { service, repo } = wired();
  const entry = await service.chargeFromPosting(posted({ patientResponsibility: cents(150) }), NOW);

  assert.ok(entry, "an ordinary patient balance must still be billed");
  assert.equal(Math.abs(entry!.amount), cents(150));
  assert.equal(repo.size, 1);
});

test("M8: a redelivered coordinated posting still charges nobody", async () => {
  // The outbox delivers at least once. A guard that only held the first delivery would be no guard.
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({ coordinationAmount: cents(250) }), NOW);
  await service.chargeFromPosting(posted({ coordinationAmount: cents(250) }), NOW);

  assert.equal(repo.size, 0);
});

test("M8: coordination arriving AFTER an ordinary charge does not reverse or re-bill it", async () => {
  /**
   * The interaction with M6's delta rule. A first advice bills the patient normally; a second, later
   * advice on the same claim turns out to involve another plan. The coordinated posting must not be
   * treated as "the payer restated the balance as zero" and post a reversing adjustment — that would
   * be Mermaid deciding the coordination question by itself, in the patient's favour but on no
   * evidence. It must simply not act.
   */
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({ postingId: "post-1", patientResponsibility: cents(200) }), NOW);
  assert.equal((await service.statement("ABC12345", NOW))!.account.balance, cents(200));

  await service.chargeFromPosting(
    posted({ postingId: "post-2", remittanceId: "rem-2", patientResponsibility: cents(0), coordinationAmount: cents(200) }),
    NOW
  );

  assert.equal(repo.size, 1, "no second entry — the coordination question is not the ledger's to answer");
  assert.equal(
    (await service.statement("ABC12345", NOW))!.account.balance,
    cents(200),
    "the original charge stands until a human resolves the other coverage"
  );
});
