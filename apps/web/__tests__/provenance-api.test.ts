/**
 * The API contract for data provenance.
 *
 * These assert the transport carries the source of a verification's benefits all the way to the
 * screen — on the list row, on the Today queue and on the detail view. The engine's own tests
 * (modules/verification/src/engine/__tests__/provenance.test.ts) prove the labels are right; these
 * prove they reach the client, which is the half that was missing and the half that misled someone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryOutbox } from "@mermaid/events";
import { createApp } from "../server.ts";
import { buildServices } from "../wiring.ts";
import { MockEdiAdapter } from "@mermaid/edi";
import { cents } from "@mermaid/shared";

/**
 * A deliberately obvious NON-DELIVERABLE address for invented patients.
 *
 * The 837D requires the subscriber's address, so a fixture patient needs one. It is named to be
 * unmistakable in a diff and in a payload: nothing here may ever reach a real payer, and no
 * production path may fall back to it.
 */
const SYNTHETIC_ADDRESS = { street: "1 SYNTHETIC TEST WAY", city: "SPRINGFIELD", state: "CA", zip: "900010000" } as const;

async function withServer(fn: (base: string, services: ReturnType<typeof buildServices>) => Promise<void>) {
  const services = buildServices({ inMemory: true, bus: new InMemoryOutbox() });
  const server = createApp(services);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, services);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const get = async (base: string, path: string): Promise<any> => {
  const res = await fetch(base + path);
  assert.equal(res.status, 200, `GET ${path}`);
  return res.json();
};

const PLAN = [
  { code: "D0120", quantity: 1 },
  { code: "D2750", quantity: 1, fee: cents(1250), toothNumber: "19" },
];

/** A clean verification — settles, so it does NOT appear on the Today queue. */
const seed = (services: ReturnType<typeof buildServices>) =>
  services.via(new MockEdiAdapter()).verification.create({
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12", memberId: "ABC12345" , address: SYNTHETIC_ADDRESS},
    cardText: "Delta Dental\nMember ID: ABC12345",
    planItems: PLAN,
  });

/**
 * One that lands on Today. `MEM10000` is the mock connector's inactive-coverage member, so this is
 * routed for review — and open work is the only thing the Today queue carries.
 */
const seedOpen = (services: ReturnType<typeof buildServices>) =>
  services.via(new MockEdiAdapter()).verification.create({
    patient: { firstName: "Ben", lastName: "Booker", dateOfBirth: "1978-11-03", memberId: "MEM10000" , address: SYNTHETIC_ADDRESS},
    cardText: "Delta Dental\nMember ID: MEM10000",
    planItems: PLAN,
  });

test("every verification list row carries provenance", async () => {
  await withServer(async (base, services) => {
    await seed(services);
    const { items } = await get(base, "/api/v1/verifications");
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(item.provenance, "a row without provenance is a row that reads as verified");
      assert.ok(["live", "test", "mock", "none"].includes(item.provenance.kind));
      assert.ok(item.provenance.label.length > 0);
      assert.ok("dataSource" in item.provenance);
      assert.ok("clearinghouseId" in item.provenance && "clearinghouseName" in item.provenance);
      assert.equal(typeof item.provenance.benefitsRetrieved, "boolean");
    }
  });
});

test("the detail view carries the full provenance object, including the money at stake", async () => {
  await withServer(async (base, services) => {
    const created = await seed(services);
    const view = await get(base, `/api/v1/verifications/${created.record.id}`);
    const p = view.provenance;
    assert.equal(p.kind, "mock");
    assert.match(p.label, /DEMO DATA/);
    assert.equal(p.dataSource, "mock");
    assert.equal(p.payerName, "Delta Dental");
    assert.equal(p.memberId, "ABC12345");
    assert.equal(p.benefitsRetrieved, true);
    assert.equal(p.eligibility, "active");
    assert.ok(p.deductible && p.annualMaximum);
    assert.equal(p.amountAtStake, view.record.calculation.totalPatientPays);
    // No clearinghouse was contacted, so none is claimed — even though the registry knows one.
    assert.equal(p.clearinghouseName, null);
  });
});

test("the Today queue badges verifications and counts the board's sources", async () => {
  await withServer(async (base, services) => {
    await seed(services);
    await seedOpen(services);
    const today = await get(base, "/api/v1/today");
    assert.ok(today.sources, "the queue must answer 'how much of this is real?' as a whole");
    assert.deepEqual(Object.keys(today.sources).sort(), ["live", "mock", "none", "test"]);

    const verifications = today.items.filter((i: any) => i.kind === "verification");
    assert.ok(verifications.length > 0);
    for (const item of verifications) {
      assert.ok(item.source, "a verification on the board must say where its coverage came from");
      assert.equal(item.source.kind, "mock");
    }
    assert.equal(
      today.sources.mock,
      verifications.length,
      "the banner's count and the rows it summarises must be the same set"
    );

    /**
     * Non-verification work carries NO source badge, deliberately.
     *
     * A claim descends from a verification, so inheriting its badge is tempting and would be wrong
     * often enough to matter — a claim can be filed after coverage was re-verified from a different
     * source. This feature exists to stop screens implying confirmation they cannot support, so it
     * must not start doing that itself one kind to the left.
     */
    for (const item of today.items.filter((i: any) => i.kind !== "verification")) {
      assert.equal(item.source, null, `${item.kind} must not inherit a verification's provenance`);
    }
  });
});

test("seeded demo data and real clearinghouse data are distinguishable through the API alone", async () => {
  await withServer(async (base, services) => {
    // Both written through the same repository, in the same queue, differing only in the adapter
    // that answered — which is exactly the situation the screen could not previously represent.
    await seed(services);
    const { items } = await get(base, "/api/v1/verifications");
    const labels = new Set(items.map((i: any) => i.provenance.label));
    for (const label of labels) {
      assert.doesNotMatch(
        String(label),
        /^REAL/,
        "nothing produced by the mock connector may ever be labelled real"
      );
    }
  });
});
