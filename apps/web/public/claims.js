/**
 * Claims — the first screen of the operational triad (spec §8.3).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "Where is every claim in its lifecycle, what is stuck, and what will age out?"
 *
 * A biller does not open this screen to admire a distribution. They open it because something has
 * not moved and they cannot tell which thing. So the primary visual is built to make one specific
 * failure visible without reading a number: a band that swells while the band above it stays flat is
 * a payer that has stopped answering.
 *
 * ── WHAT THE STATE-FLOW IS BUILT FROM, AND WHY THAT IS HONEST ────────────────────────────────────
 * The specification asks for a stacked area of claim counts by state across time. Reconstructing
 * "which state was this claim in on the 14th" needs a transition history, and Mermaid does not store
 * one — the claim carries an audit trail, but no day-by-day state table.
 *
 * What it DOES carry, and what this screen now reads off the row, is three recorded milestones:
 * when the claim was created, when a human released it to the payer, and when the payer's first
 * dollar posted. Those three timestamps determine the claim's position on any past date exactly:
 *
 *     created ≤ D < submitted   → waiting on us
 *     submitted ≤ D < first paid → with the payer
 *     first paid ≤ D            → answered
 *
 * That is a reconstruction from recorded facts, not an interpolation between them, which is the line
 * §4.4 draws. The bands it CANNOT show are the ones whose timestamps are not recorded — a rejection
 * that was fixed and refiled looks, on this chart, like a long stay with the payer. The screen says
 * so rather than implying a completeness it does not have.
 *
 * ── WHAT IS NOT DRAWN ────────────────────────────────────────────────────────────────────────────
 * The clean-claim FUNNEL (submitted → clearinghouse → payer → paid without rework) needs the two
 * middle stages as separately recorded events. Mermaid records the intake answer (`accepted` /
 * `rejected`) and the payment; it does not distinguish a clearinghouse acceptance from a payer
 * acceptance, because the mock adapter collapses them and the Stedi adapter reports one answer. A
 * four-stage funnel drawn from two known stages would be two real numbers and two invented ones, so
 * the two real ones are shown as what they are — a rate with its basis stated — and the funnel is
 * not drawn.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { RANGES } from "./store.js";
import { maskName } from "./privacy.js";
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
const dayLabel = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const DAY = 86400000;
const daysBetween = (a, b) => {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  return Number.isFinite(t0) && Number.isFinite(t1) ? (t1 - t0) / DAY : null;
};

/** The median, or null when there is nothing to take one of. Sorted numerically, not lexically. */
function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * The stack, bottom-up: the further up the column, the further along the claim.
 *
 * `void` is deliberately absent. A voided claim is not a stage of the lifecycle, it is a claim
 * withdrawn from it, and stacking it under the live ones would inflate every column with work that
 * is not in flight.
 */
const FLOW = [
  { key: "waiting", label: "Waiting on us" },
  { key: "withPayer", label: "With the payer" },
  { key: "answered", label: "Answered" },
];

/** A claim's terminal states — nothing further will happen without a person deciding it should. */
const TERMINAL = new Set(["paid", "void"]);

/**
 * What is holding this claim up — ONE answer per claim, in descending severity.
 *
 * ── WHY THIS IS EXCLUSIVE RATHER THAN A SET OF OVERLAPPING TESTS ─────────────────────────────────
 * Two reasons, and the second is the one that matters.
 *
 * A claim with no payer AND a scrub error would otherwise appear in two bars, so the ranking's
 * dollars would sum to more than the practice is owed — a bar chart that adds up to more than the
 * money is a bar chart nobody can act on.
 *
 * More importantly, the shared store filters by reading ONE value off a record and testing it
 * against the selected chips. A claim that belonged to several groups could not be expressed that
 * way, so clicking a bar would narrow the table to a population that disagreed with the bar's own
 * count. The store's entire premise is that a chart and the table beneath it cannot describe
 * different populations; a multi-valued dimension is how that premise gets broken quietly.
 *
 * So severity decides, once, here — and the bar, the filter and the table all read this function.
 */
export const HOLDS = [
  {
    key: "nopayer",
    label: "No payer on file",
    note: "cannot be transmitted electronically at all",
    match: (c) => !c.payerName,
  },
  {
    key: "errors",
    label: "Blocked by a scrub error",
    note: "the payer would reject this as filed",
    match: (c) => c.scrubErrors > 0,
  },
  {
    key: "unreleased",
    label: "Clean but not released",
    note: "waiting on a person to press submit",
    match: (c) => c.canSubmit && !c.submittedAt,
  },
  {
    key: "warnings",
    label: "Released with an advisory",
    note: "filed, but the scrubber had a reservation",
    match: (c) => c.scrubWarnings > 0 && Boolean(c.submittedAt),
  },
];

export const holdOf = (c) => HOLDS.find((h) => h.match(c))?.key ?? "none";

/**
 * Which band a claim belonged to at the END of a given day, or null if it belonged to none.
 *
 * ── THE WHOLE HONESTY CLAIM OF THIS SCREEN LIVES HERE ────────────────────────────────────────────
 * Mermaid stores no day-by-day state table, so a stacked flow over time has to be reconstructed. It
 * is reconstructed from the claim's own three recorded milestones and nothing else:
 *
 *     created ≤ D < submitted    → waiting on us
 *     submitted ≤ D < first paid → with the payer
 *     first paid ≤ D             → answered
 *
 * Each boundary is a timestamp somebody actually wrote down, so this derives a position rather than
 * interpolating between two known ones — the line §4.4 draws.
 *
 * A day is closed at its END (`dayEnd` is exclusive) so an event at 23:59 counts on the day it
 * happened rather than the day after, and a claim raised today appears in today's column.
 *
 * Returns null — never a band — for a claim that did not exist yet, that cannot be dated at all, or
 * that was withdrawn. A void claim is not a STAGE of the lifecycle; it is a claim removed from it,
 * and stacking it under the live ones would inflate every column with work nobody is doing.
 */
export function stageOnDay(claim, dayEndMs) {
  const created = Date.parse(claim.createdAt);
  if (!Number.isFinite(created) || created >= dayEndMs) return null;
  if (claim.status === "void") return null;
  const paid = claim.firstPaidAt ? Date.parse(claim.firstPaidAt) : null;
  if (paid !== null && Number.isFinite(paid) && paid < dayEndMs) return "answered";
  const submitted = claim.submittedAt ? Date.parse(claim.submittedAt) : null;
  if (submitted !== null && Number.isFinite(submitted) && submitted < dayEndMs) return "withPayer";
  return "waiting";
}

export function mountClaims(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  /*
   * "Now" is captured once per render pass rather than read inside a sort comparator. A comparator
   * that calls `new Date()` is not a stable ordering — two rows compared microseconds apart are
   * measured against different clocks — and it is called O(n log n) times per sort.
   */
  let renderedAt = Date.now();
  const idleDays = (c) => {
    const t = Date.parse(c.updatedAt);
    return Number.isFinite(t) ? Math.max(0, Math.floor((renderedAt - t) / DAY)) : null;
  };

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "Where is every claim, and what is stuck");
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

  /*
   * §8.3 — dollars is the default basis, "because dollars is the business". The toggle is a screen
   * preference rather than store state: it changes how one chart is READ, not which records the
   * screen is about, and putting it in the shared store would make it survive into screens where it
   * means nothing.
   */
  let basis = "dollars";
  const basisGroup = node("div", "seg");
  basisGroup.setAttribute("role", "group");
  basisGroup.setAttribute("aria-label", "Basis");
  for (const b of [{ key: "dollars", label: "Dollars" }, { key: "count", label: "Claims" }]) {
    const btn = node("button", "seg__b", b.label);
    btn.type = "button";
    btn.dataset.basis = b.key;
    btn.addEventListener("click", () => {
      if (basis === b.key) return;
      basis = b.key;
      drawBasisState();
      drawChart();
    });
    basisGroup.append(btn);
  }

  controls.append(basisGroup, rangeGroup);
  header.append(question, controls);

  const chips = node("div", "fchips");
  const spineHost = node("div", "");
  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  const stuckHost = node("section", "block2");
  const scrubHost = node("section", "block2");
  const supportRow = node("div", "grid2");
  supportRow.append(stuckHost, scrubHost);

  const tableHost = node("div", "");

  stage.append(header, chips, spineHost, vizHost, supportRow, node("div", "scr__rule"), tableHost);

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State owned by the screen: the fetched data, nothing else ────────────────────────────── */
  let claims = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const ACCESSORS = {
    payer: (c) => c.payerName ?? "No payer on file",
    status: (c) => c.status,
    stage: (c) => stageOf(c),
    hold: (c) => holdOf(c),
    /*
     * A click on the flow selects a DAY, and a claim belongs to that day's column if it was open on
     * it — which is not the same as having been created on it. Bucketing by `createdAt` here would
     * make the chart and the table disagree about the very selection the chart just made, so the
     * predicate is the same "was this open on that day" test the column was built from.
     */
    bucket: (c) => {
      const day = store.get().point?.bucket;
      return openOnDay(c, day) ? day : null;
    },
    at: (c) => c.createdAt,
  };

  /**
   * Was this claim open at the end of the given day? The column's own membership test, reused by the
   * table so a selected column and the rows beneath it always describe the same claims.
   */
  function openOnDay(c, isoDay) {
    if (!isoDay) return false;
    /* The SAME predicate the column was built from — not a second one that could drift from it. */
    return stageOnDay(c, Date.parse(`${isoDay}T00:00:00.000Z`) + DAY) !== null;
  }

  const visible = () => claims.filter((c) => store.matches(c, ACCESSORS));

  /**
   * The population the PRIMARY CHART is drawn from: narrowed by the dimension filters, but never by
   * the chart's own time selection.
   *
   * ── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────────────────────────
   * Building the chart from `visible()` makes it a function of its own output. Click a day on which
   * no claim was open and the chart rebuilds from zero rows, renders the insufficient-data state,
   * and hides its own plot — so the column you just selected is gone, and with it the only way to
   * click it again and deselect. The screen strands itself, and the sole escape is the filter chip.
   *
   * It is the same failure the payer selector had on Money, which vanished when selecting a payer
   * left too few rows to rank. The lesson generalised: a control must rank or plot the population
   * the SELECTION SITS IN, not the selection. So a selected day is shown by ringing its column and
   * leaving the rest of the window drawn around it — which is also the only way the selection can be
   * read as "this day, out of these" rather than as "this day, alone".
   *
   * Omitting `bucket` and `at` is what does it: `store.matches` skips the point and brush tests when
   * the caller declares no accessor for them, so this needs no second predicate that could drift out
   * of agreement with the first.
   */
  const except = (...dims) =>
    Object.fromEntries(Object.entries(ACCESSORS).filter(([k]) => !dims.includes(k)));

  /** The chart's population: every filter EXCEPT the time selection the chart itself writes. */
  const CHART_ACCESSORS = except("bucket", "at");
  const chartPopulation = () => claims.filter((c) => store.matches(c, CHART_ACCESSORS));

  /**
   * The hold ranking's population: every filter except the hold dimension the ranking itself writes.
   *
   * Same rule as the chart above, one dimension over. Ranking from the already-held claims would
   * leave a single bar the moment one was chosen — the selection with nothing to be read against,
   * and no second bar to compare it to.
   */
  const HOLD_ACCESSORS = except("hold");
  const holdPopulation = () => claims.filter((c) => store.matches(c, HOLD_ACCESSORS));

  /** Where a claim stands RIGHT NOW, in the same three stages the flow chart uses. */
  function stageOf(c) {
    if (c.firstPaidAt) return "answered";
    if (c.submittedAt) return "withPayer";
    return "waiting";
  }

  /* ── Primitives ───────────────────────────────────────────────────────────────────────────── */
  const chart = createChart(chartHost, {
    store,
    mark: "band",
    height: 190,
    series: FLOW,
    format: (v) => (basis === "dollars" ? usd(v) : `${Math.round(v)}`),
    bucketOf: (p) => p.bucket,
    label: "Claims by lifecycle stage over time",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  const table = createTable(tableHost, {
    rowKey: (c) => c.id,
    rowHeight: 36,
    amount: (c) => c.outstanding,
    formatAmount: (v) => usdExact(v),
    /*
     * The rail is reserved for a claim a person must act on. `filingMatters` gates it because
     * `filingRisk` is pure arithmetic on a date and still reports `expired` on a claim the payer
     * paid a year ago — a red rail on finished work trains people to ignore the rail.
     */
    rail: (c) =>
      c.filingMatters && (c.filingRisk === "urgent" || c.filingRisk === "expired")
        ? "critical"
        : c.scrubErrors > 0 || (c.filingMatters && c.filingRisk === "warning")
          ? "warning"
          : null,
    empty: "No claims match the current selection.",
    columns: [
      { key: "patient", label: "Patient", type: "entity", get: (c) => maskName(c.patientName), value: (c) => c.patientName },
      { key: "payer", label: "Payer", type: "entity", get: (c) => c.payerName ?? "—" },
      { key: "service", label: "Service", type: "date", get: (c) => dayLabel(c.serviceDate), value: (c) => c.serviceDate },
      { key: "stage", label: "Stage", type: "status", get: (c) => FLOW.find((f) => f.key === stageOf(c))?.label ?? stageOf(c) },
      { key: "status", label: "Status", type: "status", get: (c) => c.status.replace(/_/g, " ") },
      {
        key: "age",
        label: "Idle",
        type: "count",
        /* Days since the claim last moved — not days in state; see `updatedAt` on the row. */
        get: (c) => {
          const d = idleDays(c);
          return d === null ? "—" : `${d}d`;
        },
        /* Negated so the default descending sort puts the longest-idle claim at the top. */
        value: (c) => -(idleDays(c) ?? 0),
      },
      { key: "fee", label: "Billed", type: "currency", get: (c) => usdExact(c.totalFee), value: (c) => c.totalFee },
      {
        key: "outstanding",
        label: "Outstanding",
        type: "currency",
        get: (c) => (c.outstanding ? usdExact(c.outstanding) : null),
        value: (c) => c.outstanding ?? 0,
      },
    ],
    onOpen: (c) => store.pushDrill({ kind: "claim", id: c.id, label: maskName(c.patientName) }),
  });

  /* ── Rendering ────────────────────────────────────────────────────────────────────────────── */

  function drawChips() {
    chips.replaceChildren();
    const list = store.chips();
    if (list.length === 0) { chips.classList.remove("is-on"); return; }
    chips.classList.add("is-on");
    for (const c of list) {
      const b = node("button", "fchip", c.label ?? `${c.dim}: ${c.value}`);
      b.type = "button";
      b.setAttribute("aria-label", `Remove filter ${c.label ?? c.value}`);
      b.append(node("span", "fchip__x", "×"));
      b.addEventListener("click", () => {
        if (c.kind === "point") store.selectPoint(c.value);
        else if (c.kind === "brush") store.setBrush(null);
        else store.removeFilter(c);
      });
      chips.append(b);
    }
    if (list.length >= 2) {
      const clear = node("button", "fchip fchip--clear", "Clear all");
      clear.type = "button";
      clear.addEventListener("click", () => store.clearFilters());
      chips.append(clear);
    }
  }

  function drawRangeState() {
    const active = store.get().timeframe.key;
    for (const b of rangeGroup.querySelectorAll(".seg__b")) {
      b.classList.toggle("is-active", b.dataset.range === active);
      b.setAttribute("aria-pressed", String(b.dataset.range === active));
    }
  }

  function drawBasisState() {
    for (const b of basisGroup.querySelectorAll(".seg__b")) {
      b.classList.toggle("is-active", b.dataset.basis === basis);
      b.setAttribute("aria-pressed", String(b.dataset.basis === basis));
    }
  }

  /* ── The four metrics §8.3 names, each computed from what the rows actually carry ─────────── */

  /** Money the practice is still owed on claims that have not finished. */
  const inFlight = (rows) => rows.filter((c) => !TERMINAL.has(c.status)).reduce((t, c) => t + (c.outstanding ?? 0), 0);

  /**
   * The share of released claims the payer's intake took first time and that carried no scrub error.
   *
   * The spec's definition is "paid without rework". Mermaid can see two of those three things — the
   * intake answer and whether the scrubber found errors — and cannot see a refile, because a claim
   * corrected and resubmitted overwrites its own submission. The figure therefore reports what it
   * can prove, and `basis` on the spine says exactly that rather than letting the label imply more.
   */
  function cleanRate(rows) {
    const released = rows.filter((c) => c.submittedAt);
    if (released.length === 0) return { value: null, n: 0 };
    const clean = released.filter((c) => c.submissionOutcome === "accepted" && c.scrubErrors === 0);
    return { value: (clean.length / released.length) * 100, n: released.length };
  }

  /** Days from a human releasing the claim to the payer's first dollar. */
  function daysToAdjudication(rows) {
    const spans = rows
      .filter((c) => c.submittedAt && c.firstPaidAt)
      .map((c) => daysBetween(c.submittedAt, c.firstPaidAt))
      .filter((d) => d !== null && d >= 0);
    return { value: median(spans), n: spans.length };
  }

  /** Money on claims whose filing deadline is still live and close. */
  const atFilingRisk = (rows) =>
    rows
      .filter((c) => c.filingMatters && (c.filingRisk === "warning" || c.filingRisk === "urgent" || c.filingRisk === "expired"))
      .reduce((t, c) => t + (c.outstanding || c.totalFee || 0), 0);

  function drawSpine() {
    const rows = claims;
    const clean = cleanRate(rows);
    const adjud = daysToAdjudication(rows);
    const risk = atFilingRisk(rows);

    spine.update([
      {
        key: "inflight",
        label: "In flight",
        display: usd(inFlight(rows)),
        zero: inFlight(rows) === 0,
        delta: null,
        series: [],
        basis: "still owed on unfinished claims",
        tone: null,
      },
      {
        key: "clean",
        label: "Clean claim rate",
        /* §4.4 small-n: the count travels with the figure rather than being implied by it. */
        display: clean.value === null ? "—" : `${clean.value.toFixed(0)}%`,
        zero: clean.value === 0,
        delta: null,
        series: [],
        basis:
          clean.n === 0
            ? "no claim has been released yet"
            : clean.n < 5
              ? `accepted first time, no scrub error (n=${clean.n})`
              : "accepted first time, no scrub error",
        tone: clean.value !== null && clean.value < 90 ? "warning" : null,
      },
      {
        key: "speed",
        label: "Days to adjudication",
        display: adjud.value === null ? "—" : `${adjud.value.toFixed(adjud.value < 10 ? 1 : 0)}`,
        zero: false,
        delta: null,
        series: [],
        basis:
          adjud.n === 0
            ? "no claim has been both filed and paid"
            : adjud.n < 5
              ? `median, release to first payment (n=${adjud.n})`
              : "median, release to first payment",
        tone: null,
      },
      {
        key: "risk",
        label: "At filing risk",
        display: usd(risk),
        zero: risk === 0,
        delta: null,
        series: [],
        basis: risk === 0 ? "no live deadline is close" : "deadline still live and approaching",
        tone: risk > 0 ? "critical" : null,
      },
    ]);
  }

  /**
   * The state-flow. Every day in the window gets a column, and a claim contributes to the stage it
   * was in ON THAT DAY — reconstructed from its own three recorded milestones.
   *
   * Days with no claims at all are still drawn, because an empty stretch in the middle of a window
   * is information: it is the week nothing was filed.
   */
  function drawChart() {
    const rows = chartPopulation();
    const days = store.get().timeframe.days;
    const money = basis === "dollars";
    vizTitle.textContent = money
      ? `Claim dollars by lifecycle stage, last ${days} days`
      : `Claim count by lifecycle stage, last ${days} days`;

    if (rows.length === 0) {
      chart.update([], {
        insufficient: store.narrowed()
          ? "No claims match this selection."
          : "No claims have been raised yet. The flow appears once a verification produces one.",
      });
      return;
    }

    /*
     * The window is anchored on midnight UTC so a column is a whole day rather than a rolling 24
     * hours — otherwise the leftmost column silently holds a fraction of a day and is compared to
     * complete ones beside it, which §4.4 forbids.
     */
    const todayUtc = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
    const start = todayUtc - (days - 1) * DAY;

    const points = [];
    for (let t = start; t <= todayUtc; t += DAY) {
      const dayEnd = t + DAY;                        /* a claim counts on day D if it existed by its end */
      const iso = new Date(t).toISOString().slice(0, 10);
      const parts = { waiting: 0, withPayer: 0, answered: 0 };
      let live = 0;
      for (const c of rows) {
        const key = stageOnDay(c, dayEnd);
        if (key === null) continue;
        parts[key] += money ? c.totalFee || 0 : 1;
        live++;
      }
      points.push({
        at: iso,
        bucket: iso,
        label: dayLabel(iso),
        tick: dayLabel(iso),
        parts,
        /* The last column is today, which is still being written. §4.4 marks it rather than hiding it. */
        partial: t === todayUtc,
        note: live === 0 ? "no claims open" : `${live} ${live === 1 ? "claim" : "claims"} open`,
      });
    }

    /* A single column is a reading, not a flow. §4.4 refuses the shape rather than degrading it. */
    const withAny = points.filter((p) => p.parts.waiting + p.parts.withPayer + p.parts.answered > 0);
    if (withAny.length < 2) {
      chart.update([], {
        insufficient:
          withAny.length === 1
            ? `Every claim in this window sits on one day (${dayLabel(withAny[0].bucket)}). A flow needs more than one day to flow between.`
            : "No claim was open on any day of this window.",
      });
      return;
    }

    chart.update(points, { series: FLOW });
    chart.setNote(
      "Reconstructed from each claim's own recorded milestones — raised, released, first paid. " +
        "A refile is not separately recorded, so a claim rejected and corrected reads here as a long stay with the payer. " +
        "Click a day to see the claims behind it."
    );
    chart.setProvenance({
      definition:
        "Claims open on each day of the window, positioned by their own recorded milestones — raised, released to the payer, first paid — and valued by " +
        (money ? "the amount billed." : "a count of one each."),
      range: `last ${days} days, to today`,
      records: rows.length,
      sources: "Mermaid claims (inherited from each verification's coverage snapshot)",
    });
  }

  /**
   * Stuck claims, by how long they have been idle.
   *
   * §8.3 asks for a warning marker at "that payer's own median" duration. That marker is drawn only
   * where the payer has enough finished claims to have a median at all — a threshold computed from
   * one prior claim is a number with the authority of a statistic and the content of an anecdote.
   */
  function drawStuck() {
    stuckHost.replaceChildren();
    const rows = visible().filter((c) => !TERMINAL.has(c.status));
    stuckHost.append(node("h2", "block2__h", "What has stopped moving"));

    if (rows.length === 0) {
      stuckHost.append(
        node("p", "block2__n", store.narrowed()
          ? "Nothing in this selection is still open."
          : "Every claim has reached a resting state. Nothing is waiting on anybody.")
      );
      return;
    }

    /* Each payer's own median release-to-payment span, from its finished claims only. */
    const payerMedian = new Map();
    for (const c of claims) {
      if (!c.payerName || !c.submittedAt || !c.firstPaidAt) continue;
      const d = daysBetween(c.submittedAt, c.firstPaidAt);
      if (d === null || d < 0) continue;
      if (!payerMedian.has(c.payerName)) payerMedian.set(c.payerName, []);
      payerMedian.get(c.payerName).push(d);
    }

    const list = rows
      .map((c) => ({ c, idle: idleDays(c) ?? 0 }))
      .sort((a, b) => b.idle - a.idle)
      .slice(0, 8);

    /*
     * ── A LIST OF ZEROES UNDER "WHAT HAS STOPPED MOVING" ACCUSES HEALTHY CLAIMS ────────────────
     * `worst` is floored at 1, so when every claim moved today each bar is drawn 0.8 units wide out
     * of 100 — a speck at the left edge of an empty track. The screen then showed two rows of
     * name, payer, an apparently broken bar and "0d", beneath a heading announcing that these had
     * stopped moving. Nothing had. The reader is left deciding whether they are looking at stalled
     * claims or at a rendering fault, and neither reading is the truth.
     *
     * Ranking is only meaningful once something is actually idle, so below that this says the good
     * news plainly instead of drawing a ranked list of nothing.
     */
    if (list[0].idle === 0) {
      stuckHost.append(
        node("p", "block2__n", "Nothing has stalled — every open claim moved today.")
      );
      return;
    }

    stuckHost.append(
      node("p", "block2__n",
        "Days since each claim last moved, longest first. The marker is that payer's own median time to pay, drawn only where it has enough finished claims to have one.")
    );

    const worst = Math.max(1, list[0].idle);

    const wrap = node("div", "rank");
    for (const { c, idle } of list) {
      const spans = payerMedian.get(c.payerName) ?? [];
      const expected = spans.length >= 5 ? median(spans) : null;
      const b = node("button", "rank__r");
      b.type = "button";
      b.setAttribute(
        "aria-label",
        `${maskName(c.patientName)}, ${c.payerName ?? "no payer"}, idle ${idle} days${expected === null ? "" : `, this payer's median is ${expected.toFixed(0)} days`}`
      );

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", maskName(c.patientName)));
      name.append(node("span", "rank__sub", c.payerName ?? "No payer on file"));
      b.append(name);

      const track = node("span", "rank__t");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 8");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute(
        "class",
        "rank__f" + (expected !== null && idle > expected ? " is-warning" : "")
      );
      rect.setAttribute("x", "0");
      rect.setAttribute("y", "2");
      rect.setAttribute("width", String(Math.max(0.8, (idle / worst) * 100)));
      rect.setAttribute("height", "4");
      svg.append(rect);
      if (expected !== null) {
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        marker.setAttribute("class", "rank__mark");
        marker.setAttribute("x", String(Math.min(99.4, (expected / worst) * 100)));
        marker.setAttribute("y", "0");
        marker.setAttribute("width", "0.6");
        marker.setAttribute("height", "8");
        svg.append(marker);
      }
      track.append(svg);
      b.append(track, node("span", "rank__v", `${idle}d`));
      b.addEventListener("click", () => store.pushDrill({ kind: "claim", id: c.id, label: maskName(c.patientName) }));
      wrap.append(b);
    }
    stuckHost.append(wrap);
  }

  /**
   * What the scrubber is catching, ranked by the DOLLARS it is holding up rather than by frequency.
   *
   * Counting would rank a trivial edit that fires on every claim above the one blocking a crown, and
   * the point of the ranking is to decide what to fix first.
   *
   * The row carries counts, not reasons — the findings themselves live on the claim detail. So this
   * ranks by what the row can prove: claims held by an error, by claims held by a warning, and by
   * claims a person has not yet released. Naming a CARC-style reason here would require opening
   * every claim on the screen, which is a real cost and a separate decision.
   */
  function drawScrub() {
    scrubHost.replaceChildren();
    const rows = holdPopulation();
    scrubHost.append(node("h2", "block2__h", "What is holding claims up"));

    /*
     * Grouped by `holdOf`, so each claim lands in exactly one bar and the bars sum to the money
     * actually held up — the same function the filter and the table read.
     */
    const groups = HOLDS.map((g) => {
      const hits = rows.filter((c) => holdOf(c) === g.key);
      return { ...g, count: hits.length, dollars: hits.reduce((t, c) => t + (c.outstanding || c.totalFee || 0), 0) };
    })
      .filter((g) => g.count > 0)
      .sort((a, b) => b.dollars - a.dollars);

    if (groups.length === 0) {
      scrubHost.append(
        node("p", "block2__n", "Nothing is held up. Every claim in this selection is either released or finished.")
      );
      return;
    }

    scrubHost.append(node("p", "block2__n", "Ranked by the money each is holding up, not by how often it fires. Selecting one narrows the screen."));

    const top = Math.max(1, groups[0].dollars);
    const wrap = node("div", "rank");
    for (const g of groups) {
      const on = store.isFiltered("hold", g.key);
      const b = node("button", "rank__r" + (on ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", g.label));
      name.append(node("span", "rank__sub", `${g.count} ${g.count === 1 ? "claim" : "claims"} · ${g.note}`));
      b.append(name);

      const track = node("span", "rank__t");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 4");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "rank__f");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(Math.max(0.8, (g.dollars / top) * 100)));
      rect.setAttribute("height", "4");
      svg.append(rect);
      track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(g.dollars)));
      b.addEventListener("click", () => store.toggleFilter({ dim: "hold", value: g.key, label: g.label }));
      wrap.append(b);
    }
    scrubHost.append(wrap);
  }

  function drawTable() {
    table.update(visible(), {
      emptyMessage: store.narrowed()
        ? "No claims match this selection."
        : "No claims have been raised yet.",
    });
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
          what: "Claims could not be loaded.",
          shows: "every claim in its lifecycle, and what is stuck",
          stakes: "Nothing here is stale — it is missing. Any claim waiting for release is still waiting.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["In flight", "Clean claim rate", "Days to adjudication", "At filing risk"], chartHeight: 190 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    renderedAt = Date.now();
    drawRangeState();
    drawBasisState();
    drawChips();
    drawSpine();
    drawChart();
    drawStuck();
    drawScrub();
    drawTable();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
      const res = await api("GET", "/api/v1/claims");
      claims = res.items ?? [];
  }

  /*
   * Unlike Money, a timeframe change here does NOT re-query. `/api/v1/claims` takes no date range,
   * so the window is applied where the flow is built and every store change is a redraw of data the
   * screen already holds.
   */
  const un = store.subscribe(() => drawAll());

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); chart.destroy(); table.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill(entry) {
      if (entry.kind === "claim") return renderClaimDrill(entry.id, { store, api });
      return null;
    },
  };
}

/* ══ Drill: one claim, and the lifecycle behind it ═══════════════════════════════════════════ */
export async function renderClaimDrill(id, { store, api }) {
  const wrap = node("div", "dr__sections");
  wrap.append(node("p", "dr__loading", "Loading claim…"));

  let view, timeline;
  try {
    [view, timeline] = await Promise.all([
      api("GET", `/api/v1/claims/${encodeURIComponent(id)}`),
      /*
       * The timeline is a separate projection and a separate failure. A claim whose history cannot
       * be read is still a claim worth showing, so this degrades to the panel without it rather
       * than to an error page.
       */
      api("GET", `/api/v1/claims/${encodeURIComponent(id)}/timeline`).catch(() => null),
    ]);
  } catch (err) {
    wrap.replaceChildren(node("p", "dr__err", `Could not load this claim — ${err.message}`));
    return wrap;
  }

  const c = view.claim;
  wrap.replaceChildren();

  /* ── Now: the state, and the one action available ─────────────────────────────────────────── */
  const now = node("section", "dr__s");
  now.append(node("div", "dr__k", "Now"));
  now.append(node("div", "dr__fig", usdExact(view.outstanding)));
  now.append(node("p", "dr__p", view.outstanding > 0 ? "still owed by the payer" : "nothing outstanding"));
  now.append(node("p", "dr__p dr__p--muted", view.recommendedAction));

  const meta = node("dl", "dr__dl");
  for (const [k, v, mono] of [
    ["Patient", c.patient ? maskName(`${c.patient.firstName} ${c.patient.lastName}`.trim()) : "—", false],
    ["Payer", c.payer?.payerName ?? "—", false],
    ["Status", String(c.status).replace(/_/g, " "), false],
    ["Service date", c.serviceDate, false],
    ["Claim number", c.submission?.patientControlNumber ?? "not yet filed", true],
  ]) {
    meta.append(node("dt", "", k), node("dd", mono ? "mono" : "", v ?? "—"));
  }
  now.append(meta);
  wrap.append(now);

  /* ── Money: the whole charge accounted for, three ways ────────────────────────────────────── */
  const money = node("section", "dr__s");
  money.append(node("div", "dr__k", "Money"));
  const dl = node("dl", "dr__dl");
  const rows = [
    ["Billed", usdExact(c.totalFee)],
    ["Payer paid", usdExact(view.paidAmount)],
    ["Contract wrote off", usdExact(view.contractualAdjustment)],
    [view.patientShareIsPending ? "Patient's share (provisional)" : "Patient's share", usdExact(view.patientResponsibility)],
  ];
  /*
   * Coordination is shown only when there is some. A "$0.00 with another plan" line on the great
   * majority of claims that have no secondary is noise that hides the line on the ones that do.
   */
  if (view.coordinationPending > 0) rows.push(["Another plan still to rule", usdExact(view.coordinationPending)]);
  for (const [k, v] of rows) dl.append(node("dt", "", k), node("dd", "", v));
  money.append(dl);

  if (view.variance && view.variance.material) {
    money.append(node("p", "dr__p dr__p--muted", view.variance.summary));
  }
  wrap.append(money);

  /* ── Blockers: why this cannot go, in the scrubber's own words ────────────────────────────── */
  if ((view.blockers ?? []).length || (view.advisories ?? []).length) {
    const scrub = node("section", "dr__s");
    scrub.append(node("div", "dr__k", view.blockers.length ? "Blocking" : "Advisory"));
    for (const f of view.blockers ?? []) scrub.append(node("p", "dr__p", f.message ?? String(f)));
    for (const f of view.advisories ?? []) scrub.append(node("p", "dr__p dr__p--muted", f.message ?? String(f)));
    if (view.submitBlockedReason) scrub.append(node("p", "dr__p", view.submitBlockedReason));
    wrap.append(scrub);
  }

  /* ── Timeline: the gaps carry the information (§5.4) ──────────────────────────────────────── */
  if (timeline && (timeline.entries ?? []).length) {
    const tl = node("section", "dr__s");
    tl.append(node("div", "dr__k", "Timeline"));
    const list = node("ol", "dtl");
    const entries = timeline.entries;
    entries.forEach((e, i) => {
      const li = node("li", "dtl__n");
      li.append(node("span", "dtl__dot"));
      const bodyEl = node("span", "dtl__b");
      bodyEl.append(node("span", "dtl__label", e.title));
      const sub = [];
      if (e.actor) sub.push(e.actor === "system" ? "Mermaid" : e.actor);
      if (e.at) {
        sub.push(new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
      }
      /*
       * Elapsed since the PREVIOUS node — the number that makes a stalled claim look stalled. §5.4
       * wants the GAP to carry the information; a vertical list cannot vary its spacing by elapsed
       * time without inventing a scale, so the elapsed time is written instead of drawn.
       */
      const prev = entries[i - 1];
      const gap = prev ? daysBetween(prev.at, e.at) : null;
      if (gap !== null && gap >= 1) sub.push(`${Math.floor(gap)}d later`);
      if (sub.length) bodyEl.append(node("span", "dtl__meta", sub.join(" · ")));
      if (e.detail) bodyEl.append(node("span", "dtl__detail", e.detail));
      li.append(bodyEl);
      list.append(li);
    });
    tl.append(list);
    wrap.append(tl);
  }

  /* ── Related: lateral moves that do not close the panel ───────────────────────────────────── */
  if ((view.recovery?.reasons ?? []).length) {
    const rel = node("section", "dr__s");
    rel.append(node("div", "dr__k", "Denied on this claim"));
    for (const r of view.recovery.reasons) {
      const b = node("button", "dr__line");
      b.type = "button";
      b.append(node("span", "dr__line-n", r.carcDescription));
      b.append(node("span", "dr__line-d", r.status));
      b.append(node("span", "dr__line-v", usdExact(r.deniedAmount)));
      b.addEventListener("click", () =>
        store.pushDrill({ kind: "denial", id: r.denialId, label: r.carcDescription })
      );
      rel.append(b);
    }
    wrap.append(rel);
  }

  return wrap;
}
