import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "../../pipeline.ts";
import { decideVerification } from "../decision.ts";
import { plainEnglishEstimate } from "../summary.ts";
import { buildCoverageSnapshot } from "../snapshot.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import { addCents, benefitCategoryOf, cents, UNCATEGORIZED, ZERO, type TreatmentPlanItem } from "@mermaid/shared";
import { calculateCoverage } from "../estimate.ts";
import type { PatientInfo } from "../../types.ts";

const adapter = new MockEdiAdapter();
const NOW = new Date("2026-07-15T12:00:00Z");
const patient = (o: Partial<PatientInfo> = {}): PatientInfo => ({
  firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: "ABC12345", ...o,
});
const PROCS: TreatmentPlanItem[] = [
  { code: "D0120", quantity: 1 }, // diagnostic 100%
  { code: "D2391", quantity: 1, fee: cents(210) }, // basic 80%
];

test("clean active case → verified, estimate reconciles, report renders, decision complete", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100", planItems: PROCS },
    adapter,
    NOW
  );
  assert.equal(rec.status, "verified");
  assert.ok(rec.benefits && rec.calculation);
  assert.equal(addCents(rec.calculation!.totalInsurancePays, rec.calculation!.totalPatientPays), rec.calculation!.totalFee);
  assert.ok(rec.raw271?.includes("271"));
  assert.match(rec.reportText, /TREATMENT PLAN ESTIMATE/);
  assert.match(rec.reportText, /ESTIMATED PATIENT OWES/);

  const decision = decideVerification(rec, NOW);
  assert.equal(decision.outcome, "complete");
  assert.equal(decision.completedBy, "ai");
  assert.equal(decision.canNotifyPatient, true);

  const summary = plainEnglishEstimate(rec);
  assert.ok(summary.length > 0 && summary[0]!.includes("Delta Dental"));
});

/**
 * ── "TODAY" IS THE CLINIC'S DAY, NOT UTC's ─────────────────────────────────────────────────────
 * The coverage-window check compares the payer's stated dates to the day of service, and the day
 * of service is a calendar day in the room where the patient sits. Derived from the UTC clock, a
 * US Pacific practice's evening visits read as TOMORROW: a plan whose termination date is today —
 * still in force for hours — was flagged `coverage-terminated` and sent to review with a message
 * claiming the payer's policy had ended before treatment. East of UTC the error inverts, and a
 * genuinely ended plan reads as covered.
 */
test("a plan ending today is still in force during the clinic's evening", async () => {
  const base = new MockEdiAdapter();
  const windowed = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async checkEligibility(req: Parameters<MockEdiAdapter["checkEligibility"]>[0]) {
      const result = await base.checkEligibility(req);
      if (!result.ok || !result.data) return result;
      return {
        ...result,
        data: {
          ...result.data,
          benefits: {
            ...result.data.benefits,
            coverage: { effectiveDate: "2026-01-01", terminationDate: "2026-07-15" },
          },
        },
      };
    },
  }) as MockEdiAdapter;

  // 02:00Z on July 16 is 7pm PDT on July 15 — the plan's last covered day, with hours left in it.
  const eveningOfLastCoveredDay = new Date("2026-07-16T02:00:00Z");
  const input = { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100", planItems: PROCS };

  const inLosAngeles = await runVerification(
    input, windowed, eveningOfLastCoveredDay, undefined, undefined, undefined, "America/Los_Angeles"
  );
  assert.ok(
    !inLosAngeles.exceptions.some((e) => e.code === "coverage-terminated"),
    "the patient in the chair is still covered; claiming the payer's policy ended is a statement nobody made"
  );

  // And the check itself still works: one day later the plan HAS ended, in any zone.
  const nextEvening = await runVerification(
    input, windowed, new Date("2026-07-17T02:00:00Z"), undefined, undefined, undefined, "America/Los_Angeles"
  );
  assert.ok(
    nextEvening.exceptions.some((e) => e.code === "coverage-terminated"),
    "a plan that genuinely ended must still be caught"
  );
});

test("inactive coverage → needs_review, escalates, and the patient owes the full fee", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );
  assert.equal(rec.status, "needs_review");
  assert.ok(rec.exceptions.some((e) => e.code === "inactive-coverage"));
  assert.equal(rec.calculation!.totalInsurancePays, 0);

  const decision = decideVerification(rec, NOW);
  assert.equal(decision.outcome, "needs_human");
  assert.equal(decision.escalate, true);
  assert.equal(decision.canNotifyPatient, false);
  assert.match(decision.recommendedAction, /coverage as not active/);
});

test("unknown payer → blocked, benefits unavailable, manual-verification action", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Obscure Plan Co\nMember ID: ABC12345", planItems: PROCS },
    adapter,
    NOW
  );
  assert.equal(rec.benefits, null);
  assert.ok(rec.exceptions.some((e) => e.code === "unknown-payer"));
  const decision = decideVerification(rec, NOW);
  assert.equal(decision.outcome, "blocked");
  assert.match(decision.recommendedAction, /Verify manually/);
});

test("member-ID mismatch between card and intake is surfaced as a warning", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "XYZ99999" }), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapter,
    NOW
  );
  assert.ok(rec.exceptions.some((e) => e.code === "member-id-mismatch"));
});

test("waiting-period member: major service denied with a waiting-period flag", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "MEM10066" }), cardText: "Delta Dental\nMember ID: MEM10066", planItems: [{ code: "D2740", quantity: 1, fee: cents(1200) }] },
    adapter,
    NOW
  );
  assert.ok(rec.calculation!.lines[0]!.denied);
  assert.ok(rec.exceptions.some((e) => e.code === "waiting-period"));
});

// ── M10 — did the payer answer about the person we asked about? ───────────────────────────────
//
// Nothing ever checked. A 271 echoes the subscriber it resolved; Mermaid parsed the member ID, used
// it for nothing, and threw the date of birth away entirely (DMG was in the parser's ignore list).
//
// A member ID that is wrong in a way that STILL RESOLVES — a transposed digit belonging to somebody
// else, an AI misreading of a card — returns a perfectly healthy 271 for the wrong person: their
// deductible, their remaining maximum, their plan. Every number in it is internally consistent, so
// nothing else in the verification can tell. The patient in the chair is quoted from it and the
// claim is filed under it.

/** The mock, with the payer's echoed identity overridden — the only way to forge a mismatch. */
function adapterEchoing(subscriber: { memberId: string | null; dateOfBirth: string | null }) {
  const base = new MockEdiAdapter();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async checkEligibility(req: Parameters<MockEdiAdapter["checkEligibility"]>[0]) {
      const result = await base.checkEligibility(req);
      if (!result.ok || !result.data) return result;
      return { ...result, data: { ...result.data, subscriber } };
    },
  }) as MockEdiAdapter;
}

test("M10: a payer answering about a DIFFERENT member ID is critical, not a silent success", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "ABC12345" }), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterEchoing({ memberId: "ZZZ99999", dateOfBirth: null }),
    NOW
  );

  const flag = rec.exceptions.find((e) => e.code === "subscriber-mismatch");
  assert.ok(flag, "benefits for the wrong person must not pass silently");
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /ZZZ99999/);
  assert.match(flag!.message, /ABC12345/);
  assert.equal(rec.status, "needs_review", "and it must reach a human before anyone is quoted");
});

test("M10: a payer whose record has a different DATE OF BIRTH is critical too", async () => {
  const rec = await runVerification(
    { patient: patient({ dateOfBirth: "1990-01-01" }), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterEchoing({ memberId: "ABC12345", dateOfBirth: "1974-06-30" }),
    NOW
  );

  const flag = rec.exceptions.find((e) => e.code === "subscriber-mismatch");
  assert.ok(flag, "the identifier resolving to someone else's record must be visible");
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /1974-06-30/);
  assert.equal(rec.status, "needs_review");
});

test("M10: the mock's own 271 echoes the subscriber, so the check runs on real parsed input", async () => {
  /**
   * The V6 lesson applied: a nullable field that is ALWAYS null is invisible, so at least one test
   * must prove a real value comes out of raw X12. `build271` emits `NM1*IL` and `DMG*D8`, the parser
   * reads both, and a matching pair must produce NO mismatch — which is only meaningful because the
   * two tests above prove a non-matching pair does.
   */
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapter,
    NOW
  );

  assert.ok(rec.raw271?.includes("DMG*D8*19900101"), "the payer's echo is really on the wire");
  assert.ok(
    !rec.exceptions.some((e) => e.code === "subscriber-mismatch"),
    "a payer answering about the right person must not be flagged"
  );
  assert.equal(rec.status, "verified");
});

test("M10: hyphens and case in a member ID are not a mismatch", async () => {
  // A flag that fires on `ABC-123` versus `abc123` is a flag staff learn to ignore, and an ignored
  // critical flag is worse than none.
  const rec = await runVerification(
    { patient: patient({ memberId: "ABC12345" }), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterEchoing({ memberId: "abc-12345", dateOfBirth: null }),
    NOW
  );
  assert.ok(!rec.exceptions.some((e) => e.code === "subscriber-mismatch"));
});

test("M10: a payer that echoed NOTHING is not a mismatch — silence never is", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterEchoing({ memberId: null, dateOfBirth: null }),
    NOW
  );
  assert.ok(!rec.exceptions.some((e) => e.code === "subscriber-mismatch"));
  assert.equal(rec.status, "verified");
});

// ── D3 — a payer that said NOTHING about eligibility is not a payer that said NO ───────────────
//
// M18 made this split for the coordinator, in `analysis.ts`: `inactive` raises `inactive-coverage`
// ("The payer reports this member's coverage as NOT ACTIVE"), while anything else raises
// `eligibility-unknown` ("this is an UNKNOWN, not a refusal"). The sibling site one file over kept
// the original `!== "active"` test, so `plainEnglishEstimate` — the sentence a coordinator reads to
// a PATIENT — still said "reports this member's coverage as not active" for a payer who reported
// nothing, and moved the entire treatment fee onto the patient on the strength of it.
//
// `parse271` initialises `eligibility` to "unknown" and only overwrites it on an EB*1 or EB*6
// segment, so a 271 that quotes benefits without ever stating eligibility lands here. That is a real
// 271: benefit segments are frequently returned by payers whose eligibility statement is missing.

/** A payer that quotes benefits but never states whether the policy is live. */
function adapterSilentOnEligibility() {
  const base = new MockEdiAdapter();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async checkEligibility(req: Parameters<MockEdiAdapter["checkEligibility"]>[0]) {
      const result = await base.checkEligibility(req);
      if (!result.ok || !result.data) return result;
      return {
        ...result,
        data: {
          ...result.data,
          eligibility: "unknown" as const,
          benefits: { ...result.data.benefits, eligibility: "unknown" as const },
        },
      };
    },
  }) as MockEdiAdapter;
}

test("D3: an UNKNOWN eligibility is not read to the patient as a refusal", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );

  assert.equal(rec.benefits!.eligibility, "unknown");
  const prose = plainEnglishEstimate(rec).join(" ");

  assert.match(prose, /did not confirm whether this member's coverage is currently active/);
  assert.match(prose, /Please contact Delta Dental directly to verify coverage before proceeding/);
  assert.doesNotMatch(prose, /reports this member's coverage as not active/);
  assert.doesNotMatch(prose, /the patient's responsibility/, "no fee may be attributed on a silence");
});

test("D3: an INACTIVE eligibility still says exactly what it said before", async () => {
  // The payer really did state this one, so stating it back is correct. Unchanged wording.
  const rec = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );

  assert.equal(rec.benefits!.eligibility, "inactive");
  const prose = plainEnglishEstimate(rec).join(" ");

  assert.match(prose, /Delta Dental reports this member's coverage as not active/);
  assert.match(prose, /treatment fee is the patient's responsibility/);
  assert.doesNotMatch(prose, /did not confirm whether/);
});

test("D3: the two patient sentences are different sentences, on identical treatment plans", async () => {
  const unknown = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );
  const inactive = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );

  assert.notEqual(
    plainEnglishEstimate(unknown).join(" "),
    plainEnglishEstimate(inactive).join(" "),
    "a silence and a refusal must not read the same to the person being quoted"
  );
});

test("D3: the biller-facing message (M18) stays correct, and distinct from both patient sentences", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );

  const flag = rec.exceptions.find((e) => e.code === "eligibility-unknown");
  assert.ok(flag, "M18's split must still raise the unknown code, not inactive-coverage");
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /UNKNOWN, not a refusal/);
  assert.ok(
    !rec.exceptions.some((e) => e.code === "inactive-coverage"),
    "an unknown must never be recorded as an inactive-coverage exception"
  );

  // Three audiences, three sentences: the coordinator's flag, the patient's sentence, and the
  // decision's recommended action. None of them may be the other's wording.
  const patientProse = plainEnglishEstimate(rec).join(" ");
  assert.notEqual(flag!.message, patientProse);
  assert.doesNotMatch(patientProse, /UNKNOWN, not a refusal/, "the patient gets plain language");
  assert.doesNotMatch(flag!.message, /Please contact/, "the biller gets the operational instruction");
});

// ── D3 site 1 — the distinction has to survive into the claim, not just onto the screen ────────
//
// `plainEnglishEstimate` was the sentence a patient hears. This is the record a claim inherits: the
// engine wrote `denialReason: "coverage-inactive"` on every line of an unknown-eligibility estimate,
// and `buildCoverageSnapshot` deep-clones the calculation verbatim, so the misattribution outlived
// verification entirely and arrived at the claims scrubber as a settled fact.

test("D3: an unknown eligibility records its own denial reason on every line", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );

  assert.equal(rec.benefits!.eligibility, "unknown");
  const lines = rec.calculation!.lines;
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.equal(line.denied, true, "still quoted to the patient — nothing is promised");
    assert.equal(line.denialReason, "eligibility-unknown");
    assert.notEqual(line.denialReason, "coverage-inactive", "the payer refused nothing");
    assert.match(line.notes.join(" "), /did not state whether this member's coverage is active/);
  }
});

test("D3: a confirmed inactive coverage still records coverage-inactive, unchanged", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );

  assert.equal(rec.benefits!.eligibility, "inactive");
  for (const line of rec.calculation!.lines) {
    assert.equal(line.denialReason, "coverage-inactive");
    assert.match(line.notes.join(" "), /Coverage is not active/);
  }
});

test("D3: the coverage snapshot a claim inherits carries the distinction", async () => {
  /**
   * The snapshot is the immutable document the claim is built from and reconciled against. If the
   * reason is lost here, every downstream consumer — the scrubber included — is reading a refusal
   * that never happened, and no later fix can recover the fact from the record.
   */
  const unknown = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );
  const inactive = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );

  const unknownSnap = buildCoverageSnapshot(unknown)!;
  const inactiveSnap = buildCoverageSnapshot(inactive)!;

  assert.equal(unknownSnap.benefits.eligibility, "unknown");
  assert.equal(unknownSnap.calculation.lines[0]!.denialReason, "eligibility-unknown");
  assert.equal(inactiveSnap.benefits.eligibility, "inactive");
  assert.equal(inactiveSnap.calculation.lines[0]!.denialReason, "coverage-inactive");
  assert.notEqual(
    unknownSnap.calculation.lines[0]!.denialReason,
    inactiveSnap.calculation.lines[0]!.denialReason,
    "the claims scrubber must be able to tell these apart from the snapshot alone"
  );
});

// ── D3 site 2 — the critical flag that reached no recommended action ───────────────────────────
//
// `recommendAction` branches on exception codes in severity order. M18 gave the unknown state its
// own code; nothing ever read it. So the record's ONLY critical flag fell past every warning-level
// branch to the default — "Double-check the low-confidence fields, then approve or re-verify" —
// and the one instruction that matters, ring the payer, never reached the coordinator.

const UNKNOWN_ELIGIBILITY_ACTION =
  "Confirm directly with the payer before quoting the patient or filing — the payer did not " +
  "state whether this member's coverage is active.";

test("D3: an unknown eligibility tells the coordinator to ring the payer", async () => {
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );
  const decision = decideVerification(rec, NOW);

  assert.equal(decision.outcome, "needs_human");
  assert.equal(decision.recommendedAction, UNKNOWN_ELIGIBILITY_ACTION);
  assert.doesNotMatch(
    decision.recommendedAction,
    /Double-check the low-confidence fields/,
    "a critical flag must not be answered with the generic low-confidence default"
  );
  assert.doesNotMatch(decision.recommendedAction, /reports this coverage as not active/);
});

test("D3: a confirmed inactive coverage keeps its own action, unchanged", async () => {
  const rec = await runVerification(
    { patient: patient({ memberId: "MEM10000" }), cardText: "Delta Dental\nMember ID: MEM10000", planItems: PROCS },
    adapter,
    NOW
  );
  const decision = decideVerification(rec, NOW);

  assert.equal(
    decision.recommendedAction,
    "Contact the patient before the visit — the payer reports this coverage as not active."
  );
  assert.doesNotMatch(decision.recommendedAction, /Confirm directly with the payer/);
});

test("D3: the same fact reads the same way to all three audiences, in three registers", async () => {
  /**
   * The coordinator's flag (M18), the patient's sentence (D3), and now the recommended action all
   * describe one silence. None of them may be another's wording, and none may call it a refusal.
   */
  const rec = await runVerification(
    { patient: patient(), cardText: "Delta Dental\nMember ID: ABC12345", planItems: PROCS },
    adapterSilentOnEligibility(),
    NOW
  );

  const flag = rec.exceptions.find((e) => e.code === "eligibility-unknown")!.message;
  const action = decideVerification(rec, NOW).recommendedAction;
  const patientProse = plainEnglishEstimate(rec).join(" ");

  assert.equal(new Set([flag, action, patientProse]).size, 3, "three audiences, three sentences");
  for (const text of [flag, action, patientProse]) {
    assert.doesNotMatch(text, /not active,|as not active/, "none of them may report a refusal");
  }
  assert.match(action, /Confirm directly with the payer/, "the coordinator gets an instruction");
  assert.match(patientProse, /Please contact/, "the patient gets plain language");
  assert.match(flag, /UNKNOWN, not a refusal/, "the flag names the distinction itself");
});

// ── D2 — a benefit the plan DOES cover, just not yet or not again ──────────────────────────────
//
// A waiting period and a spent frequency allowance were counted into the same sentence as a genuine
// exclusion: "N procedures the plan doesn't cover". That is a statement about the PLAN and it is
// false — the benefit exists. A patient declines a crown they could have had in eight months, or a
// cleaning they could have rebooked into the next benefit period, on the strength of it.
//
// The figures come from `denialDetail`, set at the same `denied()` call sites as the reason, never
// parsed back out of the note.

test("D2: a waiting period is described as a waiting period, with the months that remain", async () => {
  /**
   * The mock's `...77` member carries a 12-month major waiting period effective on the FIRST of
   * the month four months back — 2026-03-01 against a 2026-07-15 verification, which is four whole
   * months and fourteen days.
   *
   * ── THIS TEST PINNED THE DEFECT, AND NOW PINS THE FIX ────────────────────────────────────────
   * It asserted 5 elapsed months and "7 more to go". `monthsBetween` subtracted month NUMBERS and
   * ignored the day entirely, so it counted every partial month as a whole one. That over-states
   * how much of a waiting period has passed, which is the direction that promises coverage: a
   * 12-month period beginning 2026-01-31 read as satisfied on 2027-01-01, the crown was quoted with
   * insurance paying half, and the payer denied it.
   */
  const rec = await runVerification(
    {
      patient: patient({ memberId: "MEM10066" }),
      cardText: "Delta Dental\nMember ID: MEM10066",
      planItems: [{ code: "D2750", quantity: 1, fee: cents(1250) }],
    },
    adapter,
    NOW
  );

  const line = rec.calculation!.lines[0]!;
  assert.equal(line.denialReason, "waiting-period");
  assert.deepEqual(line.denialDetail, { kind: "waiting-period", monthsRequired: 12, monthsElapsed: 4 });

  const prose = plainEnglishEstimate(rec).join(" ");
  assert.match(prose, /waiting period that hasn't fully elapsed yet/);
  assert.match(prose, /coverage should begin once 8 more month\(s\) have passed/);
  assert.match(prose, /in a waiting period/, "and it is named in the driver list, not lumped in");
  assert.doesNotMatch(prose, /the plan doesn't cover/, "the plan does cover this — just not yet");
});

test("D2: a spent frequency allowance says what was used, and never when it resets", async () => {
  // The mock's ABC12345 profile has already used its single annual bitewing set.
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [{ code: "D0274", quantity: 1, fee: cents(85) }],
    },
    adapter,
    NOW
  );

  const line = rec.calculation!.lines[0]!;
  assert.equal(line.denialReason, "frequency-limit");
  assert.deepEqual(line.denialDetail, {
    kind: "frequency-limit",
    used: 1,
    limit: 1,
    description: "Bitewing X-rays limited to 1 set per calendar year.",
  });

  const prose = plainEnglishEstimate(rec).join(" ");
  assert.match(prose, /This plan covers Bitewing X-rays limited to 1 set per calendar year\./);
  assert.match(prose, /you've already used the allowed number of visits \(1 of 1\) for this benefit period/);
  assert.match(prose, /over the plan's frequency limit/);
  assert.doesNotMatch(prose, /the plan doesn't cover/);
});

test("D2: the frequency sentence never claims a reset date, a period name, or renewal timing", async () => {
  /**
   * `FrequencyLimit` carries `period` as a LABEL — "calendar-year", "12-months", "36-months" — with
   * no anchor date, so when the allowance next resets is not knowable from this model. A patient
   * told "it renews in January" rebooks against a date nobody has.
   */
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [{ code: "D0274", quantity: 1, fee: cents(85) }],
    },
    adapter,
    NOW
  );

  const sentence = plainEnglishEstimate(rec).find((s) => s.includes("already used the allowed number"))!;
  assert.ok(sentence);
  for (const forbidden of [
    /calendar-year/,
    /12-months/,
    /36-months/,
    /renew/i,
    /reset/i,
    /next year/i,
    /januar/i,
    /\b20\d\d\b/,
    /\d{4}-\d{2}-\d{2}/,
  ]) {
    assert.doesNotMatch(sentence, forbidden, `the sentence must not imply timing: ${forbidden}`);
  }
});

test("D2: a genuine exclusion is still 'the plan doesn't cover', unchanged", async () => {
  // D8080 is on the mock's excluded-codes list — the payer named it. Saying so is correct.
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [{ code: "D8080", quantity: 1, fee: cents(4500) }],
    },
    adapter,
    NOW
  );

  const line = rec.calculation!.lines[0]!;
  assert.equal(line.denialReason, "excluded");
  assert.equal(line.denialDetail, undefined, "an exclusion has no figures to quantify");

  const prose = plainEnglishEstimate(rec).join(" ");
  assert.match(prose, /the plan doesn't cover/);
  assert.doesNotMatch(prose, /waiting period/);
  assert.doesNotMatch(prose, /already used the allowed number/);
});

test("D2: the four denial families are counted separately, in one estimate", async () => {
  /**
   * The whole point of the split, in one sentence a coordinator would actually read aloud: an
   * exclusion, a waiting period, a spent allowance and an unstated category are four different
   * facts about the plan, and only the first may be reported as "doesn't cover".
   */
  const rec = await runVerification(
    {
      patient: patient({ memberId: "MEM10066" }),
      cardText: "Delta Dental\nMember ID: MEM10066",
      planItems: [
        { code: "D8080", quantity: 1, fee: cents(4500) }, // excluded outright
        { code: "D2750", quantity: 1, fee: cents(1250) }, // major — inside the waiting period
        { code: "D1110", quantity: 1, fee: cents(110) }, // preventive — covered
      ],
    },
    adapter,
    NOW
  );

  const reasons = rec.calculation!.lines.filter((l) => l.denied).map((l) => l.denialReason);
  assert.ok(reasons.includes("excluded"));
  assert.ok(reasons.includes("waiting-period"));

  const prose = plainEnglishEstimate(rec).join(" ");
  assert.match(prose, /1 procedure the plan doesn't cover \(/, "only the exclusion is counted there");
  assert.match(prose, /1 procedure in a waiting period/);
  // 8, not 7 — see the elapsed-months note on the D2 waiting-period test above. Partial months are
  // no longer counted as whole ones, so 4 of the 12 have elapsed rather than 5.
  assert.match(prose, /coverage should begin once 8 more month\(s\) have passed/);
});

// ── D5 — Mermaid's own gap is not the payer's refusal ──────────────────────────────────────────
//
// A CDT code missing from the 24-entry catalog was denied with NO reason at all. It fell off the end
// of `analysis.ts`'s classifier to `exclusion`, and `summary.ts` counted it as a procedure "the plan
// doesn't cover" — a statement about a plan that was never asked about the code. The same collapse
// as B2/D2/D3, one step further from the evidence: the ignorance here is ours, not the payer's.
//
// The catalog is small, so this is the ordinary case for most of the CDT set, not an edge one.

test("D5: an uncatalogued code is recorded as unrecognized, not as an exclusion", async () => {
  // D6058 is a real CDT code (abutment-supported porcelain crown) that Mermaid's catalog lacks.
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [
        { code: "D6058", quantity: 1, fee: cents(1450) },
        { code: "D1110", quantity: 1, fee: cents(110) },
      ],
    },
    adapter,
    NOW
  );

  const line = rec.calculation!.lines.find((l) => l.code === "D6058")!;
  assert.equal(line.denialReason, "procedure-unrecognized");
  assert.notEqual(line.denialReason, "excluded", "the payer named nothing");

  // The conservative default is confirmed behaviour and must not drift.
  assert.equal(line.denied, true);
  assert.equal(line.patientPays, cents(1450), "the full fee stays the patient's");
  assert.equal(line.insurancePays, 0);
});

test("D5: the patient is told we couldn't find the code, not that the plan refused it", async () => {
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [
        { code: "D6058", quantity: 1, fee: cents(1450) },
        { code: "D1110", quantity: 1, fee: cents(110) },
      ],
    },
    adapter,
    NOW
  );
  const prose = plainEnglishEstimate(rec).join(" ");

  assert.match(
    prose,
    /We couldn't find D6058 in our procedure list, so we don't yet know how your plan covers it\./
  );
  assert.match(
    prose,
    /We're treating it as the patient's full responsibility for now — please check with our office or the payer to confirm\./
  );
  // The short driver clause and the full sentence are pinned separately and worded differently: the
  // list item said the same thing as the sentence beneath it, in almost the same words.
  assert.match(prose, /1 procedure we don't have on file \(D6058\)/);
  assert.doesNotMatch(
    prose,
    /procedure we couldn't find in our procedure list \(/,
    "the driver clause must not restate the sentence that follows it"
  );
  assert.doesNotMatch(prose, /the plan doesn't cover/, "nothing was asked of the plan about this code");
});

test("D5: the coordinator's note is unchanged — it was already accurate", async () => {
  /**
   * The note always said the true thing; only the CODE it was filed under was wrong. Nothing about
   * the biller-facing message changes, so a coordinator reading the screen sees exactly what they
   * saw before, under a classification that no longer contradicts it.
   */
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [{ code: "D6058", quantity: 1, fee: cents(1450) }],
    },
    adapter,
    NOW
  );

  const line = rec.calculation!.lines[0]!;
  assert.deepEqual(line.notes, ['CDT code "D6058" is not in the catalog; treated as not covered.']);

  const flag = rec.exceptions.find((e) => e.message.includes("D6058"))!;
  assert.ok(flag, "the line is still flagged for a human");
  assert.equal(flag.severity, "warning");
  assert.equal(flag.code, "procedure-unrecognized");
  assert.equal(
    flag.message,
    'D6058 (Unrecognized procedure code): CDT code "D6058" is not in the catalog; treated as not covered.'
  );
  assert.ok(
    !rec.exceptions.some((e) => e.code === "exclusion"),
    "nothing here may be classified as a plan exclusion"
  );
});

test("D5: an unrecognized code and a real exclusion are counted separately in one estimate", async () => {
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [
        { code: "D6058", quantity: 1, fee: cents(1450) }, // not in the catalog
        { code: "D8080", quantity: 1, fee: cents(4500) }, // catalogued, and named by the payer
        { code: "D1110", quantity: 1, fee: cents(110) },
      ],
    },
    adapter,
    NOW
  );

  const reasonFor = (code: string) => rec.calculation!.lines.find((l) => l.code === code)!.denialReason;
  assert.equal(reasonFor("D6058"), "procedure-unrecognized");
  assert.equal(reasonFor("D8080"), "excluded");

  const prose = plainEnglishEstimate(rec).join(" ");
  assert.match(prose, /1 procedure the plan doesn't cover \(/, "only the payer's own refusal is counted there");
  assert.match(prose, /1 procedure we don't have on file \(D6058\)/);
});

test("D5: an unrecognized line names itself, and carries no benefit category at all", () => {
  /**
   * Two fabrications, both closed. The description no longer reads as a procedure name, and the
   * category is no longer "basic" — a bucket invented for a code nobody classified, which was inert
   * only by accident of control flow and one refactor away from pricing an unknown procedure at the
   * basic percentage with the basic deductible and the basic waiting period.
   */
  const calc = calculateCoverage(
    [{ code: "D6058", quantity: 1, fee: cents(1450) }],
    {
      eligibility: "active",
      planName: "Delta Dental PPO",
      payerName: "Delta Dental",
      deductible: { individualAnnual: ZERO, remaining: ZERO, appliesTo: [] },
      annualMaximum: { amount: cents(1500), used: ZERO, remaining: cents(1500) },
      coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
      waitingPeriods: [],
      frequencyLimits: [],
      exclusions: [],
      excludedCodes: [],
    },
    NOW
  );

  assert.equal(calc.lines[0]!.description, "Unrecognized procedure code");
  assert.doesNotMatch(calc.lines[0]!.description, /^Unknown procedure code$/, "not a procedure name");
  // Both surfaces that print this already print the code beside it, so repeating it here rendered
  // "D6058 (Unrecognized procedure (code D6058))".
  assert.doesNotMatch(calc.lines[0]!.description, /D6058/, "the code is printed beside this, not inside it");
  assert.equal(calc.lines[0]!.category, UNCATEGORIZED);
  assert.notEqual(calc.lines[0]!.category, "basic", "no bucket was assigned, so none may be claimed");
  assert.equal(
    benefitCategoryOf(calc.lines[0]!.category),
    null,
    "and nothing may price it — the absence must not resolve to a benefit bucket"
  );
});

test("D5: a recognized line still carries its real category, priced against it", () => {
  // The guard must not have made every line uncategorized — the catalogued path is untouched.
  const calc = calculateCoverage(
    [{ code: "D2750", quantity: 1, fee: cents(1250) }],
    {
      eligibility: "active",
      planName: "Delta Dental PPO",
      payerName: "Delta Dental",
      deductible: { individualAnnual: ZERO, remaining: ZERO, appliesTo: [] },
      annualMaximum: { amount: cents(1500), used: ZERO, remaining: cents(1500) },
      coveragePercentages: { diagnostic: 100, preventive: 100, basic: 80, major: 50, orthodontic: 0 },
      waitingPeriods: [],
      frequencyLimits: [],
      exclusions: [],
      excludedCodes: [],
    },
    NOW
  );

  assert.equal(calc.lines[0]!.category, "major");
  assert.equal(benefitCategoryOf(calc.lines[0]!.category), "major", "a real bucket resolves to itself");
  assert.equal(calc.lines[0]!.denied, false, "and it is priced, not denied");
});

test("D5: the uncategorized line survives into the claim as an absence, not a bucket", async () => {
  /**
   * `build.ts` is the only consumer of a coverage line's category — it copies it onto the claim
   * line. If the widening had stopped at the estimate, the claim would still have said "basic".
   */
  const rec = await runVerification(
    {
      patient: patient(),
      cardText: "Delta Dental\nMember ID: ABC12345",
      planItems: [{ code: "D6058", quantity: 1, fee: cents(1450) }],
    },
    adapter,
    NOW
  );

  const snapshot = buildCoverageSnapshot(rec)!;
  assert.equal(snapshot.calculation.lines[0]!.category, UNCATEGORIZED);
  assert.equal(benefitCategoryOf(snapshot.calculation.lines[0]!.category), null);
});
