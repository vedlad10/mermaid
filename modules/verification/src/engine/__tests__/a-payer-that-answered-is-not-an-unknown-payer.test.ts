/**
 * Two different silences, and the difference is what a coordinator does next.
 *
 * ── THE SCREEN THIS EXISTS FOR (audit C-7) ─────────────────────────────────────────────────────
 * A live 270 went to Aetna through the real adapter for a member ID that is not one of theirs.
 * Aetna answered — properly, in a complete 271, with `AAA*N**72*C`: "Invalid/Missing
 * Subscriber/Insured ID". The payer had been identified at 0.95 confidence, the clearinghouse had
 * routed to `60054`, the round trip took two seconds and everything about it worked.
 *
 * The front desk was shown a critical exception coded `unknown-payer`, reading "Benefits could not
 * be retrieved; verify manually with the payer", under a recommended action reading "Verify manually
 * with Aetna Dental by phone or portal — electronic verification isn't available for this card."
 *
 * Every clause of that is false, and the falsehoods cost real time in opposite directions: somebody
 * telephones a payer that answered instantly, about a card whose member ID is wrong — the one fact
 * the payer volunteered and the product discarded.
 *
 * `detectExceptions` could not have known. It sees `benefits === null` and nothing else, so both the
 * "no route to this payer" case and the "this payer said no" case arrived at it identically. The
 * pipeline knows the difference and now says so.
 *
 * ── WHAT THIS FILE PINS ────────────────────────────────────────────────────────────────────────
 * That the two cases stay two cases: different codes, the payer's own words carried through to the
 * screen, and — the part that matters operationally — two different instructions. Both still block,
 * because neither is a coverage estimate; blocking was never the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "../../pipeline.ts";
import { decideVerification } from "../decision.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import type { EdiAdapter } from "@mermaid/edi";
import { cents, type TreatmentPlanItem } from "@mermaid/shared";
import type { PatientInfo } from "../../types.ts";

const NOW = new Date("2026-09-10T12:00:00Z");
const PROCS: TreatmentPlanItem[] = [{ code: "D0120", quantity: 1 }, { code: "D2750", quantity: 1, fee: cents(1250) }];
const patient: PatientInfo = {
  firstName: "Jordan",
  lastName: "Doe",
  dateOfBirth: "1990-01-01",
  memberId: "AETNA9WCSU",
};

/**
 * A payer that is reachable and refuses, which is the shape the real one has.
 *
 * Built by wrapping the mock rather than by hand, so everything except `checkEligibility` stays the
 * behaviour the rest of the pipeline is written against — the point of the test is one branch, and a
 * bespoke stub would let the other twenty drift.
 */
function refusingAdapter(reason: string): EdiAdapter {
  const mock = new MockEdiAdapter();
  return {
    ...mock,
    checkEligibility: async () => ({
      ok: false as const,
      source: "edi" as const,
      error: { code: "payer_refused", message: reason, retryable: false },
    }),
  } as unknown as EdiAdapter;
}

/** The refusal Aetna actually sent, in the wording Stedi passes through. */
const AETNA_REFUSAL = "Invalid/Missing Subscriber/Insured ID";

test("a payer that answered and refused is not reported as an unknown payer", async () => {
  const record = await runVerification(
    {
      patient,
      cardText: "AETNA DENTAL PPO\nMember: JORDAN DOE\nID: AETNA9WCSU",
      planItems: PROCS,
    },
    refusingAdapter(AETNA_REFUSAL),
    NOW
  );

  assert.equal(record.benefits, null, "a refusal must never produce benefits");
  assert.equal(
    record.exceptions.some((e) => e.code === "unknown-payer"),
    false,
    "the payer was identified and reached — calling it unknown is the defect this file is about"
  );

  const flag = record.exceptions.find((e) => e.code === "benefits-unavailable");
  assert.ok(flag, "a payer that answered without benefits must raise `benefits-unavailable`");
  assert.equal(flag!.severity, "critical", "no benefits is still a hard stop, whatever the reason");

  /**
   * The load-bearing assertion. The payer's own sentence has to survive from the 271, through the
   * adapter, through the pipeline, onto the flag a person reads — because it IS the instruction.
   */
  assert.match(
    flag!.message,
    /Invalid\/Missing Subscriber\/Insured ID/,
    `the payer's reason must reach the screen — got: ${flag!.message}`
  );
});

test("the instruction is to re-read the card, not to telephone a payer that just answered", async () => {
  const record = await runVerification(
    { patient, cardText: "AETNA DENTAL PPO\nID: AETNA9WCSU", planItems: PROCS },
    refusingAdapter(AETNA_REFUSAL),
    NOW
  );

  const decision = decideVerification(record, NOW);

  assert.equal(decision.outcome, "blocked", "nothing here is quotable; it must still stop");
  assert.equal(
    /electronic verification isn't available/i.test(decision.recommendedAction),
    false,
    `electronic verification demonstrably WAS available — got: ${decision.recommendedAction}`
  );
  assert.match(
    decision.recommendedAction,
    /member ID/i,
    `the action must name the field the payer objected to — got: ${decision.recommendedAction}`
  );
});

test("a payer with no route at all is still an unknown payer, with the old instruction", async () => {
  /**
   * The other half of the split, and the reason this is a test rather than an edit. "Obscure Plan
   * Co" is in no registry, so no request is addressed to anybody and there is no payer to have
   * answered — here "ring them" IS the correct instruction, and it must survive unchanged.
   */
  const record = await runVerification(
    { patient, cardText: "Obscure Plan Co\nMember ID: ABC12345", planItems: PROCS },
    new MockEdiAdapter(),
    NOW
  );

  assert.equal(record.benefits, null);
  assert.ok(
    record.exceptions.some((e) => e.code === "unknown-payer"),
    "a payer nothing can address is genuinely unknown"
  );
  assert.equal(
    record.exceptions.some((e) => e.code === "benefits-unavailable"),
    false,
    "nothing answered, so nothing can have answered without benefits"
  );

  const decision = decideVerification(record, NOW);
  assert.equal(decision.outcome, "blocked");
  assert.match(decision.recommendedAction, /Verify manually/);
});
