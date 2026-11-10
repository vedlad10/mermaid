/**
 * Claim scrubber — the deterministic gate every claim passes before a human may release it.
 *
 * This is where most of the module's business value lives. A rejected claim costs a clinic roughly a
 * fortnight and a staff hour to rework; the cheapest possible moment to catch a missing tooth number
 * is before the 837 leaves the building. So the rules encode what payers actually reject on, and
 * each finding says what a human should DO about it — a scrubber that reports "invalid claim" with
 * no remediation just moves the puzzle.
 *
 * Two severities, and the distinction is deliberate:
 *   • error   — the payer will refuse this. Submission is blocked.
 *   • warning — likely trouble, but the clinic may have context the rules do not (an attachment
 *               already faxed, a patient who insists on filing anyway). Surfaced at the submit
 *               gate; never blocking. Silently blocking on a heuristic teaches staff to distrust
 *               the tool.
 *
 * Pure: no I/O, no clock of its own, no AI. Same claim + same context → same findings, always. AI
 * has no place here; a rule that decides whether a claim may be billed must be inspectable and
 * reproducible.
 */
import { addCents, calendarDay, findProcedure, formatUsd, isSubscriber, type Cents } from "@mermaid/shared";
import { filingStatus, FILING_WINDOWS_ARE_PAYER_SOURCED, FILING_WINDOW_CONFIRM_NOTE, FILING_WINDOW_ESTIMATE_NOTE } from "./deadline.ts";
import { patientControlNumber } from "./build.ts";
import { preAuthSatisfied } from "./preauth.ts";
import { CLM01_MAX_LENGTH, isValidClaimControlNumber } from "@mermaid/edi";
import type { Claim, ScrubFinding, ScrubResult } from "../types.ts";

/**
 * Days after which an inherited estimate is considered stale at the service date. Mirrors the
 * verification module's freshness policy — restated rather than imported, because a module may not
 * reach into a sibling (docs/MODULE-BOUNDARIES.md). If the two ever need to move together, the
 * constant belongs in `@mermaid/shared`.
 */
export const SNAPSHOT_STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Obvious placeholders that must never reach a payer as a real identifier.
 *
 * ── WHY ALL THREE FIELDS, NOT JUST THE TAX ID ──────────────────────────────────────────────────
 * Only the tax ID used to be checked here, and it was the least of the three. The demo NPI
 * (`1234567893`) has a CORRECT check digit — that is what makes it a usable demo value — so
 * `isValidNpi` waved it through, and the demo NAME was never examined at all. A deployment running
 * on defaults could therefore file a claim naming a provider that does not exist, and the only
 * complaint was about the tax ID.
 *
 * The hard stop for that is at boot, in `assertBillingProviderConfigured` — production will not
 * start under the demo identity. What remains here is the advisory for everywhere else: a staging or
 * demo deployment SHOULD be able to file (against the mock clearinghouse) while making it plain on
 * the submit gate that the provider on this claim is not a real one.
 */
const PLACEHOLDER_TAX_IDS = new Set(["", "000000000", "123456789", "111111111"]);
const PLACEHOLDER_NPIS = new Set(["", "1234567893", "0000000000"]);
const PLACEHOLDER_NAME = /\b(demo|test|sample|example|placeholder|your practice)\b/i;

/**
 * Is this the demonstration identity rather than a practice's own?
 *
 * Exported because two places need the same answer and they must not drift: the scrubber's advisory
 * on the submit gate, and the Ops readiness check that reports whether a deployment filing claims is
 * doing so under an identity a payer would recognise. The second exists because the dangerous state
 * is the MIDDLE one — a real NPI configured while the process is not in production mode, which turns
 * off the secure-cookie refusal, the proxy declaration and HSTS while claims go out under the
 * practice's real number. See audit finding A-5.
 */
export function isPlaceholderBillingIdentity(identity: {
  name: string;
  npi: string;
  taxId: string;
}): { placeholder: boolean; fields: string[] } {
  const fields = [
    PLACEHOLDER_NAME.test(identity.name) || identity.name.trim() === "" ? "name" : null,
    PLACEHOLDER_NPIS.has(identity.npi) ? "NPI" : null,
    PLACEHOLDER_TAX_IDS.has(identity.taxId) ? "tax ID" : null,
  ].filter((f): f is string => f !== null);
  return { placeholder: fields.length > 0, fields };
}

export interface ScrubContext {
  billingProvider: { name: string; npi: string; taxId: string };
  /**
   * Whether this practice bills under a GROUP NPI rather than an individual one (NEW-22).
   *
   * Stated by the deployment, never inferred: an NPI does not carry its own entity type in any form
   * this system can rely on, and guessing wrong in either direction is expensive. Guess "group" for
   * a solo practice and every claim is blocked on a segment 005010X224A2 forbids; guess "solo" for a
   * group and every claim tells the payer a corporation performed the treatment.
   *
   * Defaults to false, which is what every claim built before this existed meant.
   */
  practiceIsGroup?: boolean;
  /**
   * Procedures this patient already has on ANOTHER claim for this same date of service.
   *
   * Passed in rather than looked up, for the same reason `practiceIsGroup` is: this engine is a pure
   * function over one claim and must stay that way to be testable. Only the service can ask the
   * repository what else has been filed, so it asks and hands the answer down.
   *
   * Empty (the default) is what every claim built before this existed meant, and is also the honest
   * value when the caller has not looked — never an assertion that nothing was filed.
   */
  alreadyFiled?: readonly {
    code: string;
    toothNumber: string | null;
    /** Which surfaces of that tooth — two restorations on one tooth are two procedures. */
    surfaces: string | null;
    /** How many units were billed; a second unit is not a repeat of the first. */
    quantity: number;
    payerName: string | null;
  }[];
}

/**
 * NPI check-digit validation (the Luhn variant CMS specifies: prefix 80840, then standard Luhn).
 * A structurally invalid NPI is a guaranteed payer rejection, so this is an error, not a warning.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  // Walk right-to-left, doubling every second digit.
  for (let i = digits.length - 1, position = 1; i >= 0; i--, position++) {
    let value = Number(digits[i]);
    if (position % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(npi[9]);
}

const dayOnly = (iso: string): Date => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

export function scrubClaim(claim: Claim, ctx: ScrubContext, now: Date = new Date(), timeZone = "UTC"): ScrubResult {
  const findings: ScrubFinding[] = [];
  const error = (f: Omit<ScrubFinding, "severity">) => findings.push({ severity: "error", ...f });
  const warn = (f: Omit<ScrubFinding, "severity">) => findings.push({ severity: "warning", ...f });

  /**
   * ── PRE-AUTHORISATION: THE APPROVAL THAT HAD TO BE ASKED FOR BEFORE TREATMENT ─────────────────
   *
   * A payer that requires approval and did not get one refuses under CARC 197 in the `CO` group.
   * `CO` forbids billing the patient, so the entire allowed amount is written off against the
   * practice — the money is simply gone, and it is gone for a reason that was knowable before the
   * patient sat down. Pia Phase32's crown lost $1,125.00 exactly this way.
   *
   * ── WHY `required` BLOCKS AND `unknown` DOES NOT ──────────────────────────────────────────────
   * `required` is the payer's own rule, read from its own benefits. Filing against it is a
   * near-certain refusal, so it is an ERROR and the gate holds.
   *
   * `unknown` is the ORDINARY answer — a 271 does not carry these rules and most payers publish
   * them in a portal. Blocking on it would stop nearly every claim in the system on a question the
   * payer never answered, and a gate that fires on ordinary traffic is one people learn to click
   * past. So it warns, loudly, and says what it does not know.
   *
   * ── THE BLOCK IS RELEASED BY EVIDENCE, NEVER BY DISMISSAL ─────────────────────────────────────
   * An approval clears it. So does the payer WAIVING it, which is a real outcome and is recorded
   * as its own status rather than dressed up as an approval — a waiver grants nothing to quote if
   * the claim is later refused. A DENIED authorisation also blocks, and more firmly: filing anyway
   * is knowingly buying a write-off, and the route back is the appeal path, not the submit button.
   */
  const auth = claim.preAuthorization;
  /**
   * Shared with the list item, which reports this claim's exposure on the dashboard. They were two
   * copies of one rule and only one of them was ever updated — see engine/preauth.ts.
   */
  const authIsLive = preAuthSatisfied(claim) && auth?.status !== "waived";

  const requiredLines = claim.lines.filter((l) => l.preAuthRequirement === "required");
  const unknownLines = claim.lines.filter((l) => l.preAuthRequirement === "unknown");
  const atRisk = (ls: typeof claim.lines) => ls.reduce((t, l) => t + (l.preAuthRiskAmount ?? 0), 0);

  if (requiredLines.length > 0 && !authIsLive && auth?.status !== "waived") {
    const codes = requiredLines.map((l) => l.code).join(", ");
    const exposure = formatUsd(atRisk(requiredLines) as Cents);
    const because =
      auth?.status === "denied"
        ? `The payer REFUSED authorisation${auth.denialReason ? `: "${auth.denialReason}"` : ""}.`
        : auth?.status === "pending"
          ? "The request is still with the payer and has not been answered."
          : auth?.status === "expired"
            ? "The approval on file has expired."
            : "No authorisation has been requested.";

    error({
      code: "preauth-missing",
      message:
        `${codes} need${requiredLines.length === 1 ? "s" : ""} this payer's approval before treatment, ` +
        `and none is on record. ${because} ${exposure} is at risk.`,
      remediation:
        auth?.status === "denied"
          ? "Do not file expecting payment. Appeal the authorisation decision, or agree the cost with " +
            "the patient in writing first — a CARC 197 refusal is contractual and cannot be billed to them."
          : "Obtain the authorisation from the payer and record its reference number, or record that " +
            "the payer waived it. If the treatment is already done, the appeal path is the route back.",
      field: "preAuthorization",
    });
  }

  if (unknownLines.length > 0) {
    warn({
      code: "preauth-unknown",
      message:
        `Nobody has established whether ${unknownLines.map((l) => l.code).join(", ")} need this payer's ` +
        `approval before treatment — a 271 does not carry these rules. ` +
        `${formatUsd(atRisk(unknownLines) as Cents)} would be at risk if approval turns out to be required.`,
      remediation:
        "Check the plan documents or the payer portal. Recording the answer once teaches every future " +
        "estimate for this plan.",
      field: "preAuthorization",
    });
  }

  /**
   * ── THE SUBSCRIBER'S ADDRESS ──────────────────────────────────────────────────────────────────
   * 837D loop 2010BA N3/N4, required whenever the patient is the subscriber (SBR02 = 18) — the
   * ordinary dental case. A real clearinghouse rejects the claim outright without it: "Missing
   * subscriber address and/or demographics."
   *
   * An ERROR, so it blocks the gate. Filing without it spends a submission and buys a rejection the
   * practice then has to work; blocking converts that into one field somebody fills in once.
   *
   * Deliberately NOT required at verification time. Coverage can be checked and a patient quoted
   * from a name and a member id, and refusing to verify someone for want of a ZIP would stop the
   * front desk doing its job at check-in. The address is required where it is actually used.
   */
  const address = claim.patient.address;
  const blank = (v: string | undefined) => !v || !v.trim();
  if (blank(address?.street) || blank(address?.city) || blank(address?.state) || blank(address?.zip)) {
    error({
      code: "subscriber-address-missing",
      message: "The patient has no address on file, and a payer will not adjudicate a dental claim without one.",
      remediation:
        "Add the street, city, state and ZIP to the patient record, then re-scrub. Do not guess — an " +
        "address on a claim is a statement to the payer about where the patient lives.",
    });
  } else {
    if (!/^[A-Z]{2}$/.test(address!.state.trim().toUpperCase())) {
      error({
        code: "subscriber-address-invalid",
        message: `"${address!.state}" is not a two-letter state code; the payer will reject the claim.`,
        remediation: "Use the two-letter USPS abbreviation, e.g. CA.",
      });
    }
    if (!/^[0-9]{5}([0-9]{4})?$/.test(address!.zip.trim().replace(/-/g, ""))) {
      error({
        code: "subscriber-address-invalid",
        message: `"${address!.zip}" is not a 5- or 9-digit ZIP; the payer will reject the claim.`,
        remediation: "Use five digits, or nine with no hyphen.",
      });
    }
  }

  /**
   * ── AN UNRECOGNISED PAYER IS A WARNING, NOT A WALL (NEW-08) ───────────────────────────────────
   *
   * This was an ERROR, which blocked the submit gate. Combined with the payer catalog being a
   * seven-row array in a source file, that meant a practice whose card said "Ameritas" could not
   * verify the patient, could not file the claim electronically, AND could not mark it filed
   * manually — the system refused to let a human do the thing it could not do itself. The claim sat
   * in `ready` until its filing window closed, which is unrecoverable revenue caused entirely by a
   * missing row in a catalog.
   *
   * A warning is the honest severity. Everything an error protects against is still true — the
   * adapter refuses to transmit without a routing id, so nothing malformed reaches a clearinghouse
   * — and the thing an error prevented was a human taking the claim to the payer's portal, which is
   * exactly what should happen next. The remediation names both ways out, in the order they should
   * be tried: catalog the payer (which fixes every future claim too), or file this one by hand.
   */
  if (!claim.payer.payerId) {
    warn({
      code: "missing-payer",
      field: "payer.payerId",
      message:
        "No payer is identified on this claim, so it cannot be transmitted electronically. It can " +
        "still be filed on the payer's portal and recorded here.",
      remediation:
        "Add the payer to the payer catalog (Settings → Payers) with the spelling that appears on " +
        "the card and its clearinghouse id — that fixes this claim and every future one. If the " +
        "payer has no electronic connection at all, file on their portal and record the filing here.",
    });
  }
  if (!claim.patient.memberId.trim()) {
    error({
      code: "missing-member-id",
      field: "patient.memberId",
      message: "No subscriber member ID.",
      remediation: "Confirm the member ID against the physical insurance card and re-verify.",
    });
  }

  // ── Subscriber identity (837D loop 2010BA) ──
  if (!claim.patient.firstName.trim() || !claim.patient.lastName.trim()) {
    error({
      code: "missing-patient-identity",
      field: "patient.name",
      message: "The subscriber's first and last name are both required.",
      remediation: "Complete the patient record, then rebuild the claim.",
    });
  }
  if (!ISO_DATE.test(claim.patient.dateOfBirth)) {
    error({
      code: "missing-patient-identity",
      field: "patient.dateOfBirth",
      message: `Date of birth "${claim.patient.dateOfBirth}" is not a valid date.`,
      remediation: "Correct the date of birth (YYYY-MM-DD), then rebuild the claim.",
    });
  }

  /**
   * ── A DEPENDENT CLAIM MUST NAME THE PERSON WHOSE POLICY IT IS (NEW-01) ────────────────────────
   *
   * When the patient is not the subscriber, 005010X224A2 puts the POLICY HOLDER in loop 2010BA
   * (NM1*IL, with the member id) and the patient in 2010CA. The claim therefore needs a name the
   * verification may never have collected: a card names the subscriber, but a front desk in a hurry
   * types the child.
   *
   * An ERROR rather than a warning, and it must stay one. The two alternatives are both worse:
   * filing the CHILD as the policy holder is the bug this whole change exists to fix — the payer
   * adjudicates against the wrong person's benefits or rejects it — and defaulting the subscriber's
   * name to the patient's would put a false statement about who holds a policy in front of an
   * insurer under the practice's own NPI.
   *
   * The date of birth is deliberately NOT required. DMG in 2010BA takes the subscriber's, and where
   * the practice does not hold it the claim falls back to the patient's rather than being blocked —
   * a date is a weaker identifier than a name and payers match 2010BA on the member id, so blocking
   * on it would refuse claims that file perfectly well. Flagged as a warning so it is visible.
   */
  if (!isSubscriber(claim.patient.relationship)) {
    const subscriber = claim.patient.subscriber;
    if (!subscriber?.firstName.trim() || !subscriber?.lastName.trim()) {
      error({
        code: "missing-subscriber-identity",
        field: "patient.subscriber",
        message:
          `This claim is for a ${claim.patient.relationship} covered under someone else's policy, ` +
          `but the policy holder is not named. A payer needs to know whose plan is being billed.`,
        remediation:
          "Add the subscriber's first and last name — the name printed on the insurance card — to " +
          "the verification, then rebuild the claim. Do not enter the patient's own name: that " +
          "tells the payer the patient holds the policy, which is what produces the wrong " +
          "adjudication this check exists to prevent.",
      });
    } else if (!subscriber.dateOfBirth || !ISO_DATE.test(subscriber.dateOfBirth)) {
      warn({
        code: "subscriber-dob-unknown",
        field: "patient.subscriber.dateOfBirth",
        message:
          "The policy holder's date of birth is not on file, so the claim carries the patient's in " +
          "loop 2010BA. Most payers match on the member ID and accept this; some do not.",
        remediation:
          "Add the subscriber's date of birth to the verification if the payer rejects the claim.",
      });
    }
  }

  /**
   * ── A GROUP PRACTICE MUST NAME WHO DID THE WORK (NEW-22) ──────────────────────────────────────
   *
   * Only loop 2010AA was ever emitted — the entity that gets paid. For a solo practice that is
   * right and complete, and 005010X224A2 says to omit 2310B when the rendering provider is the
   * billing provider.
   *
   * For a group it is a false statement: the billing NPI is the practice's corporate one, and
   * filing without 2310B tells the payer that the corporation personally performed a crown. The
   * payer checks credentialing and network participation against the RENDERING provider, so the
   * claim is denied, or paid out-of-network, for a reason that names none of this.
   *
   * Gated on the deployment saying it is a group, because nothing in a claim can tell: an NPI does
   * not carry its own entity type in a way this system can rely on, and demanding a rendering
   * provider from a solo practice would block every claim on a segment the guide forbids.
   */
  if (ctx.practiceIsGroup) {
    const rendering = claim.renderingProvider;
    if (
      !rendering?.firstName.trim() ||
      !rendering?.lastName.trim() ||
      !rendering?.npi.trim() ||
      !rendering?.taxonomyCode.trim()
    ) {
      error({
        code: "missing-rendering-provider",
        field: "renderingProvider",
        message:
          "This practice bills as a group, so the claim must name the dentist who performed the " +
          "treatment. Without it the payer is told the practice itself rendered the care.",
        remediation:
          "Set the rendering provider on this claim — the treating dentist's own name, individual " +
          "NPI (not the group's) and taxonomy code, e.g. 1223G0001X for general practice dentistry.",
      });
    } else if (!/^[0-9A-Z]{9}X$/.test(rendering.taxonomyCode.trim().toUpperCase())) {
      /**
       * A Health Care Provider Taxonomy code is ten characters and ends in `X`. Checked in shape
       * only — the code SET is published by NUCC and changes, and a hardcoded list here would start
       * rejecting legitimate new specialties the day it went stale. The shape catches a transposed
       * or truncated value, which is the realistic error; a wrong-but-well-formed code is a payer
       * conversation, not something this can know.
       */
      error({
        code: "missing-rendering-provider",
        field: "renderingProvider.taxonomyCode",
        message: `"${rendering.taxonomyCode}" is not a provider taxonomy code — they are ten characters ending in X.`,
        remediation:
          "Use the treating dentist's NUCC taxonomy code, e.g. 1223G0001X (general practice " +
          "dentistry) or 1223P0221X (paediatric dentistry).",
      });
    } else if (!isValidNpi(rendering.npi)) {
      error({
        code: "missing-rendering-provider",
        field: "renderingProvider.npi",
        message: `"${rendering.npi}" is not a valid NPI — its check digit does not compute.`,
        remediation:
          "Use the treating dentist's own 10-digit individual NPI. The group's NPI belongs in the " +
          "billing provider, which is already on this claim.",
      });
    }
  }

  // ── Coverage (read from the inherited snapshot — never re-derived) ──
  const benefits = claim.coverageSnapshot.benefits;
  /**
   * ── A REFUSAL BLOCKS; A SILENCE WARNS (M18, D3) ───────────────────────────────────────────────
   * This tested `!== "active"`, so a payer that stated NOTHING about the policy was blocked here as
   * though it had refused, under the code `inactive-coverage`, with the remediation "Do not file …
   * or collect from the patient directly" — telling a practice to bill a patient in full on the
   * strength of a refusal nobody issued.
   *
   * The severity splits with the fact, on M7's asymmetry: a claim blocked on an unknown that was
   * actually fine costs the whole claim and produces no evidence contradicting the block, while a
   * claim filed on an unknown that was not costs one submission and a CO-27 denial a biller can see
   * and work. A person has also already ruled on this record — `buildCompletedEvent` returns null
   * unless the verification settled, and an unknown eligibility raises a CRITICAL flag, so such a
   * claim can only exist as `reviewed`. Blocking again here is a second gate on a settled decision.
   *
   * Confirmed-inactive behaviour is unchanged: still an error, still blocking, same wording.
   */
  if (benefits.eligibility === "inactive") {
    error({
      code: "inactive-coverage",
      field: "coverageSnapshot.benefits.eligibility",
      message: `The verification found coverage ${benefits.eligibility}, not active.`,
      remediation: "Do not file. Re-verify coverage, or collect from the patient directly.",
    });
  } else if (benefits.eligibility !== "active") {
    warn({
      code: "eligibility-unknown",
      field: "coverageSnapshot.benefits.eligibility",
      // M18's sentence, so verification's flag and the claims gate say the same thing.
      message: "The payer did not state whether this member's coverage is active.",
      remediation:
        "The payer did not state whether this member's coverage is active — this is an unknown, not " +
        "a refusal. Confirm with the payer if you have not already; filing on an unconfirmed " +
        "eligibility risks a CO-27 denial you can then work.",
    });
  }
  /**
   * ── THE COVERAGE WINDOW AGAINST THE DATE OF SERVICE (M3) ──────────────────────────────────────
   *
   * The claim holds both halves of this comparison and never made it. `benefits.coverage` carries
   * the window the payer stated (271 `DTP*346` / `DTP*347`), inherited verbatim in the snapshot;
   * `claim.serviceDate` is the day the patient was actually treated. Nothing compared them.
   *
   * Verification does compare — but against `now`, the instant the verification ran, because that is
   * all it has: a treatment plan carries no scheduled date. In a dental practice the estimate is
   * produced at check-in for work that may be booked weeks out, so the two dates routinely differ
   * and the check silently answered a different question than the one that matters.
   *
   * The consequence is a clean verification, a quoted patient, a clean scrub, and a claim filed into
   * a guaranteed denial (CO/PR-26 or -27) — plus a patient told insurance would pay a share it was
   * never going to. This is the first place in the cycle that holds the real date of service, so it
   * is the last honest moment to catch it.
   *
   * ERRORS, matching the `critical` severity verification already assigns the same facts. This is not
   * a confidence problem to be softened; it decides whether the payer owes anything at all, and only
   * a person with the patient's card and calendar can resolve it.
   *
   * A NULL date is not a finding. `coverage` is absent on every snapshot written before the field
   * existed, and null means "the payer did not state it" — never "unlimited", and never a reason to
   * block a claim that may be perfectly good.
   */
  const window = benefits.coverage;
  const serviceDay = claim.serviceDate.slice(0, 10);
  if (window?.terminationDate && serviceDay > window.terminationDate) {
    error({
      code: "coverage-terminated",
      field: "coverageSnapshot.benefits.coverage.terminationDate",
      message:
        `The payer stated this plan ended ${window.terminationDate}, before the ${serviceDay} date of ` +
        `service. Coverage read "${benefits.eligibility}" when it was checked, but it was not in force ` +
        `on the day of treatment.`,
      remediation:
        "Do not file — the payer will refuse it. Confirm the termination date with the payer, check " +
        "whether the patient has replacement coverage, and re-verify against the correct plan. If there " +
        "is none, this is the patient's to pay and they should be told before a bill arrives.",
    });
  }
  if (window?.effectiveDate && serviceDay < window.effectiveDate) {
    error({
      code: "coverage-not-yet-effective",
      field: "coverageSnapshot.benefits.coverage.effectiveDate",
      message:
        `The payer stated this plan began ${window.effectiveDate}, after the ${serviceDay} date of ` +
        `service. The treatment predates the policy.`,
      remediation:
        "Do not file against this plan. Find the coverage that was in force on the date of service and " +
        "verify against that, or collect from the patient.",
    });
  }

  /**
   * `null` is the payer having said nothing, and must not be read as a maximum of zero (M4).
   * Both are worth a warning and they are different warnings: one says the plan is spent, the other
   * says nobody knows what the plan allows.
   */
  const maxRemaining = benefits.annualMaximum.remaining;
  if (maxRemaining === null) {
    warn({
      code: "annual-max-unknown",
      field: "coverageSnapshot.benefits.annualMaximum",
      message:
        "The payer never stated how much annual maximum remained, so the expected insurance payment on " +
        "this claim is uncapped and may be optimistic.",
      remediation:
        "Confirm the remaining annual maximum with the payer. Filing is fine; just do not treat the " +
        "expected insurance figure as settled until it is confirmed.",
    });
  } else if (maxRemaining <= 0) {
    warn({
      code: "annual-max-exhausted",
      field: "coverageSnapshot.benefits.annualMaximum",
      message: "No annual maximum remained at verification — the payer is expected to pay nothing.",
      remediation: "File to record the claim if you wish, but discuss full patient responsibility first.",
    });
  }

  /**
   * ── THE CLAIM CONTROL NUMBER (CLM01) ─────────────────────────────────────────────────────────
   * Checked here, at the gate, rather than left to the codec, because this is the only place a
   * HUMAN sees the problem before a submission is spent. Stedi rejected a 23-character probe
   * outright; a control number over the limit produces a payer rejection on a claim that is
   * otherwise perfect, and the biller who has to work it cannot see the offending value anywhere in
   * the UI.
   *
   * Derived rather than stored: `patientControlNumber` is a pure function of the claim id and is
   * what `submit` will put on the wire, so scrubbing the derivation is scrubbing the real value.
   * An error, not a warning — filing it cannot succeed, so blocking costs nothing and saves a round
   * trip.
   *
   * Today this cannot fire: `MRM-` plus twelve hex characters is 16. That is the point. The guard
   * exists so a future prefix, environment tag or resubmission suffix fails at the desk instead of
   * at the payer.
   */
  const controlNumber = patientControlNumber(claim.id);
  if (!isValidClaimControlNumber(controlNumber)) {
    error({
      code: "control-number-invalid",
      field: "submission.patientControlNumber",
      message:
        `The claim control number "${controlNumber}" is ${controlNumber.length} characters; payers ` +
        `accept at most ${CLM01_MAX_LENGTH}, and only letters, digits and hyphens.`,
      remediation:
        "This is generated by Mermaid, not entered — report it. Filing would spend a submission and " +
        "return a payer rejection.",
    });
  }

  /**
   * ── A REFILING IS A REPLACEMENT, AND A REPLACEMENT MUST NAME WHAT IT REPLACES ────────────────
   *
   * A claim that has been filed once and is going out again is not a new claim. It carries the same
   * CLM01, the same patient, the same date and the same codes as one the payer already holds, and
   * the only thing distinguishing it is CLM05-3 frequency `7` plus the payer's own control number in
   * `REF*F8`. Without that pair the payer's duplicate-detection logic matches it against the
   * original and denies it as CARC 18 — so the correction workflow manufactures the next denial for
   * the practice to work.
   *
   * ── WHY THIS EXISTS WHEN TWO HARD STOPS ALREADY DO ──────────────────────────────────────────
   * `build837D` refuses to construct a frequency-7 claim without a control number, and
   * `ClaimService.submit` refuses before it gets that far. Neither is reachable by a human until
   * they press Submit, at which point the answer is an exception on an action they expected to
   * work. Every other reason a claim cannot be filed appears HERE, in advance, next to what to do
   * about it. A block a biller meets only by walking into it is a worse block.
   *
   * It fires when a prior submission exists and recorded no payer control number — a clearinghouse
   * that acknowledged without an identifier, which is the case `submit`'s own refusal was written
   * for. An error, not a warning: submission genuinely is blocked, and a warning would misdescribe
   * what happens next.
   */
  if (claim.submission && !claim.submission.controlNumber.trim()) {
    error({
      code: "replacement-without-control-number",
      field: "submission.controlNumber",
      message:
        "This claim has been filed before, so refiling it is a REPLACEMENT — but no payer control " +
        "number was recorded for the original, and a replacement that cannot name what it replaces " +
        "is denied as a duplicate (CARC 18).",
      remediation:
        "Get the payer's control number for the original filing from the payer or the clearinghouse " +
        "and record it on the submission, then refile. Filing a second original under a control " +
        "number the payer already holds would produce the duplicate denial, not avoid it.",
    });
  }

  // ── Billing provider (837D loop 2010AA) ──
  if (!isValidNpi(ctx.billingProvider.npi)) {
    error({
      code: "invalid-npi",
      field: "billingProvider.npi",
      message: `Billing provider NPI "${ctx.billingProvider.npi}" fails the NPI check digit.`,
      remediation: "Correct BILLING_PROVIDER_NPI in the practice configuration before filing.",
    });
  }
  /**
   * Every placeholder field, not just the tax ID — see `PLACEHOLDER_TAX_IDS` above for what that
   * omission allowed. Reported as ONE finding naming all of them, because they are one
   * misconfiguration and three separate warnings about the same unset block of environment is how a
   * gate becomes noise.
   */
  const placeholders = [
    PLACEHOLDER_NAME.test(ctx.billingProvider.name) || ctx.billingProvider.name.trim() === ""
      ? "name"
      : null,
    PLACEHOLDER_NPIS.has(ctx.billingProvider.npi) ? "NPI" : null,
    PLACEHOLDER_TAX_IDS.has(ctx.billingProvider.taxId) ? "tax ID" : null,
  ].filter((field): field is string => field !== null);

  if (placeholders.length > 0) {
    warn({
      code: "placeholder-billing-provider",
      field: "billingProvider",
      message:
        `The billing provider ${placeholders.join(", ")} ` +
        `${placeholders.length === 1 ? "is" : "are"} still ${placeholders.length === 1 ? "a placeholder" : "placeholders"}. ` +
        `A payer would be told this claim was rendered by a provider that does not exist.`,
      remediation:
        "Set BILLING_PROVIDER_NAME, BILLING_PROVIDER_NPI and BILLING_PROVIDER_TAX_ID to the practice's " +
        "real registered identity. A production deployment refuses to start until they are set.",
    });
  }

  // ── Dates ──
  const service = dayOnly(claim.serviceDate);
  /**
   * Today in the PRACTICE's day, not the server's.
   *
   * This read `now.toISOString()` — the UTC day — while `timeZone` sat unused two lines below in
   * `filingStatus`. A date of service is the day the patient was in the chair, so for a practice
   * ahead of UTC the comparison ran against YESTERDAY for most of its working morning: a claim for a
   * patient genuinely treated this morning was refused as "the date of service is in the future",
   * and this one is an ERROR, so it blocks the submit gate outright. Sydney at 9am is 22:00 UTC the
   * previous day; every same-day claim filed before mid-afternoon was unfilable.
   */
  const today = dayOnly(calendarDay(now, timeZone));
  if (service.getTime() > today.getTime()) {
    error({
      code: "future-service-date",
      field: "serviceDate",
      message: `The date of service (${claim.serviceDate}) is in the future.`,
      remediation: "File after the appointment has taken place.",
    });
  }
  const filing = filingStatus(claim.filingDeadline, now, timeZone, claim.filingWindowSource ?? null);
  if (filing.risk === "expired") {
    /**
     * ── WHY THIS IS A WARNING AND NOT A BLOCKER (M7) ──────────────────────────────────────────
     * The deadline it fires on is derived from `PAYER_FILING_DAYS` / `PAYER_CATALOG`, and every
     * number in both is a plausible default nobody has checked against a payer's provider manual —
     * see `FILING_WINDOWS_ARE_PAYER_SOURCED`.
     *
     * As an ERROR this blocked the submit gate and told the biller to write the claim off. If a
     * payer's real window is 365 and Mermaid's guess is 180, that is Mermaid instructing a practice
     * to abandon revenue the payer would have paid — and a written-off claim generates no evidence
     * that contradicts the decision, so the mistake is unfalsifiable and permanent.
     *
     * Filing a genuinely late claim costs a submission and a CO-29 denial, which a biller can see
     * and work. Refusing to file a claim that was actually in time costs the whole claim, silently.
     * The asymmetry decides it: warn loudly, and let the person who can ring the payer decide.
     *
     * It loses nothing else. The finding is on the gate, the claim is still ranked by urgency, and
     * `sweepFilingRisk` still escalates `claim.filing_risk`.
     *
     * A SOURCED window (B-1) changes the words, not the severity. The date is then the payer's own
     * published limit and the finding says so, by name — but a published limit is a default the
     * practice's contract can lengthen, so it still has no standing to refuse the claim.
     */
    const finding = {
      code: "past-filing-deadline" as const,
      field: "filingDeadline",
      message: filing.source
        ? `The timely-filing deadline (${claim.filingDeadline}) has passed. ${filing.estimateNote}`
        : `Mermaid's estimate of the timely-filing deadline (${claim.filingDeadline}) has passed.` +
          `${FILING_WINDOWS_ARE_PAYER_SOURCED ? "" : ` ${FILING_WINDOW_ESTIMATE_NOTE}`}`,
      remediation: FILING_WINDOWS_ARE_PAYER_SOURCED
        ? "The payer will refuse this claim. Write it off, or appeal with proof of timely filing."
        : `${FILING_WINDOW_CONFIRM_NOTE} If the claim is genuinely late, file it anyway to obtain a ` +
          "formal denial you can appeal with proof of timely submission — do not abandon it on this " +
          "estimate alone.",
    };
    if (FILING_WINDOWS_ARE_PAYER_SOURCED) error(finding);
    else warn(finding);
  }
  const snapshotAgeDays = Math.round((service.getTime() - dayOnly(claim.coverageSnapshot.verifiedAt).getTime()) / DAY_MS);
  if (snapshotAgeDays > SNAPSHOT_STALE_DAYS) {
    warn({
      code: "stale-snapshot",
      field: "coverageSnapshot.verifiedAt",
      message: `The estimate is ${snapshotAgeDays} days older than the date of service; benefits may have changed.`,
      remediation: "Re-verify coverage and rebuild the claim so the estimate matches what the payer will honor.",
    });
  }

  // ── Service lines ──
  if (claim.lines.length === 0) {
    error({
      code: "zero-charge-line",
      field: "lines",
      message: "The claim has no service lines.",
      remediation: "Rebuild the claim from a verification that has a treatment plan.",
    });
  }

  const seen = new Map<string, number>();
  for (const line of claim.lines) {
    const procedure = findProcedure(line.code);

    if (procedure?.requiresToothNumber && !line.toothNumber?.trim()) {
      error({
        code: "missing-tooth-number",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}].toothNumber`,
        message: `${line.code} (${line.description}) is tooth-specific and has no tooth number.`,
        remediation: "Add the tooth number to the treatment plan and rebuild the claim.",
      });
    }
    if (line.fee <= 0) {
      error({
        code: "zero-charge-line",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}].fee`,
        message: `Line ${line.lineNumber} (${line.code}) carries no charge.`,
        remediation: "Set the clinic's fee for this procedure and rebuild the claim.",
      });
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      error({
        code: "invalid-quantity",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}].quantity`,
        message: `Line ${line.lineNumber} has a quantity of ${line.quantity}.`,
        remediation: "Correct the quantity on the treatment plan and rebuild the claim.",
      });
    }

    const key = `${line.code}|${line.toothNumber ?? ""}`;
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      warn({
        code: "duplicate-line",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}].code`,
        message:
          `Line ${line.lineNumber} repeats ${line.code}` +
          `${line.toothNumber ? ` on tooth ${line.toothNumber}` : ""} from line ${firstSeen}.`,
        remediation: "Confirm this is genuinely two procedures; payers deny apparent duplicates.",
      });
    } else {
      seen.set(key, line.lineNumber);
    }

    /**
     * The same procedure, on the same tooth AND the same surfaces, in the same quantity, already
     * filed for this person on this date — on another claim.
     *
     * Every element of that key earns its place by preventing a warning that would be wrong. Tooth:
     * two crowns on one date are ordinary dentistry. Surfaces: one tooth can carry two separate
     * restorations of the same code on different surfaces, and calling those a duplicate would flag
     * the dentistry rather than the billing. Quantity: a second unit is a second unit, not a repeat
     * of the first — which is how multi-unit radiographs read otherwise.
     *
     * A control that fires on the routine case is one staff clear by reflex, and then they clear the
     * real one too — the same reasoning `detectIdentityCollision` records for member IDs.
     */
    const filedElsewhere = (ctx.alreadyFiled ?? []).find(
      (f) =>
        f.code === line.code &&
        (f.toothNumber ?? "") === (line.toothNumber ?? "") &&
        (f.surfaces ?? "") === (line.surfaces ?? "") &&
        f.quantity === line.quantity
    );
    if (filedElsewhere) {
      warn({
        code: "duplicate-service",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}].code`,
        message:
          `${line.code}${line.toothNumber ? ` on tooth ${line.toothNumber}` : ""} is already on another claim ` +
          `for this patient on this date of service` +
          `${filedElsewhere.payerName ? `, filed to ${filedElsewhere.payerName}` : ""}.`,
        remediation:
          "If this is a secondary payer, it should be billed the balance the primary left, not the full fee. " +
          "If it is not, void one of the two before filing — payers deny duplicates, and two that are both paid " +
          "is a refund the practice owes.",
      });
    }

    if (line.estimatedDenied) {
      warn({
        code: "estimated-denial",
        lineNumber: line.lineNumber,
        field: `lines[${line.lineNumber}]`,
        message: `The estimate expected ${line.code} to be denied — ${formatUsd(line.fee)} is patient responsibility.`,
        remediation: "File it to obtain a formal denial (which can be appealed), or bill the patient directly.",
      });
    }
  }

  // ── Integrity: the claim's totals must equal its lines ──
  const lineTotal = addCents(...claim.lines.map((l) => l.fee));
  const insuranceTotal = addCents(...claim.lines.map((l) => l.expectedInsurancePays));
  const patientTotal = addCents(...claim.lines.map((l) => l.expectedPatientPays));
  if (lineTotal !== claim.totalFee || insuranceTotal !== claim.expectedInsurancePays || patientTotal !== claim.expectedPatientPays) {
    error({
      code: "total-mismatch",
      field: "totalFee",
      message: "The claim totals do not equal the sum of its service lines.",
      remediation: "Do not file. Rebuild the claim from the verification — this record has been corrupted.",
    });
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    clean: errors === 0,
    errors,
    warnings: findings.length - errors,
    findings,
    scrubbedAt: now.toISOString(),
  };
}
