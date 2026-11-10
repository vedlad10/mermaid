/**
 * AI denial root-cause explanation (workflow S10/S13; Payer_Loop_Analysis §11).
 *
 * §11's exact position, which these tests encode: the CARC/RARC meaning is already fully solved
 * deterministically, so AI's honest value-add is synthesizing multi-code context and free-text
 * remarks into one plain-English sentence — "not decoding codes that are already decoded".
 *
 * The properties defended here:
 *   1. Nothing about the deterministic triage changes, whatever the model says or fails to say.
 *   2. The model gets the OTHER codes on the same claim, which is where the value is.
 *   3. It cannot state a number, and it cannot recommend an action.
 *   4. It never sees a patient.
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
  DenialNotFoundError,
  DenialService,
  InMemoryDenialRepository,
  NoExplainer,
  NoNarrator,
  createDenialExplainer,
  describeDenialContext,
  sanitizeExplanation,
  type DenialExplainer,
} from "../index.ts";

const NOW = new Date("2026-09-15T10:00:00Z");
const silent = createLogger(() => {});
const PROVIDER = { name: "MERMAID DEMO DENTAL" };

const SENTENCE =
  "The payer treated the crown as unauthorised because no pre-authorisation was on file when the " +
  "claim reached them, and the second line was bundled into it rather than considered separately.";

function explainerFrom(replies: ScriptedReply[], phiApproved = true) {
  const provider = new ScriptedProvider({ replies });
  const router = new LlmRouter({
    provider, phiApproved, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
  });
  return { explainer: createDenialExplainer(router, () => NOW), provider };
}

async function wired(explainer: DenialExplainer = NoExplainer) {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();
  const service = new DenialService(
    new InMemoryDenialRepository(), playbook, PROVIDER, bus, NoNarrator, explainer
  );
  return { service };
}

/** One claim, two unrelated reason codes — the multi-code case §11 is actually about. */
const twoReasons = (): VarianceDetectedBody => ({
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
  recoverableAmount: cents(1425),
  unexplainedAmount: cents(0),
  reasons: [
    { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
    { group: "CO", code: "16", description: "Claim lacks information", amount: cents(300), procedureCode: "D0220" },
  ],
  summary: "The payer withheld $1,425.00 across two reasons.",
});

async function denialFor(explainer: DenialExplainer) {
  const { service } = await wired(explainer);
  const views = await service.createFromVariance(twoReasons(), NOW);
  const focus = views.find((v) => v.denial.carcCode === "197")!;
  return { service, id: focus.denial.id, before: focus };
}

// ── 1. Narration changes nothing ──────────────────────────────────────────────────────

test("the deterministic triage is untouched by whatever the model says", async () => {
  const { explainer } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id, before } = await denialFor(explainer);

  await service.explain(id);

  const after = (await service.get(id, NOW))!;
  assert.deepEqual(after.denial.triage, before.denial.triage, "the frozen triage must not move");
  assert.equal(after.recommendedAction, before.recommendedAction);
  assert.equal(after.denial.status, before.denial.status);
  assert.equal(after.denial.deniedAmount, before.denial.deniedAmount);
  // And nothing was written to the audit trail — explaining is not an action.
  assert.equal(after.denial.audit.length, before.denial.audit.length);
});

test("an explanation is not persisted — it is a reading aid, regenerated on request", async () => {
  const { explainer } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id } = await denialFor(explainer);

  await service.explain(id);
  const stored = (await service.get(id, NOW))!;
  assert.equal(Object.hasOwn(stored.denial as object, "explanation"), false);
});

// ── 2. Multi-code context ─────────────────────────────────────────────────────────────

test("the model is given the OTHER reason codes on the same claim — that is the value-add", async () => {
  const { explainer, provider } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id } = await denialFor(explainer);

  await service.explain(id);

  const prompt = provider.calls[0]!.prompt;
  assert.match(prompt, /Reason being explained: CARC 197/);
  assert.match(prompt, /Other reasons the payer gave on this same claim/);
  assert.match(prompt, /CARC 16/);
  assert.match(prompt, /D0220/);
  // The focus reason is not repeated in its own sibling list.
  assert.equal((prompt.match(/CARC 197/g) ?? []).length, 1);
});

test("a lone reason code says so, rather than leaving the model to imagine siblings", async () => {
  const { explainer, provider } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service } = await wired(explainer);
  const [only] = await service.createFromVariance(
    {
      ...twoReasons(),
      reasons: [
        { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
      ],
    },
    NOW
  );
  await service.explain(only!.denial.id);
  assert.match(provider.calls[0]!.prompt, /This was the only reason the payer gave on this claim/);
});

test("the payer's OWN adjustment group is sent, never assumed to be CO", async () => {
  // A recoverable denial is not always CO: `categorizeAdjustment` makes PI-group adjustments
  // recoverable too, so a payer-initiated reduction reaches this module looking exactly like a
  // contractual one. Telling the model "group CO" about it would be a false statement about whose
  // decision the reduction was — and an earlier version of `toReason` hardcoded exactly that.
  const { explainer, provider } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service } = await wired(explainer);
  const [view] = await service.createFromVariance(
    {
      ...twoReasons(),
      postingId: "post-pi",
      reasons: [
        { group: "PI", code: "197", description: "Pre-authorization absent", amount: cents(900), procedureCode: "D2750" },
      ],
    },
    NOW
  );

  assert.equal(view!.denial.carcGroup, "PI");
  await service.explain(view!.denial.id);
  assert.match(provider.calls[0]!.prompt, /\[group PI\]/);
  assert.doesNotMatch(provider.calls[0]!.prompt, /\[group CO\]/);
});

test("a denial predating the group being recorded omits it rather than guessing", () => {
  const evidence = describeDenialContext({
    payerName: "Delta Dental",
    focus: { carcCode: "197", carcDescription: "Pre-authorization absent", group: null, procedureCode: "D2750", remarks: [] },
    siblings: [],
    disposition: "appeal",
  });
  const joined = evidence.join("\n");
  assert.match(joined, /CARC 197 — Pre-authorization absent/);
  assert.doesNotMatch(joined, /group/);
});

test("the disposition is given so the sentence cannot contradict the screen", async () => {
  const { explainer, provider } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id } = await denialFor(explainer);
  await service.explain(id);
  assert.match(provider.calls[0]!.prompt, /The practice has already decided how to handle this: appeal\./);
});

// ── 3. What may not reach a provider, and what may not come back ──────────────────────

test("no patient identity reaches the provider", async () => {
  const { explainer, provider } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id } = await denialFor(explainer);
  await service.explain(id);

  const sent = `${provider.calls[0]!.system}\n${provider.calls[0]!.prompt}`;
  for (const phi of ["Ada", "Alpha", "MET30066", "MRM-000456", "2026-09-01", "1,125", "1125"]) {
    assert.doesNotMatch(sent, new RegExp(phi), `"${phi}" must never reach a provider`);
  }
});

test("it works with no BAA in place, because it never had anything to disclose", async () => {
  const { explainer } = explainerFrom([{ kind: "text", text: SENTENCE }], false);
  const { service, id } = await denialFor(explainer);
  assert.ok(await service.explain(id));
});

test("an explanation stating any number is refused — the figures beside it are already exact", () => {
  assert.equal(sanitizeExplanation("The payer paid $0 on the crown because no pre-auth was on file."), null);
  assert.equal(sanitizeExplanation("The payer withheld 1125 dollars for a missing pre-authorisation here."), null);
  assert.equal(sanitizeExplanation("The annual maximum of 1500 was already exhausted before this claim arrived."), null);
  assert.equal(sanitizeExplanation("They reduced the allowance by 20 percent under the plan's schedule."), null);
});

test("a bare number is not mistaken for a code — the guard's original hole", () => {
  // The first version of the sanitizer stripped any 1–5 digit run as "possibly a code", so the
  // sentence below lost "1125" before the digit check ran and sailed through. The guard was inert
  // against the exact output it exists to refuse. A code must now be identified as one.
  assert.equal(sanitizeExplanation("The payer withheld 1125 dollars for a missing pre-authorisation here."), null);
  assert.equal(sanitizeExplanation("The remaining annual maximum was 375 when this claim was adjudicated."), null);
  assert.equal(sanitizeExplanation("Only 2 of the submitted lines were considered by the payer at all."), null);
});

test("naming a reason or procedure code is not stating a figure", () => {
  const text =
    "CARC 197 fired because no pre-authorisation was on file for D2750 when the claim arrived, and " +
    "the payer bundled the radiograph into it.";
  assert.equal(sanitizeExplanation(text), text);
});

test("an explanation recommending an action is refused — the disposition is the playbook's", () => {
  assert.equal(sanitizeExplanation("No pre-auth was on file, so you should appeal this with the urgency note."), null);
  assert.equal(sanitizeExplanation("No pre-auth was on file. We recommend gathering the clinical narrative."), null);
  assert.equal(sanitizeExplanation("This is the kind of denial that should be appealed once documented."), null);
});

test("boilerplate and placeholders are refused", () => {
  assert.equal(sanitizeExplanation("This denial indicates that pre-authorisation was absent from the file."), null);
  assert.equal(sanitizeExplanation("Certainly, the payer refused because pre-authorisation was absent."), null);
  assert.equal(sanitizeExplanation("The payer refused because [reason] was absent from the submitted claim."), null);
  assert.equal(sanitizeExplanation("Too short."), null);
});

test("a clean sentence passes, whitespace collapsed", () => {
  assert.equal(sanitizeExplanation(`  ${SENTENCE}  `), SENTENCE);
});

test("a refused sentence shows nothing rather than something almost right", async () => {
  const { explainer } = explainerFrom([{ kind: "text", text: "The payer paid $0 on the crown, so you should appeal." }]);
  const { service, id } = await denialFor(explainer);
  assert.equal(await service.explain(id), null);
});

// ── 4. Degradation ────────────────────────────────────────────────────────────────────

for (const [label, replies] of [
  ["off", null],
  ["unavailable", [{ kind: "error", code: "unavailable" }]],
  ["rate-limited", [{ kind: "error", code: "rate_limited" }]],
  ["hung", [{ kind: "hang" }]],
  ["empty", [{ kind: "text", text: "" }]],
] as [string, ScriptedReply[] | null][]) {
  test(`when the provider is ${label}, explain() returns null and the denial is unchanged`, async () => {
    const explainer = replies
      ? explainerFrom(replies).explainer
      : createDenialExplainer(
          new LlmRouter({
            provider: null, phiApproved: false, timeoutMs: 50, maxAttempts: 1, backoffMs: 1, sleep: async () => {},
          }),
          () => NOW
        );
    const { service, id, before } = await denialFor(explainer);

    assert.equal(await service.explain(id), null);
    const after = (await service.get(id, NOW))!;
    assert.equal(after.recommendedAction, before.recommendedAction);
    assert.deepEqual(after.denial.triage, before.denial.triage);
  });
}

test("an explainer that throws cannot break the denial screen", async () => {
  const broken: DenialExplainer = {
    async explain() {
      throw new Error("a future explainer is less careful than this one");
    },
  };
  const { service, id } = await denialFor(broken);
  assert.equal(await service.explain(id), null);
});

test("explaining an unknown denial is a not-found, not a silent null", async () => {
  const { service } = await wired(explainerFrom([{ kind: "text", text: SENTENCE }]).explainer);
  await assert.rejects(() => service.explain("nope"), DenialNotFoundError);
});

// ── 5. Provenance and the evidence panel ──────────────────────────────────────────────

test("the explanation carries its provider, model and the exact facts it was given", async () => {
  const { explainer } = explainerFrom([{ kind: "text", text: SENTENCE }]);
  const { service, id } = await denialFor(explainer);

  const explanation = (await service.explain(id))!;
  assert.equal(explanation.text, SENTENCE);
  assert.equal(explanation.provider, "scripted");
  assert.equal(explanation.model, "scripted-1");
  assert.equal(explanation.generatedAt, NOW.toISOString());
  assert.ok(explanation.evidence.some((line) => line.includes("CARC 197")));
  assert.ok(explanation.evidence.some((line) => line.includes("CARC 16")));
});

test("describeDenialContext is both the prompt and the panel — one source, no drift", () => {
  const evidence = describeDenialContext({
    payerName: "Delta Dental",
    focus: {
      carcCode: "29",
      carcDescription: "Time limit for filing has expired",
      group: "CO",
      procedureCode: "D2740",
      remarks: ["N30: Recipient ineligible for this service"],
    },
    siblings: [],
    disposition: "correct_resubmit",
  });
  const joined = evidence.join("\n");
  assert.match(joined, /Delta Dental/);
  assert.match(joined, /CARC 29 \[group CO\]/);
  assert.match(joined, /D2740 \(Crown/);
  // The free-text remarks §11 names as the honest value-add.
  assert.match(joined, /Payer remarks: N30/);
  assert.match(joined, /correct resubmit/);
});

test("a claim-level reason says so rather than naming a procedure it does not have", () => {
  const evidence = describeDenialContext({
    payerName: "Cigna Dental",
    focus: { carcCode: "16", carcDescription: "Claim lacks information", group: "CO", procedureCode: null, remarks: [] },
    siblings: [],
    disposition: "appeal",
  });
  assert.match(evidence.join("\n"), /at the claim level/);
});
