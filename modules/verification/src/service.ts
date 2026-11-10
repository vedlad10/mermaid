/**
 * Verification service — the thin orchestration layer between the transport (API/UI) and the module's
 * two collaborators: the deterministic pipeline (runVerification) and the persistence seam
 * (VerificationRepository). Both are INJECTED, so this is testable and the EDI vendor / storage
 * backend stay swappable. It turns the completed-but-headless M2 pipeline into an actual product
 * feature: verify → persist → look up later → route through a human review.
 *
 * No parameter properties (Node type-stripping forbids them — design decision §12.15): fields are
 * declared and assigned explicitly.
 */
import { runVerification, type VerificationInput } from "./pipeline.ts";
import { BUILTIN_PAYERS, type NetworkParticipation, type PayerDirectory } from "./engine/payer.ts";
import { orderHistory, type FeeSchedule, type HistoryEntry } from "@mermaid/shared";
import { verificationHistory } from "./engine/history.ts";
import { NoCardReader, type CardReader, type CardReadResult } from "./engine/card-vision.ts";
import type { LlmImage } from "@mermaid/llm";
import type { EdiAdapter } from "@mermaid/edi";
import { NullEventPublisher, type EventPublisher, type VerificationCompletedBody } from "@mermaid/events";
import type { VerificationFilter, VerificationRepository } from "./repository.ts";
import { buildCompletedEvent, buildNeedsReviewEvent } from "./events.ts";
import { buildListItem, buildVerificationView, type VerificationListItem, type VerificationView } from "./view.ts";
import { NoPayerHistory, type ExceptionFlag, type PayerAccuracyProvider, type ReviewDecision, type VerificationRecord } from "./types.ts";
import type { PatientDirectory } from "./patients.ts";
import { detectIdentityCollision, type CoverageOnFile } from "./engine/identity.ts";
import { routeForReview, statusFor } from "./engine/analysis.ts";

export interface ReviewInput {
  decision: ReviewDecision["decision"];
  notes: string;
}

export class VerificationNotFoundError extends Error {
  constructor(id: string) {
    super(`verification ${id} not found`);
    this.name = "VerificationNotFoundError";
  }
}

export class VerificationService {
  #repo: VerificationRepository;
  #adapter: EdiAdapter;
  #publisher: EventPublisher;
  #payerHistory: PayerAccuracyProvider;
  #patients: PatientDirectory | null;
  #cardReader: CardReader;
  /** V3 — payer slug → this practice's network participation. Empty means every payer is `unknown`. */
  #participation: Map<string, NetworkParticipation>;
  /** The practice's IANA timezone; the coverage-window check compares the payer's dates to the clinic's day. */
  #timeZone: string;
  /** Reads the payer catalog once per verification — see the constructor. */
  #payers: () => Promise<PayerDirectory>;
  #feeSchedule: () => Promise<FeeSchedule>;

  /**
   * The publisher defaults to a no-op so the service stays usable (and unit-testable) without a
   * wired event bus — a module must never depend on whether anyone is listening. The composition
   * root injects the real outbox.
   *
   * `payerHistory` defaults to knowing nothing, for the same reason: a verification must still run
   * in a process where the shared brain is not wired, and it must produce exactly the score it
   * produced before this parameter existed when it is not.
   */
  constructor(
    repo: VerificationRepository,
    adapter: EdiAdapter,
    publisher: EventPublisher = new NullEventPublisher(),
    payerHistory: PayerAccuracyProvider = NoPayerHistory,
    patients: PatientDirectory | null = null,
    /**
     * Optional AI card reader (workflow S2). Defaults to declining, which means a supplied
     * photograph is ignored and the typed card text is used — the behaviour before there was a
     * camera, and the behaviour of any deployment without a PHI-approved LLM provider.
     */
    cardReader: CardReader = NoCardReader,
    /**
     * V3 — which network column each payer's benefits are read from. Defaults to empty, which is
     * `unknown` for every payer and is byte-identical to the behaviour before V3 existed. A
     * deployment states this; it is never inferred.
     */
    participation: Map<string, NetworkParticipation> = new Map(),
    /** The practice's IANA timezone — "today" for the coverage-window check is the clinic's day. */
    timeZone = "UTC",
    /**
     * How the deployment's payer catalog is read, once per verification (NEW-08).
     *
     * A FUNCTION rather than a value: the catalog is a table an administrator edits, so a payer
     * added at 10am must be matchable at 10:01 without a restart. Reading it here — at the edge of
     * one verification, before the deterministic pipeline starts — is what lets the pipeline stay a
     * pure function of its inputs while the catalog stays live data.
     *
     * Defaults to the built-in seven, which is what the database-free demo has.
     */
    payers: () => Promise<PayerDirectory> = async () => BUILTIN_PAYERS,
    /**
     * What each payer has been observed to allow, per procedure code (F-1).
     *
     * A FUNCTION, for the same reason `payers` is one: this is learned data that grows every time a
     * remittance posts, so a rate observed this morning must reach the next quote without a restart.
     * Read here — at the edge of one verification, before the deterministic pipeline starts — which
     * is what lets the pipeline stay a pure function of its inputs while the schedule stays live.
     *
     * Defaults to empty, which prices every line off the billed fee: exactly the behaviour that
     * shipped before this existed, and the right answer for a practice with no remittance history.
     */
    feeSchedule: () => Promise<FeeSchedule> = async () => new Map()
  ) {
    this.#repo = repo;
    this.#adapter = adapter;
    this.#publisher = publisher;
    this.#payerHistory = payerHistory;
    this.#cardReader = cardReader;
    this.#patients = patients;
    this.#participation = participation;
    this.#timeZone = timeZone;
    this.#payers = payers;
    this.#feeSchedule = feeSchedule;
  }

  /**
   * Read a card photograph and hand the fields BACK to whoever is filling the form, without
   * verifying anything and without persisting anything.
   *
   * ── WHY THIS EXISTS SEPARATELY FROM `create` ────────────────────────────────────────────────
   * `create` also reads photographs, but it reads them at the moment the verification runs — which
   * means the extracted fields go straight into the record and the person at the front desk never
   * sees them. They photograph a card, watch a thumbnail appear, and then look at a card-text box
   * that is still empty and a Member ID box that is still empty, with nothing telling them why.
   * That is the whole defect: extraction existed, but there was no point in the flow at which a
   * human could be shown what was read and correct it.
   *
   * So this is a READ, deliberately: no verification, no patient record, no event, no row. It
   * returns what the card says so the form can be filled in, and the person then reviews it and
   * presses Verify exactly as they would have if they had typed it. The confidence gate, the payer
   * registry and the review routing are untouched and still run at `create` — this does not
   * shortcut any of them, because the text it produces goes through the same pipeline as typed text.
   */
  async readCard(images: LlmImage[]): Promise<{ available: boolean; read: CardReadResult | null }> {
    const available = this.#cardReader.available();
    if (!available) return { available: false, read: null };
    // `read` degrades to null rather than throwing; the catch is for a future reader that is less
    // careful, because failing to read a card must never be able to break the check-in screen.
    const read = await this.#cardReader.read(images).catch(() => null);
    return { available: true, read };
  }

  /** Run the deterministic pipeline and persist the resulting record. */
  async create(input: VerificationInput, now: Date = new Date()): Promise<VerificationView> {
    const payers = await this.#payers();
    const feeSchedule = await this.#feeSchedule();
    const record = await runVerification(
      input,
      this.#adapter,
      now,
      this.#payerHistory,
      this.#cardReader,
      this.#participation,
      this.#timeZone,
      payers,
      feeSchedule
    );

    /**
     * The person enters the practice's patient master here, whatever the verification concluded.
     *
     * Deliberately not conditional on success: a patient whose coverage could not be verified is
     * still a patient the practice has seen, and the front desk will look for them by name tomorrow.
     * Idempotent, because the chart id is derived from the identity rather than allocated — the same
     * person verified three times is one row.
     *
     * Runs in the same transaction as the verification write, so a rolled-back request leaves no
     * orphan patient behind.
     *
     * BEFORE the save rather than after (M14 deliverable 4). The verification row carries the
     * resolved `patient_id`, so the id has to exist by the time the record is written — one INSERT
     * that is right, rather than an INSERT followed by an UPDATE that a crash could leave undone.
     */
    const linked = this.#patients ? await this.#linkPatient(record) : record;
    const saved = await this.#repo.save(linked);

    await this.#announce(saved, now);
    return buildVerificationView(saved, now);
  }

  /**
   * Resolve this record's patient, tie their member ID to them, and stamp the record with the id.
   *
   * Throws on a directory failure, and deliberately: the whole request is one transaction, so the
   * alternative is a verification saved without the link and a `patients` row that may or may not
   * exist — two rows that disagree about whether the practice has seen this person. Failing keeps
   * the atomicity the ambient transaction already provides. (This is the opposite call from the
   * ledger's `#append`, where an unresolvable member ID must never stop money being recorded; there
   * the resolution is optional enrichment, here it is the identity of the record being written.)
   */
  async #linkPatient(record: VerificationRecord): Promise<VerificationRecord> {
    const patients = this.#patients;
    if (!patients) return record;
    const patient = await patients.ensure(
      {
        firstName: record.patient.firstName,
        lastName: record.patient.lastName,
        dateOfBirth: record.patient.dateOfBirth,
      },
      // Demographics, not identity: an address must never reach `deriveChartId`, or a person who
      // moves house becomes a second patient. Merged forward only, so a check-in that skipped the
      // address cannot erase the one already on file.
      { ...(record.patient.address ? { address: record.patient.address } : {}), ...(record.patient.gender ? { gender: record.patient.gender } : {}) }
    );

    /**
     * …and the member ID they hold is tied to them here.
     *
     * This is the mapping the whole of M14 part 2 resolves through. The money carries a member ID
     * from the coverage snapshot all the way to the payer's advice; this is the one place that ID
     * and the person are seen together, so it is the only honest place to record the link.
     */
    const memberId = record.card.memberId.value ?? record.patient.memberId;

    /**
     * ── THE COLLISION CHECK, BEFORE THE LINK IS WRITTEN (M14) ────────────────────────────────────
     *
     * Read what is already on file FIRST. `linkCoverage` below is an upsert, so asking afterwards
     * would find the incoming member ID already present and compare it to itself — the check would
     * pass on every visit and be worth nothing.
     *
     * A brand-new patient has no coverages, so this is empty and nothing fires. The detector is
     * only ever looking at a chart the practice already held.
     */
    let collision: CoverageOnFile | null = null;
    if (memberId) {
      const onFile = await patients.coveragesFor(patient.id);
      collision = detectIdentityCollision(onFile, { memberId, payerKey: record.payerId });
    }

    /**
     * The link is written EITHER WAY, and that is deliberate.
     *
     * Withholding it would mean the practice's own record of a coverage it demonstrably holds
     * depends on a question nobody has answered yet, and the money that arrives under that member
     * ID would resolve to nobody. The flag is what stops the two people being treated as one; the
     * mapping is just a fact. Nothing is merged, reassigned or corrected by recording it.
     */
    if (memberId) {
      /**
       * The RELATIONSHIP travels with the link (NEW-01).
       *
       * A dental plan issues one member ID to the subscriber and covers the family under it, so
       * this is the one place the system learns that this member ID belongs to this person AS a
       * dependent — and the only place it can, because the card names the subscriber and the front
       * desk names the patient. Recorded here, it reaches loop 2000C of the 837D months later; not
       * recorded, and every family member is filed as the policy holder.
       */
      await patients.linkCoverage(patient.id, memberId, record.payerId, {
        ...(record.patient.relationship ? { relationship: record.patient.relationship } : {}),
        ...(record.patient.subscriber ? { subscriber: record.patient.subscriber } : {}),
      });
    }

    /**
     * A returning patient's address is REUSED when this visit did not collect one.
     *
     * Without this the master could accumulate addresses it never gave back: a patient verified in
     * March with an address, seen again in June without one, and the June claim blocked at the
     * submit gate for a fact the practice demonstrably already holds. The front desk would then
     * re-key an address that is already on file, which is exactly where invented data comes from.
     *
     * Precedence is one-directional and deliberate: an address collected TODAY always wins, because
     * it is the more recent statement about where this person lives. Only silence falls back.
     *
     * This is a reuse of the practice's own record, not an invention — the address was typed by a
     * human at a previous check-in and stored. It can still be STALE (see the limitation noted in
     * the checkpoint); correcting it is the edit path, which is V5 and deliberately not built here.
     */
    const patched =
      !record.patient.address && patient.address
        ? { ...record, patient: { ...record.patient, address: { ...patient.address } } }
        : record;

    if (!collision) return { ...patched, patientId: patient.id };

    /**
     * A collision candidate re-routes the record through the SAME machinery every other critical
     * exception uses — `routeForReview` → `statusFor` — rather than inventing a parallel workflow.
     * The pipeline already routed once, before this step existed; this is the second answer to the
     * same question, now that there is evidence the pipeline could not have had.
     *
     * It can only ever move a record TOWARD review: `routeForReview` returns `needsReview` for any
     * critical exception, and this adds one. A verification already heading to a human stays there.
     */
    const exceptions: ExceptionFlag[] = [
      ...patched.exceptions,
      {
        severity: "critical",
        code: "identity-collision",
        message:
          `This chart already holds member ID ${collision.memberId} with the same payer, and this visit ` +
          `presents ${memberId}. Two different people who share a name and a date of birth resolve to one ` +
          `chart, and their balances and statements would be merged. Confirm this is the same person before ` +
          `continuing.`,
      },
    ];
    const routing = routeForReview(patched.confidence, exceptions);

    return {
      ...patched,
      patientId: patient.id,
      exceptions,
      status: statusFor(Boolean(patched.benefits), routing.needsReview),
      audit: [
        ...patched.audit,
        {
          timestamp: patched.createdAt,
          actor: "system",
          message:
            `Possible identity collision: chart ${patient.chartId} already holds ${collision.memberId} ` +
            `with payer ${collision.payerKey}. Routed for human confirmation; nothing was merged.`,
        },
      ],
    };
  }

  async get(id: string, now: Date = new Date()): Promise<VerificationView | null> {
    const record = await this.#repo.getById(id);
    return record ? buildVerificationView(record, now) : null;
  }

  /** The value-ranked queue: highest work-priority first, then most recent. */
  async list(filter?: VerificationFilter, now: Date = new Date()): Promise<VerificationListItem[]> {
    const records = await this.#repo.list(filter);
    return records
      .map((r) => buildListItem(r, now))
      .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * This context's contribution to a chronology (M14 deliverable 4).
   *
   * Each module answers for its own history and no module reads another's, exactly as each answers
   * for its own worklist in the Today queue. The composition root interleaves the five answers; it
   * could not write this one itself without knowing what a verification means.
   */
  async history(filter?: VerificationFilter): Promise<HistoryEntry[]> {
    const records = await this.#repo.list(filter);
    return orderHistory(records.flatMap(verificationHistory));
  }

  /**
   * Record a human review decision (HITL, blueprint doc 08 / human-in-the-loop §): approved or
   * overridden settle the case (status "reviewed"); rejected marks it unusable (status "failed").
   * The estimate math is never touched — only the disposition and the audit trail.
   */
  async review(id: string, input: ReviewInput, now: Date = new Date()): Promise<VerificationView> {
    /**
     * Locked, not merely read. Two reviewers deciding the same flagged verification at once would
     * both read the pre-review record, and the second write would erase the first person's decision
     * and notes — on the screen a practice quotes when a patient disputes what they were told. Both
     * would also announce, and analytics keys on the source EVENT id, so the funnel over-counts.
     */
    const record = await this.#repo.lockById(id);
    if (!record) throw new VerificationNotFoundError(id);

    /**
     * ── WHY THERE IS NO ALREADY-SETTLED GUARD HERE (NEW-12) ────────────────────────────────────
     *
     * The finding this addresses offered two fixes and one of them was a guard refusing re-review.
     * It is not the one taken, deliberately.
     *
     * Re-review is a capability this codebase decided to have: a supervisor overruling a first
     * reviewer is a real act, and `tests/db/verification-concurrency.test.ts` exists specifically to
     * prove that when two people decide the same record, BOTH decisions stay on the audit trail —
     * "somebody's documented decision disappearing from the record a practice quotes in a dispute"
     * is the failure it guards. Refusing the second review would delete that capability to fix a
     * counting bug, which is the wrong trade.
     *
     * The counting bug was never really about re-review. It was that analytics deduplicated on the
     * SOURCE EVENT, so any second announcement of one verification — whatever produced it — became
     * a second fact. `verification.completed` now carries `dedupeKey: verification:<id>`, so the
     * visit is counted once however many events describe it, and re-review stays legitimate.
     *
     * The lock above is what makes concurrent reviews safe; this note is what stops the guard being
     * added back on the reasoning that "settled means finished".
     */

    const review: ReviewDecision = {
      decision: input.decision,
      notes: input.notes,
      reviewedAt: now.toISOString(),
    };
    const updated: VerificationRecord = {
      ...record,
      review,
      status: input.decision === "rejected" ? "failed" : "reviewed",
      audit: [
        ...record.audit,
        {
          timestamp: now.toISOString(),
          actor: "staff",
          message: `Reviewed: ${input.decision}${input.notes ? ` — ${input.notes}` : ""}.`,
        },
      ],
    };
    const saved = await this.#repo.update(updated);
    await this.#announce(saved, now);
    return buildVerificationView(saved, now);
  }

  /**
   * The `verification.completed` payload for a record, or `null` when it is not billable (not
   * settled, or no coverage snapshot to inherit).
   *
   * Exposed so a transport can drive claim creation on demand — "bill this now" — through exactly
   * the same payload the event carries. Without it the API would need a second, divergent path into
   * billing, and the two would eventually disagree.
   */
  async completionEvent(id: string): Promise<VerificationCompletedBody | null> {
    const record = await this.#repo.getById(id);
    if (!record) throw new VerificationNotFoundError(id);
    return buildCompletedEvent(record);
  }

  /**
   * Publish the record's outbound event. Exactly one fires per state: a settled record announces
   * `verification.completed` (carrying the snapshot billing inherits); an unsettled one announces
   * `verification.needs_review` for the Today queue.
   *
   * A settled record with no snapshot publishes nothing — there is no estimate to bill against, and
   * emitting an empty completion would invite a claim with no coverage behind it.
   */
  async #announce(record: VerificationRecord, now: Date): Promise<void> {
    const completed = buildCompletedEvent(record);
    if (completed) {
      await this.#publisher.publish("verification.completed", record.id, completed, { occurredAt: now });
      return;
    }
    const needsReview = buildNeedsReviewEvent(record, now);
    if (needsReview) {
      await this.#publisher.publish("verification.needs_review", record.id, needsReview, { occurredAt: now });
    }
  }
}
