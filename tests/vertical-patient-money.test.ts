/**
 * The patient's half of every dollar, end to end.
 *
 * card text → verification → claim → payer's 835 → **the part the payer left the patient** → a
 * balance that ages, is chased, is paid, and shows up in the practice report.
 *
 * The assertion this file exists for is that money the payer does not pay does not disappear.
 * Through M8 it did: a posting recorded `patientResponsibility` and nothing consumed it, and a
 * denial closed as "bill the patient" charged nobody. Every test here is a different way of asking
 * "where did that money go?" and getting an answer.
 *
 * Driven over the real HTTP contract, through the composition root that actually ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../apps/web/server.ts";
import { testServices } from "../apps/web/__tests__/server.test.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
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

const visit = (first: string, memberId: string, cardText: string) => ({
  patient: { firstName: first, lastName: "Patient", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, feeDollars: 110 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
});

const CLEAN = () => visit("Ada", "ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");
const PREAUTH = () => visit("Dev", "MET30077", "MetLife Dental\nMember ID: MET30077");

async function fileClaim(base: string, body: ReturnType<typeof visit>) {
  await req(base, "POST", "/api/v1/verifications", body);
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

/** Verify, file, and let the payer rule. Returns the claim and the posting it produced. */
async function throughPayment(base: string, body = CLEAN()) {
  const claim = await fileClaim(base, body);
  const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
  const posting = fetched.json.items
    .flatMap((v: { remittance: { postings: unknown[] } }) => v.remittance.postings)
    .find((p: { claimId: string }) => p.claimId === claim.id);
  return { claim, posting };
}

// ── The charge nobody had to type ─────────────────────────────────────────────────────

test("what the payer leaves the patient becomes a balance, with no human involved", async () => {
  await withServer(async (base) => {
    const { claim, posting } = await throughPayment(base);
    assert.ok(posting.patientResponsibility > 0, "this scenario is only meaningful if the payer left a balance");

    const { status, json } = await req(base, "GET", `/api/v1/patients/${claim.patient.memberId}`);
    assert.equal(status, 200);
    assert.equal(json.account.balance, posting.patientResponsibility);
    assert.equal(json.account.patientName, "Ada Patient");
    assert.equal(json.entries.length, 1);
    assert.equal(json.entries[0].recordedBy, "system", "a charge from the cycle is not a person's act");
    assert.equal(json.entries[0].claimId, claim.id, "every line traces back to the claim that caused it");
  });
});

test("the statement explains how the number was arrived at", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const { json } = await req(base, "GET", `/api/v1/patients/${claim.patient.memberId}`);

    assert.ok(json.statementLines.length >= 2);
    assert.match(json.statementLines[0], /Ada Patient owes/);
    assert.ok(
      json.statementLines.some((l: string) => /Delta Dental/.test(l)),
      "a balance a patient cannot trace to a payer decision is the start of every billing dispute"
    );
  });
});

test("re-pulling the payer's advice does not charge the patient twice", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const before = (await req(base, "GET", `/api/v1/patients/${claim.patient.memberId}`)).json;

    // The exact shape of an at-least-once redelivery.
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const after = (await req(base, "GET", `/api/v1/patients/${claim.patient.memberId}`)).json;
    assert.equal(after.account.balance, before.account.balance);
    assert.equal(after.entries.length, before.entries.length);
  });
});

// ── The denial that used to charge nobody ─────────────────────────────────────────────

test("a denial closed as the patient's lands on their account — it used to vanish", async () => {
  await withServer(async (base) => {
    await throughPayment(base, PREAUTH());
    const denial = (await req(base, "GET", "/api/v1/denials?open=1")).json.items.find(
      (d: { carcCode: string }) => d.carcCode === "197"
    );
    assert.ok(denial, "the pre-auth denial never arrived");

    const before = (await req(base, "GET", "/api/v1/patients/MET30077")).json;
    const beforeBalance = before.account?.balance ?? 0;

    /**
     * ── THIS DENIAL IS `CO`, SO BILLING IT NEEDS A DELIBERATE OVERRIDE (NEW-07) ────────────────
     *
     * CARC 197 arrived under adjustment group CO — "Contractual Obligation", which is the payer
     * saying, by the definition of the group, that this is PROVIDER liability. Failing to obtain a
     * pre-authorization is the practice's omission, not the patient's, and the contract says so.
     *
     * The close path used to accept this without a murmur, which is what the finding names: the
     * automatic path refused it (`categorizeAdjustment` sends contractual money to `post_normal`)
     * while the manual one, gated only on `denials.write`, let any biller move it to a patient's
     * statement.
     *
     * It is still reachable, because the case in this test is a real one — a patient who was told
     * beforehand and agreed to self-pay is exactly when a practice may bill it. It now takes the
     * contractual-override permission and lands in the denial's audit trail saying so.
     */
    const refused = await req(base, "POST", `/api/v1/denials/${denial.id}/close`, {
      as: "patient_billed",
      reason: "No pre-authorization was obtainable; the patient agreed to self-pay.",
      closedBy: "biller@clinic",
    });
    assert.equal(refused.status, 409, "a CO adjustment is not the patient's to be billed by default");
    assert.match(refused.json.error.message, /contractual/i);

    const closed = await req(base, "POST", `/api/v1/denials/${denial.id}/close`, {
      as: "patient_billed",
      reason: "No pre-authorization was obtainable; the patient agreed to self-pay.",
      closedBy: "biller@clinic",
      overrideContractualBar: true,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.match(
      closed.json.denial.audit.at(-1).message,
      /OVERRIDE/,
      "the decision to bill a patient for a contractual adjustment must be on the record, in the " +
        "denial itself — not only in a permission somebody once held"
    );

    const after = (await req(base, "GET", "/api/v1/patients/MET30077")).json;
    assert.equal(after.account.balance, beforeBalance + denial.deniedAmount);

    const entry = after.entries.find((e: { denialId: string | null }) => e.denialId === denial.id);
    assert.ok(entry, "the charge must be traceable to the denial that caused it");
    assert.equal(entry.recordedBy, "biller@clinic", "the person who decided is on the record");
    assert.match(entry.description, /agreed to self-pay/);
  });
});

test("a denial WRITTEN OFF charges nobody — that is what writing it off means", async () => {
  await withServer(async (base) => {
    await throughPayment(base, PREAUTH());
    const denial = (await req(base, "GET", "/api/v1/denials?open=1")).json.items.find(
      (d: { carcCode: string }) => d.carcCode === "197"
    );
    const before = (await req(base, "GET", "/api/v1/patients/MET30077")).json;

    await req(base, "POST", `/api/v1/denials/${denial.id}/close`, {
      as: "written_off",
      reason: "Our error — no pre-auth was requested.",
      closedBy: "biller@clinic",
    });

    const after = (await req(base, "GET", "/api/v1/patients/MET30077")).json;
    assert.equal(after.account.balance, before.account.balance);
  });
});

// ── Human gates on the way out ────────────────────────────────────────────────────────

test("a payment reduces the balance and is attributed to the person who took it", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const key = claim.patient.memberId;
    const owed = (await req(base, "GET", `/api/v1/patients/${key}`)).json.account.balance;

    const paid = await req(base, "POST", `/api/v1/patients/${key}/payment`, {
      amountDollars: 25,
      note: "Card, in person",
      recordedBy: "front.desk@clinic",
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.account.balance, owed - 2500);
    assert.equal(paid.json.account.paid, 2500);
    assert.equal(paid.json.entries[0].recordedBy, "front.desk@clinic");
  });
});

test("a write-off needs a reason, and is not counted as money collected", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const key = claim.patient.memberId;
    const owed = (await req(base, "GET", `/api/v1/patients/${key}`)).json.account.balance;

    const refused = await req(base, "POST", `/api/v1/patients/${key}/writeoff`, {
      amountDollars: owed / 100,
      recordedBy: "owner@clinic",
    });
    assert.equal(refused.status, 409, "revenue the practice chooses to lose must never be untraceable");

    const done = await req(base, "POST", `/api/v1/patients/${key}/writeoff`, {
      amountDollars: owed / 100,
      note: "Uncollectable after four statements.",
      recordedBy: "owner@clinic",
    });
    assert.equal(done.status, 200);
    assert.equal(done.json.account.balance, 0);
    assert.equal(done.json.account.paid, 0, "writing off is not collecting");
    assert.equal(done.json.account.forgiven, owed);
  });
});

test("the ledger refuses to go negative by accident", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const key = claim.patient.memberId;

    const over = await req(base, "POST", `/api/v1/patients/${key}/payment`, {
      amountDollars: 10_000,
      recordedBy: "front.desk@clinic",
    });
    assert.equal(over.status, 409);
    assert.match(over.json.error.message, /more than the/);
  });
});

// ── The practice view ─────────────────────────────────────────────────────────────────

test("the A/R summary answers 'what do our patients owe us?'", async () => {
  await withServer(async (base) => {
    await throughPayment(base);
    await throughPayment(base, PREAUTH());

    const { status, json } = await req(base, "GET", "/api/v1/patients");
    assert.equal(status, 200);
    assert.ok(json.summary.totalOutstanding > 0);
    assert.equal(
      json.summary.totalOutstanding,
      json.items.filter((a: { balance: number }) => a.balance > 0).reduce((s: number, a: { balance: number }) => s + a.balance, 0)
    );

    // The aging always sums to the balance — the property that makes an aging report printable.
    const bucketed = Object.values(json.summary.aging).reduce((s: number, v) => s + (v as number), 0);
    assert.equal(bucketed, json.summary.totalOutstanding);
  });
});

test("only accounts that still owe something appear in the owing list", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const key = claim.patient.memberId;
    const owed = (await req(base, "GET", `/api/v1/patients/${key}`)).json.account.balance;

    await req(base, "POST", `/api/v1/patients/${key}/payment`, {
      amountDollars: owed / 100,
      recordedBy: "front.desk@clinic",
    });

    const owing = (await req(base, "GET", "/api/v1/patients?owing=1")).json;
    assert.equal(
      owing.items.some((a: { patientKey: string }) => a.patientKey === key),
      false
    );
    // But the account still exists — a settled patient is not a deleted one.
    assert.equal((await req(base, "GET", `/api/v1/patients/${key}`)).status, 200);
  });
});

test("a fresh balance is visible but is not yet chased on the Today queue", async () => {
  await withServer(async (base) => {
    await throughPayment(base);
    const today = (await req(base, "GET", "/api/v1/today")).json;
    assert.equal(
      today.counts.patient,
      0,
      "'call this patient' before the first statement cycle is advice to chase a bill the post has not delivered"
    );
    assert.ok((await req(base, "GET", "/api/v1/patients?owing=1")).json.items.length > 0);
  });
});

// ── Both halves of every dollar ───────────────────────────────────────────────────────

test("the practice report counts the patient side without reading the ledger's tables", async () => {
  await withServer(async (base) => {
    const { claim, posting } = await throughPayment(base);

    const report = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.equal(report.money.patientBilled, posting.patientResponsibility);
    assert.equal(report.money.patientCollected, 0);
    assert.equal(report.money.totalCollected, report.money.collected);

    await req(base, "POST", `/api/v1/patients/${claim.patient.memberId}/payment`, {
      amountDollars: 25,
      recordedBy: "front.desk@clinic",
    });

    const after = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.equal(after.money.patientCollected, 2500, "the payment crossed the outbox into Analytics");
    assert.equal(after.money.totalCollected, after.money.collected + 2500);
    assert.ok(after.insights.some((s: string) => /Patients were billed/.test(s)));
  });
});

test("a write-off is not revenue — the report must not flatter a practice that forgives debt", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base);
    const key = claim.patient.memberId;
    const owed = (await req(base, "GET", `/api/v1/patients/${key}`)).json.account.balance;

    await req(base, "POST", `/api/v1/patients/${key}/writeoff`, {
      amountDollars: owed / 100,
      note: "Uncollectable.",
      recordedBy: "owner@clinic",
    });

    const report = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.equal(report.money.patientCollected, 0);
    assert.equal(report.money.patientForgiven, owed);
    assert.equal(report.money.patientCollectionRate, 0);
  });
});

// ── The appeal letter defect this milestone also fixed ────────────────────────────────

test("an appeal letter now names the member and the claim, because the denial knows them", async () => {
  await withServer(async (base) => {
    const { claim } = await throughPayment(base, PREAUTH());
    const denial = (await req(base, "GET", "/api/v1/denials?open=1")).json.items.find(
      (d: { carcCode: string }) => d.carcCode === "197"
    );
    assert.ok(denial);

    // The UI sends no context at all now. Before M9 it sent empty strings, because it could not know
    // any of these values — and the letter went out reading "Claim [claim number]".
    const drafted = await req(base, "POST", `/api/v1/denials/${denial.id}/draft`, {});
    assert.equal(drafted.status, 200, JSON.stringify(drafted.json));

    const letter = drafted.json.activeAppeal.letter;
    assert.match(letter, /MET30077/, "the member ID travelled from the claim");
    assert.match(letter, new RegExp(claim.submission.patientControlNumber), "so did the claim number");
    assert.match(letter, new RegExp(claim.serviceDate), "and the date of service");
    assert.doesNotMatch(letter, /\[member ID\]/);
    assert.doesNotMatch(letter, /\[claim number\]/);
  });
});
