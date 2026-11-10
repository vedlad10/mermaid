/**
 * Coverage-snapshot + outbound-event tests.
 *
 * This is the boundary the whole platform hangs off: everything billing ever knows about a
 * verification arrives through these payloads. So the assertions are about the *contract* — what is
 * carried, what is deliberately withheld, and that the snapshot is a frozen copy rather than a live
 * reference to the record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { InMemoryOutbox } from "@mermaid/events";
import { createLogger, createMetrics } from "@mermaid/observability";
import { COVERAGE_SNAPSHOT_VERSION, cents } from "@mermaid/shared";
import {
  InMemoryVerificationRepository,
  VerificationService,
  buildCoverageSnapshot,
  buildCompletedEvent,
  buildNeedsReviewEvent,
} from "../index.ts";
import type { VerificationInput } from "../index.ts";

const NOW = new Date("2026-07-15T12:00:00Z");
const silent = createLogger(() => {});

const PROCEDURES = [
  { code: "D0120", quantity: 1 },
  { code: "D1110", quantity: 1, fee: cents(110) },
  { code: "D2750", quantity: 1, fee: cents(1250) },
];

function input(memberId: string, cardText: string): VerificationInput {
  return {
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId },
    cardText,
    planItems: PROCEDURES,
  };
}

const CLEAN = () => input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100");
const INACTIVE = () => input("MEM10000", "Delta Dental\nMember ID: MEM10000");

function wired() {
  const bus = new InMemoryOutbox({ logger: silent, metrics: createMetrics() });
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter(), bus);
  return { bus, repo, svc };
}

test("a clean verification publishes verification.completed carrying the coverage snapshot", async () => {
  const { bus, svc } = wired();
  const view = await svc.create(CLEAN(), NOW);

  const events = bus.ofType("verification.completed");
  assert.equal(events.length, 1);
  const payload = events[0]!.payload;
  assert.equal(payload.verificationId, view.record.id);
  assert.equal(payload.settledAs, "verified");
  assert.equal(payload.coverageSnapshot.snapshot_version, COVERAGE_SNAPSHOT_VERSION);
  assert.equal(payload.coverageSnapshot.payerId, "delta-dental");
  assert.equal(payload.coverageSnapshot.memberId, "ABC12345");
  assert.equal(payload.patientResponsibility, view.record.calculation!.totalPatientPays);
  assert.equal(payload.totalFee, view.record.calculation!.totalFee);
  assert.equal(events[0]!.aggregateId, view.record.id);
});

test("a needs_review verification publishes needs_review and NO completed event", async () => {
  const { bus, svc } = wired();
  const view = await svc.create(INACTIVE(), NOW);

  assert.equal(view.record.status, "needs_review");
  assert.equal(bus.ofType("verification.completed").length, 0, "an unreviewed estimate must never reach billing");

  const raised = bus.ofType("verification.needs_review");
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.payload.patientName, "Ada Alpha");
  assert.ok(raised[0]!.payload.reasons.length > 0);
  assert.ok(raised[0]!.payload.priority > 0);
});

test("approving a review publishes verification.completed with settledAs \"reviewed\"", async () => {
  const { bus, svc } = wired();
  const created = await svc.create(INACTIVE(), NOW);
  assert.equal(bus.ofType("verification.completed").length, 0);

  const reviewedAt = new Date("2026-07-15T13:00:00Z");
  await svc.review(created.record.id, { decision: "approved", notes: "Confirmed by phone." }, reviewedAt);

  const completed = bus.ofType("verification.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.payload.settledAs, "reviewed");
  assert.equal(completed[0]!.payload.completedAt, reviewedAt.toISOString());
});

test("a rejected review publishes no completed event", async () => {
  const { bus, svc } = wired();
  const created = await svc.create(INACTIVE(), NOW);
  await svc.review(created.record.id, { decision: "rejected", notes: "Wrong patient." }, NOW);
  assert.equal(bus.ofType("verification.completed").length, 0);
});

test("a verification with no benefits publishes nothing billable", async () => {
  const { bus, svc } = wired();
  const view = await svc.create(input("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"), NOW);

  assert.equal(view.record.benefits, null);
  assert.equal(bus.ofType("verification.completed").length, 0, "no benefits means nothing to inherit");
  assert.equal(bus.ofType("verification.needs_review").length, 1);
});

test("the snapshot is a frozen copy — mutating the record cannot reach into it", async () => {
  const { svc } = wired();
  const view = await svc.create(CLEAN(), NOW);
  const snapshot = buildCoverageSnapshot(view.record)!;

  view.record.benefits!.annualMaximum.remaining = cents(0);
  view.record.calculation!.totalPatientPays = cents(999999);

  assert.notEqual(snapshot.benefits.annualMaximum.remaining, 0);
  assert.notEqual(snapshot.calculation.totalPatientPays, 999999);
});

test("buildCoverageSnapshot returns null when there is nothing to freeze", async () => {
  const { svc } = wired();
  const view = await svc.create(input("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"), NOW);
  assert.equal(buildCoverageSnapshot(view.record), null);
});

test("buildCompletedEvent refuses an unsettled record; buildNeedsReviewEvent refuses a settled one", async () => {
  const { svc } = wired();
  const clean = await svc.create(CLEAN(), NOW);
  const flagged = await svc.create(INACTIVE(), NOW);

  assert.equal(buildCompletedEvent(flagged.record), null);
  assert.ok(buildCompletedEvent(clean.record));
  assert.equal(buildNeedsReviewEvent(clean.record, NOW), null);
  assert.ok(buildNeedsReviewEvent(flagged.record, NOW));
});

test("completionEvent(id) yields the same payload the event carried", async () => {
  const { bus, svc } = wired();
  const created = await svc.create(CLEAN(), NOW);

  const published = bus.ofType("verification.completed")[0]!.payload;
  const onDemand = await svc.completionEvent(created.record.id);

  assert.ok(onDemand, "a settled verification is billable on demand");
  // The outbox stamps snapshot_version onto the envelope's payload; the body is otherwise identical.
  assert.deepEqual({ ...onDemand, snapshot_version: published.snapshot_version }, published);
});

test("completionEvent returns null for a record that is not billable", async () => {
  const { svc } = wired();
  const created = await svc.create(INACTIVE(), NOW);
  assert.equal(await svc.completionEvent(created.record.id), null);
});

test("the service works with no event bus wired at all", async () => {
  const svc = new VerificationService(new InMemoryVerificationRepository(), new MockEdiAdapter());
  const view = await svc.create(CLEAN(), NOW);
  assert.equal(view.record.status, "verified");
});
