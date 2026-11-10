/**
 * AI insurance-card reading (workflow S2; journey n2).
 *
 * The properties under test, in the order they matter:
 *
 *   1. The photograph path and the text path converge on ONE `InsuranceCardData`, so nothing
 *      downstream — payer identification, exceptions, confidence, review routing — has to change.
 *   2. There is no second payer-matching engine. `identifyPayer` still decides which connector to
 *      call, from a string the model merely transcribed.
 *   3. Confidence is earned from the cross-check, not reported by the model. Two readers that
 *      disagree drop below the review threshold instead of one of them quietly winning.
 *   4. An insurance card is PHI, so this is refused without an approved provider — and the typed
 *      card text carries the verification exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmRouter, ScriptedProvider, type ScriptedReply } from "@mermaid/llm";
import { MockEdiAdapter } from "@mermaid/edi";
import { createCardReader, NoCardReader } from "../card-vision.ts";
import { REVIEW_THRESHOLD } from "../analysis.ts";
import { identifyPayer } from "../payer.ts";
import { runVerification } from "../../pipeline.ts";

const IMAGE = [{ mediaType: "image/jpeg", base64: "QUJD" }];

function readerFrom(replies: ScriptedReply[], phiApproved = true) {
  const provider = new ScriptedProvider({ replies });
  const router = new LlmRouter({
    provider, phiApproved, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  return { reader: createCardReader(router), provider };
}

/** A model answer: structured fields plus the verbatim transcription the regex engine re-reads. */
const answer = (over: Record<string, unknown> = {}): ScriptedReply => ({
  kind: "text",
  text: JSON.stringify({
    payerName: "Delta Dental",
    memberId: "ABC12345",
    groupNumber: "GRP100",
    planName: null,
    subscriberName: "Maria Alvarez",
    effectiveDate: "2026-01-01",
    transcription: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100\nMaria Alvarez\nEffective: 2026-01-01",
    ...over,
  }),
});

// ── 1. One shape, whichever way the card was read ─────────────────────────────────────

test("a photograph produces the same InsuranceCardData shape typed text does", async () => {
  const { reader } = readerFrom([answer()]);
  const result = (await reader.read(IMAGE))!;

  assert.deepEqual(Object.keys(result.card).sort(), [
    "effectiveDate", "groupNumber", "memberId", "payerName", "planName", "subscriberName",
  ]);
  assert.equal(result.card.payerName.value, "Delta Dental");
  assert.equal(result.card.memberId.value, "ABC12345");
  // Provenance is honest about which of the three readers produced it.
  assert.equal(result.card.memberId.source, "vision");
});

test("the transcription becomes the record's card text, so provenance matches what was read", async () => {
  const { reader } = readerFrom([answer()]);
  const record = await runVerification(
    {
      patient: { firstName: "Maria", lastName: "Alvarez", dateOfBirth: "1988-03-02", memberId: "ABC12345" },
      cardText: "typed fallback nobody used",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  // `cardText` is optional on the record (pre-M2 records predate it), so it is asserted present
  // before it is read — the point of the test is that it holds the TRANSCRIPTION, not the fallback.
  assert.ok(record.cardText, "a read card must record the text it was read from");
  assert.match(record.cardText, /Delta Dental/);
  assert.doesNotMatch(record.cardText, /typed fallback/);
  // The cross-check lands in the audit trail a reviewer opens later.
  assert.ok(record.audit.some((a) => /Card read from 1 image\(s\)/.test(a.message)));
  assert.ok(record.audit.some((a) => /member ID: image read "ABC12345"/.test(a.message)));
});

test("the whole pipeline runs off a photograph — the estimate comes out the far end", async () => {
  const { reader } = readerFrom([answer()]);
  const record = await runVerification(
    {
      patient: { firstName: "Maria", lastName: "Alvarez", dateOfBirth: "1988-03-02", memberId: "ABC12345" },
      cardText: "unused",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }, { code: "D2750", quantity: 1, toothNumber: "19" }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  assert.equal(record.payerId, "delta-dental");
  assert.ok(record.benefits, "eligibility ran off the card the model read");
  assert.ok(record.calculation, "the deterministic estimate calculator ran, unchanged");
});

// ── 2. No second payer-matching engine ────────────────────────────────────────────────

test("the model transcribes the payer NAME; identifyPayer still chooses the connector", async () => {
  const { reader, provider } = readerFrom([
    answer({ payerName: "DELTA DENTAL OF CALIFORNIA", transcription: "DELTA DENTAL OF CALIFORNIA\nID ABC12345" }),
  ]);
  const result = (await reader.read(IMAGE))!;

  // The one registry, consulted downstream exactly as it was for typed text.
  // The card names its Delta company, so it reaches that company — not generic "Delta Dental".
  assert.equal(identifyPayer(result.card.payerName.value).value?.payerId, "delta-dental-ca");
  // And the model was never asked to pick a connector, an id, or a canonical name.
  const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.prompt}`;
  assert.doesNotMatch(sent, /delta-dental|payerId|connector/i);
  assert.match(provider.calls[0]!.system, /do not map it to a company you think it resembles/i);
});

test("an unrecognised payer name is carried through verbatim, and refused downstream — not mapped", async () => {
  const { reader } = readerFrom([
    answer({ payerName: "Smalltown Dental Trust", memberId: null, transcription: "Smalltown Dental Trust" }),
  ]);
  const result = (await reader.read(IMAGE))!;

  // READING it and being able to ACT on it are two different confidences, and they decompose here
  // exactly as they should. Both readers agree the card says "Smalltown Dental Trust", so the
  // extraction is trustworthy...
  assert.equal(result.card.payerName.value, "Smalltown Dental Trust");
  assert.ok(result.card.payerName.confidence >= 0.9);
  // ...and the single payer registry, unchanged, still says there is no connector for it. Collapsing
  // these into one number is what would let a model's confident misreading pick a payer.
  assert.equal(identifyPayer(result.card.payerName.value).value, null);
});

test("a card naming an unusable payer still reaches a human, through the exception path that existed", async () => {
  const { reader } = readerFrom([
    answer({ payerName: "Smalltown Dental Trust", transcription: "Smalltown Dental Trust\nMember ID: ABC12345" }),
  ]);
  const record = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "unused",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );
  assert.equal(record.status, "needs_review");
  assert.ok(record.exceptions.some((e) => e.code === "unknown-payer"));
});

// ── 3. Confidence is earned, not self-reported ────────────────────────────────────────

test("the model is never asked how confident it is", async () => {
  const { reader, provider } = readerFrom([answer()]);
  await reader.read(IMAGE);
  const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.prompt}`;
  assert.doesNotMatch(sent, /confidence|how (sure|certain)|score/i);
});

/**
 * The title and the assertion here USED to say "unrelated methods" and "independently confirmed",
 * and both overstated what happened. The regex engine reads the model's own transcript, so the two
 * readings descend from one act of reading the image. The check is still worth its score — it
 * catches the model assigning a value to the wrong FIELD, which is a real and common failure — but
 * it cannot catch a misread character, and a reviewer told it was "independently confirmed" would
 * reasonably stop checking.
 */
test("two readings agreeing scores high — the field was not misassigned", async () => {
  const { reader } = readerFrom([answer()]);
  const result = (await reader.read(IMAGE))!;
  assert.ok(result.card.memberId.confidence >= 0.9);
  assert.match(result.card.memberId.explanation, /confirmed against the card text/);
  assert.match(result.card.memberId.explanation, /same image/, "and says what that is worth");
});

test("two readers DISAGREEING drops below the review threshold instead of picking a winner", async () => {
  // The image says ABC12345; the transcription's labelled member ID says ABC99999.
  const { reader } = readerFrom([
    answer({ transcription: "Delta Dental\nMember ID: ABC99999\nGroup #: GRP100" }),
  ]);
  const result = (await reader.read(IMAGE))!;

  assert.ok(
    result.card.memberId.confidence < REVIEW_THRESHOLD,
    "a contested member ID must reach a human, not a payer"
  );
  assert.match(result.card.memberId.explanation, /They disagree/);
  assert.match(result.card.memberId.explanation, /ABC99999/, "the reviewer is shown both readings");
});

test("a contested member ID reaches a human however healthy the other signals are", async () => {
  // ── THE REGRESSION THIS PINS ────────────────────────────────────────────────────────────────
  // Lowering the contested field's confidence was NOT enough on its own. The overall score is a
  // weighted average across four components, so one contested member ID (0.25) against a matched
  // payer, retrieved benefits and clean patient data still cleared the 0.75 auto-verify threshold —
  // the card was believed and the wrong identifier would have been filed to the payer unreviewed.
  // Hence `card-reading-contested` is CRITICAL, and critical exceptions bypass the average entirely.
  const { reader } = readerFrom([
    answer({ transcription: "Delta Dental\nMember ID: ABC99999\nGroup #: GRP100" }),
  ]);
  const record = await runVerification(
    {
      patient: { firstName: "Maria", lastName: "Alvarez", dateOfBirth: "1988-03-02", memberId: "ABC12345" },
      cardText: "unused",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  assert.equal(record.status, "needs_review");
  const contested = record.exceptions.find((e) => e.code === "card-reading-contested");
  assert.ok(contested, "the disagreement must be a first-class exception, not only a low score");
  assert.equal(contested.severity, "critical");
  assert.match(contested.message, /ABC12345/);
  assert.match(contested.message, /ABC99999/);
  // Proof the exception is what stopped it, not the arithmetic: the score cleared the threshold.
  assert.ok(
    record.confidence.overall >= record.confidence.reviewThreshold,
    "if the average had caught this, the exception would be untested"
  );
});

test("a contested PAYER NAME is critical too — it decides which payer is billed", async () => {
  const { reader } = readerFrom([
    answer({ payerName: "Cigna", transcription: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100" }),
  ]);
  const record = await runVerification(
    {
      patient: { firstName: "Maria", lastName: "Alvarez", dateOfBirth: "1988-03-02", memberId: "ABC12345" },
      cardText: "unused",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );
  assert.equal(record.status, "needs_review");
  assert.ok(record.exceptions.some((e) => e.code === "card-reading-contested" && e.severity === "critical"));
});

test("a contested SUPPORTING field is shown but does not stop a check-in", async () => {
  // A critical exception that fires on most cards teaches staff to clear it without reading it.
  const { reader } = readerFrom([
    answer({ planName: "PPO Plus", transcription: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100\nPlan: PPO Basic" }),
  ]);
  const result = (await reader.read(IMAGE))!;
  assert.equal(result.contested.length, 0, "only payer name and member ID are stop-the-line fields");
  assert.ok(result.crossCheck.some((line) => /plan name.*DISAGREE/.test(line)), "but the reviewer still sees it");
});

test("a value only the model found is trusted on structure alone, at a lower score", async () => {
  // The transcription has no labelled member ID, so only the vision read produced one.
  const { reader } = readerFrom([
    answer({ transcription: "Delta Dental\nGROUP GRP100\nMaria Alvarez" }),
  ]);
  const result = (await reader.read(IMAGE))!;
  assert.equal(result.card.memberId.value, "ABC12345");
  assert.equal(result.card.memberId.confidence, 0.85);
  assert.match(result.card.memberId.explanation, /no matching pattern to check it against/);
});

test("an implausible member ID scores low even when only the model offered it", async () => {
  const { reader } = readerFrom([
    answer({ memberId: "see reverse", transcription: "Delta Dental\nGroup GRP100" }),
  ]);
  const result = (await reader.read(IMAGE))!;
  assert.ok(result.card.memberId.confidence <= 0.45);
});

test("a field neither reader found is null at zero confidence, not absent", async () => {
  const { reader } = readerFrom([answer({ planName: null, transcription: "Delta Dental\nID ABC12345" })]);
  const result = (await reader.read(IMAGE))!;
  assert.equal(result.card.planName.value, null);
  assert.equal(result.card.planName.confidence, 0);
});

test("punctuation differences between the two readings are not a disagreement", async () => {
  const { reader } = readerFrom([
    answer({ memberId: "ABC-12345", transcription: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100" }),
  ]);
  const result = (await reader.read(IMAGE))!;
  assert.ok(result.card.memberId.confidence >= 0.9, "same digits, different hyphenation, one reading");
});

// ── 4. PHI, and degradation ───────────────────────────────────────────────────────────

test("an insurance card is declared as PHI — this feature genuinely waits for the BAA", async () => {
  const { reader, provider } = readerFrom([answer()], false);
  assert.equal(await reader.read(IMAGE), null);
  assert.equal(provider.calls.length, 0, "the image must not leave the process");
});

test("without an approved provider the typed card text carries the verification, unchanged", async () => {
  const { reader } = readerFrom([answer()], false);
  const record = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  assert.equal(record.card.memberId.value, "ABC12345");
  assert.equal(record.card.memberId.source, "ocr", "the regex engine read it, and says so");
  assert.equal(record.payerId, "delta-dental");
  assert.ok(record.benefits);
  assert.ok(record.audit.some((a) => /no card reader is available/.test(a.message)));
});

for (const [label, replies] of [
  ["unavailable", [{ kind: "error", code: "unavailable" }]],
  ["rate-limited", [{ kind: "error", code: "rate_limited" }]],
  ["hung", [{ kind: "hang" }]],
  ["answering in the wrong shape", [{ kind: "text", text: '{"payerName":"Delta Dental"}' }]],
  ["answering with prose", [{ kind: "text", text: "I can see a Delta Dental card." }]],
] as [string, ScriptedReply[]][]) {
  test(`a provider ${label} declines the read; the typed text is used instead`, async () => {
    const { reader } = readerFrom(replies);
    assert.equal(await reader.read(IMAGE), null);

    const record = await runVerification(
      {
        patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
        cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
        cardImages: IMAGE,
        planItems: [{ code: "D0120", quantity: 1 }],
      },
      new MockEdiAdapter(),
      new Date("2026-09-15T10:00:00Z"),
      undefined,
      reader
    );
    assert.equal(record.card.memberId.value, "ABC12345");
    assert.ok(record.benefits, "the verification completed regardless");
  });
}

test("a reader that throws cannot stop a patient being verified", async () => {
  const record = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    {
      available: () => true,
      async read() {
        throw new Error("a future card reader is less careful than this one");
      },
    }
  );
  assert.equal(record.card.memberId.value, "ABC12345");
  assert.ok(record.benefits);
});

test("no images means no call at all, and the pipeline is byte-for-byte what it was", async () => {
  const { reader, provider } = readerFrom([answer()]);
  const input = {
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
    cardText: "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100",
    planItems: [{ code: "D0120", quantity: 1 }],
  };
  const now = new Date("2026-09-15T10:00:00Z");

  const withReader = await runVerification(input, new MockEdiAdapter(), now, undefined, reader);
  const without = await runVerification(input, new MockEdiAdapter(), now, undefined, NoCardReader);

  assert.equal(provider.calls.length, 0);
  assert.deepEqual(withReader.card, without.card);
  assert.equal(withReader.confidence.overall, without.confidence.overall);
  assert.equal(withReader.status, without.status);
});

test("an empty image array is not a read attempt", async () => {
  const { reader, provider } = readerFrom([answer()]);
  assert.equal(await reader.read([]), null);
  assert.equal(provider.calls.length, 0);
});

// ── M10 — a model may PROPOSE an identifier, it may not DECIDE one ────────────────────────────
//
// The pipeline resolved the member ID as `card.memberId.value ?? input.patient.memberId`, so the
// card reading always won. In the TEXT path that is fine — the card text was typed or pasted by
// staff, so both candidates are human-entered.
//
// The PHOTOGRAPH path is different: there the card reading is a model's transcription, and letting
// it silently overrule a person inverts the rule the whole AI layer rests on. A single misread digit
// became the identifier the eligibility check was made under, the estimate was built from, and the
// claim would be filed with. The existing `member-id-mismatch` flag is a WARNING — averaged into a
// confidence score, and it stops nothing.

/** A reader whose model confidently reads a member ID that disagrees with what was typed. */
function readerReading(memberId: string) {
  return readerFrom([
    answer({
      payerName: "Delta Dental",
      memberId,
      groupNumber: "GRP100",
      planName: "PPO",
      subscriberName: "ADA ALPHA",
      effectiveDate: null,
      transcription: `Delta Dental\nMember ID: ${memberId}\nGroup #: GRP100`,
    }),
  ]);
}

test("M10: a vision reading that disagrees with the typed member ID does NOT reach the payer", async () => {
  const { reader } = readerReading("ABC12B45"); // a misread '3' as 'B'
  const rec = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  // The 271 is built from what actually went on the wire, so it is the honest witness here.
  assert.ok(rec.raw271?.includes("ABC12345"), "the TYPED identifier is what was asked of the payer");
  assert.ok(!rec.raw271?.includes("ABC12B45"), "the model's reading must not have been sent");
});

test("M10: the disagreement is CRITICAL, so it cannot be averaged away", async () => {
  /**
   * The same reasoning `card-reading-contested` already exists for, applied to the case where the
   * two readers are the model and the front desk rather than two models: one contested identifier
   * against three healthy signals still clears the auto-verify threshold.
   */
  const { reader } = readerReading("ABC12B45");
  const rec = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  const flag = rec.exceptions.find(
    (e) => e.code === "card-reading-contested" && e.message.includes("ABC12B45")
  );
  assert.ok(flag, "both readings must be on the record, named");
  assert.equal(flag!.severity, "critical");
  assert.match(flag!.message, /typed value was used/);
  assert.equal(rec.status, "needs_review", "a person decides which identifier is right");
});

test("M10: a vision reading that AGREES changes nothing — the guard must not fire on good reads", async () => {
  // The control. If this failed, every photographed card would route to review and the feature would
  // be useless.
  const { reader } = readerReading("ABC12345");
  const rec = await runVerification(
    {
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      cardText: "",
      cardImages: IMAGE,
      planItems: [{ code: "D0120", quantity: 1 }],
    },
    new MockEdiAdapter(),
    new Date("2026-09-15T10:00:00Z"),
    undefined,
    reader
  );

  assert.ok(
    !rec.exceptions.some((e) => e.code === "card-reading-contested" && e.message.includes("typed value was used")),
    "agreement is not a disagreement"
  );
  assert.ok(rec.raw271?.includes("ABC12345"));
});

// ── Agreement is not evidence that the value is a value ───────────────────────────────

/**
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The structural plausibility check was consulted only when ONE reader found a field. So two
 * readings agreeing on something that is not an identifier at all scored 0.96 and cleared without a
 * person, while the SAME string from a single reader scored 0.45 and got looked at. Agreement made a
 * bad value HARDER to catch than a lone one.
 *
 * And the two readings are not independent: the regex engine runs over the model's own transcript,
 * so a model that writes "N/A" into both its structured answer and its transcription produces
 * exactly this shape. The cross-check catches a field being MISASSIGNED; it cannot catch a
 * character being misread, and it must not be scored as though it could.
 *
 * A wrong member ID costs a denied claim, a re-filing, and a patient quoted the wrong number.
 */
test("two readings agreeing on a non-identifier do not clear it", async () => {
  /**
   * A run-on string, not "N/A" or a bare label: the schema layer already normalises "N/A" and a dash
   * to null, and the regex reader declines a value carrying no digit — both good, and worth knowing.
   * What actually reaches the agreement path is a string long enough to be structurally impossible
   * as an identifier (22 characters) that the regex WILL extract, which is what a model produces
   * when it runs two printed lines together.
   */
  const { reader } = readerFrom([
    answer({
      memberId: "ABCDEFGHIJKLMNOPQRSTU1",
      transcription: "Delta Dental\nMember ID: ABCDEFGHIJKLMNOPQRSTU1\nGroup #: GRP100",
    }),
  ]);
  const result = (await reader.read(IMAGE))!;

  assert.equal(result.card.memberId.value, "ABCDEFGHIJKLMNOPQRSTU1", "the reading is still reported");
  assert.ok(
    result.card.memberId.confidence < REVIEW_THRESHOLD,
    `agreement on an impossible identifier scored ${result.card.memberId.confidence} — it must not clear`
  );
  assert.match(result.card.memberId.explanation, /does not look like a member ID/);
  assert.match(
    result.card.memberId.explanation,
    /not evidence that the value is right/,
    "the reviewer is told why agreement did not settle it"
  );
});

test("a plausible member ID that both readings agree on still clears", async () => {
  /** The widening must not have broken the ordinary case, which is nearly every card. */
  const { reader } = readerFrom([answer()]);
  const result = (await reader.read(IMAGE))!;

  assert.equal(result.card.memberId.value, "ABC12345");
  assert.ok(result.card.memberId.confidence >= 0.96, "agreement on a real identifier is still strong evidence");
});

test("the explanation no longer claims the two readings were independent", async () => {
  /**
   * The word was doing false work. Both readings descend from one act of reading the image — the
   * structured fields and the transcript are both the model's answer — and a reviewer told they were
   * "independently confirmed" would reasonably stop checking.
   */
  const { reader } = readerFrom([answer()]);
  const result = (await reader.read(IMAGE))!;

  assert.doesNotMatch(result.card.memberId.explanation, /independent/i);
  assert.match(
    result.card.memberId.explanation,
    /same image/,
    "it says plainly what the confirmation is worth"
  );
});

test("a card naming its Delta Dental company routes to that company; a bare 'Delta Dental' routes nowhere", () => {
  assert.equal(identifyPayer("DELTA DENTAL OF NEW JERSEY").value?.clearinghouseId, "22189");
  assert.equal(identifyPayer("Delta Dental of NJ").value?.clearinghouseId, "22189");
  assert.equal(identifyPayer("Delta Dental of New York, Inc.").value?.clearinghouseId, "11198");
  assert.equal(identifyPayer("Delta Dental of Oregon").value?.clearinghouseId, "CDOR1");
  assert.equal(identifyPayer("DELTA DENTAL OF CALIFORNIA").value?.clearinghouseId, "77777");

  const bare = identifyPayer("Delta Dental PPO");
  assert.equal(bare.value?.payerId, "delta-dental", "still recognised as Delta");
  assert.equal(bare.value?.clearinghouseId, undefined, "but no company is guessed for it");
});
