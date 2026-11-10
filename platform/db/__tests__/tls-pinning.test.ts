/**
 * TLS must be a property of the pool, not of whatever the connection string happens to say.
 *
 * ── WHAT THIS PINS, AND WHY A NAIVE VERSION WOULD NOT ──────────────────────────────────────────
 * node-postgres merges its two sources of `ssl` as
 *
 *     config = Object.assign({}, config, parse(config.connectionString))
 *
 * so the URL wins over an explicit option. Passing `ssl: { rejectUnauthorized: true }` alongside a
 * raw connection string is therefore inert when the URL sets `sslmode`, and actively REVERSED when
 * the URL says `no-verify` — a control that reads like enforcement and enforces nothing.
 *
 * These tests hold the two halves that make the pin real: that `sslmode` is removed from the string
 * (so the explicit option survives the merge), and that removing it does not disturb any other part
 * of the URL — a mangled password is an authentication failure that presents as an outage.
 *
 * The end-to-end proof that the pinned setting still connects is the live DB suite, which runs
 * every query in this repository through this pool.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withoutSslMode } from "../pool.ts";

test("sslmode is removed wherever it sits in the query string", () => {
  assert.equal(withoutSslMode("postgres://u:p@h:5432/db?sslmode=require"), "postgres://u:p@h:5432/db");
  assert.equal(
    withoutSslMode("postgres://u:p@h:5432/db?sslmode=require&channel_binding=require"),
    "postgres://u:p@h:5432/db?channel_binding=require"
  );
  assert.equal(
    withoutSslMode("postgres://u:p@h:5432/db?channel_binding=require&sslmode=require"),
    "postgres://u:p@h:5432/db?channel_binding=require"
  );
  assert.equal(
    withoutSslMode("postgres://u:p@h:5432/db?a=1&sslmode=verify-full&b=2"),
    "postgres://u:p@h:5432/db?a=1&b=2"
  );
});

test("a connection string that never mentioned sslmode is returned untouched", () => {
  const url = "postgres://u:p@h:5432/db";
  assert.equal(withoutSslMode(url), url);
  const withOthers = "postgres://u:p@h:5432/db?application_name=mermaid&connect_timeout=10";
  assert.equal(withoutSslMode(withOthers), withOthers);
});

test("the credential is never re-encoded — only the one parameter is touched", () => {
  /**
   * The reason this is textual rather than `new URL(...).toString()`. A password carrying reserved
   * characters round-trips through URL serialisation with different percent-encoding, and the
   * resulting failure is an authentication error that looks like the database is down.
   */
  const gnarly = "postgres://mermaid_app:p%40ss%2Fw0rd%3A%21@ep-x-y.aws.neon.tech:5432/db?sslmode=require";
  assert.equal(
    withoutSslMode(gnarly),
    "postgres://mermaid_app:p%40ss%2Fw0rd%3A%21@ep-x-y.aws.neon.tech:5432/db"
  );
});

test("a URL that tries to disable verification loses the ability to say so", () => {
  // `no-verify` is the case the pin exists for: alongside a raw string it would have overridden the
  // explicit option to `{ rejectUnauthorized: false }`. Stripped, it cannot reach the driver at all.
  assert.equal(withoutSslMode("postgres://u:p@h:5432/db?sslmode=no-verify"), "postgres://u:p@h:5432/db");
  assert.equal(
    withoutSslMode("postgres://u:p@h:5432/db?sslmode=disable&application_name=x"),
    "postgres://u:p@h:5432/db?application_name=x"
  );
});
