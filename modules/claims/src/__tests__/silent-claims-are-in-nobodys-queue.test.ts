/**
 * The silent-claim watchdog, through the service (F4).
 *
 * The engine beside this decides what silence means. This covers the part that makes it real: that
 * the sweep finds claims nothing else looks at, escalates each of them once, stops when a payer
 * finally answers, and offers the one honest route back to the scrubber.
 *
 * ── THE DEFECT, STATED AS A TEST ───────────────────────────────────────────────────────────────
 * `OPEN_STATUSES` is `draft, ready, rejected, partially_paid, denied` — `submitted` is absent, so
 * `sweepFilingRisk` never looks at a filed claim. That is right while payers answer, and it is the
 * whole problem when they do not: the first test below is the proof that a claim can be four months
 * from expiry, worth $650, and in nobody's queue at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { ClaimService } from "../service.ts";
import { InMemoryClaimRepository } from "../repository.ts";
import type { Claim } from "../types.ts";
import type { ClaimWentSilentBody } from "@mermaid/events";
import { BILLING_PROVIDER } from "./fixtures.ts";

const NOW = new Date("2026-09-16T09:00:00Z");
const at = (day: string) => new Date(`${day}T09:00:00Z`);

function harness() {
  const repo = new InMemoryClaimRepository();
  const bus = new InMemoryOutbox();
  const service = new ClaimService(repo, new MockEdiAdapter(), BILLING_PROVIDER, bus);
  return { repo, bus, service };
}

/**
 * A claim seeded directly into the store.
 *
 * Built rather than driven through `createFromVerification` and `submit` on purpose: this file is
 * about what the sweep does with claims in given states, and reaching those states through the full
 * pipeline would make every test depend on the scrubber's opinion of a fixture.
 */
const claimAt = (over: Partial<Claim> & { id: string }): Claim =>
  ({
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    status: "submitted",
    verificationId: `ver-${over.id}`,
    coverageSnapshot: {} as Claim["coverageSnapshot"],
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
    payer: { payerId: "delta-dental", payerName: "Delta Dental" },
    serviceDate: "2026-07-28",
    filingDeadline: "2027-07-28",
    lines: [],
    totalFee: cents(1250),
    expectedInsurancePays: cents(650),
    expectedPatientPays: cents(600),
    scrub: null,
    submission: {
      submittedAt: "2026-08-01T10:00:00.000Z",
      submittedBy: "biller@clinic",
      patientControlNumber: `MRM-${over.id}`,
      controlNumber: "CH-99881",
      outcome: "accepted",
      statusCategory: "A1",
      statusCode: "19",
      message: "Accepted",
      lineErrors: [],
    },
    payments: [],
    voidReason: null,
    filingRiskRaised: null,
    audit: [],
    ...over,
  }) as Claim;

// ── The gap ─────────────────────────────────────────────────────────────────────────────────────

test("a filed claim that went quiet is in no existing queue, and the watchdog is the only thing that sees it", async () => {
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "c1" }));

  assert.deepEqual(
    await service.list({ openOnly: true }),
    [],
    "`submitted` is not an OPEN status, so the working queue shows nothing"
  );
  assert.deepEqual(
    await service.sweepFilingRisk(NOW),
    [],
    "and the filing-risk sweep, which reads the same list, escalates nothing"
  );

  const watchlist = await service.silenceWatchlist(NOW);
  assert.equal(watchlist.length, 1, "the claim is real, it is 46 days silent, and only this finds it");
  assert.equal(watchlist[0]!.finding.category, "stalled");
  assert.equal(watchlist[0]!.finding.daysSilent, 46);
  assert.equal(watchlist[0]!.controlNumber, "CH-99881");
});

test("the watchlist is a read — it changes nothing", async () => {
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "c1" }));

  await service.silenceWatchlist(NOW);
  await service.silenceWatchlist(NOW);

  const stored = (await repo.getById("c1"))!;
  assert.equal(stored.status, "submitted", "no claim moves status because somebody looked at it");
  assert.equal(stored.silenceRaised, undefined);
  assert.equal(stored.updatedAt, "2026-08-01T10:00:00.000Z");
  assert.deepEqual(stored.audit, []);
});

// ── Separation from denials ─────────────────────────────────────────────────────────────────────

test("denied claims never appear, however long they sit", async () => {
  /**
   * A denial is an answer with a reason code and an appeal path, and it belongs to the denials
   * module. Putting it here too would give one claim two worklists under two incompatible remedies.
   */
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "denied", status: "denied" }));
  await repo.save(claimAt({ id: "paid", status: "paid" }));
  await repo.save(claimAt({ id: "silent" }));

  const ids = (await service.silenceWatchlist(NOW)).map((r) => r.id);
  assert.deepEqual(ids, ["silent"]);
});

test("a rejected claim is surfaced as a refiling job, not as a denial", async () => {
  const { repo, service } = harness();
  await repo.save(
    claimAt({
      id: "rej",
      status: "rejected",
      submission: {
        ...claimAt({ id: "rej" }).submission!,
        submittedAt: "2026-09-01T10:00:00.000Z",
        outcome: "rejected",
        message: "Missing tooth number on line 1.",
      },
    })
  );

  const [row] = await service.silenceWatchlist(NOW);
  assert.equal(row!.finding.category, "rejected-not-refiled");
  assert.match(row!.finding.action, /NOT a denial/);
  assert.match(row!.finding.action, /clock never stopped/);
});

// ── The sweep ───────────────────────────────────────────────────────────────────────────────────

test("the sweep escalates once, publishes what to do, and then goes quiet", async () => {
  const { repo, bus, service } = harness();
  await repo.save(claimAt({ id: "c1" }));

  const first = await service.sweepSilentClaims(NOW);
  assert.equal(first.length, 1);

  const events = bus.all().filter((e) => e.type === "claim.went_silent");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as unknown as ClaimWentSilentBody;
  assert.equal(payload.category, "stalled");
  assert.equal(payload.daysSilent, 46);
  assert.equal(payload.controlNumber, "CH-99881");
  assert.equal(payload.amountAtRisk, cents(650));
  assert.equal(payload.claimId, "c1");
  assert.match(payload.action, /Do not refile/);

  const stored = (await repo.getById("c1"))!;
  assert.deepEqual(stored.silenceRaised, { category: "stalled", risk: "safe" });
  assert.equal(stored.status, "submitted", "escalating is not adjudicating — the status is untouched");
  assert.equal(stored.audit.length, 1);

  // An alert that fires on every sweep is one staff learn to scroll past, and the claims most
  // likely to be scrolled past are the oldest — exactly the ones this exists for.
  assert.deepEqual(await service.sweepSilentClaims(new Date("2026-09-17T09:00:00Z")), []);
  assert.equal(bus.all().filter((e) => e.type === "claim.went_silent").length, 1);
});

test("a worsening deadline re-raises the same claim, because that is the news", async () => {
  const { repo, bus, service } = harness();
  await repo.save(claimAt({ id: "c1", filingDeadline: "2026-10-20" }));

  await service.sweepSilentClaims(at("2026-09-16")); // 34 days left — approaching (APPROACHING_DAYS is 45)
  assert.deepEqual((await repo.getById("c1"))!.silenceRaised, { category: "stalled", risk: "approaching" });

  const second = await service.sweepSilentClaims(at("2026-10-10")); // 10 days left — urgent (URGENT_DAYS is 14)
  assert.equal(second.length, 1);
  assert.deepEqual((await repo.getById("c1"))!.silenceRaised, { category: "stalled", risk: "urgent" });

  const risks = bus.all().filter((e) => e.type === "claim.went_silent").map((e) => (e.payload as { risk: string }).risk);
  assert.deepEqual(risks, ["approaching", "urgent"]);
});

test("a payer answering between the read and the write stops the escalation", async () => {
  /**
   * The watchlist read is unlocked. A remittance posting in the gap turns this claim into one the
   * payer HAS answered, and escalating it would send a biller to chase money already received.
   * The sweep re-assesses under the lock rather than trusting what it listed.
   */
  const { repo, bus, service } = harness();
  await repo.save(claimAt({ id: "c1" }));

  const listed = await service.silenceWatchlist(NOW);
  assert.equal(listed.length, 1);

  const answered = (await repo.getById("c1"))!;
  await repo.update({ ...answered, status: "paid" });

  assert.deepEqual(await service.sweepSilentClaims(NOW), []);
  assert.equal(bus.all().filter((e) => e.type === "claim.went_silent").length, 0);
});

test("the sweep works the most urgent claim first", async () => {
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "rich-and-safe", expectedInsurancePays: cents(4000), filingDeadline: "2027-07-28" }));
  await repo.save(claimAt({ id: "poor-and-expiring", expectedInsurancePays: cents(150), filingDeadline: "2026-09-20" }));

  const swept = await service.sweepSilentClaims(NOW);
  assert.deepEqual(
    swept.map((r) => r.id),
    ["poor-and-expiring", "rich-and-safe"],
    "money about to stop existing outranks more money that is not going anywhere"
  );
});

// ── Correction and resubmission ────────────────────────────────────────────────────────────────

test("a human can attest a claim was never received, which reopens it for refiling", async () => {
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "c1", submission: { ...claimAt({ id: "c1" }).submission!, controlNumber: "" } }));
  await service.sweepSilentClaims(NOW);

  const view = await service.markUnreceived("c1", "Clearinghouse has no record of it.", "sam@clinic", NOW);
  assert.equal(view.claim.status, "rejected");

  const stored = (await repo.getById("c1"))!;
  assert.match(stored.audit.at(-1)!.message, /sam@clinic established the payer never received this claim/);
  assert.match(stored.audit.at(-1)!.message, /Clearinghouse has no record of it\./);
  assert.equal(stored.audit.at(-1)!.actor, "staff", "an attestation is a human act, never the system's");
  assert.equal(
    stored.silenceRaised,
    null,
    "the claim has moved to a different kind of silence, and the next sweep must say so"
  );

  // `rejected` is already the status the existing correct-and-refile path starts from, so no new
  // workflow is invented: the practice uses the one it already knows.
  const [row] = await service.silenceWatchlist(at("2026-09-25"));
  assert.equal(row!.finding.category, "rejected-not-refiled");
});

test("the attestation refuses to be anonymous, or to overwrite an answer", async () => {
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "c1" }));

  await assert.rejects(
    () => service.markUnreceived("c1", "   ", "sam@clinic", NOW),
    /a reason is required/,
    "an unattributed attestation is worthless as evidence of timely filing"
  );

  await repo.update({ ...(await repo.getById("c1"))!, status: "denied" });
  await assert.rejects(
    () => service.markUnreceived("c1", "Not received.", "sam@clinic", NOW),
    /only a submitted claim can be marked unreceived/,
    "the payer answered; it plainly did receive it"
  );
});

test("a claim with money on it cannot be declared unreceived", async () => {
  const { repo, service } = harness();
  const paid = claimAt({ id: "c1" });
  await repo.save({
    ...paid,
    payments: [{ postingId: "p1", paidAmount: cents(650) } as unknown as Claim["payments"][number]],
  });

  await assert.rejects(
    () => service.markUnreceived("c1", "Not received.", "sam@clinic", NOW),
    /money posted against it/
  );
});

test("the sweep never reopens a claim on its own", async () => {
  /**
   * The temptation this feature exists to resist. Letting a timer conclude that silence means
   * non-receipt would be this module deciding an outcome no payer has stated — and on a claim that
   * was merely slow, it manufactures the duplicate denial the replacement gate exists to prevent.
   */
  const { repo, service } = harness();
  await repo.save(claimAt({ id: "c1", filingDeadline: "2026-09-18" }));

  await service.sweepSilentClaims(NOW);
  await service.sweepSilentClaims(at("2026-09-30"));

  assert.equal((await repo.getById("c1"))!.status, "submitted");
});
