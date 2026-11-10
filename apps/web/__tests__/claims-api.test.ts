/**
 * End-to-end HTTP tests of the claims half of the `/api/v1` contract, over the real wired app
 * (outbox + both module services). These drive the flow a clinic actually performs: verify a
 * patient, watch the claim appear, submit it through the gate, and get refused when it should be.
 *
 * The status-code assertions carry weight: a refused gate (409) and a clearinghouse failure (502)
 * must not look alike to a client, or the UI cannot tell "fix this" from "try again".
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

const visit = (memberId: string, cardText: string, toothNumber?: string) => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, feeDollars: 110 },
    { code: "D2750", quantity: 1, feeDollars: 1250, ...(toothNumber ? { toothNumber } : {}) },
  ],
});

const CLEAN = () => visit("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100", "19");

test("verifying a patient creates a claim automatically, with no claims call", async () => {
  await withServer(async (base) => {
    const verified = await req(base, "POST", "/api/v1/verifications", CLEAN());
    assert.equal(verified.status, 201);

    const list = await req(base, "GET", "/api/v1/claims");
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.readyToSubmit, 1);
    assert.equal(list.json.items[0].verificationId, verified.json.record.id);
    assert.equal(list.json.items[0].status, "ready");
    // The estimate the patient was quoted, carried onto the claim.
    assert.equal(list.json.items[0].expectedPatientPays, verified.json.record.calculation.totalPatientPays);
  });
});

test("GET /api/v1/claims/:id returns the claim, its filing status, and its gate", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;

    const detail = await req(base, "GET", `/api/v1/claims/${items[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.canSubmit, true);
    assert.equal(detail.json.submitBlockedReason, null);
    assert.equal(detail.json.filing.risk, "safe");
    assert.deepEqual(detail.json.blockers, []);
    assert.equal(detail.json.claim.coverageSnapshot.snapshot_version, 1);
  });
});

test("submitting through the gate files the claim and records the acknowledgement", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;

    const filed = await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, {
      submittedBy: "office.manager@clinic",
    });

    assert.equal(filed.status, 200);
    assert.equal(filed.json.claim.status, "submitted");
    assert.equal(filed.json.claim.submission.outcome, "accepted");
    assert.equal(filed.json.claim.submission.submittedBy, "office.manager@clinic");
    assert.match(filed.json.claim.submission.controlNumber, /^\d{9}$/);
  });
});

test("the gate refuses an unnamed submitter with a 400", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;

    const refused = await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, { submittedBy: "" });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, "validation_error");
  });
});

test("a scrub-blocked claim is refused with a 409, not a 500", async () => {
  await withServer(async (base) => {
    // No tooth number on the crown → the scrubber blocks it.
    await req(base, "POST", "/api/v1/verifications", visit("ABC12345", "Delta Dental\nMember ID: ABC12345"));
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;
    assert.equal(items[0].status, "draft");
    assert.equal(items[0].scrubErrors, 1);

    const refused = await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, { submittedBy: "biller" });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "not_submittable");
    assert.match(refused.json.error.message, /blocking issue/);
  });
});

test("a claim already submitted cannot be submitted again", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;
    await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, { submittedBy: "biller" });

    const again = await req(base, "POST", `/api/v1/claims/${items[0].id}/submit`, { submittedBy: "biller" });
    assert.equal(again.status, 409);
  });
});

test("POST /api/v1/claims bills a verification on demand, idempotently", async () => {
  await withServer(async (base) => {
    const verified = await req(base, "POST", "/api/v1/verifications", CLEAN());
    const id = verified.json.record.id;

    const created = await req(base, "POST", "/api/v1/claims", { verificationId: id });
    assert.equal(created.status, 201);
    // The event already created it, so this returns the same claim rather than a second one.
    assert.equal((await req(base, "GET", "/api/v1/claims")).json.items.length, 1);

    const again = await req(base, "POST", "/api/v1/claims", { verificationId: id });
    assert.equal(again.json.claim.id, created.json.claim.id);
    assert.equal((await req(base, "GET", "/api/v1/claims")).json.items.length, 1);
  });
});

test("billing an unsettled verification is refused with 409 not_billable", async () => {
  await withServer(async (base) => {
    const flagged = await req(base, "POST", "/api/v1/verifications", visit("MEM10000", "Delta Dental\nMember ID: MEM10000", "19"));
    assert.equal(flagged.json.record.status, "needs_review");

    const refused = await req(base, "POST", "/api/v1/claims", { verificationId: flagged.json.record.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "not_billable");
    assert.equal((await req(base, "GET", "/api/v1/claims")).json.items.length, 0);
  });
});

test("rescrub re-evaluates a claim; void closes it", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;

    const rescrubbed = await req(base, "POST", `/api/v1/claims/${items[0].id}/scrub`, {});
    assert.equal(rescrubbed.status, 200);
    assert.equal(rescrubbed.json.claim.status, "ready");

    const voided = await req(base, "POST", `/api/v1/claims/${items[0].id}/void`, { reason: "Patient switched plans." });
    assert.equal(voided.status, 200);
    assert.equal(voided.json.claim.status, "void");
    assert.equal(voided.json.claim.voidReason, "Patient switched plans.");

    const refused = await req(base, "POST", `/api/v1/claims/${items[0].id}/void`, { reason: "again" });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "invalid_transition");
  });
});

test("voiding without a reason is refused", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const { items } = (await req(base, "GET", "/api/v1/claims")).json;
    const refused = await req(base, "POST", `/api/v1/claims/${items[0].id}/void`, { reason: "   " });
    assert.equal(refused.status, 400);
  });
});

test("the claims queue filters by status and by open-only", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    await req(base, "POST", "/api/v1/verifications", visit("CIG20099", "Cigna Dental\nMember ID: CIG20099"));
    const all = (await req(base, "GET", "/api/v1/claims")).json;
    assert.equal(all.items.length, 2);

    assert.equal((await req(base, "GET", "/api/v1/claims?status=ready")).json.items.length, 1);
    assert.equal((await req(base, "GET", "/api/v1/claims?status=draft")).json.items.length, 1);
    assert.equal((await req(base, "GET", "/api/v1/claims?open=1")).json.items.length, 2);
  });
});

test("the filing-risk sweep endpoint reports what it escalated", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const swept = await req(base, "POST", "/api/v1/claims/filing-sweep", {});
    assert.equal(swept.status, 200);
    assert.deepEqual(swept.json.escalated, [], "a claim with a year to file is not news");
  });
});

test("an unknown claim id and an unknown claims route both 404 with the error envelope", async () => {
  await withServer(async (base) => {
    const missing = await req(base, "GET", "/api/v1/claims/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "not_found");

    const noRoute = await req(base, "GET", "/api/v1/claims/abc/nonsense");
    assert.equal(noRoute.status, 404);
  });
});

test("an unsupported method on the claims collection returns 405", async () => {
  await withServer(async (base) => {
    const res = await req(base, "DELETE", "/api/v1/claims");
    assert.equal(res.status, 405);
    assert.equal(res.json.error.code, "method_not_allowed");
  });
});

// ── The claim timeline (M13) ───────────────────────────────────────────────────────────────────

test("the timeline tells the claim's story: estimate → submission → posting → resolution", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", CLEAN());
    const claims = await req(base, "GET", "/api/v1/claims");
    const claim = claims.json.items[0];

    // Before anything happens, the story is just the estimate the claim inherited.
    const early = await req(base, "GET", `/api/v1/claims/${claim.id}/timeline`);
    assert.equal(early.status, 200);
    assert.equal(early.json.claimId, claim.id);
    assert.equal(early.json.entries[0].phase, "estimate");
    assert.match(early.json.entries[0].detail, /Inherited verification/);
    assert.ok(
      !early.json.entries.some((e: any) => e.phase === "submission"),
      "nothing has been released yet, so the timeline must not claim it has"
    );

    // …then a human releases it, and the payer answers.
    await req(base, "POST", `/api/v1/claims/${claim.id}/submit`, { submittedBy: "office.manager@clinic" });
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const full = await req(base, "GET", `/api/v1/claims/${claim.id}/timeline`);
    const phases = full.json.entries.map((e: any) => e.phase);
    assert.ok(phases.includes("submission"), "the release must appear");
    assert.ok(phases.includes("posting"), "and the payer's answer");

    // The submit gate is a human act, and the timeline is where that attribution is read back.
    const released = full.json.entries.find((e: any) => e.phase === "submission");
    assert.equal(released.actor, "office.manager@clinic", "the timeline names who released it");

    // Chronological, because a corrected-and-refiled claim genuinely produces a submission later
    // than an earlier posting — sorting by phase would tidy history into a lie.
    const times = full.json.entries.map((e: any) => e.at);
    assert.deepEqual(times, [...times].sort(), "entries must be in the order things actually happened");
  });
});

test("a timeline for an unknown claim is a 404, not an empty story", async () => {
  await withServer(async (base) => {
    const res = await req(base, "GET", "/api/v1/claims/does-not-exist/timeline");
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "not_found");
  });
});
