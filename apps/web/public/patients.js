/**
 * Patients — the other half of the revenue cycle (spec §8.6).
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────────────────────────
 * "Who owes us, how likely are they to pay, and what is their complete financial story?"
 *
 * The primary visual answers a question no list view can: is our patient A/R a few large problems or
 * many small ones? Those two shapes demand opposite collection strategies — one is four phone calls,
 * the other is a statement run — and a practice that reads the wrong one wastes the month.
 *
 * ── POLICIES AND PEOPLE ARE DIFFERENT COUNTS ─────────────────────────────────────────────────────
 * A ledger account is keyed by MEMBER ID, and a family plan is one member ID over several people.
 * So "43 accounts" and "43 patients" are different claims and one of them is wrong. Every count on
 * this screen says which it is, and the drill shows the people behind an account when there is more
 * than one. This is a product truth that outranks any visual decision, and it has already been the
 * subject of one defect.
 *
 * ── WHAT IS NOT DRAWN, AND WHY ───────────────────────────────────────────────────────────────────
 * §8.6 asks for statement-cycle effectiveness — payment rate by days-after-statement, so a practice
 * can see where the response curve flattens and stop paying for the fifth letter. Mermaid does not
 * record statements. `EntryKind` is charge, payment, adjustment, writeoff; nothing marks the day a
 * statement went out, so days-after-statement has no origin to count from. It is not approximated
 * from the charge date, which would silently answer a different question.
 *
 * Payment-plan performance is likewise absent because payment plans are: there is no plan entity, no
 * instalment schedule, nothing to be on track or behind against.
 *
 * Both are named on the screen rather than quietly omitted, because a practice manager looking for
 * them should learn they do not exist rather than conclude they missed them.
 */

import { createChart } from "./chart.js";
import { createTable } from "./table.js";
import { createSpine } from "./spine.js";
import { maskId, maskName } from "./privacy.js";
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
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

/**
 * The balance-size buckets, smallest first.
 *
 * Chosen so the two collection strategies fall on opposite sides of the middle: everything under
 * $500 is a statement run, everything over $1,000 is a phone call. Buckets that split evenly by
 * count would hide exactly that.
 */
const SIZES = [
  { key: "u100", label: "Under $100", max: 10000 },
  { key: "u500", label: "$100–499", max: 50000 },
  { key: "u1k", label: "$500–999", max: 100000 },
  { key: "u25", label: "$1,000–2,499", max: 250000 },
  { key: "over", label: "$2,500 and over", max: Infinity },
];
const sizeOf = (cents) => SIZES.find((s) => (cents ?? 0) < s.max)?.key ?? "over";

/**
 * The age bands, and the one that carries semantic colour.
 *
 * §5.5 is explicit: a graphite ramp, with only `120+` — here `90+`, which is the bucket the ledger
 * actually keeps — carrying loss. Age is the strongest predictor of whether a patient balance is
 * ever collected, which is why the bars are segmented by it rather than by anything else.
 */
const AGES = [
  { key: "current", label: "Under 30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "Over 90 days", tone: "critical" },
];

/** Which age band holds most of an account's balance — the one figure a row can carry. */
function dominantAge(aging) {
  let best = null;
  let bestValue = -1;
  for (const a of AGES) {
    const v = Number(aging?.[a.key] ?? 0);
    if (v > bestValue) { bestValue = v; best = a; }
  }
  return bestValue > 0 ? best : null;
}

export function mountPatients(stage, { store, api }) {
  stage.replaceChildren();
  stage.classList.add("scr");

  /* ── Chrome ───────────────────────────────────────────────────────────────────────────────── */
  const header = node("div", "scr__head");
  const question = node("h1", "scr__q", "Who owes us, and how old is it");
  const controls = node("div", "scr__controls");
  /* The presentation-mode toggle lives in the top bar, where every screen can reach it (§8.6). */
  header.append(question, controls);

  const chips = node("div", "fchips");
  const spineHost = node("div", "");
  const vizHost = node("section", "viz2");
  const vizTitle = node("div", "viz2__t");
  const chartHost = node("div", "");
  vizHost.append(vizTitle, chartHost);

  const accuracyHost = node("section", "block2");
  const gapsHost = node("section", "block2");
  const supportRow = node("div", "grid2");
  supportRow.append(accuracyHost, gapsHost);

  const tableHost = node("div", "");
  stage.append(header, chips, spineHost, vizHost, supportRow, node("div", "scr__rule"), tableHost);
  /* The screen's own layout, kept so the error state can be replaced and then put back. */
  const LAYOUT = [...stage.children];

  /* ── State ────────────────────────────────────────────────────────────────────────────────── */
  let accounts = [];
  let summary = null;
  let claims = [];
  /* The load's own state, read by the render path: see `states.js` for why it is a handle. */
  const state = { loading: false, failed: null, loaded: false };

  const ACCESSORS = {
    size: (a) => sizeOf(a.balance),
    age: (a) => dominantAge(a.aging)?.key ?? "none",
  };
  const except = (...dims) =>
    Object.fromEntries(Object.entries(ACCESSORS).filter(([k]) => !dims.includes(k)));

  const visible = () => accounts.filter((a) => store.matches(a, ACCESSORS));
  /* The distribution is drawn from everything the size filter does not narrow — a histogram that
     rebuilt from its own selection would leave a single bar and no distribution to read it against. */
  const chartPopulation = () => accounts.filter((a) => store.matches(a, except("size")));

  /* ── Primitives ───────────────────────────────────────────────────────────────────────────── */
  const chart = createChart(chartHost, {
    store,
    mark: "band",
    height: 190,
    series: AGES,
    format: (v) => usd(v),
    bucketOf: (p) => p.bucket,
    /* The x-axis is a balance-size bucket, not time. A date brush over it would mean nothing. */
    brushable: false,
    label: "Outstanding patient balances by size, segmented by age",
  });

  const spine = createSpine(spineHost, { store, metrics: [] });

  const table = createTable(tableHost, {
    rowKey: (a) => a.patientKey,
    rowHeight: 36,
    amount: (a) => a.balance,
    formatAmount: (c) => usdExact(c),
    rail: (a) => {
      const d = dominantAge(a.aging);
      return d?.key === "d90_plus" ? "critical" : d?.key === "d61_90" ? "warning" : null;
    },
    empty: "No accounts match the current selection.",
    columns: [
      {
        key: "who",
        label: "Account",
        type: "entity",
        /*
         * The ACCOUNT's name, and how many people are on it. A family policy shows one row here and
         * the drill lists the people — showing it as several rows would double-count the balance.
         */
        get: (a) => maskName(a.patientName) + (a.people?.length > 1 ? ` +${a.people.length - 1}` : ""),
        value: (a) => a.patientName,
      },
      { key: "member", label: "Member ID", type: "mono", get: (a) => maskId(a.patientKey), value: (a) => a.patientKey },
      {
        key: "age",
        label: "Oldest",
        type: "count",
        get: (a) => (a.daysOutstanding === null || a.daysOutstanding === undefined ? "—" : `${a.daysOutstanding}d`),
        value: (a) => -(a.daysOutstanding ?? 0),
      },
      /* "Mostly" on its own names no quantity — mostly what? The cell holds the age band most of this
         balance sits in, and the column beside it is "Oldest", so the pair now reads as the two
         readings of age they are: the worst of it, and where the bulk of it is. */
      { key: "band", label: "Most of it", type: "status", get: (a) => dominantAge(a.aging)?.label ?? "—" },
      { key: "charged", label: "Charged", type: "currency", get: (a) => usdExact(a.charged), value: (a) => a.charged },
      {
        key: "paid",
        label: "Paid",
        type: "currency",
        get: (a) => (a.paid ? usdExact(a.paid) : null),
        value: (a) => a.paid ?? 0,
      },
      { key: "balance", label: "Balance", type: "currency", get: (a) => usdExact(a.balance), value: (a) => a.balance },
    ],
    onOpen: (a) =>
      store.pushDrill({ kind: "patient", id: a.patientId, label: maskName(a.patientName) ?? a.patientKey }),
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
    const s = summary ?? {};
    const people = new Set();
    for (const a of accounts) for (const p of a.people ?? []) people.add(p.patientId ?? p.patientName);
    const over90 = Number(s.aging?.d90_plus ?? 0);

    spine.update([
      {
        key: "outstanding",
        label: "Patients owe",
        display: usd(s.totalOutstanding ?? 0),
        zero: !(s.totalOutstanding > 0),
        delta: null,
        series: [],
        /*
         * Both counts, both named. "43 accounts" and "43 patients" are different claims about the
         * practice and conflating them is the defect this wording exists to prevent.
         */
        basis: `${s.accountsWithBalance ?? 0} ${s.accountsWithBalance === 1 ? "account" : "accounts"} · ${people.size} ${people.size === 1 ? "person" : "people"}`,
        tone: null,
      },
      {
        key: "over90",
        label: "Over 90 days",
        display: usd(over90),
        zero: over90 === 0,
        delta: null,
        series: [],
        basis:
          s.overNinetyShare === null || s.overNinetyShare === undefined
            ? "nothing is outstanding"
            : `${Math.round(s.overNinetyShare * 100)}% of the balance`,
        tone: over90 > 0 ? "critical" : null,
      },
      {
        key: "collected",
        label: "Collected from patients",
        display: usd(s.totalPaid ?? 0),
        zero: !(s.totalPaid > 0),
        delta: null,
        series: [],
        basis:
          s.collectionRate === null || s.collectionRate === undefined
            ? "nothing has been billed"
            : `${Math.round(s.collectionRate * 100)}% of what was billed`,
        tone: null,
      },
      {
        key: "forgiven",
        label: "Written off",
        display: usd(s.totalForgiven ?? 0),
        zero: !(s.totalForgiven > 0),
        delta: null,
        series: [],
        basis: "balances a person decided not to pursue",
        tone: null,
      },
    ]);
  }

  /**
   * The distribution: one bar per balance-size bucket, each segmented by the age of the money in it.
   *
   * The height is DOLLARS, not accounts. Counting accounts would make forty $40 balances outweigh
   * one $1,600 balance, which is the exact misreading the chart exists to prevent.
   */
  function drawChart() {
    const rows = chartPopulation();
    vizTitle.textContent = "Where the patient balance actually sits";

    if (rows.length === 0) {
      chart.update([], {
        insufficient: store.narrowed()
          ? "No accounts match this selection."
          : "No patient owes anything. The distribution appears with the first balance.",
      });
      return;
    }

    const points = SIZES.map((s) => {
      const mine = rows.filter((a) => sizeOf(a.balance) === s.key);
      const parts = {};
      for (const a of AGES) parts[a.key] = mine.reduce((t, acc) => t + Number(acc.aging?.[a.key] ?? 0), 0);
      return {
        bucket: s.key,
        label: s.label,
        tick: s.label.replace(" and over", "+").replace("Under ", "<"),
        parts,
        note: `${mine.length} ${mine.length === 1 ? "account" : "accounts"}`,
      };
    });

    const occupied = points.filter((p) => AGES.some((a) => p.parts[a.key] > 0));
    if (occupied.length < 2) {
      chart.update([], {
        insufficient:
          occupied.length === 1
            ? `Every balance falls in one bucket (${occupied[0].label}, ${occupied[0].note}). A distribution needs more than one bucket to have a shape.`
            : "No account carries a balance to distribute.",
      });
      return;
    }

    chart.update(points, { series: AGES });
    chart.setNote(
      "Height is the DOLLARS in each bucket, not the number of accounts — forty small balances must not outweigh one large one. " +
        "Click a bucket to see the accounts in it."
    );
    chart.setProvenance({
      definition:
        "Outstanding patient balances grouped by the SIZE of the balance and segmented by its age. Height is dollars, not accounts.",
      range: "as at now — a balance has no window, only an age",
      records: rows.length,
      sources: "Mermaid patient ledger, keyed by member ID",
    });
  }

  /**
   * Estimate accuracy: what the patient was quoted, against what the payer actually left them.
   *
   * §8.6 asks for this and is right about why: systematic over- or under-estimation is a trust
   * problem with patients and a cash problem for the practice. It is computed from the claims, which
   * carry both the inherited estimate and the payer's own answer — the only two numbers involved.
   */
  function drawAccuracy() {
    accuracyHost.replaceChildren();
    accuracyHost.append(node("h2", "block2__h", "What we quoted, against what they owed"));

    /* Only claims a payer has actually ruled on: an unadjudicated claim has no answer to compare. */
    const ruled = claims.filter((c) => c.firstPaidAt && c.expectedPatientPays !== null && c.expectedPatientPays !== undefined);
    if (ruled.length === 0) {
      accuracyHost.append(
        node("p", "block2__n",
          "No claim has been both quoted and answered yet, so there is nothing to compare a quote against.")
      );
      return;
    }

    const deltas = ruled.map((c) => ({
      claim: c,
      quoted: c.expectedPatientPays,
      actual: c.patientResponsibility ?? 0,
      delta: (c.patientResponsibility ?? 0) - c.expectedPatientPays,
    }));
    const under = deltas.filter((d) => d.delta > 0);   /* the patient owes MORE than we told them */
    const over = deltas.filter((d) => d.delta < 0);
    const exact = deltas.filter((d) => d.delta === 0);
    const worst = deltas.reduce((w, d) => (Math.abs(d.delta) > Math.abs(w.delta) ? d : w), deltas[0]);

    accuracyHost.append(
      node("p", "block2__n",
        `Across ${ruled.length} ${ruled.length === 1 ? "claim" : "claims"} the payer has ruled on. A quote that was too low is the one that costs trust — the patient hears the higher number second.`)
    );

    const groups = [
      { key: "under", label: "Quoted too low", list: under, note: "the patient owes more than we said", tone: "critical" },
      { key: "over", label: "Quoted too high", list: over, note: "the patient owes less — a refund or a credit" },
      { key: "exact", label: "Quoted exactly", list: exact, note: "the estimate held" },
    ].filter((g) => g.list.length > 0);

    const top = Math.max(1, ...groups.map((g) => g.list.reduce((t, d) => t + Math.abs(d.delta), 0)));
    const wrap = node("div", "rank");
    for (const g of groups) {
      const dollars = g.list.reduce((t, d) => t + Math.abs(d.delta), 0);
      const b = node("button", "rank__r");
      b.type = "button";
      b.disabled = true;   /* A reading, not a filter: these are claims, and Claims is where they live. */
      const name = node("span", "rank__n rank__n--stack");
      name.append(node("span", "rank__main", g.label));
      name.append(node("span", "rank__sub", `${g.list.length} of ${ruled.length} · ${g.note}`));
      b.append(name);
      const track = node("span", "rank__t");
      const svg = svgEl("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
      svg.append(svgEl("rect", { class: "rank__f" + (g.tone ? " is-warning" : ""), x: 0, y: 0, width: Math.max(0.8, (dollars / top) * 100), height: 4 }));
      track.append(svg);
      b.append(track, node("span", "rank__v", usdExact(dollars)));
      wrap.append(b);
    }
    accuracyHost.append(wrap);

    if (worst && worst.delta !== 0) {
      accuracyHost.append(
        node("p", "block2__n block2__n--quiet",
          `The largest single miss: ${maskName(worst.claim.patientName)} was quoted ${usdExact(worst.quoted)} and owed ${usdExact(worst.actual)}.`)
      );
    }
  }

  /** The two §8.6 visuals this system has no data for, named rather than quietly dropped. */
  function drawGaps() {
    gapsHost.replaceChildren();
    gapsHost.append(node("h2", "block2__h", "Not available yet"));
    /*
     * ── NAME THE ABSENCE IN ONE LINE, NOT THE INTERNALS IN FOUR ────────────────────────────────
     * These two are named rather than quietly dropped, which is right: a reader who does not know
     * Mermaid never tracks statements could mistake this column for a statement report.
     *
     * What was wrong was the weight. Each carried a paragraph of implementation detail — "a ledger
     * entry is a charge, a payment, an adjustment or a write-off", "no origin to count days-after
     * from" — and the pair filled the entire right-hand column with things the product does not do,
     * in the vocabulary of the people who built it. Absence was given the same room as presence.
     *
     * A reader needs to know the number is missing and roughly why, so they stop looking for it.
     * They do not need the data model. One sentence each, in their words.
     */
    const dl = node("dl", "tpos");
    for (const [what, why] of [
      ["Statement-cycle effectiveness",
        "Mermaid does not send or record statements, so it cannot measure how well they work."],
      ["Payment-plan performance",
        "There are no payment plans in this system, so there is nothing to be on track or behind against."],
    ]) {
      const dt = node("dt", "tpos__l");
      dt.append(node("span", "tpos__n", what));
      dt.append(node("span", "tpos__note", why));
      dl.append(dt, node("dd", "tpos__v is-na", "—"));
    }
    gapsHost.append(dl);
  }

  function drawTable() {
    table.update(visible(), {
      emptyMessage: store.narrowed() ? "No accounts match this selection." : "No patient owes anything.",
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
          what: "Patient balances could not be loaded.",
          shows: "who owes the practice, how much, and how old it is",
          stakes: "What patients owe is not visible here.",
          error: state.failed,
          retry: load,
        })
      );
      return;
    }
    if (state.loading && !state.loaded) {
      stageSkeleton(stage, header, { metrics: ["Patients owe", "Over 90 days", "Collected from patients", "Written off"], chartHeight: 190 });
      return;
    }
    restoreLayout(stage, LAYOUT);
    drawChips();
    drawSpine();
    drawChart();
    drawAccuracy();
    drawGaps();
    drawTable();
  }

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────── */
  async function load() {
    await loadWithStates(state, fetchAll, drawAll);
  }

  async function fetchAll() {
      /* The claims are for the estimate-accuracy panel alone; losing them must not lose the ledger. */
      const [p, c] = await Promise.all([
        api("GET", "/api/v1/patients"),
        api("GET", "/api/v1/claims").catch(() => ({ items: [] })),
      ]);
      accounts = p.items ?? [];
      summary = p.summary ?? null;
      claims = c.items ?? [];
  }

  /* Masking arrives here too: the shell bumps the store when presentation mode changes. */
  const un = store.subscribe(() => drawAll());

  load();

  return {
    reload: load,
    destroy() { retire(state); un(); chart.destroy(); table.destroy(); spine.destroy(); stage.replaceChildren(); },
    async renderDrill(entry) {
      if (entry.kind === "patient") return renderPatientDrill(entry.id, { api });
      return null;
    },
  };
}

/* ══ Drill: one person's whole financial story, on one track ═════════════════════════════════ */

/**
 * §8.6 calls this the important one, and it is: "this single view replaces the three or four screens
 * a practice manager normally opens to answer 'why does this patient owe $412?'".
 *
 * The running balance in the right margin is what makes it answerable. It is computed from the
 * ledger's own SIGNED entries, oldest first — so the column is a real cumulative balance and not a
 * restatement of the current one, and the eye can follow it down the page to the charge that caused
 * the number the patient is disputing.
 */
export async function renderPatientDrill(id, { api }) {
  const wrap = node("div", "dr__sections");
  wrap.append(node("p", "dr__loading", "Loading the record…"));

  let view;
  try {
    view = await api("GET", `/api/v1/patients/record/${encodeURIComponent(id)}`);
  } catch (err) {
    wrap.replaceChildren(node("p", "dr__err", `Could not load this record — ${err.message}`));
    return wrap;
  }

  const t = view.totals ?? {};
  wrap.replaceChildren();

  /* ── Now ──────────────────────────────────────────────────────────────────────────────────── */
  const now = node("section", "dr__s");
  now.append(node("div", "dr__k", "Now"));
  now.append(node("div", "dr__fig", usdExact(t.balance ?? 0)));
  now.append(node("p", "dr__p", (t.balance ?? 0) > 0 ? "is what this patient owes today" : "nothing outstanding"));

  const meta = node("dl", "dr__dl");
  for (const [k, v, mono] of [
    ["Patient", maskName(view.patient?.firstName ? `${view.patient.firstName} ${view.patient.lastName}` : view.patient?.name), false],
    ["Member IDs", (view.provenance?.memberIds ?? []).map(maskId).join(", ") || "—", true],
    ["Charged", usdExact(t.charged ?? 0), false],
    ["Paid", usdExact(t.paid ?? 0), false],
    ["Written off", usdExact(t.forgiven ?? 0), false],
  ]) meta.append(node("dt", "", k), node("dd", mono ? "mono" : "", v ?? "—"));
  now.append(meta);

  /*
   * How the record was assembled. §8.6's own reasoning: a unified number that cannot be traced back
   * to its accounts is exactly the number a patient will dispute.
   */
  const p = view.provenance ?? {};
  now.append(
    node("p", "dr__p dr__p--muted",
      `Assembled from ${p.ledgerEntryCount ?? 0} ledger entries, ${p.claimCount ?? 0} claims, ${p.verificationCount ?? 0} verifications and ${p.denialCount ?? 0} denials across ${(p.memberIds ?? []).length} member ${(p.memberIds ?? []).length === 1 ? "ID" : "IDs"}.`)
  );
  wrap.append(now);

  /* ── The timeline, with the balance running down the right margin ─────────────────────────── */
  const ledgerEntries = [...(view.ledger?.entries ?? [])].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  if (ledgerEntries.length) {
    const tl = node("section", "dr__s");
    tl.append(node("div", "dr__k", "The balance, and what moved it"));
    const list = node("ol", "bal");
    let running = 0;
    for (const e of ledgerEntries) {
      running += Number(e.amount ?? 0);
      const li = node("li", "bal__r");
      const left = node("div", "bal__b");
      left.append(node("span", "bal__t", e.description));
      left.append(
        node("span", "bal__m",
          `${dayLabel(e.occurredAt)} · ${String(e.kind).replace(/_/g, " ")}`)
      );
      /* The event's own effect, signed — and the balance it produced, which is the spine. */
      const eff = node("span", "bal__d" + (Number(e.amount) < 0 ? " is-down" : ""),
        `${Number(e.amount) > 0 ? "+" : "−"}${usdExact(Math.abs(Number(e.amount ?? 0)))}`);
      const bal = node("span", "bal__v", usdExact(running));
      li.append(left, eff, bal);
      list.append(li);
    }
    tl.append(list);
    tl.append(
      node("p", "dr__p dr__p--muted",
        "Oldest first, so the running balance on the right is the account's actual history rather than a restatement of today's figure.")
    );
    wrap.append(tl);
  }

  /* ── The rest of the chain, which is what makes the balance explicable ────────────────────── */
  const hist = view.timeline ?? [];
  if (hist.length) {
    const sec = node("section", "dr__s");
    sec.append(node("div", "dr__k", `Everything else on this record (${hist.length})`));
    const list = node("ol", "dtl");
    hist.forEach((e, i) => {
      const li = node("li", "dtl__n");
      li.append(node("span", "dtl__dot"));
      const body = node("span", "dtl__b");
      body.append(node("span", "dtl__label", e.title));
      const sub = [];
      if (e.actor) sub.push(e.actor === "system" ? "Mermaid" : e.actor);
      if (e.at) sub.push(dayLabel(e.at));
      if (e.amount !== null && e.amount !== undefined) sub.push(usdExact(e.amount));
      if (sub.length) body.append(node("span", "dtl__meta", sub.join(" · ")));
      if (e.detail) body.append(node("span", "dtl__detail", e.detail));
      li.append(body);
      list.append(li);
    });
    sec.append(list);
    wrap.append(sec);
  }

  /* ── The people on this account, when it is more than one ─────────────────────────────────── */
  const people = view.ledger?.account?.people ?? [];
  if (people.length > 1) {
    const sec = node("section", "dr__s");
    sec.append(node("div", "dr__k", "Who is on this policy"));
    sec.append(
      node("p", "dr__p dr__p--muted",
        "One member ID, several people. The balance above is the policy's, not any one person's.")
    );
    for (const person of people) {
      sec.append(node("p", "dr__p", `${maskName(person.patientName)} — ${usdExact(person.balance ?? 0)}`));
    }
    wrap.append(sec);
  }

  if ((view.ledger?.statementLines ?? []).length) {
    const sec = node("section", "dr__s");
    sec.append(node("div", "dr__k", "What a statement would say"));
    for (const line of view.ledger.statementLines) sec.append(node("p", "dr__p", line));
    sec.append(node("p", "dr__p dr__p--muted", "Nothing is sent from this screen. A statement is delivered by a person."));
    wrap.append(sec);
  }

  return wrap;
}
