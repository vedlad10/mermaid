/**
 * Denials & Appeals service — turn a payer's refusal into recovered money, or into an informed
 * decision not to chase it.
 *
 * Three things here carry more weight than ordinary orchestration:
 *
 *  1. **Creation is idempotent on (posting, reason code, procedure).** `variance.detected` is
 *     delivered at least once. A duplicated denial is duplicated work in a queue whose whole value
 *     is that everything in it is real — a biller who works the same crown twice stops trusting it.
 *
 *  2. **Nothing is sent without a named human.** `approveAppeal` requires an actor; `submitAppeal`
 *     refuses anything unapproved. An appeal is a factual assertion to a payer about a patient's
 *     care, and the human-in-the-loop workflow names appeal submission as a first-class gate — not
 *     a convention, a gate.
 *
 *  3. **The triage is FROZEN at decision time.** The playbook keeps learning; the odds a human saw
 *     when they decided to appeal must not change underneath them afterwards. An audit trail whose
 *     reasoning mutates is not an audit trail.
 */
import { randomUUID } from "node:crypto";
import {
  categorizeAdjustment,
  formatUsd,
  orderHistory,
  type AdjustmentCategory,
  type Cents,
  type HistoryEntry,
} from "@mermaid/shared";
import { NullEventPublisher, type EventPublisher, type VarianceDetectedBody } from "@mermaid/events";
import { PURSUABLE, type PayerProfileService } from "@mermaid/payer-profile";
import { findProcedure } from "@mermaid/shared";
import {
  applyAwardOutcome,
  applyAwardSettlement,
  attributeAward,
  claimAwardTotals,
  AWARD_OPEN_STATUSES,
  type Attribution,
} from "./engine/award.ts";
import { denialHistory } from "./engine/history.ts";
import { draftAppeal } from "./engine/letter.ts";
import { NoExplainer, type DenialExplainer, type DenialExplanation, type ExplanationReason } from "./engine/explanation.ts";
import { NoNarrator, type AppealNarrator } from "./engine/narrative.ts";
import { scoreDenial } from "./engine/priority.ts";
import type { DenialFilter, DenialRepository } from "./repository.ts";
import { DEFAULT_APPEAL_WINDOW_DAYS, OPEN_DENIAL_STATUSES } from "./types.ts";
import type { Appeal, Denial, DenialAuditEvent, DenialStatus, Triage } from "./types.ts";
import {
  buildDenialListItem,
  buildDenialView,
  buildRecoveryStats,
  type DenialListItem,
  type DenialView,
  type RecoveryStats,
} from "./view.ts";

export class DenialNotFoundError extends Error {
  constructor(id: string) {
    super(`denial ${id} not found`);
    this.name = "DenialNotFoundError";
  }
}

/** The action was refused because the denial or appeal is not in a state that permits it. */
export class DenialActionError extends Error {
  reason: string;
  constructor(id: string, reason: string) {
    super(`denial ${id}: ${reason}`);
    this.name = "DenialActionError";
    this.reason = reason;
  }
}

/**
 * Billing a patient for money the payer did not assign to them was refused (NEW-07).
 *
 * Its own error type because the route turns it into a 409 with a usable message, and because the
 * remedy is not "try again" — it is either write the amount off, or have somebody who holds
 * `denials.bill_patient_override` make the call deliberately. A generic `DenialActionError` would
 * read as a state problem, which this is not.
 */
export class ContractualDenialNotBillableError extends Error {
  // Explicit fields, not parameter properties: Node's type stripping forbids those (§12.15), and
  // every other error class in this module is written the same way.
  carcGroup: string | null;
  carcCode: string;
  category: AdjustmentCategory;

  constructor(id: string, carcGroup: string | null, carcCode: string, category: AdjustmentCategory) {
    super(
      `denial ${id}: the payer reported CARC ${carcCode} under adjustment group ` +
        `${carcGroup ?? "an unrecorded group"}, which is ${describeCategory(category)} — not the ` +
        `patient's. ${
          carcGroup?.trim().toUpperCase() === "CO"
            ? "A CO adjustment is the payer citing the practice's own contract, so charging it to " +
              "the patient is a contractual breach and, on many plans, balance-billing. "
            : ""
        }Write it off, appeal it, or have someone with the contractual-override permission bill it ` +
        `deliberately.`
    );
    this.name = "ContractualDenialNotBillableError";
    this.carcGroup = carcGroup;
    this.carcCode = carcCode;
    this.category = category;
  }
}

/** Plain English for the refusal message. The category name alone means nothing at a front desk. */
function describeCategory(category: AdjustmentCategory): string {
  switch (category) {
    case "contractual":
      return "a contractual adjustment the practice agreed to absorb";
    case "coordination":
      return "a coordination-of-benefits amount another plan has not yet accounted for";
    case "informational":
      return "an amount whose owner the payer did not state";
    default:
      return "money still recoverable from the payer";
  }
}

/**
 * How long a payer accepts an appeal after its own determination, when the payer profile has no
 * entry for it.
 *
 * ── THIS IS A FALLBACK NOW, NOT THE POLICY (M5) ────────────────────────────────────────────────
 * It used to be applied unconditionally, which meant every denial from every payer was stamped
 * `now + 90 days`. Meanwhile `payers.appeal_window_days` had existed since migration 0004, was
 * seeded per payer since 0014 (Aetna 60, UnitedHealthcare 60, Guardian 90, the rest 180), and was
 * read into the domain object by the repository — with no reader anywhere. So a biller working an
 * Aetna denial was shown thirty days of runway the payer does not give, on data this system already
 * held and simply never asked for.
 *
 * The window is now read from the profile and this stands only where the profile is silent.
 *
 * The value itself lives in `types.ts`, beside the sentence that quotes it to a biller, so the
 * number used and the number stated cannot drift. This keeps the module's public name unchanged.
 */
export { DEFAULT_APPEAL_WINDOW_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day an appeal window is counted from, and how confident we are about it.
 *
 * ── WHY THE PAYER'S DATE AND NOT OURS ──────────────────────────────────────────────────────────
 * A payer's appeal window runs from ITS determination — the date on the remittance advice — not
 * from the moment this software read the file. Anchoring to `detectedAt` made every deadline
 * exactly as generous as the ingest was late: an ERA polled a fortnight after the cheque, a file a
 * practice uploads at month end, or a backlog after an outage each quietly extended a deadline a
 * biller then worked to and missed.
 *
 * `paymentDate` is optional on the event (it is additive), so the fallback is stated rather than
 * hidden: when the payer's own date is absent the detection date is used AND the audit trail says
 * so, because a deadline nobody can account for is one nobody should rely on.
 */
function appealAnchor(payload: VarianceDetectedBody): { day: string; fromPayer: boolean } {
  const stated = payload.paymentDate?.trim();
  return stated
    ? { day: stated.slice(0, 10), fromPayer: true }
    : { day: payload.detectedAt.slice(0, 10), fromPayer: false };
}

export interface BillingIdentity {
  name: string;
}

export class DenialService {
  #repo: DenialRepository;
  #playbook: PayerProfileService;
  #provider: BillingIdentity;
  #publisher: EventPublisher;
  #narrator: AppealNarrator;
  #explainer: DenialExplainer;
  /** The practice’s IANA timezone — an appeal window is a calendar day in the clinic’s own day. */
  #timeZone: string;

  constructor(
    repo: DenialRepository,
    playbook: PayerProfileService,
    provider: BillingIdentity,
    publisher: EventPublisher = new NullEventPublisher(),
    /**
     * Optional AI drafting for the letter's argument paragraph. Defaults to `NoNarrator`, which is
     * the deterministic letter — the same one this service produced before AI existed. A one-method
     * port rather than the LLM adapter itself, so the module depends on a shape it owns and every
     * test can drive both branches without a provider.
     */
    narrator: AppealNarrator = NoNarrator,
    /**
     * Optional AI narration of WHY a payer withheld money. Defaults to `NoExplainer` — no
     * explanation is offered, and every deterministic thing on the screen is unchanged. Narration
     * only: it never triages, never disposition, never touches money.
     */
    explainer: DenialExplainer = NoExplainer,
    timeZone = "UTC"
  ) {
    this.#repo = repo;
    this.#playbook = playbook;
    this.#provider = provider;
    this.#publisher = publisher;
    this.#narrator = narrator;
    this.#explainer = explainer;
    this.#timeZone = timeZone;
  }

  /**
   * Create one denial per recoverable reason on a variance, triaging each against the playbook.
   *
   * Idempotent per reason, so a redelivered event adds nothing. Reasons the playbook says are not
   * pursuable still become denials — a clinic needs to see that a code was reviewed and consciously
   * not chased, otherwise "nothing in the queue" is indistinguishable from "nobody looked".
   */
  async createFromVariance(payload: VarianceDetectedBody, now: Date = new Date()): Promise<DenialView[]> {
    const views: DenialView[] = [];

    for (const reason of payload.reasons) {
      const existing = await this.#repo.getByPostingReason(payload.postingId, reason.code, reason.procedureCode);
      if (existing) {
        views.push(buildDenialView(existing, now, this.#timeZone));
        continue;
      }

      // The payer's OWN CAS group travels with the reason. Triage reads it rather than assuming
      // `CO`: a `PR` balance, an `OA` coordination amount and a `PI` reduction are not write-offs.
      const rule = await this.#playbook.resolve(
        payload.payerId,
        reason.code,
        reason.procedureCode,
        reason.group
      );

      /**
       * ── THE APPEAL DEADLINE (M5) ──────────────────────────────────────────────────────────────
       * Two facts, both of which used to be wrong at once: WHICH window this payer allows (read
       * from the profile, which has held it since migration 0004 with no reader), and WHAT DAY it
       * runs from (the payer's own determination, not the moment Mermaid read the file).
       *
       * A deadline on this screen is acted on. Getting either half wrong sends a biller to work a
       * denial after the window has closed — the appeal is discarded, the record says it was fought
       * for, and the money is unrecoverable.
       */
      const catalogued = await this.#playbook.appealWindowDays(payload.payerId);
      const windowIsCatalogued = Boolean(catalogued && catalogued > 0);
      const windowDays = windowIsCatalogued ? catalogued! : DEFAULT_APPEAL_WINDOW_DAYS;
      // Whether the payer's own document stands behind that window (B-1). Asked about the exact
      // number used, and never for the fallback, which is Mermaid's by definition.
      const windowSource = windowIsCatalogued ? this.#playbook.sourceOfWindow(payload.payerId, "appeal", windowDays) : null;
      const anchor = appealAnchor(payload);
      const appealDeadline = new Date(new Date(`${anchor.day}T00:00:00Z`).getTime() + windowDays * DAY_MS)
        .toISOString()
        .slice(0, 10);

      const scored = scoreDenial(
        {
          deniedAmount: reason.amount,
          overturnRate: rule.overturnRate,
          appealDeadline,
          appealDeadlineEstimated: !windowIsCatalogued,
          appealWindowDays: windowDays,
          appealWindowSource: windowSource,
          detectedAt: payload.detectedAt,
          quickWin: rule.disposition === "correct_resubmit",
        },
        now
      );

      const triage: Triage = {
        disposition: rule.disposition,
        overturnRate: rule.overturnRate,
        sampleSize: rule.sampleSize,
        trusted: rule.trusted,
        source: rule.source,
        recommendedAction: rule.recommendedAction,
        guidance: rule.guidance,
        explain: [...rule.explain, ...scored.explain],
        expectedRecovery: scored.expectedRecovery,
        triagedAt: now.toISOString(),
      };

      const denial: Denial = {
        id: randomUUID(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        status: "triaged",
        claimId: payload.claimId,
        remittanceId: payload.remittanceId,
        postingId: payload.postingId,
        carcCode: reason.code,
        carcDescription: reason.description,
        carcGroup: reason.group,
        procedureCode: reason.procedureCode,
        deniedAmount: reason.amount,
        payerId: payload.payerId,
        payerName: payload.payerName,
        patientName: payload.patientName,
        memberId: payload.memberId,
        claimControlNumber: payload.claimControlNumber,
        serviceDate: payload.serviceDate,
        triage,
        appealDeadline,
        // Provenance of the date above, carried so every surface can say which kind it is showing.
        appealDeadlineEstimated: !windowIsCatalogued,
        // The figure behind the date, so the sentence caveating it can quote the number rather than
        // recomputing it from an anchor this record does not keep.
        appealWindowDays: windowDays,
        // Written only when the payer's own document stands behind the window (B-1).
        ...(windowSource ? { appealWindowSource: windowSource } : {}),
        priority: scored.priority,
        appeals: [],
        recoveredAmount: null,
        closeReason: null,
        detectedAt: payload.detectedAt,
        audit: [
          audit(
            now,
            "system",
            `Denial detected: ${reason.group}-${reason.code} ${reason.description} withholding ` +
              `${formatUsd(reason.amount)}${reason.procedureCode ? ` on ${reason.procedureCode}` : ""}.`
          ),
          audit(
            now,
            "system",
            `Triaged as "${rule.disposition}" with ${Math.round(rule.overturnRate * 100)}% recovery odds ` +
              `(${rule.source}${rule.trusted ? ", trusted" : ", provisional"}). ` +
              `Expected recovery ${formatUsd(scored.expectedRecovery)}.`
          ),
          /**
           * Where the deadline came from, next to the deadline itself.
           *
           * A date on a screen that a biller plans around has to be accountable. Both halves are
           * named — the window and the day it runs from — and both say plainly how sure they are.
           *
           * ── "CATALOGUED TERMS" WAS THE PAYER'S WORD, AND IT IS NOT ─────────────────────────────
           * This line used to read "a 60-day window from Aetna Dental's catalogued terms", which
           * names the payer as the source of a figure the payer had no part in. `PAYER_CATALOG`
           * calls its own values the common commercial-dental defaults, and no edit path exists to
           * replace them — see `APPEAL_WINDOWS_ARE_PAYER_SOURCED`. A permanent record is the worst
           * place for that overstatement: the label beside the date now says "typical terms", while
           * the log a biller opens six months later said the payer stated it.
           *
           * Both branches now describe the same two facts they always did — which window, and
           * whether Mermaid picked it — without either claiming an authority it does not have.
           */
          audit(
            now,
            "system",
            `Appeal deadline ${appealDeadline}: a ${windowDays}-day window ` +
              `${windowSource
                ? // B-1: named by its document, and still qualified — the payer's own words say the
                  // contract or state law can change it.
                  `published by ${windowSource.publisher} (${windowSource.document}) — the payer's ` +
                  `stated default, which a participation agreement or state rule may change, so confirm ` +
                  `it against the contract`
                : windowIsCatalogued
                ? `catalogued for ${payload.payerName} — a typical figure, not terms this payer ` +
                  `stated, so confirm it before relying on this date`
                : `ASSUMED from Mermaid's ${DEFAULT_APPEAL_WINDOW_DAYS}-day default, because this payer is not ` +
                  `catalogued — no payer stated this date, and it must be confirmed before it is relied on`}, ` +
              `counted from ${anchor.day} — ` +
              `${anchor.fromPayer
                ? "the payer's own determination date on the remittance"
                : "the date this denial was detected, because the remittance stated no payment date. " +
                  "Confirm the payer's determination date before relying on this deadline"}.`
          ),
        ],
      };

      const saved = await this.#repo.save(denial);
      await this.#publishCreated(saved, now);
      views.push(buildDenialView(saved, now, this.#timeZone));
    }

    return views;
  }

  async get(id: string, now: Date = new Date()): Promise<DenialView | null> {
    const denial = await this.#repo.getById(id);
    return denial ? buildDenialView(denial, now, this.#timeZone) : null;
  }

  /** The recovery worklist: highest expected recovery, adjusted for urgency, first. */
  async list(filter?: DenialFilter, now: Date = new Date()): Promise<DenialListItem[]> {
    const denials = await this.#repo.list(filter);
    return denials
      .map((d) => buildDenialListItem(d, now, this.#timeZone))
      .sort((a, b) => b.priority - a.priority || b.detectedAt.localeCompare(a.detectedAt));
  }

  /**
   * This context's contribution to a chronology (M14 deliverable 4).
   *
   * Includes the appeals inside each denial, because an appeal has no life of its own — it is what a
   * person did about one payer decision, and separating them on a patient's record would make the
   * two halves of one story read as two unrelated events.
   */
  async history(filter?: DenialFilter): Promise<HistoryEntry[]> {
    const denials = await this.#repo.list(filter);
    return orderHistory(denials.flatMap(denialHistory));
  }

  /**
   * The recovery scoreboard, over every denial rather than a filtered page.
   *
   * "Of the money we chased, how much came back?" is a question about the practice, not about
   * whatever the UI is currently showing — computing it from a filtered list would quietly answer a
   * different question than the one on screen.
   */
  async recoveryStats(now: Date = new Date()): Promise<RecoveryStats> {
    return buildRecoveryStats(await this.#repo.list(), now, this.#timeZone);
  }

  /**
   * Draft an appeal. Produces a letter and, more usefully, the evidence checklist a human must
   * actually gather. Drafting is NOT sending — the appeal is created in `draft` and goes nowhere.
   */
  async draftAppeal(
    id: string,
    /**
     * Optional CORRECTIONS only.
     *
     * The denial already carries the member ID, claim control number and date of service — they
     * arrive on `variance.detected`, from the expectation the claim recorded when it was filed. This
     * argument exists for the case where a human knows better than the file (a payer that reissued a
     * claim number, say), never as the primary source. It used to be the primary source, and because
     * the UI could not know any of these values it passed empty strings, so appeals reached payers
     * reading "Claim [claim number] … Member ID: [member ID]".
     */
    context: Partial<{ memberId: string; claimControlNumber: string; serviceDate: string }> = {},
    now: Date = new Date()
  ): Promise<DenialView> {
    const denial = await this.#require(id);
    // No "has it been triaged?" guard: `triage` is non-nullable (B3), and an untriaged denial has
    // never been constructible. The compiler enforces what this runtime check used to assert.
    if (!PURSUABLE.includes(denial.triage.disposition)) {
      throw new DenialActionError(
        id,
        `the playbook says to ${denial.triage.disposition.replace(/_/g, " ")}, not to appeal — ` +
          `override that decision explicitly before drafting`
      );
    }
    if (denial.appeals.some((a) => a.status === "draft" || a.status === "submitted")) {
      throw new DenialActionError(id, "an appeal is already open on it");
    }

    const memberId = context.memberId?.trim() || denial.memberId || "";
    const claimControlNumber = context.claimControlNumber?.trim() || denial.claimControlNumber || "";

    /**
     * ── A LETTER A PAYER CANNOT ACT ON IS WORSE THAN NO LETTER ──────────────────────────────────
     *
     * The two identifiers below are how a payer finds the claim being appealed. Without them the
     * template fell back to literal placeholders and the appeal went out reading
     * "RE: APPEAL — Claim [claim number] … Member ID: [member ID]".
     *
     * That is not a cosmetic defect. The appeal is recorded as sent, the denial leaves the recovery
     * queue, the appeal window keeps running, and the payer discards a letter that identifies
     * nothing — so the practice loses the money AND the record says it was fought for. A refusal a
     * biller can act on is strictly better than a letter nobody can.
     *
     * They normally arrive on `variance.detected` from the expectation the claim recorded when it
     * was filed, so this fires only when that chain was broken: an 835 for a claim filed outside
     * Mermaid, or one whose expectation was never written. The `context` argument is the way out —
     * a human supplies what the file does not have.
     */
    const missing = [
      memberId ? null : "the member ID",
      claimControlNumber ? null : "the claim control number",
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      throw new DenialActionError(
        id,
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing, and ${denial.payerName} ` +
          `cannot match an appeal without ${missing.length === 1 ? "it" : "them"} — supply ` +
          `${missing.length === 1 ? "it" : "them"} with the draft request, from the payer's ` +
          `remittance advice or the filed claim`
      );
    }

    const level = denial.appeals.length + 1;
    const letterContext = {
      level,
      payerName: denial.payerName,
      patientName: denial.patientName,
      memberId,
      claimControlNumber,
      serviceDate: context.serviceDate?.trim() || denial.serviceDate || denial.detectedAt.slice(0, 10),
      procedureCode: denial.procedureCode,
      carcCode: denial.carcCode,
      carcDescription: denial.carcDescription,
      deniedAmount: denial.deniedAmount,
      /**
       * What an earlier appeal already brought in (F-5/F-7 fallout). Zero on a first appeal, which
       * is nearly all of them; above zero only where a previous level was won and the payer has
       * already sent part of the money. Without it the letter demanded the full original sum from a
       * payer that had already paid some of it.
       */
      alreadyRecovered: (denial.awardSettledAmount ?? 0) as Cents,
      guidance: denial.triage.guidance,
      providerName: this.#provider.name,
    };

    /**
     * ── THE AI STEP, AND WHERE IT SITS ──────────────────────────────────────────────────────────
     *
     * After the disposition (the playbook decided this is worth appealing, above), after the
     * identifiers are verified present, and after the evidence checklist is derived — and before the
     * human gate, which is unchanged. The model writes one paragraph of an argument and touches
     * nothing else.
     *
     * The deterministic letter is built FIRST, unconditionally. That ordering is deliberate: the
     * checklist feeds the prompt, and building the real letter before asking for prose means the
     * fallback is not constructed in a hurry on a failure path that is rarely exercised. Whatever
     * happens next, there is already a correct, sendable letter in hand.
     *
     * `narrate` cannot throw — the router degrades rather than raising — but this is wrapped anyway,
     * because a drafting feature must not be able to take down the recovery of real money if a
     * future narrator implementation is less careful than the current one.
     */
    const deterministic = draftAppeal(letterContext);
    const procedure = denial.procedureCode ? findProcedure(denial.procedureCode) : undefined;
    const narrative = await this.#narrator
      .narrate({
        level,
        payerName: denial.payerName,
        procedureCode: denial.procedureCode,
        procedureDescription: procedure?.description ?? null,
        carcCode: denial.carcCode,
        carcDescription: denial.carcDescription,
        guidance: denial.triage.guidance,
        checklist: deterministic.checklist,
      })
      .catch(() => null);

    const draft = narrative ? draftAppeal(letterContext, narrative.text) : deterministic;

    const appeal: Appeal = {
      id: randomUUID(),
      denialId: denial.id,
      level,
      status: "draft",
      letter: draft.letter,
      checklist: draft.checklist,
      narrative,
      approvedBy: null,
      approvedAt: null,
      submittedAt: null,
      outcomeRecordedAt: null,
      recoveredAmount: null,
      outcomeNotes: null,
      createdAt: now.toISOString(),
    };

    const updated: Denial = {
      ...denial,
      status: "appealing",
      updatedAt: now.toISOString(),
      appeals: [...denial.appeals, appeal],
      audit: [
        ...denial.audit,
        audit(
          now,
          "system",
          `Level-${level} appeal drafted with ${draft.checklist.length} evidence item(s)` +
            // Named in the audit trail, not just in the record. Six months from now the question
            // "was that paragraph written by a machine?" must be answerable from the denial's own
            // history, not by knowing which fields to go and read.
            (narrative
              ? `; the argument paragraph was drafted by AI (${narrative.provider}${narrative.model ? `/${narrative.model}` : ""}) and requires human review.`
              : "."),
        ),
      ],
    };
    return buildDenialView(await this.#repo.update(updated), now, this.#timeZone);
  }

  /**
   * Explain, in plain English, why the payer withheld this money (workflow S10/S13; §11).
   *
   * ── NARRATION, AND NOTHING ELSE ─────────────────────────────────────────────────────────────
   * Nothing here is persisted, nothing is decided, and no state changes. The denial's reason code,
   * its description, the amount and the recommended action are all deterministic, already computed,
   * and already on the screen — this adds one optional sentence over the top of them, and returns
   * `null` when the AI layer is off, degraded, or its output was refused.
   *
   * The reason it is worth a service method rather than a call from the transport layer: the value
   * of the sentence comes from the OTHER codes on the same claim (§11's "multi-code context"), and
   * assembling those is a repository read this module owns. A payer that withheld money for a
   * missing tooth number and separately bundled a second procedure has told one story in two codes,
   * and neither code alone contains it.
   */
  async explain(id: string): Promise<DenialExplanation | null> {
    const denial = await this.#require(id);

    // Every denial raised on the same claim — this one included, then removed. Read through the
    // module's own repository on the indexed `claimIds` filter, never by reaching into another
    // context's tables.
    const onSameClaim = await this.#repo.list({ claimIds: [denial.claimId] });
    const siblings = onSameClaim.filter((other) => other.id !== denial.id).map(toReason);

    return this.#explainer
      .explain({
        payerName: denial.payerName,
        focus: toReason(denial),
        siblings,
        disposition: denial.triage.disposition,
      })
      .catch(() => null);
  }

  /**
   * A human rewrites the drafted letter before approving it.
   *
   * ── WHY THIS IS ITS OWN ACTION, AND WHY IT REVOKES APPROVAL ─────────────────────────────────
   * Editing is what makes an AI-drafted paragraph safe to offer at all. A draft a biller can only
   * accept or reject wholesale is a draft they will accept when it is 90% right, and the missing 10%
   * of an appeal letter is a factual assertion to a payer about a patient's care.
   *
   * It clears any existing approval, and that is the load-bearing half. An approval is a named
   * person's signature on *specific words*; if the words can change afterwards while the signature
   * stays, the record says someone approved a letter they never read. Whoever edits last must
   * re-approve, even if they are the same person — which costs one click and removes an entire class
   * of "who authorised this sentence?" that has no good answer after the fact.
   *
   * The evidence checklist is NOT editable here. It is derived from what the procedure and the
   * reason code actually require, and a letter is not made better by removing the radiograph it
   * needs from the list of things to enclose.
   */
  async reviseAppeal(id: string, letter: string, revisedBy: string, now: Date = new Date()): Promise<DenialView> {
    const denial = await this.#require(id);
    const actor = revisedBy.trim();
    if (!actor) throw new DenialActionError(id, "a revising user is required");

    const appeal = denial.appeals.find((a) => a.status === "draft");
    if (!appeal) throw new DenialActionError(id, "there is no drafted appeal to revise");

    const revised = letter.trim();
    if (revised.length < 80) {
      throw new DenialActionError(id, "the revised letter is too short to be a letter a payer can act on");
    }
    // The same refusal the drafting engine makes, for the same reason — a human can paste a
    // placeholder as easily as a template can emit one, and the payer cannot act on either.
    if (/\[[^\]]*\]/.test(revised)) {
      throw new DenialActionError(
        id,
        "the revised letter still contains placeholder text in square brackets — a payer cannot act on it"
      );
    }

    const wasApproved = appeal.approvedBy;
    const updated: Denial = {
      ...denial,
      updatedAt: now.toISOString(),
      appeals: denial.appeals.map((a) =>
        a.id === appeal.id ? { ...a, letter: revised, approvedBy: null, approvedAt: null } : a
      ),
      audit: [
        ...denial.audit,
        audit(
          now,
          "staff",
          `Level-${appeal.level} appeal letter edited by ${actor}` +
            (wasApproved
              ? `; the earlier approval by ${wasApproved} was cleared, because it signed off different wording.`
              : ".")
        ),
      ],
    };
    return buildDenialView(await this.#repo.update(updated), now, this.#timeZone);
  }

  /**
   * THE HUMAN GATE. A person reviews the drafted letter, confirms the evidence is gathered, and puts
   * their name to it. Nothing reaches a payer without this.
   */
  async approveAppeal(id: string, approvedBy: string, now: Date = new Date()): Promise<DenialView> {
    const denial = await this.#require(id);
    const actor = approvedBy.trim();
    if (!actor) throw new DenialActionError(id, "an approving user is required");

    const appeal = denial.appeals.find((a) => a.status === "draft");
    if (!appeal) throw new DenialActionError(id, "there is no drafted appeal to approve");

    const updated: Denial = {
      ...denial,
      updatedAt: now.toISOString(),
      appeals: denial.appeals.map((a) =>
        a.id === appeal.id ? { ...a, approvedBy: actor, approvedAt: now.toISOString() } : a
      ),
      audit: [...denial.audit, audit(now, "staff", `Level-${appeal.level} appeal approved by ${actor}.`)],
    };
    return buildDenialView(await this.#repo.update(updated), now, this.#timeZone);
  }

  /** Send an approved appeal. Refuses anything a human has not signed off. */
  async submitAppeal(id: string, now: Date = new Date()): Promise<DenialView> {
    const denial = await this.#require(id);
    const appeal = denial.appeals.find((a) => a.status === "draft");
    if (!appeal) throw new DenialActionError(id, "there is no drafted appeal to submit");
    if (!appeal.approvedBy) {
      throw new DenialActionError(id, "the appeal has not been approved by a person — it cannot be sent");
    }

    const updated: Denial = {
      ...denial,
      status: "appealed",
      updatedAt: now.toISOString(),
      appeals: denial.appeals.map((a) =>
        a.id === appeal.id ? { ...a, status: "submitted" as const, submittedAt: now.toISOString() } : a
      ),
      audit: [
        ...denial.audit,
        audit(now, "staff", `Level-${appeal.level} appeal submitted to ${denial.payerName}.`),
      ],
    };
    return buildDenialView(await this.#repo.update(updated), now, this.#timeZone);
  }

  /**
   * Record what the payer decided. **This is where the learning loop closes** — the outcome is
   * published, and the payer profile adjusts its overturn rate so the next denial of this code is
   * triaged against evidence rather than a prior.
   */
  async recordOutcome(
    id: string,
    input: { won: boolean; recoveredAmount?: Cents; notes?: string; recordedBy: string },
    now: Date = new Date()
  ): Promise<DenialView> {
    const denial = await this.#require(id);
    const actor = input.recordedBy.trim();
    if (!actor) throw new DenialActionError(id, "a recording user is required");

    /**
     * The recovered amount becomes the permanent record on the denial, feeds the recovery
     * scoreboard, and rides `appeal.outcome.recorded` into the learning loop — so a NaN (which
     * JSONB silently stores as null) or a negative figure is corruption at the source, not a
     * display problem. The same rule the ledger applies to every human money entry.
     */
    if (
      input.recoveredAmount !== undefined &&
      (!Number.isInteger(input.recoveredAmount) || input.recoveredAmount < 0)
    ) {
      throw new DenialActionError(id, "the recovered amount must be a non-negative whole number of cents");
    }

    const appeal = denial.appeals.find((a) => a.status === "submitted");
    if (!appeal) throw new DenialActionError(id, "there is no submitted appeal awaiting an outcome");

    const recovered = (input.won ? (input.recoveredAmount ?? denial.deniedAmount) : 0) as Cents;

    /**
     * ── A WIN PRODUCES A RECEIVABLE, NOT A RECOVERY (F-2) ────────────────────────────────────────
     * This used to write `status: "recovered"` and a `recoveredAmount` directly, and `recovered` is
     * a CLOSED status — so recording a win emptied the Recover worklist, closed the denial, and
     * reported money as recovered while nothing had arrived. The state machine now lives in
     * `engine/award.ts`: a win becomes `awaiting_payment` with the figure in `awardedAmount`, and
     * only posted cash can move it to `recovered`.
     *
     * `input.recoveredAmount` keeps its name on the WIRE — the route and its callers are unchanged
     * — but it is the AWARD being recorded, which is what it always actually was.
     */
    const withOutcome = applyAwardOutcome(
      denial,
      { won: input.won, awardedAmount: recovered, recordedBy: actor, notes: input.notes },
      now
    );
    const updated: Denial = {
      ...withOutcome,
      appeals: denial.appeals.map((a) =>
        a.id === appeal.id
          ? {
              ...a,
              status: (input.won ? "won" : "lost") as Appeal["status"],
              outcomeRecordedAt: now.toISOString(),
              recoveredAmount: recovered,
              outcomeNotes: input.notes ?? null,
            }
          : a
      ),
    };
    const saved = await this.#repo.update(updated);

    await this.#publisher.publish(
      "appeal.outcome.recorded",
      saved.id,
      {
        denialId: saved.id,
        appealId: appeal.id,
        claimId: saved.claimId,
        claimControlNumber: saved.claimControlNumber,
        recordedAt: now.toISOString(),
        recordedBy: actor,
        payerId: saved.payerId,
        payerName: saved.payerName,
        carcCode: saved.carcCode,
        procedureCode: saved.procedureCode,
        level: appeal.level,
        won: input.won,
        deniedAmount: saved.deniedAmount,
        recoveredAmount: recovered,
      },
      { occurredAt: now }
    );

    return buildDenialView(saved, now, this.#timeZone);
  }


  /**
   * Attribute cash from a posting to whichever award on this claim it settles (F-2, step two).
   *
   * ── WHY THIS IS DRIVEN BY AN EVENT AND NOT A CALL ─────────────────────────────────────────────
   * Remittance may not read this module's tables and this module may not read Remittance's
   * (docs/MODULE-BOUNDARIES.md), so the two halves of a settlement meet at the composition root:
   * `remittance.posted` is published by Remittance and a subscriber in `apps/web/wiring.ts` calls
   * this. That keeps the direction of knowledge one-way — nothing here knows what a posting is
   * beyond the four facts the event carries.
   *
   * ── WHAT MAKES IT SAFE UNDER AT-LEAST-ONCE DELIVERY ───────────────────────────────────────────
   * Every property is a consequence of `applyAwardSettlement` recording the POSTING ID rather than
   * accumulating a number:
   *
   *   • a redelivered event finds the posting already in the set and changes nothing;
   *   • a worker retry after a partial failure is the same no-op;
   *   • cash that arrived BEFORE the award existed is picked up, because this runs again on every
   *     `remittance.posted` and the award's own handler re-reads the claim's postings;
   *   • two different postings both count, because they are different keys.
   *
   * Returns the denials it changed, so the caller can push the recomputed receivable to the
   * projection that mirrors it (invariant S1).
   */
  async settleAwardsFromPosting(
    input: {
      claimId: string;
      postingId: string;
      /** What the payer actually sent on this posting. Cash — never an estimate, never an award. */
      paidAmount: Cents;
      /** Procedure codes this advice referenced, used to attribute when several awards are open. */
      procedureCodes?: string[];
    },
    now: Date = new Date()
  ): Promise<{ settled: DenialView[]; attribution: Attribution }> {
    if (input.paidAmount <= 0) {
      return { settled: [], attribution: { kind: "none", reason: "the posting carried no cash" } };
    }

    const onClaim = await this.#repo.list({ claimIds: [input.claimId] });
    const open = onClaim.filter((d) => AWARD_OPEN_STATUSES.includes(d.status));
    const lines = (input.procedureCodes ?? [null]).map((procedureCode) => ({
      procedureCode,
      amount: input.paidAmount,
    }));

    const attribution = attributeAward(open, lines);
    if (attribution.kind === "none" || attribution.kind === "ambiguous") {
      /**
       * Nothing is settled, and that is deliberate. The cash has already posted to the claim and the
       * ledger by the time this runs — only the AWARD credit waits, so no money is lost or invented
       * by refusing. Guessing which of several awards a payer meant would be a coin flip wearing the
       * costume of a rule.
       */
      /**
       * The ambiguity is REPORTED rather than logged from here: this module has no logger, and
       * deliberately so — it is a pure domain service and the composition root owns observability.
       * Everything a caller needs to raise an alert is in `attribution`.
       */
      return { settled: [], attribution };
    }

    const target = open.find((d) => d.id === attribution.denialId);
    if (!target) return { settled: [], attribution: { kind: "none", reason: "award vanished between read and write" } };

    const updated = applyAwardSettlement(
      target,
      { cash: input.paidAmount, postingId: input.postingId },
      now
    );
    /** Already settled by this posting — a replay. Nothing written, nothing published. */
    if (updated === target) return { settled: [], attribution };

    const saved = await this.#repo.update(updated);

    /**
     * Tell Remittance how much of the posting this denial came from has stopped being pursuable
     * (F-5). Without it the Recover worklist keeps advertising money that has already come back:
     * the appeal is won, the cash is posted, the denial reads `recovered`, and the posting still
     * offers the original amount to chase.
     *
     * The TOTAL is published rather than a delta, so a redelivered event converges instead of
     * accumulating — the same assignment-not-increment rule the settlement itself follows.
     */
    await this.#publisher.publish(
      "denial.recovery.settled",
      saved.id,
      {
        denialId: saved.id,
        claimId: saved.claimId,
        postingId: saved.postingId,
        resolvedAmount: (saved.awardSettledAmount ?? 0) as Cents,
        awardedAmount: (saved.awardedAmount ?? 0) as Cents,
        settledAmount: (saved.awardSettledAmount ?? 0) as Cents,
        status: saved.status,
        settledAt: now.toISOString(),
      },
      { occurredAt: now }
    );

    return { settled: [buildDenialView(saved, now, this.#timeZone)], attribution };
  }

  /** What this claim's open awards still expect from the payer — the figure S1 mirrors. */
  async awardOutstandingForClaim(claimId: string): Promise<Cents> {
    const onClaim = await this.#repo.list({ claimIds: [claimId] });
    return claimAwardTotals(onClaim).outstanding;
  }
  /** Close a denial without appealing — written off, or moved to the patient's balance. */
  async close(
    id: string,
    input: {
      as: "written_off" | "patient_billed";
      reason: string;
      closedBy: string;
      /**
       * Bill the patient anyway, for an adjustment the payer did not assign to them (NEW-07).
       *
       * The ROUTE gates this on `denials.bill_patient_override`; the service only knows whether it
       * was granted. Kept as a parameter rather than a role check because this module has no
       * session and should not grow one — authorization is the transport's job, and the refusal
       * below is the domain's.
       */
      overrideContractualBar?: boolean;
    },
    now: Date = new Date()
  ): Promise<DenialView> {
    const denial = await this.#require(id);
    const actor = input.closedBy.trim();
    const reason = input.reason.trim();
    if (!actor) throw new DenialActionError(id, "a closing user is required");
    if (!reason) throw new DenialActionError(id, "a reason is required to close a denial");
    if (!OPEN.includes(denial.status)) throw new DenialActionError(id, `it is already ${denial.status}`);

    /**
     * ── THE PATIENT MAY ONLY BE BILLED WHAT THE PAYER ASSIGNED TO THEM (NEW-07) ─────────────────
     *
     * The automatic path has always enforced this: `categorizeAdjustment` sends a `contractual`
     * adjustment to `post_normal` and only a `patient` one (group PR) to `patient_resp`. The MANUAL
     * close enforced nothing at all, so `denials.write` — which a biller holds for ordinary work —
     * moved any denial to the patient's balance, including one the payer had explicitly labelled
     * contractual.
     *
     * A `CO` adjustment is the payer citing the practice's OWN CONTRACT: the practice agreed this
     * amount would not be charged to the patient. Billing it anyway is a contractual breach and, on
     * many plans, balance-billing. And it is not a hypothetical hole — `denial.closed` with
     * `closedAs: "patient_billed"` is what the patient ledger subscribes to, so the charge lands on
     * a real statement.
     *
     * An UNKNOWN group is refused for the same reason every unknown in this codebase is: a denial
     * written before the group was recorded carries `null`, and "we do not know whose money this
     * is" must never resolve to "the patient's". That is the direction that costs a patient money
     * they do not owe, and it is the one nobody would notice.
     */
    if (input.as === "patient_billed" && !input.overrideContractualBar) {
      const group = (denial.carcGroup ?? "").trim().toUpperCase();
      const category = categorizeAdjustment(group, denial.carcCode);
      /**
       * Three refusals, and the reasons differ:
       *
       *   • group `CO` — "Contractual Obligation" is, by definition of the group, PROVIDER
       *     liability. That is true whatever the CARC says: CO/197 (no pre-authorization) is the
       *     practice's failure to obtain one, not the patient's, and the contract says so.
       *   • category `contractual` — the same conclusion reached from the CODE rather than the
       *     group, which catches a payer that codes a fee-schedule reduction under something else.
       *   • an ABSENT group — a denial recorded before the group was kept carries null, and "we do
       *     not know whose money this is" must not resolve to "the patient's". That is the
       *     direction that costs a patient money they do not owe, and the one nobody would notice.
       *
       * `PI` and `OA` are deliberately NOT refused. A payer-initiated reduction and a coordination
       * amount are both cases where a human can legitimately conclude the balance is the patient's
       * — after the secondary plan declines, say — and refusing those would push staff to route the
       * charge somewhere this system cannot see.
       */
      if (group === "" || group === "CO" || category === "contractual") {
        throw new ContractualDenialNotBillableError(id, denial.carcGroup, denial.carcCode, category);
      }
    }

    const updated: Denial = {
      ...denial,
      status: input.as,
      updatedAt: now.toISOString(),
      recoveredAmount: 0 as Cents,
      closeReason: reason,
      audit: [
        ...denial.audit,
        audit(
          now,
          "staff",
          `Closed as ${input.as.replace(/_/g, " ")} by ${actor}: ${reason}` +
            // Named in the trail, not merely permitted. "Who decided to bill a patient for a
            // contractual adjustment, and when?" is the question this answers, and it has to be
            // answerable from the denial itself rather than by joining two logs.
            (input.overrideContractualBar && input.as === "patient_billed"
              ? ` [OVERRIDE: billed to the patient despite adjustment group ${denial.carcGroup ?? "unknown"}, ` +
                `which the payer did not assign to them]`
              : ""),
        ),
      ],
    };
    const saved = await this.#repo.update(updated);

    /**
     * Announce where the money went.
     *
     * Closing as `patient_billed` used to be the end of the money's story: the denial went grey and
     * the amount was never charged to anybody. Deciding not to pursue a payer is only half a
     * decision — the patient ledger subscribes to the other half.
     */
    await this.#publisher.publish(
      "denial.closed",
      saved.id,
      {
        denialId: saved.id,
        claimId: saved.claimId,
        closedAt: now.toISOString(),
        closedBy: actor,
        closedAs: input.as,
        reason,
        payerId: saved.payerId,
        payerName: saved.payerName,
        carcCode: saved.carcCode,
        patientName: saved.patientName,
        memberId: saved.memberId,
        deniedAmount: saved.deniedAmount,
      },
      { occurredAt: now }
    );

    return buildDenialView(saved, now, this.#timeZone);
  }

  async #publishCreated(denial: Denial, now: Date): Promise<void> {
    await this.#publisher.publish(
      "denial.created",
      denial.id,
      {
        denialId: denial.id,
        claimId: denial.claimId,
        remittanceId: denial.remittanceId,
        detectedAt: denial.detectedAt,
        payerId: denial.payerId,
        payerName: denial.payerName,
        carcCode: denial.carcCode,
        carcDescription: denial.carcDescription,
        procedureCode: denial.procedureCode,
        deniedAmount: denial.deniedAmount,
        disposition: denial.triage.disposition,
        overturnRate: denial.triage.overturnRate,
        expectedRecovery: denial.triage.expectedRecovery,
        priority: denial.priority,
        appealDeadline: denial.appealDeadline,
      },
      { occurredAt: now }
    );
  }

  /**
   * The read every mutating path starts from — `lockById`, never `getById` (same discipline as
   * Claims). Every action here is read-modify-write over the whole aggregate; unlocked, an approve
   * racing a revise commits the OLD letter carrying the NEW signature and drops the revision.
   * `explain()` also passes through here and takes the lock; it mutates nothing, but it is only
   * reachable as a deliberate per-denial action, so the serialization costs nobody anything.
   */
  async #require(id: string): Promise<Denial> {
    const denial = await this.#repo.lockById(id);
    if (!denial) throw new DenialNotFoundError(id);
    return denial;
  }
}

/**
 * Statuses a denial may be CLOSED from — every status where the money is still in play.
 *
 * ── WHY THIS IS THE FULL OPEN SET ──────────────────────────────────────────────────────────────
 * It was the pre-Phase-3 three, and closing is exactly the act of taking money out of play, so
 * narrowing it created a dead end: an appeal won and never paid could not be written off or billed,
 * and the refusal read "it is already awaiting_payment" — a sentence that tells a biller the denial
 * is finished when the truth is that nothing will finish it.
 *
 * That state is not hypothetical; it is the ordinary end of a won appeal the payer never honours,
 * after the window to chase it has closed. Money the practice has decided to stop pursuing must be
 * able to leave the worklist, or the worklist accumulates items no action can clear.
 *
 * The contractual bar on billing a patient is unaffected — it is checked separately below, on what
 * the payer assigned rather than on the denial's status.
 */
const OPEN = [...OPEN_DENIAL_STATUSES];

/**
 * A denial, narrowed to what a model may see.
 *
 * The narrowing is the point. `Denial` carries a patient name, a member ID, a claim control number,
 * a service date and an amount; `ExplanationReason` carries none of them, so this function is the
 * one place PHI is dropped and the type system enforces that nothing downstream can put it back.
 *
 * `remarks` is empty today: RARC codes are parsed by the 835 codec and categorized into the
 * variance, but they are not carried onto the denial record, which is keyed on the CARC. Wiring them
 * through is a `variance.detected` payload change, and it is worth doing precisely because §11 names
 * free-text remarks as the honest value-add here — the field exists so that change is additive.
 */
function toReason(denial: Denial): ExplanationReason {
  return {
    carcCode: denial.carcCode,
    carcDescription: denial.carcDescription,
    // The group as the payer actually sent it. NOT assumed to be "CO": `categorizeAdjustment` makes
    // PI-group adjustments recoverable too, so a payer-initiated reduction arrives here looking
    // exactly like a contractual one, and telling the model "group CO" about it would be a false
    // statement about whose decision it was. Null on pre-existing denials, and omitted then.
    group: denial.carcGroup,
    procedureCode: denial.procedureCode,
    remarks: [],
  };
}

const audit = (now: Date, actor: DenialAuditEvent["actor"], message: string): DenialAuditEvent => ({
  timestamp: now.toISOString(),
  actor,
  message,
});
