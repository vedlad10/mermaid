/**
 * M14 — two different people who share a name and a date of birth must not merge in silence.
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────────
 * `deriveChartId` resolves on surname + given name + date of birth, and `engine/identity.ts` has
 * always stated the limit honestly: two unrelated people sharing all three collide into one record.
 * What the note did not state is the FINANCIAL consequence. `unifiedStatement` merges the two
 * people's ledgers, so one patient's statement carries another's balance and a payment from one
 * reduces the other's — a billing dispute and a PHI disclosure in the same document, and the first
 * person to notice is a patient.
 *
 * ── WHY THE OBVIOUS DETECTOR IS THE WRONG ONE ──────────────────────────────────────────────────
 * "Flag when the member IDs share nothing" fires on every insurance change, which is the ordinary
 * case. A warning that cries wolf on routine traffic is one staff learn to dismiss, so it would
 * have made the system less safe, not more. The discriminator is the PAYER: a second, different
 * member ID from the SAME payer for one name and one birth date is far more likely to be two
 * people than one person re-numbered mid-plan.
 *
 * The false-positive guard below is therefore not a nicety — it is the assertion that decides
 * whether this control is usable at all.
 *
 * Nothing here merges, unmerges, re-keys or reassigns anything. The chart resolution that already
 * happened stands; a human is asked about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";
import {
  InMemoryPatientDirectory,
  InMemoryVerificationRepository,
  VerificationService,
  deriveChartId,
  detectIdentityCollision,
} from "../index.ts";
import type { VerificationInput } from "../index.ts";

const NOW = new Date("2026-07-15T12:00:00Z");
const PROCEDURES = [{ code: "D0120", quantity: 1 }, { code: "D2750", quantity: 1, fee: cents(1250) }];

/** Same name, same DOB — the collision precondition. The card names the payer. */
const visit = (memberId: string, payerName: string): VerificationInput => ({
  patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId },
  cardText: `${payerName}\nMember ID: ${memberId}\nGroup #: GRP100`,
  planItems: PROCEDURES,
});

function wired() {
  const patients = new InMemoryPatientDirectory();
  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    new MockEdiAdapter(),
    undefined,
    undefined,
    patients
  );
  return { patients, svc };
}

const collisionFlag = (record: { exceptions: { code: string; severity: string; message: string }[] }) =>
  record.exceptions.find((e) => e.code === "identity-collision");

// ── 1. The real collision ──────────────────────────────────────────────────────────────

test("same name, same DOB, SAME payer, different member ID is flagged for human review", async () => {
  const { svc } = wired();

  const first = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  assert.equal(collisionFlag(first.record), undefined, "the first visit has nothing to collide with");

  const second = await svc.create(visit("ZZZ99999", "Delta Dental"), NOW);

  const flag = collisionFlag(second.record);
  assert.ok(flag, "a second member ID at the same payer for one name and one birth date must be questioned");
  assert.equal(flag.severity, "critical");
  assert.match(flag.message, /ABC12345/, "the message names the member ID already on file");
  assert.match(flag.message, /ZZZ99999/, "and the one this visit presented");
  assert.equal(second.record.status, "needs_review", "critical routes to a human through the existing gate");
});

test("the collision is recorded on the audit trail, saying explicitly that nothing was merged", async () => {
  const { svc } = wired();
  await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const second = await svc.create(visit("ZZZ99999", "Delta Dental"), NOW);

  const entry = second.record.audit.find((a) => /identity collision/i.test(a.message));
  assert.ok(entry, "a human reading the record must be able to see why it was routed");
  assert.match(entry.message, /nothing was merged/i);
});

// ── 2. The false-positive guard — THE assertion that makes this usable ─────────────────

test("same name and DOB with a DIFFERENT payer is an insurance change, and is NOT flagged", async () => {
  const { svc } = wired();

  await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const second = await svc.create(visit("ZZZ99999", "Cigna"), NOW);

  assert.equal(
    collisionFlag(second.record),
    undefined,
    "one person who changed jobs is the ORDINARY case — flagging it would train staff to dismiss the warning"
  );
});

// ── 3. The returning patient ───────────────────────────────────────────────────────────

test("the same person returning on the same coverage is never flagged", async () => {
  const { svc, patients } = wired();

  const first = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const second = await svc.create(visit("ABC12345", "Delta Dental"), NOW);

  assert.equal(collisionFlag(second.record), undefined);
  assert.equal(
    second.record.patientId,
    first.record.patientId,
    "and the forward-only chart resolution is untouched — one person is still one row"
  );
  assert.equal((await patients.list()).length, 1);
});

// ── 4. payer_id persistence, through the real path ─────────────────────────────────────

test("the verification's payer travels to the coverage link, not just to the record", async () => {
  const { svc, patients } = wired();

  const view = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  assert.equal(view.record.payerId, "delta-dental", "the pipeline resolved the payer from the card");

  const links = await patients.coveragesFor(view.record.patientId!);
  assert.deepEqual(
    links,
    [{ memberId: "ABC12345", payerKey: "delta-dental", relationship: "self" }],
    "and it is stored ALONGSIDE the member ID — without this the detector has nothing to compare"
  );
});

test("a verification whose payer could not be resolved stores null, and flags nothing", async () => {
  const { svc, patients } = wired();

  // A card naming no payer Mermaid catalogues: `payerId` is null on the record.
  const unknown = await svc.create(visit("ABC12345", "Unlisted Mutual Dental"), NOW);
  assert.equal(unknown.record.payerId, null, "the fixture must genuinely produce an unresolved payer");

  const links = await patients.coveragesFor(unknown.record.patientId!);
  assert.deepEqual(links, [{ memberId: "ABC12345", payerKey: null, relationship: "self" }]);

  const second = await svc.create(visit("ZZZ99999", "Unlisted Mutual Dental"), NOW);
  assert.equal(
    collisionFlag(second.record),
    undefined,
    "two unknowns are not a match — an unresolved payer is no evidence in either direction"
  );
});

// ── 5. Existing NULL payer_id rows — the compatibility rule, on its own ────────────────

/**
 * ── THE EASY MISTAKE, ASSERTED SEPARATELY ──────────────────────────────────────────────────────
 * `coverages.payer_id` has been nullable since migration 0015 and was NEVER WRITTEN before M14, so
 * EVERY coverage row in every existing deployment carries null. If null compared equal to anything,
 * this control would flag every returning patient in the entire existing data set on their next
 * visit — a safety feature that becomes pure noise on first contact with real data.
 *
 * This is its own test and its own mutation. It is NOT covered by the different-payer case.
 */
test("a pre-M14 coverage row with NO payer on file is never treated as a match", async () => {
  const { svc, patients } = wired();

  const first = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const patientId = first.record.patientId!;

  // Exactly what an existing row looks like: linked before payer_id was ever written.
  await patients.linkCoverage(patientId, "LEGACY-0001", null);
  assert.deepEqual(
    (await patients.coveragesFor(patientId)).find((l) => l.memberId === "LEGACY-0001"),
    { memberId: "LEGACY-0001", payerKey: null, relationship: "self" }
  );

  const second = await svc.create(visit("LEGACY-0002", "Guardian"), NOW);
  assert.equal(
    collisionFlag(second.record),
    undefined,
    "null means UNKNOWN payer, never 'matches every payer' — otherwise every legacy row flags"
  );
});

test("the detector refuses a null stored payer even when the incoming payer is known", () => {
  // The unit-level statement of the same rule, so the reason is pinned and not merely the outcome.
  assert.equal(
    detectIdentityCollision([{ memberId: "OLD-1", payerKey: null }], { memberId: "NEW-1", payerKey: "delta-dental" }),
    null
  );
  assert.equal(
    detectIdentityCollision([{ memberId: "OLD-1", payerKey: "delta-dental" }], { memberId: "NEW-1", payerKey: null }),
    null,
    "and symmetrically, an unknown INCOMING payer establishes nothing either"
  );
  assert.deepEqual(
    detectIdentityCollision(
      [{ memberId: "OLD-1", payerKey: "delta-dental" }],
      { memberId: "NEW-1", payerKey: "delta-dental" }
    ),
    { memberId: "OLD-1", payerKey: "delta-dental" },
    "the positive case, so the two nulls above are proven to be the reason and not an accident"
  );
});

/**
 * ── THE ROUTINE CASE MUST NOT FIRE THE CONTROL ─────────────────────────────────────────────────
 * Member IDs were compared exactly as typed. The stored one is whatever the front desk entered at a
 * previous check-in and the incoming one is whatever they entered today, so one policy typed
 * `ABC-12345` once and `abc12345` the next time raised a CRITICAL "two different people resolve to
 * one chart" flag on an ordinary returning patient — and routed a clean verification to human
 * review. `pipeline.ts` folds exactly this away before its own mismatch check, and says why: a flag
 * that fires on the routine case is one staff clear by reflex, and then they clear the real one too.
 */
test("the same member ID typed with and without punctuation is one person, not a collision", () => {
  const onFile = [{ memberId: "ABC-12345", payerKey: "delta-dental" }];

  for (const typedToday of ["abc12345", "ABC12345", "abc-12345", " ABC 12345 "]) {
    assert.equal(
      detectIdentityCollision(onFile, { memberId: typedToday, payerKey: "delta-dental" }),
      null,
      `"${typedToday}" is the same policy as "ABC-12345" — flagging it teaches staff to dismiss this control`
    );
  }

  // …and the control it exists for is untouched: a genuinely different id at the same payer fires.
  assert.deepEqual(
    detectIdentityCollision(onFile, { memberId: "ZZZ99999", payerKey: "delta-dental" }),
    { memberId: "ABC-12345", payerKey: "delta-dental" },
    "two distinct member IDs at one payer for one name and birth date are still two people"
  );
});

// ── 6. No financial mutation — the collision is a QUESTION, not a correction ───────────

test("flagging a collision changes no identity, no chart, and no money", async () => {
  const { svc, patients } = wired();

  const first = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const patientBefore = await patients.findById(first.record.patientId!);
  const chartBefore = patientBefore!.chartId;

  const second = await svc.create(visit("ZZZ99999", "Delta Dental"), NOW);
  assert.ok(collisionFlag(second.record), "the fixture must actually collide, or this proves nothing");

  // 1. No merge and no unmerge: still exactly one chart, and it is the same one.
  const all = await patients.list();
  assert.equal(all.length, 1, "the collision does not split the chart — that is a human's decision");
  assert.equal(all[0]!.chartId, chartBefore, "nor is it re-keyed");
  assert.equal(all[0]!.id, patientBefore!.id);

  // 2. The chart id derivation is untouched by any of this.
  assert.equal(chartBefore, deriveChartId({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01" }));

  // 3. No patient reassignment: the second verification still points at the resolved chart, and
  //    the FIRST verification is not retroactively moved, rewritten or invalidated.
  assert.equal(second.record.patientId, first.record.patientId!);
  const firstAgain = await svc.get(first.record.id, NOW);
  assert.equal(firstAgain!.record.status, first.record.status, "the earlier record is not re-statused");
  assert.equal(collisionFlag(firstAgain!.record), undefined, "nor retro-flagged");

  // 4. The coverage mapping is RECORDED, not reassigned — both member IDs resolve to the chart,
  //    which is what makes the money that arrives under either one findable at all.
  assert.deepEqual(
    (await patients.coveragesFor(first.record.patientId!)).map((l) => l.memberId).sort(),
    ["ABC12345", "ZZZ99999"]
  );

  // 5. No automatic financial correction: the estimate on the flagged record is the one the
  //    pipeline computed, untouched by the flag.
  assert.ok(second.record.calculation, "the collision must not blank the estimate");
  assert.equal(second.record.calculation.totalFee, first.record.calculation!.totalFee);
});

test("a collision adds an exception and never substitutes for the ones the pipeline raised", async () => {
  const { svc } = wired();
  const first = await svc.create(visit("ABC12345", "Delta Dental"), NOW);
  const second = await svc.create(visit("ZZZ99999", "Delta Dental"), NOW);

  assert.equal(second.record.status, "needs_review");
  for (const e of first.record.exceptions) {
    assert.ok(
      second.record.exceptions.some((x) => x.code === e.code),
      `the pipeline's ${e.code} must not be dropped when the collision flag is added`
    );
  }
});
