/**
 * End-to-end HTTP tests of the remittance half of the `/api/v1` contract, over the real wired app
 * (one outbox, three module services).
 *
 * These drive the whole revenue cycle through the transport a clinic actually uses: verify a
 * patient, submit the claim, pull the payer's remittance, and see the claim close itself — plus the
 * recovery queue that answers "where is our missing revenue?".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

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

const visit = (memberId: string, cardText: string) => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, feeDollars: 110 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
});

const CLEAN = () => visit("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");
const PREAUTH = () => visit("MET30077", "MetLife Dental\nMember ID: MET30077");

/** Verify a patient and file their claim; returns the filed claim. */
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
  assert.equal(filed.status, 200);
  return filed.json.claim;
}

test("pulling the payer's remittance posts it and closes the claim", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, CLEAN());

    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.items.length, 1);
    assert.equal(fetched.json.items[0].remittance.status, "posted");
    assert.equal(fetched.json.items[0].remittance.balanced, true);

    // No claims call was made — the remittance.posted event settled it.
    const settled = await req(base, "GET", `/api/v1/claims/${claim.id}`);
    assert.equal(settled.json.claim.status, "paid");
    assert.equal(settled.json.outstanding, 0);
    assert.ok(settled.json.claim.payments.length === 1);
  });
});

test("the variance is measured against the estimate the patient was quoted", async () => {
  await withServer(async (base) => {
    const verified = await req(base, "POST", "/api/v1/verifications", CLEAN());
    const expected = verified.json.record.calculation.totalInsurancePays;

      /**
   * Fetched WITHOUT the `ready` filter and given an authorisation first: a "...77" plan requires
   * pre-authorisation, so the submit gate holds the claim at `draft` until a decision is on record.
   * The payer then refuses under CARC 197 anyway — an authorisation is permission to treat, never a
   * guarantee of payment.
   */
  const { items: allClaims } = (await req(base, "GET", "/api/v1/claims")).json;
  const items = allClaims.filter((c: { status: string }) => c.status === "draft" || c.status === "ready");
    await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, { submittedBy: "biller" });
    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});

    const posting = fetched.json.items[0].remittance.postings[0];
    assert.equal(posting.variance.expectedInsurancePays, expected);
    assert.equal(posting.variance.actualPaid, posting.paidAmount);
  });
});

test("a denied procedure lands in the recovery queue with the payer's reason", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, PREAUTH());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const recovery = await req(base, "GET", "/api/v1/remittances/recovery");
    assert.equal(recovery.status, 200);
    assert.equal(recovery.json.items.length, 1);
    assert.equal(recovery.json.items[0].claimId, claim.id);
    assert.ok(recovery.json.items[0].recoverableAmount > 0);
    assert.ok(recovery.json.items[0].reasons.some((r: any) => r.code === "197"));
    assert.ok(recovery.json.totalRecoverable > 0);

    const outstanding = await req(base, "GET", `/api/v1/claims/${claim.id}`);
    assert.equal(outstanding.json.claim.status, "partially_paid");
    assert.ok(outstanding.json.outstanding > 0);
  });
});

/**
 * ── THE CLAIMS SCREEN MUST NOT UNDERSTATE WHAT THE PAYER WITHHELD ──────────────────────────────
 *
 * `outstanding` is the estimate minus what arrived, and on a claim whose estimate already assumed
 * the crown would not be covered it is SMALL exactly when the payer has denied the MOST. A real
 * claim showed $153.51 outstanding while $1,125.00 sat denied under CO-197, appealable, in the
 * recovery queue — so a biller working the claims list chased the smaller number and never saw the
 * larger one.
 *
 * Both figures are now returned and separately labelled. This pins the relationship between them:
 * the denied amount is the payer's decision, the outstanding amount is the estimate's error, and on
 * this fixture the first is strictly larger. If a later change collapses them, this fails.
 */
test("a claim carries what the payer denied, not just what the estimate missed", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, PREAUTH());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const detail = await req(base, "GET", `/api/v1/claims/${claim.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json.recovery, "an adjudicated claim with a denial must carry its recovery block");
    assert.ok(
      detail.json.recovery.openAmount > detail.json.outstanding,
      "the denied amount is the money worth chasing — it must not be hidden behind the estimate delta"
    );
    assert.ok(detail.json.recovery.reasons.some((r: any) => r.carcCode === "197"));

    // And the list row a biller actually scans must tell the same story as the claim they open.
    const list = await req(base, "GET", "/api/v1/claims");
    const row = list.json.items.find((i: any) => i.id === claim.id);
    assert.equal(row.recovery.openAmount, detail.json.recovery.openAmount);
  });
});

test("a claim nobody denied carries no recovery block at all", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, CLEAN());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const detail = await req(base, "GET", `/api/v1/claims/${claim.id}`);
    assert.equal(
      detail.json.recovery,
      undefined,
      "a contractual write-off is not a denial, and an empty recovery block would invent one"
    );
  });
});

test("a contractual write-off never reaches the recovery queue", async () => {
  await withServer(async (base) => {
    await fileClaim(base, CLEAN());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const recovery = await req(base, "GET", "/api/v1/remittances/recovery");
    assert.deepEqual(recovery.json.items, [], "the cost of being in network is not a leak");
    assert.equal(recovery.json.totalRecoverable, 0);
  });
});

test("the remittance worklist reports what is held and what is recoverable", async () => {
  await withServer(async (base) => {
    await fileClaim(base, CLEAN());
    await fileClaim(base, PREAUTH());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const list = await req(base, "GET", "/api/v1/remittances");
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 2, "one advice per payer");
    assert.equal(list.json.held, 0);
    assert.ok(list.json.totalRecoverable > 0);
    assert.ok(list.json.items[0].priority >= list.json.items[1].priority, "ranked");

    const attention = await req(base, "GET", "/api/v1/remittances?attention=1");
    assert.equal(attention.json.items.length, 1);
  });
});

test("fetching twice does not post the same money twice", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, CLEAN());
    await req(base, "POST", "/api/v1/remittances/fetch", {});
    // The claim is now `paid`, so the second fetch finds nothing awaiting payment.
    const second = await req(base, "POST", "/api/v1/remittances/fetch", {});

    assert.equal(second.status, 200);
    assert.match(second.json.note ?? "", /No claims are awaiting payment/);
    assert.equal((await req(base, "GET", "/api/v1/remittances")).json.items.length, 1);
    assert.equal((await req(base, "GET", `/api/v1/claims/${claim.id}`)).json.claim.payments.length, 1);
  });
});

test("uploading an 835 the clinic already holds ingests it once", async () => {
  await withServer(async (base) => {
    await fileClaim(base, CLEAN());
    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
    const id = fetched.json.items[0].remittance.id;
    const raw = (await req(base, "GET", `/api/v1/remittances/${id}`)).json.remittance.raw835;

    // Re-uploading the identical file is recognised by its trace number.
    const uploaded = await req(base, "POST", "/api/v1/remittances", { raw835: raw });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.json.remittance.id, id);
    assert.equal((await req(base, "GET", "/api/v1/remittances")).json.items.length, 1);
  });
});

test("an unreadable 835 is a 400 the caller must fix, not a 502", async () => {
  await withServer(async (base) => {
    const bad = await req(base, "POST", "/api/v1/remittances", { raw835: "ST*837*0001*005010X224A2~SE*2*0001~" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "parse_error");

    const missing = await req(base, "POST", "/api/v1/remittances", {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, "validation_error");
  });
});

test("an unbalanced 835 is held, and cannot be released past its arithmetic", async () => {
  await withServer(async (base) => {
    const claim = await fileClaim(base, CLEAN());
    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
    const raw = fetched.json.items[0].remittance.raw835 as string;

    // A second, corrupted advice under a different trace number.
    const tampered = raw.replace(/CAS\*PR\*2\*([\d.]+)\*/, "CAS*PR*2*1.00*").replace(/TRN\*1\*EFT(\d+)/, "TRN*1*EFT999999999");
    const held = await req(base, "POST", "/api/v1/remittances", { raw835: tampered });

    assert.equal(held.status, 201);
    assert.equal(held.json.remittance.status, "held");
    assert.equal(held.json.canPost, false);
    assert.ok(held.json.remittance.holdReason);

    const refused = await req(base, "POST", `/api/v1/remittances/${held.json.remittance.id}/release`, {
      releasedBy: "manager@clinic",
      reason: "Checked the paper EOB.",
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "unbalanced");

    // The already-paid claim is untouched by the bad file.
    assert.equal((await req(base, "GET", `/api/v1/claims/${claim.id}`)).json.claim.payments.length, 1);
  });
});

test("releasing requires both a releasing user and a reason", async () => {
  await withServer(async (base) => {
    await fileClaim(base, CLEAN());
    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
    const id = fetched.json.items[0].remittance.id;

    assert.equal((await req(base, "POST", `/api/v1/remittances/${id}/release`, { reason: "x" })).status, 400);
    assert.equal((await req(base, "POST", `/api/v1/remittances/${id}/release`, { releasedBy: "m" })).status, 400);
  });
});

test("daily reconciliation reports zero drift after a clean cycle", async () => {
  await withServer(async (base) => {
    await fileClaim(base, CLEAN());
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const report = await req(base, "GET", "/api/v1/remittances/reconcile");
    assert.equal(report.status, 200);
    assert.equal(report.json.balanced, true);
    assert.equal(report.json.drift, 0);
    assert.ok(report.json.paymentsReceived > 0);
    assert.match(report.json.summary, /^Reconciled:/);
  });
});

test("fetching with nothing submitted is a no-op, not an error", async () => {
  await withServer(async (base) => {
    const fetched = await req(base, "POST", "/api/v1/remittances/fetch", {});
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.json.items, []);
  });
});

test("unknown remittance ids and routes return the error envelope", async () => {
  await withServer(async (base) => {
    const missing = await req(base, "GET", "/api/v1/remittances/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "not_found");

    assert.equal((await req(base, "DELETE", "/api/v1/remittances")).status, 405);
    assert.equal((await req(base, "GET", "/api/v1/remittances/abc/nonsense")).status, 404);
  });
});
