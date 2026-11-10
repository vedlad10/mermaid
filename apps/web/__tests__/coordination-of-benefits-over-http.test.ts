/**
 * Coordination of benefits, driven the way an operator drives it — over the real HTTP API.
 *
 * The engine tests prove the rules; these prove a person meets them: a coordination advice opens a
 * case, a free-text release is refused, missing evidence is listed item by item, a structured answer
 * unlocks release, and the secondary claim moves through its states to closed — while the money
 * assigned to the other plan is never counted as collected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox, type ClaimSubmittedBody } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { createApp, type Services } from "../server.ts";
import { buildServices } from "../wiring.ts";

const CLAIM = "MRM-COBHTTP0001";

async function withApp(fn: (base: string, services: Services) => Promise<void>): Promise<void> {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  // The claim the practice filed — gives the case a service date, hence a deadline.
  await services.remittance.recordExpectation({
    claimId: "claim-cob-http",
    verificationId: "ver-cob-http",
    submittedAt: "2026-09-01T10:00:00.000Z",
    submittedBy: "biller@clinic",
    patient: { firstName: "Kira", lastName: "Demo", dateOfBirth: "1990-04-12", memberId: "DEMO0123" },
    payerId: "cigna-dental",
    payerName: "Cigna Dental",
    patientControlNumber: CLAIM,
    payerControlNumber: "556677889",
    totalFee: cents(1425),
    expectedInsurancePays: cents(799.99),
    serviceDate: "2026-08-19",
  } as ClaimSubmittedBody);
  const server = createApp(services);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, services);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Cigna forwards the claim (CLP02 19) and assigns $482.51 to another plan under OA-23. */
const cob835 = (): string =>
  [
    "ISA*00*          *00*          *ZZ*Cigna Dental   *ZZ*CLINIC         *260901*0000*^*00501*000000001*0*P*:",
    "GS*HP*Cigna Dental*CLINIC*20260901*0000*1*X*005010X221A1",
    "ST*835*0001",
    "BPR*I*799.99*C*ACH************20260901",
    "TRN*1*EFTCOBHTTP01*Cigna Dent",
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

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as any });
/**
 * The in-memory composition runs without login, so the acting person comes from the body — the same
 * contract `releasedBy` follows. A signed-in deployment takes it from the session instead.
 */
const post = (base: string, path: string, body: Record<string, unknown>) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "biller@clinic", ...body }),
  }).then(json);
const get = (base: string, path: string) => fetch(base + path).then(json);

test("a coordination advice opens a case, and a sentence cannot release it", async () => {
  await withApp(async (base) => {
    const upload = await fetch(`${base}/api/v1/remittances`, { method: "POST", headers: { "content-type": "text/plain" }, body: cob835() }).then(json);
    assert.equal(upload.body.remittance.status, "held");
    assert.equal(upload.body.canPost, false, "no release button while coverage is unanswered");
    assert.equal(upload.body.coordination[0].coverageStatus, "unconfirmed");

    const cases = await get(base, "/api/v1/coordination-cases?open=1");
    assert.equal(cases.body.items.length, 1);
    const item = cases.body.items[0];
    assert.equal(item.patientControlNumber, CLAIM);
    assert.equal(item.workStatus, "awaiting-coverage");
    assert.equal(item.assignedCents, 48251);
    assert.equal(item.assignedPosted, false, "announced on a held advice — not on the books yet");
    assert.ok(item.deadline, "the secondary claim has a deadline from the existing filing engine");
    assert.equal(item.deadline.estimated, true, "and it says it is an estimate");
    assert.equal(item.crossoverCarrier, null, "the payer named no other plan, so none is shown");

    const release = await post(base, `/api/v1/remittances/${upload.body.remittance.id}/release`, {
      releasedBy: "biller@clinic",
      reason: "Reconciled against the payer's paper EOB",
    });
    assert.equal(release.status, 409);
    assert.equal(release.body.error.code, "coverage-unconfirmed");
  });
});

test("missing evidence is listed item by item, and nothing is recorded", async () => {
  await withApp(async (base) => {
    await fetch(`${base}/api/v1/remittances`, { method: "POST", headers: { "content-type": "text/plain" }, body: cob835() });
    const [item] = (await get(base, "/api/v1/coordination-cases")).body.items;
    const refused = await post(base, `/api/v1/coordination-cases/${item.caseId}/confirm-coverage`, { outcome: "other-coverage" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "coverage-evidence-missing");
    assert.deepEqual(refused.body.error.missing, [
      "Where the answer came from: payer portal, payer phone call, the patient, the payer's eligibility response, or other.",
      "The date the answer was obtained.",
      "The other plan's payer name.",
      "The patient's member ID on the other plan.",
    ]);
    const after = (await get(base, `/api/v1/coordination-cases/${item.caseId}`)).body;
    assert.equal(after.coverageStatus, "unconfirmed");
  });
});

test("confirmed other coverage unlocks release, and the secondary claim runs to closed", async () => {
  await withApp(async (base, services) => {
    const upload = (await fetch(`${base}/api/v1/remittances`, { method: "POST", headers: { "content-type": "text/plain" }, body: cob835() }).then(json)).body;
    const [item] = (await get(base, "/api/v1/coordination-cases")).body.items;

    const confirmed = await post(base, `/api/v1/coordination-cases/${item.caseId}/confirm-coverage`, {
      outcome: "other-coverage",
      source: "patient",
      confirmedOn: new Date().toISOString().slice(0, 10),
      secondary: { payerName: "Delta Dental", payerId: "delta-dental", memberId: "DD-778" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.workStatus, "ready-to-file");
    assert.equal(confirmed.body.case.confirmation.secondary.payerName, "Delta Dental");

    const released = await post(base, `/api/v1/remittances/${upload.remittance.id}/release`, { releasedBy: "biller@clinic", reason: "Other coverage confirmed with the patient" });
    assert.equal(released.status, 200);
    assert.equal(released.body.remittance.status, "posted");

    const posted = (await get(base, `/api/v1/coordination-cases/${item.caseId}`)).body;
    assert.equal(posted.assignedPosted, true);
    assert.equal(posted.assignedCents, 48251);

    // The money assigned to the other plan is tracked, not collected.
    const list = (await get(base, "/api/v1/remittances")).body;
    assert.equal(list.totalRecoverable, 0, "coordinated money is not money this payer owes");
    assert.equal(list.totalWithOtherPayers, 48251, "it is money another plan may owe");

    assert.equal((await post(base, `/api/v1/coordination-cases/${item.caseId}/close`, { outcome: "secondary-paid", note: "x" })).status, 409, "nothing filed yet");
    const filed = await post(base, `/api/v1/coordination-cases/${item.caseId}/mark-filed`, { filedOn: new Date().toISOString().slice(0, 10), reference: "DD-CLM-1" });
    assert.equal(filed.body.workStatus, "filed");
    const closed = await post(base, `/api/v1/coordination-cases/${item.caseId}/close`, { outcome: "secondary-paid", note: "Delta paid on its own advice" });
    assert.equal(closed.body.workStatus, "closed");
    assert.equal((await get(base, "/api/v1/coordination-cases?open=1")).body.items.length, 0, "finished work leaves the worklist");
    assert.equal((await services.remittance.listCoordinationCases()).length, 1, "and stays on the record");
  });
});

test("no other coverage confirmed turns the work toward the primary", async () => {
  await withApp(async (base) => {
    await fetch(`${base}/api/v1/remittances`, { method: "POST", headers: { "content-type": "text/plain" }, body: cob835() });
    const [item] = (await get(base, "/api/v1/coordination-cases")).body.items;
    const confirmed = await post(base, `/api/v1/coordination-cases/${item.caseId}/confirm-coverage`, {
      outcome: "no-other-coverage",
      source: "payer-phone",
      confirmedOn: new Date().toISOString().slice(0, 10),
    });
    assert.equal(confirmed.body.workStatus, "return-to-primary");
    assert.match(confirmed.body.blockedReason, /ask the primary to correct its coordination record/i);
    const again = await post(base, `/api/v1/coordination-cases/${item.caseId}/confirm-coverage`, {
      outcome: "other-coverage", source: "patient", confirmedOn: new Date().toISOString().slice(0, 10), secondary: { payerName: "X", memberId: "1" },
    });
    assert.equal(again.status, 409, "a confirmation is never overwritten");
    assert.equal(again.body.error.code, "already-confirmed");
  });
});
