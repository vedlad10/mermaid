/**
 * The migration runner refuses an argument it does not understand.
 *
 * ── WHY THIS IS WORTH A TEST ───────────────────────────────────────────────────────────────────
 * `--status` is the only flag, and ANY other argument used to fall through to the default action,
 * which is to write DDL to whatever database is configured. So `migrate.mjs status`, `--statu`, or
 * `--dry-run` silently applied migrations: the reading most likely to be a typo produced the least
 * reversible outcome. It was found the way such things are found — by typing `status` instead of
 * `--status` against a staging database and watching a migration apply.
 *
 * That is the opposite of how the rest of this system behaves. An undeclared route is refused, a
 * monitor that cannot take a reading alarms rather than reporting calm, an unbalanced 835 stops
 * before money moves. A migration runner is the last place to be generous about what it accepts.
 *
 * Spawned as a subprocess with NO connection string, which is exactly what makes the assertion
 * meaningful: refusing a bad argument must not depend on having credentials, so the check has to
 * run before anything else. If it ever moves back below the credential check, the process would
 * exit 1 with a different message and these tests fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrate.mjs");

/** No DATABASE_URL and no DATABASE_ADMIN_URL: nothing here can reach a database. */
function run(...args) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DATABASE_ADMIN_URL;
  const r = spawnSync(process.execPath, [RUNNER, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("a mistyped flag is refused, not treated as permission to apply", () => {
  for (const arg of ["status", "--statu", "--dry-run", "-s", "apply", "--help"]) {
    const { code, out } = run(arg);
    assert.equal(code, 2, `"${arg}" should be refused with exit 2, got ${code}`);
    assert.match(out, /unrecognized argument/i, `"${arg}"`);
    assert.match(out, new RegExp(arg.replace(/[-]/g, "\-")), `the message names "${arg}" so a person can see the typo`);
    assert.doesNotMatch(out, /Applied |applied \d+ migration/i, `"${arg}" must not have applied anything`);
  }
});

test("the refusal happens before credentials are even looked for", () => {
  /**
   * The ordering IS the property. A runner that validated arguments after loading a connection
   * string would apply migrations for anyone who had one, which is everyone who runs it in anger.
   */
  const { code, out } = run("status");
  assert.equal(code, 2);
  assert.doesNotMatch(out, /set DATABASE_URL/, "it never got as far as needing a database");
});

test("the two legitimate forms are not refused", () => {
  /**
   * With no connection string these can only reach the credential check — which is the proof they
   * were ACCEPTED as arguments. Asserting the specific next failure keeps this honest: a runner
   * that refused everything would also produce a non-zero exit and could pass a weaker assertion.
   */
  for (const args of [[], ["--status"]]) {
    const { code, out } = run(...args);
    assert.equal(code, 1, `${JSON.stringify(args)} should reach the credential check`);
    assert.match(out, /set DATABASE_URL/);
    assert.doesNotMatch(out, /unrecognized argument/);
  }
});

test("a valid flag alongside an invalid one is still refused", () => {
  const { code, out } = run("--status", "--force");
  assert.equal(code, 2, "one good argument does not excuse the other");
  assert.match(out, /--force/);
});
