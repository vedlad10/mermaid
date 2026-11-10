/**
 * Insights — where Mermaid states conclusions (spec §8.7).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "What is systematically changing in our revenue cycle, and what should we do about it?"
 *
 * §8.7 opens by saying what this screen is not: "not more charts. It is where Mermaid states
 * conclusions and lets the user interrogate them." So findings occupy the left and the evidence
 * occupies the right, and every finding names the window and the sample it was drawn from.
 *
 * ── THE HONESTY REQUIREMENT IS THE HARDEST PART OF THIS SCREEN ───────────────────────────────────
 * §8.7: "Mermaid never says 'revenue is up' without saying against what, over what window, and with
 * what confidence." The analytics module produces its findings as finished sentences that carry
 * their own figures — it does not attach a significance threshold or a sample size to them.
 *
 * That gap is not papered over by inventing a confidence score, which would be the worst possible
 * response to an honesty requirement. Instead every finding is rendered with the two things the
 * report genuinely knows: the window it covers, and how many claims went into it. Where a sample is
 * too small for a conclusion to mean anything, the screen says so above the list rather than
 * decorating each row with a number nobody computed.
 *
 * ── THE COHORT GRID, WHICH IS THE POINT ──────────────────────────────────────────────────────────
 * Rows are months of service, columns are months since service, cells are the cumulative share
 * collected. Reading down a column shows whether recent cohorts are collecting more slowly than
 * older ones at the same age — the earliest possible warning of a systemic problem, and §8.7 is
 * right that almost nothing in this category surfaces it.
 *
 * It is computed here from the claims' own recorded milestones — service date, billed amount, first
 * payment date, amount paid — because that is where the facts are. A cell with no cohort behind it
 * is drawn as absent, never as zero: "nobody was treated that month" and "we collected nothing" are
 * different findings and only one of them is an emergency.
 *
 * ── WHAT IS NOT DRAWN ────────────────────────────────────────────────────────────────────────────
 * Procedure-level economics — CDT codes ranked by net yield — needs each claim's LINES, and the
 * claims list carries totals only. Fetching every claim's detail to rank its codes would be one
 * request per claim on a screen that already makes three; it is a real and buildable visual, and it
 * needs the line summary on the list endpoint first.
 */

import { createChart } from "./chart.js";
import { createSpine } from "./spine.js";
import { RANGES } from "./store.js";
import { errorBlock, load as loadWithStates, restoreLayout, retire, stageSkeleton } from "./states.js";

const usd = (cents) => {
  const v = Number(cents ?? 0) / 100;
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
const usdExact = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}$${s}`;
};
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`);
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const svgEl = (name, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** §4.4's small-n floor. Below it a rate is an anecdote wearing a percentage sign. */
const MIN_SAMPLE = 5;
const monthOf = (iso) => String(iso ?? "").slice(0, 7);
const monthLabel = (ym) => {
  const d = new Date(`${ym}-01T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
};
/** Whole months from one YYYY-MM to another. */
const monthsBetween = (from, to) => {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (!fy || !ty) return null;
  return (ty - fy) * 12 + (tm - fm);
};

/**
 * The scorecard's columns. `good` says which direction is better, for the micro-bar's tone.
 *
 * ── TWO LABELS THAT DESCRIBED THE WRONG ARITHMETIC ───────────────────────────────────────────────
 * "Collected of billed" sat one column along from "Billed", so it read as an instruction: divide
 * this by that. The engine does not do that — `report.ts` computes `ratio(collected, expected)`,
 * against what the estimates promised, deliberately, because the filed figure still contains the
 * contractual write-off every in-network practice takes. On the seeded demonstration practice the
 * label implied 31% and the cell said 60%, and nothing on the screen closed the gap.
 *
 * The spine at the top of THIS SAME SCREEN already called it "Collected of expected". So the table
 * and the metric above it disagreed about what one number meant.
 *
 * "Billed" is the second. `MoneySummary` retires that word outright — "the ambiguity was the word
 * itself" — because it had meant both what went to payers and every live claim, on two screens, at
 * two different totals. The column is `filedToPayers`, so it is Filed.
 */
export const SCORECARD = [
  { key: "claimsSubmitted", label: "Claims", kind: "count" },
  { key: "filedToPayers", label: "Filed", kind: "money" },
  { key: "collected", label: "Collected", kind: "money" },
  { key: "collectionRate", label: "Collected of expected", kind: "rate", good: "high" },
  { key: "denialRate", label: "Denial rate", kind: "rate", good: "low" },
  { key: "averageDaysToPay", label: "Days to pay", kind: "days", good: "low" },
];

export function mountInsights(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "What is systematically changing");
  const controls = node("div", "scr__controls");
  const rangeGroup = node("div", "seg");
  rangeGroup.setAttribute("role", "group");
  rangeGroup.setAttribute("aria-label", "Timeframe");
  for (const r of RANGES) {
    const b = node("button", "seg__b", r.label);
    b.type = "button";
    b.dataset.range = r.key;
    b.addEventListener("click", () => store.setTimeframe(r.key));
    rangeGroup.append(b);
  }
  controls.append(rangeGroup);
  header.append(question, controls);

  const spineHost = node("div", "");

  /* §8.7's layout: findings left at 40%, evidence right at 60%. Findings are the entry point. */
  const split = node("div", "ins");
  const findingsCol = node("section", "ins__findings");
  const evidenceCol = node("section", "ins__evidence");
  split.append(findingsCol, evidenceCol);

  const cohortHost = node("section", "block2");
  const scoreHost = node("section", "block2");
  const trendHost = node("section", "viz2");
  const trendTitle = node("div", "viz2__t");
  const trendChart = node("div", "");
  trendHost.append(trendTitle, trendChart);
  evidenceCol.append(trendHost, cohortHost, scoreHost);

  /*
   * ── THE ONE PARAGRAPH THAT MAKES THE FOUR FIGURES ABOVE DIVIDE ───────────────────────────────
   *
   * These four metrics use three different denominators and two different populations, and a reader
   * has no way to discover that: every quantity they divide BY — expected, filed, patient billed —
   * is a figure this screen never draws. So the tiles look like a set that should reconcile, and
   * they do not. Stating the arithmetic is cheaper than four more tiles, and it is the actual
   * confusion rather than a decoration on it.
   *
   * Every sentence is the engine's own definition: `report.ts` computes ratio(collected, expected),
   * ratio(denied, filedToPayers), ratio(patientCollected, patientBilled), and
   * totalCollected = collected + patientCollected.
   */
  const flowNote = node("p", "block2__n");
  flowNote.append(
    node("span", "", "Collected is payer money and patient money added together. "),
    node("span", "", "Collected of expected divides the payer half by what the estimates promised — not by what was filed, because filed still contains the contractual write-off. "),
    node("span", "", "Denial rate divides refused dollars by what was filed. "),
    node("span", "", "Patients have paid is its own population: what patients were billed against what they paid.")
  );

  stage.append(header, spineHost, flowNote, split);

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let report = null;
  let prior = null;
  let claims = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const chart = createChart(trendChart, {
    store,
    mark: "column",
    height: 160,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    label: "Cash posted by day over the selected window",
  });
  const spine = createSpine(spineHost, { store, metrics: [] });

  /* ── Rendering ────────────────────────────────────────────────────────────────────────────── */

  function drawRangeState() {
    const active = store.get().timeframe.key;
    for (const b of rangeGroup.querySelectorAll(".seg__b")) {
      b.classList.toggle("is-active", b.dataset.range === active);
      b.setAttribute("aria-pressed", String(b.dataset.range === active));
    }
  }

  /** A real delta: this window's figure against the same figure for the window before it. */
  function delta(read) {
    if (!report || !prior) return null;
    const a = read(report), b = read(prior);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return ((a - b) / Math.abs(b)) * 100;
  }

  function drawSpine() {
    const m = report?.money ?? {};
    const f = report?.funnel ?? {};
    const daily = report?.dailyCollections ?? [];
    const n = f.claimsSubmitted ?? 0;
    /* Every rate below is suppressed under the sample floor rather than shown bare (§4.4). */
    const enough = n >= MIN_SAMPLE;

    spine.update([
      {
        key: "collected",
        label: "Collected",
        display: usd(m.totalCollected ?? m.collected ?? 0),
        zero: !(m.collected > 0),
        /*
         * Read the SAME field the figure above it displays.
         *
         * `delta` promises "this window's figure against the same figure for the window before it",
         * and this one broke that promise quietly: the tile showed `totalCollected` (payer money and
         * patient money together) while the percentage underneath moved with `collected` (payer
         * money alone). Two different quantities, one arrow, no way to tell from the screen.
         */
        delta: delta((r) => r.money?.totalCollected ?? r.money?.collected ?? 0),
        series: daily.map((d) => d.collected),
        /* Says WHICH money, because the tile is the only one on this screen that adds two sources. */
        basis: prior ? "payer + patient, vs the window before" : "payer + patient; no earlier window",
        tone: null,
      },
      {
        key: "rate",
        label: "Collected of expected",
        display: enough ? pct(m.collectionRate) : "—",
        zero: false,
        delta: null,
        series: [],
        basis: enough
          ? "of what the estimates promised"
          : `only ${n} ${n === 1 ? "claim" : "claims"} in this window — too few to call a rate`,
        tone: enough && m.collectionRate !== null && m.collectionRate < 0.9 ? "warning" : null,
      },
      {
        key: "denial",
        label: "Denial rate",
        display: enough ? pct(m.denialRate) : "—",
        zero: false,
        delta: null,
        series: [],
        /* "filed", not "billed": the engine divides by `filedToPayers`, and `MoneySummary` retires
           the word "billed" precisely because it named two different totals on two screens. */
        basis: enough ? "of filed dollars refused" : `${n} ${n === 1 ? "claim" : "claims"} is not a rate`,
        tone: enough && m.denialRate > 0.1 ? "critical" : null,
      },
      {
        key: "patient",
        label: "Patients have paid",
        display: enough ? pct(m.patientCollectionRate) : "—",
        zero: false,
        delta: null,
        series: [],
        basis: enough ? "of what they were billed" : "too few claims to judge",
        tone: enough && (m.patientCollectionRate ?? 0) < 0.5 ? "warning" : null,
      },
    ]);
  }

  /**
   * The findings list. Each is the analytics module's own sentence, with the window and the sample
   * it was drawn from stated above the list rather than invented per row.
   */
  function drawFindings() {
    findingsCol.replaceChildren();

    const period = report?.period;
    const n = report?.funnel?.claimsSubmitted ?? 0;
    const days = store.get().timeframe.days;

    /*
     * The heading follows the sample, because the old fixed one argued with its own body text:
     * "What Mermaid has concluded" sat directly above "shown as observations of this window, not as
     * conclusions about the practice". A reader cannot act on a block that contradicts itself in
     * two consecutive lines — and of the two statements it was the heading that was wrong, since
     * below the sample floor these genuinely are not conclusions.
     */
    findingsCol.append(
      node("h2", "block2__h", n >= MIN_SAMPLE ? "What Mermaid has concluded" : "What this window shows")
    );

    /*
     * The basis, once, above the list — because it is the same for every finding and repeating it on
     * each row would be noise pretending to be rigour. §8.7 requires the window and sample to be
     * visible; it does not require them six times.
     */
    findingsCol.append(
      node("p", "block2__n",
        period
          ? `Drawn from ${n} ${n === 1 ? "claim" : "claims"} over the last ${days} days, ${String(period.from).slice(0, 10)} to ${String(period.to).slice(0, 10)}.`
          : "No window loaded.")
    );

    if (n < MIN_SAMPLE) {
      /*
       * The honesty requirement, applied to the whole list rather than to each row. A conclusion
       * about a revenue cycle drawn from a handful of claims is not a weak conclusion, it is not one
       * — and the right response is to say the sample is too small, not to hedge each sentence.
       *
       * The count is READ, not written. This sentence used to end "a description of four claims"
       * with the four hardcoded, so it sat directly under "Drawn from 3 claims" and gave the reader
       * two different counts for the same set in consecutive lines. A number typed into copy is a
       * number that goes stale the first time the data moves.
       */
      findingsCol.append(
        node("p", "empty2",
          `Below ${MIN_SAMPLE} claims there is nothing to conclude — these describe the ${n} ` +
            `${n === 1 ? "claim" : "claims"} in this window, not the practice.`)
      );
    }

    const findings = report?.insights ?? [];
    if (findings.length === 0) {
      findingsCol.append(node("p", "empty2", "Nothing stood out in this window."));
      return;
    }

    const list = node("ol", "find");
    for (const text of findings) {
      const li = node("li", "find__i");
      li.append(node("p", "find__t", text));
      list.append(li);
    }
    findingsCol.append(list);

    /* The denial reasons, which are findings with records behind them rather than prose. */
    const reasons = report?.topDenialReasons ?? [];
    if (reasons.length) {
      findingsCol.append(node("h3", "tri__t2", "What was refused, and why"));
      const top = Math.max(1, ...reasons.map((r) => r.denied));
      const wrap = node("div", "rank");
      for (const r of reasons) {
        const b = node("button", "rank__r");
        b.type = "button";
        b.addEventListener("click", () => document.querySelector('.tab[data-tab="recovery"]')?.click());
        const name = node("span", "rank__n rank__n--stack");
        name.append(node("span", "rank__main", r.description));
        name.append(
          node("span", "rank__sub",
            `${r.carcCode} · ${r.count} ${r.count === 1 ? "denial" : "denials"}` +
              /* A recovery rate over one denial is not a rate — it is that denial, as a percentage. */
              (r.count >= MIN_SAMPLE ? ` · ${pct(r.recoveryRate)} recovered` : ` · ${usdExact(r.recovered)} recovered so far`))
        );
        b.append(name);
        const track = node("span", "rank__t");
        const svg = svgEl("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
        svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 0, width: Math.max(0.8, (r.denied / top) * 100), height: 4 }));
        track.append(svg);
        b.append(track, node("span", "rank__v", usdExact(r.denied)));
        wrap.append(b);
      }
      findingsCol.append(wrap);
    }
  }
  /** The cash trend: the one series this report genuinely carries day by day. */
  function drawTrend() {
    const daily = report?.dailyCollections ?? [];
    const days = store.get().timeframe.days;
    trendTitle.textContent = `Cash posted by day, last ${days} days`;
    if (daily.length < 2) {
      chart.update([], {
        insufficient: daily.length === 1
          ? `Only one day in this window posted cash. A trend needs more than one reading.`
          : "No cash was posted in this window.",
      });
      return;
    }
    chart.update(
      daily.map((d) => ({
        at: d.day, bucket: d.day,
        label: new Date(d.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        tick: new Date(d.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        value: d.collected,
        note: `${d.payments} ${d.payments === 1 ? "payment" : "payments"}`,
      }))
    );
    chart.setNote("Posted, not received — the day the money was applied to a claim.");
    chart.setProvenance({
      definition: "Cash posted against claims, by the day it was applied — not the day it arrived.",
      range: `last ${days} days, to today`,
      records: daily.reduce((t, d) => t + (d.payments ?? 0), 0),
      sources: "Mermaid postings, from payer remittance advice",
    });
  }

  /**
   * The cohort grid: months of service down, months since service across, cumulative collected.
   *
   * A cell exists only where a cohort does. An empty month is drawn as absent rather than as 0%,
   * because "nobody was treated" and "we collected nothing" are different findings.
   */
  function drawCohort() {
    cohortHost.replaceChildren();
    cohortHost.append(node("h2", "block2__h", "Are recent months collecting slower"));

    const usable = claims.filter((c) => c.serviceDate && c.totalFee > 0);
    if (usable.length === 0) {
      cohortHost.append(node("p", "block2__n", "No claim carries a service date and a charge, so there are no cohorts to compare."));
      return;
    }

    /* Group by service month; within each, bucket paid dollars by months elapsed to first payment. */
    const cohorts = new Map();
    for (const c of usable) {
      const ym = monthOf(c.serviceDate);
      if (!cohorts.has(ym)) cohorts.set(ym, { billed: 0, byAge: new Map(), claims: 0 });
      const co = cohorts.get(ym);
      co.billed += c.totalFee;
      co.claims += 1;
      if (c.firstPaidAt && c.paidAmount > 0) {
        const age = Math.max(0, monthsBetween(ym, monthOf(c.firstPaidAt)) ?? 0);
        co.byAge.set(age, (co.byAge.get(age) ?? 0) + c.paidAmount);
      }
    }

    const months = [...cohorts.keys()].sort();
    const maxAge = Math.max(0, ...[...cohorts.values()].flatMap((c) => [...c.byAge.keys()]));
    const ages = Array.from({ length: maxAge + 1 }, (_, i) => i);

    if (months.length < 2) {
      cohortHost.append(
        node("p", "block2__n",
          `Every claim was treated in one month (${monthLabel(months[0])}). A cohort grid compares months against each other, so it needs at least two.`)
      );
      return;
    }

    cohortHost.append(
      node("p", "block2__n",
        "Each row is a month of treatment; each column is how many months later. Read DOWN a column: if recent rows are paler than older ones at the same age, the practice is collecting more slowly than it used to.")
    );

    const grid = node("div", "coh");
    /* Header row. */
    const head = node("div", "coh__r coh__r--h");
    head.append(node("span", "coh__l", "Treated"));
    for (const a of ages) head.append(node("span", "coh__c coh__c--h", a === 0 ? "same month" : `+${a}`));
    head.append(node("span", "coh__c coh__c--h", "billed"));
    grid.append(head);

    for (const ym of months) {
      const co = cohorts.get(ym);
      const row = node("div", "coh__r");
      const label = node("span", "coh__l");
      label.append(node("span", "", monthLabel(ym)));
      label.append(node("span", "coh__n", `${co.claims} ${co.claims === 1 ? "claim" : "claims"}`));
      row.append(label);

      let cumulative = 0;
      for (const a of ages) {
        cumulative += co.byAge.get(a) ?? 0;
        const share = co.billed > 0 ? cumulative / co.billed : null;
        const cell = node("span", "coh__c");
        /*
         * The ramp carries the rate, so the grid survives grayscale (§1.5). Semantic colour enters
         * only where a cohort has genuinely stalled — and only once it is old enough for that to
         * mean anything, because a month-old cohort collecting 20% is normal.
         */
        if (share === null) {
          cell.classList.add("is-none");
          cell.textContent = "—";
        } else {
          const step = Math.min(5, Math.max(1, Math.ceil(share * 5)));
          cell.classList.add(`is-r${step}`);
          if (a >= 2 && share < 0.5) cell.classList.add("is-cold");
          cell.textContent = pct(share);
        }
        row.append(cell);
      }
      row.append(node("span", "coh__c coh__c--t", usd(co.billed)));
      grid.append(row);
    }
    cohortHost.append(grid);
    cohortHost.append(
      node("p", "block2__n block2__n--quiet",
        "A cell is the cumulative share of that month's billed charges collected by that age. An empty cell means no cohort reached that age yet — never that nothing was collected.")
    );
  }

  /**
   * The payer scorecard. §8.7 calls it "a negotiation instrument — design it to be exported and
   * taken into a payer conversation", so every cell carries a micro-bar showing where that payer
   * sits in the practice's OWN distribution rather than against an outside benchmark nobody agreed.
   */
  function drawScorecard() {
    scoreHost.replaceChildren();
    scoreHost.append(node("h2", "block2__h", "How each payer actually behaves"));

    const payers = report?.payers ?? [];
    if (payers.length === 0) {
      scoreHost.append(node("p", "block2__n", "No payer has been billed in this window."));
      return;
    }
    scoreHost.append(
      node("p", "block2__n",
        "Each bar shows where that payer sits against the others in this practice — not against an industry figure nobody agreed to. Rates over fewer than five claims are shown as counts instead.")
    );
    /*
     * What each column divides by.
     *
     * The two rate columns use DIFFERENT denominators, and neither denominator is a column a reader
     * can see: "Collected of expected" divides by the estimates, "Denial rate" divides by Filed.
     * Without this the only denominator on offer is the one physically next to the cell, which is
     * the wrong one — that is precisely how the old "Collected of billed" label misled.
     */
    scoreHost.append(
      node("p", "block2__n",
        "Filed is what went to these payers. Collected is what they paid back. " +
        "Collected of expected divides by what the estimates promised on those claims — not by Filed, " +
        "which still contains the contractual write-off an in-network practice agrees to and never collects. " +
        "Denial rate does divide by Filed. Days to pay is the mean from submitting a claim to posting its payment.")
    );

    /* The practice's own range per column, which is what a micro-bar is measured against. */
    const ranges = {};
    for (const col of SCORECARD) {
      const vals = payers.map((p) => Number(p[col.key])).filter((v) => Number.isFinite(v));
      ranges[col.key] = { min: Math.min(...vals, 0), max: Math.max(...vals, 0) };
    }

    const table = node("div", "sc");
    const head = node("div", "sc__r sc__r--h");
    head.append(node("span", "sc__l", "Payer"));
    for (const col of SCORECARD) head.append(node("span", "sc__c sc__c--h", col.label));
    table.append(head);

    for (const p of [...payers].sort((a, b) => (b.filedToPayers ?? 0) - (a.filedToPayers ?? 0))) {
      const row = node("div", "sc__r");
      const l = node("span", "sc__l");
      l.append(node("span", "", p.payerName));
      l.append(node("span", "coh__n", `${p.claimsSubmitted} ${p.claimsSubmitted === 1 ? "claim" : "claims"}`));
      row.append(l);

      for (const col of SCORECARD) {
        const raw = Number(p[col.key]);
        const cell = node("span", "sc__c");
        const enough = (p.claimsSubmitted ?? 0) >= MIN_SAMPLE;

        let text;
        if (!Number.isFinite(raw)) text = "—";
        else if (col.kind === "money") text = usd(raw);
        else if (col.kind === "count") text = String(raw);
        else if (col.kind === "days") text = enough ? `${Math.round(raw)}d` : "—";
        /* A rate over too few claims is suppressed, not rounded (§4.4). */
        else text = enough ? pct(raw) : "—";
        cell.append(node("span", "sc__v" + (text === "—" ? " is-na" : ""), text));

        const { min, max } = ranges[col.key];
        if (Number.isFinite(raw) && max > min && (col.kind !== "rate" || enough)) {
          const share = (raw - min) / (max - min);
          const svg = svgEl("svg", { class: "sc__bar", viewBox: "0 0 100 3", preserveAspectRatio: "none", "aria-hidden": "true" });
          /* Better or worse is a claim about state, so it takes semantic colour; magnitude does not. */
          const bad = col.good === "high" ? share < 0.34 : col.good === "low" ? share > 0.66 : false;
          svg.append(svgEl("rect", { class: "sc__fill" + (bad ? " is-bad" : ""), x: 0, y: 0, width: Math.max(1, share * 100), height: 3 }));
          cell.append(svg);
        }
        row.append(cell);
      }
      table.append(row);
    }
    scoreHost.append(table);

    scoreHost.append(
      node("p", "block2__n block2__n--quiet",
        "Procedure-level economics — CDT codes by net yield — is not here: it needs each claim's lines, and the claims list carries totals only.")
    );
  }

  function drawAll() {
    /*
     * The two states that come before the data (§7). A failure used to escape `load()` as an
     * unhandled rejection and leave this screen blank for ever; now it says what failed, what it
     * costs the reader, and offers the way back.
     */
    if (state.failed) {
      stage.replaceChildren(
        header,
        errorBlock({
          what: "The report could not be built.",
          shows: "what is systematically changing in the revenue cycle",
          stakes: "No conclusion on this screen is current.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["Collected", "Collected of expected", "Denial rate", "Patients have paid"], chartHeight: 160 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    drawRangeState();
    drawSpine();
    drawFindings();
    drawTrend();
    drawCohort();
    drawScorecard();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
    const { from, to } = store.window();
    const days = store.get().timeframe.days;
    const priorFrom = new Date(new Date(from).getTime() - days * 86400000).toISOString();
      const [rep, pri, cl] = await Promise.all([
        api("GET", `/api/v1/analytics/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        api("GET", `/api/v1/analytics/report?from=${encodeURIComponent(priorFrom)}&to=${encodeURIComponent(from)}`).catch(() => null),
        api("GET", "/api/v1/claims").catch(() => ({ items: [] })),
      ]);
      report = rep;
      prior = pri;
      claims = cl.items ?? [];
  }

  const un = store.subscribe((_s, reason) => {
    /* A timeframe change is a real re-query here: the report is computed for a window. */
    if (reason === "timeframe") { load(); return; }
    drawAll();
  });

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); chart.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill() { return null; },
  };
}
