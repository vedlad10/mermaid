/**
 * Claim service — orchestration between the transport (API/UI) and the module's collaborators: the
 * pure engines (build, scrub, deadline, status), the persistence seam, the EDI adapter, and the
 * event publisher. All four are INJECTED, so this is testable and every vendor stays swappable.
 *
 * Two things here are load-bearing beyond ordinary CRUD:
 *
 *  1. **Creation is idempotent on `verificationId`.** The outbox delivers at least once; a
 *     redelivered `verification.completed` must not produce a second claim for the same visit.
 *     Duplicate claims are a billing incident, so the guard is in the service, not in the caller.
 *
 *  2. **Submission is a human gate.** `submit()` requires an actor and a clean scrub. Nothing in
 *     this module submits a claim on its own initiative, on a timer, or as an event side effect —
 *     releasing a bill to a payer is a person's decision (human-in-the-loop-workflow §; blueprint
 *     doc 08). The scrubber can only ever *block*; it can never *send*.
 *
 * No parameter properties (Node type-stripping forbids them): fields are declared and assigned.
 */
import {
  addCents,
  isSubscriber,
  orderHistory,
  type HistoryEntry,
  type PayerWindowSource,
  type SubscriberRelationship,
} from "@mermaid/shared";
import type {
  ClaimAcknowledgement,
  ClaimSubmissionRequest,
  EdiAdapter,
  EdiResult,
} from "@mermaid/edi";
import {
  NullEventPublisher,
  type EventPublisher,
  type DenialRecoverySettledBody,
  type RemittancePostedBody,
  type VerificationCompletedBody,
} from "@mermaid/events";
import { buildClaimDraft, normalizeClaimAddress, patientControlNumber } from "./engine/build.ts";
import { assessSilence, rankBySilenceUrgency, silenceWorsened } from "./engine/watchdog.ts";
import type { SilenceEscalation, SilenceFinding } from "./engine/watchdog.ts";
import { buildClaimTimeline } from "./engine/timeline.ts";
import { ESCALATING_RISKS, filingStatus } from "./engine/deadline.ts";
import { scrubClaim, type ScrubContext } from "./engine/scrub.ts";
import { assertTransition, isTerminal, SCRUBBABLE_STATUSES } from "./engine/status.ts";
import { buildClaimListItem, buildClaimView, type ClaimListItem, type ClaimView } from "./view.ts";
import type { ClaimFilter, ClaimRepository } from "./repository.ts";
import type { Claim, ClaimAppealRecovery, ClaimAuditEvent, ClaimPayment, ClaimPreAuthorization, ClaimStatus, FilingRisk, SubscriberAddress,
  RenderingProvider,
} from "./types.ts";

export class ClaimNotFoundError extends Error {
  constructor(id: string) {
    super(`claim ${id} not found`);
    this.name = "ClaimNotFoundError";
  }
}

/** The submit gate refused: the claim is not in a fileable state. */
export class ClaimNotSubmittableError extends Error {
  reason: string;
  constructor(id: string, reason: string) {
    super(`claim ${id} cannot be submitted: ${reason}`);
    this.name = "ClaimNotSubmittableError";
    this.reason = reason;
  }
}

/** The clearinghouse could not be reached. Distinct from a payer rejection — this is retryable. */
export class ClaimSubmissionFailedError extends Error {
  retryable: boolean;
  code: string;
  constructor(id: string, code: string, message: string, retryable: boolean) {
    super(`claim ${id} submission failed (${code}): ${message}`);
    this.name = "ClaimSubmissionFailedError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SubmitInput {
  /** Who is releasing this claim. Required — the gate is a human act and must be attributable. */
  submittedBy: string;
}

export interface BillingProviderIdentity {
  name: string;
  npi: string;
  taxId: string;
  /** Loop 1000A PER. A clearinghouse rejects an 837 without a submitter contact. */
  phone?: string;
  /** Loop 2010AA N3/N4. A payer will not adjudicate without the provider’s service address. */
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Loop 2000A PRV — the billing provider's taxonomy code. See `Config.billingProviderTaxonomy`. */
  taxonomy?: string;
  /**
   * Whether this NPI is a GROUP’s rather than an individual’s (NEW-22).
   *
   * When true, every claim must also name the dentist who performed the treatment — 837D loop
   * 2310B — or the payer is told the practice itself rendered the care. Part of the billing
   * identity because it is a fact about the same NPI, not a separate setting somebody could set
   * inconsistently with it.
   */
  isGroup?: boolean;
}

/**
 * This payer's filing window, from whoever holds the catalog.
 *
 * A narrow port the module owns, in the same shape and for the same reason as Verification's
 * `PayerAccuracyProvider`: Claims needs one number, and depending on the payer profile's whole
 * surface to get it would couple a bounded context to a service it has no business knowing.
 * Returning null means "the catalog has no entry", which the deadline engine turns into its own
 * documented default — a distinct outcome from being handed a guess.
 */
export interface PayerWindowProvider {
  filingWindowDays(payerId: string | null): Promise<number | null>;
  /**
   * The payer's own citation for the filing window this claim was given, or null when that window
   * is an estimate (B-1).
   *
   * Asked with the days actually used, so the answer describes the number behind this claim's date
   * and nothing else. Optional: a provider that cannot cite anything is saying every window is an
   * estimate, which is the honest default and what every claim before B-1 was.
   */
  sourceOfFilingWindow?(payerId: string | null, days: number): PayerWindowSource | null;
  /**
   * The payer’s id AT THE CLEARINGHOUSE, or null when this deployment has none for it.
   *
   * A different namespace from Mermaid’s slug, exactly as on the eligibility path. A vendor routes
   * a claim on this; sending the slug misroutes it. Asked here rather than looked up, so the module
   * stays free of any particular vendor’s registry.
   */
  clearinghouseIdFor(payerId: string | null): Promise<string | null>;
}

/** The default: no catalog, so every deadline falls back to the engine's own policy. */
export const NoPayerCatalog: PayerWindowProvider = {
  async filingWindowDays(): Promise<number | null> {
    return null;
  },
  async clearinghouseIdFor(): Promise<string | null> {
    return null;
  },
};

/**
 * How the service brackets work that must not span a vendor call (NEW-10).
 *
 * A PORT rather than a direct `withPractice`, for the reason every other collaborator here is one:
 * `modules/claims` does not import the platform's database, and a module that reached for a
 * connection pool could not be unit-tested without one.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The default: run it, with no transaction of its own.
 *
 * Correct for the in-memory repository — there is nothing to commit — and it means a caller that
 * has NOT wired a real unit of work behaves exactly as this service did before phases existed.
 */
export const InlineUnitOfWork: UnitOfWork = { run: (fn) => fn() };

/**
 * How long an unanswered submission blocks a second attempt (NEW-10).
 *
 * Comfortably longer than any clearinghouse timeout (Stedi's default is 30 seconds), and short
 * enough that a process killed mid-submission frees the claim within a coffee break rather than
 * needing a human with a database console.
 */
const SUBMISSION_ATTEMPT_TTL_MS = 5 * 60_000;

export class ClaimService {
  #repo: ClaimRepository;
  #adapter: EdiAdapter;
  #billingProvider: BillingProviderIdentity;
  #publisher: EventPublisher;
  #payerWindows: PayerWindowProvider;
  /**
   * The practice’s IANA timezone. Deadlines are calendar days in the clinic’s own day, not the
   * server’s — see packages/shared/src/calendar.ts. Injected rather than read from config so the
   * module stays free of the platform, exactly as the billing identity is.
   */
  #timeZone: string;
  /** How the two halves of a submission bracket the vendor call. See `UnitOfWork` (NEW-10). */
  #unitOfWork: UnitOfWork;

  constructor(
    repo: ClaimRepository,
    adapter: EdiAdapter,
    billingProvider: BillingProviderIdentity,
    publisher: EventPublisher = new NullEventPublisher(),
    payerWindows: PayerWindowProvider = NoPayerCatalog,
    timeZone = "UTC",
    /**
     * Defaults to running inline — no transaction at all — which is exactly right for the in-memory
     * repository the unit tests use and for the database-free demo. A deployment with Postgres
     * passes one that opens a short transaction per phase.
     */
    unitOfWork: UnitOfWork = InlineUnitOfWork
  ) {
    this.#repo = repo;
    this.#adapter = adapter;
    this.#billingProvider = billingProvider;
    this.#publisher = publisher;
    this.#payerWindows = payerWindows;
    this.#timeZone = timeZone;
    this.#unitOfWork = unitOfWork;
  }

  /**
   * Build a claim from a completed verification, scrub it, and persist it.
   *
   * Idempotent: if this verification already has a claim, the existing one is returned untouched.
   * That makes the method safe both as an event handler (at-least-once delivery) and as a manual
   * "bill this now" action from the UI — the same path, so the two can never diverge.
   */
  async createFromVerification(payload: VerificationCompletedBody, now: Date = new Date()): Promise<ClaimView> {
    const existing = await this.#repo.getByVerificationId(payload.verificationId);
    if (existing) return buildClaimView(existing, now, this.#timeZone);

    // The payer's own filing window, from the catalog that owns it. Null when it has no entry,
    // and the engine falls back to its documented default rather than losing the deadline.
    const payerId = payload.coverageSnapshot.payerId;
    const filingWindowDays = await this.#payerWindows.filingWindowDays(payerId);
    const draft = buildClaimDraft(
      {
        verificationId: payload.verificationId,
        patient: payload.patient,
        coverageSnapshot: payload.coverageSnapshot,
        filingWindowDays,
        // Whether the payer's own document stands behind that number (B-1), asked about the exact
        // number used so the claim's record describes its own date.
        filingWindowSource:
          filingWindowDays && filingWindowDays > 0
            ? (this.#payerWindows.sourceOfFilingWindow?.(payerId, filingWindowDays) ?? null)
            : null,
      },
      now
    );

    /**
     * What this patient already has filed for this date, so the scrubber can say so.
     *
     * Read here rather than inside the engine because the engine is a pure function over one claim.
     * Only the draft's own lines are compared against it, and only a warning comes of it — a second
     * claim for one visit is ordinary when a secondary payer is being billed, and wrong when nobody
     * meant to bill one twice. The scrubber's job is to make sure a person knows which this is.
     */
    const alreadyFiled = (await this.#repo.filedOnDateFor(draft.patient, draft.serviceDate)).flatMap((c) =>
      c.lines.map((l) => ({
        code: l.code,
        toothNumber: l.toothNumber ?? null,
        surfaces: l.surfaces ?? null,
        quantity: l.quantity,
        payerName: c.payer.payerName,
      }))
    );

    const scrubbed = this.#applyScrub(draft, now, "system", alreadyFiled);
    const saved = await this.#repo.save(scrubbed);
    return buildClaimView(saved, now, this.#timeZone);
  }

  async get(id: string, now: Date = new Date()): Promise<ClaimView | null> {
    const claim = await this.#repo.getById(id);
    return claim ? buildClaimView(claim, now, this.#timeZone) : null;
  }

  async getByVerification(verificationId: string, now: Date = new Date()): Promise<ClaimView | null> {
    const claim = await this.#repo.getByVerificationId(verificationId);
    return claim ? buildClaimView(claim, now, this.#timeZone) : null;
  }

  /** The value-ranked claims queue: highest work-priority first, then most recent. */
  async list(filter?: ClaimFilter, now: Date = new Date()): Promise<ClaimListItem[]> {
    const claims = await this.#repo.list(filter);
    return claims
      .map((c) => buildClaimListItem(c, now))
      .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * This context's contribution to a chronology (M14 deliverable 4) — every claim the filter matches,
   * each contributing its own timeline, interleaved.
   *
   * The same projection the single-claim timeline uses, so the patient record and the claim screen
   * can never tell different stories about the same claim.
   */
  async history(filter?: ClaimFilter): Promise<HistoryEntry[]> {
    const claims = await this.#repo.list(filter);
    return orderHistory(claims.flatMap(buildClaimTimeline));
  }

  /**
   * Re-run the scrubber. Used after the underlying data is corrected, and to re-evaluate a claim
   * whose filing deadline has moved closer since it was built.
   */
  async rescrub(id: string, now: Date = new Date()): Promise<ClaimView> {
    const claim = await this.#require(id);
    // Only pre-adjudication claims are re-scrubbed. Once a claim is with the payer or has been
    // ruled on, re-running the scrubber would imply it can be resubmitted as-is — it cannot; it must
    // be corrected and refiled, which is a deliberate act, not a sweep.
    if (!SCRUBBABLE_STATUSES.includes(claim.status)) {
      throw new ClaimNotSubmittableError(id, `a ${claim.status} claim is not re-scrubbed`);
    }
    const updated = this.#applyScrub(claim, now, "staff");
    const saved = await this.#repo.update(updated);
    return buildClaimView(saved, now, this.#timeZone);
  }

  /**
   * ── V5: correct the subscriber address on a claim that has not gone anywhere yet ─────────────
   *
   * The problem this closes. The scrubber blocks filing without the subscriber's address (837D loop
   * 2010BA N3/N4), which is correct — but until now the ONLY way to supply it was to verify the
   * patient again, because a claim inherits its patient details from the coverage snapshot and
   * nothing could touch them afterwards. Re-verifying to fix a ZIP burns a real eligibility call,
   * creates a second verification record, and produces a second claim; the first is left stranded.
   *
   * ── WHY THIS DOES NOT VIOLATE SNAPSHOT IMMUTABILITY ──────────────────────────────────────────
   * The rule that matters is that MONEY is inherited verbatim and never recomputed — fees, expected
   * insurance, patient responsibility, the benefits they were derived from. None of that is touched
   * here, and this deliberately does not re-derive any of it. An address is a demographic fact about
   * where a person lives, not a financial one, and correcting it changes nothing about what anyone
   * is owed. Every PMS in this category allows exactly this correction before a claim is filed.
   *
   * ── WHY ONLY BEFORE SUBMISSION ───────────────────────────────────────────────────────────────
   * Restricted to `SCRUBBABLE_STATUSES`, the same set `rescrub` uses. Once a payer holds the claim,
   * silently editing the address would make Mermaid's record disagree with the 837 that was actually
   * filed — and provenance is the whole point of keeping the filed copy. After submission the
   * correct act is a corrected claim (CLM05-3 frequency `7`), which already exists and is a
   * deliberate, separate decision.
   *
   * Re-scrubs immediately, so a claim blocked solely on the address becomes `ready` in one step and
   * the person who fixed it sees that it worked. Audited by name: this edits what goes to a payer.
   */
  async correctSubscriberAddress(
    id: string,
    address: SubscriberAddress,
    actor: string,
    now: Date = new Date()
  ): Promise<ClaimView> {
    const claim = await this.#require(id);
    if (!SCRUBBABLE_STATUSES.includes(claim.status)) {
      throw new ClaimNotSubmittableError(
        id,
        `a ${claim.status} claim's address cannot be edited — file a corrected claim instead`
      );
    }
    const who = actor.trim();
    if (!who) throw new ClaimNotSubmittableError(id, "a user is required to correct an address");

    // The same all-or-nothing rule the rest of the system holds: a half address passes the
    // scrubber's presence check and is then rejected by the payer, which is the expensive way to
    // find out. Normalised here so a hyphenated ZIP or a lowercase state is accepted from a form.
    const next = normalizeClaimAddress(address);
    if (!next) {
      throw new ClaimNotSubmittableError(id, "street, city, state and ZIP are all required");
    }

    const before = claim.patient.address;
    const described = `${next.street}, ${next.city} ${next.state} ${next.zip}`;
    const updated: Claim = {
      ...claim,
      patient: { ...claim.patient, address: next },
      updatedAt: now.toISOString(),
      audit: [
        ...claim.audit,
        audit(
          now,
          "staff",
          `${before ? "Corrected" : "Added"} subscriber address by ${who}: ${described}.`
        ),
      ],
    };
    // Re-scrub in the same act. The address is usually the only thing blocking, so this is what
    // turns "blocked" into "ready" without a second click nobody would know to make.
    const saved = await this.#repo.update(this.#applyScrub(updated, now, "staff"));
    return buildClaimView(saved, now, this.#timeZone);
  }

  /**
   * Name the dentist who performed the treatment — 837D loop 2310B (NEW-22).
   *
   * ── WHY THIS IS ITS OWN ACT, AND WHY IT RE-SCRUBS ─────────────────────────────────────────────
   * Shaped exactly like the subscriber-address correction next door, and for the same reasons. It
   * is a statement to a payer about who rendered care, so it is deliberate, attributable and on the
   * audit trail; and for a group practice its absence is usually the only thing blocking the claim,
   * so re-scrubbing here is what turns "blocked" into "ready" without a second click nobody would
   * know to make.
   *
   * Refused once the claim has gone to a payer. A rendering provider changed after filing does not
   * change what was filed — it makes the stored claim disagree with the 837 the payer holds, which
   * is worse than the original omission. Correct it by refiling as a replacement.
   */
  /**
   * Record what the payer said about authorising this treatment.
   *
   * ── EVERY FIELD IS SOMEBODY'S WORD, NOT AN INFERENCE ──────────────────────────────────────────
   * Nothing here is derived. A person or a payer supplies the status, the reference number and the
   * term, and Mermaid stores it with who recorded it and when. That is what makes an approval
   * evidence: a claim refused despite an authorisation is argued with the payer's own number, and a
   * number Mermaid invented would be worse than none.
   *
   * ── WHY AN APPROVAL DEMANDS A REFERENCE NUMBER ────────────────────────────────────────────────
   * Refused, because an approval that cannot be quoted back is not an approval a practice can rely
   * on — it is a memory of a phone call. `waived` deliberately does NOT demand one: there is no
   * number behind a payer saying none was needed, and demanding one would push staff to invent it.
   */
  async recordPreAuthorization(
    id: string,
    input: {
      status: ClaimPreAuthorization["status"];
      recordedBy: string;
      source: ClaimPreAuthorization["source"];
      referenceNumber?: string;
      validUntil?: string;
      denialReason?: string;
      note?: string;
    },
    now: Date = new Date()
  ): Promise<ClaimView> {
    const claim = await this.#require(id);
    const who = input.recordedBy.trim();
    if (!who) throw new ClaimNotSubmittableError(id, "a user is required");

    const reference = input.referenceNumber?.trim() ?? "";
    if (input.status === "approved" && !reference) {
      throw new ClaimNotSubmittableError(
        id,
        "an approval needs the payer's authorisation number — without it there is nothing to quote " +
          "back when the claim is refused anyway, and an approval nobody can evidence is not one"
      );
    }
    if (input.status === "denied" && !input.denialReason?.trim()) {
      throw new ClaimNotSubmittableError(
        id,
        "a refusal needs the payer's reason — it decides whether the route back is an appeal, a " +
          "corrected request, or a conversation with the patient"
      );
    }

    const decision: ClaimPreAuthorization = {
      status: input.status,
      source: input.source,
      requestedAt: claim.preAuthorization?.requestedAt ?? now.toISOString(),
      requestedBy: claim.preAuthorization?.requestedBy ?? who,
      ...(input.status === "pending" ? {} : { decidedAt: now.toISOString() }),
      ...(reference ? { referenceNumber: reference } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil.slice(0, 10) } : {}),
      ...(input.denialReason?.trim() ? { denialReason: input.denialReason.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    };

    const updated: Claim = {
      ...claim,
      preAuthorization: decision,
      updatedAt: now.toISOString(),
      audit: [
        ...claim.audit,
        audit(
          now,
          "staff",
          `Pre-authorisation recorded by ${who}: ${input.status}` +
            `${reference ? `, reference ${reference}` : ""}` +
            `${decision.validUntil ? `, valid to ${decision.validUntil}` : ""}` +
            `${decision.denialReason ? ` — "${decision.denialReason}"` : ""}` +
            ` (source: ${input.source}${input.source === "mock" ? ", SYNTHETIC TEST DATA" : ""}).`
        ),
      ],
    };

    /**
     * Re-scrubbed, because the gate reads this decision. Recording an approval must clear the
     * blocker in the same breath, or a person records the number and the screen still refuses.
     */
    return buildClaimView(await this.#repo.update(this.#applyScrub(updated, now, "staff")), now, this.#timeZone);
  }

  async setRenderingProvider(
    id: string,
    input: { provider: RenderingProvider; setBy: string },
    now: Date = new Date()
  ): Promise<ClaimView> {
    const claim = await this.#require(id);
    const who = input.setBy.trim();
    if (!who) throw new ClaimNotSubmittableError(id, "a user is required");
    if (!SCRUBBABLE_STATUSES.includes(claim.status)) {
      throw new ClaimNotSubmittableError(
        id,
        `it is ${claim.status}, so the rendering provider on the payer's copy cannot be changed by ` +
          `editing ours. File a replacement instead.`
      );
    }

    const provider: RenderingProvider = {
      firstName: input.provider.firstName.trim(),
      lastName: input.provider.lastName.trim(),
      npi: input.provider.npi.trim().replace(/\D/g, ""),
      taxonomyCode: input.provider.taxonomyCode.trim().toUpperCase(),
    };
    if (!provider.firstName || !provider.lastName || !provider.npi || !provider.taxonomyCode) {
      throw new ClaimNotSubmittableError(
        id,
        "a rendering provider needs a first name, a last name, an NPI and a taxonomy code — all " +
          "four, or loop 2310B is malformed rather than merely incomplete. A clearinghouse refuses " +
          "the whole claim on a missing PRV segment."
      );
    }

    const before = claim.renderingProvider;
    const updated: Claim = {
      ...claim,
      renderingProvider: provider,
      updatedAt: now.toISOString(),
      audit: [
        ...claim.audit,
        audit(
          now,
          "staff",
          `${before ? "Changed" : "Set"} rendering provider by ${who}: ` +
            `${provider.firstName} ${provider.lastName} (NPI ${provider.npi}, taxonomy ${provider.taxonomyCode})` +
            `${before ? `, was ${before.firstName} ${before.lastName} (NPI ${before.npi})` : ""}.`
        ),
      ],
    };
    const saved = await this.#repo.update(this.#applyScrub(updated, now, "staff"));
    return buildClaimView(saved, now, this.#timeZone);
  }

  /**
   * THE SUBMIT GATE. A human releases the claim to the clearinghouse.
   *
   * Refuses unless the claim is in a submittable status and its scrub is clean. A payer rejection
   * is recorded as a business outcome (status `rejected`) and does NOT throw — the claim is still a
   * real claim that a biller must now fix. Only a transport failure throws, because that submission
   * never happened and may be retried.
   */
  async submit(id: string, input: SubmitInput, now: Date = new Date()): Promise<ClaimView> {
    /**
     * ── THE VENDOR CALL HAPPENS BETWEEN TWO TRANSACTIONS, NOT INSIDE ONE (NEW-10) ──────────────
     *
     * This used to be one transaction from start to finish: lock the claim `FOR UPDATE`, validate
     * it, call the clearinghouse, write the answer. The call has a thirty-second timeout, and the
     * lock and one of the pool's ten connections were held for all of it. Ten concurrent
     * submissions to a slow vendor is the entire pool, and every other request in the process — a
     * screen loading, a payment being taken, the outbox draining — waits on somebody else's server.
     *
     * Three phases now:
     *
     *   1. lock, validate, record the ATTEMPT, commit   — milliseconds, and the lock is released
     *   2. call the clearinghouse                       — no transaction, no lock, no connection
     *   3. lock, record the ANSWER, commit              — milliseconds
     *
     * The idempotency key is unchanged: `patientControlNumber` is derived from the claim id, so a
     * retry presents the payer with the same number and is recognised as the same claim. That is
     * what makes it safe for phase 2 to be outside any transaction — a crash between 1 and 3 loses
     * no money and no correctness, only the knowledge of what happened, which phase 1 wrote down.
     */
    const { claim, actor, controlNumber, request } = await this.#unitOfWork.run(() =>
      this.#beginSubmission(id, input, now)
    );

    const result = await this.#adapter.submitClaim(request);

    return this.#unitOfWork.run(() => this.#completeSubmission(id, { actor, controlNumber, result }, now));
  }

  /**
   * Phase 1 — everything that must be decided before a payer sees the claim, under the lock.
   *
   * Returns the built request rather than the claim alone, so phase 2 needs nothing from the
   * database: the moment this commits, the connection is back in the pool.
   */
  async #beginSubmission(
    id: string,
    input: SubmitInput,
    now: Date
  ): Promise<{ claim: Claim; actor: string; controlNumber: string; request: ClaimSubmissionRequest }> {
    const claim = await this.#require(id);
    const actor = input.submittedBy.trim();
    if (!actor) throw new ClaimNotSubmittableError(id, "a submitting user is required");

    const gate = buildClaimView(claim, now, this.#timeZone);
    if (!gate.canSubmit) {
      throw new ClaimNotSubmittableError(id, gate.submitBlockedReason ?? "the claim is not ready");
    }
    // Belt and braces: the status machine refuses illegal transitions even if the view is stale.
    assertTransition(claim.status, "submitted");

    /**
     * ── THE IN-FLIGHT MARKER IS WHAT SERIALIZES TWO SUBMITTERS NOW (NEW-10) ────────────────────
     *
     * The row lock used to do this by accident: it was held across the clearinghouse call, so a
     * second press blocked until the first finished and then found the claim `submitted`. Releasing
     * the lock for the call — which is the whole point of the change — takes that away, so the
     * exclusion has to be stated rather than inherited from a lock held for an unrelated reason.
     *
     * The window is generous on purpose. A crash between phases would otherwise wedge the claim
     * permanently, and resubmitting is SAFE by construction: `patientControlNumber` is derived from
     * the claim id, so the payer sees the same number and recognises the same claim. Blocking
     * forever would be a worse failure than a duplicate the payer already de-duplicates.
     */
    const inFlight = claim.submissionAttempt;
    if (inFlight && now.getTime() - new Date(inFlight.startedAt).getTime() < SUBMISSION_ATTEMPT_TTL_MS) {
      throw new ClaimNotSubmittableError(
        id,
        `it was submitted to the clearinghouse at ${inFlight.startedAt} by ${inFlight.startedBy} and ` +
          `no answer has come back yet. Wait for the acknowledgement rather than filing it twice.`
      );
    }

    const controlNumber = patientControlNumber(claim.id);

    /**
     * A refiling needs the payer's number for the claim it replaces, and we may not have one.
     *
     * `claim.submission` existing is what elects frequency `7` below. But a submission can have been
     * recorded WITHOUT a control number — a clearinghouse that acknowledged without an identifier —
     * and a frequency-7 claim with nothing in REF*F8 is malformed: the payer is told to replace
     * something and not told what, so it denies the refiling as a duplicate (CARC 18).
     *
     * `build837D` refuses that combination outright, which is correct but surfaces deep inside the
     * adapter as a transport-shaped failure. Caught here instead so the person at the submit gate is
     * told what is actually wrong and what to do, in the same vocabulary as every other refusal.
     *
     * NOT silently downgraded to frequency `1`. That would file a second original under a control
     * number the payer already holds, which is the duplicate this exists to prevent.
     */
    if (claim.submission && !claim.submission.controlNumber.trim()) {
      throw new ClaimNotSubmittableError(
        id,
        "this claim has already been filed once, so refiling it is a REPLACEMENT — but no payer " +
          "control number was recorded for the original, and a payer cannot tell what a replacement " +
          "replaces without one. Obtain the payer's claim number for the original filing (from the " +
          "clearinghouse portal or the payer) before refiling."
      );
    }

    /**
     * The payer’s id at the CLEARINGHOUSE — a different namespace from Mermaid’s slug, which is
     * the playbook key and must never go on the wire. Null when this deployment has no id for the
     * payer, and the adapter then refuses rather than filing the slug and misrouting the claim.
     */
    const routingId = await this.#payerWindows.clearinghouseIdFor(claim.payer.payerId);

    /**
     * Non-null exactly when this claim is for a DEPENDENT — which is what decides whether a 2000C
     * loop is built at all. Read once so the two halves of the request below cannot disagree about
     * it, which is the failure that would put the patient in both loops or neither.
     */
    const subscriber = isSubscriber(claim.patient.relationship) ? null : claim.patient.subscriber;

    const request: ClaimSubmissionRequest = {
      claimId: claim.id,
      patientControlNumber: controlNumber,
      payerId: claim.payer.payerId ?? "",
      payerName: claim.payer.payerName ?? "",
      /**
       * ── WHO GOES IN 2010BA, AND WHO GOES IN 2010CA (NEW-01) ──────────────────────────────────
       *
       * `claim.patient` used to be poured straight into `subscriber`, on the assumption that the
       * two are the same person. In dental they usually are — and for a family they are not: the
       * plan issues one member id to the subscriber and covers the spouse and children under it.
       *
       * Filing a child as the subscriber tells the payer that the child holds the policy. It is
       * adjudicated against the wrong person's benefits, or rejected outright, and neither failure
       * names the actual cause.
       *
       * So the split happens here, where both facts are known: the policy holder goes in 2010BA
       * with the member id, and the patient goes in the 2000C level with their relationship. When
       * the patient IS the subscriber, `patient` is absent and the request is byte-for-byte what it
       * always was.
       *
       * `subscriber` is guaranteed present for a dependent claim by the scrubber, which refuses to
       * pass a claim whose relationship is not `self` and which names nobody — the alternative
       * being to invent a policy holder's name, which is a false statement to an insurer.
       */
      subscriber: {
        firstName: subscriber?.firstName ?? claim.patient.firstName,
        lastName: subscriber?.lastName ?? claim.patient.lastName,
        // The SUBSCRIBER's own date of birth when the practice recorded it. Falling back to the
        // patient's for a dependent would be a false statement, but DMG02 in 2010BA cannot be
        // empty — the scrubber is what stops a dependent claim reaching here without one.
        dateOfBirth: subscriber?.dateOfBirth ?? claim.patient.dateOfBirth,
        memberId: claim.patient.memberId,
        groupNumber: claim.payer.groupNumber,
        ...(claim.patient.address ? { address: claim.patient.address } : {}),
        ...(claim.patient.gender && !subscriber ? { gender: claim.patient.gender } : {}),
      },
      ...(subscriber
        ? {
            patient: {
              firstName: claim.patient.firstName,
              lastName: claim.patient.lastName,
              dateOfBirth: claim.patient.dateOfBirth,
              relationship: claim.patient.relationship as Exclude<SubscriberRelationship, "self">,
              ...(claim.patient.address ? { address: claim.patient.address } : {}),
              ...(claim.patient.gender ? { gender: claim.patient.gender } : {}),
            },
          }
        : {}),
      billingProvider: { ...this.#billingProvider },
      /**
       * Loop 2310B, only when the claim names someone (NEW-22). A solo practice never does, and
       * 005010X224A2 says to omit the loop there — so an ordinary claim's bytes are unchanged.
       */
      ...(claim.renderingProvider
        ? {
            renderingProvider: {
              firstName: claim.renderingProvider.firstName,
              lastName: claim.renderingProvider.lastName,
              npi: claim.renderingProvider.npi,
              taxonomyCode: claim.renderingProvider.taxonomyCode,
            },
          }
        : {}),
      // Null when unknown — the adapter refuses rather than filing under Mermaid’s own slug.
      ...(routingId ? { clearinghouseId: routingId } : {}),
      /**
       * A claim the payer has already seen is a REPLACEMENT, not a new claim.
       *
       * `claim.submission` still holds the PREVIOUS filing at this point — it is overwritten below
       * with the result of this one — so its control number is exactly what the payer needs in
       * REF*F8 to know which claim this replaces. Without it a corrected refiling is a duplicate,
       * and payers deny duplicates.
       */
      ...(claim.submission
        ? { claimFrequency: "7" as const, originalClaimControlNumber: claim.submission.controlNumber }
        : { claimFrequency: "1" as const }),
      serviceDate: claim.serviceDate,
      totalCharge: claim.totalFee,
      lines: claim.lines.map((l) => ({
        lineNumber: l.lineNumber,
        procedureCode: l.code,
        ...(l.toothNumber ? { toothNumber: l.toothNumber } : {}),
        ...(l.surfaces ? { surfaces: l.surfaces } : {}),
        quantity: l.quantity,
        chargeAmount: l.fee,
        serviceDate: l.serviceDate,
      })),
    };

    /**
     * The ATTEMPT is written before the call, in this transaction, so the moment the 837 leaves
     * there is a record that it did. A crash in phase 2 then leaves a claim that says "sent at
     * 14:02, no answer yet" rather than one indistinguishable from untouched.
     */
    await this.#repo.update({
      ...claim,
      updatedAt: now.toISOString(),
      submissionAttempt: {
        startedAt: now.toISOString(),
        startedBy: actor,
        patientControlNumber: controlNumber,
      },
    });

    return { claim, actor, controlNumber, request };
  }

  /**
   * Phase 3 — record what the payer said, under the lock again.
   *
   * The claim is RE-READ rather than carried across the vendor call. Thirty seconds is long enough
   * for someone to have voided it, corrected an address, or pressed Submit a second time, and
   * writing a stale copy back would silently undo whatever they did.
   */
  async #completeSubmission(
    id: string,
    ctx: { actor: string; controlNumber: string; result: EdiResult<ClaimAcknowledgement> },
    now: Date
  ): Promise<ClaimView> {
    const { actor, controlNumber, result } = ctx;
    const claim = await this.#require(id);

    if (!result.ok || !result.data) {
      // The attempt is cleared: nothing reached the payer, so nothing is in flight, and leaving the
      // marker would make the claim look permanently mid-submission.
      await this.#repo.update({ ...claim, updatedAt: now.toISOString(), submissionAttempt: null });
      const error = result.error;
      throw new ClaimSubmissionFailedError(
        id,
        error?.code ?? "unavailable",
        error?.message ?? "The clearinghouse did not respond.",
        error?.retryable ?? true
      );
    }

    const ack = result.data;

    /**
     * ── THE ACKNOWLEDGEMENT MUST BE ABOUT THIS CLAIM (M10) ────────────────────────────────────
     *
     * A 277CA echoes our own control number in TRN02. `parse277CA` has always read it, and nothing
     * ever compared it to what was sent. An acknowledgement is the ONLY evidence a claim reached a
     * payer, so one naming a different claim is evidence about a different claim — accepting it
     * records THIS claim as filed on the strength of somebody else's receipt, and the real one is
     * never chased because the queue believes it is gone.
     *
     * Thrown as a transport failure rather than recorded as a rejection, because that is what it is:
     * the submission's true outcome is unknown. The claim stays `ready` and fileable, and retrying
     * is safe — the control number is the idempotency key.
     *
     * A payer that echoed NOTHING is not a mismatch. Silence is legal, and refusing it would block
     * filing on every clearinghouse that does not populate TRN02.
     */
    if (ack.patientControlNumber && ack.patientControlNumber.trim() !== controlNumber) {
      await this.#repo.update({ ...claim, updatedAt: now.toISOString(), submissionAttempt: null });
      throw new ClaimSubmissionFailedError(
        id,
        "acknowledgement-mismatch",
        `The clearinghouse acknowledged claim "${ack.patientControlNumber.trim()}", but "${controlNumber}" ` +
          `was submitted. This acknowledgement is about a different claim, so it is not evidence that ` +
          `this one was filed. The claim has NOT been recorded as submitted.`,
        // Not retryable without a person looking: the same mismatch would recur, and something is
        // wrong at the vendor or in the routing that a retry loop cannot fix.
        false
      );
    }

    const accepted = ack.status === "accepted";
    const status: ClaimStatus = accepted ? "submitted" : "rejected";
    assertTransition(claim.status, status);

    const updated: Claim = {
      ...claim,
      status,
      updatedAt: now.toISOString(),
      // Answered, so nothing is in flight any more.
      submissionAttempt: null,
      submission: {
        submittedAt: now.toISOString(),
        submittedBy: actor,
        patientControlNumber: controlNumber,
        controlNumber: ack.controlNumber,
        outcome: ack.status,
        statusCategory: ack.statusCategory,
        statusCode: ack.statusCode,
        message: ack.message,
        lineErrors: ack.lineErrors,
        // Ambiguous line statuses are carried, not dropped: somebody has to read the payer's own
        // message, and a submission that quietly lost them would look like a clean rejection.
        unattributedLineErrors: ack.unattributedLineErrors,
        raw837: result.raw ?? null,
      },
      audit: [
        ...claim.audit,
        audit(now, "staff", `Submitted to ${claim.payer.payerName ?? "the payer"} by ${actor}.`),
        audit(
          now,
          "system",
          accepted
            ? `Accepted by the payer (control number ${ack.controlNumber}).`
            : `Rejected by the payer: ${ack.message}`
        ),
      ],
    };
    const saved = await this.#repo.update(updated);

    if (accepted) {
      await this.#publisher.publish(
        "claim.submitted",
        saved.id,
        {
          claimId: saved.id,
          verificationId: saved.verificationId,
          submittedAt: saved.submission!.submittedAt,
          submittedBy: actor,
          // Patient identity travels with the money — every downstream context needs it and none of
          // them may read this one's tables to get it.
          patient: {
            firstName: saved.patient.firstName,
            lastName: saved.patient.lastName,
            dateOfBirth: saved.patient.dateOfBirth,
            memberId: saved.patient.memberId,
            // Downstream, `memberId` alone cannot say WHOSE money this is — a family shares one.
            // Remittance resolves a payment to a person through it, so the relationship has to
            // travel with the payment as well as with the claim (NEW-01).
            ...(isSubscriber(saved.patient.relationship)
              ? {}
              : {
                  relationship: saved.patient.relationship!,
                  ...(saved.patient.subscriber ? { subscriber: saved.patient.subscriber } : {}),
                }),
          },
          payerId: saved.payer.payerId,
          payerName: saved.payer.payerName,
          // Both numbers travel: the clinic's is what a payment will be matched on, the payer's is
          // what a human quotes when chasing it.
          patientControlNumber: controlNumber,
          payerControlNumber: ack.controlNumber,
          totalFee: saved.totalFee,
          expectedInsurancePays: saved.expectedInsurancePays,
          serviceDate: saved.serviceDate,
        },
        { occurredAt: now }
      );
    }
    return buildClaimView(saved, now, this.#timeZone);
  }

  /**
   * Record a payment posted against this claim. Driven by `remittance.posted`.
   *
   * The claim does not decide anything about the money — every figure is the Remittance module's,
   * copied verbatim. What it decides is the resulting STATE, and that is a genuine three-way
   * distinction a biller acts on differently:
   *
   *   settled              → `paid`. Nothing further is expected from this payer.
   *   paid something, owed → `partially_paid`. Money is outstanding and recoverable.
   *   paid nothing         → `denied`. Correct, appeal, or write off.
   *
   * Idempotent on `postingId`: the outbox delivers at least once, and counting one payment twice
   * would overstate revenue. Returns `null` for a claim this module does not know — a payer may
   * remit against a claim filed before Mermaid, which is the Remittance module's unmatched-payment
   * problem, not an error here.
   */
  /**
   * Record how much of this claim's cash was won on appeal (F-7).
   *
   * Claims may not read the Denials context, so this is the `denial.recovery.settled` event — the
   * same one Remittance uses to stop advertising resolved money. Claims needs it for a different
   * reason: without it, a claim estimated at $175.00 that received $1,146.49 because an appeal was
   * won shows a $971.49 unexplained overpayment, and the only thing the system can say about the
   * practice's own hard-won money is "check whether this is a duplicate".
   *
   * Upserted on `denialId`, never appended. The event carries a running TOTAL for that denial, so a
   * redelivery converges and a reversal back to zero is simply another assignment — the same
   * discipline the producing side already applies.
   *
   * Deliberately does NOT touch status, payments, or any amount. This is an annotation explaining
   * cash that has already been recorded by `recordPayment`; if it ever moved money it would be
   * double-counting the recovery against the posting that delivered it.
   */
  async recordAppealRecovery(
    payload: DenialRecoverySettledBody,
    now: Date = new Date()
  ): Promise<ClaimView | null> {
    const claim = await this.#repo.lockById(payload.claimId);
    if (!claim) return null;

    const existing = claim.appealRecoveries ?? [];
    const prior = existing.find((r) => r.denialId === payload.denialId);
    if (prior && prior.settledAmount === payload.settledAmount && prior.awardedAmount === payload.awardedAmount) {
      // Nothing changed. Writing anyway would append an audit line on every redelivery.
      return buildClaimView(claim, now, this.#timeZone);
    }

    const recovery: ClaimAppealRecovery = {
      denialId: payload.denialId,
      settledAmount: payload.settledAmount,
      awardedAmount: payload.awardedAmount,
      settledAt: payload.settledAt,
    };
    const appealRecoveries = prior
      ? existing.map((r) => (r.denialId === payload.denialId ? recovery : r))
      : [...existing, recovery];

    const updated: Claim = {
      ...claim,
      appealRecoveries,
      updatedAt: now.toISOString(),
      audit: [
        ...claim.audit,
        audit(
          now,
          "system",
          `${formatMoney(payload.settledAmount)} of this claim's payments is money recovered on appeal ` +
            `(denial ${payload.denialId.slice(0, 8)}) — excluded from the estimate-accuracy comparison.`
        ),
      ],
    };
    return buildClaimView(await this.#repo.update(updated), now, this.#timeZone);
  }

  async recordPayment(payload: RemittancePostedBody, now: Date = new Date()): Promise<ClaimView | null> {
    // Locked, not merely read: the web process and the background worker both drain the outbox, so
    // two postings for one claim can be handled concurrently — and an unlocked read-modify-write
    // would let the second commit erase the first payment from `claim.payments`.
    const claim = await this.#repo.lockById(payload.claimId);
    if (!claim) return null;
    if (claim.payments.some((p) => p.postingId === payload.postingId)) {
      return buildClaimView(claim, now, this.#timeZone);
    }
    if (isTerminal(claim.status)) {
      // A voided claim that nonetheless received money is a real reconciliation problem, but it is
      // not this module's to resolve — record it in the audit trail and leave the status alone.
      const noted: Claim = {
        ...claim,
        updatedAt: now.toISOString(),
        audit: [
          ...claim.audit,
          audit(now, "system", `Payment of ${formatMoney(payload.paidAmount)} arrived for a ${claim.status} claim — reconcile by hand.`),
        ],
      };
      return buildClaimView(await this.#repo.update(noted), now, this.#timeZone);
    }

    // Payment Security Gate 1: If claim is already settled/paid, any additional positive payment is a duplicate payment hold
    if (claim.status === "paid" && payload.paidAmount > 0) {
      const duplicateHold: Claim = {
        ...claim,
        updatedAt: now.toISOString(),
        audit: [
          ...claim.audit,
          audit(now, "system", `Payment security hold: Duplicate payment (${formatMoney(payload.paidAmount)}) arrived for an already settled (paid) claim (trace ${payload.traceNumber}) — held for human review.`),
        ],
      };
      return buildClaimView(await this.#repo.update(duplicateHold), now, this.#timeZone);
    }

    // Payment Security Gate 2: An unsubmitted or rejected claim cannot be marked paid by an incoming remittance
    if (claim.status === "draft" || claim.status === "ready" || claim.status === "rejected" || claim.submission === null) {
      const unsubmittedAlert: Claim = {
        ...claim,
        updatedAt: now.toISOString(),
        audit: [
          ...claim.audit,
          audit(now, "system", `Payment security hold: Remittance arrived for an unverified/unsubmitted claim (status: ${claim.status}, submission: ${claim.submission ? "recorded" : "none"}) — payment held for human verification before posting.`),
        ],
      };
      return buildClaimView(await this.#repo.update(unsubmittedAlert), now, this.#timeZone);
    }

    // Payment Security Gate 3: Payment amount cannot exceed the total fee billed on the claim
    if (payload.paidAmount > claim.totalFee) {
      const excessiveAlert: Claim = {
        ...claim,
        updatedAt: now.toISOString(),
        audit: [
          ...claim.audit,
          audit(now, "system", `Payment security hold: Remittance paid amount ${formatMoney(payload.paidAmount)} exceeds total fee ${formatMoney(claim.totalFee)} billed on claim ${claim.id} — held for human review.`),
        ],
      };
      return buildClaimView(await this.#repo.update(excessiveAlert), now, this.#timeZone);
    }

    const payment: ClaimPayment = {
      postingId: payload.postingId,
      remittanceId: payload.remittanceId,
      postedAt: payload.postedAt,
      traceNumber: payload.traceNumber,
      paidAmount: payload.paidAmount,
      patientResponsibility: payload.patientResponsibility,
      contractualAdjustments: payload.contractualAdjustments,
      /**
       * Absent rather than zero when the payer said nothing about coordination, so a claim with no
       * secondary involved looks exactly as it always did.
       */
      ...(payload.coordinationAmount ? { coordinationAmount: payload.coordinationAmount } : {}),
      ...(payload.restatesPatientResponsibility !== undefined
        ? { restatesPatientResponsibility: payload.restatesPatientResponsibility }
        : {}),
      variance: payload.variance,
      outcome: payload.outcome,
      settled: payload.settled,
    };
    const payments = [...claim.payments, payment];
    const totalPaid = addCents(...payments.map((p) => p.paidAmount));

    const status: ClaimStatus = payload.settled ? "paid" : totalPaid > 0 ? "partially_paid" : "denied";
    /**
     * A payment that leaves the status WHERE IT IS is not a transition and must not be judged as
     * one. The transition table deliberately contains no self-loops, so asserting unconditionally
     * threw on the second partial payment (`partially_paid` → `partially_paid`) and on a repeat
     * zero-pay adjudication (`denied` → `denied`) — real remittances both: a secondary payer's
     * partial share, a corrected advice that still underpays, a payer denying a resubmission again.
     * The throw failed the `remittance.posted` handler, the event retried into the dead-letter
     * queue, and the payment never appeared on the claim: money received and recorded by
     * Remittance, invisible on the claim it paid. Same guard `#applyScrub` has always used.
     */
    if (status !== claim.status) assertTransition(claim.status, status);

    const updated: Claim = {
      ...claim,
      status,
      updatedAt: now.toISOString(),
      payments,
      audit: [
        ...claim.audit,
        audit(
          now,
          "system",
          `${payload.payerName || "The payer"} paid ${formatMoney(payload.paidAmount)} against an expected ` +
            `${formatMoney(payload.expectedInsurancePays)} (trace ${payload.traceNumber}). ` +
            (payload.settled
              ? "Fully settled."
              : `${formatMoney(Math.abs(payload.variance))} outstanding — see the remittance for the reasons.`)
        ),
      ],
    };
    return buildClaimView(await this.#repo.update(updated), now, this.#timeZone);
  }

  /** Withdraw a claim. Terminal — a voided claim is never resubmitted under this id. */
  async voidClaim(id: string, reason: string, actor = "staff", now: Date = new Date()): Promise<ClaimView> {
    const claim = await this.#require(id);
    assertTransition(claim.status, "void");
    const trimmed = reason.trim();
    if (!trimmed) throw new ClaimNotSubmittableError(id, "a reason is required to void a claim");

    const updated: Claim = {
      ...claim,
      status: "void",
      updatedAt: now.toISOString(),
      voidReason: trimmed,
      audit: [...claim.audit, audit(now, "staff", `Voided by ${actor}: ${trimmed}`)],
    };
    const saved = await this.#repo.update(updated);
    return buildClaimView(saved, now, this.#timeZone);
  }

  /**
   * ── THE SILENT-CLAIM WATCHDOG (F4) ──────────────────────────────────────────────────────────
   *
   * What a biller should work, among claims that got no answer. A READ — it changes nothing, and
   * it recomputes from the claims themselves rather than from a stored finding, because the
   * finding is a pure function of the claim and a stored copy could only ever go stale against it.
   *
   * Two statuses are swept and the exclusions are the feature. `submitted` is not in
   * `OPEN_STATUSES`, so no existing sweep looks at it — which is correct while payers answer and
   * is the whole defect when they do not. `rejected` IS open, but it looks like ordinary work
   * rather than a claim whose deadline is running against a filing the payer does not count.
   *
   * `denied` is deliberately absent. A denial is an ANSWER with a reason code and an appeal path,
   * and it belongs to the denials module; surfacing it here would put one claim in two worklists
   * under two incompatible remedies.
   */
  async silenceWatchlist(now: Date = new Date()): Promise<SilentClaim[]> {
    const candidates = [
      ...(await this.#repo.list({ status: "submitted" })),
      ...(await this.#repo.list({ status: "rejected" })),
    ];

    const rows: SilentClaim[] = [];
    for (const claim of candidates) {
      const { finding } = assessSilence(silenceInputFor(claim), now, this.#timeZone);
      if (!finding) continue;
      rows.push({
        id: claim.id,
        verificationId: claim.verificationId,
        patientName: `${claim.patient.firstName} ${claim.patient.lastName}`.trim(),
        payerName: claim.payer.payerName,
        status: claim.status,
        serviceDate: claim.serviceDate,
        controlNumber: claim.submission?.controlNumber ?? "",
        alreadyRaised: claim.silenceRaised ?? null,
        finding,
      });
    }
    return rankBySilenceUrgency(rows);
  }

  /**
   * Sweep silent claims and escalate them.
   *
   * The twin of `sweepFilingRisk`, and deliberately the same shape: raise only when the situation
   * is WORSE than what was last raised for this claim, so a repeated sweep is quiet. Returns what
   * was escalated in this pass. Kept an explicit method rather than a timer inside the module so
   * the caller owns the cadence and the behaviour stays deterministic under test.
   *
   * ── SHADOW MODE ───────────────────────────────────────────────────────────────────────────────
   * It moves no claim between statuses, touches no money, and blocks nothing. A silent claim is
   * still `submitted`; what changes is that somebody is told. Deciding on its own that a payer
   * never received a claim would be this module concluding an outcome no payer has stated — the
   * same line `recordPayment` respects when it refuses to mark a claim paid without an 835.
   */
  async sweepSilentClaims(now: Date = new Date()): Promise<SilentClaim[]> {
    const escalated: SilentClaim[] = [];

    for (const candidate of await this.silenceWatchlist(now)) {
      const next = { category: candidate.finding.category, risk: candidate.finding.filing.risk };
      if (!silenceWorsened(candidate.alreadyRaised, next)) continue;

      // Re-read under lock before writing: the watchlist read is unlocked, and a payment landing
      // between it and this update would otherwise be overwritten by a stale copy of the claim.
      const claim = await this.#repo.lockById(candidate.id);
      if (!claim) continue;
      if (!silenceWorsened(claim.silenceRaised, next)) continue;
      /**
       * Re-assessed under the lock rather than trusting the unlocked read. A remittance posting in
       * the gap turns this claim into `paid`, and escalating that would have a biller chase a payer
       * that has already answered — which is how a watchdog teaches people to ignore it.
       */
      const { finding } = assessSilence(silenceInputFor(claim), now, this.#timeZone);
      if (!finding) continue;

      const updated: Claim = {
        ...claim,
        silenceRaised: { category: finding.category, risk: finding.filing.risk },
        updatedAt: now.toISOString(),
        audit: [
          ...claim.audit,
          audit(
            now,
            "system",
            `Silent for ${finding.daysSilent} days (${finding.category}); filing risk ${finding.filing.risk}.`
          ),
        ],
      };
      const saved = await this.#repo.update(updated);

      await this.#publisher.publish(
        "claim.went_silent",
        saved.id,
        {
          claimId: saved.id,
          verificationId: saved.verificationId,
          raisedAt: now.toISOString(),
          category: finding.category,
          daysSilent: finding.daysSilent,
          filingDeadline: saved.filingDeadline,
          daysRemaining: finding.filing.daysRemaining,
          risk: finding.filing.risk,
          amountAtRisk: finding.amountAtRisk,
          payerName: saved.payer.payerName,
          controlNumber: saved.submission?.controlNumber ?? "",
          action: finding.action,
        },
        { occurredAt: now }
      );
      escalated.push({ ...candidate, alreadyRaised: updated.silenceRaised ?? null });
    }
    return escalated;
  }

  /**
   * Record that a HUMAN established the payer never received this claim, and reopen it for refiling.
   *
   * ── WHY THIS NEEDS A PERSON, AND WHY IT IS THE ONLY WAY OUT OF SILENCE ───────────────────────
   * `submitted` transitions only to the states a payer's answer produces — plus `rejected`, which
   * is the payer refusing at intake. There is deliberately no `submitted → draft`: a claim cannot
   * quietly become editable again while a copy of it may be sitting in an adjudication queue,
   * because the result is two live claims and a duplicate denial.
   *
   * So a silent claim has exactly one honest route back to the scrubber, and it runs through an
   * attestation. Somebody rang the clearinghouse or the payer and established that the claim is not
   * there. That is a fact about the world which no 835 will ever carry and this system cannot
   * observe — so it is recorded as what it is: a named human, a timestamp, and their reason.
   *
   * The alternative, which is what a watchdog is tempted into, is to let the sweep decide that
   * silence means non-receipt and reopen the claim itself. That would be this module concluding an
   * outcome no payer has stated, on a timer — and on a claim that was merely slow, it manufactures
   * the duplicate it was built to prevent.
   *
   * Uses the EXISTING `submitted → rejected` transition rather than widening the status machine.
   * `rejected` already means "refused at intake, never adjudicated, correct it and refile", which is
   * precisely the situation — and `rejected → draft` is already legal, so the correction and
   * resubmission path the practice needs is the one it already knows.
   */
  async markUnreceived(
    id: string,
    reason: string,
    actor = "staff",
    now: Date = new Date()
  ): Promise<ClaimView> {
    const claim = await this.#require(id);
    const why = reason.trim();
    if (!why) {
      throw new ClaimNotSubmittableError(
        id,
        "a reason is required — recording that a payer never received a claim is an attestation, and an unattributed one is worthless as evidence of timely filing"
      );
    }
    if (claim.status !== "submitted") {
      throw new ClaimNotSubmittableError(
        id,
        `only a submitted claim can be marked unreceived; this one is ${claim.status}`
      );
    }
    if (claim.payments.length > 0) {
      throw new ClaimNotSubmittableError(
        id,
        "this claim has money posted against it, so the payer did receive it"
      );
    }

    assertTransition(claim.status, "rejected");
    const updated: Claim = {
      ...claim,
      status: "rejected",
      updatedAt: now.toISOString(),
      /**
       * The escalation state is cleared, not kept. The claim has moved to a different kind of
       * silence — the practice's own — and the next sweep should say so rather than staying quiet
       * because it already spoke about the old one.
       */
      silenceRaised: null,
      audit: [
        ...claim.audit,
        audit(now, "staff", `${actor} established the payer never received this claim: ${why}. Reopened for correction and refiling.`),
      ],
    };
    const saved = await this.#repo.update(updated);
    return buildClaimView(saved, now, this.#timeZone);
  }
  /**
   * Sweep open claims and escalate timely-filing risk.
   *
   * Raises `claim.filing_risk` only when a claim's risk level is WORSE than what was last raised for
   * it, so a repeated sweep is quiet. Returns the claims escalated in this pass. Intended to be run
   * by a scheduled job; kept as an explicit method rather than a timer inside the module so the
   * caller controls cadence and the behaviour stays deterministic under test.
   */
  async sweepFilingRisk(now: Date = new Date()): Promise<ClaimListItem[]> {
    const claims = await this.#repo.list({ openOnly: true });
    const escalated: ClaimListItem[] = [];

    for (const candidate of claims) {
      const filing = filingStatus(candidate.filingDeadline, now, this.#timeZone, candidate.filingWindowSource);
      if (!ESCALATING_RISKS.includes(filing.risk)) continue;
      if (!worsened(candidate.filingRiskRaised, filing.risk)) continue;

      // Re-read under lock before writing: the list read is unlocked, and a payment landing between
      // it and this update would otherwise be overwritten by a stale copy of the claim.
      const claim = await this.#repo.lockById(candidate.id);
      if (!claim) continue;
      if (!worsened(claim.filingRiskRaised, filing.risk)) continue;

      const updated: Claim = {
        ...claim,
        filingRiskRaised: filing.risk,
        updatedAt: now.toISOString(),
        audit: [...claim.audit, audit(now, "system", `Filing risk escalated to ${filing.risk}: ${filing.message}`)],
      };
      const saved = await this.#repo.update(updated);

      await this.#publisher.publish(
        "claim.filing_risk",
        saved.id,
        {
          claimId: saved.id,
          verificationId: saved.verificationId,
          raisedAt: now.toISOString(),
          filingDeadline: saved.filingDeadline,
          daysRemaining: filing.daysRemaining,
          risk: filing.risk as "approaching" | "urgent" | "expired",
          amountAtRisk: saved.expectedInsurancePays,
          payerName: saved.payer.payerName,
        },
        { occurredAt: now }
      );
      escalated.push(buildClaimListItem(saved, now));
    }
    return escalated;
  }

  /** Run the scrubber and move the claim between draft and ready accordingly. */
  #applyScrub(
    claim: Claim,
    now: Date,
    actor: ClaimAuditEvent["actor"] = "system",
    alreadyFiled: readonly {
      code: string;
      toothNumber: string | null;
      surfaces: string | null;
      quantity: number;
      payerName: string | null;
    }[] = []
  ): Claim {
    const context: ScrubContext = {
      billingProvider: this.#billingProvider,
      // A group must name the rendering provider; a solo practice must not (NEW-22).
      ...(this.#billingProvider.isGroup ? { practiceIsGroup: true } : {}),
      // Empty on a re-scrub: `rescrub` re-evaluates the claim it holds, and re-reading what else was
      // filed there would let a warning appear or vanish because of a claim this one did not change.
      ...(alreadyFiled.length > 0 ? { alreadyFiled } : {}),
    };
    const scrub = scrubClaim(claim, context, now, this.#timeZone);
    const nextStatus: ClaimStatus = scrub.clean ? "ready" : "draft";
    const message = scrub.clean
      ? `Scrub clean${scrub.warnings > 0 ? ` (${scrub.warnings} advisory note(s))` : ""} — ready to submit.`
      : `Scrub found ${scrub.errors} blocking issue(s) and ${scrub.warnings} advisory note(s).`;

    // Only pre-adjudication claims move between draft and ready. Once a payer has ruled on a claim,
    // the scrubber may still report on it but must not reset its state.
    const status = SCRUBBABLE_STATUSES.includes(claim.status) && claim.status !== nextStatus ? nextStatus : claim.status;
    if (status !== claim.status) assertTransition(claim.status, status);

    return {
      ...claim,
      status,
      scrub,
      updatedAt: now.toISOString(),
      audit: [...claim.audit, audit(now, actor, message)],
    };
  }

  /**
   * The read every mutating path starts from — `lockById`, never `getById`.
   *
   * Row-locked so concurrent mutators serialize: without it, two clicks of the submit button both
   * read `ready`, both pass the gate, and the claim goes to the clearinghouse twice; and two
   * `remittance.posted` handlers (the request drain and the background worker both run) each read
   * the same `payments` array, and the second commit erases the first payment from the record.
   */
  async #require(id: string): Promise<Claim> {
    const claim = await this.#repo.lockById(id);
    if (!claim) throw new ClaimNotFoundError(id);
    return claim;
  }
}

const RISK_ORDER: Record<FilingRisk, number> = { safe: 0, approaching: 1, urgent: 2, expired: 3 };

/** True when `next` is a strictly worse filing risk than what was last escalated. */
/**
 * One claim the watchdog has something to say about (F4).
 *
 * Carries `alreadyRaised` so a caller can tell a NEW escalation from a standing one without a
 * second read — the difference between "this just went urgent" and "this has been urgent for a
 * fortnight", which is the difference between a notification and a worklist row.
 */
export interface SilentClaim {
  id: string;
  verificationId: string;
  patientName: string;
  payerName: string | null;
  status: ClaimStatus;
  serviceDate: string;
  /** What the payer acknowledged, when it acknowledged anything. Empty is itself the finding. */
  controlNumber: string;
  alreadyRaised: SilenceEscalation | null;
  finding: SilenceFinding;
}

/**
 * The claim, reduced to exactly what the watchdog is allowed to see.
 *
 * Narrow on purpose. The engine is pure and its findings end up in front of a biller as
 * instructions to refile or not to refile; handing it the whole aggregate would let a future rule
 * reach for something the test fixtures do not set, and pass.
 */
const silenceInputFor = (claim: Claim) => ({
  status: claim.status,
  submission: claim.submission
    ? {
        submittedAt: claim.submission.submittedAt,
        outcome: claim.submission.outcome,
        controlNumber: claim.submission.controlNumber,
      }
    : null,
  filingDeadline: claim.filingDeadline,
  expectedInsurancePays: claim.expectedInsurancePays,
  hasPayment: claim.payments.length > 0,
});
function worsened(raised: FilingRisk | null, next: FilingRisk): boolean {
  return RISK_ORDER[next] > RISK_ORDER[raised ?? "safe"];
}

const audit = (now: Date, actor: ClaimAuditEvent["actor"], message: string): ClaimAuditEvent => ({
  timestamp: now.toISOString(),
  actor,
  message,
});

/** Local money formatting for audit lines — display only; the stored figures stay integer cents. */
const formatMoney = (value: number): string =>
  (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
