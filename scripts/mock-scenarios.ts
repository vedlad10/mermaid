/**
 * mock-scenarios.ts — populate the persistent dataset with MOCK patients and drive four complete
 * RCM journeys through the REAL application, over the REAL HTTP API.
 *
 * Run:  node --env-file-if-exists=.env scripts/mock-scenarios.ts
 *
 * ── WHY THIS EXERCISES THE APP RATHER THAN THE DATABASE ────────────────────────────────────────
 * Inserting rows would prove nothing: the questions worth answering here are whether a verification
 * produces a claim, whether the 837D passes the scrubber, whether an 835 posts to the right ledger,
 * and whether any of it can leak across patients. All of those are application behaviour. So this
 * boots `createApp(buildServices())` — the same composition root `npm run web` uses, on the same
 * Postgres, with the same outbox and the same RLS — and then talks to it with `fetch` exactly as a
 * browser would, through the human submit gate and everything else.
 *
 * ── THE SAFETY PIN ─────────────────────────────────────────────────────────────────────────────
 * `.env` carries EDI_ADAPTER=stedi. Left alone, every eligibility check below would be a real
 * 270/271 to a real clearinghouse for a member no payer has issued, and every submit a real claim.
 * The adapter is therefore pinned to `mock` BEFORE any module reads config, and the memoized adapter
 * is cleared so an earlier read cannot survive. This is the same pin, for the same reason, that
 * `tests/db/harness.ts` applies to the live-database suite.
 */
process.env.EDI_ADAPTER = "mock";
const { resetEdiAdapter, getEdiAdapter } = await import("@mermaid/edi");
resetEdiAdapter();

import type { AddressInfo } from "node:net";
import { createUser } from "@mermaid/auth";
import { withPractice } from "@mermaid/db";
import { createApp } from "../apps/web/server.ts";
import { buildServices } from "../apps/web/wiring.ts";

// ── Refuse to run against anything but the mock ────────────────────────────────────────────────
const adapter = getEdiAdapter();
if (adapter.constructor.name !== "MockEdiAdapter") {
  console.error(`REFUSING: adapter is ${adapter.constructor.name}, not MockEdiAdapter.`);
  process.exit(1);
}
console.log(`safety: EDI adapter = ${adapter.constructor.name} (no vendor traffic possible)\n`);

/** The practice that already exists. Nothing here creates or drops a practice. */
const PRACTICE = "663f0b39-e74e-40c4-a553-ba887f6c62b7";

/**
 * A deliberately obvious NON-DELIVERABLE address, copied from the shape the seeder and the vertical
 * tests already use. The 837D requires the subscriber address (loop 2010BA N3/N4) or the claim
 * cannot be filed; this must never appear on a real claim.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const plan = (tooth?: string) => [
  { code: "D0120", quantity: 1 },
  { code: "D1110", quantity: 1, fee: 11000 },
  { code: "D2750", quantity: 1, fee: 125000, ...(tooth ? { toothNumber: tooth } : {}) },
];

const server = createApp(buildServices());
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ── A clearly-marked mock operator. Existing accounts are not touched. ─────────────────────────
const EMAIL = "mock-scenario-runner@mocktest.invalid";
const PASSWORD = "correct-horse-battery";
try {
  await withPractice(PRACTICE, () =>
    createUser(PRACTICE, { email: EMAIL, name: "MOCK Scenario Runner", role: "owner", password: PASSWORD })
  );
  console.log(`created mock operator ${EMAIL}`);
} catch (e) {
  console.log(`mock operator already present (${e instanceof Error ? e.message.slice(0, 60) : e})`);
}

const login = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 200) {
  console.error("login failed", login.status, await login.text());
  process.exit(1);
}
const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
const { csrf } = (await login.json()) as { csrf: string };

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

const log = (...a: unknown[]) => console.log(...a);
/** Integer cents → dollars, for a line a person reads. `?` where the field was not present. */
const usd = (c: unknown) =>
  typeof c === "number" && Number.isFinite(c) ? `$${(c / 100).toFixed(2)}` : "?";
const hr = (t: string) => log("\n" + "=".repeat(88) + `\n${t}\n` + "=".repeat(88));

/** Everything recorded, for the report. */
const RESULTS: any[] = [];

/**
 * ── WHY THIS SCRIPT NOW HAS AN EXIT CODE ───────────────────────────────────────────────────────
 *
 * It had none. Every stage recorded what came back and moved on, deliberately — "nothing here
 * asserts success; a scenario that cannot proceed records why and returns" — which is the right
 * instinct for a script whose job is to REPORT, and it is also how the harness broke for a
 * fortnight without anybody noticing: it printed `undefined` four times and exited 0.
 *
 * So the distinction is drawn where it actually lies. A journey that stops because the PRODUCT
 * refused something is a finding and still exits 0 — that is the report doing its job. A journey
 * that stops because this SCRIPT could not read the response, or could not find the claim it just
 * caused, is a broken instrument, and a broken instrument must be loud.
 */
const FAILURES: string[] = [];
const fail = (why: string) => {
  FAILURES.push(why);
  log(`  ✖ HARNESS      : ${why}`);
};

/**
 * One journey. Every stage records what actually came back — including the stage where it stops.
 * Nothing here asserts success; a scenario that cannot proceed records why and returns.
 */
async function journey(opts: {
  id: string;
  first: string;
  last: string;
  dob: string;
  memberId: string;
  card: string;
  tooth: string;
  expect: string;
}) {
  hr(`${opts.id} — ${opts.first} ${opts.last} · member ${opts.memberId}\n${opts.expect}`);
  const rec: any = { scenario: opts.id, patient: `${opts.first} ${opts.last}`, dob: opts.dob, memberId: opts.memberId, stages: {} };

  // ── 1. Verification (creates the patient record as a side effect) ───────────────────────────
  const v = await call("POST", "/api/v1/verifications", {
    patient: {
      firstName: opts.first,
      lastName: opts.last,
      dateOfBirth: opts.dob,
      memberId: opts.memberId,
      address: SYNTHETIC_ADDRESS,
    },
    cardText: opts.card,
    planItems: plan(opts.tooth),
  });
  /**
   * ── THE RESPONSE IS NESTED, AND THIS SCRIPT DID NOT NOTICE FOR A FORTNIGHT ────────────────────
   *
   * `POST /api/v1/verifications` returns `{ record, review, audit, … }`. This read `v.json.id`, so
   * every field came back `undefined` — and because nothing here asserts, the run printed
   * "verification : HTTP 201 id=undefined status=undefined outcome=undefined" four times, exited 0,
   * and wrote a report. The harness described as the integration proof had been proving nothing
   * since the response shape changed.
   *
   * Read defensively rather than by pinning the new shape, because the same silence would follow the
   * next change — and then ASSERTED, below, so a shape drift is a failure rather than a blank line.
   */
  const record = v.json?.record ?? v.json;
  /* The decision is under `decision`, not `review` — `VerificationView` is `{ record, decision,
     patientSummary, freshness, provenance }`. Its `recommendedAction` is the sentence a coordinator
     is shown, so it is what the report records: a status without an instruction is half the story. */
  const decision = v.json?.decision;
  rec.stages.verification = {
    http: v.status,
    id: record?.id,
    status: record?.status,
    outcome: decision?.outcome,
    provenance: v.json?.provenance?.shortLabel,
    recommendedAction: decision?.recommendedAction,
  };
  log(
    `  verification : HTTP ${v.status} id=${record?.id} status=${record?.status} ` +
      `outcome=${decision?.outcome} [${v.json?.provenance?.shortLabel ?? "?"}]`
  );
  if (decision?.recommendedAction) log(`  action       : ${decision.recommendedAction}`);
  if (record?.exceptions?.length) {
    rec.stages.verification.exceptions = record.exceptions.map((e: any) => `[${e.severity}] ${e.code}`);
    log(`  flags        : ${rec.stages.verification.exceptions.join(", ")}`);
  }
  if (v.status !== 201) {
    rec.stoppedAt = "verification";
    fail(`${opts.id}: verification returned HTTP ${v.status}`);
    RESULTS.push(rec);
    return rec;
  }
  if (!record?.id) {
    rec.stoppedAt = "verification";
    fail(`${opts.id}: HTTP 201 but no verification id in the response — the shape has changed again`);
    RESULTS.push(rec);
    return rec;
  }
  rec.verificationId = record.id;

  // ── 2. The claim the outbox created from verification.completed ─────────────────────────────
  const claims = await call("GET", "/api/v1/claims");
  /**
   * Matched on the VERIFICATION this journey just created, not on the member id.
   *
   * The member id matches every claim any previous run left behind for the same synthetic patient,
   * so a second run picked up an already-paid claim from the first, tried to submit it, and reported
   * "A paid claim cannot be submitted" as though the product had refused something. The journey was
   * measuring its own litter.
   */
  const mine = (claims.json?.items ?? []).filter((c: any) => c.verificationId === rec.verificationId);
  rec.stages.claim = { http: claims.status, found: mine.length, ids: mine.map((c: any) => c.id), statuses: mine.map((c: any) => c.status) };
  log(`  claim        : HTTP ${claims.status} found=${mine.length} ${mine.map((c: any) => `${c.id}(${c.status})`).join(" ")}`);
  if (mine.length === 0) {
    rec.stoppedAt = "claim-creation";
    rec.gap = "no claim was created from this verification";
    /**
     * A harness failure, not a finding — with ONE exception, drawn here rather than glossed over.
     * A verification whose coverage came back terminated produces no claim, correctly and by design
     * (MOCK-S2a is that scenario on purpose). Anything else means the outbox did not deliver
     * `verification.completed`, and a silent claim that never appeared is the most expensive silence
     * this product has.
     */
    if (record?.status === "verified") {
      fail(`${opts.id}: verification ${rec.verificationId} completed and produced no claim`);
    } else {
      log(`  (no claim, and none expected — verification is ${record?.status})`);
    }
    RESULTS.push(rec);
    return rec;
  }
  const claimId = mine[mine.length - 1].id;
  rec.claimId = claimId;

  const detail = await call("GET", `/api/v1/claims/${encodeURIComponent(claimId)}`);
  /* `scrub.status` was never a field. The detail response reports the scrubber as two lists —
     `blockers` (filing is refused) and `advisories` (filing proceeds) — plus `canSubmit`, which is
     the answer the old `scrub=undefined` was reaching for. */
  rec.stages.claimDetail = {
    status: detail.json?.claim?.status,
    canSubmit: detail.json?.canSubmit,
    blockers: (detail.json?.blockers ?? []).map((b: any) => b.code),
    advisories: (detail.json?.advisories ?? []).map((a: any) => a.code),
    expectedInsurancePays: detail.json?.claim?.expectedInsurancePays,
    totalFee: detail.json?.claim?.totalFee,
  };
  log(
    `  claim detail : status=${rec.stages.claimDetail.status} canSubmit=${rec.stages.claimDetail.canSubmit} ` +
      `expectedPays=${usd(rec.stages.claimDetail.expectedInsurancePays)}` +
      (rec.stages.claimDetail.blockers.length ? ` blockers=[${rec.stages.claimDetail.blockers.join(", ")}]` : "") +
      (rec.stages.claimDetail.advisories.length ? ` advisories=[${rec.stages.claimDetail.advisories.join(", ")}]` : "")
  );

  /**
   * ── 2b. THE PRE-AUTH GATE, WHICH IS A STAGE AND NOT AN OBSTACLE ───────────────────────────────
   *
   * `plan()` includes a D2750 crown, and this practice's playbook requires the payer's approval for
   * one. So the scrubber blocks filing with `preauth-missing` and names the money at risk — which is
   * the single most valuable thing this product does, and which made every journey here stop at
   * "1 blocking issue(s) must be fixed before filing" and record it as a failure.
   *
   * It was never a failure. It is the gate working, and the practice's next act is to obtain the
   * authorisation and record its reference number. That is what this does — and it therefore
   * exercises the gate in both directions, which the old script did in neither.
   */
  const blockers: any[] = detail.json?.blockers ?? [];
  const preauthBlocked = blockers.some((b: any) => b.code === "preauth-missing");
  if (preauthBlocked) {
    const auth = await call("POST", `/api/v1/claims/${encodeURIComponent(claimId)}/preauth`, {
      status: "approved",
      referenceNumber: `AUTH-${opts.id}`,
      source: "payer-portal",
    });
    rec.stages.preauth = { http: auth.status, canSubmit: auth.json?.canSubmit, blockers: (auth.json?.blockers ?? []).length };
    log(`  pre-auth     : blocked, authorisation AUTH-${opts.id} recorded → HTTP ${auth.status} canSubmit=${auth.json?.canSubmit}`);
    if (auth.status !== 200) {
      rec.stoppedAt = "preauth";
      fail(`${opts.id}: recording an approved pre-authorisation returned HTTP ${auth.status}`);
      RESULTS.push(rec);
      return rec;
    }
  }

  // ── 3. The human submit gate → 837D on the wire ─────────────────────────────────────────────
  const sub = await call("POST", `/api/v1/claims/${encodeURIComponent(claimId)}/submit`, {});
  rec.stages.submit = {
    http: sub.status,
    status: sub.json?.claim?.status ?? sub.json?.status,
    controlNumber: sub.json?.claim?.submission?.controlNumber,
    patientControlNumber: sub.json?.claim?.submission?.patientControlNumber,
    ack: sub.json?.claim?.submission?.acknowledgement ?? sub.json?.acknowledgement,
    error: sub.json?.error,
  };
  log(`  submit/837D  : HTTP ${sub.status} status=${rec.stages.submit.status} ctrl=${rec.stages.submit.controlNumber} ack=${JSON.stringify(rec.stages.submit.ack)?.slice(0, 120)}`);
  if (sub.json?.error) log(`  submit error : ${JSON.stringify(sub.json.error).slice(0, 200)}`);
  if (sub.status !== 200) {
    rec.stoppedAt = "submit";
    RESULTS.push(rec);
    return rec;
  }

  // ── 4. The payer's advice: 835 fetched and posted ────────────────────────────────────────────
  const rem = await call("POST", "/api/v1/remittances/fetch", {});
  const items = rem.json?.items ?? [];
  rec.stages.remittance = { http: rem.status, count: items.length, note: rem.json?.note };
  log(`  835 / posting: HTTP ${rem.status} advices=${items.length} ${rem.json?.note ?? ""}`);
  /**
   * ── THE MONEY LINE PRINTED SIX QUESTION MARKS ─────────────────────────────────────────────────
   *
   * This read `it.posting ?? it` and then `p.charged` / `p.paid`. An advice carries `postings` — the
   * plural, one per claim — and the amounts are `chargedAmount` / `paidAmount`, so every field on
   * the one line that shows what a payer actually did resolved to `?`. Same class of silence as the
   * verification id, on the stage that matters most: whether the money posted correctly.
   */
  for (const it of items) {
    const advice = it.remittance ?? it;
    for (const p of advice.postings ?? []) {
      log(
        `      · claim=${p.patientControlNumber ?? p.claimId ?? "?"} charged=${usd(p.chargedAmount)} ` +
          `paid=${usd(p.paidAmount)} patientResp=${usd(p.patientResponsibility)} ` +
          `writeOff=${usd(p.variance?.contractualAdjustments)} recoverable=${usd(p.variance?.recoverableAmount)} ` +
          `→ ${p.disposition ?? "?"}`
      );
    }
    if ((advice.postings ?? []).length === 0) log(`      · advice ${advice.traceNumber ?? "?"} carries no payment lines`);
  }
  rec.stages.remittance.items = items;

  // ── 5. What money is still owed, and what the payer denied ──────────────────────────────────
  const recovery = await call("GET", "/api/v1/remittances/recovery");
  rec.stages.recovery = { http: recovery.status, totalRecoverable: recovery.json?.totalRecoverable, count: (recovery.json?.items ?? []).length };
  log(`  recovery     : HTTP ${recovery.status} queue=${rec.stages.recovery.count} totalRecoverable=${rec.stages.recovery.totalRecoverable}`);

  const denials = await call("GET", "/api/v1/denials");
  rec.stages.denials = { http: denials.status, count: (denials.json?.items ?? []).length, items: denials.json?.items };
  log(`  denials      : HTTP ${denials.status} open=${rec.stages.denials.count}`);

  rec.stoppedAt = "completed";
  RESULTS.push(rec);
  return rec;
}

// ── The four journeys ───────────────────────────────────────────────────────────────────────────
// Member-ID suffixes are the mock adapter's documented scenario triggers (platform/edi/mock):
//   ends 00 → coverage terminated · ends 77 → pre-auth missing (CO-197) · ends 99 → annual max
//   reached (pays ~40%) · ends 23 → coordination of benefits. Anything else adjudicates clean.

const A = { first: "Quinn", last: "Mocktest", dob: "1988-03-14", tooth: "19" };
const B = { first: "Rowan", last: "Mockcase", dob: "1979-11-02", tooth: "30" };
const C = { first: "Sasha", last: "Mockfile", dob: "1993-06-25", tooth: "14" };

await journey({
  id: "MOCK-S1",
  ...A,
  memberId: "MOCKS1A41",
  card: "Delta Dental\nMember ID: MOCKS1A41\nGroup #: MOCKGRP1",
  expect: "Clean claim → full adjudication → payment posted → reconciled.",
});

await journey({
  id: "MOCK-S2a",
  ...A,
  memberId: "MOCKS2B00",
  card: "MetLife Dental\nMember ID: MOCKS2B00\nGroup #: MOCKGRP2",
  expect: "STALE COVERAGE on file (ends 00 → terminated). Expect an eligibility problem, not a payment.",
});

await journey({
  id: "MOCK-S2b",
  ...A,
  memberId: "MOCKS2B42",
  card: "MetLife Dental\nMember ID: MOCKS2B42\nGroup #: MOCKGRP2",
  expect: "RE-VERIFICATION with the corrected member id. Expect valid eligibility → claim → payment.",
});

await journey({
  id: "MOCK-S3",
  ...B,
  memberId: "MOCKS3C77",
  card: "Cigna Dental\nMember ID: MOCKS3C77\nGroup #: MOCKGRP3",
  expect: "Denial path (ends 77 → pre-auth missing, CO-197 on the major line) → recovery/appeal.",
});

await journey({
  id: "MOCK-S4",
  ...C,
  memberId: "MOCKS4D99",
  card: "Aetna Dental\nMember ID: MOCKS4D99\nGroup #: MOCKGRP4",
  expect: "Underpayment (ends 99 → annual maximum reached, pays ~40%) → remaining recoverable.",
});

// ── Traceability: who owns what ─────────────────────────────────────────────────────────────────
hr("TRACEABILITY — patient directory and per-patient records");
const dir = await call("GET", "/api/v1/patients/directory");
log(`directory: HTTP ${dir.status} patients=${(dir.json?.items ?? []).length}`);
for (const p of dir.json?.items ?? []) {
  log(`  ${p.patientId ?? p.id}  ${p.firstName ?? p.name} ${p.lastName ?? ""}  dob=${p.dateOfBirth ?? p.dob ?? "?"}`);
}

const outFile = new URL("../.mock-scenarios-report.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(
  new URL(outFile).pathname.replace(/^\//, ""),
  JSON.stringify({ directory: dir.json, results: RESULTS }, null, 2)
);
log(`\nwrote report JSON`);

await new Promise<void>((r) => server.close(() => r()));
const { closePool } = await import("@mermaid/db");
await closePool();

/* The instrument reports on itself last, and loudly. See `FAILURES` above for the distinction
   between a product refusal (a finding, exit 0) and a harness that could not read the product. */
if (FAILURES.length > 0) {
  console.error(`\n${"!".repeat(88)}`);
  console.error(`HARNESS FAILED — ${FAILURES.length} stage(s) could not be driven:`);
  for (const f of FAILURES) console.error(`  · ${f}`);
  console.error(`${"!".repeat(88)}\n`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${RESULTS.length} journeys drove to completion or to a product refusal. Harness OK.\n`);
}
