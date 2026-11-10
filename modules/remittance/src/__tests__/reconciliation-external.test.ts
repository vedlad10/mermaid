/**
 * Reconciliation compares against the payer's own file, not against ourselves (NEW-23).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `reconcileAll` read `paymentTotal` and `postings` from the SAME stored remittance document. Both
 * are written by the same code path, in the same transaction, from the same parse — so `drift` could
 * only ever be non-zero if `addCents` itself were broken.
 *
 * What it is sold as, and what an operator reads it as, is the opposite: "every cent a payer said it
 * sent is accounted for by a posting". `drift` non-zero is documented as a hard operational alert
 * meaning the ledger and the bank will disagree. A check that structurally cannot fire is worse than
 * no check, because its silence is read as evidence.
 *
 * The one document that can answer the question is the payer's own, and this system already retains
 * it: `raw835`, encrypted at rest, on every remittance. So the payments side is re-parsed from it
 * and the postings side stays as recorded — two independent derivations, which is what makes a
 * difference between them mean anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { InMemoryRemittanceRepository, RemittanceService } from "../index.ts";
import { InMemoryExpectationRepository } from "../repository.ts";
import type { Remittance } from "../types.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

/** One 835 transaction set paying `cents`, with a matching CLP the postings can be built from. */
function file(trace: string, amount: number): string {
  const dollars = (amount / 100).toFixed(2);
  return (
    [
      "ISA*00*          *00*          *ZZ*DELTA          *ZZ*CLINIC         *260901*1200*^*00501*000000001*0*P*:",
      "GS*HP*DELTA*CLINIC*20260901*1200*1*X*005010X221A1",
      "ST*835*0001",
      `BPR*I*${dollars}*C*ACH*CCP*01*999999999*DA*1234567*1512345678**01*888888888*DA*7654321*20260901`,
      `TRN*1*${trace}*1512345678`,
      "DTM*405*20260901",
      "N1*PR*DELTA DENTAL",
      "N1*PE*MERMAID DEMO DENTAL*XX*1234567893",
      "LX*1",
      `CLP*MRM-000123*1*${dollars}*${dollars}**12*PAYER-1*11`,
      "NM1*QC*1*ALPHA*ADA****MI*ABC12345",
      `SVC*AD:D0120*${dollars}*${dollars}`,
      "DTM*472*20260901",
      "SE*12*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~"
  );
}

async function wired() {
  const repo = new InMemoryRemittanceRepository();
  const expectations = new InMemoryExpectationRepository();
  const service = new RemittanceService(repo, expectations, new MockEdiAdapter());
  return { repo, service };
}

/** Ingest one advice and force it to `posted`, which is what `reconcileAll` reads. */
async function posted(repo: InMemoryRemittanceRepository, service: RemittanceService, raw: string) {
  const view = await service.ingestRaw(raw, NOW);
  const stored = (await repo.getById(view.remittance.id))!;
  const settled: Remittance = { ...stored, status: "posted" };
  await repo.update(settled);
  return settled;
}

test("NEW-23: a remittance whose postings match its own retained file reconciles", async () => {
  const { repo, service } = await wired();
  await posted(repo, service, file("TRACE-1", 10_000));

  const report = await service.reconcileAll();
  assert.equal(report.drift, 0, `unexpected drift: ${report.summary}`);
  assert.equal(report.balanced, true);
});

test("NEW-23: deleting a posting produces DRIFT — it could not before", async () => {
  /**
   * The failure the old check structurally could not see. `paymentTotal` and `postings` both came
   * from the stored document, so removing a posting removed it from BOTH sides of the subtraction
   * and the drift stayed zero. Now the payments side comes from the payer's file, which does not
   * change when our record does.
   */
  const { repo, service } = await wired();
  const stored = await posted(repo, service, file("TRACE-2", 10_000));
  assert.ok(stored.postings.length > 0, "the fixture must actually post something");

  await repo.update({ ...stored, postings: [] });

  const report = await service.reconcileAll();
  assert.notEqual(
    report.drift,
    0,
    "money the payer's own file says was sent, with nothing posted against it, must not reconcile"
  );
  assert.match(report.summary, /DRIFT/);
});

test("NEW-23: corrupting the stored 835's total produces DRIFT too", async () => {
  /**
   * The other direction, and the one that matters for integrity at rest: the retained file is the
   * evidence for money that has already moved. If it can be altered without anything noticing, it
   * is not evidence.
   */
  const { repo, service } = await wired();
  const stored = await posted(repo, service, file("TRACE-3", 10_000));

  // The payer's BPR now claims a different amount from the one we posted.
  await repo.update({ ...stored, raw835: file("TRACE-3", 25_000) });

  const report = await service.reconcileAll();
  assert.notEqual(report.drift, 0, "the file and the postings disagree, and that is the whole point");
});

test("NEW-23: a remittance with no retained file is REPORTED, not quietly counted as reconciled", async () => {
  /**
   * Rows written before retention existed are the honest case for this. Falling back to the stored
   * total for them would restore the old self-comparison for exactly the rows nothing can check —
   * the same lie in a smaller font — so they are named in the summary instead.
   */
  const { repo, service } = await wired();
  const stored = await posted(repo, service, file("TRACE-4", 10_000));
  await repo.update({ ...stored, raw835: null });

  const report = await service.reconcileAll();
  assert.match(report.summary, /could not be checked against the payer's own file/i);
  assert.match(report.summary, /TRACE-4/, "and it must say WHICH remittance, or nobody can act on it");
});

test("NEW-23: a file that no longer parses is a finding, not a crash", async () => {
  /**
   * One corrupted file must not stop a whole practice reconciling — the other remittances are the
   * ones that would tell an operator whether the money is right.
   */
  const { repo, service } = await wired();
  const good = await posted(repo, service, file("TRACE-5", 10_000));
  const bad = await posted(repo, service, file("TRACE-6", 20_000));
  await repo.update({ ...bad, raw835: "this is not an X12 interchange at all" });

  const report = await service.reconcileAll();
  assert.match(report.summary, /TRACE-6/, "the unreadable file is named");
  assert.ok(report.paymentsReceived > 0, "and the readable one still reconciles");
  void good;
});
