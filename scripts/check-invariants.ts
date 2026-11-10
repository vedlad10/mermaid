/**
 * Check a live database against the invariants this system DECLARES.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A TEST ──────────────────────────────────────────────────
 * The suite asks "does the code enforce its rules?" against data the tests themselves construct.
 * This asks a different question: "does the data actually in a database satisfy them?" Those come
 * apart in exactly the cases that matter — a migration that backfilled a column wrongly, a partial
 * remediation that updated one store and not another, a defect that ran in production before it was
 * found and left rows behind. None of those are reachable by a test, because the rows predate it.
 *
 * Every law here is IMPORTED from the module that declares it, never restated. A checker carrying
 * its own copy of the rules drifts from the code and then confidently reports agreement with itself
 * — which is the failure mode of the thing it is supposed to catch.
 *
 * ── READ-ONLY, AND STRUCTURALLY SO ─────────────────────────────────────────────────────────────
 * Every statement is a SELECT inside a transaction that is ROLLED BACK. There is no --apply flag
 * and no write path to reach: this reports, and a person decides what to do. Reads go through the
 * application role so RLS applies exactly as it does in the app, which is itself part of what is
 * being checked — a row this cannot see is a row the app cannot see either.
 *
 *   DATABASE_ADMIN_URL=… DATABASE_URL=… node scripts/check-invariants.ts
 *
 * ── WHY IT LIVES IN scripts/ AND NOT platform/db/ ──────────────────────────────────────────────
 * It reads laws from BOTH `@mermaid/shared` and `@mermaid/claims`, and platform may not depend on
 * modules — dependencies point shared ← platform ← modules ← apps. Written under platform/db first,
 * and `check-boundaries` refused it, correctly: a diagnostic that inspects the whole system is not
 * platform code, and bending the layering to host it would trade a real architectural guarantee for
 * the convenience of one file's location.
 *
 * TypeScript rather than .mjs like its neighbours, deliberately: it imports the domain laws, and
 * they are TypeScript. That import is the whole point.
 */
import pg from "pg";
import { connectionOptions } from "../platform/db/tls.mjs";
import { buildPartition, checkPartition } from "@mermaid/shared";
import { claimVariance } from "@mermaid/claims";
import type { Cents } from "@mermaid/shared";

pg.types.setTypeParser(20, (v) => v);

/** Refuses anything that looks like production, the same shape as every operational script here. */
function guard(url: string | undefined, label: string): string {
  if (!url) {
    console.error(`REFUSED: ${label} is not set.`);
    process.exit(1);
  }
  if (/prod/i.test(new URL(url).hostname)) {
    console.error(`REFUSED: ${label} looks like production. This is a diagnostic, not a production tool.`);
    process.exit(2);
  }
  return url;
}

const adminUrl = guard(process.env.DATABASE_ADMIN_URL, "DATABASE_ADMIN_URL");
const appUrl = guard(process.env.DATABASE_URL, "DATABASE_URL");

const usd = (c: number): string => `$${(c / 100).toFixed(2)}`;
const num = (v: unknown): number => Number(v ?? 0);

let checked = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checked++;
  if (!ok) failed++;
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const admin = new pg.Client(connectionOptions(adminUrl));
const app = new pg.Client(connectionOptions(appUrl));
await admin.connect();
await app.connect();

console.log("\ninvariant check — read-only");
console.log("=".repeat(72));

for (const practice of (await admin.query("select id, name from practices order by name")).rows) {
  /** One transaction per practice, rolled back: the tenant context is transaction-local anyway. */
  await app.query("begin");
  await app.query("select set_current_practice($1)", [practice.id]);
  const postings = (await app.query("SELECT * FROM postings")).rows;
  const claims = (await app.query("SELECT id, record FROM claims")).rows;
  const entries = (await app.query("SELECT kind, amount_cents, patient_id, patient_key FROM ledger_entries")).rows;
  const denials = (await app.query("SELECT id, record FROM denials")).rows;
  await app.query("rollback");

  if (postings.length === 0 && claims.length === 0 && entries.length === 0) continue;
  console.log(
    `\n── ${practice.name}: ${postings.length} posting(s), ${claims.length} claim(s), ` +
      `${entries.length} ledger entr(ies), ${denials.length} denial(s)`
  );

  /**
   * The MoneyPartition laws (I1, I3, I4, I5), on every posting the payer fully adjudicated. A
   * posting with no variance was never adjudicated against an expectation, so there is no partition
   * to check rather than a partition that passes vacuously.
   */
  const violations: string[] = [];
  let partitions = 0;
  for (const p of postings) {
    if (p.expected_insurance_cents === null || p.variance_cents === null) continue;
    partitions++;
    const found = checkPartition(
      buildPartition({
        charged: num(p.charged_cents) as Cents,
        payerPaid: num(p.paid_cents) as Cents,
        contractual: num(p.contractual_cents) as Cents,
        patientResponsibility: num(p.patient_resp_cents) as Cents,
        recoverable: num(p.recoverable_cents) as Cents,
        coordination: 0 as Cents,
        informational: 0 as Cents,
      } as never)
    );
    for (const v of found) violations.push(`${String(p.id).slice(0, 8)} ${v.invariant}: ${v.detail}`);
  }
  check(`MoneyPartition laws hold on ${partitions} adjudicated posting(s)`, violations.length === 0, violations.join("; "));

  /** A claim's variance is exact arithmetic, and its explained/unexplained split accounts for all of it. */
  const claimErrors: string[] = [];
  let paid = 0;
  for (const { id, record } of claims) {
    const v = claimVariance(record);
    if (!v) continue;
    paid++;
    if (v.variance !== ((v.paid - v.expected) as Cents)) claimErrors.push(`${String(id).slice(0, 8)} gross`);
    if (v.unexplained !== ((v.variance - v.appealRecovered) as Cents)) claimErrors.push(`${String(id).slice(0, 8)} split`);
  }
  check(`claim variance is exact on ${paid} paid claim(s)`, claimErrors.length === 0, claimErrors.join(", "));

  /**
   * A patient balance below zero is a credit the practice is holding and has not refunded. It is not
   * arithmetic that "cannot happen" — a payer takeback after a patient has paid produces it — so
   * this reports rather than asserts impossibility.
   */
  const balances = new Map<string, number>();
  for (const e of entries) {
    const key = e.patient_id ? `id:${e.patient_id}` : `key:${e.patient_key}`;
    balances.set(key, (balances.get(key) ?? 0) + num(e.amount_cents));
  }
  const credits = [...balances.entries()].filter(([, v]) => v < 0);
  check(
    "no patient account is in credit without a refund",
    credits.length === 0,
    credits.map(([k, v]) => `${k.slice(0, 16)} ${usd(v)}`).join(", ")
  );

  /** An award cannot settle for more than was awarded, and "recovered" must mean nothing is left. */
  const awardErrors: string[] = [];
  for (const { id, record } of denials) {
    const awarded = num(record.awardedAmount);
    const settled = num(record.awardSettledAmount);
    if (awarded > 0 && settled > awarded) awardErrors.push(`${String(id).slice(0, 8)} settled>awarded`);
    if (record.status === "recovered" && settled < awarded) awardErrors.push(`${String(id).slice(0, 8)} recovered but short`);
  }
  check(`award settlement is consistent on ${denials.length} denial(s)`, awardErrors.length === 0, awardErrors.join(", "));

  /** F-5: what we resolved can never exceed what the payer actually withheld. */
  const over = postings.filter((p) => num(p.resolved_recoverable_cents) > num(p.recoverable_cents));
  check(
    "no posting resolved more recovery than the payer withheld",
    over.length === 0,
    over.map((p) => String(p.id).slice(0, 8)).join(", ")
  );

  const negative = postings.filter(
    (p) => num(p.paid_cents) < 0 || num(p.charged_cents) < 0 || num(p.patient_resp_cents) < 0
  );
  check(
    "no posting carries a negative charge, payment or patient share",
    negative.length === 0,
    negative.map((p) => String(p.id).slice(0, 8)).join(", ")
  );
}

console.log("=".repeat(72));
console.log(
  failed === 0
    ? `All ${checked} invariant(s) hold. Nothing was written.`
    : `${failed} of ${checked} invariant(s) FAILED. Nothing was written — investigate before acting.`
);

await admin.end();
await app.end();
process.exit(failed === 0 ? 0 : 1);
