/**
 * The remittance idempotency key, when the payer did not give us one.
 *
 * ── THE DEFECT THESE PIN ───────────────────────────────────────────────────────────────────────
 * A TRN is situational in an 835, so trace-less remittances are legal and do arrive. Uniqueness was
 * enforced on `(practice_id, trace_number)` with `trace_number NOT NULL`, so every trace-less file
 * stored the empty string — and the SECOND one a practice ever received collided with the FIRST.
 * Two unrelated payments, one of them permanently un-ingestable.
 *
 * On the upload route that is a loud error in front of a person. On the ERA path it would be a
 * delivery that fails, retries five times, and lands in a clearinghouse error queue nobody watches.
 *
 * ── THE PROPERTY THAT MUST NOT BREAK WHILE FIXING IT ───────────────────────────────────────────
 * Deriving a key makes a trace-less file INGESTABLE. It must not make it POSTABLE. The safety gate
 * blocks on a missing trace number, and that blocker is correct — without a payer-issued trace
 * number there is nothing to quote back when a payment is disputed. So the middle tests here are
 * the load-bearing ones: the derived key must never leak into `traceNumber` and satisfy that gate.
 *
 * Raw 835s come from the adapter's public surface and are then edited, rather than from the codec
 * directly — `@mermaid/edi`'s exported API is this module's only permitted view of EDI
 * (docs/MODULE-BOUNDARIES.md), and a test that reached past it would be asserting against a
 * dependency the module is not allowed to have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import type { RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { InMemoryExpectationRepository, InMemoryRemittanceRepository, RemittanceService } from "../index.ts";

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});

function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const service = new RemittanceService(repo, new InMemoryExpectationRepository(), new MockEdiAdapter(), bus);
  return { repo, service };
}

/**
 * A service whose clearinghouse returns SEVERAL advices from ONE file — the batch shape a real ERA
 * delivery has, and the only path where several payments share a single `raw` payload.
 */
function batchWired(rawAdvices: string[]) {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const mock = new MockEdiAdapter();
  const advices = rawAdvices.map((r) => mock.parseRemittance(r).data!);

  class BatchAdapter extends MockEdiAdapter {
    override async fetchRemittance() {
      // One raw payload, several advices — exactly what `fetchAndIngest` then loops over.
      return { ok: true as const, data: advices, raw: rawAdvices.join(""), source: "mock" as const };
    }
  }

  return { repo, service: new RemittanceService(repo, new InMemoryExpectationRepository(), new BatchAdapter(), bus) };
}

const submitted = (patientControlNumber: string): ClaimSubmittedBody => ({
  claimId: `claim-${patientControlNumber}`,
  verificationId: "ver-1",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber,
  payerControlNumber: "556677889",
  totalFee: cents(1425),
  expectedInsurancePays: cents(800),
  serviceDate: "2026-07-27",
});

const remitClaim = (patientControlNumber: string): RemittanceRequestClaim => ({
  patientControlNumber,
  payerControlNumber: "556677889",
  patientFirstName: "Ada",
  patientLastName: "Alpha",
  memberId: "ABC12345",
  lines: [{ procedureCode: "D0120", charged: cents(65), quantity: 1 }],
  expectedInsurancePays: cents(65),
});

/** A real 835 from the mock clearinghouse, for the given claim. */
async function era(patientControlNumber: string): Promise<string> {
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [remitClaim(patientControlNumber)],
  });
  return fetched.raw!;
}

/**
 * Strip the TRN segment — the trace-less case a payer is entitled to send.
 *
 * Surgery on a REAL 835 rather than a hand-written fixture: the file stays balanced, keeps its
 * envelope, and differs from the working case in exactly the one way under test.
 */
const withoutTrace = (raw: string) => raw.replace(/TRN\*[^~]*~/, "");

test("two DIFFERENT trace-less remittances both ingest — they are different payments", async () => {
  // The defect, stated directly. Before the dedupe key existed the second call threw
  // "remittance with trace number  already exists" and that payment could never be recorded.
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  await service.recordExpectation(submitted("MRM-BBB"));

  const first = await service.ingestRaw(withoutTrace(await era("MRM-AAA")), NOW);
  const second = await service.ingestRaw(withoutTrace(await era("MRM-BBB")), NOW);

  assert.notEqual(first.remittance.id, second.remittance.id, "two different payments must be two remittances");
  assert.equal(repo.size, 2);
});

test("the SAME trace-less file redelivered is recognised and does not post twice", async () => {
  // The other half: content-addressed, so a redelivery of identical bytes is one payment.
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  const raw = withoutTrace(await era("MRM-AAA"));

  const first = await service.ingestRaw(raw, NOW);
  const again = await service.ingestRaw(raw, NOW);

  assert.equal(again.remittance.id, first.remittance.id, "identical bytes are one remittance, not two");
  assert.equal(repo.size, 1);
});

test("a trace-less remittance is still HELD — the derived key does not satisfy the safety gate", async () => {
  /**
   * The property that makes the fix safe rather than merely convenient. If the hash had been written
   * into `traceNumber`, `checkRemittanceSafety`'s `missing-trace-number` blocker would stop firing
   * and money would auto-post from a file with no payer trace number to reconcile against.
   */
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));

  const view = await service.ingestRaw(withoutTrace(await era("MRM-AAA")), NOW);

  assert.equal(view.remittance.status, "held");
  const stored = (await repo.list())[0]!;
  assert.equal(stored.status, "held");
  assert.match(stored.holdReason ?? "", /trace/i);
});

test("the stored traceNumber stays EMPTY — the derived key lives in its own field", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  await service.ingestRaw(withoutTrace(await era("MRM-AAA")), NOW);

  const stored = (await repo.list())[0]!;
  assert.equal(stored.traceNumber, "", "what the payer said is recorded as what the payer said");
  assert.match(stored.dedupeKey, /^sha256:[0-9a-f]{64}$/, "and the key is derived from content");
  assert.notEqual(stored.dedupeKey, stored.traceNumber);
});

test("a remittance WITH a trace number still dedupes on redelivery", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  const raw = await era("MRM-AAA");

  const first = await service.ingestRaw(raw, NOW);
  const again = await service.ingestRaw(raw, NOW);

  assert.equal(again.remittance.id, first.remittance.id);
  const stored = (await repo.list())[0]!;
  assert.notEqual(stored.traceNumber, "");
  /**
   * ── M1 — THIS ASSERTION REPLACES ONE THAT PINNED THE DEFECT ─────────────────────────────────
   *
   * It read `assert.equal(stored.dedupeKey, stored.traceNumber, "with a trace number the key IS the
   * trace number")`. That was a true description of the code and a false statement about money: a
   * trace number is the PAYER's own cheque number, unique inside that payer's numbering and nowhere
   * else, so keying on it alone made two payers' cheque `10024` one payment. The key must carry the
   * payer as well — but `traceNumber` must still hold exactly what the payer said, because the
   * safety gate blocks on its absence and a human quotes it back in a dispute.
   */
  assert.notEqual(stored.dedupeKey, stored.traceNumber, "the key is qualified; the trace number is not");
  assert.ok(stored.dedupeKey.endsWith(`|${stored.traceNumber}`), "the whole trace number is in the key");
  assert.ok(stored.dedupeKey.startsWith("DELTA DENTAL|"), "and so is the payer that issued it");
});

test("M1: two payers' identical cheque numbers are two payments, not one", async () => {
  /**
   * ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────────
   *
   * `dedupeKeyFor` returned the trace number alone. A trace number is a CHECK or EFT number issued
   * by the payer — unique within that payer's own sequence and nowhere else — and payers start
   * those sequences at low numbers and reuse them. Delta cheque `10024` and Cigna cheque `10024`
   * are ordinary, unrelated payments.
   *
   * What made this the worst failure in the module is how quiet it was. `#ingest` found the first
   * remittance under that key and returned ITS view as a success, so:
   *   • the second payment was never written;
   *   • the ERA worker counted it as ingested and settled the artifact;
   *   • `reconcileAll()` reconciles the remittances table against itself, so a row that was never
   *     written contributes nothing to `drift` — the money monitor reported BALANCED.
   * A payer's cheque in the bank against no ledger entry, and no error anywhere.
   */
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));

  const fromDelta = await era("MRM-AAA");
  // The SAME cheque number from a different payer. Surgery on a real 835 so the file stays balanced
  // and differs in exactly the one way under test; "Cigna Dental" is the same length as
  // "Delta Dental", so the ISA envelope's fixed-width padding survives.
  const fromCigna = fromDelta.replaceAll("Delta Dental", "Cigna Dental");
  assert.notEqual(fromCigna, fromDelta, "the payer must genuinely differ, or this proves nothing");

  const traceOf = (raw: string) => /TRN\*\d+\*([^*~]+)/.exec(raw)![1];
  assert.equal(traceOf(fromDelta), traceOf(fromCigna), "…while the cheque number is identical");

  const first = await service.ingestRaw(fromDelta, NOW);
  const second = await service.ingestRaw(fromCigna, NOW);

  assert.notEqual(
    second.remittance.id,
    first.remittance.id,
    "the second payer's cheque must not be swallowed as a redelivery of the first"
  );
  assert.equal(repo.size, 2, "two cheques, two remittances");

  const stored = await repo.list();
  assert.equal(new Set(stored.map((r) => r.dedupeKey)).size, 2, "distinct payments, distinct keys");
  assert.equal(
    new Set(stored.map((r) => r.traceNumber)).size,
    1,
    "and the trace number stays what each payer actually said — identical, which is the whole point"
  );
});

test("M1: the payer fold is case- and whitespace-insensitive, so a redelivery still matches", async () => {
  /**
   * An 835 shouts `METLIFE DENTAL` where a 271 says `MetLife Dental`, and a payer's own files vary
   * in internal spacing. If the fold were literal, the same payment re-served under a differently
   * cased name would derive a new key and post the money a second time — the failure this whole
   * mechanism exists to prevent, reintroduced by the fix for it.
   */
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  const raw = await era("MRM-AAA");

  await service.ingestRaw(raw, NOW);
  await service.ingestRaw(raw.replaceAll("Delta Dental", "DELTA  dental"), NOW);

  assert.equal(repo.size, 1, "same payer, same cheque, one payment");
});

test("two trace-less advices delivered in ONE batch do not collide", async () => {
  /**
   * The trap in the first version of this fix, and the reason the key folds in a discriminator
   * rather than hashing the file alone.
   *
   * `fetchAndIngest` hands every advice in a batch the SAME `raw` — there is one file and several
   * payments in it. Hashing only those bytes made two trace-less payments hash identically, so the
   * second was recognised as a duplicate of the first and returned its view. A real payment lost,
   * silently, with no error anywhere.
   *
   * Exercised through `fetchAndIngest` against an adapter that returns a genuine batch, because
   * that is the only path where one raw payload serves multiple advices — `ingestRaw` parses one
   * advice per call and can never reach it.
   */
  const { repo, service } = batchWired(
    [withoutTrace(await era("MRM-AAA")), withoutTrace(await era("MRM-BBB"))]
  );
  await service.recordExpectation(submitted("MRM-AAA"));
  await service.recordExpectation(submitted("MRM-BBB"));

  const views = await service.fetchAndIngest(
    { payerId: "delta-dental", payerName: "Delta Dental", payeeName: "MERMAID DEMO DENTAL", paymentDate: "2026-08-10" },
    NOW
  );

  assert.equal(views.length, 2);
  assert.notEqual(views[0]!.remittance.id, views[1]!.remittance.id, "two payments, two remittances");
  assert.equal(repo.size, 2);
  assert.equal(
    new Set((await repo.list()).map((r) => r.dedupeKey)).size,
    2,
    "distinct payments must derive distinct keys even from one shared file"
  );
});

test("the trace number wins over content — a re-enveloped ERA still dedupes", async () => {
  /**
   * A clearinghouse re-serving an ERA may re-envelope it: different control numbers, different
   * timestamps, same payment. Hashing content in that case would post the money a second time, so
   * whenever there is a trace number it decides, and the bytes do not get a vote.
   */
  const { service, repo } = wired();
  await service.recordExpectation(submitted("MRM-AAA"));
  const raw = await era("MRM-AAA");
  const reEnveloped = raw.replace("MERMAID DEMO DENTAL", "MERMAID DEMO DENTAL LLC");
  assert.notEqual(reEnveloped, raw, "the bytes must genuinely differ, or this proves nothing");

  await service.ingestRaw(raw, NOW);
  await service.ingestRaw(reEnveloped, NOW);

  assert.equal(repo.size, 1, "same trace, one payment, whatever the envelope says");
});
