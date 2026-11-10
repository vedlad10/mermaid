/**
 * Denials, appeals and the shared payer brain, against a real database.
 *
 * The playbook tests exist because of a bug that only a database could produce: the playbook's
 * `payer_id` column was UUID while every module identifies payers by clearinghouse slug
 * (`metlife-dental`). The in-memory repository has no type to violate, so a fully green unit suite
 * said nothing about it, and it surfaced on the first live query. Anything that crosses the
 * TypeScript/SQL boundary needs a test on the SQL side of it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice, withoutPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import {
  PayerProfileService,
  PgPlaybookRepository,
  TRUST_THRESHOLD,
  posteriorRate,
} from "@mermaid/payer-profile";
import { DenialService, PgDenialRepository } from "@mermaid/denials-appeals";
import { NullEventPublisher } from "@mermaid/events";
import type { VarianceDetectedBody } from "@mermaid/events";
import { dbTest, dropPractices, makePractice, shutdown, visibleCount } from "./harness.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const created: string[] = [];
/** Unique per run so a shared database does not leak learned rates between runs. */
const RUN = `t${Date.now().toString(36)}`;

after(async () => {
  await dropPractices(...created);
  // The playbook and the payer catalog are both GLOBAL — no practice to cascade from, so this run's
  // rows are cleaned by key.
  await withoutPractice(async () => {
    await requireContext().tx.query("DELETE FROM payer_playbook_rules WHERE payer_id LIKE $1", [`${RUN}%`]);
    await requireContext().tx.query("DELETE FROM payers WHERE edi_payer_id LIKE $1", [`${RUN}%`]);
  });
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

async function brain() {
  const service = new PayerProfileService(new PgPlaybookRepository());
  await service.ensureDefaults();
  return service;
}

function denialService(playbook: PayerProfileService) {
  return new DenialService(
    new PgDenialRepository(),
    playbook,
    { name: "MERMAID DEMO DENTAL" },
    new NullEventPublisher()
  );
}

const variance = (overrides: Partial<VarianceDetectedBody> = {}): VarianceDetectedBody => ({
  claimId: crypto.randomUUID(),
  remittanceId: crypto.randomUUID(),
  postingId: crypto.randomUUID(),
  detectedAt: "2026-10-01T09:00:00.000Z",
  payerId: `${RUN}-metlife`,
  payerName: "MetLife Dental",
  patientName: "Ada Alpha",
  memberId: "MET30066",
  claimControlNumber: "MRM-000456",
  serviceDate: "2026-09-01",
  recoverableAmount: cents(1125),
  unexplainedAmount: cents(0),
  reasons: [
    { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
  ],
  summary: "The payer withheld $1,125.00 for a missing pre-authorization.",
  ...overrides,
});

// ── The shared brain ──────────────────────────────────────────────────────────────────

test("the playbook is keyed by the payer slug every module actually carries", dbTest, async () => {
  const playbook = await brain();
  // This is the exact query that failed with `invalid input syntax for type uuid` before 0009.
  const rules = await playbook.listRules(`${RUN}-metlife`);
  assert.ok(Array.isArray(rules));

  const resolved = await playbook.resolve(`${RUN}-metlife`, "197", "D2750", "CO");
  assert.equal(resolved.disposition, "appeal");
  assert.ok(resolved.overturnRate > 0);
});

test("default rules seed once and survive a restart", dbTest, async () => {
  const first = await brain();
  const seededAgain = await first.ensureDefaults();
  assert.equal(seededAgain, 0, "a second boot must not duplicate the playbook");

  // A brand-new service over the same database, as a redeployed process would have.
  const globals = await new PayerProfileService(new PgPlaybookRepository()).listRules(null);
  assert.ok(globals.length >= 14, "the default playbook is in the database, not in a process");
  assert.ok(globals.every((r) => r.payerId === null));
});

test("an outcome persists as OBSERVATIONS, and the posterior is derived from them", dbTest, async () => {
  const playbook = await brain();
  const payerId = `${RUN}-obs`;
  const before = await playbook.resolve(payerId, "197", "D2750", "CO");

  await playbook.recordOutcome({ payerId, carcCode: "197", cdtCode: "D2750", won: true });

  const [rule] = await playbook.listRules(payerId);
  assert.ok(rule);
  assert.equal(rule.sampleSize, 1);
  assert.equal(rule.wonCount, 1);
  assert.equal(
    rule.overturnRate,
    before.overturnRate,
    "the stored rate is the PRIOR and does not move — only the evidence accumulates"
  );

  const after = await playbook.resolve(payerId, "197", "D2750", "CO");
  assert.equal(after.overturnRate, posteriorRate(rule.overturnRate, 1, 1));
  assert.ok(after.overturnRate > before.overturnRate);
  assert.ok(
    after.overturnRate - before.overturnRate < 0.1,
    "one outcome nudges; it does not lurch"
  );
});

test("learning accumulates across processes — the brain is the database", dbTest, async () => {
  const payerId = `${RUN}-shared`;
  const first = await brain();
  for (let i = 0; i < TRUST_THRESHOLD; i++) {
    await first.recordOutcome({ payerId, carcCode: "16", cdtCode: null, won: true });
  }

  // A different service instance, as a second app node would be.
  const second = new PayerProfileService(new PgPlaybookRepository());
  const resolved = await second.resolve(payerId, "16", null, "CO");
  assert.equal(resolved.sampleSize, TRUST_THRESHOLD);
  assert.equal(resolved.trusted, true, "the sample threshold was reached in a different process");
  assert.equal(resolved.source, "payer-learned");
});

test("one payer's learning never rewrites another's, or the global default", dbTest, async () => {
  const playbook = await brain();
  const globalBefore = (await playbook.resolve(null, "151", null, "CO")).overturnRate;

  for (let i = 0; i < 5; i++) {
    await playbook.recordOutcome({ payerId: `${RUN}-loud`, carcCode: "151", cdtCode: null, won: true });
  }

  assert.equal((await playbook.resolve(null, "151", null, "CO")).overturnRate, globalBefore);
  assert.equal((await playbook.resolve(`${RUN}-quiet`, "151", null, "CO")).overturnRate, globalBefore);
  assert.ok((await playbook.resolve(`${RUN}-loud`, "151", null, "CO")).overturnRate > globalBefore);
});

// ── Denials ───────────────────────────────────────────────────────────────────────────

test("a denial round-trips through Postgres with its frozen triage", dbTest, async () => {
  const p = await practice("denial-roundtrip");
  const service = denialService(await brain());

  const [view] = await withPractice(p, () => service.createFromVariance(variance(), NOW));
  const read = await withPractice(p, () => service.get(view!.denial.id, NOW));

  assert.ok(read);
  assert.deepEqual(read.denial, view!.denial, "the aggregate survives JSONB unchanged");
  assert.equal(typeof read.denial.deniedAmount, "number");
  assert.equal(read.denial.deniedAmount, cents(1125));
  assert.ok(read.denial.triage!.explain.length > 0);
});

test("the extracted columns agree with the document they came from", dbTest, async () => {
  const p = await practice("denial-columns");
  const service = denialService(await brain());
  const [view] = await withPractice(p, () => service.createFromVariance(variance(), NOW));

  const row = await withPractice(p, () => new PgDenialRepository().readColumns(view!.denial.id));
  assert.ok(row);
  assert.equal(row.status, "triaged");
  assert.equal(row.disposition, "appeal");
  assert.equal(row.denied_amount_cents, cents(1125));
  assert.equal(row.priority, view!.denial.priority);
  assert.equal(row.appeal_deadline, view!.denial.appealDeadline, "a DATE must not shift by a timezone");
});

test("the database refuses a duplicate denial for the same posting and reason", dbTest, async () => {
  const p = await practice("denial-unique");
  const service = denialService(await brain());
  const v = variance();

  await withPractice(p, () => service.createFromVariance(v, NOW));
  await withPractice(p, () => service.createFromVariance(v, NOW));
  assert.equal(await visibleCount(p, "denials"), 1, "a redelivered variance adds nothing");

  // And the constraint holds even when the service guard is bypassed.
  const [existing] = await withPractice(p, () => service.list(undefined, NOW));
  const repo = new PgDenialRepository();
  const stored = (await withPractice(p, () => repo.getById(existing!.id)))!;
  await assert.rejects(
    withPractice(p, () => repo.save({ ...stored, id: crypto.randomUUID() })),
    /already exists for posting/
  );
});

test("denials are invisible across practices", dbTest, async () => {
  const [pA, pB] = [await practice("denial-iso-a"), await practice("denial-iso-b")];
  const service = denialService(await brain());

  const [mine] = await withPractice(pA, () => service.createFromVariance(variance(), NOW));

  assert.equal(await withPractice(pB, () => service.get(mine!.denial.id, NOW)), null);
  assert.equal((await withPractice(pB, () => service.list(undefined, NOW))).length, 0);
  assert.equal(await visibleCount(pB, "denials"), 0);
  assert.equal(await visibleCount(pA, "denials"), 1);
});

test("the appeal gate survives persistence — approval is stored, not merely in memory", dbTest, async () => {
  const p = await practice("denial-gate");
  const service = denialService(await brain());
  const [view] = await withPractice(p, () => service.createFromVariance(variance(), NOW));
  const id = view!.denial.id;

  await withPractice(p, () =>
    service.draftAppeal(id, { memberId: "MET30066", claimControlNumber: "MRM-1", serviceDate: "2026-09-01" }, NOW)
  );
  await assert.rejects(
    withPractice(p, () => service.submitAppeal(id, NOW)),
    /has not been approved by a person/
  );

  await withPractice(p, () => service.approveAppeal(id, "biller@clinic", NOW));
  await withPractice(p, () => service.submitAppeal(id, NOW));

  // Re-read from the database — a brand-new service instance, as a second request would use.
  const reread = (await withPractice(p, () => denialService(new PayerProfileService(new PgPlaybookRepository())).get(id, NOW)))!;
  assert.equal(reread.denial.status, "appealed");
  assert.equal(reread.activeAppeal!.approvedBy, "biller@clinic");
  assert.ok(reread.activeAppeal!.letter.includes("Ada Alpha"));
});

test("recovery stats are computed over the practice's whole history", dbTest, async () => {
  const p = await practice("denial-stats");
  const playbook = await brain();
  const service = denialService(playbook);

  const [won] = await withPractice(p, () => service.createFromVariance(variance(), NOW));
  const [lost] = await withPractice(p, () => service.createFromVariance(variance(), NOW));

  const id = won!.denial.id;
  await withPractice(p, () =>
    service.draftAppeal(id, { memberId: "M", claimControlNumber: "C", serviceDate: "2026-09-01" }, NOW)
  );
  await withPractice(p, () => service.approveAppeal(id, "biller", NOW));
  await withPractice(p, () => service.submitAppeal(id, NOW));
  await withPractice(p, () => service.recordOutcome(id, { won: true, recoveredAmount: cents(1125), recordedBy: "biller" }, NOW));
  await withPractice(p, () =>
    service.close(lost!.denial.id, { as: "written_off", reason: "No documentation.", closedBy: "biller" }, NOW)
  );

  const stats = await withPractice(p, () => service.recoveryStats(NOW));

  /**
   * ── A WIN IS A RECEIVABLE, NOT A RECOVERY (F-2) ──────────────────────────────────────────────
   * These four assertions used to read `recoveredCount 1, recoveredAmount $1,125, recoveryRate 0.5`,
   * and they were asserting a bug. `recordOutcome({ won: true })` wrote `status: "recovered"` — a
   * CLOSED status — so winning an appeal emptied the Recover worklist, closed the denial, and
   * reported the money as collected while nothing had arrived. A practice reading that scoreboard
   * would believe it had been paid.
   *
   * The state machine in `engine/award.ts` fixed it: a win becomes `awaiting_payment` carrying the
   * agreed figure in `awardedAmount`, and only POSTED CASH moves a denial to `recovered`. The
   * product was corrected and this test was not, so it went on asserting the old semantics.
   */
  assert.equal(stats.recoveredCount, 0, "the payer agreed to pay; nothing has been paid");
  assert.equal(stats.recoveredAmount, 0, "reporting an award as cash is how a practice mis-forecasts");
  assert.equal(stats.awaitingPaymentCount, 1, "the win is a receivable somebody still has to chase");
  assert.equal(stats.awardedAwaitingPayment, cents(1125), "and it carries the agreed figure");

  /**
   * The award is open work as well as a receivable: `openCount` includes it, because winning an
   * appeal creates the job of collecting on it rather than finishing anything.
   */
  assert.equal(stats.openCount, 1, "an awaiting-payment award is still on somebody's worklist");

  assert.equal(stats.writtenOffCount, 1);
  assert.equal(stats.writtenOffAmount, cents(1125));

  /**
   * A MONEY rate, not a count rate — recovered cash over everything settled. The old `0.5` read it
   * as one denial of two, which happens to be the same figure a count rate would give here and is
   * not what the field means. With one write-off and no cash, nothing has been recovered.
   */
  assert.equal(stats.recoveryRate, 0, "no cash has arrived, so nothing has been recovered");
});

// ── The payer catalog against a real database (M12) ────────────────────────────────────────────

test("the payer catalog upserts against a PARTIAL unique index", dbTest, async () => {
  const service = await brain();
  const repo = new PgPlaybookRepository();

  // The index created by migration 0014 is partial (`WHERE edi_payer_id IS NOT NULL`), and an
  // ON CONFLICT against a partial index must repeat that predicate or Postgres refuses to use it as
  // the arbiter. That exact mistake shipped at M9 and was only caught on first contact with the
  // database, because the in-memory double accepted it happily. This is the test that would have.
  const slug = `${RUN}-catalog`;
  await repo.upsertPayer({ slug, name: "Test Payer", filingWindowDays: 200, appealWindowDays: 45 });

  // The second write is the one that exercises the conflict arbiter.
  await repo.upsertPayer({ slug, name: "Test Payer Renamed", filingWindowDays: 111, appealWindowDays: 22 });

  const found = await repo.findPayer(slug);
  assert.equal(found?.name, "Test Payer Renamed", "the second upsert must UPDATE, not insert a duplicate");
  assert.equal(found?.filingWindowDays, 111);

  await withoutPractice(async () => {
    const { rows } = await requireContext().tx.query("SELECT count(*)::int AS n FROM payers WHERE edi_payer_id = $1", [slug]);
    assert.equal((rows[0] as { n: number }).n, 1, "exactly one row — a partial index that is not used as the arbiter would give two");
  });

  // And the seeded catalog is readable through the service, which is what Claims now consults.
  assert.equal(await service.filingWindowDays("aetna-dental"), 90, "Aetna's published limit (B-1)");
  assert.equal(await service.filingWindowDays("never-catalogued"), null);
});
