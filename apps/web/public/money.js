/**
 * Money — the first screen built end to end on the interaction foundation.
 *
 * ── THE CHAIN THIS SCREEN HAS TO MAKE REAL ───────────────────────────────────────────────────────
 *   metric → chart → hover → click → filter → evidence rows → drill → payment line → claim → action
 *
 * Every arrow in that chain is a real state change, not a visual one:
 *
 *   · choosing a metric re-points the primary chart at a different real series
 *   · changing timeframe RE-QUERIES `/api/v1/analytics/report` with a new window, and separately
 *     queries the preceding window so the delta has a basis rather than a decoration
 *   · clicking a column writes a bucket into the shared store, and the evidence table narrows
 *     because it reads that store — not because the chart told it to
 *   · clicking a payer bar writes a filter, and the chart REBUILDS from the narrowed advices, so
 *     selecting a payer changes the shape of the chart rather than tinting it
 *   · opening a row pushes the drill stack, which leaves every filter behind it intact and live
 *   · a held advice exposes the action that resolves it, wired to the endpoint that does the work
 *
 * ── WHAT IS NOT DRAWN, AND WHY ───────────────────────────────────────────────────────────────────
 * The specification's signature chart for this screen is a production-to-collection waterfall, with
 * gross production as the reference line the collected band is measured against. Mermaid has no
 * production data — procedures completed are not modelled separately from the claims raised off
 * them — so the reference line would have to be invented, and §4.4 forbids that absolutely. The
 * waterfall is therefore not drawn; the composition it would carry is shown as what the data
 * genuinely supports, and the missing series is named in the open rather than approximated.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { RANGES } from "./store.js";
import { maskName } from "./privacy.js";
import { errorBlock, load as loadWithStates, restoreLayout, retire, stageSkeleton } from "./states.js";
import { renderAdviceActions } from "./coordination.js";

const usd = (cents) => {
  const v = Number(cents ?? 0) / 100;
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
/** Cents are load-bearing at transaction level; §2.3 renders them smaller and quieter. */
const usdExact = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}$${s}`;
};
/**
 * The advices the selected timeframe is about.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 * The timeframe control governs this screen: Collected re-queries the report for [from, to] and the
 * chart titles itself "last N days". The evidence table read the advice list unfiltered. So at 7
 * days the screen showed $3,682.50 collected above 97 advices carrying $25,270.45 — two true
 * figures about two different periods, with nothing on the screen saying so. At 90 days the two
 * coincide exactly, which is why it survived every look at the demonstration practice.
 *
 * ── WHY `receivedAt`, AND WHAT IT DELIBERATELY DOES NOT PROMISE ────────────────────────────────
 * `receivedAt` is the advice's own date, and the one the Arrived column already shows. It is NOT
 * the key the engine windows on: `payment_posted` carries `postedAt`, the day money reached the
 * ledger, and for 8 of this practice's 97 postings those two dates differ — an advice held in
 * August and released in September arrives in one window and posts in another.
 *
 * So a windowed advice list does not sum to Collected, and must not be made to. They count
 * different things (advices against postings) over different events (arrival against posting), and
 * the list is not even given `postedAt` by the endpoint. Making them tie out would mean moving a
 * figure to match a list, which is the wrong direction and the wrong number.
 *
 * ── A HELD ADVICE IS A POSITION, SO IT IS ALWAYS IN ────────────────────────────────────────────
 * Held money is not an event inside a window — it is cash sitting unposted until a person acts.
 * That is exactly what the Held tile reports, and why that tile and its two neighbours stay
 * all-time. Windowing held advices out of the table would hide the only rows carrying the action
 * that resolves them, and it would do it worst in the case that matters most: the oldest held
 * advice is the most urgent one and the first to fall outside a 7-day window.
 */
export function advicesInWindow(advices, window) {
  const from = Date.parse(window?.from ?? "");
  const to = Date.parse(window?.to ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [...(advices ?? [])];
  return (advices ?? []).filter((r) => {
    if (r?.status === "held") return true;
    const t = Date.parse(r?.receivedAt ?? "");
    return Number.isFinite(t) && t >= from && t <= to;
  });
}

const dayOf = (iso) => String(iso ?? "").slice(0, 10);
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

/** Which real series each metric points the primary chart at. */
const METRICS = [
  { key: "collected", label: "Collected", tone: null },
  { key: "held", label: "Held", tone: "warning" },
  { key: "pursuing", label: "Worth pursuing", tone: "critical" },
  { key: "cob", label: "With another plan", tone: null },
];

export function mountMoney(stage, { store, api, apiRaw, notify }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "How much is coming in, from whom, and how fast");
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

  /**
   * ── UPLOADING AN 835 THE PRACTICE ALREADY HOLDS (audit A-3) ──────────────────────────────────
   *
   * `POST /api/v1/remittances` accepts raw EDI bytes, refuses an empty file, refuses a truncated
   * one, names the count when a file carries more cheques than the caller expected, and has done
   * since NEW-15. Nothing in the product ever called it. The only ingestion path a person could
   * reach was "Check for payments", which polls a clearinghouse — so a practice that downloads its
   * ERAs from a payer portal, which is most of them, could not get a single payment into Mermaid.
   *
   * It sits on Money rather than on Ops because it is a biller's daily act, not an administrator's
   * one-off: the file arrives in a download folder, and this is the screen they are already on.
   *
   * The multi-payment confirmation is a SECOND click, deliberately. A month-end ERA routinely holds
   * a dozen cheques and `ingestRaw` refuses those outright, naming the count — because somebody
   * uploading what they believe is one payment must be told when it is twelve, rather than have
   * twelve posted on the strength of a belief that was wrong.
   */
  const uploadInput = node("input", "vh");
  uploadInput.type = "file";
  uploadInput.id = "money-835-file";
  uploadInput.accept = ".835,.edi,.txt,.rem,.era,text/plain,application/edi-x12";
  const uploadBtn = node("button", "btn btn--ghost btn--sm", "Upload an 835");
  uploadBtn.type = "button";
  uploadBtn.title = "Post a remittance file downloaded from a payer's portal.";
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", () => uploadChosenFile());
  controls.append(uploadBtn, uploadInput);

  header.append(question, controls);

  const chips = node("div", "fchips");
  const spineHost = node("div", "");
  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  const payersHost = node("section", "block2");
  const feesHost = node("section", "block2");
  const findingsHost = node("section", "block2");
  const tableHost = node("div", "");

  /*
   * ── WHY THESE FOUR FIGURES DO NOT ADD UP, SAID OUT LOUD ──────────────────────────────────────
   *
   * Four money figures in a row read as a breakdown of the first one. They are not: `collected`
   * comes from the report's posted `payment_posted` facts, while the other three are summed over
   * the advices on screen. Nothing in the layout says so, and the arithmetic never closes.
   *
   * The load-bearing one is Held. `remittance/service.ts` is explicit — "nothing posts from an
   * advice that fails the safety gate", and "a held remittance is real cash the payer has already
   * sent, sitting against no ledger entry". So Held is money the practice HAS and has not counted,
   * which is the opposite of what a reader assumes when it sits beside Collected.
   */
  const flowNote = node("p", "block2__n");
  const drawFlowNote = () => {
    const days = store.get().timeframe.days;
    flowNote.textContent =
      `Collected is what posted to the ledger in the last ${days} days, and the advice list and payer ` +
      "breakdown below cover that same period. " +
      "The other three tiles are current positions across every advice, not totals for the period, " +
      "so they do not move when the timeframe does: " +
      "Held is cash a payer has already sent that nobody has reconciled yet, " +
      "Worth pursuing is what payers withheld and a person could still recover, " +
      "and With another plan is what a second payer is responsible for. " +
      "They answer different questions and are not meant to add up to Collected.";
  };
  drawFlowNote();

  stage.append(header, chips, spineHost, flowNote, vizHost, payersHost, feesHost, findingsHost, node("div", "scr__rule"), tableHost);


  /* The screen's own layout, kept so the error state can be replaced and then put back. */


  const LAYOUT = [...stage.children];

  /* ── State owned by the screen: the fetched data, nothing else ────────────────────────────── */
  let advices = [];
  let report = null;
  let priorReport = null;
  /** Per-payer non-ACH rollup (F1). `null` means the request failed — distinct from `[]`, no payer charges. */
  let fees = [];
  /* The three shadow-mode findings surfaces (F2, F4, F5). `null` means the panel failed to load. */
  let variances = [];
  let clock = null;
  let silent = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */

  const state = { loading: false, failed: null, loaded: false };

  const ACCESSORS = {
    payer: (r) => r.payerName,
    status: (r) => r.status,
    bucket: (r) => dayOf(r.receivedAt),
    at: (r) => r.receivedAt,
  };

  const visible = () => advicesInWindow(advices, store.window()).filter((r) => store.matches(r, ACCESSORS));

  /* ── Primitives ───────────────────────────────────────────────────────────────────────────── */
  const chart = createChart(chartHost, {
    store,
    mark: "column",
    height: 180,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    label: "Cash arriving by day",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  const table = createTable(tableHost, {
    rowKey: (r) => r.id,
    rowHeight: 36,
    amount: (r) => r.paymentTotal,
    formatAmount: (c) => usdExact(c),
    rail: (r) => (r.status === "held" ? "warning" : r.totalRecoverable > 0 ? "critical" : null),
    empty: "No advices match the current selection.",
    columns: [
      { key: "payer", label: "Payer", type: "entity", get: (r) => r.payerName },
      { key: "received", label: "Arrived", type: "date", get: (r) => dayLabel(dayOf(r.receivedAt)), value: (r) => r.receivedAt },
      { key: "claims", label: "Claims", type: "count", get: (r) => r.claimCount },
      { key: "status", label: "Status", type: "status", get: (r) => r.status },
      { key: "recoverable", label: "Withheld", type: "currency", get: (r) => (r.totalRecoverable ? usdExact(r.totalRecoverable) : null), value: (r) => r.totalRecoverable ?? 0 },
      { key: "total", label: "Amount", type: "currency", get: (r) => usdExact(r.paymentTotal), value: (r) => r.paymentTotal },
    ],
    onOpen: (r) => store.pushDrill({ kind: "advice", id: r.id, label: r.payerName }),
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

  /** A real delta: this window's figure against the SAME figure for the preceding window. */
  function deltaOf(key) {
    if (!report || !priorReport) return null;
    const now = moneyValue(report, key);
    const before = moneyValue(priorReport, key);
    if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
    return ((now - before) / Math.abs(before)) * 100;
  }

  function moneyValue(rep, key) {
    const m = rep?.money ?? {};
    if (key === "collected") return Number(m.collected ?? 0);
    if (key === "held") return advices.filter((a) => a.status === "held").reduce((t, a) => t + a.paymentTotal, 0);
    if (key === "pursuing") return advices.reduce((t, a) => t + (a.totalRecoverable ?? 0), 0);
    if (key === "cob") return advices.reduce((t, a) => t + (a.totalWithOtherPayers ?? 0), 0);
    return 0;
  }

  function drawSpine() {
    const daily = report?.dailyCollections ?? [];
    spine.update(
      METRICS.map((m) => {
        const v = moneyValue(report, m.key);
        const d = m.key === "collected" ? deltaOf("collected") : null;
        return {
          ...m,
          display: usd(v),
          zero: v === 0,
          delta: d,
          /* Only `collected` has a genuine daily series behind it; the rest are point-in-time
             positions, so they carry no sparkline rather than a fabricated one. */
          series: m.key === "collected" ? daily.map((x) => x.collected) : [],
          basis:
            m.key === "collected"
              ? priorReport
                ? "vs prior period"
                : "no prior period loaded"
              : m.key === "held"
                ? "waiting on a person"
                : m.key === "pursuing"
                  ? "withheld on posted advices"
                  : "file the secondary",
        };
      })
    );
  }

  /**
   * The primary visual follows the active metric, and is rebuilt from the CURRENTLY VISIBLE
   * advices — so a payer filter changes the chart's shape, not merely its colour.
   */
  function drawChart() {
    const metric = store.get().metric ?? "collected";
    const rows = visible();

    if (metric === "collected") {
      const daily = report?.dailyCollections ?? [];
      vizTitle.textContent = `Cash posted, by day, last ${store.get().timeframe.days} days`;
      if (daily.length < 2) {
        chart.update([], {
          insufficient:
            daily.length === 1
              ? `Only one day in this window posted cash (${dayLabel(daily[0].day)}, ${usdExact(daily[0].collected)}). A trend needs more than one reading.`
              : "No cash was posted in this window.",
        });
        return;
      }
      chart.update(
        daily.map((d) => ({
          at: d.day, bucket: d.day, label: dayLabel(d.day), tick: dayLabel(d.day),
          value: d.collected,
          note: `${d.payments} ${d.payments === 1 ? "payment" : "payments"}`,
        }))
      );
      chart.setNote(`${daily.length} days with activity. Click a column to see the advices behind it.`);
      chart.setProvenance({
        definition: "Cash posted against claims, by the day it was applied to them — not the day the advice arrived.",
        range: `last ${store.get().timeframe.days} days, to today`,
        records: daily.reduce((t, d) => t + (d.payments ?? 0), 0),
        sources: "Mermaid postings, from payer remittance advice (835)",
      });
      return;
    }

    /* held / pursuing / cob are read off the advices themselves, bucketed by arrival day. */
    const pick =
      metric === "held" ? (a) => (a.status === "held" ? a.paymentTotal : 0)
      : metric === "pursuing" ? (a) => a.totalRecoverable ?? 0
      : (a) => a.totalWithOtherPayers ?? 0;

    const byDay = new Map();
    for (const a of rows) {
      const v = pick(a);
      if (!v) continue;
      const d = dayOf(a.receivedAt);
      byDay.set(d, (byDay.get(d) ?? 0) + v);
    }
    const series = [...byDay.entries()].sort(([x], [y]) => x.localeCompare(y));
    const title = METRICS.find((m) => m.key === metric)?.label ?? metric;
    vizTitle.textContent = `${title}, by the day the advice arrived`;

    if (series.length < 2) {
      chart.update([], {
        insufficient:
          series.length === 1
            ? `${title} appears on one day only (${dayLabel(series[0][0])}, ${usdExact(series[0][1])}). Too few readings to draw a distribution.`
            : `No advice in this selection carries ${title.toLowerCase()}.`,
      });
      return;
    }
    chart.update(series.map(([d, v]) => ({ at: d, bucket: d, label: dayLabel(d), tick: dayLabel(d), value: v })));
    chart.setNote("Click a column to see the advices behind it.");
    chart.setProvenance({
      definition: `${title}, taken from each advice and bucketed by the day the advice arrived.`,
      range: `last ${store.get().timeframe.days} days, to today`,
      records: rows.length,
      sources: "Mermaid remittance advices (835)",
    });
  }

  /** Ranked payers, each a real filter toggle. Clicking one narrows every other visual. */
  function drawPayers() {
    payersHost.replaceChildren();
    /*
     * ── RANKED FROM THE WHOLE POPULATION, NOT THE FILTERED ONE ────────────────────────────────
     * Ranking these from the visible advices made the control delete itself: selecting one payer
     * left a single row, the "fewer than two to compare" guard fired, and the entire payer list
     * vanished — taking with it both the way to deselect and the distribution the selection was
     * supposed to be read against.
     *
     * A payer's bar is therefore always its share of everything that arrived in the window. The
     * selection is shown by marking the row, which is what §1.5 means by contextual series: the
     * others stay on screen to give the selected one something to sit in.
     */
    /* Windowed for the same reason the table is: this is a breakdown of the money the metrics
       above describe, so it has to be about the same period they are. Store filters are still NOT
       applied — the unselected payers stay on screen to give the selected one something to sit in. */
    const byPayer = new Map();
    for (const a of advicesInWindow(advices, store.window())) {
      byPayer.set(a.payerName, (byPayer.get(a.payerName) ?? 0) + a.paymentTotal);
    }
    const list = [...byPayer.entries()].sort((a, b) => b[1] - a[1]);
    if (list.length < 2) return;

    payersHost.append(node("h2", "block2__h", "What each payer sent"));
    payersHost.append(
      node("p", "block2__n",
        `Every advice that arrived in the last ${store.get().timeframe.days} days, plus anything still held. Selecting a payer narrows the whole screen.`)
    );
    const top = list[0][1];
    const wrap = node("div", "rank");
    for (const [name, value] of list) {
      const on = store.isFiltered("payer", name);
      const b = node("button", "rank__r" + (on ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.append(node("span", "rank__n", name));
      const track = node("span", "rank__t");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 4");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "rank__f");
      rect.setAttribute("x", "0"); rect.setAttribute("y", "0");
      rect.setAttribute("width", String(Math.max(0.8, (value / top) * 100)));
      rect.setAttribute("height", "4");
      svg.append(rect); track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(value)));
      b.addEventListener("click", () => store.toggleFilter({ dim: "payer", value: name, label: `Payer: ${name}` }));
      wrap.append(b);
    }
    payersHost.append(wrap);
  }

  /**
   * ── WHAT A PAYER CHARGED TO PAY THIS PRACTICE (F1) ────────────────────────────────────────────
   *
   * A payer reimbursing by virtual card hands over a card number, and the processor's percentage
   * comes out of money already earned and already discounted to a contracted rate. The advice
   * balances, the claims post, and the fee is taken in a merchant statement nobody reconciles
   * against an 835 — so this is the only place it becomes visible.
   *
   * Silent when there is nothing to say. A practice whose payers all pay by ACH sees no section at
   * all, rather than an empty one asserting that a problem it does not have has been checked.
   */

  /**
   * What the three observation-only features found (F2, F4, F5).
   *
   * ── WHY THEY SHARE ONE SECTION, AND WHY IT SAYS SO ──────────────────────────────────────────
   * None of these has been acted on. They are arithmetic over money that already moved, surfaced
   * so a person can judge them before anything is allowed to act — and a reader who mistakes them
   * for work the system has DONE would double-count every figure on this screen. So the heading
   * says what they are, once, rather than each row implying it.
   *
   * ── WHY NOTHING HERE IS TOTALLED INTO THE CASH POSITION ─────────────────────────────────────
   * Because none of it is cash. An underpayment is money a payer has not sent; prompt-pay interest
   * is money no payer has agreed; a silent claim is money nobody has refused yet. Adding any of it
   * to a figure that reconciles against a bank is how a savings number stops being believed.
   */
  function drawFindings() {
    findingsHost.replaceChildren();

    const failed = [variances === null && "underpayments", clock === null && "statutory clocks", silent === null && "silent claims"].filter(Boolean);
    const rows = [
      variances && variances.length > 0 ? ["Paid below the payer's own rate", variances.length, "Each is a line the payer allowed less on than it has allowed before. Not yet disputed."] : null,
      silent && silent.length > 0 ? ["Filed and never answered", silent.length, "No payment, no denial, no acknowledgement of a problem. The filing clock is still running."] : null,
      clock && clock.items && clock.items.length > 0 ? ["Statutory clocks", clock.items.length, "Late payments and takebacks that may be out of time. Every one is defeasible — check the plan is not self-funded."] : null,
    ].filter(Boolean);

    if (rows.length === 0 && failed.length === 0) return;

    findingsHost.append(node("h2", "block2__h", "Found, not yet acted on"));

    if (failed.length > 0) {
      findingsHost.append(
        node("p", "block2__n", `The ${failed.join(" and ")} panel could not be loaded, so this is not saying none were found.`)
      );
    }
    if (rows.length === 0) return;

    findingsHost.append(
      node("p", "block2__n",
        "Nothing here has been chased, written off, or added to the totals above — these are observations " +
        "waiting on a person. The money in them is money that has not moved.")
    );

    const wrap = node("div", "rank");
    for (const [label, count, why] of rows) {
      const row = node("div", "rank__r");
      row.append(node("span", "rank__n", `${label} — ${count}`));
      const detail = node("span", "rank__t");
      detail.append(node("span", "", why));
      row.append(detail);
      wrap.append(row);
    }
    findingsHost.append(wrap);

    /*
     * Claimed and recovered are printed as two numbers and never as one. The first is arithmetic
     * this system performed; the second is cash somebody confirmed arrived. A single figure would
     * be reporting money nobody has sent, and a savings number only has to be caught disagreeing
     * with the bank once to be worthless afterwards.
     */
    if (clock && clock.savings) {
      const s2 = clock.savings;
      const claimed = (s2.promptPay.claimedCents + s2.recoupment.claimedCents) / 100;
      const recovered = (s2.promptPay.recoveredCents + s2.recoupment.recoveredCents) / 100;
      findingsHost.append(
        node("p", "block2__n",
          `Claimed so far: ${claimed.toFixed(2)}. Actually recovered: ${recovered.toFixed(2)}. ` +
          (s2.deadlinesPassed.findings > 0
            ? `${s2.deadlinesPassed.findings} claim(s) are past a statutory deadline with no answer — no amount is claimed on those, because interest accrues on whatever the payer eventually pays.`
            : ""))
      );
    }
  }

  function drawFees() {
    feesHost.replaceChildren();

    if (fees === null) {
      /* §7: a secondary panel that failed says so, rather than reading as "no payer charges you". */
      feesHost.append(node("h2", "block2__h", "What payers charged to pay you"));
      feesHost.append(node("p", "block2__n", "This could not be loaded, so it is not saying that no payer charges you."));
      return;
    }
    if (fees.length === 0) return;

    const reverted = fees.filter((f) => f.reverted);
    feesHost.append(node("h2", "block2__h", "What payers charged to pay you"));

    /*
     * The rule is "not ACH" rather than "is a card", and the note says so, because a biller who
     * reads this as a card-only list will not recognise the cheque row as the same problem. There is
     * no virtual-card code in the 835 standard — CMS says so — which is exactly why a card can only
     * be found as the absence of ACH.
     */
    feesHost.append(
      node("p", "block2__n",
        "Every reimbursement that did not arrive over ACH. A payer must honour a request to pay by ACH " +
        "(45 CFR 162.925(a)(1)), so each of these is an enrolment away from costing nothing." +
        (reverted.length > 0
          ? ` ${reverted.length} of these paid by ACH before and stopped — that is the one to act on first, because an opt-out that was undone can be redone.`
          : ""))
    );

    const wrap = node("div", "rank");
    for (const f of fees) {
      const row = node("div", "rank__r" + (f.reverted ? " is-on" : ""));
      row.append(node("span", "rank__n", f.reverted ? `${f.payerName} — was ACH` : f.payerName));

      const detail = node("span", "rank__t");
      detail.append(node("span", "", `${f.payments} payment${f.payments === 1 ? "" : "s"} · ${f.latestMethod} · ${usdExact(f.paymentTotal)}`));
      row.append(detail);

      /*
       * The cost, or an honest refusal to state one. `feeCents` is null when the practice has never
       * recorded its merchant discount rate — and a plausible 3% here would be indistinguishable
       * from a measured one to the biller who quotes it back to the payer.
       */
      const cost =
        f.feeCents === null
          ? "cost not recorded"
          : f.unpricedPayments > 0
            ? `${usdExact(f.feeCents)} over ${f.payments - f.unpricedPayments} of ${f.payments}`
            : usdExact(f.feeCents);
      row.append(node("span", "rank__v", cost));
      wrap.append(row);
    }
    feesHost.append(wrap);

    if (fees.some((f) => f.feeCents === null || f.unpricedPayments > 0)) {
      feesHost.append(
        node("p", "block2__n",
          "Some of these carry no cost because this practice's merchant discount rate has not been " +
          "recorded. The payments are still real; only their price is unknown, and it is left blank " +
          "rather than estimated.")
      );
    }
  }

  function drawTable() {
    const rows = visible();
    table.update(rows, {
      emptyMessage: store.narrowed()
        ? `No advices match this selection.`
        /* "in this window", because the list is now scoped to the timeframe: saying "yet" while
           advices exist just outside the selected period is the same lie the windowing fixed. */
        : `No payer advices arrived in the last ${store.get().timeframe.days} days.`,
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
          what: "Payer advices could not be loaded.",
          shows: "what payers have actually sent, and what is held",
          stakes: "Money already in the bank may be sitting unposted.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: METRICS.map((m) => m.label), chartHeight: 180 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    drawRangeState();
    drawFlowNote();
    drawChips();
    drawSpine();
    drawChart();
    drawPayers();
    drawFees();
    drawFindings();
    drawTable();
  }

  /**
   * Read the chosen file, post its bytes, and say what the server made of it.
   *
   * ── WHY THE TWO-STEP ON A MULTI-PAYMENT FILE ─────────────────────────────────────────────────
   * The server refuses a file carrying more than one payment unless the caller says it expects one,
   * and it names the count in the refusal. That refusal is the feature: a biller uploading what they
   * believe is one cheque, when it is in fact a month-end file of twelve, is about to post eleven
   * payments they have not looked at. So the count is put in front of them and the second click is
   * theirs.
   *
   * The refusal is recognised by its CODE, never by matching its wording — an error message is
   * written for a person and is free to be rewritten, and a client that branches on its prose breaks
   * silently the first time somebody improves it.
   */
  async function uploadChosenFile() {
    const file = uploadInput.files?.[0];
    if (!file) return;
    /* Cleared immediately: choosing the same file twice must fire `change` both times, and it will
       not if the input still holds it. */
    uploadInput.value = "";

    uploadBtn.disabled = true;
    uploadBtn.textContent = "Posting…";
    try {
      const text = await file.text();
      let result;
      try {
        result = await apiRaw("/api/v1/remittances", text);
      } catch (err) {
        if (err.code !== "multiple_payments") throw err;
        const proceed = confirmMultiple(err.message);
        if (!proceed) { notify?.("Nothing was posted.", "info"); return; }
        result = await apiRaw("/api/v1/remittances?multiple=1", text);
      }

      /**
       * Both responses are `RemittanceView`-shaped, and the advice is one level down.
       *
       * The single upload returns the view itself — `{ remittance, totalRecoverable, … }` — and the
       * confirmed multi-payment upload returns `{ remittances: view[], count }`. Reading
       * `result.payerName` off either therefore finds nothing, and the toast said "Posted the
       * payer's advice — $0.00" over a payment that had in fact posted correctly. A success message
       * that reports zero dollars is worse than no message: it is the shape of the bug the person
       * was checking for.
       */
      const posted = result.count ?? 1;
      const advice = (result.remittances?.[0] ?? result).remittance;

      /**
       * Reload FIRST, then say so.
       *
       * `notify` prepends its notice into the stage, and `load` → `drawAll` → `restoreLayout`
       * replaces the stage's children. Notifying before reloading therefore created the message and
       * destroyed it about a second later, so a successful upload looked silent — on the one action
       * on this screen where silence and failure are indistinguishable to the person who just handed
       * over a payment file.
       */
      await load();
      notify?.(
        posted === 1
          ? `Posted ${advice?.payerName ?? "the payer"}'s advice — ${usdExact(advice?.paymentTotal ?? 0)}.`
          : `Posted ${posted} payments from that file.`,
        "good"
      );
    } catch (err) {
      /* The server's own wording: it already names the segment, the count or the imbalance, and
         nothing this screen could compose would be more use to whoever has the file open. */
      notify?.(err.message, "bad");
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload an 835";
    }
  }

  /**
   * The one confirmation on this screen, and it is a real question about money.
   *
   * `window.confirm` rather than a built dialog because this must BLOCK — the alternative is an
   * async modal whose "cancel" path has to unwind an upload already in flight, and the failure mode
   * of getting that wrong is posting eleven payments nobody agreed to.
   */
  function confirmMultiple(message) {
    return window.confirm(`${message}

Post every payment in this file?`);
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
    const { from, to } = store.window();
    const days = store.get().timeframe.days;
    const priorTo = from;
    const priorFrom = new Date(new Date(from).getTime() - days * 86400000).toISOString();
    const [adv, rep, prior, pm, av, sc, si] = await Promise.all([
      api("GET", "/api/v1/remittances"),
      api("GET", `/api/v1/analytics/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      api("GET", `/api/v1/analytics/report?from=${encodeURIComponent(priorFrom)}&to=${encodeURIComponent(priorTo)}`).catch(() => null),
      /*
       * Caught rather than allowed to reject: this panel is secondary, and blanking the whole Money
       * screen because a payer-fee rollup failed would cost the reader the cash position to report a
       * cost of receiving it. `null` is carried through so the section can SAY it failed instead of
       * rendering as though no payer charges this practice.
       */
      api("GET", "/api/v1/payment-methods").catch(() => null),
      /*
       * The same reasoning as the fee rollup above: secondary panels, caught individually, so one
       * failing surface cannot blank the cash position. Each carries its own null through to the
       * renderer, which SAYS it could not load rather than rendering as though nothing was found —
       * the difference between a quiet screen and a screen that has quietly stopped checking.
       */
      api("GET", "/api/v1/allowed-variances?recoverable=1").catch(() => null),
      api("GET", "/api/v1/statutory-clock?open=1").catch(() => null),
      api("GET", "/api/v1/silent-claims").catch(() => null),
    ]);
    advices = adv.items ?? [];
    report = rep;
    priorReport = prior;
    fees = pm === null ? null : (pm.items ?? []);
    variances = av === null ? null : (av.items ?? []);
    clock = sc;
    silent = si === null ? null : (si.items ?? []);
  }

  const un = store.subscribe((_s, reason) => {
    if (reason === "timeframe") { load(); return; }   /* a real re-query, not a client-side filter */
    drawAll();
  });

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); chart.destroy(); table.destroy(); spine.destroy(); stage.replaceChildren(); },
    /** The drill renderer, handed to the panel so it can resolve an entity to a view. */
    async renderDrill(entry) {
      if (entry.kind === "advice") return renderAdviceDrill(entry.id, { store, api });
      if (entry.kind === "posting") return renderPosting(entry, { store });
      return null;
    },
  };
}

/* ══ Drill level 1: the advice ═══════════════════════════════════════════════════════════════ */
export async function renderAdviceDrill(id, { store, api }) {
  const wrap = node("div", "dr__sections");
  wrap.append(node("p", "dr__loading", "Loading advice…"));
  let view;
  try {
    view = await api("GET", `/api/v1/remittances/${encodeURIComponent(id)}`);
  } catch (err) {
    wrap.replaceChildren(node("p", "dr__err", `Could not load this advice — ${err.message}`));
    return wrap;
  }
  /*
   * The detail endpoint answers with a WRAPPER — the advice itself is nested under `remittance`,
   * beside the engine's own reading of it: what is recoverable, what belongs to another plan, and
   * the action it recommends. Reading the wrapper as though it were the advice produced a panel
   * headed "$0.00" with no payment lines, which looked like an empty advice rather than a bug.
   */
  const r = view.remittance ?? view;
  wrap.replaceChildren();

  const now = node("section", "dr__s");
  now.append(node("div", "dr__k", "Now"));
  now.append(node("div", "dr__fig", usdExact(r.paymentTotal)));
  now.append(
    node("p", "dr__p",
      r.status === "held" && view.releaseBlocked
        /* NOT "the practice's money already": a copy of a payment already on the books, or a test. */
        ? (view.releaseBlocked.rejectAs === "test-file"
            ? "A test file, not a payment — there is no money behind it. It cannot be released; reject it as a test file."
            : "A copy of a payment already on the books — not additional money. It cannot be released; reject it as a duplicate.")
        : r.status === "held"
        ? "In the bank and not yet posted. This is the practice's money already — it is waiting on a person, not on a payer."
        : r.status === "rejected"
          /* Never "posted": a rejected advice is evidence of what a payer sent, not money on the books. */
          ? `Rejected as ${r.rejection?.kind === "test-file" ? "a test file" : "a duplicate"} — never posted. ` +
            "None of this amount is on the books; the advice is kept as a record of what the payer sent."
          : "Posted against the claims below.")
  );
  const meta = node("dl", "dr__dl");
  for (const [k, v] of [
    ["Payer", r.payerName],
    ["Status", r.status],
    ["Payer's payment date", r.paymentDate],
    ["Trace number", r.traceNumber],
    ["Balances", r.balanced ? "yes" : "no"],
  ]) {
    meta.append(node("dt", "", k), node("dd", k === "Trace number" ? "mono" : "", v ?? "—"));
  }
  now.append(meta);
  if (view.recommendedAction) now.append(node("p", "dr__p dr__p--muted", view.recommendedAction));
  wrap.append(now);

  /*
   * What a person can DO with this advice — release, reject, answer a coverage question, move a
   * secondary claim. This drill was read-only, and the only renderer with those actions was mounted
   * for Test Lab alone, so no operator-facing screen could act on a held advice. Re-rendered from the
   * server after every action, so the panel never shows a state the server did not confirm.
   */
  const actions = await renderAdviceActions(view, {
    api,
    reload: async () => {
      const fresh = await renderAdviceDrill(id, { store, api });
      wrap.replaceChildren(...fresh.childNodes);
    },
  });
  if (actions) wrap.append(actions);

  /* What the engine concluded about this advice, which is why the wrapper exists. */
  if (view.totalRecoverable > 0 || view.totalWithOtherPayers > 0) {
    const eng = node("section", "dr__s");
    eng.append(node("div", "dr__k", "Still owed"));
    if (view.totalRecoverable > 0) {
      eng.append(node("div", "dr__fig-sm", usdExact(view.totalRecoverable)));
      eng.append(node("p", "dr__p", "withheld with a reason worth pursuing"));
    }
    if (view.totalWithOtherPayers > 0) {
      eng.append(node("p", "dr__p", `${usdExact(view.totalWithOtherPayers)} was assigned to another plan — tracked as a secondary claim, not collected.`));
    }
    wrap.append(eng);
  }

  const lines = node("section", "dr__s");
  lines.append(node("div", "dr__k", `Payment lines (${(r.postings ?? []).length})`));
  for (const p of r.postings ?? []) {
    const b = node("button", "dr__line");
    b.type = "button";
    b.append(node("span", "dr__line-n", maskName(p.patientName)));
    b.append(node("span", "dr__line-d", p.disposition.replace(/_/g, " ")));
    b.append(node("span", "dr__line-v", usdExact(p.paidAmount)));
    b.addEventListener("click", () =>
      store.pushDrill({ kind: "posting", id: p.id, label: maskName(p.patientName), posting: p, payer: r.payerName })
    );
    lines.append(b);
  }
  if ((r.postings ?? []).length === 0) lines.append(node("p", "dr__p", "This advice carries no payment lines."));
  wrap.append(lines);

  if ((r.issues ?? []).length) {
    const iss = node("section", "dr__s");
    iss.append(node("div", "dr__k", "Issues"));
    for (const i of r.issues) iss.append(node("p", "dr__p", typeof i === "string" ? i : i.message ?? JSON.stringify(i)));
    wrap.append(iss);
  }
  return wrap;
}

/* ══ Drill level 2: one payment line, and the claim behind it ════════════════════════════════ */
function renderPosting(entry, { store }) {
  const p = entry.posting;
  const wrap = node("div", "dr__sections");

  const now = node("section", "dr__s");
  now.append(node("div", "dr__k", "Now"));
  now.append(node("div", "dr__fig", usdExact(p.paidAmount)));
  now.append(node("p", "dr__p", `${entry.payer} ${p.disposition.replace(/_/g, " ")} this claim.`));
  wrap.append(now);

  const money = node("section", "dr__s");
  money.append(node("div", "dr__k", "Money"));
  const dl = node("dl", "dr__dl");
  for (const [k, v] of [
    ["Charged", usdExact(p.chargedAmount)],
    ["Paid", usdExact(p.paidAmount)],
    ["Patient's share", usdExact(p.patientResponsibility)],
    ["Claim", p.patientControlNumber],
  ]) dl.append(node("dt", "", k), node("dd", k === "Claim" ? "mono" : "", v));
  money.append(dl);
  wrap.append(money);

  if (p.variance) {
    const v = node("section", "dr__s");
    v.append(node("div", "dr__k", "Why it differs"));
    v.append(node("div", "dr__fig-sm", usdExact(p.variance.recoverableAmount ?? 0)));
    v.append(node("p", "dr__p", "withheld with a reason worth pursuing"));
    for (const a of p.adjustments ?? []) {
      v.append(node("p", "dr__p dr__p--muted", `${a.group}-${a.code} ${a.description} — ${usdExact(a.amount)}`));
    }
    wrap.append(v);
  }

  if ((p.remarks ?? []).length) {
    const rm = node("section", "dr__s");
    rm.append(node("div", "dr__k", "Payer remarks"));
    for (const r of p.remarks) rm.append(node("p", "dr__p dr__p--muted", `${r.code} — ${r.description}`));
    wrap.append(rm);
  }
  return wrap;
}
