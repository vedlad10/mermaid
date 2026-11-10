/**
 * Report generator — renders a verification record as a professional plain-text report the front
 * desk can print or read to a patient. Pure function of the record; safe to regenerate any time.
 * Ported from Dental Verify's `report.ts`; money uses formatUsd (cents).
 */
import { formatUsd, formatUsdOrUnknown } from "@mermaid/shared";
import { verificationFreshness } from "./freshness.ts";
import type { VerificationRecord } from "../types.ts";

const line = "─".repeat(64);

export function generateReport(rec: Omit<VerificationRecord, "reportText">): string {
  const out: string[] = [];
  const p = rec.patient;

  out.push("DENTAL INSURANCE VERIFICATION REPORT");
  out.push(line);
  const freshness = verificationFreshness(rec.createdAt);
  out.push(`Verification ID : ${rec.id}`);
  out.push(`Date            : ${new Date(rec.createdAt).toLocaleString()}`);
  out.push(`Valid until     : ${new Date(freshness.expiresAt).toLocaleDateString()} (${freshness.reason.replace(/\.$/, "")})`);
  out.push(`Status          : ${rec.status.replace("_", " ").toUpperCase()}`);
  if (rec.dataSource === "mock") out.push(`Data source     : MOCK CONNECTOR — not live payer data`);
  out.push("");
  out.push("PATIENT");
  out.push(`  Name          : ${p.firstName} ${p.lastName}`);
  out.push(`  Date of birth : ${p.dateOfBirth}`);
  out.push(`  Member ID     : ${p.memberId}`);

  if (rec.benefits) {
    const b = rec.benefits;
    out.push("");
    out.push("COVERAGE");
    out.push(`  Payer          : ${b.payerName ?? "—"}`);
    out.push(`  Plan           : ${b.planName}`);
    out.push(`  Eligibility    : ${b.eligibility.toUpperCase()}`);
    out.push(
      `  Deductible     : ${formatUsdOrUnknown(b.deductible.individualAnnual)} individual / ` +
        `${formatUsdOrUnknown(b.deductible.remaining)} remaining (applies to: ${b.deductible.appliesTo.join(", ")})`
    );
    out.push(
      `  Annual maximum : ${formatUsdOrUnknown(b.annualMaximum.amount)} — ` +
        `${formatUsdOrUnknown(b.annualMaximum.used)} used, ${formatUsdOrUnknown(b.annualMaximum.remaining)} remaining`
    );
    out.push(
      // A category the payer never mentioned prints as "not stated", never as 0% — the difference
      // between silence and an exclusion, on the document a practice reads back to a patient.
      `  Coverage       : ${(["diagnostic", "preventive", "basic", "major", "orthodontic"] as const)
        .map((c) => `${c} ${b.coveragePercentages[c] === undefined ? "not stated" : `${b.coveragePercentages[c]}%`}`)
        .join(" · ")}`
    );
    for (const w of b.waitingPeriods) {
      out.push(`  Waiting period : ${w.months} months on ${w.category} (effective ${w.coverageEffectiveDate})`);
    }
    for (const e of b.exclusions) out.push(`  Exclusion      : ${e}`);
  }

  if (rec.calculation) {
    const c = rec.calculation;
    out.push("");
    out.push("TREATMENT PLAN ESTIMATE");
    for (const l of c.lines) {
      out.push(`  ${l.code}  ${l.description} (x${l.quantity})`);
      out.push(
        `        Fee ${formatUsd(l.fee)} · plan pays ${formatUsd(l.insurancePays)} · patient pays ${formatUsd(l.patientPays)}` +
          (l.denied ? "  [NOT COVERED]" : ` (${l.coveragePercent}%)`)
      );
      for (const n of l.notes) out.push(`        Note: ${n}`);
    }
    out.push("");
    out.push(`  TOTAL FEE                : ${formatUsd(c.totalFee)}`);
    out.push(`  ESTIMATED INSURANCE PAYS : ${formatUsd(c.totalInsurancePays)}`);
    out.push(`  ESTIMATED PATIENT OWES   : ${formatUsd(c.totalPatientPays)}`);
    out.push(`  Deductible applied       : ${formatUsd(c.deductibleAppliedTotal)}`);
    out.push(
      `  Annual max remaining     : ${formatUsdOrUnknown(c.annualMaxRemainingAfter, "not stated by the payer")}` +
        `${c.annualMaxRemainingAfter === null ? "" : " (after this plan)"}`
    );
  }

  if (rec.exceptions.length > 0) {
    out.push("");
    out.push("FLAGS");
    for (const e of rec.exceptions) out.push(`  [${e.severity.toUpperCase()}] ${e.message}`);
  }

  out.push("");
  out.push("CONFIDENCE");
  out.push(`  Overall ${rec.confidence.overall.toFixed(2)} (review threshold ${rec.confidence.reviewThreshold})`);
  for (const c of rec.confidence.components) out.push(`  · ${c.name}: ${c.confidence.toFixed(2)} — ${c.explanation}`);

  out.push("");
  out.push(line);
  out.push(
    "This is an ESTIMATE based on information provided by the payer and is not a guarantee of payment. " +
      "Final benefits are determined when the claim is processed. AI-assisted output — verify before quoting."
  );

  return out.join("\n");
}
