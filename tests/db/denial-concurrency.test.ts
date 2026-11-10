/**
 * Concurrent mutation of ONE denial, against a real database.
 *
 * The race that matters here is approve-beside-revise. A revise clears any approval because a
 * signature belongs to specific words; unlocked, the two read the same starting state and the
 * LAST commit wins wholesale — so an approve landing after a concurrent revise reinstates the OLD
 * letter with a fresh signature: a payer-facing letter nobody actually read, and the revision
 * silently gone. `DenialRepository.lockById` (SELECT … FOR UPDATE) is what serializes them.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { NullEventPublisher } from "@mermaid/events";
import type { VarianceDetectedBody } from "@mermaid/events";
import { InMemoryPlaybookRepository, PayerProfileService } from "@mermaid/payer-profile";
import { DenialService, NoExplainer, NoNarrator, PgDenialRepository } from "@mermaid/denials-appeals";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-15T10:00:00Z");
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

/**
 * A denial repository whose LOCKING reads dawdle on cue.
 *
 * `delays` is consumed one entry per `lockById` call. The race window is between the mutating read
 * and its update; holding the FIRST racer's read open for seconds makes the overlap a certainty.
 * With the row lock, the second racer blocks INSIDE `lockById` until the first commits — so the
 * delay serializes; without it, both read and the last commit wins.
 */
class SlowLockDenials extends PgDenialRepository {
  delays: number[] = [];
  override async lockById(id: string) {
    const denial = await super.lockById(id);
    const wait = this.delays.shift() ?? 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return denial;
  }
}

const variance = (): VarianceDetectedBody => ({
  claimId: crypto.randomUUID(),
  remittanceId: crypto.randomUUID(),
  postingId: crypto.randomUUID(),
  detectedAt: "2026-09-15T09:00:00.000Z",
  payerId: "metlife-dental",
  payerName: "MetLife Dental",
  patientName: "Ada Alpha",
  memberId: "MET30066",
  claimControlNumber: "MRM-000456",
  serviceDate: "2026-09-01",
  paymentDate: "2026-09-01",
  recoverableAmount: cents(1125),
  unexplainedAmount: cents(0),
  reasons: [
    { group: "CO", code: "197", description: "Pre-authorization absent", amount: cents(1125), procedureCode: "D2750" },
  ],
  summary: "The payer withheld $1,125.00 for a missing pre-authorization.",
});

const REVISED_LETTER =
  "Dear MetLife Dental, we are appealing the denial of claim MRM-000456 for member MET30066. " +
  "The pre-authorization requirement cited under CO-197 was satisfied before treatment; the " +
  "authorization confirmation and clinical records are enclosed. We request adjudication and " +
  "payment of the withheld amount of $1,125.00 for procedure D2750 rendered on 2026-09-01.";

test("an approve racing a revise cannot sign the letter the approver never read", dbTest, async () => {
  const p = await makePractice("denial-race");
  created.push(p);

  const repo = new SlowLockDenials();
  const playbook = new PayerProfileService(new InMemoryPlaybookRepository());
  await playbook.ensureDefaults();
  const service = new DenialService(repo, playbook, { name: "FIXTURE FAMILY DENTAL" }, new NullEventPublisher(), NoNarrator, NoExplainer);

  const [view] = await withPractice(p, () => service.createFromVariance(variance(), NOW));
  const drafted = await withPractice(p, () => service.draftAppeal(view!.denial.id, {}, NOW));
  const originalLetter = drafted.activeAppeal!.letter;
  assert.notEqual(originalLetter, REVISED_LETTER);

  // Warm a second pooled connection so the second racer is not just waiting on a TLS handshake.
  await Promise.all([
    withPractice(p, () => service.get(view!.denial.id, NOW)),
    withPractice(p, () => service.get(view!.denial.id, NOW)),
  ]);

  // The approve reads first and dawdles; the revise starts while it is provably mid-flight.
  repo.delays = [2_500, 200];
  const approve = withPractice(p, () => service.approveAppeal(view!.denial.id, "dr.dana@clinic", NOW));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const revise = withPractice(p, () => service.reviseAppeal(view!.denial.id, REVISED_LETTER, "biller@clinic", NOW));
  await Promise.allSettled([approve, revise]);

  const final = (await withPractice(p, () => service.get(view!.denial.id, NOW)))!;
  const appeal = final.activeAppeal!;
  assert.equal(appeal.letter, REVISED_LETTER, "the revision must never be silently dropped");
  if (appeal.approvedBy) {
    // Legal only in the serialization where the approve ran AFTER the revise — i.e. the signature
    // is on the revised words. An approval on the ORIGINAL letter text is the breach.
    assert.equal(appeal.letter, REVISED_LETTER);
  }
});
