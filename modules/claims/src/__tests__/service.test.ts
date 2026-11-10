/**
 * Claim-service tests: idempotent creation, the human submit gate, payer rejection handling, void,
 * and filing-risk escalation — against the in-memory repository and the mock EDI adapter.
 *
 * The gate tests are the ones that matter most. If any path in this suite could file a claim without
 * a named human and a clean scrub, the module has failed its central obligation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { cents } from "@mermaid/shared";
import {
  ClaimNotFoundError,
  ClaimNotSubmittableError,
  ClaimService,
  ClaimSubmissionFailedError,
  InMemoryClaimRepository,
  buildClaimTimeline,
} from "../index.ts";
import type { ClaimSubmissionRequest, EdiAdapter, EdiResult, ClaimAcknowledgement } from "@mermaid/edi";
import type { DenialRecoverySettledBody, RemittancePostedBody } from "@mermaid/events";
import { BILLING_PROVIDER, NOW, PATIENT, completedEvent, snapshot } from "./fixtures.ts";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

const silent = createLogger(() => {});

function wired(adapter: EdiAdapter = new MockEdiAdapter()) {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryClaimRepository();
  const service = new ClaimService(repo, adapter, BILLING_PROVIDER, bus);
  return { bus, repo, service };
}

// ── Creation ──────────────────────────────────────────────────────────────────────────

test("a completed verification becomes a scrubbed, ready-to-submit claim", async () => {
  const { service, repo } = wired();
  const view = await service.createFromVerification(completedEvent(), NOW);

  assert.equal(view.claim.status, "ready");
  assert.equal(view.claim.verificationId, "ver-0001");
  assert.equal(view.claim.totalFee, cents(1425));
  assert.equal(view.claim.expectedInsurancePays, cents(800));
  assert.ok(view.claim.scrub?.clean);
  assert.equal(view.canSubmit, true);
  assert.equal(view.submitBlockedReason, null);
  assert.equal(repo.size, 1);
});

test("creation is idempotent — a redelivered event produces no second claim", async () => {
  const { service, repo } = wired();
  const first = await service.createFromVerification(completedEvent(), NOW);
  const second = await service.createFromVerification(completedEvent(), NOW);

  assert.equal(repo.size, 1, "duplicate claims are a billing incident, not a cosmetic bug");
  assert.equal(first.claim.id, second.claim.id);
  assert.deepEqual(first.claim.audit, second.claim.audit, "the existing claim is returned untouched");
});

/**
 * ── A SECOND POLICY IS A SECOND CLAIM, AND SOMEBODY HAS TO KNOW ────────────────────────────────
 *
 * `claims_one_per_verification` makes creation idempotent per verification, which is the test
 * directly above. It cannot see across verifications — and a patient with two coverages is verified
 * twice by design, so one crown became two full-fee claims to two payers, both filed as primary and
 * both paid. This is the reach the constraint does not have, done in the service where the
 * repository can be asked.
 *
 * A warning, not a block: billing a secondary payer after the primary rules is correct and ordinary.
 * Doing it without anyone noticing is not.
 */
test("a second claim for the same treatment on the same day is flagged, not silently filed", async () => {
  const { service } = wired();

  const first = await service.createFromVerification(completedEvent(), NOW);
  assert.ok(first.claim.scrub?.clean, "the first filing of a crown is unremarkable");
  assert.equal(
    first.claim.scrub?.findings.some((f) => f.code === "duplicate-service"),
    false
  );

  // The same person, the same day, the same tooth — a different policy, so a different verification.
  const second = await service.createFromVerification(
    completedEvent({
      coverageSnapshot: snapshot({ verificationId: "ver-0002", payerId: "metlife-dental", payerName: "MetLife Dental" }),
    }),
    NOW
  );

  const finding = second.claim.scrub?.findings.find((f) => f.code === "duplicate-service");
  assert.ok(finding, "the second full-fee claim for one crown must not go out unremarked");
  assert.equal(finding!.severity, "warning");
  assert.match(finding!.message, /already on another claim/);
  assert.equal(second.claim.status, "ready", "a warning must never block a legitimate secondary filing");
  assert.equal(second.canSubmit, true);
});

/**
 * ── A SHARED NAME IS NOT A SHARED PERSON ───────────────────────────────────────────────────────
 *
 * The lookup matched on name alone, so a father and son seen on one day flagged each other's
 * claims — and this database holds exactly such a pair. `deriveChartId` resolves a person on
 * surname, given name AND date of birth, so the date of birth is what tells them apart; matching
 * without it asked a different question than the patient master answers.
 */
test("two different people who share a name do not flag each other's claims", async () => {
  const { service } = wired();

  await service.createFromVerification(completedEvent(), NOW);

  // Same name, same day, same tooth — a DIFFERENT person, by the only discriminator identity uses.
  const son = await service.createFromVerification(
    completedEvent({
      patient: { ...PATIENT, dateOfBirth: "2016-09-03" },
      coverageSnapshot: snapshot({ verificationId: "ver-0002" }),
    }),
    NOW
  );

  assert.equal(
    son.claim.scrub?.findings.some((f) => f.code === "duplicate-service"),
    false,
    "a namesake's crown is not this patient's duplicate"
  );
});

/**
 * A claim the payer refused AT INTAKE was never accepted, so correcting and refiling it is the
 * prescribed act. Warning on it would fire the control on the routine correction path.
 */
test("a rejected claim is not something a refiling duplicates", async () => {
  const { service, repo } = wired();

  const first = await service.createFromVerification(completedEvent(), NOW);
  const stored = (await repo.getById(first.claim.id))!;
  await repo.update({ ...stored, status: "rejected" });

  const refiled = await service.createFromVerification(
    completedEvent({ coverageSnapshot: snapshot({ verificationId: "ver-0002" }) }),
    NOW
  );

  assert.equal(
    refiled.claim.scrub?.findings.some((f) => f.code === "duplicate-service"),
    false,
    "the payer never accepted the first, so the second is a correction and not a second billing"
  );
});

test("a claim that fails the scrubber stays in draft and cannot be submitted", async () => {
  const { service } = wired();
  const broken = snapshot();
  delete broken.calculation.lines[2]!.toothNumber;

  const view = await service.createFromVerification(completedEvent({ coverageSnapshot: broken }), NOW);

  assert.equal(view.claim.status, "draft");
  assert.equal(view.canSubmit, false);
  assert.match(view.submitBlockedReason!, /1 blocking issue/);
  assert.equal(view.blockers[0]!.code, "missing-tooth-number");
  assert.match(view.recommendedAction, /Add the tooth number/);
});

test("a claim can be looked up by id and by the verification it came from", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);

  assert.equal((await service.get(created.claim.id, NOW))!.claim.id, created.claim.id);
  assert.equal((await service.getByVerification("ver-0001", NOW))!.claim.id, created.claim.id);
  assert.equal(await service.get("nope", NOW), null);
  assert.equal(await service.getByVerification("nope", NOW), null);
});

// ── The submit gate ───────────────────────────────────────────────────────────────────

test("submitting a clean claim files it and publishes claim.submitted", async () => {
  const { service, bus } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);

  const view = await service.submit(created.claim.id, { submittedBy: "front.desk@clinic" }, NOW);

  assert.equal(view.claim.status, "submitted");
  assert.equal(view.claim.submission!.outcome, "accepted");
  assert.equal(view.claim.submission!.submittedBy, "front.desk@clinic");
  assert.match(view.claim.submission!.controlNumber, /^\d{9}$/);
  assert.ok(view.claim.submission!.raw837?.includes("ST*837*"), "the filed 837 is retained");
  assert.ok(
    view.claim.audit.some((a) => a.actor === "staff" && a.message.includes("front.desk@clinic")),
    "the submit gate is attributable to a person"
  );

  const events = bus.ofType("claim.submitted");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.claimId, created.claim.id);
  assert.equal(events[0]!.payload.verificationId, "ver-0001");
  assert.equal(events[0]!.payload.expectedInsurancePays, cents(800));
});

test("the gate refuses a claim with blocking scrub errors", async () => {
  const { service, bus } = wired();
  const broken = snapshot();
  broken.benefits.eligibility = "inactive";
  const created = await service.createFromVerification(completedEvent({ coverageSnapshot: broken }), NOW);

  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "front.desk@clinic" }, NOW),
    (err: unknown) => {
      assert.ok(err instanceof ClaimNotSubmittableError);
      assert.match(err.reason, /blocking issue/);
      return true;
    }
  );
  assert.equal((await service.get(created.claim.id, NOW))!.claim.status, "draft");
  assert.equal(bus.ofType("claim.submitted").length, 0);
});

test("the gate refuses an unnamed submitter — filing is always attributable", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "   " }, NOW),
    /a submitting user is required/
  );
});

test("a claim cannot be submitted twice", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);

  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "biller" }, NOW),
    /already been submitted/
  );
});

test("a payer rejection is recorded as a business outcome, not thrown", async () => {
  const { service, bus } = wired();
  // Member IDs ending "00" are rejected by the mock payer at intake.
  const rejecting = snapshot({ memberId: "MEM10000" });
  const created = await service.createFromVerification(
    completedEvent({
      coverageSnapshot: rejecting,
      patient: { firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03", memberId: "MEM10000" , address: SYNTHETIC_ADDRESS},
    }),
    NOW
  );

  const view = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);

  assert.equal(view.claim.status, "rejected");
  assert.equal(view.claim.submission!.outcome, "rejected");
  assert.equal(view.claim.submission!.statusCode, "33");
  assert.match(view.recommendedAction, /Fix and resubmit/);
  assert.equal(bus.ofType("claim.submitted").length, 0, "a rejected claim was never accepted");
});

test("a transport failure throws and leaves the claim untouched for a retry", async () => {
  // Wrap the real mock and override only submission, so this stays valid as the adapter grows.
  const base = new MockEdiAdapter();
  const failing: EdiAdapter = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(_req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      return {
        ok: false,
        error: { code: "timeout", message: "The clearinghouse did not respond.", retryable: true },
        source: "mock",
      };
    },
  });
  const { service } = wired(failing);
  const created = await service.createFromVerification(completedEvent(), NOW);

  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "biller" }, NOW),
    (err: unknown) => {
      assert.ok(err instanceof ClaimSubmissionFailedError);
      assert.equal(err.retryable, true, "a transport blip must be retryable, not a denial");
      assert.equal(err.code, "timeout");
      return true;
    }
  );
  const after = await service.get(created.claim.id, NOW);
  assert.equal(after!.claim.status, "ready", "the claim is still fileable");
  assert.equal(after!.claim.submission, null);
});

/**
 * ── M11 — a refiling with no payer control number is refused AT THE GATE ───────────────────────
 *
 * `claim.submission` existing is what elects CLM05-3 frequency `7` (a replacement). But a
 * submission can have been recorded WITHOUT a payer control number, and a replacement that does not
 * quote the original in REF*F8 is malformed: the payer is told to supersede a claim and not told
 * which, so it denies the refiling as a duplicate (CARC 18).
 *
 * `build837D` now refuses that combination, which is right but surfaces from inside the adapter as
 * a transport-shaped failure. This pins the gate-level refusal a biller actually sees — and pins
 * that the claim is NOT quietly downgraded to a second original, which would file under a control
 * number the payer already holds.
 */
test("M11: refiling a claim whose original filing has no payer control number is refused", async () => {
  const base = new MockEdiAdapter();
  // A clearinghouse that answered about the claim but named no control number for it.
  const anonymousAck: EdiAdapter = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(_req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      return {
        ok: true,
        data: {
          status: "rejected",
          controlNumber: "",
          patientControlNumber: null,
          statusCategory: "A3",
          statusCode: "33",
          message: "Returned as unprocessable.",
          acknowledgedAt: NOW.toISOString(),
          lineErrors: [],
          unattributedLineErrors: [],
        },
        source: "mock",
      };
    },
  });

  const { service } = wired(anonymousAck);
  const created = await service.createFromVerification(completedEvent(), NOW);
  const filed = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  assert.equal(filed.claim.status, "rejected");
  assert.equal(filed.claim.submission!.controlNumber, "", "the setup this guards against");

  // The real correction workflow: a rejected claim is re-scrubbed back to `ready` before refiling.
  // `rejected → submitted` is not a legal transition; `rejected → ready → submitted` is.
  const ready = await service.rescrub(created.claim.id, NOW);

  /**
   * ── THIS EXPECTATION MOVED, AND THE MOVE IS THE POINT ───────────────────────────────────────
   *
   * It used to read `status === "ready"` and `canSubmit === true`: the claim LOOKED fileable, and
   * the refusal arrived only once a biller pressed Submit. That was the best this test could pin
   * while the only guards lived in `submit` and the codec — and the doc block above says exactly
   * that, describing M11 as moving the refusal out of the adapter to "the gate a biller actually
   * sees".
   *
   * `scrubClaim` now carries the same rule (`replacement-without-control-number`), so a refiling
   * that cannot name its original never reaches `ready` at all. Same direction, one step further:
   * the biller reads what is wrong and what to fetch BEFORE spending an action, rather than
   * meeting an exception on one they expected to work.
   */
  assert.equal(ready.claim.status, "draft", "a blocking finding demotes it; it is not fileable");
  assert.equal(ready.canSubmit, false);
  const blocker = ready.blockers.find((f) => f.code === "replacement-without-control-number");
  assert.ok(blocker, "the gate must say why, not merely withhold the button");
  // The wording this test used to demand of the thrown error now lives on the finding, where a
  // human reads it. Still pinned, just at the layer that now carries it.
  assert.match(blocker.message, /REPLACEMENT/);
  assert.match(blocker.message, /payer control number/i);
  assert.match(blocker.remediation, /control number/i);

  /**
   * Submitting anyway is still refused. The reason is now the gate's own ("blocking issue(s)"),
   * because `#beginSubmission` consults `canSubmit` before it reaches its own replacement check —
   * that check remains as defence in depth for a stale view, and `replacement-needs-a-control-
   * number.test.ts` pins that the two predicates cannot drift apart.
   */
  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "biller" }, NOW),
    (err: unknown) => {
      assert.ok(err instanceof ClaimNotSubmittableError, "a usable refusal, not a raw codec throw");
      assert.match(err.reason, /blocking issue/i);
      return true;
    }
  );

  const after = await service.get(created.claim.id, NOW);
  // Still the ORIGINAL filing's record, and still blocked — no second original went out under a
  // control number the payer already holds, which is the duplicate this whole guard exists to stop.
  assert.equal(after!.claim.status, "draft", "it must not have quietly filed a second original");
  assert.equal(after!.claim.submission!.controlNumber, "", "the rejected first filing, unchanged");
});

test("M11: a refiling that DOES carry the payer's control number still files, as a replacement", async () => {
  /**
   * The control. Without it, breaking the refiling path entirely would also satisfy the test above —
   * the guard must refuse only the malformed combination, never an ordinary correction.
   */
  const base = new MockEdiAdapter();
  const sent: ClaimSubmissionRequest[] = [];
  const rejectsOnce: EdiAdapter = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      sent.push(req);
      return {
        ok: true,
        data: {
          status: sent.length === 1 ? "rejected" : "accepted",
          controlNumber: "PAYER-CTRL-4242",
          // Echoes back what was submitted, as a real 277CA does.
          patientControlNumber: req.patientControlNumber,
          statusCategory: sent.length === 1 ? "A3" : "A1",
          statusCode: sent.length === 1 ? "33" : "19",
          message: "ack",
          acknowledgedAt: NOW.toISOString(),
          lineErrors: [],
          unattributedLineErrors: [],
        },
        source: "mock",
      };
    },
  });

  const { service } = wired(rejectsOnce);
  const created = await service.createFromVerification(completedEvent(), NOW);
  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  await service.rescrub(created.claim.id, NOW);
  const refiled = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);

  assert.equal(refiled.claim.status, "submitted", "an ordinary correction still files");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.claimFrequency, "1", "the first filing is an original");
  assert.equal(sent[1]!.claimFrequency, "7", "the refiling is a replacement");
  assert.equal(
    sent[1]!.originalClaimControlNumber,
    "PAYER-CTRL-4242",
    "and it names the claim it replaces"
  );
});

/**
 * ── M10 — an acknowledgement about a different claim is not evidence about this one ────────────
 *
 * A 277CA echoes our own control number in TRN02. `parse277CA` has always read it, and nothing
 * compared it to what was sent. An acknowledgement is the ONLY evidence a claim reached a payer, so
 * one naming a different claim records THIS claim as filed on somebody else's receipt — and the real
 * claim is never chased, because the queue believes it is gone.
 */
test("M10: an acknowledgement naming a DIFFERENT claim is refused, and nothing is recorded", async () => {
  const base = new MockEdiAdapter();
  const wrongClaim: EdiAdapter = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(_req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      return {
        ok: true,
        data: {
          status: "accepted",
          controlNumber: "PAYER-1",
          patientControlNumber: "MRM-SOMEONEELSE",
          statusCategory: "A1",
          statusCode: "19",
          message: "Accepted.",
          acknowledgedAt: NOW.toISOString(),
          lineErrors: [],
          unattributedLineErrors: [],
        },
        source: "mock",
      };
    },
  });

  const { service, bus } = wired(wrongClaim);
  const created = await service.createFromVerification(completedEvent(), NOW);

  await assert.rejects(
    () => service.submit(created.claim.id, { submittedBy: "biller" }, NOW),
    (err: unknown) => {
      assert.ok(err instanceof ClaimSubmissionFailedError);
      assert.equal(err.code, "acknowledgement-mismatch");
      assert.equal(err.retryable, false, "a retry loop cannot fix a vendor naming the wrong claim");
      assert.match(err.message, /about a different claim/);
      return true;
    }
  );

  const after = await service.get(created.claim.id, NOW);
  assert.equal(after!.claim.status, "ready", "the claim must stay fileable, not be marked submitted");
  assert.equal(after!.claim.submission, null);
  assert.equal(bus.ofType("claim.submitted").length, 0, "nothing downstream may act on this");
});

test("M10: an acknowledgement that echoes the right claim files normally", async () => {
  // The control — the mock echoes what it was sent, which is what a real 277CA does.
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  const view = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  assert.equal(view.claim.status, "submitted");
});

test("M10: a clearinghouse that echoes NO control number is not treated as a mismatch", async () => {
  /**
   * Silence is legal — not every clearinghouse populates TRN02. Refusing it would block filing
   * everywhere that does not, which is the M7 failure shape: blocking real work on a fact nobody
   * asserted.
   */
  const base = new MockEdiAdapter();
  const silentAck: EdiAdapter = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(_req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      return {
        ok: true,
        data: {
          status: "accepted",
          controlNumber: "PAYER-1",
          patientControlNumber: null,
          statusCategory: "A1",
          statusCode: "19",
          message: "Accepted.",
          acknowledgedAt: NOW.toISOString(),
          lineErrors: [],
          unattributedLineErrors: [],
        },
        source: "mock",
      };
    },
  });

  const { service } = wired(silentAck);
  const created = await service.createFromVerification(completedEvent(), NOW);
  const view = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  assert.equal(view.claim.status, "submitted");
});

// ── Re-scrub, void, listing ───────────────────────────────────────────────────────────

test("rescrub re-evaluates a claim and promotes it once the data is fixed", async () => {
  const { service, repo } = wired();
  const broken = snapshot();
  delete broken.calculation.lines[2]!.toothNumber;
  const created = await service.createFromVerification(completedEvent({ coverageSnapshot: broken }), NOW);
  assert.equal(created.claim.status, "draft");

  // A biller corrects the tooth number on the claim itself.
  const stored = (await repo.getById(created.claim.id))!;
  stored.lines[2]!.toothNumber = "19";
  await repo.update(stored);

  const view = await service.rescrub(created.claim.id, NOW);
  assert.equal(view.claim.status, "ready");
  assert.equal(view.canSubmit, true);
});

test("a submitted claim is not re-scrubbed", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  await assert.rejects(() => service.rescrub(created.claim.id, NOW), /a submitted claim is not re-scrubbed/);
});

test("voiding requires a reason and is terminal", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);

  await assert.rejects(() => service.voidClaim(created.claim.id, "  ", "biller", NOW), /a reason is required/);

  const view = await service.voidClaim(created.claim.id, "Patient switched plans.", "biller", NOW);
  assert.equal(view.claim.status, "void");
  assert.equal(view.claim.voidReason, "Patient switched plans.");
  assert.equal(view.canSubmit, false);

  await assert.rejects(() => service.voidClaim(created.claim.id, "again", "biller", NOW), /cannot move from "void"/);
  await assert.rejects(() => service.submit(created.claim.id, { submittedBy: "biller" }, NOW), /void claim cannot be submitted/);
});

test("an unknown claim id raises ClaimNotFoundError", async () => {
  const { service } = wired();
  await assert.rejects(() => service.submit("nope", { submittedBy: "biller" }, NOW), ClaimNotFoundError);
  await assert.rejects(() => service.rescrub("nope", NOW), ClaimNotFoundError);
  await assert.rejects(() => service.voidClaim("nope", "reason", "biller", NOW), ClaimNotFoundError);
});

test("the queue is value-ranked: the claim closest to losing money comes first", async () => {
  const { service } = wired();
  await service.createFromVerification(completedEvent(), NOW); // clean, deadline a year out

  const urgent = snapshot({ verificationId: "ver-urgent", payerId: "uhc-dental", payerName: "UnitedHealthcare Dental" });
  urgent.verifiedAt = "2026-05-01T09:00:00.000Z"; // 90-day window → deadline 2026-07-30
  await service.createFromVerification(completedEvent({ verificationId: "ver-urgent", coverageSnapshot: urgent }), NOW);

  const items = await service.list(undefined, NOW);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.verificationId, "ver-urgent");
  assert.equal(items[0]!.filingRisk, "urgent");
  assert.ok(items[0]!.priority > items[1]!.priority);
});

test("the queue filters by status and by open-only", async () => {
  const { service } = wired();
  const a = await service.createFromVerification(completedEvent(), NOW);
  const broken = snapshot({ verificationId: "ver-draft" });
  delete broken.calculation.lines[2]!.toothNumber;
  await service.createFromVerification(completedEvent({ verificationId: "ver-draft", coverageSnapshot: broken }), NOW);
  await service.submit(a.claim.id, { submittedBy: "biller" }, NOW);

  assert.equal((await service.list({ status: "draft" }, NOW)).length, 1);
  assert.equal((await service.list({ status: "submitted" }, NOW)).length, 1);
  const open = await service.list({ openOnly: true }, NOW);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.status, "draft");
});

// ── Filing-risk sweep ─────────────────────────────────────────────────────────────────

test("the sweep escalates an at-risk claim exactly once per worsening level", async () => {
  const { service, bus } = wired();
  const urgent = snapshot({ verificationId: "ver-urgent", payerId: "uhc-dental", payerName: "UnitedHealthcare Dental" });
  urgent.verifiedAt = "2026-05-01T09:00:00.000Z"; // deadline 2026-07-30
  await service.createFromVerification(completedEvent({ verificationId: "ver-urgent", coverageSnapshot: urgent }), NOW);

  const first = await service.sweepFilingRisk(NOW);
  assert.equal(first.length, 1);
  assert.equal(bus.ofType("claim.filing_risk").length, 1);
  assert.equal(bus.ofType("claim.filing_risk")[0]!.payload.risk, "urgent");
  assert.equal(bus.ofType("claim.filing_risk")[0]!.payload.amountAtRisk, cents(800));

  const second = await service.sweepFilingRisk(NOW);
  assert.equal(second.length, 0, "an alert that repeats is an alert staff learn to ignore");
  assert.equal(bus.ofType("claim.filing_risk").length, 1);

  // Once it actually expires, that is new information and escalates again.
  const later = await service.sweepFilingRisk(new Date("2026-08-15T12:00:00Z"));
  assert.equal(later.length, 1);
  assert.equal(bus.ofType("claim.filing_risk").length, 2);
  assert.equal(bus.ofType("claim.filing_risk")[1]!.payload.risk, "expired");
});

test("the sweep ignores claims that are safe, submitted, or closed", async () => {
  const { service, bus } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW); // deadline a year out
  assert.deepEqual(await service.sweepFilingRisk(NOW), []);

  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  assert.deepEqual(await service.sweepFilingRisk(new Date("2027-07-20T12:00:00Z")), [], "a filed claim is not at risk");
  assert.equal(bus.ofType("claim.filing_risk").length, 0);
});

test("the service works with no event bus wired at all", async () => {
  const service = new ClaimService(new InMemoryClaimRepository(), new MockEdiAdapter(), BILLING_PROVIDER);
  const created = await service.createFromVerification(completedEvent(), NOW);
  const view = await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  assert.equal(view.claim.status, "submitted");
});

// ── Recording payment (driven by remittance.posted) ───────────────────────────────────

const payment = (overrides: Partial<RemittancePostedBody> = {}): RemittancePostedBody => ({
  remittanceId: "rem-1",
  postingId: "post-1",
  claimId: "",
  patientControlNumber: "MRM-000123",
  postedAt: "2026-08-10T09:00:00.000Z",
  traceNumber: "EFT100200300",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientName: "Ada Alpha",
  memberId: "ABC12345",
  paymentDate: "2026-08-10",
  chargedAmount: cents(1425),
  paidAmount: cents(800),
  patientResponsibility: cents(500),
  contractualAdjustments: cents(125),
  expectedInsurancePays: cents(800),
  variance: cents(0),
  outcome: "as_expected",
  settled: true,
  ...overrides,
});

async function submittedClaim() {
  const wiring = wired();
  const created = await wiring.service.createFromVerification(completedEvent(), NOW);
  await wiring.service.submit(created.claim.id, { submittedBy: "biller" }, NOW);
  return { ...wiring, claimId: created.claim.id };
}

test("a settled payment marks the claim paid and records what arrived", async () => {
  const { service, claimId } = await submittedClaim();

  const view = await service.recordPayment(payment({ claimId }), NOW);

  assert.equal(view!.claim.status, "paid");
  assert.equal(view!.paidAmount, cents(800));
  assert.equal(view!.outstanding, 0);
  assert.equal(view!.claim.payments.length, 1);
  assert.equal(view!.claim.payments[0]!.traceNumber, "EFT100200300");
  // This payer's advice assigned money to the patient, so the sentence must say the PAYER is done
  // rather than the claim — see `recommendAction`. "Settled in full" unqualified sent a billing team
  // away from the one case where a statement still had to go out.
  assert.match(view!.recommendedAction, /payer is done/);
  assert.match(view!.recommendedAction, /\$500\.00 was assigned to the patient/);
  assert.ok(view!.claim.audit.some((a) => a.message.includes("Delta Dental paid $800.00")));
});

/**
 * ── "NO ACTION NEEDED" MUST MEAN NOBODY OWES ANYTHING ──────────────────────────────────────────
 *
 * `settled` is a statement about the PAYER — "nothing further is expected from this payer on this
 * claim". A payer can be entirely done while the patient owes most of the charge: an exhausted
 * annual maximum comes back as PR-119 and lands the balance on the patient, and the claim is marked
 * `paid` because the payer's side of it genuinely is.
 *
 * Rendering that as "No action needed" retires the claim from the worklist while a statement still
 * has to go out — the balance is never billed and the practice simply does not collect it. These
 * two cases pin the distinction from both sides, so a future edit cannot collapse them back into
 * one sentence without a test saying so.
 */
test("a payer who is done does not mean the claim is done — patient responsibility is named", async () => {
  const { service, claimId } = await submittedClaim();

  // The payer settled its share; its own advice assigned the rest to the patient.
  const view = await service.recordPayment(
    payment({ claimId, paidAmount: cents(47.99), patientResponsibility: cents(1234.51), settled: true }),
    NOW
  );

  assert.equal(view!.claim.status, "paid", "the payer is finished, so the claim is paid");
  assert.equal(view!.outstanding, 0, "and nothing further is outstanding FROM THE PAYER");
  assert.doesNotMatch(
    view!.recommendedAction,
    /No action needed/,
    "a claim leaving $1,234.51 with the patient is not 'no action needed' — that is a statement to send"
  );
  assert.match(view!.recommendedAction, /\$1,234\.51 was assigned to the patient/);
});

/**
 * ── TWO PAYERS RESTATE ONE BALANCE; THEY DO NOT EACH ADD ONE ───────────────────────────────────
 *
 * Every payer's advice names the WHOLE remaining patient responsibility, not its own slice of one.
 * Summing them therefore counts the same money once per payer: a primary leaving $1,234.51 and a
 * secondary then leaving $514.51 reported $1,749.02 owed on a $1,425.00 charge — more than the
 * treatment cost, from two payers who each described the same balance shrinking.
 *
 * The sentence must quote the latest word. Nothing about the ledger changes: it already computes a
 * per-claim delta, so the secondary's payment REDUCES the balance rather than adding to it.
 */
test("a second payer's advice restates the patient's share — the claim quotes the latest, not the sum", async () => {
  const { service, claimId } = await submittedClaim();

  await service.recordPayment(
    payment({ claimId, postingId: "post-primary", paidAmount: cents(47.99), patientResponsibility: cents(1234.51), settled: false }),
    NOW
  );
  const after = await service.recordPayment(
    payment({ claimId, postingId: "post-secondary", paidAmount: cents(720), patientResponsibility: cents(514.51), settled: true }),
    NOW
  );

  assert.equal(after!.claim.payments.length, 2, "both payers posted against ONE claim");
  assert.equal(after!.paidAmount, cents(767.99), "payments DO accumulate — 47.99 + 720.00");
  assert.match(
    after!.recommendedAction,
    /\$514\.51 was assigned to the patient/,
    "the current balance, not 1234.51 + 514.51 = 1749.02 on a 1425.00 charge"
  );
  assert.doesNotMatch(after!.recommendedAction, /\$1,749\.02/);
});

test("a claim the payer paid in full, owing the patient nothing, still reads as closed", async () => {
  const { service, claimId } = await submittedClaim();

  const view = await service.recordPayment(
    payment({ claimId, paidAmount: cents(1300), patientResponsibility: cents(0), settled: true }),
    NOW
  );

  assert.equal(view!.claim.status, "paid");
  // The original wording survives for the case it was always right about: nobody owes anything.
  assert.match(view!.recommendedAction, /No action needed/);
  assert.match(view!.recommendedAction, /settled this claim in full/);
});

test("a payment with money still owed leaves the claim partially paid", async () => {
  const { service, claimId } = await submittedClaim();

  const view = await service.recordPayment(
    payment({ claimId, paidAmount: cents(500), variance: cents(-300), outcome: "underpaid", settled: false }),
    NOW
  );

  assert.equal(view!.claim.status, "partially_paid");
  assert.equal(view!.paidAmount, cents(500));
  assert.equal(view!.outstanding, cents(300));
  assert.match(view!.recommendedAction, /\$300\.00 is still outstanding/);
  assert.ok(view!.priority > 50, "money earned and not received outranks unfiled work");
});

test("a zero payment marks the claim denied, which is not the same as rejected", async () => {
  const { service, claimId } = await submittedClaim();

  const view = await service.recordPayment(
    payment({ claimId, paidAmount: cents(0), patientResponsibility: cents(0), variance: cents(-800), outcome: "denied", settled: false }),
    NOW
  );

  assert.equal(view!.claim.status, "denied");
  assert.equal(view!.paidAmount, 0);
  assert.match(view!.recommendedAction, /adjudicated this claim and paid nothing/);
  assert.equal(view!.canSubmit, false);
  assert.match(view!.submitBlockedReason!, /already adjudicated/);
});

test("recording the same posting twice does not double-count revenue", async () => {
  const { service, claimId } = await submittedClaim();

  await service.recordPayment(payment({ claimId }), NOW);
  const again = await service.recordPayment(payment({ claimId }), NOW);

  assert.equal(again!.claim.payments.length, 1, "the outbox delivers at least once");
  assert.equal(again!.paidAmount, cents(800));
});

test("a second, different payment accumulates and can complete the claim", async () => {
  const { service, claimId } = await submittedClaim();

  await service.recordPayment(
    payment({ claimId, paidAmount: cents(500), variance: cents(-300), outcome: "underpaid", settled: false }),
    NOW
  );
  const view = await service.recordPayment(
    payment({ claimId, postingId: "post-2", remittanceId: "rem-2", paidAmount: cents(300), settled: true }),
    NOW
  );

  assert.equal(view!.claim.status, "paid");
  assert.equal(view!.claim.payments.length, 2);
  assert.equal(view!.paidAmount, cents(800));
  assert.equal(view!.outstanding, 0);
});

/**
 * ── THE SECOND PARTIAL PAYMENT MUST LAND (self-transition guard) ───────────────────────────────
 * The transition table has no self-loops, and `recordPayment` used to assert the transition
 * unconditionally — so the second partial payment threw `partially_paid → partially_paid`, the
 * `remittance.posted` handler failed, the event dead-lettered after its retries, and the payment
 * never appeared on the claim. Real money, recorded by Remittance, invisible here. A secondary
 * payer's share and a corrected-but-still-short advice both arrive exactly this way.
 */
test("a second partial payment accumulates instead of throwing on a self-transition", async () => {
  const { service, claimId } = await submittedClaim();

  await service.recordPayment(
    payment({ claimId, paidAmount: cents(500), variance: cents(-300), outcome: "underpaid", settled: false }),
    NOW
  );
  const view = await service.recordPayment(
    payment({
      claimId,
      postingId: "post-2",
      remittanceId: "rem-2",
      paidAmount: cents(100),
      variance: cents(-200),
      outcome: "underpaid",
      settled: false,
    }),
    NOW
  );

  assert.equal(view!.claim.status, "partially_paid");
  assert.equal(view!.claim.payments.length, 2, "the second payment is recorded, not dead-lettered");
  assert.equal(view!.paidAmount, cents(600));
  assert.equal(view!.outstanding, cents(200));
});

test("a payer denying the claim a second time is recorded, not thrown away", async () => {
  const { service, claimId } = await submittedClaim();

  await service.recordPayment(
    payment({ claimId, paidAmount: cents(0), patientResponsibility: cents(0), variance: cents(-800), outcome: "denied", settled: false }),
    NOW
  );
  const view = await service.recordPayment(
    payment({
      claimId,
      postingId: "post-2",
      remittanceId: "rem-2",
      paidAmount: cents(0),
      patientResponsibility: cents(0),
      variance: cents(-800),
      outcome: "denied",
      settled: false,
    }),
    NOW
  );

  assert.equal(view!.claim.status, "denied");
  assert.equal(view!.claim.payments.length, 2, "the repeat adjudication is part of the record");
});

test("a payment for a claim this module does not know returns null rather than throwing", async () => {
  const { service } = wired();
  assert.equal(await service.recordPayment(payment({ claimId: "not-ours" }), NOW), null);
});

test("a payment arriving for a voided claim is audited, not silently applied", async () => {
  const { service } = await submittedClaim();
  const created = await service.createFromVerification(
    completedEvent({ verificationId: "ver-void", coverageSnapshot: snapshot({ verificationId: "ver-void" }) }),
    NOW
  );
  await service.voidClaim(created.claim.id, "Filed in error.", "biller", NOW);

  const view = await service.recordPayment(payment({ claimId: created.claim.id }), NOW);

  assert.equal(view!.claim.status, "void", "a terminal status is not overwritten");
  assert.equal(view!.claim.payments.length, 0);
  assert.ok(view!.claim.audit.some((a) => /arrived for a void claim — reconcile by hand/.test(a.message)));
});

test("an adjudicated claim is not re-scrubbed back into draft", async () => {
  const { service, claimId } = await submittedClaim();
  await service.recordPayment(
    payment({ claimId, paidAmount: cents(500), variance: cents(-300), outcome: "underpaid", settled: false }),
    NOW
  );

  await assert.rejects(() => service.rescrub(claimId, NOW), /a partially_paid claim is not re-scrubbed/);
});

test("the repository isolates stored claims from later caller mutation", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  created.claim.totalFee = cents(1);
  created.claim.patient.firstName = "TAMPERED";

  const fetched = await service.get(created.claim.id, NOW);
  assert.equal(fetched!.claim.totalFee, cents(1425));
  assert.equal(fetched!.claim.patient.firstName, "Ada");
});

// ── V5: correcting a subscriber address on an unfiled claim ────────────────────────────

/**
 * The workflow this closes, end to end.
 *
 * A claim missing loop 2010BA N3/N4 is held by the scrubber. Before V5 the only remedy was to
 * verify the patient again — a wasted eligibility call, a second verification record, a second
 * claim, and the original left stranded in `draft` forever.
 *
 * These tests drive the whole path: a claim that is genuinely blocked, corrected by name, and
 * released. Asserting only that a field changed would miss the point — the point is that the claim
 * becomes submittable.
 */
async function blockedOnAddress() {
  const { service, repo } = wired();
  // A verification that never collected an address, which is the ordinary way this happens.
  const event = completedEvent();
  // Drop the address without loosening the type — the point is a REAL completed event that simply
  // never carried one, which is the ordinary way a claim ends up blocked.
  const patient = { ...event.patient };
  delete (patient as { address?: unknown }).address;
  const view = await service.createFromVerification({ ...event, patient }, NOW);
  return { service, repo, view };
}

test("a claim with no subscriber address is blocked, and correcting it releases the gate", async () => {
  const { service, view } = await blockedOnAddress();

  assert.equal(view.claim.status, "draft", "no address means the scrubber holds it");
  assert.ok(
    view.claim.scrub?.findings.some((f) => f.code === "subscriber-address-missing"),
    "the blocking reason must be the address"
  );
  assert.equal(view.canSubmit, false);

  const corrected = await service.correctSubscriberAddress(view.claim.id, SYNTHETIC_ADDRESS, "ada.biller", NOW);

  assert.deepEqual(corrected.claim.patient.address, SYNTHETIC_ADDRESS, "the address is on the claim");
  assert.equal(corrected.claim.status, "ready", "correcting must re-scrub and release the gate");
  assert.equal(corrected.canSubmit, true, "the whole point — the claim is now filable");
  assert.equal(
    corrected.claim.scrub?.findings.some((f) => f.code === "subscriber-address-missing"),
    false,
    "the blocking finding is gone"
  );
});

test("the correction is attributed by name in the claim's own audit trail", async () => {
  const { service, view } = await blockedOnAddress();
  const corrected = await service.correctSubscriberAddress(view.claim.id, SYNTHETIC_ADDRESS, "ada.biller", NOW);

  const entry = corrected.claim.audit.find((a) => a.message.includes("subscriber address"));
  assert.ok(entry, "editing what goes to a payer must be recorded");
  assert.match(entry!.message, /ada\.biller/, "the actor is named");
  assert.match(entry!.message, /1 SYNTHETIC TEST WAY/, "and so is what it was changed to");
  assert.equal(entry!.actor, "staff", "a human act, not a system one");
});

test("a correction normalises what staff actually type", async () => {
  // Lowercase state, hyphenated ZIP, stray whitespace — accepted and stored in the 837's shape, so
  // the scrubber's format rules do not fire a moment after someone saves.
  const { service, view } = await blockedOnAddress();
  const corrected = await service.correctSubscriberAddress(
    view.claim.id,
    { street: "  1 SYNTHETIC TEST WAY ", city: "Springfield", state: "ca", zip: "90001-0000" },
    "ada.biller",
    NOW
  );

  assert.deepEqual(corrected.claim.patient.address, {
    street: "1 SYNTHETIC TEST WAY",
    city: "Springfield",
    state: "CA",
    zip: "900010000",
  });
  assert.equal(corrected.claim.status, "ready");
});

test("a partial address is REFUSED, not half-saved", async () => {
  // Half an address satisfies the scrubber's presence check and is then rejected by the payer after
  // filing. Refusing here converts that into an error at the desk.
  const { service, view } = await blockedOnAddress();

  await assert.rejects(
    () => service.correctSubscriberAddress(view.claim.id, { street: "1 SYNTHETIC TEST WAY", city: "", state: "CA", zip: "900010000" }, "ada.biller", NOW),
    /street, city, state and ZIP are all required/
  );

  // And the claim is untouched — still blocked, not left in some half-corrected state.
  const after = await service.get(view.claim.id, NOW);
  assert.equal(after!.claim.patient.address, undefined);
  assert.equal(after!.claim.status, "draft");
});

test("an unnamed actor is refused — the audit trail must not be anonymous", async () => {
  const { service, view } = await blockedOnAddress();
  await assert.rejects(
    () => service.correctSubscriberAddress(view.claim.id, SYNTHETIC_ADDRESS, "   ", NOW),
    /a user is required/
  );
});

test("a claim the payer already holds cannot be quietly edited", async () => {
  /**
   * The immutability boundary. Once a claim has been filed, editing the address would make
   * Mermaid's record disagree with the 837 that was actually sent — and the filed copy is kept for
   * provenance precisely so it cannot. The correct act after submission is a corrected claim
   * (CLM05-3 frequency 7), which exists and is a separate, deliberate decision.
   */
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  const submitted = await service.submit(created.claim.id, { submittedBy: "ada.biller" }, NOW);
  assert.notEqual(submitted.claim.status, "draft", "precondition: the claim has been filed");

  await assert.rejects(
    () => service.correctSubscriberAddress(created.claim.id, SYNTHETIC_ADDRESS, "ada.biller", NOW),
    /cannot be edited|file a corrected claim/
  );
});

test("correcting an address changes no money", async () => {
  /**
   * The rule that makes this safe. Snapshot immutability is about MONEY — fees, expected insurance,
   * patient responsibility and the benefits they were derived from are inherited verbatim and never
   * recomputed. An address is a demographic fact, and correcting it must not disturb any of that.
   */
  const { service, view } = await blockedOnAddress();
  const before = view.claim;
  const after = (await service.correctSubscriberAddress(view.claim.id, SYNTHETIC_ADDRESS, "ada.biller", NOW)).claim;

  assert.equal(after.totalFee, before.totalFee);
  assert.equal(after.expectedInsurancePays, before.expectedInsurancePays);
  assert.equal(after.expectedPatientPays, before.expectedPatientPays);
  assert.deepEqual(after.lines, before.lines, "not one service line moved");
  assert.deepEqual(after.coverageSnapshot, before.coverageSnapshot, "the snapshot is untouched");
});

// ── D1 (claims side) — the estimate caveat reaches every biller-facing surface ─────────────
//
// See the block in `deadline.test.ts` for why. These drive the same guarantee through the service,
// so a future refactor cannot satisfy the engine test while leaving a screen asserting a bare date.
//
// The fixture claim is Delta Dental, verified 2026-07-27, so its filing deadline is 2027-07-27 on
// the catalogued 365-day window — the "known payer" case, which is exactly where the temptation to
// present the date as the payer's own term is strongest.

const URGENT_DAY = new Date("2027-07-20T12:00:00Z"); // 7 days out
const AFTER_DEADLINE = new Date("2027-08-05T12:00:00Z"); // 9 days past

test("D1: a catalogued payer's deadline is still labelled an estimate on the claim view", async () => {
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);

  const view = (await service.get(created.claim.id, URGENT_DAY))!;

  assert.equal(view.claim.filingDeadline, "2027-07-27", "Delta Dental's catalogued 365-day window");
  assert.equal(view.filing.risk, "urgent");
  assert.equal(view.filing.estimated, true, "catalogued is not the same as payer-sourced");
  assert.match(view.filing.estimateNote!, /estimate, not this payer's stated terms/);
  assert.match(view.filing.message, /estimate, not this payer's stated terms/);
  assert.match(view.recommendedAction, /estimate, not this payer's stated terms/);
});

test("D1: an expired deadline no longer recommends writing the claim off", async () => {
  /**
   * The recommended action is the sentence a biller acts on. It read "The filing deadline has
   * passed. Write this off, or appeal with proof of timely filing." — the same instruction M7
   * refused to let the scrub gate give, on the same unverified window, surviving one file over.
   */
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);

  const view = (await service.get(created.claim.id, AFTER_DEADLINE))!;

  assert.equal(view.filing.risk, "expired");
  assert.doesNotMatch(view.recommendedAction, /Write this off/);
  assert.doesNotMatch(view.filing.message, /will refuse the claim/);
  assert.match(view.recommendedAction, /Confirm the real filing window with the payer/);
});

test("D1: the queue row carries the caveat, so it is visible before anyone opens the claim", async () => {
  const { service } = wired();
  await service.createFromVerification(completedEvent(), NOW);

  const [row] = await service.list({}, URGENT_DAY);

  assert.equal(row!.filingDeadline, "2027-07-27");
  assert.equal(row!.filingRisk, "urgent");
  assert.equal(row!.filingDeadlineEstimated, true);
  assert.match(row!.filingDeadlineNote!, /estimate, not this payer's stated terms/);
});

test("D1: the submission timeline records the deadline as an estimate, permanently", async () => {
  /**
   * The timeline is the record read months later, when nobody remembers where the date came from.
   * A bare "Filing deadline 2027-07-27." in a permanent record is read as the payer's own term.
   */
  const { repo, claimId } = await submittedClaim();
  const claim = (await repo.getById(claimId))!;

  const submission = buildClaimTimeline(claim).find((e) => e.phase === "submission")!;

  assert.match(submission.detail, /Filing deadline 2027-07-27/);
  assert.match(submission.detail, /Mermaid's estimate/);
  assert.match(submission.detail, /estimate, not this payer's stated terms/);
});

test("D1: the scrub finding and the countdown quote the same sentence", async () => {
  /**
   * They were two hand-typed copies of one claim about the world, and only one of them existed.
   * Now both read from `FILING_WINDOW_ESTIMATE_NOTE`, so neither can drift or be silently dropped.
   */
  const { service } = wired();
  const created = await service.createFromVerification(completedEvent(), NOW);
  const view = (await service.get(created.claim.id, AFTER_DEADLINE))!;

  const finding = view.claim.scrub!.findings.find((f) => f.code === "past-filing-deadline");
  // The scrub ran at creation, when the deadline was a year out, so the finding is absent here —
  // which is precisely why the countdown had to carry the sentence on its own.
  assert.equal(finding, undefined, "no expired finding on a claim scrubbed while still in time");
  assert.match(view.filing.message, /estimate, not this payer's stated terms/);
});

// ── D3 site 3 — an unknown eligibility must not block a claim a human already approved ─────────
//
// The scrub tests prove the finding's code and severity. This proves the consequence that actually
// matters: the claim reaches `ready`, the submit gate opens, and a named human can file it — which
// is the whole point of downgrading a silence from a refusal.

test("D3: a claim from an unknown-eligibility verification is ready and submittable", async () => {
  const { service } = wired();
  const snap = snapshot();
  snap.benefits.eligibility = "unknown";
  for (const line of snap.calculation.lines) {
    line.denied = true;
    line.denialReason = "eligibility-unknown";
  }

  const view = await service.createFromVerification(completedEvent({ coverageSnapshot: snap }), NOW);

  const finding = view.claim.scrub!.findings.find((f) => f.code === "eligibility-unknown")!;
  assert.ok(finding, "the payer's silence is still reported");
  assert.equal(finding.severity, "warning");
  assert.equal(view.claim.status, "ready");
  assert.equal(view.canSubmit, true, "an unknown must not hold a reviewed claim at the gate");
  assert.equal(view.submitBlockedReason, null);
  assert.ok(
    view.advisories.some((f) => f.code === "eligibility-unknown"),
    "and it is surfaced to the biller as an advisory, not silently dropped"
  );
  assert.ok(!view.blockers.some((f) => f.code === "eligibility-unknown"));

  // The human gate is untouched: it still takes a named person to file.
  const submitted = await service.submit(view.claim.id, { submittedBy: "biller" }, NOW);
  assert.equal(submitted.claim.status, "submitted");
});

test("D3: a claim from a confirmed INACTIVE verification is still blocked at the gate", async () => {
  const { service } = wired();
  const snap = snapshot();
  snap.benefits.eligibility = "inactive";

  const view = await service.createFromVerification(completedEvent({ coverageSnapshot: snap }), NOW);

  assert.ok(view.blockers.some((f) => f.code === "inactive-coverage"));
  assert.equal(view.canSubmit, false);
  await assert.rejects(() => service.submit(view.claim.id, { submittedBy: "biller" }, NOW), ClaimNotSubmittableError);
});

/**
 * ── NEW-01 — A DEPENDENT'S CLAIM IS FILED UNDER THE SUBSCRIBER'S POLICY, NOT AS THEM ─────────────
 *
 * `claim.patient` used to be poured straight into the submission's `subscriber`, on the assumption
 * that the two are the same person. A dental plan issues one member id to the SUBSCRIBER and covers
 * the spouse and children under it, so for a family that assumption files the child as the policy
 * holder — adjudicated against the wrong person's benefits, or rejected, with nothing naming why.
 *
 * This asserts the split at the seam where it is decided: who lands in loop 2010BA and who lands in
 * the 2000C patient loop. `x12-837-dependent.test.ts` asserts what the codec then puts on the wire.
 */
test("NEW-01: a dependent's claim carries the SUBSCRIBER in 2010BA and the patient in 2000C", async () => {
  const sent: ClaimSubmissionRequest[] = [];
  const capture: EdiAdapter = capturing(sent);

  const { service } = wired(capture);
  const event = completedEvent();
  const created = await service.createFromVerification(
    {
      ...event,
      patient: {
        ...event.patient,
        firstName: "Kit",
        lastName: "Alpha",
        dateOfBirth: "2016-09-03",
        relationship: "child",
        subscriber: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" },
      },
    },
    NOW
  );
  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);

  const req = sent[0]!;
  assert.equal(req.subscriber.firstName, "Ada", "2010BA names the person who HOLDS the policy");
  assert.equal(req.subscriber.lastName, "Alpha");
  assert.equal(req.subscriber.dateOfBirth, "1990-04-12", "and their own date of birth, not the child's");
  assert.equal(req.subscriber.memberId, event.patient.memberId, "the member id is the policy's");

  assert.ok(req.patient, "the patient must appear as a separate loop, not be conflated with 2010BA");
  assert.equal(req.patient!.firstName, "Kit");
  assert.equal(req.patient!.dateOfBirth, "2016-09-03");
  assert.equal(req.patient!.relationship, "child");
});

test("NEW-01: an ordinary self claim still sends ONE person, in 2010BA", async () => {
  /**
   * The regression that matters most — nearly every dental claim is a self claim, and a change that
   * added a patient loop to those would be found by payers, at scale, on claims that were filing.
   */
  const sent: ClaimSubmissionRequest[] = [];
  const { service } = wired(capturing(sent));
  const created = await service.createFromVerification(completedEvent(), NOW);
  await service.submit(created.claim.id, { submittedBy: "biller" }, NOW);

  assert.equal(sent[0]!.patient, undefined, "no 2000C loop for a patient who is the subscriber");
  assert.equal(sent[0]!.subscriber.firstName, completedEvent().patient.firstName);
});

/** An adapter that records what it was asked to file and accepts it. */
function capturing(sink: ClaimSubmissionRequest[]): EdiAdapter {
  const base = new MockEdiAdapter();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async submitClaim(req: ClaimSubmissionRequest): Promise<EdiResult<ClaimAcknowledgement>> {
      sink.push(req);
      return {
        ok: true,
        data: {
          status: "accepted",
          controlNumber: "PAYER-CTRL-0001",
          patientControlNumber: req.patientControlNumber,
          statusCategory: "A1",
          statusCode: "19",
          message: "ack",
          acknowledgedAt: NOW.toISOString(),
          lineErrors: [],
          unattributedLineErrors: [],
        },
        source: "mock",
      };
    },
  });
}

// ── Appeal recoveries (F-7) ───────────────────────────────────────────────────────────

/**
 * Claims subscribes to a DENIALS event so it can tell "the payer overpaid you" apart from "you won
 * an appeal". These tests cover the seam, and specifically the two ways an event-fed annotation
 * goes wrong: accumulating on redelivery, and quietly moving money.
 */
const recovery = (claimId: string, over: Partial<DenialRecoverySettledBody> = {}): DenialRecoverySettledBody => ({
  denialId: "den-1",
  claimId,
  postingId: "post-1",
  resolvedAmount: cents(1125),
  awardedAmount: cents(1125),
  settledAmount: cents(1125),
  status: "recovered",
  settledAt: "2026-08-30T00:00:00.000Z",
  ...over,
});

async function claimWithPayment(paid = 21.49) {
  const wiring = await submittedClaim();
  await wiring.service.recordPayment(
    payment({ claimId: wiring.claimId, paidAmount: cents(paid), settled: false, outcome: "underpaid" }),
    NOW
  );
  return wiring;
}

test("a settled award is recorded against the claim without touching a single amount", async () => {
  const { service, claimId } = await claimWithPayment();
  const before = (await service.get(claimId))!.claim;

  const view = await service.recordAppealRecovery(recovery(claimId), NOW);

  assert.equal(view?.claim.appealRecoveries?.length, 1);
  assert.equal(view?.claim.appealRecoveries?.[0]!.settledAmount, cents(1125));
  assert.deepEqual(view?.claim.payments, before.payments, "an annotation, not a payment");
  assert.equal(view?.claim.status, before.status, "and not a status change either");
  assert.equal(view?.claim.totalFee, before.totalFee);
});

test("a redelivered settlement converges instead of accumulating", async () => {
  const { service, claimId } = await claimWithPayment();
  await service.recordAppealRecovery(recovery(claimId), NOW);
  await service.recordAppealRecovery(recovery(claimId), NOW);
  const view = await service.recordAppealRecovery(recovery(claimId), NOW);

  assert.equal(view?.claim.appealRecoveries?.length, 1, "one denial, one entry");
  assert.equal(view?.claim.appealRecoveries?.[0]!.settledAmount, cents(1125), "not $3,375.00");
});

test("a redelivery that changes nothing writes no audit line", async () => {
  const { service, claimId } = await claimWithPayment();
  const first = await service.recordAppealRecovery(recovery(claimId), NOW);
  const again = await service.recordAppealRecovery(recovery(claimId), NOW);
  assert.equal(again?.claim.audit.length, first?.claim.audit.length, "an at-least-once bus must not grow the trail");
});

test("a revised settlement assigns the new total, including back down to zero", async () => {
  const { service, claimId } = await claimWithPayment();
  await service.recordAppealRecovery(recovery(claimId), NOW);
  const raised = await service.recordAppealRecovery(recovery(claimId, { settledAmount: cents(1200) }), NOW);
  assert.equal(raised?.claim.appealRecoveries?.[0]!.settledAmount, cents(1200));

  /** A payer takeback reverses an award. The event is an assignment, so zero is expressible. */
  const reversed = await service.recordAppealRecovery(recovery(claimId, { settledAmount: cents(0) }), NOW);
  assert.equal(reversed?.claim.appealRecoveries?.[0]!.settledAmount, cents(0));
  assert.equal(reversed?.claim.appealRecoveries?.length, 1, "reversal is an update, never a new row");
});

test("two denials on one claim each keep their own recovery", async () => {
  const { service, claimId } = await claimWithPayment();
  await service.recordAppealRecovery(recovery(claimId, { denialId: "den-1", settledAmount: cents(400) }), NOW);
  const view = await service.recordAppealRecovery(recovery(claimId, { denialId: "den-2", settledAmount: cents(300) }), NOW);

  assert.equal(view?.claim.appealRecoveries?.length, 2);
  assert.equal(view?.variance?.appealRecovered, cents(700));
});

test("a settlement for a claim this practice does not have is ignored, not thrown", async () => {
  const { service } = wired();
  assert.equal(await service.recordAppealRecovery(recovery("no-such-claim"), NOW), null, "the outbox must not dead-letter");
});

test("the recovery reaches the claim view, so the screen can stop calling it a duplicate", async () => {
  const { service, claimId } = await claimWithPayment();
  await service.recordPayment(
    payment({ claimId, postingId: "post-2", remittanceId: "rem-2", paidAmount: cents(1125), settled: true }),
    NOW
  );
  const view = await service.recordAppealRecovery(recovery(claimId), NOW);

  const v = view!.variance!;
  assert.equal(v.paid, cents(1146.49), "$21.49 + $1,125.00");
  assert.equal(v.variance, cents(346.49), "gross, against the $800.00 estimate");
  assert.equal(v.appealRecovered, cents(1125));
  assert.equal(v.unexplained, cents(-778.51), "the primary adjudication came in far under estimate");
  assert.doesNotMatch(v.summary, /duplicate/);
});
