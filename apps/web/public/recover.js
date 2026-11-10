/**
 * Recover — the second screen of the operational triad (spec §8.5).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "What money was denied or underpaid, how much of it is realistically winnable, and what expires
 * first?"
 *
 * Three questions, and the third outranks the other two. A denial worth $4,000 with a 70% overturn
 * rate is worth nothing at all once its filing window shuts, so this screen is built to make an
 * expiry impossible to miss and a past expiry impossible to mistake for a live one.
 *
 * ── WHY THE RANKING IS BY DOLLARS AND NOT BY COUNT ───────────────────────────────────────────────
 * §8.5 is explicit and it is right: "count ranking hides the expensive rare denials". A code that
 * fires forty times for $60 each is a process defect worth fixing next quarter; one that fires twice
 * for $4,000 is this afternoon's work. A list sorted by frequency puts the first at the top.
 *
 * ── WHAT IS NOT DRAWN, AND WHY ───────────────────────────────────────────────────────────────────
 * The specification asks the recovery curve to carry a comparison band: "the practice's historical
 * recovery curve for that payer or denial category", so a cohort tracking below its own history
 * reads as urgent. Mermaid holds one denial history, not a current cohort and a separate historical
 * one — drawing a "historical" band from the same records the live curve is drawn from would be a
 * comparison of a set with itself, dressed as a benchmark. §4.4 forbids a reference line that was
 * not measured, so the curve is drawn without one and the absence is named on the screen.
 *
 * Underpayment detection (claims paid below the contracted rate) is a real §8.5 supporting visual
 * and it is genuinely available — as `variance` on the CLAIMS list, not on any denial. It is not
 * fetched here: a second full list on this screen's load path buys one distribution, and the same
 * figure is already the subject of Claims' own variance surfacing. Stated rather than silently
 * dropped.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { maskName } from "./privacy.js";
import { errorBlock, load as loadWithStates, restoreLayout, retire, stageSkeleton } from "./states.js";
import { coordinationLabel } from "./coordination.js";

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
const svgEl = (name, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const DAY = 86400000;

/**
 * §4.4 small-n. Five is the specification's threshold, and the reason it exists is that a rate over
 * three appeals is an anecdote wearing a percentage sign — and this particular percentage decides
 * whether a practice spends an afternoon on a case.
 */
const MIN_SAMPLE = 5;

/**
 * Whether a sample is big enough to quote a rate from.
 *
 * ── WHY THIS IS NOT `n >= MIN_SAMPLE` WRITTEN INLINE ─────────────────────────────────────────────
 * Because `undefined >= 5` is false but `undefined < 5` is ALSO false, and the guard was written the
 * second way. A record that carried no sample size therefore sailed past a check meant to stop it
 * and published "30% — based on undefined similar appeals". The suppression rule exists precisely
 * for the case where the evidence is missing, so a missing sample size is the one input it must
 * never let through. Requiring a finite number makes the absent case fail closed.
 */
export const quotable = (n) => Number.isFinite(n) && n >= MIN_SAMPLE;

/** How a rate is written when it may be written at all, and `null` when it may not. */
export const rateWithBasis = (rate, n, source) => {
  if (!quotable(n) || !Number.isFinite(rate)) return null;
  const where = source === "payer-learned" ? "with this payer" : "across comparable denials";
  return `${Math.round(rate * 100)}% — based on ${n} similar appeals ${where}`;
};

/**
 * The deadline horizon's severity bands, in the order they are tested.
 *
 * "Past" is first and is not a warning. A closed window is not an escalation of an approaching one;
 * it is a different fact — the money is gone — and §8.5 asks for it to render as permanent loss
 * rather than as the most urgent item on a list of things still worth doing.
 */
export const horizonTone = (days) => {
  if (days === null) return "unknown";
  if (days < 0) return "past";
  if (days <= 2) return "critical";
  if (days <= 7) return "warning";
  return "open";
};

export function mountRecover(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  let renderedAt = Date.now();

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "What was denied, and what is worth chasing");
  const controls = node("div", "scr__controls");
  header.append(question, controls);

  const chips = node("div", "fchips");
  const spineHost = node("div", "");

  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  /*
   * The deadline horizon gets the full width and sits directly under the curve, above the two
   * ranked lists. It is the only element on this screen that reports something irreversible, and
   * §8.5's own ordering follows from that.
   */
  const horizonHost = node("section", "block2");

  const reasonsHost = node("section", "block2");
  const payersHost = node("section", "block2");
  const supportRow = node("div", "grid2");
  supportRow.append(reasonsHost, payersHost);

  const tableHost = node("div", "");

  /* Money a payer assigned to another plan — recovered only by filing with that plan (0034). */
  const secondaryHost = node("section", "block2");
  stage.append(header, chips, spineHost, vizHost, horizonHost, secondaryHost, supportRow, node("div", "scr__rule"), tableHost);

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State owned by the screen ────────────────────────────────────────────────────────────── */
  let denials = [];
  let stats = null;
  /** Open secondary-claim work with money on it; null when it could not be read. */
  let secondary = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const ACCESSORS = {
    payer: (d) => d.payerName,
    reason: (d) => d.carcCode,
    status: (d) => d.status,
    window: (d) => horizonTone(d.daysToAppeal),
  };
  const except = (...dims) =>
    Object.fromEntries(Object.entries(ACCESSORS).filter(([k]) => !dims.includes(k)));

  const visible = () => denials.filter((d) => store.matches(d, ACCESSORS));
  /*
   * Each ranked control is drawn from the population MINUS its own dimension — the rule Claims and
   * Money both arrived at the hard way. A control that ranks from its own output deletes every bar
   * but the chosen one, taking with it the distribution the choice was supposed to be read against.
   */
  const reasonPopulation = () => denials.filter((d) => store.matches(d, except("reason")));
  const payerPopulation = () => denials.filter((d) => store.matches(d, except("payer")));
  const horizonPopulation = () => denials.filter((d) => store.matches(d, except("window")));

  /* ── Primitives ───────────────────────────────────────────────────────────────────────────── */
  const chart = createChart(chartHost, {
    store,
    mark: "line",
    height: 190,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    /* The x-axis is elapsed days, not dates — a time brush over it would mean nothing. */
    brushable: false,
    label: "Cumulative dollars recovered, by days since the denial",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  const table = createTable(tableHost, {
    rowKey: (d) => d.id,
    rowHeight: 36,
    amount: (d) => d.deniedAmount,
    formatAmount: (v) => usdExact(v),
    rail: (d) => {
      const tone = horizonTone(d.daysToAppeal);
      return tone === "critical" ? "critical" : tone === "warning" ? "warning" : null;
    },
    empty: "No denials match the current selection.",
    columns: [
      { key: "patient", label: "Patient", type: "entity", get: (d) => maskName(d.patientName), value: (d) => d.patientName },
      { key: "payer", label: "Payer", type: "entity", get: (d) => d.payerName },
      /* §8.5 — never a bare code. The code is the identifier; the description is the meaning. */
      { key: "reason", label: "Why", type: "entity", get: (d) => d.carcDescription, value: (d) => d.carcDescription },
      { key: "code", label: "Code", type: "mono", get: (d) => d.carcCode, width: "72px" },
      { key: "status", label: "Status", type: "status", get: (d) => String(d.status).replace(/_/g, " ") },
      {
        key: "deadline",
        label: "Expires",
        type: "date",
        get: (d) =>
          d.daysToAppeal === null ? "—" : d.daysToAppeal < 0 ? `${Math.abs(d.daysToAppeal)}d ago` : `${d.daysToAppeal}d`,
        /* Soonest-first is the useful order, so an unknown deadline sorts last rather than first. */
        value: (d) => (d.daysToAppeal === null ? Number.POSITIVE_INFINITY : d.daysToAppeal),
      },
      {
        key: "odds",
        /*
         * "Odds" is a bet, and it did not say a bet on what. The figure is the share of appeals
         * against this code that the payer overturned, and "overturn" is the word this screen
         * already uses for it in both ranked lists ("% overturned", "that reason's overturn rate").
         * One noun for one concept, so the column and the prose describe the same thing.
         */
        label: "Overturn",
        type: "count",
        /* Suppressed rather than shown bare when the sample cannot support it (§4.4). */
        get: (d) => (quotable(d.sampleSize) ? `${Math.round(d.overturnRate * 100)}%` : "—"),
        value: (d) => (quotable(d.sampleSize) ? d.overturnRate : -1),
      },
      { key: "denied", label: "Denied", type: "currency", get: (d) => usdExact(d.deniedAmount), value: (d) => d.deniedAmount },
    ],
    onOpen: (d) => store.pushDrill({ kind: "denial", id: d.id, label: maskName(d.patientName) }),
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

  function drawSpine() {
    if (!stats) { spine.update([]); return; }
    const urgentMoney = denials
      .filter((d) => d.daysToAppeal !== null && d.daysToAppeal >= 0 && d.daysToAppeal <= 7 && d.status !== "recovered")
      .reduce((t, d) => t + d.deniedAmount, 0);

    spine.update([
      {
        key: "open",
        label: "Denied and open",
        display: usd(stats.openDenied),
        zero: stats.openDenied === 0,
        delta: null,
        series: [],
        basis: `${stats.openCount} ${stats.openCount === 1 ? "denial" : "denials"} nobody has closed`,
        tone: stats.openDenied > 0 ? "warning" : null,
      },
      {
        key: "winnable",
        label: "Worth pursuing",
        display: usd(stats.openExpectedRecovery),
        zero: stats.openExpectedRecovery === 0,
        delta: null,
        series: [],
        basis: "denied dollars weighted by their own overturn rate",
        tone: null,
      },
      {
        key: "expiring",
        label: "Expiring in 7 days",
        display: usd(urgentMoney),
        zero: urgentMoney === 0,
        delta: null,
        series: [],
        basis: urgentMoney === 0 ? "no open appeal window closes this week" : "after the deadline this is gone",
        tone: urgentMoney > 0 ? "critical" : null,
      },
      {
        key: "recovered",
        label: "Recovered",
        display: usd(stats.recoveredAmount),
        zero: stats.recoveredAmount === 0,
        delta: null,
        series: [],
        /*
         * The rate is stated with its denominator or not at all. A bare "100%" over one appeal is
         * the most misleading number this screen could print.
         */
        basis:
          stats.recoveryRate === null
            ? "nothing has been appealed to a conclusion yet"
            : stats.recoveredCount + stats.writtenOffCount >= MIN_SAMPLE
              ? `${Math.round(stats.recoveryRate * 100)}% of what was appealed`
              : `from ${stats.recoveredCount} of ${stats.recoveredCount + stats.writtenOffCount} concluded — too few to call a rate`,
        tone: null,
      },
    ]);
  }

  /**
   * The recovery curve: cumulative dollars recovered against days from denial to award.
   *
   * Built from the two timestamps a denial actually carries — when it was detected, and when the
   * appeal was awarded. A denial that has been won but never dated cannot be placed on the axis and
   * is counted in the note rather than dropped in silence.
   */
  function drawChart() {
    const rows = visible();
    vizTitle.textContent = "Money recovered, by how long after the denial it arrived";

    const won = rows
      .map((d) => {
        if (!d.awardedAt) return null;
        const days = (Date.parse(d.awardedAt) - Date.parse(d.detectedAt)) / DAY;
        const amount = d.recoveredAmount ?? d.awardSettledAmount ?? 0;
        return Number.isFinite(days) && days >= 0 && amount > 0 ? { days: Math.round(days), amount } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.days - b.days);

    const undated = rows.filter((d) => !d.awardedAt && (d.recoveredAmount ?? 0) > 0).length;

    if (won.length < 2) {
      chart.update([], {
        insufficient:
          won.length === 1
            ? `One appeal has been won and dated (${usdExact(won[0].amount)}, ${won[0].days} days after the denial). A recovery curve needs more than one point to have a shape.`
            : rows.length === 0
              ? "No denials match this selection."
              : "No appeal in this selection has been won and dated yet, so there is no recovery to plot. The curve appears once money comes back.",
      });
      return;
    }

    /* Cumulative, so the curve can only rise — which is what makes a flattening visible. */
    let running = 0;
    const points = won.map((w) => {
      running += w.amount;
      return {
        /*
         * Deliberately no `at`. Every other chart's points carry an instant because their axis IS
         * time; this one's axis is elapsed days, and inventing a date to satisfy the field would put
         * a fabricated timestamp into the shared store the moment anyone dragged across the plot.
         * The chart is constructed unbrushable for the same reason.
         */
        bucket: `d${w.days}`,
        label: `${w.days} days after denial`,
        tick: `${w.days}d`,
        value: running,
        note: `${usdExact(w.amount)} recovered here`,
      };
    });
    chart.update(points);
    chart.setNote(
      "Cumulative, from the day each denial was detected to the day its appeal was awarded. " +
        "No comparison band is drawn: Mermaid holds one denial history, and a benchmark taken from the same records it is benchmarking would compare this set with itself." +
        (undated ? ` ${undated} recovered ${undated === 1 ? "denial carries" : "denials carry"} no award date and cannot be placed on this axis.` : "")
    );
    chart.setProvenance({
      definition:
        "Cumulative dollars recovered, plotted against how many days after the denial the appeal was awarded. No comparison band: Mermaid holds one denial history, and a benchmark from the same records would compare a set with itself.",
      range: "every dated award in the current selection — the axis is elapsed days, not dates",
      records: won.length,
      sources: "Mermaid denials and appeals",
    });
  }

  /**
   * The appeal-deadline horizon — the next 60 days as one track, each open appeal a mark at its own
   * filing deadline, sized by the dollars that die with it.
   *
   * §8.5 wants a past deadline to render as permanent loss and to FEEL like one. It is drawn to the
   * left of the track's origin, in the quaternary ink, with the amount struck through — deliberately
   * not an alarm colour, because an alarm implies something can still be done.
   */
  function drawHorizon() {
    horizonHost.replaceChildren();
    horizonHost.append(node("h2", "block2__h", "What expires, and when"));

    const rows = horizonPopulation().filter((d) => d.status !== "recovered" && d.status !== "written_off");
    const dated = rows.filter((d) => d.daysToAppeal !== null);

    if (dated.length === 0) {
      horizonHost.append(
        node("p", "block2__n",
          rows.length === 0
            ? "No open denial has a filing deadline to miss."
            : `${rows.length} open ${rows.length === 1 ? "denial has" : "denials have"} no appeal deadline recorded, so none can be placed on a horizon.`)
      );
      return;
    }

    horizonHost.append(
      node("p", "block2__n",
        "The next 60 days. Each mark is one appeal at its filing deadline, sized by the money that goes with it. Anything left of today is already gone.")
    );

    const HORIZON = 60;
    const past = dated.filter((d) => d.daysToAppeal < 0);
    const ahead = dated.filter((d) => d.daysToAppeal >= 0 && d.daysToAppeal <= HORIZON);
    const beyond = dated.filter((d) => d.daysToAppeal > HORIZON);
    const biggest = Math.max(1, ...dated.map((d) => d.deniedAmount));

    const track = node("div", "hz");
    const svg = svgEl("svg", { class: "hz__svg", viewBox: `0 0 1000 56`, preserveAspectRatio: "none", role: "img" });
    svg.setAttribute("aria-label", `${ahead.length} appeals with a deadline in the next 60 days`);

    /* The baseline, and today's rule at its origin. */
    svg.append(svgEl("line", { class: "hz__base", x1: 0, y1: 44, x2: 1000, y2: 44, "vector-effect": "non-scaling-stroke" }));
    svg.append(svgEl("line", { class: "hz__today", x1: 0, y1: 6, x2: 0, y2: 50, "vector-effect": "non-scaling-stroke" }));

    for (const d of ahead) {
      const x = (d.daysToAppeal / HORIZON) * 1000;
      /* Height carries the dollars; a floor of 6 keeps a small one clickable rather than invisible. */
      const h = Math.max(6, (d.deniedAmount / biggest) * 34);
      const tone = horizonTone(d.daysToAppeal);
      const bar = svgEl("rect", {
        class: `hz__m is-${tone}`,
        x: Math.min(996, Math.max(0, x - 2)),
        y: 44 - h,
        width: 4,
        height: h,
      });
      const title = svgEl("title");
      title.textContent = `${maskName(d.patientName)} · ${d.payerName} · ${usdExact(d.deniedAmount)} · ${d.daysToAppeal} days left`;
      bar.append(title);
      svg.append(bar);
    }
    track.append(svg);

    const scale = node("div", "hz__scale");
    for (const n of [0, 15, 30, 45, 60]) scale.append(node("span", "hz__tick", n === 0 ? "today" : `${n}d`));
    track.append(scale);
    horizonHost.append(track);

    /* The three facts the track itself cannot state. */
    const notes = node("div", "hz__notes");
    const band = (label, list, tone) => {
      if (list.length === 0) return;
      const total = list.reduce((t, d) => t + d.deniedAmount, 0);
      const b = node("button", `hz__b is-${tone}` + (store.isFiltered("window", tone) ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(store.isFiltered("window", tone)));
      b.append(node("span", "hz__b-n", label));
      const amount = node("span", "hz__b-v", usdExact(total));
      if (tone === "past") amount.classList.add("is-lost");
      b.append(amount);
      b.addEventListener("click", () => store.toggleFilter({ dim: "window", value: tone, label }));
      notes.append(b);
    };
    band("Deadline already passed", past, "past");
    band("Inside 2 days", ahead.filter((d) => d.daysToAppeal <= 2), "critical");
    band("Inside 7 days", ahead.filter((d) => d.daysToAppeal > 2 && d.daysToAppeal <= 7), "warning");
    if (beyond.length) {
      notes.append(
        node("span", "hz__past",
          `${beyond.length} further ${beyond.length === 1 ? "appeal is" : "appeals are"} due beyond 60 days.`)
      );
    }
    horizonHost.append(notes);
  }

  /**
   * Denial reasons ranked by dollars, each carrying its own overturn rate as an inline marker.
   *
   * This is the instrument the screen exists for: it turns a list of CARC codes into an order of
   * work. The bar is the money at stake; the marker is how much of it history says is winnable.
   */
  function drawReasons() {
    reasonsHost.replaceChildren();
    reasonsHost.append(node("h2", "block2__h", "Why the money was withheld"));

    const rows = reasonPopulation();
    if (rows.length === 0) {
      reasonsHost.append(node("p", "block2__n", "No denials in this selection."));
      return;
    }

    const byCode = new Map();
    for (const d of rows) {
      const cur = byCode.get(d.carcCode) ?? {
        code: d.carcCode,
        description: d.carcDescription,
        denied: 0,
        count: 0,
        /* The rate is a property of the CODE's triage, identical across its denials by construction. */
        rate: d.overturnRate,
        sample: d.sampleSize,
        source: d.triageSource,
      };
      cur.denied += d.deniedAmount;
      cur.count += 1;
      /* Keep the best-evidenced rate when several triages of the same code disagree. */
      if (Number.isFinite(d.sampleSize) && d.sampleSize > (cur.sample ?? -1)) {
        cur.rate = d.overturnRate; cur.sample = d.sampleSize; cur.source = d.triageSource;
      }
      byCode.set(d.carcCode, cur);
    }
    const list = [...byCode.values()].sort((a, b) => b.denied - a.denied);

    reasonsHost.append(
      node("p", "block2__n",
        "Ranked by dollars, never by how often a code fires — a rare expensive denial outranks a common cheap one. The dark part of each bar is what its overturn rate says is worth pursuing, drawn only where enough appeals back the rate.")
    );

    const top = Math.max(1, list[0].denied);
    const wrap = node("div", "rank");
    for (const r of list) {
      const on = store.isFiltered("reason", r.code);
      const b = node("button", "rank__r" + (on ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", r.description));
      const basis = rateWithBasis(r.rate, r.sample, r.source);
      name.append(
        node("span", "rank__sub", `${r.code} · ${r.count} ${r.count === 1 ? "denial" : "denials"}${basis ? ` · ${basis}` : " · too few appeals to judge the odds"}`)
      );
      b.append(name);

      /*
       * ── A RATE CANNOT BE READ ON A MONEY AXIS ──────────────────────────────────────────────
       * The bar's width is money — this code's denied dollars against the largest code's. The
       * marker was `rate * 100`, a probability between 0 and 1, plotted on that same ruler. Two
       * quantities, one axis: every reason with a high overturn rate put its tick near the right
       * edge no matter how little money it denied, so the tick drifted free of the bar it was
       * supposed to qualify. The same mistake was in the payer list below and on Verify.
       *
       * Rate times dollars IS a quantity on this axis, and it is one the screen already names: the
       * spine's "Worth pursuing" is denied dollars weighted by their own overturn rate. Drawn as a
       * heavier segment inside the bar it answers the question the marker was reaching for — how
       * much of this is likely to come back — as a part of a whole, needing no key.
       */
      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 8", preserveAspectRatio: "none", "aria-hidden": "true" });
      const full = Math.max(0.8, (r.denied / top) * 100);
      svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 2, width: full, height: 4 }));
      /* Suppressed under the sample threshold rather than drawn faintly: an overturn rate from two
         appeals is not a weak estimate, it is not one. */
      if (quotable(r.sample) && Number.isFinite(r.rate) && r.rate > 0) {
        svg.append(
          svgEl("rect", { class: "rank__seg", x: 0, y: 2, width: Math.min(full, (r.denied * r.rate / top) * 100), height: 4 })
        );
      }
      track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(r.denied)));
      b.addEventListener("click", () =>
        store.toggleFilter({ dim: "reason", value: r.code, label: `${r.code} ${r.description}` })
      );
      wrap.append(b);
    }
    reasonsHost.append(wrap);
  }

  /**
   * Payers ranked by what they have denied, with their own overturn rate beside it.
   *
   * §8.5 asks for appeal success rate per payer with sample sizes shown and anything under n=5
   * suppressed. Suppression here means the ROW still appears — the denied dollars are real and the
   * practice needs to see them — but the rate is replaced by what is true instead: how many appeals
   * would be needed before one could be quoted.
   */
  function drawPayers() {
    payersHost.replaceChildren();
    payersHost.append(node("h2", "block2__h", "Which payer is withholding it"));

    const rows = payerPopulation();
    if (rows.length === 0) {
      payersHost.append(node("p", "block2__n", "No denials in this selection."));
      return;
    }

    const byPayer = new Map();
    for (const d of rows) {
      const cur = byPayer.get(d.payerName) ?? { payer: d.payerName, denied: 0, count: 0, concluded: 0, won: 0 };
      cur.denied += d.deniedAmount;
      cur.count += 1;
      if (d.status === "recovered") { cur.concluded += 1; cur.won += 1; }
      else if (d.status === "written_off") cur.concluded += 1;
      byPayer.set(d.payerName, cur);
    }
    const list = [...byPayer.values()].sort((a, b) => b.denied - a.denied);

    payersHost.append(
      node("p", "block2__n", "Denied dollars per payer. The dark part of each bar is what this payer's own appeal record says comes back, drawn only where enough appeals have concluded to say.")
    );

    const top = Math.max(1, list[0].denied);
    const wrap = node("div", "rank");
    for (const p of list) {
      const on = store.isFiltered("payer", p.payer);
      const b = node("button", "rank__r" + (on ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", p.payer));
      name.append(
        node("span", "rank__sub",
          quotable(p.concluded)
            ? `${p.count} denied · ${Math.round((p.won / p.concluded) * 100)}% overturned (n=${p.concluded})`
            : `${p.count} denied · ${p.concluded} concluded — ${MIN_SAMPLE - p.concluded} more before a rate means anything`)
      );
      b.append(name);

      /* Same correction as the reasons list above: the won/concluded ratio is a count, and drawing
         it on the money axis floated it away from its own bar. The money it implies is a part of
         that bar, so it is drawn as one. */
      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 8", preserveAspectRatio: "none", "aria-hidden": "true" });
      const full = Math.max(0.8, (p.denied / top) * 100);
      svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 2, width: full, height: 4 }));
      if (quotable(p.concluded) && p.won > 0) {
        svg.append(
          svgEl("rect", { class: "rank__seg", x: 0, y: 2, width: Math.min(full, (p.denied * (p.won / p.concluded) / top) * 100), height: 4 })
        );
      }
      track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(p.denied)));
      b.addEventListener("click", () => store.toggleFilter({ dim: "payer", value: p.payer, label: `Payer: ${p.payer}` }));
      wrap.append(b);
    }
    payersHost.append(wrap);
  }

  function drawTable() {
    table.update(visible(), {
      emptyMessage: store.narrowed() ? "No denials match this selection." : "Nothing has been denied.",
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
          what: "Denials could not be loaded.",
          shows: "what was denied, what is winnable, and what expires first",
          stakes: "Appeal deadlines keep running while this is blank.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["Denied and open", "Worth pursuing", "Expiring in 7 days", "Recovered"], chartHeight: 190 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    renderedAt = Date.now();
    drawChips();
    drawSpine();

    /*
     * ── ONE ABSENCE, STATED ONCE ───────────────────────────────────────────────────────────────
     * Five blocks each decided independently that they had nothing to draw, so a practice with no
     * denials met five different sentences for one fact:
     *
     *   "0 denials nobody has closed"      "No denials match this selection."
     *   "No open denial has a filing deadline to miss."   "No denials in this selection." (twice)
     *   "Nothing has been denied."
     *
     * Two of them said "this selection" with nothing selected, which invites a reader to go hunting
     * for the filter they must have left on. And the whole arrangement reads as a screen full of
     * holes, when what it is actually reporting is the best news in the product: no payer has
     * refused a claim. Scaffolding around an absence makes the absence look like a fault.
     *
     * So the emptiness is answered once, by the screen, and the blocks below it do not render at
     * all. The spine stays because four zeroes are a true and useful reading, and the timeframe
     * control stays because it is how a reader widens the question.
     */
    if (denials.length === 0) {
      const note = node("section", "block2");
      const filtered = store.narrowed();
      note.append(node("h2", "block2__h", filtered ? "No denials match these filters." : "Nothing has been denied."));
      note.append(
        node("p", "block2__n",
          filtered
            ? "Clear a filter above to widen the search."
            : "No payer has refused a claim, so there is nothing to appeal and nothing to chase. " +
              "This screen fills in the moment a denial arrives.")
      );
      drawSecondary();
      stage.replaceChildren(header, chips, spineHost, note, secondaryHost);
      return;
    }

    drawChart();
    drawHorizon();
    drawSecondary();
    drawReasons();
    drawPayers();
    drawTable();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
      const res = await api("GET", "/api/v1/denials");
      denials = res.items ?? [];
      /*
       * The scoreboard covers the whole practice, not the filtered page — the endpoint is explicit
       * about that, and it is why the spine does not recompute these from `denials`. "How are we
       * doing at recovery" is a question about the practice, not about what the UI is showing.
       */
      stats = res.stats ?? null;
      /*
       * Read beside the denials, never instead of them: a failure here must not blank the denials
       * the screen exists for, so it is caught and stated in its own block.
       */
      secondary = await api("GET", "/api/v1/coordination-cases?open=1")
        .then((r) => (r.items ?? []).filter((i) => i.assignedCents > 0))
        .catch(() => null);
  }

  /**
   * ── MONEY ASSIGNED TO ANOTHER PLAN ──────────────────────────────────────────────────────────
   * The other half of recovery. A denial is money a payer refused; this is money a payer PASSED ON —
   * paid its share and assigned the rest to another plan's adjudication. It comes back only if
   * someone files with that plan in time. It is not collected and it is not the patient's, so it is
   * never added to the spine's figures; it has its own block, its own deadline, and opens the advice
   * where the next step is taken.
   */
  function drawSecondary() {
    secondaryHost.replaceChildren();
    if (secondary === null) {
      secondaryHost.hidden = false;
      secondaryHost.append(
        node("h2", "block2__h", "Money assigned to another plan"),
        node("p", "block2__n", "Secondary claims could not be loaded. Money assigned to other plans is not shown here until they load.")
      );
      return;
    }
    secondaryHost.hidden = secondary.length === 0;
    if (secondary.length === 0) return;
    const total = secondary.reduce((t, i) => t + i.assignedCents, 0);
    secondaryHost.append(
      node("h2", "block2__h", `Money assigned to another plan — ${usdExact(total)}`),
      node("p", "block2__n",
        "A payer paid its share and assigned the rest to another plan. It is recovered only by filing with that plan — it is not collected, and it is not the patient's.")
    );
    const wrap = node("div", "");
    for (const i of secondary) {
      const b = node("button", "rank__r");
      b.type = "button";
      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", `${i.primaryPayerName} · claim ${i.patientControlNumber}`));
      const due = i.deadline ? ` · file by ${i.deadline.deadline}${i.deadline.estimated ? " (estimate)" : ""}` : "";
      name.append(node("span", "rank__sub", `${coordinationLabel(i)}${due}`));
      b.append(name, node("span", "rank__v", usdExact(i.assignedCents)));
      if (i.remittanceId) {
        b.addEventListener("click", () => store.pushDrill({ kind: "advice", id: i.remittanceId, label: `Claim ${i.patientControlNumber}` }));
      } else {
        b.disabled = true;
      }
      wrap.append(b);
    }
    secondaryHost.append(wrap);
  }

  const un = store.subscribe(() => drawAll());
  load();

  return {
    reload: load,
    destroy() { retire(state); un(); chart.destroy(); table.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill(entry) {
      if (entry.kind === "denial") return renderDenialDrill(entry.id, { api });
      // A secondary claim opens its advice — where the coverage answer and the filing are recorded.
      if (entry.kind === "advice") {
        const m = await import("./money.js");
        return m.renderAdviceDrill(entry.id, { store, api });
      }
      return null;
    },
  };
}

/* ══ Drill: one denial, its evidence, and what the engine recommends ═════════════════════════ */
export async function renderDenialDrill(id, { api }) {
  const wrap = node("div", "dr__sections");
  wrap.append(node("p", "dr__loading", "Loading denial…"));

  let view;
  try {
    view = await api("GET", `/api/v1/denials/${encodeURIComponent(id)}`);
  } catch (err) {
    wrap.replaceChildren(node("p", "dr__err", `Could not load this denial — ${err.message}`));
    return wrap;
  }

  const d = view.denial;
  wrap.replaceChildren();

  /* ── Now ──────────────────────────────────────────────────────────────────────────────────── */
  const now = node("section", "dr__s");
  now.append(node("div", "dr__k", "Now"));
  now.append(node("div", "dr__fig", usdExact(d.deniedAmount)));
  now.append(node("p", "dr__p", "withheld by the payer"));
  now.append(node("p", "dr__p dr__p--muted", view.recommendedAction));
  if (view.blockedReason) now.append(node("p", "dr__p", view.blockedReason));

  const meta = node("dl", "dr__dl");
  for (const [k, v, mono] of [
    ["Patient", maskName(d.patientName), false],
    ["Payer", d.payerName, false],
    ["Status", String(d.status).replace(/_/g, " "), false],
    ["Denied on", dayLabel(d.createdAt), false],
    ["Service date", d.serviceDate ?? "—", false],
    ["Procedure", d.procedureCode ?? "—", true],
    ["Claim", d.claimControlNumber ?? "—", true],
  ]) meta.append(node("dt", "", k), node("dd", mono ? "mono" : "", v ?? "—"));
  now.append(meta);
  wrap.append(now);

  /* ── Why: the code AND what it means, never the code alone (§8.5) ─────────────────────────── */
  const why = node("section", "dr__s");
  why.append(node("div", "dr__k", "Why"));
  why.append(node("p", "dr__p", d.carcDescription));
  /*
   * The adjustment GROUP is part of the reason, not decoration: it says whose decision this was. A
   * `CO` is the contract; a `PI` is the payer choosing to reduce. Null on denials recorded before
   * the group was kept, and shown as absent rather than guessed at.
   */
  why.append(node("p", "dr__p dr__p--muted", d.carcGroup ? `CARC ${d.carcCode}, adjustment group ${d.carcGroup}` : `CARC ${d.carcCode}`));
  wrap.append(why);

  /* ── The engine's reading, with its evidence rather than a bare score ─────────────────────── */
  const odds = node("section", "dr__s");
  odds.append(node("div", "dr__k", "Overturn"));
  const t = d.triage ?? {};
  const basis = rateWithBasis(t.overturnRate ?? 0, t.sampleSize ?? 0, t.source);
  if (basis) {
    odds.append(node("div", "dr__fig-sm", `${Math.round((t.overturnRate ?? 0) * 100)}%`));
    odds.append(node("p", "dr__p", basis));
  } else {
    odds.append(node("div", "dr__fig-sm", "—"));
    odds.append(
      node("p", "dr__p",
        `Only ${t.sampleSize ?? 0} comparable ${(t.sampleSize ?? 0) === 1 ? "appeal has" : "appeals have"} concluded. That is too few to quote a rate from, so none is shown.`)
    );
  }
  if (t.guidance) odds.append(node("p", "dr__p dr__p--muted", t.guidance));
  for (const line of t.explain ?? []) odds.append(node("p", "dr__p dr__p--muted", line));
  wrap.append(odds);

  /* ── The deadline, and what it means if it passes ─────────────────────────────────────────── */
  const when = node("section", "dr__s");
  when.append(node("div", "dr__k", "Deadline"));
  if (d.appealDeadline) {
    when.append(node("div", "dr__fig-sm", dayLabel(d.appealDeadline)));
    when.append(
      node("p", "dr__p",
        view.daysToAppeal === null ? ""
        : view.daysToAppeal < 0
          ? `Closed ${Math.abs(view.daysToAppeal)} days ago. This money cannot be appealed for any more.`
          : `${view.daysToAppeal} days left to file.`)
    );
    // B-1: a payer-published window also shows its note — which document, and the contract caveat.
    if ((view.deadlineEstimated || view.deadlineSourced) && view.deadlineNote) {
      when.append(node("p", "dr__p dr__p--muted", view.deadlineNote));
    }
  } else {
    when.append(node("p", "dr__p", "No filing deadline is recorded for this payer, so none can be counted down."));
  }
  wrap.append(when);

  /* ── The appeal, if one exists. The human gate is stated, never operated from here. ───────── */
  if (view.activeAppeal) {
    const ap = node("section", "dr__s");
    ap.append(node("div", "dr__k", "Appeal"));
    ap.append(node("p", "dr__p", `Status: ${String(view.activeAppeal.status).replace(/_/g, " ")}`));
    if (view.activeAppeal.approvedBy) {
      ap.append(node("p", "dr__p dr__p--muted", `Approved by ${view.activeAppeal.approvedBy}`));
    } else if (view.canApprove) {
      /*
       * Stated, not offered. An appeal is a factual assertion to a payer about a patient's care and
       * it must be approved by a named person on the record that holds the letter they approved —
       * a one-click "Approve" beside a summary is exactly the gate this product refuses to build.
       */
      ap.append(node("p", "dr__p", "A draft is waiting for a named person to approve it before anything is sent."));
    }
    if (view.activeAppeal.letter) {
      const pre = node("pre", "dr__pre", view.activeAppeal.letter);
      ap.append(pre);
    }
    wrap.append(ap);
  }

  return wrap;
}
