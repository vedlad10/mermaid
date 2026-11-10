/**
 * "Verify all due" — the rules that decide what one click sends to a clearinghouse.
 *
 * Every check is a real eligibility request that a live clearinghouse bills for, so the assertions
 * here are mostly about what is NOT sent: visits that are fine, visits a re-check cannot help, a
 * patient checked moments ago, a second request for the same person, a visit fixed since the screen
 * was drawn, and anything past the per-click limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppointmentService,
  MAX_PATIENTS_PER_RUN,
  RECHECK_COOLDOWN_MS,
  type AppointmentUnitOfWork,
  type VerifyFn,
} from "../appointment-service.ts";
import { InMemoryAppointmentRepository, type ScheduledVisit } from "../appointments.ts";
import { InMemoryPatientDirectory } from "../patients.ts";
import { InMemoryVerificationRepository } from "../repository.ts";
import type { VerificationInput } from "../pipeline.ts";
import type { VerificationRecord } from "../types.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

let seq = 0;
const person = (first: string) => ({ firstName: first, lastName: "Test", dateOfBirth: "1980-01-01" });

function setup() {
  const patients = new InMemoryPatientDirectory();
  const verifications = new InMemoryVerificationRepository();
  let units = 0;
  const uow: AppointmentUnitOfWork = { run: (fn) => { units += 1; return fn(); } };
  const service = new AppointmentService(new InMemoryAppointmentRepository(), patients, verifications, "UTC", uow);

  /** Book a visit and, optionally, give the patient a prior verification. */
  async function book(
    first: string,
    hoursAhead: number,
    prior?: { status?: string; ageDays?: number; cardText?: string; eligibility?: string; ageMinutes?: number },
    over: Partial<ScheduledVisit> = {}
  ): Promise<string> {
    const externalId = `V-${++seq}`;
    await service.sync("csv", [{
      externalId, scheduledFor: at(hoursAhead), status: "scheduled", patient: person(first),
      plannedProcedures: [{ code: "D1110", feeCents: 12_000 }], ...over,
    }], NOW);
    const [item] = (await service.list(new Date(NOW.getTime() - DAY), new Date(NOW.getTime() + 20 * DAY)))
      .filter((a) => a.externalId === externalId);
    if (prior) {
      const memberId = `M-${first}`;
      await patients.linkCoverage(item!.patientId, memberId, "delta");
      const ageMs = (prior.ageMinutes ?? 0) * 60_000 + (prior.ageDays ?? 1) * DAY * (prior.ageMinutes ? 0 : 1);
      await verifications.save({
        id: `v-${first}-${seq}`,
        createdAt: new Date(NOW.getTime() - ageMs).toISOString(),
        status: prior.status ?? "verified",
        patientId: item!.patientId,
        patient: { ...person(first), memberId },
        card: { memberId: { value: memberId } },
        cardText: prior.cardText ?? `Delta Dental\nMember ID: ${memberId}`,
        planItems: [{ code: "D0120", quantity: 1 }],
        benefits: { eligibility: prior.eligibility ?? "active", coverage: { effectiveDate: null, terminationDate: null } },
        review: null,
      } as unknown as VerificationRecord);
    }
    return item!.id;
  }

  /**
   * A verify that records what it was asked and answers "verified, active" — and SAVES the record,
   * as the real `VerificationService.create` does, matched to the patient by member ID the way a
   * real record is. Without the save, a second run would still see the old check.
   */
  const calls: VerificationInput[] = [];
  const verify: VerifyFn = async (input, now) => {
    calls.push(input);
    const record = {
      id: `new-${calls.length}`, createdAt: now.toISOString(), status: "verified",
      patient: input.patient, card: { memberId: { value: input.patient.memberId } }, cardText: input.cardText,
      planItems: input.planItems, review: null,
      benefits: { eligibility: "active", coverage: { effectiveDate: null, terminationDate: null } },
    } as unknown as VerificationRecord;
    await verifications.save(record);
    return { record };
  };
  return { service, book, verify, calls, units: () => units, verifications, patients };
}

test("the preview lists only not-ready visits in the next three days, each marked check or skip with a reason", async () => {
  const { service, book } = setup();
  await book("Fresh", 24, { ageDays: 1 });                       // verified → not listed
  const stale = await book("Stale", 24, { ageDays: 40 });        // expired by the visit → check
  const failed = await book("Failed", 30, { status: "failed" });  // last check failed → check
  const inactive = await book("Inactive", 36, { eligibility: "inactive" }); // payer said inactive → check
  const review = await book("Review", 40, { status: "needs_review" }); // a person must decide → skip
  const none = await book("Nobody", 44);                          // no insurance on file → skip
  await book("Later", 24 * 5, { ageDays: 40 });                   // outside the 3-day window

  const due = await service.due(NOW);
  const by = new Map(due.visits.map((v) => [v.appointmentId, v]));
  assert.equal(due.horizonDays, 3);
  assert.deepEqual(new Set(due.visits.map((v) => v.appointmentId)), new Set([stale, failed, inactive, review, none]));
  assert.equal(by.get(stale)!.will, "check");
  assert.equal(by.get(failed)!.will, "check");
  assert.equal(by.get(inactive)!.will, "check");
  assert.match(by.get(inactive)!.reason, /payer said inactive/i);
  assert.equal(by.get(review)!.will, "skip");
  assert.match(by.get(review)!.reason, /waiting for a person/);
  assert.equal(by.get(none)!.will, "skip");
  assert.match(by.get(none)!.reason, /No insurance on file/);
  assert.equal(due.checks, 3, "counted in PATIENTS");
});

test("a patient checked minutes ago is not checked again, and a card nobody entered is never invented", async () => {
  const { service, book } = setup();
  const recent = await book("Recent", 24, { status: "failed", ageMinutes: 5 });
  const noCard = await book("NoCard", 24, { status: "failed", cardText: "" });
  const due = await service.due(NOW);
  const by = new Map(due.visits.map((v) => [v.appointmentId, v]));
  assert.equal(by.get(recent)!.will, "skip");
  assert.match(by.get(recent)!.reason, new RegExp(`Wait ${RECHECK_COOLDOWN_MS / 60_000} minutes`));
  assert.equal(by.get(noCard)!.will, "skip");
  assert.match(by.get(noCard)!.reason, /No card on file/);
  assert.equal(due.checks, 0);
});

test("a run sends ONE request per patient, from the card on file, priced against the visit", async () => {
  const { service, book, verify, calls } = setup();
  const first = await book("Twice", 24, { ageDays: 40 }, { plannedProcedures: [{ code: "D2750", feeCents: 125_000 }] });
  const second = await book("Twice", 48, { ageDays: 40 });
  const run = await service.runDue([first, second], verify, NOW);

  assert.equal(run.checked, 1);
  assert.equal(calls.length, 1, "two visits, one patient, one eligibility request");
  assert.match(calls[0]!.cardText, /Member ID: M-Twice/);
  assert.equal(calls[0]!.patient.firstName, "Twice");
  assert.deepEqual(calls[0]!.planItems, [{ code: "D2750", quantity: 1, fee: 125_000 }], "the soonest visit's plan, not the old check's");
  assert.deepEqual(run.results.map((r) => [r.appointmentId, r.outcome, r.readiness?.state]).sort(), [
    [first, "checked", "verified"],
    [second, "checked", "verified"],
  ].sort());
});

test("what is due is re-derived at the click: a visit fixed since the preview is not checked twice", async () => {
  const { service, book, verify, calls } = setup();
  const id = await book("Once", 24, { ageDays: 40 });
  const firstRun = await service.runDue([id], verify, NOW);
  assert.equal(firstRun.checked, 1);

  // The same click again (a stale screen, a second tab): the visit is verified now.
  const again = await service.runDue([id], verify, new Date(NOW.getTime() + RECHECK_COOLDOWN_MS + 60_000));
  assert.equal(again.checked, 0);
  assert.equal(calls.length, 1);
  assert.equal(again.results[0]!.outcome, "not-run");
  assert.match(again.results[0]!.message, /No longer due/);
});

test("only the visits a person asked for are checked, and skips are reported, not sent", async () => {
  const { service, book, verify, calls } = setup();
  const a = await book("Asked", 24, { ageDays: 40 });
  await book("NotAsked", 24, { ageDays: 40 });
  const review = await book("Review", 24, { status: "needs_review" });
  const run = await service.runDue([a, review, "not-a-visit"], verify, NOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.patient.firstName, "Asked");
  const by = new Map(run.results.map((r) => [r.appointmentId, r]));
  assert.equal(by.get(review)!.outcome, "not-run");
  assert.equal(by.get("not-a-visit")!.outcome, "not-run");
});

test("one patient's failure is that patient's: the rest of the run goes on", async () => {
  const { service, book, calls } = setup();
  const bad = await book("Timeout", 20, { ageDays: 40 });
  const good = await book("Fine", 22, { ageDays: 40 });
  const verify: VerifyFn = async (input, now) => {
    calls.push(input);
    if (input.patient.firstName === "Timeout") throw new Error("clearinghouse timed out after 30s");
    return { record: { id: "ok", createdAt: now.toISOString(), status: "verified", benefits: { eligibility: "active" } } as unknown as VerificationRecord };
  };
  const run = await service.runDue([bad, good], verify, NOW);
  const by = new Map(run.results.map((r) => [r.appointmentId, r]));
  assert.equal(by.get(bad)!.outcome, "error");
  assert.match(by.get(bad)!.message, /timed out/);
  assert.equal(by.get(good)!.outcome, "checked");
  assert.equal(run.checked, 2, "both were sent; one came back as an error");
});

test("a check that comes back not-ready says so — a run does not paint everything green", async () => {
  const { service, book } = setup();
  const id = await book("StillInactive", 24, { eligibility: "inactive" });
  const verify: VerifyFn = async (_input, now) => ({
    record: { id: "x", createdAt: now.toISOString(), status: "verified", benefits: { eligibility: "inactive" } } as unknown as VerificationRecord,
  });
  const [r] = (await service.runDue([id], verify, NOW)).results;
  assert.equal(r!.outcome, "checked");
  assert.equal(r!.readiness!.state, "inactive");
  assert.equal(r!.verificationId, "x");
});

test(`one click checks at most ${MAX_PATIENTS_PER_RUN} patients, soonest first; the rest are reported`, async () => {
  const { service, book, verify, calls } = setup();
  const ids: string[] = [];
  for (let i = 0; i < MAX_PATIENTS_PER_RUN + 2; i++) ids.push(await book(`P${String(i).padStart(2, "0")}`, 2 + i, { ageDays: 40 }));
  const run = await service.runDue(ids, verify, NOW);
  assert.equal(run.checked, MAX_PATIENTS_PER_RUN);
  assert.equal(calls.length, MAX_PATIENTS_PER_RUN);
  const over = run.results.filter((r) => r.outcome === "not-run");
  assert.deepEqual(over.map((r) => r.appointmentId), ids.slice(MAX_PATIENTS_PER_RUN), "the latest visits wait for the next run");
  assert.match(over[0]!.message, /limit for one run/);
});

test("each check runs in its own unit of work, so one failure cannot undo another's write", async () => {
  const { service, book, verify, units } = setup();
  const a = await book("UowA", 24, { ageDays: 40 });
  const b = await book("UowB", 26, { ageDays: 40 });
  const before = units();
  await service.runDue([a, b], verify, NOW);
  // One for reading what is due, then one per patient checked.
  assert.equal(units() - before, 1 + 2);
});

test("with two plans, the re-check uses the card of the plan the visit rests on — not the last card typed", async () => {
  const { service, book, verify, calls, verifications, patients } = setup();
  // Primary: checked forty days ago, so out of date by the visit.
  const id = await book("TwoPlans", 24, { ageDays: 40 });
  const [visit] = (await service.due(NOW)).visits;
  // Secondary: a different payer and member ID, checked more recently, and it failed.
  await patients.linkCoverage(visit!.patientId, "SEC-999", "metlife");
  await verifications.save({
    id: "secondary-run",
    createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    status: "failed",
    payerId: "metlife",
    patientId: visit!.patientId,
    patient: { ...person("TwoPlans"), memberId: "SEC-999" },
    card: { memberId: { value: "SEC-999" } },
    cardText: "MetLife Dental\nMember ID: SEC-999",
    planItems: [{ code: "D0120", quantity: 1 }],
    benefits: null,
    review: null,
  } as unknown as VerificationRecord);

  const due = await service.due(NOW);
  assert.equal(due.visits[0]!.state, "stale", "the primary's out-of-date check is the answer, not the secondary's failure");
  await service.runDue([id], verify, NOW);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cardText, /Member ID: M-TwoPlans/, "the primary's card");
  assert.doesNotMatch(calls[0]!.cardText, /SEC-999/, "not the secondary's, though it was entered last");
});
