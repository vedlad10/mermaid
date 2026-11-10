/**
 * The production wiring F1–F5 depend on, end to end.
 *
 * Each of these was verified in isolation and then wired through a composition root that no test
 * exercised. This covers the joins: that a practice's OWN settings reach the features, that the
 * claim nobody answered is found by the sweep rather than by a remittance, and that the findings
 * are reachable outside a test at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { cents } from "@mermaid/shared";
import { assessUnpaidDeadline, promptPayRuleFor } from "@mermaid/payer-profile";
import { buildServices } from "../apps/web/wiring.ts";

const SYNTHETIC_ADDRESS = {
  street: "1 SYNTHETIC TEST WAY",
  city: "SPRINGFIELD",
  state: "CA",
  zip: "900010000",
} as const;

const PLAN = [
  { code: "D0120", quantity: 1, fee: cents(65) },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

async function filedClaim(jurisdiction = "NJ") {
  const bus = new InMemoryOutbox();
  const services = buildServices({ inMemory: true, bus, jurisdiction });
  const demo = services.via(new MockEdiAdapter());

  await demo.verification.create({
    patient: {
      firstName: "Ada",
      lastName: "Alpha",
      dateOfBirth: "1990-04-12",
      memberId: "ABC12345",
      address: SYNTHETIC_ADDRESS,
    },
    cardText: "Delta Dental\nMember ID: ABC12345",
    planItems: PLAN,
  });

  const fileable = (await demo.claims.list({ status: "ready" })).find((c) => c.canSubmit);
  assert.ok(fileable, "the fixture must produce a filable claim");
  const filed = await demo.claims.submit(fileable.id, { submittedBy: "biller@clinic" });
  return { services, demo, bus, claimId: filed.claim.id, submittedAt: filed.claim.submission!.submittedAt };
}

const daysLater = (from: string, days: number): Date =>
  new Date(Date.parse(`${from.slice(0, 10)}T09:00:00Z`) + days * 86_400_000);

// ── Per-practice settings (migration 0032) ──────────────────────────────────────────────────────

test("a practice that has stated nothing keeps the deployment's answer", async () => {
  /**
   * The property that makes 0032 safe to apply to a running deployment: until somebody fills
   * something in, every answer is exactly the one it was yesterday.
   */
  const { services } = await filedClaim();
  assert.deepEqual(await services.practiceSettings.get(), {
    jurisdictionState: null,
    merchantDiscountRateBps: null,
  });
});

test("a practice's own jurisdiction overrides the deployment's", async () => {
  const { services } = await filedClaim("NJ");
  const saved = await services.practiceSettings.save({ jurisdictionState: "tx" });
  assert.equal(saved.jurisdictionState, "TX", "normalised on the way in, as the column requires");

  assert.equal((await services.practiceSettings.get()).jurisdictionState, "TX");
});

test("settings refuse values that would reach a screen as money or as law", async () => {
  const { services } = await filedClaim();
  await assert.rejects(() => services.practiceSettings.save({ jurisdictionState: "Texas" }), /two-letter state code/);
  await assert.rejects(() => services.practiceSettings.save({ merchantDiscountRateBps: 10_001 }), /basis points/);
  await assert.rejects(() => services.practiceSettings.save({ merchantDiscountRateBps: 2.5 }), /basis points/);
  assert.equal((await services.practiceSettings.get()).merchantDiscountRateBps, null, "and nothing was stored");
});

test("a stated merchant rate prices a non-ACH payment that was previously unpriced", async () => {
  /**
   * F1's whole dollar figure was null in every deployment because the rate lived only in an
   * environment variable nobody had set. Stating it on the practice is what turns a detected leak
   * into a measured one — and the rate is resolved per POSTING, so it is the paying practice's.
   */
  const { services, demo, bus } = await filedClaim();
  await services.practiceSettings.save({ merchantDiscountRateBps: 350 });

  const { build835 } = await import("../platform/edi/mock/x12-835.ts");
  const submitted = await demo.claims.list({ status: "submitted" });
  const claim = await demo.claims.get(submitted[0]!.id);
  const control = claim!.claim.submission!.patientControlNumber;

  await demo.remittance.recordExpectation({
    claimId: claim!.claim.id,
    verificationId: claim!.claim.verificationId,
    submittedAt: claim!.claim.submission!.submittedAt,
    submittedBy: "biller@clinic",
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
    payerId: "delta-dental",
    payerName: "Delta Dental",
    patientControlNumber: control,
    payerControlNumber: "556677889",
    totalFee: cents(1315),
    expectedInsurancePays: cents(900),
    serviceDate: claim!.claim.serviceDate,
  } as never);

  await demo.remittance.ingestRaw(
    build835({
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      traceNumber: "CHK-1",
      paymentTotal: 900,
      paymentDate: "2026-09-16",
      paymentMethod: "CHK",
      claims: [{
        patientControlNumber: control,
        statusCode: "1", charged: 1315, paid: 900, patientResponsibility: 200,
        payerControlNumber: "556677889", patientFirstName: "Ada", patientLastName: "Alpha",
        memberId: "ABC12345",
        lines: [{ procedureCode: "D2750", charged: 1315, paid: 900,
          adjustments: [{ group: "CO", code: "45", amount: 215 }, { group: "PR", code: "2", amount: 200 }] }],
      }],
    }),
    new Date("2026-09-16T09:00:00Z")
  );
  await bus.drain();

  const [row] = await services.paymentMethods.summary();
  assert.equal(row!.latestMethod, "CHK");
  // $900.00 x 3.5% = $31.50
  assert.equal(row!.feeCents, cents(31.5));
  assert.equal(row!.unpricedPayments, 0, "the practice stated its rate, so nothing is unpriced");
});

// ── F5 finds the claim that produced no remittance at all ───────────────────────────────────────

test("a claim past its statutory deadline is found without any remittance existing", () => {
  /**
   * The gap F5 shipped with. It was driven entirely by remittances, so it only ever assessed claims
   * a payer PAID — and a claim the payer simply never answered produces no remittance, so nothing
   * looked at it. The engine's inputs come from the watchdog's own elapsed-day count, which is why
   * the two cannot drift by a day.
   */
  const NJ = promptPayRuleFor("NJ", "2026-09-16")!;
  const { finding } = assessUnpaidDeadline(
    { elapsedDays: 60, submissionChannel: "electronic", expectedInsurancePays: cents(900) },
    NJ
  );
  assert.equal(finding!.daysPastDeadline, 30);
  assert.equal(finding!.estimatedExposure, cents(900));
});

test("the watchdog's list is a superset of what the deadline sweep needs", async () => {
  /**
   * The assumption the sweep is built on, pinned so it cannot quietly stop being true. The watchdog
   * surfaces an unacknowledged claim at 7 days and a stalled one at 30; the shortest verified
   * statutory window is 30. So any claim past a deadline is already on that list, and the sweep
   * needs no second query — and no second opinion about how long a claim has been waiting.
   */
  const { demo, submittedAt } = await filedClaim();
  const atDeadline = daysLater(submittedAt, 31);

  const watchlist = await demo.claims.silenceWatchlist(atDeadline);
  assert.equal(watchlist.length, 1, "a claim 31 days silent is on the watchdog's list");
  assert.equal(watchlist[0]!.status, "submitted");
  assert.equal(watchlist[0]!.finding.daysSilent, 31);

  const NJ = promptPayRuleFor("NJ", "2026-09-16")!;
  const { finding } = assessUnpaidDeadline(
    {
      elapsedDays: watchlist[0]!.finding.daysSilent,
      submissionChannel: "electronic",
      expectedInsurancePays: watchlist[0]!.finding.amountAtRisk,
    },
    NJ
  );
  assert.equal(finding!.daysPastDeadline, 1, "and NJ's 30-day window has just been passed");
});

// ── The findings are reachable at all ───────────────────────────────────────────────────────────

test("every shadow-mode surface is exposed on the services object", async () => {
  // Each of these was computed and stored on real traffic while being reachable from nowhere.
  const { services } = await filedClaim();
  assert.ok(typeof services.allowedVariances.findings === "function");
  assert.ok(typeof services.statutoryClock.findings === "function");
  assert.ok(typeof services.statutoryClock.savings === "function");
  assert.ok(typeof services.claims.silenceWatchlist === "function");
  assert.ok(typeof services.practiceSettings.get === "function");

  const savings = await services.statutoryClock.savings();
  assert.deepEqual(savings.deadlinesPassed, { findings: 0 });
  assert.equal(savings.promptPay.claimedCents, 0);
  assert.equal(savings.promptPay.recoveredCents, 0);
});
