/**
 * Remittance service — receive a payer's 835, gate it on money safety, post it, and publish what
 * the clinic needs to act on.
 *
 * Three properties this layer is responsible for, all of them about money rather than convenience:
 *
 *  1. **A payment posts exactly once.** Guarded here AND by the repository's unique key, because
 *     the clearinghouse re-serves ERAs, the outbox delivers at least once, and staff re-upload files.
 *     Re-ingesting returns the existing remittance untouched rather than throwing — a duplicate
 *     delivery is normal traffic, not an error. The key is the payer's trace number when there is
 *     one and a derived value when there is not (`dedupeKeyFor`), because a TRN is situational in
 *     an 835 and keying on it directly made every trace-less file a duplicate of every other.
 *
 *  2. **Nothing posts from an advice that fails the safety gate.** It is held, with the exact
 *     findings a human needs. Refusing to post is always the cheaper failure.
 *
 *  3. **`variance.detected` is raised only for genuinely recoverable money.** Contractual write-offs
 *     and patient balances are not denials; publishing them would flood the recovery queue until
 *     staff stopped reading it.
 *
 * Every collaborator is injected. No parameter properties (Node type-stripping forbids them).
 */
import { createHash, randomUUID } from "node:crypto";
import { addCents, formatUsd, type Cents, expectationFor } from "@mermaid/shared";
import type { EdiAdapter, RemittanceAdvice, RemittanceRequest } from "@mermaid/edi";
import {
  NullEventPublisher,
  type ClaimSubmittedBody,
  type EventPublisher,
  type StatutoryClockObservedBody,
} from "@mermaid/events";
import { allowedFromLine, chargedPerUnit, contractualWriteOff } from "@mermaid/payer-profile";

/**
 * The practice's merchant discount rate, or a way to find it.
 *
 * A plain number (or null) is what a single-practice deployment passes and what every existing
 * caller passes. A FUNCTION is what a multi-practice deployment passes, because the rate belongs
 * to whichever practice's transaction this posting is running inside — and that is not knowable
 * when the service is constructed, only when a remittance posts.
 */
export type MerchantRate = number | null | (() => Promise<number | null>);

const resolveMerchantRate = async (rate: MerchantRate): Promise<number | null> =>
  typeof rate === "function" ? await rate() : rate;
import {
  adjudicationOf,
  duplicateFindings,
  UNRELEASABLE_SAFETY_CODES,
  type DuplicateCandidate,
  checkRemittanceSafety,
  reconcile,
  type ClaimContext,
  type PriorPayment,
  type ReconciliationReport,
  type SafetyFinding,
  type SafetyResult,
} from "./engine/safety.ts";
import { checkPayee, payeeMismatchMessage } from "./era/payee.ts";
import type { EraArtifactRepository } from "./era/repository.ts";
import type { EraArtifact, EraProvenance } from "./era/types.ts";
import { computeVariance, restatesPatientResponsibility } from "./engine/variance.ts";
import { assessPaymentMethod } from "./engine/payment-method.ts";
import {
  DuplicateRemittanceError,
  type ExpectationRepository,
  type HeldRemittanceSummary,
  type RemittanceFilter,
  type RemittanceRepository,
  type CoordinationRepository,
  InMemoryCoordinationRepository,
} from "./repository.ts";
import type { Posting, Remittance, RemittanceAuditEvent, VarianceReason } from "./types.ts";
import {
  closeSecondaryWork,
  confirmCoverage,
  markSecondaryFiled,
  recordSignal,
  requestConfirmation,
  signalOf,
  type CloseInput,
  type ConfirmCoverageInput,
  type CoordinationCase,
  type CoordinationEvidence,
  type FilingInput,
  type RequestInput,
} from "./coordination.ts";
import {
  buildRecoveryQueue,
  buildRemittanceListItem,
  buildRemittanceView,
  type RecoveryItem,
  type RemittanceListItem,
  type RemittanceView,
} from "./view.ts";

export class RemittanceNotFoundError extends Error {
  constructor(id: string) {
    super(`remittance ${id} not found`);
    this.name = "RemittanceNotFoundError";
  }
}

/** The advice could not be retrieved or read at all. Distinct from "it read fine but is unsafe". */
export class RemittanceUnavailableError extends Error {
  retryable: boolean;
  code: string;
  constructor(code: string, message: string, retryable: boolean) {
    super(`remittance retrieval failed (${code}): ${message}`);
    this.name = "RemittanceUnavailableError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** No coordination case with this id — in this practice, which RLS decides. */
export class CoordinationCaseNotFoundError extends Error {
  constructor(id: string) {
    super(`coordination case ${id} not found`);
    this.name = "CoordinationCaseNotFoundError";
  }
}

/**
 * A release or reject that this remittance's own state forbids — a DECISION, not a failure.
 *
 * ── WHY NOT `RemittanceUnavailableError` ITSELF ────────────────────────────────────────────────
 * That class describes an advice that could not be retrieved or read, and it prefixes every message
 * with "remittance retrieval failed (code):". Its refusals were reaching operators as, for example,
 * "remittance retrieval failed (duplicate-adjudication): The payer's claim control number…" — which
 * reads as a clearinghouse fault on the one screen where the operator has to decide what to do with
 * money. Nothing was retrieved, and nothing failed: the system declined, and said why.
 *
 * A subclass, so every existing `instanceof RemittanceUnavailableError` — the HTTP mapping above
 * all — still recognises it and still maps each `code` to the same status. Only the message
 * changes: it is exactly the sentence the operator needs, with nothing in front of it.
 */
export class RemittanceActionRefusedError extends RemittanceUnavailableError {
  constructor(code: string, message: string) {
    super(code, message, false);
    this.name = "RemittanceActionRefusedError";
    this.message = message;
  }
}

export class RemittanceService {
  #repo: RemittanceRepository;
  #expectations: ExpectationRepository;
  #adapter: EdiAdapter;
  #publisher: EventPublisher;
  #eraArtifacts: EraArtifactRepository | null;
  #merchantRateBps: MerchantRate;
  #testInterchanges: "accept" | "refuse";
  #coordination: CoordinationRepository;

  constructor(
    repo: RemittanceRepository,
    expectations: ExpectationRepository,
    adapter: EdiAdapter,
    publisher: EventPublisher = new NullEventPublisher(),
    /**
     * The ERA artifact ledger, when this deployment polls a clearinghouse.
     *
     * Optional because a deployment can legitimately have no ERA source — the DB-free demo, a
     * practice still on portal downloads — and `null` there is the truth rather than a stub. It is
     * NOT optional in the sense of "wire it later": without it `deadLetteredArtifacts()` answers
     * "none", and a caller cannot tell that apart from "none abandoned". So the composition root
     * passes it whenever a ledger exists, and `eraLedgerAttached` below makes the difference
     * legible to anything that needs to say which of the two it is looking at.
     */
    eraArtifacts: EraArtifactRepository | null = null,
    /**
     * The practice's merchant discount rate in basis points (295 = 2.95%), when it has stated one.
     *
     * Optional, and `null` is the honest default rather than an industry average: the rate lives on
     * a merchant statement this system has never seen. Without it a non-ACH payment is still
     * DETECTED and still published — only the cost is withheld, because a plausible figure on a
     * screen is indistinguishable from a measured one and a practice cannot argue with a payer from
     * a number we invented.
     */
    merchantRateBps: MerchantRate = null,
    /**
     * Whether an advice whose envelope says TEST (ISA15 = T) may ever post here.
     *
     * `"refuse"` wherever the deployment can reach real payers: a test interchange on a live
     * deployment is cash that was never sent. `"accept"` by default because the demonstration
     * deployments run on the mock clearinghouse or a vendor's test mode, where every file is a test
     * file by construction and refusing them would stop the demo posting anything. The composition
     * root decides from `filesToRealPayers`; see `testInterchangePolicy` in `apps/web/wiring.ts`.
     */
    testInterchanges: "accept" | "refuse" = "accept",
    /**
     * Where coordination-of-benefits cases live (see `coordination.ts`). In-memory by default so a
     * test or the DB-free demo needs nothing; the composition root passes the Postgres repository
     * wherever the remittances themselves are persistent.
     */
    coordination: CoordinationRepository = new InMemoryCoordinationRepository()
  ) {
    this.#repo = repo;
    this.#expectations = expectations;
    this.#adapter = adapter;
    this.#publisher = publisher;
    this.#eraArtifacts = eraArtifacts;
    this.#merchantRateBps = merchantRateBps;
    this.#testInterchanges = testInterchanges;
    this.#coordination = coordination;
  }

  /** Whether an ERA artifact ledger is attached — i.e. whether "no dead letters" is a measurement. */
  get eraLedgerAttached(): boolean {
    return this.#eraArtifacts !== null;
  }

  /**
   * Record what a claim was promised. Driven by `claim.submitted`; this is the ledger against which
   * every future payment is compared. Idempotent.
   */
  async recordExpectation(payload: ClaimSubmittedBody): Promise<void> {
    await this.#expectations.record({
      claimId: payload.claimId,
      verificationId: payload.verificationId,
      // The CLINIC's control number, not the payer's — CLP01 on the 835 echoes this one back.
      patientControlNumber: payload.patientControlNumber,
      payerId: payload.payerId,
      payerName: payload.payerName,
      memberId: payload.patient.memberId,
      patientName: `${payload.patient.firstName} ${payload.patient.lastName}`.trim(),
      submittedAt: payload.submittedAt,
      serviceDate: payload.serviceDate,
      totalFee: payload.totalFee,
      expectedInsurancePays: payload.expectedInsurancePays,
      /**
       * A newly filed claim has no award. The Postgres upsert deliberately does not list this
       * column, so an award already recorded against a resubmitted control number survives rather
       * than being reset — resubmitting a claim does not un-win an appeal.
       */
      awardOutstanding: 0 as Cents,
    });
  }

  /**
   * Record what a payer has AGREED to pay on appeal and not yet sent (L-1 / S1).
   *
   * A projection of state Denials owns, pushed here by the composition root because this module may
   * not read that one's tables. An ASSIGNMENT of a figure recomputed from the awards themselves —
   * never an increment — so a replayed event converges rather than accumulating.
   *
   * While it is non-zero, a payment on this claim is measured against the AWARD instead of the
   * pre-appeal estimate. Returns whether anything changed.
   */
  async setAwardOutstanding(patientControlNumber: string, amount: Cents): Promise<boolean> {
    return this.#expectations.setAwardOutstanding(patientControlNumber, amount);
  }


  /**
   * Record that some of a posting's recoverable money has been resolved (F-5).
   *
   * ── WHAT THIS IS AND IS NOT ───────────────────────────────────────────────────────────────────
   * It is NOT a correction to the payer's advice. `variance.recoverableAmount` stays exactly as the
   * 835 stated it, because that is the record this posting exists to be. This is a separate fact —
   * what the practice DID about that money — and the outstanding figure is the difference.
   *
   * Without it the Recover worklist kept advertising money that had already come back: an appeal won
   * and paid in full left its denial `recovered` while its posting still offered $1,125.00 to chase.
   *
   * ── IDEMPOTENT BY ASSIGNMENT ──────────────────────────────────────────────────────────────────
   * The caller passes the TOTAL resolved for this posting, recomputed from the denials that own it,
   * and this assigns it. Delivery is at-least-once, so a redelivered settlement event must converge
   * rather than accumulate — the same property that makes the award settlement itself replay-safe.
   *
   * Clamped to what the payer actually withheld: resolving more than was ever recoverable would make
   * the outstanding figure negative, and the database CHECK refuses it anyway.
   */
  async resolveRecoverable(postingId: string, resolved: Cents, now: Date = new Date()): Promise<boolean> {
    const remittances = await this.#repo.list();
    for (const remittance of remittances) {
      const posting = remittance.postings.find((p) => p.id === postingId);
      if (!posting) continue;

      const ceiling = posting.variance?.recoverableAmount ?? (0 as Cents);
      const next = Math.min(Math.max(0, resolved), ceiling) as Cents;
      if ((posting.resolvedRecoverable ?? 0) === next) return false;

      await this.#repo.update({
        ...remittance,
        postings: remittance.postings.map((p) =>
          p.id === postingId ? { ...p, resolvedRecoverable: next } : p
        ),
        audit: [
          ...remittance.audit,
          {
            timestamp: now.toISOString(),
            actor: "system",
            message:
              `${formatUsd(next)} of the ${formatUsd(ceiling)} this payer withheld on ` +
              `${posting.patientControlNumber} has been resolved. The payer's own figure is ` +
              `unchanged; what remains pursuable is the difference.`,
          },
        ],
      });
      return true;
    }
    return false;
  }

  /** Take in a raw 835 the clinic already holds (portal download, emailed file). */
  async ingestRaw(raw835: string, now: Date = new Date()): Promise<RemittanceView> {
    const result = this.#adapter.parseRemittance(raw835);
    if (!result.ok || !result.data) {
      const error = result.error;
      throw new RemittanceUnavailableError(
        error?.code ?? "parse_error",
        error?.message ?? "The remittance could not be read.",
        error?.retryable ?? false
      );
    }
    return this.#ingest(result.data, result.raw ?? raw835, now);
  }

  /**
   * Ingest an 835 the clinic uploaded that carries SEVERAL payments (NEW-15).
   *
   * ── WHY THIS IS SEPARATE FROM `ingestRaw` AND NOT A FLAG ON IT ─────────────────────────────────
   * `ingestRaw` refuses a multi-transaction-set file, and `parse835` throws to make it refuse:
   * "there is no honest way to fold three cheques into one advice", and taking the first would post
   * one payment while two vanished with no error anywhere. That refusal is correct and stays.
   *
   * But the file a payer's portal hands a practice at month end routinely holds a dozen cheques, so
   * "correct refusal" meant the human upload path could not accept the most ordinary export there
   * is. The person then split the file by hand in a text editor — around segment boundaries, in a
   * document where a misplaced `~` changes what a payer is recorded as having paid.
   *
   * So this exists, and the CALLER has to ask for it explicitly. That is the whole design: a person
   * uploading what they believe is one cheque must still be refused if it is three, because that
   * belief being wrong is exactly what needs surfacing. Asking for many means having been told there
   * are many.
   *
   * Each transaction set becomes its own remittance with its own trace number and its own
   * idempotency key, exactly as an ERA file's do — so re-uploading the same file posts nothing
   * twice, and a file that is half-new is ingested for its new half.
   */
  async ingestRawAll(raw835: string, now: Date = new Date()): Promise<RemittanceView[]> {
    const result = this.#adapter.parseRemittanceAll(raw835);
    if (!result.ok || !result.data) {
      const error = result.error;
      throw new RemittanceUnavailableError(
        error?.code ?? "parse_error",
        error?.message ?? "The remittance could not be read.",
        error?.retryable ?? false
      );
    }

    const views: RemittanceView[] = [];
    for (const advice of result.data) {
      /**
       * Sequentially, and each with the WHOLE file as its raw payload.
       *
       * Sequential because a request holds one pooled client, so concurrent queries on it are
       * neither concurrent nor supported. The whole file because that is what the practice was
       * given and what an auditor will be shown — the dedupe key is derived per advice (its own
       * trace number), so sharing the raw bytes costs no idempotency.
       */
      views.push(await this.#ingest(advice, raw835, now));
    }
    return views;
  }

  /**
   * Ingest an ERA *file* retrieved from a clearinghouse — the inbound-money path.
   *
   * Differs from `ingestRaw` in three ways, all of them because nobody asked for this file:
   *
   *  1. **It expects a batch.** A clearinghouse artifact routinely carries several 835 transaction
   *     sets, one per cheque, so it parses with `parseRemittanceAll` and returns one view per
   *     payment. `ingestRaw` keeps its single-advice contract for the human upload path, where one
   *     file is one payment and anything else deserves a person's attention.
   *
   *  2. **It carries provenance.** Which practice, decided how, and against which artifact — all
   *     recorded on every remittance it produces.
   *
   *  3. **It cross-checks the payee.** A file naming a different practice is HELD, never posted.
   *
   * The caller is responsible for having established the tenant already: this runs inside whatever
   * practice context it is given, and reads nothing from the payload to decide that. A parse
   * failure throws `RemittanceUnavailableError` so the artifact ledger records a failure and
   * retries rather than marking a file done that was never read.
   */
  async ingestArtifact(
    raw: string,
    provenance: Omit<EraProvenance, "payeeCheck" | "claimedPayeeId">,
    now: Date = new Date()
  ): Promise<RemittanceView[]> {
    const result = this.#adapter.parseRemittanceAll(raw);
    if (!result.ok || !result.data) {
      const error = result.error;
      throw new RemittanceUnavailableError(
        error?.code ?? "parse_error",
        error?.message ?? "The ERA could not be read.",
        error?.retryable ?? false
      );
    }

    const views: RemittanceView[] = [];
    for (const advice of result.data) {
      const claimedPayeeId = advice.payeeId?.trim() ? advice.payeeId.trim() : null;
      views.push(
        await this.#ingest(advice, raw, now, {
          ...provenance,
          claimedPayeeId,
          payeeCheck: checkPayee(claimedPayeeId, provenance.expectedPayeeId),
        })
      );
    }
    return views;
  }

  /**
   * Poll the clearinghouse for released remittances and ingest each one.
   *
   * Expectations supply the request: a real adapter ignores them and returns whatever the payer
   * released, while the mock needs them to stand in for the payer's adjudication.
   */
  async fetchAndIngest(
    request: Omit<RemittanceRequest, "claims"> & { claims?: RemittanceRequest["claims"] },
    now: Date = new Date()
  ): Promise<RemittanceView[]> {
    const result = await this.#adapter.fetchRemittance({ ...request, claims: request.claims ?? [] });
    if (!result.ok || !result.data) {
      const error = result.error;
      throw new RemittanceUnavailableError(
        error?.code ?? "unavailable",
        error?.message ?? "The clearinghouse did not respond.",
        error?.retryable ?? true
      );
    }
    const views: RemittanceView[] = [];
    for (const advice of result.data) {
      views.push(await this.#ingest(advice, result.raw ?? null, now));
    }
    return views;
  }

  async get(id: string, now: Date = new Date()): Promise<RemittanceView | null> {
    const remittance = await this.#repo.getById(id);
    if (!remittance) return null;
    /**
     * A held advice is shown with the findings release would refuse on NOW, so the screen offers
     * the action that will work — see `RemittanceView.releaseBlocked`.
     */
    return this.#viewOf(remittance, now);
  }

  /** The value-ranked remittance worklist: most recoverable money first. */
  async list(filter?: RemittanceFilter, now: Date = new Date()): Promise<RemittanceListItem[]> {
    const remittances = await this.#repo.list(filter);
    /**
     * Held advices carry what release would refuse on, as `get` does. The prior-payment history is
     * read ONCE for the whole list rather than once per held advice: this list is polled by the
     * Today and Money screens, and each read decrypts every stored advice.
     */
    const held = remittances.filter((r) => r.status === "held");
    const history = held.length > 0 ? await this.#priorPayments(null) : [];
    const items: RemittanceListItem[] = [];
    for (const r of remittances) {
      const blockers = r.status === "held" ? await this.#unreleasableFindings(r, history) : [];
      items.push(buildRemittanceListItem(r, now, blockers, await this.#casesFor(r)));
    }
    return items.sort((a, b) => b.priority - a.priority || b.receivedAt.localeCompare(a.receivedAt));
  }

  /**
   * How much money is held, and since when — the reading behind the held-age monitor.
   *
   * A held remittance is real cash the payer has already sent, sitting against no ledger entry
   * because Mermaid refused to post it. That refusal is correct and it is the whole design: what was
   * missing is that nothing measured how long the refusal had been standing. `reconcileAll()` cannot
   * see it — the remittance IS in the table, so its money reconciles perfectly while nobody works
   * it. This is the second reading, and it is the one that goes stale.
   */
  async heldSummary(): Promise<HeldRemittanceSummary> {
    return this.#repo.heldSummary();
  }

  /**
   * ERA files that exhausted their retries and were abandoned.
   *
   * These are the money that never became a remittance at all, which is why they are invisible to
   * every other reading in this service: no remittance row, so nothing to reconcile, nothing to
   * hold, nothing in any list. The artifact ledger is the only record that the clearinghouse ever
   * offered the file, and until now it had no reader outside its own tests.
   *
   * Returns `[]` when no ledger is attached. Callers that must distinguish "none abandoned" from
   * "not watching" read `eraLedgerAttached`.
   */
  async deadLetteredArtifacts(): Promise<EraArtifact[]> {
    if (!this.#eraArtifacts) return [];
    const all = await this.#eraArtifacts.list();
    return all.filter((a) => a.deadLettered);
  }

  /**
   * Release a held remittance after a human has reconciled it.
   *
   * The safety gate is re-run and its BLOCKERS still stand — a person may confirm the payer's paper
   * EOB, but they may not wave through arithmetic that does not add up. Only the human-judgement
   * blockers (an unmatched payment, a reversal someone has now identified) are overridable, which is
   * why releasing requires both a name and a reason.
   */
  async release(id: string, releasedBy: string, reason: string, now: Date = new Date()): Promise<RemittanceView> {
    const remittance = await this.#require(id);
    const actor = releasedBy.trim();
    const why = reason.trim();
    if (!actor) throw new RemittanceActionRefusedError("validation_error", "a releasing user is required");
    if (!why) throw new RemittanceActionRefusedError("validation_error", "a reason is required to release a held remittance");
    if (remittance.status === "posted") return buildRemittanceView(remittance, now);
    if (remittance.status === "rejected") {
      throw new RemittanceActionRefusedError(
        "rejected",
        "This remittance was rejected and can never be posted. Its record is kept as evidence; if the " +
          "decision was wrong, the payer's file must be ingested again as a new advice."
      );
    }

    if (!remittance.balanced) {
      throw new RemittanceActionRefusedError(
        "unbalanced",
        "This remittance does not balance. Arithmetic cannot be overridden — reconcile it against the payer's EOB first."
      );
    }

    /**
     * A remittance with no trace number can never be released, however good the reason.
     *
     * The trace is the idempotency key: `#ingest` recognises a repeat delivery by it, and with no
     * trace that gate does nothing. Ingesting the same payer file twice therefore produces two
     * distinct held remittances that look identical and are both releasable — and releasing both
     * posts the money twice, double-crediting the payer and double-charging every patient on it.
     *
     * The safety gate already raises this as a blocker at ingest, so a trace-less remittance arrives
     * held. This is the second half of that guarantee: without it, "held" is only a speed bump in
     * front of the one failure the ledger's own subscriber calls the one that leaves the building.
     */
    if (!remittance.traceNumber.trim()) {
      throw new RemittanceActionRefusedError(
        "missing-trace-number",
        "This remittance carries no trace (check or EFT) number, so there is no way to guarantee it posts " +
          "only once. Obtain the trace number from the payer or clearinghouse and re-ingest the file."
      );
    }

    /**
     * ── THE GATE'S HARD FINDINGS ARE RE-ASKED HERE, NOT REMEMBERED ──────────────────────────────
     * The findings stored at ingest describe the world at ingest. A twin posted since — or an advice
     * ingested before a check existed — is invisible to them, and that is exactly how two copies of
     * an already-posted payment sat on staging as ordinary "review and release" items. So the
     * findings no person may override are evaluated again, now, against what is on the books now.
     */
    const unreleasable = await this.#unreleasableFindings(remittance);
    if (unreleasable.length > 0) {
      throw new RemittanceActionRefusedError(
        unreleasable[0]!.code,
        `${unreleasable.map((f) => f.message).join(" ")} This cannot be released — reject it instead.`
      );
    }

    /**
     * ── A COORDINATION HOLD IS RELEASED BY AN ANSWER, NOT BY A SENTENCE ─────────────────────────
     * The hold asked "does this patient have another plan?". It used to accept any reason, and on
     * staging three advices were released with "Reconciled against the payer's paper EOB" — true,
     * and no answer at all. Release is now refused until a person has CONFIRMED coverage on the case
     * (outcome, source, date), whatever the free-text reason says. Holds for any other reason are
     * untouched: this looks only at claims this advice itself signalled.
     */
    await this.#syncCoordinationFor(remittance, now);
    // Locked: a confirmation racing this release must be seen, or must wait for it.
    const pending = await this.#unconfirmedCasesFor(remittance, true);
    if (pending.length > 0) {
      throw new RemittanceActionRefusedError(
        "coverage-unconfirmed",
        pending
          .map((c) => `${c.primaryPayerName} indicated another plan on claim ${c.patientControlNumber}, and nobody has confirmed whether the patient has one.`)
          .join(" ") +
          " Confirm the patient's other coverage — the answer, where it came from, and when — before this can be released."
      );
    }

    const posted = await this.#post(
      remittance,
      now,
      [
        audit(now, "staff", `Released for posting by ${actor}: ${why}`),
      ]
    );
    return this.#viewOf(posted, now);
  }

  // ── Coordination of benefits ───────────────────────────────────────────────────────────────

  /** Every coordination case, newest first. */
  async listCoordinationCases(): Promise<CoordinationCase[]> {
    return this.#coordination.list();
  }

  async getCoordinationCase(id: string): Promise<CoordinationCase | null> {
    return this.#coordination.getById(id);
  }

  /** Record a person's structured answer to "does this patient have another plan?". */
  async confirmCoverage(id: string, input: ConfirmCoverageInput, actor: string, now: Date = new Date()): Promise<CoordinationCase> {
    const c = await this.#requireCase(id);
    return this.#coordination.update(confirmCoverage(c, input, actor, now));
  }

  /** Record that the patient or payer was asked, and when to follow up. */
  async requestCoverageConfirmation(id: string, input: RequestInput, actor: string, now: Date = new Date()): Promise<CoordinationCase> {
    const c = await this.#requireCase(id);
    return this.#coordination.update(requestConfirmation(c, input, actor, now));
  }

  /** The secondary claim was filed with the confirmed other plan. */
  async markSecondaryFiled(id: string, input: FilingInput, actor: string, now: Date = new Date()): Promise<CoordinationCase> {
    const c = await this.#requireCase(id);
    return this.#coordination.update(markSecondaryFiled(c, input, actor, now));
  }

  /** Finish the secondary work with a stated outcome. Moves no money. */
  async closeSecondaryWork(id: string, input: CloseInput, actor: string, now: Date = new Date()): Promise<CoordinationCase> {
    const c = await this.#requireCase(id);
    return this.#coordination.update(closeSecondaryWork(c, input, actor, now));
  }

  /**
   * Open or refresh a case for every coordination signal on every advice already stored.
   *
   * The backfill for advices received before cases existed, and safe to run any number of times:
   * each advice's evidence is recorded idempotently, a person's decisions are never touched, and no
   * remittance, posting or ledger entry is read for anything but the signal. Returns what changed.
   */
  async syncCoordinationCases(now: Date = new Date()): Promise<{ opened: number; updated: number; unchanged: number }> {
    const totals = { opened: 0, updated: 0, unchanged: 0 };
    for (const status of ["held", "posted", "rejected"] as const) {
      for (const r of await this.#repo.list({ status })) {
        const outcome = await this.#syncCoordinationFor(r, now);
        totals.opened += outcome.opened;
        totals.updated += outcome.updated;
        totals.unchanged += outcome.unchanged;
      }
    }
    return totals;
  }

  /**
   * Held money nobody is working, as opposed to held money waiting on a coverage answer.
   *
   * The held-age check reads this. An advice held ONLY because coverage is unconfirmed is not
   * neglected cash — it is a question with its own check (`coordination.coverage_unconfirmed`),
   * its own clock, and a way to say "asked, waiting until Friday". Counting it here too would report
   * one problem twice under a name that describes neither. Once coverage is confirmed the advice is
   * ordinary held cash again and comes back into this count until someone releases it.
   */
  async unattendedHeldSummary(): Promise<HeldRemittanceSummary> {
    const held = await this.#repo.list({ status: "held" });
    let count = 0;
    let totalCents = 0;
    let oldest: string | null = null;
    for (const r of held) {
      if ((await this.#unconfirmedCasesFor(r)).length > 0) continue;
      count++;
      totalCents += r.paymentTotal;
      if (oldest === null || r.receivedAt < oldest) oldest = r.receivedAt;
    }
    return { count, oldestReceivedAt: oldest, totalCents };
  }

  async #requireCase(id: string): Promise<CoordinationCase> {
    const c = await this.#coordination.lockById(id);
    if (!c) throw new CoordinationCaseNotFoundError(id);
    return c;
  }

  /** The cases for claims THIS advice signalled whose coverage nobody has confirmed. */
  async #unconfirmedCasesFor(remittance: Remittance, lock = false): Promise<CoordinationCase[]> {
    const out: CoordinationCase[] = [];
    for (const p of remittance.postings) {
      if (!signalOf(p)) continue;
      const c = lock
        ? await this.#coordination.lockByControlNumber(p.patientControlNumber)
        : await this.#coordination.getByControlNumber(p.patientControlNumber);
      if (c && c.coverageStatus === "unconfirmed" && !out.some((o) => o.id === c.id)) out.push(c);
    }
    return out;
  }

  /** The cases for claims this advice signalled, confirmed or not — what its view shows. */
  async #casesFor(remittance: Remittance): Promise<CoordinationCase[]> {
    const out: CoordinationCase[] = [];
    for (const p of remittance.postings) {
      if (!signalOf(p)) continue;
      const c = await this.#coordination.getByControlNumber(p.patientControlNumber);
      if (c && !out.some((o) => o.id === c.id)) out.push(c);
    }
    return out;
  }

  /**
   * Record this advice's coordination evidence on its claims' cases. Opens a case the first time a
   * claim is signalled; afterwards only replaces this advice's own entry. Idempotent.
   */
  async #syncCoordinationFor(remittance: Remittance, now: Date): Promise<{ opened: number; updated: number; unchanged: number }> {
    const totals = { opened: 0, updated: 0, unchanged: 0 };
    for (const posting of remittance.postings) {
      const signal = signalOf(posting);
      if (!signal) continue;
      const expectation = await this.#expectations.getByControlNumber(posting.patientControlNumber);
      const evidence: CoordinationEvidence = {
        remittanceId: remittance.id,
        traceNumber: remittance.traceNumber,
        payerName: remittance.payerName,
        receivedAt: remittance.receivedAt,
        remittanceStatus: remittance.status,
        forwarded: signal.forwarded,
        assignedCents: signal.assignedCents,
        crossoverCarrier: posting.crossoverCarrier ?? null,
      };
      const input = {
        patientControlNumber: posting.patientControlNumber,
        claimId: posting.claimId ?? expectation?.claimId ?? null,
        serviceDate: expectation?.serviceDate ?? null,
        evidence,
      };
      const existing = await this.#coordination.lockByControlNumber(posting.patientControlNumber);
      if (!existing) {
        const opened = recordSignal(null, input, randomUUID(), now);
        if (await this.#coordination.insertIfAbsent(opened)) {
          totals.opened++;
          continue;
        }
        // Lost the race to the one-case-per-claim key: another advice opened it first. Merge into theirs.
        const winner = await this.#coordination.lockByControlNumber(posting.patientControlNumber);
        if (!winner) throw new Error(`coordination case for ${posting.patientControlNumber} vanished mid-insert`);
        await this.#coordination.update(recordSignal(winner, input, winner.id, now));
        totals.updated++;
        continue;
      }
      const next = recordSignal(existing, input, existing.id, now);
      if (next === existing) {
        totals.unchanged++;
      } else {
        await this.#coordination.update(next);
        totals.updated++;
      }
    }
    return totals;
  }

  /** The view, with everything release would refuse on and every coordination case it touches. */
  async #viewOf(remittance: Remittance, now: Date): Promise<RemittanceView> {
    const blockers = remittance.status === "held" ? await this.#unreleasableFindings(remittance) : [];
    return buildRemittanceView(remittance, now, blockers, await this.#casesFor(remittance));
  }

  /**
   * Reject a held remittance: it will never post, and the record says who decided that and why.
   *
   * ── WHAT THIS DOES NOT DO, AND WHY THAT IS THE WHOLE POINT ──────────────────────────────────
   * It never calls `#post`, and `#post` is the only thing in this module that publishes
   * `remittance.posted` — the event the claim, the patient ledger and the analytics facts are all
   * driven by. So a rejection cannot create a ledger entry, a claim payment, a patient balance or a
   * collection figure: there is no path from here to any of them.
   *
   * The record, its raw 835 and its trace are kept. The payer did send this file, and "did Cigna pay
   * this claim twice?" has to be answerable from the books — by showing both advices and what was
   * decided about each — long after the held pile has been cleared.
   *
   * Idempotent on an already-rejected remittance, so a double-click or a retried request cannot
   * produce a second decision. Refused on a POSTED one: money on the books is retracted by a
   * reversal from the payer, never by relabelling the advice that delivered it.
   */
  async reject(
    id: string,
    rejectedBy: string,
    reason: string,
    kind: "duplicate" | "test-file",
    now: Date = new Date()
  ): Promise<RemittanceView> {
    const remittance = await this.#require(id);
    const actor = rejectedBy.trim();
    const why = reason.trim();
    if (!actor) throw new RemittanceActionRefusedError("validation_error", "a rejecting user is required");
    if (!why) throw new RemittanceActionRefusedError("validation_error", "a reason is required to reject a remittance");
    if (kind !== "duplicate" && kind !== "test-file") {
      throw new RemittanceActionRefusedError("validation_error", "kind must be `duplicate` or `test-file`");
    }
    if (remittance.status === "rejected") return buildRemittanceView(remittance, now);
    if (remittance.status === "posted") {
      throw new RemittanceActionRefusedError(
        "already-posted",
        "This remittance is already posted. Posted money is retracted by a reversal from the payer, " +
          "not by rejecting the advice that delivered it."
      );
    }

    /**
     * Name the twin when the gate can see one, so the record says WHICH payment this copies. When it
     * cannot — a payer that omits CLP07, a duplicate established from the bank statement — the person's
     * reason is the evidence, and no twin is invented to decorate it.
     */
    const twins = kind === "duplicate" ? await this.#duplicateTwins(remittance) : [];
    const twin = twins.find((p) => p.status === "posted") ?? twins[0];

    const label = kind === "duplicate" ? "a duplicate" : "a test file";
    const rejected: Remittance = {
      ...remittance,
      status: "rejected",
      rejection: {
        kind,
        reason: why,
        rejectedBy: actor,
        rejectedAt: now.toISOString(),
        ...(twin ? { duplicateOfTrace: twin.traceNumber } : {}),
      },
      audit: [
        ...remittance.audit,
        audit(
          now,
          "staff",
          `Rejected as ${label} by ${actor}: ${why}` +
            (twin ? ` (duplicates advice ${twin.traceNumber}).` : "") +
            ` Nothing was posted; the ${formatUsd(remittance.paymentTotal)} in this advice is not on the books.`
        ),
      ],
    };
    const stored = await this.#repo.update(rejected);
    await this.#syncCoordinationFor(stored, now);
    return this.#viewOf(stored, now);
  }

  /**
   * Every payment recorded against a claim, individually, from POSTED and HELD advices other than
   * `excludingId`. Rejected advices are not payments and never appear.
   *
   * One reader for ingest and release, so the two cannot be looking at different histories.
   */
  async #priorPayments(excludingId: string | null): Promise<PriorPayment[]> {
    const priorPayments: PriorPayment[] = [];
    for (const status of ["posted", "held"] as const) {
      for (const other of await this.#repo.list({ status })) {
        if (other.id === excludingId) continue;
        for (const posting of other.postings) {
          const key = posting.patientControlNumber;
          if (!key || posting.paidAmount <= 0) continue;
          priorPayments.push({
            patientControlNumber: key,
            paid: posting.paidAmount,
            status,
            traceNumber: other.traceNumber,
            adjudication: adjudicationOf(posting.adjustments),
            payerName: other.payerName,
            payerControlNumber: posting.payerControlNumber ?? "",
            reversal: posting.disposition === "reversal",
            remittanceId: other.id,
          });
        }
      }
    }
    return priorPayments;
  }

  /** The stored postings of a remittance, as the duplicate check reads claims. */
  #candidatesOf(remittance: Remittance): DuplicateCandidate[] {
    return remittance.postings.map((p) => ({
      patientControlNumber: p.patientControlNumber,
      payerControlNumber: p.payerControlNumber ?? "",
      paid: p.paidAmount,
      reversal: p.disposition === "reversal",
      adjustments: p.adjustments,
    }));
  }

  /**
   * The prior payments this remittance's claims duplicate, as `duplicateFindings` defines one: the
   * same claim paying the same figure — which an identical adjudication under the same claim control
   * number always is. One definition, so the twin named on a rejection is the one the gate saw.
   */
  async #duplicateTwins(remittance: Remittance): Promise<PriorPayment[]> {
    const priors = await this.#priorPayments(remittance.id);
    const amounts = new Set(remittance.postings.map((p) => `${p.patientControlNumber}|${p.paidAmount}`));
    return priors.filter((p) => amounts.has(`${p.patientControlNumber}|${p.paid}`));
  }

  /**
   * The findings that no reason can override, evaluated against the books as they stand NOW.
   *
   * Read from the STORED postings rather than a re-parse of the raw 835, so a remittance whose file
   * was never retained is checked exactly like one whose file was.
   */
  async #unreleasableFindings(
    remittance: Remittance,
    /** All prior payments, already read; this advice's own are excluded here. */
    history?: readonly PriorPayment[]
  ): Promise<SafetyFinding[]> {
    const findings: SafetyFinding[] = [];
    if (remittance.usageIndicator === "T" && this.#testInterchanges === "refuse") {
      findings.push({
        severity: "blocker",
        code: "test-interchange",
        message:
          "The sender marked this interchange as a TEST file (ISA15 = T), and this deployment posts to a " +
          "real practice's books.",
        remediation: "Reject it as a test file.",
      });
    }
    const contexts = new Map<string, ClaimContext>();
    for (const p of remittance.postings) {
      const expectation = await this.#expectations.getByControlNumber(p.patientControlNumber);
      if (expectation) {
        contexts.set(p.patientControlNumber, {
          awardOutstanding: expectation.awardOutstanding ?? (0 as Cents),
          filedCharge: expectation.totalFee,
        });
      }
    }
    findings.push(
      ...duplicateFindings(
        remittance.payerName,
        this.#candidatesOf(remittance),
        history
          ? history.filter((p) => p.remittanceId !== remittance.id)
          : await this.#priorPayments(remittance.id),
        contexts
      ).filter((f) => f.severity === "blocker")
    );
    return findings.filter((f) => UNRELEASABLE_SAFETY_CODES.has(f.code));
  }

  /**
   * The recovery queue: every posting still holding money someone owes the practice, across every
   * remittance, ranked by what is actually retrievable.
   *
   * Lives on the service rather than being assembled by a caller, because it spans the module's
   * whole store — handing a repository out to the transport layer to build it there would put a
   * module's storage in someone else's hands.
   */
  async recoveryQueue(now: Date = new Date()): Promise<RecoveryItem[]> {
    return buildRecoveryQueue(await this.#repo.list({ status: "posted" }), now);
  }

  /** Daily money reconciliation over everything posted so far (blueprint P3). */
  /**
   * ── RECONCILE AGAINST THE PAYER'S OWN FILE, NOT AGAINST OURSELVES (NEW-23) ────────────────────
   *
   * This read `paymentTotal` and `postings` from the SAME stored remittance document. Both are
   * written by the same code path, in the same transaction, from the same parse — so the comparison
   * was the system checking its own arithmetic against its own arithmetic, and `drift` could only
   * ever be non-zero if `addCents` were broken.
   *
   * What it was sold as, and what an operator reads it as, is the opposite: "every cent a payer said
   * it sent is accounted for by a posting". The one thing that can answer that is the payer's own
   * document, and this system already retains it — `raw835`, encrypted at rest, on every remittance.
   *
   * So the payments side is now RE-PARSED from the stored 835 and the postings side stays as
   * recorded. Two independent derivations of the same number, which is what makes a difference
   * between them mean something. A file corrupted at rest, a posting deleted underneath the
   * aggregate, or a parser change that reads BPR differently now all show up as drift; before, none
   * of them could.
   *
   * ── WHAT A REMITTANCE WITH NO RETAINED FILE DOES ──────────────────────────────────────────────
   * It is reported, and excluded from the comparison, rather than silently falling back to the
   * stored total — which would restore the old self-comparison for exactly the rows nothing can
   * check. Rows written before retention existed are the honest case for this; counting them as
   * reconciled would be the same lie in a smaller font.
   */
  async reconcileAll(): Promise<ReconciliationReport> {
    const remittances = await this.#repo.list({ status: "posted" });

    const paymentTotals: Cents[] = [];
    const postedAmounts: Cents[] = [];
    const providerAdjustments: Cents[] = [];
    const unverifiable: string[] = [];

    for (const summary of remittances) {
      // `list` returns the summary; the raw file lives on the full aggregate.
      const stored = await this.#repo.getById(summary.id);
      if (!stored) continue;

      postedAmounts.push(...stored.postings.map((p) => p.paidAmount));
      providerAdjustments.push(...stored.providerAdjustments.map((p) => p.amount));

      const external = this.#paymentTotalFromFile(stored.raw835);
      if (external === null) {
        unverifiable.push(stored.traceNumber || stored.id);
        // Its postings still count. Dropping them too would hide money that IS posted behind a file
        // that was never kept, and produce a drift that says the opposite of what is wrong.
        paymentTotals.push(stored.paymentTotal);
        continue;
      }
      paymentTotals.push(external);
    }

    const report = reconcile({ paymentTotals, postedAmounts, providerAdjustments });
    if (unverifiable.length === 0) return report;

    return {
      ...report,
      summary:
        `${report.summary} ${unverifiable.length} remittance${unverifiable.length === 1 ? "" : "s"} ` +
        `could not be checked against the payer's own file (${unverifiable.slice(0, 5).join(", ")}` +
        `${unverifiable.length > 5 ? ", …" : ""}) — no 835 was retained for ${
          unverifiable.length === 1 ? "it" : "them"
        }, so ${unverifiable.length === 1 ? "its total is" : "their totals are"} taken from our own ` +
        `record and prove nothing.`,
    };
  }

  /**
   * The BPR total as the PAYER wrote it, re-derived from the retained file.
   *
   * Null when there is no file, or when it no longer parses — and a file that no longer parses is
   * itself the finding: it is the evidence for money that has already moved, and its integrity is
   * exactly what this check exists to notice. Returning null puts it in the unverifiable list
   * rather than throwing, so one corrupted file does not stop the whole practice reconciling.
   */
  #paymentTotalFromFile(raw835: string | null | undefined): Cents | null {
    if (!raw835 || raw835.trim() === "") return null;
    const parsed = this.#adapter.parseRemittanceAll(raw835);
    if (!parsed.ok || !parsed.data || parsed.data.length === 0) return null;
    return addCents(...parsed.data.map((advice) => advice.paymentTotal));
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────

  async #ingest(
    advice: RemittanceAdvice,
    raw: string | null,
    now: Date,
    provenance?: EraProvenance
  ): Promise<RemittanceView> {
    /**
     * ── GATE 0: IS THERE ANYTHING HERE AT ALL ────────────────────────────────────────────────────
     * `ingestRaw` refuses a parse that FAILS. This refuses one that succeeds and yields nothing.
     *
     * Found by uploading a truncated payload — `ISA*00*…*ZZ*BROKEN~GS*HP~ST*835*0001~SE*2*0001~` —
     * which begins with ISA, so it is X12-shaped, and parses without error into an advice with no
     * trace number, no payer, no claims and no provider adjustments. It was accepted with a 201 and
     * stored as a held remittance.
     *
     * What that leaves behind is worse than a rejection. The row sits on the Money worklist with no
     * payer and no trace to identify it, and `release` refuses any remittance without a trace number
     * — deliberately and correctly — so nobody can ever clear it. Every malformed upload adds another
     * one, permanently.
     *
     * Deliberately narrow. An advice with no CLAIMS is legitimate: a payer sending only provider-
     * level adjustments is recording a recoupment, and that is real money this must keep. So the
     * refusal needs all three to be absent — nothing was paid, nobody was adjudicated, and nothing
     * was withheld — which is the honest definition of an empty file.
     */
    const carriesNothing =
      advice.claims.length === 0 &&
      advice.providerAdjustments.length === 0 &&
      !advice.paymentTotal &&
      !advice.traceNumber?.trim();
    if (carriesNothing) {
      throw new RemittanceUnavailableError(
        "empty_advice",
        "This file parsed as EDI but contains no payment, no claims and no adjustments — there is " +
          "nothing to record. Check that the whole file was uploaded.",
        false
      );
    }

    // Gate 1: idempotency. A key we have already seen is normal traffic, not an error.
    const dedupeKey = dedupeKeyFor(advice, raw);
    const existing = await this.#repo.getByDedupeKey(dedupeKey);
    if (existing) return buildRemittanceView(existing, now);

    const known = await this.#expectations.knownControlNumbers();
    /**
     * Every payment already recorded against a claim, individually, from posted AND held advices.
     *
     * Read here rather than inside the gate because the gate is pure.
     *
     * ── WHY HELD ADVICES COUNT NOW ───────────────────────────────────────────────────────────────
     * They used not to, on the reasoning that "a held one has not moved money, so treating it as a
     * prior payment would block the release of the very advice a person is reviewing". The first
     * half is true and the second does not follow: the advice being ingested is not saved yet, so it
     * cannot match itself here — and when `release` asks the same question, `#priorPayments`
     * excludes the advice being released, so a held advice never blocks itself.
     *
     * What the omission cost is a real double-post path. `dedupeKeyFor` keys on the payer plus the
     * TRACE NUMBER, so a payer re-sending the same payment under a new trace produces two distinct
     * rows. Both pass every other gate, both sit held, and a biller looking at two well-formed
     * advices for the same claim has nothing on either screen telling them these are one payment.
     * Releasing both posts it twice.
     *
     * ── WHY INDIVIDUALLY AND NOT SUMMED ──────────────────────────────────────────────────────────
     * This used to accumulate a total per claim and compare the incoming amount against it, which
     * answers a different question and got both directions wrong: two prior postings of $400 total
     * $800, so a third $400 duplicate passed the gate, while a legitimate $800 payment was blocked
     * for matching the total by coincidence.
     *
     * `list()` reads whole aggregates, which is the wrong shape for a hot path — this runs once per
     * ingest, not per monitor tick, and correctness on a duplicate payment is worth more than the
     * read. If ingest volume ever makes it matter, this becomes a repository query.
     */
    const priorPayments = await this.#priorPayments(null);

    /**
     * The outstanding appeal award for each claim this advice pays, so the gate can tell a recovery
     * from a re-send.
     *
     * One read per claim in the incoming advice, on the same reasoning the prior-payment scan uses:
     * this runs once per ingest, and being wrong about a duplicate payment costs more than the
     * reads. Claims with no expectation contribute nothing, which is the conservative reading.
     */
    const claimContexts = new Map<string, ClaimContext>();
    for (const claim of advice.claims) {
      const expectation = await this.#expectations.getByControlNumber(claim.patientControlNumber);
      if (expectation) {
        claimContexts.set(claim.patientControlNumber, {
          awardOutstanding: expectation.awardOutstanding ?? (0 as Cents),
          /** What we billed, so the gate can ask whether this file is even about our claim. */
          filedCharge: expectation.totalFee,
        });
      }
    }

    const baseSafety = checkRemittanceSafety(advice, known, now, priorPayments, claimContexts, {
      testInterchanges: this.#testInterchanges,
    });
    /**
     * The payee cross-check joins the existing gate as one more BLOCKER, rather than as a separate
     * mechanism that could be evaluated in a different order or forgotten. Everything downstream —
     * `safeToPost`, `holdReason`, the release path (which re-checks only the findings no person may
     * override, `UNRELEASABLE_SAFETY_CODES`) — then treats it exactly
     * like any other reason not to move money, which is what it is.
     */
    const safety = provenance?.payeeCheck === "mismatched"
      ? withPayeeBlocker(baseSafety, provenance)
      : baseSafety;
    const postings = await this.#buildPostings(advice, now);

    const remittance: Remittance = {
      id: randomUUID(),
      traceNumber: advice.traceNumber,
      dedupeKey,
      receivedAt: now.toISOString(),
      status: "held",
      payerName: advice.payerName,
      payeeName: advice.payeeName,
      paymentTotal: advice.paymentTotal,
      paymentMethod: advice.paymentMethod,
      paymentDate: advice.paymentDate,
      balanced: advice.balanced,
      issues: advice.issues,
      holdReason: safety.safeToPost ? null : holdReason(safety),
      postings,
      providerAdjustments: advice.providerAdjustments,
      raw835: raw,
      usageIndicator: advice.usageIndicator ?? null,
      audit: [
        audit(
          now,
          "system",
          `Remittance received: ${formatUsd(advice.paymentTotal)} from ${advice.payerName || "the payer"} ` +
            `(trace ${advice.traceNumber || "—"}), ${advice.claims.length} claim(s).`
        ),
        // HOW this practice was chosen, recorded next to the money it decided the owner of. An ERA
        // is the only thing here that arrives unsolicited, so the answer must be evidence on the
        // record rather than an assumption left in a call stack.
        ...(provenance ? [audit(now, "system", describeProvenance(provenance))] : []),
      ],
    };

    if (!safety.safeToPost) remittance.audit.push(audit(now, "system", `Held: ${holdReason(safety)}`));

    /**
     * ── LOSING THE RACE TO THE UNIQUE KEY IS NOT A FAILURE ───────────────────────────────────────
     *
     * The `getByDedupeKey` check above is check-then-act: two ingests of the same payment — a
     * clearinghouse re-serving one cheque under two artifact ids, a person uploading a file twice,
     * two workers — can both read "not seen yet" and both proceed to insert. The UNIQUE constraint
     * is what actually decides, and that is the design: the guard is a courtesy, the index is the
     * guarantee.
     *
     * What the loser does with the refusal is the part that was wrong. The error arrived untyped,
     * so nothing recognised it as the ordinary event it is: the upload route returned 500, and the
     * ERA worker judged it a permanent failure and DEAD-LETTERED the artifact — reporting a payer's
     * file as abandoned money when its money was already on the ledger, and sending a person to
     * retrieve a file that needed nothing.
     *
     * Both paths now land here. The winner's row is re-read and returned, which is byte-for-byte
     * what the non-concurrent redelivery at the top of this method already does — so a race and a
     * repeat finally mean the same thing.
     *
     * Nothing is posted on this branch, deliberately: the winner posted its own money, and `#post`
     * here would publish `remittance.posted` a second time for one payment.
     */
    let saved: Remittance;
    try {
      saved = await this.#repo.save(remittance);
    } catch (e) {
      if (!(e instanceof DuplicateRemittanceError)) throw e;
      const winner = await this.#repo.getByDedupeKey(dedupeKey);
      /**
       * The constraint fired but the row is not visible. Under READ COMMITTED this cannot happen —
       * the insert blocks until the other transaction commits or rolls back, so by the time a
       * violation is raised the winner is committed and a fresh statement sees it. If it ever does
       * happen the honest answer is the original refusal, not a fabricated success.
       */
      if (!winner) throw e;
      return buildRemittanceView(winner, now);
    }

    // The payer's word on another plan becomes a case the moment the advice exists — held or not.
    await this.#syncCoordinationFor(saved, now);

    if (!safety.safeToPost) return this.#viewOf(saved, now);

    const posted = await this.#post(saved, now, []);
    return this.#viewOf(posted, now);
  }

  /** Build a posting per claim payment, computing variance wherever we know what was expected. */
  async #buildPostings(advice: RemittanceAdvice, now: Date): Promise<Posting[]> {
    const postings: Posting[] = [];
    for (const claim of advice.claims) {
      const expectation = await this.#expectations.getByControlNumber(claim.patientControlNumber);
      const adjustments: VarianceReason[] = claim.adjustments.map((a) => ({
        group: a.group,
        code: a.code,
        description: a.description,
        category: a.category,
        amount: a.amount,
        procedureCode: a.procedureCode,
      }));

      postings.push({
        id: randomUUID(),
        remittanceId: "", // filled by the caller once the remittance id exists
        postedAt: now.toISOString(),
        claimId: expectation?.claimId ?? null,
        patientControlNumber: claim.patientControlNumber,
        payerControlNumber: claim.payerControlNumber,
        patientName: claim.patientName,
        chargedAmount: claim.charged,
        paidAmount: claim.paid,
        patientResponsibility: claim.patientResponsibility,
        disposition: claim.disposition,
        // No expectation means no honest comparison — a variance against an unknown baseline is a
        // fabricated number, and fabricated shortfalls would poison the recovery queue.
        /**
         * ── WHAT THIS PAYMENT IS MEASURED AGAINST (L-1) ─────────────────────────────────────────
         * Normally the estimate the claim carried when it was filed. But once a payer has AGREED an
         * appeal award and not yet paid it, the award is what the incoming money is expected to
         * match — the estimate predates the appeal and describes a different question.
         *
         * Measuring a corrected remittance against the pre-appeal estimate is what reported a
         * $1,125.00 recovery against a $175.00 expectation as a $950.00 OVERPAYMENT, putting every
         * successful appeal on the worklist as a suspected takeback.
         */
        /**
         * `null` where there is no expectation — the engine now takes `Cents | null` and refuses to
         * fabricate, so the honest answer travels as a value rather than resting on this branch
         * being written correctly.
         */
        variance: computeVariance(
          {
            chargedAmount: claim.charged,
            paidAmount: claim.paid,
            patientResponsibility: claim.patientResponsibility,
            adjustments,
          },
          expectation
            ? expectationFor({
                expectedInsurancePays: expectation.expectedInsurancePays,
                awardOutstanding: expectation.awardOutstanding ?? (0 as Cents),
              })
            : null
        ),
        adjustments,
        remarks: claim.remarks,
        // The payer's own naming of the other plan, when it gave one — evidence for the case.
        ...(claim.crossoverCarrier ? { crossoverCarrier: claim.crossoverCarrier } : {}),
      });
    }
    return postings;
  }

  /** Mark posted, stamp the posting ids, publish. */
  async #post(remittance: Remittance, now: Date, extraAudit: RemittanceAuditEvent[]): Promise<Remittance> {
    const postings = remittance.postings.map((p) => ({ ...p, remittanceId: remittance.id, postedAt: now.toISOString() }));
    const totalPosted = addCents(...postings.map((p) => p.paidAmount));

    const updated: Remittance = {
      ...remittance,
      status: "posted",
      holdReason: null,
      postings,
      audit: [
        ...remittance.audit,
        ...extraAudit,
        audit(now, "system", `Posted ${formatUsd(totalPosted)} across ${postings.length} claim(s).`),
      ],
    };
    const saved = await this.#repo.update(updated);
    await this.#syncCoordinationFor(saved, now);

    for (const posting of saved.postings) {
      await this.#publishPosting(saved, posting, now);
    }
    await this.#publishAllowedAmounts(saved, now);
    await this.#publishPaymentMethod(saved, now);
    await this.#publishStatutoryClock(saved, now);
    return saved;
  }

  /**
   * Publish the dates two statutes run on (F5).
   *
   * ── WHY FROM `#post`, LIKE ITS TWO NEIGHBOURS ────────────────────────────────────────────────
   * A HELD advice is money a human has not accepted and can still void. An interest demand raised
   * off a payment that is later voided is a letter to a payer about money the practice does not
   * have. A held advice that is released passes through here, so nothing is lost — only deferred to
   * the point the money is real.
   *
   * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────────
   * It does not hold, block or alter a posting, and it does not touch the reconciliation. A
   * recoupment that is out of time still balances the file — the payer took the money, and the
   * ledger has to agree with the bank whether or not the takeback was lawful. What changes is that
   * somebody is now told about it.
   *
   * ── WHY THE EXPECTATION IS READ PER CLAIM ────────────────────────────────────────────────────
   * `submittedAt` is the entire prompt-pay clock and it exists nowhere on an 835. It comes from the
   * expectation this practice recorded when it filed, keyed per claim rather than assumed uniform,
   * so a claim this practice cannot recognise contributes nothing instead of borrowing the filing
   * date of the claim beside it — which would date a stranger's claim to our calendar and invoice a
   * payer for it.
   */
  async #publishStatutoryClock(remittance: Remittance, now: Date): Promise<void> {
    const claims: StatutoryClockObservedBody["claims"] = [];
    for (const posting of remittance.postings) {
      const expectation = await this.#expectations.getByControlNumber(posting.patientControlNumber);
      if (!expectation) continue;
      claims.push({
        patientControlNumber: posting.patientControlNumber,
        claimId: posting.claimId,
        payerId: expectation.payerId,
        submittedAt: expectation.submittedAt,
        chargedAmount: posting.chargedAmount,
        paidAmount: posting.paidAmount,
        disposition: posting.disposition,
        /**
         * Groups and codes RAW. Which of them mean the claim was never clean is the clock's rule,
         * and it is applied where it can be tested — the same reasoning that hands
         * `allowedFromLine` its adjustments unfiltered.
         */
        adjustments: posting.adjustments.map((a) => ({ group: a.group, code: a.code })),
      });
    }

    /**
     * PLB `L6` is interest the payer paid at the provider level. It is the suppressor for the whole
     * prompt-pay half, and it lives in a segment the claim loop never sees — so it is computed here
     * and travels as a fact rather than being re-derived by a consumer that would have to be handed
     * the PLB list anyway.
     */
    const interestPaidAtProviderLevel = remittance.providerAdjustments.some(
      (p) => p.reasonCode.trim().toUpperCase() === "L6"
    );

    /**
     * Nothing to say, so nothing is said. An advice with no claim we recognise and no provider-level
     * adjustment carries neither clock, and publishing it would put a row in the outbox for almost
     * every remittance — the precedent `#publishAllowedAmounts` already set.
     */
    if (claims.length === 0 && remittance.providerAdjustments.length === 0) return;

    await this.#publisher.publish(
      "remittance.statutory_clock_observed",
      remittance.id,
      {
        remittanceId: remittance.id,
        dedupeKey: remittance.dedupeKey,
        payerName: remittance.payerName,
        observedAt: now.toISOString(),
        paymentDate: remittance.paymentDate,
        claims,
        providerAdjustments: remittance.providerAdjustments.map((p) => ({
          reasonCode: p.reasonCode,
          referenceId: p.referenceId,
          amount: p.amount,
        })),
        interestPaidAtProviderLevel,
      },
      { occurredAt: now }
    );
  }
  /**
   * Say so when a payer paid by something other than ACH (F1).
   *
   * ── WHY FROM `#post` AND NOT FROM INGESTION ────────────────────────────────────────────────────
   * `#publishAllowedAmounts` is published here, and this belongs at the same moment for the same
   * reason: a HELD remittance is money a human has not yet accepted, and it can still be voided. An
   * observation raised at ingestion would tell a practice it had been charged a fee to receive a
   * payment it may never take. A held advice that is later released passes through here, so nothing
   * is lost — only deferred to the point the money is real.
   *
   * ── IDEMPOTENCY ────────────────────────────────────────────────────────────────────────────────
   * One payment posts once. `remittances_one_per_dedupe_key` is the constraint, `#post` is reached
   * once per remittance, and Postgres holds a row lock across `release()`. So one payment produces
   * at most one observation, and the `dedupeKey` travels in the payload so a consumer can recognise
   * a REDELIVERY of that one observation rather than counting a second fee.
   *
   * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
   * It does not hold, block, or alter a posting. The money is real, the file balances, and the fee
   * was charged wherever the card was run — refusing to post good money over it would be a worse
   * outcome than the fee. The remedy is an EFT enrolment, not a hold.
   */
  async #publishPaymentMethod(remittance: Remittance, now: Date): Promise<void> {
    const prior = await this.#repo.priorPaymentMethod(remittance.payerName, remittance.id);
    const assessment = assessPaymentMethod(remittance, {
      priorStanding: prior === null ? null : prior.trim().toUpperCase() === "ACH" ? "ach" : "non-ach",
      merchantRateBps: await resolveMerchantRate(this.#merchantRateBps),
    });

    /**
     * Only a non-ACH payment is worth an event. An ACH one is the normal case and publishing it
     * would put a row in the outbox for almost every remittance saying nothing happened; a
     * zero-dollar or reversing advice moved no money there was a fee to receive. The reversion case
     * does not need the ACH events either — the previous method is read from the remittances table,
     * which records one for every payment whether or not it was worth saying out loud.
     */
    if (assessment.standing !== "non-ach") return;

    await this.#publisher.publish(
      "remittance.payment_method_observed",
      remittance.id,
      {
        remittanceId: remittance.id,
        dedupeKey: remittance.dedupeKey,
        payerName: remittance.payerName,
        observedAt: now.toISOString(),
        method: assessment.method,
        paymentTotal: remittance.paymentTotal,
        feeCents: assessment.feeCents,
        reverted: assessment.reverted,
        priorMethod: prior,
      },
      { occurredAt: now }
    );
  }

  /**
   * Tell the payer profile what this payer says its contracted rates are (F-1).
   *
   * The estimate engine computes both the insurance and the patient share from the practice's BILLED
   * FEE. For an in-network practice that is wrong twice: the payer pays a percentage of its
   * contracted ALLOWED amount, and the gap between the fee and that amount is a write-off nobody
   * owes — so the patient is quoted for money no one will ever collect. The payer states the real
   * figure on every advice; nothing was reading it.
   *
   * Re-parsed from the retained 835 rather than read off the postings, for the plain reason that a
   * posting is claim-level and a fee schedule is per-procedure: only the service lines carry a
   * charge per code. `reconcileAll` already re-derives from this file, so the pattern and its
   * failure mode are established — no retained file means no observation, never a guess.
   *
   * Only group CO. "Contractual obligation" is by definition the portion a contracted provider may
   * not bill the patient, which is what makes `charge − CO` a contracted rate rather than an
   * arithmetic coincidence. An out-of-network payer reduces a charge under OA or PR and that money
   * is often the patient's; learning a rate from those groups would teach the estimate that an
   * out-of-network patient owes less than they do.
   *
   * Publishes nothing when there is nothing to say. An event carrying an empty list would make every
   * full-price claim look like a fee-schedule observation in the deliveries table.
   */
  async #publishAllowedAmounts(remittance: Remittance, now: Date): Promise<void> {
    if (!remittance.raw835 || remittance.raw835.trim() === "") return;
    const parsed = this.#adapter.parseRemittanceAll(remittance.raw835);
    if (!parsed.ok || !parsed.data || parsed.data.length === 0) return;

    /**
     * The payer SLUG comes from the claim's own expectation, exactly as `#publishPosting` gets it,
     * and never from the name the 835 printed: payers rename, and two payers can print the same
     * trading name. A rate filed against the wrong payer would be quoted to patients of a payer that
     * never agreed to it.
     *
     * Keyed per claim rather than assumed uniform, so a claim this practice cannot recognise
     * contributes nothing instead of borrowing the payer of the claim beside it.
     */
    const payerByControl = new Map<string, string>();
    for (const posting of remittance.postings) {
      const expectation = await this.#expectations.getByControlNumber(posting.patientControlNumber);
      if (expectation?.payerId) payerByControl.set(posting.patientControlNumber, expectation.payerId);
    }
    if (payerByControl.size === 0) return;

    const byPayer = new Map<string, { cdtCode: string; charged: Cents; allowed: Cents }[]>();
    /** Codes this advice paid with no contractual reduction — evidence a contract may have lapsed. */
    const fullPriceByPayer = new Map<string, Set<string>>();
    for (const advice of parsed.data) {
      for (const claim of advice.claims) {
        const payerId = payerByControl.get(claim.patientControlNumber);
        if (!payerId) continue;
        for (const line of claim.lines) {
          if (!line.procedureCode) continue;
          /**
           * Adjustments handed over RAW, all groups. Which of them count as a contracted write-off
           * is the payer profile's rule to apply, and it is applied where it can be tested — a
           * filter written here passed the whole suite when mutated to accept every group.
           */
          const observed = {
            cdtCode: line.procedureCode,
            charged: line.charged,
            quantity: line.quantity,
            adjustments: line.adjustments.map((a) => ({ group: a.group, amount: a.amount })),
          };
          const allowed = allowedFromLine(observed);
          if (allowed === null) {
            /**
             * No contracted rate to learn — but if the payer applied no contractual reduction AT
             * ALL, that is worth saying. A line reduced under some other group tells us nothing
             * either way; only the complete absence of CO is evidence the contract is not being
             * applied.
             */
            if (contractualWriteOff(observed) === 0 && line.charged > 0) {
              const set = fullPriceByPayer.get(payerId) ?? new Set<string>();
              set.add(line.procedureCode);
              fullPriceByPayer.set(payerId, set);
            }
            continue;
          }
          const list = byPayer.get(payerId) ?? [];
          // Both figures PER UNIT, which is the unit an estimate multiplies back out.
          list.push({ cdtCode: line.procedureCode, charged: chargedPerUnit(observed), allowed });
          byPayer.set(payerId, list);
        }
      }
    }

    for (const payerId of new Set([...byPayer.keys(), ...fullPriceByPayer.keys()])) {
      const lines = byPayer.get(payerId) ?? [];
      const fullPriceCodes = [...(fullPriceByPayer.get(payerId) ?? [])].sort();
      if (lines.length === 0 && fullPriceCodes.length === 0) continue;
      await this.#publisher.publish(
        "remittance.allowed_amounts_observed",
        remittance.id,
        {
          remittanceId: remittance.id,
          payerId,
          payerName: remittance.payerName,
          observedAt: now.toISOString(),
          lines,
          fullPriceCodes,
        },
        { occurredAt: now }
      );
    }
  }

  async #publishPosting(remittance: Remittance, posting: Posting, now: Date): Promise<void> {
    // An unmatched payment has no claim to close and no baseline to compare — it is recorded and
    // surfaced in the UI, but publishing it would tell Claims to settle a claim we cannot name.
    if (!posting.claimId || !posting.variance) return;
    const variance = posting.variance;

    // The payer SLUG, not just the name the 835 printed. Read once and carried on BOTH events: a
    // consumer that only gets a display name cannot reliably tie a payment back to the claim that
    // earned it (payers rename, and two payers can print the same trading name).
    const expectation = await this.#expectations.getByControlNumber(posting.patientControlNumber);
    const payerId = expectation?.payerId ?? null;
    /** Deduped and non-null: what this advice actually named, for award attribution downstream. */
    const procedureCodes = [
      ...new Set(posting.adjustments.map((a) => a.procedureCode).filter((c): c is string => !!c)),
    ];

    await this.#publisher.publish(
      "remittance.posted",
      posting.claimId,
      {
        remittanceId: remittance.id,
        postingId: posting.id,
        claimId: posting.claimId,
        patientControlNumber: posting.patientControlNumber,
        postedAt: posting.postedAt,
        traceNumber: remittance.traceNumber,
        payerId,
        payerName: remittance.payerName,
        // The posting knows the name the payer printed; the expectation knows the member ID the
        // claim was filed under. The ledger needs the latter to know WHOSE account this is.
        patientName: posting.patientName || expectation?.patientName || "Unknown patient",
        memberId: expectation?.memberId ?? null,
        paymentDate: remittance.paymentDate,
        chargedAmount: posting.chargedAmount,
        paidAmount: posting.paidAmount,
        patientResponsibility: posting.patientResponsibility,
        contractualAdjustments: variance.contractualAdjustments,
        // M8 — the ledger must be able to see that this balance is under coordination before it
        // bills anyone for it. Omitted when zero/false so the payload stays as it was for the
        // ordinary single-payer claim, which is the overwhelming majority.
        ...(variance.coordinationAmount !== 0 ? { coordinationAmount: variance.coordinationAmount } : {}),
        ...(posting.disposition === "forwarded" ? { forwardedToOtherPayer: true } : {}),
        /** Always sent, so a consumer never has to infer adjudication from the amounts alone. */
        disposition: posting.disposition,
        restatesPatientResponsibility: restatesPatientResponsibility(posting),
        ...(procedureCodes.length ? { procedureCodes } : {}),
        expectedInsurancePays: variance.expectedInsurancePays,
        variance: variance.variance,
        outcome: variance.outcome,
        /**
         * Settled means nothing further is expected FROM THIS PAYER on this claim: everything the
         * payer did not pay is explained by contract or by the patient's own balance.
         *
         * Derived from the adjudication rather than from `actionable`, because those two answer
         * different questions and only agreed by luck. `actionable` means "a person should look at
         * this", and an OVERPAYMENT is both settled and actionable — the payer is done, and someone
         * still has to handle the takeback. Reading `!actionable` turned every overpaid claim into
         * `partially_paid`, which is the one status that says the payer still owes money.
         *
         * `coordination_pending` joins the unsettled set (M8). Another plan is involved and has not
         * ruled, so the claim is genuinely not finished — marking it settled would move it to `paid`
         * in Claims and retire it from every queue while a secondary claim still needs filing.
         */
        settled:
          variance.adjudication !== "underpaid" &&
          variance.adjudication !== "denied" &&
          variance.adjudication !== "coordination_pending",
      },
      { occurredAt: now }
    );

    if (!variance.actionable) return;

    await this.#publisher.publish(
      "variance.detected",
      posting.claimId,
      {
        claimId: posting.claimId,
        remittanceId: remittance.id,
        postingId: posting.id,
        detectedAt: now.toISOString(),
        payerId,
        payerName: remittance.payerName,
        patientName: posting.patientName,
        // Everything an appeal letter has to name. Read from the expectation the claim recorded when
        // it was filed, because Denials cannot ask Claims and must not ask a human to retype it.
        memberId: expectation?.memberId ?? null,
        claimControlNumber: posting.patientControlNumber,
        serviceDate: expectation?.serviceDate ?? posting.postedAt.slice(0, 10),
        // The payer's own determination date (BPR16), so an appeal window is counted from when the
        // PAYER decided rather than from when this software noticed. See `VarianceDetectedBody`.
        ...(remittance.paymentDate ? { paymentDate: remittance.paymentDate } : {}),
        recoverableAmount: variance.recoverableAmount,
        unexplainedAmount: variance.unexplainedAmount,
        reasons: variance.reasons.map((r) => ({
          group: r.group,
          code: r.code,
          description: r.description,
          amount: r.amount,
          procedureCode: r.procedureCode,
        })),
        summary: variance.explanation.join(" "),
      },
      { occurredAt: now }
    );
  }

  /**
   * The read a mutating path starts from — `lockById`, never `getById`.
   *
   * `release()` is the only caller, and it is read-modify-write over money: two releases racing
   * both read `held`, both clear the already-posted guard, and both publish `remittance.posted`.
   * Claims and the ledger key on the posting and absorb it; analytics keys on the source EVENT and
   * cannot, so the practice report double-counts the advice. The lock makes the second caller wait
   * and then see `posted`, which is what the guard was always meant to do.
   */
  async #require(id: string): Promise<Remittance> {
    const remittance = await this.#repo.lockById(id);
    if (!remittance) throw new RemittanceNotFoundError(id);
    return remittance;
  }
}

/**
 * How a payer names itself, folded so that the same payer is the same string.
 *
 * An 835 shouts `METLIFE DENTAL` where a 271 says `MetLife Dental`, and internal whitespace varies
 * between a payer's own files. Read from the advice, never from a registry — see `dedupeKeyFor` for
 * why every ingredient of the key has to come out of the file itself.
 */
const payerKeyOf = (advice: RemittanceAdvice): string =>
  advice.payerName.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * The value uniqueness is enforced on — the payer AND its trace number when the payer gave one, a
 * content hash of the raw 835 when it did not.
 *
 * ── WHY THE PAYER IS PART OF THE KEY (M1) ──────────────────────────────────────────────────────
 * This returned `advice.traceNumber` alone, and a trace number is not unique. It is the payer's own
 * CHECK or EFT number — unique within that payer's own numbering and nowhere else. Payers start
 * sequences at low numbers and reuse them freely, so Delta Dental cheque `10024` and Cigna cheque
 * `10024` are ordinary, unrelated payments that collided on one key.
 *
 * What that collision did is the worst behaviour in this module, because it is the quietest.
 * `#ingest` finds the first remittance under that key, decides the second is a redelivery, and
 * returns the FIRST one's view as a success. The second payment is never written. On the ERA path
 * `EraIngestService` counts it among the advices it ingested and settles the artifact `ingested`, so
 * the worker reports a clean run. And `reconcileAll()` reconciles the `remittances` table against
 * itself — a payment that was never written contributes nothing to `drift`, so the money monitor,
 * whose entire job is to catch money that does not add up, reports BALANCED.
 *
 * The result is a payer's cheque in the bank against no ledger entry: claims left `submitted`,
 * patients never charged their share, nothing in the recovery queue, and no error anywhere.
 *
 * ── WHY THE PAYER NAME AND NOT TRN03 ───────────────────────────────────────────────────────────
 * TRN03 is the originating company identifier and is the technically correct qualifier — it exists
 * in the segment precisely because TRN02 does not stand alone. It is parsed (`trace.originator`) but
 * it is not a stored COLUMN, and that decides it: existing rows carry `dedupe_key = trace_number`
 * and must be backfilled to the new derivation, or a redelivery of an already-ingested ERA would
 * compute a key nothing matches and post the same money twice. A backfill can only use what is
 * already in the table, and `payer_name` is a column while the originator would have to be
 * recovered by re-parsing an encrypted, possibly-absent raw payload.
 *
 * The payer name is sufficient for what this key actually has to do, which is narrower than it
 * looks: it must be STABLE FOR THE SAME FILE REDELIVERED, and it must DIFFER between different
 * payments. The name is read out of the file, so a redelivery of those bytes yields the same name
 * however the payer may have rebranded since. Two payers sharing both a trace number and a printed
 * trading name is the residual risk, and it is far smaller than the one this replaces.
 *
 * ── WHY THIS IS NOT JUST `advice.traceNumber` ──────────────────────────────────────────────────
 * A TRN is situational in an 835, so trace-less files are legal and do arrive. Storing the empty
 * string as the uniqueness key made every trace-less remittance a duplicate of every other one, so
 * the second a practice received could never be ingested at all.
 *
 * ── WHY NOT PUT THE HASH IN `traceNumber` ──────────────────────────────────────────────────────
 * Because the safety gate blocks on `!advice.traceNumber.trim()`, and that blocker is correct:
 * without a payer-issued trace number there is nothing to quote back when a payment is disputed.
 * Deriving a key makes the file INGESTABLE; it must not make it look POSTABLE. The two fields stay
 * separate so this function can never accidentally satisfy that gate.
 *
 * ── WHY THE HASH IS OVER THE RAW BYTES *AND* THE ADVICE ────────────────────────────────────────
 * The raw bytes give stability: the same file redelivered hashes the same, so a repeat delivery is
 * recognised. Hashing the parsed advice ALONE would make the key move whenever the parser changed,
 * and a redelivery after a deploy would land as a new remittance.
 *
 * But the bytes alone are not enough, because one file can yield SEVERAL advices — `fetchAndIngest`
 * hands every advice in a batch the same `raw`. Two trace-less payments from one file would then
 * hash identically and the second would be silently swallowed as a duplicate, which loses a real
 * payment without an error anywhere. So a discriminator drawn from the advice's own money — payer,
 * total, date, and the claims it pays — is folded in. Stable across redelivery, distinct between
 * advices in one batch.
 *
 * With no raw payload AND no trace number there is nothing stable to key on, so the fallback is the
 * remittance's own id: unique, therefore never a false duplicate, but it cannot recognise a genuine
 * redelivery either. That is stated rather than hidden — it is the honest limit of what is knowable
 * from an advice that arrived with neither a trace number nor its own bytes.
 */
export function dedupeKeyFor(advice: RemittanceAdvice, raw: string | null): string {
  const trace = advice.traceNumber.trim();
  // Migration 0020 backfills existing rows to exactly this shape, so a redelivery of an ERA
  // ingested before that migration is still recognised as the duplicate it is.
  if (trace) return `${payerKeyOf(advice)}|${trace}`;
  if (!raw) return `id:${randomUUID()}`;

  // Sorted, because claim ORDER within an advice is not a fact about the payment. The payer is
  // already folded in here, which is why this branch never had M1's collision.
  const claims = advice.claims.map((c) => c.patientControlNumber).sort().join(",");
  const discriminator = [advice.payerName, advice.paymentTotal, advice.paymentDate, claims].join("|");
  return `sha256:${createHash("sha256").update(`${raw}\n${discriminator}`, "utf8").digest("hex")}`;
}

/**
 * Add the payee mismatch to a safety result as a blocker.
 *
 * Rebuilt rather than mutated: `checkRemittanceSafety` returns a value, and a caller that quietly
 * edits it would make the gate's output depend on who had touched it first.
 */
function withPayeeBlocker(base: SafetyResult, provenance: EraProvenance): SafetyResult {
  const finding: SafetyFinding = {
    severity: "blocker",
    code: "payee-mismatch",
    message: payeeMismatchMessage(provenance.claimedPayeeId, provenance.expectedPayeeId),
    remediation:
      "Confirm which practice this payment belongs to before releasing it. If the clearinghouse " +
      "credential for this practice is pointed at the wrong account, fix that first — every ERA it " +
      "has taken in needs re-checking.",
  };
  const findings = [...base.findings, finding];
  return {
    safeToPost: false,
    blockers: [...base.blockers, finding],
    notices: base.notices,
    findings,
  };
}

/** The audit line describing how this remittance's practice was decided. */
function describeProvenance(p: EraProvenance): string {
  const how =
    p.resolution === "source-credential"
      ? `retrieved with this practice's own ${p.vendor} credential`
      : `uploaded inside an authenticated session`;
  const artifact = p.artifactId ? ` (artifact ${p.artifactId})` : "";
  const payee =
    p.payeeCheck === "matched" ? `payee ${p.claimedPayeeId} matches the registered NPI`
    : p.payeeCheck === "mismatched" ? `PAYEE MISMATCH: file says ${p.claimedPayeeId ?? "—"}, source registered ${p.expectedPayeeId ?? "—"}`
    : p.payeeCheck === "absent" ? "the file named no payee identifier"
    : "no payee NPI is registered for this source, so none was checked";
  return `Practice resolved: ${how}${artifact}. Payee check — ${payee}.`;
}

function holdReason(safety: SafetyResult): string {
  const first = safety.blockers[0];
  const extra = safety.blockers.length > 1 ? ` (and ${safety.blockers.length - 1} more)` : "";
  return first ? `${first.message}${extra}` : "Held for review.";
}

const audit = (now: Date, actor: RemittanceAuditEvent["actor"], message: string): RemittanceAuditEvent => ({
  timestamp: now.toISOString(),
  actor,
  message,
});
