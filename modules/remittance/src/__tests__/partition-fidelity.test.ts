/**
 * The lift is only trustworthy if the shared partition still describes what this engine actually
 * produces. These tests hold the two together.
 *
 * ── WHAT "FIDELITY" MEANS HERE ─────────────────────────────────────────────────────────────────
 * `computeVariance` used to sum the buckets and clamp the residual inline; that arithmetic now
 * lives in `@mermaid/shared` so the estimate half of the system can reach the same partition. A
 * lift like that is safe exactly to the degree it changes nothing, so the assertions below are
 * deliberately about EQUIVALENCE rather than about the new type being nice:
 *
 *   • every figure `Variance` reports still equals the corresponding bucket in the partition
 *   • every partition the engine produces satisfies the laws, across the whole scenario matrix
 *   • the reconciliation the vertical tests already assert — "every cent the payer withheld is
 *     attributed to exactly one bucket" — is restated here as an equation over the partition
 *
 * The overpayment cases matter most. `Variance` has never carried an overpaid figure, so nothing
 * downstream can regress; but the partition now keeps it, and these tests pin the value so a later
 * phase can rely on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartition, checkPartition, cents, type Cents } from "@mermaid/shared";
import { computeVariance, type PaidClaim } from "../engine/variance.ts";
import type { VarianceReason } from "../types.ts";

/**
 * `computeVariance` returns null for an UNKNOWN expectation, which is a state none of these tests
 * describe — every one of them states a figure. Asserted rather than silenced with `!`, so a
 * function that started refusing everything would fail here instead of passing quietly.
 */
const variance = (
  paid: Parameters<typeof computeVariance>[0],
  expected: Parameters<typeof computeVariance>[1]
): NonNullable<ReturnType<typeof computeVariance>> => {
  const v = computeVariance(paid, expected);
  assert.ok(v, "a stated expectation must produce a variance");
  return v;
};


const adj = (
  group: string,
  code: string,
  category: VarianceReason["category"],
  amount: number
): VarianceReason => ({
  group,
  code,
  description: `${group}-${code}`,
  category,
  amount: cents(amount),
  procedureCode: null,
});

const claim = (o: {
  charged: number;
  paid: number;
  patientResponsibility?: number;
  adjustments: VarianceReason[];
}): PaidClaim => ({
  chargedAmount: cents(o.charged),
  paidAmount: cents(o.paid),
  patientResponsibility: cents(o.patientResponsibility ?? 0),
  adjustments: o.adjustments,
});

/** Rebuild the partition from a Variance the way a later phase would, and check it. */
const partitionOf = (v: NonNullable<ReturnType<typeof computeVariance>>, informational: Cents = cents(0)) =>
  buildPartition({
    charged: v.chargedAmount,
    payerPaid: v.actualPaid,
    contractual: v.contractualAdjustments,
    patientResponsibility: v.patientResponsibility,
    coordination: v.coordinationAmount,
    recoverable: v.recoverableAmount,
    informational,
  });

/**
 * The scenario matrix. Each entry names a real shape the engine has to handle, so a law that only
 * holds for the happy path is caught here rather than in production.
 */
const SCENARIOS: { name: string; paid: PaidClaim; expected: number; informational?: number }[] = [
  {
    name: "paid in full against the estimate",
    paid: claim({ charged: 120, paid: 120, adjustments: [] }),
    expected: 120,
  },
  {
    name: "contractual write-off, patient owes the rest",
    paid: claim({
      charged: 1425,
      paid: 799.99,
      adjustments: [adj("CO", "45", "contractual", 142.5), adj("PR", "2", "patient", 482.51)],
    }),
    expected: 800,
  },
  {
    name: "denial with a recoverable reason",
    paid: claim({
      charged: 1425,
      paid: 21.49,
      adjustments: [
        adj("CO", "45", "contractual", 142.5),
        adj("CO", "197", "recoverable", 1125),
        adj("PR", "2", "patient", 136.01),
      ],
    }),
    expected: 175,
  },
  {
    name: "coordination of benefits — money owed by another plan",
    paid: claim({
      charged: 1425,
      paid: 799.99,
      adjustments: [adj("CO", "45", "contractual", 142.5), adj("OA", "23", "coordination", 482.51)],
    }),
    expected: 800,
  },
  {
    name: "zero payment, everything to an unmet deductible",
    paid: claim({ charged: 1425, paid: 0, adjustments: [adj("PR", "1", "patient", 1425)] }),
    expected: 600,
  },
  {
    name: "money withheld with no reason code at all",
    paid: claim({ charged: 1425, paid: 1000, adjustments: [] }),
    expected: 1425,
  },
  {
    name: "overpayment — more arrived than the charge could absorb",
    paid: claim({ charged: 1000, paid: 1200, adjustments: [] }),
    expected: 1000,
  },
  {
    name: "informational adjustment alongside a normal split",
    paid: claim({
      charged: 1000,
      paid: 700,
      adjustments: [
        adj("CO", "45", "contractual", 100),
        adj("PR", "2", "patient", 150),
        adj("CO", "94", "informational", 50),
      ],
    }),
    expected: 700,
    informational: 50,
  },
];

test("every scenario's partition satisfies the laws", () => {
  for (const s of SCENARIOS) {
    const v = variance(s.paid, cents(s.expected));
    const p = partitionOf(v, cents(s.informational ?? 0));
    assert.deepEqual(checkPartition(p), [], `${s.name}: partition violated its laws`);
  }
});

test("the partition reports the same figures Variance does", () => {
  for (const s of SCENARIOS) {
    const v = variance(s.paid, cents(s.expected));
    const p = partitionOf(v, cents(s.informational ?? 0));
    assert.equal(p.charged, v.chargedAmount, `${s.name}: charged`);
    assert.equal(p.payerPaid, v.actualPaid, `${s.name}: paid`);
    assert.equal(p.contractual, v.contractualAdjustments, `${s.name}: contractual`);
    assert.equal(p.patientResponsibility, v.patientResponsibility, `${s.name}: patient`);
    assert.equal(p.recoverable, v.recoverableAmount, `${s.name}: recoverable`);
    assert.equal(p.coordination, v.coordinationAmount, `${s.name}: coordination`);
    assert.equal(
      p.unexplained,
      v.unexplainedAmount,
      `${s.name}: unexplained must match the figure the engine has always reported`
    );
  }
});

/**
 * The clamp is still doing its job on the reported figure, and the sign is now kept beside it.
 * `Variance` deliberately does NOT gain an overpaid field in this phase — nothing persisted
 * changes — so this asserts the partition holds what the engine discards.
 */
test("an overpayment reports zero unexplained on Variance and a real figure on the partition", () => {
  const v = variance(claim({ charged: 1000, paid: 1200, adjustments: [] }), cents(1000));
  assert.equal(v.unexplainedAmount, 0, "the clamp still protects the reported figure");
  const p = partitionOf(v);
  assert.equal(p.overpayment, cents(200), "and the fact survives in the partition");
  assert.equal(p.unexplained, 0);
});

test("unexplained money is still surfaced, unchanged by the lift", () => {
  const v = variance(claim({ charged: 1425, paid: 1000, adjustments: [] }), cents(1425));
  assert.equal(v.unexplainedAmount, cents(425));
  assert.equal(partitionOf(v).unexplained, cents(425));
});

/**
 * The reconciliation the vertical suite asserts in prose — "every cent the payer withheld is
 * attributed to exactly one bucket" — restated as an equation, so it is checked at the unit level
 * too and a future bucket cannot be added without either joining the sum or showing up as
 * unexplained.
 */
test("every cent is attributed to exactly one bucket, for every scenario", () => {
  for (const s of SCENARIOS) {
    const v = variance(s.paid, cents(s.expected));
    const p = partitionOf(v, cents(s.informational ?? 0));
    const total =
      p.payerPaid +
      p.contractual +
      p.patientResponsibility +
      p.coordination +
      p.recoverable +
      p.informational +
      p.unexplained -
      p.overpayment;
    assert.equal(total, p.charged, `${s.name}: the buckets do not reconstitute the charge`);
  }
});
