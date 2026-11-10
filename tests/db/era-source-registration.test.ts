/**
 * Registering an ERA source over HTTP encrypts the credential; readiness flags one that is not
 * (NEW-11).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `era_sources.credential` holds a clearinghouse API key that fetches a practice's payment files.
 * `PgEraSourceRepository.upsert` runs it through `encryptPhi` before it lands — and nothing outside
 * a test ever called that method. The only way to register a source was hand-written SQL against
 * the table, and hand-written SQL writes exactly what it is handed.
 *
 * So the encryption existed and was not used, which is the same distinction as between a control
 * and a claim about one. Worse, nothing could tell the two apart: a plaintext credential and an
 * encrypted one are both just text in a column, and no screen, check or log mentioned either.
 *
 * ── WHY THE ASSERTIONS READ THE COLUMN ───────────────────────────────────────────────────────────
 * The envelope is what `encryptPhi` produces, so its presence in the RAW column is the whole proof.
 * Asking the repository would only prove the repository can decrypt what it wrote.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createUser } from "@mermaid/auth";
import { requireContext, withPractice } from "@mermaid/db";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";
let probe: pg.Client | null = null;

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (probe) await probe.end().catch(() => {});
  await dropPractices(...created);
  await shutdown();
});

async function app(): Promise<string> {
  if (base) return base;
  server = createApp(buildServices());
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

/** The owner connection — `era_sources` is RLS-scoped, and this reads the raw column across it. */
async function raw(): Promise<pg.Client> {
  if (probe) return probe;
  probe = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL });
  await probe.connect();
  return probe;
}

/**
 * A signed-in user for a throwaway practice.
 *
 * `role` matters and is not incidental: registering a source is `remittances.write`, which a BILLER
 * holds — that is the point, because it is the people who work remittances who set up where the
 * remittances come from. `/ops/readiness` is `audit.read`, which a biller does NOT hold, so the
 * readiness test signs in as an office manager. Two permissions, two audiences, deliberately.
 */
async function signedIn(label: string, role: "biller" | "office_manager" = "biller") {
  const practiceId = await makePractice(label);
  created.push(practiceId);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () =>
    createUser(practiceId, { email, name: `${label} User`, role, password })
  );

  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { practiceId, call };
}

test("a source registered over HTTP stores its credential ENCRYPTED", dbTest, async () => {
  const { practiceId, call } = await signedIn("era-register");
  const secret = `sk-live-${randomBytes(8).toString("hex")}`;

  const res = await call("POST", "/api/v1/ops/era-sources", {
    vendor: "stedi",
    credential: secret,
    payeeNpi: "1234567893",
  });
  const body = (await res.json()) as {
    source: { vendor: string; credentialConfigured: boolean; credentialEncrypted: boolean };
  };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.source.credentialConfigured, true);
  assert.equal(body.source.credentialEncrypted, true);

  // ── The proof is in the column ────────────────────────────────────────────────────────────────
  const c = await raw();
  const { rows } = await c.query<{ credential: string }>(
    "SELECT credential FROM era_sources WHERE practice_id = $1 AND vendor = 'stedi'",
    [practiceId]
  );
  assert.equal(rows.length, 1);
  assert.match(
    rows[0]!.credential,
    /^v2:/,
    "the stored credential must carry the ROW-BOUND envelope (NEW-25). A row without any envelope " +
      "is a live clearinghouse key readable in every backup of this database; a `v1:` one is " +
      "encrypted but not tied to its row, so it could be moved into another practice's source and " +
      "would decrypt there."
  );
  assert.ok(
    !rows[0]!.credential.includes(secret),
    "and the plaintext must appear nowhere in the stored value"
  );
});

test("the credential is never echoed back — not the value, not a prefix", dbTest, async () => {
  /**
   * A registration response that confirmed the key by showing part of it would put it in a browser
   * history, a proxy log and a screenshot. `EraSourceSummary` cannot carry one by construction;
   * this asserts the shape that reaches the wire agrees.
   */
  const { call } = await signedIn("era-echo");
  const secret = `sk-live-${randomBytes(8).toString("hex")}`;

  const created1 = await (await call("POST", "/api/v1/ops/era-sources", { vendor: "stedi", credential: secret })).text();
  const listed = await (await call("GET", "/api/v1/ops/era-sources")).text();

  for (const [what, payload] of [["the registration response", created1], ["the list", listed]] as const) {
    assert.ok(!payload.includes(secret), `${what} contains the credential`);
    assert.ok(!payload.includes(secret.slice(0, 12)), `${what} contains a prefix of the credential`);
    assert.ok(!/"credential"\s*:/.test(payload), `${what} carries a credential field at all`);
  }
});

test("readiness FAILS while a credential sits in the clear, and passes once it is re-registered", dbTest, async () => {
  const { practiceId, call } = await signedIn("era-plaintext", "office_manager");

  /**
   * The hand-written-SQL path this route replaces, reproduced exactly: an INSERT that writes what
   * it is given. This is how every ERA source in this deployment was registered before now.
   */
  await withPractice(practiceId, () =>
    requireContext().tx.query(
      `INSERT INTO era_sources (id, practice_id, vendor, credential, payee_npi, cursor, enabled)
       VALUES ($1,$2,'stedi','sk-live-in-the-clear','1234567893',NULL,true)`,
      [randomUUID(), practiceId]
    )
  );

  const before = await call("GET", "/api/v1/ops/readiness");
  const beforeBody = (await before.json()) as { checks: { name: string; ok: boolean; detail: string }[] };
  const flagged = beforeBody.checks.find((c) => c.name === "era_credentials_encrypted");
  assert.ok(flagged, "readiness must have something to say about ERA credentials at all");
  assert.equal(flagged!.ok, false, "a credential stored in plaintext is not a ready deployment");
  assert.match(flagged!.detail, /PLAINTEXT/);
  assert.match(flagged!.detail, /Rotate the key/i, "and it must say the key is now compromised, not just misfiled");
  assert.equal(before.status, 503);

  // ── Re-registering through the route fixes it ────────────────────────────────────────────────
  const fixed = await call("POST", "/api/v1/ops/era-sources", {
    vendor: "stedi",
    credential: `sk-live-${randomBytes(8).toString("hex")}`,
    payeeNpi: "1234567893",
  });
  assert.equal(fixed.status, 200);

  const after = (await (await call("GET", "/api/v1/ops/readiness")).json()) as {
    checks: { name: string; ok: boolean }[];
  };
  assert.equal(
    after.checks.find((c) => c.name === "era_credentials_encrypted")?.ok,
    true,
    "and the check clears — the same one row, now through the repository that encrypts"
  );
});

test("re-registering does NOT rewind the polling cursor", dbTest, async () => {
  /**
   * Rotating a key or correcting an NPI must not re-offer every artifact the practice has ever
   * taken in. The repository has always had this rule; the route has to pass through it rather
   * than around it, which is the whole reason registration goes through the repository at all.
   */
  const { practiceId, call } = await signedIn("era-cursor");

  await call("POST", "/api/v1/ops/era-sources", { vendor: "stedi", credential: "sk-one", payeeNpi: "1234567893" });
  await withPractice(practiceId, () =>
    requireContext().tx.query("UPDATE era_sources SET cursor = 'page-42' WHERE practice_id = $1", [practiceId])
  );

  await call("POST", "/api/v1/ops/era-sources", { vendor: "stedi", credential: "sk-two", payeeNpi: "1234567893" });

  const c = await raw();
  const { rows } = await c.query<{ cursor: string | null }>(
    "SELECT cursor FROM era_sources WHERE practice_id = $1 AND vendor = 'stedi'",
    [practiceId]
  );
  assert.equal(rows[0]!.cursor, "page-42", "the cursor moves only when a page has actually been read");
});

test("a malformed payee NPI is refused at the edge", dbTest, async () => {
  /**
   * The payee NPI is what the ingest cross-checks an 835's payee against before a cent is posted —
   * the control that stops one practice's payment landing in another's ledger. A malformed one
   * makes that check compare against something no payer will ever send: every file held, for a
   * reason nobody would look for here.
   */
  const { call } = await signedIn("era-npi");
  const res = await call("POST", "/api/v1/ops/era-sources", {
    vendor: "stedi",
    credential: "sk-live-x",
    payeeNpi: "12345",
  });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /10 digits/);
});
