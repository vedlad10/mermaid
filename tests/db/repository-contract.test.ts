/**
 * Repository contract — the same spec, run against BOTH implementations of each interface.
 *
 * ── THE TRAP THIS CLOSES ───────────────────────────────────────────────────────────────────────
 * Every repository in this system exists twice: an in-memory implementation (the laptop demo, and
 * the whole database-free business suite) and a Postgres one (production). They sit behind one
 * interface, and nothing until now checked that they MEAN THE SAME THING.
 *
 * They already diverged once. At M10 the `openOnly` filter was written out longhand in both places
 * and the two lists drifted, so the Today queue showed one set of claims in the demo and a
 * different set in production. Every test was green throughout: the in-memory suite tested the
 * in-memory list, the live-database suite tested the SQL, and neither compared them. That is not an
 * oversight anyone would repeat deliberately — it is the shape of the trap. Two implementations of
 * one interface, each tested against its own idea of the answer.
 *
 * So this file does the one thing those suites structurally cannot: seeds identical data into both
 * backends, asks both the same questions, and asserts the answers are identical. It is deliberately
 * indifferent to WHAT the right answer is — `openOnly` can mean whatever the module decides, as
 * long as it means the same thing twice. That keeps this suite from becoming a second, competing
 * definition of the domain that itself has to be maintained.
 *
 * Four filters share the drifting shape (`openOnly` / `withBalanceOnly`), which is why they are the
 * ones covered here.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { withPractice } from "@mermaid/db";
import {
  InMemoryVerificationRepository,
  PgVerificationRepository,
  type VerificationFilter,
  type VerificationRepository,
} from "@mermaid/verification";
import {
  InMemoryClaimRepository,
  PgClaimRepository,
  type ClaimFilter,
  type ClaimRepository,
} from "@mermaid/claims";
import {
  InMemoryRemittanceRepository,
  PgRemittanceRepository,
  type RemittanceRepository,
} from "@mermaid/remittance";
import {
  InMemoryPaymentMethodRepository,
  PgPaymentMethodRepository,
  type PaymentMethodObservation,
  type PaymentMethodRepository,
  InMemoryAllowedVarianceRepository,
  PgAllowedVarianceRepository,
  type AllowedVarianceRepository,
  InMemoryStatutoryClockRepository,
  PgStatutoryClockRepository,
  toStored,
  type StatutoryClockRepository,
} from "@mermaid/payer-profile";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];

after(async () => {
  await dropPractices(...created);
  await shutdown();
});

async function practice(name: string): Promise<string> {
  const id = await makePractice(name);
  created.push(id);
  return id;
}

/**
 * Compare two implementations over a list of filters.
 *
 * Ids only, and as a SET: ordering is a separate contract (both sort newest-first) and comparing
 * whole records here would fail on incidental representation differences — a Date versus its ISO
 * string — that say nothing about whether the filter agrees.
 */
async function assertSameSelection<F>(
  label: string,
  filters: { name: string; filter: F | undefined }[],
  runA: (f: F | undefined) => Promise<{ id: string }[]>,
  runB: (f: F | undefined) => Promise<{ id: string }[]>
): Promise<void> {
  for (const { name, filter } of filters) {
    const [a, b] = await Promise.all([runA(filter), runB(filter)]);
    const idsA = [...a.map((r) => r.id)].sort();
    const idsB = [...b.map((r) => r.id)].sort();
    assert.deepEqual(
      idsB,
      idsA,
      `${label}: the in-memory and Postgres repositories disagree about "${name}" — ` +
        `in-memory returned ${idsA.length} row(s), Postgres ${idsB.length}. ` +
        `A filter that means two different things is how the demo and production show different work.`
    );
  }
}

// ── Verifications ──────────────────────────────────────────────────────────────────────────────

test("verification list filters mean the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-verifications");

  const memory: VerificationRepository = new InMemoryVerificationRepository();
  const postgres: VerificationRepository = new PgVerificationRepository();

  // One record per status, plus the case the M8 fix turned on: a `failed` verification a human has
  // already REJECTED is finished work, while a `failed` one nobody has looked at still needs a person.
  const records = [
    { status: "verified" as const, review: null },
    { status: "needs_review" as const, review: null },
    { status: "failed" as const, review: null },
    { status: "failed" as const, review: { decision: "rejected" as const, notes: "unusable", reviewedAt: new Date().toISOString(), reviewedBy: "coordinator@clinic" } },
  ];

  await withPractice(practiceId, async () => {
    for (const [i, spec] of records.entries()) {
      const record = {
        id: crypto.randomUUID(),
        createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        status: spec.status,
        patient: { firstName: "Ada", lastName: `Alpha${i}`, dateOfBirth: "1990-04-12", memberId: `M${i}` },
        card: { payerName: { value: "MetLife Dental", confidence: 1 }, memberId: { value: `M${i}`, confidence: 1 } },
        payer: { payerId: "metlife-dental", payerName: "MetLife Dental", confidence: 1, explanation: "" },
        benefits: null,
        calculation: null,
        exceptions: [],
        confidence: { overall: 0.9, components: [], reviewThreshold: 0.75 },
        review: spec.review,
        audit: [],
        planItems: [],
      } as unknown as Parameters<VerificationRepository["save"]>[0];

      await memory.save(record);
      await postgres.save(record);
    }

    const filters: { name: string; filter: VerificationFilter | undefined }[] = [
      { name: "no filter", filter: undefined },
      { name: "openOnly", filter: { openOnly: true } },
      { name: "status=verified", filter: { status: "verified" } },
      { name: "status=needs_review", filter: { status: "needs_review" } },
      { name: "status=failed", filter: { status: "failed" } },
      { name: "status=failed + openOnly", filter: { status: "failed", openOnly: true } },
    ];

    await assertSameSelection(
      "VerificationRepository.list",
      filters,
      (f) => memory.list(f),
      (f) => postgres.list(f)
    );
  });
});

// ── Claims ─────────────────────────────────────────────────────────────────────────────────────

test("claim list filters mean the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-claims");

  const memory: ClaimRepository = new InMemoryClaimRepository();
  const postgres: ClaimRepository = new PgClaimRepository();

  // Every status the lifecycle can hold, so `openOnly` is exercised across the whole range rather
  // than the two or three a happy-path fixture happens to produce. This is the exact filter that
  // drifted at M10.
  //
  // Taken from the module's own union rather than written out here: a hand-copied list in a test
  // whose entire subject is hand-copied lists drifting would be a poor joke, and a new status added
  // tomorrow must be covered automatically rather than silently skipped.
  const { CLAIM_STATUSES } = await import("@mermaid/claims");
  const statuses: readonly string[] = CLAIM_STATUSES;

  await withPractice(practiceId, async () => {
    for (const [i, status] of statuses.entries()) {
      const stamp = new Date(Date.UTC(2026, 0, i + 1)).toISOString();
      const claim = {
        id: crypto.randomUUID(),
        verificationId: crypto.randomUUID(),
        createdAt: stamp,
        updatedAt: stamp,
        status,
        patient: { firstName: "Ada", lastName: `Alpha${i}`, dateOfBirth: "1990-04-12", memberId: `M${i}` },
        payer: { payerId: "metlife-dental", payerName: "MetLife Dental" },
        serviceDate: "2026-01-15",
        filingDeadline: "2027-01-15",
        lines: [],
        totalFee: 0,
        expectedInsurancePays: 0,
        expectedPatientPays: 0,
        coverageSnapshot: { snapshot_version: 1 },
        scrub: null,
        submission: null,
        payments: [],
        voidReason: null,
        audit: [],
      } as unknown as Parameters<ClaimRepository["save"]>[0];

      await memory.save(claim);
      await postgres.save(claim);
    }

    const filters: { name: string; filter: ClaimFilter | undefined }[] = [
      { name: "no filter", filter: undefined },
      { name: "openOnly", filter: { openOnly: true } },
      ...statuses.map((s) => ({ name: `status=${s}`, filter: { status: s } as ClaimFilter })),
      { name: "status=paid + openOnly", filter: { status: "paid", openOnly: true } as ClaimFilter },
    ];

    await assertSameSelection(
      "ClaimRepository.list",
      filters,
      (f) => memory.list(f),
      (f) => postgres.list(f)
    );
  });
});

// ── The property that makes the above hold by construction ─────────────────────────────────────

test("both claim repositories derive openOnly from the SAME exported constant", dbTest, async () => {
  const { OPEN_STATUSES } = await import("@mermaid/claims");

  assert.ok(Array.isArray(OPEN_STATUSES) && OPEN_STATUSES.length > 0, "OPEN_STATUSES must be exported and non-empty");

  // The M10 fix was not "make the two lists match" — it was "stop there being two lists". This
  // asserts the structural property rather than the behavioural symptom, because a shared constant
  // cannot drift, whereas two matching copies can drift again tomorrow.
  const { readFileSync } = await import("node:fs");
  for (const file of ["modules/claims/src/repository.ts", "modules/claims/src/repository.pg.ts"]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(
      source,
      /import\s*\{[^}]*OPEN_STATUSES[^}]*\}\s*from\s*["']\.\/engine\/status\.ts["']/,
      `${file} must import OPEN_STATUSES rather than restating it — two copies of one list is how they drifted`
    );
  }
});

// ── The patient master ─────────────────────────────────────────────────────────────────────────

test("the patient directory resolves identity identically in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-patients");

  const { InMemoryPatientDirectory, PgPatientDirectory, deriveChartId } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();

  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const typedDifferently = { firstName: "  ada ", lastName: "ALPHA", dateOfBirth: "1990-04-12" };
  const child = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "2016-04-12" };

  await withPractice(practiceId, async () => {
    for (const identity of [ada, typedDifferently, child]) {
      const a = await memory.ensure(identity);
      const b = await postgres.ensure(identity);
      assert.equal(b.chartId, a.chartId, "both directories must derive the same chart id");
      assert.equal(b.chartId, deriveChartId(identity));
    }

    // The property the whole patient master exists for, proven against the real unique constraint:
    // the same human arriving twice is one row, and a `ON CONFLICT` that failed to arbitrate would
    // show up here as two.
    const inMemory = await memory.list();
    const inPostgres = await postgres.list();
    assert.equal(inMemory.length, 2, "Ada and her child — the repeated spelling is not a third person");
    assert.equal(inPostgres.length, 2, "Postgres must agree, via UNIQUE (practice_id, chart_id)");

    assert.deepEqual(
      inPostgres.map((p) => p.chartId).sort(),
      inMemory.map((p) => p.chartId).sort()
    );
  });
});

/**
 * The reads M14 deliverable 4 added — one `LIKE` in SQL against one `includes()` in TypeScript.
 *
 * This is precisely the shape that drifted at M10: two implementations of one filter, each correct
 * on its own terms, disagreeing about an edge. The consequence here is a front desk that can find a
 * patient on the laptop demo and cannot find them in production, or vice versa.
 */
test("the directory searches, and refuses wildcards, identically in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-directory");

  const { InMemoryPatientDirectory, PgPatientDirectory, deriveChartId } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();

  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const ben = { firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03" };

  await withPractice(practiceId, async () => {
    for (const identity of [ada, ben]) {
      await memory.ensure(identity);
      await postgres.ensure(identity);
    }

    const both = async (query?: string) => {
      const a = (await memory.list(query)).map((p) => p.chartId).sort();
      const b = (await postgres.list(query)).map((p) => p.chartId).sort();
      assert.deepEqual(b, a, `the two directories disagree on list(${JSON.stringify(query)})`);
      return a;
    };

    assert.deepEqual(await both("alpha"), [deriveChartId(ada)], "surname, case-insensitively");
    assert.deepEqual(await both("Ada"), [deriveChartId(ada)], "given name");
    assert.deepEqual(await both(deriveChartId(ben)), [deriveChartId(ben)], "chart id");
    assert.deepEqual(await both("nobodyhere"), []);
    assert.equal((await both(undefined)).length, 2, "no query is everyone, in both");

    /**
     * A wildcard supplied by the caller must be a LITERAL, not a pattern. Otherwise a search box is
     * a way to ask for every row in the table — a full scan wearing a search's clothes — and the two
     * implementations would disagree about it, since `includes("%")` was never a wildcard.
     */
    for (const wildcard of ["%", "_", "%%", "a%a"]) {
      assert.deepEqual(await both(wildcard), [], `"${wildcard}" must match nothing, in both`);
    }
  });
});

/**
 * `memberIdsFor` is the join key the entire patient record hangs on: get it wrong in one
 * implementation and that person's claims, denials and balance are assembled from a different set of
 * accounts than the other implementation would have used.
 */
test("member IDs come back in the same order from both directories", dbTest, async () => {
  const practiceId = await practice("contract-members");

  const { InMemoryPatientDirectory, PgPatientDirectory } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

  await withPractice(practiceId, async () => {
    const a = await memory.ensure(ada);
    const b = await postgres.ensure(ada);

    // Linked out of order on purpose — a sorted answer must be the repository's doing, not the
    // caller's luck with insertion order.
    for (const memberId of ["MET30001", "ABC12345", "ZZZ00009"]) {
      await memory.linkCoverage(a.id, memberId);
      await postgres.linkCoverage(b.id, memberId);
    }

    const expected = ["ABC12345", "MET30001", "ZZZ00009"];
    assert.deepEqual(await memory.memberIdsFor(a.id), expected);
    assert.deepEqual(await postgres.memberIdsFor(b.id), expected);

    // A patient with no coverage on file is an empty list, never everything.
    assert.deepEqual(await memory.memberIdsFor(crypto.randomUUID()), []);
    assert.deepEqual(await postgres.memberIdsFor(crypto.randomUUID()), []);
  });
});

/**
 * `coveragesFor` is the read the M14 collision detector decides on, and the two implementations
 * resolve the payer by completely different means: Postgres LEFT JOINs `payers` on the UUID foreign
 * key, the in-memory twin keeps the slug beside the member ID. If they disagree about what "unknown
 * payer" looks like, the detector flags in one deployment and stays silent in the other — and the
 * one that stays silent is the one running against real data.
 */
test("coveragesFor answers identically in both directories, nulls included", dbTest, async () => {
  const practiceId = await practice("contract-coverages");

  const { InMemoryPatientDirectory, PgPatientDirectory } = await import("@mermaid/verification");
  const { PgPlaybookRepository } = await import("@mermaid/payer-profile");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

  /**
   * Seeded HERE rather than relied on. `payers` is populated by `PayerProfileService` at wiring
   * time, not by a migration, so a test that assumed `delta-dental` was already in the table would
   * be asserting about whatever else had run against this database — the coupling that made the ERA
   * suite unreliable for a whole milestone.
   */
  await new PgPlaybookRepository().upsertPayer({
    slug: "delta-dental",
    name: "Delta Dental",
    filingWindowDays: 365,
    appealWindowDays: 180,
  });

  await withPractice(practiceId, async () => {
    const a = await memory.ensure(ada);
    const b = await postgres.ensure(ada);

    /**
     * A CATALOGUED payer and an explicitly absent one — the two cases both directories can answer,
     * and the two the detector actually decides on.
     *
     * An UNRESOLVABLE slug is deliberately not asserted here. Whether `no-such-payer` resolves is a
     * property of the `payers` table, which the in-memory twin does not have and cannot pretend to:
     * Postgres nulls it (the subselect finds no row), the double echoes it. That divergence is real
     * and is pinned in its own Postgres-only test below rather than papered over by teaching the
     * double about a table it does not own.
     */
    const links: [string, string | null][] = [
      ["ABC12345", "delta-dental"],
      ["MET30001", null],
    ];
    for (const [memberId, payerKey] of links) {
      await memory.linkCoverage(a.id, memberId, payerKey);
      await postgres.linkCoverage(b.id, memberId, payerKey);
    }

    const fromMemory = await memory.coveragesFor(a.id);
    const fromPostgres = await postgres.coveragesFor(b.id);
    assert.deepEqual(fromPostgres, fromMemory, "the two directories must answer the same question the same way");
    assert.deepEqual(fromPostgres, [
      { memberId: "ABC12345", payerKey: "delta-dental", relationship: "self" },
      { memberId: "MET30001", payerKey: null, relationship: "self" },
    ]);

    // Forward-only on the payer, in both: a later visit that could not name the payer must not
    // erase what an earlier one established. Same rule as the patient address (V2).
    await memory.linkCoverage(a.id, "ABC12345", null);
    await postgres.linkCoverage(b.id, "ABC12345", null);
    const keep = (links: { memberId: string; payerKey: string | null }[]) =>
      links.find((l) => l.memberId === "ABC12345")?.payerKey;
    assert.equal(keep(await memory.coveragesFor(a.id)), "delta-dental");
    assert.equal(keep(await postgres.coveragesFor(b.id)), "delta-dental", "and Postgres agrees");

    // A patient with no coverage is an empty list, never everything.
    assert.deepEqual(await memory.coveragesFor(crypto.randomUUID()), []);
    assert.deepEqual(await postgres.coveragesFor(crypto.randomUUID()), []);
  });
});

/**
 * A payer slug Mermaid cannot resolve reads back as UNKNOWN, not as a payer that matches itself.
 *
 * Postgres-only, and the reason is worth stating: the in-memory directory has no `payers` table, so
 * it echoes whatever slug it is handed. The two therefore genuinely diverge here — and the Postgres
 * behaviour is the one that matters, because it is the one the collision detector runs against in
 * any deployment holding real money.
 *
 * Why the null is the safe answer: `payerId` comes from the verification REGISTRY while `payers` is
 * seeded from `PAYER_CATALOG`, and those are two lists that can disagree. If an uncatalogued slug
 * were stored verbatim, two coverages carrying it would compare EQUAL and flag a collision on a
 * payer Mermaid cannot even name — a false positive built on an unknown.
 */
test("a payer slug with no row in `payers` is stored as unknown, not as itself", dbTest, async () => {
  const practiceId = await practice("contract-unknown-payer");
  const { PgPatientDirectory } = await import("@mermaid/verification");
  const directory = new PgPatientDirectory();

  await withPractice(practiceId, async () => {
    const patient = await directory.ensure({ firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" });
    await directory.linkCoverage(patient.id, "UNK-0001", "no-such-payer-anywhere");

    assert.deepEqual(await directory.coveragesFor(patient.id), [
      { memberId: "UNK-0001", payerKey: null, relationship: "self" },
    ]);
  });
});

test("a patient is scoped to its practice — the same person at two practices is two records", dbTest, async () => {
  const one = await practice("contract-patients-a");
  const two = await practice("contract-patients-b");
  const { PgPatientDirectory } = await import("@mermaid/verification");
  const directory = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

  const first = await withPractice(one, () => directory.ensure(ada));
  const second = await withPractice(two, () => directory.ensure(ada));

  // Same derived chart id — it is a function of the identity, not of the practice — but different
  // rows, because a chart is a practice's own record of a person, and RLS keeps them apart.
  assert.equal(second.chartId, first.chartId);
  assert.notEqual(second.id, first.id, "two practices must not share one patient row");

  const visibleToOne = await withPractice(one, () => directory.list());
  assert.equal(visibleToOne.length, 1, "each practice sees only its own patient");
});

/**
 * ── V2: the patient address must actually reach Postgres ────────────────────────────────────────
 *
 * Migration 0017 added the columns; for one commit `patients.pg.ts` neither read nor wrote them, so
 * the address rode the verification's JSONB document and the patient master stayed blank. A claim
 * still filed, which is exactly why nothing caught it: the defect was invisible from the claim path
 * and only showed up as a returning patient being asked for an address the practice already had.
 *
 * Both directories are asserted together because the in-memory twin is what every unit test runs
 * against — a merge rule that held in Postgres and not in memory would make the whole unit suite
 * lie about this behaviour.
 */
test("an address round-trips through both directories, and normalises on the way in", dbTest, async () => {
  const practiceId = await practice("contract-address");
  const { InMemoryPatientDirectory, PgPatientDirectory } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };

  // Typed the way a human types it: lowercase state, hyphenated ZIP, stray whitespace. The 837 and
  // the CHECK constraints both want `CA` and `900010000`.
  const asTyped = { street: "  1 SYNTHETIC TEST WAY ", city: "Springfield", state: "ca", zip: "90001-0000" };
  const stored = { street: "1 SYNTHETIC TEST WAY", city: "Springfield", state: "CA", zip: "900010000" };

  await withPractice(practiceId, async () => {
    const a = await memory.ensure(ada, { address: asTyped, gender: "F" });
    const b = await postgres.ensure(ada, { address: asTyped, gender: "F" });

    assert.deepEqual(a.address, stored, "in-memory must normalise identically");
    assert.deepEqual(b.address, stored, "the address must survive the round trip through Postgres");
    assert.equal(a.gender, "F");
    assert.equal(b.gender, "F");

    // And it must still be there when the row is fetched fresh, not merely echoed by RETURNING.
    const refetched = await postgres.findById(b.id);
    assert.deepEqual(refetched?.address, stored, "the address must be readable on a later request");
    assert.deepEqual((await postgres.list())[0]?.address, stored, "the directory listing carries it too");
  });
});

/**
 * The rule that protects real data: an upsert merges FORWARD ONLY.
 *
 * A repeat visit that collected no address must not erase the one on file. Get this backwards and
 * the failure is quiet and expensive — the patient master empties out one visit at a time, and the
 * only symptom is claims blocking at the submit gate for a fact the practice used to hold.
 */
test("a later visit without an address does not erase the address already on file", dbTest, async () => {
  const practiceId = await practice("contract-address-merge");
  const { InMemoryPatientDirectory, PgPatientDirectory } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const first = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" };
  const moved = { street: "2 SYNTHETIC TEST WAY", city: "SHELBYVILLE", state: "OR", zip: "970010000" };

  await withPractice(practiceId, async () => {
    await memory.ensure(ada, { address: first });
    await postgres.ensure(ada, { address: first });

    // Visit two: no address collected at all.
    const m2 = await memory.ensure(ada);
    const p2 = await postgres.ensure(ada);
    assert.deepEqual(m2.address, first, "in-memory must preserve on silence");
    assert.deepEqual(p2.address, first, "Postgres must preserve on silence — this is the COALESCE");

    // Visit three: an INCOMPLETE address. Half an address is not an address, so it must preserve
    // rather than stitch a new street onto the old city — which would produce a real place that is
    // nobody's home and put it on a claim.
    const partial = { street: "3 SYNTHETIC TEST WAY", city: "", state: "CA", zip: "900010000" };
    assert.deepEqual((await memory.ensure(ada, { address: partial })).address, first);
    assert.deepEqual((await postgres.ensure(ada, { address: partial })).address, first);

    // Visit four: the patient moved and said so. A collected address always wins — preserving here
    // would be the opposite defect, pinning a patient to an address they have left.
    assert.deepEqual((await memory.ensure(ada, { address: moved })).address, moved);
    assert.deepEqual((await postgres.ensure(ada, { address: moved })).address, moved);
    assert.deepEqual((await postgres.findById(p2.id))?.address, moved, "the move is durable");
  });
});

/**
 * ── V5: correcting an address must behave identically in both directories ───────────────────────
 *
 * `updateAddress` is the ONLY path that can clear an address, so the two implementations disagreeing
 * would be invisible in unit tests (which run against memory) and only show up in production. The
 * asymmetry with `ensure` is the whole design and is asserted here directly: check-in silence
 * preserves, a deliberate correction replaces or clears.
 */
test("an address correction replaces, clears and refuses identically in both directories", dbTest, async () => {
  const practiceId = await practice("contract-address-correct");
  const { InMemoryPatientDirectory, PgPatientDirectory } = await import("@mermaid/verification");
  const memory = new InMemoryPatientDirectory();
  const postgres = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const first = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" };
  const moved = { street: "2 SYNTHETIC TEST WAY", city: "SHELBYVILLE", state: "OR", zip: "970010000" };

  await withPractice(practiceId, async () => {
    const a = await memory.ensure(ada, { address: first });
    const b = await postgres.ensure(ada, { address: first });

    // Replace.
    assert.deepEqual((await memory.updateAddress(a.id, moved))?.address, moved);
    assert.deepEqual((await postgres.updateAddress(b.id, moved))?.address, moved);
    assert.deepEqual((await postgres.findById(b.id))?.address, moved, "durable in Postgres");

    // Normalise on the way in — hyphenated ZIP, lowercase state.
    const typed = { street: "3 SYNTHETIC TEST WAY", city: "Ogdenville", state: "or", zip: "97001-0000" };
    const stored = { street: "3 SYNTHETIC TEST WAY", city: "Ogdenville", state: "OR", zip: "970010000" };
    assert.deepEqual((await memory.updateAddress(a.id, typed))?.address, stored);
    assert.deepEqual((await postgres.updateAddress(b.id, typed))?.address, stored);

    // Clear — the capability `ensure` cannot express at any price.
    assert.equal((await memory.updateAddress(a.id, null))?.address, undefined);
    assert.equal((await postgres.updateAddress(b.id, null))?.address, undefined);
    assert.equal((await postgres.findById(b.id))?.address, undefined, "the clear is durable too");

    // …and a cleared address is genuinely gone, so `ensure` can put one back on the next visit.
    assert.deepEqual((await postgres.ensure(ada, { address: first }))?.address, first);

    // A partial correction is refused by BOTH, loudly, rather than half-written.
    const partial = { street: "4 SYNTHETIC TEST WAY", city: "", state: "CA", zip: "900010000" };
    await assert.rejects(() => memory.updateAddress(a.id, partial), /street, city, state and ZIP/);
    await assert.rejects(() => postgres.updateAddress(b.id, partial), /street, city, state and ZIP/);
    assert.deepEqual((await postgres.findById(b.id))?.address, first, "the refusal left the row intact");

    // An unknown id is null in both, never a newly created row.
    assert.equal(await memory.updateAddress(crypto.randomUUID(), first), null);
    assert.equal(await postgres.updateAddress(crypto.randomUUID(), first), null);
  });
});

/**
 * A correction must not leak across tenants.
 *
 * `updateAddress` carries no practice predicate — RLS supplies it. That is the same rule every
 * repository here follows, and it is the one worth proving rather than assuming, because the failure
 * would be one practice silently rewriting another's patient record.
 */
test("one practice cannot correct another practice's patient address", dbTest, async () => {
  const one = await practice("contract-address-tenant-a");
  const two = await practice("contract-address-tenant-b");
  const { PgPatientDirectory } = await import("@mermaid/verification");
  const directory = new PgPatientDirectory();
  const ada = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  const mine = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" };
  const theirs = { street: "999 SYNTHETIC INTRUDER WAY", city: "SHELBYVILLE", state: "OR", zip: "970010000" };

  const owned = await withPractice(one, () => directory.ensure(ada, { address: mine }));

  // Practice two holds a real patient id and still cannot touch it — indistinguishable from a row
  // that does not exist, which is the correct answer for a caller who must not learn otherwise.
  const attempt = await withPractice(two, () => directory.updateAddress(owned.id, theirs));
  assert.equal(attempt, null, "another tenant's patient must not resolve");

  const after = await withPractice(one, () => directory.findById(owned.id));
  assert.deepEqual(after?.address, mine, "the owning practice's record is untouched");
});

// ── Held remittances ───────────────────────────────────────────────────────────────────────────

/**
 * `heldSummary` is a NEW aggregate, written twice — a `reduce` over a Map in memory, and a
 * `COUNT`/`MIN`/`SUM` in Postgres. That is exactly the shape this file exists for: two
 * implementations of one interface, each perfectly correct against its own idea of the answer.
 *
 * The empty case is asserted as hard as the populated one. Both sides must answer
 * `{0, null, 0}` — not `{0, undefined, 0}`, not a `MIN` of NULL leaking through as the string
 * "null". A monitor reads this on a threshold of zero, so the shape of "nothing is held" is
 * load-bearing: anything truthy in `oldestReceivedAt` would compute an age from the epoch and
 * announce a forty-year-old hold on a practice that has none.
 */
test("the held-money summary means the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-held-summary");

  const memory: RemittanceRepository = new InMemoryRemittanceRepository();
  const postgres: RemittanceRepository = new PgRemittanceRepository();

  const remittance = (id: string, status: "held" | "posted", receivedAt: string, totalCents: number) => ({
    id,
    traceNumber: `TRN-${id}`,
    dedupeKey: `delta-dental|TRN-${id}`,
    receivedAt,
    status,
    payerName: "Delta Dental",
    payeeName: "MERMAID DEMO DENTAL",
    paymentTotal: totalCents,
    paymentMethod: "ACH",
    paymentDate: "2026-09-01",
    balanced: true,
    issues: [],
    holdReason: status === "held" ? "coordination of benefits" : null,
    postings: [],
    providerAdjustments: [],
    raw835: null,
    audit: [],
  }) as unknown as Parameters<RemittanceRepository["save"]>[0];

  await withPractice(practiceId, async () => {
    const empty = await Promise.all([memory.heldSummary(), postgres.heldSummary()]);
    assert.deepEqual(
      empty[1],
      empty[0],
      "with nothing held the two must agree exactly — including that the oldest is null, not absent"
    );
    assert.deepEqual(empty[0], { count: 0, oldestReceivedAt: null, totalCents: 0 });

    // Real UUIDs: `remittances.id` is a uuid column, so a readable string id fails at the driver
    // before any assertion runs — a test that dies on its own fixture proves nothing about either
    // implementation, and it looks exactly like a caught defect while doing so.
    for (const spec of [
      { label: "held-newer", status: "held" as const, at: "2026-09-05T00:00:00.000Z", cents: 25_000 },
      { label: "held-older", status: "held" as const, at: "2026-09-01T00:00:00.000Z", cents: 60_000 },
      { label: "already-posted", status: "posted" as const, at: "2026-08-01T00:00:00.000Z", cents: 90_000 },
    ]) {
      const record = remittance(crypto.randomUUID(), spec.status, spec.at, spec.cents);
      await memory.save(record);
      await postgres.save(record);
    }

    const [a, b] = await Promise.all([memory.heldSummary(), postgres.heldSummary()]);
    assert.deepEqual(
      b,
      a,
      "the in-memory and Postgres summaries disagree — a monitor reading one and a demo reading the " +
        "other would tell two different stories about the same stopped money"
    );
    assert.equal(a.count, 2, "posted money is not held money");
    assert.equal(a.totalCents, 85_000, "and the total is the held rows only");
    assert.equal(
      a.oldestReceivedAt,
      "2026-09-01T00:00:00.000Z",
      "the OLDEST, not the newest — the age of the pile is what the alert is about"
    );
  });
});

/**
 * `priorPaymentMethod` decides whether a practice is TOLD its payer has started charging it to be
 * paid, so the two implementations disagreeing is not an abstract risk: one of them is a `sort` over
 * a Map and the other is `ORDER BY ... LIMIT 1`, and the three ways they could quietly differ —
 * ordering, case folding, and which row is excluded — are each a silent wrong answer rather than an
 * error anyone would see.
 *
 * The case-folding one is the subtlest. A payer that prints "Delta Dental" one month and
 * "DELTA DENTAL " the next has not become a different payer, and an implementation that thinks it
 * has reports every advice as a first sighting and never as a reversion — the feature's whole point,
 * silently absent, with every test green.
 */
test("priorPaymentMethod means the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-prior-payment-method");

  const memory: RemittanceRepository = new InMemoryRemittanceRepository();
  const postgres: RemittanceRepository = new PgRemittanceRepository();

  const remittance = (id: string, payerName: string, method: string, receivedAt: string) => ({
    id,
    traceNumber: `TRN-${id.slice(0, 8)}`,
    dedupeKey: `${payerName.trim().toUpperCase()}|TRN-${id.slice(0, 8)}`,
    receivedAt,
    status: "posted",
    payerName,
    payeeName: "MERMAID DEMO DENTAL",
    paymentTotal: 65_000,
    paymentMethod: method,
    paymentDate: receivedAt.slice(0, 10),
    balanced: true,
    issues: [],
    holdReason: null,
    postings: [],
    providerAdjustments: [],
    raw835: null,
    audit: [],
  }) as unknown as Parameters<RemittanceRepository["save"]>[0];

  const olderId = crypto.randomUUID();
  const newerId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  const absentId = crypto.randomUUID();

  await withPractice(practiceId, async () => {
    const both = async (payer: string, excluding: string) =>
      Promise.all([memory.priorPaymentMethod(payer, excluding), postgres.priorPaymentMethod(payer, excluding)]);

    // Nothing on file yet: both must say "no previous payment", not "" and not a throw.
    const [emptyMem, emptyPg] = await both("Delta Dental", absentId);
    assert.equal(emptyPg, emptyMem, "an unknown payer must answer identically in both");
    assert.equal(emptyMem, null, "null means no previous payment — the safe reading, a first sighting");

    for (const record of [
      remittance(olderId, "Delta Dental", "ACH", "2026-08-01T00:00:00.000Z"),
      // Deliberately messy: same payer, different casing AND surrounding whitespace.
      remittance(newerId, "  delta dental  ", "CHK", "2026-09-01T00:00:00.000Z"),
      // A different payer, paying most recently of all — must never be returned for Delta.
      remittance(foreignId, "MetLife Dental", "FWT", "2026-09-10T00:00:00.000Z"),
    ]) {
      await memory.save(record);
      await postgres.save(record);
    }

    // ── Ordering + case-insensitive match ──
    const [latestMem, latestPg] = await both("Delta Dental", absentId);
    assert.equal(latestPg, latestMem, "the two repositories disagree about this payer's last method");
    assert.equal(latestMem, "CHK", "the most recently RECEIVED Delta payment, matched across casing and padding");
    assert.notEqual(latestMem, "FWT", "another payer's payment is not this payer's history");

    // ── Exclusion: skipping the newest falls through to the one before it ──
    const [priorMem, priorPg] = await both("DELTA DENTAL", newerId);
    assert.equal(priorPg, priorMem, "the two repositories disagree once the current row is excluded");
    assert.equal(
      priorMem,
      "ACH",
      "excluding the row being assessed must reveal the one before it — this is the ACH→non-ACH " +
        "reversion the whole observation exists to catch"
    );

    // ── A payer with no history at all, now that the table is populated ──
    const [unknownMem, unknownPg] = await both("Cigna Dental", absentId);
    assert.equal(unknownPg, unknownMem);
    assert.equal(unknownMem, null, "a payer we have never been paid by has no previous method");
  });
});

// ── Non-ACH payer payments ─────────────────────────────────────────────────────────────────────

/**
 * Both implementations fold rows into the per-payer view with the SAME exported function, so the
 * judgement in this feature — what a fee total means when some payments could not be priced — cannot
 * drift between them by construction.
 *
 * What can still drift is everything around it: whether the Postgres upsert actually makes a
 * redelivered observation one payment rather than two, and whether a NULL fee survives the round
 * trip as null rather than arriving as 0. The second is the quiet one. A fee of zero asserts these
 * payments cost nothing; null says nobody has recorded what they cost, and a practice reading the
 * first would conclude its card-paying payers are free.
 */
test("non-ACH payment observations mean the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-payment-methods");

  const memory: PaymentMethodRepository = new InMemoryPaymentMethodRepository();
  const postgres: PaymentMethodRepository = new PgPaymentMethodRepository();

  const observation = (over: Partial<PaymentMethodObservation> = {}): PaymentMethodObservation => ({
    remittanceId: crypto.randomUUID(),
    dedupeKey: "DELTA DENTAL|CHK-1",
    payerName: "Delta Dental",
    method: "CHK",
    paymentTotal: 65_000 as PaymentMethodObservation["paymentTotal"],
    feeCents: null,
    reverted: false,
    priorMethod: null,
    observedAt: "2026-08-10T09:00:00.000Z",
    ...over,
  });

  await withPractice(practiceId, async () => {
    const both = async () => Promise.all([memory.summary(), postgres.summary()]);

    const [emptyMem, emptyPg] = await both();
    assert.deepEqual(emptyPg, emptyMem, "with nothing observed the two must agree exactly");
    assert.deepEqual(emptyMem, [], "and an empty rollup is [], never a row asserting zero");

    const priced = observation({
      feeCents: 1_918 as PaymentMethodObservation["feeCents"],
      observedAt: "2026-08-01T00:00:00.000Z",
    });
    const unpriced = observation({ observedAt: "2026-09-01T00:00:00.000Z", reverted: true, priorMethod: "ACH" });
    for (const record of [priced, unpriced]) {
      await memory.record(record);
      await postgres.record(record);
    }

    const [a, b] = await both();
    assert.deepEqual(b, a, "the in-memory and Postgres rollups disagree about the same payments");
    assert.equal(a.length, 1, "one payer, one row");
    assert.equal(a[0]!.payments, 2);
    assert.equal(a[0]!.feeCents, 1_918, "the priced payment still totals");
    assert.equal(a[0]!.unpricedPayments, 1, "a NULL fee survived as unknown, not as zero");
    assert.equal(a[0]!.reverted, true);
    assert.equal(a[0]!.latestMethod, "CHK");

    // The idempotency both stores exist to guarantee: an at-least-once bus redelivering one payment.
    await memory.record(priced);
    await postgres.record(priced);
    const [againMem, againPg] = await both();
    assert.deepEqual(againPg, againMem);
    assert.equal(againMem[0]!.payments, 2, "a redelivered observation is not a third payment");
  });
});

/**
 * The rate history behind F2 — and the one property the whole feature rests on.
 *
 * Both implementations run the SAME fold, so their JUDGEMENT cannot drift; what can drift is what
 * survives the round trip. The Postgres store rewrites only the epochs that changed, and it writes
 * `allowed_cents` on insert and deliberately NOT on conflict — so an epoch's figure is physically
 * unable to be edited after it is written. That is the guarantee the feature exists for, and it is
 * expressible in exactly one place: here, against a real table.
 *
 * The rest is the ordinary round-trip surface, and each item is a silent wrong answer rather than an
 * error anyone would see: a `closed_at` that came back as a Date instead of an ISO string, an
 * `observed_payer_name` that arrived as "" instead of null (the leased-network test then compares
 * two empty strings and never fires), and a redelivered observation counting as a second sighting.
 */
test("rate epochs mean the same thing, and keep the same evidence, in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-allowed-variance");

  const memory: AllowedVarianceRepository = new InMemoryAllowedVarianceRepository();
  const postgres: AllowedVarianceRepository = new PgAllowedVarianceRepository();

  const CROWN = 112_500;
  const CUT = 98_000;
  const observe = (allowed: number, observedAt: string, over: Record<string, unknown> = {}) => ({
    remittanceId: crypto.randomUUID(),
    payerId: "delta-dental",
    cdtCode: "D2750",
    allowed: allowed as never,
    charged: 125_000 as never,
    observedAt,
    observedPayerName: "Delta Dental",
    ...over,
  });

  await withPractice(practiceId, async () => {
    const both = async (input: ReturnType<typeof observe>) =>
      Promise.all([memory.observe(input), postgres.observe(input)]);
    const histories = async () =>
      Promise.all([memory.history("delta-dental", "D2750"), postgres.history("delta-dental", "D2750")]);

    const [emptyMem, emptyPg] = await histories();
    assert.deepEqual(emptyPg, emptyMem, "with nothing observed the two must agree exactly");
    assert.deepEqual(emptyMem, [], "and an absent history is [], never a row asserting a rate of zero");

    const first = observe(CROWN, "2026-03-04T00:00:00.000Z");
    const [fMem, fPg] = await both(first);
    assert.deepEqual(fPg, fMem, "the first observation must report the same thing in both");
    assert.equal(fMem, null, "there is nothing to contradict, so there is nothing to report");

    const short = observe(CUT, "2026-08-19T00:00:00.000Z");
    const [sMem, sPg] = await both(short);
    assert.deepEqual(sPg, sMem, "the two stores disagree about the same shortfall");
    assert.equal(sMem!.classification, "line-underpayment");
    assert.equal(sMem!.delta, -14_500);

    const [hMem, hPg] = await histories();
    assert.deepEqual(hPg, hMem, "the two histories disagree after the same two observations");
    assert.equal(hMem.length, 2, "the differing rate opened a candidate rather than overwriting");
    assert.equal(hMem[0]!.status, "confirmed");
    assert.equal(hMem[0]!.allowed, CROWN, "the rate the payer agreed to is still the baseline");
    assert.equal(hMem[0]!.closedAt, null, "an open epoch has no close date — the CHECK constraint agrees");
    assert.equal(hMem[1]!.status, "candidate");
    assert.equal(hMem[1]!.observedPayerName, "Delta Dental", "a name, not an empty string");

    /**
     * Redelivery. The epoch fold is NOT idempotent by construction — a second sighting is
     * meaningful — so in production the per-subscriber checkpoint is what prevents this. Asserted
     * here in the negative on purpose: if a future change ever makes `observe` idempotent on the
     * remittance id, this is the test that has to be consciously rewritten rather than the
     * behaviour quietly diverging between the two stores.
     */
    await both(short);
    const [rMem, rPg] = await histories();
    assert.deepEqual(rPg, rMem, "if a replay counts twice, it must count twice IDENTICALLY in both");

    // Corroborated: the baseline moves and the old figure is closed, not edited.
    await both(observe(CUT, "2026-09-14T00:00:00.000Z"));
    const [pMem, pPg] = await histories();
    assert.deepEqual(pPg, pMem);
    assert.equal(pMem[0]!.status, "superseded");
    assert.equal(
      pMem[0]!.allowed,
      CROWN,
      "the superseded figure survived the write — this is the evidence an appeal is written from, " +
        "and a store that let it be edited would have destroyed it exactly when it became valuable"
    );
    assert.ok(pMem[0]!.closedAt !== null, "and it came back as a bounded period");
    assert.equal(pMem[0]!.closedAt, "2026-09-14T00:00:00.000Z", "as an ISO string, not a Date");
    assert.equal(pMem[1]!.status, "confirmed");
    assert.equal(pMem[1]!.allowed, CUT);

    const [fnMem, fnPg] = await Promise.all([memory.findings(), postgres.findings()]);
    assert.deepEqual(fnPg, fnMem, "the two finding lists disagree about the same advices");
    assert.equal(fnMem[0]!.classification, "schedule-drift", "most recent first");
    assert.equal(fnMem[0]!.recoverable, false);

    const [rcMem, rcPg] = await Promise.all([
      memory.findings({ recoverableOnly: true }),
      postgres.findings({ recoverableOnly: true }),
    ]);
    assert.deepEqual(rcPg, rcMem, "the worklist filter means two different things in the two stores");
    assert.ok(
      rcMem.every((f) => f.recoverable),
      "a downgrade or a raise in the worklist is a biller phoning a payer about money they were paid"
    );
  });
});

/**
 * The statutory clock's two stores (F5).
 *
 * Both run the same fold, so their JUDGEMENT cannot drift; what can drift is what survives the round
 * trip — and every item below is a silent wrong answer rather than an error anyone would see.
 *
 * A `paid_at` that came back as an instant instead of a calendar day moves a recoupment window by a
 * timezone, which decides disputes taken on the last day of it. A `defeasible_by` array that
 * arrived empty strips the ERISA caveat off a demand letter. And `recovered_cents` surviving a
 * redelivery is the difference between a savings report that matches the bank and one that does
 * not — the Postgres conflict clause deliberately does not touch it, and that omission is only
 * checkable here, against a real table.
 */
test("statutory clock findings mean the same thing in both repositories", dbTest, async () => {
  const practiceId = await practice("contract-statutory-clock");

  const memory: StatutoryClockRepository = new InMemoryStatutoryClockRepository();
  const postgres: StatutoryClockRepository = new PgStatutoryClockRepository();

  const REMITTANCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const finding = toStored(
    {
      kind: "prompt-pay-interest",
      elapsedDays: 60,
      allowedDays: 30,
      lateDays: 30,
      principal: 90_000 as never,
      interestCents: 888 as never,
      rateBps: 1200,
      citation: "N.J.S.A. 17B:30-51",
      source: "https://example.invalid/nj",
      verifiedOn: "2026-09-15",
      defeasibleBy: ["The plan is self-funded (ERISA).", "The claim was not clean."],
      action: "Confirm the plan is insured, then bill the payer.",
    },
    {
      remittanceId: REMITTANCE,
      subject: "MRM-000123",
      payerId: "delta-dental",
      payerName: "Delta Dental",
      state: "NJ",
      detectedAt: "2026-09-01T00:00:00.000Z",
    }
  );
  const key = { remittanceId: REMITTANCE, kind: "prompt-pay-interest" as const, subject: "MRM-000123" };

  await withPractice(practiceId, async () => {
    const both = async () => Promise.all([memory.findings(), postgres.findings()]);

    const [emptyMem, emptyPg] = await both();
    assert.deepEqual(emptyPg, emptyMem, "with nothing found the two must agree exactly");
    assert.deepEqual(emptyMem, [], "and an empty worklist is [], never a row asserting zero owed");

    const [zeroMem, zeroPg] = await Promise.all([memory.savings(), postgres.savings()]);
    assert.deepEqual(zeroPg, zeroMem);
    assert.equal(zeroMem.promptPay.findings, 0, "a report of zeroes, not an absent report");

    // ── The payment index the recoupment window is measured from ──────────────────────────────
    const payment = {
      patientControlNumber: "MRM-000123",
      payerId: "delta-dental",
      payerName: "Delta Dental",
      paidAt: "2026-01-05",
      paidCents: 90_000 as never,
      remittanceId: REMITTANCE,
    };
    await memory.recordPayment(payment);
    await postgres.recordPayment(payment);

    /**
     * A supplemental cheque on the same claim, months later. The FIRST payment is the one the
     * window runs from — overwriting would silently restart the clock and hand the payer months it
     * is not entitled to, a bug discoverable only by losing a dispute the practice should have won.
     */
    const later = { ...payment, paidAt: "2026-06-30", paidCents: 7_500 as never };
    await memory.recordPayment(later);
    await postgres.recordPayment(later);

    const [pMem, pPg] = await Promise.all([
      memory.paymentFor("MRM-000123"),
      postgres.paymentFor("MRM-000123"),
    ]);
    assert.deepEqual(pPg, pMem, "the two stores disagree about when this practice was paid");
    assert.equal(pMem!.paidAt, "2026-01-05", "a DATE, not an instant — a timezone must not move a window");
    assert.equal(pMem!.paidCents, 90_000);

    const [missMem, missPg] = await Promise.all([
      memory.paymentFor("MRM-999999"),
      postgres.paymentFor("MRM-999999"),
    ]);
    assert.deepEqual(missPg, missMem, "a claim never paid has no date, and null is the answer in both");
    assert.equal(missMem, null);

    // ── The finding ────────────────────────────────────────────────────────────────────────────
    await memory.record(finding);
    await postgres.record(finding);

    const [a, b] = await both();
    assert.deepEqual(b, a, "the two stores disagree about the same finding");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.claimedCents, 888);
    assert.equal(a[0]!.recoveredCents, 0, "detected is not collected");
    assert.equal(a[0]!.outcome, "open");
    assert.deepEqual(
      a[0]!.defeasibleBy,
      ["The plan is self-funded (ERISA).", "The claim was not clean."],
      "an empty array here strips the preemption caveat off a demand letter"
    );
    assert.deepEqual(
      a[0]!.evidence,
      { elapsedDays: 60, allowedDays: 30, lateDays: 30, principal: 90_000, rateBps: 1200 },
      "the working must survive JSONB intact, or the figure stops being re-derivable"
    );
    assert.equal(a[0]!.verifiedOn, "2026-09-15");

    // ── A person closes it, and a redelivery must not undo that ────────────────────────────────
    const [oMem, oPg] = await Promise.all([
      memory.recordOutcome(key, { outcome: "recovered", recoveredCents: 888 as never, note: "Paid in Nov." }),
      postgres.recordOutcome(key, { outcome: "recovered", recoveredCents: 888 as never, note: "Paid in Nov." }),
    ]);
    assert.deepEqual(oPg, oMem);
    assert.equal(oMem!.outcome, "recovered");

    await memory.record(finding);
    await postgres.record(finding);

    const [rMem, rPg] = await both();
    assert.deepEqual(rPg, rMem, "the two stores disagree about what a replay does to a closed finding");
    assert.equal(rMem.length, 1, "a redelivery is one finding, not a second demand");
    assert.equal(
      rMem[0]!.outcome,
      "recovered",
      "the conflict clause refreshes the arithmetic and must NOT reopen a dispute a person closed"
    );
    assert.equal(rMem[0]!.recoveredCents, 888);
    assert.equal(rMem[0]!.outcomeNote, "Paid in Nov.");

    const [sMem, sPg] = await Promise.all([memory.savings(), postgres.savings()]);
    assert.deepEqual(sPg, sMem, "the two savings reports disagree about the same findings");
    assert.equal(sMem.promptPay.claimedCents, 888, "claiming is unchanged by collecting");
    assert.equal(sMem.promptPay.recoveredCents, 888);
    assert.equal(sMem.recoupment.findings, 0);

    const [openMem, openPg] = await Promise.all([
      memory.findings({ openOnly: true }),
      postgres.findings({ openOnly: true }),
    ]);
    assert.deepEqual(openPg, openMem, "the worklist filter means two different things in the two stores");
    assert.deepEqual(openMem, []);

    const [outcomeless, outcomelessPg] = await Promise.all([
      memory.recordOutcome({ ...key, subject: "MRM-NOPE" }, { outcome: "recovered", recoveredCents: 100 as never, note: null }),
      postgres.recordOutcome({ ...key, subject: "MRM-NOPE" }, { outcome: "recovered", recoveredCents: 100 as never, note: null }),
    ]);
    assert.equal(outcomeless, null);
    assert.equal(
      outcomelessPg,
      null,
      "an outcome for a finding nobody raised must be refused, not created — a savings figure with no evidence under it makes the whole report unusable"
    );
  });
});

/**
 * `retireClearinghouseId` is the one write that can CLEAR a routing id, so both implementations must
 * clear only the exact stale value. The catalog uses it to retract `77777` (Delta Dental of
 * California) from the generic Delta row; an id an administrator typed must survive it.
 */
test("retiring a clearinghouse id clears only the exact stale value, in both repositories", dbTest, async () => {
  const { InMemoryPlaybookRepository, PgPlaybookRepository } = await import("@mermaid/payer-profile");
  const slug = "contract-retire-clearinghouse-id"; // a fixed slug, so a rerun reuses its own row
  for (const repo of [new PgPlaybookRepository(), new InMemoryPlaybookRepository()]) {
    const name = repo.constructor.name;
    await repo.upsertPayer({ slug, name: "Contract Payer", filingWindowDays: 365, appealWindowDays: 180, clearinghouseId: "77777" });

    assert.equal(await repo.retireClearinghouseId(slug, "22189"), false, `${name}: a different value is somebody's decision`);
    assert.equal((await repo.findPayer(slug))!.clearinghouseId, "77777", name);

    assert.equal(await repo.retireClearinghouseId(slug, "77777"), true, name);
    assert.equal((await repo.findPayer(slug))!.clearinghouseId, undefined, name);
    assert.equal(await repo.retireClearinghouseId(slug, "77777"), false, `${name}: nothing left to retire`);
  }
});
