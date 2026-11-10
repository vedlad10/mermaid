/**
 * The negative adjustment, end to end, through the real ingest path.
 *
 * ── WHY THIS TEST IS IN THE APP LAYER ──────────────────────────────────────────────────────────
 * The gate itself is tested where it lives, in `modules/remittance`. This one needs the WIRING —
 * the parser, the safety gate, the posting builder and the repository composed the way the product
 * composes them — and only the app layer may know that composition exists. A module reaching up
 * into `apps/` to prove itself is the layer inversion the boundary checker exists to stop, and it
 * caught exactly that when this file was first written in the wrong place.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * `@mermaid/shared` states five laws a money partition obeys. I5: every amount is a non-negative
 * whole number of cents, because a credit is a DIRECTION and direction lives in which bucket the
 * money sits in, never in its sign.
 *
 * Those laws were enforced in `checkPartition`, in its unit tests, and in an offline script — and
 * nowhere on the path money actually travels. `computeVariance` calls `buildPartition` and reads
 * `unexplained` off it; it has never called `checkPartition`.
 *
 * This file, fed through `parse835` and `ingestArtifact`:
 *
 *   CLP*MRM-NEG1*1*1000.00*600.00*500.00      charged 1000, paid 600, patient 500
 *   CAS*CO*45*-100.00                          a contractual write-off, REVERSED
 *   CAS*PR*2*500.00
 *
 * Every published gate passed. 600 + (−100) + 500 = 1000, so it BALANCES. CLP05 agrees with the PR
 * total, so the cross-check passes. CLP02 is not 22, so the reversal gate ignores it. Result:
 * `status: posted`, no hold, no finding — and the patient billed $500 where a well-formed advice
 * would have said $300. The negative moved $200 onto a person while the system reported everything
 * in order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import { buildServices } from "../wiring.ts";

const RECEIVED = new Date("2026-08-10T09:00:00Z");

const EXPECTATION = {
  claimId: "c1",
  verificationId: "v1",
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Neg", lastName: "Case", dateOfBirth: "1990-01-01", memberId: "ABC00011" },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: "MRM-NEG1",
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
};

type View = { remittance: { status: string; balanced: boolean; holdReason: string | null } };

/** A real 835 from the mock clearinghouse, optionally mutated, through the production parser. */
async function ingest(mutate: (raw: string) => string): Promise<View> {
  const services = buildServices({ inMemory: true });
  await services.remittance.recordExpectation(EXPECTATION as never);
  const fetched = await new MockEdiAdapter().fetchRemittance({
    payerId: "delta-dental",
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentDate: "2026-08-10",
    claims: [
      {
        patientControlNumber: "MRM-NEG1",
        payerControlNumber: "556677889",
        patientFirstName: "Neg",
        patientLastName: "Case",
        memberId: "ABC00011",
        lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
        expectedInsurancePays: cents(600),
      },
    ],
  });
  const views = await services.remittance.ingestArtifact(
    mutate(fetched.raw!),
    { resolution: "source-credential", vendor: "mock", artifactId: "f1", expectedPayeeId: null } as never,
    RECEIVED
  );
  return views[0] as unknown as View;
}

/** The exact file that posted: internally consistent in every published respect. */
const SELF_CONSISTENT_NEGATIVE = (raw: string) =>
  raw
    .replace(/CAS\*CO\*45\*100\.00/, "CAS*CO*45*-100.00")
    .replace(/CAS\*PR\*2\*300\.00/, "CAS*PR*2*500.00")
    .replace(/(CLP\*MRM-NEG1\*[^*]*\*[^*]*\*[^*]*\*)300\.00/, "$1500.00");

test("the advice that used to auto-post is now HELD", async () => {
  /** THE ASSERTION THIS FILE EXISTS FOR. Before the gate, this returned "posted". */
  const v = await ingest(SELF_CONSISTENT_NEGATIVE);

  assert.equal(v.remittance.status, "held", "auto-posting this bills a patient $200 that is not theirs");
  assert.match(
    v.remittance.holdReason ?? "",
    /negative CO-45 adjustment/,
    `the hold must say why: ${v.remittance.holdReason}`
  );
});

test("it still passes every gate that existed before, which is why it slipped through", async () => {
  /**
   * Pinned deliberately. If a later change makes this advice fail the balance check or the CLP05
   * cross-check for some unrelated reason, the test above would start passing for the wrong reason
   * and this one says so.
   */
  const v = await ingest(SELF_CONSISTENT_NEGATIVE);
  const reason = v.remittance.holdReason ?? "";

  assert.equal(v.remittance.balanced, true, "the advice balances — that is the trap");
  assert.ok(!/does not balance/.test(reason), "the arithmetic gates pass");
  assert.ok(!/CLP05/.test(reason), "CLP05 agrees with the PR total");
  assert.ok(!/reversal/i.test(reason), "and it is not labelled a reversal");
});

test("an ordinary advice still posts on its own", async () => {
  /**
   * The other half, and the more important one for whether this gate survives contact with a real
   * practice: a blocker that stops normal remittances is one people learn to click past.
   */
  const v = await ingest((raw) => raw);
  assert.equal(v.remittance.status, "posted");
  assert.ok(!/negative/.test(v.remittance.holdReason ?? ""));
});

test("a negative that does not balance is caught by both gates independently", async () => {
  const v = await ingest((raw) => raw.replace(/CAS\*CO\*45\*100\.00/, "CAS*CO*45*-100.00"));
  const reason = v.remittance.holdReason ?? "";

  assert.equal(v.remittance.status, "held");
  assert.ok(
    /negative CO-45|does not balance/.test(reason),
    `both gates should have something to say: ${reason}`
  );
});
