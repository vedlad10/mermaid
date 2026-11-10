/**
 * Coverage readiness for a visit — every state, and the three traps it exists to avoid:
 * judging freshness today instead of on the visit day, trusting an older good run over a newer bad
 * one, and reading "a person reviewed it" as "the patient is covered".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appointmentReadiness, latestVerification } from "../readiness.ts";
import type { VerificationRecord } from "../../types.ts";

const benefits = (over: Record<string, unknown> = {}) => ({
  eligibility: "active",
  planName: "PPO",
  coverage: { effectiveDate: null, terminationDate: null },
  ...over,
});

const record = (over: Record<string, unknown>): VerificationRecord =>
  ({
    id: "v1",
    status: "verified",
    createdAt: "2026-09-20T15:00:00.000Z",
    review: null,
    benefits: benefits(),
    ...over,
  }) as unknown as VerificationRecord;

const VISIT = new Date("2026-10-01T14:30:00.000Z");
const DAY = "2026-10-01";
const ready = (latest: VerificationRecord | null, hasCoverage = true, at = VISIT, day = DAY) =>
  appointmentReadiness(at, day, latest, hasCoverage);

test("no verification: coverage on file is unverified, none on file is no-coverage", () => {
  assert.deepEqual([ready(null, true).state, ready(null, true).group], ["unverified", "pending"]);
  assert.deepEqual([ready(null, false).state, ready(null, false).group], ["no-coverage", "no-coverage"]);
  assert.equal(ready(null).verificationId, null);
  assert.equal(ready(null).expiresAt, null);
});

test("a fresh, active verification is verified and names the run it rests on", () => {
  const r = ready(record({}));
  assert.equal(r.state, "verified");
  assert.equal(r.group, "verified");
  assert.equal(r.verificationId, "v1");
  assert.equal(r.verifiedAt, "2026-09-20T15:00:00.000Z");
  assert.equal(r.expiresAt, "2026-10-20T15:00:00.000Z");
});

test("freshness is judged on the VISIT day: fresh today, expired by January 3, is stale", () => {
  const verifiedDec = record({ createdAt: "2026-12-20T15:00:00.000Z" });
  const beforeRollover = ready(verifiedDec, true, new Date("2026-12-28T15:00:00.000Z"), "2026-12-28");
  const afterRollover = ready(verifiedDec, true, new Date("2027-01-03T15:00:00.000Z"), "2027-01-03");
  assert.equal(beforeRollover.state, "verified");
  assert.equal(afterRollover.state, "stale");
  assert.equal(afterRollover.group, "pending");
  assert.match(afterRollover.reason, /Plan-year rollover/);
});

test("aging on the visit day is still ready — only an expired result counts against a visit", () => {
  // Created Sep 5: expires Oct 5, aging from Sep 28. An Oct 1 visit falls in the aging band.
  assert.equal(ready(record({ createdAt: "2026-09-05T15:00:00.000Z" })).state, "verified");
});

test("needs_review is pending; failed is failed", () => {
  assert.equal(ready(record({ status: "needs_review" })).state, "needs-review");
  assert.equal(ready(record({ status: "needs_review" })).group, "pending");
  const failed = ready(record({ status: "failed", benefits: null }));
  assert.deepEqual([failed.state, failed.group], ["failed", "failed"]);
});

test("a person's approval of a failed run stands, even with no benefits", () => {
  const approved = record({ status: "reviewed", benefits: null, review: { decision: "overridden", notes: "", reviewedAt: "" } });
  assert.equal(ready(approved).state, "verified");
});

test("REVIEWED IS NOT COVERED: a reviewed run the payer called inactive is inactive, not green", () => {
  const r = ready(
    record({ status: "reviewed", benefits: benefits({ eligibility: "inactive" }), review: { decision: "approved", notes: "", reviewedAt: "" } })
  );
  assert.equal(r.state, "inactive");
  assert.equal(r.group, "failed");
});

test("a plan that ends before the visit, or starts after it, is inactive for that visit", () => {
  const ends = ready(record({ benefits: benefits({ coverage: { effectiveDate: null, terminationDate: "2026-09-30" } }) }));
  assert.equal(ends.state, "inactive");
  assert.match(ends.reason, /ends 2026-09-30, before the 2026-10-01 visit/);
  // The plan's last day is still a covered day.
  const endsThatDay = ready(record({ benefits: benefits({ coverage: { effectiveDate: null, terminationDate: DAY } }) }));
  assert.equal(endsThatDay.state, "verified");
  const starts = ready(record({ benefits: benefits({ coverage: { effectiveDate: "2026-10-02", terminationDate: null } }) }));
  assert.equal(starts.state, "inactive");
});

test("an eligibility the payer did not confirm is unconfirmed, and pending", () => {
  const r = ready(record({ benefits: benefits({ eligibility: "unknown" }) }));
  assert.deepEqual([r.state, r.group], ["unconfirmed", "pending"]);
});

test("the LATEST run is the current word, even when an older one looked better", () => {
  const good = record({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" });
  const bad = record({ id: "new", createdAt: "2026-09-25T00:00:00.000Z", status: "failed", benefits: null });
  assert.equal(latestVerification([good, bad])?.id, "new");
  assert.equal(latestVerification([bad, good])?.id, "new");
  assert.equal(latestVerification([]), null);
  // Equal timestamps break on id, so the answer does not depend on read order.
  const a = record({ id: "a" });
  const b = record({ id: "b" });
  assert.equal(latestVerification([a, b])?.id, "b");
  assert.equal(latestVerification([b, a])?.id, "b");
});

/* ── Across plans: each plan answers for itself ──────────────────────────────────────────────── */

const { coverageReadiness, planKey } = await import("../readiness.ts");

const onPlan = (payerId: string, memberId: string, over: Record<string, unknown>) =>
  record({ payerId, card: { memberId: { value: memberId } }, patient: { memberId }, ...over });

test("a SECONDARY plan's newer failed check no longer hides a verified primary", () => {
  const primary = onPlan("delta", "DD-100", { id: "p", createdAt: "2026-09-20T15:00:00.000Z" });
  const secondary = onPlan("metlife", "ML-200", { id: "s", createdAt: "2026-09-27T15:00:00.000Z", status: "failed", benefits: null });

  // The old behaviour, still true of the single-run primitive: the newest run overall is the failed one.
  assert.equal(ready(latestVerification([primary, secondary])).state, "failed");

  const r = coverageReadiness(VISIT, DAY, [primary, secondary], true);
  assert.equal(r.state, "verified");
  assert.equal(r.verificationId, "p", "the answer names the plan it rests on");
  assert.equal(r.plans, 2);
  assert.match(r.reason, /Another plan on file is not ready\./, "the other plan's problem is said, not hidden");
});

test("within ONE plan the newest run is still the current word — a lapse cannot hide behind an older good run", () => {
  const older = onPlan("delta", "DD-100", { id: "old", createdAt: "2026-09-01T15:00:00.000Z" });
  const newer = onPlan("delta", "dd100", { id: "new", createdAt: "2026-09-25T15:00:00.000Z", benefits: benefits({ eligibility: "inactive" }) });
  assert.equal(planKey(older), planKey(newer), "the same member ID printed two ways is one plan");
  const r = coverageReadiness(VISIT, DAY, [older, newer], true);
  assert.equal(r.state, "inactive");
  assert.equal(r.plans, 1);
});

test("a job change: the new plan verified, the old plan's check expired — the visit is ready", () => {
  const oldPlan = onPlan("delta", "DD-100", { id: "old", createdAt: "2026-07-01T15:00:00.000Z" });
  const newPlan = onPlan("metlife", "ML-200", { id: "new", createdAt: "2026-09-26T15:00:00.000Z" });
  const r = coverageReadiness(VISIT, DAY, [oldPlan, newPlan], true);
  assert.equal(r.state, "verified");
  assert.equal(r.verificationId, "new");
});

test("when no plan is ready, the visit takes the most recoverable answer, and says nothing extra", () => {
  const stale = onPlan("delta", "DD-100", { id: "stale", createdAt: "2026-07-01T15:00:00.000Z" });
  const failed = onPlan("metlife", "ML-200", { id: "failed", createdAt: "2026-09-27T15:00:00.000Z", status: "failed", benefits: null });
  const r = coverageReadiness(VISIT, DAY, [failed, stale], true);
  assert.equal(r.state, "stale", "an out-of-date check is fixed by re-checking; a failed plan may not be");
  assert.doesNotMatch(r.reason, /Another plan/, "the note is only for a ready visit with a plan that is not");
});

test("two plans in the same state: the newer run is the answer", () => {
  const a = onPlan("delta", "DD-100", { id: "a", createdAt: "2026-09-10T15:00:00.000Z" });
  const b = onPlan("metlife", "ML-200", { id: "b", createdAt: "2026-09-20T15:00:00.000Z" });
  assert.equal(coverageReadiness(VISIT, DAY, [a, b], true).verificationId, "b");
  assert.equal(coverageReadiness(VISIT, DAY, [b, a], true).verificationId, "b", "independent of read order");
});

test("no runs at all behaves exactly as before: coverage on file is unverified, none is no-coverage", () => {
  assert.equal(coverageReadiness(VISIT, DAY, [], true).state, "unverified");
  assert.equal(coverageReadiness(VISIT, DAY, [], false).state, "no-coverage");
});
