/**
 * The dashboard must agree with the records underneath it.
 *
 * Analytics is a projection fed by domain events, deliberately never by another module's tables. It
 * is therefore the one place in Mermaid where a number on a screen can drift away from the thing it
 * describes without anything failing: no query joins them, so nothing forces them to agree.
 *
 * These drive a full revenue cycle through the real composition root and then assert that every
 * headline figure equals the same figure derived from the owning module. A practice reading "we
 * collected $1,520.95" and a ledger that says otherwise is a practice that stops trusting both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const PLAN = [
  { code: "D0120", quantity: 1 },
  { code: "D1110", quantity: 1, fee: cents(110) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

/** A full day of work: verify several patients, file what is filable, take the payers' advice. */
async function runCycle() {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const demo = services.via(new MockEdiAdapter());

  const patients = [
    { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345", card: "Delta Dental\nMember ID: ABC12345" },
    { firstName: "Cora", lastName: "Chen", dateOfBirth: "1985-06-21", memberId: "CIG20099", card: "Cigna Dental\nMember ID: CIG20099" },
    { firstName: "Dev", lastName: "Diaz", dateOfBirth: "2001-02-15", memberId: "MET30066", card: "MetLife Dental\nMember ID: MET30066" },
  ];
  for (const p of patients) {
    await demo.verification.create({
      patient: { firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dateOfBirth, memberId: p.memberId , address: SYNTHETIC_ADDRESS},
      cardText: p.card,
      planItems: PLAN,
    });
  }

  for (const item of await demo.claims.list({ status: "ready" })) {
    if (item.canSubmit) await demo.claims.submit(item.id, { submittedBy: "recon.test@clinic" });
  }

  const submitted = await demo.claims.list({ status: "submitted" });
  const detailed = (await Promise.all(submitted.map((i) => demo.claims.get(i.id)))).filter(
    (v): v is NonNullable<typeof v> => v !== null && v.claim.submission !== null && v.claim.payer.payerId !== null
  );
  const byPayer = new Map<string, typeof detailed>();
  for (const v of detailed) byPayer.set(v.claim.payer.payerId!, [...(byPayer.get(v.claim.payer.payerId!) ?? []), v]);

  for (const [payerId, group] of byPayer) {
    await demo.remittance.fetchAndIngest({
      payerId,
      payerName: group[0]!.claim.payer.payerName ?? payerId,
      payeeName: "MERMAID DEMO DENTAL",
      claims: group.map((v) => ({
        patientControlNumber: v.claim.submission!.patientControlNumber,
        payerControlNumber: v.claim.submission!.controlNumber,
        patientFirstName: v.claim.patient.firstName,
        patientLastName: v.claim.patient.lastName,
        memberId: v.claim.patient.memberId,
        lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
        expectedInsurancePays: v.claim.expectedInsurancePays,
      })),
    });
  }
  return services;
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const WINDOW = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

test("every headline money figure equals the same figure derived from its owning module", async () => {
  const services = await runCycle();
  const report = await services.analytics.report(WINDOW);

  const remittances = await services.remittance.list({});
  assert.equal(
    report.money.collected,
    sum(remittances.map((r) => r.paymentTotal)),
    "collected must equal what the payers actually sent"
  );

  const claims = await services.claims.list({});
  const filed = claims.filter((c) => c.status !== "draft" && c.status !== "void");
  assert.equal(report.money.filedToPayers, sum(filed.map((c) => c.totalFee)), "billed must equal what was filed");
  assert.equal(report.funnel.claimsSubmitted, filed.length);

  const denials = await services.denials.list({});
  assert.equal(report.money.denied, sum(denials.map((d) => d.deniedAmount)), "denied must equal the denials on the board");

  const accounts = await services.ledger.list({});
  const ledgerCharged = sum(accounts.map((a) => a.balance));
  assert.equal(
    report.money.patientBilled,
    ledgerCharged,
    "what analytics says patients were billed must equal what the ledger actually charged them"
  );
});

test("the money identity holds: nothing is collected that was never billed", async () => {
  const services = await runCycle();
  const m = (await services.analytics.report(WINDOW)).money;

  assert.ok(m.collected <= m.filedToPayers, "a practice cannot collect more than it billed");
  assert.ok(m.expected <= m.filedToPayers, "an estimate cannot exceed the charge");
  assert.ok(m.denied <= m.filedToPayers);
  assert.ok(m.recovered <= m.denied, "recovering more than was denied is double counting");
  assert.equal(m.totalCollected, m.collected + m.patientCollected, "the two halves of collection are additive");
});

test("rates are derived from the counts beside them, never computed twice", async () => {
  const services = await runCycle();
  const r = await services.analytics.report(WINDOW);

  /**
   * A rate is `null` when its denominator is zero, and that is deliberate: "0% recovered" and
   * "nothing has been denied yet" are different statements, and only one of them is bad news.
   * The assertion honours that rather than coercing — a test that read `null` as `0` would let a
   * regression turn "not applicable" into "you have recovered nothing" unnoticed.
   */
  const close = (actual: number | null, denominator: number, ratio: number, label: string) => {
    if (denominator === 0) {
      assert.equal(actual, null, `${label} must be null when its denominator is zero, not 0`);
      return;
    }
    assert.ok(actual !== null && Math.abs(actual - ratio) < 0.005, `${label}: ${actual} vs ${ratio}`);
  };

  // Collection is measured against EXPECTED, not billed — billed carries the contractual write-off
  // every in-network practice takes, and measuring against it makes a healthy clinic look alarming.
  close(r.money.collectionRate, r.money.expected, r.money.collected / (r.money.expected || 1), "collectionRate");
  close(r.money.denialRate, r.money.filedToPayers, r.money.denied / (r.money.filedToPayers || 1), "denialRate");
  close(r.money.recoveryRate, r.money.denied, r.money.recovered / (r.money.denied || 1), "recoveryRate");
  close(
    r.funnel.billingRate,
    r.funnel.verificationsCompleted,
    r.funnel.claimsSubmitted / (r.funnel.verificationsCompleted || 1),
    "billingRate"
  );
});

test("a redelivered remittance does not inflate a single figure", async () => {
  /**
   * The outbox delivers at least once and a payer may re-send a file. Analytics is fed by events, so
   * a redelivery that double-counted would overstate revenue on the screen a practice reports from —
   * while every underlying module stayed correct, because they are idempotent and analytics was not.
   */
  const services = await runCycle();
  const before = await services.analytics.report(WINDOW);

  const remittances = await services.remittance.list({});
  const first = await services.remittance.get(remittances[0]!.id);
  assert.ok(first);
  // Re-ingest the identical advice: same trace number, same claims.
  await services.remittance.ingestRaw(first!.remittance.raw835 ?? "");

  const after = await services.analytics.report(WINDOW);
  assert.equal(after.money.collected, before.money.collected, "a duplicate ERA must not add revenue");
  assert.equal(after.money.patientBilled, before.money.patientBilled, "nor re-charge the patients");
  assert.equal(after.money.denied, before.money.denied);
});
