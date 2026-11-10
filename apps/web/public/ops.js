/**
 * Ops — the machine watching itself (spec §8.8).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "Is the machine keeping up, what needs a human, and where is the automation failing?"
 *
 * Three audiences read this screen and they want the same thing: the practice, asking whether the
 * thing they pay for is working; whoever operates the deployment, asking what is about to break;
 * and a compliance review, asking who did what to which record. §8.8 is explicit that the audit log
 * is "a compliance requirement, not a nice-to-have", and that it lives here.
 *
 * ── THE COLUMN THAT MAKES THE QUEUE BOARD WORTH HAVING ───────────────────────────────────────────
 * §8.8 says it outright and it is the single best sentence in the specification: "a backlog of 400
 * items is meaningless; a backlog holding $312K is a crisis." Every queue row therefore carries the
 * money it is holding, and the board is ordered by that and not by depth.
 *
 * ── WHAT THE THROUGHPUT CHART IS ACTUALLY DRAWN FROM ─────────────────────────────────────────────
 * §8.8 asks for items entering versus items cleared, per queue, so a backlog reads as a widening
 * band. Mermaid instruments exactly one queue with both timestamps: the domain-event outbox, which
 * records when each event occurred and when it was delivered. That is the machine's own throughput
 * — every cross-module effect in this product passes through it — so the chart is drawn from it and
 * says so, rather than approximating the same shape for six queues that keep no such history.
 *
 * ── WHAT IS NOT DRAWN ────────────────────────────────────────────────────────────────────────────
 * The per-queue automation rate as small multiples. The outbox can say how often the machine
 * succeeded first time, and that is drawn — but "resolved without human touch, per queue" needs each
 * queue to record whether a person touched an item, and none of them does. One honest number is
 * better than seven sparklines of a quantity nobody measured.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { errorBlock, freshnessTag, load as loadWithStates, poll, restoreLayout, retire, stageSkeleton } from "./states.js";

const usd = (cents) => {
  const v = Number(cents ?? 0) / 100;
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};
const usdExact = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}$${s}`;
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
const HOUR = 3600000;

const elapsed = (iso, nowMs) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
};
/** An age a person can act on: minutes, then hours, then days. Never a bare millisecond count. */
function humanAge(ms) {
  if (ms === null) return "—";
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

/**
 * The human work queues, in the order the revenue cycle runs.
 *
 * Each is a slice of the ONE unified queue the server already composes — `/api/v1/today` ranks
 * everything a person must act on, across every module, by what it is worth. Re-deriving the same
 * queues from six list endpoints would produce a second opinion about the practice's backlog, and
 * two backlogs that disagree is worse than either.
 */
const QUEUES = [
  { kind: "verification", label: "Verification", note: "coverage checked, waiting on a person" },
  { kind: "claim", label: "Claims", note: "built, and not yet released to a payer" },
  { kind: "remittance", label: "Posting", note: "money in the bank, not yet posted" },
  { kind: "denial", label: "Denials", note: "refused, and worth appealing" },
  { kind: "patient", label: "Patient billing", note: "a balance a person must decide to bill" },
  { kind: "era", label: "ERA intake", note: "a payer file that could not be read" },
];

/** The stack of the throughput chart, bottom-up: settled at the bottom, trouble on top. */
const FLOW = [
  { key: "delivered", label: "Delivered" },
  { key: "pending", label: "Still pending" },
  { key: "dead", label: "Dead-lettered", tone: "critical" },
];

/**
 * @param {object} deps
 * @param {{label: string, note: string, run: () => void}[]} [deps.extras]
 *   Admin surfaces this deployment has that this screen has NOT rebuilt — contracted rates, staff.
 *   They are passed in rather than reached for, because the dependency runs one way: the shell knows
 *   about the screens, and a screen must not reach back into the shell to call one of its renderers.
 *   Listing them here is also the honest thing: they exist, they work, and they are still on the old
 *   surface, which is a fact an operator should be able to see rather than discover.
 */
export function mountOps(stage, { store, api, extras = [] }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  let now = Date.now();

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "Is the machine keeping up");
  const stamp = node("div", "scr__stamp");
  header.append(question, stamp);

  const spineHost = node("div", "");
  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  const queuesHost = node("section", "block2");
  const healthHost = node("section", "block2");
  const exceptionsHost = node("section", "block2");
  const row1 = node("div", "grid2");
  row1.append(queuesHost, healthHost);

  const auditHost = node("section", "block2");
  const auditTableHost = node("div", "");

  stage.append(
    header, spineHost, vizHost, row1, exceptionsHost,
    node("div", "scr__rule"), auditHost, auditTableHost
  );

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let board = null;      /* the unified work queue + the practice's money position */
  let outbox = null;     /* the machine's own queue */
  let monitors = null;   /* the SLA checks */
  let audit = [];        /* who did what, to which record */
  let auditFilter = "all";
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const chart = createChart(chartHost, {
    store,
    mark: "band",
    height: 180,
    series: FLOW,
    format: (v) => `${Math.round(v)}`,
    bucketOf: (p) => p.bucket,
    label: "Domain events per day, by how they ended up",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  /**
   * The audit log. §8.8 requires it filterable; it is deliberately NOT drillable, because an audit
   * entry is the record of an act and not a handle on the thing acted upon — opening the entity from
   * here would invite editing a record while reading its own history.
   */
  const auditTable = createTable(auditTableHost, {
    rowKey: (a) => String(a.id),
    rowHeight: 32,
    empty: "No audit entries.",
    columns: [
      { key: "when", label: "When", type: "date", get: (a) => humanAge(elapsed(a.created_at, now)) + " ago", value: (a) => a.created_at, width: "104px" },
      { key: "actor", label: "Who", type: "entity", get: (a) => String(a.actor_role ?? "system").replace(/_/g, " ") },
      { key: "action", label: "Did", type: "entity", get: (a) => String(a.action).replace(/_/g, " ") },
      { key: "resource", label: "To", type: "entity", get: (a) => a.resource },
      { key: "ref", label: "Which", type: "mono", get: (a) => a.resource_id ?? "—", width: "220px" },
      { key: "outcome", label: "Result", type: "status", get: (a) => a.outcome, width: "96px" },
    ],
  });

  /* ── The spine: four questions an operator actually has ───────────────────────────────────── */
  function drawSpine() {
    const items = board?.items ?? [];
    const backlogMoney = items.reduce((t, i) => t + (i.amount ?? 0), 0);
    const oldest = items
      .map((i) => elapsed(i.dueDate ?? null, now))
      .filter((v) => v !== null);
    const b = outbox?.backlog ?? {};
    const firing = (monitors?.checks ?? []).filter((c) => !c.ok);

    /* Delivered without a retry: the machine got it right the first time. */
    const recent = outbox?.recent ?? [];
    const clean = recent.filter((e) => e.status === "delivered" && (e.attempts ?? 1) <= 1).length;
    const rate = recent.length ? (clean / recent.length) * 100 : null;

    spine.update([
      {
        key: "held",
        label: "Backlog holding",
        value: backlogMoney,
        format: (v) => usd(v),
        display: usd(backlogMoney),
        zero: backlogMoney === 0,
        delta: null,
        series: [],
        /* §8.8's own sentence: depth is meaningless, dollars are the crisis. */
        basis: `${items.length} ${items.length === 1 ? "item" : "items"} waiting on a person`,
        tone: backlogMoney > 0 ? "warning" : null,
      },
      {
        key: "events",
        label: "Events undelivered",
        value: Number(b.pending ?? 0),
        format: (v) => String(Math.round(v)),
        display: String(b.pending ?? 0),
        zero: (b.pending ?? 0) === 0,
        delta: null,
        series: [],
        basis: b.oldestPending
          ? `oldest waiting ${humanAge(elapsed(b.oldestPending, now))}`
          : "the outbox is empty",
        tone: (b.pending ?? 0) > 0 ? "warning" : null,
      },
      {
        key: "dead",
        label: "Dead-lettered",
        value: Number(b.dead ?? 0),
        format: (v) => String(Math.round(v)),
        display: String(b.dead ?? 0),
        zero: (b.dead ?? 0) === 0,
        delta: null,
        series: [],
        basis: (b.dead ?? 0) === 0 ? "nothing has given up" : "these effects never happened",
        tone: (b.dead ?? 0) > 0 ? "critical" : null,
      },
      {
        key: "first",
        label: "Right first time",
        ...(rate === null ? {} : { value: rate, format: (v) => `${v.toFixed(0)}%` }),
        display: rate === null ? "—" : `${rate.toFixed(0)}%`,
        zero: false,
        delta: null,
        series: [],
        /*
         * Stated exactly, because it is NOT the spec's per-queue automation rate. It is the share of
         * recent events the outbox delivered without a retry — the one automation measure this
         * system genuinely records.
         */
        basis:
          rate === null
            ? "no events to judge"
            : `of the last ${recent.length} events, delivered without a retry`,
        tone: rate !== null && rate < 95 ? "warning" : null,
      },
    ], { basis: "ops:now" });

    /* The header states what is firing, because a monitor nobody reads is not a monitor. */
    stamp.replaceChildren();
    stamp.append(
      node("span", "scr__stamp-t",
        firing.length === 0
          ? `All ${(monitors?.checks ?? []).length} checks passing.`
          : `${firing.length} of ${(monitors?.checks ?? []).length} checks firing.`)
    );
    if (oldest.length) stamp.append(node("span", "scr__stamp-a", `oldest deadline ${humanAge(Math.max(...oldest))} away`));
    /* How current this reading itself is — on the screen that reports whether things are current. */
    if (board?.generatedAt) stamp.append(freshnessTag(board.generatedAt, now));
  }

  /**
   * Throughput: events per day, stacked by how they ended up.
   *
   * An event is placed on the day it OCCURRED, not the day it was delivered — the question is
   * whether the machine kept up with what happened, and bucketing by delivery would hide exactly
   * the lag being looked for by moving late work into the day it was finally done.
   */
  function drawChart() {
    const recent = outbox?.recent ?? [];
    vizTitle.textContent = "What the machine was asked to do, and whether it did it";

    if (recent.length === 0) {
      chart.update([], { insufficient: "The outbox has handled nothing yet. The throughput picture appears with the first event." });
      return;
    }

    const byDay = new Map();
    for (const e of recent) {
      const day = String(e.occurredAt ?? "").slice(0, 10);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, { delivered: 0, pending: 0, dead: 0 });
      const slot = byDay.get(day);
      if (e.deadLettered) slot.dead += 1;
      else if (e.status === "delivered" || e.publishedAt) slot.delivered += 1;
      else slot.pending += 1;
    }

    const days = [...byDay.keys()].sort();
    if (days.length < 2) {
      chart.update([], {
        insufficient: days.length === 1
          ? `Every event the outbox holds occurred on one day (${days[0]}). Throughput needs more than one day to have a shape.`
          : "No event carries a date the throughput chart can place it on.",
      });
      return;
    }

    /* Every day between the first and last, so a silent stretch reads as one rather than closing up. */
    const first = Date.parse(`${days[0]}T00:00:00.000Z`);
    const last = Date.parse(`${days[days.length - 1]}T00:00:00.000Z`);
    const points = [];
    for (let t = first; t <= last; t += DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const slot = byDay.get(iso) ?? { delivered: 0, pending: 0, dead: 0 };
      const total = slot.delivered + slot.pending + slot.dead;
      points.push({
        at: iso, bucket: iso,
        label: new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        tick: new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        parts: slot,
        note: total === 0 ? "nothing happened" : `${total} ${total === 1 ? "event" : "events"}`,
      });
    }
    chart.update(points, { series: FLOW });
    chart.setNote(
      `The last ${recent.length} domain events, placed on the day they occurred rather than the day they were delivered — ` +
        "bucketing by delivery would hide the very lag this chart exists to show."
    );
    chart.setProvenance({
      definition:
        "Domain events the outbox handled, placed on the day they OCCURRED rather than the day they were delivered, split by how each ended up.",
      range: days.length ? `${days[0]} to ${days[days.length - 1]}` : "no events",
      records: recent.length,
      sources: "Mermaid domain-event outbox",
    });
  }

  /**
   * The queue depth board — ordered by the money each queue is holding, never by depth.
   *
   * The outbox is listed alongside the human queues and marked as the machine's own, because an
   * operator looking for "what is stuck" should not have to know which queues have people in them.
   */
  function drawQueues() {
    queuesHost.replaceChildren();
    queuesHost.append(node("h2", "block2__h", "What each queue is holding"));
    queuesHost.append(
      node("p", "block2__n",
        "Ordered by money, not by depth: a backlog of four hundred items means nothing, and a backlog holding six figures is the whole job.")
    );

    const items = board?.items ?? [];
    const rows = QUEUES.map((q) => {
      const mine = items.filter((i) => i.kind === q.kind);
      const oldestDue = mine.map((i) => (i.dueDate ? Date.parse(i.dueDate) : null)).filter((v) => v !== null);
      return {
        ...q,
        depth: mine.length,
        dollars: mine.reduce((t, i) => t + (i.amount ?? 0), 0),
        urgent: mine.filter((i) => i.urgent).length,
        /* The nearest deadline in the queue, which is what decides whether depth matters today. */
        nextDue: oldestDue.length ? Math.min(...oldestDue) : null,
      };
    }).filter((r) => r.depth > 0);

    const b = outbox?.backlog ?? {};
    const machine = {
      kind: "outbox", label: "Domain events", note: "the machine's own queue — no person is in it",
      depth: (b.pending ?? 0) + (b.dead ?? 0),
      dollars: null,
      urgent: b.dead ?? 0,
      nextDue: null,
      oldestAge: b.oldestPending ? elapsed(b.oldestPending, now) : null,
    };

    const all = [...rows].sort((a, z) => z.dollars - a.dollars);
    if (machine.depth > 0) all.push(machine);

    if (all.length === 0) {
      queuesHost.append(node("p", "empty2", "Every queue is empty. Nothing is waiting on a person or on the machine."));
      return;
    }

    const top = Math.max(1, ...all.map((r) => r.dollars ?? 0));
    const wrap = node("div", "rank");
    for (const r of all) {
      const isMachine = r.kind === "outbox";
      const b2 = node("button", "rank__r");
      b2.type = "button";
      b2.disabled = isMachine;
      if (!isMachine) {
        b2.setAttribute("aria-label", `${r.label}: ${r.depth} items holding ${usdExact(r.dollars)}`);
        /* Opens the screen that owns this queue rather than a copy of it living here. */
        const TAB = { verification: "verifications", claim: "claims", remittance: "money", denial: "recovery", patient: "patients" };
        const tab = TAB[r.kind];
        if (tab) b2.addEventListener("click", () => document.querySelector(`.tab[data-tab="${tab}"]`)?.click());
        else b2.disabled = true;
      }

      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", r.label));
      const bits = [`${r.depth} ${r.depth === 1 ? "item" : "items"}`];
      if (r.urgent) bits.push(`${r.urgent} urgent`);
      if (isMachine && r.oldestAge !== null) bits.push(`oldest ${humanAge(r.oldestAge)}`);
      if (!isMachine && r.nextDue !== null) bits.push(`next deadline ${humanAge(Math.max(0, r.nextDue - now))} away`);
      bits.push(r.note);
      name.append(node("span", "rank__sub", bits.join(" · ")));
      b2.append(name);

      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
      if (r.dollars !== null) {
        svg.append(svgEl("rect", { class: "rank__f" + (r.urgent ? " is-warning" : ""), x: 0, y: 0, width: Math.max(0.8, (r.dollars / top) * 100), height: 4 }));
      }
      track.append(svg);
      /*
       * The machine's queue holds no money, and reports that rather than $0.00 — a zero here would
       * say the outbox is holding nothing valuable, when what is true is that dollars are not the
       * unit it is measured in.
       */
      b2.append(track, node("span", "rank__v" + (r.dollars === null ? " is-na" : ""), r.dollars === null ? "—" : usdExact(r.dollars)));
      wrap.append(b2);
    }
    queuesHost.append(wrap);
  }

  /** The integration health strip: every monitor, its verdict, and the numbers behind it. */
  function drawHealth() {
    healthHost.replaceChildren();
    healthHost.append(node("h2", "block2__h", "What the monitors say"));

    /**
     * ── THE ADMIN LINKS ARE DRAWN FIRST, BECAUSE THEY DO NOT DEPEND ON A MONITOR ───────────────
     *
     * This block used to sit at the BOTTOM of this function, below an early return taken whenever
     * `monitors` had not reported. The comment on it said "named, not hidden" — and they were
     * hidden, by every condition that makes a health check absent: a monitors endpoint that is down,
     * a first paint before it has answered, and (once the health read moved out of the blocking
     * fetch) simply the minute it takes on a real practice's data.
     *
     * So Contracted rates, Staff and Payment sources — three admin surfaces reachable from nowhere
     * else in the product — disappeared exactly when an operator was most likely to be on this
     * screen. Nothing about them has anything to do with what the monitors say.
     */
    if (extras.length) {
      const more = node("div", "hc__more");
      more.append(node("h3", "tri__t2", "Not yet rebuilt"));
      more.append(node("p", "block2__n", "These work, and still live on the previous surface."));
      const links = node("div", "hc__links");
      for (const x of extras) {
        const b2 = node("button", "tri__link", `${x.label} →`);
        b2.type = "button";
        if (x.note) b2.title = x.note;
        b2.addEventListener("click", x.run);
        links.append(b2);
      }
      more.append(links);
      healthHost.append(more);
    }

    const checks = monitors?.checks ?? [];
    if (checks.length === 0) {
      /* Not "all healthy" and not an error: the reading has not arrived, or could not be taken. The
         distinction matters on the one screen whose job is to say whether the machine is working. */
      healthHost.append(node("p", "empty2", "Checking the monitors…"));
      return;
    }
    healthHost.append(
      node("p", "block2__n", "Every check this deployment runs, failing ones first. The detail is the monitor's own reading, not a restatement of it.")
    );

    /*
     * ── A READING IS A NUMBER PLUS ITS UNIT, AND THE UNIT LIVES IN THE KEY ─────────────────────
     * These lines are the monitor's own numbers, shown rather than summarised, and the renderer is
     * generic on purpose — a monitor added tomorrow gets its detail printed without touching this
     * screen. What it used to be was generic about the UNITS too, and printed:
     *
     *     threshold ms 259,200,000        held remittance age, i.e. three days
     *     amount posted 151,297           $1,512.97
     *
     * Nobody converts 259 million milliseconds in their head, and "amount posted 151,297" reads as
     * a hundred and fifty-one thousand of something on a screen where every other figure is
     * dollars. Both numbers were correct and neither was legible, which on an operations screen is
     * the same as being wrong: the reader either mis-reads it or skips it.
     *
     * So the key declares the unit and the renderer honours it — `…Ms` is a duration, `…Cents` is
     * money — and the suffix drops out of the label, because "threshold 3d" already says what
     * "threshold ms" was there to say.
     */
    const duration = (ms) => {
      const n = Number(ms);
      if (!Number.isFinite(n)) return String(ms);
      const abs = Math.abs(n);
      /* One decimal only near a boundary, so "5m" stays "5m" and 90s does not become "2m". */
      const at = (per, unit, dp) => `${Number((n / per).toFixed(dp))}${unit}`;
      if (abs < 1000) return `${n}ms`;
      if (abs < 60_000) return at(1000, "s", abs < 10_000 ? 1 : 0);
      if (abs < 3_600_000) return at(60_000, "m", abs < 600_000 ? 1 : 0);
      if (abs < 86_400_000) return at(3_600_000, "h", 1);
      return at(86_400_000, "d", 1);
    };

    const readingOf = (key, value) => {
      /* `examples` is a list of offending records, not a reading. Inline it renders as a dangling
         word with nothing after it; it belongs in the drill, and until it is there it is omitted
         rather than printed as a label with no value. */
      if (value === null || value === undefined || typeof value === "object") return "";
      const label = (k) => k.replace(/([A-Z])/g, " $1").toLowerCase().trim();
      if (typeof value === "number") {
        if (/Cents$/.test(key)) return `${label(key.replace(/Cents$/, ""))} ${usdExact(value)}`;
        if (/Ms$/.test(key)) return `${label(key.replace(/Ms$/, ""))} ${duration(value)}`;
        return `${label(key)} ${value.toLocaleString("en-US")}`;
      }
      return `${label(key)} ${String(value)}`;
    };

    const list = node("div", "hc");
    for (const c of [...checks].sort((a, z) => Number(a.ok) - Number(z.ok))) {
      const rowEl = node("div", "hc__r");
      rowEl.append(node("span", "hc__dot" + (c.ok ? " is-ok" : " is-bad")));
      const body = node("span", "hc__b");
      body.append(node("span", "hc__k", String(c.key).replace(/[._]/g, " ")));
      body.append(node("span", "hc__m", c.message));
      /*
       * The monitor's own numbers, shown rather than summarised. An operator diagnosing a lag needs
       * the threshold it was measured against, and a screen that paraphrases them loses exactly that.
       */
      if (c.detail && typeof c.detail === "object") {
        const detail = Object.entries(c.detail)
          .map(([k, v]) => readingOf(k, v))
          .filter(Boolean)
          .join(" · ");
        if (detail) body.append(node("span", "hc__d", detail));
      }
      rowEl.append(body);
      list.append(rowEl);
    }
    healthHost.append(list);

  }

  /**
   * Why automation handed work to a person, ranked by the money each reason is holding.
   *
   * §8.8 calls this "the product's own improvement backlog, made visible to the customer", which is
   * exactly right: every row here is a case the machine could not finish, and the dollars say which
   * one is worth engineering away first.
   */
  function drawExceptions() {
    exceptionsHost.replaceChildren();
    exceptionsHost.append(node("h2", "block2__h", "Why the machine handed it to a person"));

    const items = board?.items ?? [];
    if (items.length === 0) {
      exceptionsHost.append(node("p", "empty2", "Nothing was handed over. The machine finished everything it was given."));
      return;
    }
    exceptionsHost.append(
      node("p", "block2__n",
        "Each reason the automation stopped, with the money it is holding up. This is the product's own improvement backlog: the top row is what is worth engineering away first.")
    );

    const byReason = new Map();
    for (const i of items) {
      /* The queue's own sentence, which is the reason — not a category invented on this screen. */
      const reason = i.subtitle ?? "unstated";
      const cur = byReason.get(reason) ?? { reason, count: 0, dollars: 0, kinds: new Set() };
      cur.count += 1;
      cur.dollars += i.amount ?? 0;
      cur.kinds.add(i.kind);
      byReason.set(reason, cur);
    }
    const list = [...byReason.values()].sort((a, z) => z.dollars - a.dollars || z.count - a.count);
    const top = Math.max(1, list[0].dollars);

    const wrap = node("div", "rank");
    for (const r of list) {
      const b2 = node("button", "rank__r");
      b2.type = "button";
      b2.disabled = true;   /* Ranked for reading; the items themselves live on their own screens. */
      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", r.reason));
      name.append(node("span", "rank__sub", `${r.count} ${r.count === 1 ? "item" : "items"} · ${[...r.kinds].join(", ")}`));
      b2.append(name);
      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
      svg.append(svgEl("rect", { class: "rank__f", x: 0, y: 0, width: Math.max(0.8, (r.dollars / top) * 100), height: 4 }));
      track.append(svg);
      b2.append(track, node("span", "rank__v", usdExact(r.dollars)));
      wrap.append(b2);
    }
    exceptionsHost.append(wrap);
  }

  /** The audit log — who or what did what, to which record, when, with what result. */
  function drawAudit() {
    auditHost.replaceChildren();
    auditHost.append(node("h2", "block2__h", "Who did what"));
    auditHost.append(
      node("p", "block2__n",
        `The last ${audit.length} recorded acts, newest first. Every credential change, every release to a payer, every login.`)
    );

    const seg = node("div", "seg seg--sm");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Filter the audit log");
    const FILTERS = [
      { key: "all", label: "Everything", match: () => true },
      /* The two questions a review actually opens this log to ask. */
      { key: "failed", label: "Failures", match: (a) => a.outcome !== "success" },
      { key: "security", label: "Credentials", match: (a) => /login|password|session|credential|user/i.test(`${a.action} ${a.resource}`) },
      { key: "money", label: "Money", match: (a) => /claim|remittance|posting|appeal|denial|charge|bill/i.test(`${a.action} ${a.resource}`) },
    ];
    for (const f of FILTERS) {
      const b2 = node("button", "seg__b" + (auditFilter === f.key ? " is-active" : ""), f.label);
      b2.type = "button";
      b2.setAttribute("aria-pressed", String(auditFilter === f.key));
      b2.addEventListener("click", () => { auditFilter = f.key; drawAudit(); drawAuditTable(); });
      seg.append(b2);
    }
    auditHost.append(seg);
  }

  function drawAuditTable() {
    const FILTERS = {
      all: () => true,
      failed: (a) => a.outcome !== "success",
      security: (a) => /login|password|session|credential|user/i.test(`${a.action} ${a.resource}`),
      money: (a) => /claim|remittance|posting|appeal|denial|charge|bill/i.test(`${a.action} ${a.resource}`),
    };
    const rows = audit.filter(FILTERS[auditFilter] ?? (() => true));
    auditTable.update(rows, {
      emptyMessage:
        auditFilter === "failed"
          ? "Nothing has failed. Every recorded act succeeded."
          : "No audit entries match this filter.",
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
          what: "The operations picture could not be loaded.",
          shows: "whether the machine is keeping up, and who did what",
          stakes: "This is the screen that reports whether the machine is running — treat it as unknown, not healthy.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["Backlog holding", "Events undelivered", "Dead-lettered", "Right first time"], chartHeight: 180 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    now = Date.now();
    drawSpine();
    drawChart();
    drawQueues();
    drawHealth();
    drawExceptions();
    drawAudit();
    drawAuditTable();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
      /*
       * Four independent reads, and a failure in any ONE of them must not blank the other three.
       * This is the screen an operator opens when something is already wrong; a monitors endpoint
       * that is itself down is a reason to show the outbox, not a reason to show nothing.
       */
      const [t, o, a] = await Promise.all([
        api("GET", "/api/v1/today").catch(() => null),
        api("GET", "/api/v1/ops/outbox").catch(() => null),
        api("GET", "/api/v1/ops/audit").catch(() => ({ items: [] })),
      ]);
      board = t;
      outbox = o;
      audit = a?.items ?? [];

      /**
       * ── THE HEALTH BAND ARRIVES LATE, AND THE SCREEN DOES NOT WAIT FOR IT ─────────────────────
       *
       * `/ops/monitors` takes every money reading in the practice: it re-reads each posted advice to
       * compare the payer's own file against what was posted, and each adjudicated claim to compare
       * its copy of a payment against the remittance's. That is the most valuable thing on this
       * screen and the slowest — measured at 58 seconds against a seeded quarter from a laptop, and
       * one to two colocated with the database.
       *
       * It used to sit inside the `Promise.all` above, so the WHOLE screen — the outbox board, the
       * exception queue, the audit trail — waited on the slowest read. An operator opening Ops
       * because something is already wrong got a skeleton for as long as the health check took,
       * which is the opposite of what this screen is for and reads as a hang.
       *
       * So it is started here and awaited nowhere. The other three render immediately; the health
       * band fills in when it lands and redraws in place. `handle.destroyed` is checked because the
       * screen may well have been left before a minute is up — painting then would put Ops back on
       * top of whatever replaced it.
       */
      api("GET", "/api/v1/ops/monitors")
        .then((m) => {
          monitors = m;
          if (!state.destroyed) drawAll();
        })
        .catch(() => {
          /* Left null. `drawHealth` already renders "unknown" for that, which is the honest word:
             not measured is not the same as measured and healthy. */
          monitors = null;
          if (!state.destroyed) drawAll();
        });
  }

  const un = store.subscribe(() => drawAll());

  /*
   * §8.8 calls this "the most live screen in the product", and it is the screen an operator leaves
   * open while something is going wrong. A minute is slow enough to cost nothing and fast enough
   * that a dead-lettered event does not sit unseen through a coffee break.
   */
  const stopPolling = poll(60_000, () => store.get().drill.length === 0, load);

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); stopPolling(); chart.destroy(); auditTable.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill() { return null; },
  };
}
