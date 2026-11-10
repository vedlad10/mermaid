/**
 * Coverage readiness for the next fourteen days — Verify's primary visual (spec §8.2).
 *
 * "Is every patient we are about to treat covered, and where exactly are the gaps?" Each practice
 * day is a column; each column is stacked by readiness, the band needing a person on top. The list
 * beneath is the same visits, defaulting to the ones that are not ready, soonest first.
 *
 * ── HEIGHT IS PRODUCTION WHEN IT CAN BE, AND SAYS SO WHEN IT CANNOT ──────────────────────────────
 * §8.2 weighs a day by scheduled production, "so a day with one big case reads as heavier than a day
 * with four hygiene visits". That is only honest when every visit's planned fee is known: a column
 * built from the fees that happen to be stated would be a partial sum drawn as a whole one. So when
 * any booked visit in the window has no fee, the whole chart switches to counting visits and its
 * title says so. It never mixes the two units in one picture.
 *
 * ── ITS OWN SELECTION ────────────────────────────────────────────────────────────────────────────
 * Verify's lower half is driven by the screen's shared store, keyed by the day a CHECK was made. A
 * click on Thursday here means the day a VISIT happens — a different axis. Writing it to the shared
 * store would filter the verification table to checks made next Thursday, which is none. So this
 * block keeps a store of its own; the only thing it writes to the shared one is the drill.
 *
 * ── TODAY IS RULED AND NAMED ─────────────────────────────────────────────────────────────────────
 * §8.2 marks today with a 1px `--tide` vertical rule, drawn through the centre of today's column
 * (`chart.setRule`). The column's tick also reads "Today": the rule is colour and position, and the
 * word is what survives greyscale and a screen reader.
 */
import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createStore } from "./store.js";
import { maskName } from "./privacy.js";
import { mountImport } from "./schedule-import.js";
import { READINESS_GROUPS, addDays, clockTime, fetchSchedule, readinessTone, readinessWord, scheduleProvenance } from "./schedule.js";

export const HORIZON_DAYS = 14;

const usd = (cents) => `$${(Number(cents ?? 0) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usdExact = (cents) =>
  `$${(Number(cents ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayLabel = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const tickLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** The three ways the list can be read. Defaults to the work, as §8.2 specifies. */
const VIEWS = [
  { key: "attention", label: "Not ready", test: (a) => a.status === "scheduled" && a.readiness?.group !== "verified" },
  { key: "verified", label: "Verified", test: (a) => a.status === "scheduled" && a.readiness?.group === "verified" },
  { key: "all", label: "All visits", test: () => true },
];

/**
 * The fortnight as chart points and a headline, from the schedule alone.
 *
 * Pure, so the two decisions that can be wrong — the unit, and which days exist — are tested
 * without a DOM. Every practice day in the horizon is a point, visits or not: a Saturday with
 * nothing booked is a real empty column, and dropping it would close the gap between Friday and
 * Monday and draw a week that is not the week.
 */
export function readinessPlan(schedule, days = HORIZON_DAYS) {
  const booked = schedule.items.filter((a) => a.status === "scheduled" && a.readiness);
  const unit = booked.length > 0 && booked.every((a) => a.plannedProductionCents !== null) ? "production" : "visits";
  const weight = (a) => (unit === "production" ? a.plannedProductionCents : 1);

  const points = [];
  for (let k = 0; k < days; k++) {
    const day = addDays(schedule.today, k);
    const parts = Object.fromEntries(READINESS_GROUPS.map((g) => [g.key, 0]));
    const onDay = booked.filter((a) => a.day === day);
    for (const a of onDay) parts[a.readiness.group] += weight(a);
    points.push({
      at: day,
      bucket: day,
      label: k === 0 ? `Today, ${dayLabel(day)}` : dayLabel(day),
      tick: k === 0 ? "Today" : tickLabel(day),
      parts,
      note: onDay.length === 0 ? "nothing booked" : `${onDay.length} ${onDay.length === 1 ? "visit" : "visits"}`,
    });
  }

  const open = booked.filter((a) => a.readiness.group !== "verified");
  return {
    unit,
    points,
    booked: booked.length,
    notReady: open.length,
    notReadyWeight: open.reduce((t, a) => t + weight(a), 0),
    totalWeight: booked.reduce((t, a) => t + weight(a), 0),
  };
}

/**
 * The preview's sentence and button label. Pure, so the counting — patients, not visits, because
 * one person with two visits is one request — is tested without a DOM.
 */
export function duePreviewSummary(due) {
  const checkVisits = due.visits.filter((v) => v.will === "check").length;
  const skipped = due.visits.length - checkVisits;
  const people = (n) => `${n} ${n === 1 ? "patient" : "patients"}`;
  const visits = (n) => `${n} ${n === 1 ? "visit" : "visits"}`;
  if (due.visits.length === 0) {
    return { checks: 0, sentence: "Nothing is due for a check. Every booked visit in that window is verified.", button: null };
  }
  const parts = [];
  if (due.checks > 0) {
    parts.push(`${people(due.checks)} can be checked now, covering ${visits(checkVisits)}.`);
    if (due.checks > due.maxPatients) parts.push(`One run checks the first ${due.maxPatients}; run again for the rest.`);
  } else {
    parts.push("Nothing here can be checked automatically.");
  }
  if (skipped > 0) parts.push(`${visits(skipped)} ${skipped === 1 ? "needs" : "need"} a person instead — the reason is beside each.`);
  const n = Math.min(due.checks, due.maxPatients);
  return { checks: due.checks, sentence: parts.join(" "), button: due.checks > 0 ? `Check ${people(n)} now` : null };
}

/** What a run did, in one sentence: sent, answered, and what did not happen. */
export function dueRunSummary(run) {
  const checked = run.results.filter((r) => r.outcome === "checked");
  const ready = checked.filter((r) => r.readiness?.group === "verified").length;
  const errors = run.results.filter((r) => r.outcome === "error").length;
  const notRun = run.results.filter((r) => r.outcome === "not-run").length;
  const parts = [`Checked ${run.checked} ${run.checked === 1 ? "patient" : "patients"}.`];
  if (checked.length > 0) parts.push(`${ready} of ${checked.length} ${checked.length === 1 ? "visit is" : "visits are"} now ready.`);
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "visit" : "visits"} could not be checked.`);
  if (notRun > 0) parts.push(`${notRun} ${notRun === 1 ? "visit was" : "visits were"} not run.`);
  return parts.join(" ");
}

export function mountReadiness(host, { api, store, onChanged = null }) {
  host.replaceChildren();
  host.classList.add("ready");

  const head = node("div", "ready__head");
  const figWrap = node("div", "ready__sig");
  const fig = node("div", "ready__fig");
  const basis = node("p", "ready__basis");
  figWrap.append(fig, basis);
  const src = node("span", "ready__src");
  head.append(figWrap, src);
  /* The way schedule data gets IN (stage 4): its own full-width row, because its preview is a form. */
  const importHost = node("div", "");

  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");

  const listHead = node("div", "ready__lh");
  const viewGroup = node("div", "seg seg--sm");
  viewGroup.setAttribute("role", "group");
  viewGroup.setAttribute("aria-label", "Which visits to list");
  const dayChip = node("div", "fchips");
  listHead.append(viewGroup, dayChip);
  const tableHost = node("div", "");

  const dueHost = node("div", "due");
  dueHost.setAttribute("aria-live", "polite");

  host.append(head, importHost, vizTitle, chartHost, dueHost, listHead, tableHost);

  const local = createStore();
  let schedule = null;
  let failed = null;
  let view = "attention";
  let unit = null;
  let chart = null;
  /* "Verify all due": the preview, the last run in this sitting, and whether one is running. */
  let due = null;
  let dueError = null;
  let lastRun = null;
  let runError = null;
  let running = false;

  const buildChart = (nextUnit) => {
    if (chart && unit === nextUnit) return;
    chart?.destroy();
    unit = nextUnit;
    chart = createChart(chartHost, {
      store: local,
      mark: "band",
      height: 170,
      series: READINESS_GROUPS,
      format: unit === "production" ? (v) => usd(v) : (v) => `${v} ${v === 1 ? "visit" : "visits"}`,
      bucketOf: (p) => p.bucket,
      brushable: false,
      label: "Coverage readiness for each of the next fourteen days",
    });
  };

  for (const v of VIEWS) {
    const b = node("button", "seg__b", v.label);
    b.type = "button";
    b.dataset.view = v.key;
    b.addEventListener("click", () => { view = v.key; drawList(); });
    viewGroup.append(b);
  }

  const table = createTable(tableHost, {
    rowKey: (a) => a.id,
    rowHeight: 36,
    rail: (a) => (a.status === "scheduled" ? readinessTone(a) : null),
    empty: "No visits match.",
    columns: [
      {
        key: "when",
        label: "When",
        type: "date",
        /* Wider than a date track: the time is what a front desk reads first, and 92px clipped it. */
        width: "152px",
        get: (a) => `${dayLabel(a.day).replace(",", "")} · ${clockTime(a.scheduledFor, schedule?.timeZone)}`,
        value: (a) => a.scheduledFor,
      },
      { key: "patient", label: "Patient", type: "entity", get: (a) => maskName(a.patientName), value: (a) => a.patientName },
      { key: "provider", label: "Provider", type: "entity", get: (a) => a.provider ?? "—" },
      {
        key: "planned",
        label: "Planned",
        type: "currency",
        get: (a) => (a.plannedProductionCents === null ? null : usdExact(a.plannedProductionCents)),
        value: (a) => a.plannedProductionCents ?? -1,
      },
      {
        key: "coverage",
        label: "Coverage",
        type: "status",
        get: (a) => (a.status === "scheduled" ? readinessWord(a.readiness) : a.status === "no-show" ? "No-show" : "Cancelled"),
      },
    ],
    onOpen: (a) => {
      if (a.readiness?.verificationId) {
        store.pushDrill({ kind: "verification", id: a.readiness.verificationId, label: maskName(a.patientName) });
      }
    },
  });

  function drawHead(plan) {
    const prov = scheduleProvenance(schedule.items);
    src.textContent = prov ?? "";
    src.hidden = !prov;
    fig.className = "ready__fig";
    if (plan.booked === 0) {
      fig.textContent = "—";
      fig.classList.add("is-zero");
      basis.textContent = "No visits are booked for the next fourteen days.";
      return;
    }
    if (plan.notReady === 0) {
      fig.textContent = plan.unit === "production" ? usd(0) : "0";
      fig.classList.add("is-zero");
      basis.textContent = `Every one of the ${plan.booked} booked ${plan.booked === 1 ? "visit" : "visits"} in the next fourteen days is verified.`;
      return;
    }
    fig.classList.add("is-warning");
    if (plan.unit === "production") {
      fig.textContent = usd(plan.notReadyWeight);
      basis.textContent =
        `of ${usd(plan.totalWeight)} planned over the next fourteen days is booked against coverage that is not ready — ` +
        `${plan.notReady} of ${plan.booked} visits`;
    } else {
      fig.textContent = String(plan.notReady);
      basis.textContent = `of ${plan.booked} booked visits over the next fourteen days are not ready. Counted, not weighed: some planned fees are not on file.`;
    }
  }

  function drawChart(plan) {
    buildChart(plan.unit);
    vizTitle.textContent =
      plan.unit === "production"
        ? "Planned production for each of the next fourteen days, by coverage readiness"
        : "Visits for each of the next fourteen days, by coverage readiness";
    if (plan.booked === 0) {
      chart.update([], { insufficient: "Nothing is booked in the next fourteen days." });
      return;
    }
    chart.update(plan.points, { series: READINESS_GROUPS });
    chart.setRule(schedule.today);
    chart.setNote(
      plan.unit === "production"
        ? "Height is planned production from the practice's own schedule, so one crown outweighs four cleanings. Click a day to list its visits."
        : "Height is the number of visits: some planned fees are not on file, and a partial sum would be drawn as a whole one. Click a day to list its visits."
    );
    chart.setProvenance({
      definition:
        "Booked visits for each practice day, stacked by whether the patient's latest verification covers the visit ON ITS DAY — " +
        "fresh by then, the payer active, and the visit inside the plan's dates.",
      range: `today and the next ${HORIZON_DAYS - 1} days`,
      records: plan.booked,
      sources: scheduleProvenance(schedule.items) ? "Demo schedule (invented), with Mermaid verifications" : "The practice's schedule, with Mermaid verifications",
    });
  }

  function drawList() {
    for (const b of viewGroup.querySelectorAll(".seg__b")) {
      const on = b.dataset.view === view;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    const day = local.get().point?.bucket ?? null;
    dayChip.replaceChildren();
    dayChip.classList.toggle("is-on", Boolean(day));
    if (day) {
      const b = node("button", "fchip", dayLabel(day));
      b.type = "button";
      b.setAttribute("aria-label", `Show every day, not only ${dayLabel(day)}`);
      b.append(node("span", "fchip__x", "×"));
      b.addEventListener("click", () => local.selectPoint(day));
      dayChip.append(b);
    }
    if (!schedule) { table.update([]); return; }
    const test = VIEWS.find((v) => v.key === view)?.test ?? (() => true);
    const rows = schedule.items
      .filter((a) => (day ? a.day === day : true))
      .filter(test)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    table.update(rows, {
      emptyMessage:
        schedule.items.length === 0
          ? "No visits are booked for the next fourteen days."
          : view === "attention"
            ? `Every booked visit${day ? " that day" : ""} is verified.`
            : "No visits match.",
    });
  }

  /**
   * "Verify all due": what one click will send, what it will not and why, and — after a run — what
   * came back for every visit. Nothing here runs without the button; the preview calls no payer.
   */
  function drawDue() {
    dueHost.replaceChildren();
    const h = node("div", "due__h");
    h.append(node("h3", "due__t", `Due for a check in the next ${due?.horizonDays ?? 3} days`));
    dueHost.append(h);

    if (dueError) {
      dueHost.append(node("p", "due__n",
        dueError.status === 403 ? "Your role cannot see what is due for a check." : "Could not work out what is due for a check."));
      return;
    }
    if (!due) return;

    if (lastRun || runError) dueHost.append(drawRun());

    const s = duePreviewSummary(due);
    dueHost.append(node("p", "due__n", s.sentence));
    if (due.visits.length > 0) {
      const list = node("ol", "due__l");
      for (const v of due.visits) {
        const li = node("li", "due__i" + (v.will === "skip" ? " is-skip" : ""));
        li.append(node("span", "due__when", `${dayLabel(v.day).replace(",", "")} · ${clockTime(v.scheduledFor, schedule?.timeZone)}`));
        li.append(node("span", "due__who", maskName(v.patientName)));
        li.append(node("span", "due__will", v.will === "check" ? "Will check" : "Skipped"));
        li.append(node("span", "due__why", v.reason));
        list.append(li);
      }
      dueHost.append(list);
    }
    if (s.checks > 0) {
      const b = node("button", "btn btn--primary due__run", running ? `Checking ${s.checks} ${s.checks === 1 ? "patient" : "patients"}…` : s.button);
      b.type = "button";
      b.disabled = running;
      b.setAttribute("aria-busy", String(running));
      b.addEventListener("click", runDue);
      dueHost.append(b);
    }
  }

  /** The last run, per visit — what the payer said, or why the check did not happen. */
  function drawRun() {
    const wrap = node("div", "due__res");
    if (runError) {
      wrap.append(node("p", "due__n is-critical",
        runError.status === 409 ? runError.message
          : runError.status === 403 ? `Not run. ${runError.message}`
            : `The run could not be completed: ${runError.message}`));
      return wrap;
    }
    wrap.append(node("p", "due__n", dueRunSummary(lastRun)));
    const list = node("ol", "due__l");
    for (const r of lastRun.results) {
      const tone = r.outcome === "error" ? "critical" : r.outcome === "checked" && r.readiness?.group !== "verified" ? "warning" : null;
      const li = node("li", "due__i" + (r.outcome === "not-run" ? " is-skip" : ""));
      li.append(node("span", "due__when", r.day ? `${dayLabel(r.day).replace(",", "")} · ${clockTime(r.scheduledFor, schedule?.timeZone)}` : "—"));
      li.append(node("span", "due__who", r.patientName ? maskName(r.patientName) : "—"));
      li.append(node("span", "due__will" + (tone ? ` is-${tone}` : ""),
        r.outcome === "checked" ? readinessWord(r.readiness) : r.outcome === "error" ? "Check failed" : "Not run"));
      li.append(node("span", "due__why", r.message));
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  function drawAll() {
    if (failed) {
      fig.textContent = "—";
      fig.className = "ready__fig is-zero";
      basis.textContent =
        failed.status === 403
          ? "Your role cannot see the schedule."
          : "The schedule could not be loaded. The checks below are unaffected.";
      src.hidden = true;
      buildChart(unit ?? "production");
      chart.update([], { insufficient: "No schedule to draw." });
      table.update([], { emptyMessage: "—" });
      return;
    }
    if (!schedule) return;
    const plan = readinessPlan(schedule);
    drawHead(plan);
    drawChart(plan);
    drawList();
  }

  const un = local.subscribe(() => drawList());

  async function reload() {
    const [s, d] = await Promise.all([
      fetchSchedule(api, HORIZON_DAYS).then((v) => ({ v, e: null }), (e) => ({ v: null, e })),
      api("GET", "/api/v1/appointments/due").then((v) => ({ v, e: null }), (e) => ({ v: null, e })),
    ]);
    schedule = s.v;
    failed = s.e;
    due = d.v;
    dueError = d.e;
    drawAll();
    drawDue();
  }

  async function runDue() {
    if (running || !due) return;
    const ids = due.visits.filter((v) => v.will === "check").map((v) => v.appointmentId);
    if (ids.length === 0) return;
    running = true;
    runError = null;
    drawDue();
    try {
      lastRun = await api("POST", "/api/v1/appointments/verify", { appointmentIds: ids });
    } catch (err) {
      runError = err;
    } finally {
      running = false;
    }
    /* The checks changed readiness, the queue and the look-back: redraw all of it from the server. */
    if (onChanged) await onChanged();
    else await reload();
  }

  buildChart("production");
  const importer = mountImport(importHost, {
    api,
    timeZone: () => schedule?.timeZone ?? null,
    onImported: () => (onChanged ? onChanged() : reload()),
  });
  /* No fetch here: the owning screen calls `reload` from its own load, once, with everything else. */

  return {
    reload,
    destroy() { un(); importer.destroy(); chart?.destroy(); table.destroy(); host.replaceChildren(); },
  };
}
