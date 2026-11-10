/**
 * The appeal drafting → editing → approval → release path, over HTTP, through the real wired app.
 *
 * The module tests prove what the AI branches do. This file proves the transport does not weaken
 * any of it: that editing a letter is reachable, that it revokes an approval across a request
 * boundary, that a client can tell a refused gate from a broken request, and that the AI provenance
 * a reviewer needs actually arrives in the JSON rather than only existing in the domain object.
 *
 * `testServices()` builds with `LLM_PROVIDER` unset — the default `off`. So these run the
 * deterministic path, which is the point: **the whole appeal workflow must be complete and correct
 * with AI switched off**, because that is how every deployment starts and how every deployment runs
 * during a provider outage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

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

/** The pre-auth denial on a crown — the canonical recoverable case. */
const PREAUTH_VISIT = {
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "MET30077" , address: SYNTHETIC_ADDRESS},
  cardText: "MetLife Dental\nMember ID: MET30077",
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
};

/** Verify → claim → submit → remittance → variance → denial, all through the API. */
async function throughToDenial(base: string): Promise<{ denialId: string }> {
  await req(base, "POST", "/api/v1/verifications", PREAUTH_VISIT);
/**
 * ── WHY THESE FIXTURES NOW RECORD AN AUTHORISATION ────────────────────────────────────────────
 * A "...77" plan requires pre-authorisation, so the submit gate holds the claim until a decision is
 * on record. That is the feature working, and it is what saves the $1,125.00.
 *
 * These suites are about what happens AFTER a payer refuses, so they need a filed claim. They
 * record an approval — and the payer refuses under CARC 197 regardless, which is not a
 * contradiction but the doctrine stated plainly: an authorisation is permission to treat, never a
 * guarantee of payment. The authorisation number is then the practice's evidence on the appeal.
 */
  /**
   * Fetched WITHOUT the `ready` filter: a "...77" claim is held at `draft` by the pre-auth blocker
   * until a decision is recorded, so filtering on `ready` here would find nothing. Recording the
   * authorisation re-runs the scrubber and the claim becomes ready.
   */
  const ready = (await req(base, "GET", "/api/v1/claims")).json.items
    .filter((c: { status: string }) => c.status === "draft" || c.status === "ready")
    .at(-1);
  await req(base, "POST", `/api/v1/claims/${ready.id}/preauth`, {
    status: "approved",
    source: "payer-portal",
    referenceNumber: "AUTH-TEST-1",
    recordedBy: "office.manager@clinic",
  });
  await req(base, "POST", `/api/v1/claims/${ready.id}/submit`, { submittedBy: "office.manager@clinic" });
  await req(base, "POST", "/api/v1/remittances/fetch", {});

  const denials = (await req(base, "GET", "/api/v1/denials")).json;
  const denial = denials.items.find((d: { carcCode: string }) => d.carcCode === "197");
  assert.ok(denial, "the pre-auth denial should have reached the recovery queue");
  return { denialId: denial.id };
}

const LETTER_EDIT =
  "RE: APPEAL — Claim MRM-1\nThis crown restored a tooth with structural loss that a direct " +
  "restoration could not support, and the enclosed radiograph documents that loss at the time of " +
  "treatment. We ask that the claim be reprocessed.";

test("a drafted appeal arrives with its evidence checklist and its AI provenance field", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);

    const drafted = await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});
    assert.equal(drafted.status, 200);

    const appeal = drafted.json.activeAppeal;
    assert.equal(appeal.status, "draft");
    assert.ok(appeal.checklist.length > 0, "a letter without its evidence is a wasted appeal window");
    // With AI off, this is null — and the field is PRESENT and null, not absent. The UI branches on
    // it to decide whether to show the "a machine wrote this" panel, and an absent field is a
    // different bug from a null one.
    assert.equal(appeal.narrative, null);
    assert.equal(drafted.json.canApprove, true);
    assert.equal(drafted.json.canSubmit, false, "drafting is not sending");
  });
});

/**
 * The one money input this API accepted unvalidated. `Number("abc")` is NaN, `cents(NaN)` is NaN,
 * and JSONB stores NaN as null — on the figure that feeds the recovery scoreboard and the learning
 * loop. A negative figure would subtract revenue nobody lost. Both are refused with a 400 the way
 * every other dollar field on this API already is.
 */
test("a garbage or negative recovered amount is a 400, not a recorded outcome", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});
    await req(base, "POST", `/api/v1/denials/${denialId}/approve`, { approvedBy: "biller@clinic" });
    await req(base, "POST", `/api/v1/denials/${denialId}/submit`, {});

    for (const bad of ["abc", -125.5]) {
      const refused = await req(base, "POST", `/api/v1/denials/${denialId}/outcome`, {
        won: true,
        recoveredAmountDollars: bad,
        recordedBy: "biller@clinic",
      });
      assert.equal(refused.status, 400, `recoveredAmountDollars=${bad} must be refused`);
      assert.equal(refused.json.error.code, "validation_error");
    }

    // The record is untouched: the appeal is still awaiting its outcome, and a valid one lands.
    const ok = await req(base, "POST", `/api/v1/denials/${denialId}/outcome`, {
      won: true,
      recoveredAmountDollars: 1125,
      recordedBy: "biller@clinic",
    });
    assert.equal(ok.status, 200);
    /**
     * The field the API accepts is still `recoveredAmountDollars` — the wire contract has not moved
     * — but what it records is the AWARD: what the payer agreed to pay. `recoveredAmount` stays null
     * until a posting settles it, which is the whole of F-2 in one assertion.
     */
    assert.equal(ok.json.denial.awardedAmount, 112500, "the payer agreed to $1,125.00");
    assert.equal(ok.json.denial.awardSettledAmount, 0, "and has sent none of it");
    assert.equal(ok.json.denial.recoveredAmount, null, "so no cash is recorded");
    assert.equal(ok.json.denial.status, "awaiting_payment");
  });
});

test("the letter can be edited over HTTP before it is approved", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});

    const revised = await req(base, "POST", `/api/v1/denials/${denialId}/revise`, {
      letter: LETTER_EDIT,
      revisedBy: "biller@clinic",
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.json.activeAppeal.letter, LETTER_EDIT);
    assert.equal(revised.json.canApprove, true);
  });
});

test("editing an approved letter revokes the approval across the request boundary", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});

    const approved = await req(base, "POST", `/api/v1/denials/${denialId}/approve`, { approvedBy: "biller@clinic" });
    assert.equal(approved.json.activeAppeal.approvedBy, "biller@clinic");
    assert.equal(approved.json.canSubmit, true);

    const revised = await req(base, "POST", `/api/v1/denials/${denialId}/revise`, {
      letter: LETTER_EDIT,
      revisedBy: "dentist@clinic",
    });
    assert.equal(revised.json.activeAppeal.approvedBy, null);
    assert.equal(revised.json.canSubmit, false);

    // And the gate genuinely holds: the edited wording has nobody's name on it.
    const sent = await req(base, "POST", `/api/v1/denials/${denialId}/submit`, {});
    assert.equal(sent.status, 409);
    assert.match(String(sent.json.error?.message ?? ""), /not been approved by a person/);
  });
});

test("a revision carrying placeholder text is refused with a message a biller can act on", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});

    const bad = await req(base, "POST", `/api/v1/denials/${denialId}/revise`, {
      letter: `${LETTER_EDIT} Please see [the enclosed radiograph].`,
      revisedBy: "biller@clinic",
    });
    assert.equal(bad.status, 409);
    assert.match(String(bad.json.error?.message ?? ""), /placeholder text/);
  });
});

test("a revision with no letter at all is a bad request, not a refused gate", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});
    // 400 vs 409 is the distinction a client needs: "you sent nothing" is not "the state forbids it".
    assert.equal((await req(base, "POST", `/api/v1/denials/${denialId}/revise`, {})).status, 400);
  });
});

test("revising a denial with no drafted appeal is refused", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    const revised = await req(base, "POST", `/api/v1/denials/${denialId}/revise`, {
      letter: LETTER_EDIT,
      revisedBy: "biller@clinic",
    });
    assert.equal(revised.status, 409);
    assert.match(String(revised.json.error?.message ?? ""), /no drafted appeal to revise/);
  });
});

test("explaining a denial is a 200 with a null explanation when AI is off, and changes nothing", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    const before = (await req(base, "GET", `/api/v1/denials/${denialId}`)).json;

    // A degraded AI layer is an ordinary 200, not an error. The client renders the deterministic
    // reason code either way, and a 5xx here would make an optional sentence look like an outage.
    const explained = await req(base, "POST", `/api/v1/denials/${denialId}/explain`, {});
    assert.equal(explained.status, 200);
    assert.equal(explained.json.explanation, null);

    const after = (await req(base, "GET", `/api/v1/denials/${denialId}`)).json;
    assert.equal(after.recommendedAction, before.recommendedAction);
    assert.deepEqual(after.denial.triage, before.denial.triage);
    assert.equal(after.denial.audit.length, before.denial.audit.length, "explaining is not an action");
  });
});

test("explaining an unknown denial is a 404, not a null explanation", async () => {
  await withServer(async (base) => {
    assert.equal((await req(base, "POST", "/api/v1/denials/nope/explain", {})).status, 404);
  });
});

test("the full path still ends at the payer only after a named human signs the final wording", async () => {
  await withServer(async (base) => {
    const { denialId } = await throughToDenial(base);
    await req(base, "POST", `/api/v1/denials/${denialId}/draft`, {});
    await req(base, "POST", `/api/v1/denials/${denialId}/revise`, { letter: LETTER_EDIT, revisedBy: "biller@clinic" });
    await req(base, "POST", `/api/v1/denials/${denialId}/approve`, { approvedBy: "biller@clinic" });

    const sent = await req(base, "POST", `/api/v1/denials/${denialId}/submit`, {});
    assert.equal(sent.status, 200);
    assert.equal(sent.json.denial.status, "appealed");
    assert.equal(sent.json.activeAppeal.letter, LETTER_EDIT, "what was approved is what was sent");

    // The whole decision chain is legible from the denial's own history afterwards.
    const audit = sent.json.denial.audit.map((a: { message: string }) => a.message).join("\n");
    assert.match(audit, /appeal drafted/);
    assert.match(audit, /letter edited by biller@clinic/);
    assert.match(audit, /approved by biller@clinic/);
  });
});
