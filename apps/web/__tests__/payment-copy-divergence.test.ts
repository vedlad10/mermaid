/**
 * Watching the three copies of a payment for disagreement.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * One posting is recorded in three places: the `postings` projection, inside `remittances.record`,
 * and inside `claims.record.payments`. Each store answers a different question and each screen reads
 * exactly one of them — which means a copy can drift while every screen still looks right, because
 * each copy is entirely self-consistent on its own.
 *
 * It has happened twice. A recovery was resolved in the projection and not in the JSONB the Recover
 * queue reads, so a worklist kept advertising money that had already arrived. A variance outcome was
 * relabelled in two stores and not the third, so the API served a different word than the database
 * held. Both were found by hand, afterwards, on a database small enough to eyeball.
 *
 * ── WHAT THESE TESTS PIN ───────────────────────────────────────────────────────────────────────
 * That the detector actually detects. A guard nobody has watched fail is not a guard, and this one
 * is especially easy to write so that it passes forever — comparing a value to itself — which is
 * exactly the mistake that made an earlier version of the F-3 tests worthless.
 *
 * The two stores are faked rather than driven through a full clinic, because the thing under test is
 * the COMPARISON. Driving real data through would only ever produce copies that agree, which is the
 * one case that proves nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { AlertGate } from "@mermaid/observability";
import { DEFAULT_THRESHOLDS, PAYMENT_COPY_DIVERGENCE, readCopies, runChecks } from "../monitors.ts";
import type { Services } from "../wiring.ts";

const at = (ms: number): Date => new Date(1_760_000_000_000 + ms);

/** What the remittance store says about a posting. */
const posting = (id: string, paid: number, responsibility: number, outcome: string) => ({
  id,
  paidAmount: cents(paid),
  patientResponsibility: cents(responsibility),
  variance: { outcome },
});

/** What the claim store says about the same posting. */
const payment = (postingId: string, paid: number, responsibility: number, outcome: string) => ({
  postingId,
  paidAmount: cents(paid),
  patientResponsibility: cents(responsibility),
  outcome,
});

/**
 * Two stores, stated independently. A test that derived one from the other could not fail.
 */
function stores(
  postings: ReturnType<typeof posting>[],
  payments: ReturnType<typeof payment>[]
): Services {
  return {
    remittance: {
      list: async () => [{ id: "rem-1" }],
      get: async () => ({ remittance: { postings } }),
      reconcileAll: async () => ({ drift: 0, balanced: true, summary: "ok" }),
      heldSummary: async () => ({ count: 0, oldestReceivedAt: null, totalCents: 0 }),
      deadLetteredArtifacts: async () => [],
    },
    claims: {
      /**
       * The status is load-bearing, not decoration.
       *
       * `readCopies` only reads claims in an adjudicated status, because a payment reaches a claim
       * only through `recordPayment` and that always leaves it `paid`, `partially_paid` or `denied`
       * — every other status costs a database round trip to learn it holds nothing. These fakes
       * carried no status at all and were therefore skipped the moment that filter arrived, so seven
       * tests went from asserting a comparison to asserting that nothing was compared.
       *
       * `partially_paid` rather than `paid` on purpose: `paid` is terminal, and a fixture standing
       * for "a claim with money on it" should be the state a claim is usually IN while money is
       * still being compared.
       */
      list: async () => [{ id: "claim-1", status: "partially_paid" }],
      get: async () => ({ claim: { payments } }),
    },
    persistent: false,
  } as unknown as Services;
}

const AGREE = {
  postings: [posting("p-1", 799.99, 500, "as_expected"), posting("p-2", 21.49, 136.01, "underpaid")],
  payments: [payment("p-1", 799.99, 500, "as_expected"), payment("p-2", 21.49, 136.01, "underpaid")],
};

// ── The comparison itself ─────────────────────────────────────────────────────────────────────

test("copies that agree report agreement, and report how many were compared", async () => {
  const result = await readCopies(stores(AGREE.postings, AGREE.payments));

  assert.equal(result.mismatches.length, 0);
  assert.equal(result.orphans.length, 0);
  assert.equal(result.compared, 2, "comparing nothing and reporting agreement is how a broken check looks healthy");
  assert.equal(result.truncated, false);
});

test("a single cent of disagreement about money is caught and located", async () => {
  /**
   * A one-cent difference is still two answers to one question, and the materiality band does not
   * apply here: that band decides whether a VARIANCE is worth a human's time, not whether this
   * system is allowed to contradict itself.
   */
  const result = await readCopies(
    stores(AGREE.postings, [payment("p-1", 800.0, 500, "as_expected"), AGREE.payments[1]!])
  );

  assert.equal(result.mismatches.length, 1);
  assert.deepEqual(result.mismatches[0], {
    postingId: "p-1",
    field: "paidAmount",
    remittance: "79999",
    claim: "80000",
  });
});

test("a disagreement about the WORD, with no money moved, is caught too", async () => {
  /**
   * The second real incident. No amount changed, so every money check reconciled perfectly while the
   * API served a different word than the database held — which is why the outcome is compared at all.
   */
  const result = await readCopies(
    stores(AGREE.postings, [payment("p-1", 799.99, 500, "underpaid"), AGREE.payments[1]!])
  );

  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]!.field, "outcome");
  assert.equal(result.mismatches[0]!.remittance, "as_expected");
  assert.equal(result.mismatches[0]!.claim, "underpaid");
});

test("patient responsibility is compared, because it is what the ledger bills", async () => {
  const result = await readCopies(
    stores(AGREE.postings, [payment("p-1", 799.99, 600, "as_expected"), AGREE.payments[1]!])
  );
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]!.field, "patientResponsibility");
});

test("several fields drifting on one posting are each reported", async () => {
  const result = await readCopies(
    stores(AGREE.postings, [payment("p-1", 1, 2, "denied"), AGREE.payments[1]!])
  );
  assert.deepEqual(
    result.mismatches.map((m) => m.field).sort(),
    ["outcome", "paidAmount", "patientResponsibility"],
    "a partial remediation rarely gets exactly one field wrong"
  );
});

test("a payment on a claim that no posted remittance records is reported, not ignored", async () => {
  /**
   * Not necessarily corruption — a held remittance has no posted copy — but it is never nothing, so
   * it is surfaced rather than quietly skipped.
   */
  const result = await readCopies(stores([AGREE.postings[0]!], AGREE.payments));
  assert.deepEqual(result.orphans, ["p-2"]);
  assert.equal(result.mismatches.length, 0, "an absent copy is not a disagreeing one");
});

// ── What the alert does with it ───────────────────────────────────────────────────────────────

const check = async (services: Services) => {
  const notes = await runChecks(
    services,
    new AlertGate({ consecutive: 1, cooldownMs: 60_000 }),
    DEFAULT_THRESHOLDS,
    at(0)
  );
  return notes.find((n) => n.key === PAYMENT_COPY_DIVERGENCE);
};

test("agreement raises no alarm", async () => {
  assert.equal(await check(stores(AGREE.postings, AGREE.payments)), undefined, "nothing has diverged");
});

test("divergence fires, names the field, and says why both screens look right", async () => {
  const note = await check(
    stores(AGREE.postings, [payment("p-1", 800.0, 500, "as_expected"), AGREE.payments[1]!])
  );

  assert.equal(note?.kind, "firing", "there is no tolerable number of contradictions about one payment");
  assert.equal(note!.detail.mismatches, 1);
  assert.match(note!.message, /paidAmount/, "the field a person has to go and look at");
  assert.match(note!.message, /both look correct and one of them is not/);
  assert.equal((note!.detail.examples as unknown[]).length, 1);
});

test("a comparison that could not run says so rather than reporting agreement", async () => {
  /**
   * The rule every alert in this file follows, and the one most worth restating: with a threshold of
   * zero, a swallowed failure and good news compute to the same thing. A comparison that cannot be
   * made must never read as one that passed.
   */
  const broken = stores(AGREE.postings, AGREE.payments);
  const note = await check({
    ...broken,
    claims: { list: async () => { throw new Error("repository down"); } },
  } as unknown as Services);

  assert.equal(note?.kind, "firing");
  assert.match(note!.message, /now unmonitored/);
  assert.equal(note!.detail.practicesRead, 0);
});

// ── The narrowing that made this fast, and the invariant it rests on ──────────────────────────

test("every status a payment can actually land in is scanned", async () => {
  /**
   * `readCopies` reads only claims in an adjudicated status. That is a claim about the DOMAIN, not
   * an optimisation: `ClaimService.recordPayment` appends a payment and then sets the status to
   * `paid`, `partially_paid` or `denied` — and refuses to append at all when the claim is already
   * terminal. So no other status can hold a payment, and reading one costs a round trip to find out
   * it holds nothing.
   *
   * If that ever stops being true, this check goes quiet rather than wrong, which is the worst way
   * for a money guard to fail. So the invariant is asserted here rather than trusted: each of the
   * three statuses, carrying a divergence, must still be caught.
   */
  for (const status of ["paid", "partially_paid", "denied"] as const) {
    const services = {
      remittance: {
        list: async () => [{ id: "rem-1" }],
        get: async () => ({ remittance: { postings: [posting("p-9", 100, 20, "as_expected")] } }),
      },
      claims: {
        list: async () => [{ id: "claim-9", status }],
        get: async () => ({ claim: { payments: [payment("p-9", 101, 20, "as_expected")] } }),
      },
      persistent: false,
    } as unknown as Services;

    const result = await readCopies(services);
    assert.equal(result.compared, 1, `a ${status} claim must be compared, not skipped`);
    assert.equal(result.mismatches.length, 1, `a divergence on a ${status} claim must be caught`);
    assert.equal(result.mismatches[0]!.field, "paidAmount");
  }
});

test("a claim that cannot hold a payment is not read at all", async () => {
  /**
   * The other half: the reads this removes are reads that could only ever return nothing. Asserted
   * by counting `get` calls rather than by inspecting the result, because the result would be
   * identical either way — the point is the round trip that did not happen.
   */
  let reads = 0;
  const services = {
    remittance: { list: async () => [], get: async () => null },
    claims: {
      list: async () => [
        { id: "c-draft", status: "draft" },
        { id: "c-ready", status: "ready" },
        { id: "c-submitted", status: "submitted" },
        { id: "c-rejected", status: "rejected" },
        { id: "c-void", status: "void" },
      ],
      get: async () => {
        reads += 1;
        return { claim: { payments: [] } };
      },
    },
    persistent: false,
  } as unknown as Services;

  const result = await readCopies(services);
  assert.equal(reads, 0, "five claims that cannot hold a payment must cost zero reads");
  assert.equal(result.compared, 0);
  assert.deepEqual(result.mismatches, []);
});
