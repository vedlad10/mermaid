/**
 * A payer is DATA — added from a screen, matched on the next card, routed on the next claim, with
 * no deploy (NEW-08). Against the real database, over real HTTP.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * `modules/verification/src/engine/payer.ts` carried a seven-row array: slug, name, a hand-written
 * regular expression matched against the card, and the clearinghouse's id. Its own comment called
 * itself a mock "until the Payer Profile module is live on the database" — and that module has been
 * live, on a `payers` table keyed on the same slugs, since M12. So the two facts that decide whether
 * a patient can be verified at all lived in a source file while the deadlines lived in a table.
 *
 * A practice whose card said "Ameritas" could not verify that patient, could not file that claim,
 * and could not be helped by anyone without a code change, a review and a deploy. The scrubber made
 * it worse by treating `missing-payer` as a hard error, so the claim could not be filed manually
 * either — the system refused to let a human do the thing it could not do itself.
 *
 * ── WHY THE CENTRAL TEST GOES THROUGH HTTP ───────────────────────────────────────────────────────
 * The claim being made is "no code change". A test that called the service directly would prove the
 * service works; only a test that adds the payer the way an administrator would, then verifies a
 * patient the way the front desk would, proves that the path between them carries the new row.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createUser } from "@mermaid/auth";
import { withPractice, withoutPractice } from "@mermaid/db";
import { PayerProfileService, PgPlaybookRepository } from "@mermaid/payer-profile";
import { createApp } from "../../apps/web/server.ts";
import { buildServices } from "../../apps/web/wiring.ts";
import { dbTest, dropPractices, makePractice, shutdown } from "./harness.ts";

const created: string[] = [];
const addedSlugs: string[] = [];
let server: ReturnType<typeof createApp> | null = null;
let base = "";

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  // `payers` is shared reference data with no tenant column, so a payer this suite invents would
  // otherwise outlive it in a database other tests read.
  if (addedSlugs.length > 0) {
    await withoutPractice((tx) =>
      tx.query("DELETE FROM payers WHERE edi_payer_id = ANY($1::text[])", [addedSlugs])
    ).catch(() => {});
  }
  await dropPractices(...created);
  await shutdown();
});

async function app(): Promise<string> {
  if (base) return base;
  server = createApp(buildServices());
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

/** A signed-in owner for a throwaway practice — `payers.write` is an admin permission. */
async function owner(label: string) {
  const practiceId = await makePractice(label);
  created.push(practiceId);
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () =>
    createUser(practiceId, { email, name: `${label} Owner`, role: "owner", password })
  );

  const url = await app();
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await res.json()) as { csrf: string };

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { practiceId, call };
}

/** A slug this run owns, so a repeat run cannot collide on the shared catalog. */
function newSlug(): string {
  const slug = `test-payer-${randomBytes(4).toString("hex")}`;
  addedSlugs.push(slug);
  return slug;
}

test("a payer added over HTTP resolves in verification and routes a claim — no code change", dbTest, async () => {
  const { call } = await owner("payer-catalog");
  const slug = newSlug();
  /**
   * The card names a payer invented for THIS run.
   *
   * A fixed name ("Ameritas") looked fine and was not: `payers` is shared reference data with no
   * tenant column, so a run whose cleanup never ran — a killed process, a dropped connection —
   * leaves its alias behind, and the next run's "nothing recognises this card yet" step finds that
   * it does. The test then fails describing the opposite of what is wrong.
   */
  const brand = `Testwell ${slug.slice(-8).toUpperCase()}`;

  // ── 1. Nothing recognises this card today ────────────────────────────────────────────────────
  const before = await call("POST", "/api/v1/verifications", {
    patient: {
      firstName: "Ada",
      lastName: "Alpha",
      dateOfBirth: "1990-04-12",
      memberId: "ZZZ12345",
    },
    cardText: `${brand} Dental\nMember ID: ZZZ12345`,
    planItems: [{ code: "D0120", feeDollars: 65 }],
  });
  // The body is read ONCE — `await res.text()` inside an assertion message consumes it, and the
  // next `.json()` throws "Body is unusable" instead of reporting the assertion.
  const beforeBody = (await before.json()) as { record: { payerId: string | null } };
  assert.equal(before.status, 201, JSON.stringify(beforeBody));
  assert.equal(
    beforeBody.record.payerId,
    null,
    "the card names a payer nothing in the catalog knows — which is the whole starting position"
  );

  // ── 2. An administrator catalogues it, from a screen ─────────────────────────────────────────
  const added = await call("POST", "/api/v1/payer-profile/payers", {
    slug,
    name: `${brand} Dental`,
    clearinghouseId: "47009",
    filingWindowDays: 180,
    appealWindowDays: 90,
    aliases: [{ alias: brand }],
  });
  const saved = (await added.json()) as { payer: { payerId: string; clearinghouseId?: string } };
  assert.equal(added.status, 200, JSON.stringify(saved));
  assert.equal(saved.payer.payerId, slug);
  assert.equal(saved.payer.clearinghouseId, "47009");

  // ── 3. The SAME card, on the same running process, now resolves ──────────────────────────────
  const after2 = await call("POST", "/api/v1/verifications", {
    patient: {
      firstName: "Bea",
      lastName: "Beta",
      dateOfBirth: "1988-02-02",
      memberId: "ZZZ67890",
    },
    cardText: `${brand} Dental\nMember ID: ZZZ67890`,
    planItems: [{ code: "D0120", feeDollars: 65 }],
  });
  const afterBody = (await after2.json()) as { record: { payerId: string | null } };
  assert.equal(after2.status, 201, JSON.stringify(afterBody));
  assert.equal(
    afterBody.record.payerId,
    slug,
    "no restart, no deploy — the catalog is read at the edge of every verification for exactly this"
  );

  // ── 4. And the claim it produces routes to the clearinghouse id that was typed ───────────────
  const routing = await withoutPractice(() =>
    new PayerProfileService(new PgPlaybookRepository()).connectors()
  );
  assert.equal(
    routing.find((p) => p.payerId === slug)?.clearinghouseId,
    "47009",
    "the id a claim is routed with comes from the same row the card was matched against — one " +
      "source, so the two cannot be edited apart"
  );
});

test("the catalog reports the payers it cannot match or route, rather than looking complete", dbTest, async () => {
  /**
   * A payer with no aliases matches no card and a payer with no clearinghouse id routes no claim.
   * Both look exactly like a working payer on a screen that only lists rows, and both fail silently
   * weeks later — so the list carries the warnings with it.
   */
  const { call } = await owner("payer-warnings");
  const slug = newSlug();

  const res = await call("POST", "/api/v1/payer-profile/payers", { slug, name: "Catalogued Only" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { warnings: string[] };

  assert.ok(
    body.warnings.some((w) => w.includes(slug) && /no card aliases/i.test(w)),
    `expected an alias warning for ${slug}, got ${JSON.stringify(body.warnings)}`
  );
  assert.ok(
    body.warnings.some((w) => w.includes(slug) && /no clearinghouse id/i.test(w)),
    "and a routing warning"
  );
});

test("an alias another payer already claims is dropped, and the response says so", dbTest, async () => {
  /**
   * One alias means one payer. Routing that depended on which row was written last is how an
   * eligibility request reaches a company that has never heard of the patient — and the error comes
   * back as "not covered", which reads like an answer rather than a mistake.
   *
   * Dropped rather than refused: the payer's windows and clearinghouse id are useful facts on their
   * own, and losing them because an alias collided would be a worse trade. The response echoes the
   * SAVED row so an administrator can see their alias did not take.
   */
  const { call } = await owner("payer-alias-clash");
  const first = newSlug();
  const second = newSlug();
  // No hyphen: aliases are stored normalised (non-alphanumerics collapse to spaces), so a
  // hyphenated fixture would come back spaced and the assertion would be about normalisation
  // rather than about the collision.
  const shared = `shared${randomBytes(3).toString("hex")}`;

  await call("POST", "/api/v1/payer-profile/payers", {
    slug: first,
    name: "First Claimant",
    aliases: [{ alias: shared }],
  });
  const res = await call("POST", "/api/v1/payer-profile/payers", {
    slug: second,
    name: "Second Claimant",
    aliases: [{ alias: shared }],
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { payer: { aliases: { alias: string }[] } };
  assert.deepEqual(
    body.payer.aliases,
    [],
    "the second payer keeps its row and loses the contested alias — and is shown that it lost it"
  );

  const listed = (await (await call("GET", "/api/v1/payer-profile/payers")).json()) as {
    payers: { payerId: string; aliases: { alias: string }[] }[];
  };
  assert.deepEqual(
    listed.payers.find((p) => p.payerId === first)?.aliases.map((a) => a.alias),
    [shared],
    "the first claimant keeps it"
  );
});

test("adding a payer needs payers.write — reading the catalog does not", dbTest, async () => {
  /**
   * An alias decides which company a patient's eligibility request is sent to and a clearinghouse
   * id decides where a claim is routed, so writing the catalog is a genuinely powerful act. The
   * `auditor` role is read-only everywhere by definition and is the sharpest test of that.
   */
  const practiceId = await makePractice("payer-rbac");
  created.push(practiceId);
  const email = `auditor-${randomBytes(4).toString("hex")}@example.test`;
  const password = "correct-horse-battery";
  await withPractice(practiceId, () =>
    createUser(practiceId, { email, name: "Read Only", role: "auditor", password })
  );

  const url = await app();
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = (await login.json()) as { csrf: string };

  const write = await fetch(`${url}/api/v1/payer-profile/payers`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({ slug: newSlug(), name: "Should Not Exist" }),
  });
  assert.equal(write.status, 403, "an auditor must not be able to re-route another practice's claims");

  const read = await fetch(`${url}/api/v1/payer-profile/payers`, { headers: { cookie } });
  assert.equal(read.status, 200, "but reading the catalog is `payers.read`, which an auditor holds");
});

test("the seeded catalog can match every payer it lists, and route all but the known gap", dbTest, async () => {
  /**
   * The upgrade case, which is where this could have gone wrong silently: a database seeded before
   * aliases existed holds these payers with none, and the matcher now reads the TABLE. Without
   * `ensurePayers` filling that gap, such a deployment would recognise no insurance card at all —
   * strictly worse than the hardcoded array it replaces.
   */
  const service = new PayerProfileService(new PgPlaybookRepository());
  await withoutPractice(() => service.ensureDefaults());
  const catalog = await withoutPractice(() => service.connectors());

  for (const slug of ["delta-dental", "cigna-dental", "metlife-dental", "aetna-dental", "guardian-dental", "uhc-dental", "moda-dental"]) {
    const payer = catalog.find((p) => p.payerId === slug);
    assert.ok(payer, `${slug} must be catalogued`);
    assert.ok(payer!.aliases.length > 0, `${slug} must be matchable from a card`);
  }
  assert.equal(
    catalog.find((p) => p.payerId === "moda-dental")?.clearinghouseId,
    undefined,
    "Moda genuinely has no clearinghouse id here, and a seed must not invent one — a verification " +
      "says so plainly rather than sending Mermaid's own slug"
  );

  // Idempotent: a second boot writes nothing, including for the payer with the legitimate gap.
  assert.equal(await withoutPractice(() => service.ensurePayers()), 0);
});

test("the payer catalog is shared reference data, not tenant data", dbTest, async () => {
  /**
   * Every practice bills the same Delta Dental. Giving the catalog a practice_id would fragment the
   * routing table per clinic and make "add a payer" an operation somebody repeats for each one.
   */
  const a = await owner("payer-shared-a");
  const b = await owner("payer-shared-b");
  const slug = newSlug();

  await a.call("POST", "/api/v1/payer-profile/payers", {
    slug,
    name: "Shared Reference",
    aliases: [{ alias: slug }],
  });

  const seenByB = (await (await b.call("GET", "/api/v1/payer-profile/payers")).json()) as {
    payers: { payerId: string }[];
  };
  assert.ok(
    seenByB.payers.some((p) => p.payerId === slug),
    "a payer catalogued by one practice is catalogued for all of them"
  );
});

test("B-1: a Postgres catalog still holding the old Aetna guesses is corrected by the seed, and nothing else moves", dbTest, async () => {
  /**
   * Staging's `payers` row for Aetna was seeded at 180 filing / 60 appeal, and `ensurePayers` leaves
   * existing rows alone — so the sourced 90/180 would never reach it without the narrow correction
   * path. This drives that path against the real table and the real upsert, and restores the row
   * whatever happens: `payers` is shared reference data every other test reads.
   */
  const repo = new PgPlaybookRepository();
  const service = new PayerProfileService(repo);
  await service.ensurePayers();
  const original = (await repo.findPayer("aetna-dental"))!;
  try {
    await repo.upsertPayer({ ...original, filingWindowDays: 180, appealWindowDays: 60 });

    assert.equal(await service.ensurePayers(), 1, "the stale Aetna row is rewritten, once");
    const corrected = (await repo.findPayer("aetna-dental"))!;
    assert.equal(corrected.filingWindowDays, 90);
    assert.equal(corrected.appealWindowDays, 180);
    assert.equal(corrected.clearinghouseId, original.clearinghouseId, "routing is untouched");
    assert.deepEqual(
      [...(corrected.aliases ?? [])].map((a) => a.alias).sort(),
      [...(original.aliases ?? [])].map((a) => a.alias).sort(),
      "the aliases a card is matched on are untouched"
    );
    assert.equal(await service.ensurePayers(), 0, "idempotent on the next boot");

    // A practice's own figure is not a guess, and survives.
    await repo.upsertPayer({ ...corrected, filingWindowDays: 120 });
    await service.ensurePayers();
    assert.equal((await repo.findPayer("aetna-dental"))!.filingWindowDays, 120);
  } finally {
    await repo.upsertPayer(original);
  }
});
