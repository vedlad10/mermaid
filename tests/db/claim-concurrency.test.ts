/**
 * Concurrent mutation of ONE claim, against a real database.
 *
 * Every claim mutation is read-modify-write over the whole aggregate, and the process genuinely
 * runs concurrent mutators: the web request drains the outbox AND a background worker drains it,
 * both with SKIP LOCKED, and two humans can click the same button. These tests prove the row lock
 * (`ClaimRepository.lockById`, `SELECT … FOR UPDATE`) actually serializes them — a property no
 * in-memory double can establish, because the in-memory store has no second connection.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { withPractice } from "@mermaid/db";
import { MockEdiAdapter, type EdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { PgVerificationRepository, VerificationService, type VerificationInput } from "@mermaid/verification";
import { ClaimNotSubmittableError, ClaimService, PgClaimRepository } from "@mermaid/claims";
import { NullEventPublisher } from "@mermaid/events";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const BILLING_PROVIDER = { name: "MERMAID DEMO DENTAL", npi: "1234567893", taxId: "987654321" };
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const created: string[] = [];
after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

const CLEAN: VerificationInput = {
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345", address: SYNTHETIC_ADDRESS },
  cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, fee: cents(110) },
    { code: "D2750", quantity: 1, toothNumber: "19", fee: cents(1250) },
  ],
};

/**
 * An adapter that counts wire submissions and holds each one open briefly.
 *
 * The delay is the point of the test: it keeps the first submitter INSIDE the gate (between its
 * read of the claim and its status write) long enough that the second submitter is provably
 * concurrent rather than merely close. With the row lock, the second blocks on the read and then
 * sees `submitted`; without it, both pass the gate and the claim goes to the clearinghouse twice.
 */
function countingAdapter(delayMs: number): { adapter: EdiAdapter; calls: () => number; entered: Promise<void> } {
  const real = new MockEdiAdapter();
  let count = 0;
  let signalEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const adapter: EdiAdapter = {
    checkEligibility: (r) => real.checkEligibility(r),
    submitClaim: async (r) => {
      count += 1;
      signalEntered();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return real.submitClaim(r);
    },
    fetchRemittance: (r) => real.fetchRemittance(r),
    parseRemittance: (raw) => real.parseRemittance(raw),
    parseRemittanceAll: (raw) => real.parseRemittanceAll(raw),
    listRemittanceArtifacts: (r) => real.listRemittanceArtifacts(r),
    fetchRemittanceArtifact: (id) => real.fetchRemittanceArtifact(id),
  };
  return { adapter, calls: () => count, entered };
}

/**
 * Force the pool to hold at least two live connections BEFORE the race.
 *
 * A serverless Postgres endpoint takes on the order of a second to establish a fresh TLS
 * connection. Without this, the "concurrent" second transaction spends the entire race window
 * connecting, arrives after the first has committed, and the test passes even with the lock
 * removed — a hollow race. Two overlapping sleeps guarantee two distinct pooled connections exist
 * and are warm.
 */
async function warmTwoConnections(p: string): Promise<void> {
  await Promise.all([
    withPractice(p, async (tx) => void (await tx.query("SELECT pg_sleep(0.3)"))),
    withPractice(p, async (tx) => void (await tx.query("SELECT pg_sleep(0.3)"))),
  ]);
}

async function readyClaim(p: string, claims: ClaimService): Promise<string> {
  const verification = new VerificationService(new PgVerificationRepository(), new MockEdiAdapter(), new NullEventPublisher());
  const verified = await withPractice(p, () => verification.create(CLEAN, NOW));
  const payload = (await withPractice(p, () => verification.completionEvent(verified.record.id)))!;
  const built = await withPractice(p, () => claims.createFromVerification(payload, NOW));
  assert.equal(built.claim.status, "ready", "the fixture claim must scrub clean");
  return built.claim.id;
}

test("two concurrent submits file the claim ONCE — the second is refused, not raced", dbTest, async () => {
  const p = await practice("claim-race-submit");
  const { adapter, calls, entered } = countingAdapter(2_000);
  const claims = new ClaimService(new PgClaimRepository(), adapter, BILLING_PROVIDER, new NullEventPublisher());
  const id = await readyClaim(p, claims);
  await warmTwoConnections(p);

  // Two transactions, two warm connections, one claim. The second submit starts only once the
  // first is PROVABLY inside the clearinghouse call and holding the row — so its read happens in
  // the window where, without the lock, the claim still reads `ready`.
  const first = withPractice(p, () => claims.submit(id, { submittedBy: "biller-one" }, NOW));
  await entered;
  const second = withPractice(p, () => claims.submit(id, { submittedBy: "biller-two" }, NOW));
  const results = await Promise.allSettled([first, second]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one submit succeeds");
  assert.equal(rejected.length, 1, "the loser is told, not silently absorbed");
  assert.ok(
    rejected[0]!.reason instanceof ClaimNotSubmittableError,
    `the refusal names the gate (got ${String(rejected[0]!.reason)})`
  );

  // The property that matters: the claim reached the clearinghouse exactly once. Without the row
  // lock both callers pass the gate before either writes, and this is 2.
  assert.equal(calls(), 1, "one claim, one wire submission");

  const read = (await withPractice(p, () => claims.get(id, NOW)))!;
  assert.equal(read.claim.status, "submitted");
  assert.equal(read.claim.payments.length, 0);
});
