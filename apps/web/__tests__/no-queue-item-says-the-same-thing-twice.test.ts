/**
 * A Today item must not print the same sentence twice.
 *
 * ── THE DEFECT, WHICH ONLY STAGING DATA SHOWED ─────────────────────────────────────────────────
 * A held remittance's subtitle ended with `holdReason`, and its action is
 * `"Review and release — {the same holdReason}"`. So the reason appeared in full, twice, one line
 * under the other:
 *
 *   subtitle  Paid 2026-08-31 · held 5 days · $799.99 not posted · Claim MRM-BDEDD701FE6B was
 *             FORWARDED by Cigna Dental to another plan (status 19), with $482.51 assigned to that
 *             plan's adjudication. Another payer is involved and has not been accounted for.
 *   action    Review and release — Claim MRM-BDEDD701FE6B was FORWARDED by Cigna Dental to another
 *             plan (status 19), with $482.51 assigned to that plan's adjudication. Another payer is
 *             involved and has not been accounted for.
 *
 * 243 characters followed by 211 characters saying the same thing. On staging those two rows
 * rendered at 268px against 106px for every other item — two and a half times the height — and
 * pushed the rest of the board off the screen.
 *
 * That breaks the criterion §12 says outranks everything else in the specification: a practice
 * manager must answer the screen's question in under five seconds without scrolling.
 *
 * ── WHY THE ASSERTION IS SHAPED THIS WAY ───────────────────────────────────────────────────────
 * Not "the subtitle is short" — the queue is entitled to say what it needs to. The defect is
 * REDUNDANCY: two fields on one row spending the reader's attention on the same words. A shared
 * run of forty characters is well past any phrase two independent sentences would collide on by
 * accident, and comfortably under the length of a real repeated explanation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTodayQueue } from "../today.ts";
import { buildServices, type Services } from "../wiring.ts";
import { MockEdiAdapter, type RemittanceRequestClaim } from "@mermaid/edi";
import type { ClaimSubmittedBody } from "@mermaid/events";
import { cents } from "@mermaid/shared";

const NOW = new Date("2026-08-12T09:00:00.000Z");

/**
 * The longest run of characters two strings share.
 *
 * Written out rather than reached for, because the useful answer here is the LENGTH of the overlap
 * and where it starts — a failure that only says "these are similar" sends the next person hunting.
 */
function longestSharedRun(a: string, b: string): string {
  if (!a || !b) return "";
  let best = "";
  for (let i = 0; i < a.length; i++) {
    /* Only runs that could beat the best are worth extending. */
    for (let j = i + best.length + 1; j <= a.length; j++) {
      const candidate = a.slice(i, j);
      if (!b.includes(candidate)) break;
      best = candidate;
    }
  }
  return best;
}

test("the overlap detector finds a real repeat and ignores an incidental one", () => {
  /* A self-check: a broken detector would let every assertion below pass. */
  assert.equal(longestSharedRun("abcdefgh", "xxcdefxx").length, 4);
  assert.equal(longestSharedRun("the claim was paid", "a different sentence").length <= 5, true);
  assert.equal(longestSharedRun("", "anything"), "");
});

const RECEIVED = new Date("2026-08-10T09:00:00.000Z");

const submitted = (memberId: string, id: string): ClaimSubmittedBody => ({
  claimId: `claim-${id}`,
  verificationId: `ver-${id}`,
  submittedAt: "2026-07-28T10:00:00.000Z",
  submittedBy: "biller@clinic",
  patient: { firstName: "Held", lastName: "Money", dateOfBirth: "1990-04-12", memberId },
  payerId: "delta-dental",
  payerName: "Delta Dental",
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  totalFee: cents(1000),
  expectedInsurancePays: cents(600),
  serviceDate: "2026-07-27",
});

const remitClaim = (memberId: string, id: string): RemittanceRequestClaim => ({
  patientControlNumber: `MRM-${id}`,
  payerControlNumber: "556677889",
  patientFirstName: "Held",
  patientLastName: "Money",
  memberId,
  lines: [{ procedureCode: "D2750", charged: cents(1000), quantity: 1 }],
  expectedInsurancePays: cents(600),
});

/**
 * A clinic holding two advices for a reason with PROSE in it.
 *
 * The member id is the whole fixture: `…23` is what makes the mock forward the claim to a second
 * plan, and a coordination hold is the one whose `holdReason` runs to a paragraph rather than a
 * phrase. Without it there is no held remittance at all, and both tests below pass over an empty
 * set — which is exactly what the first version of this file did: reintroducing the defect into
 * `today.ts` did not fail it.
 *
 * Two advices, not one, because the second test is about telling two identical ones apart.
 */
async function clinic(): Promise<Services> {
  const services = buildServices({ inMemory: true });
  for (const id of ["B1", "B2"]) {
    await services.remittance.recordExpectation(submitted("ABC00023", id));
    const fetched = await new MockEdiAdapter().fetchRemittance({
      payerId: "delta-dental",
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      paymentDate: "2026-08-10",
      claims: [remitClaim("ABC00023", id)],
    });
    await services.remittance.ingestArtifact(
      fetched.raw!,
      { resolution: "source-credential", vendor: "mock", artifactId: `f-${id}`, expectedPayeeId: null },
      RECEIVED
    );
  }
  return services;
}

test("no queue item spends the reader's attention on the same words twice", async () => {
  const today = await buildTodayQueue(await clinic(), 50, NOW, { role: "owner" });
  assert.ok(today.items.length > 0, "the fixture produced no items, so this would be vacuous");

  const offenders: string[] = [];
  for (const item of today.items) {
    const shared = longestSharedRun(item.subtitle ?? "", item.action ?? "");
    if (shared.length >= 40) {
      offenders.push(
        `${item.kind} "${item.title}" repeats ${shared.length} characters between its subtitle and ` +
          `its action: ${JSON.stringify(shared.slice(0, 60))}…`
      );
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}\n`);
});

test("a held remittance still says which advice it is", async () => {
  /**
   * The other half of the fix, and the reason the subtitle was not simply shortened to nothing.
   *
   * Staging carries two Cigna advices identical on this board — same payer, same $799.99, same
   * claim, same forwarded-to-another-plan reason — so a biller had no way to tell whether Cigna had
   * sent $799.99 once or twice, and releasing both would post $1,599.98 against one payment. The
   * payment date and the held age are what tell them apart, and they must survive any tidying of
   * this row.
   */
  const today = await buildTodayQueue(await clinic(), 50, NOW, { role: "owner" });
  const held = today.items.filter((i) => i.kind === "remittance" && /held \d+ day/.test(i.subtitle ?? ""));
  /* Both assertions here range over held advices, so an empty set means neither tests anything.
     This is the guard the first version of this file lacked. */
  assert.ok(held.length >= 2, "the fixture produced no held advices, so every assertion is vacuous");

  for (const item of held) {
    assert.match(item.subtitle!, /^Paid \d{4}-\d{2}-\d{2}/, "the payment date leads the row");
    assert.match(item.subtitle!, /held \d+ days?/, "and the age is on it");
    assert.match(item.subtitle!, /not posted/, "and the amount that has not moved");
  }
});
