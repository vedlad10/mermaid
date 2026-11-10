/**
 * ERA ingestion — tenant resolution (G1) and artifact retrieval (G2).
 *
 * ── WHAT THESE ARE ACTUALLY PROTECTING ─────────────────────────────────────────────────────────
 * An ERA is the only thing in this system that arrives unsolicited AND moves money. Every other
 * inbound payload answers a question Mermaid asked inside a request that already knew whose it was.
 * So the property under test is not "does ingestion work" but "can a file talk its way into the
 * wrong ledger" — and the answer has to be no by construction, not by vigilance.
 *
 * The design under test: the CREDENTIAL that fetched an artifact IS the tenant. The payee
 * identifier in the 835 is only ever a cross-check that can withhold trust, never a selector that
 * can grant it. These tests exist mostly to prove that asymmetry holds, including in the cases
 * where a payload is actively lying.
 *
 * The clearinghouse is mocked, deliberately and visibly: no ERA has ever been retrieved from live
 * Stedi, because a test ERA is only produced for a claim that submitted successfully and Stedi's
 * claim path returns INTERNAL_ERROR. Nothing here fabricates a real payer result — the mock serves
 * artifacts a test staged, and serves nothing otherwise.
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
  EraIngestService,
  InMemoryEraArtifactRepository,
  InMemoryEraSourceRepository,
  InMemoryExpectationRepository,
  InMemoryRemittanceRepository,
  RemittanceService,
  checkPayee,
  looksLikeX12,
} from "../index.ts";
import type { EraSource } from "../era/types.ts";

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});

const PRACTICE_A = "11111111-1111-4111-8111-111111111111";
const PRACTICE_B = "22222222-2222-4222-8222-222222222222";
const NPI_A = "1234567893";
const NPI_B = "1999999992";

/** One practice's whole ERA stack, with its OWN adapter — i.e. its own credential. */
function practice(practiceId: string, payeeNpi: string | null = NPI_A) {
  const adapter = new MockEdiAdapter();
  const repo = new InMemoryRemittanceRepository();
  const expectations = new InMemoryExpectationRepository();
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const remittance = new RemittanceService(repo, expectations, adapter, bus);
  const sources = new InMemoryEraSourceRepository();
  const artifacts = new InMemoryEraArtifactRepository();
  const era = new EraIngestService(adapter, sources, artifacts, remittance, silent);

  const source: EraSource = {
    id: `src-${practiceId}`,
    practiceId,
    vendor: "mock",
    credential: "test_credential_never_logged",
    payeeNpi,
    cursor: null,
    enabled: true,
    lastPolledAt: null,
    lastError: null,
  };
  return { adapter, repo, expectations, remittance, sources, artifacts, era, source };
}

/**
 * Both implementations of the seam have to answer this the same way, or a rule exists in only one
 * of them — which is a bug in the other. The Postgres side is held to the same behaviour, plus its
 * tenant scoping, in `tests/db/era-tenancy.test.ts`.
 */
test("a source resolves by its own id, not by a vendor guess", async () => {
  const sources = new InMemoryEraSourceRepository();
  const mock = await sources.upsert({
    practiceId: "p1", vendor: "mock", credential: "c-mock", payeeNpi: NPI_A, cursor: null, enabled: true,
  });
  const stedi = await sources.upsert({
    practiceId: "p1", vendor: "stedi", credential: "c-stedi", payeeNpi: NPI_B, cursor: null, enabled: true,
  });

  // The whole point: with two registered, the id picks one and the vendor priority order does not.
  assert.equal((await sources.getById(mock.id))!.vendor, "mock");
  assert.equal((await sources.getById(mock.id))!.payeeNpi, NPI_A);
  assert.equal((await sources.getById(stedi.id))!.vendor, "stedi");
  assert.equal((await sources.getById(stedi.id))!.payeeNpi, NPI_B);

  assert.equal(await sources.getById("src-does-not-exist"), null);
});

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
  totalFee: cents(65),
  expectedInsurancePays: cents(65),
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

/** A real, balanced 835 from the mock clearinghouse, addressed to `payeeNpi`. */
async function era835(patientControlNumber: string, payeeNpi: string | null): Promise<string> {
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [remitClaim(patientControlNumber)],
  });
  const raw = fetched.raw!;
  // The mock builder emits a bare N1*PE; give it an identifier so the cross-check has something
  // real to compare. Surgery on a genuine 835 rather than a hand-written fixture.
  return payeeNpi ? raw.replace(/N1\*PE\*([^~]*)~/, `N1*PE*$1*XX*${payeeNpi}~`) : raw;
}

// ── The happy path ───────────────────────────────────────────────────────────────────────────────

test("a practice polls, discovers, retrieves and ingests its own ERA", async () => {
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  p.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_A), { transactionId: "txn-1" });

  const polled = await p.era.poll(p.source, NOW);
  assert.equal(polled.discovered, 1);
  assert.equal(polled.error, null);

  const artifact = (await p.artifacts.list())[0]!;
  assert.equal(artifact.status, "pending", "discovery records work; it does not do the work");
  assert.equal(artifact.fileExecutionId, "exec-1");

  const report = await p.era.ingestArtifact(p.source, artifact, NOW);
  assert.equal(report.remittances.length, 1);
  assert.equal(report.failed, 0);

  const stored = await p.repo.list();
  assert.equal(stored.length, 1);
  // The amount is whatever the mock payer adjudicated — asserting a hardcoded figure here would
  // just restate the mock's adjudication rules and break whenever they change. What matters is
  // that real money arrived and was attributed to this practice.
  assert.ok(stored[0]!.paymentTotal > 0, "a payment was posted");
  assert.equal(stored[0]!.paymentTotal, report.remittances[0]!.remittance.paymentTotal);
  assert.equal((await p.artifacts.list())[0]!.status, "ingested");
});

test("the audit trail records HOW the practice was resolved and from which artifact", async () => {
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  p.adapter.stageRemittanceArtifact("exec-audit", await era835("MRM-AAA", NPI_A));

  await p.era.poll(p.source, NOW);
  await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  const trail = (await p.repo.list())[0]!.audit.map((a) => a.message).join("\n");
  assert.match(trail, /Practice resolved: retrieved with this practice's own mock credential/);
  assert.match(trail, /artifact exec-audit/);
  assert.match(trail, /payee 1234567893 matches the registered NPI/);
});

// ── Cross-practice isolation: the property that matters most ─────────────────────────────────────

test("practice A cannot ingest practice B's ERA — the payload does not choose the tenant", async () => {
  /**
   * The attack, stated plainly: a file addressed to practice B is served to practice A's poller.
   * Because the tenant came from A's credential, the money lands in A's context — and the payee
   * cross-check catches that it should not have, so it is HELD rather than posted.
   *
   * Note what is NOT asserted: that the remittance was routed to B. Routing it anywhere on the
   * strength of the payload is the defect. The correct outcome is that A stops and asks.
   */
  const a = practice(PRACTICE_A, NPI_A);
  await a.remittance.recordExpectation(submitted("MRM-BBB"));
  a.adapter.stageRemittanceArtifact("exec-b", await era835("MRM-BBB", NPI_B));

  await a.era.poll(a.source, NOW);
  const report = await a.era.ingestArtifact(a.source, (await a.artifacts.list())[0]!, NOW);

  assert.equal(report.held, 1, "a foreign payee must never post");
  assert.equal(report.ingested, 0);

  const stored = (await a.repo.list())[0]!;
  assert.equal(stored.status, "held");
  assert.match(stored.holdReason ?? "", /payee/i);
  assert.match(stored.audit.map((x) => x.message).join("\n"), /PAYEE MISMATCH/);
  assert.equal((await a.artifacts.list())[0]!.status, "held");
});

test("practice B's store is untouched by anything practice A ingests", async () => {
  // Two fully separate stacks, as two practices are. The isolation asserted here is the in-memory
  // half; `tests/db/` asserts the same thing against real RLS, which is where it truly lives.
  const a = practice(PRACTICE_A, NPI_A);
  const b = practice(PRACTICE_B, NPI_B);
  await a.remittance.recordExpectation(submitted("MRM-AAA"));
  a.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_A));

  await a.era.poll(a.source, NOW);
  await a.era.ingestArtifact(a.source, (await a.artifacts.list())[0]!, NOW);

  assert.equal((await a.repo.list()).length, 1);
  assert.equal((await b.repo.list()).length, 0, "B saw nothing of A's money");
  assert.equal((await b.artifacts.list()).length, 0);
});

test("a matching payee cannot make an otherwise-unsafe remittance post", async () => {
  // The asymmetry, asserted directly: the cross-check may withhold trust, never grant it. A
  // trace-less ERA is held for a missing trace number whether or not the payee matches.
  const p = practice(PRACTICE_A, NPI_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  const traceless = (await era835("MRM-AAA", NPI_A)).replace(/TRN\*[^~]*~/, "");
  p.adapter.stageRemittanceArtifact("exec-traceless", traceless);

  await p.era.poll(p.source, NOW);
  const report = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(report.held, 1);
  assert.match((await p.repo.list())[0]!.holdReason ?? "", /trace/i);
});

test("a source with no registered NPI is reported as unchecked, not as matched", async () => {
  const p = practice(PRACTICE_A, null);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  p.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_B));

  await p.era.poll(p.source, NOW);
  await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  const trail = (await p.repo.list())[0]!.audit.map((a) => a.message).join("\n");
  assert.match(trail, /no payee NPI is registered for this source/);
});

test("checkPayee grants nothing and withholds precisely", () => {
  assert.equal(checkPayee("1234567893", "1234567893"), "matched");
  assert.equal(checkPayee(" 1234567893 ", "1234567893"), "matched", "padding is not a different practice");
  assert.equal(checkPayee("abc123", "ABC123"), "matched", "case is not a different practice");
  assert.equal(checkPayee("1999999992", "1234567893"), "mismatched");
  assert.equal(checkPayee(null, "1234567893"), "absent", "a bare payee name is legal and is not evidence");
  assert.equal(checkPayee("1234567893", null), "not-registered");
  assert.equal(checkPayee(null, null), "not-registered");
  // A prefix must NOT match — that is how two different NPIs would compare equal.
  assert.equal(checkPayee("123456789", "1234567893"), "mismatched");
});

// ── Retrieval failures (G2) ──────────────────────────────────────────────────────────────────────

test("a 5xx retrieval leaves the artifact pending and retryable — nothing is lost", async () => {
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-5xx", "unused", {
    failure: { code: "unavailable", message: "Stedi is unavailable (HTTP 503).", retryable: true },
  });

  await p.era.poll(p.source, NOW);
  const report = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(report.failed, 1);
  assert.equal(report.deadLettered, 0);
  const artifact = (await p.artifacts.list())[0]!;
  assert.equal(artifact.status, "pending", "a transport failure is retried, not abandoned");
  assert.equal(artifact.deadLettered, false);
  assert.match(artifact.lastError ?? "", /503/);
});

test("a 4xx retrieval dead-letters immediately rather than retrying forever", async () => {
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-4xx", "unused", {
    failure: { code: "parse_error", message: "Stedi refused the request (HTTP 404).", retryable: false },
  });

  await p.era.poll(p.source, NOW);
  const report = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(report.deadLettered, 1);
  const artifact = (await p.artifacts.list())[0]!;
  assert.equal(artifact.deadLettered, true);
  assert.equal(artifact.status, "failed");
});

test("a timeout is retryable; repeated failure eventually dead-letters", async () => {
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-timeout", "unused", {
    failure: { code: "timeout", message: "Stedi did not respond within 30000ms.", retryable: true },
  });
  await p.era.poll(p.source, NOW);

  // Drive it to the ceiling the way a worker would: same artifact, repeatedly.
  for (let i = 0; i < 5; i++) {
    const artifact = (await p.artifacts.list())[0]!;
    await p.era.ingestArtifact(p.source, artifact, NOW);
  }
  const artifact = (await p.artifacts.list())[0]!;
  assert.equal(artifact.deadLettered, true, "retrying forever occupies a slot real ERAs need");
  assert.ok(artifact.attempts >= 5);
});

test("an unknown fileExecutionId fails permanently and is never treated as empty", async () => {
  const p = practice(PRACTICE_A);
  const { artifact } = await p.artifacts.discover({
    practiceId: PRACTICE_A,
    sourceId: p.source.id,
    fileExecutionId: "exec-does-not-exist",
    transactionId: null,
    processedAt: null,
  });

  const report = await p.era.ingestArtifact(p.source, artifact, NOW);
  assert.equal(report.deadLettered, 1);
  assert.equal((await p.repo.list()).length, 0, "an unretrievable artifact must not become a $0 remittance");
});

test("a missing fileExecutionId is refused rather than fetched", async () => {
  const p = practice(PRACTICE_A);
  const { artifact } = await p.artifacts.discover({
    practiceId: PRACTICE_A,
    sourceId: p.source.id,
    fileExecutionId: "   ",
    transactionId: null,
    processedAt: null,
  });

  const report = await p.era.ingestArtifact(p.source, artifact, NOW);
  assert.equal(report.deadLettered, 1);
  assert.match((await p.artifacts.list())[0]!.lastError ?? "", /never be retrieved/);
});

test("a non-X12 body is refused before the parser sees it, and says which failure it was", async () => {
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-html", "<!doctype html><title>502 Bad Gateway</title>");

  await p.era.poll(p.source, NOW);
  const report = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(report.failed, 1);
  assert.match((await p.artifacts.list())[0]!.lastError ?? "", /not X12/);
  assert.equal((await p.repo.list()).length, 0);
});

test("looksLikeX12 separates 'not EDI' from 'EDI we cannot read'", () => {
  assert.equal(looksLikeX12("ISA*00*..."), true);
  assert.equal(looksLikeX12("  \n ST*835*0001~"), true);
  assert.equal(looksLikeX12("<!doctype html>"), false);
  assert.equal(looksLikeX12('{"error":"nope"}'), false);
  assert.equal(looksLikeX12(""), false);
});

// ── Exactly-once, and the multi-cheque file ──────────────────────────────────────────────────────

test("a multi-835 artifact becomes one remittance per cheque", async () => {
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  await p.remittance.recordExpectation(submitted("MRM-BBB"));
  const batch = (await era835("MRM-AAA", NPI_A)) + (await era835("MRM-BBB", NPI_A));
  p.adapter.stageRemittanceArtifact("exec-batch", batch);

  await p.era.poll(p.source, NOW);
  const report = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(report.remittances.length, 2, "two cheques, two remittances");
  assert.equal((await p.repo.list()).length, 2);
  assert.equal((await p.artifacts.list())[0]!.remittanceCount, 2);
  // And they are genuinely distinct payments, not one read twice.
  assert.equal(new Set((await p.repo.list()).map((r) => r.dedupeKey)).size, 2);
});

test("polling the same window twice discovers nothing new", async () => {
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_A));

  const first = await p.era.poll(p.source, NOW);
  assert.equal(first.discovered, 1);

  // A real poller resumes from the cursor; a re-poll of the same window is the case that must be
  // harmless, because that is what happens after a crash or a restart.
  const second = await p.era.poll({ ...p.source, cursor: null }, NOW);
  assert.equal(second.discovered, 0);
  assert.equal(second.alreadyKnown, 1);
  assert.equal((await p.artifacts.list()).length, 1);
});

test("ingesting the same artifact twice posts the money once", async () => {
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  p.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_A));
  await p.era.poll(p.source, NOW);

  const artifact = (await p.artifacts.list())[0]!;
  await p.era.ingestArtifact(p.source, artifact, NOW);
  const again = await p.era.ingestArtifact(p.source, artifact, NOW);

  assert.equal((await p.repo.list()).length, 1, "the dedupe key is the second guarantee");
  assert.equal(again.remittances.length, 1, "re-ingestion returns the existing remittance, not a new one");
});

test("the same cheque re-served under a NEW artifact id still posts once", async () => {
  /**
   * Why the artifact ledger alone is not enough. A clearinghouse may re-serve one payment under a
   * fresh `fileExecutionId`, which the ledger cannot recognise — so the remittance dedupe key has
   * to catch it, and this asserts the two guarantees compose rather than overlap.
   */
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  const raw = await era835("MRM-AAA", NPI_A);
  p.adapter.stageRemittanceArtifact("exec-first", raw);
  p.adapter.stageRemittanceArtifact("exec-second", raw);

  await p.era.poll(p.source, NOW);
  for (const artifact of await p.artifacts.list()) {
    await p.era.ingestArtifact(p.source, artifact, NOW);
  }

  assert.equal((await p.artifacts.list()).length, 2, "two artifacts were genuinely offered");
  assert.equal((await p.repo.list()).length, 1, "but it is one payment, and posts once");
});

test("a failed artifact can be retried successfully — failure is not terminal", async () => {
  const p = practice(PRACTICE_A);
  await p.remittance.recordExpectation(submitted("MRM-AAA"));
  p.adapter.stageRemittanceArtifact("exec-flaky", "unused", {
    failure: { code: "unavailable", message: "transient", retryable: true },
  });
  await p.era.poll(p.source, NOW);

  const failed = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);
  assert.equal(failed.failed, 1);

  // The clearinghouse recovers; the same artifact now serves its bytes.
  p.adapter.stageRemittanceArtifact("exec-flaky", await era835("MRM-AAA", NPI_A));
  const retried = await p.era.ingestArtifact(p.source, (await p.artifacts.list())[0]!, NOW);

  assert.equal(retried.remittances.length, 1);
  assert.equal((await p.artifacts.list())[0]!.status, "ingested");
  assert.equal((await p.repo.list()).length, 1);
});

// ── Poll failures ────────────────────────────────────────────────────────────────────────────────

test("a failed poll does not advance the cursor", async () => {
  /**
   * The one failure mode that loses an ERA silently. If a failed page advanced the cursor, the
   * artifacts in it would never be mentioned again by anybody — no error, no ledger row, no money.
   */
  const p = practice(PRACTICE_A);
  const broken = new MockEdiAdapter();
  broken.listRemittanceArtifacts = async () => ({
    ok: false,
    error: { code: "unavailable", message: "clearinghouse down", retryable: true },
    source: "mock" as const,
  });
  const era = new EraIngestService(broken, p.sources, p.artifacts, p.remittance, silent);
  await p.sources.upsert(p.source);

  const report = await era.poll({ ...p.source, cursor: "page-7" }, NOW);
  assert.equal(report.error, "clearinghouse down");
  assert.equal(report.cursor, "page-7", "the cursor must not move past a page we never read");
  assert.equal((await p.artifacts.list()).length, 0);
});

test("the cursor advances only after every id on the page is on the ledger", async () => {
  /**
   * ── WHY THIS TEST INTERRUPTS THE PAGE ────────────────────────────────────────────────────────
   * The first version of this test asserted the end state of a page that succeeded, and it was
   * HOLLOW: moving `recordPollSuccess` to the top of the loop — the exact defect it was meant to
   * catch — left every assertion passing, because both orderings reach the same final state when
   * nothing goes wrong.
   *
   * Ordering only becomes observable when the page does NOT complete. So this one fails partway
   * through and asserts the cursor did not move: if it had, the un-recorded artifacts would never
   * be offered again by anybody, which is the one way an ERA disappears in silence.
   */
  const p = practice(PRACTICE_A);
  // A stub page rather than the mock adapter's, so the cursor values under test are exactly the
  // ones asserted and do not depend on how the mock happens to paginate.
  const stub = new MockEdiAdapter();
  stub.listRemittanceArtifacts = async () => ({
    ok: true as const,
    data: {
      artifacts: [
        { id: "exec-1", transactionId: null, processedAt: null },
        { id: "exec-2", transactionId: null, processedAt: null },
      ],
      nextCursor: "page-2",
    },
    source: "mock" as const,
  });
  const era = new EraIngestService(stub, p.sources, p.artifacts, p.remittance, silent);
  await p.sources.upsert({ ...p.source, cursor: "page-1" });

  let calls = 0;
  const realDiscover = p.artifacts.discover.bind(p.artifacts);
  p.artifacts.discover = async (input) => {
    if (++calls === 2) throw new Error("database went away mid-page");
    return realDiscover(input);
  };

  await assert.rejects(era.poll({ ...p.source, cursor: "page-1" }, NOW), /went away mid-page/);

  const stored = await p.sources.get("mock");
  assert.equal(stored!.cursor, "page-1", "an interrupted page must not move the cursor past itself");
  assert.equal((await p.artifacts.list()).length, 1, "the id that WAS recorded stays recorded");
});

test("a completed page does advance the cursor, so polling makes progress", async () => {
  // The other half: refusing to advance on failure must not turn into never advancing at all.
  const p = practice(PRACTICE_A);
  p.adapter.stageRemittanceArtifact("exec-1", await era835("MRM-AAA", NPI_A));
  await p.sources.upsert(p.source);

  const report = await p.era.poll(p.source, NOW);
  assert.equal(report.discovered, 1);
  const stored = await p.sources.get("mock");
  assert.equal(stored!.cursor, report.cursor);
  assert.equal(stored!.lastError, null);
});

/**
 * ── THE ERROR'S OWN `retryable` FLAG DECIDES ───────────────────────────────────────────────────
 * The ingest catch hard-coded `retryable: false` on the reasoning that parse failures are
 * permanent. True of parsing — but `RemittanceUnavailableError` also arrives with
 * `retryable: true` for transient infrastructure failures, and ignoring its word dead-lettered a
 * payer's money file on the FIRST such failure: the five-attempt retry machinery skipped entirely,
 * and the file pushed to the hand-work queue for a condition that would have cleared itself.
 */
test("a retryable ingest failure keeps its retries; a permanent one dead-letters", async () => {
  const { RemittanceUnavailableError } = await import("../index.ts");
  const stage = async (whichError: "transient" | "permanent") => {
    const p = practice(PRACTICE_A);
    const throwing = {
      ingestArtifact: async () => {
        throw whichError === "transient"
          ? new RemittanceUnavailableError("db_unavailable", "the database went away mid-ingest", true)
          : new RemittanceUnavailableError("parse_error", "this 835 is malformed", false);
      },
    } as unknown as RemittanceService;
    const era = new EraIngestService(p.adapter, p.sources, p.artifacts, throwing, silent);
    p.adapter.stageRemittanceArtifact("exec-retry", await era835("MRM-RTY", NPI_A));
    const { artifact } = await p.artifacts.discover({
      practiceId: PRACTICE_A,
      sourceId: p.source.id,
      fileExecutionId: "exec-retry",
      transactionId: null,
      processedAt: null,
    });
    return { era, artifacts: p.artifacts, source: p.source, artifact };
  };

  const transient = await stage("transient");
  const first = await transient.era.ingestArtifact(transient.source, transient.artifact, NOW);
  assert.equal(first.failed, 1);
  assert.equal(first.deadLettered, 0, "one transient failure must not abandon a payer's money file");
  const afterTransient = (await transient.artifacts.get("exec-retry"))!;
  assert.equal(afterTransient.deadLettered, false);
  assert.equal(afterTransient.status, "pending", "the file is still work, not a corpse");

  const permanent = await stage("permanent");
  const only = await permanent.era.ingestArtifact(permanent.source, permanent.artifact, NOW);
  assert.equal(only.deadLettered, 1, "the same bytes will not parse differently next time");
  assert.equal((await permanent.artifacts.get("exec-retry"))!.deadLettered, true);
});
