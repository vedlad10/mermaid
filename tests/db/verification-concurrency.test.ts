/**
 * Two people reviewing ONE flagged verification at once, against a real database.
 *
 * Recording a review is read-modify-write: read the record, stamp the decision, save, announce.
 * Unlocked, both reviewers read the pre-review record and the second write erases the first
 * person's decision and their notes — on the screen a practice quotes when a patient disputes what
 * they were told they would owe. `VerificationRepository.lockById` is what serializes them.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { MockEdiAdapter } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import {
  PgVerificationRepository,
  VerificationService,
  type VerificationInput,
  type VerificationRecord,
} from "@mermaid/verification";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

/** A repository whose LOCKING read dawdles, so two reviewers provably overlap. */
class SlowLockVerifications extends PgVerificationRepository {
  override async lockById(id: string): Promise<VerificationRecord | null> {
    const record = await super.lockById(id);
    await new Promise((resolve) => setTimeout(resolve, 900));
    return record;
  }
}

/** The `...00` member is inactive in the mock, so this record lands in `needs_review`. */
const FLAGGED: VerificationInput = {
  patient: {
    firstName: "Ben",
    lastName: "Booker",
    dateOfBirth: "1978-11-03",
    memberId: "MEM10000",
    address: { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" },
  },
  cardText: "Delta Dental\nMember ID: MEM10000",
  planItems: [{ code: "D2750", quantity: 1, fee: cents(1250) }],
};

test("two concurrent reviews cannot erase each other's decision", dbTest, async () => {
  const p = await makePractice("verify-race");
  created.push(p);

  const service = new VerificationService(
    new SlowLockVerifications(),
    new MockEdiAdapter(),
    new NullEventPublisher()
  );

  const flagged = await withPractice(p, () => service.create(FLAGGED, NOW));
  assert.equal(flagged.record.status, "needs_review", "the fixture must actually need a person");
  const id = flagged.record.id;

  // Two warm connections, so the second reviewer is not just waiting on a TLS handshake.
  await Promise.all([
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
  ]);

  await Promise.allSettled([
    withPractice(p, () =>
      service.review(id, { decision: "approved", notes: "Confirmed active by phone." }, NOW)
    ),
    withPractice(p, () =>
      service.review(id, { decision: "rejected", notes: "Wrong patient — this is a different Ben Booker." }, NOW)
    ),
  ]);

  const settled = (await withPractice(p, () => service.get(id, NOW)))!.record;

  // Whichever reviewer won, the record must be internally CONSISTENT: the decision, the status and
  // the notes all belong to the same person. Unlocked, the two writes interleave from a shared
  // pre-review snapshot and the surviving record can carry one reviewer's status beside the
  // other's reasoning.
  assert.ok(settled.review, "a decision was recorded");
  const expectedStatus = settled.review!.decision === "rejected" ? "failed" : "reviewed";
  assert.equal(settled.status, expectedStatus, "the status must match the decision that survived");

  const notes = settled.review!.notes;
  const consistent =
    (settled.review!.decision === "approved" && notes.includes("Confirmed active")) ||
    (settled.review!.decision === "rejected" && notes.includes("Wrong patient"));
  assert.ok(consistent, `the decision and its notes must come from one reviewer, got: ${notes}`);

  /**
   * And NEITHER reviewer's line is missing from the audit trail.
   *
   * This is the property the lock actually buys. Re-reviewing a settled record is legitimate — a
   * supervisor may overrule — so two lines is the correct outcome of two people deciding. What must
   * never happen is a line VANISHING: unlocked, the second reviewer builds its record from a
   * snapshot taken before the first review existed, so `audit: [...record.audit, line]` writes back
   * a history with the first person's entry deleted. Somebody's documented decision disappears from
   * the record a practice quotes in a dispute, and nothing anywhere says it happened.
   */
  const reviewLines = settled.audit.filter((a) => a.message.startsWith("Reviewed:"));
  assert.equal(reviewLines.length, 2, `both reviewers' entries must survive — got ${reviewLines.length}`);
  assert.ok(
    reviewLines.some((a) => a.message.includes("Confirmed active")),
    "the approver's reasoning is still on the record"
  );
  assert.ok(
    reviewLines.some((a) => a.message.includes("Wrong patient")),
    "and so is the rejecter's"
  );
});
