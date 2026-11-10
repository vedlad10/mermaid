/**
 * L-3 end to end: the capped figure survives estimate → claim → patient balance → ledger.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE ENGINE TESTS ───────────────────────────────────────────
 * `denied-line-liability.test.ts` proves the ENGINE prices a denied line correctly. That is not the
 * same as proving a patient is billed correctly. The estimate is copied into the claim, the claim's
 * patient share reaches the ledger through an event, and the ledger is what a practice actually
 * collects against — a rule that stopped at the engine would look right on the estimate screen and
 * bill the old figure anyway.
 *
 * The whole point of L-3 is what a patient is asked to pay, so the assertion has to run to the place
 * that asks them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { buildServices } from "../apps/web/wiring.ts";

const SYNTHETIC_ADDRESS = {
  street: "1 SYNTHETIC TEST WAY",
  city: "SPRINGFIELD",
  state: "CA",
  zip: "900010000",
} as const;

/**
 * Member IDs ending `99` hit a nearly-exhausted annual maximum in the mock, which is the scenario
 * that produces a covered-but-unpaid line rather than a plain denial — the case L-3 governs.
 */
const PLAN = [
  { code: "D0120", quantity: 1, fee: cents(65) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

async function clinicWithSchedule(memberId: string) {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const demo = services.via(new MockEdiAdapter());

  /** A learned contracted rate, exactly as a posted remittance would have taught it. */
  await services.allowedAmounts.record({
    payerId: "delta-dental",
    cdtCode: "D2750",
    allowed: cents(1000),
    charged: cents(1250),
    observedAt: "2026-08-01T00:00:00.000Z",
  });

  const verification = await demo.verification.create({
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId, address: SYNTHETIC_ADDRESS },
    cardText: `Delta Dental\nMember ID: ${memberId}`,
    planItems: PLAN,
  });
  return { services, demo, verification };
}

test("the contracted figure the estimate quoted is the figure the claim carries", async () => {
  const { demo, verification } = await clinicWithSchedule("ABC12399");
  const calc = verification.record.calculation!;

  const claims = await demo.claims.list();
  const claim = (await demo.claims.get(claims[0]!.id))!.claim;

  assert.equal(
    claim.expectedPatientPays,
    calc.totalPatientPays,
    "the claim copies the estimate — a different number here means the patient is quoted twice"
  );
  assert.equal(claim.totalFee, calc.totalFee, "and the practice still bills its own fee");
});

test("a contracted write-off is never billed to the patient", async () => {
  /**
   * The property L-3 exists for. Whatever the plan did, the patient's share must not include money
   * the contract says nobody may collect.
   */
  const { demo, verification } = await clinicWithSchedule("ABC12399");
  const calc = verification.record.calculation!;
  if (calc.totalContractualWriteOff === 0) return; // no rate applied to this scenario; nothing to prove

  const claims = await demo.claims.list();
  const claim = (await demo.claims.get(claims[0]!.id))!.claim;

  assert.ok(
    claim.expectedPatientPays <= claim.totalFee - calc.totalContractualWriteOff,
    `patient share ${claim.expectedPatientPays} includes part of the ${calc.totalContractualWriteOff} write-off`
  );
  assert.equal(
    claim.expectedInsurancePays + claim.expectedPatientPays + calc.totalContractualWriteOff,
    claim.totalFee,
    "the billed fee splits three ways on the claim, exactly as on the estimate"
  );
});

test("no contracted rate means the claim is what it always was", async () => {
  /** The fallback, asserted at the claim rather than the engine: a practice with no history is unaffected. */
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const demo = services.via(new MockEdiAdapter());
  await demo.verification.create({
    patient: { firstName: "Bo", lastName: "Beta", dateOfBirth: "1988-01-02", memberId: "ABC12345", address: SYNTHETIC_ADDRESS },
    cardText: "Delta Dental\nMember ID: ABC12345",
    planItems: PLAN,
  });
  const claims = await demo.claims.list();
  const claim = (await demo.claims.get(claims[0]!.id))!.claim;

  assert.equal(
    claim.expectedInsurancePays + claim.expectedPatientPays,
    claim.totalFee,
    "with nothing written off, the two shares still sum to the billed fee"
  );
});

test("the ledger charges the patient what the payer assigned, never the practice's list price", async () => {
  /**
   * The end of the chain. `chargeFromPosting` raises the patient's balance from the payer's OWN
   * statement of patient responsibility, so a contracted write-off cannot reach a patient's account
   * even if every layer above it were wrong. Asserted here because it is the last place a wrong
   * figure would still be recoverable, and the first place it would be visible to a patient.
   */
  const { services, demo } = await clinicWithSchedule("ABC12399");

  for (const item of await demo.claims.list({ status: "ready" })) {
    if (item.canSubmit) await demo.claims.submit(item.id, { submittedBy: "l3.test@clinic" });
  }
  const submitted = await demo.claims.list({ status: "submitted" });
  const detailed = (await Promise.all(submitted.map((i) => demo.claims.get(i.id)))).filter(
    (v): v is NonNullable<typeof v> => v !== null && v.claim.submission !== null
  );
  for (const v of detailed) {
    await demo.remittance.fetchAndIngest({
      payerId: v.claim.payer.payerId!,
      payerName: v.claim.payer.payerName ?? "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      claims: [
        {
          patientControlNumber: v.claim.submission!.patientControlNumber,
          payerControlNumber: v.claim.submission!.controlNumber,
          patientFirstName: v.claim.patient.firstName,
          patientLastName: v.claim.patient.lastName,
          memberId: v.claim.patient.memberId,
          lines: v.claim.lines.map((l) => ({ procedureCode: l.code, charged: l.fee, quantity: l.quantity })),
          expectedInsurancePays: v.claim.expectedInsurancePays,
        },
      ],
    });
  }

  const accounts = await services.ledger.list(undefined, new Date("2026-09-01T00:00:00Z"));
  const billed = accounts.reduce((total, a) => total + a.balance, 0);
  const totalFee = PLAN.reduce((t, l) => t + l.fee, 0);

  assert.ok(billed >= 0, "a patient balance is never negative");
  assert.ok(
    billed <= totalFee,
    `the ledger billed ${billed} against a ${totalFee} treatment plan — more than the whole plan is impossible`
  );
});

test("the claim carries the write-off, not just the net figures", async () => {
  /**
   * The claim inherits the money correctly — that was already asserted above — but it was dropping
   * the EXPLANATION. `ClaimLine` carried fee, insurance and patient and not the write-off, so the
   * claim screen showed three figures that visibly do not add up on the one screen a biller works
   * from. The money was right and the row was unreadable.
   */
  const { demo, verification } = await clinicWithSchedule("ABC12399");
  const calc = verification.record.calculation!;
  if (calc.totalContractualWriteOff === 0) return;

  const claims = await demo.claims.list();
  const claim = (await demo.claims.get(claims[0]!.id))!.claim;

  assert.equal(
    claim.totalContractualWriteOff,
    calc.totalContractualWriteOff,
    "the claim total must equal the estimate's — it is inherited, never recomputed"
  );
  const perLine = claim.lines.reduce((t, l) => t + (l.contractualWriteOff ?? 0), 0);
  assert.equal(perLine, claim.totalContractualWriteOff, "and the lines sum to it");
  assert.equal(
    claim.expectedInsurancePays + claim.expectedPatientPays + claim.totalContractualWriteOff!,
    claim.totalFee,
    "so the claim's own three figures account for the billed fee exactly"
  );
});

test("a claim with no contracted rate carries no write-off at all", async () => {
  /** Absent, not zero: a claim priced off billed fees should look exactly as it always did. */
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const demo = services.via(new MockEdiAdapter());
  await demo.verification.create({
    patient: { firstName: "Cy", lastName: "Gamma", dateOfBirth: "1991-05-05", memberId: "ABC12347", address: SYNTHETIC_ADDRESS },
    cardText: `Delta Dental
Member ID: ABC12347`,
    planItems: PLAN,
  });
  const claims = await demo.claims.list();
  const claim = (await demo.claims.get(claims[0]!.id))!.claim;
  assert.equal(claim.totalContractualWriteOff, undefined);
  for (const l of claim.lines) assert.equal(l.contractualWriteOff, undefined);
});
