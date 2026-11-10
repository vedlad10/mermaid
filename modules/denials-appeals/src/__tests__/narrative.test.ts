/**
 * AI appeal drafting (workflow S14; Payer_Loop_Analysis §12).
 *
 * These tests are organised around the four things that must remain true no matter what a model
 * returns:
 *
 *   1. AI never decides WHETHER to appeal — the playbook does, before the model is ever consulted.
 *   2. AI writes ONE paragraph. Identifiers, money and the evidence checklist stay deterministic.
 *   3. The human gate is exactly where it was, and editing the letter revokes an approval.
 *   4. When the model is off, down, or wrong, the practice gets the letter it always got.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import { InMemoryPlaybookRepository, PayerProfileService } from "@mermaid/payer-profile";
import { LlmRouter, ScriptedProvider, type ScriptedReply } from "@mermaid/llm";
import type { VarianceDetectedBody } from "@mermaid/events";
import {
  DenialActionError,
  DenialService,
  InMemoryDenialRepository,
  NoNarrator,
  createAppealNarrator,
  describeEvidence,
  draftAppeal,
  sanitizeNarrative,
  type AppealNarrator,
} from "../index.ts";

const NOW = new Date("2026-09-15T10:00:00Z");
const silent = createLogger(() => {});
const PROVIDER = { name: "MERMAID DEMO DENTAL" };

const ARGUMENT =
  "This crown was placed to restore a tooth with structural loss that a direct restoration could " +
  "not support. The enclosed pre-operative radiograph documents the extent of that loss at the time " +
  "of treatment. MetLife Dental has previously reprocessed comparable restorations on review of the " +
  "same documentation, and we ask that this claim receive the same consideration.";

function narratorFrom(replies: ScriptedReply[], phiApproved = true): AppealNarrator {
  const router = new LlmRouter({
    provider: new ScriptedProvider({ replies }),
    phiApproved,
    timeoutMs: 50,
    maxAttempts: 1,
    backoffMs: 1,
    sleep: async () => {},
  });
  return createAppealNarrator(router, () => NOW);
}

async function wired(narrator: AppealNarrator = NoNarrator) {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();
  const service = new DenialService(new InMemoryDenialRepository(), playbook, PROVIDER, bus, narrator);
  return { service, playbook };
}

const variance = (overrides: Partial<VarianceDetectedBody> = {}): VarianceDetectedBody => ({
  claimId: "claim-1",
  remittanceId: "rem-1",
  postingId: "post-1",
  detectedAt: "2026-09-15T09:00:00.000Z",
  payerId: "metlife-dental",
  payerName: "MetLife Dental",
  patientName: "Ada Alpha",
  memberId: "MET30066",
  claimControlNumber: "MRM-000456",
  serviceDate: "2026-09-01",
  recoverableAmount: cents(1125),
  unexplainedAmount: cents(0),
  reasons: [
    { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
  ],
  summary: "The payer withheld $1,125.00 for a missing pre-authorization.",
  ...overrides,
});

async function draftedWith(narrator: AppealNarrator) {
  const { service } = await wired(narrator);
  const [view] = await service.createFromVariance(variance(), NOW);
  const id = view!.denial.id;
  const drafted = await service.draftAppeal(id, {}, NOW);
  return { service, id, appeal: drafted.activeAppeal!, view: drafted };
}

// ── 1. The model never decides whether to appeal ──────────────────────────────────────

test("a denial the playbook says NOT to appeal is refused before the model is ever consulted", async () => {
  const provider = new ScriptedProvider({ replies: [{ kind: "text", text: ARGUMENT }] });
  const router = new LlmRouter({
    provider, phiApproved: true, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  const { service } = await wired(createAppealNarrator(router, () => NOW));

  // CARC 45 is a contractual adjustment — the playbook's disposition is not pursuable.
  const [view] = await service.createFromVariance(
    variance({
      postingId: "post-contractual",
      reasons: [
        { group: "CO", code: "45", description: "Charge exceeds fee schedule", amount: cents(500), procedureCode: "D2750" },
      ],
    }),
    NOW
  );

  await assert.rejects(() => service.draftAppeal(view!.denial.id, {}, NOW), DenialActionError);
  // The whole point: no prompt was built, no provider was called, no AI opinion was formed about a
  // decision that was already made deterministically.
  assert.equal(provider.calls.length, 0);
});

test("the letter's identifiers and amount come from the record, never from the model", async () => {
  const { appeal } = await draftedWith(
    narratorFrom([{ kind: "text", text: ARGUMENT }])
  );
  assert.match(appeal.letter, /Claim MRM-000456/);
  assert.match(appeal.letter, /Member ID: MET30066/);
  assert.match(appeal.letter, /\$1,125\.00/);
  assert.match(appeal.letter, /reason code 197/);
  // And the AI paragraph is in there too, in the argument slot.
  assert.match(appeal.letter, /This crown was placed to restore a tooth/);
});

test("the evidence checklist is deterministic and identical with or without AI", async () => {
  const withAi = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  const without = await draftedWith(NoNarrator);
  assert.deepEqual(withAi.appeal.checklist, without.appeal.checklist);
  assert.ok(without.appeal.checklist.length > 0);
});

// ── 2. Provenance ─────────────────────────────────────────────────────────────────────

test("an AI-drafted paragraph is recorded with its provider, model and the evidence it was given", async () => {
  const { appeal } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  assert.ok(appeal.narrative);
  assert.equal(appeal.narrative.provider, "scripted");
  assert.equal(appeal.narrative.model, "scripted-1");
  assert.equal(appeal.narrative.text, ARGUMENT);
  // The reviewer can check what the model knew, not just what it wrote.
  assert.ok(appeal.narrative.evidence.some((line) => line.includes("CARC 197")));
  assert.ok(appeal.narrative.evidence.some((line) => line.includes("D2750")));
});

test("the denial's own audit trail says the paragraph was machine-written", async () => {
  const { view } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  const line = view.denial.audit.at(-1)!.message;
  assert.match(line, /drafted by AI \(scripted\/scripted-1\)/);
  assert.match(line, /requires human review/);
});

test("a deterministic draft records narrative: null and says nothing about AI", async () => {
  const { appeal, view } = await draftedWith(NoNarrator);
  assert.equal(appeal.narrative, null);
  assert.doesNotMatch(view.denial.audit.at(-1)!.message, /AI/);
});

// ── 3. What the model is not permitted to send ────────────────────────────────────────

test("the prompt carries no patient identity — this feature needs no PHI by construction", async () => {
  const provider = new ScriptedProvider({ replies: [{ kind: "text", text: ARGUMENT }] });
  const router = new LlmRouter({
    provider, phiApproved: true, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  const { service } = await wired(createAppealNarrator(router, () => NOW));
  const [view] = await service.createFromVariance(variance(), NOW);
  await service.draftAppeal(view!.denial.id, {}, NOW);

  const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.prompt}`;
  for (const phi of ["Ada", "Alpha", "MET30066", "MRM-000456", "2026-09-01", "1,125", "1125"]) {
    assert.doesNotMatch(sent, new RegExp(phi), `"${phi}" must never reach a provider`);
  }
  // What it DOES carry: an argument about a procedure code and a reason code.
  assert.match(sent, /D2750/);
  assert.match(sent, /CARC 197/);
});

test("drafting still works when the environment has NOT approved a provider for PHI", async () => {
  // The consequence of the property above, and the reason it was worth designing for: the single
  // most valuable AI feature in the product runs before any BAA is signed.
  const { appeal } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }], false));
  assert.ok(appeal.narrative);
  assert.match(appeal.letter, /This crown was placed/);
});

// ── 4. Degradation is the deterministic letter, every time ────────────────────────────

for (const [label, replies] of [
  ["the provider is unavailable", [{ kind: "error", code: "unavailable" }]],
  ["the provider rate-limits", [{ kind: "error", code: "rate_limited" }]],
  ["the provider hangs past the deadline", [{ kind: "hang" }]],
  ["the model returns nothing usable", [{ kind: "text", text: "" }]],
] as [string, ScriptedReply[]][]) {
  test(`when ${label}, the appeal is the deterministic letter and the money is still pursued`, async () => {
    const { appeal } = await draftedWith(narratorFrom(replies));
    assert.equal(appeal.narrative, null);
    assert.match(appeal.letter, /reconsider this determination on the basis of the records listed below/);
    assert.match(appeal.letter, /Claim MRM-000456/);
    assert.ok(appeal.checklist.length > 0);
  });
}

test("a narrator that throws does not stop an appeal being drafted", async () => {
  const broken: AppealNarrator = {
    async narrate() {
      throw new Error("a future narrator implementation is less careful than the current one");
    },
  };
  const { appeal } = await draftedWith(broken);
  assert.equal(appeal.narrative, null);
  assert.match(appeal.letter, /reconsider this determination on the basis of the records listed below/);
});

test("with LLM off — the default — nothing about the appeal changes", async () => {
  const off = new LlmRouter({
    provider: null, phiApproved: false, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  const { appeal } = await draftedWith(createAppealNarrator(off, () => NOW));
  assert.equal(appeal.narrative, null);
  assert.match(appeal.letter, /reconsider this determination on the basis of the records listed below/);
});

// ── 5. sanitizeNarrative — the last gate before a sentence reaches a payer ────────────

test("a narrative stating a dollar amount is refused — the letter states the money once, deterministically", () => {
  assert.equal(sanitizeNarrative(`${ARGUMENT} The practice is owed $1,250.00 for this service.`), null);
  assert.equal(sanitizeNarrative(`${ARGUMENT} The practice is owed 1250 dollars.`), null);
});

test("a narrative containing placeholder text is refused, as the deterministic engine already refuses", () => {
  assert.equal(sanitizeNarrative(`${ARGUMENT} Please see [radiograph].`), null);
  assert.equal(sanitizeNarrative(`${ARGUMENT} Reference {{claim}}.`), null);
  assert.equal(sanitizeNarrative(`${ARGUMENT} Member XXX.`), null);
});

test("a model that narrated its task instead of performing it is refused", () => {
  assert.equal(sanitizeNarrative(`Here is the appeal paragraph you asked for. ${ARGUMENT}`), null);
  assert.equal(sanitizeNarrative(`Certainly! ${ARGUMENT}`), null);
});

test("a narrative too short to be an argument is refused", () => {
  assert.equal(sanitizeNarrative("We appeal."), null);
});

test("a clean argument passes through, whitespace-normalised", () => {
  assert.equal(sanitizeNarrative(`  ${ARGUMENT}  `), ARGUMENT);
});

test("a refused narrative degrades to the deterministic letter rather than being cleaned up", async () => {
  const { appeal } = await draftedWith(
    narratorFrom([{ kind: "text", text: `${ARGUMENT} We are owed $1,125.00.` }])
  );
  assert.equal(appeal.narrative, null);
  assert.match(appeal.letter, /reconsider this determination on the basis of the records listed below/);
});

// ── 6. The human gate, unchanged, and editing that revokes it ─────────────────────────

test("an AI-drafted appeal cannot be sent without a named human approving it", async () => {
  const { service, id } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  await assert.rejects(() => service.submitAppeal(id, NOW), /has not been approved by a person/);
});

test("a human can rewrite the AI paragraph before approving", async () => {
  const { service, id } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  const edited = `${ARGUMENT}\n\nAdded by the treating provider after review of the chart.`;
  const view = await service.reviseAppeal(id, edited, "biller@clinic", NOW);
  assert.equal(view.activeAppeal!.letter, edited);
  assert.match(view.denial.audit.at(-1)!.message, /letter edited by biller@clinic/);
});

test("editing an APPROVED letter clears the approval — a signature signs off specific words", async () => {
  const { service, id } = await draftedWith(narratorFrom([{ kind: "text", text: ARGUMENT }]));
  const approved = await service.approveAppeal(id, "biller@clinic", NOW);
  assert.equal(approved.activeAppeal!.approvedBy, "biller@clinic");

  const revised = await service.reviseAppeal(id, `${ARGUMENT} One more sentence.`, "dentist@clinic", NOW);
  assert.equal(revised.activeAppeal!.approvedBy, null);
  assert.equal(revised.activeAppeal!.approvedAt, null);
  assert.match(revised.denial.audit.at(-1)!.message, /earlier approval by biller@clinic was cleared/);

  // And it genuinely cannot be sent until someone signs the new wording.
  await assert.rejects(() => service.submitAppeal(id, NOW), /has not been approved by a person/);
});

test("a revision may not introduce placeholder text a payer cannot act on", async () => {
  const { service, id } = await draftedWith(NoNarrator);
  await assert.rejects(
    () => service.reviseAppeal(id, `${ARGUMENT} See [enclosed radiograph].`, "biller", NOW),
    /placeholder text in square brackets/
  );
});

test("a revision that is not a letter is refused", async () => {
  const { service, id } = await draftedWith(NoNarrator);
  await assert.rejects(() => service.reviseAppeal(id, "ok", "biller", NOW), /too short to be a letter/);
  await assert.rejects(() => service.reviseAppeal(id, ARGUMENT, "  ", NOW), /a revising user is required/);
});

test("there is nothing to revise when no appeal is drafted", async () => {
  const { service } = await wired();
  const [view] = await service.createFromVariance(variance(), NOW);
  await assert.rejects(
    () => service.reviseAppeal(view!.denial.id, ARGUMENT, "biller", NOW),
    /no drafted appeal to revise/
  );
});

// ── 7. The engine itself ──────────────────────────────────────────────────────────────

test("draftAppeal with no narrative is byte-identical to the letter before AI existed", () => {
  const ctx = {
    level: 1,
    payerName: "MetLife Dental",
    patientName: "Ada Alpha",
    memberId: "MET30066",
    claimControlNumber: "MRM-000123",
    serviceDate: "2026-07-27",
    procedureCode: "D2750",
    carcCode: "197",
    carcDescription: "Pre-authorization absent",
    deniedAmount: cents(1125),
    guidance: "Cite the clinical urgency.",
    providerName: "MERMAID DEMO DENTAL",
  };
  assert.equal(draftAppeal(ctx).letter, draftAppeal(ctx, null).letter);
  assert.match(draftAppeal(ctx).letter, /reconsider this determination on the basis of the records listed below/);
  // The narrative replaces exactly one slot.
  assert.match(draftAppeal(ctx, ARGUMENT).letter, /This crown was placed/);
  assert.doesNotMatch(draftAppeal(ctx, ARGUMENT).letter, /reconsider this determination on the basis of the records listed below/);
});

test("describeEvidence is both the prompt and the panel a reviewer reads — one source", () => {
  const evidence = describeEvidence({
    level: 2,
    payerName: "Delta Dental",
    procedureCode: "D2740",
    procedureDescription: "Crown - porcelain/ceramic",
    carcCode: "29",
    carcDescription: "Time limit for filing has expired",
    guidance: "Attach the clearinghouse acceptance report.",
    checklist: ["Signed appeal letter", "Clearinghouse acceptance report"],
  });
  const joined = evidence.join("\n");
  assert.match(joined, /Delta Dental/);
  assert.match(joined, /Appeal level: 2 \(a previous appeal/);
  assert.match(joined, /CARC 29/);
  assert.match(joined, /D2740 — Crown/);
  assert.match(joined, /Clearinghouse acceptance report/);
});

test("evidence says so plainly when the denial names no procedure", () => {
  const evidence = describeEvidence({
    level: 1,
    payerName: "Cigna Dental",
    procedureCode: null,
    procedureDescription: null,
    carcCode: "16",
    carcDescription: "Claim lacks information",
    guidance: "",
    checklist: [],
  });
  assert.ok(evidence.some((line) => line.includes("not identified on the denial")));
});

// ── The letter asserts only what is on file ────────────────────────────────────────────────────
//
// This module's header calls an appeal "a factual assertion to a payer about a patient's care".
// That is precisely why the DEFAULT paragraph may not make one. It read "This procedure was
// clinically necessary and appropriately documented" — Mermaid assesses neither, and the checklist
// printed two lines below is the list a human must go and gather, so the letter attested to
// documentation in the same breath as asking for it.
//
// A named human approves before anything is sent. They were approving a pre-written claim about
// care, not making one, and a human gate is not a licence for the default to overstate.

const FACTUAL_CTX = {
  level: 1,
  payerName: "Delta Dental",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  claimControlNumber: "MRM-000123",
  serviceDate: "2026-07-27",
  procedureCode: "D2750",
  carcCode: "197",
  carcDescription: "Pre-authorization absent",
  deniedAmount: cents(1125),
  guidance: "Cite the clinical urgency.",
  providerName: "MERMAID DEMO DENTAL",
};

test("the default paragraph asserts no clinical judgement and no documentary one", () => {
  const letter = draftAppeal(FACTUAL_CTX).letter;

  assert.match(
    letter,
    /We are asking Delta Dental to reconsider this determination on the basis of the records listed below\./
  );
  assert.doesNotMatch(letter, /clinically necessary/i, "nothing here assesses clinical necessity");
  assert.doesNotMatch(letter, /appropriately documented/i, "and nothing knows what documentation exists");

  // The playbook's guidance still follows it — that is a known argument for the code, not a claim
  // about this patient's care, and it was not part of what was removed.
  assert.match(letter, /Cite the clinical urgency\./);
});

test("the enclosure list is named as what will accompany the appeal, not as what is attached", () => {
  /**
   * At draft time the list is a to-do — `recommendedAction` says "Gather the N evidence items, then
   * approve to send". "Enclosed with this appeal:" claimed attachment of things the workflow was
   * still asking for. "to accompany" is true at draft AND at send, so no new state is needed to
   * make it honest; the human approval gate already stands between the two moments.
   */
  const draft = draftAppeal(FACTUAL_CTX);

  assert.match(draft.letter, /Documentation to accompany this appeal:/);
  assert.doesNotMatch(draft.letter, /Enclosed with this appeal/i);
  assert.ok(draft.checklist.length > 0, "there is a list, and it is still printed");
  for (const item of draft.checklist) assert.ok(draft.letter.includes(item), `${item} must appear`);
});

test("an AI narrative replaces the argument and nothing else about what is claimed", () => {
  // The model owns one slot. It must not be able to reintroduce an enclosure claim or displace the
  // deterministic facts around it.
  const withAi = draftAppeal(FACTUAL_CTX, "This crown was placed after a fracture.").letter;

  assert.match(withAi, /This crown was placed after a fracture\./);
  assert.match(withAi, /Documentation to accompany this appeal:/, "the enclosure wording is not the AI's");
  assert.match(withAi, /Claim MRM-000123/);
  assert.doesNotMatch(withAi, /clinically necessary and appropriately documented/i);
});
