/**
 * mock-scenarios-continue.ts — finish the two journeys that stopped at a human gate.
 *
 *   S2b  the re-verification was held by an `identity-collision` exception. Mermaid refuses to merge
 *        two possible people into one chart on its own, which is correct. The designed continuation
 *        is the review endpoint, so that is what this uses — not a workaround.
 *   S3   the denial was captured and triaged to `appeal`. This runs the real appeal workflow
 *        (draft → approve → submit), attempts a corrected refiling, and records the outcome.
 *
 * Same safety pin as mock-scenarios.ts: the adapter is forced to `mock` before config is read.
 */
process.env.EDI_ADAPTER = "mock";
const { resetEdiAdapter, getEdiAdapter } = await import("@mermaid/edi");
resetEdiAdapter();

import type { AddressInfo } from "node:net";
import { createApp } from "../apps/web/server.ts";
import { buildServices } from "../apps/web/wiring.ts";

const adapter = getEdiAdapter();
if (adapter.constructor.name !== "MockEdiAdapter") {
  console.error(`REFUSING: adapter is ${adapter.constructor.name}`);
  process.exit(1);
}
console.log(`safety: EDI adapter = ${adapter.constructor.name}\n`);

const server = createApp(buildServices());
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const login = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "mock-scenario-runner@mocktest.invalid", password: "correct-horse-battery" }),
});
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
const hr = (t: string) => log("\n" + "=".repeat(88) + `\n${t}\n` + "=".repeat(88));

// ── S2b — clear the identity-collision through the review gate ─────────────────────────────────
hr("MOCK-S2b — resolving the identity-collision through the human review gate");
const vlist = await call("GET", "/api/v1/verifications");
const v2b = (vlist.json?.items ?? []).find((v: any) => v.memberId === "MOCKS2B42" || v.member?.memberId === "MOCKS2B42");
log(`  found verification: ${v2b?.id} status=${v2b?.status}`);
if (v2b) {
  const rev = await call("POST", `/api/v1/verifications/${encodeURIComponent(v2b.id)}/review`, {
    decision: "approved",
    notes: "MOCK/TEST: confirmed same synthetic person; employer changed, MOCKS2B00 is stale and MOCKS2B42 is current.",
  });
  log(`  review       : HTTP ${rev.status} status=${rev.json?.status ?? rev.json?.verification?.status}`);

  const claims = await call("GET", "/api/v1/claims");
  const mine = (claims.json?.items ?? []).filter((c: any) => c.memberId === "MOCKS2B42" || c.patient?.memberId === "MOCKS2B42");
  log(`  claim        : found=${mine.length} ${mine.map((c: any) => `${c.id}(${c.status})`).join(" ")}`);
  if (mine.length > 0) {
    const id = mine[mine.length - 1].id;
    const sub = await call("POST", `/api/v1/claims/${encodeURIComponent(id)}/submit`, {});
    log(`  submit/837D  : HTTP ${sub.status} status=${sub.json?.claim?.status}`);
    const rem = await call("POST", "/api/v1/remittances/fetch", {});
    log(`  835/posting  : HTTP ${rem.status} advices=${(rem.json?.items ?? []).length}`);
  } else {
    log(`  GAP: review did not produce a claim.`);
  }
}

// ── S3 — the appeal workflow, then a corrected refiling ────────────────────────────────────────
hr("MOCK-S3 — appeal workflow (draft → approve → submit) and corrected refiling");
const dlist = await call("GET", "/api/v1/denials");
const d = (dlist.json?.items ?? [])[0];
log(`  denial       : id=${d?.id} carc=${d?.carcCode ?? d?.carc_code} amount=${d?.deniedAmount ?? d?.denied_amount_cents} status=${d?.status} disposition=${d?.disposition}`);

if (d) {
  const claimId = d.claimId ?? d.claim_id;
  const cdet = await call("GET", `/api/v1/claims/${encodeURIComponent(claimId)}`);
  const ctrl = cdet.json?.claim?.submission?.controlNumber ?? cdet.json?.claim?.patientControlNumber;
  const svc = cdet.json?.claim?.serviceDate;

  const draft = await call("POST", `/api/v1/denials/${encodeURIComponent(d.id)}/draft`, {
    memberId: "MOCKS3C77",
    claimControlNumber: String(ctrl ?? ""),
    serviceDate: String(svc ?? ""),
  });
  log(`  draft appeal : HTTP ${draft.status} status=${draft.json?.status} letterChars=${(draft.json?.appeal?.letter ?? draft.json?.letter ?? "").length}`);

  const appr = await call("POST", `/api/v1/denials/${encodeURIComponent(d.id)}/approve`, {});
  log(`  approve      : HTTP ${appr.status} status=${appr.json?.status} approvedBy=${appr.json?.appeal?.approvedBy ?? appr.json?.approvedBy}`);

  const subm = await call("POST", `/api/v1/denials/${encodeURIComponent(d.id)}/submit`, {});
  log(`  submit appeal: HTTP ${subm.status} status=${subm.json?.status} submittedAt=${subm.json?.appeal?.submittedAt ?? subm.json?.submittedAt}`);

  // A corrected claim (CLM05-3 frequency 7): submitting an already-submitted claim elects it.
  const refile = await call("POST", `/api/v1/claims/${encodeURIComponent(claimId)}/submit`, {});
  log(`  corrected refile: HTTP ${refile.status} status=${refile.json?.claim?.status} err=${JSON.stringify(refile.json?.error ?? "").slice(0, 160)}`);

  const rem2 = await call("POST", "/api/v1/remittances/fetch", {});
  log(`  835 after refile: HTTP ${rem2.status} advices=${(rem2.json?.items ?? []).length} ${rem2.json?.note ?? ""}`);

  const out = await call("POST", `/api/v1/denials/${encodeURIComponent(d.id)}/outcome`, {
    won: true,
    recoveredAmountDollars: 1125.0,
    notes: "MOCK/TEST: simulated payer overturn on appeal. No payer transaction occurred.",
  });
  log(`  outcome      : HTTP ${out.status} status=${out.json?.status} recovered=${out.json?.appeal?.recoveredAmount ?? out.json?.recoveredAmount}`);
}

// ── Final money + traceability ─────────────────────────────────────────────────────────────────
hr("FINAL STATE");
for (const p of ["/api/v1/remittances/recovery", "/api/v1/denials", "/api/v1/patients/directory"]) {
  const r = await call("GET", p);
  log(`${p} → HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
}

await new Promise<void>((r) => server.close(() => r()));
const { closePool } = await import("@mermaid/db");
await closePool();
