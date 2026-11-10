/**
 * Chart primitives — the visual vocabulary Mermaid reasons in.
 *
 * ── WHY THESE ARE HAND-BUILT ─────────────────────────────────────────────────────────────────────
 * Two constraints decide it. The app ships as static ES modules with no client build step, and the
 * CSP is `script-src 'self'` / `style-src 'self'` — which means an inline `style=` attribute is
 * DROPPED by the browser. Every charting library positions its marks with inline styles, so a
 * library here would render an empty box. SVG *geometry attributes* (`x`, `y`, `width`, `d`) are
 * XML, not CSS, and the policy does not touch them.
 *
 * The vocabulary a revenue cycle actually needs is also small and specific: how much arrived and
 * when, how it divides, how old it is, and where it stopped moving. These primitives cover it.
 *
 * ── HOW THEY SCALE ───────────────────────────────────────────────────────────────────────────────
 * Most primitives draw into `viewBox="0 0 100 H"` with `preserveAspectRatio="none"`, so a chart
 * fills whatever width it is handed — 393px or 1440px — with no resize listener and no measurement.
 * Non-uniform scaling would normally smear stroke widths and turn circles into ellipses, so every
 * stroked mark carries `vector-effect="non-scaling-stroke"`, and no primitive in that family draws a
 * circle. Text is never inside those SVGs: labels are HTML siblings, which keeps them at their true
 * size, selectable, and translatable. A primitive needing TRUE aspect — anything drawing a circle —
 * would have to fix its own box and use `meet`; none currently does.
 *
 * ── THE HONESTY RULE ─────────────────────────────────────────────────────────────────────────────
 * Every primitive returns "" when its data cannot support it, and the caller shows the figure alone.
 * A chart is a claim about data: a trend through two points, or a "distribution" of one category,
 * asserts a pattern nobody measured. Nothing here invents, interpolates, smooths, back-fills or
 * extends a series.
 */

/** HTML-escape. These charts take real payer and patient names. */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const n2 = (v) => Number(v).toFixed(2);

/** Money, in the product's own format. Cents in, never floats. */
export const money = (cents) => {
  const v = Number(cents ?? 0) / 100;
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Compact money for an axis tick, where two decimals are noise. */
export const moneyTick = (cents) => {
  const v = Math.abs(Number(cents ?? 0)) / 100;
  const sign = Number(cents) < 0 ? "−" : "";
  if (v >= 1000) return `${sign}$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(v)}`;
};

/**
 * A row of HTML labels beneath a plot. They sit outside the SVG so they never inherit the
 * non-uniform scaling that makes the plot responsive.
 */
export const axisRow = (labels) =>
  !labels || labels.length === 0
    ? ""
    : `<div class="cx__axis">${labels.map((l) => `<span class="cx__tick">${esc(l)}</span>`).join("")}</div>`;

const frame = (inner, { height, label, cls = "" }) =>
  `<svg class="cx__plot ${cls}" viewBox="0 0 100 ${height}" preserveAspectRatio="none" role="img"
        aria-label="${esc(label)}">${inner}</svg>`;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   TIME SERIES
   ════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A thin time series with the final reading marked.
 *
 * SOURCE      [{at: ISO string, value: number}]
 * DERIVATION  x is the real timestamp against the true range, y is 0..max. Points sit at their
 *             actual times, so an irregular series LOOKS irregular — the gaps are information about
 *             when the practice was and was not being paid.
 *
 * Refuses under three points: a line through two readings asserts a direction two readings cannot
 * establish.
 */
export function trendLine(points, { height = 40, label = "", fill = true } = {}) {
  const pts = (points ?? []).filter((p) => p && p.at && Number.isFinite(Number(p.value)));
  if (pts.length < 3) return "";

  const xs = pts.map((p) => new Date(p.at).getTime());
  if (xs.some((t) => Number.isNaN(t))) return "";
  const ys = pts.map((p) => Number(p.value));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = Math.max(...ys, 0), yMin = Math.min(...ys, 0);
  if (!(x1 > x0) || yMax === yMin) return "";

  const px = (t) => ((t - x0) / (x1 - x0)) * 100;
  const py = (v) => height - ((v - yMin) / (yMax - yMin)) * (height - 3) - 1.5;

  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${n2(px(xs[i]))} ${n2(py(ys[i]))}`).join(" ");
  const area = `${d} L100 ${height} L0 ${height} Z`;
  const lx = px(xs[xs.length - 1]), ly = py(ys[ys.length - 1]);

  return frame(
    `${fill ? `<path class="cx__area" d="${area}" />` : ""}` +
      `<path class="cx__line" d="${d}" fill="none" vector-effect="non-scaling-stroke" />` +
      `<path class="cx__last" d="M${n2(lx)} ${n2(ly - 2.4)} L${n2(lx)} ${n2(ly + 2.4)}" vector-effect="non-scaling-stroke" />`,
    { height, label }
  );
}

/**
 * Discrete readings as columns — the honest shape for a handful of daily figures, where a line would
 * imply a continuous quantity that was never measured between the days.
 *
 * SOURCE      [{label, value, title?}]
 * DERIVATION  column height is value ÷ max. A zero keeps its slot and draws a baseline tick, because
 *             a day on which no money arrived is a reading, not a gap.
 */
export function columns(rows, { height = 44, label = "" } = {}) {
  const data = (rows ?? []).filter((r) => r && Number.isFinite(Number(r.value)));
  if (data.length < 2) return "";
  const max = Math.max(...data.map((r) => Math.abs(Number(r.value))));
  if (max <= 0) return "";

  const slot = 100 / data.length;
  /*
   * Capped, not just proportional. With four readings a bar at 54% of its slot is 110px wide and
   * 8px tall — a slab, not a column, and a shape that reads as a rule rather than a measurement.
   * The ceiling keeps a sparse series looking like the same instrument as a dense one.
   */
  const w = Math.min(8, Math.max(1.2, slot * 0.54));
  const bars = data
    .map((r, i) => {
      const v = Math.abs(Number(r.value));
      const h = v === 0 ? 0.7 : Math.max(0.9, (v / max) * (height - 2));
      const x = i * slot + (slot - w) / 2;
      const cls = v === 0 ? "cx__col cx__col--empty" : "cx__col";
      return `<rect class="${cls}" x="${n2(x)}" y="${n2(height - h)}" width="${n2(w)}" height="${n2(h)}"><title>${esc(r.label ?? "")}${r.title ? ` — ${esc(r.title)}` : ""}</title></rect>`;
    })
    .join("");
  /* Columns need something to stand on, or they read as blocks floating at arbitrary heights. */
  const base = `<line class="cx__base" x1="0" y1="${height}" x2="100" y2="${height}" vector-effect="non-scaling-stroke" />`;
  return frame(base + bars, { height, label });
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   DISTRIBUTION
   ════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One stacked bar: how a single total divides.
 *
 * SOURCE      [{key, value, cls, label, title}]
 * DERIVATION  each segment's width is its share of the sum.
 *
 * Refuses a single populated segment. A full-width block says only "all of it is in one place",
 * which the figure beside it already says, and says better.
 */
export function stackedBar(segments, { height = 6, label = "" } = {}) {
  const segs = (segments ?? []).filter((s) => Number(s.value) > 0);
  if (segs.length < 2) return "";
  const total = segs.reduce((a, s) => a + Number(s.value), 0);
  if (total <= 0) return "";
  /*
   * Each segment's START is exact; only its right edge is inset by a hairline, so the ground shows
   * between neighbours. Without it, two adjacent segments carrying the same hue — "ready to file"
   * and "part paid" are both amber, because both mean a person must act — rendered as one block,
   * and the reader counted three states where the legend named four.
   */
  const GAP = 0.28;
  let x = 0;
  const rects = segs
    .map((s, i) => {
      const w = Math.max(0.5, (Number(s.value) / total) * 100);
      const drawn = i === segs.length - 1 ? w : Math.max(0.4, w - GAP);
      const r = `<rect class="cx__seg ${s.cls ?? ""}" x="${n2(x)}" y="0" width="${n2(drawn)}" height="${height}"><title>${esc(s.label ?? s.key)} — ${esc(s.title ?? money(s.value))}</title></rect>`;
      x += w;
      return r;
    })
    .join("");
  return frame(rects, { height, label, cls: "cx__plot--flat" });
}

/**
 * Ranked horizontal bars — the shape for "who is worst", where lengths are compared against a shared
 * left edge and the category names have to stay readable.
 *
 * SOURCE      [{name, value, display?, meta?, cls?}]
 * DERIVATION  bar width is value ÷ the largest value present, so the leader is full width and the
 *             comparison is relative. Pass `max` to scale against an external total instead.
 *
 * The bar is a track behind HTML text rather than SVG text beside a bar, which is what keeps the
 * names selectable and correctly sized at every width.
 */
export function rankedBars(rows, { max = null, limit = 6, label = "" } = {}) {
  const all = (rows ?? []).filter((r) => Number.isFinite(Number(r.value)));
  const data = all.slice(0, limit);
  if (data.length < 2) return "";
  const top = max ?? Math.max(...data.map((r) => Math.abs(Number(r.value))));
  if (top <= 0) return "";

  return `<div class="cx__ranked" role="img" aria-label="${esc(label)}">${data
    .map((r) => {
      const pct = Math.max(0.8, (Math.abs(Number(r.value)) / top) * 100);
      /*
       * An optional second measure drawn INSIDE the first. Where the row means "we filed this much
       * and they paid that much", two numbers on one track answer it at a glance; two separate bars
       * make the reader do the division. `achieved` is on the same scale as `value`, never rebased.
       */
      const has = Number.isFinite(Number(r.achieved));
      const apct = has ? Math.min(pct, Math.max(0.5, (Math.abs(Number(r.achieved)) / top) * 100)) : 0;
      return `<div class="cx__rank">
        <span class="cx__rank-name">${esc(r.name)}</span>
        <span class="cx__rank-track">
          <svg viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden="true">
            <rect class="cx__rank-track-bg${has ? " is-target" : ` ${r.cls ?? ""}`}" x="0" y="0" width="${n2(pct)}" height="3" />
            ${has ? `<rect class="cx__rank-fill ${r.cls ?? ""}" x="0" y="0" width="${n2(apct)}" height="3" />` : ""}
          </svg>
        </span>
        <span class="cx__rank-val">${esc(r.display ?? money(r.value))}</span>
        ${r.meta ? `<span class="cx__rank-meta">${esc(r.meta)}</span>` : ""}
      </div>`;
    })
    .join("")}${
    /* A cap that says nothing reads as "this is all of them". */
    all.length > data.length
      ? `<div class="cx__rank-more">${data.length} of ${all.length} shown</div>`
      : ""
  }</div>`;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   FLOW
   ════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A pipeline drawn as proportional bars stepping down, with the loss between each pair named.
 *
 * SOURCE      [{name, value, display?, dropLabel?}] in pipeline order
 * DERIVATION  each stage's width is its share of the FIRST stage, so the reader sees attrition
 *             rather than a re-based comparison. The annotation is stage[i-1] − stage[i].
 *
 * Refuses a non-monotonic series: a funnel whose stages grow is not a funnel, and drawing one would
 * misrepresent the pipeline it claims to describe.
 */
export function funnel(stages, { label = "", unit = "count" } = {}) {
  const s = (stages ?? []).filter((x) => x && Number.isFinite(Number(x.value)));
  if (s.length < 2) return "";
  const head = Number(s[0].value);
  if (head <= 0) return "";
  for (let i = 1; i < s.length; i++) if (Number(s[i].value) > Number(s[i - 1].value)) return "";

  const fmt = (v) => (unit === "money" ? money(v) : String(v));
  return `<div class="cx__funnel" role="img" aria-label="${esc(label)}">${s
    .map((st, i) => {
      const pct = Math.max(1, (Number(st.value) / head) * 100);
      const drop = i > 0 ? Number(s[i - 1].value) - Number(st.value) : 0;
      return `<div class="cx__fstage">
        <div class="cx__fhead">
          <span class="cx__fname">${esc(st.name)}</span>
          <span class="cx__fval">${esc(st.display ?? fmt(st.value))}</span>
        </div>
        <svg class="cx__fbar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
          <rect class="cx__fbar-fill ${st.cls ?? ""}" x="0" y="0" width="${n2(pct)}" height="4" />
        </svg>
        ${drop > 0 ? `<div class="cx__fdrop">−${esc(fmt(drop))}${st.dropLabel ? ` ${esc(st.dropLabel)}` : ""}</div>` : ""}
      </div>`;
    })
    .join("")}</div>`;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
   TIME
   ════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * An activity timeline: every event at its true position in the window, in a lane by kind.
 *
 * SOURCE      [{at: ISO, kind, text}]
 * DERIVATION  x is the event's real timestamp against the window bounds; the lane is its kind. A
 *             reader sees what KIND of thing has been happening as a texture, and when it stopped.
 *
 * This is the one visualization that answers "is Mermaid actually watching?", and it can only answer
 * that with real timestamps — so it refuses a window it cannot bound.
 */
export function activityTimeline(events, { from, to, lanes, laneLabels = {}, label = "", height = 48 } = {}) {
  const evs = (events ?? []).filter((e) => e && e.at && !Number.isNaN(new Date(e.at).getTime()));
  if (evs.length < 2) return "";
  const times = evs.map((e) => new Date(e.at).getTime());
  const t0 = from ? new Date(from).getTime() : Math.min(...times);
  const t1 = to ? new Date(to).getTime() : Math.max(...times);
  if (!(t1 > t0)) return "";

  const order = lanes ?? [...new Set(evs.map((e) => e.kind))];
  const laneH = height / Math.max(1, order.length);

  const rules = order
    .map(
      (_, i) =>
        `<line class="cx__lane" x1="0" y1="${n2(i * laneH + laneH / 2)}" x2="100" y2="${n2(i * laneH + laneH / 2)}" vector-effect="non-scaling-stroke" />`
    )
    .join("");

  const marks = evs
    .map((e) => {
      const li = order.indexOf(e.kind);
      if (li < 0) return "";
      const x = ((new Date(e.at).getTime() - t0) / (t1 - t0)) * 100;
      const y = li * laneH + laneH * 0.2;
      const h = laneH * 0.6;
      return `<rect class="cx__ev cx__ev--${esc(e.kind)}" x="${n2(Math.min(99.3, Math.max(0, x)))}" y="${n2(y)}" width="0.7" height="${n2(h)}"><title>${esc(e.text ?? e.kind)}</title></rect>`;
    })
    .join("");

  return `<div class="cx__timeline">
    <div class="cx__lanes">${order
      .map((k) => `<span class="cx__lane-name">${esc(laneLabels[k] ?? k)}</span>`)
      .join("")}</div>
    ${frame(`${rules}${marks}`, { height, label })}
  </div>`;
}

