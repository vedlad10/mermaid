/**
 * The Moda Health sample card, end to end — the reported defect, pinned.
 *
 * The complaint was: the photograph uploads and appears, and then nothing happens. Card text stays
 * empty, Member ID stays empty. Three separate causes, and each gets its own section here:
 *
 *   1. The parser returned the literal word "NUMBER" as the member ID, at 0.92 confidence — high
 *      enough to auto-verify. This affected the TYPED path too, and predates photographs entirely.
 *   2. There was no upload → read → populate step at all: extraction ran only inside `create`, so
 *      the form the person was looking at was never filled in.
 *   3. Card reading is gated off (`LLM_PROVIDER=off`), and the UI said nothing about it.
 *
 * And one thing that is NOT a defect and must never be "fixed": **date of birth is not printed on
 * this card, or on essentially any insurance card.** A DOB that stays empty after a scan is correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { LlmRouter, ScriptedProvider } from "@mermaid/llm";
import { interpretCardText, cardConfidence } from "../ocr.ts";
import { createCardReader, NoCardReader } from "../card-vision.ts";
import { identifyPayer } from "../payer.ts";
import { runVerification } from "../../pipeline.ts";
import { MODA_FIELDS, MODA_IMAGE, MODA_REPLY, MODA_TRANSCRIPTION } from "./moda-card.ts";

const NOW = new Date("2026-09-15T10:00:00Z");

/** The patient being seen is a dependent on the card, which is the normal case. */
const PATIENT = {
  firstName: "Kimberly",
  lastName: "Smith",
  dateOfBirth: "1996-11-04",
  memberId: "J01234567",
};

function readerFrom(phiApproved = true) {
  const provider = new ScriptedProvider({ replies: [MODA_REPLY] });
  const router = new LlmRouter({
    provider, phiApproved, timeoutMs: 100, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  return { reader: createCardReader(router), provider };
}

// ── 1. The parser defect, on the typed path ──────────────────────────────────────────

test("the Moda card's ID is J01234567 — not the word 'NUMBER'", () => {
  // ── REGRESSION ───────────────────────────────────────────────────────────────────────────────
  // "ID number" over "J01234567" is how a card is printed. The labelled-value pattern matched "ID",
  // found no inline value, and captured the remaining word "number" — reporting it as a LABELLED
  // member ID, which scores 0.92 and clears the 0.75 auto-verify threshold. A made-up identifier,
  // confidently, on a claim to a payer. This assertion is the guard.
  const card = interpretCardText(MODA_TRANSCRIPTION);
  assert.equal(card.memberId.value, "J01234567");
  assert.notEqual(card.memberId.value, "NUMBER");
});

test("the group number is the dental group, not the Rx group printed beside it", () => {
  // "Rx Group: RXMODA" is the PHARMACY group. Filing under it means filing under a number the
  // dental payer has never seen.
  const card = interpretCardText(MODA_TRANSCRIPTION);
  assert.equal(card.groupNumber.value, "10101010");
  assert.notEqual(card.groupNumber.value, "RXMODA");
});

test("no digit run on the card is mistaken for the member ID", () => {
  // The card also carries BIN 610014, group 10101010, and three phone numbers. A "longest digit
  // run" heuristic would happily return any of them.
  const card = interpretCardText(MODA_TRANSCRIPTION);
  for (const decoy of ["610014", "8772777280", "8669380356", "40384", "97240"]) {
    assert.notEqual(card.memberId.value, decoy);
  }
});

test("the label-above-value layout works for other payers too, at full labelled confidence", () => {
  // Before the fix these fell through to the token fallback at 0.55, which is below the review
  // threshold — so every such card went to a human unnecessarily.
  for (const [text, expected] of [
    ["Aetna Dental\nMember ID\nW123456789\nGroup Number\n0987654", "W123456789"],
    ["Cigna\nSubscriber ID\nU7654321\nGroup #\nGRP55", "U7654321"],
  ] as [string, string][]) {
    const card = interpretCardText(text);
    assert.equal(card.memberId.value, expected);
    assert.equal(card.memberId.confidence, 0.92);
  }
});

test("the inline layout still parses exactly as it always did", () => {
  const card = interpretCardText("Delta Dental\nMember ID: ABC12345\nGroup #: GRP100\nEffective: 2025-01-01");
  assert.equal(card.memberId.value, "ABC12345");
  assert.equal(card.groupNumber.value, "GRP100");
  assert.equal(card.payerName.value, "Delta Dental");
  assert.ok(cardConfidence(card) > 0.7);
});

test("a label with no value anywhere yields null, never the label word", () => {
  const card = interpretCardText("Some Dental Plan\nMember ID\nGroup number");
  assert.notEqual(card.memberId.value, "NUMBER");
  assert.notEqual(card.groupNumber.value, "NUMBER");
});

// ── 2. Reading the photograph ────────────────────────────────────────────────────────

test("reading the Moda photograph returns the fields a claim needs", async () => {
  const { reader } = readerFrom();
  const result = (await reader.read(MODA_IMAGE))!;

  assert.equal(result.card.payerName.value, "Moda Health");
  assert.equal(result.card.memberId.value, "J01234567");
  assert.equal(result.card.groupNumber.value, "10101010");
  assert.equal(result.card.planName.value, "Dental PPO");
  assert.equal(result.transcription, MODA_TRANSCRIPTION);
});

test("the photograph and the transcribed text agree, so the member ID scores high", async () => {
  // The point of the cross-check: the vision read said J01234567 and the regex engine, reading the
  // transcription independently, said J01234567. Two unrelated methods, one answer.
  const { reader } = readerFrom();
  const result = (await reader.read(MODA_IMAGE))!;
  assert.ok(result.card.memberId.confidence >= 0.9);
  assert.equal(result.contested.length, 0);
  /**
   * Was `/independently confirmed/`. Both readings descend from one act of reading the image — the
   * regex engine works on the model's own transcript — so the confirmation is that the field was not
   * MISASSIGNED, which is real and worth the score, and not that every character was read correctly.
   */
  assert.match(result.card.memberId.explanation, /confirmed against the card text/);
});

test("date of birth is not on the card, and is not invented", async () => {
  const { reader } = readerFrom();
  const result = (await reader.read(MODA_IMAGE))!;
  assert.equal(result.card.effectiveDate.value, null);
  assert.equal(MODA_FIELDS.effectiveDate, null);
  // Nothing in the read even claims to carry a birth date — it must come from the patient.
  assert.equal(Object.hasOwn(result.card as object, "dateOfBirth"), false);
});

// ── 3. Verify coverage proceeds after a successful read ──────────────────────────────

test("Verify coverage runs to completion on a card read from the photograph", async () => {
  const { reader } = readerFrom();
  const record = await runVerification(
    { patient: PATIENT, cardText: "", cardImages: MODA_IMAGE, planItems: [{ code: "D0120", quantity: 1 }] },
    new MockEdiAdapter(),
    NOW,
    undefined,
    reader
  );

  // It produced a real record rather than throwing or stalling — the reported flow now completes.
  assert.ok(record.id);
  assert.equal(record.card.memberId.value, "J01234567");
  assert.equal(record.card.memberId.source, "vision");
  // The transcription became the record's card text, so provenance matches what was read.
  assert.match(record.cardText ?? "", /J01234567/);
  assert.ok(record.reportText.length > 0);
});

test("Moda resolves to its connector, so the card yields a real estimate", async () => {
  // Moda was added to the payer registry deliberately. Before that, a perfectly-read card still
  // landed in `needs_review` with `unknown-payer` — the read was right and the registry had never
  // heard of the payer. Worth remembering that those are two different failures with two different
  // fixes: OCR reads what is printed, the registry decides who can be reached electronically.
  assert.equal(identifyPayer("Moda Health").value?.payerId, "moda-dental");

  const { reader } = readerFrom();
  const record = await runVerification(
    { patient: PATIENT, cardText: "", cardImages: MODA_IMAGE, planItems: [{ code: "D0120", quantity: 1 }] },
    new MockEdiAdapter(),
    NOW,
    undefined,
    reader
  );

  assert.equal(record.payerId, "moda-dental");
  assert.ok(record.benefits, "eligibility ran off the photograph");
  assert.ok(record.calculation, "and the deterministic estimate calculator produced a quote");
  assert.ok(!record.exceptions.some((e) => e.code === "unknown-payer"));
});

test("a payer that is genuinely unknown still routes to a human", async () => {
  // Adding Moda must not have made the registry permissive. A card from a payer with no connector
  // is still a case only a person can finish, and `\\bmoda\\b` must not match by coincidence.
  assert.equal(identifyPayer("Smalltown Dental Trust").value, null);
  assert.equal(identifyPayer("Modality Benefits").value, null);
});

test("a card whose payer IS in the registry verifies end to end from a photograph", async () => {
  // Proof that the pipeline itself is sound after a read — the Moda outcome above is about the
  // registry, not about the photograph path.
  const delta = {
    ...MODA_FIELDS,
    payerName: "Delta Dental",
    memberId: "ABC12345",
    transcription: "Delta Dental\nID number\nABC12345\nGroup number\nGRP100",
  };
  const router = new LlmRouter({
    provider: new ScriptedProvider({ replies: [{ kind: "text", text: JSON.stringify(delta) }] }),
    phiApproved: true, timeoutMs: 100, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });

  const record = await runVerification(
    {
      patient: { ...PATIENT, memberId: "ABC12345" },
      cardText: "",
      cardImages: MODA_IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    NOW,
    undefined,
    createCardReader(router)
  );

  assert.equal(record.payerId, "delta-dental");
  assert.ok(record.benefits, "eligibility ran off the photograph");
  assert.ok(record.calculation, "and the deterministic estimate was produced");
});

// ── 4. The gates, unchanged ──────────────────────────────────────────────────────────

test("an unapproved deployment reads nothing and says so — it does not invent a card", async () => {
  const { reader, provider } = readerFrom(false);
  assert.equal(await reader.read(MODA_IMAGE), null);
  assert.equal(provider.calls.length, 0, "an insurance card must not leave the process");
  // `available()` is still true: a reader IS wired, it simply may not send PHI. The UI needs that
  // distinction to say "not enabled" versus "could not read this photo".
  assert.equal(reader.available(), true);
});

test("with no provider at all, available() is false and the typed text carries the check-in", async () => {
  assert.equal(NoCardReader.available(), false);

  const record = await runVerification(
    {
      patient: PATIENT,
      cardText: MODA_TRANSCRIPTION,
      cardImages: MODA_IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    NOW,
    undefined,
    NoCardReader
  );

  // The typed/pasted card text is parsed by the fixed regex engine — so even with AI switched off
  // entirely, the Moda card yields the right member ID rather than "NUMBER".
  assert.equal(record.card.memberId.value, "J01234567");
  assert.equal(record.card.memberId.source, "ocr");
  assert.ok(record.audit.some((a) => /no card reader is available/.test(a.message)));
});

// ── D4 — a run of letters is not an identifier ────────────────────────────────────────────────
//
// The labelled-value pattern accepted any six-plus characters of letters, digits and hyphens, so an
// all-letter word was a well-formed member ID as far as this function was concerned — at 0.92
// confidence, which clears the 0.75 auto-verify threshold. `LABEL_WORDS` catches the specific words
// seen in the wild, but it is an enumeration: the next card printing a label it has never heard of
// gets the same silent promotion from prose to identifier.
//
// Every member ID this repository has ever handled carries a digit, including the live Stedi sandbox
// member, so requiring one rejects nothing real.

test("D4: an all-letter run is not accepted as a labelled member ID", () => {
  for (const text of [
    "Some Dental Plan\nMember ID: SUBSCRIBER",
    "Some Dental Plan\nMember ID\nIDENTIFIER",
    "Some Dental Plan\nSubscriber ID: ABCDEFGH",
  ]) {
    const card = interpretCardText(text);
    assert.ok(
      card.memberId.value === null || /\d/.test(card.memberId.value),
      `"${text}" produced a digitless member ID: ${card.memberId.value}`
    );
    assert.ok(
      card.memberId.confidence < 0.92,
      "and it must not carry the confidence of a labelled identifier"
    );
  }
});

test("D4: a fragment of a longer word is never returned as an identifier", () => {
  /**
   * The label alternation matches `id` unanchored, so `IDENTIFIER` on its own line matched "ID" as
   * the label and captured the remainder of the SAME WORD — `ENTIFIER` — at 0.92 confidence. The
   * shape check now runs on the inline branch too, where it never used to.
   */
  const card = interpretCardText("Some Dental Plan\nMember ID\nIDENTIFIER");
  assert.notEqual(card.memberId.value, "ENTIFIER");
  assert.equal(card.memberId.value, null);
});

test("D4: a missing member ID is the failure mode, not an invented one", () => {
  /**
   * The point of the tightening. A rejected value leaves the field empty, and the appeal and claim
   * gates already refuse to file without one; an accepted prose word puts a made-up identifier on a
   * real claim, which nothing downstream has any reason to doubt.
   */
  const card = interpretCardText("Some Dental Plan\nMember ID: SUBSCRIBER\nGroup #: GRP100");
  assert.equal(card.memberId.value, null);
  assert.equal(card.memberId.confidence, 0);
  assert.match(card.memberId.explanation, /No member ID found/i);
});

test("D4: every member ID shape this system actually handles still parses", () => {
  // The fixtures, the OCR cases, the hyphenated form, and the live Stedi sandbox member — which is
  // also the case that proves the match stays case-preserving.
  for (const [text, expected] of [
    ["Delta Dental\nMember ID: ABC12345", "ABC12345"],
    ["Obscure Plan Co\nMember ID: ZZ998877", "ZZ998877"],
    ["Aetna Dental\nMember ID\nW123456789", "W123456789"],
    ["Cigna\nSubscriber ID\nU7654321", "U7654321"],
    ["Moda Health\nID number\nJ01234567", "J01234567"],
    ["Delta Dental\nMember ID: ABC-12345", "ABC-12345"],
    ["Aetna Dental\nMember ID: AETNA9wcSu", "AETNA9wcSu"],
  ] as [string, string][]) {
    const card = interpretCardText(text);
    assert.equal(card.memberId.value, expected, `"${text}" must still parse`);
    assert.equal(card.memberId.confidence, 0.92);
  }
});
