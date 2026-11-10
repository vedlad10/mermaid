/**
 * Concurrent release of ONE held remittance, against a real database.
 *
 * Releasing is read-modify-write over money: read the held remittance, check it is not already
 * posted, post it, and publish one `remittance.posted` per posting. Two releases racing — a biller
 * double-clicking, two people working the same hold — both read `held`, both clear the guard, and
 * both publish.
 *
 * Claims and the patient ledger key their idempotency on the POSTING and absorb that. Analytics
 * keys on the SOURCE EVENT id and cannot: the two publishes are genuinely different events carrying
 * the same money, so the practice report double-counts every dollar on the advice. The row lock
 * (`RemittanceRepository.lockById`) is what makes the second caller wait and then see `posted`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { requireContext, withPractice } from "@mermaid/db";
import { cents } from "@mermaid/shared";
import { MockEdiAdapter } from "@mermaid/edi";
import { NullEventPublisher } from "@mermaid/events";
import type { EventBus, DomainEvent } from "@mermaid/events";
import {
  PgExpectationRepository,
  PgRemittanceRepository,
  RemittanceService,
} from "@mermaid/remittance";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

/** Counts what was published, so a double release is visible as the duplicate money it is. */
class CountingPublisher extends NullEventPublisher {
  posted: DomainEvent[] = [];
  override async publish(type: never, aggregateId: never, body: never, options?: never) {
    const event = await super.publish(type, aggregateId, body, options);
    if (String(type) === "remittance.posted") this.posted.push(event as DomainEvent);
    return event;
  }
}

/** A repository whose LOCKING read dawdles, so two releasers provably overlap. */
class SlowLockRemittances extends PgRemittanceRepository {
  override async lockById(id: string) {
    const remittance = await super.lockById(id);
    await new Promise((resolve) => setTimeout(resolve, 900));
    return remittance;
  }
}

/**
 * An 835 the safety gate HOLDS, so there is something to release.
 *
 * Trace-less: `missing-trace-number` is a blocker, and it is also refused at release — so the hold
 * used here is a payee mismatch instead, raised through the real ERA provenance path.
 */
async function heldRemittance(practiceId: string, service: RemittanceService): Promise<string> {
  /**
   * The expectation has to exist first. Without it the posting carries no `claimId` and no
   * variance, `#publishPosting` returns early, and the test would pass by publishing nothing at
   * all — measuring the wrong thing while looking green.
   */
  await withPractice(practiceId, () =>
    service.recordExpectation({
      claimId: crypto.randomUUID(),
      verificationId: crypto.randomUUID(),
      submittedAt: "2026-08-25T10:00:00.000Z",
      submittedBy: "biller@clinic",
      patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" },
      payerId: "delta-dental",
      payerName: "Delta Dental",
      patientControlNumber: "MRM-RACE-001",
      payerControlNumber: "556677889",
      totalFee: cents(65),
      expectedInsurancePays: cents(65),
      serviceDate: "2026-08-24",
    })
  );

  const raw = (
    await new MockEdiAdapter().fetchRemittance({
      payerId: "delta-dental",
      payerName: "Delta Dental",
      payeeName: "MERMAID DEMO DENTAL",
      paymentDate: "2026-09-01",
      claims: [
        {
          patientControlNumber: "MRM-RACE-001",
          payerControlNumber: "556677889",
          patientFirstName: "Ada",
          patientLastName: "Alpha",
          memberId: "ABC12345",
          lines: [{ procedureCode: "D0120", charged: cents(65), quantity: 1 }],
          expectedInsurancePays: cents(65),
        },
      ],
    })
  ).raw!;
  // Give the file a payee the source does not expect — a blocker that HOLDS without touching the
  // trace number, which release() refuses outright and for a different reason.
  const withPayee = raw.replace(/N1\*PE\*([^~]*)~/, `N1*PE*$1*XX*9999999999~`);

  const views = await withPractice(practiceId, () =>
    service.ingestArtifact(
      withPayee,
      { resolution: "source-credential", vendor: "mock", artifactId: "exec-race", expectedPayeeId: "1234567893" },
      NOW
    )
  );
  assert.equal(views.length, 1);
  assert.equal(views[0]!.remittance.status, "held", "the fixture must actually be held");
  return views[0]!.remittance.id;
}

test("two concurrent releases post the money once, and publish it once", dbTest, async () => {
  const p = await makePractice("remit-race");
  created.push(p);

  const publisher = new CountingPublisher();
  const service = new RemittanceService(
    new SlowLockRemittances(),
    new PgExpectationRepository(),
    new MockEdiAdapter(),
    publisher as never
  );
  const id = await heldRemittance(p, service);
  publisher.posted.length = 0;

  // Two warm connections, so the second releaser is not just waiting on a TLS handshake.
  await Promise.all([
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
    withPractice(p, async () => void (await requireContext().tx.query("SELECT pg_sleep(0.3)"))),
  ]);

  await Promise.allSettled([
    withPractice(p, () => service.release(id, "biller-one@clinic", "Confirmed with the payer.", NOW)),
    withPractice(p, () => service.release(id, "biller-two@clinic", "Confirmed with the payer.", NOW)),
  ]);

  const view = (await withPractice(p, () => service.get(id, NOW)))!;
  assert.equal(view.remittance.status, "posted");

  // The property that matters. Analytics is idempotent on the source EVENT id, so two publishes of
  // one posting are two facts and the practice report counts the money twice.
  assert.equal(
    publisher.posted.length,
    view.remittance.postings.length,
    "one posting, one remittance.posted — a second publish double-counts the advice on every report"
  );
});
