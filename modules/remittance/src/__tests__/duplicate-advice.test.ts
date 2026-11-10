/**
 * The same payment, on the same claim, twice.
 *
 * ── WHAT LIVE STAGING HELD ─────────────────────────────────────────────────────────────────────
 * Claim MRM-BDEDD701FE6B carried THREE advices of $799.99:
 *
 *   EFT227219236  posted  2026-08-28
 *   EFT396527421  held    2026-08-30
 *   EFT860280126  held    2026-08-31
 *
 * The two held ones were held for coordination of benefits, and both told a biller "Review and
 * release". Releasing either would have posted $799.99 a second time against a claim that expected
 * $800.00 — cash the bank never received, and a $799.99 credit on a patient who owes $482.51.
 *
 * ── WHY NO EXISTING GATE COULD SEE IT ──────────────────────────────────────────────────────────
 * Every other check reads one advice in isolation, which is right for all of them: an advice either
 * balances or it does not. A duplicate is the one hazard invisible from inside a single file. The
 * second copy is perfectly well-formed, balances to the cent, and is indistinguishable from the
 * first except that the first already happened.
 *
 * ── WHAT THE FIRST VERSION OF THIS GATE GOT WRONG ──────────────────────────────────────────────
 * It summed every posted payment per claim and compared the incoming amount to that total, and it
 * saw only POSTED advices. Three defects followed, each with its own test below:
 *
 *   1. A sum answers the wrong question. Two prior postings of $400 total $800, so a third $400
 *      duplicate passed (800 !== 400) — while a legitimate $800 payment was blocked for matching
 *      the total by coincidence. Both directions wrong, from one line.
 *   2. Two HELD advices could not see each other. `dedupeKeyFor` keys on payer plus trace number,
 *      so a payer re-sending under a new trace produces two rows that both pass every gate. That is
 *      exactly the staging case above, and the gate would only have caught the third of the three.
 *   3. Amount alone cannot tell a re-send from a correction, and cannot tell either from an appeal
 *      recovery that happens to equal the original payment. It called all of them the same thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, type Cents } from "@mermaid/shared";
import { adjudicationOf, checkRemittanceSafety, type ClaimContext, type PriorPayment } from "../engine/safety.ts";
import type { RemittanceAdvice } from "@mermaid/edi";

const CLAIM = "MRM-BDEDD701FE6B";
const KNOWN = new Set([CLAIM]);
const NOW = new Date("2026-08-31T12:00:00Z");

/** The adjudication both sides of a re-send share: one contractual write-off. */
const WRITE_OFF = [{ category: "contractual", group: "CO", code: "45", amount: cents(142.5), description: "", procedureCode: null }];

/** A different adjudication for the same money — what a corrected advice looks like. */
const RESTATED = [
  { category: "contractual", group: "CO", code: "45", amount: cents(100), description: "", procedureCode: null },
  { category: "patient", group: "PR", code: "2", amount: cents(42.5), description: "", procedureCode: null },
];

const advice = (
  paid: number,
  control = CLAIM,
  adjustments: typeof WRITE_OFF = WRITE_OFF
): RemittanceAdvice =>
  ({
    payerName: "Cigna Dental",
    payerId: "cigna-dental",
    traceNumber: "EFT860280126",
    paymentDate: "2026-08-31",
    paymentMethod: "ACH",
    paymentTotal: cents(paid),
    issues: [],
    providerAdjustments: [],
    claims: [
      {
        patientControlNumber: control,
        payerControlNumber: "556677889",
        patientFirstName: "Kira",
        patientLastName: "Demo",
        charged: cents(1425),
        paid: cents(paid),
        patientResponsibility: cents(0),
        contractualAdjustment: cents(142.5),
        coordinationPending: cents(0),
        unbalanced: false,
        status: "paid",
        lines: [],
        adjustments,
      },
    ],
  }) as unknown as RemittanceAdvice;

const prior = (
  paid: number,
  status: "posted" | "held" = "posted",
  adjustments: typeof WRITE_OFF = WRITE_OFF,
  patientControlNumber = CLAIM,
  traceNumber = "EFT227219236"
): PriorPayment => ({
  patientControlNumber,
  paid: cents(paid),
  status,
  traceNumber,
  adjudication: adjudicationOf(adjustments),
});

const award = (amount: number): Map<string, ClaimContext> =>
  new Map([[CLAIM, { awardOutstanding: cents(amount) as Cents }]]);

const codes = (r: ReturnType<typeof checkRemittanceSafety>) => r.findings.map((f) => f.code);

test("a second advice paying the same amount on the same claim is BLOCKED", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99)]);

  assert.ok(codes(result).includes("duplicate-advice"), codes(result).join(", "));
  assert.equal(result.safeToPost, false, "it must never post on its own");

  const finding = result.findings.find((f) => f.code === "duplicate-advice")!;
  assert.equal(finding.severity, "blocker", "posting invented cash is not a notice");
  assert.match(finding.message, /\$799\.99 has already been posted/);
  assert.match(finding.message, new RegExp(CLAIM));
  assert.match(finding.message, /EFT227219236/, "it names the advice to go and compare against");
  assert.match(finding.remediation, /puts the patient in credit/);
  assert.match(finding.remediation, /refund or a takeback, not a second posting/);
});

test("a legitimate second payment of a DIFFERENT amount passes", () => {
  /**
   * Jack Demo's appeal recovery: $21.49 already posted, then $1,125.00 arrives. Blocking this would
   * refuse money the practice appealed for and won.
   */
  const result = checkRemittanceSafety(advice(1125), KNOWN, NOW, [prior(21.49)]);
  assert.ok(!codes(result).some((c) => c.startsWith("duplicate-advice")), codes(result).join(", "));
});

test("the first advice on a claim is never a duplicate", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, []);
  assert.ok(!codes(result).some((c) => c.startsWith("duplicate-advice")));
});

test("a zero-dollar advice is not a duplicate of a zero-dollar advice", () => {
  /**
   * A claim refused outright pays nothing, and a payer can legitimately send more than one such
   * advice — a denial and then a corrected denial. There is no cash to double-post, so there is
   * nothing to block, and blocking it would stop the corrected file from ever landing.
   */
  const result = checkRemittanceSafety(advice(0), KNOWN, NOW, [prior(0)]);
  assert.ok(!codes(result).some((c) => c.startsWith("duplicate-advice")));
});

test("a duplicate on a DIFFERENT claim does not implicate this one", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [
    prior(799.99, "posted", WRITE_OFF, "MRM-SOMETHINGELSE"),
  ]);
  assert.ok(!codes(result).some((c) => c.startsWith("duplicate-advice")));
});

test("omitting the parameter keeps every existing caller correct", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW);
  assert.ok(!codes(result).some((c) => c.startsWith("duplicate-advice")));
});

/**
 * ── DEFECT 1: A SUM ANSWERS THE WRONG QUESTION ───────────────────────────────────────────────────
 * Both of these passed the summing version, in opposite directions, and both are exactly the case a
 * duplicate gate exists for.
 */
test("a THIRD identical payment is blocked, even though two prior ones sum to something else", () => {
  const result = checkRemittanceSafety(advice(400), KNOWN, NOW, [prior(400), prior(400, "posted", WRITE_OFF, CLAIM, "EFT2")]);
  assert.ok(
    codes(result).includes("duplicate-advice"),
    `two prior $400 postings sum to $800, and comparing against that total let a third $400 through: ${codes(result).join(", ")}`
  );
});

test("a legitimate payment is NOT blocked for matching the SUM of earlier ones", () => {
  const result = checkRemittanceSafety(advice(800), KNOWN, NOW, [prior(400), prior(400, "posted", WRITE_OFF, CLAIM, "EFT2")]);
  assert.ok(
    !codes(result).some((c) => c.startsWith("duplicate-advice")),
    `$800 equals the sum of two $400 postings by coincidence, not because it duplicates either: ${codes(result).join(", ")}`
  );
});

/**
 * ── DEFECT 2: TWO HELD ADVICES COULD NOT SEE EACH OTHER ──────────────────────────────────────────
 * The staging case. Nothing has moved yet, which is precisely why it is worth catching here: this is
 * the last moment before a person is invited to press release on both.
 */
test("an advice matching one that is merely HELD is blocked before anyone can release both", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99, "held", WRITE_OFF, CLAIM, "EFT396527421")]);

  const finding = result.findings.find((f) => f.code === "duplicate-advice-pending");
  assert.ok(finding, `expected a pending-duplicate blocker, got: ${codes(result).join(", ")}`);
  assert.equal(finding.severity, "blocker");
  assert.equal(result.safeToPost, false);
  assert.match(finding.message, /EFT396527421/, "it names the twin so a biller can find it");
  assert.match(finding.message, /Releasing both would post/);
  assert.match(finding.remediation, /Release .*the one that matches the money actually received/s);
});

test("a pending twin is reported ahead of a posted one — it is the reversible half", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [
    prior(799.99, "posted"),
    prior(799.99, "held", WRITE_OFF, CLAIM, "EFT396527421"),
  ]);
  assert.ok(codes(result).includes("duplicate-advice-pending"), codes(result).join(", "));
  assert.ok(
    !codes(result).includes("duplicate-advice"),
    "one finding per claim, naming the situation a person can still act on"
  );
});

/**
 * ── DEFECT 3: AMOUNT ALONE CANNOT TELL A RE-SEND FROM A CORRECTION ───────────────────────────────
 * Both still block, because both would post the money a second time. What changes is what the person
 * is told, and therefore what they do: chasing a payer about a payment they never made wastes a call
 * and ends in confusion.
 */
test("the same money adjudicated DIFFERENTLY reads as a correction, not a second payment", () => {
  const result = checkRemittanceSafety(advice(799.99, CLAIM, RESTATED), KNOWN, NOW, [prior(799.99, "posted", WRITE_OFF)]);

  const finding = result.findings.find((f) => f.code === "duplicate-advice-restated");
  assert.ok(finding, `expected a restatement blocker, got: ${codes(result).join(", ")}`);
  assert.equal(finding.severity, "blocker", "it would still post the amount a second time");
  assert.equal(result.safeToPost, false);
  assert.match(finding.message, /adjudicates it differently/);
  assert.match(finding.message, /corrected adjudication rather than a second payment/);
  assert.match(finding.remediation, /replace the original rather than post on top of it/);

  assert.ok(
    !codes(result).includes("duplicate-advice"),
    "calling this a double payment sends a biller to ask the payer about money nobody claims was sent"
  );
});

test("an identical adjudication is the re-send, and says so", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99)]);
  const finding = result.findings.find((f) => f.code === "duplicate-advice")!;
  assert.match(finding.message, /adjudicated identically/);
});

/**
 * ── THE APPEAL VALVE ─────────────────────────────────────────────────────────────────────────────
 * The case the gate must not block. A payer that agreed $799.99 on appeal will send $799.99, and on
 * a claim already paid $799.99 that is indistinguishable from a re-send by amount — except that the
 * practice was told in writing to expect it.
 */
test("a payment matching an agreed appeal award is the recovery, not a duplicate", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99)], award(799.99));

  assert.equal(result.safeToPost, true, "holding money the payer has already conceded defeats the appeal workflow");
  const finding = result.findings.find((f) => f.code === "duplicate-advice")!;
  assert.equal(finding.severity, "notice", "surfaced, not walled");
  assert.match(finding.message, /agreed to pay on appeal/);
  assert.match(finding.message, /Treated as the recovery, not as a duplicate/);
});

test("an award of a DIFFERENT size does not excuse a duplicate", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99)], award(250));
  const finding = result.findings.find((f) => f.code === "duplicate-advice")!;
  assert.equal(finding.severity, "blocker", "an unrelated award is not evidence about this payment");
});

test("a zero award is no award at all", () => {
  const result = checkRemittanceSafety(advice(799.99), KNOWN, NOW, [prior(799.99)], award(0));
  const finding = result.findings.find((f) => f.code === "duplicate-advice")!;
  assert.equal(finding.severity, "blocker");
});
