/**
 * 835 ERA codec tests.
 *
 * The balancing assertions carry the most weight here — they are the money-safety mechanism the
 * remittance module refuses to post without. Note especially the one-cent test: in the donor's
 * float-dollar implementation a 1¢ discrepancy hid inside a `> 0.01` tolerance. In integer cents it
 * fails, which is the correct behaviour for money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import {
  allAdjustments,
  build835,
  claimDisposition,
  parse835,
  parseSegments,
  CLP_STATUS,
  type Build835Claim,
  type Build835ProviderAdjustment,
} from "../mock/x12-835.ts";

const NOW = new Date("2026-08-10T09:00:00Z");

/** Exam $65 paid in full; crown $1250 → $125 contractual, $500 paid, $625 coinsurance. */
function claim(overrides: Partial<Build835Claim> = {}): Build835Claim {
  return {
    patientControlNumber: "MRM-000123",
    payerControlNumber: "556677889",
    statusCode: "1",
    charged: 1315,
    paid: 565,
    patientResponsibility: 625,
    patientFirstName: "Ada",
    patientLastName: "Alpha",
    memberId: "ABC12345",
    lines: [
      { procedureCode: "D0120", charged: 65, paid: 65, quantity: 1 },
      {
        procedureCode: "D2750",
        charged: 1250,
        paid: 500,
        quantity: 1,
        adjustments: [
          { group: "CO", code: "45", amount: 125 },
          { group: "PR", code: "2", amount: 625 },
        ],
      },
    ],
    ...overrides,
  };
}

const advice = (claims: Build835Claim[], paymentTotal: number) =>
  build835(
    {
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      traceNumber: "EFT100200300",
      paymentTotal,
      paymentDate: "2026-08-10",
      claims,
    },
    NOW
  );

test("build835 → parse835 round-trips a balanced payment (production parser exercised)", () => {
  const parsed = parse835(advice([claim()], 565));

  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.trace!.number, "EFT100200300");
  assert.equal(parsed.payerName, "Delta Dental");
  assert.equal(parsed.payeeName, "MERMAID DEMO DENTAL");
  assert.equal(parsed.payment!.method, "ACH");
  assert.equal(parsed.payment!.date, "20260810");
});

test("money is parsed into INTEGER CENTS, never dollars", () => {
  const parsed = parse835(advice([claim()], 565));
  const c = parsed.claims[0]!;

  assert.equal(parsed.payment!.total, cents(565));
  assert.equal(c.charged, 131500);
  assert.equal(c.paid, 56500);
  assert.equal(c.patientResponsibility, 62500);
  assert.ok(Number.isInteger(c.charged) && Number.isInteger(c.paid));
  assert.equal(c.lines[1]!.charged, 125000);
  assert.equal(c.lines[1]!.paid, 50000);
});

test("claim identity, patient and control numbers survive the round trip", () => {
  const c = parse835(advice([claim()], 565)).claims[0]!;
  assert.equal(c.patientControlNumber, "MRM-000123");
  assert.equal(c.payerControlNumber, "556677889");
  assert.equal(c.patientName, "Ada Alpha");
  assert.equal(c.memberId, "ABC12345");
  assert.equal(c.statusCode, "1");
});

test("line-level CAS adjustments are attributed to their procedure", () => {
  const c = parse835(advice([claim()], 565)).claims[0]!;
  const adjustments = allAdjustments(c);

  assert.equal(adjustments.length, 2);
  const contractual = adjustments.find((a) => a.code === "45")!;
  assert.equal(contractual.group, "CO");
  assert.equal(contractual.amount, cents(125));
  assert.equal(contractual.procedureCode, "D2750");

  const coinsurance = adjustments.find((a) => a.code === "2")!;
  assert.equal(coinsurance.group, "PR");
  assert.equal(coinsurance.amount, cents(625));
});

test("claim-level CAS adjustments carry no procedure code", () => {
  const parsed = parse835(
    advice(
      [
        claim({
          paid: 0,
          patientResponsibility: 0,
          lines: [{ procedureCode: "D0120", charged: 65, paid: 0 }, { procedureCode: "D2750", charged: 1250, paid: 0 }],
          claimAdjustments: [{ group: "CO", code: "27", amount: 1315 }],
        }),
      ],
      0
    )
  );
  const c = parsed.claims[0]!;
  assert.equal(c.adjustments.length, 1);
  assert.equal(c.adjustments[0]!.code, "27");
  assert.equal(c.adjustments[0]!.procedureCode, null);
  assert.equal(parsed.balanced, true);
});

test("RARC remark codes are captured", () => {
  const parsed = parse835(advice([claim({ remarks: ["N54", "N130"] })], 565));
  assert.deepEqual(parsed.claims[0]!.remarks, ["N54", "N130"]);
});

// ── Balancing: the money-safety mechanism ─────────────────────────────────────────────

test("a ONE CENT discrepancy fails the balance check — no float tolerance to hide in", () => {
  // The donor balanced in float dollars with a `> 0.01` epsilon, which would have swallowed this.
  const raw = advice([claim()], 565).replace("CAS*PR*2*625.00", "CAS*PR*2*624.99");
  const parsed = parse835(raw);

  assert.equal(parsed.balanced, false);
  assert.equal(parsed.claims[0]!.unbalanced, true);
  assert.match(parsed.issues[0]!, /charged \$1315\.00 but paid \+ adjustments = \$1314\.99/);
});

test("service lines that disagree with the claim total are caught", () => {
  const raw = advice([claim()], 565).replace("SVC*AD:D2750*1250.00*500.00", "SVC*AD:D2750*1250.00*450.00");
  const parsed = parse835(raw);

  assert.equal(parsed.balanced, false);
  assert.ok(parsed.issues.some((i) => /service lines total \$515\.00 but CLP reports \$565\.00 paid/.test(i)));
});

test("a payment total that disagrees with the claims is caught", () => {
  const parsed = parse835(advice([claim()], 999));
  assert.equal(parsed.balanced, false);
  assert.ok(parsed.issues.some((i) => /Remittance total \$999\.00 does not equal/.test(i)));
});

test("provider-level adjustments are subtracted from the expected payment total", () => {
  const raw = advice([claim()], 515).replace("~SE*", "~PLB*1234567893*20261231*WO>REF1*50.00~SE*");
  const parsed = parse835(raw);

  assert.equal(parsed.providerAdjustments.length, 1);
  assert.equal(parsed.providerAdjustments[0]!.amount, cents(50));
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
});

/**
 * ── PLB PARSING (M12) ──────────────────────────────────────────────────────────────────────────
 *
 * Driven through `build835` → `parse835` rather than hand-built, so `reasonCode` and `referenceId`
 * are proven to come off the wire. A field only a fixture can produce is a field that can be
 * permanently null in production without any test noticing — the coverage-date defect.
 */
const withPlb = (
  providerAdjustments: Build835ProviderAdjustment[],
  paymentTotal: number,
  claims: Build835Claim[] = [claim()]
) =>
  build835(
    {
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      traceNumber: "EFT100200300",
      paymentTotal,
      paymentDate: "2026-08-10",
      claims,
      providerAdjustments,
    },
    NOW
  );

test("PLB03 splits into a reason code and the claim reference behind it", () => {
  const parsed = parse835(
    withPlb([{ providerId: "1234567893", reasonCode: "WO", referenceId: "MRM-000123", amount: 50 }], 515)
  );

  assert.equal(parsed.providerAdjustments.length, 1);
  const plb = parsed.providerAdjustments[0]!;
  assert.equal(plb.reasonCode, "WO");
  assert.equal(plb.referenceId, "MRM-000123");
  // The verbatim string survives alongside the split halves.
  assert.equal(plb.reason, "WO:MRM-000123");
  assert.equal(plb.amount, cents(50));
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
});

test("a PLB with a bare reason code reports referenceId null, not an empty string", () => {
  const parsed = parse835(withPlb([{ providerId: "1234567893", reasonCode: "L6", amount: 4.12 }], 560.88));

  const plb = parsed.providerAdjustments[0]!;
  assert.equal(plb.reasonCode, "L6");
  assert.equal(plb.referenceId, null, "no reference must be null — an empty string reads as a real value");
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
});

/**
 * Re-declare a payload's component separator — ISA16, and every composite in the body.
 *
 * The point is that the two move TOGETHER. This test used to swap the composite alone, leaving a
 * payload that announced `:` and then used `>`; it passed only because the parser guessed from a
 * fixed set instead of reading the announcement, and it would have kept passing while a real payer's
 * separator went unread. A payload that contradicts its own header is malformed, and asserting that
 * we parse it anyway asserts the wrong thing.
 */
const withSeparator = (raw: string, comp: string) => {
  // ISA16 is the element immediately before the very first segment terminator.
  const out = raw.replace("*:~GS*", `*${comp}~GS*`).replaceAll("WO:", `WO${comp}`).replaceAll("AD:", `AD${comp}`);
  assert.ok(
    out.includes(`*${comp}~GS*`) && !out.includes("WO:MRM") === (comp !== ":"),
    `the fixture was not fully rewritten to ${comp} — the test would prove nothing`
  );
  return out;
};

test("the component separator is read from ISA16, whatever the payer chose", () => {
  const plb = (raw: string) => raw.replace("~SE*", "~PLB*1234567893*20261231*WO:MRM-000123*50.00~SE*");

  for (const comp of [":", ">", "^", "`", "|"]) {
    const parsed = parse835(withSeparator(plb(advice([claim()], 515)), comp));

    assert.equal(
      parsed.providerAdjustments[0]!.referenceId,
      "MRM-000123",
      `separator ${comp}: the PLB reference must survive — an unsplit one is a takeback attributed to no claim`
    );
    assert.equal(
      parsed.claims[0]!.lines[0]!.procedureCode,
      "D0120",
      `separator ${comp}: SVC01 must lose its qualifier — "AD${comp}D0120" matches no procedure catalog`
    );
    assert.equal(parsed.balanced, true, `separator ${comp}: ${parsed.issues.join(" | ")}`);
  }
});

test("a backtick separator — the one a real clearinghouse actually used — is not guessed at", () => {
  /**
   * Stedi's live 277CA declares a backtick in ISA16. The old parser guessed from `[:>^]`, which does
   * not contain it, so `STC*A1`20` came back as the unsplit "A1`20" with a null status code and the
   * accept/reject decision was made on that string. The 835 path had the identical defect: a
   * backtick payer would have posted every line against a procedure code no catalog holds.
   */
  const parsed = parse835(withSeparator(advice([claim()], 565), "`"));

  assert.equal(parsed.claims[0]!.lines[0]!.procedureCode, "D0120");
  assert.equal(parsed.claims[0]!.lines[1]!.procedureCode, "D2750");
  assert.equal(parsed.balanced, true, parsed.issues.join(" | "));
});

test("every pair on a multi-pair PLB is read, and the advice balances because of it", () => {
  // One segment, two takebacks: PLB03/04 = $50, PLB05/06 = $30. $565 paid − $80 = $485 deposited.
  const raw = withPlb(
    [
      { providerId: "1234567893", reasonCode: "WO", referenceId: "MRM-000123", amount: 50 },
      { providerId: "1234567893", reasonCode: "FB", referenceId: "MRM-000999", amount: 30 },
    ],
    485
  );
  // Both pairs must be on ONE segment — a per-adjustment segment would not exercise the pair loop.
  assert.equal((raw.match(/~PLB\*/g) ?? []).length, 1, "the two pairs must share one PLB segment");

  const parsed = parse835(raw);

  assert.equal(parsed.providerAdjustments.length, 2);
  assert.equal(parsed.providerAdjustments[0]!.amount, cents(50));
  assert.equal(parsed.providerAdjustments[1]!.amount, cents(30));
  assert.equal(parsed.providerAdjustments[1]!.reasonCode, "FB");
  assert.equal(parsed.providerAdjustments[1]!.referenceId, "MRM-000999");

  // THE LOAD-BEARING ASSERTION: reading only PLB03/04 leaves $30 unaccounted, the BPR total no
  // longer equals claims-less-adjustments, and the advice fails to balance. The sum is what makes
  // this file readable at all.
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
});

test("a PLB pair positioned after an omitted one is still read", () => {
  // PLB03/04 empty, PLB05/06 real. `break` on the first gap would drop $50 that is on the wire.
  const raw = advice([claim()], 515).replace("~SE*", "~PLB*1234567893*20261231**0.00*WO:MRM-000123*50.00~SE*");
  const parsed = parse835(raw);

  assert.equal(parsed.providerAdjustments.length, 1);
  assert.equal(parsed.providerAdjustments[0]!.amount, cents(50));
  assert.equal(parsed.providerAdjustments[0]!.referenceId, "MRM-000123");
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
});

test("an 835 with no BPR payment segment is flagged rather than silently posted", () => {
  const raw = advice([claim()], 565).replace(/BPR\*[^~]*~/, "");
  const parsed = parse835(raw);
  assert.equal(parsed.payment, null);
  assert.equal(parsed.balanced, false);
  assert.match(parsed.issues.join(" "), /no BPR payment segment/);
});

test("a balance failure is DATA, not an exception — the payment info must survive", () => {
  const parsed = parse835(advice([claim()], 999));
  assert.equal(parsed.balanced, false);
  assert.equal(parsed.claims.length, 1, "the claim is still readable so a human can reconcile it");
  assert.equal(parsed.payment!.total, cents(999));
});

// ── Structural failures must be loud ──────────────────────────────────────────────────

test("parse835 throws on empty input and on a non-835 payload", () => {
  assert.throws(() => parse835(""), /Empty EDI payload/);
  assert.throws(() => parse835("   "), /Empty EDI payload/);
  assert.throws(() => parse835("ST*837*0001*005010X224A2~SE*2*0001~"), /not an X12 835/);
});

test("an SVC before any CLP is reported rather than crashing", () => {
  const parsed = parse835("ST*835*0001~BPR*I*0.00*C*ACH~TRN*1*T1~SVC*AD>D0120*65.00*65.00~SE*5*0001~");
  assert.equal(parsed.balanced, false);
  assert.ok(parsed.issues.some((i) => /SVC service line appeared before any CLP/.test(i)));
});

// ── Disposition ───────────────────────────────────────────────────────────────────────

test("disposition distinguishes paid, partial and denied", () => {
  const parsed = parse835(advice([claim()], 565));
  assert.equal(claimDisposition(parsed.claims[0]!), "partial");

  const full = parse835(
    advice([claim({ charged: 65, paid: 65, patientResponsibility: 0, lines: [{ procedureCode: "D0120", charged: 65, paid: 65 }] })], 65)
  );
  assert.equal(claimDisposition(full.claims[0]!), "paid_full");
});

test("a reversal is recognised BEFORE the zero-payment heuristic", () => {
  // A CLP-22 with $0 paid is a retraction needing manual review, not a denial.
  const raw = advice(
    [claim({ statusCode: "22", paid: 0, patientResponsibility: 0, lines: [{ procedureCode: "D0120", charged: 65, paid: 0, adjustments: [{ group: "CR", code: "45", amount: 65 }] }], charged: 65 })],
    0
  );
  const parsed = parse835(raw);
  assert.equal(claimDisposition(parsed.claims[0]!), "reversal");
  assert.equal(CLP_STATUS["22"], "reversal");
});

test("an explicitly denied claim reports denied", () => {
  const parsed = parse835(
    advice(
      [
        claim({
          statusCode: "4",
          paid: 0,
          patientResponsibility: 0,
          charged: 65,
          lines: [{ procedureCode: "D0120", charged: 65, paid: 0, adjustments: [{ group: "CO", code: "96", amount: 65 }] }],
        }),
      ],
      0
    )
  );
  assert.equal(claimDisposition(parsed.claims[0]!), "denied");
});

test("the envelope is well-formed and SE counts the transaction", () => {
  const raw = advice([claim()], 565);
  const segments = parseSegments(raw);
  const stIndex = segments.findIndex((s) => s.id === "ST");
  const seIndex = segments.findIndex((s) => s.id === "SE");

  assert.equal(segments[stIndex]!.elements[0], "835");
  assert.equal(segments[seIndex]!.elements[0], String(seIndex - stIndex + 1));
  assert.equal(segments.at(-1)!.id, "IEA");
});

test("multiple claims in one remittance all parse and balance together", () => {
  const second = claim({
    patientControlNumber: "MRM-000456",
    payerControlNumber: "556677890",
    charged: 65,
    paid: 65,
    patientResponsibility: 0,
    lines: [{ procedureCode: "D0120", charged: 65, paid: 65 }],
  });
  const parsed = parse835(advice([claim(), second], 630));

  assert.equal(parsed.claims.length, 2);
  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
  assert.deepEqual(parsed.claims.map((c) => c.patientControlNumber), ["MRM-000123", "MRM-000456"]);
});

/**
 * ── A GAPPED CAS SEGMENT IS READ, AND REPORTED (NEW-26) ──────────────────────────────────────────
 *
 * The triplet loop used `if (!code) break`, on the reasoning — still stated in the PLB loop — that a
 * CAS segment's triplets are contiguous by construction. 005010X221A1 requires that; it is not a
 * guarantee about what arrives. A payer emitting a gap had every adjustment after it DISCARDED.
 *
 * Discarding an adjustment silently is the same money loss the PLB loop was fixed for, and it fails
 * in a more confusing direction: the dropped amount breaks the BPR balance check, so the advice
 * holds as `unbalanced` and a human is told the payer's file does not add up — when in fact the
 * parser stopped reading it early.
 */

/**
 * One advice whose claim carries the CAS segment given, verbatim, in place of its CO adjustment.
 *
 * A CAS triplet is code/amount/QUANTITY, so a gap where the second triplet should be is FOUR empty
 * elements after the first amount (its quantity, then the whole missing triplet) — getting that
 * alignment wrong writes the next reason code into an amount slot, which is a different bug and
 * would make this test pass for the wrong reason.
 */
const withCas = (cas: string): string =>
  advice([claim()], 565).replace(/~CAS\*CO[^~]*~/, `~${cas}~`);

/**
 * The adjustments the substituted segment produced.
 *
 * Claim-level AND line-level: the fixture's CO adjustment hangs off the D2750 service line, and a
 * helper that looked only at `claim.adjustments` would report an empty list and make every
 * assertion below vacuously wrong rather than loudly wrong.
 */
const coCodes = (raw: string): string[] => {
  const c = parse835(raw).claims[0]!;
  return [...c.adjustments, ...c.lines.flatMap((l) => l.adjustments)]
    .filter((a) => a.group === "CO")
    .map((a) => a.code);
};

test("NEW-26: a CAS segment with a gap keeps the adjustments after it", () => {
  // A gap where the second triplet should be: two empty elements, then a real reason code.
  //                       ↓ first triplet ↓  ↓ the missing one ↓ ↓ third ↓
  const raw = withCas("CAS*CO*45*1.25*****253*0.25");
  const parsed = parse835(raw);

  assert.deepEqual(
    coCodes(raw),
    ["45", "253"],
    "the adjustment after the gap is money the payer withheld; dropping it makes the file fail to " +
      "balance for a reason that has nothing to do with the payer"
  );
  const all = [...parsed.claims[0]!.adjustments, ...parsed.claims[0]!.lines.flatMap((l) => l.adjustments)];
  assert.equal(all.find((a) => a.code === "253")!.amount, 25);
});

test("NEW-26: the gap itself is reported as an issue, not inferred from an arithmetic failure", () => {
  const parsed = parse835(withCas("CAS*CO*45*1.25*****253*0.25"));

  assert.ok(
    parsed.issues.some((i) => /gap/i.test(i) && /contiguous/i.test(i)),
    `the malformed segment must be named, got: ${JSON.stringify(parsed.issues)}`
  );
});

test("NEW-26: an amount with no reason code is refused rather than counted", () => {
  /**
   * Money the payer has not explained. Counting it toward the balance would make the file reconcile
   * while nobody could say why the deduction happened — which is the shape of a reconciliation that
   * passes and means nothing.
   */
  // An amount sitting in a triplet whose reason code is empty.
  const parsed = parse835(withCas("CAS*CO*45*1.25***0.25"));

  assert.ok(
    parsed.issues.some((i) => /no reason code/i.test(i)),
    `expected an issue naming the unexplained amount, got: ${JSON.stringify(parsed.issues)}`
  );
});

test("NEW-26: an ordinary contiguous CAS is unchanged, and reports nothing", () => {
  /**
   * The control. Every real 835 takes this path, and an issue raised on well-formed traffic is an
   * issue people learn to ignore.
   */
  const parsed = parse835(advice([claim()], 565));

  assert.equal(parsed.balanced, true, `unexpected issues: ${parsed.issues.join(" | ")}`);
  assert.deepEqual(
    parsed.issues.filter((i) => /gap|no reason code/i.test(i)),
    [],
    "a well-formed segment must produce no complaint"
  );
});

// ── Claim-level adjustments beside itemised lines ─────────────────────────────────────────────
//
// CLP04 = Σ SVC03 − Σ claim-level CAS (005010X221A1 balancing). The check compared CLP04 with the
// lines alone, so a payer that takes a withhold or reduction at the CLAIM level while itemising the
// lines produced a "service lines total … but CLP reports …" failure on a balanced file — and the
// safety gate refuses to release an arithmetic failure at all. Found 2026-10-15 by reading public
// 835s: the X12 guide's own managed-care example and a Databricks sample, both balanced, both held.

const withClaimLevelAdjustment = (clp04: string, bpr: string): string =>
  [
    "ISA*00*          *00*          *ZZ*PAYER          *ZZ*CLINIC         *261015*1200*^*00501*000000001*0*P*:",
    "GS*HP*PAYER*CLINIC*20261015*1200*1*X*005010X221A1",
    "ST*835*0001",
    `BPR*I*${bpr}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20261015`,
    "TRN*1*EFT0001*1512345678",
    "N1*PR*SYNTHETIC DENTAL PLAN",
    "N1*PE*SYNTHETIC DENTAL GROUP*XX*1234567893",
    "LX*1",
    `CLP*MRM-000200*1*800.00*${clp04}*300.00*12*PAYERCLAIM1`,
    "CAS*CO*A2*50.00", // a managed-care withhold, taken at the claim level
    "NM1*QC*1*ALPHA*ADA****MI*ABC12345",
    "SVC*AD:D2750*800.00*500.00",
    "DTM*472*20261001",
    "CAS*PR*1*300.00",
    "SE*14*0001",
    "GE*1*1",
    "IEA*1*000000001",
  ].join("~") + "~";

test("a claim-level adjustment beside itemised lines balances: CLP04 = lines − claim-level CAS", () => {
  const parsed = parse835(withClaimLevelAdjustment("450.00", "450.00"));
  assert.equal(parsed.balanced, true, parsed.issues.join(" | "));
  assert.equal(parsed.claims[0]!.unbalanced, false);
});

test("a claim that is still short after the claim-level adjustment is caught, and the message shows the arithmetic", () => {
  const parsed = parse835(withClaimLevelAdjustment("400.00", "400.00"));
  assert.equal(parsed.balanced, false);
  assert.ok(
    parsed.issues.some((i) =>
      /service lines total \$500\.00, less \$50\.00 adjusted at the claim level, is \$450\.00, but CLP reports \$400\.00 paid/.test(i)
    ),
    parsed.issues.join(" | ")
  );
});

test("paying the full lines AND taking a claim-level adjustment is still caught, by the charge identity", () => {
  // CLP04 equal to the line total is accepted for the claim-level-denial shape; here it would mean
  // the payer paid $500 and also withheld $50 from an $800 charge — $850 accounted for.
  const parsed = parse835(withClaimLevelAdjustment("500.00", "500.00"));
  assert.equal(parsed.balanced, false);
  assert.ok(parsed.issues.some((i) => /charged \$800\.00 but paid \+ adjustments = \$850\.00/.test(i)), parsed.issues.join(" | "));
});
