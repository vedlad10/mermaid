/**
 * The money partition and its laws.
 *
 * ── WHY THE OVERPAYMENT CASES CARRY THE WEIGHT ─────────────────────────────────────────────────
 * The remittance engine has always clamped the residual with `Math.max(0, …)`, which is correct —
 * a negative `unexplained` is meaningless — but the clamp threw the sign away, so an overpayment
 * left no trace. A design review then proposed asserting
 *
 *     allowed === payerPaid + patientResponsibility + coordination + recoverable + unexplained
 *
 * which reads as obviously true and is false on every overpaid remittance. Shipping that assertion
 * would have failed ingestion on real payer advice. The tests below pin the corrected, signed form
 * AND keep a test that demonstrates the naive equation breaking, so nobody "simplifies" it back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPartition,
  checkPartition,
  partitionBalances,
  accountedFor,
  residual,
  type MoneyPartition,
} from "../domain/partition.ts";
import { addCents, subCents, type Cents } from "../money.ts";

const c = (n: number): Cents => n as Cents;

/** The audited staging case: $1,425.00 charged, 10% contractual, payer pays, patient owes the rest. */
const nora = () =>
  buildPartition({
    charged: c(142_500),
    payerPaid: c(79_999),
    contractual: c(14_250),
    patientResponsibility: c(48_251),
  });

// ── The six required scenarios ────────────────────────────────────────────────────────────────

test("normal payment — the charge divides exactly, nothing unexplained, nothing overpaid", () => {
  const p = nora();
  assert.equal(p.allowed, 128_250, "allowed is charged minus the write-off");
  assert.equal(p.unexplained, 0);
  assert.equal(p.overpayment, 0);
  assert.deepEqual(checkPartition(p), []);
});

test("partial payment — the shortfall is recoverable, not unexplained, when the payer said why", () => {
  const p = buildPartition({
    charged: c(142_500),
    payerPaid: c(2_149),
    contractual: c(14_250),
    patientResponsibility: c(13_601),
    recoverable: c(112_500),
  });
  assert.equal(p.unexplained, 0, "a reason code was given, so nothing vanished");
  assert.equal(p.recoverable, 112_500);
  assert.ok(partitionBalances(p));
});

test("zero payment — a full denial still balances when every withheld dollar carries a reason", () => {
  const p = buildPartition({
    charged: c(142_500),
    payerPaid: c(0),
    contractual: c(0),
    patientResponsibility: c(142_500),
  });
  assert.equal(p.payerPaid, 0);
  assert.equal(p.allowed, 142_500);
  assert.equal(p.unexplained, 0);
  assert.ok(partitionBalances(p));
});

test("zero payment with NO reason code is unexplained money, which is the dangerous case", () => {
  const p = buildPartition({
    charged: c(142_500),
    payerPaid: c(0),
    contractual: c(0),
    patientResponsibility: c(0),
  });
  assert.equal(p.unexplained, 142_500, "nothing but arithmetic surfaces this");
  assert.equal(p.overpayment, 0);
  assert.ok(partitionBalances(p), "unexplained money still satisfies the laws — it is reported, not a fault");
});

test("overpayment — more arrived than the charge could absorb, and the fact survives", () => {
  const p = buildPartition({
    charged: c(142_500),
    payerPaid: c(150_000),
    contractual: c(0),
    patientResponsibility: c(0),
  });
  assert.equal(p.overpayment, 7_500, "the residual went negative and was kept, not discarded");
  assert.equal(p.unexplained, 0);
  assert.deepEqual(checkPartition(p), []);
});

test("informational adjustments are accounted for, so they never masquerade as unexplained", () => {
  const withInfo = buildPartition({
    charged: c(142_500),
    payerPaid: c(79_999),
    contractual: c(14_250),
    patientResponsibility: c(43_251),
    informational: c(5_000),
  });
  assert.equal(withInfo.informational, 5_000);
  assert.equal(withInfo.unexplained, 0, "informational money balances, exactly as the engine always counted it");

  /** Drop the same amount from the bucket and it reappears as money nobody explained. */
  const without = buildPartition({
    charged: c(142_500),
    payerPaid: c(79_999),
    contractual: c(14_250),
    patientResponsibility: c(43_251),
  });
  assert.equal(without.unexplained, 5_000, "which is why the bucket has to exist");
});

/**
 * Money is integer cents everywhere, so nothing rounds inside the partition. What the arithmetic
 * DOES do is refuse to hide a pro-rata split that fails to sum — the one-cent drift a payer's
 * per-line rounding produces surfaces as unexplained rather than being quietly absorbed.
 */
test("rounding — a one-cent pro-rata drift surfaces instead of being absorbed", () => {
  const lines = [c(3_649), c(6_175), c(70_175)];
  const paid = addCents(...lines);
  assert.equal(paid, 79_999, "the fixture's own pro-rata split, which sums a cent short of 800.00");

  const p = buildPartition({
    charged: c(142_500),
    payerPaid: paid,
    contractual: c(14_250),
    patientResponsibility: c(48_250),
  });
  assert.equal(p.unexplained, 1, "one cent, named rather than swallowed");
  assert.ok(partitionBalances(p));
});

// ── The law that is easy to get wrong ─────────────────────────────────────────────────────────

test("the signed reconciliation holds in every direction", () => {
  const cases: MoneyPartition[] = [
    nora(),
    buildPartition({ charged: c(100_00), payerPaid: c(120_00), contractual: c(0), patientResponsibility: c(0) }),
    buildPartition({ charged: c(100_00), payerPaid: c(0), contractual: c(0), patientResponsibility: c(0) }),
    buildPartition({
      charged: c(100_00),
      payerPaid: c(40_00),
      contractual: c(10_00),
      patientResponsibility: c(20_00),
      coordination: c(15_00),
      recoverable: c(10_00),
      informational: c(5_00),
    }),
  ];
  for (const p of cases) {
    const reconciled = subCents(addCents(accountedFor(p), p.unexplained), p.overpayment);
    assert.equal(reconciled, p.charged, "I4: charged === accountedFor + unexplained − overpayment");
    assert.deepEqual(checkPartition(p), []);
  }
});

/**
 * The trap, kept as an executable warning. If someone "simplifies" the law back to its unsigned
 * form, this test is the record of why that is wrong.
 */
test("the naive unsigned equation is FALSE on an overpayment — this is why I4 carries a minus", () => {
  const p = buildPartition({
    charged: c(142_500),
    payerPaid: c(150_000),
    contractual: c(0),
    patientResponsibility: c(0),
  });
  const naive = addCents(
    p.payerPaid,
    p.patientResponsibility,
    p.coordination,
    p.recoverable,
    p.informational,
    p.unexplained
  );
  assert.notEqual(naive, p.allowed, "the naive form does not hold");
  assert.equal(naive - p.allowed, 7_500, "it is wrong by exactly the overpaid amount");
  assert.equal(subCents(naive, p.overpayment), p.allowed, "and the signed form repairs it");
});

test("unexplained and overpayment are never both non-zero", () => {
  for (const paid of [0, 50_00, 100_00, 150_00]) {
    const p = buildPartition({
      charged: c(100_00),
      payerPaid: c(paid),
      contractual: c(0),
      patientResponsibility: c(0),
    });
    assert.ok(p.unexplained === 0 || p.overpayment === 0, `both non-zero at paid=${paid}`);
  }
});

test("a payer paying more than the allowed amount always shows an overpayment", () => {
  const p = buildPartition({
    charged: c(100_00),
    payerPaid: c(95_00),
    contractual: c(10_00),
    patientResponsibility: c(0),
  });
  assert.ok(p.payerPaid > p.allowed, "paid 95.00 against an allowed 90.00");
  assert.ok(p.overpayment > 0, "which the partition must report rather than hide");
});

// ── The checker earns its keep only if it can fail ────────────────────────────────────────────

test("a tampered residual is caught", () => {
  const p: MoneyPartition = { ...nora(), unexplained: c(500) };
  const violations = checkPartition(p);
  assert.ok(violations.some((v) => v.invariant === "I3"), "the residual no longer matches the buckets");
  assert.ok(violations.some((v) => v.invariant === "I4"), "and the reconciliation breaks with it");
});

test("an allowed amount that does not complement the write-off is caught", () => {
  const p: MoneyPartition = { ...nora(), allowed: c(100_000) };
  assert.ok(checkPartition(p).some((v) => v.invariant === "I1"));
});

test("a negative amount is a representation error, never a credit", () => {
  const p: MoneyPartition = { ...nora(), recoverable: c(-1) };
  const violations = checkPartition(p);
  assert.ok(violations.some((v) => v.invariant === "I5" && /negative/.test(v.detail)));
});

test("fractional cents are refused", () => {
  const p: MoneyPartition = { ...nora(), payerPaid: c(79_999.5) };
  assert.ok(checkPartition(p).some((v) => v.invariant === "I5" && /whole cents/.test(v.detail)));
});

test("residual and accountedFor agree with the buckets they are built from", () => {
  const p = nora();
  assert.equal(accountedFor(p), 142_500);
  assert.equal(residual(p), 0);
});
