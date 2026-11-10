/**
 * Today — the triage screen (spec §8.1).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "What happened since I last looked, what needs me right now, and what is at risk today?"
 *
 * This is the screen a practice manager opens between patients, standing up, interrupted. It is the
 * one screen in the product that is not for analysis, and §8.1 breaks the standard shell for it
 * deliberately: three columns, because triage is a different act from investigation.
 *
 *   NEEDS YOU            MONEY TODAY              LIVE ACTIVITY
 *   dollar-ranked        intraday cash curve      reverse-chronological
 *   interventions        + today's schedule       stream of what the
 *                                                 machine and people did
 *
 * ── THE SCHEDULE STRIP ──────────────────────────────────────────────────────────────────────────
 * §8.1 calls the schedule strip "the highest-leverage widget in dental RCM — it must be above the
 * fold": who is coming in, when, with which provider, for what planned production, and whether
 * their coverage is ready.
 *
 * Until migration 0035 Mermaid had no appointment, and this slot stated that gap rather than list
 * verification records under a heading that said "today's schedule". It now reads the practice's
 * own schedule (`/api/v1/appointments`). Readiness is the server's answer, judged at the visit; the
 * strip only chooses words and colour for it (`schedule.js`), and says where the visits came from
 * when they are not the practice's own feed.
 */

import { createChart } from "./chart.js";
import { maskId, maskName } from "./privacy.js";
import { errorBlock, freshnessTag, load as loadWithStates, poll, restoreLayout, retire, stageSkeleton } from "./states.js";
import { clockTime, fetchSchedule, readinessTone, readinessWord, scheduleProvenance } from "./schedule.js";

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
const DAY = 86400000;
const HOUR = 3600000;

/**
 * Count a figure to its new value over §6.1's `--motion-chart` (320ms), decelerating.
 *
 * Text cannot be interpolated by CSS, so each frame re-formats through the caller's own formatter —
 * which also keeps the intermediate frames in the product's money vocabulary instead of showing raw
 * cents for a third of a second. Reduced motion skips to the end.
 */
function countUp(el, from, to, format) {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !Number.isFinite(from) || !Number.isFinite(to)) { el.textContent = format(to); return; }
  const started = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - started) / 320);
    el.textContent = format(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * The practice's standing money position, as rows a screen can render without deciding anything.
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT MARKUP ─────────────────────────────────────────────────
 * Because of one specific failure that has already happened once, in the renderer this replaced:
 * a figure the viewer's ROLE may not see comes back from the server as `null`, and rendering it as
 * `usd(v ?? 0)` prints a confident "$0.00" — under a caption reading "not visible to your role",
 * with every test still green. Telling a front-desk user that payers owe the practice nothing is a
 * false statement about money; telling them the figure is not theirs to see is a true one.
 *
 * So the null-vs-zero decision is made exactly once, here, where it can be tested without a DOM.
 * `visible: false` carries no `amount` at all — there is no value in the row for a renderer to
 * accidentally coerce.
 *
 * A visible ZERO is a real answer and is shown as $0.00. That distinction is the whole point: "no
 * payer owes us anything" and "you may not see what payers owe us" are different sentences.
 */
export function positionRows(money) {
  const m = money ?? {};
  const row = (key, label, amount, note, tone) =>
    amount === null || amount === undefined
      ? { key, label, visible: false, display: "—", note: "not visible to your role", tone: null }
      : { key, label, visible: true, amount, display: usdExact(amount), note, tone: amount > 0 ? tone : null };

  const rows = [
    row("held", "In the bank, not yet posted", m.heldInBank,
      m.heldCount ? `${m.heldCount} ${m.heldCount === 1 ? "advice" : "advices"} waiting on a person` : "nothing waiting",
      "warning"),
    row("payers", "Payers still owe", m.owedByPayers, "filed and unanswered", null),
    row("patients", "Patients owe", m.owedByPatients,
      m.overNinetyShare > 0 ? `${Math.round(m.overNinetyShare * 100)}% of it over 90 days` : "none of it over 90 days",
      null),
    row("denied", "Denied and not recovered", m.deniedUnrecovered, "refused, and still worth chasing", "critical"),
  ];

  /*
   * Pre-authorisation exposure appears only when there is some. A permanent "$0.00 at risk" row is
   * one more line to read past on a screen whose whole job is to be read in five seconds — and it
   * would sit there on the overwhelming majority of days when nothing is at risk.
   */
  if (m.preAuthAtRisk === null || m.preAuthAtRisk > 0) {
    rows.push(row("preauth", "At risk, unauthorised", m.preAuthAtRisk, "no approval on file for treatment already billed", "critical"));
  }
  return rows;
}

/**
 * Today's schedule strip (§8.1) as rows a screen can render without deciding anything.
 *
 * Pure, for the same reason `positionRows` is: the decisions that can be wrong — which visits are
 * today, which are counted, when production can be stated, what colour a row may claim — are made
 * once, here, where a test can reach them without a DOM.
 *
 * Production is the sum of what the practice's own system planned, or null when ANY scheduled
 * visit's fee is unknown: a partial total under the word "planned" would be read as the day's.
 * Cancelled visits stay in the list — the front desk needs to see the gap in the chair — but count
 * toward nothing.
 */
export function scheduleStrip(schedule, now = Date.now()) {
  const todays = (schedule?.items ?? []).filter((a) => a.day === schedule.today);
  const booked = todays.filter((a) => a.status === "scheduled");
  const production = booked.every((a) => a.plannedProductionCents !== null)
    ? booked.reduce((t, a) => t + a.plannedProductionCents, 0)
    : null;
  return {
    rows: todays.map((a) => ({
      id: a.id,
      time: clockTime(a.scheduledFor, schedule.timeZone),
      name: a.patientName,
      detail: [a.provider, a.plannedProcedures.map((p) => p.code).join(" ")].filter(Boolean).join(" · "),
      production: a.plannedProductionCents,
      word: a.status === "scheduled" ? readinessWord(a.readiness) : a.status === "no-show" ? "No-show" : a.status[0].toUpperCase() + a.status.slice(1),
      tone: a.status === "scheduled" ? readinessTone(a, now) : null,
      group: a.readiness?.group ?? null,
      booked: a.status === "scheduled",
      verificationId: a.readiness?.verificationId ?? null,
    })),
    count: booked.length,
    production,
    notReady: booked.filter((a) => a.readiness && a.readiness.group !== "verified").length,
    provenance: scheduleProvenance(todays),
  };
}

/** Which drill a needs-you item opens, by the kind the queue reports. */
const DRILL_FOR = {
  verification: "verification",
  claim: "claim",
  remittance: "advice",
  denial: "denial",
};

/**
 * How long ago, in the shortest form that is still exact enough to act on.
 *
 * Minutes below an hour, hours below a day, then days. Never "a while ago": this stream is the
 * record of what the machine did, and a person checking whether their own action landed needs to
 * see that it landed two minutes ago rather than that it landed recently.
 */
function ago(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, nowMs - t);
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
  /*
   * Past a day, elapsed time stops being the useful form and an absolute one starts. "11d ago"
   * repeated down a column says nothing that distinguishes one group from the next — which is
   * exactly what happened here, six groups deep, all reading "11d ago" while the events inside them
   * were minutes apart. A clock time restores the ordering the reader was looking for.
   */
  const d = new Date(t);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** The activity stream's filters. `money` is any entry that moved a dollar figure. */
const STREAMS = [
  { key: "all", label: "Everything" },
  { key: "money", label: "Money only" },
  { key: "system", label: "System only" },
];
/*
 * There is no "people only" filter, and its absence is deliberate rather than an omission.
 * `recentActivity` reports WHAT happened — a payer paid, a claim was refused — and does not carry
 * an actor, so the client cannot tell a posting the outbox performed from one a person released.
 * Offering the filter would produce an empty list that looks like "nobody did anything today".
 * The audit log on Ops does carry actors, and that is where the question belongs until the queue
 * carries one too.
 */

export function mountToday(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr", "scr--today");

  let now = Date.now();
  /** What "posted today" read on the previous draw, so a change can be told from a first sight. */
  let lastPostedToday = null;

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "What needs a person right now");
  const stamp = node("div", "scr__stamp");
  header.append(question, stamp);

  /* The three columns §8.1 specifies. CSS collapses them; the order here is the mobile order. */
  const cols = node("div", "tri");
  const colNeeds = node("section", "tri__c tri__c--needs");
  const colMoney = node("section", "tri__c tri__c--money");
  const colFeed = node("section", "tri__c tri__c--feed");
  cols.append(colNeeds, colMoney, colFeed);

  stage.append(header, cols);

  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let board = null;
  let advices = [];
  /* Today's schedule, or the error that stopped it — never both, and neither blocks the board. */
  let schedule = null;
  let scheduleError = null;
  let stream = "all";
  /**
   * Items a person has dealt with in this sitting.
   *
   * §8.1 permits exactly one gamified element and describes it precisely: "a plain count, not a
   * celebration". It is per-session and deliberately not persisted — it answers "have I made
   * progress since I sat down", which is a question about this sitting.
   */
  const resolved = new Set();

  const chartHost = node("div", "");
  const chart = createChart(chartHost, {
    store,
    mark: "line",
    height: 150,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    /* The x-axis is an hour of the day, not a date. A time brush over it would mean nothing. */
    brushable: false,
    label: "Money posted so far today, by hour",
  });

  /* ── NEEDS YOU ────────────────────────────────────────────────────────────────────────────── */

  function drawNeeds() {
    colNeeds.replaceChildren();
    const items = (board?.items ?? []).filter((i) => !resolved.has(i.id));

    const head = node("div", "tri__h");
    head.append(node("h2", "tri__t", "Needs you"));
    if (resolved.size > 0) {
      /* A plain count. No celebration, no colour, no animation — §8.1 is explicit. */
      head.append(node("span", "tri__done", `${resolved.size} cleared`));
    }
    colNeeds.append(head);

    /*
     * The ranking basis is stated, not implied. A list that claims to be ordered by importance owes
     * the reader the rule it used, or they cannot tell a mis-ranking from a surprise.
     */
    colNeeds.append(
      /*
       * The dash is explained here because the list is ranked by money and the top row can carry
       * one. A coverage check that never reached the payer has produced no estimate, so its worth
       * is genuinely unknown rather than zero — and it still outranks priced work, because an
       * unknown that is about to expire is worse than a known one that is not. Left unexplained,
       * the first row of the entry screen reads as a blank where the most important figure should
       * be, and the ranking rule stated in this very sentence appears not to hold.
       */
      node("p", "tri__n", "Ranked by the money at stake weighted by how soon it is lost. The figure is what that decision is worth — a dash where nothing has priced it yet.")
    );

    if (items.length === 0) {
      colNeeds.append(
        node("p", "empty2", resolved.size > 0
          ? "That is everything. Nothing else is waiting on a person right now."
          : "Nothing needs a person right now.")
      );
      return;
    }

    const list = node("ul", "needs");
    for (const item of items) {
      const li = node("li", "needs__i" + (item.urgent ? " is-urgent" : ""));

      /*
       * §8.1: "The list reads as a column of money with explanations attached, not as a list of
       * notifications with amounts appended." So the figure comes first in the DOM as well as in
       * the layout — it is what the eye and the screen reader both meet first.
       */
      const fig = node("span", "needs__amt" + (item.amount ? "" : " is-zero"), item.amount ? usd(item.amount) : "—");
      const body = node("div", "needs__b");
      /*
       * Masked only when the title IS a person. A remittance item is titled with the PAYER — "Cigna
       * Dental" — and reducing that to "C.D." would hide nothing private while making the row
       * unreadable. Presentation mode protects patients, not payers.
       */
      body.append(node("span", "needs__title", item.kind === "remittance" ? item.title : maskName(item.title)));
      /**
       * The subtitle, plus the one fact that tells this row from its twin — masked here rather than
       * composed on the server.
       *
       * A coverage check's distinguisher is a MEMBER ID, and presentation mode exists to stop an
       * identifier being read off a screen turned around in an operatory. `maskId` keeps the last
       * two characters, which is exactly enough to keep two rows apart and is the case it was
       * written for. Everything else — a trace number, a service date, a procedure code — is not a
       * person and travels as plain text.
       */
      const d = item.distinguisher;
      const tell = !d ? "" : "memberId" in d ? ` · member ${maskId(d.memberId)}` : ` · ${d.text}`;
      body.append(node("span", "needs__why", item.subtitle + tell));
      body.append(node("span", "needs__act", item.action));

      const meta = node("div", "needs__meta");
      if (item.dueDate) {
        const days = Math.round((Date.parse(item.dueDate) - now) / DAY);
        meta.append(
          node("span", "needs__due" + (days <= 2 ? " is-critical" : days <= 7 ? " is-warning" : ""),
            days < 0 ? `${Math.abs(days)}d past due` : days === 0 ? "due today" : `${days}d left`)
        );
      }
      if (item.source?.shortLabel) meta.append(node("span", "needs__src", item.source.shortLabel));
      if (meta.childElementCount) body.append(meta);

      const open = node("button", "needs__open", "Open");
      open.type = "button";
      open.setAttribute("aria-label", `Open ${item.title}`);
      const kind = DRILL_FOR[item.kind];
      if (kind) {
        open.addEventListener("click", () => store.pushDrill({ kind, id: item.id, label: item.title }));
      } else {
        open.disabled = true;
        open.title = `Nothing on this screen can open a ${item.kind}.`;
      }

      /*
       * "Clear" records that a PERSON has dealt with this, and says so plainly. It does not resolve
       * anything in the system — no verification is reviewed, no advice released, no claim filed by
       * pressing it. Wiring a one-click resolve here would put a money decision behind a button on a
       * summary screen, which is the gate this product exists to keep closed.
       */
      const clear = node("button", "needs__clear", "Clear");
      clear.type = "button";
      clear.title = "Hide this from today's list. Nothing in the record changes.";
      clear.setAttribute("aria-label", `Hide ${item.title} from today's list`);
      clear.addEventListener("click", () => { resolved.add(item.id); drawNeeds(); });

      const actions = node("div", "needs__actions");
      actions.append(open, clear);

      li.append(fig, body, actions);
      list.append(li);
    }
    colNeeds.append(list);
  }

  /* ── MONEY TODAY ──────────────────────────────────────────────────────────────────────────── */

  /**
   * The intraday cash curve, and the comparison line §8.1 asks it to carry.
   *
   * The curve is cumulative dollars POSTED today, by hour, from the advices' own arrival times. The
   * comparison is the median of the same eight most recent matching weekdays at the same hour —
   * "are we behind by this time on a normal Tuesday?", which is the question a total cannot answer.
   *
   * The median is drawn ONLY when eight comparable weekdays actually carry postings. A "median" over
   * two Tuesdays is a line with the authority of a benchmark and the content of a coin toss, and
   * this one would be read as the answer to "are we behind". Below that, the line is absent and the
   * screen says how many it has.
   */
  function hourlySeries() {
    const todayIso = new Date(now).toISOString().slice(0, 10);
    const todayDow = new Date(`${todayIso}T00:00:00.000Z`).getUTCDay();

    /** Cumulative cents posted by the end of each hour, for one calendar day. */
    const cumulativeFor = (iso) => {
      const byHour = new Array(24).fill(0);
      for (const a of advices) {
        if (String(a.receivedAt ?? "").slice(0, 10) !== iso) continue;
        /* Held money is in the bank but not posted; a curve of "posted" must not count it. */
        if (a.status !== "posted") continue;
        const h = new Date(a.receivedAt).getUTCHours();
        if (h >= 0 && h < 24) byHour[h] += a.paymentTotal ?? 0;
      }
      let run = 0;
      return byHour.map((v) => (run += v));
    };

    /* The eight most recent earlier days sharing today's weekday that actually posted something. */
    const priorDays = [];
    for (let back = 1; back <= 8 * 7 && priorDays.length < 8; back++) {
      const iso = new Date(now - back * DAY).toISOString().slice(0, 10);
      if (new Date(`${iso}T00:00:00.000Z`).getUTCDay() !== todayDow) continue;
      const cum = cumulativeFor(iso);
      if (cum[23] > 0) priorDays.push(cum);
    }

    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const comparable = priorDays.length >= 8
      ? Array.from({ length: 24 }, (_, h) => median(priorDays.map((d) => d[h])))
      : null;

    return { today: cumulativeFor(todayIso), comparable, priorCount: priorDays.length, todayIso };
  }

  /**
   * Who is in the chair today, and whether their coverage is ready (§8.1).
   *
   * A failure here is local: the schedule states its own problem in its own slot and the rest of
   * the column — money that did post — stays on screen, because §7 forbids one missing feed from
   * blanking data that did arrive.
   */
  function drawSchedule() {
    const wrap = node("div", "tri__sched");
    const head = node("div", "tri__h");
    head.append(node("h3", "tri__t2", "Today's schedule"));
    wrap.append(head);

    if (scheduleError) {
      wrap.append(
        node("p", "tri__n",
          scheduleError.status === 403
            ? "Your role cannot see the schedule. Someone who can review coverage can."
            : "The schedule could not be loaded. Everything else on this screen is current; it will retry on the next refresh.")
      );
      return wrap;
    }
    if (!schedule) return wrap;

    const s = scheduleStrip(schedule);
    if (s.provenance) head.append(node("span", "tri__src", s.provenance));

    if (s.rows.length === 0) {
      wrap.append(node("p", "tri__n", "No visits are booked for today."));
      return wrap;
    }

    /* The day in one line: how many are coming, what they are worth, how many are not ready. */
    const parts = [`${s.count} ${s.count === 1 ? "visit" : "visits"}`];
    if (s.production !== null) parts.push(`${usd(s.production)} planned`);
    parts.push(s.notReady === 0 ? "every one ready" : `${s.notReady} not ready`);
    wrap.append(node("p", "tri__n", parts.join(" · ")));

    const list = node("ol", "sched");
    for (const r of s.rows) {
      const li = node("li", "");
      const b = node("button", "sched__i" + (r.booked ? "" : " is-off") + (r.tone ? ` is-${r.tone}` : ""));
      b.type = "button";
      b.append(node("span", "sched__time", r.time));
      const who = node("span", "sched__who");
      who.append(node("span", "sched__name", maskName(r.name)));
      if (r.detail) who.append(node("span", "sched__detail", r.detail));
      b.append(who);
      b.append(node("span", "sched__amt" + (r.production === null ? " is-na" : ""), r.production === null ? "—" : usd(r.production)));
      const st = node("span", "sched__st" + (r.tone ? ` is-${r.tone}` : ""));
      /* The dot obeys the same rule as the word beside it — see `readinessTone` — so the two can
         never disagree about whether this visit is an alarm. */
      if (r.booked) st.append(node("span", `sched__dot is-${r.tone ?? (r.group === "verified" ? "verified" : "quiet")}`));
      st.append(node("span", "", r.word));
      b.append(st);
      b.setAttribute(
        "aria-label",
        `${r.time}, ${maskName(r.name)}, ${r.word}${r.verificationId ? ". Opens the verification." : ". Opens Verify."}`
      );
      b.addEventListener("click", () => {
        if (r.verificationId) store.pushDrill({ kind: "verification", id: r.verificationId, label: maskName(r.name) });
        else document.querySelector('.tab[data-tab="verifications"]')?.click();
      });
      li.append(b);
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  function drawMoney() {
    colMoney.replaceChildren();

    const head = node("div", "tri__h");
    head.append(node("h2", "tri__t", "Money today"));
    colMoney.append(head);

    const { today, comparable, priorCount } = hourlySeries();
    const postedToday = today[23];
    const upToHour = new Date(now).getUTCHours();

    /* The one figure this column is about, with what it is measured against directly beneath it. */
    /*
     * §6: the product's one authored moment. The figure counts to its new value ONLY when the money
     * genuinely moved between two reads of the same day — never on the first draw, and never when
     * the reader caused the change, because counting between two numbers that were about different
     * things implies a relationship that is not there.
     */
    const figEl = node("div", "tri__fig" + (postedToday ? "" : " is-zero"), usdExact(postedToday));
    colMoney.append(figEl);
    if (lastPostedToday !== null && lastPostedToday !== postedToday) {
      countUp(figEl, lastPostedToday, postedToday, (v) => usdExact(v));
    }
    lastPostedToday = postedToday;
    colMoney.append(
      node("p", "tri__n",
        comparable
          ? `posted so far today, against ${usdExact(comparable[upToHour])} by this hour on a typical matching weekday`
          : `posted so far today. No comparison line: a same-weekday median needs eight comparable days and ${priorCount === 0 ? "none" : `only ${priorCount}`} ${priorCount === 1 ? "has" : "have"} posted anything.`)
    );

    colMoney.append(chartHost);

    /* Only the hours that have happened. Drawing a flat line to midnight asserts a future. */
    const points = [];
    for (let h = 0; h <= Math.min(23, upToHour); h++) {
      points.push({
        bucket: `h${h}`,
        label: `${String(h).padStart(2, "0")}:00`,
        tick: `${String(h).padStart(2, "0")}`,
        value: today[h],
        note: comparable ? `typical by now: ${usdExact(comparable[h])}` : undefined,
      });
    }
    if (postedToday === 0) {
      /* The figure directly above already reads "$0.00 · posted so far today", so restating that
         nothing has posted spends a second line saying what the reader has just read. Only the
         chart's own absence is news here. */
      chart.update([], { insufficient: "The curve appears with the first payment." });
    } else if (points.length < 2) {
      chart.update([], { insufficient: "Only one hour has elapsed today. A curve needs more than one reading." });
    } else {
      chart.update(points);
      chart.setNote("Cumulative, from each advice's own arrival time. Hours still to come are not drawn.");
      chart.setProvenance({
        definition: "Cumulative dollars POSTED today, by hour, from each advice's own arrival time. Held money is excluded — it is in the bank but not posted.",
        range: "today, to the current hour",
        records: advices.filter((a) => String(a.receivedAt ?? "").slice(0, 10) === new Date(now).toISOString().slice(0, 10)).length,
        sources: "Mermaid remittance advices (835)",
        syncedAt: board?.generatedAt ?? null,
      });
    }

    /* ── Today's schedule (§8.1) — see the file header ──────────────────────────────────────── */
    colMoney.append(drawSchedule());

    /* ── Where the money is standing ───────────────────────────────────────────────────────── */
    const pos = node("div", "tri__pos");
    pos.append(node("h3", "tri__t2", "Where the money is standing"));
    const dl = node("dl", "tpos");
    for (const r of positionRows(board?.money)) {
      const dt = node("dt", "tpos__l");
      dt.append(node("span", "tpos__n", r.label));
      if (r.note) dt.append(node("span", "tpos__note", r.note));
      /*
       * `is-na` carries no money and never can: the display string is fixed at "—" by
       * `positionRows`, so there is no value here for a formatter to coerce into "$0.00".
       */
      const dd = node("dd", "tpos__v" + (r.visible ? "" : " is-na") + (r.tone ? ` is-${r.tone}` : ""), r.display);
      dl.append(dt, dd);
    }
    pos.append(dl);
    colMoney.append(pos);
  }

  /* ── LIVE ACTIVITY ────────────────────────────────────────────────────────────────────────── */

  function drawFeed() {
    colFeed.replaceChildren();

    const head = node("div", "tri__h");
    head.append(node("h2", "tri__t", "Activity"));
    colFeed.append(head);

    const seg = node("div", "seg seg--sm");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Filter activity");
    for (const s of STREAMS) {
      const b = node("button", "seg__b" + (stream === s.key ? " is-active" : ""), s.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(stream === s.key));
      b.addEventListener("click", () => { stream = s.key; drawFeed(); });
      seg.append(b);
    }
    colFeed.append(seg);

    const all = board?.recentActivity ?? [];
    const rows = all.filter((e) =>
      stream === "all" ? true
      : stream === "money" ? Number(e.amount) > 0
      : /* system */ e.kind !== "patient"
    );

    if (rows.length === 0) {
      colFeed.append(
        node("p", "empty2", all.length === 0
          ? "Nothing has happened yet."
          : "Nothing in this stream. Clear the filter to see everything.")
      );
      return;
    }

    /*
     * §8.1 groups the stream by minute. Grouping is what turns twelve lines that all say "17:30"
     * into one moment with twelve things in it — which is what actually happened when a remittance
     * posted and fanned out.
     */
    const groups = [];
    for (const e of rows) {
      const minute = String(e.at ?? "").slice(0, 16);
      const last = groups[groups.length - 1];
      if (last && last.minute === minute) last.entries.push(e);
      else groups.push({ minute, entries: [e] });
    }

    const list = node("ol", "tfeed");
    for (const g of groups) {
      const li = node("li", "tfeed__g");
      li.append(node("div", "tfeed__when", ago(g.entries[0].at, now)));
      for (const e of g.entries) {
        const row = node("div", "tfeed__e");
        row.append(node("span", `tfeed__dot is-${e.kind}`));
        row.append(node("span", "tfeed__t", e.text));
        if (Number(e.amount) > 0) row.append(node("span", "tfeed__v", usdExact(e.amount)));
        const kind = DRILL_FOR[e.kind];
        if (kind && e.id) {
          row.classList.add("is-openable");
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          const open = () => store.pushDrill({ kind, id: e.id, label: e.text.slice(0, 48) });
          row.addEventListener("click", open);
          row.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
          });
        }
        li.append(row);
      }
      list.append(li);
    }
    colFeed.append(list);
  }

  /* ── Header stamp: provenance, which is never blended silently ────────────────────────────── */
  function drawStamp() {
    stamp.replaceChildren();
    if (!board) return;
    const s = board.sources ?? {};
    const total = (s.live ?? 0) + (s.test ?? 0) + (s.mock ?? 0) + (s.none ?? 0);
    if (total === 0) return;
    const parts = [];
    if (s.live) parts.push(`${s.live} live`);
    if (s.test) parts.push(`${s.test} clearinghouse test`);
    if (s.mock) parts.push(`${s.mock} seeded demo`);
    if (s.none) parts.push(`${s.none} with no benefits returned`);
    /*
     * "None of these 2" named nothing. The stamp sits above a board showing four rows of mixed
     * work, so "these 2" invited the reader to look for two of something and find no set that size
     * — the count is of COVERAGE CHECKS, which is a different population from the list underneath
     * it. A count without its noun is not shorter, it is unresolvable.
     */
    const checks = `coverage ${total === 1 ? "check" : "checks"}`;
    stamp.append(
      node("span", "scr__stamp-t",
        (s.live ?? 0) === 0
          ? `None of the ${total} ${checks} came from a live payer — ${parts.join(", ")}.`
          : `${total} ${checks}: ${parts.join(", ")}.`)
    );
    /*
     * §7.5, not a timestamp. "Synced 4m ago" and "stale — 3h" are different claims about whether the
     * figures beside them can be acted on, and the whole reason the indicator exists is that data
     * quietly shown as current when it is hours old is the failure nobody notices.
     */
    if (board.generatedAt) stamp.append(freshnessTag(board.generatedAt, now));
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
          what: "Today's board could not be loaded.",
          shows: "what needs a person right now, and what money arrived today",
          stakes: "Work needing a person is not visible, including anything on a deadline.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: [], chartHeight: 150, rows: 8 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    now = Date.now();
    drawStamp();
    drawNeeds();
    drawMoney();
    drawFeed();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
      /*
       * The advices are fetched for the intraday curve alone, and failing to get them must not take
       * the whole triage screen down — the needs-you column is the reason a person opened it.
       */
      const [t, adv, sched] = await Promise.all([
        api("GET", "/api/v1/today"),
        api("GET", "/api/v1/remittances").catch(() => ({ items: [] })),
        /* Same rule for the schedule: its failure is stated in its own slot, never the screen's. */
        fetchSchedule(api, 1).then(
          (s) => ({ s, e: null }),
          (e) => ({ s: null, e })
        ),
      ]);
      board = t;
      advices = adv.items ?? [];
      schedule = sched.s;
      scheduleError = sched.e;
  }

  /*
   * §8.1 describes this screen as live — an activity stream whose entries arrive, and money that
   * posts while somebody is looking. A minute is the slowest interval at which "what needs a person
   * right now" is still telling the truth about the word "now".
   */
  const stopPolling = poll(60_000, () => store.get().drill.length === 0, load);

  const un = store.subscribe((_s, reason) => {
    /* Nothing on this screen filters, so only a drill close needs a redraw of the cleared count. */
    if (reason === "drill") return;
    drawAll();
  });

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); stopPolling(); chart.destroy(); stage.replaceChildren(); stage.classList.remove("scr--today"); },
    /**
     * Today opens four kinds of entity and owns none of them. Rather than duplicating four drill
     * renderers — which would be four more places for the panel to disagree with the screen that
     * owns the record — it loads the owning screen's renderer on demand.
     */
    async renderDrill(entry) {
      if (entry.kind === "verification") {
        const m = await import("./verify.js");
        return m.renderVerificationDrill(entry.id, { api });
      }
      if (entry.kind === "claim") {
        const m = await import("./claims.js");
        return m.renderClaimDrill(entry.id, { store, api });
      }
      if (entry.kind === "denial") {
        const m = await import("./recover.js");
        return m.renderDenialDrill(entry.id, { api });
      }
      if (entry.kind === "advice") {
        const m = await import("./money.js");
        return m.renderAdviceDrill(entry.id, { store, api });
      }
      return null;
    },
  };
}
