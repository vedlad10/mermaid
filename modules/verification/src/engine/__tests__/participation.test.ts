/**
 * V3 — resolving this practice's network participation from stated configuration.
 *
 * The parsing rules matter more than they look. This map decides which column of a 271 a patient is
 * quoted from, so a config typo that silently resolved to a participation nobody stated would move
 * real money: an in-network practice quoted from the out-of-network column over-quotes patients, and
 * the reverse under-quotes them and the practice absorbs it.
 *
 * The rule under test is therefore: state it clearly or stay `unknown`. Never guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParticipationMap, participationFor } from "../payer.ts";

test("a stated participation resolves for that payer and no other", () => {
  const map = parseParticipationMap("delta-dental:in,cigna-dental:out");

  assert.equal(participationFor("delta-dental", map), "in-network");
  assert.equal(participationFor("cigna-dental", map), "out-of-network");
  // A payer nobody mentioned is unknown — never inherited from a neighbour in the list.
  assert.equal(participationFor("aetna-dental", map), "unknown");
});

test("both the short and long spellings are accepted, and whitespace and case are insignificant", () => {
  const map = parseParticipationMap("  DELTA-DENTAL : In-Network ,  cigna-dental:OUT  ");

  assert.equal(participationFor("delta-dental", map), "in-network");
  assert.equal(participationFor("cigna-dental", map), "out-of-network");
});

test("nothing configured means every payer is unknown", () => {
  for (const raw of [undefined, "", "   ", ",,,"]) {
    const map = parseParticipationMap(raw);
    assert.equal(map.size, 0, `expected no entries for ${JSON.stringify(raw)}`);
    assert.equal(participationFor("delta-dental", map), "unknown");
  }
});

test("a malformed entry is ignored, and does NOT default to a participation", () => {
  /**
   * The rule with teeth. `delta-dental:inn` is a typo, not a statement — resolving it to
   * `in-network` would quote every Delta patient from a column nobody chose, and the config would
   * look correct while doing it. Unknown is the honest answer and is also the safe one, because it
   * is the behaviour the system already had.
   */
  const map = parseParticipationMap("delta-dental:inn,cigna-dental,metlife-dental:,:out,aetna-dental:yes");

  assert.equal(participationFor("delta-dental", map), "unknown", "a typo must not become a participation");
  assert.equal(participationFor("cigna-dental", map), "unknown", "no value at all is not a statement");
  assert.equal(participationFor("metlife-dental", map), "unknown");
  assert.equal(participationFor("aetna-dental", map), "unknown", "`yes` does not name a network");
  assert.equal(map.size, 0, "not one of those was a statement about participation");
});

test("good entries survive alongside bad ones", () => {
  // A single typo must not discard the rest of a practice's stated contracts.
  const map = parseParticipationMap("delta-dental:inn,cigna-dental:out");

  assert.equal(participationFor("delta-dental", map), "unknown");
  assert.equal(participationFor("cigna-dental", map), "out-of-network");
});

test("an unidentified payer is unknown, never a default", () => {
  // `identifyPayer` returns null for a payer not in the registry; the pipeline passes that null
  // through. It must not resolve to a participation.
  assert.equal(participationFor(null, parseParticipationMap("delta-dental:in")), "unknown");
});

/**
 * The wiring test — participation must reach the PARSER, not merely be stored on a service.
 *
 * The unit tests above prove the map resolves. This proves the resolved value actually travels:
 * service → pipeline → EligibilityRequest → adapter → parse271. A break anywhere along that chain
 * leaves the whole feature inert while every test above still passes, which is exactly the shape of
 * the V2 defect this session started with.
 */
test("the stated participation reaches the eligibility request the adapter receives", async () => {
  const { VerificationService, InMemoryVerificationRepository } = await import("../../index.ts");
  const { MockEdiAdapter } = await import("@mermaid/edi");
  const { cents } = await import("@mermaid/shared");

  const seen: (string | undefined)[] = [];
  const adapter = new MockEdiAdapter();
  const spied = {
    ...adapter,
    checkEligibility(req: { networkParticipation?: string }) {
      seen.push(req.networkParticipation);
      return adapter.checkEligibility(req as never);
    },
  } as unknown as InstanceType<typeof MockEdiAdapter>;

  const svc = new VerificationService(
    new InMemoryVerificationRepository(),
    spied,
    undefined,
    undefined,
    null,
    undefined,
    parseParticipationMap("cigna-dental:out")
  );

  const visit = (card: string) => ({
    patient: { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-01-01", memberId: "ABC12345" },
    cardText: card,
    planItems: [{ code: "D1110", quantity: 1, fee: cents(110) }],
  });

  await svc.create(visit("Cigna\nMember ID: ABC12345"), new Date("2026-07-15T12:00:00Z"));
  await svc.create(visit("Delta Dental\nMember ID: ABC12345"), new Date("2026-07-15T12:00:00Z"));

  assert.deepEqual(seen, ["out-of-network", "unknown"], "the stated payer travels; an unstated one is unknown");
});
