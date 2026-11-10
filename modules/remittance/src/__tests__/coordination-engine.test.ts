/**
 * The coordination-of-benefits case, as pure rules.
 *
 * Every test here is a sentence an operator could say out loud about a claim, and the rule that has
 * to hold for it. The service and HTTP suites prove the rules are WIRED; this proves they are RIGHT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cents } from "@mermaid/shared";
import {
  assignedOf,
  blockedReasonOf,
  closeSecondaryWork,
  confirmCoverage,
  CoordinationRefusedError,
  crossoverCarrierOf,
  markSecondaryFiled,
  missingForConfirmation,
  recordSignal,
  requestConfirmation,
  signalOf,
  workStatusOf,
  type CoordinationEvidence,
} from "../coordination.ts";

const NOW = new Date("2026-09-24T12:00:00Z");
const c = (n: number) => Math.round(n * 100) as Cents;

const evidence = (over: Partial<CoordinationEvidence> = {}): CoordinationEvidence => ({
  remittanceId: "rem-1",
  traceNumber: "EFT1",
  payerName: "Cigna Dental",
  receivedAt: "2026-08-28T04:40:14.825Z",
  remittanceStatus: "posted",
  forwarded: true,
  assignedCents: c(482.51),
  crossoverCarrier: null,
  ...over,
});

const open = (ev: CoordinationEvidence = evidence()) =>
  recordSignal(null, { patientControlNumber: "MRM-1", claimId: "claim-1", serviceDate: "2026-08-19", evidence: ev }, "case-1", NOW);

function refusedWith(work: () => unknown, code: string): CoordinationRefusedError {
  try {
    work();
  } catch (err) {
    assert.ok(err instanceof CoordinationRefusedError, String(err));
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected refusal ${code}`);
}

// ── Coverage ──────────────────────────────────────────────────────────────────────────────────

test("a new case starts unconfirmed — the payer's signal is a question, not an answer", () => {
  const k = open();
  assert.equal(k.coverageStatus, "unconfirmed");
  assert.equal(k.confirmation, null);
  assert.equal(workStatusOf(k), "awaiting-coverage");
  assert.match(blockedReasonOf(k)!, /Nobody has confirmed/);
});

test("no other coverage, confirmed with a source and a date", () => {
  const k = confirmCoverage(open(), { outcome: "no-other-coverage", source: "payer-portal", confirmedOn: "2026-09-24" }, "biller@clinic", NOW);
  assert.equal(k.coverageStatus, "no-other-coverage");
  assert.equal(k.confirmation?.source, "payer-portal");
  assert.equal(k.confirmation?.confirmedBy, "biller@clinic");
  assert.equal(k.confirmation?.secondary, null);
  assert.equal(workStatusOf(k), "return-to-primary", "money was withheld for a plan that does not exist");
  assert.match(k.history.at(-1)!.message, /No other coverage confirmed\. Source: payer-portal/);
});

test("other coverage exists — and the plan must be recorded to say so", () => {
  const missing = refusedWith(
    () => confirmCoverage(open(), { outcome: "other-coverage", source: "patient", confirmedOn: "2026-09-24" }, "a@clinic", NOW),
    "coverage-evidence-missing"
  ).missing;
  assert.deepEqual(missing, ["The other plan's payer name.", "The patient's member ID on the other plan."]);

  const k = confirmCoverage(
    open(),
    { outcome: "other-coverage", source: "patient", confirmedOn: "2026-09-24", secondary: { payerName: "Delta Dental", memberId: "DD123", payerId: "delta-dental" } },
    "a@clinic",
    NOW
  );
  assert.equal(k.coverageStatus, "other-coverage");
  assert.deepEqual(k.confirmation?.secondary, { payerName: "Delta Dental", payerId: "delta-dental", memberId: "DD123" });
  assert.equal(workStatusOf(k), "ready-to-file");
  assert.equal(blockedReasonOf(k), null);
});

test("missing evidence is reported item by item, all at once", () => {
  const missing = missingForConfirmation({}, NOW);
  assert.equal(missing.length, 3, missing.join(" | "));
  assert.match(missing[0]!, /Whether the patient has another plan/);
  assert.match(missing[1]!, /Where the answer came from/);
  assert.match(missing[2]!, /The date the answer was obtained/);
});

test("a confirmation without a date is refused", () => {
  const err = refusedWith(
    () => confirmCoverage(open(), { outcome: "no-other-coverage", source: "payer-phone" }, "a@clinic", NOW),
    "coverage-evidence-missing"
  );
  assert.deepEqual(err.missing, ["The date the answer was obtained."]);
});

test("a confirmation dated in the future is refused", () => {
  refusedWith(
    () => confirmCoverage(open(), { outcome: "no-other-coverage", source: "payer-phone", confirmedOn: "2026-10-30" }, "a@clinic", NOW),
    "coverage-evidence-missing"
  );
});

test("free text cannot stand in for a structured answer", () => {
  // The exact shape that released three advices on staging: a sentence where an answer belongs.
  const err = refusedWith(
    () =>
      confirmCoverage(open(), { outcome: "Reconciled against the payer's paper EOB", source: "Reconciled", confirmedOn: "2026-09-24" }, "a@clinic", NOW),
    "coverage-evidence-missing"
  );
  assert.equal(err.missing.length, 2);
});

test("“other” as a source has to say what it was", () => {
  const err = refusedWith(
    () => confirmCoverage(open(), { outcome: "no-other-coverage", source: "other", confirmedOn: "2026-09-24" }, "a@clinic", NOW),
    "coverage-evidence-missing"
  );
  assert.match(err.missing[0]!, /“other” needs to say what it was/);
  const k = confirmCoverage(open(), { outcome: "no-other-coverage", source: "other", sourceNote: "Employer HR letter", confirmedOn: "2026-09-24" }, "a@clinic", NOW);
  assert.equal(k.confirmation?.sourceNote, "Employer HR letter");
});

test("a confirmation is never overwritten", () => {
  const k = confirmCoverage(open(), { outcome: "no-other-coverage", source: "patient", confirmedOn: "2026-09-24" }, "a@clinic", NOW);
  refusedWith(
    () => confirmCoverage(k, { outcome: "other-coverage", source: "patient", confirmedOn: "2026-09-24", secondary: { payerName: "X", memberId: "1" } }, "b@clinic", NOW),
    "already-confirmed"
  );
});

test("a request records who was asked and when to follow up — and only while unconfirmed", () => {
  const k = requestConfirmation(open(), { from: "patient", requestedOn: "2026-09-24", followUpBy: "2026-09-30" }, "a@clinic", NOW);
  assert.deepEqual({ ...k.request, recordedAt: "" }, { from: "patient", requestedOn: "2026-09-24", followUpBy: "2026-09-30", requestedBy: "a@clinic", recordedAt: "" });
  assert.equal(k.coverageStatus, "unconfirmed", "asking is not answering");
  refusedWith(() => requestConfirmation(open(), { from: "patient", requestedOn: "2026-09-24", followUpBy: "2026-09-20" }, "a@clinic", NOW), "request-incomplete");
  const done = confirmCoverage(k, { outcome: "no-other-coverage", source: "patient", confirmedOn: "2026-09-24" }, "a@clinic", NOW);
  refusedWith(() => requestConfirmation(done, { from: "patient", requestedOn: "2026-09-24", followUpBy: "2026-09-30" }, "a@clinic", NOW), "already-confirmed");
});

// ── Secondary work ────────────────────────────────────────────────────────────────────────────

test("no money to another plan means no secondary work — R1's shape", () => {
  const k = open(evidence({ assignedCents: 0 as Cents }));
  assert.equal(workStatusOf(k), "not-needed");
  assert.equal(blockedReasonOf(k), null);
});

test("secondary work moves ready-to-file → filed → closed, and nowhere else", () => {
  let k = confirmCoverage(
    open(),
    { outcome: "other-coverage", source: "patient", confirmedOn: "2026-09-24", secondary: { payerName: "Delta Dental", memberId: "DD1" } },
    "a@clinic",
    NOW
  );
  refusedWith(() => closeSecondaryWork(k, { outcome: "secondary-paid", note: "x" }, "a@clinic", NOW), "invalid-transition");
  refusedWith(() => markSecondaryFiled(k, {}, "a@clinic", NOW), "filing-incomplete");
  k = markSecondaryFiled(k, { filedOn: "2026-09-24", reference: "DD-CLM-9" }, "a@clinic", NOW);
  assert.equal(workStatusOf(k), "filed");
  refusedWith(() => markSecondaryFiled(k, { filedOn: "2026-09-24" }, "a@clinic", NOW), "invalid-transition");
  refusedWith(() => closeSecondaryWork(k, { outcome: "primary-reprocessed", note: "x" }, "a@clinic", NOW), "close-incomplete");
  k = closeSecondaryWork(k, { outcome: "secondary-paid", note: "Delta paid $482.51 on its own advice" }, "a@clinic", NOW);
  assert.equal(workStatusOf(k), "closed");
  refusedWith(() => closeSecondaryWork(k, { outcome: "written-off", note: "x" }, "a@clinic", NOW), "invalid-transition");
});

test("nothing can be filed while coverage is unconfirmed", () => {
  const err = refusedWith(() => markSecondaryFiled(open(), { filedOn: "2026-09-24" }, "a@clinic", NOW), "invalid-transition");
  assert.match(err.message, /until other coverage is confirmed/);
});

test("return-to-primary closes only as reprocessed or written off", () => {
  const k = confirmCoverage(open(), { outcome: "no-other-coverage", source: "payer-phone", confirmedOn: "2026-09-24" }, "a@clinic", NOW);
  refusedWith(() => closeSecondaryWork(k, { outcome: "secondary-paid", note: "x" }, "a@clinic", NOW), "close-incomplete");
  const closed = closeSecondaryWork(k, { outcome: "primary-reprocessed", note: "Cigna reprocessed as sole coverage" }, "a@clinic", NOW);
  assert.equal(workStatusOf(closed), "closed");
});

// ── Evidence ──────────────────────────────────────────────────────────────────────────────────

test("recording the same advice twice is one piece of evidence, not two", () => {
  const k = open();
  const again = recordSignal(k, { patientControlNumber: "MRM-1", claimId: "claim-1", serviceDate: "2026-08-19", evidence: evidence() }, "ignored", NOW);
  assert.equal(again, k, "an unchanged re-record returns the case untouched");
  assert.equal(again.evidence.length, 1);
});

test("evidence read back from JSONB, keys reordered, is still the same evidence", () => {
  const k = open();
  // Postgres JSONB does not keep key order; the stored copy comes back sorted differently.
  const roundTripped = { ...k, evidence: k.evidence.map((e) => Object.fromEntries(Object.entries(e).reverse()) as typeof e) };
  const again = recordSignal(roundTripped, { patientControlNumber: "MRM-1", claimId: "claim-1", serviceDate: "2026-08-19", evidence: evidence() }, "ignored", NOW);
  assert.equal(again, roundTripped, "a re-sync after a database round trip changes nothing");
});

test("a rejected duplicate stops counting but stays on the record", () => {
  // The staging shape: the original posted, two copies rejected. The work is the original's $482.51,
  // once — not three times.
  let k = open(evidence({ remittanceId: "orig", traceNumber: "EFT227219236" }));
  for (const [id, trace] of [["dup1", "EFT396527421"], ["dup2", "EFT860280126"]]) {
    k = recordSignal(
      k,
      { patientControlNumber: "MRM-1", claimId: "claim-1", serviceDate: "2026-08-19", evidence: evidence({ remittanceId: id, traceNumber: trace, remittanceStatus: "rejected", receivedAt: "2026-08-31T00:00:00Z" }) },
      "ignored",
      NOW
    );
  }
  assert.equal(k.evidence.length, 3);
  assert.deepEqual(assignedOf(k), { cents: c(482.51), posted: true });
});

test("a person's decision survives any later evidence", () => {
  const confirmed = confirmCoverage(open(), { outcome: "no-other-coverage", source: "patient", confirmedOn: "2026-09-24" }, "a@clinic", NOW);
  const later = recordSignal(
    confirmed,
    { patientControlNumber: "MRM-1", claimId: "claim-1", serviceDate: "2026-08-19", evidence: evidence({ remittanceId: "rem-2", traceNumber: "EFT2" }) },
    "ignored",
    NOW
  );
  assert.equal(later.coverageStatus, "no-other-coverage");
  assert.deepEqual(later.confirmation, confirmed.confirmation);
});

test("the crossover carrier is what the payer sent, or nothing", () => {
  assert.equal(crossoverCarrierOf(open()), null, "absent stays absent");
  const named = open(evidence({ crossoverCarrier: { name: "Delta Dental", idQualifier: "PI", id: "DD01" } }));
  assert.deepEqual(crossoverCarrierOf(named), { name: "Delta Dental", idQualifier: "PI", id: "DD01" });
});

test("a posting carries the signal only when the payer gave one", () => {
  const coordination = { category: "coordination", amount: c(22.01) };
  const contractual = { category: "contractual", amount: c(6.5) };
  assert.equal(signalOf({ disposition: "paid_full", adjustments: [contractual] }), null);
  assert.deepEqual(signalOf({ disposition: "forwarded", adjustments: [contractual] }), { forwarded: true, assignedCents: 0 });
  assert.deepEqual(signalOf({ disposition: "partial", adjustments: [contractual, coordination] }), { forwarded: false, assignedCents: c(22.01) });
  // The variance's own figure wins when present — it is the one every other surface reads.
  assert.deepEqual(
    signalOf({ disposition: "forwarded", adjustments: [coordination], variance: { coordinationAmount: c(482.51) } }),
    { forwarded: true, assignedCents: c(482.51) }
  );
});
