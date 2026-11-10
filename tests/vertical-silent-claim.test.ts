/**
 * A claim that was filed and never answered, from verification to the watchdog (F4).
 *
 * The unit tests either side of this prove their own halves: the engine decides what silence means,
 * and the service decides what to do about it. Neither proves the claim reaching `submitted` the way
 * a real one does — through a verification, the scrubber, a submit gate and a clearinghouse
 * acknowledgement — and that matters here more than usual, because the watchdog's whole judgement
 * turns on ONE field that only the real path populates: whether the acknowledgement named a control
 * number.
 *
 * A fixture can set that field to anything. Only the pipeline can prove what actually lands in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import type { ClaimWentSilentBody } from "@mermaid/events";
import { buildServices } from "../apps/web/wiring.ts";

const SYNTHETIC_ADDRESS = {
  street: "1 SYNTHETIC TEST WAY",
  city: "SPRINGFIELD",
  state: "CA",
  zip: "900010000",
} as const;

const PLAN = [
  { code: "D0120", quantity: 1, fee: cents(65) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

/** Verify a patient and file the claim, exactly as a clinic would. */
async function filedClaim() {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus });
  const demo = services.via(new MockEdiAdapter());

  await demo.verification.create({
    patient: {
      firstName: "Ada",
      lastName: "Alpha",
      dateOfBirth: "1990-04-12",
      memberId: "ABC12345",
      address: SYNTHETIC_ADDRESS,
    },
    cardText: "Delta Dental\nMember ID: ABC12345",
    planItems: PLAN,
  });

  const ready = await demo.claims.list({ status: "ready" });
  const fileable = ready.find((c) => c.canSubmit);
  assert.ok(fileable, "the fixture must produce a claim the scrubber is happy with");
  const filed = await demo.claims.submit(fileable.id, { submittedBy: "biller@clinic" });
  assert.equal(filed.claim.status, "submitted");

  return { services, demo, bus, claimId: filed.claim.id, submittedAt: filed.claim.submission!.submittedAt };
}

/** Days after the real submission date, as an instant. */
const daysLater = (submittedAt: string, days: number): Date =>
  new Date(Date.parse(`${submittedAt.slice(0, 10)}T09:00:00Z`) + days * 86_400_000);

// ── The gap ─────────────────────────────────────────────────────────────────────────────────────

test("a real filed claim that goes quiet is in no queue until the watchdog looks", async () => {
  const { demo, claimId, submittedAt } = await filedClaim();
  const later = daysLater(submittedAt, 40);

  assert.deepEqual(
    (await demo.claims.list({ openOnly: true })).map((c) => c.id).filter((id) => id === claimId),
    [],
    "`submitted` is not an OPEN status, so the working queue does not show it"
  );
  assert.deepEqual(
    (await demo.claims.sweepFilingRisk(later)).map((c) => c.id),
    [],
    "and the filing-risk sweep reads that same list, so it escalates nothing either"
  );

  const watchlist = await demo.claims.silenceWatchlist(later);
  assert.equal(watchlist.length, 1, "the claim is 40 days silent and only this finds it");
  assert.equal(watchlist[0]!.id, claimId);
  assert.equal(watchlist[0]!.finding.daysSilent, 40);
});

test("a claim the clearinghouse acknowledged is STALLED — the real path fills in the control number", async () => {
  /**
   * The field the whole judgement turns on. `submit` records a submission even when the
   * acknowledgement carried no identifier, and reading that as receipt would turn an unacknowledged
   * claim — refile it — into a stalled one — do not refile it. Here the mock clearinghouse DOES
   * acknowledge with an identifier, so the correct answer is `stalled`, and the action must say so.
   */
  const { demo, claimId, submittedAt } = await filedClaim();

  const [row] = await demo.claims.silenceWatchlist(daysLater(submittedAt, 40));
  assert.equal(row!.id, claimId);
  assert.ok(row!.controlNumber.trim().length > 0, "the real submit path recorded an acknowledgement identifier");
  assert.equal(row!.finding.category, "stalled");
  assert.match(row!.finding.action, /Do not refile/);
  assert.match(row!.finding.action, new RegExp(row!.controlNumber.trim()));
});

test("nothing is silent while the payer still has its ordinary time", async () => {
  const { demo, submittedAt } = await filedClaim();
  assert.deepEqual(await demo.claims.silenceWatchlist(daysLater(submittedAt, 20)), []);
});

// ── The sweep, end to end ───────────────────────────────────────────────────────────────────────

test("the sweep escalates over the bus, once, and the claim never moves status", async () => {
  const { demo, bus, claimId, submittedAt } = await filedClaim();
  const later = daysLater(submittedAt, 40);

  const escalated = await demo.claims.sweepSilentClaims(later);
  assert.equal(escalated.length, 1);
  await bus.drain();

  const events = bus.all().filter((e) => e.type === "claim.went_silent");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as unknown as ClaimWentSilentBody;
  assert.equal(payload.claimId, claimId);
  assert.equal(payload.category, "stalled");
  assert.equal(payload.daysSilent, 40);
  assert.equal(payload.payerName, "Delta Dental");

  const claim = (await demo.claims.get(claimId))!;
  assert.equal(claim.claim.status, "submitted", "escalating is not adjudicating");

  // Quiet on the second pass, and quieter still on the third.
  assert.deepEqual(await demo.claims.sweepSilentClaims(daysLater(submittedAt, 41)), []);
  assert.equal(bus.all().filter((e) => e.type === "claim.went_silent").length, 1);
});

test("a payer finally answering ends the silence for good", async () => {
  /**
   * The claim the watchdog was chasing gets paid. Nothing about the watchdog should have to be
   * unwound for that to be true — the finding was never stored as a fact, only derived, so the
   * moment the claim is answered it simply stops being derivable.
   */
  const { demo, claimId, submittedAt } = await filedClaim();
  const later = daysLater(submittedAt, 40);
  await demo.claims.sweepSilentClaims(later);

  const filed = (await demo.claims.get(claimId))!;
  await demo.claims.recordPayment(
    {
      remittanceId: "rem-1",
      postingId: "post-1",
      claimId,
      patientControlNumber: filed.claim.submission!.patientControlNumber,
      postedAt: later.toISOString(),
      traceNumber: "ACH-1",
      payerId: "delta-dental",
      payerName: "Delta Dental",
      patientName: "Ada Alpha",
      memberId: "ABC12345",
      paymentDate: later.toISOString().slice(0, 10),
      chargedAmount: cents(1315),
      paidAmount: cents(700),
      patientResponsibility: cents(200),
      contractualAdjustments: cents(415),
    } as never,
    later
  );

  assert.deepEqual(
    await demo.claims.silenceWatchlist(daysLater(submittedAt, 60)),
    [],
    "an answered claim is not silent, and no state had to be cleaned up to make that true"
  );
});

// ── Correction and resubmission ────────────────────────────────────────────────────────────────

test("a human attestation reopens a silent claim and the existing refiling path takes over", async () => {
  const { demo, claimId, submittedAt } = await filedClaim();
  await demo.claims.sweepSilentClaims(daysLater(submittedAt, 40));

  const reopened = await demo.claims.markUnreceived(
    claimId,
    "Called Delta; they have no record of it.",
    "sam@clinic",
    daysLater(submittedAt, 41)
  );
  assert.equal(reopened.claim.status, "rejected", "the status a correct-and-refile already starts from");

  // And the claim is now in the ORDINARY working queue, which is the point: no new workflow was
  // invented, the practice uses the one it already knows.
  const open = await demo.claims.list({ openOnly: true });
  assert.ok(open.some((c) => c.id === claimId), "a reopened claim is open work");

  const [row] = await demo.claims.silenceWatchlist(daysLater(submittedAt, 50));
  assert.equal(row!.finding.category, "rejected-not-refiled", "and the silence is now the practice's own");
});

test("the watchdog changes nothing about claims, verification or money", async () => {
  /**
   * Shadow mode, asserted rather than asserted-to. Nothing calls the sweep automatically, and when
   * it is called by hand it must leave every other reading of the system exactly where it was.
   */
  const { demo, bus, submittedAt } = await filedClaim();
  const before = {
    open: (await demo.claims.list({ openOnly: true })).length,
    submitted: (await demo.claims.list({ status: "submitted" })).length,
    events: bus.all().length,
  };

  await demo.claims.silenceWatchlist(daysLater(submittedAt, 40));

  assert.equal((await demo.claims.list({ openOnly: true })).length, before.open);
  assert.equal((await demo.claims.list({ status: "submitted" })).length, before.submitted);
  assert.equal(bus.all().length, before.events, "a read publishes nothing");
});
