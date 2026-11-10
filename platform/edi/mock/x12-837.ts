/**
 * X12 EDI 837D / 277CA codec — dental claim submission and acknowledgement.
 *
 * Companion to `x12-271.ts`, and built on the same doctrine: the MOCK synthesizes the wire payload,
 * but the PARSER is production code exercised on every call. When a real clearinghouse replaces the
 * transport (blueprint doc 09), the acknowledgement parser and the normalized shapes do not change —
 * only where the bytes come from.
 *
 * Money here is raw dollar figures as they appear on the wire (X12 carries decimal dollars).
 * Conversion to integer cents happens at the adapter boundary (`mock/index.ts`), never in the codec.
 *
 * Subset (deliberate — full 5010 is payer-companion-guide specific, blueprint doc 09):
 *   837D (005010X224A2): ISA/GS/ST, BHT, submitter 1000A, receiver 1000B, billing provider 2000A/2010AA,
 *                        subscriber 2000B/2010BA/2010BB (SBR, NM1*IL, DMG, NM1*PR), claim 2300 (CLM,
 *                        DTP*472, REF*D9), service lines 2400 (LX, SV3, TOO, DTP*472).
 *   277CA (005010X214): ST, BHT, TRN, STC (composite status), REF*1K payer control number, and
 *                        per-line SVC/STC pairs for itemized rejections.
 * Unknown segments are traced, never fatal — same as the 271 parser.
 */

import {
  COMP,
  componentSeparatorOf,
  controlNumber,
  d8,
  isoToD8,
  parseSegments,
  render,
  type X12Segment,
} from "./x12.ts";
import { CLM01_MAX_LENGTH, isValidClaimControlNumber } from "../adapter.ts";

export { controlNumber, parseSegments, type X12Segment };

// ── 837D: build ───────────────────────────────────────────────────────────────────────

/** One dental service line, as it appears on the wire (charge in DOLLARS). */
export interface X12ClaimLine {
  lineNumber: number;
  procedureCode: string;
  /** Universal/National tooth number, e.g. "19". Required for tooth-specific procedures. */
  toothNumber?: string;
  /** Tooth surfaces, e.g. "MO". */
  surfaces?: string;
  quantity: number;
  chargeAmount: number;
  /** ISO service date for this line. */
  serviceDate: string;
}

/**
 * The patient, in loop 2000C/2010CA, when they are covered under someone else's policy.
 *
 * `relationshipCode` is X12 element 1069 as it appears in **PAT01**, not SBR02 — see the note on
 * the 2000C loop in `build837D` for why those are different elements answering different questions.
 */
export interface X12Dependent {
  firstName: string;
  lastName: string;
  /** ISO date of birth — the DEPENDENT's, which is what DMG02 in 2010CA carries. */
  dateOfBirth: string;
  /** PAT01: "01" spouse, "19" child, "G8" other. Never "18" — self has no 2000C loop. */
  relationshipCode: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  gender?: "M" | "F" | "U";
}

/**
 * The dentist who performed the treatment, for loop 2310B.
 *
 * An individual, always — NM102 is "1" and there is no organisation form here. A group's NPI
 * belongs in 2010AA, and putting it here would say the corporation rendered the care.
 */
export interface X12RenderingProvider {
  firstName: string;
  lastName: string;
  /** The rendering provider's OWN individual NPI — not the group's. */
  npi: string;
  /**
   * PRV03 — the dentist's Health Care Provider Taxonomy code, e.g. `1223G0001X` for general
   * practice dentistry.
   *
   * ── WHY THIS IS REQUIRED AND NOT OPTIONAL ──────────────────────────────────────────────────────
   * 005010X224A2 loop 2310B is NM1 **then PRV**, and the PRV is required when the loop is present.
   * Emitting the name without it produced a structurally invalid claim, and a real clearinghouse
   * said so in exactly those terms: `Unexpected segment LX: segment PRV is the next required
   * segment` at `Loop 2310B`.
   *
   * Nothing in this repository could have caught that. The mock parses what it builds, so an 837
   * missing a segment only the PAYER requires round-trips perfectly — the same blind spot that let
   * `PER` in loop 1000A and `N3` in loop 2010AA ship, both of which a clearinghouse also found.
   */
  taxonomyCode: string;
}

export interface X12ClaimRequest {
  /** Clinic's own control number for this claim (CLM01 / patient account number). */
  patientControlNumber: string;
  payerId: string;
  payerName: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  memberId: string;
  /** ISO date of birth. */
  dateOfBirth: string;
  groupNumber?: string | null;
  /** Loop 2010BA N3/N4 + DMG03 — required when the patient is the subscriber. */
  subscriberStreet?: string;
  subscriberCity?: string;
  subscriberState?: string;
  subscriberZip?: string;
  subscriberGender?: "M" | "F" | "U";
  /**
   * Loop 2000C/2010CA — the PATIENT, when the patient is not the subscriber (NEW-01).
   *
   * Absent means the patient IS the subscriber: HL04 stays "0", no 2000C level is emitted, and the
   * bytes are exactly what this builder has always produced for an ordinary dental claim.
   */
  dependent?: X12Dependent;
  billingProviderName: string;
  billingProviderNpi: string;
  billingProviderTaxId: string;
  /** Loop 1000A PER — who the payer contacts about this claim. Defaults to the billing provider. */
  submitterContactName?: string;
  submitterContactPhone?: string;
  /** Loop 2010AA N3/N4 — the billing provider’s SERVICE address. Required by payers. */
  billingProviderStreet?: string;
  billingProviderCity?: string;
  billingProviderState?: string;
  billingProviderZip?: string;
  /**
   * Loop 2000A PRV03 — the billing provider's Health Care Provider Taxonomy code.
   *
   * Situational in the guide, required in practice: Stedi's payer edits rejected a valid test claim
   * with "Missing Billing Provider taxonomy code. This code is required when no rendering provider or
   * assistant surgeon is reported" (277CA `A6:145:85`). That is every solo practice's claim. Found
   * on 2026-10-15, the first time a claim got far enough to be edited at all.
   */
  billingProviderTaxonomy?: string;
  /** ISO date of service for the claim as a whole. */
  serviceDate: string;
  /** Total charge in DOLLARS. */
  totalCharge: number;
  /**
   * ISA15 usage indicator: `T` test, `P` production. NOT cosmetic.
   *
   * Hardcoded to "P" until a real clearinghouse refused: "The Test API Key is not permitted to
   * submit production transactions." The dangerous direction is the other one — a production claim
   * stamped `T` is accepted and then ignored, so the practice believes it filed and no payer ever
   * adjudicates. The adapter derives this from its own test mode, which is already interlocked
   * against the API key’s prefix, so the envelope cannot disagree with the credential sending it.
   */
  usageIndicator?: "T" | "P";
  claimFrequency?: "1" | "7";
  originalClaimControlNumber?: string | null;
  lines: X12ClaimLine[];
  /**
   * Loop 2310B — the RENDERING provider, when that is not the billing provider (NEW-22).
   *
   * ── WHY A GROUP PRACTICE CANNOT FILE WITHOUT THIS ──────────────────────────────────────────────
   * Only 2010AA was emitted: the entity that gets paid. In a solo practice those are the same
   * person and the loop is correctly omitted — 005010X224A2 says to send 2310B only "when the
   * rendering provider is different than the billing provider".
   *
   * In a group they are never the same. The billing provider is the practice's group NPI; the
   * rendering provider is the dentist who actually did the work, and that is what a payer uses to
   * check credentialing and network participation for the treatment being billed. Without it the
   * payer is told a corporate entity personally performed a crown.
   *
   * Absent means "the billing provider rendered this", which is what every claim built before this
   * existed meant, and what a solo practice's claims still mean.
   */
  renderingProvider?: X12RenderingProvider;
  /** Mermaid's internal claim id, carried in REF*D9 so an ack can be matched back. */
  claimId: string;
}

/** Build an X12 837D dental claim. */
export function build837D(req: X12ClaimRequest, now: Date = new Date()): string {
  /**
   * The last line of defence on CLM01, deliberately duplicated from the scrubber.
   *
   * The scrubber is where a human is told; this is where it becomes impossible. They are not the
   * same guarantee: the scrubber runs against the claim aggregate, while anything at all can call
   * this builder — a retry path, a resubmission, a future caller that has its own idea of a control
   * number. A value that is too long merely earns a payer rejection, but one carrying `*` or `~`
   * would SPLIT THE CLM SEGMENT and produce a structurally different claim than the one authorised.
   *
   * Throws rather than truncating. Silently shortening a control number would break the duplicate
   * detection it exists for — the payer would see a claim it could not match to the original, which
   * is how the same treatment gets paid twice.
   */
  if (!isValidClaimControlNumber(req.patientControlNumber)) {
    throw new Error(
      `Refusing to build an 837D: CLM01 "${req.patientControlNumber}" is not a valid claim control ` +
        `number (max ${CLM01_MAX_LENGTH} characters, letters, digits and hyphens only).`
    );
  }

  /**
   * A REPLACEMENT MUST SAY WHAT IT REPLACES.
   *
   * CLM05-3 `7` tells the payer this claim supersedes one it already holds, and 005010X224A2
   * requires `REF*F8` carrying that claim's control number alongside it. Without the reference the
   * payer is told "replace something" with no statement of what — so it either rejects the claim or,
   * worse, adjudicates it as a brand-new one and denies it as a duplicate (CARC 18). Either way the
   * correction workflow manufactures the very denial it exists to work.
   *
   * The `if` further down already omitted `REF*F8` when the original number was absent, which meant
   * the malformed combination was constructed silently. The empty case is reachable: a submission
   * recorded without a control number (a vendor that returned no acknowledgement identifier) leaves
   * `claim.submission.controlNumber` empty, and `ClaimService.submit` still elects frequency `7`
   * because a prior submission exists.
   *
   * Refused here rather than corrected, for the same reason CLM01 is: quietly downgrading it to
   * frequency `1` would file a duplicate under a control number the payer already has, and quietly
   * emitting an empty REF*F8 would put a malformed segment on the wire. Anything can call this
   * builder, so the refusal belongs where the segment is written.
   */
  if (req.claimFrequency === "7" && !req.originalClaimControlNumber?.trim()) {
    throw new Error(
      `Refusing to build an 837D: claim frequency 7 is a REPLACEMENT and must quote the payer's own ` +
        `control number for the claim it replaces in REF*F8, but none was supplied. Filing it without ` +
        `one is denied as a duplicate (CARC 18). File as an original (frequency 1), or obtain the ` +
        `payer's control number for the original claim.`
    );
  }
  /**
   * "18" in PAT01 would say "the patient is the subscriber" from inside the loop that exists only
   * because they are not — a contradiction on the wire, and one that reads as a plausible value.
   * Refused here for the same reason CLM01 is: anything at all can call this builder.
   */
  if (req.dependent && req.dependent.relationshipCode === "18") {
    throw new Error(
      `Refusing to build an 837D: a 2000C patient loop was requested with PAT01 "18" (self). A ` +
        `patient who is the subscriber has no dependent loop — omit it and SBR02 carries "18".`
    );
  }
  const dependent = req.dependent;
  const ctrl = controlNumber(req.patientControlNumber + req.payerId);
  const date = d8(now);
  const time = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const svcDate = isoToD8(req.serviceDate);

  const segs: string[][] = [
    ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "CLINIC         ", "ZZ", req.payerId.slice(0, 15).padEnd(15, " "), date.slice(2), time, "^", "00501", ctrl, "0", req.usageIndicator ?? "P", COMP],
    ["GS", "HC", "CLINIC", req.payerId, date, time, ctrl, "X", "005010X224A2"],
    ["ST", "837", "0001", "005010X224A2"],
    // BHT06 "CH" = chargeable claim (as opposed to a predetermination, "RP").
    ["BHT", "0019", "00", ctrl, date, time, "CH"],
    // 1000A submitter / 1000B receiver.
    ["NM1", "41", "2", req.billingProviderName, "", "", "", "", "46", req.billingProviderTaxId],
    /**
     * PER — the submitter’s contact, and MANDATORY in loop 1000A.
     *
     * Omitted until a real clearinghouse validated the envelope and answered
     * "Segment PER has fewer than the minimum of 1 items". Nothing in this repository caught it:
     * the mock parses what it builds, so an 837 missing a segment only the PAYER requires round-trips
     * perfectly. It is the whole reason a vendor round trip is worth more than another fixture.
     *
     * PER01 "IC" = information contact; PER03 "TE" = telephone. The number is who a payer rings when
     * a claim is unreadable, so it is a real operational field rather than a formality.
     */
    ["PER", "IC", req.submitterContactName ?? req.billingProviderName, "TE", req.submitterContactPhone ?? ""],
    ["NM1", "40", "2", req.payerName, "", "", "", "", "46", req.payerId],
    // 2000A billing provider hierarchical level.
    ["HL", "1", "", "20", "1"],
    // PRV01 "BI" billing, PRV02 "PXC" taxonomy qualifier. Its place is here, before 2010AA's NM1.
    ...(req.billingProviderTaxonomy ? [["PRV", "BI", "PXC", req.billingProviderTaxonomy]] : []),
    ["NM1", "85", "2", req.billingProviderName, "", "", "", "", "XX", req.billingProviderNpi],
    /**
     * N3/N4 — the billing provider’s address, and REQUIRED in loop 2010AA before REF.
     *
     * Found the same way PER was: a real clearinghouse validated the envelope and answered
     * "Unexpected segment REF: segment N3 is the next required segment". A payer will not adjudicate
     * a claim without knowing where the provider practises — it is how the plan’s network and
     * jurisdiction are determined — so this is a substantive field, not a formality.
     *
     * A PO box is not acceptable to most payers here; this must be the service location.
     */
    ["N3", req.billingProviderStreet ?? ""],
    ["N4", req.billingProviderCity ?? "", req.billingProviderState ?? "", req.billingProviderZip ?? ""],
    ["REF", "EI", req.billingProviderTaxId],
    /**
     * 2000B subscriber.
     *
     * HL04 is the "child HL segments follow" flag: "0" when the subscriber IS the patient and this
     * is the last level, "1" when a 2000C patient level follows. It was hardcoded to "0", which is
     * correct only for a self claim (NEW-01).
     */
    ["HL", "2", "1", "22", dependent ? "1" : "0"],
    /**
     * SBR01 "P" primary · SBR02 individual relationship · SBR03 group · SBR09 "CI" commercial.
     *
     * ── SBR02 IS PRESENT ONLY FOR A SELF CLAIM, AND THAT IS NOT A SIMPLIFICATION ────────────────
     * 005010X224A2 makes SBR02 situational: "Required when the patient is the subscriber or is
     * considered to be the subscriber. If not required by this implementation guide, do not send."
     * For a dependent the relationship is carried by **PAT01 in loop 2000C**, and sending it in
     * SBR02 as well is a guide violation — the same class of mistake as the filing indicator that
     * sat in SBR08, which a real clearinghouse rejected with "Element SBR-08 is not used by this
     * guide". Two elements, two questions: SBR02 says "the subscriber is the patient", PAT01 says
     * "here is how the patient relates to the subscriber".
     *
     * So this emits "18" when the patient is the subscriber and NOTHING when they are not, rather
     * than putting "19" here where a reader might expect to find it.
     *
     * The filing indicator sat in SBR08, one element early — an off-by-one no fixture could catch,
     * because our own parser never read it back. A clearinghouse did: "Element SBR-08 is not used by
     * this guide". SBR08 is genuinely unused in 005010X224A2, so the value was both in the wrong
     * place and in a place the guide forbids.
     */
    ["SBR", "P", dependent ? "" : "18", req.groupNumber ?? "", "", "", "", "", "", "CI"],
    ["NM1", "IL", "1", req.subscriberLastName, req.subscriberFirstName, "", "", "", "MI", req.memberId],
    /**
     * N3/N4 — the SUBSCRIBER’s address, required in loop 2010BA whenever the patient is the
     * subscriber (SBR02 = 18), which is the ordinary dental case.
     *
     * Found by a live clearinghouse: "Missing subscriber address and/or demographics." The address
     * is collected at check-in and the scrubber blocks filing without it, so the codec never has to
     * invent one.
     *
     * For a DEPENDENT claim these carry the SUBSCRIBER's address, and the dependent's own goes in
     * 2010CA below. Where a practice holds only one address for the family — the common case — the
     * caller passes the same values to both, which is a statement it can actually support.
     */
    ["N3", req.subscriberStreet ?? ""],
    ["N4", req.subscriberCity ?? "", req.subscriberState ?? "", req.subscriberZip ?? ""],
    ["DMG", "D8", isoToD8(req.dateOfBirth), req.subscriberGender ?? "U"],
    ["NM1", "PR", "2", req.payerName, "", "", "", "", "PI", req.payerId],
  ];

  /**
   * ── 2000C PATIENT LEVEL — emitted ONLY when the patient is not the subscriber ─────────────────
   *
   * Before this existed, a child covered under a parent's policy was filed as though the child WERE
   * the policy holder: their name in NM1*IL against the subscriber's member id, and SBR02 "18"
   * asserting they were the same person. A payer either rejects that outright or adjudicates it
   * against the wrong person's benefits.
   *
   * HL03 "23" = dependent level; HL04 "0" because nothing nests below a patient. PAT01 is the
   * relationship. NM1*QC is the patient's name — no identifier element, deliberately: a dependent
   * has no member id of their own, which is the entire reason this loop exists.
   */
  if (dependent) {
    segs.push(["HL", "3", "2", "23", "0"]);
    segs.push(["PAT", dependent.relationshipCode]);
    segs.push(["NM1", "QC", "1", dependent.lastName, dependent.firstName]);
    segs.push(["N3", dependent.street ?? ""]);
    segs.push(["N4", dependent.city ?? "", dependent.state ?? "", dependent.zip ?? ""]);
    segs.push(["DMG", "D8", isoToD8(dependent.dateOfBirth), dependent.gender ?? "U"]);
  }

  segs.push(
    /**
     * 2300 claim. CLM05 = "11:B:<frequency>" — office place of service, and the CLAIM FREQUENCY that
     * tells the payer whether it is seeing this claim for the first time.
     *
     * The frequency was hardcoded to "1". A claim corrected and refiled after a denial therefore
     * arrived carrying a CLM01 the payer already had, presented as a brand-new claim — which payers
     * deny as CARC 18, duplicate. The correction workflow reliably manufactured the next denial.
     * A replacement is frequency 7, and must quote the payer's own control number in REF*F8 or the
     * payer cannot tell what it replaces.
     */
    ["CLM", req.patientControlNumber, req.totalCharge.toFixed(2), "", "", ["11", "B", req.claimFrequency ?? "1"].join(COMP), "Y", "A", "Y", "Y"],
    ["DTP", "472", "D8", svcDate],
    ["REF", "D9", req.claimId]
  );

  // Guaranteed present for frequency 7 by the guard at the top — a replacement cannot be built
  // without it, so this is no longer the place where an absent reference is quietly tolerated.
  if (req.claimFrequency === "7") {
    segs.push(["REF", "F8", req.originalClaimControlNumber!.trim()]);
  }

  /**
   * ── 2310B RENDERING PROVIDER ─────────────────────────────────────────────────────────────────
   *
   * Position matters: inside the 2300 claim loop, after the claim's own segments and BEFORE the
   * 2400 service lines. A payer's parser reads these in order, and a provider loop appearing after
   * the first LX belongs to that service line's 2420 loop instead — a different assertion entirely.
   *
   * NM101 "82" = rendering provider; NM102 "1" = a person; NM108/09 "XX" = an NPI. No address:
   * 2310B carries none in this guide, because where the care was given is the 2010AA service
   * address and where the dentist personally lives is not the payer's business.
   */
  if (req.renderingProvider) {
    segs.push([
      "NM1",
      "82",
      "1",
      req.renderingProvider.lastName,
      req.renderingProvider.firstName,
      "",
      "",
      "",
      "XX",
      req.renderingProvider.npi,
    ]);
    /**
     * PRV — the dentist's specialty, and REQUIRED in this loop.
     *
     * PRV01 "PE" = performing provider; PRV02 "PXC" = the qualifier for a Health Care Provider
     * Taxonomy code; PRV03 the code itself. Without it the loop is incomplete and a clearinghouse
     * refuses the claim structurally: "Unexpected segment LX: segment PRV is the next required
     * segment". Found by a live clearinghouse, not by any test here — see `taxonomyCode`.
     */
    segs.push(["PRV", "PE", "PXC", req.renderingProvider.taxonomyCode]);
  }

  // 2400 service lines.
  for (const line of req.lines) {
    segs.push(["LX", String(line.lineNumber)]);
    // SV301 composite (AD = dental procedure code qualifier), SV302 charge, SV306 quantity.
    segs.push(["SV3", ["AD", line.procedureCode].join(COMP), line.chargeAmount.toFixed(2), "", "", "", String(line.quantity)]);
    if (line.toothNumber) {
      // TOO01 "JP" = the payer's tooth-numbering system; TOO03 carries surfaces.
      segs.push(["TOO", "JP", line.toothNumber, line.surfaces ?? ""]);
    }
    segs.push(["DTP", "472", "D8", isoToD8(line.serviceDate)]);
  }

  const stIndex = segs.findIndex((s) => s[0] === "ST");
  segs.push(["SE", String(segs.length - stIndex + 1), "0001"]);
  segs.push(["GE", "1", ctrl]);
  segs.push(["IEA", "1", ctrl]);
  return render(segs);
}

// ── 277CA: build + parse ──────────────────────────────────────────────────────────────

export interface X12AckLineError {
  lineNumber: number;
  /** The procedure the line carries — what a real payer names in SVC01, rather than our line number. */
  procedureCode: string;
  /** X12 status code (STC01-2). */
  code: string;
  message: string;
}

/**
 * A line-level status EXACTLY as the payer reported it, before anything decides which of our lines
 * it belongs to.
 *
 * ── WHY THIS IS NOT A LINE NUMBER (DEC-1) ──────────────────────────────────────────────────────
 * `parse277CA` used to read `SVC*AD:LINE2` and hand back `lineNumber: 2`. That composite is a
 * Mermaid invention: `build277CA` wrote it, `parse277CA` read it, and the round trip was perfect —
 * which is precisely why no fixture ever disagreed. A real payer puts the PROCEDURE in SVC01
 * (`AD:D0120`), so `/LINE(\d+)/` never matched, `currentLine` stayed null, and the line-level STC
 * was folded into the claim's own statuses. An acknowledgement accepting the claim while rejecting
 * one line therefore read as a rejected claim with no line errors — and the practice reworked and
 * refiled a claim the payer already held, which is the CARC 18 duplicate the REF*F8 guard exists to
 * prevent.
 *
 * The parser now reports what the payer said and nothing more. Deciding which submitted line a
 * status belongs to needs the claim, which this layer does not have — see `attributeLineStatuses`.
 */
export interface X12AckLineStatus {
  /** SVC01 component 2 — the procedure the payer is reporting on. Null when SVC01 was unreadable. */
  procedureCode: string | null;
  /**
   * REF*6R inside the 2220D loop — the SUBMITTER's line item control number, when the payer echoes
   * one.
   *
   * Mermaid's 837D does not currently send `REF*6R` (it emits `LX` only), so this is normally null
   * and no payer can be expected to return it. It is parsed because a clearinghouse that supplies
   * one is handing over the only unambiguous answer there is, and discarding it would force a
   * guess where none was needed.
   */
  lineItemControlNumber: string | null;
  /** 1-based position of this service loop within the claim, in the order the payer listed them. */
  sequence: number;
  /** X12 status code (STC01-2). */
  code: string;
  message: string;
}

export interface X12AckInput {
  patientControlNumber: string;
  payerControlNumber: string;
  payerName: string;
  accepted: boolean;
  /** STC01-1 status category, e.g. "A1" accepted, "A3" returned unprocessable. */
  statusCategory: string;
  /** STC01-2 status code, e.g. "19" entity acknowledges receipt, "33" subscriber not found. */
  statusCode: string;
  message: string;
  /** Total charge in DOLLARS. */
  totalCharge: number;
  lineErrors?: X12AckLineError[];
}

/** Build an X12 277CA claim acknowledgement (what the clearinghouse returns for an 837). */
export function build277CA(input: X12AckInput, now: Date = new Date()): string {
  const date = d8(now);
  const ctrl = controlNumber(input.payerControlNumber);
  const segs: string[][] = [
    ["ST", "277", "0001", "005010X214"],
    ["BHT", "0085", "08", ctrl, date, "0000", "TH"],
    ["NM1", "PR", "2", input.payerName],
    ["TRN", "2", input.patientControlNumber],
    [
      "STC",
      [input.statusCategory, input.statusCode].join(COMP),
      date,
      input.accepted ? "WQ" : "U",
      input.totalCharge.toFixed(2),
    ],
    ["REF", "1K", input.payerControlNumber],
    ["MSG", input.message],
  ];
  /**
   * Loop 2220D, in the shape a real payer sends it.
   *
   * This used to emit `SVC*AD:LINE2` — a line NUMBER where the guide puts a PROCEDURE. The mock
   * parsed its own invention perfectly and taught the rest of the system a 277CA that does not
   * exist. It now emits `AD:{procedureCode}`, which means the mock exercises the same attribution
   * path a payer's acknowledgement does, ambiguity included.
   *
   * No `REF*6R`: Mermaid's 837D does not send a line item control number, so a payer has nothing of
   * ours to echo, and inventing one here would restore exactly the false confidence just removed.
   */
  for (const err of input.lineErrors ?? []) {
    segs.push(["SVC", ["AD", err.procedureCode].join(COMP), "0.00"]);
    // STC12 is the free-form message. This wrote it at STC08 — the CHECK NUMBER field — which the
    // parser then read back, so the mock round-tripped a message a real payer puts four elements
    // further along. Positions matter in X12 exactly as much as they do in the 837.
    segs.push(["STC", ["A7", err.code].join(COMP), date, "U", "0.00", "", "", "", "", "", "", "", err.message]);
  }
  segs.push(["SE", String(segs.length + 1), "0001"]);
  return render(segs);
}

/** One claim the acknowledgement reports on, bound to the TRN segment that introduced it. */
export interface Parsed277CAClaim {
  /** TRN02 — Mermaid's own control number, echoed back. Null when the payer echoed none. */
  patientControlNumber: string | null;
  /** The payer/clearinghouse control number to quote in any follow-up (REF*1K). */
  payerControlNumber: string | null;
  accepted: boolean;
  statusCategory: string | null;
  statusCode: string | null;
  message: string;
  /** Line-level statuses as the payer reported them, unattributed. See `attributeLineStatuses`. */
  lineStatuses: X12AckLineStatus[];
}

export interface Parsed277CA {
  /**
   * 2200B information-receiver status — what happened to the TRANSMISSION, never to a claim.
   *
   * Kept apart from the claims deliberately (M19). A real 277CA carries STC segments at several
   * hierarchical levels, and a receiver-level "we got your batch" is not evidence about any claim
   * inside it. Folding the two together is how an A3 rejection gets overwritten by an A1 that was
   * talking about something else.
   */
  receiverStatus: { statusCategory: string | null; statusCode: string | null; message: string } | null;
  /** Every claim the acknowledgement reported on, in the order the payer listed them. */
  claims: Parsed277CAClaim[];
  trace: { segmentsTotal: number; statusSegments: number; skipped: string[] };
}

/**
 * X12 status categories that mean "the claim is in the payer's hands". Everything else is a
 * rejection. Listing acceptance explicitly (rather than treating unknown as fine) is deliberate: an
 * unrecognized status must never be read as "submitted", or a claim silently dies in a queue.
 */
const ACCEPTED_CATEGORIES = new Set(["A0", "A1", "A2"]);

/**
 * Parse an X12 277CA acknowledgement. Throws when the payload is not a 277 or carries no STC status
 * segment — a claim submission with no readable outcome must fail loud, not be assumed accepted.
 */
export function parse277CA(raw: string): Parsed277CA {
  const segments = parseSegments(raw);
  /**
   * The separator THIS payload declares, not the one Mermaid writes.
   *
   * `STC01` and `SVC01` are composites, and a real clearinghouse declared a BACKTICK in ISA16 — so
   * splitting on the hardcoded `:` left `statusCategory` as the unsplit "A1`20" and `statusCode`
   * null, and the accept/reject decision was made on that. Read from the payload, a 277CA from any
   * trading partner parses the same way.
   */
  const comp = componentSeparatorOf(raw);
  if (segments.length === 0) throw new Error("Empty EDI payload.");
  const st = segments.find((s) => s.id === "ST");
  if (!st || st.elements[0] !== "277") {
    throw new Error("Payload is not an X12 277 acknowledgement.");
  }

  const out: Parsed277CA = {
    receiverStatus: null,
    claims: [],
    trace: { segmentsTotal: segments.length, statusSegments: 0, skipped: [] },
  };

  /**
   * ── THE HL HIERARCHY, AND WHY IGNORING IT REPORTED A REFUSED CLAIM AS ACCEPTED ────────────────
   *
   * 005010X214 nests the acknowledgement: HL*20 information source → HL*21 information receiver →
   * HL*19 provider of service → HL*22/23/PT the patient, and only THERE does a claim (2200D) live.
   * Each level may carry its own TRN and its own STC, and a rejection at a level rejects everything
   * beneath it — the claims under a refused provider were never forwarded to anyone.
   *
   * This parser read a flat sequence: every TRN opened a claim. Mermaid's own `build277CA` emits no
   * HL segments, so nothing here ever noticed. A real one from Stedi does, and the effect was this:
   *
   *   HL*2 (21, receiver)  TRN*2*847856660      STC*A1`20        → pseudo-claim "847856660"
   *   HL*3 (19, PROVIDER)  TRN*1*0              STC*A7`562`85    → pseudo-claim "0"   ← the refusal
   *   HL*4 (PT, patient)   TRN*2*MRM513713041   STC*A1`20        → the real claim
   *
   * The provider-level A7 ("rejected — invalid NPI") landed in a pseudo-claim numbered "0" that
   * matches no submission and that nothing ever reads. `ackForClaim` looked up the patient control
   * number, found the PT-level A1, and returned ACCEPTED — for a claim the vendor had just refused
   * with `HTTP 400`, `"status":"ERROR"` and `Invalid NPI … Correct and resubmit`.
   *
   * A claim recorded as filed that was never filed is the worst outcome this codebase has: nobody
   * fixes it, nobody refiles it, and the practice discovers it when the timely-filing window has
   * closed. The unanimity rule below already refused to let a late A1 overwrite an earlier A3 — this
   * is the same rule, applied up the hierarchy instead of along the sequence.
   */
  const levels = new Map<string, { parent: string | null; statuses: { category: string; code: string | null }[] }>();
  /** HL01 of the innermost level open, or null before any HL — i.e. a flat payload. */
  let currentHl: string | null = null;
  /** True while the reader is inside a level that cannot hold a claim (20, 21, 19). */
  let inNonClaimLevel = false;

  /** Every rejecting status on the levels ABOVE a claim, outermost first. */
  const ancestorRejections = (hl: string | null) => {
    const found: { category: string; code: string | null }[] = [];
    for (let id = hl; id !== null; id = levels.get(id)?.parent ?? null) {
      for (const st of levels.get(id)?.statuses ?? []) {
        if (!ACCEPTED_CATEGORIES.has(st.category)) found.unshift(st);
      }
    }
    return found;
  };

  /** The service loop currently open (2220D), or null when the reader is at claim level. */
  let openLine: X12AckLineStatus | null = null;
  /** 1-based position of that loop within the claim, reset by `settle`. */
  let lineSequence = 0;
  let open: Parsed277CAClaim | null = null;
  /** The HL the open claim hangs from, so `settle` can walk its ancestors. */
  let openHl: string | null = null;
  /** Every claim-level status seen for the open claim. Acceptance must be unanimous — see below. */
  let openStatuses: { category: string; code: string | null }[] = [];

  /**
   * Settle the claim currently being read.
   *
   * ── ACCEPTANCE IS UNANIMOUS, AND A REJECTION IS WHAT GETS REPORTED ─────────────────────────────
   * A claim may carry several STC segments. The old parser let the LAST one win, so an A3 followed
   * by an A1 read as accepted — a claim recorded as filed that the payer had actually returned, and
   * therefore never fixed and never refiled. That is M2 by another route.
   *
   * So: accepted only when at least one claim-level status exists and EVERY one of them is an
   * accepting category; and the status reported out is the first NON-accepting one where there is
   * any, because that is the one a biller has to act on.
   */
  const settle = () => {
    const claim = open;
    if (!claim) return;
    /**
     * An ancestor's rejection is THIS claim's rejection, and it is reported ahead of the claim's own
     * status because it is the more fundamental fact: a claim under a refused provider did not fail
     * for its own reasons, it never went anywhere. Outermost first, so the reported code is the
     * highest-level thing wrong.
     */
    const inherited = ancestorRejections(openHl);
    const rejecting = inherited[0] ?? openStatuses.find((s) => !ACCEPTED_CATEGORIES.has(s.category));
    const reported = rejecting ?? openStatuses[0];
    claim.statusCategory = reported?.category ?? null;
    claim.statusCode = reported?.code ?? null;
    claim.accepted = openStatuses.length > 0 && rejecting === undefined;
    out.claims.push(claim);
    open = null;
    openHl = null;
    openStatuses = [];
    openLine = null;
    lineSequence = 0;
  };

  for (const seg of segments) {
    if (seg.id === "HL") {
      /**
       * HL01 id, HL02 parent, HL03 level code. Levels 20/21/19 are the source, the receiver and the
       * provider — structure, not claims. Anything else (22 subscriber, 23 dependent, PT patient) is
       * where 2200D claims live.
       */
      settle();
      const [id, parent, level] = seg.elements;
      currentHl = id || null;
      inNonClaimLevel = ["20", "21", "19"].includes(level ?? "");
      if (currentHl) levels.set(currentHl, { parent: parent || null, statuses: [] });
    } else if (seg.id === "TRN") {
      /**
       * A TRN opens a claim (2200D) — but ONLY below the provider. At the receiver and provider
       * levels the TRN is a batch or provider trace number, and treating it as a claim invented
       * claims numbered "847856660" and "0" that match no submission Mermaid ever made.
       */
      settle();
      if (inNonClaimLevel) continue;
      openHl = currentHl;
      open = {
        patientControlNumber: seg.elements[1] || null,
        payerControlNumber: null,
        accepted: false,
        statusCategory: null,
        statusCode: null,
        message: "",
        lineStatuses: [],
      };
    } else if (seg.id === "REF" && seg.elements[0] === "1K") {
      if (open) open.payerControlNumber = seg.elements[1] || null;
    } else if (seg.id === "MSG") {
      if (seg.elements[0]) {
        if (open) open.message = seg.elements[0];
        else if (out.receiverStatus) out.receiverStatus.message = seg.elements[0];
      }
    } else if (seg.id === "SVC") {
      /**
       * A service loop opens. SVC01 is a COMPOSITE — qualifier, procedure code, then modifiers —
       * so the procedure is component 2. Everything until the next SVC or TRN belongs to this line.
       *
       * No `/LINE(\d+)/`. That pattern read a Mermaid invention and matched nothing a payer sends;
       * the position is tracked here instead, and the procedure is taken from where the guide puts
       * it.
       */
      const components = (seg.elements[0] ?? "").split(comp);
      lineSequence += 1;
      openLine = {
        procedureCode: components[1]?.trim() || null,
        lineItemControlNumber: null,
        sequence: lineSequence,
        code: "",
        message: "",
      };
    } else if (seg.id === "REF" && seg.elements[0] === "6R") {
      // The submitter's own line control number, where a payer echoes one. Mermaid does not send
      // it today, so this is normally absent — but when present it is the unambiguous answer.
      if (openLine) openLine.lineItemControlNumber = seg.elements[1] || null;
    } else if (seg.id === "STC") {
      out.trace.statusSegments++;
      const [category, code] = (seg.elements[0] ?? "").split(comp);
      if (openLine && open) {
        // STC12 — the free-form message (elements are 0-based from STC01). This read element 7,
        // which is STC08, the check number: a real payer's message was silently lost and whatever
        // it did put in STC08 was shown to a biller as the payer's words.
        open.lineStatuses.push({ ...openLine, code: code ?? "", message: seg.elements[11] ?? "" });
        openLine = null;
      } else if (open) {
        openStatuses.push({ category: category ?? "", code: code ?? null });
      } else {
        /**
         * No claim is open, so this status is about a LEVEL — the batch, or the provider. Recorded
         * against that level so every claim beneath it inherits it; also surfaced as
         * `receiverStatus` for the first one, which is what that field has always meant.
         */
        if (currentHl) levels.get(currentHl)?.statuses.push({ category: category ?? "", code: code ?? null });
        out.receiverStatus ??= { statusCategory: category ?? null, statusCode: code ?? null, message: "" };
      }
    } else if (!["ISA", "GS", "ST", "BHT", "NM1", "SE", "GE", "IEA", "DTP", "QTY", "AMT"].includes(seg.id)) {
      out.trace.skipped.push(seg.id);
    }
  }
  settle();

  if (out.trace.statusSegments === 0) {
    throw new Error("277 contained no STC status segments.");
  }
  return out;
}

/** A line as Mermaid submitted it — the only thing that can say what the payer is talking about. */
export interface SubmittedServiceLine {
  lineNumber: number;
  procedureCode: string;
}

/** A payer line status matched to one of our lines, with the evidence that matched it. */
export interface AttributedLineError {
  lineNumber: number;
  procedureCode: string;
  code: string;
  message: string;
  /** How the match was made — recorded so a reader can weigh it rather than assume. */
  matchedBy: "line-control-number" | "unique-procedure-code" | "procedure-code-sequence";
}

/** A payer line status that could NOT be matched to exactly one submitted line. */
export interface UnattributedLineError {
  procedureCode: string | null;
  sequence: number;
  code: string;
  message: string;
  reason:
    /** SVC01 carried no readable procedure code. */
    | "no-procedure-code"
    /** The payer named a procedure this claim does not contain. */
    | "unknown-procedure-code"
    /** The claim carries this procedure more than once and nothing distinguishes which line. */
    | "ambiguous-duplicate-procedure";
}

/**
 * Decide which submitted line each reported status belongs to — or refuse to (DEC-1).
 *
 * ── WHY REFUSING IS A RESULT AND NOT A FAILURE ─────────────────────────────────────────────────
 * A 277CA names a PROCEDURE. A dental claim may legitimately carry the same procedure twice — two
 * fillings, two quadrants of scaling — and when it does, "D2391 was rejected" does not say which
 * one. Assigning it to the first match would be a guess presented as a fact: the biller corrects a
 * line the payer never complained about, refiles, and is rejected again for the line they never
 * touched.
 *
 * So this attributes only where the evidence is unambiguous, and hands back everything else as
 * unattributed with the reason. An unattributable line error is a real outcome — somebody has to
 * read the payer's own message — and it is strictly better than a confident wrong answer.
 *
 * Three ways a match can be certain, in order of strength:
 *   1. `REF*6R` — the payer echoing OUR line control number. Nothing beats being told.
 *   2. The claim carries that procedure exactly once. Then there is only one line it can mean.
 *   3. The claim carries it N times AND the payer reported exactly N statuses for it — the
 *      sequences align one-to-one, so the k-th reported is the k-th submitted. Any other count and
 *      they cannot be aligned, which is case `ambiguous-duplicate-procedure`.
 *
 * Pure, and separate from the parser on purpose: the parser reports what the payer said, this
 * decides what it means against a claim, and only the caller has both.
 */
export function attributeLineStatuses(
  statuses: readonly X12AckLineStatus[],
  submitted: readonly SubmittedServiceLine[]
): { attributed: AttributedLineError[]; unattributed: UnattributedLineError[] } {
  const norm = (code: string | null | undefined): string => (code ?? "").trim().toUpperCase();
  const linesByCode = new Map<string, SubmittedServiceLine[]>();
  for (const line of submitted) {
    const key = norm(line.procedureCode);
    if (!key) continue;
    linesByCode.set(key, [...(linesByCode.get(key) ?? []), line]);
  }

  // How many statuses the payer reported per procedure — the count that decides whether a
  // duplicated code can be aligned by sequence at all.
  const reportedPerCode = new Map<string, number>();
  for (const status of statuses) {
    const key = norm(status.procedureCode);
    if (key) reportedPerCode.set(key, (reportedPerCode.get(key) ?? 0) + 1);
  }
  const seenPerCode = new Map<string, number>();

  const attributed: AttributedLineError[] = [];
  const unattributed: UnattributedLineError[] = [];

  for (const status of statuses) {
    const control = (status.lineItemControlNumber ?? "").trim();
    const byControl = control
      ? submitted.find((line) => String(line.lineNumber) === control)
      : undefined;
    if (byControl) {
      attributed.push({
        lineNumber: byControl.lineNumber,
        procedureCode: byControl.procedureCode,
        code: status.code,
        message: status.message,
        matchedBy: "line-control-number",
      });
      continue;
    }

    const key = norm(status.procedureCode);
    if (!key) {
      unattributed.push({ ...bare(status), reason: "no-procedure-code" });
      continue;
    }

    const candidates = linesByCode.get(key) ?? [];
    if (candidates.length === 0) {
      // The payer named something this claim does not contain. Nothing is invented from it.
      unattributed.push({ ...bare(status), reason: "unknown-procedure-code" });
      continue;
    }
    if (candidates.length === 1) {
      attributed.push({
        lineNumber: candidates[0]!.lineNumber,
        procedureCode: candidates[0]!.procedureCode,
        code: status.code,
        message: status.message,
        matchedBy: "unique-procedure-code",
      });
      continue;
    }

    // Duplicated procedure. Alignable only when the payer reported as many as we submitted.
    if ((reportedPerCode.get(key) ?? 0) !== candidates.length) {
      unattributed.push({ ...bare(status), reason: "ambiguous-duplicate-procedure" });
      continue;
    }
    const index = seenPerCode.get(key) ?? 0;
    seenPerCode.set(key, index + 1);
    attributed.push({
      lineNumber: candidates[index]!.lineNumber,
      procedureCode: candidates[index]!.procedureCode,
      code: status.code,
      message: status.message,
      matchedBy: "procedure-code-sequence",
    });
  }

  return { attributed, unattributed };
}

const bare = (status: X12AckLineStatus) => ({
  procedureCode: status.procedureCode,
  sequence: status.sequence,
  code: status.code,
  message: status.message,
});

/**
 * Pick the claim an acknowledgement reports on for the control number we submitted.
 *
 * ── WHY A SELECTOR RATHER THAN A TOP-LEVEL STATUS (M19) ────────────────────────────────────────
 * `parse277CA` used to expose one global `accepted` and one global TRN, which is correct only while
 * Mermaid submits exactly one claim per call and the payer answers about exactly that claim. On a
 * batch acknowledgement the last TRN and the last STC won, so the answer could belong to somebody
 * else's claim. Making the caller name the claim it is asking about removes the guess.
 *
 * Returns null when the ack reports on several claims and none of them is ours — an outcome that is
 * genuinely UNKNOWN, and which callers must refuse rather than resolve in the reassuring direction.
 */
export function ackForClaim(parsed: Parsed277CA, patientControlNumber: string): Parsed277CAClaim | null {
  const matched = parsed.claims.find((c) => (c.patientControlNumber ?? "").trim() === patientControlNumber);
  if (matched) return matched;
  /**
   * One claim and no match is still handed back, on purpose. A payer that echoed NOTHING in TRN02
   * is not a mismatch — silence is legal, and refusing it would block filing through every
   * clearinghouse that does not populate the field. And where it echoed a DIFFERENT number, the
   * refusal belongs to ClaimService's acknowledgement-mismatch guard (M10), which already says the
   * right thing to a biller and leaves the claim fileable.
   */
  if (parsed.claims.length === 1) return parsed.claims[0] ?? null;
  return null;
}
