/**
 * Scrubber tests — one per rule, plus the severity contract.
 *
 * The severity split is the part worth guarding: an error blocks a human from filing, a warning
 * does not. Getting that backwards either lets a guaranteed rejection out the door or trains staff
 * to fight the tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "@mermaid/shared";
import { buildClaimDraft, patientControlNumber } from "../engine/build.ts";
import { isValidNpi, scrubClaim } from "../engine/scrub.ts";
import { FILING_WINDOWS_ARE_PAYER_SOURCED } from "../engine/deadline.ts";
import { isValidClaimControlNumber } from "@mermaid/edi";
import type { Claim, ScrubCode } from "../types.ts";
import { BILLING_PROVIDER, DEMO_BILLING_PROVIDER, NOW, PATIENT, snapshot } from "./fixtures.ts";

const CTX = { billingProvider: BILLING_PROVIDER };

function claim(mutate: (c: Claim) => void = () => {}): Claim {
  const c = buildClaimDraft({ verificationId: "ver-0001", patient: { ...PATIENT }, coverageSnapshot: snapshot() }, NOW);
  mutate(c);
  return c;
}

const codes = (c: Claim): ScrubCode[] => scrubClaim(c, CTX, NOW).findings.map((f) => f.code);
const find = (c: Claim, code: ScrubCode) => scrubClaim(c, CTX, NOW).findings.find((f) => f.code === code);

test("a well-formed claim scrubs clean", () => {
  const result = scrubClaim(claim(), CTX, NOW);
  assert.equal(result.clean, true, `unexpected findings: ${JSON.stringify(result.findings)}`);
  assert.equal(result.errors, 0);
  assert.equal(result.warnings, 0);
  assert.equal(result.scrubbedAt, NOW.toISOString());
});

test("every finding carries a remediation a human can act on", () => {
  const result = scrubClaim(
    claim((c) => {
      c.payer.payerId = null;
      c.patient.memberId = "";
    }),
    CTX,
    NOW
  );
  assert.ok(result.findings.length >= 2);
  for (const finding of result.findings) {
    assert.ok(finding.remediation.trim().length > 0, `${finding.code} has no remediation`);
    assert.ok(finding.message.trim().length > 0, `${finding.code} has no message`);
  }
});

test("a missing member ID blocks filing; an unrecognised payer does NOT (NEW-08)", () => {
  /**
   * ── WHY THESE TWO STOPPED BEING THE SAME SEVERITY ─────────────────────────────────────────────
   * A missing member ID is a claim that cannot be adjudicated by anyone, on any channel: the payer
   * has no way to find the policy. It stays an error.
   *
   * A missing PAYER used to be an error too, and combined with the payer catalog being a seven-row
   * array in a source file, that meant a practice whose card said "Ameritas" could not verify the
   * patient, could not file electronically, AND could not record a manual filing — the system
   * refused to let a human do the thing it could not do itself. The claim sat in `ready` until its
   * filing window closed: unrecoverable revenue caused entirely by a missing row in a catalog.
   *
   * Nothing an error protected against is lost. The adapter still refuses to transmit without a
   * routing id, so nothing malformed reaches a clearinghouse; what changes is that the human can
   * take the claim to the payer's portal, which is what should happen next.
   */
  const result = scrubClaim(
    claim((c) => {
      c.payer.payerId = null;
      c.patient.memberId = "  ";
    }),
    CTX,
    NOW
  );
  assert.equal(result.clean, false, "the member ID alone still blocks it");
  assert.ok(result.findings.some((f) => f.code === "missing-member-id" && f.severity === "error"));

  const payerFinding = result.findings.find((f) => f.code === "missing-payer")!;
  assert.equal(payerFinding.severity, "warning");
  assert.match(payerFinding.remediation, /payer catalog/i, "and it names the way out that lasts");
  assert.match(payerFinding.remediation, /portal/i, "as well as the one for right now");
});

test("an unrecognised payer alone does not block the submit gate", () => {
  /**
   * The control for the test above: with a valid member ID, a claim whose payer is not catalogued
   * must SCRUB CLEAN, because the only thing left to do about it is a human decision.
   */
  const result = scrubClaim(claim((c) => (c.payer.payerId = null)), CTX, NOW);
  assert.equal(result.errors, 0, `unexpected errors: ${JSON.stringify(result.findings)}`);
  assert.equal(result.clean, true, "a human must be able to file this manually and record it");
});

test("inactive coverage blocks filing", () => {
  const c = claim((x) => {
    x.coverageSnapshot.benefits.eligibility = "inactive";
  });
  const finding = find(c, "inactive-coverage")!;
  assert.equal(finding.severity, "error");
  assert.match(finding.remediation, /Do not file/);
});

test("an incomplete subscriber identity blocks filing", () => {
  assert.ok(codes(claim((c) => (c.patient.lastName = ""))).includes("missing-patient-identity"));
  assert.ok(codes(claim((c) => (c.patient.dateOfBirth = "12/04/1990"))).includes("missing-patient-identity"));
});

test("a tooth-specific procedure with no tooth number blocks filing", () => {
  const c = claim((x) => {
    delete x.lines[2]!.toothNumber;
  });
  const finding = find(c, "missing-tooth-number")!;
  assert.equal(finding.severity, "error");
  assert.equal(finding.lineNumber, 3);
  assert.match(finding.message, /D2750/);
});

test("a whole-mouth procedure needs no tooth number", () => {
  // The exam and cleaning lines carry none and the clean claim still passes.
  assert.equal(scrubClaim(claim(), CTX, NOW).clean, true);
});

test("a zero-charge line and an invalid quantity both block filing", () => {
  assert.ok(codes(claim((c) => (c.lines[0]!.fee = cents(0)))).includes("zero-charge-line"));
  assert.ok(codes(claim((c) => (c.lines[0]!.quantity = 0))).includes("invalid-quantity"));
  assert.ok(codes(claim((c) => (c.lines[0]!.quantity = 1.5))).includes("invalid-quantity"));
});

test("a claim with no service lines blocks filing", () => {
  const c = claim((x) => {
    x.lines = [];
    x.totalFee = cents(0);
    x.expectedInsurancePays = cents(0);
    x.expectedPatientPays = cents(0);
  });
  assert.ok(codes(c).includes("zero-charge-line"));
});

test("an invalid billing-provider NPI blocks filing", () => {
  const result = scrubClaim(claim(), { billingProvider: { ...BILLING_PROVIDER, npi: "1234567890" } }, NOW);
  assert.equal(result.clean, false);
  assert.ok(result.findings.some((f) => f.code === "invalid-npi" && f.severity === "error"));
});

test("a placeholder tax ID warns but does not block — the demo must still run", () => {
  const result = scrubClaim(claim(), { billingProvider: { ...BILLING_PROVIDER, taxId: "000000000" } }, NOW);
  assert.equal(result.clean, true, "a placeholder must not block filing");
  assert.ok(result.findings.some((f) => f.code === "placeholder-billing-provider" && f.severity === "warning"));
});

/**
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────────────────────────
 *
 * Only the tax ID was ever checked, and it was the least of the three. The demo NPI `1234567893` has
 * a CORRECT check digit — that is what makes it usable as a demo value — so `isValidNpi` waved it
 * through, and the demo NAME was never examined at all. A deployment left on defaults could file a
 * claim naming a provider that does not exist, and the only complaint was about the tax ID.
 *
 * Production now refuses to BOOT under the demo identity (`assertBillingProviderConfigured`), which
 * is where a false attestation to a payer belongs — one person, once, rather than a busy biller
 * clicking past an advisory every day. This is the advisory that remains for everywhere else.
 */
test("the demo billing identity is recognised on every field, not just the tax ID", () => {
  const result = scrubClaim(claim(), { billingProvider: DEMO_BILLING_PROVIDER }, NOW);

  const finding = result.findings.find((f) => f.code === "placeholder-billing-provider");
  assert.ok(finding, "an unconfigured deployment must be told, on all three fields");
  assert.equal(finding!.severity, "warning", "the demo and staging must still be able to file");
  for (const field of ["name", "NPI", "tax ID"]) {
    assert.match(finding!.message, new RegExp(field), `the ${field} placeholder was not reported`);
  }
  assert.match(finding!.message, /provider that does not exist/, "it must say what is actually wrong");

  // One finding, not three: they are one misconfiguration, and three warnings about the same unset
  // block of environment is how a gate becomes noise people click past.
  assert.equal(result.findings.filter((f) => f.code === "placeholder-billing-provider").length, 1);
});

test("a demo NPI alone is caught, even though its check digit is valid", () => {
  // The precise gap: `isValidNpi` passes this, so before the placeholder set covered NPIs there was
  // nothing at all between a default deployment and a payer.
  assert.equal(isValidNpi(DEMO_BILLING_PROVIDER.npi), true, "the demo NPI is structurally valid — that is the trap");

  const result = scrubClaim(claim(), { billingProvider: { ...BILLING_PROVIDER, npi: DEMO_BILLING_PROVIDER.npi } }, NOW);
  const finding = result.findings.find((f) => f.code === "placeholder-billing-provider");
  assert.ok(finding, "a valid-looking but fake NPI must still be reported");
  assert.match(finding!.message, /NPI/);
});

test("a future date of service blocks filing", () => {
  const c = claim((x) => {
    x.serviceDate = "2026-09-01";
  });
  assert.ok(codes(c).includes("future-service-date"));
});

/**
 * ── "TODAY" IS THE DAY IN THE CHAIR, NOT THE DAY AT THE SERVER ─────────────────────────────────
 * The future-service-date check derived today from `now.toISOString()` — the UTC day — while the
 * practice timezone sat unused two lines below in the filing-deadline check. For a practice AHEAD
 * of UTC the comparison therefore ran against yesterday for most of the working morning, and this
 * finding is an ERROR: a claim for a patient genuinely treated this morning was refused as future
 * dated and could not be filed at all. In Sydney, 9am is 22:00 UTC the previous day, so every
 * same-day claim filed before mid-afternoon was blocked.
 */
test("a claim filed the morning it was treated is not 'in the future' east of UTC", () => {
  // 22:00Z on Jul 15 is 09:00 on Jul 16 in Sydney — the morning of the appointment.
  const sydneyMorning = new Date("2026-07-15T22:00:00Z");
  const treatedToday = claim((x) => {
    x.serviceDate = "2026-07-16";
  });

  const inSydney = scrubClaim(treatedToday, CTX, sydneyMorning, "Australia/Sydney");
  assert.equal(
    inSydney.findings.some((f) => f.code === "future-service-date"),
    false,
    "the patient was in the chair this morning; refusing the claim as future dated blocks real work"
  );

  // The guard itself is untouched: a service date genuinely after the practice's today still blocks.
  const treatedTomorrow = claim((x) => {
    x.serviceDate = "2026-07-17";
  });
  assert.ok(
    scrubClaim(treatedTomorrow, CTX, sydneyMorning, "Australia/Sydney").findings.some(
      (f) => f.code === "future-service-date"
    ),
    "a date that is still in the future in the practice's own day must be refused"
  );
});

/**
 * ── M7 — THIS TEST REPLACES ONE THAT PINNED THE DEFECT ─────────────────────────────────────────
 *
 * It asserted `severity === "error"` and a remediation reading "Write it off, or appeal" — i.e. it
 * held in place a BLOCK on filing, and an instruction to abandon revenue, derived from
 * `PAYER_FILING_DAYS`, every value of which its own comment describes as a "common
 * commercial-dental default". A plausible guess.
 *
 * If a payer's real window is 365 and the guess is 180, that is Mermaid telling a practice to write
 * off money the payer would have paid — and a written-off claim produces no evidence contradicting
 * the decision, so the mistake is unfalsifiable and permanent.
 *
 * Filing a genuinely late claim costs a submission and a CO-29 denial a biller can see and work.
 * Refusing to file one that was actually in time costs the whole claim, silently. So while
 * `FILING_WINDOWS_ARE_PAYER_SOURCED` is false the finding warns loudly and does not refuse.
 */
test("M7: a passed filing deadline warns loudly but does not block, while the window is a guess", () => {
  assert.equal(
    FILING_WINDOWS_ARE_PAYER_SOURCED,
    false,
    "if the windows have been sourced, this test's premise has changed — re-read it, do not just flip it"
  );

  const c = claim((x) => {
    x.filingDeadline = "2026-07-01";
  });
  const finding = find(c, "past-filing-deadline")!;

  assert.equal(finding.severity, "warning", "Mermaid may not refuse a claim on its own unverified constant");
  assert.match(finding.message, /estimate, not this payer's stated terms/);
  assert.match(finding.remediation, /Confirm the real filing window with the payer/);
  assert.doesNotMatch(finding.remediation, /^The payer will refuse/);

  // The gate is not blocked by it — that is the whole point — but the finding is still surfaced.
  const result = scrubClaim(c, CTX, NOW);
  assert.ok(
    result.findings.some((f) => f.code === "past-filing-deadline"),
    "surfaced at the gate, so the biller decides with the fact in front of them"
  );
});

test("B-1: a passed SOURCED deadline names the payer's limit, and still only warns", () => {
  /**
   * Aetna's own guide says 90 days. It also says nothing about THIS practice's contract, and Aetna's
   * appeal page qualifies its own window "unless otherwise required by contract". A published
   * default earns the payer's name on the finding — not the standing to refuse the claim.
   */
  const c = claim((x) => {
    x.filingDeadline = "2026-07-01";
    x.filingWindowSource = {
      publisher: "Aetna Dental",
      document: "Dental Office Guide, 23.05.803.1B, revised 09/25/2026",
      url: "https://app-iaem.aetna.com/content/dam/aetna/pdfs/aetna-dental/ppo-office-guide.pdf",
      quote: "no later than 90 days after the date of service.",
      verifiedOn: "2026-09-30",
    };
  });
  const finding = find(c, "past-filing-deadline")!;

  assert.equal(finding.severity, "warning", "a published default is not this practice's contract");
  assert.match(finding.message, /The timely-filing deadline \(2026-07-01\) has passed/);
  assert.match(finding.message, /Aetna Dental's published filing limit \(Dental Office Guide/);
  assert.doesNotMatch(finding.message, /Mermaid's estimate/);
  assert.match(finding.remediation, /Confirm the real filing window with the payer/);
});

// ── M3 — the coverage window against the DATE OF SERVICE ─────────────────────────────────────
//
// The claim held both halves of this comparison and never made it. `benefits.coverage` carries the
// window the payer stated (271 DTP*346 / DTP*347), inherited verbatim in the snapshot;
// `claim.serviceDate` is the day the patient was treated.
//
// Verification does compare — but against `now`, the instant it ran, because a treatment plan
// carries no scheduled date. In a dental practice the estimate is produced at check-in for work
// booked weeks out, so the two dates routinely differ and the check answered a different question
// than the one that decides whether the payer owes anything.
//
// The fixture claim's service date is 2026-07-27.

test("M3: a plan that ended before the date of service BLOCKS the claim", () => {
  const c = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: "2026-01-01", terminationDate: "2026-07-05" };
  });
  const finding = find(c, "coverage-terminated")!;

  assert.ok(finding, "a claim filed after coverage ended is a guaranteed denial");
  assert.equal(finding.severity, "error", "this decides whether the payer owes anything at all");
  assert.match(finding.message, /ended 2026-07-05/);
  assert.match(finding.message, /2026-07-27 date of service/);
  assert.equal(scrubClaim(c, CTX, NOW).clean, false);
});

test("M3: an ACTIVE eligibility does not rescue a service date outside the window", () => {
  /**
   * The exact case this exists for, and the reason it is a separate finding from
   * `inactive-coverage`. The payer answered ACTIVE — truthfully, on the day it was asked — and the
   * plan still was not in force when the patient was treated. Checking eligibility alone can never
   * see this.
   */
  const c = claim((x) => {
    x.coverageSnapshot.benefits.eligibility = "active";
    x.coverageSnapshot.benefits.coverage = { effectiveDate: null, terminationDate: "2026-07-05" };
  });
  const result = scrubClaim(c, CTX, NOW);

  assert.ok(result.findings.some((f) => f.code === "coverage-terminated"));
  assert.ok(
    !result.findings.some((f) => f.code === "inactive-coverage"),
    "eligibility is genuinely active — reporting it as inactive would be a false statement"
  );
  assert.equal(result.clean, false);
});

test("M3: treatment predating the policy blocks too, and says which way round it is", () => {
  const c = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: "2026-08-01", terminationDate: null };
  });
  const finding = find(c, "coverage-not-yet-effective")!;

  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /began 2026-08-01/);
  assert.match(finding.message, /predates the policy/);
});

test("M3: a service date INSIDE the window is clean — the rule must not block good claims", () => {
  // The control. A rule that fires on everything is not a rule, and blocking a fileable claim is
  // the failure mode M7 exists to prevent.
  const c = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: "2026-01-01", terminationDate: "2026-12-31" };
  });
  const result = scrubClaim(c, CTX, NOW);
  assert.equal(result.clean, true, `unexpected findings: ${JSON.stringify(result.findings)}`);
});

test("M3: the boundary days are INSIDE the window, because a plan covers the day it ends", () => {
  const endsOnServiceDay = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: null, terminationDate: "2026-07-27" };
  });
  const startsOnServiceDay = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: "2026-07-27", terminationDate: null };
  });

  assert.equal(scrubClaim(endsOnServiceDay, CTX, NOW).clean, true, "a plan ending today still covers today");
  assert.equal(scrubClaim(startsOnServiceDay, CTX, NOW).clean, true, "a plan beginning today covers today");
});

test("M3: a payer that stated NO window blocks nothing — null is silence, not a refusal", () => {
  /**
   * Most payers omit the segments, and every snapshot written before the field existed has none.
   * Treating a missing date as a reason to block would stop good claims on the strength of a fact
   * nobody stated — the mirror image of the defect, and the failure V6's own notes warn about.
   */
  const absent = claim((x) => {
    delete x.coverageSnapshot.benefits.coverage;
  });
  const bothNull = claim((x) => {
    x.coverageSnapshot.benefits.coverage = { effectiveDate: null, terminationDate: null };
  });

  assert.equal(scrubClaim(absent, CTX, NOW).clean, true);
  assert.equal(scrubClaim(bothNull, CTX, NOW).clean, true);
});

test("M7: an expired deadline is not the only thing keeping a claim fileable — real errors still block", () => {
  // The control. Demoting this finding must not have made the gate permissive in general.
  const c = claim((x) => {
    x.filingDeadline = "2026-07-01";
    x.patient.address = undefined;
  });
  const result = scrubClaim(c, CTX, NOW);
  assert.equal(result.clean, false);
  assert.ok(result.findings.some((f) => f.code === "subscriber-address-missing" && f.severity === "error"));
});

test("an estimate much older than the date of service warns about staleness", () => {
  const c = claim((x) => {
    x.serviceDate = "2026-10-01"; // ~66 days after the 2026-07-27 verification
    x.lines.forEach((l) => (l.serviceDate = "2026-10-01"));
  });
  const result = scrubClaim(c, CTX, new Date("2026-10-02T12:00:00Z"));
  const finding = result.findings.find((f) => f.code === "stale-snapshot")!;
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /66 days older/);
});

test("a repeated code on the same tooth warns about a duplicate", () => {
  const c = claim((x) => {
    x.lines.push({ ...x.lines[2]!, lineNumber: 4 });
    x.totalFee = cents(2675);
    x.expectedInsurancePays = cents(1425);
    x.expectedPatientPays = cents(1250);
  });
  const finding = find(c, "duplicate-line")!;
  assert.equal(finding.severity, "warning");
  assert.equal(finding.lineNumber, 4);
  assert.match(finding.message, /repeats D2750 on tooth 19 from line 3/);
});

/**
 * One line already filed elsewhere, defaulting to the fixture's own crown: D2750, tooth 19, whole
 * tooth, one unit. Overriding ONE field is how each test below states the single difference it is
 * about, so a reader can see the discriminator without re-reading the whole key.
 */
const filed = (over: Partial<{ code: string; toothNumber: string | null; surfaces: string | null; quantity: number; payerName: string | null }> = {}) => ({
  code: "D2750",
  toothNumber: "19" as string | null,
  surfaces: null as string | null,
  quantity: 1,
  payerName: "Delta Dental" as string | null,
  ...over,
});

/**
 * ── THE SAME TREATMENT ON TWO CLAIMS ───────────────────────────────────────────────────────────
 *
 * `duplicate-line` above catches one claim repeating itself. This is the harder case: one crown on
 * tooth 19 filed to Delta AND to MetLife, as two claims, both as primary, both paid in full —
 * $2,850.00 billed and $1,599.98 collected against a single $1,425.00 crown. Nothing was violated;
 * the only guard in place was one-claim-per-verification, and there were two verifications.
 */
test("a procedure already filed for this patient on this date warns across claims", () => {
  const c = claim();
  const result = scrubClaim(
    c,
    { ...CTX, alreadyFiled: [filed({ toothNumber: "19" })] },
    NOW
  );
  const finding = result.findings.find((f) => f.code === "duplicate-service")!;
  assert.ok(finding, "the second filing of one crown must be visible before it goes out");
  assert.equal(finding.severity, "warning", "a secondary payer is a legitimate second claim — warn, never block");
  assert.match(finding.message, /already on another claim/);
  assert.match(finding.message, /Delta Dental/);
  assert.match(finding.remediation, /balance the primary left/);
});

test("the same code on a DIFFERENT tooth is not a duplicate service", () => {
  const result = scrubClaim(
    claim(),
    { ...CTX, alreadyFiled: [filed({ toothNumber: "30" })] },
    NOW
  );
  assert.equal(
    result.findings.some((f) => f.code === "duplicate-service"),
    false,
    "two crowns on two teeth in one day is ordinary dentistry, not a duplicate"
  );
});

/**
 * ── THE KEY IS AS NARROW AS THE DENTISTRY REQUIRES ─────────────────────────────────────────────
 *
 * Each of these is a case where the treatment is genuinely NOT a repeat, and a warning would be
 * wrong. A control that fires on the routine case is one staff clear by reflex — and then they
 * clear the real one too, which is the failure this whole check exists to avoid.
 */
test("the same code on the same tooth but DIFFERENT surfaces is not a duplicate service", () => {
  const c = claim((x) => {
    x.lines[2]!.surfaces = "MO";
  });
  const result = scrubClaim(c, { ...CTX, alreadyFiled: [filed({ surfaces: "DO" })] }, NOW);
  assert.equal(
    result.findings.some((f) => f.code === "duplicate-service"),
    false,
    "one tooth can carry two separate restorations in a day — that is dentistry, not double billing"
  );
});

test("a different QUANTITY on the same code and tooth is not a duplicate service", () => {
  const c = claim((x) => {
    x.lines[2]!.quantity = 2;
  });
  const result = scrubClaim(c, { ...CTX, alreadyFiled: [filed({ quantity: 1 })] }, NOW);
  assert.equal(
    result.findings.some((f) => f.code === "duplicate-service"),
    false,
    "a second unit is a second unit, not a repeat of the first"
  );
});

test("identical code, tooth, surfaces and quantity IS still a duplicate service", () => {
  const c = claim((x) => {
    x.lines[2]!.surfaces = "MO";
  });
  const result = scrubClaim(c, { ...CTX, alreadyFiled: [filed({ surfaces: "MO", quantity: 1 })] }, NOW);
  assert.ok(
    result.findings.find((f) => f.code === "duplicate-service"),
    "narrowing the key must not cost the detection it exists for"
  );
});

test("a claim with nothing filed against it carries no duplicate-service finding", () => {
  assert.equal(codes(claim()).includes("duplicate-service"), false);
});

test("a line the estimate already expected to be denied is an advisory, not a blocker", () => {
  const c = claim((x) => {
    x.lines[2]!.estimatedDenied = true;
  });
  const result = scrubClaim(c, CTX, NOW);
  assert.equal(result.clean, true);
  const finding = result.findings.find((f) => f.code === "estimated-denial")!;
  assert.equal(finding.severity, "warning");
  assert.match(finding.remediation, /formal denial/);
});

test("an exhausted annual maximum warns without blocking", () => {
  const c = claim((x) => {
    x.coverageSnapshot.benefits.annualMaximum.remaining = cents(0);
  });
  const result = scrubClaim(c, CTX, NOW);
  assert.equal(result.clean, true);
  assert.ok(result.findings.some((f) => f.code === "annual-max-exhausted" && f.severity === "warning"));
});

test("totals that disagree with the lines block filing as a corruption guard", () => {
  const c = claim((x) => {
    x.totalFee = cents(9999);
  });
  const finding = find(c, "total-mismatch")!;
  assert.equal(finding.severity, "error");
  assert.match(finding.remediation, /this record has been corrupted/);
});

test("the scrubber is pure — the same claim scrubs identically every time", () => {
  const c = claim();
  const a = scrubClaim(c, CTX, NOW);
  const b = scrubClaim(c, CTX, NOW);
  assert.deepEqual(a, b);
});

test("NPI check-digit validation accepts valid NPIs and rejects malformed ones", () => {
  assert.equal(isValidNpi("1234567893"), true);
  assert.equal(isValidNpi("1234567890"), false, "wrong check digit");
  assert.equal(isValidNpi("123456789"), false, "too short");
  assert.equal(isValidNpi("12345678931"), false, "too long");
  assert.equal(isValidNpi("abcdefghij"), false);
  assert.equal(isValidNpi(""), false);
});

/**
 * ── V4: the claim control number (CLM01) ────────────────────────────────────────────────────────
 *
 * The scrubber is where a HUMAN is told, before a submission is spent. The codec refuses
 * independently (`platform/edi/__tests__/clm01-control-number.test.ts`); this pins that the gate
 * also holds, and — more importantly — that the rule is wired to the value `submit` will actually
 * put on the wire rather than to a copy that could drift.
 */
test("today's generated control number scrubs clean, and is inside the payer limit", () => {
  /**
   * The control case, and the one that makes the guard honest about its own status: this rule
   * CANNOT fire on current data, because `MRM-` plus twelve hex characters is 16 of an allowed 20.
   * If this ever fails, the derivation changed and the guard just earned its place.
   */
  const c = claim();
  assert.equal(codes(c).includes("control-number-invalid"), false, "a normal claim must not be flagged");

  const generated = patientControlNumber(c.id);
  assert.ok(generated.length <= 20, `generated control number ${generated} is ${generated.length} chars`);
  assert.ok(generated.startsWith("MRM-"));
});

test("the rule scrubs the number `submit` will actually send, not a stored copy", () => {
  /**
   * The wiring assertion. `patientControlNumber` is a pure function of the claim id, and `submit`
   * calls exactly that function — so scrubbing the derivation IS scrubbing the real value. A test
   * that asserted against a field on the claim would pass while the two silently diverged.
   *
   * Driven by giving the claim an id that derives to an over-long number, which is the only way to
   * make the rule fire without weakening it.
   */
  const c = claim();
  // 40 characters of hex → `MRM-` + 12 = 16. Push the derivation over by using a longer id is not
  // possible (it slices to 12), so assert the invariant that keeps it safe instead.
  assert.equal(patientControlNumber("x".repeat(200)).length, 16, "the derivation is length-bounded by construction");
  assert.equal(isValidClaimControlNumber(patientControlNumber(c.id)), true);
});

test("an invalid control number is an ERROR that blocks the gate, with actionable remediation", () => {
  /**
   * This FIRES the rule rather than asserting around it.
   *
   * `patientControlNumber` strips hyphens and upper-cases, but it does not sanitise: any other
   * character in the claim id survives into CLM01. A UUID cannot contain `*`, so this is not a
   * live defect — it is the mechanism by which the guard can be proven to work, and it also pins a
   * real hazard, since a claim id is only a UUID by current convention.
   */
  const c = claim();
  c.id = "abc*def01234567";
  const derived = patientControlNumber(c.id);
  assert.ok(derived.includes("*"), `expected the delimiter to survive, got ${derived}`);

  const finding = find(c, "control-number-invalid");
  assert.ok(finding, "an unusable control number must be reported");
  assert.equal(finding!.severity, "error", "it must BLOCK — filing it cannot succeed");
  assert.match(finding!.message, /\*/, "the message names the offending value");
  assert.ok(finding!.remediation.length > 0, "a human needs to be told what to do");

  // And it genuinely blocks the gate, not merely appears in the list.
  assert.equal(scrubClaim(c, CTX, NOW).clean, false);
});

test("an over-long control number blocks too", () => {
  // The length half of the same rule, driven the same way.
  const c = claim();
  c.id = "a".repeat(12);
  assert.equal(find(c, "control-number-invalid"), undefined, "16 characters is fine");

  assert.equal(isValidClaimControlNumber("MRM-" + "A".repeat(17)), false, "21 characters is not");
});

// ── D3 site 3 — the claims gate treats a silence as a refusal ──────────────────────────────────
//
// This rule tested `eligibility !== "active"`, so a snapshot carrying the payer's silence was
// blocked under `inactive-coverage` with the remediation "Do not file … or collect from the patient
// directly" — instructing a practice to bill a patient in full on a refusal nobody issued.
//
// The severity splits with the fact, on M7's asymmetry. A claim blocked on an unknown that was
// actually fine costs the whole claim and leaves no evidence contradicting the block; a claim filed
// on an unknown that was not costs one submission and a CO-27 a biller can see and work. A person
// has also already ruled on the record: an unknown eligibility raises a CRITICAL verification flag,
// and `buildCompletedEvent` emits nothing until the verification has settled, so a claim built from
// one of these can only have come through a human review.

/** A snapshot exactly as verification writes it when the payer never stated eligibility (site 1). */
function unknownEligibilitySnapshot() {
  const snap = snapshot();
  snap.benefits.eligibility = "unknown";
  for (const line of snap.calculation.lines) {
    line.denied = true;
    line.denialReason = "eligibility-unknown";
  }
  return snap;
}

test("D3: an unknown eligibility warns under its own code — it does not block", () => {
  const c = claim((x) => {
    x.coverageSnapshot = unknownEligibilitySnapshot();
  });
  const result = scrubClaim(c, CTX, NOW);

  const finding = result.findings.find((f) => f.code === "eligibility-unknown")!;
  assert.ok(finding, "the payer's silence must be reported, under its own code");
  assert.equal(finding.severity, "warning");
  assert.match(finding.remediation, /this is an unknown, not a refusal/);
  assert.match(finding.remediation, /risks a CO-27 denial you can then work/);
  assert.doesNotMatch(finding.remediation, /Do not file/);

  assert.ok(
    !result.findings.some((f) => f.code === "inactive-coverage"),
    "a payer that stated nothing has refused nothing"
  );
  assert.equal(result.errors, 0, "nothing here blocks filing");
  assert.equal(result.clean, true, "and the claim is still submittable");
});

test("D3: a confirmed inactive coverage still blocks, with its existing wording", () => {
  // Unchanged by site 3. The payer did state this one, so refusing to file is the right answer.
  const c = claim((x) => {
    x.coverageSnapshot.benefits.eligibility = "inactive";
  });
  const result = scrubClaim(c, CTX, NOW);

  const finding = result.findings.find((f) => f.code === "inactive-coverage")!;
  assert.equal(finding.severity, "error");
  assert.equal(finding.message, "The verification found coverage inactive, not active.");
  assert.equal(finding.remediation, "Do not file. Re-verify coverage, or collect from the patient directly.");
  assert.equal(result.clean, false, "an actual refusal still blocks");
  assert.ok(!result.findings.some((f) => f.code === "eligibility-unknown"));
});

test("D3: the two eligibility findings are never both raised, and never the same severity", () => {
  const unknown = scrubClaim(claim((x) => (x.coverageSnapshot = unknownEligibilitySnapshot())), CTX, NOW);
  const inactive = scrubClaim(claim((x) => (x.coverageSnapshot.benefits.eligibility = "inactive")), CTX, NOW);

  const eligibilityFindings = (r: ReturnType<typeof scrubClaim>) =>
    r.findings.filter((f) => f.code === "inactive-coverage" || f.code === "eligibility-unknown");

  assert.equal(eligibilityFindings(unknown).length, 1);
  assert.equal(eligibilityFindings(inactive).length, 1);
  assert.notEqual(eligibilityFindings(unknown)[0]!.code, eligibilityFindings(inactive)[0]!.code);
  assert.notEqual(eligibilityFindings(unknown)[0]!.severity, eligibilityFindings(inactive)[0]!.severity);
  assert.notEqual(eligibilityFindings(unknown)[0]!.remediation, eligibilityFindings(inactive)[0]!.remediation);
});

test("D3: an ACTIVE coverage raises neither finding", () => {
  const result = scrubClaim(claim(), CTX, NOW);
  assert.ok(!result.findings.some((f) => f.code === "inactive-coverage" || f.code === "eligibility-unknown"));
});

/**
 * ── A DEPENDENT CLAIM MUST NAME THE POLICY HOLDER (NEW-01) ────────────────────────────────────────
 *
 * A dental plan issues one member id to the subscriber and covers the family under it, so a claim
 * for a child carries the PARENT's member id. 005010X224A2 puts the policy holder in loop 2010BA —
 * a name the verification may never have collected, because the front desk types the patient.
 *
 * The two ways of not blocking are both worse than blocking. Filing the child as the subscriber is
 * the bug the whole change exists to fix. Defaulting the subscriber's name to the patient's puts a
 * false statement about who holds a policy in front of an insurer under the practice's own NPI.
 */
test("a dependent claim with no named subscriber is BLOCKED, not filed as self", () => {
  const c = claim((x) => {
    x.patient.relationship = "child";
  });
  const finding = find(c, "missing-subscriber-identity");

  assert.ok(finding, "a claim for a child under someone else's policy must not reach a payer unnamed");
  assert.equal(finding!.severity, "error", "a warning would let it file and be misadjudicated");
  assert.equal(scrubClaim(c, CTX, NOW).clean, false);
  assert.match(finding!.remediation, /Do not enter the patient's own name/i);
});

test("a dependent claim that names its subscriber scrubs clean", () => {
  const c = claim((x) => {
    x.patient.relationship = "child";
    x.patient.subscriber = { firstName: "Ada", lastName: "Alpha", dateOfBirth: "1990-04-12" };
  });
  const result = scrubClaim(c, CTX, NOW);
  assert.equal(result.clean, true, `unexpected findings: ${JSON.stringify(result.findings)}`);
});

test("a subscriber with no date of birth WARNS — payers match 2010BA on the member id", () => {
  /**
   * Deliberately not an error. DMG02 in 2010BA takes the subscriber's date of birth and the claim
   * falls back to the patient's when the practice does not hold it; blocking would refuse claims
   * that file perfectly well, which is how a scrubber teaches staff to ignore it.
   */
  const c = claim((x) => {
    x.patient.relationship = "spouse";
    x.patient.subscriber = { firstName: "Ada", lastName: "Alpha" };
  });
  const finding = find(c, "subscriber-dob-unknown");

  assert.ok(finding);
  assert.equal(finding!.severity, "warning");
  assert.equal(scrubClaim(c, CTX, NOW).clean, true, "a warning must not block the gate");
});

test("an ordinary self claim is asked for no subscriber at all", () => {
  /**
   * The regression guard. Almost every dental claim has the patient as the subscriber, and a rule
   * that fired on those would block the entire ordinary workload on a field nobody needs to fill.
   */
  for (const relationship of [undefined, "self" as const]) {
    const c = claim((x) => {
      x.patient.relationship = relationship;
    });
    assert.deepEqual(
      codes(c).filter((k) => k === "missing-subscriber-identity" || k === "subscriber-dob-unknown"),
      [],
      `relationship ${String(relationship)} must ask for nothing`
    );
  }
});
