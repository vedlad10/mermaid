/**
 * No two rows on the board may read identically when they are different work.
 *
 * ── WHAT THE BOARD ACTUALLY PRINTED (audit B-7) ────────────────────────────────────────────────
 * Against the real database, four rows in two identical pairs:
 *
 *   $1,425   Quinn Mocktest   MetLife Dental · verification needs a person
 *   $1,425   Quinn Mocktest   MetLife Dental · verification needs a person
 *   $1,125   Cigna Dental     1 claim · money still owed
 *   $1,125   Cigna Dental     1 claim · money still owed
 *
 * Two coverage checks under two DIFFERENT member ids, and two advices for two DIFFERENT claims. A
 * biller reading that cannot tell a duplicate render from duplicate work, and the cheap assumption —
 * "the page repeated itself" — is the one that loses money: clear one, assume the other went with
 * it, and a policy goes unverified or an advice goes unreleased.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `no-queue-item-says-the-same-thing-twice` ─────────────────
 * That file is about redundancy WITHIN a row: a subtitle and an action spending the reader's
 * attention on the same words. This is about collision BETWEEN rows, which is the opposite failure —
 * there each row said too much, here each row says too little to be itself. Both were introduced by
 * the same instinct (keep the row short) and they pull in opposite directions, so they are worth
 * being able to fail independently.
 *
 * ── AND WHY IT ALSO ASSERTS THE QUIET CASE ─────────────────────────────────────────────────────
 * The last test is the one that stops the fix becoming its own defect. Appending a member id to
 * every name would pass a "no duplicates" check trivially and cost six words on every row of a
 * screen whose entire claim is that it can be answered in five seconds. The clause must appear only
 * where there is a twin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTodayQueue } from "../today.ts";
import { buildServices, type Services } from "../wiring.ts";
import { MockEdiAdapter, type RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { cents, type TreatmentPlanItem } from "@mermaid/shared";

const NOW = new Date("2026-08-12T09:00:00.000Z");
const RECEIVED = new Date("2026-08-10T09:00:00.000Z");
const PLAN: TreatmentPlanItem[] = [{ code: "D0120", quantity: 1 }, { code: "D2750", quantity: 1, fee: cents(1250) }];

/**
 * One person, two policies.
 *
 * This is the shape PRODUCT.md is explicit about — "an account keyed by member ID is a POLICY" — and
 * it is not exotic: a patient changes employer mid-year, or is checked once as a dependent and once
 * as a subscriber. Both member ids end `00` so the mock reports coverage terminated and both checks
 * stay on the board needing a person, which is the state that produced the duplicate.
 */
async function twoChecksForOnePerson(): Promise<Services> {
  const services = buildServices({ inMemory: true });
  for (const memberId of ["MET90100", "MET90200"]) {
    await services.verification.create({
      patient: { firstName: "Quinn", lastName: "Twice", dateOfBirth: "1988-03-14", memberId },
      cardText: `MetLife Dental\nMember ID: ${memberId}`,
      planItems: PLAN,
    });
  }
  return services;
}

const submitted = (id: string, serviceDate: string): ClaimSubmittedBody => ({
  claimId: `claim-${id}`,
  verificationId: `ver-${id}`,
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Paid", lastName: "Twice", dateOfBirth: "1990-04-12", memberId: "CIG00077" },
  payerId: "cigna-dental",
  payerName: "Cigna Dental",
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: `PC-${id}`,
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate,
});

const remitClaim = (id: string): RemittanceRequestClaim => ({
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: `PC-${id}`,
  patientFirstName: "Paid",
  patientLastName: "Twice",
  memberId: "CIG00077",
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/** One payer, two separate advices, each against its own claim — the second pair from the board. */
async function twoAdvicesFromOnePayer(): Promise<Services> {
  const services = buildServices({ inMemory: true });
  for (const [id, serviceDate] of [["A1", "2026-07-20"], ["A2", "2026-07-27"]] as const) {
    await services.remittance.recordExpectation(submitted(id, serviceDate));
    const fetched = await new MockEdiAdapter().fetchRemittance({
      payerId: "cigna-dental",
      payerName: "Cigna Dental",
      payeeName: "MERMAID DEMO DENTAL",
      paymentDate: "2026-08-10",
      claims: [remitClaim(id)],
    });
    await services.remittance.ingestArtifact(
      fetched.raw!,
      { resolution: "source-credential", vendor: "mock", artifactId: `f-${id}`, expectedPayeeId: null },
      RECEIVED
    );
  }
  return services;
}

/**
 * Every row as the reader sees it — including the distinguisher, composed the way the client does.
 *
 * The distinguisher travels STRUCTURED rather than folded into the subtitle, because a coverage
 * check's is a member id and `today.js` has to mask it under presentation mode. So the assembly that
 * happens on screen is repeated here; a test that compared subtitles alone would pass while the
 * rendered rows were still identical.
 */
const shown = (d: { memberId: string } | { text: string } | null | undefined): string =>
  !d ? "" : "memberId" in d ? ` · member ${d.memberId}` : ` · ${d.text}`;

const asRead = (
  items: { kind: string; title: string; subtitle: string; distinguisher?: { memberId: string } | { text: string } | null }[]
): string[] => items.map((i) => `${i.kind} | ${i.title} | ${i.subtitle}${shown(i.distinguisher)}`);

function duplicatesIn(rows: string[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([row, n]) => `${n}× ${row}`);
}

test("two coverage checks for one person under two policies are not one row printed twice", async () => {
  const today = await buildTodayQueue(await twoChecksForOnePerson(), 50, NOW, { role: "owner" });
  const checks = today.items.filter((i) => i.kind === "verification");
  assert.equal(checks.length, 2, "the fixture must produce exactly the two rows that collided");

  assert.deepEqual(
    duplicatesIn(asRead(checks)),
    [],
    "two different policies rendered as the same row — this is the defect verbatim"
  );

  /**
   * And the clause has to be the one that ANSWERS the reader's question. "2 of 2" would remove the
   * duplicate without telling anybody which policy they are looking at, which is not a fix.
   */
  for (const memberId of ["MET90100", "MET90200"]) {
    assert.ok(
      checks.some((c) => c.distinguisher && "memberId" in c.distinguisher && c.distinguisher.memberId === memberId),
      `no row names policy ${memberId} — got: ${asRead(checks).join(" / ")}`
    );
  }
});

test("two advices from one payer are not one row printed twice", async () => {
  const today = await buildTodayQueue(await twoAdvicesFromOnePayer(), 50, NOW, { role: "owner" });
  const advices = today.items.filter((i) => i.kind === "remittance");
  assert.ok(advices.length >= 2, "the fixture produced fewer than two advices, so this is vacuous");

  assert.deepEqual(
    duplicatesIn(asRead(advices)),
    [],
    "two advices for two claims rendered as the same row — releasing one and assuming the other " +
      "went with it is how one payment gets posted twice"
  );
});

test("a row with no twin says nothing extra", async () => {
  /**
   * The restraint half. One check, one row, and the subtitle stays the sentence it was — because the
   * cost of the fix is a line of text on a screen budgeted in seconds, and it is only worth paying
   * where the reader would otherwise be confused.
   */
  const services = buildServices({ inMemory: true });
  await services.verification.create({
    patient: { firstName: "Solo", lastName: "Check", dateOfBirth: "1988-03-14", memberId: "MET90100" },
    cardText: "MetLife Dental\nMember ID: MET90100",
    planItems: PLAN,
  });

  const today = await buildTodayQueue(services, 50, NOW, { role: "owner" });
  const checks = today.items.filter((i) => i.kind === "verification");
  assert.equal(checks.length, 1, "the fixture must produce exactly one row");
  assert.ok(
    !checks[0]!.distinguisher,
    `an unambiguous row must not carry a disambiguator — got: ${JSON.stringify(checks[0]!.distinguisher)}`
  );
  assert.equal(
    checks[0]!.subtitle.includes("MET90100"),
    false,
    "and it must certainly not be in the subtitle, where nothing masks it"
  );
});
