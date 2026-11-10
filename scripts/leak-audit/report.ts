/**
 * Renders an AuditReport as Markdown. Pure, so the same report always renders the same bytes.
 *
 * Wording rules, enforced by tests/leak-audit.test.ts:
 *   · a synthetic report carries the banner and every finding row is prefixed `[SYNTHETIC]`
 *   · totals are labelled ESTIMATED and are never described as recovered, collected or earned
 *   · the three buckets are never summed into one headline figure
 */
import { formatUsd, type Cents } from "@mermaid/shared";
import type { AuditReport, Finding, FindingCategory } from "./engine.ts";

const usd = (c: number | null): string => (c === null ? "not estimated" : formatUsd(c as Cents));

export const TITLES: Record<FindingCategory, string> = {
  "underpayment-vs-learned-rate": "Paid below the payer's own earlier allowed amount",
  "alternate-benefit-downgrade": "Paid at a lesser procedure's rate (possible alternate-benefit downgrade)",
  "rate-drift": "Payer now consistently pays a different rate (contract conversation)",
  "prompt-pay-interest": "Statutory prompt-pay interest",
  "denial-administrative": "Denied for an administrative defect",
  "denial-judgment": "Denied: needs a clinical or contractual argument",
  "silent-claim": "Open on the aging report, absent from every remittance supplied",
  "non-ach-payment": "Paid by a method other than ACH",
};
export const ORDER = Object.keys(TITLES) as FindingCategory[];

/** How each data-check status reads in a report: a word, never a colour alone. */
export const CHECK_WORD: Record<"ok" | "warn" | "fail", string> = { ok: "OK", warn: "CHECK", fail: "RESOLVE FIRST" };

// The replacement is a backslash and a pipe. It was written "\|", which JavaScript reads as a bare
// "|", so a payer name containing a pipe split its table row in two.
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function row(f: Finding, label: string): string {
  return `| ${label}${f.id} | ${cell(f.claim ?? "—")} | ${cell(f.payer)} | ${f.cdtCode ?? "—"} | ${f.date ?? "—"} | ${usd(f.estimatedCents)} | ${f.confidence} |`;
}

export function renderMarkdown(r: AuditReport): string {
  const syn = r.context.synthetic;
  const label = syn ? "[SYNTHETIC] " : "";
  const out: string[] = [];
  out.push(`# Retrospective revenue-leak audit${syn ? " — SYNTHETIC DEMONSTRATION" : ""}`);
  out.push("");
  if (syn) {
    out.push(
      "> **SYNTHETIC DATA.** Every claim, payer behaviour, rate and amount below was generated for this demonstration. " +
        "Nothing here describes a real practice, a real patient, or how any real payer behaves. " +
        "It shows what the audit does, not what a practice will find."
    );
    out.push("");
  }
  out.push("> **ESTIMATED — NOT RECOVERED.** No figure in this report is money collected. A finding is a claim a person must verify and pursue; most will recover less than their estimate, and some will recover nothing.");
  out.push("");
  out.push(`**Practice:** ${r.context.practiceLabel}  `);
  out.push(`**As of:** ${r.context.asOf} · **State:** ${r.context.state ?? "not supplied"}  `);
  out.push(`**Payments covered:** ${r.window.from ?? "—"} to ${r.window.to ?? "—"}  `);
  out.push(`**Inputs:** ${r.inputs.uniqueAdvices} distinct remittances · ${r.inputs.claimsOnAdvices} claims · ${r.inputs.lines} service lines · ${r.inputs.agingRows} aging rows`);
  out.push("");
  out.push("## Before reading the findings: data checks");
  out.push("");
  out.push("| Check | Status | Detail |");
  out.push("|---|---|---|");
  for (const c of r.dataChecks) out.push(`| ${cell(c.check)} | ${CHECK_WORD[c.status]} | ${cell(c.detail)} |`);
  out.push("");
  if (r.dataChecks.some((c) => c.status === "fail")) {
    out.push("> **A data check failed.** Resolve it before this report is shown to anyone: the findings below may be artifacts of the input rather than facts about the practice.");
    out.push("");
  }
  out.push("## Summary");
  out.push("");
  out.push("The three figures below are different kinds of number and are deliberately not added together.");
  out.push("");
  out.push("| Measure | Amount | What it means |");
  out.push("|---|---:|---|");
  out.push(`| Estimated recoverable (high + medium confidence) | ${usd(r.totals.estimatedRecoverableCents)} | Short-payments the payers' own paperwork supports. High ${usd(r.totals.estimatedRecoverableHighCents)}; medium ${usd(r.totals.estimatedRecoverableMediumCents)}. An estimate, not a collection. |`);
  out.push(`| At stake (unverified) | ${usd(r.totals.atStakeCents)} | In dispute or unaccounted for. An upper bound only, never an expectation. |`);
  out.push(`| Avoidable cost going forward | ${usd(r.totals.avoidableCostCents)} | Not claimable back. Counted only where the practice's merchant rate was supplied. |`);
  out.push("");
  out.push("## Findings by category");
  out.push("");
  for (const cat of ORDER) {
    const list = r.findings.filter((f) => f.category === cat);
    if (list.length === 0) continue;
    out.push(`### ${TITLES[cat]} (${list.length})`);
    out.push("");
    out.push("| ID | Claim | Payer | Code | Paid on | Estimate | Confidence |");
    out.push("|---|---|---|---|---|---:|---|");
    for (const f of list) out.push(row(f, label));
    out.push("");
  }
  out.push("## Evidence, claim by claim");
  out.push("");
  for (const f of r.findings) {
    out.push(`**${label}${f.id}** · ${TITLES[f.category]} · ${f.claim ?? "payment-level"} · ${f.payer}`);
    out.push("");
    out.push(`- **Estimate:** ${usd(f.estimatedCents)} (${f.bucket.replace("-", " ")}) · **Confidence:** ${f.confidence} — ${f.confidenceReason}`);
    for (const e of f.evidence) out.push(`- Evidence: ${e}`);
    for (const c of f.caveats) out.push(`- Caveat: ${c}`);
    out.push(`- Next step: ${f.action}`);
    out.push("");
  }
  out.push("## What this audit did not look at");
  out.push("");
  out.push("| Area | Why | Count |");
  out.push("|---|---|---:|");
  for (const e of r.exclusions) out.push(`| ${cell(e.area)} | ${cell(e.reason)} | ${e.count ?? "—"} |`);
  out.push("");
  out.push("## How to read confidence");
  out.push("");
  out.push("- **High** — deterministic arithmetic over amounts the payer itself stated, against a baseline seen five or more times.");
  out.push("- **Medium** — the same, with a baseline seen three or four times, or a statute whose applicability to this plan cannot be read from the advice.");
  out.push("- **Low** — the data bounds the amount but does not support an expectation: denials, silent claims, single-observation baselines.");
  out.push("- No payer-specific success rate is applied anywhere. None has been measured on real data.");
  out.push("");
  if (r.intake) {
    out.push("## Files read");
    out.push("");
    out.push("SHA-256 of each file as received, so anyone holding the originals can confirm exactly what was read.");
    out.push("");
    out.push("| File | Advices | SHA-256 | Note |");
    out.push("|---|---:|---|---|");
    for (const f of r.intake.files) out.push(`| ${cell(f.name)} | ${f.advices} | \`${f.sha256}\` | ${cell(f.error ?? "")} |`);
    if (r.intake.aging) out.push(`| ${cell(r.intake.aging.name)} | aging export | \`${r.intake.aging.sha256}\` | ${cell(r.intake.aging.note ?? "")} |`);
    out.push("");
  }
  return out.join("\n");
}
