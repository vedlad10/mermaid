/**
 * M8 — coordination of benefits, end to end, from raw X12 to the patient's ledger.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────────
 * Mermaid modelled exactly one payer per patient. When a patient held two plans, the primary's
 * advice arrived carrying:
 *
 *   • an `OA`-group adjustment — CARC 23, "the impact of prior payer(s) adjudication" — which is the
 *     standard coordination code, categorised `informational`. It counted toward `accountedFor` in
 *     `computeVariance`, so the arithmetic balanced and no `unexplained` was raised, and then it
 *     appeared in NONE of the four reported money fields and NO queue. It reconciled and vanished.
 *
 *   • CLP02 `19`/`20` — the payer stating it forwarded the claim to another plan. `CLP_STATUS` had
 *     mapped both since the codec was written; `claimDisposition` ignored them and reported the
 *     claim as `paid_full` / `partial` / `denied` by amount, so it looked finished.
 *
 * The advice then posted, and `chargeFromPosting` billed the patient the primary's `PR` balance —
 * money a secondary payer may owe. A refund when discovered, a balance-billing exposure in several
 * states, and the secondary claim was never filed, so that revenue was never pursued at all.
 *
 * ── WHY THESE DRIVE RAW X12 RATHER THAN HAND-BUILT OBJECTS ─────────────────────────────────────
 * `coordination` and `forwarded` are both derived from a payer's own file. A test that constructs a
 * `RemittanceAdvice` by hand proves the categoriser and the gate agree with each other, and proves
 * nothing about whether either value ever comes off a real 835 — the exact shape of the
 * coverage-date defect, where a field that was always null and a payer that never said it were
 * indistinguishable for a whole milestone.
 *
 * So the fixtures come from `MockEdiAdapter.fetchRemittance` (member IDs ending `23` adjudicate as
 * coordination) and go through the production `parse835`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import type { RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { InMemoryExpectationRepository, InMemoryRemittanceRepository, RemittanceService } from "../index.ts";

const NOW = new Date("2026-08-10T09:00:00Z");
const silent = createLogger(() => {});

function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryRemittanceRepository();
  const service = new RemittanceService(repo, new InMemoryExpectationRepository(), new MockEdiAdapter(), bus);
  return { bus, repo, service };
}

const submitted = (memberId: string): ClaimSubmittedBody => ({
  claimId: "claim-cob",
  verificationId: "ver-cob",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Cob", lastName: "Patient", dateOfBirth: "1990-04-12", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: "MRM-COB1",
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
});

const remitClaim = (memberId: string): RemittanceRequestClaim => ({
  patientControlNumber: "MRM-COB1",
  payerControlNumber: "556677889",
  patientFirstName: "Cob",
  patientLastName: "Patient",
  memberId,
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/** A real 835 from the mock clearinghouse. `…23` adjudicates as coordination of benefits. */
async function era(memberId: string): Promise<string> {
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [remitClaim(memberId)],
  });
  return fetched.raw!;
}

const COB_MEMBER = "ABC00023";
const ORDINARY_MEMBER = "ABC12345";

// ── The payer's own file actually says it ─────────────────────────────────────────────────────

test("M8: the coordination signals come off raw X12, not out of a hand-built object", async () => {
  const raw = await era(COB_MEMBER);

  assert.match(raw, /CAS\*OA\*23\*/, "the OA-23 adjustment is really on the wire");
  assert.match(raw, /CLP\*MRM-COB1\*19\*/, "and so is CLP02 19, forwarded to another payer");

  const advice = new MockEdiAdapter().parseRemittance(raw).data!;
  const claim = advice.claims[0]!;
  assert.equal(claim.disposition, "forwarded", "the parser must not collapse 19 into partial/paid");
  const oa = claim.adjustments.find((a) => a.group === "OA");
  assert.ok(oa, "the OA adjustment survives normalisation");
  assert.equal(oa!.category, "coordination", "and is categorised as nobody's money yet");
});

test("M8: an ordinary claim from the same builder carries neither signal", async () => {
  // The control for the fixture itself. If the builder emitted OA on everything, every test below
  // would pass for the wrong reason.
  const advice = new MockEdiAdapter().parseRemittance(await era(ORDINARY_MEMBER)).data!;
  const claim = advice.claims[0]!;

  assert.notEqual(claim.disposition, "forwarded");
  assert.ok(!claim.adjustments.some((a) => a.group === "OA"));
});

// ── The remittance HOLDS ──────────────────────────────────────────────────────────────────────

test("M8: a coordinated remittance is HELD, with the reason a human needs", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted(COB_MEMBER));

  const view = await service.ingestRaw(await era(COB_MEMBER), NOW);

  assert.equal(view.remittance.status, "held", "money whose owner is unknown must not post itself");
  assert.match(view.remittance.holdReason ?? "", /FORWARDED|another payer/i);

  const stored = (await repo.list())[0]!;
  assert.equal(stored.status, "held");
  assert.ok(stored.raw835, "the evidence is preserved, not discarded");
});

test("M8: an ordinary remittance still posts — the gate must not freeze normal cash", async () => {
  const { service } = wired();
  await service.recordExpectation(submitted(ORDINARY_MEMBER));

  const view = await service.ingestRaw(await era(ORDINARY_MEMBER), NOW);
  assert.equal(view.remittance.status, "posted");
});

// ── Nothing disappears ────────────────────────────────────────────────────────────────────────

test("M8: the coordination amount is on the posting, named — not merely balanced away", async () => {
  const { service, repo } = wired();
  await service.recordExpectation(submitted(COB_MEMBER));
  await service.ingestRaw(await era(COB_MEMBER), NOW);

  const posting = (await repo.list())[0]!.postings[0]!;
  const variance = posting.variance!;

  assert.ok(variance.coordinationAmount > 0, "the sum must be reportable");
  assert.equal(variance.unexplainedAmount, 0, "and must not masquerade as vanished money");
  assert.equal(
    variance.actualPaid +
      variance.contractualAdjustments +
      variance.patientResponsibility +
      variance.recoverableAmount +
      variance.coordinationAmount +
      variance.unexplainedAmount,
    variance.chargedAmount,
    "every dollar charged is accounted for by exactly one category"
  );
  assert.equal(variance.adjudication, "coordination_pending");
});

/**
 * ── THE LEDGER HALF LIVES IN THE LEDGER'S OWN SUITE ────────────────────────────────────────────
 * "a balance under coordination is never charged to the patient" is asserted in
 * `modules/patient-ledger/src/__tests__/service.test.ts`. It cannot be asserted here: a module may
 * not import a sibling (docs/MODULE-BOUNDARIES.md, enforced by `npm run boundaries`), and reaching
 * for `@mermaid/patient-ledger` from Remittance to test the pair together is exactly the coupling
 * that rule exists to prevent. What this file owns is the half that produces the signal; what the
 * ledger's file owns is the half that refuses to act on it.
 */

test("M8: the claim is not reported settled while another payer has not ruled", async () => {
  /**
   * `settled` closes the claim in the Claims module and retires it from every queue. A coordinated
   * claim that reported settled would look finished while its secondary was never filed — the
   * revenue simply never pursued.
   */
  const { service, bus } = wired();
  await service.recordExpectation(submitted(COB_MEMBER));
  const view = await service.ingestRaw(await era(COB_MEMBER), NOW);

  // Held, so nothing published yet — which is itself the point.
  assert.equal(bus.ofType("remittance.posted").length, 0);

  // A sentence is not an answer to "does this patient have another plan?" (0034).
  await assert.rejects(
    service.release(view.remittance.id, "biller@clinic", "Confirmed against the paper EOB", NOW),
    (e: Error & { code?: string }) => e.code === "coverage-unconfirmed"
  );
  const [cob] = await service.listCoordinationCases();
  await service.confirmCoverage(
    cob!.id,
    { outcome: "other-coverage", source: "patient", confirmedOn: "2026-08-10", secondary: { payerName: "Guardian Dental", memberId: "GD-1" } },
    "biller@clinic",
    NOW
  );
  const released = await service.release(view.remittance.id, "biller@clinic", "Other coverage confirmed", NOW);
  assert.equal(released.remittance.status, "posted");

  const event = bus.ofType("remittance.posted")[0]!;
  assert.equal(event.payload.settled, false, "another plan has not ruled, so this claim is not finished");
  assert.ok((event.payload.coordinationAmount ?? 0) > 0, "and the amount travels so the ledger can refuse it");
  assert.equal(event.payload.forwardedToOtherPayer, true);
});
