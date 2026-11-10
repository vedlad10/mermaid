/**
 * Loop 2310B — the dentist who actually performed the treatment (NEW-22).
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
 * Only loop 2010AA was ever emitted: the entity that gets PAID. For a solo practice that is right
 * and complete, and 005010X224A2 says to omit 2310B when the rendering provider is the billing
 * provider.
 *
 * For a group it is a false statement. The billing NPI is the practice's corporate one, so filing
 * without 2310B tells the payer that the corporation personally performed a crown. The payer checks
 * credentialing and network participation against the RENDERING provider, so the claim is denied,
 * or paid out-of-network, for a reason that names none of this — and a group practice had no way to
 * file a correct claim at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build837D, parseSegments } from "../mock/x12-837.ts";
import type { X12ClaimRequest } from "../mock/x12-837.ts";

const NOW = new Date("2026-07-27T14:30:00Z");

const SOLO: X12ClaimRequest = {
  claimId: "11111111-2222-3333-4444-555555555555",
  patientControlNumber: "MRM-000123",
  payerId: "delta-dental",
  payerName: "Delta Dental",
  subscriberFirstName: "Ada",
  subscriberLastName: "Alpha",
  memberId: "ABC12345",
  dateOfBirth: "1990-04-12",
  groupNumber: "GRP100",
  subscriberStreet: "1 Main St",
  subscriberCity: "Springfield",
  subscriberState: "CA",
  subscriberZip: "90001",
  billingProviderName: "MERMAID DEMO DENTAL",
  billingProviderNpi: "1234567893",
  billingProviderTaxId: "987654321",
  serviceDate: "2026-07-27",
  totalCharge: 175,
  lines: [{ lineNumber: 1, procedureCode: "D0120", quantity: 1, chargeAmount: 175, serviceDate: "2026-07-27" }],
};

const GROUP: X12ClaimRequest = {
  ...SOLO,
  renderingProvider: { firstName: "Rhea", lastName: "Mockdentist", npi: "1111111112", taxonomyCode: "1223G0001X" },
};

const seg = (raw: string, id: string) => parseSegments(raw).filter((s) => s.id === id);

test("a group claim names the treating dentist in NM1*82", () => {
  const raw = build837D(GROUP, NOW);
  const rendering = seg(raw, "NM1").find((s) => s.elements[0] === "82");

  assert.ok(rendering, "loop 2310B opens with NM1*82 — without it nobody is named as having rendered care");
  assert.equal(rendering!.elements[1], "1", "NM102 '1' — a person. A group's NPI belongs in 2010AA.");
  assert.equal(rendering!.elements[2], "Mockdentist");
  assert.equal(rendering!.elements[3], "Rhea");
  assert.equal(rendering!.elements[7], "XX", "an NPI qualifier");
  assert.equal(rendering!.elements[8], "1111111112", "and the INDIVIDUAL's NPI, not the group's");
});

test("2310B sits inside the claim loop and BEFORE the first service line", () => {
  /**
   * Position is the whole difference between two loops. A provider segment appearing after the
   * first `LX` belongs to that service line's 2420 loop — "this line was rendered by…" — which is a
   * different assertion from "this claim was rendered by…", and a payer's parser reads it that way.
   */
  const segments = parseSegments(build837D(GROUP, NOW));
  const clm = segments.findIndex((s) => s.id === "CLM");
  const rendering = segments.findIndex((s) => s.id === "NM1" && s.elements[0] === "82");
  const firstLine = segments.findIndex((s) => s.id === "LX");

  assert.ok(clm >= 0 && rendering >= 0 && firstLine >= 0);
  assert.ok(rendering > clm, "2310B belongs inside the 2300 claim loop, after CLM");
  assert.ok(rendering < firstLine, "and before the first service line, or it becomes a 2420 loop");
});

test("a SOLO claim emits no 2310B at all — the guide says to omit it", () => {
  /**
   * The regression that matters most: almost every dental claim in this system is a solo practice's,
   * and adding a segment the guide forbids to those would be found by payers, at scale, on claims
   * that were filing perfectly well.
   */
  const raw = build837D(SOLO, NOW);
  assert.equal(seg(raw, "NM1").filter((s) => s.elements[0] === "82").length, 0);
  assert.equal(
    seg(raw, "NM1").find((s) => s.elements[0] === "85")!.elements[8],
    "1234567893",
    "and the billing provider is untouched"
  );
});

test("2310B carries PRV — the segment a real clearinghouse refused the claim without", () => {
  /**
   * ── FOUND BY A LIVE CLEARINGHOUSE, NOT BY THIS SUITE ───────────────────────────────────────────
   * The first version of this loop emitted NM1*82 and went straight on to the service lines. Every
   * test here passed, because the mock parses what it builds — the same blind spot that let `PER` in
   * loop 1000A and `N3` in loop 2010AA ship, both of which a clearinghouse also caught.
   *
   * Stedi's validator said it exactly: `Unexpected segment LX: segment PRV is the next required
   * segment`, at `Loop 2310B`. 005010X224A2 makes PRV mandatory whenever the loop is present, so
   * the claim was structurally invalid and every group practice's claim would have been refused.
   *
   * PRV01 "PE" performing · PRV02 "PXC" taxonomy-code qualifier · PRV03 the code.
   */
  const segments = parseSegments(build837D(GROUP, NOW));
  const prv = segments.filter((s) => s.id === "PRV");

  assert.equal(prv.length, 1, "exactly one PRV, in the rendering-provider loop");
  assert.deepEqual(prv[0]!.elements.slice(0, 3), ["PE", "PXC", "1223G0001X"]);

  // Immediately after NM1*82 and before the first service line — position is the loop.
  const nm1 = segments.findIndex((s) => s.id === "NM1" && s.elements[0] === "82");
  const prvAt = segments.findIndex((s) => s.id === "PRV");
  const firstLine = segments.findIndex((s) => s.id === "LX");
  assert.equal(prvAt, nm1 + 1, "PRV follows the name directly — that is what the guide requires");
  assert.ok(prvAt < firstLine);
});

test("a SOLO claim emits no PRV either — the whole loop is absent", () => {
  assert.equal(parseSegments(build837D(SOLO, NOW)).filter((s) => s.id === "PRV").length, 0);
});

test("the SE segment count includes the rendering provider", () => {
  /**
   * SE01 is the number of segments in the transaction set and a payer validates it. One extra
   * segment, and a count that did not move would make every group practice's claim structurally
   * invalid — rejected for a reason that says nothing about the provider.
   */
  const count = (req: X12ClaimRequest) => Number(seg(build837D(req, NOW), "SE")[0]!.elements[0]);
  // NM1*82 and PRV — two segments, not one.
  assert.equal(count(GROUP) - count(SOLO), 2);

  assert.equal(
    count(GROUP),
    parseSegments(build837D(GROUP, NOW)).filter((s) => !["ISA", "GS", "GE", "IEA"].includes(s.id)).length,
    "and it must equal the segments actually between ST and SE inclusive"
  );
});
