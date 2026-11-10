/**
 * Verify — the third screen of the operational triad (spec §8.2).
 *
 * ── THE QUESTION, IN TWO HALVES ──────────────────────────────────────────────────────────────────
 * §8.2 asks: "Is every patient we are about to treat covered, and where exactly are the gaps?" —
 * and specifies a forward-looking readiness timeline: the next 14 days, each day a stack of
 * appointment blocks whose height is SCHEDULED PRODUCTION, so one big case reads heavier than four
 * hygiene visits.
 *
 * That timeline is the top of this screen (`verify-readiness.js`), drawn from the practice's
 * schedule (migration 0035). Until the schedule existed it could not be drawn honestly — a forward
 * track built from verification records would have been a chart of appointments that do not exist
 * — so this screen used to lead with its look-back instead.
 *
 * The look-back stays, beneath it: what WAS checked, day by day, stacked by how each check came out,
 * its height the money each check put at stake. It answers "what came back unresolved", which the
 * forward view cannot — a failed check for a patient with no visit booked is still work.
 *
 * ── WHAT ELSE IS NOT DRAWN ───────────────────────────────────────────────────────────────────────
 * The payer response-time histogram (§8.2's "which payers require a head start") needs the latency
 * between the 270 going out and the 271 coming back. The verification record keeps `createdAt` and
 * nothing about when the eligibility call returned, so the distribution has no source. It is a
 * genuinely useful chart and it is one recorded field away; it is not approximated in the meantime.
 *
 * ── THE DRILL IS THE POINT OF THIS SCREEN ────────────────────────────────────────────────────────
 * §8.2 calls the raw-to-parsed mapping "a core trust feature — build it, don't skip it", and it is
 * right: everything downstream of this screen inherits these numbers. An estimate a practice quotes
 * a patient from, a claim that inherits that estimate, a variance measured against it — all of it
 * rests on a parse of a 271 that nobody can see. So the drill puts the parsed benefit beside the
 * payer's own bytes, and every card field beside the confidence and the explanation the reader gave
 * it, so a person can check the machine's work rather than trust it.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { RANGES } from "./store.js";
import { maskName } from "./privacy.js";
import { errorBlock, load as loadWithStates, restoreLayout, retire, stageSkeleton } from "./states.js";
import { atStake, partition } from "./verify-buckets.js";
import { mountReadiness } from "./verify-readiness.js";

const usd = (cents) => {
  const v = Number(cents ?? 0) / 100;
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
const usdExact = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}$${s}`;
};
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
const svgEl = (name, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const DAY = 86400000;

/**
 * The stack, bottom-up: settled at the bottom, unresolved above it.
 *
 * Ordered so the thing needing a person is always the band on TOP — the eye lands on the top of a
 * column first, and on this screen the top of the column is the work.
 */
const OUTCOMES = [
  { key: "complete", label: "Answered" },
  { key: "needs_human", label: "Needs a person" },
  /* Warning, not critical: §1.4 reserves critical for money withheld and not recovered, and a
     check that never reached the payer has lost nobody a dollar yet. See drawSpine. */
  { key: "blocked", label: "Could not be checked", tone: "warning" },
];
const OUTCOME_LABEL = (k) => OUTCOMES.find((o) => o.key === k)?.label ?? String(k).replace(/_/g, " ");


export function mountVerify(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "Is everyone we are about to treat covered");
  header.append(question);

  /*
   * The look-back half keeps its own heading and carries the timeframe control beside it, because
   * that control governs only this half: the readiness block above is always the next fourteen days,
   * and a "last 90 days" switch sitting over it would read as though it moved the fortnight.
   */
  const checkedHead = node("div", "scr__head scr__head--sub");
  const checkedTitle = node("h2", "scr__q2", "Whose coverage has been checked, and what did it say");
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
  checkedHead.append(checkedTitle, controls);

  const readyHost = node("section", "");
  const chips = node("div", "fchips");
  const spineHost = node("div", "");
  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  const gapsHost = node("section", "block2");
  const payersHost = node("section", "block2");
  const supportRow = node("div", "grid2");
  supportRow.append(gapsHost, payersHost);

  const tableHost = node("div", "");

  stage.append(
    header,
    readyHost,
    node("div", "scr__rule"),
    checkedHead,
    chips,
    spineHost,
    vizHost,
    supportRow,
    node("div", "scr__rule"),
    tableHost
  );

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let verifications = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const ACCESSORS = {
    payer: (v) => v.payerName ?? "No payer identified",
    outcome: (v) => v.outcome,
    provenance: (v) => v.provenance?.kind ?? "none",
    bucket: (v) => dayOf(v.createdAt),
    at: (v) => v.createdAt,
  };
  const except = (...dims) =>
    Object.fromEntries(Object.entries(ACCESSORS).filter(([k]) => !dims.includes(k)));

  const visible = () => verifications.filter((v) => store.matches(v, ACCESSORS));
  /* Each control ranks from the population minus its own dimension — see claims.js for the failure
     this prevents: a control that ranks from its own output deletes every option but the chosen one. */
  const chartPopulation = () => verifications.filter((v) => store.matches(v, except("bucket", "at")));
  const gapPopulation = () => verifications.filter((v) => store.matches(v, except("outcome")));
  const payerPopulation = () => verifications.filter((v) => store.matches(v, except("payer")));

  /* ── Primitives ───────────────────────────────────────────────────────────────────────────── */
  const chart = createChart(chartHost, {
    store,
    mark: "band",
    height: 190,
    series: OUTCOMES,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    label: "Money checked per day, by how the check came out",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  /* §8.2 primary visual: the next fourteen days. Its own selection; see verify-readiness.js. */
  /* After a run, the whole screen re-reads: readiness, the queue below, and the look-back. */
  const readiness = mountReadiness(readyHost, { api, store, onChanged: () => load() });

  const table = createTable(tableHost, {
    rowKey: (v) => v.id,
    rowHeight: 36,
    amount: (v) => atStake(v),
    formatAmount: (c) => usdExact(c),
    /* Both unresolved outcomes are "a person must act"; the Outcome column says which, and the
       rail is not the channel that distinguishes them (§1.4 — colour is a claim about the money,
       and neither of these is lost money). */
    rail: (v) => (v.outcome === "blocked" || v.outcome === "needs_human" ? "warning" : null),
    empty: "No verifications match the current selection.",
    columns: [
      { key: "patient", label: "Patient", type: "entity", get: (v) => maskName(v.patientName), value: (v) => v.patientName },
      { key: "payer", label: "Payer", type: "entity", get: (v) => v.payerName ?? "—" },
      /*
       * Provenance travels on the ROW, not only in the drill. A queue of eight names with payers
       * beside them reads as eight verified patients, and nobody opens a record to find out
       * otherwise — which is the exact confusion this column exists to remove.
       */
      { key: "source", label: "Source", type: "status", get: (v) => v.provenance?.shortLabel ?? "—" },
      { key: "outcome", label: "Outcome", type: "status", get: (v) => OUTCOME_LABEL(v.outcome) },
      { key: "checked", label: "Checked", type: "date", get: (v) => dayLabel(v.createdAt), value: (v) => v.createdAt },
      {
        key: "flags",
        /*
         * "Flags" is a count of nothing a reader can name — the column showed "3" against a patient
         * and left them to guess what three of anything meant. These are the record's critical
         * exceptions: a contested card reading, a name the payer does not have. "Problems" is the
         * plain word for that, and it makes the number self-describing at a glance.
         */
        label: "Problems",
        type: "count",
        get: (v) => (v.criticalFlags > 0 ? String(v.criticalFlags) : "—"),
        value: (v) => v.criticalFlags,
      },
      {
        key: "patient_pays",
        label: "Patient pays",
        type: "currency",
        get: (v) => (v.patientPays === null ? null : usdExact(v.patientPays)),
        value: (v) => v.patientPays ?? -1,
      },
      { key: "stake", label: "At stake", type: "currency", get: (v) => usdExact(atStake(v)), value: (v) => atStake(v) },
    ],
    onOpen: (v) => store.pushDrill({ kind: "verification", id: v.id, label: maskName(v.patientName) }),
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

  /**
   * The four figures across the top, and the rule that governs which four they may be.
   *
   * ── THE DEFECT THIS REPLACED ───────────────────────────────────────────────────────────────────
   * The spine is a row of equal siblings separated by hairlines, so a reader takes the figures in it
   * to be parallel — different slices of the same population, side by side. Three of the four were
   * not. "Waiting on a person" was every unresolved check; "Could not be checked" was a STRICT
   * SUBSET of it; and "No benefits returned" counted any check whose payer sent no benefits, which
   * on real data is mostly the blocked ones over again. The screenshot at 1280 showed the cost:
   *
   *     Could not be checked   $1,360        No benefits returned   $1,360
   *
   * the same blocked check, twice, under two headings, with nothing on screen to say they were one
   * check. There is no reading of that row a person can trust. Either the practice has $2,720 of
   * trouble or it has $1,360, and the interface offered no way to tell — while a reader who added
   * the row got $5,505, a number describing nothing.
   *
   * ── THE RULE ───────────────────────────────────────────────────────────────────────────────────
   * NO METRIC IN THIS SPINE MAY CONTAIN ANOTHER. A check falls in at most one of the first three,
   * so the figures can be read across without double-counting a dollar. If a fifth question ever
   * earns a slot here, it has to partition too, or it belongs in a block below with its own words.
   *
   * The aggregate went away rather than being labelled, and that is the trade: a reader loses one
   * roll-up and gains two numbers that say which KIND of work is waiting — a decision or a phone
   * call — which is the thing that actually changes what they do next.
   */
  function drawSpine() {
    const rows = verifications;
    const n = rows.length;
    const sum = (list) => list.reduce((t, v) => t + atStake(v), 0);
    /* Every basis line names the same denominator, so the four read as parts of one population. */
    const of = (k) => `${k} of ${n} ${n === 1 ? "check" : "checks"}`;

    /* The three buckets, and the guarantee that they do not overlap, live in verify-buckets.js. */
    const { needsHuman, blocked, empty } = partition(rows);

    spine.update([
      {
        key: "needs_human",
        label: "Needs a person",
        display: usd(sum(needsHuman)),
        zero: needsHuman.length === 0,
        delta: null,
        series: [],
        basis:
          needsHuman.length === 0
            ? "no check is waiting on a decision"
            : `${of(needsHuman.length)} · answered, needs a decision`,
        tone: needsHuman.length > 0 ? "warning" : null,
      },
      {
        key: "blocked",
        label: "Could not be checked",
        display: usd(sum(blocked)),
        zero: blocked.length === 0,
        delta: null,
        series: [],
        basis:
          blocked.length === 0
            ? "every card reached a payer"
            : `${of(blocked.length)} · needs a phone call or a portal`,
        /*
         * WARNING, not critical. §1.4 gives critical one meaning — money withheld and not recovered
         * — and a check that never reached the payer has not lost anybody a dollar yet. It is the
         * definition of "a person must act", which is what warning says. Painting it as loss put
         * the screen's loudest colour on its most recoverable problem.
         */
        tone: blocked.length > 0 ? "warning" : null,
      },
      {
        key: "empty",
        label: "Answered with no benefits",
        display: usd(sum(empty)),
        zero: empty.length === 0,
        delta: null,
        series: [],
        basis:
          empty.length === 0
            ? "every answered check carried benefits"
            : `${of(empty.length)} · replied with no coverage`,
        tone: empty.length > 0 ? "warning" : null,
      },
      {
        key: "quoted",
        label: "Quoted to patients",
        display: usd(rows.reduce((t, v) => t + (v.patientPays ?? 0), 0)),
        zero: rows.every((v) => !v.patientPays),
        delta: null,
        series: [],
        /* The one figure here that is not a slice of the three beside it, so the basis says which
           direction it points rather than restating the label. */
        basis: `what all ${n} estimates tell patients they owe`,
        tone: null,
      },
    ]);
  }

  /**
   * The readiness timeline, turned around: what was checked each day, stacked by how it came out,
   * with the height carrying the money rather than the headcount.
   */
  function drawChart() {
    const rows = chartPopulation();
    const days = store.get().timeframe.days;
    vizTitle.textContent = `Money checked per day, by how the check came out, last ${days} days`;

    if (rows.length === 0) {
      chart.update([], {
        insufficient: store.narrowed()
          ? "No verifications match this selection."
          : "Nothing has been verified yet.",
      });
      return;
    }

    /* Anchored on midnight UTC so a column is a whole day, never a rolling window (§4.4). */
    const todayUtc = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
    const start = todayUtc - (days - 1) * DAY;

    const byDay = new Map();
    for (const v of rows) {
      const d = dayOf(v.createdAt);
      if (!byDay.has(d)) byDay.set(d, { complete: 0, needs_human: 0, blocked: 0, n: 0 });
      const slot = byDay.get(d);
      const key = OUTCOMES.some((o) => o.key === v.outcome) ? v.outcome : "needs_human";
      slot[key] += atStake(v);
      slot.n += 1;
    }

    const points = [];
    for (let t = start; t <= todayUtc; t += DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const slot = byDay.get(iso) ?? { complete: 0, needs_human: 0, blocked: 0, n: 0 };
      points.push({
        at: iso,
        bucket: iso,
        label: dayLabel(iso),
        tick: dayLabel(iso),
        parts: { complete: slot.complete, needs_human: slot.needs_human, blocked: slot.blocked },
        partial: t === todayUtc,
        note: slot.n === 0 ? "nothing checked" : `${slot.n} ${slot.n === 1 ? "check" : "checks"}`,
      });
    }

    const active = points.filter((p) => p.parts.complete + p.parts.needs_human + p.parts.blocked > 0);
    if (active.length < 2) {
      chart.update([], {
        insufficient:
          active.length === 1
            ? `Every check in this window happened on one day (${dayLabel(active[0].bucket)}). A daily pattern needs more than one day.`
            : "No coverage was checked on any day of this window.",
      });
      return;
    }

    chart.update(points, { series: OUTCOMES });
    chart.setNote(
      "Height is the money each check put at stake, not the number of patients — one crown outweighs four cleanings. " +
        "This looks BACK at what was checked. Who is coming in, and whether they are covered, is the fourteen-day view above. " +
        "Click a day to see the checks behind it."
    );
    chart.setProvenance({
      definition:
        "Treatment money put at stake by each coverage check, on the day the check was made, split by how the check came out. Looks backward; the schedule-driven view is the readiness timeline above.",
      range: `last ${days} days, to today`,
      records: rows.length,
      sources: "Mermaid verifications, via the configured eligibility adapter",
    });
  }

  /**
   * Where the gaps are — the ranked reasons a check did not end in a usable answer.
   *
   * Ranked by dollars at stake for the same reason Recover ranks denials that way: one blocked
   * crown outranks six blocked cleanings, and a frequency ranking hides it.
   */
  function drawGaps() {
    gapsHost.replaceChildren();
    gapsHost.append(node("h2", "block2__h", "Where the gaps are"));

    const rows = gapPopulation();
    const unresolved = rows.filter((v) => v.outcome !== "complete");
    if (unresolved.length === 0) {
      gapsHost.append(
        node("p", "block2__n",
          rows.length === 0 ? "Nothing has been checked yet." : "Every check in this selection came back with an answer.")
      );
      return;
    }

    gapsHost.append(
      node("p", "block2__n", "Ranked by the treatment money each is holding up. Selecting one narrows the whole screen.")
    );

    const groups = OUTCOMES.filter((o) => o.key !== "complete")
      .map((o) => {
        const hits = unresolved.filter((v) => (OUTCOMES.some((x) => x.key === v.outcome) ? v.outcome : "needs_human") === o.key);
        return { ...o, count: hits.length, dollars: hits.reduce((t, v) => t + atStake(v), 0), hits };
      })
      .filter((g) => g.count > 0)
      .sort((a, b) => b.dollars - a.dollars);

    const top = Math.max(1, groups[0].dollars);
    const wrap = node("div", "rank");
    for (const g of groups) {
      const on = store.isFiltered("outcome", g.key);
      const b = node("button", "rank__r" + (on ? " is-on" : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", g.label));
      /*
       * The most common recommended action for the group, so the bar says what to DO and not only
       * how much is stuck. Taken from the records rather than written here, because the decision
       * engine already produced the sentence and two copies of it would drift.
       */
      const actions = new Map();
      for (const v of g.hits) actions.set(v.recommendedAction, (actions.get(v.recommendedAction) ?? 0) + 1);
      const commonest = [...actions.entries()].sort((a, z) => z[1] - a[1])[0]?.[0] ?? "";
      /*
       * The count and the action are two facts, and jamming them into one clamped line cost the
       * reader both. `.rank__sub` clamps at two lines; the engine's recommendation is a full
       * sentence, so prefixing it with "1 patient · " spent the first third of the first line on
       * the count and then guillotined the sentence mid-word — "…the payer reports this coverage as
       * not…" — which is not a shortened action, it is an unreadable one. Two lines of a sentence is
       * enough to act on; two lines minus a prefix was not.
       *
       * The count moves next to the money, where the other ranked lists on this screen already put
       * their counts, and the sentence gets the sub-line to itself.
       */
      name.append(node("span", "rank__sub", commonest));
      b.append(name);

      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
      svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 0, width: Math.max(0.8, (g.dollars / top) * 100), height: 4 }));
      track.append(svg);
      const value = node("span", "rank__v rank__v--stack");
      value.append(node("span", "", usdExact(g.dollars)));
      value.append(
        node("span", "rank__vsub", `${g.count} ${g.count === 1 ? "patient" : "patients"}`)
      );
      b.append(track, value);
      b.addEventListener("click", () => store.toggleFilter({ dim: "outcome", value: g.key, label: g.label }));
      wrap.append(b);
    }
    gapsHost.append(wrap);
  }

  /**
   * Payers, ranked by money checked, each showing how much of it actually came back confirmed.
   *
   * This is the closest honest thing to §8.2's response-time distribution: without a latency the
   * screen cannot say which payers are slow, but it can say which ones ANSWER — and a payer that
   * returns a 271 with no benefit segments is the one a practice needs a head start with.
   */
  function drawPayers() {
    payersHost.replaceChildren();
    payersHost.append(node("h2", "block2__h", "Which payers answer"));

    const rows = payerPopulation();
    if (rows.length === 0) {
      payersHost.append(node("p", "block2__n", "Nothing has been checked yet."));
      return;
    }

    const byPayer = new Map();
    for (const v of rows) {
      const key = v.payerName ?? "No payer identified";
      const cur = byPayer.get(key) ?? { payer: key, stake: 0, count: 0, confirmed: 0, confirmedStake: 0 };
      cur.stake += atStake(v);
      cur.count += 1;
      if (v.provenance?.benefitsRetrieved) {
        cur.confirmed += 1;
        /* The money behind the confirmed checks, not just how many there were — see the bar. */
        cur.confirmedStake += atStake(v);
      }
      byPayer.set(key, cur);
    }
    const list = [...byPayer.values()].sort((a, b) => b.stake - a.stake);

    payersHost.append(
      node("p", "block2__n",
        "Treatment money checked per payer. The dark part of each bar is the money whose benefits actually came back.")
    );

    const top = Math.max(1, list[0].stake);
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
          `${p.count} ${p.count === 1 ? "check" : "checks"} · ${p.confirmed} came back with benefits`)
      );
      b.append(name);

      /*
       * ── WHAT THIS BAR USED TO DRAW, AND WHY IT COULD NOT BE READ ─────────────────────────────
       * The bar's width was money — this payer's stake against the biggest payer's. The marker beside
       * it was `confirmed / count`, a ratio of CHECKS, plotted on that same 0–100 axis. Two different
       * quantities sharing one ruler, and the arithmetic gave it away: every payer who confirmed all
       * of its checks put the marker at 100, i.e. hard right, regardless of its own bar. At 1280 four
       * of the five payers had their marker stranded in white space past the end of their bar, all at
       * the same x, looking like a broken column rule rather than a reading. The sentence above the
       * list called it "that payer's confirmed share", which is what it was measuring but not where
       * it was pointing.
       *
       * A share of a bar belongs INSIDE the bar. Same axis, same units, part against whole: the
       * confirmed money is drawn over the total in a heavier value, so "most of this came back" is
       * one glance and needs no key. §1.1's ramp runs light→dark, so weight is the emphasis channel
       * here and no second hue enters the screen.
       */
      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 8", preserveAspectRatio: "none", "aria-hidden": "true" });
      const full = Math.max(0.8, (p.stake / top) * 100);
      svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 2, width: full, height: 4 }));
      if (p.confirmedStake > 0) {
        svg.append(
          svgEl("rect", {
            class: "rank__seg",
            x: 0,
            y: 2,
            /* Never wider than the bar it sits in, even if rounding would push it over. */
            width: Math.min(full, (p.confirmedStake / top) * 100),
            height: 4,
          })
        );
      }
      track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(p.stake)));
      b.addEventListener("click", () => store.toggleFilter({ dim: "payer", value: p.payer, label: `Payer: ${p.payer}` }));
      wrap.append(b);
    }
    payersHost.append(wrap);
  }

  function drawTable() {
    table.update(visible(), {
      emptyMessage: store.narrowed() ? "No verifications match this selection." : "Nothing has been verified yet.",
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
          what: "Verifications could not be loaded.",
          shows: "whose coverage has been checked and what came back",
          stakes: "Coverage checks waiting on a person are not visible here.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["Needs a person", "Could not be checked", "Answered with no benefits", "Quoted to patients"], chartHeight: 190 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    drawRangeState();
    drawChips();
    drawSpine();
    drawChart();
    drawGaps();
    drawPayers();
    drawTable();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await Promise.all([loadWithStates(state, fetchAll, drawAll), readiness.reload()]);
  }

  async function fetchAll() {
      const res = await api("GET", "/api/v1/verifications");
      verifications = res.items ?? [];
  }

  const un = store.subscribe(() => drawAll());
  load();

  return {
    reload: load,
    destroy() { retire(state); un(); readiness.destroy(); chart.destroy(); table.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill(entry) {
      if (entry.kind === "verification") return renderVerificationDrill(entry.id, { api });
      return null;
    },
  };
}

/* ══ Drill: the parse, beside the bytes it came from ═════════════════════════════════════════ */
export async function renderVerificationDrill(id, { api }) {
  const wrap = node("div", "dr__sections");
  wrap.append(node("p", "dr__loading", "Loading verification…"));

  let view;
  try {
    view = await api("GET", `/api/v1/verifications/${encodeURIComponent(id)}`);
  } catch (err) {
    wrap.replaceChildren(node("p", "dr__err", `Could not load this verification — ${err.message}`));
    return wrap;
  }

  const r = view.record;
  const b = r.benefits;
  const prov = view.provenance;
  wrap.replaceChildren();

  /* ── Now: what this check concluded, and where it came from ───────────────────────────────── */
  const now = node("section", "dr__s");
  /* "Now" contrasted with nothing — there is no history section under it — and named neither the
     figure nor its subject. The figure is `totalPatientPays`, which is the "Patient pays" column of
     the table the reader clicked to get here, so it says that. */
  now.append(node("div", "dr__k", "Patient pays"));
  now.append(node("div", "dr__fig", r.calculation ? usdExact(r.calculation.totalPatientPays) : "—"));
  now.append(
    node("p", "dr__p",
      r.calculation
        ? "is what this patient would be told they owe"
        : "No estimate could be produced, so there is nothing to quote.")
  );
  now.append(node("p", "dr__p dr__p--muted", view.decision?.recommendedAction ?? ""));

  /*
   * Provenance is stated before any figure is read, not after. Every number below inherits its
   * trustworthiness from this one line, and a reader who sees the benefits first has already
   * believed them.
   */
  const pv = node("p", "dr__p" + (prov?.benefitsRetrieved ? " dr__p--muted" : ""));
  pv.textContent = `${prov?.label ?? "UNKNOWN SOURCE"} — ${prov?.explanation ?? ""}`;
  now.append(pv);
  if (prov?.benefitsNote) now.append(node("p", "dr__p dr__p--muted", prov.benefitsNote));
  wrap.append(now);

  /* ── Benefit utilisation, as bullets against their real contracted targets (§8.2) ─────────── */
  if (b) {
    const util = node("section", "dr__s");
    util.append(node("div", "dr__k", "How much of the plan is left"));

    const bullet = (label, used, total, tone) => {
      if (!Number.isFinite(total) || total <= 0) return;
      const row = node("div", "bul");
      row.append(node("span", "bul__l", label));
      const track = node("span", "bul__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 6", preserveAspectRatio: "none", "aria-hidden": "true" });
      svg.append(svgEl("rect", { class: "bul__bg", x: 0, y: 1, width: 100, height: 4 }));
      const pct = Math.max(0, Math.min(100, (used / total) * 100));
      svg.append(svgEl("rect", { class: "bul__f" + (tone ? ` is-${tone}` : ""), x: 0, y: 1, width: pct, height: 4 }));
      /* The target marker: the contracted value the bar is measured against, per §8.2. */
      svg.append(svgEl("rect", { class: "bul__mark", x: 99.4, y: 0, width: 0.6, height: 6 }));
      track.append(svg);
      row.append(track);
      row.append(node("span", "bul__v", `${usdExact(total - used)} left`));
      util.append(row);
    };

    if (b.annualMaximum) {
      const nearlyGone = b.annualMaximum.remaining <= b.annualMaximum.amount * 0.1;
      bullet("Annual maximum", b.annualMaximum.used, b.annualMaximum.amount, nearlyGone ? "warning" : null);
    }
    if (b.deductible) {
      const met = (b.deductible.individualAnnual ?? 0) - (b.deductible.remaining ?? 0);
      bullet("Deductible", met, b.deductible.individualAnnual, null);
    }
    for (const f of b.frequencyLimits ?? []) {
      const row = node("p", "dr__p dr__p--muted");
      row.textContent = `${f.description} Used ${f.used} of ${f.limit} this ${String(f.period).replace(/-/g, " ")}.`;
      util.append(row);
    }
    for (const w of b.waitingPeriods ?? []) {
      util.append(node("p", "dr__p", typeof w === "string" ? w : (w.description ?? JSON.stringify(w))));
    }
    wrap.append(util);
  }

  /* ── What the plan pays, by category ──────────────────────────────────────────────────────── */
  if (b?.coveragePercentages) {
    const cov = node("section", "dr__s");
    cov.append(node("div", "dr__k", "What the plan pays"));
    const dl = node("dl", "dr__dl");
    for (const [cat, pct] of Object.entries(b.coveragePercentages)) {
      dl.append(node("dt", "", cat.charAt(0).toUpperCase() + cat.slice(1)), node("dd", "", `${pct}%`));
    }
    cov.append(dl);
    if ((b.excludedCodes ?? []).length) {
      cov.append(node("p", "dr__p dr__p--muted", `Not covered: ${b.excludedCodes.join(", ")}`));
    }
    wrap.append(cov);
  }

  /* ── Exceptions: what the engine flagged for a person ─────────────────────────────────────── */
  if ((r.exceptions ?? []).length) {
    const ex = node("section", "dr__s");
    /* The same word as the column that counts these. Renaming the column to "Problems" and leaving
       the drill saying "Flags" would have split one concept across two names in the two places a
       reader meets it in sequence — click a row reading "Problems 3" and land on a panel headed
       "Flags", and the obvious inference is that they are different things. */
    ex.append(node("div", "dr__k", "Problems"));
    for (const e of r.exceptions) {
      const p = node("p", e.severity === "critical" ? "dr__p" : "dr__p dr__p--muted");
      p.textContent = e.message ?? `${e.code}`;
      ex.append(p);
    }
    wrap.append(ex);
  }

  /* ── What the card said, and how sure the reader was of each field ────────────────────────── */
  const card = node("section", "dr__s");
  card.append(node("div", "dr__k", "What was read off the card"));
  const fields = Object.entries(r.card ?? {}).filter(([, f]) => f && typeof f === "object" && "value" in f);
  for (const [name, f] of fields) {
    const row = node("div", "fld");
    row.append(node("span", "fld__n", name.replace(/([A-Z])/g, " $1").toLowerCase()));
    row.append(node("span", "fld__v" + (f.value === null ? " is-empty" : ""), f.value ?? "not found"));
    /*
     * The confidence AND the reason for it. A bare "0.92" is a number nobody can check; "Found a
     * labeled member ID" is a claim a person can look at the card and agree or disagree with.
     */
    row.append(node("span", "fld__c", `${Math.round((f.confidence ?? 0) * 100)}% · ${f.explanation ?? ""}`));
    card.append(row);
  }
  wrap.append(card);

  /*
   * ── THE PAYER'S OWN BYTES ───────────────────────────────────────────────────────────────────
   * §8.2 calls this a core trust feature and asks for the parsed fields highlighted against the
   * source segments. The highlighting is not built — a 271 segment does not carry a pointer to the
   * field it produced, so drawing a line between them would mean re-implementing the parser in the
   * browser and asserting that the second implementation agrees with the first. Two parsers that
   * disagree is a worse failure than no highlighting, because the highlight would look authoritative.
   *
   * What IS here is the whole response, segment per line, beside the parse above it — so a person
   * checking the machine's work has both halves in one panel and can read the EB segments directly.
   * The remaining step is a parser that records which segment each field came from, and that is a
   * change to the codec rather than to this screen.
   */
  if (r.raw271) {
    const raw = node("section", "dr__s");
    raw.append(node("div", "dr__k", "The payer's answer, as it arrived"));
    raw.append(
      node("p", "dr__p dr__p--muted",
        `${prov?.raw271Bytes ?? r.raw271.length} bytes of 271, one segment per line. Everything above was read out of this.`)
    );
    const pre = node("pre", "dr__pre", String(r.raw271).split("~").filter(Boolean).join("~\n"));
    raw.append(pre);
    wrap.append(raw);
  } else {
    const raw = node("section", "dr__s");
    raw.append(node("div", "dr__k", "The payer's answer"));
    raw.append(node("p", "dr__p", "No 271 was stored for this check, so the parse above cannot be audited against a source."));
    wrap.append(raw);
  }

  return wrap;
}
