/**
 * Readiness after 0034: held cash, a coverage question, and a secondary claim are three different
 * things, and each is reported by the check that owns it.
 *
 *   money.held_remittance_age         cash nobody is working (a coverage question is not that)
 *   coordination.coverage_unconfirmed a payer said "another plan" and nobody is finding out
 *   coordination.secondary_claims     money assigned to another plan, near or past its deadline
 *
 * Driven through real services and the real monitor readings — no fakes — because the property
 * under test is that the checks agree with the money, and a fake would only agree with itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox, type ClaimSubmittedBody } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices, type Services } from "../wiring.ts";
import {
  COVERAGE_UNCONFIRMED,
  DEFAULT_THRESHOLDS,
  HELD_REMITTANCE_AGE,
  SECONDARY_CLAIMS,
  takeReadings,
  type MonitorReading,
} from "../monitors.ts";
import { buildTodayQueue } from "../today.ts";

const DAY = 86_400_000;
const T0 = new Date("2026-09-20T12:00:00Z");
const after = (days: number) => new Date(T0.getTime() + days * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const CLAIM = "MRM-COBREADY01";

async function withCoordinationHold(serviceDate = "2026-08-19"): Promise<{ services: Services; remittanceId: string; caseId: string }> {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  await services.remittance.recordExpectation({
    claimId: "claim-ready",
    verificationId: "ver-ready",
    submittedAt: "2026-08-20T10:00:00.000Z",
    submittedBy: "biller@clinic",
    patient: { firstName: "Kira", lastName: "Demo", dateOfBirth: "1990-04-12", memberId: "DEMO0123" },
    payerId: "cigna-dental",
    payerName: "Cigna Dental",
    patientControlNumber: CLAIM,
    payerControlNumber: "556677889",
    totalFee: cents(1425),
    expectedInsurancePays: cents(799.99),
    serviceDate,
  } as ClaimSubmittedBody);
  const raw =
    [
      "ISA*00*          *00*          *ZZ*Cigna Dental   *ZZ*CLINIC         *260920*0000*^*00501*000000001*0*P*:",
      "GS*HP*Cigna Dental*CLINIC*20260920*0000*1*X*005010X221A1",
      "ST*835*0001",
      "BPR*I*799.99*C*ACH************20260920",
      "TRN*1*EFTREADY01*Cigna Dent",
      "N1*PR*Cigna Dental",
      "N1*PE*MERMAID DEMO DENTAL",
      `CLP*${CLAIM}*19*1425.00*799.99*0.00*CI*333273831`,
      "NM1*QC*1*Demo*Kira****MI*DEMO0123",
      "SVC*AD:D2750*1425.00*799.99**1",
      "CAS*CO*45*142.50",
      "CAS*OA*23*482.51",
      "SE*11*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~";
  const view = await services.remittance.ingestRaw(raw, T0);
  const [c] = await services.remittance.listCoordinationCases();
  return { services, remittanceId: view.remittance.id, caseId: c!.id };
}

const read = async (services: Services, now: Date) => {
  const readings = await takeReadings(services, DEFAULT_THRESHOLDS, now, "this-practice");
  const byKey = (key: string) => readings.find((r) => r.key === key) as MonitorReading;
  return { held: byKey(HELD_REMITTANCE_AGE), coverage: byKey(COVERAGE_UNCONFIRMED), secondary: byKey(SECONDARY_CLAIMS) };
};

test("a coverage question is not reported as neglected cash — it is reported as what it is", async () => {
  const { services } = await withCoordinationHold();
  const { held, coverage } = await read(services, after(5));
  assert.equal(held.breaching, false, "the held-age check is for cash nobody is working");
  assert.equal(held.detail.heldCount, 0);
  assert.equal(coverage.breaching, true, "nobody has asked, five days on");
  assert.deepEqual(coverage.detail.unasked, [CLAIM]);
  assert.match(coverage.message, /with nobody asking, past the review window/);
});

test("inside the review window a new question is not yet an alert", async () => {
  const { services } = await withCoordinationHold();
  const { coverage } = await read(services, after(1));
  assert.equal(coverage.breaching, false);
  assert.match(coverage.message, /raised within the review window, not yet asked/);
});

test("a question someone is following up is work in progress — until the follow-up date passes", async () => {
  const { services, caseId } = await withCoordinationHold();
  await services.remittance.requestCoverageConfirmation(caseId, { from: "patient", requestedOn: iso(after(1)), followUpBy: iso(after(10)) }, "biller@clinic", after(1));

  const waiting = await read(services, after(5));
  assert.equal(waiting.coverage.breaching, false);
  assert.match(waiting.coverage.message, /being followed up by a set date/);

  const late = await read(services, after(11));
  assert.equal(late.coverage.breaching, true);
  assert.match(late.coverage.message, /past the follow-up date someone set/);
});

test("answering the question does not make held cash disappear — it becomes ordinary held cash again", async () => {
  const { services, caseId, remittanceId } = await withCoordinationHold();
  await services.remittance.confirmCoverage(
    caseId,
    { outcome: "other-coverage", source: "patient", confirmedOn: iso(after(2)), secondary: { payerName: "Delta Dental", memberId: "DD-1" } },
    "biller@clinic",
    after(2)
  );
  const answered = await read(services, after(5));
  assert.equal(answered.coverage.breaching, false, "the coverage question is answered");
  assert.equal(answered.held.breaching, true, "but the money is still unposted and nobody has released it");

  await services.remittance.release(remittanceId, "biller@clinic", "Other coverage confirmed", after(5));
  const released = await read(services, after(6));
  assert.equal(released.held.breaching, false, "released: the cash is on the books");
  assert.equal(released.secondary.detail.open, 1, "and the secondary claim is now open work");
  assert.equal(released.secondary.detail.openCents, 48251);
});

test("a secondary claim near its deadline breaches until it is filed", async () => {
  // Service date ~a year back, so the existing engine's estimated window ends within days.
  const { services, caseId, remittanceId } = await withCoordinationHold("2025-10-01");
  await services.remittance.confirmCoverage(
    caseId,
    { outcome: "other-coverage", source: "payer-portal", confirmedOn: iso(after(0)), secondary: { payerName: "Delta Dental", memberId: "DD-1" } },
    "biller@clinic",
    after(0)
  );
  await services.remittance.release(remittanceId, "biller@clinic", "Other coverage confirmed", after(0));

  const urgent = await read(services, after(1));
  assert.equal(urgent.secondary.breaching, true);
  assert.match(urgent.secondary.message, /\$482\.51 is urgent or past the filing deadline and not yet filed/);
  assert.equal(urgent.secondary.detail.deadlinesAreEstimates, true);

  await services.remittance.markSecondaryFiled(caseId, { filedOn: iso(after(1)), reference: "DD-1" }, "biller@clinic", after(1));
  const filed = await read(services, after(2));
  assert.equal(filed.secondary.breaching, false, "filed in time — now waiting on the other plan, not at risk of being lost");
  assert.equal(filed.secondary.detail.open, 1, "still open until the other plan answers — never counted as recovered");
});

test("a system with no coordination has nothing to say about it", async () => {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const { coverage, secondary } = await read(services, T0);
  assert.equal(coverage.breaching, false);
  assert.match(coverage.message, /Every coverage question a payer raised has been answered/);
  assert.equal(secondary.breaching, false);
  assert.match(secondary.message, /No money is waiting on another plan/);
});

// ── Today: the work reaches the board ─────────────────────────────────────────────────────────


test("Today lists a held coordination advice once, then its secondary claim once posted", async () => {
  const { services, caseId, remittanceId } = await withCoordinationHold();

  const held = (await buildTodayQueue(services, 50, after(1))).items.filter((i) => i.id === remittanceId);
  assert.equal(held.length, 1, "the held advice is one row — its action already asks the coverage question");
  assert.match(held[0]!.action, /^Confirm the patient's other coverage before release/);

  await services.remittance.confirmCoverage(
    caseId,
    { outcome: "other-coverage", source: "patient", confirmedOn: iso(after(1)), secondary: { payerName: "Delta Dental", memberId: "DD-1" } },
    "biller@clinic",
    after(1)
  );
  await services.remittance.release(remittanceId, "biller@clinic", "Other coverage confirmed", after(1));

  const posted = (await buildTodayQueue(services, 50, after(2))).items.filter((i) => i.id === remittanceId);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.subtitle, /\$482\.51 assigned to another plan · ready to file/);
  assert.match(posted[0]!.action, /File the secondary claim with Delta Dental/);
  assert.equal(posted[0]!.amount, 48251, "the amount at risk — not collected money");
  assert.equal(posted[0]!.dueDateEstimated, true);

  await services.remittance.markSecondaryFiled(caseId, { filedOn: iso(after(2)) }, "biller@clinic", after(2));
  await services.remittance.closeSecondaryWork(caseId, { outcome: "secondary-paid", note: "Delta paid" }, "biller@clinic", after(3));
  const done = (await buildTodayQueue(services, 50, after(4))).items.filter((i) => i.id === remittanceId);
  assert.equal(done.length, 0, "finished work leaves the board");
});
