/**
 * Stopped money must age — the Today queue's half.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────────
 * Mermaid's money-safety design terminates in one instruction: when uncertain, HOLD. Eight distinct
 * blockers end there — seven in `engine/safety.ts` plus the payee cross-check. The hold is correct
 * and nothing here changes it.
 *
 * What was missing is that the hold had no clock. This queue set `dueDate: null` on every held
 * remittance and marked it urgent only `&& !balanced`, which made "does the arithmetic add up" the
 * test for "does someone need to look at this today". Those are different questions, and the gap
 * between them is exactly where the most recent money-safety work landed: a coordination hold (M8)
 * and a payee mismatch (G1) both balance TO THE CENT — the money is fully accounted for and its
 * OWNER is unknown. Under the old condition neither could ever become urgent, however long it sat.
 * The newest safety work was the least visible work on the board.
 *
 * Meanwhile a dead-lettered ERA artifact — a payer's payment file abandoned after five failed
 * retrievals — appeared on no screen at all. `EraArtifactRepository.list()` had zero callers outside
 * its own tests.
 *
 * Both are invisible to `reconcileAll()`, for opposite reasons: the held remittance IS a row, so its
 * money reconciles perfectly while nobody works it; the abandoned artifact never became a row, so it
 * contributes to neither side of the sum. The money monitor reports balanced either way.
 *
 * ── WHY THESE DRIVE REAL PARSED X12 ────────────────────────────────────────────────────────────
 * A hand-built `status: "held"` fixture proves the queue agrees with itself about a value a test
 * wrote. It proves nothing about whether a hold that a payer's own file produces ever reaches this
 * code — the exact shape of the coverage-date defect, where a field that was always null and a payer
 * who never spoke were indistinguishable for a whole milestone. So the coordination hold below comes
 * out of `MockEdiAdapter` (member IDs ending `23` adjudicate as COB) through the production
 * `parse835`, and the payee mismatch comes through the real `ingestArtifact` cross-check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter, type RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { createLogger } from "@mermaid/observability";
import { EraIngestService, InMemoryEraSourceRepository } from "@mermaid/remittance";
import { calendarDay, cents } from "@mermaid/shared";
import { buildTodayQueue } from "../today.ts";
import { buildServices, type Services } from "../wiring.ts";

const RECEIVED = new Date("2026-08-10T09:00:00Z");
const DAY_MS = 86_400_000;
/** `now`, expressed as whole days after the remittance landed. */
const daysLater = (n: number): Date => new Date(RECEIVED.getTime() + n * DAY_MS);

/** …23 adjudicates as coordination of benefits: CAS*OA*23 plus CLP02 `19`. Balances exactly. */
const COB_MEMBER = "ABC00023";

const submitted = (memberId: string): ClaimSubmittedBody => ({
  claimId: "claim-held",
  verificationId: "ver-held",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Held", lastName: "Patient", dateOfBirth: "1990-04-12", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: "MRM-HELD1",
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
});

const remitClaim = (memberId: string): RemittanceRequestClaim => ({
  patientControlNumber: "MRM-HELD1",
  payerControlNumber: "556677889",
  patientFirstName: "Held",
  patientLastName: "Patient",
  memberId,
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/**
 * A real 835 from the mock clearinghouse, as raw X12.
 *
 * `payeeNpi` is injected into loop 1000B the same way `era-ingest.test.ts` does it: the mock's
 * `fetchRemittance` emits `N1*PE` with a bare name, which is legal and which makes the payee check
 * report `absent` rather than comparing anything. Adding the identifier is what lets a genuine
 * mismatch be produced — through `checkPayee` reading parsed X12, not by writing a blocker into a
 * fixture.
 */
async function era(memberId: string, payeeNpi: string | null = null): Promise<string> {
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [remitClaim(memberId)],
  });
  const raw = fetched.raw!;
  return payeeNpi ? raw.replace(/N1\*PE\*([^~]*)~/, `N1*PE*$1*XX*${payeeNpi}~`) : raw;
}

/**
 * Ingest one real ERA and return the services holding it.
 *
 * `expectedPayeeId` is what the practice's ERA source registered. Passing an identifier the file
 * does not carry is what produces a genuine `payee-mismatch` blocker — through `checkPayee`, not by
 * writing the blocker into a fixture.
 */
async function withHeldRemittance(
  memberId: string,
  payee: { onFile: string; registered: string } | null = null
): Promise<{ services: Services; remittanceId: string }> {
  const services = buildServices({ inMemory: true });
  await services.remittance.recordExpectation(submitted(memberId));
  const views = await services.remittance.ingestArtifact(
    await era(memberId, payee?.onFile ?? null),
    {
      resolution: "source-credential",
      vendor: "mock",
      artifactId: "file-1",
      expectedPayeeId: payee?.registered ?? null,
    },
    RECEIVED
  );
  assert.equal(views.length, 1, "the fixture is one advice");
  return { services, remittanceId: views[0]!.remittance.id };
}

const remittanceItems = (queue: Awaited<ReturnType<typeof buildTodayQueue>>) =>
  queue.items.filter((i) => i.kind === "remittance");

// ── A. The held remittance gets a clock ─────────────────────────────────────────────────

/**
 * ── THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE ───────────────────────────────────────────
 * A coordination hold BALANCES. Restore the old `urgent: held && !balanced` and this test fails,
 * because a balanced hold could never be urgent at any age.
 */
test("a balanced, held remittance becomes urgent once it has aged — and it balances", async () => {
  const { services } = await withHeldRemittance(COB_MEMBER);

  const fresh = remittanceItems(await buildTodayQueue(services, 50, daysLater(1)));
  assert.equal(fresh.length, 1);
  assert.equal(
    fresh[0]!.urgent,
    false,
    "a hold from yesterday is work, not yet an emergency — the threshold has to mean something"
  );

  const aged = remittanceItems(await buildTodayQueue(services, 50, daysLater(3)));
  assert.equal(
    aged[0]!.urgent,
    true,
    "at the review threshold a held remittance is urgent REGARDLESS of whether it balances — this is " +
      "the whole defect: the coordination and payee holds the money-safety work added all balance"
  );

  // The property that made the old condition wrong, asserted directly rather than implied.
  const listed = await services.remittance.list({ needsAttention: true }, daysLater(3));
  assert.equal(listed[0]!.balanced, true, "a coordination hold balances to the cent; its OWNER is what is unknown");
  assert.equal(listed[0]!.status, "held");
});

test("a held remittance carries a real due date, and it is the review deadline", async () => {
  const { services } = await withHeldRemittance(COB_MEMBER);

  const [item] = remittanceItems(await buildTodayQueue(services, 50, daysLater(1)));
  assert.equal(
    item!.dueDate,
    calendarDay(new Date(RECEIVED.getTime() + 3 * DAY_MS), "UTC"),
    "three days from when the money ARRIVED — the countdown is on the practice, not on the payer"
  );
  /**
   * A DAY, not an instant. The client renders `dueDate` verbatim and has no timezone of its own, so
   * an ISO instant here reached a biller as `by 2026-08-31T04:40:14.825Z` beside rows showing plain
   * dates. The shape is asserted because the shape is what was wrong.
   */
  assert.match(item!.dueDate!, /^\d{4}-\d{2}-\d{2}$/, "a deadline is a day a human works to");
});

test("the subtitle names the payment, not only its age", async () => {
  /**
   * The age is not an identifier. Staging carries two Cigna advices identical on this board -- same
   * payer, same $799.99, same claim, same "FORWARDED to another plan" reason -- separated only by
   * "held 0 days" versus "held 3 days". Neither carries a trace or check number, which is exactly
   * why both are held, so a biller could not tell from the queue whether Cigna sent $799.99 once or
   * twice; releasing both posts $1,599.98 against one payment.
   *
   * The payment date is what distinguishes them, and the Money screen already led with it.
   */
  const { services } = await withHeldRemittance(COB_MEMBER);

  const [item] = remittanceItems(await buildTodayQueue(services, 50, daysLater(1)));
  assert.match(
    item!.subtitle,
    /^Paid \d{4}-\d{2}-\d{2} /,
    `a held row must say WHICH payment it is, not only how old: "${item!.subtitle}"`
  );
});

test("the subtitle states how long the money has sat and how much of it there is", async () => {
  const { services } = await withHeldRemittance(COB_MEMBER);

  const [item] = remittanceItems(await buildTodayQueue(services, 50, daysLater(5)));
  assert.match(item!.subtitle, /held 5 days/i, "the age is on the row, not only in the ranking");
  // $600.00 is what the PAYER SENT (BPR02), not the $1,000 charged. The amount at risk here is the
  // cash sitting unposted, which is the payer's figure — the charge is not money anyone holds.
  assert.match(item!.subtitle, /\$600\.00 not posted/, "and the money, because a count alone is deferrable");
  /**
   * The reason is on the ROW, but on the action rather than the subtitle — it moved, and this
   * assertion moved with it rather than being dropped.
   *
   * It used to be in both places at once: the subtitle ended with `holdReason` and the action is
   * "Review and release — {the same holdReason}". For a coordination hold that reason is a
   * paragraph, so staging rendered those rows at 268px against 106px for everything else and
   * pushed the board off the screen. The guarantee here was never "the subtitle says why" — it was
   * "a biller can see why without opening the row", and one copy satisfies that.
   *
   * See no-queue-item-says-the-same-thing-twice.test.ts, which fails if it goes back to two.
   */
  assert.match(item!.action!, /coordination|another payer|other/i, "and the reason it is held");
});

/**
 * The second blocker, through a different code path entirely. One clock, whatever stopped the money
 * — if aging were wired to the coordination hold specifically it would pass the test above and still
 * leave every other hold invisible.
 */
test("a payee-mismatch hold ages identically — two blockers, one clock", async () => {
  // An ORDINARY member: nothing about this claim's adjudication is unusual, so the only thing
  // holding it is that the file names a payee this practice's source did not register.
  const { services } = await withHeldRemittance("ABC12345", { onFile: "1999999992", registered: "1234567893" });

  const listed = await services.remittance.list({ needsAttention: true }, daysLater(3));
  assert.equal(listed[0]!.status, "held");
  assert.match(String(listed[0]!.holdReason), /payee/i, "held by the payee cross-check, not by coordination");
  assert.equal(listed[0]!.balanced, true, "and it balances too — same blind spot, different blocker");

  const fresh = remittanceItems(await buildTodayQueue(services, 50, daysLater(1)));
  assert.equal(fresh[0]!.urgent, false);
  const aged = remittanceItems(await buildTodayQueue(services, 50, daysLater(3)));
  assert.equal(aged[0]!.urgent, true);
});

/**
 * ── M12 × M13: THE THIRD BLOCKER ON THE SAME CLOCK ─────────────────────────────────────────────
 *
 * A provider-level recoupment is the newest reason to hold, and it has the same shape as the other
 * two: the advice BALANCES — the payer's arithmetic is perfect — and what is unknown is whose claim
 * the money came out of. It has to inherit the clock rather than grow one of its own, or M12
 * reintroduces exactly the blind spot M13 closed.
 *
 * The PLB is injected into an 835 the mock clearinghouse produced, with BPR02 reduced to match, so
 * the hold comes off real parsed X12 through the production `parse835` and NOT from the arithmetic
 * failing.
 */
async function eraWithRecoupment(memberId: string, amountDollars: number, reference: string): Promise<string> {
  const raw = await era(memberId);
  const total = Number.parseFloat(/BPR\*I\*([\d.]+)\*/.exec(raw)![1]!);
  return raw
    .replace(/BPR\*I\*[\d.]+\*/, `BPR*I*${(total - amountDollars).toFixed(2)}*`)
    .replace("~SE*", `~PLB*1234567893*20261231*WO>${reference}*${amountDollars.toFixed(2)}~SE*`);
}

async function withRecoupmentHold(): Promise<{ services: Services; remittanceId: string }> {
  const services = buildServices({ inMemory: true });
  await services.remittance.recordExpectation(submitted("ABC12345"));
  const views = await services.remittance.ingestArtifact(
    await eraWithRecoupment("ABC12345", 500, "MRM-HELD1"),
    { resolution: "source-credential", vendor: "mock", artifactId: "file-plb", expectedPayeeId: null },
    RECEIVED
  );
  assert.equal(views.length, 1, "the fixture is one advice");
  return { services, remittanceId: views[0]!.remittance.id };
}

test("a recoupment hold ages on the same clock — three blockers, one clock", async () => {
  const { services } = await withRecoupmentHold();

  const listed = await services.remittance.list({ needsAttention: true }, daysLater(3));
  assert.equal(listed[0]!.status, "held");
  assert.match(String(listed[0]!.holdReason), /provider-level adjustments/);
  assert.equal(
    listed[0]!.balanced,
    true,
    "the payer's file adds up perfectly — what is unknown is which claim the $500 came out of"
  );

  const fresh = remittanceItems(await buildTodayQueue(services, 50, daysLater(1)));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.urgent, false, "a recoupment from yesterday is work, not yet an emergency");

  const aged = remittanceItems(await buildTodayQueue(services, 50, daysLater(3)));
  assert.equal(aged[0]!.urgent, true, "at the review threshold it is urgent, exactly as the other two holds are");
  assert.equal(
    aged[0]!.dueDate,
    calendarDay(new Date(RECEIVED.getTime() + 3 * DAY_MS), "UTC"),
    "and it inherits the clock rather than carrying one of its own"
  );
});

test("a recoupment hold is counted in the held total the money monitor reads", async () => {
  const { services } = await withRecoupmentHold();

  const summary = await services.remittance.heldSummary();
  assert.equal(summary.count, 1);
  assert.equal(summary.oldestReceivedAt, RECEIVED.toISOString());
  assert.equal(
    summary.totalCents,
    10_000,
    "the cash sitting unposted is the BPR total — $600 paid less the $500 the payer took back"
  );
});

test("no amount of ageing posts a RECOUPMENT hold either, and the claim stays paid-or-not on its own", async () => {
  const { services, remittanceId } = await withRecoupmentHold();

  for (const day of [4, 30, 365]) {
    await buildTodayQueue(services, 50, daysLater(day));
    const view = await services.remittance.get(remittanceId, daysLater(day));
    assert.equal(view!.remittance.status, "held", `still held after ${day} days — only a person may release it`);
    // The recouped amount is recorded and never applied to anything by the passage of time.
    assert.equal(view!.remittance.providerAdjustments[0]!.amount, cents(500));
  }
});

test("releasing a held remittance clears it from the aged queue and from the held total", async () => {
  const { services, remittanceId } = await withHeldRemittance(COB_MEMBER);

  const before = await services.remittance.heldSummary();
  assert.equal(before.count, 1);
  assert.equal(before.totalCents, 60_000, "the cash the payer actually sent, which is what is sitting unposted");
  assert.equal(before.oldestReceivedAt, RECEIVED.toISOString());

  // A coordination hold is released by a structured coverage answer since 0034 — never a sentence.
  const [cob] = await services.remittance.listCoordinationCases();
  await services.remittance.confirmCoverage(
    cob!.id,
    { outcome: "other-coverage", source: "patient", confirmedOn: daysLater(4).toISOString().slice(0, 10), secondary: { payerName: "Guardian Dental", memberId: "GD-1" } },
    "Practice Owner",
    daysLater(4)
  );
  await services.remittance.release(remittanceId, "Practice Owner", "confirmed against the paper EOB", daysLater(4));

  const after = await services.remittance.heldSummary();
  assert.deepEqual(
    after,
    { count: 0, oldestReceivedAt: null, totalCents: 0 },
    "released money is not held money — the clock stops when the person acts, and only then"
  );

  const aged = remittanceItems(await buildTodayQueue(services, 50, daysLater(9)));
  assert.equal(
    aged.filter((i) => i.urgent).length,
    0,
    "nine days on, nothing is urgent: the item aged out because it was WORKED, not because it expired"
  );
});

/**
 * ── THE PROPERTY THAT MUST NOT BE TRUE ─────────────────────────────────────────────────────────
 * Ageing raises attention. It must never release anything. If a future change ever made a hold post
 * itself after the review window, "when uncertain, hold" would silently become "when uncertain, wait
 * three days and post anyway" — which is worse than never having held it, because the delay looks
 * like diligence.
 */
test("no amount of ageing posts a held remittance by itself", async () => {
  const { services, remittanceId } = await withHeldRemittance(COB_MEMBER);

  for (const day of [4, 30, 365]) {
    await buildTodayQueue(services, 50, daysLater(day));
    const view = await services.remittance.get(remittanceId, daysLater(day));
    assert.equal(view!.remittance.status, "held", `still held after ${day} days — only a person may release it`);
  }
  assert.equal((await services.remittance.heldSummary()).count, 1);
});

// ── B. Abandoned ERA files reach a human ────────────────────────────────────────────────

/**
 * A retrieval that keeps failing until the retries run out. Driven through the real
 * `EraIngestService` failure path rather than by writing `deadLettered: true` into a row, so the
 * test would notice if the dead-letter rule itself stopped firing.
 */
async function withAbandonedEra(attempts: number): Promise<Services> {
  const services = buildServices({ inMemory: true });

  /**
   * The worker writes to `services.eraArtifacts`, and the queue reads through
   * `services.remittance.deadLetteredArtifacts()`. Nothing here connects the two — the composition
   * root does, and that is the point. If those were ever wired to different instances this test
   * would find an empty queue rather than quietly passing against a store nobody wrote to.
   */
  const artifacts = services.eraArtifacts;
  const sources = new InMemoryEraSourceRepository();
  const source = await sources.upsert({
    practiceId: "practice-1",
    vendor: "mock",
    credential: "test_credential",
    payeeNpi: null,
    cursor: null,
    enabled: true,
  });

  /**
   * A RETRYABLE retrieval failure, staged deliberately.
   *
   * An id the mock has never heard of fails NON-retryably and dead-letters on the first attempt,
   * which would exercise "permanent failure" and prove nothing about retry exhaustion — the case
   * this test is named for. A timing-out clearinghouse is the realistic shape and the one that walks
   * the artifact all the way to its last attempt.
   */
  const adapter = new MockEdiAdapter();
  adapter.stageRemittanceArtifact("file-lost-1", "", {
    failure: { code: "timeout", message: "the clearinghouse did not answer in time", retryable: true },
  });

  const era = new EraIngestService(adapter, sources, artifacts, services.remittance, createLogger(() => {}));

  await artifacts.discover({
    practiceId: "practice-1",
    sourceId: source.id,
    fileExecutionId: "file-lost-1",
    transactionId: null,
    processedAt: null,
  });
  // Re-read the row each pass so the attempt count is the ledger's, not this loop's.
  for (let i = 0; i < attempts; i++) {
    await era.ingestArtifact(source, (await artifacts.get("file-lost-1"))!, RECEIVED);
  }
  return services;
}

test("an ERA file abandoned after its last retry appears on the board", async () => {
  const services = await withAbandonedEra(5);

  const queue = await buildTodayQueue(services, 50, daysLater(1));
  const lost = queue.items.filter((i) => i.kind === "era");

  assert.equal(lost.length, 1, "a payer's payment file that nothing will retry again must reach a person");
  assert.match(lost[0]!.title, /file-lost-1/, "named by the clearinghouse handle, which is what a support ticket quotes");
  assert.match(lost[0]!.subtitle, /attempt/i, "with how many times we tried");
  assert.equal(lost[0]!.urgent, true, "urgent on arrival: the retries are already gone, there is nothing left to wait for");
  assert.equal(queue.counts.era, 1);
});

test("an artifact still being retried does NOT appear — the queue means abandoned, not in progress", async () => {
  const services = await withAbandonedEra(1);

  const queue = await buildTodayQueue(services, 50, daysLater(1));
  assert.equal(
    queue.items.filter((i) => i.kind === "era").length,
    0,
    "one failed attempt is work in progress; showing it would train staff to ignore the category"
  );
});

/**
 * The amount is zero because the file was never parsed, and that is a deliberate refusal rather than
 * an oversight. Ranking breaks ties toward money, so inventing a figure here would silently reorder
 * items whose amounts are real.
 */
test("an abandoned file claims no amount it cannot support", async () => {
  const services = await withAbandonedEra(5);

  const [lost] = (await buildTodayQueue(services, 50, daysLater(1))).items.filter((i) => i.kind === "era");
  assert.equal(lost!.amount, 0, "the file was never read; its value is genuinely unknown and stays unstated");
  assert.match(lost!.action, /upload|by hand|clearinghouse/i, "but what to DO about it is stated");
});
