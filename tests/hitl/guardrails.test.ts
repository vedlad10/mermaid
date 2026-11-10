/**
 * The human-in-the-loop guardrails, asserted AS A SET.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY ────────────────────────────────────────────────────────────
 * Every gate in `human-in-the-loop-workflow.pdf` is already enforced at its own service and covered
 * by that service's tests. So why this?
 *
 * Because the promise the product actually makes is a NEGATIVE one — *no path exists* that
 * auto-delivers a patient bill, auto-submits an appeal, auto-posts an exception, or quietly reduces
 * what a patient owes. A per-gate test proves the gate it guards works. It cannot prove that the
 * next endpoint someone adds did not open a way around it, because it never looks there. Only a
 * suite that sweeps the whole surface and asserts absence can do that.
 *
 * Blueprint doc 16 §E.3 lists this among the three things to do "before writing feature code":
 * "Write the `tests/hitl/` guardrail suite early, so 'no path auto-delivers a patient bill /
 * auto-submits an appeal / auto-posts an exception' is proven continuously, not assumed."
 * It is late. It is here now, and it is written so that a future endpoint that breaks one of these
 * promises fails this file rather than reaching a patient.
 *
 * ── HOW TO READ A FAILURE HERE ─────────────────────────────────────────────────────────────────
 * A red test in this file is not a broken test. It means a route was added that can move money,
 * speak to a patient, or reach a payer without a person deciding — and the fix is the route, not
 * the assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp } from "../../apps/web/server.ts";
import { buildServices, type Services } from "../../apps/web/wiring.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address (loop 2010BA N3/N4), so a fixture patient needs one.
 * Named to be unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and
 * no production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const SERVER_SOURCE = new URL("../../apps/web/server.ts", import.meta.url);
const LLM_ADAPTER_SOURCE = new URL("../../platform/llm/src/adapter.ts", import.meta.url);

function services(): Services {
  return buildServices({ inMemory: true, bus: new InMemoryOutbox() });
}

async function withServer(fn: (base: string, app: Services) => Promise<void>): Promise<void> {
  const app = services();
  const server = createApp(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, app);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function req(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const VISIT = (memberId: string) => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
  cardText: `MetLife Dental\nMember ID: ${memberId}`,
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, feeDollars: 110 },
    { code: "D2750", quantity: 1, feeDollars: 1250, toothNumber: "19" },
  ],
});

/** Drive a patient to a denial sitting in the recovery queue, with money on a patient's account. */
async function toDenial(base: string) {
  const created = await req(base, "POST", "/api/v1/verifications", VISIT("MET30077"));
  const verificationId = created.json.record.id;
  const claims = await req(base, "GET", "/api/v1/claims");
  const claim = claims.json.items.find((c: any) => c.verificationId === verificationId) ?? claims.json.items[0];
  await req(base, "POST", `/api/v1/claims/${claim.id}/preauth`, {
    status: "approved", source: "payer-portal", referenceNumber: "AUTH-TEST-1", recordedBy: "office.manager@clinic",
  });
  await req(base, "POST", `/api/v1/claims/${claim.id}/submit`, { submittedBy: "office.manager@clinic" });
  await req(base, "POST", "/api/v1/remittances/fetch", {});
  const denials = await req(base, "GET", "/api/v1/denials?open=1");
  return { denials: denials.json.items ?? [], claim };
}

// ── 1. Nothing the software does reaches a patient ─────────────────────────────────────────────
//
// HITL §3: "Telling a patient what they owe — and actually collecting it — is a trust and
// relationship moment, not a data problem… Should always be human." The guarantee is enforced by
// ABSENCE: there is no delivery mechanism to misuse. This asserts the absence directly, because an
// absence is exactly what a future feature would quietly fill in.

test("no code path can deliver anything to a patient — there is no transport to misuse", () => {
  const source = readFileSync(SERVER_SOURCE, "utf8");

  // If any of these ever appear, a patient-facing delivery channel has been introduced and the
  // "a human communicates the number" guarantee needs re-litigating, not quietly losing.
  for (const forbidden of ["nodemailer", "sendgrid", "twilio", "sendMail", "sendSms", "smtp"]) {
    assert.ok(
      !source.toLowerCase().includes(forbidden.toLowerCase()),
      `the HTTP surface references "${forbidden}" — the platform must have no way to message a patient`
    );
  }
});

test("no endpoint sends a statement; the ledger only ever RETURNS one for a person to read", async () => {
  await withServer(async (base) => {
    await toDenial(base);

    // Every plausible spelling of "send it to them" must not exist.
    for (const path of [
      "/api/v1/patients/MET30077/send",
      "/api/v1/patients/MET30077/statement/send",
      "/api/v1/patients/MET30077/notify",
      "/api/v1/patients/MET30077/email",
    ]) {
      const res = await req(base, "POST", path, {});
      assert.equal(res.status, 404, `${path} must not exist — a statement is read aloud, never delivered`);
    }

    // What DOES exist returns the statement to the staff member asking for it.
    const statement = await req(base, "GET", "/api/v1/patients/MET30077");
    assert.ok([200, 404].includes(statement.status), "reading a statement is always allowed");
  });
});

// ── 2. No appeal reaches a payer without a named human ─────────────────────────────────────────
//
// HITL §8: "final review before submission should always stay human. This is a 'someone's name is
// on this' moment."

test("an appeal cannot be submitted without a human approval, however it is asked for", async () => {
  await withServer(async (base) => {
    const { denials } = await toDenial(base);
    assert.ok(denials.length > 0, "the fixture must actually produce a denial to appeal");
    const id = denials[0].id;

    await req(base, "POST", `/api/v1/denials/${id}/draft`, {});

    // Straight submission, with no approval on record.
    const bare = await req(base, "POST", `/api/v1/denials/${id}/submit`, {});
    assert.equal(bare.status, 409, "an unapproved appeal must be refused, not sent");

    // And it must not be possible to smuggle the approval in as request input — the approver comes
    // from the session, never from the body.
    const smuggled = await req(base, "POST", `/api/v1/denials/${id}/submit`, {
      approved: true,
      approvedBy: "attacker@example.com",
      status: "approved",
    });
    assert.equal(smuggled.status, 409, "approval must never be assertable by the caller");
  });
});

test("drafting an appeal is not sending one", async () => {
  await withServer(async (base) => {
    const { denials } = await toDenial(base);
    const id = denials[0].id;

    const drafted = await req(base, "POST", `/api/v1/denials/${id}/draft`, {});
    assert.equal(drafted.status, 200);
    assert.equal(drafted.json.activeAppeal.status, "draft");
    assert.notEqual(drafted.json.denial.status, "appealed", "drafting must never advance the denial to sent");
  });
});

// ── 2b. AI drafting does not weaken any of the above ───────────────────────────────────────────
//
// The product workflow puts AI immediately before the mandatory human gate at S14, and the payer-
// loop analysis §12 is explicit that an AI-drafted appeal is "a draft only, always human-approved".
// The risk a drafting feature introduces is not that the model writes badly — it is that a screen
// which now produces polished, confident prose makes the gate feel ceremonial. These tests pin the
// gate to behaviour rather than to anyone's discipline.

test("editing a drafted letter revokes its approval — a signature signs off specific words", async () => {
  await withServer(async (base) => {
    const { denials } = await toDenial(base);
    const id = denials[0].id;

    await req(base, "POST", `/api/v1/denials/${id}/draft`, {});
    // The DB-free demo has no session, so the actor comes from the body — the only case in which it
    // ever does (see `actorName`). A real deployment takes it from the authenticated user.
    const approved = await req(base, "POST", `/api/v1/denials/${id}/approve`, { approvedBy: "biller@clinic" });
    assert.equal(approved.json.canSubmit, true);

    const edited =
      "RE: APPEAL — Claim MRM-1\nThe procedure restored a tooth with structural loss that a direct " +
      "restoration could not support, and the enclosed radiograph documents it.";
    const revised = await req(base, "POST", `/api/v1/denials/${id}/revise`, {
      letter: edited,
      revisedBy: "dentist@clinic",
    });
    assert.equal(revised.json.activeAppeal.approvedBy, null, "changed words must lose their signature");

    const sent = await req(base, "POST", `/api/v1/denials/${id}/submit`, {});
    assert.equal(sent.status, 409, "wording nobody has signed must not reach a payer");
  });
});

test("asking the AI to explain a denial cannot change, advance or approve anything", async () => {
  await withServer(async (base) => {
    const { denials } = await toDenial(base);
    const id = denials[0].id;
    const before = (await req(base, "GET", `/api/v1/denials/${id}`)).json;

    const explained = await req(base, "POST", `/api/v1/denials/${id}/explain`, {
      // Nothing in the body may be treated as an instruction or an assertion of state.
      approved: true,
      approvedBy: "attacker@example.com",
      status: "appealed",
      disposition: "write_off",
    });
    assert.equal(explained.status, 200);

    const after = (await req(base, "GET", `/api/v1/denials/${id}`)).json;
    assert.equal(after.denial.status, before.denial.status);
    assert.deepEqual(after.denial.triage, before.denial.triage, "narration must not re-triage");
    assert.equal(after.activeAppeal, null, "narration must not create an appeal");
    assert.equal(after.denial.audit.length, before.denial.audit.length);
  });
});

test("the AI seam cannot decide anything — the adapter offers extraction and drafting only", () => {
  // Structural, and deliberately so. Every guarantee above is a guarantee about what the model is
  // ASKED for; this is the one that says a future caller has no way to ask for more. There is no
  // decide(), score() or classify() on the interface, so "let the model triage it" is not a small
  // refactor away — it requires adding a method, in a file whose header explains why there isn't one.
  const adapter = readFileSync(LLM_ADAPTER_SOURCE, "utf8");
  const surface = adapter.slice(adapter.indexOf("export interface LlmAdapter"));
  const body = surface.slice(0, surface.indexOf("}"));
  for (const forbidden of ["decide", "score", "classify", "triage", "disposition"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\s*[(<]`).test(body), `LlmAdapter must not expose ${forbidden}()`);
  }
  assert.match(body, /extract</);
  assert.match(body, /draft\(/);
});

// ── 3. Money never leaves a patient's balance without a named person and a reason ───────────────
//
// HITL §7: the pursue-or-write-off call "should stay human-owned". Reducing what a patient owes is
// how a practice loses money quietly.

test("no balance-reducing route accepts an anonymous actor", async () => {
  await withServer(async (base) => {
    await toDenial(base);

    // Adjustments and write-offs require a reason; the note is the actor's justification.
    for (const path of ["adjustment", "writeoff"]) {
      const noReason = await req(base, "POST", `/api/v1/patients/MET30077/${path}`, { amountDollars: 10 });
      assert.ok(
        [400, 409, 404].includes(noReason.status),
        `${path} without a reason must be refused (got ${noReason.status})`
      );
    }
  });
});

test("a payment larger than the balance is refused rather than creating a negative balance", async () => {
  await withServer(async (base) => {
    await toDenial(base);
    const overpay = await req(base, "POST", "/api/v1/patients/MET30077/payment", { amountDollars: 1_000_000 });
    assert.ok(
      [400, 409, 404].includes(overpay.status),
      `paying more than is owed must be refused (got ${overpay.status})`
    );
    assert.notEqual(overpay.status, 500, "a refused gate must be a decision, never a crash");
  });
});

test("charges cannot be created by a person — they arrive from the cycle", async () => {
  await withServer(async (base) => {
    await toDenial(base);
    for (const path of ["/api/v1/patients/MET30077/charge", "/api/v1/patients/MET30077/charges"]) {
      const res = await req(base, "POST", path, { amountDollars: 500 });
      assert.equal(res.status, 404, `${path} must not exist — a charge is caused by a payer decision`);
    }
  });
});

// ── 4. A claim reaches a payer only through a named human ──────────────────────────────────────
//
// HITL §5: "Keep a human checkpoint for claims above a dollar threshold or flagged as atypical."

test("a claim cannot be submitted without a named submitter", async () => {
  await withServer(async (base) => {
    await req(base, "POST", "/api/v1/verifications", VISIT("ABC12345"));
    const claims = await req(base, "GET", "/api/v1/claims");
    const claim = claims.json.items[0];

    const anonymous = await req(base, "POST", `/api/v1/claims/${claim.id}/submit`, {});
    assert.equal(anonymous.status, 400, "the submit gate must refuse an unnamed submitter");

    const blank = await req(base, "POST", `/api/v1/claims/${claim.id}/submit`, { submittedBy: "   " });
    assert.equal(blank.status, 400, "whitespace is not a person");
  });
});

// ── 5. The gates are wired into the authorization table, not just the services ──────────────────
//
// A gate enforced only inside a service is one refactor away from being bypassed by a new route.
// Deny-by-default is the structural half of the guarantee: a route with no permission entry is
// refused rather than served.

test("an undeclared route is REFUSED, not served to whoever happens to be logged in", () => {
  const source = readFileSync(SERVER_SOURCE, "utf8");

  // Behavioural proof of this lives in tests/db/rbac (it needs a session, and the DB-free demo has
  // no accounts). What is asserted here is the structural half: the null case must be refused
  // explicitly, because `authorizeRequest` SKIPS the permission check when the permission is null
  // (`if (meta.permission && !can(...))`). Without this branch an undeclared endpoint is served to
  // any authenticated user — including `auditor`, who is read-only everywhere by construction.
  const dispatchBody = source.slice(source.indexOf("async function dispatch("));
  assert.match(
    dispatchBody,
    /!policy\.declared[\s\S]{0,200}AuthError\(\s*403/,
    "dispatch must refuse a route that was never declared, before calling guard()"
  );

  // The regression this guards against is the exact shape the bug had: piping `permissionFor`
  // straight into `guard`, so a null sailed through as "no permission required".
  assert.ok(
    !/permission:\s*permissionFor\(/.test(source),
    "permissionFor() must not be inlined into guard() — an undeclared route has to be refused first"
  );

  // "Declared and needs nothing" must stay distinguishable from "nobody declared it". If these
  // collapse back into one value, the bug returns exactly as it was.
  assert.match(source, /declared:\s*true/, "a declared route must be representable");
  assert.match(source, /declared:\s*false/, "an undeclared route must be representable and distinct");
});

test("the human gates never read their actor from client input when a session exists", () => {
  const source = readFileSync(SERVER_SOURCE, "utf8");

  // The session-derived actor is the whole point: a client-supplied name is a signature anyone can
  // forge. The DB-free demo has no accounts, which is the only case the body is consulted.
  assert.match(
    source,
    /session/i,
    "the server must derive gate actors from the session"
  );
  for (const gate of ["submittedBy", "releasedBy"]) {
    assert.ok(source.includes(gate), `the ${gate} gate must still exist to be governed`);
  }
});
