/**
 * X12 EDI 270/271 codec — dental eligibility subset. Ported verbatim (logic-for-logic) from Dental
 * Verify's proven `edi271.ts`; it is production code exercised on every mock verification. Kept as
 * the MOCK/dev implementation of the EDI adapter: EDI is bought via a clearinghouse in production
 * (blueprint doc 09), but this parser is the reference the normalized shapes are validated against.
 *
 * Money here is raw dollar figures as they appear in the X12 (EB07). Conversion to integer cents
 * happens at the adapter boundary (mock/index.ts), never in the wire codec.
 *
 * Subset (documented deliberately — full 5010 is payer-companion-guide specific):
 *   270: BHT, HL loops, NM1, DMG, DTP, EQ.  271: EB (01 1/6 eligibility; A coinsurance EB08 = the
 *   PATIENT's share as a fraction; C deductible / F limitation, EB06 22|23|25 benefit period or
 *   29 remaining) + MSG (CDT-only code lists attach to the coinsurance row they follow).
 * Unknown segments are counted and traced, never fatal.
 */
import type { OtherPayerEvidence, ProcedureCategory } from "@mermaid/shared";
import type { NetworkParticipation } from "../adapter.ts";
import { controlNumber, d8, ELEM, parseSegments, render, SEG, type X12Segment } from "./x12.ts";

// Re-exported for callers (and tests) that reach for the tokenizer alongside this codec.
export { parseSegments, type X12Segment };

const SERVICE_TYPE_TO_CATEGORY: Record<string, ProcedureCategory> = {
  "23": "diagnostic",
  "41": "preventive",
  "24": "basic",
  "25": "basic",
  "26": "basic",
  "28": "basic",
  "40": "basic",
  "36": "major",
  "39": "major",
  "38": "orthodontic",
};

export const CATEGORY_TO_SERVICE_TYPE: Record<ProcedureCategory, string> = {
  diagnostic: "23",
  preventive: "41",
  basic: "25",
  major: "36",
  orthodontic: "38",
};

export interface X12EligibilityRequest {
  payerName: string;
  payerId: string;
  providerName: string;
  providerNpi: string;
  subscriberLastName: string;
  subscriberFirstName: string;
  memberId: string;
  dateOfBirth: string;
  serviceDate?: Date;
}

/** Build an X12 270 dental eligibility inquiry. */
export function build270(req: X12EligibilityRequest, now: Date = new Date()): string {
  const ctrl = controlNumber(req.memberId + req.payerId);
  const date = d8(now);
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const dob = req.dateOfBirth.replace(/-/g, "");

  const segs: string[][] = [
    ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "CLINIC         ", "ZZ", req.payerId.padEnd(15, " "), date.slice(2), time, "^", "00501", ctrl, "0", "P", ":"],
    ["GS", "HS", "CLINIC", req.payerId, date, time, ctrl, "X", "005010X279A1"],
    ["ST", "270", "0001", "005010X279A1"],
    ["BHT", "0022", "13", ctrl, date, time],
    ["HL", "1", "", "20", "1"],
    ["NM1", "PR", "2", req.payerName, "", "", "", "", "PI", req.payerId],
    ["HL", "2", "1", "21", "1"],
    ["NM1", "1P", "2", req.providerName, "", "", "", "", "XX", req.providerNpi],
    ["HL", "3", "2", "22", "0"],
    ["NM1", "IL", "1", req.subscriberLastName, req.subscriberFirstName, "", "", "", "MI", req.memberId],
    ["DMG", "D8", dob],
    ["DTP", "291", "D8", d8(req.serviceDate ?? now)],
    ["EQ", "35"],
  ];
  const stIndex = segs.findIndex((s) => s[0] === "ST");
  const bodyCount = segs.length - stIndex + 1;
  segs.push(["SE", String(bodyCount), "0001"]);
  segs.push(["GE", "1", ctrl]);
  segs.push(["IEA", "1", ctrl]);
  return render(segs);
}

export interface Benefits271Input {
  payerName: string;
  planName: string;
  memberId: string;
  active: boolean;
  coveragePercentages: Record<ProcedureCategory, number>;
  deductibleAnnual: number;
  deductibleRemaining: number;
  annualMaximum: number;
  annualMaximumRemaining: number;
  /**
   * The subscriber's date of birth, emitted as `DMG*D8*CCYYMMDD` — the payer restating whose record
   * it answered about.
   *
   * The builder must be ABLE to emit it, or `subscriberDateOfBirth` is a parsed field no test can
   * prove comes off real input: exactly the shape of the coverage-date defect, where a permanently
   * null value and "the payer did not say" were indistinguishable.
   */
  subscriberDateOfBirth?: string | null;
  /** Coverage window, when the payer states one (DTP*346 / DTP*347). */
  effectiveDate?: string | null;
  terminationDate?: string | null;
  messages?: string[];
  /**
   * Another plan this payer says the patient holds — emitted as `EB*R` with its 2120 loop naming
   * the plan as the secondary payer. Placed LAST, after the patient's own dates and messages, so the
   * patient's coverage window is never read inside the other plan's context.
   */
  otherCoverage?: { name: string; idQualifier: string | null; id: string | null };
  /**
   * Extra `EB*C` / `EB*F` segments for OTHER service types, emitted before the dental ones.
   *
   * ── WHY THE BUILDER NEEDS THIS (M9) ──────────────────────────────────────────────────────────
   * A real payer answering a dental inquiry routinely quotes several service types — the dental
   * annual maximum (`35`) alongside an orthodontic lifetime maximum (`38`) or a general health-plan
   * figure (`30`). This builder emitted only `35`, so no fixture could ever produce a second
   * candidate for a slot and the parser's failure to read EB03 was invisible: exactly the blind spot
   * the "do not test a codec only against its own writer" rule names.
   *
   * Emitted BEFORE the dental segments deliberately, because the defect was first-wins on an equal
   * rank. A fixture that put them after would pass with or without the fix.
   */
  otherServiceTypeBenefits?: {
    /** EB01: `C` deductible, `F` limitation/maximum. */
    kind: "C" | "F";
    /** EB03 service type — anything other than `35`, e.g. `38` orthodontia. */
    serviceType: string;
    /** EB06: `23` annual total, `29` remaining. */
    timeQualifier: "23" | "29";
    amount: number;
    /** EB02 coverage level; defaults to `IND`. */
    coverageLevel?: string;
  }[];
}

/** Build an X12 271 response (mock transport). Real integrations receive this from a clearinghouse. */
export function build271(input: Benefits271Input, now: Date = new Date()): string {
  const ctrl = controlNumber(input.memberId + input.payerName);
  const date = d8(now);
  const segs: string[][] = [
    ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", input.payerName.slice(0, 15).padEnd(15), "ZZ", "CLINIC         ", date.slice(2), "0000", "^", "00501", ctrl, "0", "P", ":"],
    ["GS", "HB", input.payerName.slice(0, 15), "CLINIC", date, "0000", ctrl, "X", "005010X279A1"],
    ["ST", "271", "0001", "005010X279A1"],
    ["BHT", "0022", "11", ctrl, date, "0000"],
    ["HL", "1", "", "20", "1"],
    ["NM1", "PR", "2", input.payerName],
    ["HL", "2", "1", "21", "1"],
    ["NM1", "1P", "2", "CLINIC"],
    ["HL", "3", "2", "22", "0"],
    ["NM1", "IL", "1", "", "", "", "", "", "MI", input.memberId],
  ];

  // DMG follows the subscriber's NM1, as it does in a real 271.
  if (input.subscriberDateOfBirth) {
    segs.push(["DMG", "D8", input.subscriberDateOfBirth.replace(/-/g, "")]);
  }

  if (input.active) {
    segs.push(["EB", "1", "IND", "35", "", input.planName]);
    for (const [category, svc] of Object.entries(CATEGORY_TO_SERVICE_TYPE)) {
      const pct = input.coveragePercentages[category as ProcedureCategory] ?? 0;
      // EB08 is the PATIENT's share, as a real payer sends it — 80% coverage is `.2`. This wrote the
      // plan's share, which matched the parser's inverted reading and hid it from every test.
      segs.push(["EB", "A", "IND", svc, "", "", "", "", String(Math.round(100 - pct) / 100)]);
    }
    // Other service types FIRST, so a fixture reproduces the first-wins ordering the M9 defect had.
    for (const extra of input.otherServiceTypeBenefits ?? []) {
      segs.push([
        "EB",
        extra.kind,
        extra.coverageLevel ?? "IND",
        extra.serviceType,
        "",
        "",
        extra.timeQualifier,
        String(extra.amount),
      ]);
    }
    segs.push(["EB", "C", "IND", "35", "", "", "23", String(input.deductibleAnnual)]);
    segs.push(["EB", "C", "IND", "35", "", "", "29", String(input.deductibleRemaining)]);
    segs.push(["EB", "F", "IND", "35", "", "", "23", String(input.annualMaximum)]);
    segs.push(["EB", "F", "IND", "35", "", "", "29", String(input.annualMaximumRemaining)]);
  } else {
    segs.push(["EB", "6", "IND", "35", "", input.planName]);
  }
  // The coverage window, exactly as a payer states it. Emitted so the mock can exercise the
  // service-date-outside-coverage path that used to be unrepresentable.
  const d8of = (iso: string) => iso.replace(/-/g, "");
  if (input.effectiveDate) segs.push(["DTP", "346", "D8", d8of(input.effectiveDate)]);
  if (input.terminationDate) segs.push(["DTP", "347", "D8", d8of(input.terminationDate)]);

  for (const m of input.messages ?? []) segs.push(["MSG", m]);

  if (input.otherCoverage) {
    const o = input.otherCoverage;
    segs.push(["EB", "R", "IND", "35", "GP", "OTHER DENTAL COVERAGE"]);
    segs.push(["LS", "2120"]);
    segs.push(["NM1", "SEP", "2", o.name, "", "", "", "", o.idQualifier ?? "", o.id ?? ""]);
    segs.push(["LE", "2120"]);
  }

  const stIndex = segs.findIndex((s) => s[0] === "ST");
  segs.push(["SE", String(segs.length - stIndex + 1), "0001"]);
  segs.push(["GE", "1", ctrl]);
  segs.push(["IEA", "1", ctrl]);
  return render(segs);
}

/**
 * How well an EB segment matches the person we are actually verifying.
 *
 * ── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────────────────────────
 * A real payer's 271 does not carry one deductible. It carries several, for different scopes of the
 * same plan: individual and family, in-network and out-of-network, sometimes per service type. The
 * parser read EB01 and EB07 and wrote every one of them into the same slot, so the LAST segment in
 * the file won.
 *
 * On a perfectly ordinary Delta Dental response that produced:
 *
 *     deductible      $200  (the out-of-network one)   instead of  $50
 *     annual maximum  $4,500 / $3,900 (the FAMILY one) instead of  $1,500 / $1,200
 *
 * The estimate then believed the patient had $2,700 of benefit they did not have. Mermaid would
 * have told the practice insurance was going to pay, the payer would have stopped at $1,200, and
 * the practice would have eaten the difference or re-billed a patient it had already quoted.
 *
 * It never showed up in testing because `build271` only ever emits `IND` with no network qualifier,
 * so every fixture had exactly one candidate per slot and last-wins was indistinguishable from
 * correct.
 *
 * EB02 is the coverage level (`IND` / `FAM`) and EB12 is in-plan-network (`Y` / `N`). A verification
 * is about one person being treated by this practice, so the individual in-network benefit is the
 * one that applies. Lower-precedence segments are still accepted when nothing better arrives — a
 * payer that sends only family benefits should not leave us with nothing — but they may never
 * overwrite a better match.
 */
/**
 * `CCYYMMDD` → `YYYY-MM-DD`. Returns null for anything else — a malformed date must not become a
 * real one.
 *
 * ── THE BUG THIS LINE CARRIED ──────────────────────────────────────────────────────────────────
 * The test was `/^d{8}$/` — a missing backslash, so it matched the literal string `"dddddddd"` and
 * nothing else. `isoDay` therefore returned null for EVERY real date, which meant `DTP*346` and
 * `DTP*347` were parsed, discarded, and reported as "the payer did not say".
 *
 * Nothing failed. `coverage.effectiveDate` and `coverage.terminationDate` are legitimately nullable
 * — null means the payer was silent — so a permanent null is indistinguishable from a quiet payer.
 * The coverage-window engine downstream is correct and well covered, but its tests build a
 * `Benefits` object directly, so no test ever drove a date from raw X12 through this function. The
 * whole termination-detection path was dead in production: a patient whose plan had ended verified
 * clean, and the claim was filed into a guaranteed denial.
 *
 * The lesson is the codec rule one level deeper than "do not test a codec against its own writer":
 * here the writer emitted the segments correctly and the READER silently dropped them, so a
 * round-trip test through `build271` would still have caught nothing without asserting the values.
 */
function isoDay(d8: string | undefined): string | null {
  const v = (d8 ?? "").trim();
  if (!/^\d{8}$/.test(v)) return null;
  /**
   * Eight digits is the X12 shape, not proof of a real day: `20261301` and `20260230` both pass a
   * digit test and neither is a date. Reconstructing through `Date.UTC` and comparing back rejects
   * an overflowed month or day, which JavaScript would otherwise roll forward into a plausible
   * WRONG date — `20260230` silently becoming March 2nd. A coverage window is used to decide whether
   * a plan had ended on the date of service, so a date that is off by days is worse than no date:
   * null is reported as "the payer did not say", which is honest and blocks nothing incorrectly.
   */
  const [y, m, d] = [Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8))];
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

const NO_MATCH = -1;

/** EB03 for dental care. A 271 answering a dental inquiry states this on the segments that matter. */
const DENTAL_SERVICE_TYPE = "35";

/**
 * The dental service types this codec recognises as CATEGORIES — the same ten that
 * `SERVICE_TYPE_TO_CATEGORY` maps, derived from it so the two lists cannot drift apart.
 *
 * A plan-level figure is legitimately stated under one of these as well as under `35`: a payer may
 * quote the annual maximum against major services (`36`) rather than against dental care in general.
 */
const DENTAL_CATEGORY_SERVICE_TYPES: ReadonlySet<string> = new Set(Object.keys(SERVICE_TYPE_TO_CATEGORY));

/** EB03 `30`, "Health Benefit Plan Coverage": the plan as a whole, whatever kind of plan it is. */
const PLAN_COVERAGE_SERVICE_TYPE = "30";

/**
 * EB03 `38`. A category like the others for COINSURANCE, but never for a plan-level deductible or
 * maximum: orthodontia carries its own, usually lifetime, deductible and maximum. Live BCBS of
 * California states only its orthodontic deductible ($0) under an annual period, and admitting it as
 * a category fallback made the plan's annual deductible $0 beside a stated $50 remaining.
 */
const ORTHODONTIC_SERVICE_TYPE = "38";

/**
 * Service types only a MEDICAL benefit set uses: medical care, hospital, home health, emergency,
 * pharmacy, physician visits, chiropractic, and every letter-led code (vision, mental health, urgent
 * care…). Deliberately NOT here: `2` surgical, `3` consultation, `4` diagnostic X-ray, `5` lab,
 * `7` anesthesia — dental payers use those too (Cigna's live dental 271 states `4` and `7`).
 *
 * Used for one decision only: whether a 271 is a DENTAL plan's answer, so that its `30` figures are
 * the dental plan's own. One of these anywhere in the file means a medical benefit set is present,
 * and then `30` is the medical plan's deductible — the Aetna sandbox case B1 exists for.
 */
function isMedicalOnlyServiceType(code: string): boolean {
  if (/^[A-Z][A-Z0-9]$/.test(code)) return true;
  if (!/^\d{1,2}$/.test(code)) return false;
  const n = Number(code);
  return n === 1 || n === 6 || (n >= 8 && n <= 22) || n === 33 || n === 34 || (n >= 42 && n <= 59) || n >= 61;
}

/**
 * Whether this 271 answers for a DENTAL plan and nothing else.
 *
 * ── WHY `30` NEEDS THIS ────────────────────────────────────────────────────────────────────────
 * B1 refused `30` everywhere, because the Aetna sandbox answered a dental inquiry with a medical
 * plan and its `30` deductible became the patient's dental one. Correct for that file, and wrong for
 * every dental payer that states its plan-level figures under `30`: live Cigna and UnitedHealthcare
 * dental 271s (2026-10-15) put the $50 deductible and the $2,000 maximum ONLY there. With `30`
 * refused, Cigna's maximum fell through to a $0 limit on four 3D-imaging codes and the patient was
 * quoted "annual maximum $0" — no benefit left — on a plan with $2,000 of it.
 *
 * So `30` is admitted when the file carries positive dental evidence (`35` or a dental category on
 * some EB) and no medical-only service type anywhere. Fail-closed: an unrecognised code is neither,
 * and a mixed medical-and-dental answer keeps `30` refused, exactly as B1 decided.
 */
function isDentalPlanResponse(segments: X12Segment[]): boolean {
  let dentalEvidence = false;
  for (const seg of segments) {
    if (seg.id !== "EB") continue;
    for (const component of (seg.elements[2] ?? "").split("^")) {
      const code = component.trim().toUpperCase();
      if (code === "") continue;
      if (isMedicalOnlyServiceType(code)) return false;
      if (code === DENTAL_SERVICE_TYPE || DENTAL_CATEGORY_SERVICE_TYPES.has(code)) dentalEvidence = true;
    }
  }
  return dentalEvidence;
}

/**
 * EB06 qualifiers that state the plan's benefit PERIOD: `23` calendar year, `22` service year,
 * `25` contract. All three are "the annual figure" — which one a payer uses is its plan year, not a
 * different benefit. Live MetLife states its $1,250 maximum and $50 deductible only under `22`, and
 * live BCBS of California its $1,500 maximum only under `25`; reading `23` alone discarded both.
 * `32`/`33` (lifetime) are never annual: an orthodontic lifetime maximum is a different benefit.
 */
const BENEFIT_PERIOD_QUALIFIERS: ReadonlySet<string> = new Set(["22", "23", "25"]);
const REMAINING_QUALIFIER = "29";

/**
 * A MSG that is nothing but CDT codes: "D2140 D2150 D2160". Cigna attaches these to coinsurance
 * rows to say which procedures a rate covers. Matched whole and strictly — free text is never read
 * for money, so "MAJOR RESTORATIVE" or a sentence that mentions a code does not qualify.
 */
const CDT_CODE_LIST = /^D\d{4}(?: D\d{4})*$/;

/**
 * How well an EB03 qualifies a deductible or maximum for THIS patient's dental estimate.
 *
 * ── WHY A NON-DENTAL TYPE IS REJECTED RATHER THAN RANKED LAST ──────────────────────────────────
 * This used to score `35 → 2`, empty `→ 1`, everything else `→ 0`. Because the accept test is
 * `rank > (previous ?? NO_MATCH)` and `NO_MATCH` is −1, a rank of 0 still beat "nothing chosen" —
 * so the FIRST non-dental figure in the file was admitted whenever no dental one existed.
 *
 * Against a real Aetna 271 that answered a dental inquiry with a medical benefit set, that made
 * `EB*F*FAM*48***23*240` — a hospital-inpatient, family-scope limitation — the patient's dental
 * annual maximum, and medical `EB*C` segments the deductible. Both then scored 0.9 confidence,
 * because confidence tests non-nullness and not provenance. A coordinator read "$240 annual
 * maximum" as this patient's dental benefit.
 *
 * A wrong-service-type figure is not a worse answer to the same question — it is the answer to a
 * different one, which is this function's own founding argument (see the M9 note below). So it is
 * refused outright: absent is honest and drives confidence down automatically, where a fabricated
 * dollar figure is neither.
 *
 * ── ORDERING ───────────────────────────────────────────────────────────────────────────────────
 *   3  `35`  — dental care, stated explicitly. The best possible qualification.
 *   2  ``    — unqualified. "Unqualified sits between the wanted type and any other" (M9): a payer
 *              that omitted EB03 is more likely describing the plan generally than a sub-category,
 *              so it must still outrank a specific non-`35` dental type. `30` ranks here too, but
 *              only in a dental plan's own answer (`isDentalPlanResponse`).
 *   1  one of the category types except `38` — real dental evidence, but about a category rather
 *              than the plan, so it loses to both of the above.
 *   NO_MATCH  anything else — refused, including `38` (`ORTHODONTIC_SERVICE_TYPE`).
 *
 * ── COMPOSITES ─────────────────────────────────────────────────────────────────────────────────
 * EB03 can carry several codes (`UC^86`, `48^50`). Each component is judged on its own, and a
 * segment carrying ANY non-dental component is refused entirely rather than admitted on the
 * strength of its acceptable half — a benefit qualified as both dental and something else does not
 * establish a dental figure, and guessing which half the amount belongs to is exactly the kind of
 * inference this function exists to prevent.
 */
function serviceTypeRank(serviceType: string | undefined, dentalPlan = false): number {
  const raw = (serviceType ?? "").trim().toUpperCase();
  let best = NO_MATCH;
  for (const component of raw.split("^")) {
    const code = component.trim();
    /**
     * `30` in a dental plan's own answer is that plan's general figure — ranked with the
     * unqualified one (2), because both describe the plan rather than a category, and below `35`.
     * Anywhere else it is refused (B1). See `isDentalPlanResponse`.
     */
    const rank =
      code === DENTAL_SERVICE_TYPE
        ? 3
        : code === "" || (code === PLAN_COVERAGE_SERVICE_TYPE && dentalPlan)
          ? 2
          : DENTAL_CATEGORY_SERVICE_TYPES.has(code) && code !== ORTHODONTIC_SERVICE_TYPE
            ? 1
            : NO_MATCH;
    // One non-dental component disqualifies the whole segment, however good its siblings are.
    if (rank === NO_MATCH) return NO_MATCH;
    if (rank > best) best = rank;
  }
  return best;
}

/**
 * Which scope of a benefit applies to the patient in the chair: coverage level and network column.
 * Shared by the dollar figures (`benefitPrecedence`) and by coinsurance, which used to have no
 * precedence at all — see the coinsurance note in `parse271`.
 */
function scopeRank(
  coverageLevel: string | undefined,
  inNetwork: string | undefined,
  participation: NetworkParticipation
): number {
  const level = (coverageLevel ?? "").trim().toUpperCase();
  const network = (inNetwork ?? "").trim().toUpperCase();
  // Anything explicitly about a scope we are not asking about. `IND` covers the subscriber and each
  // dependent individually, which is what a chairside verification is about.
  const levelRank = level === "IND" ? 2 : level === "" ? 1 : 0; // FAM and anything else rank lowest
  const wanted = participation === "out-of-network" ? "N" : "Y";
  /**
   * `W` is X12's "not applicable": the benefit applies whichever network the provider is in. It is
   * the unqualified case stated explicitly, so it ranks with an empty EB12 — not with the column we
   * are NOT in, where it used to land. Every live dental payer sampled sends `W` on plan figures.
   */
  const networkRank = network === wanted ? 2 : network === "" || network === "W" ? 1 : 0;
  return levelRank * 3 + networkRank;
}

function benefitPrecedence(
  coverageLevel: string | undefined,
  inNetwork: string | undefined,
  participation: NetworkParticipation = "unknown",
  serviceType: string | undefined = undefined,
  dentalPlan = false
): number {
  const service = (serviceType ?? "").trim().toUpperCase();

  /**
   * V3 — which network column applies is the PRACTICE's fact, not the payer's.
   *
   * The wanted side always outranks the other; an unqualified segment sits between them, because a
   * payer that did not say is more likely describing the plan generally than the column we are not
   * in. `unknown` keeps the original preference for `Y`, which is correct for the CO-45-writing
   * in-network practice this system was built for and is the behaviour every existing deployment
   * already has — but it is a DEFAULT, not a determination, and `participationFor` says so.
   * The level and network ranks live in `scopeRank`, shared with coinsurance.
   */
  const scope = scopeRank(coverageLevel, inNetwork, participation);

  /**
   * ── M9 — EB03 IS PART OF WHICH FIGURE THIS IS ─────────────────────────────────────────────────
   *
   * EB03 is the service type the benefit describes, and it was ignored entirely. A payer answering a
   * dental inquiry frequently quotes more than one: the dental annual maximum (`35`) alongside an
   * ORTHODONTIC lifetime maximum (`38`), or a general health-plan figure (`30`). Every one of those
   * arrives as `EB*F*IND*<type>*…*23*<amount>` and landed in the same slot.
   *
   * Because the old rank was identical for all of them and the comparison is strictly-greater
   * (`rank > chosen`), the FIRST one in the file won. Which figure a patient was quoted against
   * therefore depended on segment order: an ortho lifetime maximum listed first became the plan's
   * annual maximum. Capped low the patient is over-quoted and declines treatment; capped high the
   * practice is promised money the payer will not pay and absorbs the difference — the same defect
   * class as the family-vs-individual bug this function was written to fix, one element over.
   *
   * It ranks ABOVE the other two dimensions because it decides WHICH BENEFIT this is, where they
   * only decide which column of it applies. An in-network individual ORTHODONTIC maximum is not a
   * better answer for the dental maximum than an unqualified dental one — it is a different number.
   *
   * `build271` emits only `35`, which is exactly why this survived: no fixture could produce a
   * second service type. It now can — see `extraServiceTypeBenefits`.
   */
  const serviceRank = serviceTypeRank(service, dentalPlan);
  // Refused outright, not ranked last: `rank > (previous ?? NO_MATCH)` would otherwise admit a
  // rank-0 candidate whenever nothing had been chosen yet, which is the defect this closes.
  if (serviceRank === NO_MATCH) return NO_MATCH;

  // `scope` is at most 8, so the service type always dominates it.
  return serviceRank * 9 + scope;
}

/** Two or more rates the payer stated for the same thing, at the same scope. */
export interface CoinsuranceConflict {
  scope: "category" | "procedure";
  /** The procedure category, or the CDT code. */
  key: string;
  /** Every plan percentage stated for it, ascending. The lowest is the one quoted. */
  planPercents: number[];
}

export interface Parsed271 {
  eligibility: "active" | "inactive" | "unknown";
  payerName: string | null;
  planName: string | null;
  memberId: string | null;
  /** What the PLAN pays, 0–100, per category — never the patient's coinsurance. See `parse271`. */
  coveragePercentages: Partial<Record<ProcedureCategory, number>>;
  /**
   * What the plan pays for one CDT code, when the payer listed the code against a rate (Cigna's
   * convention: a coinsurance row followed by MSG segments that are only CDT codes). More specific
   * than the category, so the estimate prefers it. Empty for payers that do not list codes.
   */
  procedureCoveragePercentages: Record<string, number>;
  /**
   * The subscriber's date of birth AS THE PAYER ECHOED IT (DMG02), ISO, or null when absent.
   *
   * Read so a caller can check the payer answered about the person we asked about (M10). DMG was in
   * the ignore list, so the one field that could contradict a mis-keyed member ID was discarded.
   */
  subscriberDateOfBirth: string | null;
  /**
   * The coverage window the payer stated (DTP*346 begin / DTP*347 end, or a DTP*291 RD8 range).
   * Null means the payer did not say — never that the coverage is open-ended.
   */
  coverage: { effectiveDate: string | null; terminationDate: string | null };
  deductible: { annual: number | null; remaining: number | null };
  annualMaximum: { amount: number | null; remaining: number | null };
  messages: string[];
  /** EB*R + 2120: other plans the payer says this patient has. Evidence only — see `Benefits`. */
  otherPayers: OtherPayerEvidence[];
  trace: {
    segmentsTotal: number;
    benefitSegments: number;
    skipped: string[];
    /** EB segments that described a real benefit for a scope we did not choose (family, out-of-network). */
    supersededBenefits: number;
    /**
     * Where the payer stated different rates for one category or code at the SAME scope. The lowest
     * plan percentage was quoted; this says that a choice was made, so the review can see it.
     */
    coinsuranceConflicts: CoinsuranceConflict[];
  };
}

/**
 * Parse an X12 271 into a normalized partial benefits picture. Throws when the payload is not a 271
 * or carries no benefit info — garbage must fail loud, not produce a silent zero-benefit plan.
 */
export function parse271(raw: string, participation: NetworkParticipation = "unknown"): Parsed271 {
  const segments = parseSegments(raw);
  if (segments.length === 0) throw new Error("Empty EDI payload.");
  const st = segments.find((s) => s.id === "ST");
  if (!st || st.elements[0] !== "271") {
    throw new Error("Payload is not an X12 271 transaction.");
  }

  const out: Parsed271 = {
    eligibility: "unknown",
    payerName: null,
    planName: null,
    memberId: null,
    coveragePercentages: {},
    procedureCoveragePercentages: {},
    subscriberDateOfBirth: null,
    coverage: { effectiveDate: null, terminationDate: null },
    deductible: { annual: null, remaining: null },
    annualMaximum: { amount: null, remaining: null },
    messages: [],
    otherPayers: [],
    trace: {
      segmentsTotal: segments.length,
      benefitSegments: 0,
      skipped: [],
      supersededBenefits: 0,
      coinsuranceConflicts: [],
    },
  };

  const dentalPlan = isDentalPlanResponse(segments);

  /**
   * ── COINSURANCE IS THE PATIENT'S SHARE ─────────────────────────────────────────────────────────
   *
   * EB01 `A` is co-insurance, and EB08 is the percentage THE PATIENT pays (X12 005010X279A1; Stedi:
   * "co-insurance represents the percentage of a benefit patients are responsible for"). This codec
   * stored EB08 as the percentage the PLAN pays, and its own `build271` wrote it the same way, so the
   * mock agreed with the parser and every test passed — a closed loop with the meaning inverted.
   *
   * Measured against five live Stedi dental 271s (2026-10-15): Ameritas sends `EB*A**35*****0`
   * immediately followed by "TYPE 1 PROCEDURES COVERED AT 100%", and BCBS of California pairs
   * `EB*D…*1` (plan 100%) with `EB*A…*0` (patient 0%) on the same row. Read the old way, preventive
   * care showed as 0% covered, an 80% basic benefit as 20%, and an orthodontic benefit the payer
   * EXCLUDES (`EB*A**38…*1`, patient pays 100%) as 100% covered. Every estimate against a real payer
   * would have split insurance and patient the wrong way round.
   *
   * ── AND IT NEEDS THE SAME PRECEDENCE AS EVERY OTHER FIGURE ──────────────────────────────────────
   * Coinsurance had none: the last row for a category won. Payers send in- and out-of-network rows
   * for every category (Cigna, MetLife, BCBS CA all do), so the out-of-network rate routinely
   * replaced the in-network one. It now ranks by scope (`scopeRank`), and within a category prefers
   * the category's own service type (`25` for basic restorative over `40` oral surgery).
   *
   * When a payer states two different rates for the same category at the same scope — Cigna's `25`
   * row is 90% for fillings and 60% for inlays and onlays — no rule here can know which procedure is
   * meant. The LOWER plan percentage is quoted, so the patient is never promised coverage the payer
   * did not state for them, and the conflict is recorded so a reviewer sees that a choice was made.
   * Where the payer listed the codes (`CDT_CODE_LIST`), the per-code rate removes the guess.
   */
  type RateCandidates = { rank: number; planPercents: Set<number> };
  const categoryRates = new Map<ProcedureCategory, RateCandidates>();
  const procedureRates = new Map<string, RateCandidates>();
  const offerRate = <K>(rates: Map<K, RateCandidates>, key: K, rank: number, planPercent: number): void => {
    const current = rates.get(key);
    if (!current || rank > current.rank) {
      if (current) out.trace.supersededBenefits++;
      rates.set(key, { rank, planPercents: new Set([planPercent]) });
    } else if (rank === current.rank) {
      current.planPercents.add(planPercent);
    } else {
      out.trace.supersededBenefits++;
    }
  };
  /** The coinsurance row a following run of CDT-list MSGs belongs to; any other segment ends it. */
  let codeListFor: { rank: number; planPercent: number } | null = null;

  /**
   * ── LOOP 2120 IS SOMEBODY ELSE ────────────────────────────────────────────────────────────────
   * Between `LS*2120` and `LE*2120` the segments describe a benefit-related ENTITY — for `EB*R`, the
   * other payer. Its NM1 can carry entity code `PR`, exactly like the information source's own NM1
   * in 2100A. The parser used to read every `NM1*PR` as "the payer", last one winning, so a 271
   * that named the patient's other plan silently REPLACED the patient's payer with it — every
   * estimate and claim then described the wrong insurer. Tracking the loop is what makes the other
   * payer readable at all, and it is also the fix for that.
   */
  let inRelatedEntity = false;
  let currentOther: OtherPayerEvidence | null = null;
  const OTHER_PAYER_ROLE: Record<string, OtherPayerEvidence["role"]> = {
    PRP: "primary",
    SEP: "secondary",
    TTP: "tertiary",
    PR: "unspecified",
  };

  type BenefitSlot = "deductibleAnnual" | "deductibleRemaining" | "maximumAmount" | "maximumRemaining";
  const chosen: Partial<Record<BenefitSlot, number>> = {};

  for (const seg of segments) {
    // A code list belongs only to the coinsurance row it IMMEDIATELY follows.
    if (seg.id !== "MSG") codeListFor = null;
    if (seg.id === "LS" && seg.elements[0] === "2120") {
      inRelatedEntity = true;
    } else if (seg.id === "LE" && seg.elements[0] === "2120") {
      inRelatedEntity = false;
    } else if (seg.id === "NM1" && inRelatedEntity) {
      // Inside 2120: the entity is someone else. Only a payer-type entity after an EB*R is recorded.
      const role = OTHER_PAYER_ROLE[seg.elements[0] ?? ""];
      if (currentOther && role) {
        currentOther.role = role;
        currentOther.name = (seg.elements[2] ?? "").trim() || null;
        currentOther.idQualifier = (seg.elements[7] ?? "").trim() || null;
        currentOther.id = (seg.elements[8] ?? "").trim() || null;
      }
    } else if (seg.id === "NM1" && seg.elements[0] === "PR") {
      out.payerName = seg.elements[2] || null;
    } else if (seg.id === "NM1" && seg.elements[0] === "IL") {
      out.memberId = seg.elements[8] || null;
    } else if (seg.id === "MSG") {
      if (seg.elements[0]) out.messages.push(seg.elements[0]);
      const text = (seg.elements[0] ?? "").trim();
      if (codeListFor && CDT_CODE_LIST.test(text)) {
        for (const code of text.split(" ")) offerRate(procedureRates, code, codeListFor.rank, codeListFor.planPercent);
      }
    } else if (seg.id === "EB") {
      out.trace.benefitSegments++;
      const [eb01, eb02, eb03, eb04, eb05, eb06, eb07, eb08, , , , eb12, eb13] = seg.elements;
      /**
       * EB13 names ONE procedure. A figure about one code is not the plan's figure, and payers use
       * these rows for different things — MetLife for per-code age and frequency rules, Ameritas
       * for per-code rates that contradict its own category rows. Never read as a plan figure.
       */
      const perProcedure = (eb13 ?? "").trim() !== "";
      // A new EB closes the previous benefit's context; only an EB*R opens an other-payer one.
      currentOther = null;
      if (eb01 === "R") {
        currentOther = {
          role: "unspecified",
          name: null,
          idQualifier: null,
          id: null,
          insuranceType: (eb04 ?? "").trim() || null,
          planDescription: (eb05 ?? "").trim() || null,
        };
        out.otherPayers.push(currentOther);
      } else if (eb01 === "1") {
        out.eligibility = "active";
        if (eb05) out.planName = eb05;
      } else if (eb01 === "6") {
        out.eligibility = "inactive";
        if (eb05) out.planName = eb05;
      } else if (eb01 === "A") {
        // See "COINSURANCE IS THE PATIENT'S SHARE" above.
        const patientShare = Number.parseFloat(eb08 ?? "");
        const components = [
          ...new Set((eb03 ?? "").split("^").map((c) => c.trim().toUpperCase()).filter((c) => c !== "")),
        ];
        const dentalRow =
          components.length > 0 &&
          components.every(
            (c) =>
              c === DENTAL_SERVICE_TYPE ||
              DENTAL_CATEGORY_SERVICE_TYPES.has(c) ||
              (dentalPlan && !isMedicalOnlyServiceType(c))
          );
        if (perProcedure || !dentalRow || !Number.isFinite(patientShare) || patientShare < 0 || patientShare > 1) {
          out.trace.skipped.push(seg.id + ELEM + seg.elements.join(ELEM));
        } else {
          const planPercent = 100 - Math.round(patientShare * 100);
          const scope = scopeRank(eb02, eb12, participation);
          // Per category: is the category's OWN service type among this row's components?
          const categories = new Map<ProcedureCategory, boolean>();
          for (const c of components) {
            const category = SERVICE_TYPE_TO_CATEGORY[c];
            if (category) categories.set(category, categories.get(category) === true || CATEGORY_TO_SERVICE_TYPE[category] === c);
          }
          for (const [category, canonical] of categories) {
            offerRate(categoryRates, category, scope * 2 + (canonical ? 1 : 0), planPercent);
          }
          codeListFor = { rank: scope, planPercent };
        }
      } else if (eb01 === "C" || eb01 === "F") {
        const amount = Number.parseFloat(eb07 ?? "");
        const period = eb06 ?? "";
        if (
          perProcedure ||
          !Number.isFinite(amount) ||
          (!BENEFIT_PERIOD_QUALIFIERS.has(period) && period !== REMAINING_QUALIFIER)
        ) {
          out.trace.skipped.push(seg.id + ELEM + seg.elements.join(ELEM));
        } else {
          /**
           * Keep the best-matching candidate, never the last one seen. See `benefitPrecedence`:
           * a family or out-of-network figure must not overwrite the individual in-network figure
           * that actually applies to the patient in the chair.
           */
          const remaining = period === REMAINING_QUALIFIER;
          const slot: BenefitSlot =
            eb01 === "C"
              ? remaining ? "deductibleRemaining" : "deductibleAnnual"
              : remaining ? "maximumRemaining" : "maximumAmount";
          const rank = benefitPrecedence(eb02, eb12, participation, eb03, dentalPlan);
          const previous = chosen[slot];
          if (rank > (previous ?? NO_MATCH)) {
            /**
             * A better candidate DISPLACES one already chosen, and that counts too.
             *
             * This branch used to increment nothing, so `supersededBenefits` recorded only the
             * candidates that arrived after the winner and lost. A better figure arriving second —
             * which is the ordinary case now that EB03 outranks everything, since payers list other
             * service types first as often as not — silently overwrote its predecessor and the trace
             * reported that the payer had offered exactly one scope.
             *
             * The counter exists so a reviewer looking at a surprising estimate can see that there
             * were alternatives. Counting only half of them made it quietly misleading.
             */
            if (previous !== undefined) out.trace.supersededBenefits++;
            chosen[slot] = rank;
            if (slot === "deductibleAnnual") out.deductible.annual = amount;
            else if (slot === "deductibleRemaining") out.deductible.remaining = amount;
            else if (slot === "maximumAmount") out.annualMaximum.amount = amount;
            else out.annualMaximum.remaining = amount;
          } else {
            // Recorded rather than dropped silently: a reviewer looking at a surprising estimate can
            // see that the payer offered other scopes and which one was chosen over them.
            out.trace.supersededBenefits++;
          }
        }
      } else {
        out.trace.skipped.push(seg.id + ELEM + seg.elements.join(ELEM));
      }
    } else if (seg.id === "DMG") {
      // DMG01 `D8` + DMG02 CCYYMMDD. The payer restating whose record it answered about.
      if (seg.elements[0] === "D8") out.subscriberDateOfBirth ??= isoDay(seg.elements[1]);
    } else if (seg.id === "DTP" && (inRelatedEntity || currentOther)) {
      // A date inside an other-payer context is the OTHER plan's, not this patient's coverage window.
      out.trace.skipped.push(seg.id + ELEM + seg.elements.join(ELEM));
    } else if (seg.id === "DTP") {
      /**
       * DTP01 qualifier: 346 = plan begin, 347 = plan end, 291 = plan (often an RD8 range).
       * DTP02 format: D8 = CCYYMMDD, RD8 = CCYYMMDD-CCYYMMDD.
       *
       * These were in the ignore list below, so every coverage date a payer sent was discarded and
       * the benefits model had nowhere to put one anyway. A plan that ended before the date of
       * service is the difference between a clean claim and a guaranteed denial.
       */
      const [qualifier, format, value] = seg.elements;
      const range = format === "RD8" ? (value ?? "").split("-") : null;
      if (qualifier === "346") out.coverage.effectiveDate = isoDay(range?.[0] ?? value);
      else if (qualifier === "347") out.coverage.terminationDate = isoDay(range?.[1] ?? value);
      else if (qualifier === "291" && range) {
        out.coverage.effectiveDate ??= isoDay(range[0]);
        out.coverage.terminationDate ??= isoDay(range[1]);
      }
    } else if (!["ISA", "GS", "ST", "BHT", "HL", "NM1", "SE", "GE", "IEA", "REF", "LS", "LE"].includes(seg.id)) {
      out.trace.skipped.push(seg.id);
    }
  }

  if (out.trace.benefitSegments === 0) {
    throw new Error("271 contained no EB benefit segments.");
  }

  // Resolve each rate to the LOWEST plan percentage stated at its best scope, recording any
  // disagreement. See "COINSURANCE IS THE PATIENT'S SHARE".
  const resolve = <K extends string>(
    rates: Map<K, RateCandidates>,
    scope: CoinsuranceConflict["scope"],
    into: Partial<Record<K, number>>
  ): void => {
    for (const [key, { planPercents }] of rates) {
      const stated = [...planPercents].sort((a, b) => a - b);
      into[key] = stated[0]!;
      if (stated.length > 1) out.trace.coinsuranceConflicts.push({ scope, key, planPercents: stated });
    }
  };
  resolve(categoryRates, "category", out.coveragePercentages);
  resolve(procedureRates, "procedure", out.procedureCoveragePercentages);
  return out;
}
