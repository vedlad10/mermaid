/**
 * A held advice can be REJECTED — and a duplicate or a test file can no longer be released.
 *
 * ── WHAT STAGING HELD ──────────────────────────────────────────────────────────────────────────
 * Claim MRM-BDEDD701FE6B, Cigna, payer claim control number 333273831, $799.99:
 *
 *   EFT227219236  2026-08-28  posted (released by a person)
 *   EFT396527421  2026-08-30  held — "forwarded to another plan", nothing about a duplicate
 *   EFT860280126  2026-08-31  held — the same
 *
 * The same adjudication, delivered three times under three EFT traces. The duplicate gate existed by
 * then but ran only at ingest, and both held copies had been ingested before it — so both still read
 * "Review and release", `release()` never asked again, and releasing either would have posted
 * $799.99 a second time. Nor was there any other way out: a held advice could only leave the pile by
 * being posted.
 *
 * Every test below drives the real service with real 835 text through `ingestRaw` — the path an
 * upload and an ERA both take — and reads money movement off a real outbox, because "nothing was
 * posted" is only a claim until the events that post things are shown not to exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox, type ClaimSubmittedBody } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { createLogger, createMetrics } from "@mermaid/observability";
import {
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceActionRefusedError,
  RemittanceService,
  RemittanceUnavailableError,
} from "../index.ts";

const silent = createLogger(() => {});
const NOW = new Date("2026-09-10T12:00:00Z");

interface FileSpec {
  trace: string;
  date: string;
  icn: string;
  paid: number;
  charged?: number;
  /** CLP02. `1` paid as primary (posts); `19` forwarded to another plan (held for coordination). */
  status?: string;
  usage?: "T" | "P";
  payer?: string;
  claim?: string;
}

/** A small, balanced, single-claim 835. Charge = paid + a CO-45 write-off, on one line. */
function file835(f: FileSpec): string {
  const payer = f.payer ?? "Cigna Dental";
  const charged = f.charged ?? 1425;
  const d8 = f.date.replaceAll("-", "");
  const writeOff = (charged - f.paid).toFixed(2);
  return (
    [
      `ISA*00*          *00*          *ZZ*${payer.padEnd(15).slice(0, 15)}*ZZ*CLINIC         *${d8.slice(2)}*0000*^*00501*000000001*0*${f.usage ?? "P"}*:`,
      `GS*HP*${payer}*CLINIC*${d8}*0000*1*X*005010X221A1`,
      "ST*835*0001",
      `BPR*I*${f.paid.toFixed(2)}*C*ACH************${d8}`,
      `TRN*1*${f.trace}*${payer.slice(0, 10)}`,
      `N1*PR*${payer}`,
      "N1*PE*MERMAID DEMO DENTAL",
      `CLP*${f.claim ?? "MRM-BDEDD701FE6B"}*${f.status ?? "1"}*${charged.toFixed(2)}*${f.paid.toFixed(2)}*0.00*CI*${f.icn}`,
      "NM1*QC*1*Demo*Kira****MI*DEMO0123",
      `SVC*AD:D2750*${charged.toFixed(2)}*${f.paid.toFixed(2)}**1`,
      `CAS*CO*45*${writeOff}`,
      "SE*10*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~"
  );
}

/**
 * The claim the practice filed. `remittance.posted` — the event that moves money into the claim and
 * the ledger — is published only for a posting matched to a claim the practice filed, so a test that
 * wants to SEE money move (or prove it did not) has to have filed the claim first.
 */
const filed: ClaimSubmittedBody = {
  claimId: "claim-bdedd701",
  verificationId: "ver-bdedd701",
  submittedAt: "2026-08-20T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Kira", lastName: "Demo", dateOfBirth: "1990-04-12", memberId: "DEMO0123" },
  payerId: "cigna-dental",
  payerName: "Cigna Dental",
  patientControlNumber: "MRM-BDEDD701FE6B",
  payerControlNumber: "556677889",
  totalFee: cents(1425),
  expectedInsurancePays: cents(799.99),
  serviceDate: "2026-08-19",
} as ClaimSubmittedBody;

async function wired(testInterchanges: "accept" | "refuse" = "accept") {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const service = new RemittanceService(
    repo,
    new InMemoryExpectationRepository(),
    new MockEdiAdapter(),
    bus,
    null,
    null,
    testInterchanges
  );
  await service.recordExpectation(filed);
  /** Every `remittance.posted` event — the ONLY thing that moves money into claims and the ledger. */
  const postedEvents = () => bus.all().filter((e) => e.type === "remittance.posted");
  return { bus, repo, service, postedEvents };
}

/** Assert a release/reject is refused with a specific code, never an upstream-looking failure. */
async function refused(work: Promise<unknown>, code: string): Promise<RemittanceUnavailableError> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof RemittanceUnavailableError, `expected a refusal, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected refusal "${code}", but it succeeded`);
}

const original = { trace: "EFT227219236", date: "2026-08-28", icn: "333273831", paid: 799.99 };

/**
 * A status-19 advice is a coordination hold, and since 0034 it is released by a structured
 * coverage answer, never by a sentence. Tests that exercise something else about such an advice
 * answer the coverage question first, exactly as an operator would.
 */
async function confirmNoOtherCoverage(service: RemittanceService): Promise<void> {
  for (const c of await service.listCoordinationCases()) {
    if (c.coverageStatus !== "unconfirmed") continue;
    await service.confirmCoverage(c.id, { outcome: "no-other-coverage", source: "payer-portal", confirmedOn: "2026-09-10" }, "biller@clinic", NOW);
  }
}

// ── The parser: ISA15 ──────────────────────────────────────────────────────────────────────────

test("the parser reads ISA15, the sender's own statement of whether the money is real", () => {
  const edi = new MockEdiAdapter();
  const t = edi.parseRemittance(file835({ ...original, usage: "T" }));
  const p = edi.parseRemittance(file835({ ...original, usage: "P" }));
  assert.equal(t.ok && t.data!.usageIndicator, "T");
  assert.equal(p.ok && p.data!.usageIndicator, "P");

  // No envelope at all: the sender said nothing, which is NOT the same as "production".
  const bare = file835(original).split("~").filter((s) => !/^(ISA|GS|GE|IEA)\*/.test(s)).join("~");
  const none = edi.parseRemittance(bare);
  assert.equal(none.ok && none.data!.usageIndicator, null);
});

// ── Duplicate adjudication ─────────────────────────────────────────────────────────────────────

test("the same adjudication under a NEW trace and date is held, not posted", async () => {
  const { service, postedEvents } = await wired();
  const first = await service.ingestRaw(file835(original), NOW);
  assert.equal(first.remittance.status, "posted");
  assert.equal(postedEvents().length, 1);

  const again = await service.ingestRaw(file835({ ...original, trace: "EFT396527421", date: "2026-08-30" }), NOW);
  assert.equal(again.remittance.status, "held", "a different EFT trace does not make it a different payment");
  assert.match(again.remittance.holdReason ?? "", /claim control number 333273831/);
  assert.match(again.remittance.holdReason ?? "", /EFT227219236/);
  assert.equal(postedEvents().length, 1, "and nothing about it reached the claim or the ledger");
});

test("releasing it is REFUSED — no reason overrides money already on the books", async () => {
  const { service, postedEvents } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const again = await service.ingestRaw(file835({ ...original, trace: "EFT396527421", date: "2026-08-30" }), NOW);

  const err = await refused(
    service.release(again.remittance.id, "biller@clinic", "Looks fine to me", NOW),
    "duplicate-adjudication"
  );
  assert.match(err.message, /reject it instead/);
  assert.equal(postedEvents().length, 1);
});

test("a DIFFERENT amount under the same claim control number is new money, not a copy", async () => {
  /**
   * Payers pay a won appeal as a supplemental payment under the SAME claim control number, with no
   * reversal (see tests/vertical-award-settlement.test.ts). Same identifier, different content,
   * genuinely new money: it must not be treated as a re-delivery. Only an IDENTICAL adjudication
   * under the same identifier is.
   */
  const { service, postedEvents } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const supplemental = await service.ingestRaw(
    file835({ ...original, trace: "EFT500000001", date: "2026-09-02", paid: 325 }),
    NOW
  );
  assert.doesNotMatch(supplemental.remittance.holdReason ?? "", /same adjudication delivered again/);
  assert.equal(supplemental.remittance.status, "posted");
  assert.equal(postedEvents().length, 2);
});

test("a legitimate SEPARATE payment on the same claim still posts", async () => {
  // A different claim control number and a different amount: a second adjudication — an appeal
  // recovery, a supplemental payment. Nothing about it is a copy.
  const { service, postedEvents } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const separate = await service.ingestRaw(
    file835({ trace: "EFT600000001", date: "2026-09-05", icn: "444000111", paid: 125 }),
    NOW
  );
  assert.equal(separate.remittance.status, "posted", separate.remittance.holdReason ?? "");
  assert.equal(postedEvents().length, 2);
});

test("another payer's claim control number is not this payer's, even when the digits match", async () => {
  // CLP07 is the PAYER's identifier; two payers numbering claims independently can collide.
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const other = await service.ingestRaw(
    file835({ trace: "EFT700000001", date: "2026-09-05", icn: "333273831", paid: 60, payer: "Delta Dental" }),
    NOW
  );
  assert.doesNotMatch(other.remittance.holdReason ?? "", /claim control number/);
});

test("THE STAGING SHAPE: a copy held BEFORE its twin posted is refused at release anyway", async () => {
  /**
   * Reproduces R2/R3 exactly. The copy arrives first and is held for coordination alone — there is
   * nothing to be a duplicate OF yet, so its stored hold reason never mentions one. Then the other
   * copy is released and posted. The first copy's stored reason is now stale, and before this change
   * it released cleanly: `release()` trusted the findings from ingest.
   */
  const { service, postedEvents } = await wired();
  const early = await service.ingestRaw(
    file835({ ...original, trace: "EFT396527421", date: "2026-08-30", status: "19" }),
    NOW
  );
  assert.equal(early.remittance.status, "held");
  assert.doesNotMatch(early.remittance.holdReason ?? "", /duplicate|control number/i, "held for coordination only");

  const twin = await service.ingestRaw(file835({ ...original, status: "19" }), NOW);
  // With only a HELD twin, release is a person's call — once coverage is answered: the first wins…
  await confirmNoOtherCoverage(service);
  const released = await service.release(twin.remittance.id, "biller@clinic", "Matches the 28 Aug deposit", NOW);
  assert.equal(released.remittance.status, "posted");
  assert.equal(postedEvents().length, 1);

  // …and the other copy — whose stored reason says nothing about a duplicate — can no longer follow.
  await refused(service.release(early.remittance.id, "biller@clinic", "Review and release", NOW), "duplicate-adjudication");
  assert.equal(postedEvents().length, 1, "$799.99 posted once, not twice");
});

// ── Reject ─────────────────────────────────────────────────────────────────────────────────────

test("rejecting a duplicate posts nothing, names its twin, and keeps the record", async () => {
  const { service, bus, repo, postedEvents } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);
  const eventsBefore = bus.all().length;

  const view = await service.reject(
    copy.remittance.id,
    "biller@clinic",
    "Same adjudication as the 28 Aug advice; one deposit",
    "duplicate",
    NOW
  );

  assert.equal(view.remittance.status, "rejected");
  assert.equal(view.remittance.rejection?.kind, "duplicate");
  assert.equal(view.remittance.rejection?.duplicateOfTrace, "EFT227219236");
  assert.equal(view.remittance.rejection?.rejectedBy, "biller@clinic");
  assert.equal(bus.all().length, eventsBefore, "not one event of any kind — nothing downstream can move");
  assert.equal(postedEvents().length, 1);

  // The evidence survives: the row, its trace and the payer's own file.
  const stored = await repo.getById(copy.remittance.id);
  assert.equal(stored?.traceNumber, "EFT860280126");
  assert.ok(stored?.raw835?.includes("CLP*MRM-BDEDD701FE6B"));
  assert.match(stored!.audit.at(-1)!.message, /Rejected as a duplicate by biller@clinic: Same adjudication/);
});

test("a rejected advice carries no money on any surface", async () => {
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);
  const reconciledBefore = await service.reconcileAll();
  const recoveryBefore = await service.recoveryQueue(NOW);

  const view = await service.reject(copy.remittance.id, "biller@clinic", "Duplicate of EFT227219236", "duplicate", NOW);

  assert.equal(view.totalRecoverable, 0);
  assert.equal(view.totalWithOtherPayers, 0);
  assert.equal(view.canPost, false);
  assert.match(view.recommendedAction, /Nothing was posted/);
  assert.deepEqual(await service.reconcileAll(), reconciledBefore, "reconciliation reads posted money only");
  assert.deepEqual(await service.recoveryQueue(NOW), recoveryBefore);
  const attention = await service.list({ needsAttention: true }, NOW);
  assert.ok(!attention.some((r) => r.id === copy.remittance.id), "off every worklist");
});

test("a rejected advice can never be released, and rejecting twice is one decision", async () => {
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);

  const first = await service.reject(copy.remittance.id, "a@clinic", "Duplicate", "duplicate", NOW);
  const second = await service.reject(copy.remittance.id, "b@clinic", "Different reason", "test-file", new Date(NOW.getTime() + 60_000));
  assert.deepEqual(second.remittance.rejection, first.remittance.rejection, "the first decision stands");
  await refused(service.release(copy.remittance.id, "a@clinic", "Changed my mind", NOW), "rejected");
});

test("POSTED money cannot be rejected — it is retracted by a reversal, not relabelled", async () => {
  const { service, postedEvents } = await wired();
  const posted = await service.ingestRaw(file835(original), NOW);
  await refused(service.reject(posted.remittance.id, "a@clinic", "Oops", "duplicate", NOW), "already-posted");
  assert.equal((await service.get(posted.remittance.id, NOW))!.remittance.status, "posted");
  assert.equal(postedEvents().length, 1);
});

test("a rejection needs a person, a reason, and what the advice actually was", async () => {
  const { service } = await wired();
  const held = await service.ingestRaw(file835({ ...original, status: "19" }), NOW);
  await refused(service.reject(held.remittance.id, "a@clinic", "   ", "duplicate", NOW), "validation_error");
  await refused(service.reject(held.remittance.id, "  ", "Duplicate", "duplicate", NOW), "validation_error");
  await refused(
    service.reject(held.remittance.id, "a@clinic", "Duplicate", "whatever" as "duplicate", NOW),
    "validation_error"
  );
  assert.equal((await service.get(held.remittance.id, NOW))!.remittance.status, "held");
});

// ── Test interchanges (ISA15 = T) ──────────────────────────────────────────────────────────────

test("a TEST 835 on a live deployment is held, cannot be released, and is rejected as a test file", async () => {
  const { service, postedEvents } = await wired("refuse");
  const testFile = await service.ingestRaw(file835({ ...original, usage: "T" }), NOW);
  assert.equal(testFile.remittance.status, "held");
  assert.equal(testFile.remittance.usageIndicator, "T");
  assert.match(testFile.remittance.holdReason ?? "", /TEST file \(ISA15 = T\)/);

  await refused(service.release(testFile.remittance.id, "a@clinic", "Reconciled", NOW), "test-interchange");
  const rejected = await service.reject(testFile.remittance.id, "a@clinic", "Clearinghouse sandbox file", "test-file", NOW);
  assert.equal(rejected.remittance.status, "rejected");
  assert.equal(rejected.remittance.rejection?.kind, "test-file");
  assert.equal(postedEvents().length, 0, "a test file never reached the books");
});

test("a PRODUCTION 835 on a live deployment posts exactly as before", async () => {
  const { service, postedEvents } = await wired("refuse");
  const real = await service.ingestRaw(file835({ ...original, usage: "P" }), NOW);
  assert.equal(real.remittance.status, "posted");
  assert.equal(postedEvents().length, 1);
});

test("a demonstration deployment still posts test files — every file it sees is one", async () => {
  // The mock clearinghouse and vendor test modes emit ISA15 = T by construction. Refusing them there
  // would stop the demo posting anything, which protects nobody.
  const { service, postedEvents } = await wired("accept");
  const demo = await service.ingestRaw(file835({ ...original, usage: "T" }), NOW);
  assert.equal(demo.remittance.status, "posted");
  assert.equal(postedEvents().length, 1);
});

// ── Readiness reads the held pile ──────────────────────────────────────────────────────────────

test("the held pile — readiness's input — shrinks only when the item is correctly disposed of", async () => {
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);
  assert.equal((await service.heldSummary()).count, 1);

  // A refused release changes nothing: the copy is still held, still counted, still flagged.
  await refused(service.release(copy.remittance.id, "a@clinic", "Clear the board", NOW), "duplicate-adjudication");
  assert.deepEqual(await service.heldSummary(), { count: 1, oldestReceivedAt: NOW.toISOString(), totalCents: 79999 });

  // Rejecting it is the disposal, and the pile is empty.
  await service.reject(copy.remittance.id, "a@clinic", "Duplicate of EFT227219236", "duplicate", NOW);
  assert.deepEqual(await service.heldSummary(), { count: 0, oldestReceivedAt: null, totalCents: 0 });
});

// ── What the operator is SHOWN ─────────────────────────────────────────────────────────────────

test("a held duplicate is shown as one: release is not offered, reject is the action", async () => {
  // The staging shape again: the copy's stored hold reason says nothing about a duplicate, so a view
  // built only from ingest-time findings offered "Review and release" on a button bound to fail.
  const { service } = await wired();
  const early = await service.ingestRaw(file835({ ...original, trace: "EFT396527421", date: "2026-08-30", status: "19" }), NOW);
  const twin = await service.ingestRaw(file835({ ...original, status: "19" }), NOW);
  await confirmNoOtherCoverage(service);
  await service.release(twin.remittance.id, "biller@clinic", "Matches the 28 Aug deposit", NOW);

  const view = (await service.get(early.remittance.id, NOW))!;
  assert.equal(view.canPost, false, "the release button must not be offered");
  assert.equal(view.releaseBlocked?.code, "duplicate-adjudication");
  assert.equal(view.releaseBlocked?.rejectAs, "duplicate");
  assert.match(view.recommendedAction, /^Do not release — .*EFT227219236.* Reject it as a duplicate; nothing will be posted\.$/);
  assert.doesNotMatch(view.recommendedAction, /Review and release/);

  // The list — which the Today board and the Money screen are drawn from — says the same.
  const row = (await service.list(undefined, NOW)).find((r) => r.id === early.remittance.id)!;
  assert.equal(row.canPost, false);
  assert.equal(row.releaseBlocked?.rejectAs, "duplicate");
  assert.match(row.recommendedAction, /^Do not release/);
});

test("an ordinary held advice still offers review and release", async () => {
  // Held for a reason that is neither a duplicate nor coordination: the advice's charge disagrees
  // with what the practice filed. Nothing about it is a copy, and nobody's coverage is in question.
  const { service } = await wired();
  const held = await service.ingestRaw(file835({ ...original, charged: 1500 }), NOW);
  assert.equal(held.remittance.status, "held");
  const view = (await service.get(held.remittance.id, NOW))!;
  assert.equal(view.releaseBlocked, null);
  assert.deepEqual(view.coordination, []);
  assert.equal(view.canPost, true);
  assert.match(view.recommendedAction, /^Review and release/);
});

test("R1's shape asks for a coverage answer first, then offers review and release", async () => {
  // Forwarded to another plan, $0 assigned, no twin anywhere. Not a copy — a question.
  const { service } = await wired();
  const held = await service.ingestRaw(file835({ ...original, status: "19" }), NOW);
  const asked = (await service.get(held.remittance.id, NOW))!;
  assert.equal(asked.canPost, false, "no release until the coverage question is answered");
  assert.equal(asked.coordination[0]?.coverageStatus, "unconfirmed");
  assert.equal(asked.coordination[0]?.workStatus, "not-needed", "$0 was assigned, so there is nothing to file");
  assert.match(asked.recommendedAction, /^Confirm the patient's other coverage before release — Cigna Dental forwarded claim MRM-BDEDD701FE6B, naming no other plan\./);

  await confirmNoOtherCoverage(service);
  const answered = (await service.get(held.remittance.id, NOW))!;
  assert.equal(answered.canPost, true);
  assert.match(answered.recommendedAction, /^Review and release/);
});

test("a held test file on a live deployment is shown as a test file", async () => {
  const { service } = await wired("refuse");
  const held = await service.ingestRaw(file835({ ...original, usage: "T" }), NOW);
  const view = (await service.get(held.remittance.id, NOW))!;
  assert.equal(view.releaseBlocked?.rejectAs, "test-file");
  assert.equal(view.canPost, false);
  assert.match(view.recommendedAction, /Reject it as a test file/);
});

test("once rejected, nothing is left to block — the view states the decision", async () => {
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);
  await service.reject(copy.remittance.id, "biller@clinic", "Duplicate of EFT227219236", "duplicate", NOW);
  const view = (await service.get(copy.remittance.id, NOW))!;
  assert.equal(view.releaseBlocked, null);
  assert.match(view.recommendedAction, /^Rejected as a duplicate/);
});

test("a refusal reads as the decision it is — not as a retrieval failure", async () => {
  const { service } = await wired();
  await service.ingestRaw(file835(original), NOW);
  const copy = await service.ingestRaw(file835({ ...original, trace: "EFT860280126", date: "2026-08-31" }), NOW);

  const err = await refused(service.release(copy.remittance.id, "biller@clinic", "Review and release", NOW), "duplicate-adjudication");
  assert.ok(err instanceof RemittanceActionRefusedError, "a decision, typed as one");
  assert.ok(err instanceof RemittanceUnavailableError, "and still mapped by every existing handler");
  assert.doesNotMatch(err.message, /retrieval failed/);
  assert.match(err.message, /^The payer's claim control number 333273831/);

  const posted = (await service.list(undefined, NOW)).find((r) => r.status === "posted")!;
  const again = await refused(service.reject(posted.id, "biller@clinic", "Oops", "duplicate", NOW), "already-posted");
  assert.match(again.message, /^This remittance is already posted\./);
});
