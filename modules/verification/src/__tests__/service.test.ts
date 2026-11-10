/**
 * Service + repository + view tests. Exercises the full "verify → persist → look up → review" flow
 * against the in-memory repository and the mock EDI adapter (production 271 parser behind it), with a
 * fixed clock for determinism.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import {
  VerificationService,
  VerificationNotFoundError,
  InMemoryVerificationRepository,
} from "../index.ts";
import type { VerificationInput } from "../index.ts";

const NOW = new Date("2026-07-15T12:00:00Z");

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

test("create runs the pipeline, persists the record, and returns a full view", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());

  const view = await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);

  assert.equal(view.record.status, "verified");
  assert.equal(view.decision.outcome, "complete");
  assert.ok(view.record.calculation, "expected a coverage calculation");
  assert.ok(view.patientSummary.length > 0, "expected a plain-English summary");
  assert.equal(view.freshness.status, "fresh");
  assert.equal(repo.size, 1);
});

test("a saved verification round-trips by id", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());

  const created = await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);
  const fetched = await svc.get(created.record.id, NOW);

  assert.ok(fetched, "expected to find the record");
  assert.deepEqual(fetched.record, created.record);
});

test("get returns null for an unknown id", async () => {
  const svc = new VerificationService(new InMemoryVerificationRepository(), new MockEdiAdapter());
  assert.equal(await svc.get("00000000-0000-0000-0000-000000000000", NOW), null);
});

test("inactive coverage is routed to a human", async () => {
  const svc = new VerificationService(new InMemoryVerificationRepository(), new MockEdiAdapter());
  const view = await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);
  assert.equal(view.record.status, "needs_review");
  assert.equal(view.decision.outcome, "needs_human");
  assert.ok(view.record.exceptions.some((e) => e.code === "inactive-coverage"));
});

test("list is value-ranked: the higher-priority case comes first", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());

  await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW); // clean → low priority
  await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW); // inactive → high priority

  const items = await svc.list(undefined, NOW);
  assert.equal(items.length, 2);
  assert.ok(items[0]!.priority >= items[1]!.priority, "expected descending priority");
  assert.equal(items[0]!.outcome, "needs_human");
});

test("list filters by status", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());
  await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);
  await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);

  const needsReview = await svc.list({ status: "needs_review" }, NOW);
  assert.equal(needsReview.length, 1);
  assert.equal(needsReview[0]!.status, "needs_review");
});

test("review settles a needs_review case and records the decision + audit", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());

  const created = await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);
  assert.equal(created.record.status, "needs_review");

  const reviewed = await svc.review(created.record.id, { decision: "approved", notes: "Confirmed by phone." }, NOW);
  assert.equal(reviewed.record.status, "reviewed");
  assert.equal(reviewed.decision.outcome, "complete");
  assert.equal(reviewed.record.review?.decision, "approved");
  assert.ok(reviewed.record.audit.some((a) => a.actor === "staff" && a.message.includes("approved")));
});

test("a rejected review marks the case failed/blocked", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());
  const created = await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);

  const reviewed = await svc.review(created.record.id, { decision: "rejected", notes: "Wrong patient." }, NOW);
  assert.equal(reviewed.record.status, "failed");
  assert.equal(reviewed.decision.outcome, "blocked");
});

test("openOnly returns what still needs a person — and drops what a person has settled", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());

  const clean = await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);
  const flagged = await svc.create(input("MEM10000", "Delta Dental\nMember ID: MEM10000"), NOW);
  const unknownPayer = await svc.create(input("XYZ99999", "Obscure Plan Co\nMember ID: XYZ99999"), NOW);

  const open = await svc.list({ openOnly: true }, NOW);
  assert.equal(open.some((v) => v.id === clean.record.id), false, "a verified case is not work");
  assert.equal(open.some((v) => v.id === flagged.record.id), true);
  assert.equal(
    open.some((v) => v.id === unknownPayer.record.id),
    true,
    "an unusable case nobody has looked at still needs a person"
  );

  // The regression this guards: REJECTING a verification is a human settling it. Before this filter
  // existed the record stayed `failed` → decision `blocked` → priority 80, so the unified Today queue
  // re-offered finished work at the top of the list, permanently.
  await svc.review(flagged.record.id, { decision: "rejected", notes: "Wrong patient." }, NOW);
  const after = await svc.list({ openOnly: true }, NOW);
  assert.equal(
    after.some((v) => v.id === flagged.record.id),
    false,
    "a case a human rejected is finished, not blocked work"
  );
  assert.equal((await svc.list(undefined, NOW)).length, 3, "an unfiltered list still shows everything");
});

test("reviewing an unknown id throws VerificationNotFoundError", async () => {
  const svc = new VerificationService(new InMemoryVerificationRepository(), new MockEdiAdapter());
  await assert.rejects(
    () => svc.review("does-not-exist", { decision: "approved", notes: "" }, NOW),
    VerificationNotFoundError
  );
});

test("the repository isolates stored records from later caller mutation", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());
  const created = await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);

  // Mutate the returned view; the store must be unaffected.
  created.record.patient.firstName = "TAMPERED";
  const fetched = await svc.get(created.record.id, NOW);
  assert.equal(fetched!.record.patient.firstName, "Ada");
});

test("saving a duplicate id is rejected by the repository", async () => {
  const repo = new InMemoryVerificationRepository();
  const svc = new VerificationService(repo, new MockEdiAdapter());
  const created = await svc.create(input("ABC12345", "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100"), NOW);
  await assert.rejects(() => repo.save(created.record), /already exists/);
});

/**
 * ── V2: the patient master carries the address, and gives it back ───────────────────────────────
 *
 * Two halves of one defect. The write half — a verification that collected an address must leave it
 * on the patient, not only inside its own document. The read half — a RETURNING patient who is not
 * asked again must still be filable, because the practice already holds the fact.
 *
 * The read half is the one with teeth. Without it the master accumulates addresses it never returns,
 * the June claim blocks for the address collected in March, and the front desk re-keys an address
 * that is already on file — which is precisely where invented patient data comes from.
 */
const ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;
const CARD = "Delta Dental\nMember ID: ABC12345\nGroup #: GRP100";

test("an address collected at check-in is written to the patient master", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );

  const view = await svc.create({ ...input("ABC12345", CARD), patient: { ...input("ABC12345", CARD).patient, address: ADDRESS } }, NOW);

  const patient = await patients.findById(view.record.patientId!);
  assert.deepEqual(patient?.address, ADDRESS, "the address must land on the patient, not only in the verification");
});

test("a returning patient's address is reused when this visit did not collect one", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );

  const march = input("ABC12345", CARD);
  await svc.create({ ...march, patient: { ...march.patient, address: ADDRESS } }, NOW);

  // June: same person, no address typed. The record must come back filable anyway.
  const june = await svc.create(input("ABC12345", CARD), NOW);

  assert.deepEqual(june.record.patient.address, ADDRESS, "the stored address must be reused on a later visit");
});

test("an address collected today wins over the one on file — reuse is a fallback, never an override", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );

  const moved = { street: "2 SYNTHETIC TEST WAY", city: "SHELBYVILLE", state: "OR", zip: "970010000" } as const;
  const first = input("ABC12345", CARD);
  await svc.create({ ...first, patient: { ...first.patient, address: ADDRESS } }, NOW);
  const second = await svc.create({ ...first, patient: { ...first.patient, address: moved } }, NOW);

  assert.deepEqual(second.record.patient.address, moved, "today's answer is the more recent statement of fact");
  assert.deepEqual((await patients.findById(second.record.patientId!))?.address, moved, "and it updates the master");
});

test("a patient with no address anywhere stays without one — nothing invents a placeholder", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );

  const view = await svc.create(input("ABC12345", CARD), NOW);

  assert.equal(view.record.patient.address, undefined, "absent must keep meaning NOT COLLECTED");
  assert.equal((await patients.findById(view.record.patientId!))?.address, undefined);
});

/**
 * ── V5: correcting the address on the patient master ────────────────────────────────────────────
 *
 * The other half of V5. V2 made a stored address REUSED by the next verification, so correcting it
 * here is what stops the practice being asked the same question again — and what makes every future
 * claim for this person filable without re-keying.
 *
 * `updateAddress` is deliberately NOT `ensure`. `ensure` merges forward only, which is right for a
 * check-in where silence means "nobody asked" and exactly wrong for a correction, where somebody is
 * deliberately restating what they know — including that a stored address is wrong and must go.
 */
test("an address on file can be corrected, and the correction is what is read back", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const created = await patients.ensure(ada, { address: ADDRESS });

  const moved = { street: "2 SYNTHETIC TEST WAY", city: "SHELBYVILLE", state: "OR", zip: "970010000" };
  const updated = await patients.updateAddress(created.id, moved);

  assert.deepEqual(updated?.address, moved);
  assert.deepEqual((await patients.findById(created.id))?.address, moved, "durable, not just returned");
});

test("a correction normalises what staff type", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const created = await patients.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });

  const updated = await patients.updateAddress(created.id, {
    street: " 1 SYNTHETIC TEST WAY ",
    city: "Springfield",
    state: "ca",
    zip: "90001-0000",
  });

  // The state is upper-cased because USPS codes are two upper-case letters and an 837 carries them
  // that way. The CITY is left exactly as typed — "Springfield" is not more correct as
  // "SPRINGFIELD", and silently re-casing a person's address is a change nobody asked for.
  assert.deepEqual(updated?.address, {
    street: "1 SYNTHETIC TEST WAY",
    city: "Springfield",
    state: "CA",
    zip: "900010000",
  });
});

test("passing null CLEARS the address — the one thing `ensure` can never do", async () => {
  /**
   * The capability that makes this a correction rather than another write. An address entered
   * against the wrong patient must be removable, and `ensure`'s forward-only merge cannot do it at
   * any price. Clearing returns the record to "not collected", which the scrubber correctly blocks
   * on — honest, and visible on the screen.
   */
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const created = await patients.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" }, { address: ADDRESS });

  const cleared = await patients.updateAddress(created.id, null);

  assert.equal(cleared?.address, undefined, "cleared means NOT COLLECTED");
  assert.equal((await patients.findById(created.id))?.address, undefined);
});

test("a partial correction is refused loudly, and leaves the record alone", async () => {
  // A silent no-op would tell the desk their correction saved when it did not, and they would go on
  // believing the claim is unblocked.
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const created = await patients.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" }, { address: ADDRESS });

  await assert.rejects(
    () => patients.updateAddress(created.id, { street: "2 SYNTHETIC TEST WAY", city: "", state: "OR", zip: "970010000" }),
    /street, city, state and ZIP/
  );
  assert.deepEqual((await patients.findById(created.id))?.address, ADDRESS, "the original survives intact");
});

test("correcting a patient who does not exist is null, not a new row", async () => {
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();

  assert.equal(await patients.updateAddress(crypto.randomUUID(), ADDRESS), null);
});

test("a corrected address flows into the NEXT verification, closing the loop with V2", async () => {
  /**
   * The end-to-end proof that the two halves connect. Correcting the master is only worth anything
   * if the next visit picks it up — otherwise the front desk fixes an address that no claim ever
   * sees.
   */
  const { InMemoryPatientDirectory } = await import("../index.ts");
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );

  const first = await svc.create(input("ABC12345", CARD), NOW);
  assert.equal(first.record.patient.address, undefined, "precondition: nothing on file");

  await patients.updateAddress(first.record.patientId!, ADDRESS);

  // A later visit that collects no address must now inherit the corrected one.
  const second = await svc.create(input("ABC12345", CARD), NOW);
  assert.deepEqual(second.record.patient.address, ADDRESS, "the correction reaches the next claim");
});
