/**
 * The unified Today queue and the practice report — the two views that reason about ALL FIVE
 * modules at once, driven over the real HTTP contract.
 *
 * Every other vertical test in this repository follows one case through the cycle. This one asks a
 * different question: **after a day of real work, do the two screens a practice actually opens agree
 * with what happened?** They are built in opposite ways on purpose —
 *
 *   • the Today queue is COMPOSED at request time from each module's own ranked worklist, so it can
 *     never show work that is already done (apps/web/today.ts);
 *   • the report is PROJECTED from domain events into `analytics_facts`, so it records the world as
 *     it was and never contends with a clinic filing a claim (modules/analytics).
 *
 * Both are therefore able to be wrong in ways no single-module test would catch, and both are wired
 * through the composition root that actually ships.
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

/** Settles cleanly and pays in full. */
const CLEAN = () => visit("Ada", "ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");
/** Member IDs ending 77 hit a missing pre-authorization on the crown — a recoverable CO-197. */
const PREAUTH = () => visit("Dev", "MET30077", "MetLife Dental\nMember ID: MET30077");
/** Inactive coverage — never settles on its own, so it stays in the queue as human work. */
const INACTIVE = () => visit("Ben", "MEM10000", "Delta Dental\nMember ID: MEM10000");

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

/** A day of real work: one clean patient paid in full, one denied, one stuck needing a person. */
async function aDayOfWork(base: string) {
  await fileClaim(base, CLEAN());
  await fileClaim(base, PREAUTH());
  await req(base, "POST", "/api/v1/verifications", INACTIVE());
  await req(base, "POST", "/api/v1/remittances/fetch", {});
}

// ── The Today queue ───────────────────────────────────────────────────────────────────

test("the Today queue merges every module's own worklist into one ranked list", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);

    const { status, json: today } = await req(base, "GET", "/api/v1/today");
    assert.equal(status, 200);
    assert.ok(today.items.length > 0, "a day of work produced no work to do");

    // Every kind present is a kind some module said still needs a person.
    assert.ok(today.counts.verification >= 1, "the inactive-coverage patient still needs a human");
    assert.ok(today.counts.denial >= 1, "the pre-auth denial is recoverable work");

    // Ranked, and comparably: each module scores 0–100 on the same "what does leaving this alone
    // cost the practice" basis, so a merged sort is meaningful rather than merely tidy.
    const priorities = today.items.map((i: { priority: number }) => i.priority);
    assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));

    assert.equal(
      today.atStake,
      today.items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)
    );
    assert.equal(
      today.urgentCount,
      today.items.filter((i: { urgent: boolean }) => i.urgent).length
    );
  });
});

test("every Today item carries the owning module's own recommendation, not a re-derived one", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const { json: today } = await req(base, "GET", "/api/v1/today");

    for (const item of today.items) {
      assert.ok(item.action.length > 0, `${item.kind} ${item.id} has no recommended action`);
      assert.ok(item.title.length > 0);
      assert.ok(["verification", "claim", "remittance", "denial", "patient"].includes(item.kind));
    }

    const denial = today.items.find((i: { kind: string }) => i.kind === "denial");
    assert.ok(denial, "the denial never reached the queue");
    const detail = await req(base, "GET", `/api/v1/denials/${denial.id}`);
    assert.equal(
      denial.action,
      detail.json.recommendedAction,
      "the queue must quote the module verbatim — two wordings of one decision is two decisions"
    );
    assert.equal(denial.amount, detail.json.denial.triage.expectedRecovery);
  });
});

test("work that is finished leaves the queue — the queue cannot go stale", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const before = (await req(base, "GET", "/api/v1/today")).json;
    const denial = before.items.find((i: { kind: string }) => i.kind === "denial");
    assert.ok(denial);

    await req(base, "POST", `/api/v1/denials/${denial.id}/close`, {
      as: "written_off",
      reason: "No pre-authorization on file and none obtainable retroactively.",
      closedBy: "biller@clinic",
    });

    const after = (await req(base, "GET", "/api/v1/today")).json;
    assert.equal(
      after.items.some((i: { id: string }) => i.id === denial.id),
      false,
      "a closed denial is not work; a composed queue learns that without being told"
    );
    assert.equal(after.counts.denial, before.counts.denial - 1);
  });
});

test("a verification a human REJECTED leaves the queue — the defect this test was written for", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);

    const before = (await req(base, "GET", "/api/v1/today")).json;
    const stuck = before.items.find((i: { kind: string }) => i.kind === "verification");
    assert.ok(stuck, "the inactive-coverage patient should be waiting for a person");

    // Rejecting is the human-in-the-loop decision "this is unusable" — the case is SETTLED. It
    // leaves the record `failed`, which the decision engine reads as `blocked` at priority 80, so
    // the queue used to re-offer finished work at the top of the list forever. A worklist that shows
    // completed work is worse than none, because staff learn to distrust it and stop opening it.
    await req(base, "POST", `/api/v1/verifications/${stuck.id}/review`, {
      decision: "rejected",
      notes: "Wrong patient — this card belongs to someone else.",
    });

    const after = (await req(base, "GET", "/api/v1/today")).json;
    assert.equal(
      after.items.some((i: { id: string }) => i.id === stuck.id),
      false
    );
    assert.equal(after.counts.verification, before.counts.verification - 1);
  });
});

test("the queue is bounded by `limit`, and the totals describe what it returned", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const { json } = await req(base, "GET", "/api/v1/today?limit=2");
    assert.equal(json.items.length, 2);
    assert.equal(
      json.atStake,
      json.items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0),
      "a truncated page must not report the whole backlog's money as if it were on screen"
    );
  });
});

test("an empty practice gets an empty queue, not an error", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/api/v1/today");
    assert.equal(status, 200);
    assert.deepEqual(json.items, []);
    // Exhaustive on purpose: every kind the queue can produce must be represented at zero, so a new
    // kind cannot be added without someone deciding it belongs on an empty practice's board too.
    // `era` (an abandoned ERA file) joined the list with the held-money clock.
    assert.deepEqual(json.counts, { verification: 0, claim: 0, remittance: 0, denial: 0, patient: 0, era: 0 });
    assert.equal(json.atStake, 0);
    assert.equal(json.urgentCount, 0);
  });
});

// ── The practice report ───────────────────────────────────────────────────────────────

test("the report is fed entirely by domain events — nobody told Analytics anything", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);

    const { status, json: report } = await req(base, "GET", "/api/v1/analytics/report");
    assert.equal(status, 200);

    assert.equal(report.funnel.claimsSubmitted, 2, "two claims were released to payers");
    assert.equal(report.funnel.verificationsCompleted, 2, "the inactive patient never completed");
    assert.equal(report.funnel.verificationsFlagged, 1);
    assert.ok(report.funnel.claimsPaid >= 2, "both payers remitted");
    assert.ok(report.money.filedToPayers > 0);
    assert.ok(report.money.collected > 0);
    assert.ok(report.money.denied > 0, "the pre-auth shortfall is denied money, not a write-off");
  });
});

test("the report and the source systems agree on the money", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const report = (await req(base, "GET", "/api/v1/analytics/report")).json;

    const claims = (await req(base, "GET", "/api/v1/claims?status=paid")).json.items;
    const partial = (await req(base, "GET", "/api/v1/claims?status=partially_paid")).json.items;
    const filed = [...claims, ...partial].reduce((s: number, c: { totalFee: number }) => s + c.totalFee, 0);
    assert.equal(report.money.filedToPayers, filed, "what the dashboard says was filed is what the claims module filed");

    const denials = (await req(base, "GET", "/api/v1/denials")).json;
    const denied = denials.items.reduce((s: number, d: { deniedAmount: number }) => s + d.deniedAmount, 0);
    assert.equal(report.money.denied, denied);

    // Collection rate is measured against EXPECTED, never against what was filed: that figure carries the
    // contractual write-off every in-network practice takes, and measuring against it would make a
    // healthy practice look alarming.
    assert.equal(
      report.money.collectionRate,
      Math.round((report.money.collected / report.money.expected) * 1000) / 1000
    );
  });
});

test("recovering a denial moves the recovery rate, the payer scorecard and the reasons table", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const denial = (await req(base, "GET", "/api/v1/denials?open=1")).json.items.find(
      (d: { carcCode: string }) => d.carcCode === "197"
    );
    assert.ok(denial, "the pre-auth denial never arrived");

    const before = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.equal(before.money.recovered, 0);

    await req(base, "POST", `/api/v1/denials/${denial.id}/draft`, {
      memberId: "MET30077",
      claimControlNumber: "",
      serviceDate: denial.detectedAt.slice(0, 10),
    });
    await req(base, "POST", `/api/v1/denials/${denial.id}/approve`, { approvedBy: "biller@clinic" });
    await req(base, "POST", `/api/v1/denials/${denial.id}/submit`, {});
    const outcome = await req(base, "POST", `/api/v1/denials/${denial.id}/outcome`, {
      won: true,
      recoveredAmountDollars: denial.deniedAmount / 100,
      recordedBy: "biller@clinic",
    });
    assert.equal(outcome.status, 200, JSON.stringify(outcome.json));

    const after = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.equal(after.money.recovered, denial.deniedAmount, "the outcome crossed the outbox into Analytics");
    assert.equal(after.money.recoveryRate, 1);

    const reason = after.topDenialReasons.find((r: { carcCode: string }) => r.carcCode === "197");
    assert.ok(reason);
    assert.equal(reason.recovered, denial.deniedAmount);
    assert.equal(reason.recoveryRate, 1);

    const payer = after.payers.find((p: { payerName: string }) => /metlife/i.test(p.payerName));
    assert.ok(payer, "the payer scorecard must name the payer that denied");
    assert.equal(payer.recovered, denial.deniedAmount);
  });
});

test("a redelivered event never double-counts revenue on the dashboard", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const first = (await req(base, "GET", "/api/v1/analytics/report")).json;

    // Re-serving the payer's advice is the exact shape of an at-least-once redelivery.
    await req(base, "POST", "/api/v1/remittances/fetch", {});

    const second = (await req(base, "GET", "/api/v1/analytics/report")).json;
    assert.deepEqual(second.money, first.money, "the projection is idempotent on the source event id");
    assert.deepEqual(second.funnel, first.funnel);
  });
});

test("the reporting window is honoured — a period before the work is empty", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const { json } = await req(
      base,
      "GET",
      "/api/v1/analytics/report?from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z"
    );
    assert.equal(json.funnel.claimsSubmitted, 0);
    assert.equal(json.money.filedToPayers, 0);
    assert.deepEqual(json.insights, ["No activity in this period yet."]);
    assert.equal(json.period.from, "2020-01-01T00:00:00.000Z");
  });
});

test("insights are earned by arithmetic, not generated", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const report = (await req(base, "GET", "/api/v1/analytics/report")).json;

    assert.ok(report.insights.length > 0);
    /**
     * `only` is part of the sentence when the rate is poor — "Collecting only 60%..." — and the
     * original pattern demanded a digit straight after "Collecting", so it matched the healthy
     * phrasing and nothing else. It broke the moment the fixture's collection rate fell, which is
     * a fact about the DATA and not about the insight, and the assertion below still pins the rate.
     */
    const collection = report.insights.find((s: string) => /Collecting (only )?\d+%/.test(s));
    assert.ok(collection, "the collection-rate sentence is the first thing an owner reads");
    assert.match(collection, new RegExp(`${Math.round(report.money.collectionRate * 100)}%`));
  });
});

test("the two views agree: money the queue says is at stake is money the report says was denied", async () => {
  await withServer(async (base) => {
    await aDayOfWork(base);
    const today = (await req(base, "GET", "/api/v1/today")).json;
    const report = (await req(base, "GET", "/api/v1/analytics/report")).json;

    const queuedDenials = today.items.filter((i: { kind: string }) => i.kind === "denial");
    const denials = (await req(base, "GET", "/api/v1/denials?open=1")).json.items;

    assert.equal(queuedDenials.length, denials.length);
    assert.ok(
      report.money.denied >= queuedDenials.reduce((s: number, i: { amount: number }) => s + i.amount, 0),
      "expected recovery can never exceed what was actually denied"
    );
  });
});
