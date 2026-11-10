/**
 * End-to-end HTTP test of the clinic demo server: boots the real node:http app over an in-memory
 * service on an ephemeral port and drives it through fetch — the whole transport → service →
 * deterministic-pipeline stack. This is the first genuine integration test in the project (the
 * pipeline was previously only tested as a library).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp, type Services } from "../server.ts";
import { buildServices } from "../wiring.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

/**
 * The business suite runs against the SAME composition root the server uses, forced in-memory.
 *
 * That is deliberate: these tests exist to prove the API contract and the business flows, and they
 * must exercise the wiring that actually ships rather than a parallel hand-rolled copy that can
 * drift from it. Durability and tenant isolation are proven separately, against a real database,
 * in tests/db/.
 */
export function testServices(): Services {
  return buildServices({ inMemory: true, bus: new InMemoryOutbox() });
}

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

// Node's fetch types Response.json() as `unknown`; this test speaks the API's JSON loosely.
async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const CLEAN = {
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" , address: SYNTHETIC_ADDRESS},
  cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
  planItems: [
    { code: "D0120", quantity: 1 },
    { code: "D1110", quantity: 1, feeDollars: 110 },
    { code: "D2750", quantity: 1, feeDollars: 1250 },
  ],
};

const INACTIVE = {
  patient: { firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03", memberId: "MEM10000" , address: SYNTHETIC_ADDRESS},
  cardText: "Delta Dental\nMember ID: MEM10000",
  planItems: [{ code: "D2750", quantity: 1, feeDollars: 1250 }],
};

test("GET /api/v1/health returns ok", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/api/v1/health");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    /**
     * Health also reports the running build. It answered `{ ok: true }` and nothing else, so the
     * only way to tell whether a browser was talking to new code was to grep the served bundle for
     * a string from it — which is exactly the hour that got spent when a stale cached `app.js` made
     * a correct deploy look like it had not happened.
     */
    assert.ok("commit" in json, "the running build must be reportable");
    assert.ok(typeof json.startedAt === "string", "and when this process started");
  });
});

test("GET /api/v1/reference/cdt returns the catalog", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/api/v1/reference/cdt");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items) && json.items.length > 0);
    assert.ok(json.items[0].code && json.items[0].typicalFeeUsd);
  });
});

test("POST create → 201 verified; feeDollars is converted to cents at the boundary", async () => {
  await withServer(async (base) => {
    const { status, json: view } = await req(base, "POST", "/api/v1/verifications", CLEAN);
    assert.equal(status, 201);
    assert.equal(view.record.status, "verified");
    assert.equal(view.decision.outcome, "complete");
    // Crown fee entered as $1250 dollars must land as 125000 cents in the domain record.
    const crown = view.record.calculation.lines.find((l: { code: string }) => l.code === "D2750");
    assert.equal(crown.fee, 125000);
    assert.ok(view.patientSummary.length > 0);
  });
});

test("create → list → detail round-trips", async () => {
  await withServer(async (base) => {
    const { json: created } = await req(base, "POST", "/api/v1/verifications", CLEAN);
    const { json: list } = await req(base, "GET", "/api/v1/verifications");
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, created.record.id);

    const { json: detail } = await req(base, "GET", `/api/v1/verifications/${created.record.id}`);
    assert.equal(detail.record.id, created.record.id);
    assert.deepEqual(detail.record.calculation, created.record.calculation);
  });
});

test("inactive coverage → needs_review, then human review settles it", async () => {
  await withServer(async (base) => {
    const { json: created } = await req(base, "POST", "/api/v1/verifications", INACTIVE);
    assert.equal(created.record.status, "needs_review");
    assert.equal(created.decision.outcome, "needs_human");

    const { json: reviewed } = await req(base, "POST", `/api/v1/verifications/${created.record.id}/review`, {
      decision: "approved",
      notes: "Confirmed active by phone.",
    });
    assert.equal(reviewed.record.status, "reviewed");
    assert.equal(reviewed.decision.outcome, "complete");
    assert.equal(reviewed.record.review.decision, "approved");
  });
});

test("GET unknown id → 404 with the error envelope", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "GET", "/api/v1/verifications/nope");
    assert.equal(status, 404);
    assert.equal(json.error.code, "not_found");
  });
});

test("POST create with missing cardText → 400 validation error", async () => {
  await withServer(async (base) => {
    const { status, json } = await req(base, "POST", "/api/v1/verifications", {
      patient: CLEAN.patient,
      planItems: CLEAN.planItems,
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "validation_error");
  });
});

test("GET / serves the UI shell", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Mermaid/);
  });
});

test("static path traversal is refused", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/../package.json`);
    assert.ok(res.status === 404 || res.status === 403);
  });
});

/**
 * The shell and the client have to agree on the tab set.
 *
 * There is no build step and no framework here, so nothing but this test connects the `data-tab`
 * attributes in index.html to the branches in app.js's `loadQueue`. Adding a tab and forgetting to
 * wire it produces a button that silently does nothing — which is exactly the class of defect a
 * no-framework UI trades away type safety for, and therefore the one worth spending a test on.
 */
test("every tab in the shell is one the client knows how to load", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const js = await (await fetch(`${base}/app.js`)).text();

    const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(
      tabs,
      // `testlab` is the Integration Test / Stedi Test Lab — an observability screen reporting on the
      // product rather than running it, which is why it sits last in the rail.
      ["today", "verifications", "claims", "money", "recovery", "patients", "insights", "ops", "testlab"],
      "the tab set changed — update loadQueue() and switchTab() to match"
    );

    /**
     * Exactly one tab starts selected in the STATIC shell, and it is Today.
     *
     * `start()` may move the selection: the rail is now built from the permission list the session
     * returns, and a role that cannot open Today lands on the first tab it can (see
     * navigation-matches-permissions.test.ts). This assertion is about the markup as shipped, which
     * is still the right default for everyone who can open it.
     *
     * The pattern tolerates attributes between the two, because `data-requires` now sits there.
     */
    const selected = [...html.matchAll(/data-tab="([a-z]+)"[^>]*?aria-selected="true"/g)].map((m) => m[1]!);
    assert.deepEqual(selected, ["today"]);

    for (const tab of tabs) {
      assert.ok(
        js.includes(`"${tab}"`),
        `app.js has no branch for the "${tab}" tab — the button would do nothing`
      );
    }
  });
});

/**
 * M22 — a recoupment has to reach the SCREEN, not just the aggregate.
 *
 * `providerAdjustments` has always reached the API view (asserted against the service in
 * `today-stopped-money.test.ts` and `remittance/service.test.ts`), and for a while nothing drew it.
 * The attribution got to a human only through `holdReason` and the Today subtitle, which carry the
 * FIRST blocker's message, so an advice with two takebacks and an unrelated blocker showed one
 * sentence and the rest stayed in the database.
 *
 * Asserted here for the same reason as the tab wiring above: there is no build step and no
 * framework, so nothing but this test connects data that is on the view to the code that renders
 * it. Deleting the section is exactly the regression this catches.
 */
test("the remittance screen renders the payer's provider-level adjustments", async () => {
  await withServer(async (base) => {
    const js = await (await fetch(`${base}/app.js`)).text();

    assert.match(js, /function providerAdjustmentsSection\(/, "the provider-adjustment renderer is gone");
    assert.ok(
      js.includes("${providerAdjustmentsSection(r)}"),
      "the remittance screen no longer calls the renderer — a takeback would be invisible again"
    );
    assert.ok(
      js.includes("r.providerAdjustments"),
      "the renderer must read the adjustments off the remittance it was given"
    );
    // Attribution is a match against THIS advice's claims — never a prefix or a nearest neighbour.
    assert.match(
      js,
      /byControlNumber\.has\(p\.referenceId\)/,
      "attribution must stay an exact match against a posting on this advice"
    );
  });
});

/**
 * M24 instance 4 — the discarded scope has to be on the screen, not only in the read model.
 *
 * The provenance block is where a coordinator looks before quoting a patient, so it is where a
 * "the payer also described another scope" disclosure belongs. Same no-build-step reasoning as the
 * tests above: nothing but this connects the server's `provenance` object to the code that draws it.
 */
test("the provenance block discloses benefit scopes the payer stated and the quote discarded", async () => {
  await withServer(async (base) => {
    const js = await (await fetch(`${base}/app.js`)).text();

    assert.ok(js.includes("p.supersededNote"), "the provenance block must render the disclosure sentence");
    assert.ok(
      js.includes("p.supersededBenefits"),
      "the provenance block must show the count, including when it is zero"
    );
    // Never-counted must stay visibly different from counted-and-zero on the screen too.
    assert.ok(js.includes('"not counted"'), "an uncounted record must not render as zero discarded scopes");
  });
});

/** The API surface the new screens depend on, asserted from the transport a browser actually uses. */
test("the Today and Insights screens have the endpoints they call", async () => {
  await withServer(async (base) => {
    for (const path of [
      "/api/v1/today",
      "/api/v1/analytics/report",
      "/api/v1/patients",
      // The patient master (M14 deliverable 4). Distinct from `/patients` above, which lists
      // ACCOUNTS with balances — a person verified and never billed is on one and not the other.
      "/api/v1/patients/directory",
      "/api/v1/ops/outbox",
      "/api/v1/ops/readiness",
      "/api/v1/ops/audit",
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${path} must answer the UI`);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    }
    const sweep = await fetch(`${base}/api/v1/claims/filing-sweep`, { method: "POST" });
    assert.equal(sweep.status, 200, "the Today tab's deadline check must be reachable");
  });
});

/**
 * ── `hidden` MUST ACTUALLY HIDE ────────────────────────────────────────────────────────────────
 *
 * The browser's `[hidden] { display: none }` lives in the USER-AGENT stylesheet, and ANY author rule
 * beats it regardless of specificity. `.login { display: flex }` and `.layout { display: grid }`
 * silently cancelled it, so `el.hidden = true` did nothing to either — and those two elements are
 * exactly what the sign-in gate switches between.
 *
 * The result: the DB-free demo showed a sign-in form for a deployment with no accounts, and a
 * Postgres deployment rendered the whole app shell around the login panel to someone who had not
 * signed in. Nothing leaked — every API call 401s without a session — but the gate was not a gate.
 *
 * Asserted from the stylesheet rather than from a rendered page because this suite has no DOM. It is
 * the shape of the bug that matters: a class with `display` will out-rank the UA rule again the next
 * time one is added, and only an `!important` reset is immune to that.
 */
test("the stylesheet forces [hidden] to win over any layout rule", async () => {
  await withServer(async (base) => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(
      css.replace(/\s+/g, " "),
      /\[hidden\] \{ display: none !important; \}/,
      "without this reset, .login and .layout out-rank the user-agent [hidden] rule and the gate stops gating"
    );

    // Both elements the gate toggles still declare a `display`, which is what makes the reset needed.
    assert.match(css, /\.login \{[^}]*display: flex/s);
    assert.match(css, /\.layout \{[^}]*display: grid/s);
  });
});

/**
 * The route table is matched most-specific-first, and `/patients/:key` is greedy enough to swallow
 * anything added beneath it. Both new routes sit ABOVE it for that reason; this asserts the ordering
 * rather than trusting it, because getting it wrong fails as a confusing 404 from the ledger rather
 * than as an obvious mis-route.
 */
/**
 * ── THE SPOOF THIS CLOSES ──────────────────────────────────────────────────────────────────────
 * `clientIp` used to prefer the FIRST `x-forwarded-for` entry unconditionally. That header belongs
 * to whoever sent the request unless a proxy this deployment controls rewrites it, and the first
 * entry stays client-controlled even when a proxy appends its own — so a credential-stuffing script
 * that varied the header per request got a fresh rate-limit bucket on every guess, and the audit
 * trail recorded whatever address the attacker chose. The throttle on the one endpoint that guards
 * password guessing against PHI limited nothing.
 */
test("a client-supplied x-forwarded-for cannot choose the rate-limit identity", async () => {
  const { clientIpFrom } = await import("../server.ts");
  const SOCKET = { kind: "socket" } as const;
  const ONE_HOP = { kind: "forwarded", hops: 1 } as const;

  // Default deployment: no proxy declared. The header is a stranger's claim and is ignored.
  assert.equal(clientIpFrom({ forwardedFor: "6.6.6.6" }, "203.0.113.9", SOCKET), "203.0.113.9");
  assert.equal(clientIpFrom({ forwardedFor: "a, b, c" }, "203.0.113.9", SOCKET), "203.0.113.9");
  assert.equal(clientIpFrom({}, "203.0.113.9", SOCKET), "203.0.113.9");
  // …including the Cloudflare header, which means nothing when no Cloudflare was declared.
  assert.equal(clientIpFrom({ cfConnectingIp: "6.6.6.6" }, "203.0.113.9", SOCKET), "203.0.113.9");

  // Behind ONE declared proxy, the entry the PROXY appended (the last) is the client — never the
  // first, which the client wrote. This is the difference between reading our own proxy's word
  // and reading the attacker's.
  assert.equal(clientIpFrom({ forwardedFor: "6.6.6.6, 198.51.100.7" }, "10.0.0.1", ONE_HOP), "198.51.100.7");
  assert.equal(clientIpFrom({ forwardedFor: "198.51.100.7" }, "10.0.0.1", ONE_HOP), "198.51.100.7");
  // A proxy that sent an empty header proves nothing; fall back to the socket.
  assert.equal(clientIpFrom({ forwardedFor: "" }, "10.0.0.1", ONE_HOP), "10.0.0.1");
  assert.equal(clientIpFrom({ forwardedFor: " , " }, "10.0.0.1", ONE_HOP), "10.0.0.1");

  // No socket address and nothing trustworthy → null, never a fabricated identity.
  assert.equal(clientIpFrom({ forwardedFor: "6.6.6.6" }, undefined, SOCKET), null);
});

/**
 * ── THE CLOUDFLARE-FRONTED SHAPE ───────────────────────────────────────────────────────────────
 * Client → Cloudflare → the platform's router → this process, over loopback. Under
 * `TRUST_PROXY=0` every audit row in that shape records `ip=::1`.
 *
 * Cloudflare APPENDS to `x-forwarded-for` (its own documentation), so the left of that chain stays
 * whatever the client typed — which is why the hop count has to be counted from the right, and why
 * `cf-connecting-ip`, a single value the edge generates from the connection it terminated, is the
 * one this deployment declares.
 */
test("the declared source decides which value is read, and a forged header never wins", async () => {
  const { clientIpFrom } = await import("../server.ts");
  const CF = { kind: "cloudflare" } as const;
  const TWO_HOPS = { kind: "forwarded", hops: 2 } as const;
  const RENDER_LOOPBACK = "::1";

  // (a) Cloudflare → Render, the real shape: the edge's own header is the client.
  assert.equal(
    clientIpFrom(
      { cfConnectingIp: "203.0.113.9", forwardedFor: "203.0.113.9, 172.71.150.4" },
      RENDER_LOOPBACK,
      CF
    ),
    "203.0.113.9"
  );

  // (b) The same request, read by hop count instead. Both answers agree — which is what makes the
  // Cloudflare header the safer of two correct readings rather than a different one.
  assert.equal(
    clientIpFrom({ forwardedFor: "203.0.113.9, 172.71.150.4" }, RENDER_LOOPBACK, TWO_HOPS),
    "203.0.113.9"
  );

  // (c) The spoof. A client sends BOTH headers; Cloudflare appends the address it saw, so the
  // forged entry is pushed left and the count still lands on the real client.
  assert.equal(
    clientIpFrom(
      { cfConnectingIp: "203.0.113.9", forwardedFor: "6.6.6.6, 203.0.113.9, 172.71.150.4" },
      RENDER_LOOPBACK,
      CF
    ),
    "203.0.113.9",
    "the edge's own header is not affected by anything the client put in the chain"
  );
  assert.equal(
    clientIpFrom({ forwardedFor: "6.6.6.6, 203.0.113.9, 172.71.150.4" }, RENDER_LOOPBACK, TWO_HOPS),
    "203.0.113.9",
    "counting from the right walks past the client's own entry"
  );

  // (d) A duplicated cf-connecting-ip arrives joined by node, which is not an IP literal. Refused
  // outright rather than half-parsed: the fallback is the socket, never the attacker's half.
  assert.equal(
    clientIpFrom({ cfConnectingIp: "6.6.6.6, 203.0.113.9" }, RENDER_LOOPBACK, CF),
    RENDER_LOOPBACK
  );

  // (e) Missing headers. Declaring an edge does not conjure one: fall back to the socket.
  assert.equal(clientIpFrom({}, RENDER_LOOPBACK, CF), RENDER_LOOPBACK);
  assert.equal(clientIpFrom({ forwardedFor: "198.51.100.7" }, RENDER_LOOPBACK, TWO_HOPS), RENDER_LOOPBACK,
    "a chain shorter than the declared hops did not arrive the way this deployment says it does");

  // (f) IPv6, both as the edge's value and inside the chain.
  assert.equal(clientIpFrom({ cfConnectingIp: "2001:db8::1" }, RENDER_LOOPBACK, CF), "2001:db8::1");
  assert.equal(
    clientIpFrom({ forwardedFor: "2001:db8::1, 172.71.150.4" }, RENDER_LOOPBACK, TWO_HOPS),
    "2001:db8::1"
  );
  // A bare IPv6 address is all colons and must not be mistaken for host:port.
  assert.equal(clientIpFrom({ cfConnectingIp: "2001:db8:85a3::8a2e:370:7334" }, RENDER_LOOPBACK, CF),
    "2001:db8:85a3::8a2e:370:7334");

  // (g) Ports, which real proxies emit in both families, and neither shape should lose the address.
  assert.equal(clientIpFrom({ cfConnectingIp: "203.0.113.9:54321" }, RENDER_LOOPBACK, CF), "203.0.113.9");
  assert.equal(clientIpFrom({ cfConnectingIp: "[2001:db8::1]:54321" }, RENDER_LOOPBACK, CF), "2001:db8::1");

  // (h) Values that are not addresses at all. `unknown` is a real proxy convention; the rest is what
  // an attacker sends. None of them may become a rate-limit bucket or an audit row.
  for (const junk of ["unknown", "not-an-ip", "<script>", "203.0.113", "999.999.999.999", "  "]) {
    assert.equal(clientIpFrom({ cfConnectingIp: junk }, RENDER_LOOPBACK, CF), RENDER_LOOPBACK, junk);
    assert.equal(clientIpFrom({ forwardedFor: `${junk}, 172.71.150.4` }, RENDER_LOOPBACK, TWO_HOPS),
      RENDER_LOOPBACK, junk);
  }

  // (i) And the whole point: two different clients are two different identities.
  assert.notEqual(
    clientIpFrom({ cfConnectingIp: "203.0.113.9" }, RENDER_LOOPBACK, CF),
    clientIpFrom({ cfConnectingIp: "198.51.100.7" }, RENDER_LOOPBACK, CF)
  );
});

test("the patient-record routes are not swallowed by the ledger's :key route", async () => {
  await withServer(async (base) => {
    const directory = await fetch(`${base}/api/v1/patients/directory`);
    assert.equal(directory.status, 200);
    const listed = (await directory.json()) as { items?: unknown };
    assert.ok(Array.isArray(listed.items), "not the ledger statement for a member named 'directory'");

    const record = await fetch(`${base}/api/v1/patients/record/00000000-0000-4000-8000-000000000000`);
    assert.equal(record.status, 404);
    const missing = (await record.json()) as { error: { code: string } };
    assert.equal(missing.error.code, "not_found");
  });
});
