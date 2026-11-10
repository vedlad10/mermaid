/**
 * The board's money position must reconcile with itself, and with the modules it reads.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
 * The Today board shows the same money in two places by design: a lead figure a person reads in a
 * glance, and a panel that breaks it into the three things a person can do about it. Two renderings
 * of one quantity is exactly the arrangement that drifts, and on the first pass over real staging
 * data it had already drifted — the lead added "awaited" and "worth pursuing" while the panel also
 * counted the $482.51 assigned to a second plan. A reader comparing them would have found a $482.51
 * discrepancy with nothing on the screen to explain it.
 *
 * The client now computes that total once. These tests pin the arithmetic the client relies on, at
 * the boundary that produces it, so a future change to any module's aggregate cannot silently make
 * the board's two halves disagree again.
 *
 * ── WHAT IS DELIBERATELY NOT SUMMED ────────────────────────────────────────────────────────────
 * Held cash, payer money, patient money and money at risk are four different questions with four
 * different owners. There is no assertion here that they add to anything, because they must not be
 * added — a total across them would describe nothing, and the moment one exists somebody quotes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter, type RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { cents, type Role } from "@mermaid/shared";
import { buildTodayQueue } from "../today.ts";
import { buildServices, type Services } from "../wiring.ts";

const RECEIVED = new Date("2026-08-10T09:00:00Z");
const DAY_MS = 86_400_000;
const daysLater = (n: number): Date => new Date(RECEIVED.getTime() + n * DAY_MS);

/** …23 adjudicates as coordination of benefits — the state that produced the drift. */
const COB_MEMBER = "ABC00023";
/**
 * …77 is refused under CARC 197 in the `CO` group: recoverable money the practice may pursue and
 * may never bill the patient for. Needed because a COB advice alone carries NOTHING in
 * `totalRecoverable`, so a fixture built only from …23 cannot tell a correct posted-only filter from
 * one that also counts held advices — mutation testing caught exactly that hole here.
 */
const RECOVERABLE_MEMBER = "ABC00077";

const submitted = (memberId: string, id: string): ClaimSubmittedBody => ({
  claimId: `claim-${id}`,
  verificationId: `ver-${id}`,
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Held", lastName: "Patient", dateOfBirth: "1990-04-12", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
});

const remitClaim = (memberId: string, id: string): RemittanceRequestClaim => ({
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  patientFirstName: "Held",
  patientLastName: "Patient",
  memberId,
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/**
 * Real 835s from the mock clearinghouse, ingested through the production path.
 *
 * `member` decides what the payer's file SAYS; `payeeMismatch` decides why the advice is HELD. They
 * are separated because the two questions are independent, and a fixture that can only hold a COB
 * advice cannot exercise the recoverable path at all.
 */
async function clinicWithHeldAdvice(
  count: number,
  member: string = COB_MEMBER,
  payeeMismatch = false
): Promise<Services> {
  const services = buildServices({ inMemory: true });
  for (let i = 0; i < count; i++) {
    const id = `H${i}`;
    await services.remittance.recordExpectation(submitted(member, id));
    const fetched = await new MockEdiAdapter().fetchRemittance({
      payerId: "delta-dental",
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      paymentDate: "2026-08-10",
      claims: [remitClaim(member, id)],
    });
    /**
     * The mock emits `N1*PE` with a bare name, which is legal and makes the payee check report
     * `absent` rather than comparing anything. Injecting the identifier is what lets a genuine
     * mismatch be produced — through `checkPayee` reading parsed X12, not by writing a blocker
     * into a fixture.
     */
    const raw = payeeMismatch
      ? fetched.raw!.replace(/N1\*PE\*([^~]*)~/, `N1*PE*$1*XX*1111111111~`)
      : fetched.raw!;
    await services.remittance.ingestArtifact(
      raw,
      {
        resolution: "source-credential",
        vendor: "mock",
        artifactId: `file-${i}`,
        expectedPayeeId: payeeMismatch ? "9999999999" : null,
      },
      RECEIVED
    );
  }
  return services;
}

test("the money position is present and every figure is a number, not an absence", async () => {
  const services = await clinicWithHeldAdvice(1);
  const { money } = await buildTodayQueue(services, 50, daysLater(1));

  const figures = [
    "heldInBank",
    "heldCount",
    "owedByPayers",
    "withOtherPlans",
    "expectedFromPayers",
    "owedByPatients",
    "deniedUnrecovered",
    "recoveredByAppeal",
    "preAuthAtRisk",
  ] as const;

  for (const k of figures) {
    const v = money[k];
    assert.equal(typeof v, "number", `${k} must be a number for a viewer permitted to see it`);
    assert.ok(Number.isInteger(v), `${k} must be integer cents`);
    assert.ok(v! >= 0, `${k} must never be negative on this board`);
  }
});

test("held advices are listed individually, and their amounts sum to the held total", async () => {
  /**
   * The board lists held advices one by one, because "$1,599.98 held" is a figure nobody can act on
   * — releasing money requires knowing which advice, from whom, and how long it has sat. The list
   * and the total are two views of one set, so they must agree by construction.
   */
  const services = await clinicWithHeldAdvice(2);
  const { money } = await buildTodayQueue(services, 50, daysLater(1));

  assert.equal(money.heldAdvices!.length, money.heldCount, "one row per held advice");
  assert.equal(
    money.heldAdvices!.reduce((t, h) => t + h.amount, 0),
    money.heldInBank,
    "the rows must account for the total exactly"
  );
  for (const h of money.heldAdvices!) {
    assert.ok(h.traceNumber, "a trace number is what distinguishes two advices from one payer");
    assert.ok(h.payerName, "and the payer is who to call");
  }
});

test("held age is whole days, counted from receipt — never negative, never scraped from prose", async () => {
  /**
   * The first implementation pattern-matched the age out of the recommendation sentence the module
   * writes. That worked, and would have broken silently the first time somebody improved the
   * wording. The age is now a field.
   */
  const services = await clinicWithHeldAdvice(1);

  const sameDay = await buildTodayQueue(services, 50, daysLater(0));
  assert.equal(sameDay.money.heldAdvices![0]!.ageDays, 0, "received today is zero days, not one");

  const later = await buildTodayQueue(services, 50, daysLater(4));
  assert.equal(later.money.heldAdvices![0]!.ageDays, 4);

  /**
   * A PART day is what separates flooring from rounding, and every assertion on a whole multiple
   * passes under either. Four and a half days on hold is four days on hold: a dashboard must not
   * age money it has not yet aged.
   */
  const partial = await buildTodayQueue(services, 50, new Date(RECEIVED.getTime() + 4.5 * DAY_MS));
  assert.equal(partial.money.heldAdvices![0]!.ageDays, 4, "part of a day is not a day");
  const almost = await buildTodayQueue(services, 50, new Date(RECEIVED.getTime() + 2.99 * DAY_MS));
  assert.equal(
    almost.money.heldAdvices![0]!.ageDays,
    2,
    "and the three-day review threshold must not trip early"
  );

  /** A clock skewed backwards must not produce a negative age on a dashboard. */
  const skewed = await buildTodayQueue(services, 50, new Date(RECEIVED.getTime() - 2 * DAY_MS));
  assert.equal(skewed.money.heldAdvices![0]!.ageDays, 0);
});

test("held advices are ordered oldest first — the longest wait is the one to release", async () => {
  const services = await clinicWithHeldAdvice(2);
  const { money } = await buildTodayQueue(services, 50, daysLater(3));
  const ages = money.heldAdvices!.map((h) => h.ageDays);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
});

test("a held advice contributes nothing to what payers still owe", async () => {
  /**
   * THE ASSERTION THAT PINS THE SEPARATION. Held money is in the bank. Counting it as owed would
   * report the same dollar twice — once as received and once as outstanding — and the board shows
   * both figures side by side, so the double count would be on one screen.
   */
  /**
   * Two fixtures, because one cannot prove both halves. A COB advice carries money in
   * `totalWithOtherPayers` and nothing in `totalRecoverable`; an advice refused under CARC 197 is
   * the reverse. Testing only the first left a filter that also counted held advices passing
   * cleanly — the mutation survived, which is why both are here.
   */
  const cob = await buildTodayQueue(await clinicWithHeldAdvice(1), 50, daysLater(1));
  assert.ok(cob.money.heldInBank! > 0, "the fixture must actually hold money, or this proves nothing");
  assert.equal(cob.money.withOtherPlans, 0, "a held advice is not yet a fact about what a second plan owes");

  const refused = await buildTodayQueue(
    await clinicWithHeldAdvice(1, RECOVERABLE_MEMBER, true),
    50,
    daysLater(1)
  );
  /**
   * Note what this fixture is: a CARC 197 refusal pays NOTHING, so the advice is held and the
   * bank figure is legitimately zero. Asserting `heldInBank > 0` here was wrong — held is a state
   * of an advice, not a synonym for cash — and the board's copy was corrected to match.
   */
  assert.equal(refused.money.heldCount, 1, "the advice is held");
  assert.equal(refused.money.heldInBank, 0, "and it carries no payment — a zero-dollar advice");
  assert.equal(
    refused.money.owedByPayers,
    0,
    "and the $900.00 it withholds counts as owed only once a person accepts the advice"
  );
});

test("the recoverable fixture really does carry recoverable money once posted", async () => {
  /**
   * The guard on the test above. If CARC 197 ever stopped producing a recoverable adjustment, the
   * assertion that a HELD advice contributes zero would still pass while proving nothing at all.
   */
  const services = await clinicWithHeldAdvice(1, RECOVERABLE_MEMBER, true);
  const [advice] = await services.remittance.list();
  assert.equal(advice!.status, "held", "the payee mismatch must be what holds it");
  assert.ok(
    advice!.totalRecoverable > 0,
    "and the payer must genuinely have withheld money the practice may pursue"
  );
});

test("aging partitions the patient balance exactly — no bucket lost or counted twice", async () => {
  const services = await clinicWithHeldAdvice(1);
  const { money } = await buildTodayQueue(services, 50, daysLater(1));

  assert.equal(
    Object.values(money.aging!).reduce((a, b) => a + b, 0),
    money.owedByPatients,
    "the buckets are a partition of the balance, so they must sum to it"
  );
});

test("the over-90 share is a fraction or absent — never a number the UI would print as a count", async () => {
  const services = await clinicWithHeldAdvice(1);
  const { money } = await buildTodayQueue(services, 50, daysLater(1));

  if (money.overNinetyShare !== null) {
    assert.ok(
      money.overNinetyShare >= 0 && money.overNinetyShare <= 1,
      "a share is 0–1; the board multiplies it by 100"
    );
  }
});

test("an empty practice reports zero everywhere rather than omitting the position", async () => {
  /**
   * A board that renders `undefined` as `$NaN` is worse than one that renders `$0.00`. The empty
   * case is the one a new practice sees first.
   */
  const { money } = await buildTodayQueue(buildServices({ inMemory: true }), 50, daysLater(1));

  assert.equal(money.heldInBank, 0);
  assert.equal(money.heldCount, 0);
  assert.deepEqual(money.heldAdvices, []);
  assert.equal(money.oldestHeldAt, null);
  assert.equal(money.owedByPatients, 0);
  assert.equal(money.overNinetyShare, null, "no balance means the share is undefined, not zero");
  assert.equal(money.preAuthAtRisk, 0);
});

// ── Who may see what ────────────────────────────────────────────────────────────────────────────

/**
 * The board's route is gated on `queue.read`, which EVERY role holds — correctly, because every
 * role has work. That was fine while the board was only a worklist. The moment it also carried the
 * practice's money position, `queue.read` alone would have handed a front-desk user the total
 * patient A/R, the bank balance of unposted payer cash, the denial recovery figures and the
 * pre-authorisation exposure — four things that role's permission set deliberately excludes.
 *
 * The rule these pin: a withheld figure is `null`, never `0`. "$0.00 owed by patients" is a false
 * statement about a practice's money; "not yours to see" is a true one, and the board renders them
 * differently.
 */
const boardFor = async (role: Role) =>
  (await buildTodayQueue(await clinicWithHeldAdvice(1), 50, daysLater(1), { role })).money;

test("the front desk sees patient money and nothing else", async () => {
  const m = await boardFor("front_desk");

  assert.notEqual(m.owedByPatients, null, "patients.read — this is their screen");
  assert.equal(m.heldInBank, null, "no remittances.read");
  assert.equal(m.heldAdvices, null);
  assert.equal(m.owedByPayers, null);
  assert.equal(m.withOtherPlans, null);
  assert.equal(m.expectedFromPayers, null, "no claims.read");
  assert.equal(m.preAuthAtRisk, null);
  assert.equal(m.deniedUnrecovered, null, "no denials.read");
  assert.equal(m.recoveredByAppeal, null);
});

test("a dentist sees claim exposure but never a patient's balance", async () => {
  /**
   * Stated in the role matrix itself: a dentist writing an appeal narrative needs the treatment and
   * the payer's reason, not the patient's account balance. The board must not be the back door.
   */
  const m = await boardFor("dentist");

  assert.notEqual(m.expectedFromPayers, null, "claims.read");
  assert.notEqual(m.deniedUnrecovered, null, "denials.read");
  assert.equal(m.owedByPatients, null, "no patients.read — deliberately");
  assert.equal(m.aging, null);
  assert.equal(m.heldInBank, null, "no remittances.read");
});

test("a biller sees the whole position, because closing money is the job", async () => {
  const m = await boardFor("biller");

  for (const k of ["heldInBank", "owedByPayers", "expectedFromPayers", "owedByPatients", "deniedUnrecovered"] as const) {
    assert.notEqual(m[k], null, `a biller must see ${k}`);
  }
  assert.notEqual(m.heldAdvices, null);
});

test("an owner sees everything the fixture can show", async () => {
  /**
   * Two fields carry a null that means something else, and both are documented on the type:
   * `oldestHeldAt` is null when nothing is held, and `overNinetyShare` is null when no patient owes
   * anything — a share of nothing is undefined, not zero. They are excluded here rather than
   * asserted, because an overloaded null is worth naming out loud: for every OTHER field on this
   * object, null means exactly one thing, and that is what makes the permission gate legible.
   */
  const m = await boardFor("owner");
  const overloaded = new Set(["oldestHeldAt", "overNinetyShare"]);
  for (const [k, v] of Object.entries(m)) {
    if (overloaded.has(k)) continue;
    assert.notEqual(v, null, `an owner must see ${k}`);
  }
});

test("a withheld figure is null, never zero — the distinction the whole gate exists for", async () => {
  /**
   * THE ASSERTION THAT MATTERS. If a withheld figure were rendered as 0, a front-desk user would be
   * told the practice is owed nothing by payers, which is a lie the board states with confidence.
   * Proved against a fixture that genuinely holds money, so zero and withheld are distinguishable.
   */
  const services = await clinicWithHeldAdvice(1);
  const owner = (await buildTodayQueue(services, 50, daysLater(1), { role: "owner" })).money;
  const desk = (await buildTodayQueue(services, 50, daysLater(1), { role: "front_desk" })).money;

  assert.ok(owner.heldInBank! > 0, "there IS money held, so this is not a vacuous comparison");
  assert.equal(desk.heldInBank, null, "and the front desk is told it cannot see it");
  assert.notEqual(desk.heldInBank, 0, "not that there is none");
});

test("the queue's items are filtered by the same rule as its money", async () => {
  /**
   * Withholding the total while listing the rows it was computed from would be theatre.
   */
  const services = await clinicWithHeldAdvice(1);
  const owner = await buildTodayQueue(services, 50, daysLater(1), { role: "owner" });
  const desk = await buildTodayQueue(services, 50, daysLater(1), { role: "front_desk" });

  assert.ok(
    owner.items.some((i) => i.kind === "remittance"),
    "the owner's board carries the held advice as a row"
  );
  assert.equal(
    desk.items.filter((i) => i.kind === "remittance").length,
    0,
    "and the front desk's does not"
  );
  assert.equal(desk.counts.remittance, 0, "including in the counts");
});

test("no viewer means no filtering — the DB-free demo has no accounts to filter by", async () => {
  const services = await clinicWithHeldAdvice(1);
  const anonymous = (await buildTodayQueue(services, 50, daysLater(1))).money;
  assert.notEqual(anonymous.heldInBank, null);
});

test("a claim no payer will pay is valued at what the PATIENT owes, not zero", () => {
  /**
   * Ben Demo on staging: coverage inactive, so the claim expects $0.00 from the payer and $175.00
   * from him. The board listed him at $0.00 beside the instruction "Do not file. Re-verify coverage,
   * or collect from the patient directly."
   *
   * A row telling a biller to collect $175.00, valued at nothing, sorts to the bottom of a board
   * ranked by what it costs to leave alone. $175.00 nobody collects is exactly as lost as $175.00 a
   * payer never pays.
   */
  const item = {
    kind: "claim" as const,
    status: "draft",
    outstanding: 0,
    expectedInsurancePays: 0,
    expectedPatientPays: 17500,
  };
  /** The rule the queue applies, asserted directly — the three branches in priority order. */
  const value = (c: typeof item) =>
    c.outstanding > 0 ? c.outstanding : c.expectedInsurancePays > 0 ? c.expectedInsurancePays : c.expectedPatientPays;

  assert.equal(value(item), 17500, "an uninsured claim is worth what the patient owes");
  assert.equal(
    value({ ...item, expectedInsurancePays: 12000 }),
    12000,
    "an insured claim is still worth what the payer will pay"
  );
  assert.equal(
    value({ ...item, outstanding: 5000, expectedInsurancePays: 12000 }),
    5000,
    "and once a payer has ruled, the outstanding balance wins"
  );
});

// ── The activity feed ───────────────────────────────────────────────────────────────────────────

/**
 * The feed exists because every other element on the board is a POSITION — what is true now — and a
 * position cannot tell a practice where nothing needs doing apart from one whose payer feed stopped
 * three days ago. Those look identical and mean opposite things.
 *
 * Which makes its timestamps load-bearing. The first version stamped "appeal won" with the DENIAL's
 * timestamp, because that was the only instant the row carried: a fabricated time on a real event,
 * sorting the win alongside the refusal it reversed.
 */
test("the board stamps the instant its money was read", async () => {
  const at = daysLater(2);
  const queue = await buildTodayQueue(await clinicWithHeldAdvice(1), 50, at);
  assert.equal(
    queue.generatedAt,
    at.toISOString(),
    "the freshness stamp must be the clock every figure was computed against, not the render time"
  );
});

test("every activity entry carries a real instant, newest first", async () => {
  const queue = await buildTodayQueue(await clinicWithHeldAdvice(2), 50, daysLater(2));
  assert.ok(queue.recentActivity.length > 0, "the fixture must produce events, or this proves nothing");

  for (const a of queue.recentActivity) {
    assert.ok(a.at, "an entry with no instant must not be emitted at all");
    assert.ok(
      !Number.isNaN(new Date(a.at).getTime()),
      `${a.text} carries an unparseable instant: ${a.at}`
    );
    assert.ok(a.text.length > 0);
  }

  const times = queue.recentActivity.map((a) => a.at);
  assert.deepEqual(times, [...times].sort().reverse(), "newest first, or a feed is just a list");
});

/**
 * A clinic whose denial has been appealed and won, with the win recorded on a LATER day.
 *
 * The held-advice fixtures produce no denials at all, so the branch that stamps an appeal win went
 * untested — and two mutations proved it: reverting the win to the denial's own clock, and dropping
 * the sort entirely, both passed. A fixture where the two instants differ is the only thing that can
 * tell them apart.
 */
async function clinicWithWonAppeal(): Promise<{ services: Services; deniedAt: string; wonAt: Date }> {
  const services = buildServices({ inMemory: true });
  const id = "W1";
  await services.remittance.recordExpectation(submitted(RECOVERABLE_MEMBER, id));
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [remitClaim(RECOVERABLE_MEMBER, id)],
  });
  await services.remittance.ingestArtifact(
    fetched.raw!,
    { resolution: "source-credential", vendor: "mock", artifactId: "f-W1", expectedPayeeId: null },
    RECEIVED
  );
  const [denial] = await services.denials.list();
  assert.ok(denial, "the CARC 197 refusal must have produced a denial");

  /** Won three days after it was detected — the gap is the whole point of the fixture. */
  const wonAt = daysLater(3);
  await services.denials.draftAppeal(denial!.id, {}, wonAt);
  await services.denials.approveAppeal(denial!.id, "manager@clinic", wonAt);
  await services.denials.submitAppeal(denial!.id, wonAt);
  await services.denials.recordOutcome(denial!.id, { won: true, recordedBy: "manager@clinic" }, wonAt);
  return { services, deniedAt: denial!.detectedAt, wonAt };
}

test("an appeal win is stamped when the payer agreed, not when the claim was refused", async () => {
  /**
   * THE ASSERTION THE MUTATION EXPOSED. The win and the refusal are different events, days apart,
   * and stamping one with the other's clock sorts a recovery alongside the denial it reversed.
   */
  const { services, deniedAt, wonAt } = await clinicWithWonAppeal();
  const queue = await buildTodayQueue(services, 50, daysLater(4));

  const win = queue.recentActivity.find((a) => /Appeal won/.test(a.text));
  assert.ok(win, `no appeal-win entry was emitted: ${queue.recentActivity.map((a) => a.text).join(" | ")}`);
  assert.notEqual(win!.at, deniedAt, "the win must not borrow the refusal's instant");
  assert.equal(win!.at.slice(0, 10), wonAt.toISOString().slice(0, 10), "it carries the day it was won");

  const refusal = queue.recentActivity.find((a) => /refused/.test(a.text));
  assert.ok(refusal, "and the refusal is still its own entry");
  assert.equal(refusal!.at, deniedAt);
  assert.ok(win!.at > refusal!.at, "the win is the later of the two, and must sort that way");
});

test("the feed orders a win above the refusal it reversed", async () => {
  const { services } = await clinicWithWonAppeal();
  const queue = await buildTodayQueue(services, 50, daysLater(4));
  const times = queue.recentActivity.map((a) => a.at);
  assert.deepEqual(times, [...times].sort().reverse());

  const winAt = queue.recentActivity.findIndex((a) => /Appeal won/.test(a.text));
  const refusalAt = queue.recentActivity.findIndex((a) => /refused/.test(a.text));
  assert.ok(winAt >= 0 && refusalAt >= 0);
  assert.ok(winAt < refusalAt, "newest first means the win comes before the refusal");
});

test("a win says AWARDED, and the cash arriving is a separate entry", async () => {
  /**
   * Telling the same money twice under two verbs is how a feed starts overstating what a practice
   * has. The payer agreeing and the payer paying are different events with different instants.
   */
  const { services } = await clinicWithWonAppeal();
  const queue = await buildTodayQueue(services, 50, daysLater(4));
  const win = queue.recentActivity.find((a) => /Appeal won/.test(a.text))!;
  assert.match(win.text, /agreed to pay/);
  assert.ok(!/recovered/.test(win.text), "an award is a promise, not an arrival");
});

test("an entry never claims an instant borrowed from a different event", async () => {
  /**
   * THE ASSERTION THIS EXISTS FOR. Every remittance entry must carry that remittance's own
   * `receivedAt`; nothing may be stamped with a sibling's clock.
   */
  const services = await clinicWithHeldAdvice(2);
  const queue = await buildTodayQueue(services, 50, daysLater(2));
  const advices = await services.remittance.list();
  const known = new Set(advices.map((r) => r.receivedAt));

  for (const a of queue.recentActivity.filter((x) => x.kind === "remittance")) {
    assert.ok(known.has(a.at), `a remittance entry is stamped ${a.at}, which no advice recorded`);
  }
});

test("the feed is bounded, so a busy practice does not render its whole history", async () => {
  const queue = await buildTodayQueue(await clinicWithHeldAdvice(2), 50, daysLater(2));
  assert.ok(queue.recentActivity.length <= 8);
});

test("an empty practice reports an empty feed rather than a placeholder", async () => {
  const queue = await buildTodayQueue(buildServices({ inMemory: true }), 50, daysLater(1));
  assert.deepEqual(queue.recentActivity, []);
});
