/**
 * The Unified Patient Financial Record, assembled (M14 deliverable 4) — driven over the real HTTP
 * contract, through the composition root that actually ships.
 *
 * `vertical-patient-record.test.ts` asserts the DATA property: one human is one record, however many
 * member IDs they hold. This file asserts the READ property that finally makes that visible — that
 * the record a person opens is complete, that its money agrees with the modules it was assembled
 * from, and that a member-ID change does not split one patient's history in two.
 *
 * It is deliberately end-to-end rather than a unit test of `buildPatientRecord`. The whole risk in a
 * composed view is in the joins between contexts, and a test that hands the composer its inputs
 * proves only that the composer can add up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../apps/web/server.ts";
import { testServices } from "../apps/web/__tests__/server.test.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(testServices());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function req(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** The same human every time — the identity resolves on surname, given name, date of birth. */
const ADA = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

const visit = (memberId: string, cardText: string) => ({
  patient: { ...ADA, memberId, address: SYNTHETIC_ADDRESS },
  cardText,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
});

/** Settles cleanly and pays. */
const DELTA = () => visit("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");
/** A different employer a year later — member IDs ending 77 hit a recoverable pre-auth denial. */
const METLIFE = () => visit("MET30077", "MetLife Dental\nMember ID: MET30077");

async function fileClaim(base: string, body: ReturnType<typeof visit>) {
  const created = await req(base, "POST", "/api/v1/verifications", body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
    /**
   * Fetched WITHOUT the `ready` filter and given an authorisation first: a "...77" plan requires
   * pre-authorisation, so the submit gate holds the claim at `draft` until a decision is on record.
   * The payer then refuses under CARC 197 anyway — an authorisation is permission to treat, never a
   * guarantee of payment.
   */
  const { items: allClaims } = (await req(base, "GET", "/api/v1/claims")).json;
  const items = allClaims.filter((c: { status: string }) => c.status === "draft" || c.status === "ready");
  const claim = items.at(-1);
  await req(base, "POST", `/api/v1/claims/${claim.id}/preauth`, {
    status: "approved", source: "payer-portal", referenceNumber: "AUTH-TEST-1", recordedBy: "office.manager@clinic",
  });
  const filed = await req(base, "POST", `/api/v1/claims/${claim.id}/submit`, { submittedBy: "office.manager@clinic" });
  assert.equal(filed.status, 200, JSON.stringify(filed.json));
  return filed.json.claim;
}

/** Find Ada in the patient master and return her id. */
async function findAda(base: string): Promise<string> {
  const { status, json } = await req(base, "GET", "/api/v1/patients/directory?q=alpha");
  assert.equal(status, 200);
  assert.equal(json.items.length, 1, "one human is one record, whatever they were searched by");
  return json.items[0].id;
}

/** Ada's whole history: two employers, two plans, one of them denied and appealed. */
async function twoYearsOfAda(base: string): Promise<string> {
  await fileClaim(base, DELTA());
  await fileClaim(base, METLIFE());
  await req(base, "POST", "/api/v1/remittances/fetch", {});
  return findAda(base);
}

// ── The record itself ─────────────────────────────────────────────────────────────────

test("one person's record spans every member ID they have ever held", async () => {
  await withServer(async (base) => {
    const adaId = await twoYearsOfAda(base);

    const { status, json: record } = await req(base, "GET", `/api/v1/patients/record/${adaId}`);
    assert.equal(status, 200);

    assert.equal(record.patient.firstName, "Ada");
    assert.deepEqual(
      record.provenance.memberIds.slice().sort(),
      ["ABC12345", "MET30077"],
      "both plans resolve to the one person — this is the join the whole record hangs on"
    );
    assert.equal(record.verifications.length, 2, "both coverage checks belong to this person");
    assert.equal(record.claims.length, 2, "and both claims filed under them");
    assert.equal(record.coverages.length, 2);
    for (const coverage of record.coverages) {
      assert.ok(coverage.payerName, "a coverage the practice has actually used knows its payer");
      assert.equal(coverage.claimCount, 1);
    }
  });
});

test("the record reaches every context — verification, claim, denial, appeal, ledger", async () => {
  await withServer(async (base) => {
    const adaId = await twoYearsOfAda(base);
    const { json: record } = await req(base, "GET", `/api/v1/patients/record/${adaId}`);

    assert.ok(record.verifications.length > 0, "verification");
    assert.ok(record.claims.length > 0, "claim");
    assert.ok(record.denials.length > 0, "the MetLife pre-auth denial must reach the patient's record");
    assert.ok(record.ledger, "the payer left this patient a balance, so there is a ledger");
    assert.ok(record.ledger.entries.length > 0);

    // Every phase of the cycle appears in the one chronological spine.
    const phases = new Set(record.timeline.map((e: any) => e.phase));
    for (const expected of ["verification", "estimate", "submission", "posting", "denial", "ledger"]) {
      assert.ok(phases.has(expected), `the timeline is missing the ${expected} phase`);
    }
  });
});

test("the timeline is ordered oldest-first and every entry names who did it", async () => {
  await withServer(async (base) => {
    const adaId = await twoYearsOfAda(base);
    const { json: record } = await req(base, "GET", `/api/v1/patients/record/${adaId}`);

    const times = record.timeline.map((e: any) => e.at);
    assert.deepEqual(times, times.slice().sort(), "a history out of order is not a history");

    for (const entry of record.timeline) {
      assert.ok(entry.at && entry.title && entry.detail, "every entry says what happened");
      assert.ok(entry.actor, "and who did it — 'system' or a named person, never blank");
    }

    // The submit gate is a human act, and the record must show which human.
    const submitted = record.timeline.filter((e: any) => e.phase === "submission");
    assert.ok(submitted.length > 0);
    for (const entry of submitted) {
      assert.equal(entry.actor, "office.manager@clinic", "a claim released to a payer names its releaser");
    }
  });
});

test("the money on the record agrees with the modules it was assembled from", async () => {
  await withServer(async (base) => {
    const adaId = await twoYearsOfAda(base);
    const { json: record } = await req(base, "GET", `/api/v1/patients/record/${adaId}`);

    const live = record.claims.filter((c: any) => c.status !== "void");
    assert.equal(
      record.totals.billed,
      live.reduce((t: number, c: any) => t + c.totalFee, 0),
      "the record never recomputes what a claim billed — it adds up what the claims say"
    );
    assert.equal(record.totals.paidByPayers, live.reduce((t: number, c: any) => t + c.paidAmount, 0));
    assert.equal(record.totals.balance, record.ledger.account.balance, "one person, one balance");
    assert.equal(
      record.totals.balance,
      record.totals.chargedToPatient - record.totals.paidByPatient - record.totals.forgiven,
      "the balance is a fold over the entries, and the totals must not disagree with it"
    );
  });
});

test("a payment taken at the desk lands on the record, attributed", async () => {
  await withServer(async (base) => {
    const adaId = await twoYearsOfAda(base);
    const before = (await req(base, "GET", `/api/v1/patients/record/${adaId}`)).json;
    assert.ok(before.totals.balance > 0, "the fixture must leave this patient owing something");

    // Paid against ONE of her two accounts — the unified record must still show one balance.
    const account = before.ledger.entries.find((e: any) => e.kind === "charge");
    const paid = await req(base, "POST", `/api/v1/patients/${account.patientKey}/payment`, {
      amountDollars: 10,
      recordedBy: "front.desk@clinic",
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));

    const after = (await req(base, "GET", `/api/v1/patients/record/${adaId}`)).json;
    assert.equal(after.totals.balance, before.totals.balance - 1000, "$10 in cents, off the one balance");
    assert.equal(after.totals.paidByPatient, before.totals.paidByPatient + 1000);

    const payment = after.timeline.filter((e: any) => e.title.startsWith("Payment received"));
    assert.equal(payment.length, 1);
    assert.equal(payment[0].actor, "front.desk@clinic", "money leaving a balance always names a person");
    assert.equal(payment[0].amount, 1000, "shown as a positive magnitude — the direction is in the title");
  });
});

// ── The empty and the missing ─────────────────────────────────────────────────────────

test("a patient who was verified but never billed has a record, not an error", async () => {
  await withServer(async (base) => {
    // Inactive coverage: nothing settles, so no claim and no ledger ever exist for this person.
    const created = await req(base, "POST", "/api/v1/verifications", {
      patient: { firstName: "Ben", lastName: "Beta", dateOfBirth: "1988-02-02", memberId: "MEM10000" , address: SYNTHETIC_ADDRESS},
      cardText: "Delta Dental\nMember ID: MEM10000",
      planItems: [{ code: "D0120", quantity: 1 }],
    });
    assert.equal(created.status, 201);

    const { items } = (await req(base, "GET", "/api/v1/patients/directory?q=beta")).json;
    assert.equal(items.length, 1, "a patient exists whatever the verification concluded");

    const { status, json: record } = await req(base, "GET", `/api/v1/patients/record/${items[0].id}`);
    assert.equal(status, 200);
    assert.equal(record.claims.length, 0);
    assert.equal(record.ledger, null, "no financial history is a state, not a zero balance");
    assert.equal(record.totals.balance, 0);
    assert.ok(record.timeline.length > 0, "the coverage check itself is history worth showing");
  });
});

test("an unknown patient id is a 404, indistinguishable from another practice's patient", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/api/v1/patients/record/00000000-0000-4000-8000-000000000000");
    assert.equal(status, 404);
    assert.equal(json.error.code, "not_found");
  });
});

// ── The directory ─────────────────────────────────────────────────────────────────────

test("the directory lists people, not accounts — and searches by name or chart id", async () => {
  await withServer(async (base) => {
    await twoYearsOfAda(base);

    const all = (await req(base, "GET", "/api/v1/patients/directory")).json;
    assert.ok(all.items.length >= 1);

    const ada = all.items.find((p: any) => p.lastName === "Alpha");
    assert.ok(ada, "Ada is one person in the directory despite holding two member IDs");

    const byName = (await req(base, "GET", "/api/v1/patients/directory?q=Ada")).json;
    assert.equal(byName.items.length, 1);
    const byChart = (await req(base, "GET", `/api/v1/patients/directory?q=${ada.chartId}`)).json;
    assert.equal(byChart.items.length, 1);
    assert.equal(byChart.items[0].id, ada.id);

    const miss = (await req(base, "GET", "/api/v1/patients/directory?q=nobodyhere")).json;
    assert.equal(miss.items.length, 0, "an empty search is an empty list, never everything");
  });
});
