/**
 * Remittance-service tests: the expectation ledger, idempotent posting, the money-safety hold, and
 * what gets published.
 *
 * The idempotency tests are the ones that matter most. A double-posted remittance corrupts the
 * ledger a practice bills patients and reports revenue from — and the clearinghouse re-serving an
 * ERA, the outbox re-delivering, and a user re-uploading a file are all *normal* traffic, not edge
 * cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import type { ClaimSubmittedBody } from "@mermaid/events";
import type { RemittanceRequestClaim } from "@mermaid/edi";
import {
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceService,
  RemittanceNotFoundError,
  RemittanceUnavailableError,
  buildRecoveryQueue,
} from "../index.ts";

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});

function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const expectations = new InMemoryExpectationRepository();
  const service = new RemittanceService(repo, expectations, new MockEdiAdapter(), bus);
  return { bus, repo, expectations, service };
}

const submitted = (overrides: Partial<ClaimSubmittedBody> = {}): ClaimSubmittedBody => ({
  claimId: "claim-1",
  verificationId: "ver-1",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: "MRM-000123",
  payerControlNumber: "556677889",
  totalFee: cents(1425),
  expectedInsurancePays: cents(800),
  serviceDate: "2026-07-27",
  ...overrides,
});

const remitClaim = (memberId: string, overrides: Partial<RemittanceRequestClaim> = {}): RemittanceRequestClaim => ({
  patientControlNumber: "MRM-000123",
  payerControlNumber: "556677889",
  patientFirstName: "Ada",
  patientLastName: "Alpha",
  memberId,
  lines: [
    { procedureCode: "D0120", charged: cents(65), quantity: 1 },
    { procedureCode: "D1110", charged: cents(110), quantity: 1 },
    { procedureCode: "D2750", charged: cents(1250), quantity: 1 },
  ],
  expectedInsurancePays: cents(800),
  ...overrides,
});

const fetchFor = (claims: RemittanceRequestClaim[]) => ({
  payerId: "delta-dental",
  payerName: "Delta Dental",
  payeeName: "MERMAID DEMO DENTAL",
  paymentDate: "2026-08-10",
  claims,
});

// ── The expectation ledger ────────────────────────────────────────────────────────────

test("claim.submitted records what the clinic was promised", async () => {
  const { service, expectations } = wired();
  await service.recordExpectation(submitted());

  const recorded = await expectations.getByControlNumber("MRM-000123");
  assert.equal(recorded!.claimId, "claim-1");
  assert.equal(recorded!.expectedInsurancePays, cents(800));
  assert.equal(recorded!.payerId, "delta-dental");
});

test("recording the same claim.submitted twice keeps one expectation", async () => {
  const { service, expectations } = wired();
  await service.recordExpectation(submitted());
  await service.recordExpectation(submitted());
  assert.equal(expectations.size, 1);
});

// ── Posting ───────────────────────────────────────────────────────────────────────────

test("a clean remittance posts and computes variance against the inherited estimate", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());

  const [view] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  assert.equal(view!.remittance.status, "posted");
  assert.equal(view!.remittance.balanced, true);
  assert.equal(view!.remittance.postings.length, 1);

  const posting = view!.remittance.postings[0]!;
  assert.equal(posting.claimId, "claim-1", "matched on the control number the payer echoed back");
  assert.equal(posting.variance!.expectedInsurancePays, cents(800));
  assert.equal(posting.variance!.actualPaid, posting.paidAmount);
  assert.ok(posting.variance!.contractualAdjustments > 0);
});

test("posting is idempotent — the same trace number never posts twice", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted());

  const [first] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);
  const [second] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  assert.equal(repo.size, 1, "a re-served ERA is normal traffic, not a second payment");
  assert.equal(first!.remittance.id, second!.remittance.id);
  assert.deepEqual(first!.remittance.audit, second!.remittance.audit, "the existing remittance is untouched");
});

test("re-uploading the same 835 file does not double-post it", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted());

  const adapter = new MockEdiAdapter();
  const fetched = await adapter.fetchRemittance(fetchFor([remitClaim("ABC12345")]));
  const raw = fetched.raw!;

  await service.ingestRaw(raw, NOW);
  await service.ingestRaw(raw, NOW);
  assert.equal(repo.size, 1);
});

test("the repository itself refuses a duplicate trace, even if the service guard were bypassed", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted());
  const [view] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  await assert.rejects(
    () => repo.save({ ...view!.remittance, id: "different-id" }),
    /already exists/
  );
});

/**
 * ── LOSING THE RACE TO THE UNIQUE KEY IS NORMAL TRAFFIC, NOT A FAILURE (B-5) ───────────────────
 *
 * `#ingest`'s `getByDedupeKey` check is check-then-act: two ingests of one payment can both read
 * "not seen yet" and both try to insert. The UNIQUE key decides, and that is the design — but the
 * loser used to receive a bare `Error`, which nothing could tell apart from a real fault. The
 * upload route turned it into a 500 and the ERA worker dead-lettered the artifact, reporting a
 * payer's file as abandoned when its money was already on the ledger.
 *
 * Simulated by blinding the pre-check ONCE, which is precisely the shape of the race: the loser's
 * check runs before the winner commits and sees nothing, and its recovery read runs after and sees
 * the row. Blinding it permanently would model something that cannot happen — and the service
 * rightly refuses to invent a result in that case rather than reporting a success it cannot back.
 */
function blindTheDedupeCheckOnce(repo: InMemoryRemittanceRepository): void {
  const real = repo.getByDedupeKey.bind(repo);
  let used = false;
  repo.getByDedupeKey = async (key: string) => {
    if (used) return real(key);
    used = true;
    return null;
  };
}

test("an ingest that loses the dedupe race returns the winner's remittance instead of throwing", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted());

  const first = await service.ingestRaw(await rawFor([remitClaim("ABC12345")]), NOW);
  blindTheDedupeCheckOnce(repo);
  const second = await service.ingestRaw(await rawFor([remitClaim("ABC12345")]), NOW);

  assert.equal(
    second.remittance.id,
    first.remittance.id,
    "the loser must be handed the winner's row, exactly as an ordinary redelivery is"
  );
  assert.equal(repo.size, 1, "one payment, one remittance");
});

test("the loser publishes nothing — one payment posts once", async () => {
  const { service, repo, bus } = wired();
  await service.recordExpectation(submitted());

  await service.ingestRaw(await rawFor([remitClaim("ABC12345")]), NOW);
  const postedAfterFirst = bus.ofType("remittance.posted").length;
  assert.ok(postedAfterFirst > 0, "the winner really did post, so the count below means something");

  blindTheDedupeCheckOnce(repo);
  await service.ingestRaw(await rawFor([remitClaim("ABC12345")]), NOW);

  assert.equal(
    bus.ofType("remittance.posted").length,
    postedAfterFirst,
    "re-posting the winner's money would double-count it on every downstream report"
  );
});

// ── The money-safety hold ─────────────────────────────────────────────────────────────

test("an unbalanced remittance is HELD, not posted, and says why", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());

  const adapter = new MockEdiAdapter();
  const fetched = await adapter.fetchRemittance(fetchFor([remitClaim("ABC12345")]));
  const tampered = fetched.raw!.replace(/CAS\*PR\*2\*([\d.]+)\*/, "CAS*PR*2*1.00*");

  const view = await service.ingestRaw(tampered, NOW);

  assert.equal(view.remittance.status, "held");
  assert.equal(view.remittance.balanced, false);
  assert.ok(view.remittance.holdReason);
  assert.equal(view.canPost, false, "arithmetic is never overridable");
  assert.match(view.recommendedAction, /Do not post/);
  assert.equal(bus.ofType("remittance.posted").length, 0);
});

/**
 * ── M12: A RECOUPMENT HOLDS, THROUGH THE REAL PARSER ───────────────────────────────────────────
 *
 * The PLB is injected into an 835 the mock adapter actually produced, and the BPR total is reduced
 * by the same amount so the file BALANCES. That matters: an unbalanced advice already held before
 * M12, so a test that let the arithmetic break would prove nothing about the recoupment rule.
 */
function withRecoupment(raw: string, amountDollars: number, reference: string | null): string {
  const total = Number.parseFloat(/BPR\*I\*([\d.]+)\*/.exec(raw)![1]!);
  /**
   * The separator must be the one this payload's own ISA16 declares — the mock writes `:`.
   * This wrote `>` and parsed anyway only because the parser used to guess from a fixed set instead
   * of reading the declaration; the fixture was quietly malformed, and it stopped being readable the
   * moment the parser started believing the header. See `x12-277ca-real-stedi.test.ts` for the live
   * payload that forced that change.
   */
  const plb03 = reference ? `WO:${reference}` : "WO";
  return raw
    .replace(/BPR\*I\*[\d.]+\*/, `BPR*I*${(total - amountDollars).toFixed(2)}*`)
    .replace("~SE*", `~PLB*1234567893*20261231*${plb03}*${amountDollars.toFixed(2)}~SE*`);
}

async function rawFor(claims = [remitClaim("ABC12345")]) {
  const fetched = await new MockEdiAdapter().fetchRemittance(fetchFor(claims));
  return fetched.raw!;
}

test("M12: a balanced advice carrying a recoupment over the threshold is HELD, naming the amount", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());

  const view = await service.ingestRaw(withRecoupment(await rawFor(), 500, "MRM-000123"), NOW);

  assert.equal(view.remittance.balanced, true, "the arithmetic is fine — this holds on the recoupment alone");
  assert.equal(view.remittance.status, "held");
  assert.match(view.remittance.holdReason!, /\$500\.00 in provider-level adjustments/);
  assert.match(view.remittance.holdReason!, /taken against claim MRM-000123/);
  assert.equal(bus.ofType("remittance.posted").length, 0, "nothing may post while the recoupment is unreviewed");
});

test("M12: the reason code and reference survive parse → advice → stored remittance", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());

  const view = await service.ingestRaw(withRecoupment(await rawFor(), 500, "MRM-000123"), NOW);

  const [plb] = view.remittance.providerAdjustments;
  assert.equal(plb!.reasonCode, "WO");
  assert.equal(plb!.referenceId, "MRM-000123");
  assert.equal(plb!.amount, cents(500));
});

test("M12: a recoupment naming a claim we never submitted is held as unattributed, not guessed at", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());

  const view = await service.ingestRaw(withRecoupment(await rawFor(), 500, "MRM-UNKNOWN"), NOW);

  assert.equal(view.remittance.status, "held");
  assert.match(view.remittance.holdReason!, /references MRM-UNKNOWN, which matches no claim we recorded submitting/);
  assert.doesNotMatch(view.remittance.holdReason!, /taken against claim/);
});

test("M12: interest below the threshold still posts — the gate must not fire on ordinary traffic", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());

  const view = await service.ingestRaw(withRecoupment(await rawFor(), 4.12, "MRM-000123"), NOW);

  assert.equal(view.remittance.status, "posted");
  assert.equal(view.remittance.holdReason, null);
  assert.equal(bus.ofType("remittance.posted").length, 1);
});

/**
 * ── THE NEGATIVE PROOF ─────────────────────────────────────────────────────────────────────────
 *
 * A hold defers a decision. It must not MAKE one. This asserts the four things M12 was explicitly
 * scoped never to do, against the same advice posted with and without a recoupment.
 */
test("M12: holding a recoupment reverses nothing, unposts nothing and re-statuses no claim", async () => {
  const { service: plain } = wired();
  await plain.recordExpectation(submitted());
  const posted = await plain.ingestRaw(await rawFor(), NOW);

  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  const held = await service.ingestRaw(withRecoupment(await rawFor(), 500, "MRM-000123"), NOW);

  assert.equal(posted.remittance.status, "posted");
  assert.equal(held.remittance.status, "held");

  // 1. No payment is unposted or reversed — the postings are computed identically either way.
  assert.equal(held.remittance.postings.length, posted.remittance.postings.length);
  assert.deepEqual(
    held.remittance.postings.map((p) => [p.claimId, p.paidAmount]),
    posted.remittance.postings.map((p) => [p.claimId, p.paidAmount]),
    "a recoupment must not alter what the payer paid on any claim"
  );

  // 2. No claim status is changed, because nothing is published at all while held.
  assert.equal(bus.ofType("remittance.posted").length, 0);
  assert.deepEqual(bus.ofType("variance.detected"), []);

  // 3. No automatic financial correction: the recouped money is recorded, not applied anywhere.
  assert.equal(held.remittance.providerAdjustments[0]!.amount, cents(500));

  // 4. The advice's own arithmetic is untouched — `balanced` still describes the payer's file.
  assert.equal(held.remittance.balanced, true);
});

test("M12: a held recoupment is releasable by a person, and posts only then", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  const held = await service.ingestRaw(withRecoupment(await rawFor(), 500, "MRM-000123"), NOW);
  assert.equal(held.remittance.status, "held");

  const released = await service.release(
    held.remittance.id,
    "manager@clinic",
    "Confirmed the takeback against the payer's remittance.",
    NOW
  );

  // Unlike an arithmetic failure, a recoupment IS overridable — a person can establish what it is.
  assert.equal(released.remittance.status, "posted");
  assert.equal(bus.ofType("remittance.posted").length, 1);
});

test("a held, unbalanced remittance cannot be released by a human either", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());
  const adapter = new MockEdiAdapter();
  const fetched = await adapter.fetchRemittance(fetchFor([remitClaim("ABC12345")]));
  const view = await service.ingestRaw(fetched.raw!.replace(/CAS\*PR\*2\*([\d.]+)\*/, "CAS*PR*2*1.00*"), NOW);

  await assert.rejects(
    () => service.release(view.remittance.id, "manager@clinic", "Checked the paper EOB.", NOW),
    /Arithmetic cannot be overridden/
  );
});

test("releasing requires both a name and a reason", async () => {
  const { service } = wired();
  const adapter = new MockEdiAdapter();
  const fetched = await adapter.fetchRemittance(fetchFor([remitClaim("ABC12345")]));
  // No expectation recorded → unmatched payment → posts anyway (a notice, not a blocker).
  const view = await service.ingestRaw(fetched.raw!, NOW);
  assert.equal(view.remittance.status, "posted");

  await assert.rejects(() => service.release(view.remittance.id, "", "reason", NOW), /releasing user is required/);
  await assert.rejects(() => service.release(view.remittance.id, "manager", "  ", NOW), /reason is required/);
});

test("an unmatched payment still posts, but is surfaced for identification", async () => {
  const { service, bus } = wired();
  // No expectation recorded for this control number.
  const [view] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  assert.equal(view!.remittance.status, "posted", "real cash must not be frozen out of the ledger");
  assert.equal(view!.unmatched.length, 1);
  assert.equal(view!.remittance.postings[0]!.claimId, null);
  assert.equal(view!.remittance.postings[0]!.variance, null, "no baseline means no honest comparison");
  assert.equal(bus.ofType("remittance.posted").length, 0, "we cannot tell Claims to settle a claim we cannot name");
  assert.match(view!.recommendedAction, /could not be matched/);
});

// ── Events ────────────────────────────────────────────────────────────────────────────

test("posting publishes remittance.posted with the full variance picture", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  const events = bus.ofType("remittance.posted");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload;
  assert.equal(payload.claimId, "claim-1");
  assert.equal(payload.expectedInsurancePays, cents(800));
  assert.equal(payload.variance, payload.paidAmount - payload.expectedInsurancePays);
  assert.ok(payload.contractualAdjustments > 0);
  assert.equal(payload.traceNumber, events[0]!.payload.traceNumber);
});

test("a clean payment settles the claim and raises NO variance alert", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  assert.equal(bus.ofType("remittance.posted")[0]!.payload.settled, true);
  assert.equal(bus.ofType("variance.detected").length, 0, "a contractual write-off is not news");
});

test("a recoverable denial raises variance.detected with its reason codes", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  // Member ID ending 77 → the crown is denied for a missing pre-authorization.
  await service.fetchAndIngest(fetchFor([remitClaim("MET30077")]), NOW);

  const posted = bus.ofType("remittance.posted")[0]!.payload;
  assert.equal(posted.settled, false, "money is still outstanding");
  assert.ok(posted.variance < 0);

  const detected = bus.ofType("variance.detected");
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.payload.claimId, "claim-1");
  assert.ok(detected[0]!.payload.recoverableAmount > 0);
  assert.equal(detected[0]!.payload.payerId, "delta-dental");
  assert.ok(detected[0]!.payload.reasons.some((r) => r.code === "197"));
  assert.match(detected[0]!.payload.summary, /corrected or appealed/);
});

test("a benefit-maximum shortfall is the patient's, so no variance alert is raised", async () => {
  const { service, bus } = wired();
  await service.recordExpectation(submitted());
  await service.fetchAndIngest(fetchFor([remitClaim("CIG20099")]), NOW);

  assert.equal(bus.ofType("variance.detected").length, 0, "the payer owes nothing further");
});

// ── Queries ───────────────────────────────────────────────────────────────────────────

test("the recovery queue lists only postings still holding recoverable money", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted());
  await service.recordExpectation(submitted({ claimId: "claim-2", patientControlNumber: "MRM-000456" }));

  await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);
  await service.fetchAndIngest(
    fetchFor([remitClaim("MET30077", { patientControlNumber: "MRM-000456", payerControlNumber: "556677890" })]),
    NOW
  );

  const queue = buildRecoveryQueue(await repo.list());
  assert.equal(queue.length, 1, "only the pre-auth denial is worth pursuing");
  assert.equal(queue[0]!.claimId, "claim-2");
  assert.ok(queue[0]!.recoverableAmount > 0);
  assert.ok(queue[0]!.explanation.length > 0);
});

test("the worklist is ranked, and filters to what needs attention", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());
  await service.recordExpectation(submitted({ claimId: "claim-2", patientControlNumber: "MRM-000456" }));

  await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);
  await service.fetchAndIngest(
    fetchFor([remitClaim("MET30077", { patientControlNumber: "MRM-000456", payerControlNumber: "556677890" })]),
    NOW
  );

  const all = await service.list(undefined, NOW);
  assert.equal(all.length, 2);
  assert.ok(all[0]!.totalRecoverable > 0, "the one with money outstanding ranks first");

  const attention = await service.list({ needsAttention: true }, NOW);
  assert.equal(attention.length, 1);
});

test("daily reconciliation balances what was received against what was posted", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());
  await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  const report = await service.reconcileAll();
  assert.equal(report.balanced, true, report.summary);
  assert.equal(report.drift, 0);
});

test("an unreadable payload fails as a retrieval error, not a silent no-op", async () => {
  const { service, repo } = wired();
  await assert.rejects(
    () => service.ingestRaw("ST*837*0001*005010X224A2~SE*2*0001~", NOW),
    (err: unknown) => {
      assert.ok(err instanceof RemittanceUnavailableError);
      assert.equal(err.code, "parse_error");
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(repo.size, 0);
});

test("an unknown remittance id raises RemittanceNotFoundError", async () => {
  const { service } = wired();
  assert.equal(await service.get("nope", NOW), null);
  await assert.rejects(() => service.release("nope", "manager", "reason", NOW), RemittanceNotFoundError);
});

test("the service works with no event bus wired at all", async () => {
  const service = new RemittanceService(
    new InMemoryRemittanceRepository(),
    new InMemoryExpectationRepository(),
    new MockEdiAdapter()
  );
  await service.recordExpectation(submitted());
  const [view] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);
  assert.equal(view!.remittance.status, "posted");
});

test("the repository isolates stored remittances from later caller mutation", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted());
  const [view] = await service.fetchAndIngest(fetchFor([remitClaim("ABC12345")]), NOW);

  view!.remittance.paymentTotal = cents(1);
  const fetched = await service.get(view!.remittance.id, NOW);
  assert.notEqual(fetched!.remittance.paymentTotal, cents(1));
});
