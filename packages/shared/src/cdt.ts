/**
 * CDT procedure reference — the single catalog both halves of the cycle share (blueprint doc 02
 * port map: donor `cdt.ts` + `knowledge.js` → one shared reference). Fees are typical US fees in
 * `Cents`, used only as fallbacks when the clinic supplies no fee of its own.
 *
 * Fields the estimate engine needs are populated now (code, description, category, typicalFee).
 * Claim-scrub attributes (required fields, attachment/narrative expectations, frequency windows)
 * are additive and land with the claims scrubber — the shape is ready for them.
 */
import { cents, type Cents } from "./money.ts";
import type { ProcedureCategory } from "./domain/estimate.ts";

export interface CdtProcedure {
  code: string;
  description: string;
  category: ProcedureCategory;
  /** Typical fee (fallback only), in cents. */
  typicalFee: Cents;
  /**
   * The payer rejects this procedure when it is filed without a tooth number (837D TOO segment).
   * True for tooth-specific work — restorations, crowns, endodontics, extractions, sealants — and
   * false for whole-mouth or quadrant procedures (exams, cleanings, scaling per quadrant).
   */
  requiresToothNumber?: boolean;
  /**
   * The payer commonly requires supporting documentation (radiograph, perio chart, narrative).
   * Advisory: it produces a scrub warning, not a blocking error, because whether an attachment is
   * genuinely required is payer- and plan-specific and the clinic may already have sent it.
   */
  requiresNarrative?: boolean;
}

export const CDT_CATALOG: readonly CdtProcedure[] = [
  { code: "D0120", description: "Periodic oral evaluation", category: "diagnostic", typicalFee: cents(65) },
  { code: "D0150", description: "Comprehensive oral evaluation", category: "diagnostic", typicalFee: cents(110) },
  { code: "D0210", description: "Full mouth X-ray series", category: "diagnostic", typicalFee: cents(150) },
  { code: "D0274", description: "Bitewing X-rays (four films)", category: "diagnostic", typicalFee: cents(75) },
  { code: "D1110", description: "Prophylaxis (cleaning), adult", category: "preventive", typicalFee: cents(110) },
  { code: "D1120", description: "Prophylaxis (cleaning), child", category: "preventive", typicalFee: cents(85) },
  { code: "D1206", description: "Topical fluoride varnish", category: "preventive", typicalFee: cents(45) },
  { code: "D1351", description: "Sealant, per tooth", category: "preventive", typicalFee: cents(60), requiresToothNumber: true },
  { code: "D2140", description: "Amalgam filling, one surface", category: "basic", typicalFee: cents(175), requiresToothNumber: true },
  { code: "D2391", description: "Composite filling, one surface, posterior", category: "basic", typicalFee: cents(210), requiresToothNumber: true },
  { code: "D2392", description: "Composite filling, two surfaces, posterior", category: "basic", typicalFee: cents(265), requiresToothNumber: true },
  { code: "D2740", description: "Crown, porcelain/ceramic", category: "major", typicalFee: cents(1350), requiresToothNumber: true, requiresNarrative: true },
  { code: "D2750", description: "Crown, porcelain fused to metal", category: "major", typicalFee: cents(1250), requiresToothNumber: true, requiresNarrative: true },
  { code: "D2950", description: "Core buildup, including pins", category: "major", typicalFee: cents(320), requiresToothNumber: true, requiresNarrative: true },
  { code: "D3310", description: "Root canal, anterior tooth", category: "basic", typicalFee: cents(850), requiresToothNumber: true, requiresNarrative: true },
  { code: "D3330", description: "Root canal, molar", category: "basic", typicalFee: cents(1250), requiresToothNumber: true, requiresNarrative: true },
  { code: "D4341", description: "Scaling and root planing, per quadrant", category: "basic", typicalFee: cents(290), requiresNarrative: true },
  { code: "D4910", description: "Periodontal maintenance", category: "preventive", typicalFee: cents(145) },
  { code: "D5110", description: "Complete denture, maxillary", category: "major", typicalFee: cents(1900), requiresNarrative: true },
  { code: "D6010", description: "Implant placement, endosteal", category: "major", typicalFee: cents(2400), requiresToothNumber: true, requiresNarrative: true },
  { code: "D7140", description: "Extraction, erupted tooth", category: "basic", typicalFee: cents(220), requiresToothNumber: true },
  { code: "D7240", description: "Extraction, impacted tooth (full bony)", category: "major", typicalFee: cents(550), requiresToothNumber: true, requiresNarrative: true },
  { code: "D8080", description: "Comprehensive orthodontic treatment, adolescent", category: "orthodontic", typicalFee: cents(5500), requiresNarrative: true },
  { code: "D9110", description: "Palliative treatment of dental pain", category: "basic", typicalFee: cents(120) },
];

const byCode = new Map(CDT_CATALOG.map((p) => [p.code, p]));

export function findProcedure(code: string): CdtProcedure | undefined {
  return byCode.get(code.trim().toUpperCase());
}
