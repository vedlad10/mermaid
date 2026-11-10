// sync-demo-environment.mjs — bring one deployment's database up to this checkout, and put the same
// demonstration practice on it, in one command.
//
//   DATABASE_URL=… DATABASE_ADMIN_URL=… \
//     node scripts/sync-demo-environment.mjs --confirm-host <the hostname in that URL>
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// Staging and the development laptop run the same commit and show different screens, because they
// run different databases and only one of them has ever been seeded. Closing that gap is four
// separate commands in a specific order, two of which are easy to forget and one of which is easy to
// get wrong:
//
//   migrate            · the schema the code expects
//   db:provision-role  · AFTER migrate, because ALTER DEFAULT PRIVILEGES only covers objects that
//                        already exist — and it is the only thing that restores the append-only
//                        revoke on `audit_events`, which has silently drifted before
//   demo:seed          · the data
//   a look at the result
//
// Ordering them by hand is how a deployment ends up migrated but unprovisioned, which is invisible
// until a compliance review asks about the audit trail.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────────────────────────
// It never deletes, truncates or resets anything. `demo:seed` is additive by construction (there is
// no `--wipe`, deliberately), so this ADDS a demonstration practice's worth of data to whatever the
// target already holds and leaves every existing row alone. If the target already has a seeded demo
// practice, running this gives it a second batch rather than replacing the first — use `--offset` to
// keep the member ids clear of the existing ones.
//
// It also refuses a target that is not this machine unless the hostname is named on the command
// line and matches, for the same reason `seed-demo-practice.ts` does: NODE_ENV describes the
// PROCESS, so the production refusal never fires on `DATABASE_URL=<somewhere else> …`, however wrong
// that URL is.
import { spawnSync } from "node:child_process";
import pg from "pg";
import { connectionOptions } from "../platform/db/tls.mjs";

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const appUrl = process.env.DATABASE_URL;
const adminUrl = process.env.DATABASE_ADMIN_URL || appUrl;

if (!appUrl) {
  console.error("REFUSING: set DATABASE_URL (and DATABASE_ADMIN_URL) to the deployment you mean to sync.");
  process.exit(1);
}

let host;
try {
  host = new URL(appUrl).hostname;
} catch {
  console.error("REFUSING: DATABASE_URL is not a URL, so its target cannot be checked.");
  process.exit(1);
}

const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
if (!loopback && arg("confirm-host") !== host) {
  console.error(
    `REFUSING: DATABASE_URL points at "${host}", which is not this machine.\n\n` +
      `This writes a demonstration practice — invented patients, their claims, their payers'\n` +
      `remittances and their ledgers — into that database. Nothing here can tell one remote\n` +
      `database from another, so the host has to be named by somebody who has read it:\n\n` +
      `  node scripts/sync-demo-environment.mjs --confirm-host ${host}\n`
  );
  process.exit(1);
}

/** Row counts, so "did this work" has an answer that is not a vibe. */
async function census(label) {
  const client = new pg.Client(connectionOptions(adminUrl));
  await client.connect();
  try {
    const one = async (sql, ...params) => Number((await client.query(sql, params)).rows[0].n);
    const counts = {
      migrations: await one("SELECT count(*)::int n FROM _migrations").catch(() => 0),
      practices: await one("SELECT count(*)::int n FROM practices").catch(() => 0),
      patients: await one("SELECT count(*)::int n FROM patients").catch(() => 0),
      claims: await one("SELECT count(*)::int n FROM claims").catch(() => 0),
      remittances: await one("SELECT count(*)::int n FROM remittances").catch(() => 0),
      denials: await one("SELECT count(*)::int n FROM denials").catch(() => 0),
      ledger_entries: await one("SELECT count(*)::int n FROM ledger_entries").catch(() => 0),
    };
    console.log(`\n${label}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);
    return counts;
  } finally {
    await client.end();
  }
}

/**
 * Run one npm script against the SAME environment this process was given.
 *
 * Inherited rather than re-derived: the whole point is that every step sees the one DATABASE_URL the
 * caller named, and a step that quietly picked up `.env` instead would migrate one database and seed
 * another. `--env-file-if-exists=.env` inside those scripts does NOT override an already-set
 * variable, so an explicit one wins — but passing the environment through is what makes that true
 * rather than hoped for.
 */
function step(label, script, extra = []) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  const r = spawnSync("npm", ["run", script, ...(extra.length ? ["--", ...extra] : [])], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: appUrl, DATABASE_ADMIN_URL: adminUrl },
  });
  if (r.status !== 0) {
    console.error(`\nFAILED at "${label}" (exit ${r.status}). Nothing after this ran.`);
    process.exit(r.status ?? 1);
  }
}

console.log(`syncing the deployment whose database is at ${host}`);
console.log("nothing here deletes, truncates or resets — every step only adds.");

const before = await census("BEFORE");

step("schema", "migrate");
step("schema — what is applied now", "migrate:status");
/* AFTER migrate, always: ALTER DEFAULT PRIVILEGES only covers objects that already exist, and this
   is the only thing that restores the append-only revoke on audit_events. */
step("the unprivileged role, and the append-only audit revoke", "db:provision-role");
step("RLS proof, run as that role", "db:verify");
step("demonstration practice", "demo:seed", [
  "--patients", arg("patients", "70"),
  "--days", arg("days", "90"),
  "--offset", arg("offset", "0"),
  ...(loopback ? [] : ["--confirm-host", host]),
]);

const after = await census("AFTER");

console.log("\n── what changed " + "─".repeat(48));
for (const k of Object.keys(after)) {
  const d = after[k] - before[k];
  console.log(`  ${k.padEnd(16)} ${String(before[k]).padStart(6)} → ${String(after[k]).padStart(6)}  ${d > 0 ? `(+${d})` : d < 0 ? `(${d})` : ""}`);
}
console.log(
  "\nEvery figure on every screen is derived from those rows by the product, so the two deployments\n" +
    "now differ only in the data each one's own history produced.\n"
);
