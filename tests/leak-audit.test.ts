/**
 * The retrospective revenue-leak audit.
 *
 * What these tests establish, and what they cannot: the audit finds exactly the leaks a synthetic
 * generator planted, stays silent on the claims it deliberately left clean, and never describes an
 * estimate as money recovered. They prove the audit's LOGIC. They say nothing about whether a real
 * practice's data contains these leaks, or how a real payer behaves.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse835All } from "../platform/edi/mock/x12-835.ts";
import { auditLeaks, type AdviceSource, type AgingRow, type AuditReport, type Finding } from "../scripts/leak-audit/engine.ts";
import { agingToCsv, decodeAging, describeAgingRead, parseAging, parseColumnMap, readAging } from "../scripts/leak-audit/aging.ts";
import { readEra, readEraDir } from "../scripts/leak-audit/intake.ts";
import { renderMarkdown } from "../scripts/leak-audit/report.ts";
import { renderHtml } from "../scripts/leak-audit/report-html.ts";
import { csvText, renderWorklistCsv } from "../scripts/leak-audit/worklist.ts";
import { buildSyntheticDataset } from "../scripts/leak-audit/synthetic.ts";
import { isInsideRepository, missingAttestations, REQUIRED_ATTESTATIONS } from "../scripts/revenue-leak-audit.ts";

function run() {
  const data = buildSyntheticDataset();
  const advices: AdviceSource[] = data.advices.flatMap((a) => parse835All(a.raw).map((parsed) => ({ source: a.file, parsed })));
  return { data, report: auditLeaks(advices, data.aging, data.context) };
}

test("the audit finds exactly the planted leaks, with the planted amounts and confidence", () => {
  const { data, report } = run();
  const key = (category: string, claim: string | null, cents: number | null, confidence: string) =>
    `${category}|${claim ?? "-"}|${cents ?? "null"}|${confidence}`;
  const got = report.findings.map((f) => key(f.category, f.claim, f.estimatedCents, f.confidence)).sort();
  const want = data.truth.expected.map((e) => key(e.category, e.claim, e.cents, e.confidence)).sort();
  assert.deepEqual(got, want);
});

test("claims that were deliberately clean, or deliberately refused, produce no finding", () => {
  const { data, report } = run();
  const flagged = new Set(report.findings.map((f) => f.claim));
  assert.ok(data.truth.mustStayQuiet.length >= 30, "the control group must be substantial");
  for (const q of data.truth.mustStayQuiet) assert.equal(flagged.has(q.claim), false, `${q.claim}: ${q.why}`);
});

test("the three totals are separate and match the planted figures", () => {
  const { report } = run();
  // 2 underpayments × $90 (high) + 6 × $5.79 interest (medium)
  assert.equal(report.totals.estimatedRecoverableHighCents, 18_000);
  assert.equal(report.totals.estimatedRecoverableMediumCents, 6 * 579);
  assert.equal(report.totals.estimatedRecoverableCents, 18_000 + 6 * 579);
  // drift 90 + two alternate-benefit 60 + denials 900+210+110+850 + silent 1200+260+280+1200+150
  assert.equal(report.totals.atStakeCents, 9_000 + 12_000 + 207_000 + 309_000);
  // no merchant rate was supplied, so no avoidable cost is invented
  assert.equal(report.totals.avoidableCostCents, 0);
});

test("a refusal the platform makes is a refusal here: no interest the payer already paid, none inside the window", () => {
  const { report } = run();
  const interest = report.findings.filter((f) => f.category === "prompt-pay-interest");
  assert.equal(interest.length, 6);
  for (const f of interest) assert.equal(f.payer, "MetLife Dental");
});

test("an alternate-benefit downgrade is kept out of the recoverable total, as the platform decides", () => {
  const { report } = run();
  const abp = report.findings.filter((f) => f.category === "alternate-benefit-downgrade");
  assert.equal(abp.length, 2);
  for (const f of abp) assert.equal(f.bucket, "at-stake");
});

test("every finding is labelled synthetic and the report cannot be mistaken for a result", () => {
  const { report } = run();
  assert.ok(report.findings.length > 0);
  for (const f of report.findings) assert.equal(f.synthetic, true);
  const md = renderMarkdown(report);
  assert.match(md, /SYNTHETIC DEMONSTRATION/);
  assert.match(md, /ESTIMATED — NOT RECOVERED/);
  // every finding id appears only behind the label
  for (const f of report.findings) assert.ok(md.includes(`[SYNTHETIC] ${f.id}`), f.id);
  // the word "recovered" is only ever negated
  const stripped = md.replace(/NOT RECOVERED/g, "");
  assert.doesNotMatch(stripped, /\brecovered\b/i);
});

test("a non-synthetic report carries no synthetic label and is not described as a demonstration", () => {
  const { data } = run();
  const advices: AdviceSource[] = data.advices.flatMap((a) => parse835All(a.raw).map((parsed) => ({ source: a.file, parsed })));
  const real = auditLeaks(advices, data.aging, { ...data.context, synthetic: false });
  const md = renderMarkdown(real);
  assert.doesNotMatch(md, /SYNTHETIC/);
  assert.match(md, /ESTIMATED — NOT RECOVERED/);
});

test("findings carry no patient names or member ids", () => {
  const { report } = run();
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /Synthetic[ ,]*Patient|Patient[ ,]*Synthetic/);
  assert.doesNotMatch(json, /SYN\d{4}/);
});

test("the same inputs always produce the same files and the same report", () => {
  const a = buildSyntheticDataset();
  const b = buildSyntheticDataset();
  assert.deepEqual(a.advices, b.advices);
  assert.equal(JSON.stringify(run().report), JSON.stringify(run().report));
});

test("aging export parsing is strict and round-trips", () => {
  const { data } = run();
  assert.deepEqual(parseAging(agingToCsv(data.aging)), data.aging);
  assert.throws(() => parseAging("claim,payer\nA,B\n"), /no "service_date" column/);
  assert.throws(
    () => parseAging("claim,payer,service_date,billed,balance\nA,B,13/45/2026,1,1\n"),
    /not a real calendar day/
  );
  assert.throws(
    () => parseAging("claim,payer,service_date,billed,balance\nA,B,3/4/26,1,1\n"),
    /Two-digit years are refused/
  );
  assert.throws(
    () => parseAging("claim,payer,service_date,billed,balance,channel\nA,B,2026-03-04,1,1,fax\n"),
    /must be electronic or paper/
  );
});

test("missing filing date or channel is reported as not assessed, never assumed", () => {
  const { data } = run();
  const advices: AdviceSource[] = data.advices.flatMap((a) => parse835All(a.raw).map((parsed) => ({ source: a.file, parsed })));
  const stripped = data.aging.map((r) => ({ ...r, channel: null }));
  const report = auditLeaks(advices, stripped, data.context);
  assert.equal(report.findings.filter((f) => f.category === "prompt-pay-interest").length, 0);
  assert.ok(report.exclusions.some((e) => e.area === "Prompt-pay interest" && (e.count ?? 0) > 0));
});

test("real-data mode refuses to run without a complete safeguards attestation", () => {
  assert.deepEqual(missingAttestations(""), [...REQUIRED_ATTESTATIONS]);
  assert.deepEqual(missingAttestations(REQUIRED_ATTESTATIONS.join("\n")), []);
  assert.equal(missingAttestations(REQUIRED_ATTESTATIONS.slice(1).join("\n")).length, 1);

  const none = spawnSync(
    process.execPath,
    ["scripts/revenue-leak-audit.ts", "--era-dir", "does-not-exist", "--aging", "does-not-exist.csv"],
    { encoding: "utf8" }
  );
  assert.equal(none.status, 3);
  assert.match(none.stderr, /REFUSING/);
  assert.match(none.stderr, /PILOT-PREREQUISITES/);
});

// ── Real files: duplicates, unreadable files, the claim join, column maps ─────────────────────────
//
// What a practice actually hands over is messier than the generator: the same ERA downloaded twice,
// a truncated file, a PDF in the folder, an aging export whose headers are its own and whose claim
// numbers may not be the 835's. None of it may change a figure silently.

const findingKeys = (r: AuditReport): string[] =>
  r.findings.map((f) => `${f.category}|${f.claim}|${f.estimatedCents}|${f.confidence}`).sort();

function adviceSources(data = buildSyntheticDataset()): AdviceSource[] {
  return data.advices.flatMap((a) => parse835All(a.raw).map((parsed) => ({ source: a.file, parsed })));
}

test("the same ERA supplied twice is counted once, and the report says which file was the copy", () => {
  const data = buildSyntheticDataset();
  const advices = adviceSources(data);
  const base = auditLeaks(advices, data.aging, data.context);
  const original = advices.find((a) => a.source.includes("EFT000000029"))!;
  const copy = { source: original.source.replace(".835", " (1).835"), parsed: structuredClone(original.parsed) };
  const twice = auditLeaks([copy, ...advices], data.aging, data.context);

  assert.deepEqual(findingKeys(twice), findingKeys(base), "a second download adds no finding");
  assert.deepEqual(twice.totals, base.totals);
  assert.equal(twice.inputs.advices, advices.length + 1);
  assert.equal(twice.inputs.uniqueAdvices, advices.length);
  const check = twice.dataChecks.find((c) => c.check === "Each payment counted once")!;
  assert.equal(check.status, "ok");
  assert.ok(check.detail.includes(`${copy.source} is a copy of ${original.source}`), check.detail);
  // evidence cites the plain name, whichever order the files arrived in
  for (const f of twice.findings) for (const e of f.evidence) assert.ok(!e.includes(" (1).835"), e);
});

test("two copies of one payment that disagree are both set aside, never averaged or guessed between", () => {
  const data = buildSyntheticDataset();
  const advices = adviceSources(data);
  const original = advices.find((a) => a.source.includes("EFT000000029"))!;
  const altered = structuredClone(original.parsed);
  altered.claims[0]!.paid = (altered.claims[0]!.paid + 1) as (typeof altered.claims)[number]["paid"];
  const r = auditLeaks([...advices, { source: "corrected.835", parsed: altered }], data.aging, data.context);

  const check = r.dataChecks.find((c) => c.check === "Each payment counted once")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /disagree/);
  assert.ok(r.exclusions.some((e) => e.area === "Advices" && /disagree/.test(e.reason) && e.count === 2));
  for (const f of r.findings) {
    for (const e of f.evidence) assert.ok(!e.includes(original.source) && !e.includes("corrected.835"), e);
  }
});

test("one unreadable file does not end the audit; it is listed with its reason and its hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-audit-intake-"));
  try {
    const data = buildSyntheticDataset();
    const good = data.advices[0]!;
    writeFileSync(join(dir, good.file), good.raw);
    writeFileSync(join(dir, "truncated.835"), "ISA*00*");
    writeFileSync(join(dir, "eob.pdf"), "%PDF-1.4");
    writeFileSync(join(dir, ".DS_Store"), "");
    writeFileSync(join(dir, "desktop.ini"), "");
    const { advices, files } = readEraDir(dir);

    assert.deepEqual(files.map((f) => f.name), [good.file, "eob.pdf", "truncated.835"]);
    assert.equal(advices.length, 1);
    assert.equal(files[0]!.error, null);
    assert.match(files[1]!.error!, /PDF or paper EOB needs a person/);
    assert.ok(files[2]!.error);
    for (const f of files) assert.match(f.sha256, /^[0-9a-f]{64}$/);

    const report = auditLeaks(advices, [], data.context, { files, aging: null });
    const read = report.dataChecks.find((c) => c.check === "Remittance files read")!;
    assert.equal(read.status, "warn");
    assert.match(read.detail, /1 of 3 files read/);
    assert.ok(readEra("x.835", "not edi").file.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when no claim number joins the two exports, the report says so before any finding is read", () => {
  const data = buildSyntheticDataset();
  const renumbered = data.aging.map((r) => ({ ...r, claim: r.claim.replace(/^SYN-/, "PM-") }));
  const r = auditLeaks(adviceSources(data), renumbered, data.context);

  const joinCheck = r.dataChecks.find((c) => /join/.test(c.check))!;
  assert.equal(joinCheck.status, "fail");
  assert.match(joinCheck.detail, /0 of \d+ remitted claims/);
  assert.equal(r.findings.filter((f) => f.category === "prompt-pay-interest").length, 0);
  const silent = r.findings.filter((f) => f.category === "silent-claim");
  assert.ok(silent.length > 0);
  for (const f of silent) assert.match(f.caveats[0]!, /number claims differently/);
  assert.match(renderMarkdown(r), /A data check failed/);
  assert.match(renderHtml(r), /Resolve before use/);

  const joined = auditLeaks(adviceSources(data), data.aging, data.context);
  assert.equal(joined.dataChecks.find((c) => /join/.test(c.check))!.status, "ok");
});

test("an export's own column names are mapped explicitly, never guessed", () => {
  const data = buildSyntheticDataset();
  const csv = agingToCsv(data.aging).replace(/^.*$/m, "Claim #,Carrier,Service Date,Sent Date,Channel,Billed Amount,Balance");
  assert.throws(() => parseAging(csv), /no "claim" column.*Headers found: Claim #, Carrier.*--aging-columns/s);
  const map = parseColumnMap(
    "claim=Claim #;payer=Carrier;service_date=Service Date;submitted_date=Sent Date;channel=Channel;billed=Billed Amount;balance=Balance"
  );
  assert.deepEqual(parseAging(csv, map), data.aging);
  assert.deepEqual(parseAging(csv + ",,,,,,\r\n", map), data.aging, "a spreadsheet's trailing blank row is not a claim");
  assert.throws(() => parseColumnMap("claimnumber=Claim #"), /Unknown aging field "claimnumber"/);
  assert.throws(() => parseColumnMap("claim="), /empty header/);
  assert.throws(() => parseAging(csv, { claim: "Claim No" }), /no "Claim No" column \(mapped to claim\)/);
});

// ── What practice software actually writes ────────────────────────────────────────────────────────
//
// Open Dental's query window exports tab-delimited `.txt`; Excel's "Unicode Text" is UTF-16; report
// exports put a title above the header, a carrier's name above its claims and a total below them,
// and write amounts as `$1,234.50` or `(12.50)`. Every one of those is FORMAT. None may change a value,
// and every line left out must be named.

/** The synthetic aging rows as a practice report would write them: every quirk at once. */
function practiceShapedExport(rows: readonly AgingRow[]): Buffer {
  const amount = (c: number) => {
    const s = `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return c < 0 ? `(${s})` : s;
  };
  const us = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}/${y} 12:00:00 AM`;
  };
  const lines = ["Claims sent, all carriers", "Date range 10/1/2025 - 9/30/2026", "claim\tpayer\tservice_date\tsubmitted_date\tchannel\tbilled\tbalance"];
  let payer: string | null = null;
  let billed = 0;
  let balance = 0;
  const subtotal = () => payer !== null && lines.push(`\t${payer} Total\t\t\t\t${amount(billed)}\t${amount(balance)}`);
  for (const r of rows) {
    if (r.payer !== payer) {
      subtotal();
      payer = r.payer;
      billed = balance = 0;
      lines.push(payer);
    }
    billed += r.billedCents;
    balance += r.balanceCents;
    lines.push([r.claim, r.payer, us(r.serviceDate), r.submittedOn ? us(r.submittedOn) : "", r.channel ?? "", amount(r.billedCents), amount(r.balanceCents)].join("\t"));
  }
  subtotal();
  lines.push(`Grand Total\t\t\t\t\t${amount(rows.reduce((s, r) => s + r.billedCents, 0))}\t${amount(rows.reduce((s, r) => s + r.balanceCents, 0))}`);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join("\r\n") + "\r\n", "utf16le")]);
}

test("a practice report's format is read, and every line left out is named", () => {
  const data = buildSyntheticDataset();
  const r = readAging(practiceShapedExport(data.aging));
  assert.deepEqual(r.rows, data.aging, "the same rows, to the cent and the day");
  assert.equal(r.encoding, "UTF-16LE");
  assert.equal(r.delimiter, "tab");
  assert.equal(r.headerLine, 3);
  const groups = data.aging.filter((a, i) => i === 0 || a.payer !== data.aging[i - 1]!.payer).length;
  assert.ok(groups > 1);
  assert.equal(r.headingLines.length, groups, "one carrier heading per group");
  assert.equal(r.totalLines.length, groups + 1, "a subtotal per carrier and the grand total");
  const note = describeAgingRead(r);
  assert.match(note, /^\d+ claims read, tab-delimited, UTF-16LE; header on line 3; the 2 lines above it not read; total rows left out \(line .+\); group headings with no date or amount left out/);
});

test("amounts, dates and encodings that real exports use, and the ones refused", () => {
  const head = "claim,payer,service_date,billed,balance\n";
  const one = (row: string) => parseAging(head + row + "\n")[0]!;
  assert.equal(one('A,B,2026-03-04,"$1,200.00",(12.50)').balanceCents, -1250, "accounting parentheses are a negative");
  assert.equal(one('A,B,2026-03-04,"$1,200.00",(12.50)').billedCents, 120000);
  assert.equal(one("A,B,2026-03-04,0,(0.00)").balanceCents, 0);
  assert.throws(() => one("A,B,2026-03-04,1,(-1)"), /balance "\(-1\)" is not an amount/);
  for (const d of ["3/4/2026 12:00:00 AM", "2026-03-04 00:00:00", "2026-03-04T00:00:00Z", "03/04/2026 0:00"]) {
    assert.equal(one(`A,B,${d},1,1`).serviceDate, "2026-03-04", d);
  }
  assert.throws(() => one("A,B,01/01/0001,1,1"), /not a plausible date\. Open Dental writes 01\/01\/0001 for no date/);
  assert.throws(() => one("A,B,3/4/2026 noon,1,1"), /is not YYYY-MM-DD or M\/D\/YYYY/);
  assert.equal(one("A,Total Dental Administrators,2026-03-04,1,1").payer, "Total Dental Administrators", "a carrier named Total is a carrier");
  assert.throws(() => parseAging(head + ",B,2026-03-04,1,1\n"), /Line 2: claim is empty/, "a claim row without its number is still refused");
  assert.throws(() => one("Total Dental Administrators,,,5,5"), /Line 2: service_date is empty/, "not a total row: the label does not end in Total");

  // Windows-1252, as an older Excel CSV save writes an accented name; not valid UTF-8.
  const latin = readAging(Buffer.from(head + "A,Société Dentaire,2026-03-04,1,1\n", "latin1"));
  assert.equal(latin.encoding, "Windows-1252");
  assert.equal(latin.rows[0]!.payer, "Société Dentaire");
  assert.equal(decodeAging(Buffer.from("﻿" + head, "utf8")).encoding, "UTF-8");

  // A header pushed below the 30th line is not hunted for.
  assert.throws(() => parseAging("title\n".repeat(30) + head + "A,B,2026-03-04,1,1\n"), /no "claim" column/);
});

test("Open Dental's Outstanding Insurance Claims export is recognised and refused with the way forward", () => {
  const od =
    "Carrier Name\tPhone\tType\tUser\tPatName\tClinic\tDateService\tDateSent\tDateSentOrig\tTrackStat\tDateStat\tError\tAmount\r\n" +
    "Synthetic Dental Co\t555-0100\tPri\t\tDoe, Jordan\t\t03/04/2026\t03/05/2026\t03/05/2026\t\t\t\t120.00\r\n";
  assert.throws(() => parseAging(od), /Outstanding Insurance Claims report\. It carries no claim number and no paid claims.*docs\/pilot\/exports\/open-dental\.md/s);
});

test("an aging export of open claims only is named as the likely cause when nothing joins", () => {
  const data = buildSyntheticDataset();
  const openOnly = data.aging.filter((r) => r.balanceCents > 0).map((r) => ({ ...r, claim: `OPEN-${r.claim}` }));
  assert.ok(openOnly.length > 0);
  const check = auditLeaks(adviceSources(data), openOnly, data.context).dataChecks.find((c) => /join/.test(c.check))!;
  assert.equal(check.status, "fail");
  assert.match(check.detail, /every row on the aging export has an open balance: it is probably an outstanding-claims report/);
  const renumbered = data.aging.map((r) => ({ ...r, claim: `PM-${r.claim}` }));
  const other = auditLeaks(adviceSources(data), renumbered, data.context).dataChecks.find((c) => /join/.test(c.check))!;
  assert.match(other.detail, /^0 of \d+ remitted claims appear on the aging export\. None do: the two exports probably number claims differently/);
});

test("the worklist is one row per finding, sums as numbers, and cannot run a payer's formula", () => {
  const { report } = run();
  const csv = renderWorklistCsv(report);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, report.findings.length + 1);
  assert.equal(lines[0], "id,category,bucket,confidence,claim,payer,cdt_code,date,estimate_usd,next_step,evidence,caveats,synthetic,status,owner,notes");
  const und = report.findings.find((f) => f.category === "underpayment-vs-learned-rate")!;
  assert.ok(lines.some((l) => l.startsWith(`${und.id},`) && l.includes(",90.00,")), "estimate is a plain number");

  assert.equal(csvText('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvText("+1"), "'+1");
  assert.equal(csvText("-1"), "'-1");
  assert.equal(csvText("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvText("Delta, Dental"), `"Delta, Dental"`);
  assert.equal(csvText("Cigna Dental"), "Cigna Dental");

  const hostile: Finding = { ...und, payer: "=cmd|'/c calc'!A1" };
  const row = renderWorklistCsv({ ...report, findings: [hostile] }).split("\r\n")[1]!;
  assert.ok(row.includes(",'=cmd|'/c calc'!A1,"), row);
});

test("the HTML report is static, escapes payer text, and keeps the report's wording rules", () => {
  const { report } = run();
  const html = renderHtml(report);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  // A statute's source URL may appear as TEXT in a caveat; nothing may LOAD one.
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|\ssrc=|url\(|href="(?!#)/i, "no script, no external resource, no request");
  assert.match(html, /Synthetic data/);
  assert.match(html, /Estimated — not recovered/);
  for (const f of report.findings) assert.ok(html.includes(`<span class="syn">SYNTHETIC</span><a href="#f-${f.id}">`), f.id);
  assert.doesNotMatch(html.replace(/not recovered/gi, ""), /\brecovered\b/i);
  assert.match(html, /deliberately not added together/);

  const und = report.findings[0]!;
  const hostile = renderHtml({ ...report, findings: [{ ...und, payer: `<script>alert(1)</script>"x` }] });
  assert.doesNotMatch(hostile, /<script>alert/);
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;x/);

  const real = renderHtml({
    ...report,
    context: { ...report.context, synthetic: false },
    findings: report.findings.map((f) => ({ ...f, synthetic: false })),
  });
  assert.doesNotMatch(real, /SYNTHETIC|Synthetic data|synthetic demonstration/);
  assert.match(real, /store, send and destroy it as PHI/);
});

test("a pipe in a payer's name cannot split a Markdown table row", () => {
  const { report } = run();
  const f = report.findings[0]!;
  const md = renderMarkdown({ ...report, findings: [{ ...f, payer: "Delta | Dental" }] });
  assert.ok(md.includes("Delta \\| Dental"));
});

test("a real report is refused anywhere inside the repository", () => {
  assert.equal(isInsideRepository("docs/pilot/audit-output"), true);
  assert.equal(isInsideRepository("."), true);
  assert.equal(isInsideRepository(join(tmpdir(), "audit")), false);
  assert.equal(isInsideRepository("/repo/../repo-sibling/x", "/repo"), false);
});

// ── The real-data path, end to end, through the command a person types ───────────────────────────
//
// Run over the SYNTHETIC files, in a temporary directory outside the repository. The attestation
// written below is a test fixture that exercises the gate; no real data is read by this test, and
// the gate itself is tested above with an absent and an incomplete attestation.

test("real-data mode end to end: reads a folder and an export, writes all four reports, exits by what it found", () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-audit-e2e-"));
  try {
    const data = buildSyntheticDataset();
    mkdirSync(join(dir, "era"));
    for (const a of data.advices) writeFileSync(join(dir, "era", a.file), a.raw);
    writeFileSync(join(dir, "aging.csv"), agingToCsv(data.aging));
    writeFileSync(join(dir, "aging-renumbered.csv"), agingToCsv(data.aging).replace(/^SYN-/gm, "PM-"));
    writeFileSync(join(dir, "aging-practice.txt"), practiceShapedExport(data.aging));
    writeFileSync(join(dir, "attestation.txt"), REQUIRED_ATTESTATIONS.join("\n"));
    const cli = (aging: string, out: string) =>
      spawnSync(
        process.execPath,
        [
          "scripts/revenue-leak-audit.ts",
          "--era-dir", join(dir, "era"),
          "--aging", join(dir, aging),
          "--state", "nj",
          "--as-of", "2026-09-30",
          "--practice-label", "E2E fixture",
          "--safeguards-attestation", join(dir, "attestation.txt"),
          "--out", out,
        ],
        { encoding: "utf8" }
      );

    const ok = cli("aging.csv", join(dir, "out"));
    assert.equal(ok.status, 0, ok.stderr);
    for (const f of ["report.html", "report.md", "worklist.csv", "findings.json"]) assert.ok(existsSync(join(dir, "out", f)), f);
    const report = JSON.parse(readFileSync(join(dir, "out", "findings.json"), "utf8")) as AuditReport;
    assert.deepEqual(findingKeys(report), findingKeys(run().report), "the file path finds exactly what the in-memory path finds");
    assert.equal(report.context.state, "NJ");
    assert.equal(report.intake!.files.length, data.advices.length);
    assert.ok(report.findings.every((f) => f.synthetic === false), "real-data mode labels nothing synthetic");

    const shaped = cli("aging-practice.txt", join(dir, "out-practice"));
    assert.equal(shaped.status, 0, shaped.stderr);
    const shapedReport = JSON.parse(readFileSync(join(dir, "out-practice", "findings.json"), "utf8")) as AuditReport;
    assert.deepEqual(findingKeys(shapedReport), findingKeys(report), "a UTF-16, tab-delimited, titled and totalled export finds the same");
    assert.match(shapedReport.intake!.aging!.note!, /tab-delimited, UTF-16LE; header on line 3/);
    assert.match(readFileSync(join(dir, "out-practice", "report.md"), "utf8"), /aging export \| `[0-9a-f]{64}` \| \d+ claims read, tab-delimited/);
    assert.match(shaped.stdout, /aging export aging-practice\.txt: \d+ claims read/);

    const mismatch = cli("aging-renumbered.csv", join(dir, "out2"));
    assert.equal(mismatch.status, 4, "a failed data check is an exit code, not just a line in a file");
    assert.match(mismatch.stderr, /RESOLVE FIRST/);

    const inRepo = cli("aging.csv", "docs/pilot/audit-output");
    assert.equal(inRepo.status, 3);
    assert.match(inRepo.stderr, /inside the repository/);
    assert.equal(existsSync("docs/pilot/audit-output"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an impossible payment date is 'no readable payment date', never a window or an age", () => {
  /**
   * A public 835 sample carries BPR16 `20002316` (month 23). It became "2000-23-16", passed the
   * shape test, set the report window and would have aged claims by NaN. Now it is excluded and
   * counted like any advice with no payment date.
   */
  const data = buildSyntheticDataset();
  const advices = adviceSources(data);
  const original = advices.find((a) => a.source.includes("EFT000000029"))!;
  const bad = structuredClone(original.parsed);
  bad.payment = { ...bad.payment!, date: "20262316" };
  bad.trace = { number: "EFT-BAD-DATE", originator: bad.trace?.originator ?? "" };
  const r = auditLeaks([...advices, { source: "bad-date.835", parsed: bad }], data.aging, data.context);

  assert.ok(!/-23-/.test(String(r.window.from)) && !/-23-/.test(String(r.window.to)), JSON.stringify(r.window));
  assert.ok(r.exclusions.some((e) => e.area === "Advices" && /no readable payment date/.test(e.reason) && e.count === 1));
  for (const f of r.findings) for (const e of f.evidence) assert.ok(!e.includes("bad-date.835"), e);
});
