/**
 * The interactive chart shell.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM THE SVG IT REPLACES ───────────────────────────────────────────
 * The previous charts were correct pictures. They drew real data honestly and then stopped. The
 * specification's position — which is right — is that a visualization a user cannot interrogate is
 * unfinished: "There are no display-only visualizations in Mermaid."
 *
 * So every chart built through this shell responds to hover, click, brush and the keyboard, and
 * every one of those gestures writes to the shared store rather than to local state. That is the
 * whole trick: the chart does not remember what it highlighted. It renders the store back. A chart
 * and the table beneath it therefore cannot drift into describing different populations, because
 * there is only one population and both read it from the same place.
 *
 * ── THE CSP CONSTRAINT, AND WHY THIS IS BUILT THIS WAY ───────────────────────────────────────────
 * `style-src 'self'` means an inline `style=` attribute in markup is DROPPED by the browser. That
 * rules out the usual approach of writing positioned elements into an HTML string. But CSP governs
 * markup, not the CSSOM: assigning `element.style.transform` from JavaScript is unaffected, and the
 * shipped client already relies on that in production. So the geometry is authored as SVG
 * attributes, and the two things that must move continuously — the crosshair and the brush — are
 * positioned by assigning to `.style` after the element exists.
 *
 * ── HONESTY ──────────────────────────────────────────────────────────────────────────────────────
 * Nothing here invents a point, smooths a series, or bridges a gap. A chart with too few readings
 * to support its own shape refuses to render and says what it would need. Partial buckets are drawn
 * dashed and are never compared to complete ones.
 */

const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Where a reference rule begins, clear of the scale hint over the plot's top-left. See drawRule. */
const RULE_TOP = 14;

/** The plot's own coordinate space. Width is normalised so the SVG scales without a resize listener. */
const VW = 1000;

/**
 * @param {HTMLElement} host        where the chart lives
 * @param {object}      opts
 * @param {object}      opts.store  the shared selection/filter store
 * @param {"line"|"column"|"band"} opts.mark
 * @param {number}      opts.height plot height in px
 * @param {(v:number)=>string} opts.format how a value is written out
 * @param {(p:object)=>string} opts.bucketOf the identity a click selects
 * @param {{key:string,label:string,tone?:string}[]} opts.series  `band` only — the stack, bottom-up
 */
export function createChart(host, opts) {
  const {
    store,
    mark = "line",
    height = 180,
    format = (v) => String(v),
    bucketOf = (p) => String(p.at).slice(0, 10),
    label = "",
    onDrill = null,
    /**
     * Whether dragging across the plot sets a time brush.
     *
     * Off for any chart whose x-axis is NOT calendar time. The recovery curve's axis is "days since
     * the denial", so two points a third of the way apart do not describe a date range — brushing
     * them would write a `{from, to}` of values that are not instants into the shared store, and
     * every screen reading that store would then filter by them. A gesture that cannot mean anything
     * is better refused than given a meaning it does not have.
     */
    brushable = true,
  } = opts;

  /**
   * The stack's composition, bottom-up. Declared at construction and replaceable through `update`,
   * because a screen may learn its series from the data (which payers appear) rather than from a
   * constant.
   */
  let series = opts.series ?? [];

  let points = [];
  let scaleY = { min: 0, max: 1 };
  let hoverIndex = -1;
  let dragFrom = null;

  host.classList.add("ch");
  host.innerHTML = "";

  /* ── Static frame ─────────────────────────────────────────────────────────────────────────── */
  const readout = document.createElement("div");
  readout.className = "ch__readout";
  readout.setAttribute("aria-live", "off");

  const svg = el("svg", {
    class: "ch__svg",
    viewBox: `0 0 ${VW} ${height}`,
    preserveAspectRatio: "none",
    role: "img",
    tabindex: "0",
    "aria-label": label,
  });

  const gGrid = el("g", { class: "ch__grid" });
  const gMarks = el("g", { class: "ch__marks" });
  /* The reference rule (§8.2 marks today with one): behind the marks, above the grid. */
  const gRule = el("g", { class: "ch__rules", "aria-hidden": "true" });
  /** The bucket a vertical rule marks, or null. See `setRule`. */
  let ruleBucket = null;
  const brushRect = el("rect", { class: "ch__brush", x: 0, y: 0, width: 0, height, "aria-hidden": "true" });
  const crosshair = el("line", {
    class: "ch__crosshair",
    x1: 0, y1: 0, x2: 0, y2: height,
    "vector-effect": "non-scaling-stroke",
    "aria-hidden": "true",
  });
  crosshair.classList.add("is-hidden");
  svg.append(gGrid, gRule, brushRect, gMarks, crosshair);

  const axis = document.createElement("div");
  axis.className = "ch__axis";

  /*
   * §4.2 forbids a legend "where direct labelling works" — and on a line or a column series it
   * does, which is why neither of those marks has one. A stack of four bands is the case where it
   * does not: the bands share an x position, so there is nowhere to write a label except beside the
   * band, and a segment two pixels tall has no beside. The legend is therefore built only for the
   * band mark and stays empty for every other.
   */
  const legend = document.createElement("div");
  legend.className = "ch__legend";

  const note = document.createElement("p");
  note.className = "ch__note";

  /*
   * ── §4.4 PROVENANCE ────────────────────────────────────────────────────────────────────────────
   * "Every chart exposes its provenance… If you cannot fill in that popover, you cannot ship the
   * chart." That is a strong rule and it is the right one: a picture of money whose definition,
   * window, filters and record count cannot be stated is a picture nobody can check.
   *
   * The affordance is built here rather than per screen so no chart can be shipped without it — the
   * button exists from construction, and a chart whose caller never supplied a definition says so
   * in the popover rather than hiding the button and looking complete.
   */
  const provBtn = document.createElement("button");
  provBtn.type = "button";
  provBtn.className = "ch__prov-b";
  provBtn.textContent = "i";
  provBtn.setAttribute("aria-label", "Where this chart's numbers come from");
  provBtn.setAttribute("aria-expanded", "false");

  const provPop = document.createElement("div");
  provPop.className = "ch__prov";
  provPop.hidden = true;
  provPop.setAttribute("role", "dialog");
  provPop.setAttribute("aria-label", "Chart provenance");

  let provenance = null;

  const closeProv = () => {
    provPop.hidden = true;
    provBtn.setAttribute("aria-expanded", "false");
  };
  const drawProv = () => {
    provPop.replaceChildren();
    const p = provenance ?? {};
    const line = (k, v) => {
      const row = document.createElement("div");
      row.className = "ch__prov-r";
      const key = document.createElement("span");
      key.className = "ch__prov-k";
      key.textContent = k;
      const val = document.createElement("span");
      val.className = "ch__prov-v" + (v ? "" : " is-na");
      val.textContent = v || "not stated";
      row.append(key, val);
      provPop.append(row);
    };

    const def = document.createElement("p");
    def.className = "ch__prov-def";
    /*
     * A chart whose caller supplied no definition does not hide the fact. §4.4's rule is that the
     * popover must be fillable; a blank one is the visible form of failing it, which is far better
     * than a missing button that lets the chart look finished.
     */
    def.textContent = p.definition || "This chart has no stated definition, which §4.4 requires. Treat it as unverified.";
    if (!p.definition) def.classList.add("is-na");
    provPop.append(def);

    line("Range", p.range);
    /* Read from the store, not from the caller — the filters ARE the store, and a chart that
       reported its own idea of them could disagree with the chips above it. */
    const chips = store.chips();
    line("Filters", chips.length ? chips.map((c) => c.label ?? `${c.dim}: ${c.value}`).join(", ") : "none");
    line("Records", p.records === null || p.records === undefined ? "" : String(p.records));
    line("Source", p.sources);
    line("Last sync", p.syncedAt);
  };

  provBtn.addEventListener("click", () => {
    const open = provPop.hidden;
    if (open) drawProv();
    provPop.hidden = !open;
    provBtn.setAttribute("aria-expanded", String(open));
  });
  provBtn.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeProv(); });
  provPop.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeProv(); provBtn.focus(); } });
  /* Dismissed by clicking anywhere else, which is what a popover has to do to not become a panel. */
  document.addEventListener("click", (ev) => {
    if (provPop.hidden) return;
    if (provPop.contains(ev.target) || provBtn.contains(ev.target)) return;
    closeProv();
  });

  host.append(readout, provBtn, provPop, svg, axis, legend, note);

  /* ── Geometry ─────────────────────────────────────────────────────────────────────────────── */
  const xOf = (i) => (points.length <= 1 ? VW / 2 : (i / (points.length - 1)) * VW);
  const bandOf = (i) => (points.length === 0 ? VW : VW / points.length);
  const yOf = (v) => {
    const { min, max } = scaleY;
    if (max === min) return height / 2;
    return height - 6 - ((v - min) / (max - min)) * (height - 14);
  };
  const indexAtRatio = (r) => {
    if (points.length === 0) return -1;
    if (mark === "column") return clamp(Math.floor(r * points.length), 0, points.length - 1);
    return clamp(Math.round(r * (points.length - 1)), 0, points.length - 1);
  };

  /* ── Draw ─────────────────────────────────────────────────────────────────────────────────── */
  function drawGrid() {
    gGrid.replaceChildren();
    /* §4.2 — horizontal only, at most five, and the axis line itself is never drawn. */
    const ticks = 4;
    for (let i = 1; i <= ticks; i++) {
      const v = scaleY.min + ((scaleY.max - scaleY.min) * i) / ticks;
      const y = yOf(v);
      gGrid.append(el("line", { class: "ch__gridline", x1: 0, y1: y, x2: VW, y2: y, "vector-effect": "non-scaling-stroke" }));
    }
  }

  function drawMarks() {
    gMarks.replaceChildren();
    if (points.length === 0) return;
    const sel = store.get().point?.bucket ?? null;

    /*
     * ── THE STACKED BAND ──────────────────────────────────────────────────────────────────────
     * One column per bucket, divided into the series that compose it. The value of the shape is
     * watching a band SWELL: a growing "with the payer" band beside a flat "adjudicated" band is a
     * payer slowdown, and it is visible without reading a single number.
     *
     * Composition uses the graphite ramp rather than a colour per series (§1.5). Ordering the ramp
     * light-to-dark makes the stack itself encode progression, so the picture survives
     * `filter: grayscale(1)` — which is the test the whole palette is built to pass. A series may
     * opt into semantic colour only where the band genuinely means money lost.
     *
     * Each segment's edges come from the CUMULATIVE total below it, so a segment's top is computed
     * by the same expression as its neighbour's bottom and the two are identical floats. Drawing
     * each segment from its own height instead would leave sub-pixel seams between bands — which on
     * a stack reads as missing data rather than as rounding.
     */
    if (mark === "band") {
      const band = bandOf();
      const w = Math.min(band * 0.62, 52);
      points.forEach((p, i) => {
        const parts = p.parts ?? {};
        const x = i * band + (band - w) / 2;
        const isSel = sel !== null && bucketOf(p) === sel;
        /* Negative contributions are not representable in a stack and are never invented into one. */
        const at = (k) => Math.max(0, Number(parts[k]) || 0);
        const total = series.reduce((t, s) => t + at(s.key), 0);

        if (total <= 0) {
          const r = el("rect", {
            class: "ch__col is-empty" + (isSel ? " is-selected" : ""),
            x, y: height - 2, width: w, height: 2,
          });
          r.append(el("title", {}));
          r.lastChild.textContent = `${p.label ?? bucketOf(p)} — nothing`;
          gMarks.append(r);
          return;
        }

        let below = 0;
        series.forEach((s, si) => {
          const v = at(s.key);
          if (v === 0) { return; }
          const yTop = yOf(below + v);
          const yBottom = yOf(below);
          below += v;
          const seg = el("rect", {
            class:
              "ch__seg" +
              /* Ramp position is the series' place in the stack, never its index in a palette. */
              (s.tone ? ` is-${s.tone}` : ` is-ramp-${Math.min(5, si + 1)}`) +
              (isSel ? " is-selected" : ""),
            x,
            y: yTop,
            width: w,
            height: Math.max(1, yBottom - yTop),
          });
          seg.append(el("title", {}));
          seg.lastChild.textContent = `${p.label ?? bucketOf(p)} · ${s.label} — ${format(v)}`;
          gMarks.append(seg);
        });
      });
      return;
    }

    if (mark === "column") {
      const band = bandOf();
      const w = Math.min(band * 0.55, 46);
      points.forEach((p, i) => {
        const v = Number(p.value);
        const zero = v === 0;
        const y = zero ? height - 2 : yOf(v);
        const h = zero ? 2 : Math.max(2, height - 6 - y + 6);
        const r = el("rect", {
          class:
            "ch__col" +
            (zero ? " is-empty" : "") +
            (p.partial ? " is-partial" : "") +
            (sel !== null && bucketOf(p) === sel ? " is-selected" : ""),
          x: i * band + (band - w) / 2,
          y: zero ? height - 2 : y,
          width: w,
          height: h,
        });
        r.append(el("title", {}));
        r.lastChild.textContent = `${p.label ?? bucketOf(p)} — ${format(v)}`;
        gMarks.append(r);
      });
      return;
    }

    /* A line. Gaps are drawn as gaps — §4.4 forbids interpolating across missing data. */
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        gMarks.append(
          el("path", {
            class: "ch__line",
            d: run.map((s, k) => `${k === 0 ? "M" : "L"}${s.x.toFixed(2)} ${s.y.toFixed(2)}`).join(" "),
            fill: "none",
            "vector-effect": "non-scaling-stroke",
          })
        );
      } else if (run.length === 1) {
        gMarks.append(el("circle", { class: "ch__dot", cx: run[0].x, cy: run[0].y, r: 2.5 }));
      }
      run = [];
    };
    points.forEach((p, i) => {
      if (p.value === null || p.value === undefined) { flush(); return; }
      run.push({ x: xOf(i), y: yOf(Number(p.value)) });
    });
    flush();

    const last = points[points.length - 1];
    if (last && last.value !== null) {
      gMarks.append(el("circle", { class: "ch__terminus", cx: xOf(points.length - 1), cy: yOf(Number(last.value)), r: 3 }));
    }
    if (sel !== null) {
      const i = points.findIndex((p) => bucketOf(p) === sel);
      if (i >= 0 && points[i].value !== null) {
        gMarks.append(el("circle", { class: "ch__selected", cx: xOf(i), cy: yOf(Number(points[i].value)), r: 4.5 }));
      }
    }
  }

  /**
   * The band key. Ordered TOP-DOWN — the reverse of the stack's draw order — because that is the
   * order the eye reads the column it describes, and a key that runs opposite to its own picture
   * makes the reader do the flip.
   *
   * A series carrying nothing across the whole window is omitted. Listing it would assert the
   * screen looked for it and describe a band that is not on the chart.
   */
  function drawLegend() {
    legend.replaceChildren();
    if (mark !== "band" || points.length === 0) return;
    const present = series.filter((s) =>
      points.some((p) => (Number((p.parts ?? {})[s.key]) || 0) > 0)
    );
    if (present.length < 2) return;
    present.forEach((s) => {
      const si = series.indexOf(s);
      const item = document.createElement("span");
      item.className = "ch__key";
      const swatch = document.createElement("span");
      swatch.className =
        "ch__key-sw" + (s.tone ? ` is-${s.tone}` : ` is-ramp-${Math.min(5, si + 1)}`);
      const name = document.createElement("span");
      name.textContent = s.label;
      item.append(swatch, name);
      legend.prepend(item);
    });
  }

  function drawAxis() {
    axis.replaceChildren();
    if (points.length === 0) return;
    /* §4.2 — 4 to 7 ticks, adaptive. */
    const want = Math.min(5, points.length);
    const step = Math.max(1, Math.floor((points.length - 1) / Math.max(1, want - 1)));
    const seen = new Set();
    for (let i = 0; i < points.length; i += step) seen.add(i);
    const last = points.length - 1;
    /*
     * The final tick always belongs — it names the end of the window — but the stepped run rarely
     * lands on it, so adding it can leave two labels a day apart ("4 Sept  5 Sept") reading as a
     * crowded pair rather than a scale. The stepped tick within half a step of the end is therefore
     * dropped in favour of the end itself.
     */
    for (const i of [...seen]) if (i !== last && last - i < step / 2) seen.delete(i);
    seen.add(last);
    for (const i of [...seen].sort((a, b) => a - b)) {
      const s = document.createElement("span");
      s.className = "ch__tick";
      s.textContent = points[i].tick ?? points[i].label ?? "";
      axis.append(s);
    }
  }

  /**
   * The y-axis label sits INSIDE the plot, top-left above its gridline — the spec's signature, and
   * it reclaims the horizontal space a conventional axis would take.
   */
  function drawScaleLabel() {
    const existing = host.querySelector(".ch__yhint");
    if (existing) existing.remove();
    if (points.length === 0) return;
    const s = document.createElement("div");
    s.className = "ch__yhint";
    s.textContent = format(scaleY.max);
    host.insertBefore(s, svg);
  }

  function paint() {
    drawGrid();
    drawRule();
    drawMarks();
    drawAxis();
    drawScaleLabel();
    paintBrush();
  }

  /**
   * One 1px vertical rule through the marked bucket: a reference, not data.
   *
   * At the CENTRE of the bucket's slot, drawn behind the marks. Above a stack it reads as the
   * marker, and through an empty day it is the only thing in the slot. Never at a slot edge: on the
   * first bucket that would sit on the plot's left edge and read as the axis line §4.2 forbids.
   * A bucket that is not on the chart draws nothing, because a rule for a day off the axis is not a
   * claim this chart can make.
   */
  function drawRule() {
    gRule.replaceChildren();
    if (ruleBucket === null || points.length === 0) return;
    const i = points.findIndex((p) => bucketOf(p) === ruleBucket);
    if (i < 0) return;
    const x = mark === "line" ? xOf(i) : i * bandOf() + bandOf() / 2;
    /*
     * Starts BELOW the scale hint (`.ch__yhint`), which sits over the plot's top-left corner. On the
     * first bucket, which is where today always is, a rule from y=0 ran straight through "$2,815" on
     * a phone. The rule only has to say which column; it does not need the top 14 units to do it.
     */
    gRule.append(el("line", { class: "ch__rule", x1: x, y1: Math.min(RULE_TOP, height), x2: x, y2: height, "vector-effect": "non-scaling-stroke" }));
  }

  function paintBrush() {
    const b = store.get().brush;
    if (!b || points.length === 0) { brushRect.setAttribute("width", "0"); return; }
    const t0 = new Date(b.from).getTime(), t1 = new Date(b.to).getTime();
    const idxs = points.map((p, i) => ({ i, t: new Date(p.at).getTime() })).filter((x) => x.t >= t0 && x.t <= t1);
    if (idxs.length === 0) { brushRect.setAttribute("width", "0"); return; }
    const a = mark === "column" ? idxs[0].i * bandOf() : xOf(idxs[0].i);
    const z = mark === "column" ? (idxs[idxs.length - 1].i + 1) * bandOf() : xOf(idxs[idxs.length - 1].i);
    brushRect.setAttribute("x", String(Math.min(a, z)));
    brushRect.setAttribute("width", String(Math.max(2, Math.abs(z - a))));
  }

  /* ── Readout: anchored, never a floating tooltip that covers the data ─────────────────────── */
  function showReadout(i) {
    if (i < 0 || i >= points.length) { readout.classList.remove("is-on"); return; }
    const p = points[i];
    readout.replaceChildren();
    const when = document.createElement("span");
    when.className = "ch__ro-when";
    when.textContent = p.label ?? bucketOf(p);
    const val = document.createElement("span");
    val.className = "ch__ro-val";
    val.textContent = p.value === null ? "no data" : format(Number(p.value));
    readout.append(when, val);
    /*
     * On a stack the total alone is the least interesting number on the screen — the question the
     * shape raises is which band is swelling. So the readout names every series that is actually
     * present at this bucket. A series contributing nothing is omitted rather than written as zero:
     * four "— 0" lines bury the one line that moved.
     */
    if (mark === "band") {
      for (const s of series) {
        const v = Math.max(0, Number((p.parts ?? {})[s.key]) || 0);
        if (v === 0) continue;
        const part = document.createElement("span");
        part.className = "ch__ro-part";
        const nm = document.createElement("span");
        nm.className = "ch__ro-part-n";
        nm.textContent = s.label;
        const pv = document.createElement("span");
        pv.className = "ch__ro-part-v";
        pv.textContent = format(v);
        part.append(nm, pv);
        readout.append(part);
      }
    }
    if (p.note) {
      const n = document.createElement("span");
      n.className = "ch__ro-note";
      n.textContent = p.note;
      readout.append(n);
    }
    readout.classList.add("is-on");
  }

  function moveCrosshair(i) {
    if (i < 0) { crosshair.classList.add("is-hidden"); return; }
    const x = mark === "column" ? i * bandOf() + bandOf() / 2 : xOf(i);
    crosshair.setAttribute("x1", String(x));
    crosshair.setAttribute("x2", String(x));
    crosshair.classList.remove("is-hidden");
  }

  const ratioFromEvent = (ev) => {
    const r = svg.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
  };

  /* ── Gestures ─────────────────────────────────────────────────────────────────────────────── */
  svg.addEventListener("pointermove", (ev) => {
    const i = indexAtRatio(ratioFromEvent(ev));
    /* No brush preview on a chart that cannot be brushed — the drag is inert, so it must look it. */
    if (dragFrom !== null && brushable) {
      const a = Math.min(dragFrom, i), z = Math.max(dragFrom, i);
      if (points[a] && points[z]) {
        brushRect.setAttribute("x", String(mark === "column" ? a * bandOf() : xOf(a)));
        brushRect.setAttribute(
          "width",
          String(Math.max(2, (mark === "column" ? (z + 1) * bandOf() : xOf(z)) - (mark === "column" ? a * bandOf() : xOf(a))))
        );
      }
      return;
    }
    if (i === hoverIndex) return;
    hoverIndex = i;
    moveCrosshair(i);
    showReadout(i);
  });

  svg.addEventListener("pointerleave", () => {
    if (dragFrom !== null) return;
    hoverIndex = -1;
    moveCrosshair(-1);
    readout.classList.remove("is-on");
  });

  svg.addEventListener("pointerdown", (ev) => {
    if (points.length === 0) return;
    dragFrom = indexAtRatio(ratioFromEvent(ev));
    svg.setPointerCapture(ev.pointerId);
  });

  svg.addEventListener("pointerup", (ev) => {
    if (dragFrom === null) return;
    const to = indexAtRatio(ratioFromEvent(ev));
    const from = dragFrom;
    dragFrom = null;
    try { svg.releasePointerCapture(ev.pointerId); } catch {}

    if (from === to || !brushable) {
      /* A click is a point selection — and on an unbrushable chart, so is a drag. */
      store.selectPoint(bucketOf(points[to]));
      return;
    }
    const a = points[Math.min(from, to)], z = points[Math.max(from, to)];
    store.setBrush({ from: a.at, to: z.at });
  });

  /* §4.3.5 — keyboard parity, which is also how this passes an accessibility review. */
  svg.addEventListener("keydown", (ev) => {
    if (points.length === 0) return;
    const cur = hoverIndex < 0 ? points.findIndex((p) => bucketOf(p) === store.get().point?.bucket) : hoverIndex;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      const next = clamp((cur < 0 ? 0 : cur) + (ev.key === "ArrowRight" ? 1 : -1), 0, points.length - 1);
      hoverIndex = next;
      moveCrosshair(next);
      showReadout(next);
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (hoverIndex >= 0) {
        store.selectPoint(bucketOf(points[hoverIndex]));
        if (onDrill) onDrill(bucketOf(points[hoverIndex]));
      }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      store.clearFilters();
      hoverIndex = -1;
      moveCrosshair(-1);
      readout.classList.remove("is-on");
    }
  });

  const unsubscribe = store.subscribe((_s, reason) => {
    if (reason === "point" || reason === "brush" || reason === "filters") paint();
  });

  return {
    /**
     * Replace the data. `insufficient` renders the spec's §7.2 treatment instead of a degraded
     * chart — a shape drawn from too few readings is a claim nobody measured.
     */
    update(next, { insufficient = null, series: nextSeries = null } = {}) {
      if (nextSeries) series = nextSeries;
      if (insufficient) {
        points = [];
        host.classList.add("is-empty");
        svg.style.display = "none";
        axis.replaceChildren();
        legend.replaceChildren();
        note.textContent = insufficient;
        return;
      }
      host.classList.remove("is-empty");
      svg.style.display = "";
      points = next ?? [];
      /*
       * A stacked point's height is the sum of its parts, not a `value` a caller also had to
       * supply. Deriving it here is what stops the axis from disagreeing with the bars it scales —
       * a caller who computed `value` separately and drifted would produce columns that overflow
       * their own plot.
       */
      if (mark === "band") {
        for (const p of points) {
          p.value = series.reduce((t, s) => t + Math.max(0, Number((p.parts ?? {})[s.key]) || 0), 0);
        }
        drawLegend();
      }
      const vals = points.map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
      const max = vals.length ? Math.max(...vals) : 1;
      const min = Math.min(0, ...(vals.length ? vals : [0]));
      scaleY = { min, max: max === min ? min + 1 : max };
      note.textContent = opts.note ?? "";
      paint();
    },
    setNote(text) { note.textContent = text ?? ""; },
    /** Mark one bucket with a vertical reference rule (§8.2: today), or clear it with null. */
    setRule(bucket) { ruleBucket = bucket ?? null; drawRule(); },
    /**
     * State where this chart's numbers came from (§4.4).
     *
     * `filters` is deliberately NOT a parameter: they live in the shared store and the popover reads
     * them there, so it cannot disagree with the chips above the chart.
     *
     * @param {object} p
     * @param {string} p.definition  the metric in one sentence
     * @param {string} p.range       the window it covers, in words a person reads
     * @param {number} p.records     how many records it was computed from
     * @param {string} p.sources     which systems the records came from
     * @param {string} [p.syncedAt]  when those systems were last read
     */
    setProvenance(p) { provenance = p; if (!provPop.hidden) drawProv(); },
    destroy() { unsubscribe(); host.replaceChildren(); },
  };
}
