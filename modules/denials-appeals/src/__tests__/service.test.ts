/**
 * Denials & Appeals service tests.
 *
 * The gate tests carry the most weight. An appeal is a factual assertion to a payer about a
 * patient's care — if any path here could send one without a named human having approved it, the
 * module has failed its central obligation, and no amount of correct triage would compensate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import { InMemoryPlaybookRepository, PayerProfileService } from "@mermaid/payer-profile";
import type { VarianceDetectedBody } from "@mermaid/events";
import {
  APPEAL_WINDOWS_ARE_PAYER_SOURCED,
  ASSUMED_APPEAL_WINDOW_LABEL,
  appealWindowNote,
  catalogedAppealWindowLabel,
  DenialActionError,
  DenialNotFoundError,
  DenialService,
  IncompleteAppealError,
  InMemoryDenialRepository,
  buildDenialView,
  buildRecoveryStats,
  draftAppeal,
  scoreDenial,
} from "../index.ts";

const NOW = new Date("2026-09-15T10:00:00Z");
const silent = createLogger(() => {});
const PROVIDER = { name: "MERMAID DEMO DENTAL" };

async function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const playbookRepo = new InMemoryPlaybookRepository();
  const playbook = new PayerProfileService(playbookRepo);
  await playbook.ensureDefaults();
  const repo = new InMemoryDenialRepository();
  const service = new DenialService(repo, playbook, PROVIDER, bus);
  return { bus, repo, playbook, service };
}

/** A pre-auth denial on a crown — the canonical recoverable case from the M5 vertical. */
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
    {
      group: "CO",
      code: "197",
      description: "Pre-authorization absent",
      amount: cents(1125),
      procedureCode: "D2750",
    },
  ],
  summary: "The payer withheld $1,125.00 for a missing pre-authorization.",
  ...overrides,
});

const APPEAL_CONTEXT = {
  memberId: "MET30066",
  claimControlNumber: "MRM-000123",
  serviceDate: "2026-07-27",
};

/**
 * ── THE TIMEZONE MUST SURVIVE EVERY PATH TO A VIEW ─────────────────────────────────────────────
 * An appeal window is a calendar day in the practice's own day. The service takes the practice
 * timezone for exactly that reason — and then four of its return paths and the worklist row
 * builder dropped it, so the window fell back to UTC. For a US Pacific practice from late
 * afternoon onward, a deadline of "today" read `closed` with -1 days: the worklist told a biller
 * the window had passed on an appeal that was still filable for hours, and the view returned
 * right after drafting said the same. This pins the practice-day reading on both surfaces.
 */
test("the appeal window is counted in the practice's day, on the worklist and after drafting", async () => {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();
  const repo = new InMemoryDenialRepository();
  const { NoNarrator, NoExplainer } = await import("../index.ts");
  const service = new DenialService(repo, playbook, PROVIDER, bus, NoNarrator, NoExplainer, "America/Los_Angeles");

  // UnitedHealthcare is catalogued at 60 days; a 2026-09-01 determination puts the deadline on 2026-10-31.
  // 2026-11-01T02:00Z is 7pm PDT on OCT 31 — still the deadline day in the practice's room,
  // already the day after in UTC.
  const eveningOfDeadline = new Date("2026-11-01T02:00:00Z");
  await service.createFromVariance(
    variance({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental", paymentDate: "2026-09-01" }),
    eveningOfDeadline
  );

  const [row] = await service.list(undefined, eveningOfDeadline);
  assert.equal(row!.appealDeadline, "2026-10-31");
  assert.equal(row!.daysToAppeal, 0, "the deadline day still has hours left in Los Angeles");
  assert.equal(row!.appealWindow, "urgent", "not `closed` — a biller told the window passed abandons the money");

  const drafted = await service.draftAppeal(row!.id, APPEAL_CONTEXT, eveningOfDeadline);
  assert.equal(drafted.daysToAppeal, 0, "the view returned from drafting counts the same day the worklist does");
  assert.equal(drafted.appealWindow, "urgent");
});

// ── M5 — the appeal deadline is the PAYER'S, counted from the PAYER'S date ────────────────────
//
// Both halves used to be wrong at once. The window was `DEFAULT_APPEAL_WINDOW_DAYS` (90) for every
// payer, while `payers.appeal_window_days` had held the real figure since migration 0004 and been
// seeded per payer since 0014 — with no reader anywhere in the codebase. And the count started at
// `now`, the moment Mermaid read the file, so a late ingest silently extended the deadline by
// exactly how late it was.
//
// A biller plans around this date. Getting it wrong sends them to work a denial after the window has
// closed: the appeal is discarded by the payer, the record says the money was fought for, and it is
// unrecoverable.

test("M5: the appeal window comes from the payer's catalogued terms, not a global 90 days", async () => {
  const { service } = await wired();

  // UnitedHealthcare is catalogued at 60 days; MetLife at 180. One constant cannot be right for both.
  // (Aetna was the example until B-1 sourced its window at 180 — see the B-1 tests below.)
  const [uhc] = await service.createFromVariance(
    variance({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental", paymentDate: "2026-09-01" }),
    NOW
  );
  const [metlife] = await service.createFromVariance(
    variance({ postingId: "post-2", payerId: "metlife-dental", paymentDate: "2026-09-01" }),
    NOW
  );

  assert.equal(uhc!.denial.appealDeadline, "2026-10-31", "60 days from the payer's 2026-09-01 determination");
  assert.equal(metlife!.denial.appealDeadline, "2027-02-28", "180 days from the same determination");
  assert.notEqual(
    uhc!.denial.appealDeadline,
    metlife!.denial.appealDeadline,
    "two payers with different terms must not be given the same deadline"
  );
});

test("M5: the window is counted from the payer's determination date, not from when we read the file", async () => {
  /**
   * The half that is invisible without an ingest delay. An ERA polled a fortnight after the cheque,
   * a file uploaded at month end, or a backlog after an outage each used to push the deadline out by
   * exactly that lag — always in the direction that makes a closed window look open.
   */
  const { service } = await wired();
  const paidOn = "2026-08-01";
  const readOn = new Date("2026-09-15T10:00:00Z"); // 45 days later

  const [denial] = await service.createFromVariance(
    variance({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental", paymentDate: paidOn }),
    readOn
  );

  // 2026-08-01 + 60 days. Counted from `readOn` it would have been 2026-11-14 — 45 days of runway
  // that does not exist.
  assert.equal(denial!.denial.appealDeadline, "2026-09-30");
  assert.ok(denial!.denial.appealDeadline < "2026-11-14", "the ingest lag must not extend the deadline");
});

test("M5: an uncatalogued payer falls back to 90 days, and the audit trail says it is a fallback", async () => {
  const { service } = await wired();
  const [denial] = await service.createFromVariance(
    variance({ payerId: "some-regional-plan", payerName: "Regional Dental", paymentDate: "2026-09-01" }),
    NOW
  );

  assert.equal(denial!.denial.appealDeadline, "2026-11-30", "90 days from the determination");
  const line = denial!.denial.audit.find((a) => a.message.includes("Appeal deadline"))!;
  assert.match(line.message, /not catalogued/, "a fallback must announce itself as one");
});

test("M5: a remittance that stated no payment date falls back, and says so rather than pretending", async () => {
  const { service } = await wired();
  const payload = variance({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental" });
  delete payload.paymentDate;

  const [denial] = await service.createFromVariance(payload, NOW);

  // Falls back to detectedAt (2026-09-15) + 60.
  assert.equal(denial!.denial.appealDeadline, "2026-11-14");
  const line = denial!.denial.audit.find((a) => a.message.includes("Appeal deadline"))!;
  assert.match(line.message, /the date this denial was detected/);
  assert.match(line.message, /Confirm the payer's determination date/);
});

test("M5: the deadline's provenance is recorded next to the deadline itself", async () => {
  /**
   * A date a biller plans around has to be accountable: which window, and counted from what.
   *
   * This asserted the audit line said the window came from "catalogued terms", full stop — which
   * read as the PAYER'S terms, and named Aetna as the source of a figure Aetna had no part in.
   * `PAYER_CATALOG` calls its own values the common commercial-dental defaults and no edit path
   * exists to replace them (`APPEAL_WINDOWS_ARE_PAYER_SOURCED`). The record still says the window
   * is catalogued — that much is true and useful — and no longer says the payer stated it.
   */
  const { service } = await wired();
  const [denial] = await service.createFromVariance(
    variance({ payerId: "uhc-dental", payerName: "UnitedHealthcare Dental", paymentDate: "2026-09-01" }),
    NOW
  );

  const line = denial!.denial.audit.find((a) => a.message.includes("Appeal deadline"))!;
  assert.match(line.message, /60-day window/);
  assert.match(line.message, /catalogued for UnitedHealthcare Dental/, "which window, and whose entry it is");
  assert.match(line.message, /a typical figure, not terms this payer stated/, "and how sure that is");
  assert.match(line.message, /confirm it before relying on this date/);
  assert.match(line.message, /counted from 2026-09-01/);
  assert.match(line.message, /the payer's own determination date/, "the ANCHOR is the payer's, and stays so");
});

// ── Triage ────────────────────────────────────────────────────────────────────────────

test("a variance becomes a triaged denial with a disposition and recovery odds", async () => {
  const { service } = await wired();
  const [view] = await service.createFromVariance(variance(), NOW);

  assert.equal(view!.denial.status, "triaged");
  assert.equal(view!.denial.carcCode, "197");
  assert.equal(view!.denial.deniedAmount, cents(1125));
  assert.equal(view!.denial.triage!.disposition, "appeal");
  assert.ok(view!.denial.triage!.overturnRate > 0);
  assert.ok(view!.denial.triage!.expectedRecovery > 0);
  assert.ok(view!.denial.priority > 0);
  assert.equal(view!.canDraft, true);
  assert.match(view!.recommendedAction, /retro-authorization/i);
});

/**
 * ── B3 — A DENIAL IS NEVER UNTRIAGED, AND THE QUEUE SHOWS REAL ODDS ───────────────────────────
 *
 * `Denial.triage` was `Triage | null` and `DenialStatus` had a `new` ("not yet triaged") member.
 * Neither state was ever constructible: `createFromVariance` is the only creator, it always
 * resolves a rule, and it always writes `status: "triaged"`. The nullable type only forced readers
 * to handle a case that could not happen — and `buildDenialListItem` handled it by rendering
 * `overturnRate: 0`, i.e. "0% chance of recovery", beside a `disposition` of "unknown".
 *
 * This pins the invariant the type now states: what reaches the biller's queue row is the payer
 * brain's real verdict, never a zero standing in for an impossible absence.
 */
test("B3: every created denial is triaged, and the queue row carries the real odds", async () => {
  const { service, repo } = await wired();
  const [view] = await service.createFromVariance(variance(), NOW);

  // The aggregate itself — no optional access, because the type no longer admits one.
  const stored = await repo.getById(view!.denial.id);
  assert.ok(stored, "the denial persisted");
  assert.equal(stored!.status, "triaged");
  assert.ok(stored!.triage.overturnRate > 0, "a real rate, not a zero standing in for absence");
  assert.ok(stored!.triage.expectedRecovery > 0);
  assert.equal(stored!.triage.disposition, "appeal");

  // The queue row a biller reads reflects that verdict rather than a fallback.
  const [item] = await service.list({}, NOW);
  assert.equal(item!.disposition, "appeal", "never the old 'unknown' fallback");
  assert.equal(item!.overturnRate, stored!.triage.overturnRate, "the row shows the frozen rate");
  assert.ok(item!.overturnRate > 0, "0% odds would be a claim the playbook never made");
  assert.equal(item!.expectedRecovery, stored!.triage.expectedRecovery);
});

test("one denial per REASON — two codes on one claim are two pieces of work", async () => {
  const { service, repo } = await wired();
  const views = await service.createFromVariance(
    variance({
      reasons: [
        { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
        { group: "CO", code: "16", description: "Missing or invalid information", amount: cents(65), procedureCode: "D0120" },
      ],
    }),
    NOW
  );

  assert.equal(views.length, 2);
  assert.equal(repo.size, 2);
  assert.deepEqual(views.map((v) => v.denial.carcCode).sort(), ["16", "197"]);
  // Different codes get different dispositions — that is the whole point of not collapsing them.
  const correctable = views.find((v) => v.denial.carcCode === "16")!;
  assert.equal(correctable.denial.triage!.disposition, "correct_resubmit");
});

test("creation is idempotent per reason — a redelivered event adds nothing", async () => {
  const { service, repo } = await wired();
  await service.createFromVariance(variance(), NOW);
  await service.createFromVariance(variance(), NOW);
  assert.equal(repo.size, 1, "a duplicated denial is duplicated work in a queue that must stay real");
});

test("the queue is ranked by expected recovery, not by amount denied", async () => {
  const { service } = await wired();
  // A large denial with poor odds (CO-96 exclusion) vs. a smaller one with excellent odds (CO-16).
  await service.createFromVariance(
    variance({
      postingId: "post-big",
      reasons: [{ group: "CO", code: "96", description: "Non-covered charge", amount: cents(2000), procedureCode: "D6010" }],
    }),
    NOW
  );
  await service.createFromVariance(
    variance({
      postingId: "post-small",
      reasons: [{ group: "CO", code: "16", description: "Missing or invalid information", amount: cents(900), procedureCode: "D2750" }],
    }),
    NOW
  );

  const queue = await service.list(undefined, NOW);
  assert.equal(queue[0]!.carcCode, "16", "a $900 denial at 75% beats a $2,000 denial at 20%");
  assert.ok(queue[0]!.expectedRecovery > queue[1]!.expectedRecovery);
});

test("a non-pursuable code is still recorded, so nobody-looked and nothing-to-do stay distinguishable", async () => {
  const { service } = await wired();
  const [view] = await service.createFromVariance(
    variance({
      reasons: [{ group: "CO", code: "119", description: "Benefit maximum reached", amount: cents(500), procedureCode: null }],
    }),
    NOW
  );

  assert.equal(view!.denial.triage!.disposition, "patient_resp");
  assert.equal(view!.canDraft, false);
  assert.match(view!.blockedReason!, /not to appeal/);
});

test("denial.created is published for the Today queue", async () => {
  const { service, bus } = await wired();
  await service.createFromVariance(variance(), NOW);

  const events = bus.ofType("denial.created");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.carcCode, "197");
  assert.equal(events[0]!.payload.disposition, "appeal");
  assert.ok(events[0]!.payload.expectedRecovery > 0);
});

// ── The appeal gate ───────────────────────────────────────────────────────────────────

async function drafted() {
  const wiring = await wired();
  const [view] = await wiring.service.createFromVariance(variance(), NOW);
  const withDraft = await wiring.service.draftAppeal(view!.denial.id, APPEAL_CONTEXT, NOW);
  return { ...wiring, id: view!.denial.id, view: withDraft };
}

/**
 * ── A LETTER A PAYER CANNOT ACT ON IS WORSE THAN NO LETTER ─────────────────────────────────────
 *
 * The template used to fall back to literal placeholders, so an appeal with no member ID on file
 * went to the payer reading "RE: APPEAL — Claim [claim number] … Member ID: [member ID]". The
 * failure is silent and expensive: the appeal is recorded as sent, the denial leaves the recovery
 * queue, the window keeps running, and the payer discards a letter that identifies nothing. The
 * practice loses the money AND the record says it was fought for.
 */
test("an appeal with no member ID is refused, not sent with a placeholder", async () => {
  const { service } = await wired();
  // An 835 for a claim filed outside Mermaid: no expectation was ever recorded, so the identifiers
  // never arrived on `variance.detected`.
  const [view] = await service.createFromVariance(variance({ memberId: null }), NOW);

  await assert.rejects(
    () => service.draftAppeal(view!.denial.id, {}, NOW),
    (err: Error) => {
      assert.ok(err instanceof DenialActionError);
      assert.match(err.message, /member ID/);
      assert.match(err.message, /remittance advice or the filed claim/, "the refusal tells a biller what to do");
      return true;
    }
  );

  // Nothing was recorded: no appeal, and the denial is still in the queue as work.
  const after = await service.get(view!.denial.id, NOW);
  assert.equal(after!.denial.appeals.length, 0, "a refused draft must not leave a phantom appeal behind");
  assert.ok(after!.open, "and the money must stay on the recovery queue");
});

test("a human can supply what the file does not have, and the draft then succeeds", async () => {
  const { service } = await wired();
  const [view] = await service.createFromVariance(variance({ memberId: null, claimControlNumber: "" }), NOW);

  const drafted = await service.draftAppeal(
    view!.denial.id,
    { memberId: "MET30066", claimControlNumber: "MRM-000456" },
    NOW
  );

  const letter = drafted.activeAppeal!.letter;
  assert.match(letter, /Member ID: MET30066/);
  assert.match(letter, /Claim MRM-000456/);
  assert.doesNotMatch(letter, /\[member ID\]|\[claim number\]/, "no placeholder may reach a payer");
});

test("the engine refuses too, so no future caller can route around the service", async () => {
  // Duplicated on purpose: a bulk-appeal job or a retry path must not be able to produce a letter
  // with a placeholder in it just because it did not go through `draftAppeal` on the service.
  assert.throws(
    () =>
      draftAppeal({
        level: 1,
        payerName: "MetLife Dental",
        patientName: "Ada Alpha",
        memberId: "",
        claimControlNumber: "MRM-000456",
        serviceDate: "2026-09-01",
        procedureCode: "D2750",
        carcCode: "197",
        carcDescription: "Pre-authorization absent",
        deniedAmount: cents(1125),
        guidance: "",
        providerName: "Mermaid Dental",
      }),
    IncompleteAppealError
  );
});

test("drafting produces a letter and the evidence a human must actually gather", async () => {
  const { view } = await drafted();
  const appeal = view.activeAppeal!;

  assert.equal(appeal.status, "draft");
  assert.equal(appeal.level, 1);
  assert.match(appeal.letter, /RE: APPEAL/);
  assert.match(appeal.letter, /Ada Alpha/);
  assert.match(appeal.letter, /\$1,125\.00/);
  assert.match(appeal.letter, /reason code 197/);
  // The crown needs a radiograph and a narrative; the pre-auth code needs a retro-auth request.
  assert.ok(appeal.checklist.some((c) => /radiograph/i.test(c)));
  assert.ok(appeal.checklist.some((c) => /narrative/i.test(c)));
  assert.ok(appeal.checklist.some((c) => /retro-authorization/i.test(c)));
  assert.equal(view.denial.status, "appealing");
});

test("drafting is NOT sending — it goes nowhere until a person approves it", async () => {
  const { view, id, service } = await drafted();
  assert.equal(view.activeAppeal!.approvedBy, null);
  assert.equal(view.canSubmit, false);
  assert.equal(view.canApprove, true);

  await assert.rejects(
    () => service.submitAppeal(id, NOW),
    (err: unknown) => {
      assert.ok(err instanceof DenialActionError);
      assert.match(err.reason, /has not been approved by a person/);
      return true;
    }
  );
});

test("approval requires a named human, then the appeal may be sent", async () => {
  const { service, id } = await drafted();
  await assert.rejects(() => service.approveAppeal(id, "   ", NOW), /an approving user is required/);

  const approved = await service.approveAppeal(id, "biller@clinic", NOW);
  assert.equal(approved.activeAppeal!.approvedBy, "biller@clinic");
  assert.equal(approved.canSubmit, true);

  const sent = await service.submitAppeal(id, NOW);
  assert.equal(sent.denial.status, "appealed");
  assert.equal(sent.activeAppeal!.status, "submitted");
  assert.ok(sent.denial.audit.some((a) => a.actor === "staff" && /approved by biller@clinic/.test(a.message)));
});

test("a code the playbook says not to appeal cannot be drafted without an explicit override", async () => {
  const { service } = await wired();
  const [view] = await service.createFromVariance(
    variance({
      reasons: [{ group: "CO", code: "119", description: "Benefit maximum reached", amount: cents(500), procedureCode: null }],
    }),
    NOW
  );
  await assert.rejects(
    () => service.draftAppeal(view!.denial.id, APPEAL_CONTEXT, NOW),
    /the playbook says to patient resp/
  );
});

test("only one appeal may be open at a time", async () => {
  const { service, id } = await drafted();
  await assert.rejects(() => service.draftAppeal(id, APPEAL_CONTEXT, NOW), /already open/);
});

// ── Outcome and the learning loop ─────────────────────────────────────────────────────

/**
 * ── THE ASSERTION THIS TEST USED TO MAKE WAS THE DEFECT (F-2) ────────────────────────────────────
 * It read `status === "recovered"` and called that "closes the denial", which is exactly what went
 * wrong in production: a person recording a win closed the denial, emptied the Recover worklist, and
 * reported $1,125.00 recovered while $21.49 had actually been collected. A win is now a RECEIVABLE.
 */
test("recording a win opens a receivable rather than closing the denial", async () => {
  const { service, bus, id } = await drafted();
  await service.approveAppeal(id, "biller@clinic", NOW);
  await service.submitAppeal(id, NOW);

  const won = await service.recordOutcome(
    id,
    { won: true, recoveredAmount: cents(1125), recordedBy: "biller@clinic" },
    NOW
  );

  assert.equal(won.denial.status, "awaiting_payment", "OPEN — the money has not arrived");
  assert.equal(won.denial.awardedAmount, cents(1125), "what the payer agreed to pay");
  assert.equal(won.denial.awardSettledAmount, 0, "and nothing has been collected against it");
  assert.equal(won.denial.recoveredAmount, null, "cash, of which there is none yet");
  assert.equal(won.denial.outcomeDecision, "won");
  assert.ok(won.denial.awardedAt, "the receivable's age is anchored to a recorded fact");
  assert.equal(won.activeAppeal, null);

  const outcome = bus.ofType("appeal.outcome.recorded");
  assert.equal(outcome.length, 1);
  assert.equal(outcome[0]!.payload.won, true);
  assert.equal(outcome[0]!.payload.carcCode, "197");
  assert.equal(outcome[0]!.payload.payerId, "metlife-dental");
});

test("recording a loss writes it off and still publishes the outcome — losses teach too", async () => {
  const { service, bus, id } = await drafted();
  await service.approveAppeal(id, "biller@clinic", NOW);
  await service.submitAppeal(id, NOW);

  const lost = await service.recordOutcome(
    id,
    { won: false, notes: "Payer upheld the denial.", recordedBy: "biller@clinic" },
    NOW
  );

  assert.equal(lost.denial.status, "written_off");
  assert.equal(lost.denial.awardedAmount, 0, "a lost appeal awards nothing");
  assert.equal(lost.denial.outcomeDecision, "lost");
  assert.equal(bus.ofType("appeal.outcome.recorded")[0]!.payload.won, false);
});

/**
 * ── A CORRUPT RECOVERED AMOUNT IS REFUSED AT THE SOURCE ────────────────────────────────────────
 * The recovered figure becomes the denial's permanent record, feeds the recovery scoreboard, and
 * rides `appeal.outcome.recorded` into the learning loop. A NaN — which is what `Number("abc")`
 * produces one layer up, and which JSONB silently stores as null — or a negative figure is
 * corruption at the source. The same rule the ledger applies to every human money entry.
 */
test("a NaN or negative recovered amount is refused, not recorded", async () => {
  const { service, id } = await drafted();
  await service.approveAppeal(id, "biller@clinic", NOW);
  await service.submitAppeal(id, NOW);

  await assert.rejects(
    () => service.recordOutcome(id, { won: true, recoveredAmount: NaN as never, recordedBy: "biller" }, NOW),
    /non-negative whole number of cents/
  );
  await assert.rejects(
    () => service.recordOutcome(id, { won: true, recoveredAmount: cents(-5), recordedBy: "biller" }, NOW),
    /non-negative whole number of cents/
  );

  // Neither refusal touched the record: the appeal is still awaiting its outcome.
  const view = (await service.get(id, NOW))!;
  assert.equal(view.denial.status, "appealed");
  assert.equal(view.denial.recoveredAmount, null);
});

test("an outcome cannot be recorded before an appeal was submitted", async () => {
  const { service, id } = await drafted();
  await assert.rejects(
    () => service.recordOutcome(id, { won: true, recordedBy: "biller" }, NOW),
    /no submitted appeal awaiting an outcome/
  );
});

test("the triage is frozen — later learning does not rewrite an old decision", async () => {
  const { service, playbook, id } = await drafted();
  const odds = (await service.get(id, NOW))!.denial.triage!.overturnRate;

  // The brain learns a great deal about this code afterwards.
  for (let i = 0; i < 30; i++) {
    await playbook.recordOutcome({ payerId: "metlife-dental", carcCode: "197", cdtCode: "D2750", won: true });
  }
  assert.ok((await playbook.resolve("metlife-dental", "197", "D2750", "CO")).overturnRate > odds);

  assert.equal(
    (await service.get(id, NOW))!.denial.triage!.overturnRate,
    odds,
    "an audit trail whose reasoning mutates is not an audit trail"
  );
});

// ── Closing without appealing ─────────────────────────────────────────────────────────

test("a denial can be written off or billed to the patient, with a reason and a name", async () => {
  const { service } = await wired();
  const [a] = await service.createFromVariance(variance(), NOW);
  const [b] = await service.createFromVariance(variance({ postingId: "post-2" }), NOW);

  await assert.rejects(
    () => service.close(a!.denial.id, { as: "written_off", reason: "  ", closedBy: "biller" }, NOW),
    /a reason is required/
  );

  const off = await service.close(
    a!.denial.id,
    { as: "written_off", reason: "Not worth the documentation effort.", closedBy: "biller" },
    NOW
  );
  assert.equal(off.denial.status, "written_off");
  assert.equal(off.open, false);

  /**
   * The denial in `variance()` arrives under group CO, so billing it to the patient is refused
   * without a deliberate override — see the NEW-07 tests below for the whole rule.
   */
  const billed = await service.close(
    b!.denial.id,
    {
      as: "patient_billed",
      reason: "Disclosed to the patient before treatment.",
      closedBy: "biller",
      overrideContractualBar: true,
    },
    NOW
  );
  assert.equal(billed.denial.status, "patient_billed");
});

/**
 * ── A PATIENT MAY ONLY BE BILLED WHAT THE PAYER DID NOT KEEP FOR THE PRACTICE (NEW-07) ──────────
 *
 * `categorizeAdjustment` has always sent a contractual adjustment to `post_normal` and never to the
 * patient, and the automatic triage path obeyed it. The MANUAL close obeyed nothing: `denials.write`
 * — which a biller holds to close denials all day — moved ANY denial to a patient's balance,
 * including one the payer had labelled `CO`. `denial.closed` with `closedAs: "patient_billed"` is
 * what the patient ledger subscribes to, so the charge landed on a real statement.
 *
 * A `CO` adjustment is the payer citing the practice's own contract. Billing it anyway is a
 * contractual breach and, on many plans, balance-billing.
 */
test("NEW-07: a CO-group denial cannot be billed to the patient", async () => {
  const { service } = await wired();
  const [d] = await service.createFromVariance(variance(), NOW);

  await assert.rejects(
    () =>
      service.close(
        d!.denial.id,
        { as: "patient_billed", reason: "The patient can pay this.", closedBy: "biller" },
        NOW
      ),
    (err: Error) => {
      assert.equal(err.name, "ContractualDenialNotBillableError");
      assert.match(err.message, /contractual/i);
      assert.match(err.message, /override/i, "and it names the way through, for someone who holds it");
      return true;
    }
  );

  // Writing it OFF is untouched — that is what a contractual adjustment is for.
  const off = await service.close(
    d!.denial.id,
    { as: "written_off", reason: "Contractual. We absorb it.", closedBy: "biller" },
    NOW
  );
  assert.equal(off.denial.status, "written_off");
});

test("NEW-07: an adjustment the payer assigned to the PATIENT is billable", async () => {
  /**
   * The control. A rule that refused everything would be indistinguishable from removing the
   * feature, and staff would route the charge somewhere this system cannot see.
   */
  const { service } = await wired();
  const [d] = await service.createFromVariance(
    variance({ reasons: [{ group: "PR", code: "3", description: "Co-payment", amount: cents(50), procedureCode: "D0120" }] }),
    NOW
  );

  const billed = await service.close(
    d!.denial.id,
    { as: "patient_billed", reason: "Co-payment due at the desk.", closedBy: "biller" },
    NOW
  );
  assert.equal(billed.denial.status, "patient_billed");
  assert.doesNotMatch(billed.denial.audit.at(-1)!.message, /OVERRIDE/, "no override was needed");
});

test("NEW-07: a denial with NO recorded group is refused — unknown must not mean the patient", async () => {
  /**
   * Denials written before the adjustment group was kept carry null. "We do not know whose money
   * this is" resolving to "the patient's" is the direction that costs a patient money they do not
   * owe, and the one nobody would notice.
   */
  const { service, repo } = await wired();
  const [d] = await service.createFromVariance(variance(), NOW);
  const stored = (await repo.getById(d!.denial.id))!;
  await repo.update({ ...stored, carcGroup: null });

  await assert.rejects(
    () =>
      service.close(
        d!.denial.id,
        { as: "patient_billed", reason: "Probably theirs.", closedBy: "biller" },
        NOW
      ),
    /ContractualDenialNotBillableError|unrecorded group/
  );
});

test("an unknown denial raises DenialNotFoundError", async () => {
  const { service } = await wired();
  assert.equal(await service.get("nope", NOW), null);
  await assert.rejects(() => service.draftAppeal("nope", APPEAL_CONTEXT, NOW), DenialNotFoundError);
});

// ── Scoreboard ────────────────────────────────────────────────────────────────────────

test("recovery stats answer 'of the money we chased, how much came back?'", async () => {
  const { service, repo, id } = await drafted();
  await service.approveAppeal(id, "biller", NOW);
  await service.submitAppeal(id, NOW);
  await service.recordOutcome(id, { won: true, recoveredAmount: cents(1125), recordedBy: "biller" }, NOW);

  const [other] = await service.createFromVariance(variance({ postingId: "post-lost" }), NOW);
  await service.close(other!.denial.id, { as: "written_off", reason: "No documentation.", closedBy: "biller" }, NOW);

  const stats = buildRecoveryStats(await repo.list(), NOW);
  /**
   * The win is a RECEIVABLE, so it is still open work and no cash has been collected. The old
   * version of this test asserted the opposite — a 50% recovery rate on money nobody had received —
   * which is precisely the reporting defect F-2 was raised for.
   */
  assert.equal(stats.recoveredCount, 0, "nothing has been paid");
  assert.equal(stats.recoveredAmount, 0, "so no cash is on the scoreboard");
  assert.equal(stats.awaitingPaymentCount, 1);
  assert.equal(stats.awardedAwaitingPayment, cents(1125), "the payer agreed to this and has not sent it");
  assert.equal(stats.writtenOffCount, 1);
  assert.equal(stats.recoveryRate, 0, "of the money that has actually settled, none came back yet");
  assert.equal(stats.openCount, 1, "the award is still work");
});

test("the service works with no event bus wired at all", async () => {
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();
  const service = new DenialService(new InMemoryDenialRepository(), playbook, PROVIDER);
  const [view] = await service.createFromVariance(variance(), NOW);
  assert.equal(view!.denial.status, "triaged");
});

// ── D1 — an ASSUMED deadline must not read like a payer's stated one ──────────────────────────
//
// M5 stopped every payer being stamped `now + 90 days`, but the fallback it left behind still
// reached a biller looking exactly like a date the payer had named: same badge, same countdown,
// same "Only 3 days left to appeal" sentence. Nothing on any screen distinguished a date
// UnitedHealthcare actually set from a date Mermaid picked because it had never heard of the payer.
//
// The countdown is real either way, so `AppealWindow` and the priority score are deliberately
// unchanged — an assumed window runs out just as really as a stated one. What is added is
// PROVENANCE: every surface that shows the date now also says which kind of date it is.
//
// The two denials below are constructed to land on the SAME deadline, the SAME window and the SAME
// number of days: UnitedHealthcare is catalogued at 60 days from 2026-07-20, the regional plan is uncatalogued
// and takes the 90-day default from 2026-06-20. Both close on 2026-09-18, three days after NOW.
// Anything that still tells them apart is doing so on provenance alone, which is the point.

const SAME_DEADLINE = "2026-09-18";

async function assumedVsCatalogued() {
  const { service } = await wired();
  const [assumed] = await service.createFromVariance(
    variance({
      postingId: "post-assumed",
      payerId: "some-regional-plan",
      payerName: "Regional Dental",
      paymentDate: "2026-06-20",
    }),
    NOW
  );
  const [stated] = await service.createFromVariance(
    variance({
      postingId: "post-stated",
      payerId: "uhc-dental",
      payerName: "UnitedHealthcare Dental",
      paymentDate: "2026-07-20",
    }),
    NOW
  );
  return { service, assumed: assumed!, stated: stated! };
}

test("D1: the two cases are genuinely indistinguishable by date, window and urgency", async () => {
  const { assumed, stated } = await assumedVsCatalogued();

  assert.equal(assumed.denial.appealDeadline, SAME_DEADLINE, "90 days from 2026-06-20");
  assert.equal(stated.denial.appealDeadline, SAME_DEADLINE, "60 days from 2026-07-20");
  assert.equal(assumed.appealWindow, "urgent");
  assert.equal(stated.appealWindow, "urgent");
  assert.equal(assumed.daysToAppeal, stated.daysToAppeal, "the countdown is the same countdown");
});

test("D1: an uncatalogued payer's deadline is recorded and rendered as assumed", async () => {
  const { assumed } = await assumedVsCatalogued();

  assert.equal(assumed.denial.appealDeadlineEstimated, true, "the fallback must be recorded on the denial");
  assert.equal(assumed.deadlineEstimated, true);
  assert.equal(assumed.deadlineNote, ASSUMED_APPEAL_WINDOW_LABEL);
  assert.match(
    assumed.recommendedAction,
    /confirm with payer/i,
    "the sentence that counts down to the date must say the date is assumed"
  );
});

test("D1: a catalogued payer's deadline is not assumed, but is still not the payer's word", async () => {
  /**
   * The half `c7af7ff` left standing. Marking only the fallback implied the contrast — that a
   * catalogued window IS the payer's stated terms. It is not: `PAYER_CATALOG` calls its own values
   * the common commercial-dental defaults, and no edit path exists to replace them, so the honest
   * statement is "typical figure", not "Aetna told us". `APPEAL_WINDOWS_ARE_PAYER_SOURCED` is the
   * one place that judgement lives.
   */
  const { stated } = await assumedVsCatalogued();

  assert.equal(stated.denial.appealDeadlineEstimated, false, "it did come from the catalogue");
  assert.equal(stated.deadlineEstimated, false);
  assert.equal(stated.denial.appealWindowDays, 60, "UnitedHealthcare's catalogued window, quoted by the note");
  assert.equal(stated.deadlineNote, "Estimated 60-day window based on typical terms — confirm with payer.");
  assert.doesNotMatch(stated.deadlineNote!, /Assumed/, "it is not the 90-day default");
  assert.doesNotMatch(stated.deadlineNote!, /payer not on file/, "UnitedHealthcare IS on file — just not consulted");
  assert.match(stated.recommendedAction, /confirm with payer/i, "and the countdown says so too");
});

test("D1: the assumed and stated denials render differently despite identical dates", async () => {
  const { assumed, stated } = await assumedVsCatalogued();

  assert.notEqual(
    assumed.recommendedAction,
    stated.recommendedAction,
    "same deadline, same urgency — the only difference left to show is where the date came from"
  );
  // Both carry a caveat now, so neither contains the other. What must hold is that each names its
  // OWN kind of window — the reader has to be able to tell a 90-day default from a 60-day typical.
  assert.match(assumed.recommendedAction, /Assumed 90-day window \(payer not on file\)/);
  assert.match(stated.recommendedAction, /Estimated 60-day window based on typical terms/);
  assert.doesNotMatch(stated.recommendedAction, /Assumed/);
  assert.doesNotMatch(assumed.recommendedAction, /typical terms/);
});

test("D1: the worklist row a biller scans carries the caveat too", async () => {
  const { service } = await assumedVsCatalogued();
  const rows = await service.list({}, NOW);

  const assumedRow = rows.find((r) => r.payerName === "Regional Dental")!;
  const statedRow = rows.find((r) => r.payerName === "UnitedHealthcare Dental")!;

  assert.equal(assumedRow.appealDeadline, statedRow.appealDeadline, "identical dates on the list");
  assert.equal(assumedRow.deadlineEstimated, true);
  assert.equal(assumedRow.deadlineNote, ASSUMED_APPEAL_WINDOW_LABEL);
  assert.equal(statedRow.deadlineEstimated, false);
  assert.equal(statedRow.deadlineNote, "Estimated 60-day window based on typical terms — confirm with payer.");
  assert.notEqual(assumedRow.deadlineNote, statedRow.deadlineNote, "two kinds of window, two sentences");
});

test("D1: the priority explanation a biller opens says the countdown is to an assumed date", async () => {
  const { assumed, stated } = await assumedVsCatalogued();

  const countdown = (v: { denial: { triage: { explain: string[] } } }) =>
    v.denial.triage.explain.find((line) => /left to appeal/.test(line))!;

  // Both countdowns carry a caveat; they must not carry the SAME one.
  assert.match(countdown(assumed), /Assumed 90-day window \(payer not on file\) — confirm with payer\./);
  assert.match(countdown(stated), /Estimated 60-day window based on typical terms — confirm with payer\./);
  assert.notEqual(countdown(assumed), countdown(stated));
});

test("D1: the audit trail names the assumption as an assumption", async () => {
  const { assumed, stated } = await assumedVsCatalogued();

  const deadlineLine = (v: { denial: { audit: { message: string }[] } }) =>
    v.denial.audit.find((a) => a.message.includes("Appeal deadline"))!;

  assert.match(deadlineLine(assumed).message, /ASSUMED/);
  assert.match(deadlineLine(assumed).message, /must be confirmed before it is relied on/);
  assert.doesNotMatch(deadlineLine(stated).message, /ASSUMED/, "the catalogue is not the 90-day default");
  assert.match(deadlineLine(stated).message, /catalogued for UnitedHealthcare Dental/);
  // Softened with the label (`f161c26`): the entry exists, the payer did not write it.
  assert.match(deadlineLine(stated).message, /not terms this payer stated/);
  assert.doesNotMatch(
    deadlineLine(stated).message,
    /from UnitedHealthcare Dental's catalogued terms/,
    "the permanent record must not name the payer as the source of Mermaid's own figure"
  );
});

test("D1: provenance changes the wording and nothing about the ranking", () => {
  /**
   * The guarantee Option A rests on. If the flag ever reached the score, an uncatalogued payer's
   * denials would quietly sort differently from a catalogued payer's on otherwise identical facts —
   * which is a business decision nobody made.
   */
  const input = {
    deniedAmount: cents(1125),
    overturnRate: 0.6,
    appealDeadline: SAME_DEADLINE,
    detectedAt: "2026-09-15T09:00:00.000Z",
    quickWin: false,
  };

  const stated = scoreDenial(input, NOW);
  const assumed = scoreDenial({ ...input, appealDeadlineEstimated: true }, NOW);

  assert.equal(assumed.priority, stated.priority, "the assumption must not move the queue");
  assert.equal(assumed.expectedRecovery, stated.expectedRecovery);
  assert.notDeepEqual(assumed.explain, stated.explain, "but it must change what the biller is told");
});

test("D1: a denial written before provenance was tracked asserts nothing either way", async () => {
  /**
   * `appealDeadlineEstimated` is optional on purpose. An older record genuinely does not know which
   * window produced its date, and defaulting it to `false` would assert the payer's own terms were
   * used — inventing the very fact this flag exists to stop being invented.
   */
  const { assumed } = await assumedVsCatalogued();
  const legacy = { ...assumed.denial };
  delete legacy.appealDeadlineEstimated;

  delete legacy.appealWindowDays;

  const view = buildDenialView(legacy, NOW);
  assert.equal(view.deadlineEstimated, false, "no claim is made about WHICH window produced it");
  /**
   * It still gets a caveat, and that is correct: whichever of the two windows produced this date, it
   * was a typical figure rather than the payer's stated terms — so the claim the sentence makes is
   * true without knowing which. What it cannot do is quote a number, and it does not.
   */
  assert.equal(view.deadlineNote, "Estimated window based on typical terms — confirm with payer.");
  assert.doesNotMatch(view.deadlineNote!, /\d/, "an unrecorded window cannot be quoted");
  assert.doesNotMatch(view.deadlineNote!, /Assumed/, "and it must not claim the default was used");
});

// ── The caveat is gated on the sourcing flag, not hardcoded on ────────────────────────────────
//
// `APPEAL_WINDOWS_ARE_PAYER_SOURCED` is the one place the judgement lives: no appeal window in this
// system comes from a payer's own published terms, because `PAYER_CATALOG` calls its values the
// common commercial-dental defaults and there is no path by which a practice can replace them
// (`ensurePayers` skips existing rows, and the payer-profile API is GET-only). It mirrors M7's
// `FILING_WINDOWS_ARE_PAYER_SOURCED` on the claims side, about the same seed data.

test("D1: the catalogued caveat is tied to the sourcing flag, not asserted unconditionally", () => {
  /**
   * Asserts the RELATIONSHIP rather than the literal `false`, so that flipping the flag one day
   * makes this test the thing that notices — every catalogued sentence must stop apologising in the
   * same commit that earns the right to.
   */
  assert.equal(
    appealWindowNote(false, 60) === null,
    APPEAL_WINDOWS_ARE_PAYER_SOURCED,
    "a catalogued window is caveated exactly while no window is payer-sourced"
  );

  // The fallback is caveated either way — it is Mermaid's own number and always was.
  assert.equal(appealWindowNote(true, 90), ASSUMED_APPEAL_WINDOW_LABEL);
  assert.doesNotMatch(appealWindowNote(true, 60)!, /typical terms/, "the default is not a payer figure");
});

test("D1: the catalogued sentence quotes the window it is caveating, when it knows it", () => {
  assert.equal(
    appealWindowNote(false, 180),
    "Estimated 180-day window based on typical terms — confirm with payer."
  );
  assert.equal(
    appealWindowNote(false, 60),
    "Estimated 60-day window based on typical terms — confirm with payer."
  );

  // Absent, zero and negative all mean "not recorded" — the claim is made without a number rather
  // than with a wrong one.
  for (const unknown of [undefined, null, 0, -1]) {
    assert.equal(
      appealWindowNote(false, unknown),
      "Estimated window based on typical terms — confirm with payer.",
      `window ${String(unknown)} must not be quoted`
    );
  }
});

test("D1: every surface quotes the same sentence for the same denial", () => {
  // One function, so the view, the worklist row and the priority explanation cannot drift.
  const note = appealWindowNote(false, 60)!;
  assert.equal(catalogedAppealWindowLabel(60), note);

  const countdown = scoreDenial(
    {
      deniedAmount: cents(1125),
      overturnRate: 0.6,
      appealDeadline: "2026-09-18",
      appealDeadlineEstimated: false,
      appealWindowDays: 60,
      detectedAt: "2026-09-15T09:00:00.000Z",
      quickWin: false,
    },
    NOW
  ).explain.find((l) => l.includes("left to appeal"))!;

  assert.ok(countdown.includes(note), `the countdown must quote the same sentence: ${countdown}`);
});

// ── A won appeal the payer never honours must be able to leave the worklist ───────────────────

/**
 * ── THE DEAD END THIS CLOSES ───────────────────────────────────────────────────────────────────
 * `close` guarded on a hand-written `["triaged", "appealing", "appealed"]` that predated Phase 3.
 * Recording a win moves a denial to `awaiting_payment`, so the ordinary end of a won appeal the
 * payer never honours — write it off, or bill the patient once the window has closed — was refused
 * outright, with the message "it is already awaiting_payment".
 *
 * That sentence tells a biller the denial is finished. The truth was that nothing could ever finish
 * it: the item stayed on the Recover worklist permanently, and no action available to anyone could
 * clear it. A worklist that accumulates items no action can remove is a worklist people stop
 * reading, which costs far more than the one denial.
 */
test("a won-but-unpaid award can be written off once the practice gives up on it", async () => {
  const { service, id } = await drafted();
  await service.approveAppeal(id, "biller@clinic", NOW);
  await service.submitAppeal(id, NOW);
  const won = await service.recordOutcome(id, { won: true, recoveredAmount: cents(1125), recordedBy: "biller@clinic" }, NOW);
  assert.equal(won.denial.status, "awaiting_payment", "the state this test exists for");

  const closed = await service.close(
    id,
    { as: "written_off", reason: "Delta agreed on appeal in March and has never paid; window closed.", closedBy: "biller@clinic" },
    NOW
  );

  assert.equal(closed.denial.status, "written_off");
  assert.equal(closed.open, false, "and it leaves the worklist");
  assert.equal(closed.denial.awardedAmount, cents(1125), "what the payer agreed to is still on the record");
});

test("a partially recovered award can be closed for the remainder", async () => {
  const { service, id } = await drafted();
  await service.approveAppeal(id, "biller@clinic", NOW);
  await service.submitAppeal(id, NOW);
  const won = await service.recordOutcome(id, { won: true, recoveredAmount: cents(1125), recordedBy: "biller@clinic" }, NOW);
  const settled = await service.settleAwardsFromPosting(
    { claimId: won.denial.claimId, postingId: "post-settle", paidAmount: cents(500) },
    NOW
  );
  assert.equal(settled.settled[0]?.denial.status, "partially_recovered", "the state this test exists for");

  const closed = await service.close(
    id,
    { as: "written_off", reason: "Payer sent half and will not send the rest.", closedBy: "biller@clinic" },
    NOW
  );
  assert.equal(closed.denial.status, "written_off");
  assert.equal(closed.denial.awardSettledAmount, cents(500), "cash already received is untouched by closing");
});

test("a denial that is genuinely finished still refuses to be closed twice", async () => {
  /** Widening the guard must not have removed it. */
  const { service } = await wired();
  const [a] = await service.createFromVariance(variance(), NOW);
  await service.close(a!.denial.id, { as: "written_off", reason: "Not worth pursuing.", closedBy: "biller" }, NOW);

  await assert.rejects(
    () => service.close(a!.denial.id, { as: "written_off", reason: "Again.", closedBy: "biller" }, NOW),
    /already written_off/
  );
});

// ── B-1 — Aetna's appeal window is SOURCED from Aetna's own page ──────────────────────────────
//
// The catalog said 60; Aetna publishes 180 "from the receipt of the adverse decision". A biller
// shown a third of the real window writes appealable denials off early. These pin the number, the
// provenance that travels with it, and the rule that the citation belongs to the number rather than
// to the payer.

test("B-1: an Aetna denial gets Aetna's published 180-day appeal window, counted from the payer's date", async () => {
  const { service } = await wired();
  const [aetna] = await service.createFromVariance(
    variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-09-01" }),
    NOW
  );

  assert.equal(aetna!.denial.appealWindowDays, 180);
  assert.equal(aetna!.denial.appealDeadline, "2027-02-28", "180 days from the 2026-09-01 determination — not 2026-10-31");
});

test("B-1: the sourced window is recorded as the payer's, and still carries the contract caveat", async () => {
  const { service } = await wired();
  const [aetna] = await service.createFromVariance(
    variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-09-01" }),
    NOW
  );

  const source = aetna!.denial.appealWindowSource!;
  assert.ok(source, "the denial records which document stands behind its date");
  assert.equal(source.publisher, "Aetna Dental");
  assert.match(source.url, /^https:\/\/www\.aetnadental\.com\//, "the payer's own site, not an aggregator");
  assert.match(source.quote, /within 180 days from the receipt of the adverse decision/, "the number is in the quote");

  assert.equal(aetna!.deadlineEstimated, false);
  assert.equal(aetna!.deadlineSourced, true);
  assert.equal(
    aetna!.deadlineNote,
    "A 180-day window published by Aetna Dental — confirm against your participation agreement, which may differ."
  );
  assert.doesNotMatch(aetna!.deadlineNote!, /typical terms/, "a published window is not a typical figure");
});

test("B-1: an urgent countdown on a sourced window carries the contract caveat too", async () => {
  // The recommendation only asserts the deadline when it is urgent. 2026-03-22 + 180 days is
  // 2026-09-18, three days after NOW — the same deadline the D1 tests use.
  const { service } = await wired();
  const [aetna] = await service.createFromVariance(
    variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-03-22" }),
    NOW
  );
  assert.equal(aetna!.denial.appealDeadline, SAME_DEADLINE);
  assert.equal(aetna!.appealWindow, "urgent");
  assert.match(aetna!.recommendedAction, /published by Aetna Dental/, "the countdown names whose window it is");
  assert.match(aetna!.recommendedAction, /participation agreement/i, "and carries the same caveat");
  assert.doesNotMatch(aetna!.recommendedAction, /typical terms/);
});

test("B-1: the permanent audit line names the document, and does not call the payer's figure a guess", async () => {
  const { service } = await wired();
  const [aetna] = await service.createFromVariance(
    variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-09-01" }),
    NOW
  );

  const line = aetna!.denial.audit.find((a) => a.message.includes("Appeal deadline"))!;
  assert.match(line.message, /180-day window published by Aetna Dental \(Dispute & Appeal Process Overview/);
  assert.match(line.message, /may change/, "a published default, and the record says a contract can change it");
  assert.doesNotMatch(line.message, /typical figure/);
  assert.match(line.message, /counted from 2026-09-01/);
});

test("B-1: a citation belongs to the number — an edited Aetna window is no longer Aetna's published term", async () => {
  /**
   * A practice that records its own negotiated 120 days has replaced Aetna's published default.
   * Labelling 120 with Aetna's document would name the payer as the source of the practice's figure —
   * the overstatement D1 removed, in the other direction.
   */
  const { service, playbook } = await wired();
  await playbook.savePayer({ slug: "aetna-dental", name: "Aetna Dental", appealWindowDays: 120 });

  const [edited] = await service.createFromVariance(
    variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-09-01" }),
    NOW
  );
  assert.equal(edited!.denial.appealWindowDays, 120, "the practice's number is the one used");
  assert.equal(edited!.denial.appealWindowSource, undefined, "and it carries no citation it does not have");
  assert.equal(edited!.deadlineSourced, false);
  assert.equal(edited!.deadlineNote, "Estimated 120-day window based on typical terms — confirm with payer.");
});

test("B-1: every other catalogued payer is still unsourced, and says so", async () => {
  const { service } = await wired();
  for (const payerId of ["delta-dental", "cigna-dental", "metlife-dental", "guardian-dental", "uhc-dental"]) {
    const [d] = await service.createFromVariance(
      variance({ postingId: `post-${payerId}`, payerId, payerName: payerId, paymentDate: "2026-09-01" }),
      NOW
    );
    assert.equal(d!.denial.appealWindowSource, undefined, `${payerId} has no citation`);
    assert.equal(d!.deadlineSourced, false);
    assert.match(d!.deadlineNote!, /typical terms/, `${payerId} is still labelled a typical figure`);
  }
});

test("B-1: an old denial written on the 60-day guess keeps its date and its estimate label", async () => {
  /**
   * The deadline is fixed when the denial is triaged, so a denial from before the correction still
   * holds the 60-day date. It is NOT relabelled as Aetna's published term — that would attach
   * Aetna's name to a date computed from Mermaid's guess.
   */
  const view = buildDenialView(
    {
      ...(await wired().then(({ service }) =>
        service.createFromVariance(
          variance({ payerId: "aetna-dental", payerName: "Aetna Dental", paymentDate: "2026-09-01" }),
          NOW
        )
      ))[0]!.denial,
      appealDeadline: "2026-10-31",
      appealWindowDays: 60,
      appealWindowSource: undefined,
    },
    NOW
  );
  assert.equal(view.deadlineSourced, false);
  assert.equal(view.deadlineNote, "Estimated 60-day window based on typical terms — confirm with payer.");
});
