/**
 * A malformed id is "no such record", never "the server broke".
 *
 * ── THE DEFECT, AND WHY THE EXISTING TESTS COULD NOT SEE IT ────────────────────────────────────
 * Every one of these routes reads a path segment straight into a query against a `uuid` column, so
 * Postgres raises `invalid input syntax for type uuid` on anything that is not one. That is an
 * unhandled driver error. On live staging, six routes answered **500** to a request that should
 * simply not have found anything:
 *
 *     GET /api/v1/claims/not-a-uuid              500
 *     GET /api/v1/remittances/not-a-uuid         500
 *     GET /api/v1/denials/not-a-uuid             500
 *     GET /api/v1/verifications/not-a-uuid       500
 *     GET /api/v1/patients/record/not-a-uuid     500
 *     GET /api/v1/claims/not-a-uuid/timeline     500
 *
 * `claims-api.test.ts` and `remittance-api.test.ts` already asked for `does-not-exist` and asserted
 * 404 — and passed throughout, because these suites run against the IN-MEMORY repositories, where
 * an unknown key is simply a miss. Only a real `uuid` column rejects the string. The bug lived in
 * the gap between the two, which is why the assertion below is about the GUARD rather than about
 * the status: in memory, both a guarded and an unguarded route answer 404, and only the message
 * distinguishes them.
 *
 * Three things follow from the 500, and only the first is cosmetic: the caller is told the server
 * broke when it did not; every probe writes an `error` row to the audit trail and a stack to the
 * logs, so a scanner walking URLs looks like an outage; and 500 is the one status a client is
 * entitled to retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server.ts";
import { testServices } from "./server.test.ts";

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

async function req(
  base: string,
  method: string,
  path: string
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * Every route that names a record by uuid in its path. Kept as a list rather than a loop over the
 * router so that adding a route means deciding, here, whether its id is a uuid.
 */
const UUID_ROUTES: { method: "GET" | "POST"; path: (id: string) => string }[] = [
  { method: "GET", path: (id) => `/api/v1/claims/${id}` },
  { method: "GET", path: (id) => `/api/v1/claims/${id}/timeline` },
  { method: "GET", path: (id) => `/api/v1/remittances/${id}` },
  { method: "GET", path: (id) => `/api/v1/denials/${id}` },
  { method: "GET", path: (id) => `/api/v1/verifications/${id}` },
  { method: "GET", path: (id) => `/api/v1/patients/record/${id}` },
];

/**
 * Strings that reach the handler AS an id and are not one.
 *
 * `..` and other traversal shapes are deliberately absent: the URL parser normalises them away
 * before routing, so they are a route-not-found rather than a record-not-found, and asserting the
 * id guard on them would be asserting the wrong layer. Path traversal has its own test.
 *
 * `00000000-0000-0000-0000` is the interesting one — a truncated uuid is the shape most likely to
 * arrive from a real client that sliced an id for display, which is exactly how the ids in this
 * product's own UI are abbreviated.
 */
const MALFORMED = ["not-a-uuid", "abc", "1", "00000000-0000-0000-0000", "null", "undefined"];

test("a malformed id is refused before it reaches the database", async () => {
  await withServer(async (base) => {
    for (const route of UUID_ROUTES) {
      for (const bad of MALFORMED) {
        const res = await req(base, route.method, route.path(bad));
        assert.equal(
          res.status,
          404,
          `${route.method} ${route.path(bad)} answered ${res.status} — a bad id is a miss, not a fault`
        );
        assert.equal(
          res.json.error.code,
          "not_found",
          `${route.path(bad)} must use the not_found envelope`
        );
        /**
         * The guard's own wording, not the service's ("Claim not found.", "Remittance not found.").
         * In memory an unguarded route reaches the repository and misses, answering 404 anyway — so
         * the STATUS cannot tell the two apart and this message is what proves the guard ran at all.
         */
        assert.equal(
          res.json.error.message,
          "No such record.",
          `${route.path(bad)} answered from the service, so the id was passed through to a uuid column`
        );
      }
    }
  });
});

test("a well-formed id that does not exist still reaches the service", async () => {
  /**
   * The other half, and the reason the guard checks SHAPE and not membership. A real uuid must go on
   * to the repository and get the resource's own answer — a guard that short-circuited every miss
   * would make "not found" unable to distinguish a deleted claim from a typo, and would quietly
   * disable the real lookup.
   */
  await withServer(async (base) => {
    const absent = "00000000-0000-4000-8000-000000000000";
    const res = await req(base, "GET", `/api/v1/claims/${absent}`);
    assert.equal(res.status, 404);
    assert.equal(
      res.json.error.message,
      "Claim not found.",
      "a well-formed id must be answered by the module that owns the record"
    );
  });
});
