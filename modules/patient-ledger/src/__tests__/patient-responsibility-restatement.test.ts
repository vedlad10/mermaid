/**
 * When a second posting arrives, does the patient's balance move? (L-2)
 *
 * ── THE LIVE DEFECT THIS EXISTS TO STOP ────────────────────────────────────────────────────────
 * A corrected remittance settling a won appeal paid $1,125.00 to the practice and reported
 * `patientResponsibility: 0`, because it re-adjudicated nothing about the patient. The ledger read
 * that as "the payer lowered the share to zero" and wrote:
 *
 *     adjustment  −$136.01   "…reprocessed the claim and lowered patient responsibility to $0.00"
 *
 * A real balance the patient genuinely owed was forgiven automatically, on staging, the first time
 * an appeal ever settled. Nothing caught it: the ledger's rule was correct for every claim that
 * could only ever have one posting, and appeals made second postings normal.
 *
 * ── WHY CLP02 ALONE WAS NOT THE ANSWER ─────────────────────────────────────────────────────────
 * The obvious fix is to gate on the claim status code. It fails: that settlement arrived as an
 * ordinary `partial`, because a payer sending a supplemental cheque has no other status to use. The
 * discriminator is whether the advice says ANYTHING about the patient — a PR-group adjustment or a
 * non-zero patient figure — and Remittance states that on the event as
 * `restatesPatientResponsibility`.
 *
 * Every expected value below is derived from the scenario, not read back from a run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import { InMemoryLedgerRepository, PatientLedgerService } from "../index.ts";
import type { RemittancePostedBody } from "@mermaid/events";

const NOW = new Date("2026-10-02T09:00:00Z");
const silent = createLogger(() => {});

/** The audited claim: the payer paid $21.49 and left the patient $136.01. */
const ORIGINAL_PR = cents(136.01);
const AWARD = cents(1125);

function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryLedgerRepository();
  return { repo, service: new PatientLedgerService(repo, bus) };
}

const posted = (over: Partial<RemittancePostedBody>): RemittancePostedBody =>
  ({
    remittanceId: "rem-1",
    postingId: "post-1",
    claimId: "claim-1",
    patientControlNumber: "MRM-A659B7918AA6",
    postedAt: "2026-08-28T04:40:14.843Z",
    traceNumber: "EFT1",
    payerId: "metlife-dental",
    payerName: "MetLife Dental",
    patientName: "Jack Demo",
    memberId: "DEMO0277",
    paymentDate: "2026-08-28",
    chargedAmount: cents(1425),
    paidAmount: cents(21.49),
    patientResponsibility: ORIGINAL_PR,
    contractualAdjustments: cents(142.5),
    expectedInsurancePays: cents(175),
    variance: cents(-153.51),
    outcome: "underpaid",
    settled: false,
    disposition: "partial",
    restatesPatientResponsibility: true,
    ...over,
  }) as RemittancePostedBody;

const balance = async (s: ReturnType<typeof wired>["service"]) =>
  (await s.statement("DEMO0277", NOW))?.account.balance ?? 0;

// ── A. The original adjudication ──────────────────────────────────────────────────────────────

test("A — the first advice charges the patient what the payer assigned them", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  assert.equal(await balance(service), ORIGINAL_PR, "$136.01");
});

// ── B. The supplemental award payment — the live defect ───────────────────────────────────────

test("B — a settlement that says nothing about the patient does NOT forgive the balance", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({}), NOW);

  await service.chargeFromPosting(
    posted({
      postingId: "post-2",
      remittanceId: "rem-2",
      paidAmount: AWARD,
      patientResponsibility: cents(0),
      contractualAdjustments: cents(125),
      outcome: "as_expected",
      settled: true,
      disposition: "partial",
      restatesPatientResponsibility: false,
    }),
    NOW
  );

  assert.equal(await balance(service), ORIGINAL_PR, "the patient still owes $136.01");
  const entries = await repo.entriesFor("DEMO0277");
  assert.equal(entries.length, 1, "no second ledger entry at all");
  assert.ok(!entries.some((e) => e.amount < 0), "and certainly no credit");
});

// ── C / D. A genuine re-adjudication may still restate it ─────────────────────────────────────

test("D — a replacement that DOES re-adjudicate the patient's share may lower it", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);

  await service.chargeFromPosting(
    posted({
      postingId: "post-3",
      remittanceId: "rem-3",
      patientResponsibility: cents(0),
      disposition: "paid_full",
      restatesPatientResponsibility: true,
    }),
    NOW
  );

  assert.equal(await balance(service), 0, "the payer restated the share, so the ledger follows");
});

test("D — a re-adjudication that RAISES the share still charges the difference", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  await service.chargeFromPosting(
    posted({ postingId: "post-4", patientResponsibility: cents(200), restatesPatientResponsibility: true }),
    NOW
  );
  assert.equal(await balance(service), cents(200), "136.01 + 63.99");
});

// ── C. A reversal does not restate on its own ─────────────────────────────────────────────────

test("C — a reversal is not a restatement, so it does not move the balance by itself", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  await service.chargeFromPosting(
    posted({
      postingId: "post-5",
      disposition: "reversal",
      patientResponsibility: cents(0),
      restatesPatientResponsibility: false,
    }),
    NOW
  );
  assert.equal(await balance(service), ORIGINAL_PR, "the replacement that follows is what speaks");
});

// ── E. Replay ─────────────────────────────────────────────────────────────────────────────────

test("E — replaying the same posting charges nothing twice", async () => {
  const { service, repo } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  await service.chargeFromPosting(posted({}), NOW);
  assert.equal(await balance(service), ORIGINAL_PR, "not $272.02");
  assert.equal((await repo.entriesFor("DEMO0277")).length, 1);
});

// ── F. Multiple postings ──────────────────────────────────────────────────────────────────────

test("F — several silent postings never accumulate credits", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  for (const id of ["post-a", "post-b", "post-c"]) {
    await service.chargeFromPosting(
      posted({ postingId: id, patientResponsibility: cents(0), restatesPatientResponsibility: false }),
      NOW
    );
  }
  assert.equal(await balance(service), ORIGINAL_PR, "still exactly $136.01");
});

// ── G / H. Zero-dollar and partial payments ───────────────────────────────────────────────────

test("G — a zero-dollar advice that assigns the patient everything still charges them", async () => {
  const { service } = wired();
  await service.chargeFromPosting(
    posted({ paidAmount: cents(0), patientResponsibility: cents(1425), disposition: "denied", restatesPatientResponsibility: true }),
    NOW
  );
  assert.equal(await balance(service), cents(1425));
});

test("H — a partial payment restating a smaller share lowers the balance to that figure", async () => {
  const { service } = wired();
  await service.chargeFromPosting(posted({}), NOW);
  await service.chargeFromPosting(
    posted({ postingId: "post-6", patientResponsibility: cents(50), restatesPatientResponsibility: true }),
    NOW
  );
  assert.equal(await balance(service), cents(50), "the payer's latest word, not a sum");
});

// ── The conservative fallback for events written before the field existed ─────────────────────

test("an old event with no restatement flag may raise a balance but never lower one", async () => {
  const { service } = wired();
  const legacy = (over: Partial<RemittancePostedBody>) => {
    const p = posted(over) as unknown as Record<string, unknown>;
    delete p.restatesPatientResponsibility;
    delete p.disposition;
    return p as unknown as RemittancePostedBody;
  };

  await service.chargeFromPosting(legacy({}), NOW);
  assert.equal(await balance(service), ORIGINAL_PR, "the increase still applies, as it always has");

  await service.chargeFromPosting(legacy({ postingId: "post-7", patientResponsibility: cents(0) }), NOW);
  assert.equal(
    await balance(service),
    ORIGINAL_PR,
    "but a decrease is not inferable from a payload that never carried the distinction"
  );
});
