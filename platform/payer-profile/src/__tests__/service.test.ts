/**
 * Payer-profile tests — rule resolution and the learning behaviour.
 *
 * The learning assertions matter more than they look. A recommendation engine that swings on one
 * outcome, or that reaches 0% / 100% certainty, will be trusted exactly once and then ignored
 * forever. The prior floor and the small-sample gate are what make the number safe to act on, and
 * they are what these tests protect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPlaybookRepository, PAYER_CATALOG, PayerProfileService, TRUST_THRESHOLD, sourcedWindow } from "../index.ts";

async function brain() {
  const repo = new InMemoryPlaybookRepository();
  const service = new PayerProfileService(repo);
  await service.ensureDefaults();
  return { repo, service };
}

test("the default playbook seeds once and is idempotent", async () => {
  const { repo, service } = await brain();
  const first = repo.size;
  assert.ok(first > 0);
  assert.equal(await service.ensureDefaults(), 0, "a second boot must not duplicate rules");
  assert.equal(repo.size, first);
});

test("a known code resolves to its playbook disposition and action", async () => {
  const { service } = await brain();
  const rule = await service.resolve(null, "16", "D2750", "CO");

  assert.equal(rule.disposition, "correct_resubmit");
  assert.equal(rule.pursuable, true);
  assert.match(rule.recommendedAction, /correct it, and resubmit/);
  assert.equal(rule.source, "default-rule");
  assert.equal(rule.carcDescription, "Missing or invalid information");
});

test("the most specific rule wins: payer + procedure family beats a global code rule", async () => {
  const { repo, service } = await brain();
  // CO-50 has two seeded rules (D2 crowns, D4 perio) — the procedure decides.
  assert.match((await service.resolve(null, "50", "D2750", "CO")).guidance, /Crowns and buildups/);
  assert.match((await service.resolve(null, "50", "D4341", "CO")).guidance, /root planing/);

  // A payer-specific rule outranks both.
  await repo.upsertRule({
    payerId: "delta-dental",
    carcCode: "50",
    cdtPrefix: "",
    disposition: "verify_writeoff",
    recommendedAction: "Delta never overturns these.",
    guidance: "",
    overturnRate: 0.05,
    wonCount: 1,
    sampleSize: 30,
    trusted: true,
  });
  const delta = await service.resolve("delta-dental", "50", "D2750", "CO");
  assert.equal(delta.disposition, "verify_writeoff");
  assert.equal(delta.source, "payer-learned");

  // …and only for that payer.
  assert.equal((await service.resolve("cigna-dental", "50", "D2750", "CO")).disposition, "appeal");
});

test("an unrecognized code still gets a safe disposition from its CARC category", async () => {
  const { service } = await brain();
  const unknown = await service.resolve(null, "999", "D2750", "CO");

  assert.equal(unknown.source, "carc-category");
  assert.equal(unknown.disposition, "appeal", "unknown withheld money defaults to worth a look");
  assert.equal(unknown.pursuable, true);
  assert.ok(unknown.recommendedAction.length > 0, "a denial with no recommendation is one nobody works");
});

test("a contractual code is never presented as pursuable", async () => {
  const { service } = await brain();
  const contractual = await service.resolve(null, "45", null, "CO");
  assert.equal(contractual.disposition, "post_normal");
  assert.equal(contractual.pursuable, false);
});

test("a benefit-maximum code routes to the patient, not to an appeal", async () => {
  const { service } = await brain();
  const maxed = await service.resolve(null, "119", null, "CO");
  assert.equal(maxed.disposition, "patient_resp");
  assert.equal(maxed.pursuable, false);
});

/**
 * The CAS group decides the answer, and it used to be hardcoded to `CO`.
 *
 * The same CARC means different things depending on whose decision the reduction was. A payer's own
 * reduction (`PI`) is not a contract term, so a fee-schedule code under `PI` is worth questioning
 * rather than posting and forgetting — `categorizeAdjustment` has always said so, and this
 * derivation was the one caller that never asked it the real question.
 */
test("the same code under a different CAS group is triaged differently", async () => {
  const { service } = await brain();

  // CARC 45 is contractual by nature. Under CO that is a write-off nobody should chase.
  const contractual = await service.resolve(null, "45", null, "CO");
  assert.equal(contractual.disposition, "post_normal");
  assert.equal(contractual.pursuable, false);

  // The identical code under PI is the payer's OWN reduction, not a contract term.
  const payerInitiated = await service.resolve(null, "45", null, "PI");
  assert.equal(payerInitiated.disposition, "appeal", "a PI reduction is not a contractual write-off");
  assert.equal(payerInitiated.pursuable, true);
});

test("a PR-group code is the patient's balance, never a write-off", async () => {
  const { service } = await brain();
  const patient = await service.resolve(null, "45", null, "PR");
  assert.equal(patient.disposition, "patient_resp");
  assert.equal(patient.pursuable, false);
});

test("an unknown group is not read as CO — it falls to the recoverable default", async () => {
  const { service } = await brain();
  // Null is how a caller says "the group was never recorded" (as `Denial.carcGroup` already does).
  // Guessing CO here is exactly the defect: it turned every ungrouped denial into a contract term.
  const unknownGroup = await service.resolve(null, "45", null, null);
  assert.equal(unknownGroup.disposition, "appeal");
  assert.equal(unknownGroup.pursuable, true, "money we did not receive goes in front of a person");
});

// ── Learning ──────────────────────────────────────────────────────────────────────────

test("recording an outcome creates a PAYER-specific rule, leaving the global default alone", async () => {
  const { service } = await brain();
  const before = await service.resolve(null, "197", null, "CO");

  await service.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });

  const global = await service.resolve(null, "197", null, "CO");
  assert.equal(global.overturnRate, before.overturnRate, "one payer's behaviour must not rewrite everyone's default");

  const payer = await service.resolve("metlife-dental", "197", "D2750", "CO");
  assert.ok(payer.overturnRate > before.overturnRate, "winning moved this payer's rate up");
  assert.equal(payer.sampleSize, 1);
});

test("a win moves the rate up and a loss moves it down", async () => {
  const { service } = await brain();
  const start = (await service.resolve(null, "29", null, "CO")).overturnRate;

  await service.recordOutcome({ payerId: "p-win", carcCode: "29", cdtCode: null, won: true });
  await service.recordOutcome({ payerId: "p-loss", carcCode: "29", cdtCode: null, won: false });

  assert.ok((await service.resolve("p-win", "29", null, "CO")).overturnRate > start);
  assert.ok((await service.resolve("p-loss", "29", null, "CO")).overturnRate < start);
});

test("a rate is provisional until the sample clears the trust threshold", async () => {
  const { service } = await brain();
  for (let i = 0; i < TRUST_THRESHOLD - 1; i++) {
    await service.recordOutcome({ payerId: "slow", carcCode: "151", cdtCode: null, won: true });
  }
  const provisional = await service.resolve("slow", "151", null, "CO");
  assert.equal(provisional.trusted, false);
  assert.equal(provisional.sampleSize, TRUST_THRESHOLD - 1);
  assert.ok(provisional.explain.some((e) => /provisional/.test(e)));

  await service.recordOutcome({ payerId: "slow", carcCode: "151", cdtCode: null, won: true });
  const trusted = await service.resolve("slow", "151", null, "CO");
  assert.equal(trusted.trusted, true);
  assert.ok(trusted.explain.some((e) => /trusted/.test(e)));
});

test("one outcome NUDGES the rate — it does not lurch", async () => {
  // The failure this guards against was real: under a fixed 25/75 blend a single won appeal moved a
  // code from 30% to 83%, because with one observation the "observed mean" is necessarily 0 or 1.
  const { service } = await brain();
  const prior = (await service.resolve("nudge", "197", null, "CO")).overturnRate;

  await service.recordOutcome({ payerId: "nudge", carcCode: "197", cdtCode: null, won: true });
  const afterOne = (await service.resolve("nudge", "197", null, "CO")).overturnRate;

  assert.ok(afterOne > prior, "one win moves the rate up");
  assert.ok(
    afterOne - prior < 0.1,
    `one observation must not swing the rate more than ~10 points (${prior} → ${afterOne})`
  );
});

test("evidence progressively outweighs the prior", async () => {
  const { service } = await brain();
  const prior = (await service.resolve("curve", "197", null, "CO")).overturnRate;
  const seen: number[] = [];
  for (let i = 1; i <= 50; i++) {
    await service.recordOutcome({ payerId: "curve", carcCode: "197", cdtCode: null, won: true });
    if (i === 1 || i === 20 || i === 50) seen.push((await service.resolve("curve", "197", null, "CO")).overturnRate);
  }
  const [afterOne, afterTwenty, afterFifty] = seen as [number, number, number];

  assert.ok(afterOne > prior && afterOne < 0.45, "one win: a nudge");
  assert.ok(afterTwenty > 0.6, "twenty wins: evidence dominates");
  assert.ok(afterFifty > afterTwenty, "and it keeps converging");
  assert.ok(afterFifty < 1, "but never promises certain recovery");
});

test("an unbroken losing streak never reaches zero", async () => {
  const { service } = await brain();
  for (let i = 0; i < 50; i++) {
    await service.recordOutcome({ payerId: "unlucky", carcCode: "16", cdtCode: null, won: false });
  }
  const rate = (await service.resolve("unlucky", "16", null, "CO")).overturnRate;
  assert.ok(rate > 0, "a rate of exactly zero would silently hide a recoverable code forever");
  assert.ok(rate < 0.2, "but fifty losses should make it clearly not worth chasing");
});

test("one outlier cannot swing a well-established rate", async () => {
  const { service } = await brain();
  for (let i = 0; i < 40; i++) {
    await service.recordOutcome({ payerId: "steady", carcCode: "16", cdtCode: null, won: true });
  }
  const established = (await service.resolve("steady", "16", null, "CO")).overturnRate;

  await service.recordOutcome({ payerId: "steady", carcCode: "16", cdtCode: null, won: false });
  const afterOutlier = (await service.resolve("steady", "16", null, "CO")).overturnRate;

  assert.ok(established - afterOutlier < 0.03, "a single loss must not move a 40-sample rate materially");
});

test("every resolution explains itself in plain English", async () => {
  const { service } = await brain();
  for (const [carc, cdt] of [["16", "D2750"], ["50", "D4341"], ["999", null]] as const) {
    const rule = await service.resolve(null, carc, cdt, "CO");
    assert.ok(rule.explain.length >= 2, `${carc} produced no explanation`);
    for (const line of rule.explain) assert.ok(line.trim().length > 0);
  }
});

// ── Payer accuracy: where the loop reaches the front half (M11) ────────────────────────────────
//
// These protect a property that is easy to break and hard to notice: an unproven payer must have
// NO effect on a verification, not a neutral one. The confidence report is an average, so a
// component of 1.0 for "we know nothing about this payer" would quietly raise the score of every
// verification of every unfamiliar payer — the opposite of what ignorance should do.

test("a payer with no recorded outcomes contributes nothing to confidence", async () => {
  const { service } = await brain();
  const accuracy = await service.payerAccuracy("never-seen");

  assert.equal(accuracy.confidence, null, "no evidence must mean no component, not a neutral one");
  assert.equal(accuracy.observations, 0);
  assert.equal(accuracy.trusted, false);
  assert.match(accuracy.explanation, /No appeal outcomes recorded/);
});

test("an unidentified payer contributes nothing either", async () => {
  const { service } = await brain();
  const accuracy = await service.payerAccuracy(null);

  assert.equal(accuracy.confidence, null);
  assert.match(accuracy.explanation, /No payer was identified/);
});

test("below the trust threshold the track record still contributes nothing", async () => {
  const { service } = await brain();
  for (let i = 0; i < TRUST_THRESHOLD - 1; i++) {
    await service.recordOutcome({ payerId: "sparse", carcCode: "16", cdtCode: null, won: true });
  }
  const accuracy = await service.payerAccuracy("sparse");

  assert.equal(accuracy.observations, TRUST_THRESHOLD - 1);
  assert.equal(accuracy.confidence, null, "human-in-the-loop §9's sanity gate applies to the front half too");
  assert.equal(accuracy.trusted, false);
});

test("at the trust threshold the track record starts to count, and explains itself", async () => {
  const { service } = await brain();
  for (let i = 0; i < TRUST_THRESHOLD; i++) {
    await service.recordOutcome({ payerId: "proven", carcCode: "16", cdtCode: null, won: true });
  }
  const accuracy = await service.payerAccuracy("proven");

  assert.equal(accuracy.observations, TRUST_THRESHOLD);
  assert.equal(accuracy.trusted, true);
  assert.ok(accuracy.confidence !== null, "at the threshold the evidence must start to count");
  assert.equal(accuracy.overturnShare, 1);
  assert.match(accuracy.explanation, /overturned/);
  assert.match(accuracy.explanation, new RegExp(`${TRUST_THRESHOLD} recorded outcomes`));
});

test("a payer whose refusals never hold up scores lower than one whose refusals do", async () => {
  const { service } = await brain();
  for (let i = 0; i < TRUST_THRESHOLD; i++) {
    // Every denial reversed on appeal — this payer's own decisions are routinely wrong.
    await service.recordOutcome({ payerId: "unreliable", carcCode: "16", cdtCode: null, won: true });
    // Every appeal lost — this payer's denials hold up.
    await service.recordOutcome({ payerId: "reliable", carcCode: "16", cdtCode: null, won: false });
  }

  const unreliable = await service.payerAccuracy("unreliable");
  const reliable = await service.payerAccuracy("reliable");

  assert.ok(unreliable.confidence! < reliable.confidence!, "being wrong more often must cost confidence");
  assert.equal(reliable.confidence, 1, "a payer that is never reversed carries no penalty");
});

test("the track record's influence is bounded — it can never alone force a review", async () => {
  const { service } = await brain();
  for (let i = 0; i < 200; i++) {
    await service.recordOutcome({ payerId: "worst", carcCode: "16", cdtCode: null, won: true });
  }
  const worst = await service.payerAccuracy("worst");

  assert.ok(worst.confidence! >= 0.75, "the worst possible track record must still be floored");

  // The bound is asserted against the components a REAL verification actually produces, not against
  // a hypothetical perfect one. That distinction is the whole test: an earlier version of this
  // checked four components of 1.0, concluded a 0.6 floor was safe, and shipped a change that sent
  // every verification of a well-evidenced payer to a human. Confidence aggregates weakest-link, so
  // a clean baseline is exactly the case that hides the problem.
  const REPRESENTATIVE = [0.75, 0.95, 0.76, 1.0]; // card · payer id · benefits · patient data
  const withPayer = [...REPRESENTATIVE, worst.confidence!];
  const avg = withPayer.reduce((a, b) => a + b, 0) / withPayer.length;
  const min = Math.min(...withPayer);
  const overall = avg * 0.6 + min * 0.4;

  assert.ok(overall > 0.75, `a bad payer alone must not push a sound verification under review (got ${overall})`);
  // ...and it must still cost something, or the term is decorative.
  const baseAvg = REPRESENTATIVE.reduce((a, b) => a + b, 0) / REPRESENTATIVE.length;
  const base = baseAvg * 0.6 + Math.min(...REPRESENTATIVE) * 0.4;
  assert.ok(overall < base, "a bad track record must actually lower confidence");
});

// ── The payer catalog (M12) ────────────────────────────────────────────────────────────────────
//
// `payers` has carried filing_window_days since migration 0004 and stood empty since, while the
// claims deadline engine kept its own hardcoded copy. These protect the fact that the table is now
// the source of truth — and that "the catalog does not know" stays distinguishable from a number,
// because a claim whose deadline is silently wrong is unrecoverable revenue.

test("the payer catalog seeds once and is idempotent", async () => {
  const { service } = await brain();
  const again = await service.ensurePayers();
  assert.equal(again, 0, "ensureDefaults already seeded the catalog; a second call must not duplicate");
  assert.equal(await service.filingWindowDays("aetna-dental"), 90);
});

test("a catalogued payer's filing window comes from the catalog, not from a constant", async () => {
  const { service } = await brain();

  // These differ from each other, so a lookup that silently returned one default would show up.
  assert.equal(await service.filingWindowDays("delta-dental"), 365);
  assert.equal(await service.filingWindowDays("aetna-dental"), 90);
  // UHC was the third here; since B-1 it shares Aetna's 90, so Guardian keeps the three distinct.
  assert.equal(await service.filingWindowDays("guardian-dental"), 180);
});

test("an uncatalogued payer returns null — 'I do not know' is not the same as a default", async () => {
  const { service } = await brain();
  assert.equal(await service.filingWindowDays("never-heard-of-it"), null);
  assert.equal(await service.filingWindowDays(null), null);
});

test("editing a payer's window changes it, with no code change", async () => {
  const { repo, service } = await brain();

  assert.equal(await service.filingWindowDays("delta-dental"), 365);
  await repo.upsertPayer({
    slug: "delta-dental",
    name: "Delta Dental",
    filingWindowDays: 120,
    appealWindowDays: 180,
  });

  assert.equal(
    await service.filingWindowDays("delta-dental"),
    120,
    "the whole point of moving this into the catalog is that a practice can change it"
  );
});

// ── B-1 — Aetna's windows are SOURCED, and existing databases are corrected ────────────────────
//
// The catalog shipped Aetna at 180 filing / 60 appeal as "common defaults". Aetna's own documents
// say 90 and 180. Both guesses cost money, in opposite directions. These pin the sourced values,
// the rule that a citation belongs to a NUMBER, and the narrow path by which an already-seeded
// database loses the old guess without losing anybody's edit.

test("B-1: Aetna is catalogued at its published 90-day filing and 180-day appeal windows", async () => {
  const { service } = await brain();
  assert.equal(await service.filingWindowDays("aetna-dental"), 90);
  assert.equal(await service.appealWindowDays("aetna-dental"), 180);
});

test("B-1: both Aetna windows cite Aetna's own documents, and the quote contains the number", () => {
  const filing = sourcedWindow("aetna-dental", "filing", 90)!;
  const appeal = sourcedWindow("aetna-dental", "appeal", 180)!;

  assert.ok(filing && appeal);
  assert.match(filing.url, /^https:\/\/app-iaem\.aetna\.com\/.*ppo-office-guide\.pdf$/);
  assert.match(filing.quote, /no later than 90 days after the date\s+of service/);
  assert.match(filing.document, /Dental Office Guide/);
  assert.match(appeal.url, /^https:\/\/www\.aetnadental\.com\//);
  assert.match(appeal.quote, /within 180 days from the receipt of the adverse decision/);
  assert.match(appeal.quote, /unless otherwise required by contract or state requirement/, "the payer's own qualifier is kept");
  for (const s of [filing, appeal]) assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test("B-1: a citation belongs to the number — any other figure for Aetna is an estimate", () => {
  assert.equal(sourcedWindow("aetna-dental", "filing", 180), null, "the old guess is not Aetna's term");
  assert.equal(sourcedWindow("aetna-dental", "appeal", 60), null, "the old guess is not Aetna's term");
  assert.equal(sourcedWindow("aetna-dental", "filing", 120), null, "a practice's own number is not Aetna's either");
  assert.equal(sourcedWindow("aetna-dental", "filing", null), null);
  assert.equal(sourcedWindow(null, "filing", 90), null);
});

test("B-1: every payer other than Aetna is still unsourced", () => {
  for (const p of PAYER_CATALOG.filter((p) => p.slug !== "aetna-dental")) {
    assert.equal(sourcedWindow(p.slug, "filing", p.filingWindowDays), null, `${p.slug} filing`);
    assert.equal(sourcedWindow(p.slug, "appeal", p.appealWindowDays), null, `${p.slug} appeal`);
  }
});

test("B-1: the service answers for exactly the window it is asked about", async () => {
  const { service } = await brain();
  assert.equal(service.sourceOfWindow("aetna-dental", "filing", 90)?.publisher, "Aetna Dental");
  assert.equal(service.sourceOfWindow("aetna-dental", "filing", 180), null);
  assert.equal(service.sourceOfWindow("delta-dental", "filing", 365), null);
});

test("B-1: a database still holding Mermaid's old Aetna guesses is corrected on the next boot", async () => {
  /**
   * Every database seeded before B-1 — staging among them — holds Aetna at 180/60, and
   * `ensurePayers` leaves existing rows alone. Without this path the correction would only ever
   * reach a fresh database.
   */
  const { repo, service } = await brain();
  const seeded = (await repo.findPayer("aetna-dental"))!;
  await repo.upsertPayer({ ...seeded, filingWindowDays: 180, appealWindowDays: 60 });

  assert.equal(await service.ensurePayers(), 1, "the stale row is rewritten once");
  assert.equal(await service.filingWindowDays("aetna-dental"), 90);
  assert.equal(await service.appealWindowDays("aetna-dental"), 180);
  const after = (await repo.findPayer("aetna-dental"))!;
  assert.equal(after.clearinghouseId, seeded.clearinghouseId, "nothing else about the row moves");
  assert.deepEqual(after.aliases, seeded.aliases);

  assert.equal(await service.ensurePayers(), 0, "and the correction is idempotent");
});

test("B-1: each stale window is corrected on its own — one guess replaced, one edit kept", async () => {
  const { repo, service } = await brain();
  const seeded = (await repo.findPayer("aetna-dental"))!;
  // The filing window is still the old guess; the appeal window is a practice's negotiated 150.
  await repo.upsertPayer({ ...seeded, filingWindowDays: 180, appealWindowDays: 150 });

  await service.ensurePayers();
  assert.equal(await service.filingWindowDays("aetna-dental"), 90, "the guess is replaced");
  assert.equal(await service.appealWindowDays("aetna-dental"), 150, "the edit survives");
});

test("B-1: an administrator's own Aetna window is never overwritten by the correction", async () => {
  const { repo, service } = await brain();
  const seeded = (await repo.findPayer("aetna-dental"))!;
  await repo.upsertPayer({ ...seeded, filingWindowDays: 120, appealWindowDays: 90 });

  assert.equal(await service.ensurePayers(), 0);
  assert.equal(await service.filingWindowDays("aetna-dental"), 120);
  assert.equal(await service.appealWindowDays("aetna-dental"), 90);
});

test("B-1: the correction is Aetna's alone — another payer holding the same numbers is untouched", async () => {
  const { repo, service } = await brain();
  const guardian = (await repo.findPayer("guardian-dental"))!;
  await repo.upsertPayer({ ...guardian, filingWindowDays: 180, appealWindowDays: 60 });

  assert.equal(await service.ensurePayers(), 0);
  assert.equal(await service.filingWindowDays("guardian-dental"), 180);
  assert.equal(await service.appealWindowDays("guardian-dental"), 60);
});

// ── "Delta Dental" is not one payer ───────────────────────────────────────────────────────────

test("a fresh catalog routes named Delta companies to their own ids and a bare 'Delta Dental' to none", async () => {
  /**
   * Stedi's payer network, 2026-10-15: 77777 is Delta Dental of California (CA only); New Jersey is
   * 22189, New York 11198, Oregon CDOR1. Every Delta card used to route to 77777.
   */
  const { repo } = await brain();
  assert.equal((await repo.findPayer("delta-dental"))!.clearinghouseId, undefined, "no company is guessed");
  assert.equal((await repo.findPayer("delta-dental-ca"))!.clearinghouseId, "77777");
  assert.equal((await repo.findPayer("delta-dental-nj"))!.clearinghouseId, "22189");
  assert.equal((await repo.findPayer("delta-dental-ny"))!.clearinghouseId, "11198");
  assert.equal((await repo.findPayer("delta-dental-or"))!.clearinghouseId, "CDOR1");
});

test("a database still routing every Delta card to California has that retired on the next boot, once", async () => {
  const { repo, service } = await brain();
  const generic = (await repo.findPayer("delta-dental"))!;
  await repo.upsertPayer({ ...generic, clearinghouseId: "77777" }); // what every older database holds

  assert.equal(await service.ensurePayers(), 1);
  const after = (await repo.findPayer("delta-dental"))!;
  assert.equal(after.clearinghouseId, undefined);
  assert.deepEqual(after.aliases, generic.aliases, "nothing else about the row moves");
  assert.equal(await service.ensurePayers(), 0, "idempotent");
});

test("an id an administrator set on 'Delta Dental' survives — only the catalog's own old guess is retired", async () => {
  const { repo, service } = await brain();
  const generic = (await repo.findPayer("delta-dental"))!;
  await repo.upsertPayer({ ...generic, clearinghouseId: "22189" }); // a NJ practice naming its local Delta

  assert.equal(await service.ensurePayers(), 0);
  assert.equal((await repo.findPayer("delta-dental"))!.clearinghouseId, "22189");
});

test("retiring the old id is not undone when the same boot also fills a missing alias set", async () => {
  const { repo, service } = await brain();
  const generic = (await repo.findPayer("delta-dental"))!;
  await repo.upsertPayer({ ...generic, clearinghouseId: "77777", aliases: [] });

  await service.ensurePayers();
  const after = (await repo.findPayer("delta-dental"))!;
  assert.equal(after.clearinghouseId, undefined, "the alias fill must not write 77777 back");
  assert.ok((after.aliases ?? []).length > 0);
});

test("MetLife filed under its alias is moved to Stedi's primary id in ONE boot, counted once", async () => {
  /**
   * 65978 is an alias of MetLife Dental Family; Stedi's primary is 10134, and only the primary is
   * answered by Stedi's test-mode mock (AAA 79 otherwise). Retire-then-fill must not take two boots.
   */
  const { repo, service } = await brain();
  const seeded = (await repo.findPayer("metlife-dental"))!;
  assert.equal(seeded.clearinghouseId, "10134", "a fresh database gets the primary id");
  await repo.upsertPayer({ ...seeded, clearinghouseId: "65978" }); // what every older database holds

  assert.equal(await service.ensurePayers(), 1, "one row changed");
  assert.equal((await repo.findPayer("metlife-dental"))!.clearinghouseId, "10134");
  assert.equal(await service.ensurePayers(), 0, "idempotent");
});
