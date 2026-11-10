/**
 * Renders an AuditReport as one self-contained HTML file: the report a practice manager actually
 * opens, reads, and prints. Pure, so the same report always renders the same bytes.
 *
 * ── WHY IT IS STATIC ───────────────────────────────────────────────────────────────────────────
 * No script, no web font, no image, no request of any kind. A real report contains claim numbers
 * and amounts and is handled as PHI (PILOT-PREREQUISITES B6): it must open on an air-gapped
 * workstation, print to paper for an appeal, and never phone home. A Content-Security-Policy of
 * `default-src 'none'` makes that a property of the file, so even a payer name that somehow escaped
 * escaping could not run.
 *
 * ── THE WORDING RULES ARE THE MARKDOWN REPORT'S ────────────────────────────────────────────────
 * Synthetic banner and per-finding label; ESTIMATED, never recovered; the three buckets are never
 * summed. tests/leak-audit.test.ts holds this file to them as it holds report.ts.
 *
 * Visual language is DESIGN.md's (the pinned brief): paper-white ground, navy ink, hairline rules,
 * weights 400/450/500 only, mono for measured quantities, semantic colour only on a status word.
 */
import { formatUsd, type Cents } from "@mermaid/shared";
import type { AuditReport, DataCheck, Finding } from "./engine.ts";
import { CHECK_WORD, ORDER, TITLES } from "./report.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const usd = (c: number | null): string => (c === null ? "not estimated" : formatUsd(c as Cents));
const anchor = (f: Finding): string => `f-${f.id.replace(/[^A-Za-z0-9-]/g, "")}`;

const CSS = `
:root{--void:#f4f6f9;--base:#fff;--raised:#f7f9fb;--ink:#0c1320;--ink2:#485364;--ink3:#606b7f;
--hair:rgba(13,20,33,.07);--soft:rgba(13,20,33,.11);--strong:rgba(13,20,33,.20);--tide:#06798a;
--critical:#c0362c;--warning:#a35c05;--positive:#15774d;
--sans:"Inter Tight",Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:"JetBrains Mono",ui-monospace,"Cascadia Mono",Consolas,monospace}
*{box-sizing:border-box}
html{background:var(--void)}
body{margin:0;font:400 14px/20px var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased}
main{max-width:1040px;margin:0 auto;padding:40px 32px 64px;background:var(--base);border-left:1px solid var(--hair);border-right:1px solid var(--hair);min-height:100vh}
h1{font:450 24px/32px var(--sans);letter-spacing:-.01em;margin:0 0 4px}
h2{font:500 12px/16px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);margin:48px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--soft)}
h3{font:450 15px/20px var(--sans);margin:28px 0 8px}
p{margin:0 0 8px;color:var(--ink2);max-width:72ch}
strong,b,th{font-weight:500}
a{color:var(--tide);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid rgba(6,121,138,.35);outline-offset:2px;border-radius:2px}
.meta{color:var(--ink3);font-size:12px;line-height:16px;margin:0 0 4px}
.meta>span{white-space:nowrap}
.meta>span+span::before{content:"·";margin:0 8px 0 4px;color:var(--ink3)}
.rail{border-left:2px solid var(--warning);padding:10px 14px;margin:20px 0 0;background:var(--raised)}
.rail p{margin:0;color:var(--ink)}
.rail .word{font:500 11px/14px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--warning);display:block;margin-bottom:2px}
.rail.fail{border-left-color:var(--critical)}.rail.fail .word{color:var(--critical)}
.rail.note{border-left-color:var(--strong)}.rail.note .word{color:var(--ink3)}
.fig,.num,code{font-family:var(--mono);font-variant-numeric:tabular-nums}
.signal{margin:32px 0 0}
.label{font:500 11px/14px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.apart{margin-top:8px}
.signal .fig{display:block;font-size:44px;line-height:48px;letter-spacing:-.03em;font-weight:450;margin:6px 0 6px}
.signal p{margin:0}
.secondary{display:flex;flex-wrap:wrap;gap:0;margin:24px 0 0;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.secondary div{flex:1 1 200px;padding:12px 16px 12px 0}
.secondary div+div{padding-left:16px;border-left:1px solid var(--hair)}
.secondary .fig{display:block;font-size:20px;line-height:24px;letter-spacing:-.01em;margin:4px 0 2px}
.secondary small{color:var(--ink3);font-size:12px;line-height:16px;display:block}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;line-height:18px}
th{font-size:11px;line-height:14px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3);text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--soft);white-space:nowrap}
td{padding:8px 12px 8px 0;border-bottom:1px solid var(--hair);vertical-align:top;color:var(--ink2)}
td:first-child,th:first-child{padding-left:0}
td.num,th.num{text-align:right;white-space:nowrap}
td.num{color:var(--ink)}
td.mono{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
table.findings{table-layout:fixed;min-width:640px}
.findings col.c-id{width:20%}.findings col.c-claim{width:13%}.findings col.c-payer{width:21%}.findings col.c-code{width:9%}.findings col.c-date{width:13%}.findings col.c-est{width:12%}.findings col.c-conf{width:12%}
table.findings td{overflow:hidden;text-overflow:ellipsis}
td.id{white-space:nowrap}
.status{white-space:nowrap;font:500 11px/18px var(--sans);letter-spacing:.06em;text-transform:uppercase}
.status::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px;background:currentColor}
.status.ok{color:var(--positive)}.status.warn{color:var(--warning)}.status.fail{color:var(--critical)}
.syn{font:500 10px/14px var(--sans);letter-spacing:.06em;color:var(--warning);margin-right:6px}
.finding{padding:16px 0 18px;border-bottom:1px solid var(--hair);break-inside:avoid}
.finding h3{margin:0 0 4px}
.finding .meta{margin-bottom:10px}
.finding dl{display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0}
.finding dt{color:var(--ink3);font-size:12px;line-height:20px}
.finding dd{margin:0;color:var(--ink2)}
.finding ul{margin:0;padding-left:18px}
.finding li+li{margin-top:4px}
.finding .next{color:var(--ink)}
footer{margin-top:48px;color:var(--ink3);font-size:12px;line-height:16px}
@media (max-width:640px){main{padding:24px 16px 48px}.signal .fig{font-size:32px;line-height:36px}.finding dl{grid-template-columns:1fr}.secondary div+div{padding-left:0;border-left:0;border-top:1px solid var(--hair)}}
@media print{html{background:#fff}main{border:0;padding:0;max-width:none}a{color:var(--ink)}.rail{background:none}h2{break-after:avoid}}
`;

/**
 * A line of facts separated by middots. Each fact never breaks inside itself, so the line must break
 * BETWEEN them: the space in the join is that break opportunity. Without it the spans abut, the
 * whole line is one unbreakable run, and a phone scrolls sideways.
 */
const meta = (items: readonly string[]): string => `<p class="meta">${items.map((i) => `<span>${i}</span>`).join(" ")}</p>`;

function checkRow(c: DataCheck): string {
  return `<tr><td>${esc(c.check)}</td><td><span class="status ${c.status}">${CHECK_WORD[c.status]}</span></td><td>${esc(c.detail)}</td></tr>`;
}

export function renderHtml(r: AuditReport): string {
  const syn = r.context.synthetic;
  const label = syn ? `<span class="syn">SYNTHETIC</span>` : "";
  const title = `Revenue-leak audit — ${r.context.practiceLabel}${syn ? " (synthetic demonstration)" : ""}`;
  const failed = r.dataChecks.filter((c) => c.status === "fail");
  const o: string[] = [];
  o.push(`<!doctype html><html lang="en"><head><meta charset="utf-8">`);
  o.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
  o.push(`<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`);
  o.push(`<title>${esc(title)}</title><style>${CSS}</style></head><body><main>`);

  // ── header ──
  o.push(`<header><h1>Revenue-leak audit${syn ? " — synthetic demonstration" : ""}</h1>`);
  o.push(
    meta([
      esc(r.context.practiceLabel),
      `As of <span class="num">${esc(r.context.asOf)}</span>`,
      `State ${esc(r.context.state ?? "not supplied")}`,
      `Payments <span class="num">${esc(r.window.from ?? "—")}</span> to <span class="num">${esc(r.window.to ?? "—")}</span>`,
    ])
  );
  o.push(
    meta([
      `${r.inputs.uniqueAdvices} distinct remittances`,
      `${r.inputs.claimsOnAdvices} claims`,
      `${r.inputs.lines} service lines`,
      `${r.inputs.agingRows} aging rows`,
      `${r.findings.length} findings`,
    ])
  );
  if (syn) {
    o.push(
      `<div class="rail"><span class="word">Synthetic data</span><p>Every claim, payer behaviour, rate and amount here was generated for this demonstration. ` +
        `Nothing describes a real practice, a real patient, or how any real payer behaves. It shows what the audit does, not what a practice will find.</p></div>`
    );
  }
  o.push(
    `<div class="rail note"><span class="word">Estimated — not recovered</span><p>No figure in this report is money collected. ` +
      `A finding is a claim a person must verify and pursue; most will recover less than their estimate, and some will recover nothing.</p></div>`
  );
  if (failed.length > 0) {
    o.push(
      `<div class="rail fail"><span class="word">Resolve before use</span><p>${failed.map((c) => esc(c.check)).join("; ")}. ` +
        `The findings below may be artifacts of the input rather than facts about the practice. See <a href="#checks">data checks</a>.</p></div>`
    );
  }
  o.push(`</header>`);

  // ── primary signal, then secondary: never summed ──
  o.push(`<section class="signal" aria-labelledby="sig"><span class="label" id="sig">Estimated recoverable · high and medium confidence</span>`);
  o.push(`<span class="fig">${usd(r.totals.estimatedRecoverableCents)}</span>`);
  o.push(
    `<p>Short-payments the payers' own paperwork supports: high <span class="num">${usd(r.totals.estimatedRecoverableHighCents)}</span>, ` +
      `medium <span class="num">${usd(r.totals.estimatedRecoverableMediumCents)}</span>. An estimate, not a collection.</p></section>`
  );
  o.push(`<div class="secondary">`);
  o.push(`<div><span class="label">At stake · unverified</span><span class="fig">${usd(r.totals.atStakeCents)}</span><small>In dispute or unaccounted for. An upper bound, never an expectation.</small></div>`);
  o.push(`<div><span class="label">Avoidable cost · going forward</span><span class="fig">${usd(r.totals.avoidableCostCents)}</span><small>Not claimable back. Counted only where a merchant rate was supplied.</small></div>`);
  o.push(`</div>`);
  o.push(`<p class="meta apart">These three figures are different kinds of number and are deliberately not added together.</p>`);

  // ── data checks ──
  o.push(`<h2 id="checks">Data checks — read before the findings</h2><div class="scroll"><table><thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead><tbody>`);
  for (const c of r.dataChecks) o.push(checkRow(c));
  o.push(`</tbody></table></div>`);

  // ── findings by category ──
  o.push(`<h2>Findings by category</h2>`);
  if (r.findings.length === 0) o.push(`<p>No finding. That is a statement about the files supplied, not proof that nothing is owed; see what was not assessed below.</p>`);
  for (const cat of ORDER) {
    const list = r.findings.filter((f) => f.category === cat);
    if (list.length === 0) continue;
    o.push(`<h3>${esc(TITLES[cat])} <span class="meta num">(${list.length})</span></h3><div class="scroll"><table class="findings">` +
        `<colgroup><col class="c-id"><col class="c-claim"><col class="c-payer"><col class="c-code"><col class="c-date"><col class="c-est"><col class="c-conf"></colgroup><thead><tr>`);
    o.push(`<th scope="col">ID</th><th scope="col">Claim</th><th scope="col">Payer</th><th scope="col">Code</th><th scope="col">Date</th><th scope="col" class="num">Estimate</th><th scope="col">Confidence</th></tr></thead><tbody>`);
    for (const f of list) {
      o.push(
        `<tr><td class="id">${label}<a href="#${anchor(f)}"><code>${esc(f.id)}</code></a></td><td><code>${esc(f.claim ?? "—")}</code></td><td>${esc(f.payer)}</td>` +
          `<td><code>${esc(f.cdtCode ?? "—")}</code></td><td class="mono">${esc(f.date ?? "—")}</td><td class="num">${usd(f.estimatedCents)}</td><td>${esc(f.confidence)}</td></tr>`
      );
    }
    o.push(`</tbody></table></div>`);
  }

  // ── evidence ──
  if (r.findings.length > 0) {
    o.push(`<h2>Evidence and next step, finding by finding</h2>`);
    for (const f of r.findings) {
      o.push(`<article class="finding" id="${anchor(f)}"><h3>${label}<code>${esc(f.id)}</code> · ${esc(TITLES[f.category])}</h3>`);
      o.push(
        meta([
          esc(f.claim ?? "payment-level"),
          esc(f.payer),
          `<span class="num">${usd(f.estimatedCents)}</span>`,
          esc(f.bucket.replace("-", " ")),
          `${esc(f.confidence)} confidence`,
        ]) + `<dl>`
      );
      o.push(`<dt>Why this confidence</dt><dd>${esc(f.confidenceReason)}</dd>`);
      o.push(`<dt>Evidence</dt><dd><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></dd>`);
      o.push(`<dt>Caveats</dt><dd><ul>${f.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></dd>`);
      o.push(`<dt>Next step</dt><dd class="next">${esc(f.action)}</dd></dl></article>`);
    }
  }

  // ── exclusions, confidence, files ──
  o.push(`<h2>What this audit did not look at</h2><div class="scroll"><table><thead><tr><th scope="col">Area</th><th scope="col">Why</th><th scope="col" class="num">Count</th></tr></thead><tbody>`);
  for (const e of r.exclusions) o.push(`<tr><td>${esc(e.area)}</td><td>${esc(e.reason)}</td><td class="num">${e.count ?? "—"}</td></tr>`);
  o.push(`</tbody></table></div>`);
  o.push(`<h2>How to read confidence</h2>`);
  o.push(`<p><strong>High</strong> — deterministic arithmetic over amounts the payer itself stated, against a baseline seen five or more times.</p>`);
  o.push(`<p><strong>Medium</strong> — the same, with a baseline seen three or four times, or a statute whose applicability to this plan cannot be read from the advice.</p>`);
  o.push(`<p><strong>Low</strong> — the data bounds the amount but does not support an expectation: denials, silent claims, single-observation baselines.</p>`);
  o.push(`<p>No payer-specific success rate is applied anywhere. None has been measured on real data.</p>`);
  if (r.intake) {
    o.push(`<h2>Files read</h2><p>SHA-256 of each file as received, so anyone holding the originals can confirm exactly what was read.</p>`);
    o.push(`<div class="scroll"><table><thead><tr><th scope="col">File</th><th scope="col" class="num">Advices</th><th scope="col">SHA-256</th><th scope="col">Note</th></tr></thead><tbody>`);
    for (const f of r.intake.files) {
      o.push(`<tr><td>${esc(f.name)}</td><td class="num">${f.advices}</td><td><code>${f.sha256}</code></td><td>${esc(f.error ?? "")}</td></tr>`);
    }
    if (r.intake.aging) o.push(`<tr><td>${esc(r.intake.aging.name)}</td><td class="num">aging</td><td><code>${r.intake.aging.sha256}</code></td><td>${esc(r.intake.aging.note ?? "")}</td></tr>`);
    o.push(`</tbody></table></div>`);
  }
  o.push(`<footer>Mermaid retrospective audit. Read-only: no claim was filed, changed or appealed in producing this report.${syn ? " Synthetic demonstration." : " Contains claim-level data: store, send and destroy it as PHI."}</footer>`);
  o.push(`</main></body></html>`);
  return o.join("\n") + "\n";
}
